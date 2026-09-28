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

export const MIGRATIONS: Migration[] = [];

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
