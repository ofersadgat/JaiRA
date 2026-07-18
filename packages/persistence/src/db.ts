/**
 * SQLite execution store — `.jaira/jaira.db` (DESIGN §4).
 *
 * v1 scope (DESIGN §1a item 1 / §4.3 revision): the engine runs in-process and
 * emits a complete `EngineEvent` stream; JaiRA records that stream plus
 * task-level lifecycle. The §4.2 materialized tables (`instances`,
 * `operations`, `transitions`, …) arrive with step-level durable resume in
 * `@ai-exec/hw`; the tables here are shaped so they can be added alongside
 * without migration of what exists.
 */
import Database from "better-sqlite3";

export type JairaDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_runtime (
  task_id          TEXT PRIMARY KEY,
  status           TEXT NOT NULL,
  snapshot_hash    TEXT,
  branch           TEXT,
  worktree_path    TEXT,
  root_instance_id INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- One row per workflow-level execution attempt of a task. Workflow-level
-- recovery means a task may accumulate several runs (initial + re-runs after
-- interruption); events reference the run they belong to.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES task_runtime(task_id),
  snapshot_hash TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  outcome       TEXT,        -- success | error | canceled | interrupted
  outputs_json  TEXT,
  failure_json  TEXT
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, id);

-- Append-only journal of the engine's EngineEvent stream (DESIGN §4.2 'events').
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  instance_id  INTEGER,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
`;

export function openDb(file: string): JairaDb {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
