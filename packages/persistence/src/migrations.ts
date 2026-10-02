/**
 * Schema changes after the baseline.
 *
 * `db.ts` creates a new database whole, from one `SCHEMA` constant, and stamps it
 * {@link SCHEMA_BASELINE}. Everything before that was a history of 24 steps; every database there was
 * had been brought to 24, and the steps were deleted with the readers of the older shapes they carried
 * (no-back-compat rule, 2026-09-27). A database older than the baseline is refused, not converted.
 *
 * A later change is a step here, because `CREATE TABLE IF NOT EXISTS` handles a new TABLE and no column
 * at all: an added column would reach a fresh database and silently skip every existing one. So:
 * `PRAGMA user_version` as the marker, an ordered list starting at `SCHEMA_BASELINE + 1`, each step
 * applied once, in a transaction — and folded into `SCHEMA` (with the baseline raised) once every
 * database has taken it.
 *
 * Rules for adding one:
 *
 *  - **Append, never edit.** A shipped migration has already run somewhere; changing it changes only
 *    what a fresh database gets, and the two then disagree forever.
 *  - **Make it idempotent where SQLite lets you** (`IF NOT EXISTS`), so a half-applied step is
 *    recoverable by re-running rather than by hand.
 *  - **`ALTER TABLE ADD COLUMN` may only add a VIRTUAL generated column**, never a `STORED` one —
 *    SQLite rejects the latter outright, because it would have to rewrite every existing row.
 *  - **Change `SCHEMA` too**, so a fresh database is born in the shape the step leaves an old one in.
 */
import type { JairaDb } from "./db";

/** The version `SCHEMA` creates a database at. */
export const SCHEMA_BASELINE = 24;

export interface Migration {
  /** The `user_version` this step brings the database TO. Sequential from `SCHEMA_BASELINE + 1`. */
  version: number;
  /** What it is for, in the past tense — read by whoever is wondering why their schema moved. */
  note: string;
  sql?: string;
  /** A step SQL cannot express (a data migration over stored JSON), run after `sql` in the same transaction. */
  run?: (db: JairaDb) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 25,
    note: "decision 0016: the watcher's checks became pipelines, and the remote events were renamed (git.push → git.pushed, git.merge_request.* → merge_request.*, git.merge_request.comments → merge_request.commented, git.checks.failed → pipeline.failed)",
    // A CHECK constraint cannot be altered, so the table is rebuilt; a head's `checks` row keeps its
    // shape ({ sha, done, since }) under its new kind.
    sql: `
CREATE TABLE repo_watch_seen_next (
  workspace  TEXT NOT NULL DEFAULT '',
  remote     TEXT NOT NULL,
  repository TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('merge_request', 'branch', 'pipelines')),
  key        TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, remote, repository, kind, key)
);
INSERT INTO repo_watch_seen_next (workspace, remote, repository, kind, key, state_json, updated_at)
  SELECT workspace, remote, repository, CASE kind WHEN 'checks' THEN 'pipelines' ELSE kind END, key, state_json, updated_at FROM repo_watch_seen;
DROP TABLE repo_watch_seen;
ALTER TABLE repo_watch_seen_next RENAME TO repo_watch_seen;
UPDATE repo_watch_cursors
  SET cursor_json = json_remove(json_set(cursor_json, '$.pipelines', json('true')), '$.checks')
  WHERE json_extract(cursor_json, '$.checks') IS NOT NULL;
UPDATE event_waits SET name = CASE name
  WHEN 'git.push' THEN 'git.pushed'
  WHEN 'git.merge_request.opened' THEN 'merge_request.opened'
  WHEN 'git.merge_request.updated' THEN 'merge_request.updated'
  WHEN 'git.merge_request.comments' THEN 'merge_request.commented'
  WHEN 'git.merge_request.merged' THEN 'merge_request.merged'
  WHEN 'git.merge_request.closed' THEN 'merge_request.closed'
  WHEN 'git.checks.failed' THEN 'pipeline.failed'
  ELSE name END;
`,
  },
];

/**
 * Bring one database up to date. Called on every open, and a no-op once it is.
 *
 * Each step runs in its own transaction with the version bump inside it, so an interrupted upgrade
 * leaves the database at the last version that fully applied rather than part-way through one.
 */
export function migrate(db: JairaDb, migrations: readonly Migration[] = MIGRATIONS): number {
  let at = read(db);
  for (const migration of migrations) {
    if (migration.version <= at) continue;
    // IMMEDIATE, and the version is re-read INSIDE: several processes open one database by design, and
    // a deferred transaction takes its write lock only at the first statement — two would both read the
    // old version and the loser would apply an already-applied step.
    db.transaction(() => {
      if (read(db) >= migration.version) return; // the other process got here first
      if (migration.sql !== undefined) db.exec(migration.sql);
      migration.run?.(db);
      // Interpolated because SQLite does not accept a parameter in a PRAGMA. Safe by construction:
      // the value is a number from this file, never from input.
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
    at = Math.max(at, migration.version);
  }
  return read(db);
}

export const read = (db: JairaDb): number => Number((db.pragma("user_version", { simple: true }) as number | bigint) ?? 0);
