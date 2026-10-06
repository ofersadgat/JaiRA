/**
 * The change log every reader syncs from (decision 0018 §3–§5).
 *
 * One row per thing that changed — `(collection, id)` — with the time it last changed, the task it
 * belongs to where it belongs to one, and whether the change was its deletion (a tombstone, §4). A
 * reader holding cursor T asks for everything at or after T (`changesSince`, inclusive: the rows at T
 * come again and are upserted by id, which is never ordered on).
 *
 * **Written by triggers**, not by the code that writes the rows. A trigger runs inside the statement
 * that fires it, so the stamp is taken inside the write that saves the row (§3): a row cannot become
 * visible behind a reader's cursor. And it holds for every writer — the ones that exist, the ones not
 * written yet, and another process writing the same database (`jaira` from a terminal) — with nothing
 * to remember. What the database does not hold (a task's file, a gate the engine keeps in memory) is
 * entered by {@link touch}, with the same clock.
 *
 * **The clock** is this machine's milliseconds, never behind the newest stamp in the log
 * (`max(now, newest)`): a wall clock stepped backwards cannot put a change behind a cursor. Two changes
 * in one millisecond share a stamp, which the inclusive read is for.
 */
import type { SyncChange } from "@jaira/shared";
import type { JairaDb } from "./db";

/** A collection a reader syncs, and the table rows of it are entered from. */
interface Tracked {
  table: string;
  collection: string;
  /** The row's id, as SQL over `NEW`/`OLD` written `R` (substituted). */
  id: string;
  /** The task it belongs to, or `NULL`. */
  task: string;
  /** Only these columns' updates count — a heartbeat is not a change anybody reads. */
  updateOf?: string[];
}

const TRACKED: readonly Tracked[] = [
  { table: "task_runtime", collection: "task", id: "R.task_id", task: "R.task_id" },
  { table: "task_owners", collection: "task", id: "R.task_id", task: "R.task_id" },
  { table: "state_machine_events", collection: "event", id: "CAST(R.seq AS TEXT)", task: "R.task_id" },
  { table: "operation_records", collection: "record", id: "R.id", task: "R.task_id" },
  { table: "pending_interactions", collection: "gate", id: "R.request_id", task: "R.task_id" },
  { table: "artifacts", collection: "artifact", id: "CAST(R.id AS TEXT)", task: "R.task_id" },
  { table: "session_names", collection: "sessionName", id: "R.task_id || '/' || R.name", task: "NULLIF(R.task_id, '')" },
  { table: "sessions", collection: "session", id: "R.id", task: "NULL" },
  { table: "remote_handles", collection: "remote", id: "R.task_id || '/' || R.key", task: "R.task_id" },
  { table: "event_waits", collection: "wait", id: "R.task_id || '/' || R.name", task: "R.task_id" },
  { table: "jobs", collection: "job", id: "CAST(R.id AS TEXT)", task: "R.task_id", updateOf: ["ended_at", "outcome", "cancel_requested_at"] },
  { table: "module_approvals", collection: "moduleApproval", id: "R.path", task: "NULL" },
  { table: "workspaces", collection: "workspace", id: "R.id", task: "NULL" },
];

/** The stamp: this machine's milliseconds, never behind the newest in the log. */
const CLOCK = `MAX(CAST(unixepoch('subsec') * 1000 AS INTEGER), COALESCE((SELECT MAX(at) FROM sync_changes), 0))`;

function entry(t: Tracked, row: "NEW" | "OLD", deleted: 0 | 1): string {
  const id = t.id.replaceAll("R.", `${row}.`);
  const task = t.task.replaceAll("R.", `${row}.`);
  return `INSERT INTO sync_changes (collection, id, task_id, at, deleted) VALUES ('${t.collection}', ${id}, ${task}, ${CLOCK}, ${deleted})
    ON CONFLICT (collection, id) DO UPDATE SET task_id = excluded.task_id, at = excluded.at, deleted = excluded.deleted;`;
}

function triggers(t: Tracked): string {
  const on = (event: string, row: "NEW" | "OLD", deleted: 0 | 1): string =>
    `CREATE TRIGGER IF NOT EXISTS sync_${t.table}_${event.split(" ")[0]!.toLowerCase()} AFTER ${event} ON ${t.table} BEGIN ${entry(t, row, deleted)} END;`;
  return [
    on("INSERT", "NEW", 0),
    on(t.updateOf === undefined ? "UPDATE" : `UPDATE OF ${t.updateOf.join(", ")}`, "NEW", 0),
    on("DELETE", "OLD", 1),
  ].join("\n");
}

