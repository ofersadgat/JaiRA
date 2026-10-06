/**
 * The SQLite store — `~/.jaira/system/jaira.db`, one for every workspace on the machine (decision 0013
 * §4). Each task is owned by the workspace that made it (`task_owners`); see `workspace.ts`.
 *
 * `SCHEMA` is the whole current shape, and a new database is created from it in one step and stamped
 * `SCHEMA_BASELINE`. A change after that is a step in `migrations.ts` AND a change here.
 */
import Database from "better-sqlite3";
import { migrate, read, SCHEMA_BASELINE } from "./migrations";
import { SYNC_SQL } from "./sync";
import { WINDOW_STATES_SQL } from "./windowStates";

export type JairaDb = Database.Database;

const SCHEMA = `
-- A task's machine as it stands: one row per task, its status and how it last ended. A task IS its
-- run; re-running makes another task that points back (parent_task_id). archived_from/archived_at say
-- how an archived task had finished and when (decision 0014).
CREATE TABLE task_runtime (
  task_id           TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  snapshot_hash     TEXT,
  branch            TEXT,
  worktree_path     TEXT,
  root_instance_id  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  parent_task_id    TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  outcome           TEXT,            -- success | error | canceled | interrupted
  outputs_json      TEXT,
  failure_json      TEXT,
  forked_at_seq     INTEGER,         -- a fork: the parent's journal position it was cut at
  fork_boundary_seq INTEGER,         -- and the copy's own last journaled event
  document_id       TEXT,
  archived_from     TEXT,
  archived_at       INTEGER
);

-- The append-only journal of the engine's EngineEvent stream. session_ref is where a call ended in
-- its conversation, operation_id the call it was about: generated, so they cannot drift from the event.
CREATE TABLE state_machine_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  instance_id  TEXT,                 -- durable UUIDv7
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  session_ref  TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.metrics.sessionRef')) VIRTUAL,
  operation_id TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.operationId')) VIRTUAL
);
CREATE INDEX state_machine_events_task ON state_machine_events(task_id, seq);
CREATE INDEX state_machine_events_session ON state_machine_events(session_ref);
CREATE INDEX state_machine_events_operation ON state_machine_events(operation_id);

-- The command audit trail (DESIGN §4.2, §10.2): every command an agent asked for, what policy decided,
-- and — when escalated — the person's answer and its scope.
CREATE TABLE command_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  command     TEXT,
  parsed_json TEXT,
  decision    TEXT NOT NULL,         -- allowed | blocked | approved | denied
  decided_by  TEXT NOT NULL,         -- policy | user
  reason      TEXT,
  scope       TEXT,                  -- once | session | workflow-run | always
  session_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX command_log_task ON command_log(task_id, id);

-- Process claims (DESIGN §4.2a): a fact about NOW, apart from the history in task_runtime.
--   kind='run'     : a process claiming a task's run.
--   kind='process' : a child JaiRA spawned (git, claude, a shell command), under the run job that owns
--                    it — so an orphaned agent still running and spending is found.
-- owner_token is a random per-PROCESS id: liveness is "did that token heartbeat recently". pid is kept
-- only to report a process to a person and, carefully, to end an orphan.
CREATE TABLE jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,
  task_id             TEXT,
  parent_job_id       INTEGER REFERENCES jobs(id),
  owner_token         TEXT NOT NULL,
  pid                 INTEGER,
  command             TEXT,
  started_at          INTEGER NOT NULL,
  heartbeat_at        INTEGER NOT NULL,
  cancel_requested_at INTEGER,
  ended_at            INTEGER,
  outcome             TEXT,
  cwd                 TEXT
);
CREATE INDEX jobs_open ON jobs(ended_at, heartbeat_at);
CREATE INDEX jobs_task ON jobs(task_id, id);
CREATE INDEX jobs_owner ON jobs(owner_token, ended_at);

-- What a child process wrote, kept so a failure can say what the process said before it died.
CREATE TABLE job_output (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL,
  stream     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  chunk      TEXT NOT NULL,
  dropped    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX job_output_job ON job_output(job_id, stream, seq);

-- The artifact map (DESIGN §7.6): what a producer said it wrote (logical_path) and where the bytes went
-- (physical_path, NULL for a virtual destination). One row wins per (task, logical path).
CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  logical_path  TEXT NOT NULL,
  physical_path TEXT,
  content       TEXT,                -- an inline copy, for virtual and small files
  hash          TEXT NOT NULL,       -- sha-256: identity independent of location
  bytes         INTEGER NOT NULL,
  format        TEXT,
  instance_id   TEXT,
  state_id      TEXT,
  slot          TEXT,
  created_at    INTEGER NOT NULL,
  interactive   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX artifacts_task ON artifacts(task_id, id);
CREATE UNIQUE INDEX artifacts_logical ON artifacts(task_id, logical_path);

-- Memoized model answers, by memo key (declarative-ai exec/memo.ts). No task: a later run or process
-- hits what an earlier one wrote.
CREATE TABLE call_memo (
  key        TEXT PRIMARY KEY,
  outcome    TEXT NOT NULL,          -- JSON: a successful ExecResult
  created_at INTEGER NOT NULL
);

-- What a person has said may RUN: one row per js/ts module file (SPEC §7.5.5). mac is an HMAC over path
-- and hash keyed by a secret NOT in this file, so appending a row is not the same as being approved.
CREATE TABLE module_approvals (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  mac         TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);

-- The model catalog as this machine last learned it (decision 0009): one row per route/model.
CREATE TABLE models (
  key          TEXT PRIMARY KEY,     -- {route}/{model}
  route        TEXT NOT NULL,
  row          TEXT NOT NULL,        -- JSON: a ModelInfoInterface
  source       TEXT,
  refreshed_at INTEGER NOT NULL
);

-- Conversation lineage: a session forks from a parent at a cursor. cut_at names the last message a
-- rewound session's rows still hold, so the next call copies the remote cut there.
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  parent              TEXT REFERENCES sessions(id),
  cursor              INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  provider            TEXT,
  provider_session_id TEXT,
  cut_at              TEXT
);

-- An authored name for a session within a task (an alias; the session is a UUID).
CREATE TABLE session_names (
  task_id    TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (task_id, name)
);

-- One call a run made: the whole ask (request_json, with its scope and its seat spliced in) and what
-- came back. The seat and scope are generated from the request; landed_* is where it really ran when a
-- fork moved it. op_position is the seat claim; op_effective serves every read by landed position.
CREATE TABLE operation_records (
  id                  TEXT PRIMARY KEY,                -- hash of the SCOPED request
  task_id             TEXT,
  status              TEXT NOT NULL DEFAULT 'open',    -- open | completed | failed | interrupted
  request_json        TEXT,
  result_json         TEXT,
  error_json          TEXT,
  metrics_json        TEXT,
  provider_session_id TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  landed_session_id   TEXT,
  landed_seq          INTEGER,
  instance_id         TEXT GENERATED ALWAYS AS (json_extract(request_json, '$.scope.instanceId')) VIRTUAL,
  sequence            INTEGER GENERATED ALWAYS AS (json_extract(request_json, '$.scope.sequence')) VIRTUAL,
  session_id          TEXT GENERATED ALWAYS AS (json_extract(request_json, '$.session.id')) VIRTUAL,
  session_seq         INTEGER GENERATED ALWAYS AS (json_extract(request_json, '$.session.seq')) VIRTUAL
);
CREATE UNIQUE INDEX op_position ON operation_records(session_id, session_seq)
  WHERE status IN ('open', 'completed') AND landed_session_id IS NULL;
CREATE INDEX operation_records_session ON operation_records(session_id, session_seq);
CREATE INDEX operation_records_scope ON operation_records(task_id, id);
CREATE INDEX op_effective ON operation_records(COALESCE(landed_session_id, session_id), COALESCE(landed_seq, session_seq));

-- Big strings stored once by content hash (RECORDS.md §8); refs counts the records naming each.
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  refs       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX blobs_unreferenced ON blobs(refs) WHERE refs <= 0;

-- Gates parked and not yet answered (DESIGN §7.1): durable, so a run that dies holding one leaves the
-- question behind.
CREATE TABLE pending_interactions (
  request_id      TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  component       TEXT NOT NULL,
  inputs_json     TEXT NOT NULL,
  about           TEXT,
  subject_project TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX pending_interactions_task ON pending_interactions(task_id);

-- The merge requests tasks opened, and what each has already heard (decision 0004).
CREATE TABLE remote_handles (
  task_id         TEXT NOT NULL,
  key             TEXT NOT NULL,
  provider        TEXT NOT NULL,
  host            TEXT NOT NULL,
  project         TEXT NOT NULL,
  remote          TEXT NOT NULL,
  branch          TEXT NOT NULL,
  target          TEXT NOT NULL,
  number          INTEGER,
  url             TEXT,
  pushed_head     TEXT,
  cursor_json     TEXT NOT NULL DEFAULT '{}',
  seen_json       TEXT NOT NULL DEFAULT '[]',
  settle_at       INTEGER,
  settle_after_ms INTEGER,
  awaiting        INTEGER NOT NULL DEFAULT 0,
  request_id      TEXT,
  checked_at      INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (task_id, key)
);
CREATE INDEX remote_handles_awaiting ON remote_handles(awaiting) WHERE awaiting = 1;

-- When a task's guards first waited on each event name (decision 0010 §3).
CREATE TABLE event_waits (
  task_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  since   INTEGER NOT NULL,
  PRIMARY KEY (task_id, name)
);

-- The workspaces in this file (decision 0013 §4): this machine's (machine NULL) and replicas of other
-- machines'. task_owners says which one each task belongs to.
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  machine    TEXT,
  dir        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE task_owners (
  task_id   TEXT PRIMARY KEY,
  workspace TEXT NOT NULL
);
CREATE INDEX task_owners_workspace ON task_owners(workspace, task_id);

-- The repository watcher's memory (decision 0010 §2), per workspace: where the next look starts, and
-- the last state of each request, branch and branch head's pipelines.
CREATE TABLE repo_watch_cursors (
  workspace   TEXT NOT NULL DEFAULT '',
  remote      TEXT NOT NULL,
  repository  TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_error  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (workspace, remote, repository)
);
CREATE TABLE repo_watch_seen (
  workspace  TEXT NOT NULL DEFAULT '',
  remote     TEXT NOT NULL,
  repository TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('merge_request', 'branch', 'pipelines')),
  key        TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, remote, repository, kind, key)
);

-- What this machine holds of other machines' tasks (decision 0013 §6): per task, the owner's version
-- and how far into its journal; and where the owner's journal numbers landed here.
CREATE TABLE replica_versions (
  workspace  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  version    TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  events     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, task_id)
);
CREATE TABLE replica_seqs (
  workspace  TEXT NOT NULL,
  remote_seq INTEGER NOT NULL,
  local_seq  INTEGER NOT NULL,
  PRIMARY KEY (workspace, remote_seq)
);
CREATE INDEX replica_seqs_local ON replica_seqs(local_seq);
${SYNC_SQL}
${WINDOW_STATES_SQL}
`;

