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
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/**
 * This workspace's id, for an open: {@link workspaceIdOf}, held to what the database knows.
 *
 * A clone's `workspace.id` is meant never to be committed — but a repository that committed it gives
 * every clone the same id, and each one opened re-registered the id under its own directory, taking
 * the other's tasks with it (seen 2026-10-06: two conversations made in one checkout read as "missing
 * task file" under another). So:
 *
 *  - **No file**: the id this directory is already registered under, else the one that owns the most
 *    of the task files in it — a file deleted (an ignore rule pulled in removes a once-committed one)
 *    must not orphan the tasks it owned — else a new one.
 *  - **A file whose id another live directory holds**: kept only if this directory has files of that
 *    id's tasks the other does not — where a task's file was written is where it was made, and a task
 *    file the repository committed is in both, so it says nothing. Otherwise this directory is a copy,
 *    and gets an id of its own.
 */
export function workspaceIdFor(db: JairaDb, paths: Pick<JairaPaths, "workspaceIdFile" | "projectDir" | "tasksDir">): string {
  const mint = (id: string = randomUUID()): string => {
    mkdirSync(dirname(paths.workspaceIdFile), { recursive: true });
    writeFileSync(paths.workspaceIdFile, `${id}\n`, "utf8");
    return id;
  };
  let id: string | undefined;
  try {
    id = readFileSync(paths.workspaceIdFile, "utf8").trim() || undefined;
  } catch {
    id = undefined;
  }
  if (id === undefined) {
    const here = (db.prepare(`SELECT id, dir FROM workspaces WHERE machine IS NULL`).all() as Array<{ id: string; dir: string }>).find((w) => sameDir(w.dir, paths.projectDir));
    return mint(here?.id ?? ownerOfFiles(db, paths.tasksDir));
  }
  const held = db.prepare(`SELECT dir FROM workspaces WHERE id = ? AND machine IS NULL`).get(id) as { dir: string } | undefined;
  if (held === undefined || sameDir(held.dir, paths.projectDir) || !holdsId(held.dir, id) || hasOwnTasksOf(db, id, paths.tasksDir, held.dir)) return id;
  return mint();
}

const sameDir = (a: string, b: string): boolean => {
  const norm = (dir: string): string => resolve(dir).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Whether `dir` — a project's checkout, or the shared root — still has `id` in its id file. */
function holdsId(dir: string, id: string): boolean {
  for (const file of [join(dir, ".jaira", "system", "workspace.id"), join(dir, "system", "workspace.id")]) {
    try {
      if (readFileSync(file, "utf8").trim() === id) return true;
    } catch {
      // Not this layout.
    }
  }
  return false;
}

/** The workspace of this machine owning the most of the tasks whose files are in `tasksDir`, if any does. */
function ownerOfFiles(db: JairaDb, tasksDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(tasksDir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const ownerOf = db.prepare(`SELECT o.workspace AS id FROM task_owners o JOIN workspaces w ON w.id = o.workspace WHERE o.task_id = ? AND w.machine IS NULL`);
  const count = new Map<string, number>();
  for (const n of names) {
    const row = ownerOf.get(n.slice(0, -".json".length)) as { id: string } | undefined;
    if (row !== undefined) count.set(row.id, (count.get(row.id) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Whether `tasksDir` has the file of a task `id` owns that the directory `other` does not have. */
function hasOwnTasksOf(db: JairaDb, id: string, tasksDir: string, other: string): boolean {
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
  };
  const theirs = new Set([...names(join(other, ".jaira", "system", "tasks")), ...names(join(other, "system", "tasks"))]);
  const owned = db.prepare(`SELECT 1 FROM task_owners WHERE task_id = ? AND workspace = ?`);
  return names(tasksDir).some((n) => !theirs.has(n) && owned.get(n.slice(0, -".json".length), id) !== undefined);
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
 * Claim the rows a file-backed `tasks` concern replayed into this connection — a clone's own task
 * rows, or a pulled one's that no workspace has claimed. One another workspace owns stays theirs,
 * and is left out of everything this workspace lists.
 */
export function claimReplayed(db: JairaDb, workspace: string): void {
  const shadowed = db.prepare(`SELECT 1 FROM temp.sqlite_master WHERE type = 'table' AND name = 'task_runtime'`).get();
  if (shadowed === undefined) return;
  db.prepare(`INSERT OR IGNORE INTO task_owners (task_id, workspace) SELECT task_id, ? FROM temp.task_runtime`).run(workspace);
}