/**
 * The log, its triggers, and the horizon below which tombstones have been dropped. Idempotent, so it is
 * both a migration's step and part of a fresh database's schema.
 */
export const SYNC_SQL = `
CREATE TABLE IF NOT EXISTS sync_changes (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  task_id    TEXT,
  at         INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS sync_changes_at ON sync_changes(at);
CREATE INDEX IF NOT EXISTS sync_changes_task ON sync_changes(task_id, at);
CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
${TRACKED.map(triggers).join("\n")}
`;

/**
 * Enter a change the database does not see: a task's file, a gate held in memory, the placement queue.
 * The same clock as the triggers; `deleted` leaves a tombstone.
 */
export function touch(db: JairaDb, collection: string, id: string, taskId: string | null = null, deleted = false): void {
  db.prepare(
    `INSERT INTO sync_changes (collection, id, task_id, at, deleted) VALUES (?, ?, ?, ${CLOCK}, ?)
     ON CONFLICT (collection, id) DO UPDATE SET task_id = excluded.task_id, at = excluded.at, deleted = excluded.deleted`,
  ).run(collection, id, taskId, deleted ? 1 : 0);
}

/** The newest stamp in the log — the cursor a reader that has read everything holds. 0 for an empty log. */
export function syncNow(db: JairaDb): number {
  const row = db.prepare(`SELECT MAX(at) AS at FROM sync_changes`).get() as { at: number | null };
  return row.at ?? 0;
}

/**
 * Below this, tombstones have been dropped: a reader whose cursor is older cannot know what was deleted
 * since, and reloads whole (§4). 0 while none ever has been.
 */
export function syncHorizon(db: JairaDb): number {
  const row = db.prepare(`SELECT value FROM sync_meta WHERE key = 'horizon'`).get() as { value: number } | undefined;
  return row?.value ?? 0;
}

/**
 * Everything at or after `since` (inclusive), oldest first — optionally of one task, or of some
 * collections. Rows sharing the last stamp come again on the next read; a reader upserts by id.
 */
export function changesSince(db: JairaDb, since: number, options: { taskId?: string; collections?: readonly string[] } = {}): SyncChange[] {
  const where = ["at >= ?"];
  const args: unknown[] = [since];
  if (options.taskId !== undefined) {
    where.push("task_id = ?");
    args.push(options.taskId);
  }
  if (options.collections !== undefined && options.collections.length > 0) {
    where.push(`collection IN (${options.collections.map(() => "?").join(", ")})`);
    args.push(...options.collections);
  }
  const rows = db.prepare(`SELECT collection, id, task_id, at, deleted FROM sync_changes WHERE ${where.join(" AND ")} ORDER BY at`).all(...args) as Array<{
    collection: string;
    id: string;
    task_id: string | null;
    at: number;
    deleted: number;
  }>;
  return rows.map((r) => ({ collection: r.collection, id: r.id, taskId: r.task_id, at: r.at, deleted: r.deleted === 1 }));
}

/**
 * Drop tombstones older than `keepMs` (§4), raising the horizon to the newest dropped. A live row's entry
 * is never dropped: it is where a reader learns the row's time.
 */
export function pruneTombstones(db: JairaDb, keepMs: number, nowMs = Date.now()): number {
  const cutoff = nowMs - keepMs;
  return db.transaction(() => {
    const newest = db.prepare(`SELECT MAX(at) AS at FROM sync_changes WHERE deleted = 1 AND at < ?`).get(cutoff) as { at: number | null };
    if (newest.at === null) return 0;
    const dropped = db.prepare(`DELETE FROM sync_changes WHERE deleted = 1 AND at < ?`).run(cutoff).changes;
    db.prepare(`INSERT INTO sync_meta (key, value) VALUES ('horizon', ?) ON CONFLICT (key) DO UPDATE SET value = MAX(value, excluded.value)`).run(newest.at);
    return dropped;
  })();
}

/** How long a tombstone is kept (§4, proposed 30 days). */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
