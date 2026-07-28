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

-- The command audit trail (DESIGN §4.2 'command_log', §10.2): every command an
-- agent requested, what policy decided, and — when escalated — the human's answer
-- and its scope. The first of the deferred §4.2 tables to land, because policy is
-- the feature that needs it.
CREATE TABLE IF NOT EXISTS command_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  tool        TEXT NOT NULL,
  command     TEXT,
  parsed_json TEXT,
  decision    TEXT NOT NULL,   -- allowed | blocked | approved | denied
  decided_by  TEXT NOT NULL,   -- policy | user
  reason      TEXT,
  scope       TEXT,            -- once | session | workflow-run | always
  session_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS command_log_task ON command_log(task_id, id);
CREATE INDEX IF NOT EXISTS command_log_run ON command_log(run_id, id);

-- The artifact map (DESIGN §7.6, §4.2 'artifacts'): what a producer said it wrote
-- (logical_path) and where the bytes actually went (physical_path). This is what
-- makes a read of the logical path resolve in a later state or a later run — so it
-- is a table, not a per-process map.
--
-- No FK to runs: an artifact outlives the run that produced it (a worktree file is
-- the user's work product), and pruning decides separately whether to remove it.
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  run_id        INTEGER,
  logical_path  TEXT NOT NULL,
  physical_path TEXT,             -- NULL for a virtual: destination
  content       TEXT,             -- inline copy, for virtual and small files
  hash          TEXT NOT NULL,    -- sha-256: identity independent of location
  bytes         INTEGER NOT NULL,
  format        TEXT,
  instance_id   INTEGER,
  state_id      TEXT,
  slot          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id, id);
-- One row wins per (task, logical path): a rewrite replaces, so a read resolves to
-- the latest without every consumer sorting.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_logical ON artifacts(task_id, logical_path);
`;

export function openDb(file: string): JairaDb {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
