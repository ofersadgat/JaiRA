/**
 * Schema changes that `CREATE TABLE IF NOT EXISTS` cannot make.
 *
 * `db.ts` applies one `SCHEMA` constant on every open, which handles a NEW table perfectly and a new
 * COLUMN not at all: `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so
 * an added column reaches a fresh database and silently skips every existing one. That is a constraint
 * nobody can hold in their head — "we may only ever add tables" gets violated by accident, and the
 * symptom is a query that works on a new machine and fails on the one that has been running longest.
 *
 * So: `PRAGMA user_version` as the marker, an ordered list, each step applied once, in a transaction.
 *
 * Rules for adding one:
 *
 *  - **Append, never edit.** A shipped migration has already run somewhere; changing it changes only
 *    what a fresh database gets, and the two then disagree forever.
 *  - **Make it idempotent where SQLite lets you** (`IF NOT EXISTS`), so a half-applied step is
 *    recoverable by re-running rather than by hand.
 *  - **`ALTER TABLE ADD COLUMN` may only add a VIRTUAL generated column**, never a `STORED` one —
 *    SQLite rejects the latter outright, because it would have to rewrite every existing row.
 */
import type { JairaDb } from "./db";

export interface Migration {
  /** The `user_version` this step brings the database TO. Sequential from 1. */
  version: number;
  /** What it is for, in the past tense — read by whoever is wondering why their schema moved. */
  note: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    note: "expose a run's conversation position, so a state can be joined to the transcript it produced",
    // The position rides on the engine's own metrics: `withSessionPosition` reports the position a
    // call ENDED at as `<id>@<seq+1>`, and hw puts those metrics on `operation.completed`. So the
    // journal already carries the join — it was simply not queryable without reading every payload.
    //
    // GENERATED rather than copied: the value is derived from the payload on every read, so it cannot
    // drift from the event it came from. VIRTUAL because `ALTER TABLE` permits nothing else, and
    // because the cost of computing it is a JSON extract on rows a query has already narrowed.
    sql: `
      ALTER TABLE events ADD COLUMN session_ref TEXT
        GENERATED ALWAYS AS (json_extract(payload_json, '$.metrics.sessionRef')) VIRTUAL;
      CREATE INDEX IF NOT EXISTS events_session ON events(session_ref);
    `,
  },
  {
    version: 2,
    note: "keep conversations, which every run has always computed and thrown away",
    // A session is its RECORDS, ordered by `seq` — upstream's model, and why a record holds the whole
    // `LlmOutput` verbatim rather than being shredded into a message table. `sessions` is lineage
    // only: a branch stores what it appended and points at where it left its parent, so a fork of a
    // long conversation costs one row.
    //
    // The primary key on `(session_id, seq)` is not bookkeeping — it IS how a position is claimed, so
    // a second claim is a constraint violation rather than a check with a race in it.
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        parent     TEXT REFERENCES sessions(id),
        cursor     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_records (
        session_id   TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        record_id    TEXT NOT NULL,
        task_id      TEXT,
        run_id       INTEGER,
        result_json  TEXT,
        metrics_json TEXT,
        external_id  TEXT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      -- Scoped by SESSION, not global: a record id is <session>:<seq> and a session id is
      -- instance-scoped, so two runs of one workflow mint identical record ids. session_id already
      -- carries the run (see SessionScope), which makes the pair unique and the bare id not.
      CREATE UNIQUE INDEX IF NOT EXISTS operation_records_id ON operation_records(session_id, record_id);
      CREATE INDEX IF NOT EXISTS operation_records_run ON operation_records(task_id, run_id);
    `,
  },
  {
    version: 3,
    note: "keep what a child process printed, so a failed agent says why",
    // A CLI agent that fails prints the reason on stderr, and JaiRA sent that stream to /dev/null —
    // so "the agent exited 1" was the whole story. Stored in flushed chunks rather than per write:
    // a chatty child would otherwise put one synchronous INSERT per data event on the main thread.
    //
    // `dropped` is what was elided BEFORE a chunk. The sink keeps a head and a tail and discards the
    // middle, because the interesting parts of a failing process's output are its first error and its
    // last line, and the middle is repetition.
    sql: `
      CREATE TABLE IF NOT EXISTS job_output (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id     INTEGER NOT NULL,
        stream     TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        chunk      TEXT NOT NULL,
        dropped    INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_output_job ON job_output(job_id, stream, seq);
      ALTER TABLE jobs ADD COLUMN cwd TEXT;
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
    // IMMEDIATE, and the version is re-read INSIDE. JaiRA runs several processes against one project by
    // design (DESIGN §4.2a) — the app open while a CLI run starts is the ordinary case — and a deferred
    // transaction takes its write lock only at the first statement. Two processes would both read the
    // old version, both begin, and the loser would apply an already-applied step: `duplicate column
    // name`, thrown out of `openProject`.
    db.transaction(() => {
      if (read(db) >= migration.version) return; // the other process got here first
      db.exec(migration.sql);
      // Interpolated because SQLite does not accept a parameter in a PRAGMA. Safe by construction:
      // the value is a number from this file, never from input.
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
    at = Math.max(at, migration.version);
  }
  return read(db);
}

const read = (db: JairaDb): number => Number((db.pragma("user_version", { simple: true }) as number | bigint) ?? 0);