/**
 * Open the store: a new database is created whole from `SCHEMA`; an existing one is brought forward by
 * the steps after the baseline; one older than the baseline is refused.
 *
 * The addon is a Node-API build (better-sqlite3 13), so the one binary the package ships for this
 * platform serves Node and Electron alike.
 */
export function openDb(file: string): JairaDb {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // So an `INSERT OR REPLACE` that removes a conflicting row fires that row's DELETE trigger, and the
  // change log (decision 0018, `sync.ts`) gets its tombstone: SQLite skips delete triggers on a
  // replace's implicit delete otherwise. The log's triggers write only `sync_changes`, which has none.
  db.pragma("recursive_triggers = ON");
  if (read(db) < SCHEMA_BASELINE) {
    try {
      // IMMEDIATE, and asked again inside: two processes opening a new file at once must create it once.
      db.transaction(() => {
        const version = read(db);
        if (version >= SCHEMA_BASELINE) return;
        const tables = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
        if (version > 0 || tables > 0) {
          throw new Error(
            `${file} was made by a JaiRA older than this one's database (version ${version}, and this one starts at ${SCHEMA_BASELINE}); it can no longer be read — move it aside to start a new one`,
          );
        }
        db.exec(SCHEMA);
        db.pragma(`user_version = ${SCHEMA_BASELINE}`);
      }).immediate();
    } catch (e) {
      db.close();
      throw e;
    }
  }
  migrate(db);
  return db;
}
