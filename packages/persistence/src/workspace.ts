/**
 * Workspaces in the one database (decision 0013 §4).
 *
 * The database moved out of every clone into the shared root: one file, `~/.jaira/system/jaira.db`,
 * that the app loads its index from, while each clone keeps what is its own — settings, workflows,
 * task files, and any records its `storage` puts in files. So a row no longer says which project it
 * belongs to by which file it is in, and this module is what says it instead:
 *
 *  - **A workspace has an id**, minted on its first open into `system/workspace.id` and never
 *    committed. An id rather than the folder's path, so a clone moved on disk keeps its history, and
 *    a second clone of the same repository — which has the same committed files — does not share it.
 *  - **A task has one owner** (`task_owners`): the workspace that made it, claimed in the same
 *    statement that inserts its runtime row. Everything that reads or acts on tasks as a SET — the
 *    board, recovery, the gates still waiting, pruning — asks for its own workspace's, and a task
 *    another workspace owns is not in that set even when a pulled task file names it.
 *  - **A replica is one more owner**: another machine's workspace, its rows kept here for the window
 *    to read, registered with that machine's id.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal, type JairaPaths } from "@jaira/shared";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JairaDb } from "./db";

const log = createLogger("jaira.persistence.workspace");

/**
 * The SQL condition "this task is owned by the workspace bound to the one parameter" — for a query
 * over a table with a `task_id` column. `task_owners` is never file-backed, so the name always
 * resolves to the shared table.
 */
export const OWNED_BY = `task_id IN (SELECT task_id FROM task_owners WHERE workspace = ?)`;

/** This workspace's id, minted on first use. */
export function workspaceIdOf(paths: Pick<JairaPaths, "workspaceIdFile">): string {
  try {
    const id = readFileSync(paths.workspaceIdFile, "utf8").trim();
    if (id.length > 0) return id;
  } catch {
    // Not minted yet.
  }
  const id = randomUUID();
  mkdirSync(dirname(paths.workspaceIdFile), { recursive: true });
  writeFileSync(paths.workspaceIdFile, `${id}\n`, "utf8");
  return id;
}

/** Record where a workspace is — this machine's (`machine` absent) or a replica's. */
export function registerWorkspace(db: JairaDb, id: string, dir: string, machine?: string, nowMs = Date.now()): void {
  db.prepare(
    `INSERT INTO workspaces (id, machine, dir, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, dir = excluded.dir, updated_at = excluded.updated_at`,
  ).run(id, machine ?? null, dir, nowMs);
}

/** Which workspace owns a task, when one does. */
export function ownerOf(db: JairaDb, taskId: string): string | undefined {
  const row = db.prepare(`SELECT workspace FROM task_owners WHERE task_id = ?`).get(taskId) as { workspace: string } | undefined;
  return row?.workspace;
}

/**
 * Make `workspace` the owner of a task, or refuse because another is.
 *
 * Idempotent for the owner itself. The refusal is the whole point: two clones of one repository
 * share committed task files, and a task one of them ran is not the other's to start again.
 */
export function claimTask(db: JairaDb, workspace: string, taskId: string): void {
  db.prepare(`INSERT OR IGNORE INTO task_owners (task_id, workspace) VALUES (?, ?)`).run(taskId, workspace);
  const owner = ownerOf(db, taskId);
  if (owner !== workspace) {
    throw refusal(log, `task '${taskId}' belongs to another workspace${owner !== undefined ? ` (${owner})` : ""}`, { taskId });
  }
}

/**
 * Claim what no workspace owns yet for `workspace` — the shared root, whose records were the only
 * ones in this file before it held every workspace's (migration 21). Idempotent and cheap: every
 * row written since is claimed as it is inserted, so after the first open there is nothing to find.
 */
export function claimUnowned(db: JairaDb, workspace: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_owners (task_id, workspace)
       SELECT task_id, ? FROM main.task_runtime WHERE task_id NOT IN (SELECT task_id FROM task_owners)`,
  ).run(workspace);
  db.prepare(`UPDATE repo_watch_cursors SET workspace = ? WHERE workspace = ''`).run(workspace);
  db.prepare(`UPDATE repo_watch_seen SET workspace = ? WHERE workspace = ''`).run(workspace);
}

/**
 * Claim the rows a file-backed `tasks` concern replayed into this connection — a clone's own task
 * rows, or a pulled one's that no workspace has claimed. One another workspace owns stays theirs,
 * and is left out of everything this workspace lists.
 */
export function claimReplayed(db: JairaDb, workspace: string): void {
  const shadowed = db.prepare(`SELECT 1 FROM temp.sqlite_master WHERE type = 'table' AND name = 'task_runtime'`).get();
  if (shadowed === undefined) return;
  db.prepare(`INSERT OR IGNORE INTO task_owners (task_id, workspace) SELECT task_id, ? FROM temp.task_runtime`).run(workspace);
}
