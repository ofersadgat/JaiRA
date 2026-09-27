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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDb, type JairaDb } from "./db";

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

// ---------------------------------------------------------------------------------------------
// The clone's own database, merged once and retired.
//
// The migration of decision 0013 §4 and nothing else: once every clone a person has has been opened
// by a build with it, this section and its caller go (no-back-compat rule).
// ---------------------------------------------------------------------------------------------

/** Where a clone kept its database before decision 0013. */
export function legacyDbFile(paths: Pick<JairaPaths, "systemDir">): string {
  return join(paths.systemDir, "jaira.db");
}

export interface LegacyMerge {
  /** Tasks whose records moved into the shared database. */
  merged: string[];
  /**
   * Tasks left behind because the shared database already has them — a pulled task file another
   * clone ran as well. Their rows stay in the old file, renamed `jaira.db.unmerged`, rather than
   * being thrown away.
   */
  skipped: string[];
}

/** The columns two copies of a table share (generated ones excluded), quoted for a statement. */
function sharedColumns(db: JairaDb, table: string, except: readonly string[] = []): string[] {
  const of = (schema: string): Set<string> =>
    new Set((db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>).map((c) => c.name));
  const main = of("main");
  const legacy = of("legacy");
  return [...main].filter((c) => legacy.has(c) && !except.includes(c));
}

const hasTable = (db: JairaDb, schema: string, table: string): boolean =>
  db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;

/** The next free value of an AUTOINCREMENT key, counting ids used and since deleted. */
function nextId(db: JairaDb, table: string, column: string): number {
  const used = (db.prepare(`SELECT COALESCE(MAX(${column}), 0) AS n FROM main.${table}`).get() as { n: number }).n;
  const sequence = hasTable(db, "main", "sqlite_sequence")
    ? ((db.prepare(`SELECT seq FROM main.sqlite_sequence WHERE name = ?`).get(table) as { seq: number } | undefined)?.seq ?? 0)
    : 0;
  return Math.max(used, sequence);
}

/**
 * Move a clone's `system/jaira.db` into the shared database, owned by `workspace`, and remove it.
 *
 * Journal sequence numbers and job ids are shifted past the ones already here — order is kept, and
 * so is every reference to them (a fork's cut and boundary, a job's parent, a job's output). Ids
 * that are never pointed at (command log, job output, artifact rows) are left for the table to mint.
 * The two tables only the shared root was ever asked for — module approvals and the model catalog —
 * are not carried.
 */
