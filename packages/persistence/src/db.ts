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
import { createLogger, errorToJson } from "@declarative-ai/log";
import { Refusal } from "@jaira/shared";
import Database from "better-sqlite3";
import { migrate } from "./migrations";
import { abiAdvice, sqliteBinding } from "./nativeBinding";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.db");

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

-- Append-only journal of the engine's EngineEvent stream. BOOTSTRAP SHAPE under the
-- ORIGINAL name: migrations 1-3 build on 'events', and migration 4 renames it to
-- state_machine_events (CHANGESETS.md §5.1) — so this create must keep existing for a
-- fresh database to walk the same path an old one did. On an already-migrated database
-- this recreates an empty shell, which openDb drops again after migrating.
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

-- Process claims (DESIGN §4.2a). A run is HISTORY; a claim on a run is a fact about
-- NOW, and the two have different lifetimes — so columns on runs would leave dead
-- pid/heartbeat fields on every historical row and overwrite the previous claim on
-- each re-run.
--
-- kind='run'     : a process claiming a workflow run.
-- kind='process' : a child JaiRA spawned (git, wsl.exe, claude, a bash command),
--                  pointing at the run job that owns it. Untracked before this, so
--                  an orphaned agent kept running and spending money invisibly.
--
-- owner_token is a random per-PROCESS id: liveness is "did that token heartbeat
-- recently", which needs no pid semantics at all. pid is recorded only to report a
-- process to a human and (carefully) to kill an orphan.
CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,   -- run | process
  task_id             TEXT,
  run_id              INTEGER,
  parent_job_id       INTEGER REFERENCES jobs(id),
  owner_token         TEXT NOT NULL,
  pid                 INTEGER,
  command             TEXT,
  started_at          INTEGER NOT NULL,
  heartbeat_at        INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  ended_at            INTEGER,
  outcome             TEXT
);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs(ended_at, heartbeat_at);
CREATE INDEX IF NOT EXISTS jobs_task ON jobs(task_id, id);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner_token, ended_at);

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
  -- The interactive flag is added by migration 6 and deliberately NOT declared here: a fresh
  -- database walks the same path an old one did, and a column declared in both places is a
  -- duplicate-column error on every first open.
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id, id);
-- Memoized model answers, keyed by memoKey (declarative-ai exec/memo.ts): the
-- operation's content hash folded with the executor namespace. Durable on purpose --
-- an in-process map answers "would someone else making this identical call reuse the
-- answer?" only within one run, which is not where the cost repeats.
--
-- No FK to runs or tasks: the whole point is that a later run, task or process hits
-- an entry an earlier one wrote. created_at is what pruning would sort on.
CREATE TABLE IF NOT EXISTS call_memo (
  key        TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL,   -- JSON: a successful ExecResult
  created_at INTEGER NOT NULL
);
-- One row wins per (task, logical path): a rewrite replaces, so a read resolves to
-- the latest without every consumer sorting.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_logical ON artifacts(task_id, logical_path);
`;

/**
 * Open the store.
 *
 * The addon is named explicitly when a build for this runtime's ABI is cached — see
 * `nativeBinding.ts`. That is what lets the same `node_modules` serve the tests (Node) and the app
 * (Electron) without either of them swapping a file the other is using. With nothing cached, the
 * package finds its own, which is the ordinary case for an installed copy.
 */
export function openDb(file: string): JairaDb {
  const binding = sqliteBinding();
  const db = openWithAdvice(file, binding);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // AFTER the schema, so a fresh database gets every table before a migration tries to alter one —
  // and so a step that adds a column runs against the table `SCHEMA` has just guaranteed exists.
  migrate(db);
  // SCHEMA bootstraps the legacy `events` table for migrations 1-3 to build on; once migration 4
  // has renamed it to state_machine_events, the shell SCHEMA just recreated is empty and dead.
  // Guarded by emptiness, never by version alone: rows in it would mean unmigrated data, and
  // dropping data is not this function's call.
  const tableExists = (name: string): boolean =>
    (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { n: number })
      .n > 0;
  if (tableExists("state_machine_events") && tableExists("events")) {
    const shell = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    if (shell.n === 0) db.exec(`DROP TABLE events`);
  }
  return db;
}

/**
 * `new Database`, with the one failure worth translating.
 *
 * An ABI mismatch is the single error here that is about the developer's machine rather than about
 * the database, and Node reports it as two version numbers with no remedy attached. Rethrown with
 * the command that fixes it — and rethrown, not swallowed: there is no opening this file without it.
 */
function openWithAdvice(file: string, binding: string | undefined): JairaDb {
  try {
    return binding !== undefined ? new Database(file, { nativeBinding: binding }) : new Database(file);
  } catch (e) {
    const advice = abiAdvice(e);
    if (advice === undefined) throw e;
    // Not through `refusal`, and the reason is the `cause`: this is the one refusal here that chains
    // the underlying error, and losing that would leave the advice with no way back to the ABI
    // mismatch it is advice ABOUT. So the line is written by hand and the marker applied by hand.
    log.warn(advice, { file, cause: errorToJson(e) });
    throw new Refusal(advice, { cause: e });
  }
}