export function mergeLegacyDb(db: JairaDb, paths: Pick<JairaPaths, "systemDir" | "dbFile">, workspace: string): LegacyMerge | undefined {
  const file = legacyDbFile(paths);
  if (resolve(file) === resolve(paths.dbFile) || !existsSync(file)) return undefined;
  // Brought to this schema first, so the two copies of every table have the same columns.
  openDb(file).close();
  db.prepare(`ATTACH DATABASE ? AS legacy`).run(file);
  let result: LegacyMerge;
  try {
    result = db.transaction((): LegacyMerge => {
      const tasks = (db.prepare(`SELECT task_id FROM legacy.task_runtime`).all() as Array<{ task_id: string }>).map((r) => r.task_id);
      const taken = new Set(
        (
          db
            .prepare(
              `SELECT task_id FROM legacy.task_runtime
                WHERE task_id IN (SELECT task_id FROM main.task_runtime) OR task_id IN (SELECT task_id FROM main.task_owners)`,
            )
            .all() as Array<{ task_id: string }>
        ).map((r) => r.task_id),
      );
      db.exec(`CREATE TEMP TABLE merge_skip (task_id TEXT PRIMARY KEY)`);
      const skip = db.prepare(`INSERT INTO merge_skip (task_id) VALUES (?)`);
      for (const id of taken) skip.run(id);
      const KEEP = `task_id NOT IN (SELECT task_id FROM temp.merge_skip)`;

      const seqShift = nextId(db, "state_machine_events", "seq");
      const jobShift = nextId(db, "jobs", "id");

      const copy = (table: string, opts: { where?: string; except?: string[]; values?: Record<string, string>; or?: string } = {}): void => {
        if (!hasTable(db, "legacy", table)) return;
        const columns = sharedColumns(db, table, opts.except);
        const values = columns.map((c) => opts.values?.[c] ?? `"${c}"`);
        db.exec(
          `INSERT ${opts.or ?? ""} INTO main."${table}" (${columns.map((c) => `"${c}"`).join(", ")})
             SELECT ${values.join(", ")} FROM legacy."${table}" ${opts.where !== undefined ? `WHERE ${opts.where}` : ""}`,
        );
      };

      // Parents before children: `main` keeps its foreign keys.
      copy("task_runtime", {
        where: KEEP,
        values: {
          forked_at_seq: `CASE WHEN forked_at_seq IS NULL THEN NULL ELSE forked_at_seq + ${seqShift} END`,
          fork_boundary_seq: `CASE WHEN fork_boundary_seq IS NULL THEN NULL ELSE fork_boundary_seq + ${seqShift} END`,
        },
      });
      db.prepare(`INSERT INTO main.task_owners (task_id, workspace) SELECT task_id, ? FROM legacy.task_runtime WHERE ${KEEP}`).run(workspace);
      copy("state_machine_events", { where: KEEP, values: { seq: `seq + ${seqShift}` } });
      // Lineage: a session is named by an assigned id, unique across databases, so one already here
      // is the same session.
      copy("sessions", { or: "OR IGNORE" });
      copy("operation_records", { where: KEEP });
      copy("session_names", { where: KEEP, or: "OR IGNORE" });
      copy("command_log", { where: KEEP, except: ["id"] });
      copy("artifacts", { where: KEEP, except: ["id"] });
      copy("pending_interactions", { where: KEEP });
      copy("remote_handles", { where: KEEP });
      copy("event_waits", { where: KEEP });
      copy("jobs", {
        where: `task_id IS NULL OR ${KEEP}`,
        values: { id: `id + ${jobShift}`, parent_job_id: `CASE WHEN parent_job_id IS NULL THEN NULL ELSE parent_job_id + ${jobShift} END` },
      });
      copy("job_output", {
        where: `job_id IN (SELECT id FROM legacy.jobs WHERE task_id IS NULL OR ${KEEP})`,
        except: ["id"],
        values: { job_id: `job_id + ${jobShift}` },
      });
      // Content-addressed: the same bytes are the same row, referenced by both databases' records.
      if (hasTable(db, "legacy", "blobs")) {
        const columns = sharedColumns(db, "blobs");
        db.exec(
          `INSERT INTO main.blobs (${columns.map((c) => `"${c}"`).join(", ")})
             SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM legacy.blobs WHERE true
           ON CONFLICT(hash) DO UPDATE SET refs = main.blobs.refs + excluded.refs`,
        );
      }
      copy("call_memo", { or: "OR IGNORE" });
      copy("repo_watch_cursors", { or: "OR REPLACE", values: { workspace: `'${workspace.replace(/'/g, "''")}'` } });
      copy("repo_watch_seen", { or: "OR REPLACE", values: { workspace: `'${workspace.replace(/'/g, "''")}'` } });
      db.exec(`DROP TABLE temp.merge_skip`);
      return { merged: tasks.filter((id) => !taken.has(id)), skipped: [...taken] };
    })();
  } finally {
    db.exec(`DETACH DATABASE legacy`);
  }
  // Retired: removed, or — when something was left behind — kept under a name nothing opens.
  const parts = [file, `${file}-wal`, `${file}-shm`];
  try {
    if (result.skipped.length > 0) {
      renameSync(file, `${file}.unmerged`);
      log.warn(`kept ${result.skipped.length} task(s) the shared database already had in ${file}.unmerged`, { skipped: result.skipped });
      for (const part of parts.slice(1)) rmSync(part, { force: true });
    } else {
      for (const part of parts) rmSync(part, { force: true });
    }
  } catch (err) {
    log.warn(`merged ${file} into the shared database but could not remove it`, { error: err instanceof Error ? err.message : String(err) });
  }
  log.info(`merged ${result.merged.length} task(s) from ${file} into the shared database`);
  return result;
}
