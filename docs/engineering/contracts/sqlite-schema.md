---
id: engineering/contracts/sqlite-schema
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: schema
owned_by: [engineering/units/project-store]
consumers: ["@jaira/persistence stores, views.ts, load.ts, cut.ts, prune.ts and lifecycle.ts", "@jaira/app main service.ts through SqliteMemoCache, JobOutputSink and jobOutput over project.db", "shadow.ts, which copies each file-backed table's statement and indexes", "people reading system/jaira.db to diagnose"]
since: migration 17
siblings: [engineering/contracts/journal-events, engineering/contracts/storage-files, engineering/contracts/jaira-layout]
---

# SQLite schema

`system/jaira.db` is one SQLite database per project and one for the shared root, at `PRAGMA user_version` 17, built by the bootstrap `SCHEMA` in `db.ts` followed by `MIGRATIONS` in `migrations.ts`.

## A caller reads this contract to write persistence code or a migration, and reaches the tables through a store otherwise

**Use when.** Writing or reviewing a query in `@jaira/persistence`, adding a migration, or reading a database by hand to diagnose.

**Do not use when.** Reading an event's payload: [journal-events](journal-events.md). Reading or writing a file-backed concern's files: [storage-files](storage-files.md). Reading a task's metadata file: [task-file](task-file.md). Code outside `@jaira/persistence` goes through a store; the app's only direct uses of `project.db` are `SqliteMemoCache`, `JobOutputSink` and `jobOutput`.

## The shape is thirteen tables and one lazily created index table, grouped by what they record

Times are epoch milliseconds. A column marked generated is `VIRTUAL`, computed from JSON on read and indexable.

### The connection runs in WAL mode with foreign keys enforced

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `PRAGMA journal_mode` | text | yes | `wal`, set by `openDb` on every open |
| `PRAGMA foreign_keys` | boolean | yes | on; the schema declares two foreign keys, `sessions.parent` and `jobs.parent_job_id` |
| `PRAGMA user_version` | integer | yes | the last migration applied, 17 |

### `task_runtime` holds one row per task, and every fact about its one machine is a column

Primary key `task_id`. Since migration 16 it holds what the retired `runs` table held.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `task_id` | TEXT | yes | the task id, also the task file's name |
| `status` | TEXT | yes | `queued`, `running`, `stopping`, `completed`, `failed`, `canceled` or `interrupted` |
| `snapshot_hash` | TEXT | no | the pinned snapshot directory's name |
| `branch` | TEXT | no | the git branch the task is bound to |
| `worktree_path` | TEXT | no | the task's worktree directory |
| `root_instance_id` | TEXT | no | the machine's root instance; stamped by migration 16 for older tasks |
| `created_at`, `updated_at` | INTEGER | yes | row creation and last write |
| `parent_task_id` | TEXT | no | the task this one re-runs, forks or was fanned out from |
| `started_at`, `ended_at` | INTEGER | no | when the machine last started and last stopped; `ended_at` is cleared when it starts |
| `outcome` | TEXT | no | `success`, `error`, `canceled` or `interrupted` |
| `outputs_json`, `failure_json` | TEXT | no | the machine's outputs and its failure, as JSON |
| `forked_at_seq` | INTEGER | no | for a fork, the parent's journal `seq` the copy stops before |
| `fork_boundary_seq` | INTEGER | no | for a fork, the copy's own last copied journal `seq` |

### `state_machine_events` is the journal, one row per engine event

Primary key `seq INTEGER AUTOINCREMENT`. Indexes `state_machine_events_task (task_id, seq)`, `state_machine_events_session (session_ref)`, `state_machine_events_operation (operation_id)`. Column meanings are [journal-events](journal-events.md).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `seq` | INTEGER, autoincrement | yes | insertion order in this database |
| `task_id` | TEXT | yes | the task whose machine emitted the event |
| `instance_id` | TEXT | no | the event's instance; NULL when it has none |
| `type` | TEXT | yes | the event's type |
| `payload_json` | TEXT | yes | the event verbatim |
| `created_at` | INTEGER | yes | the event's time |
| `session_ref` | TEXT, generated from `$.metrics.sessionRef` | no | where the call's conversation ended, `<sessionId>@<seq>` |
| `operation_id` | TEXT, generated from `$.operationId` | no | the join to `operation_records.id` |

### `operation_records` holds one row per dispatched call, and its seat is part of its request

Primary key `id`. Indexes: the claim `op_position`, UNIQUE on `(session_id, session_seq) WHERE status IN ('open', 'completed') AND landed_session_id IS NULL`; `operation_records_session (session_id, session_seq)` for reads; `operation_records_scope (task_id, id)`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | TEXT | yes | the hash of the scoped request; rows migration 13 found colliding carry `<id>~~<n>` |
| `task_id` | TEXT | no | the task that made the call; NULL only for an unscoped store |
| `status` | TEXT | yes, default `open` | `open`, `completed`, `failed` or `interrupted` |
| `request_json` | TEXT | no | the operation as asked, with `scope {instanceId, sequence}` and `session {id, seq, providerSessionId?}` beside its fields |
| `result_json` | TEXT | no | what came back or what streamed so far; string leaves of 1024 characters or more are `{"$blob": <sha256>}` |
| `error_json`, `metrics_json` | TEXT | no | the failure and the call's metrics |
| `provider_session_id` | TEXT | no | the provider handle the call reported |
| `started_at` | INTEGER | yes | when the call was first dispatched |
| `ended_at` | INTEGER | no | when it last settled |
| `landed_session_id`, `landed_seq` | TEXT, INTEGER | no | where the call demonstrably ran when that is not its asked seat |
| `instance_id`, `sequence` | TEXT, INTEGER, generated from `$.scope.instanceId` and `$.scope.sequence` | no | the dispatch site |
| `session_id`, `session_seq` | TEXT, INTEGER, generated from `$.session.id` and `$.session.seq` | no | the asked seat; NULL for a call in no conversation |

### `sessions` and `session_names` hold conversation lineage and the names authors wrote

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `sessions.id` | TEXT, primary key | yes | a UUIDv7, `s_<seed>`, `<id>~<word><n>`, or a legacy `task/run/name` |
| `sessions.parent` | TEXT, references `sessions(id)` | no | the session this branch left |
| `sessions.cursor` | INTEGER, default 0 | yes | the parent seat this branch starts at |
| `sessions.created_at` | INTEGER | yes | creation time |
| `sessions.provider`, `sessions.provider_session_id` | TEXT | no | the conversation's current remote, set together or not at all |
| `sessions.cut_at` | TEXT | no | the provider message id a rewound remote is copied up to on its next use |
| `session_names.task_id` | TEXT, default `''` | yes | the task the alias belongs to; `''` for an unscoped store |
| `session_names.name` | TEXT | yes | what an author or the engine wrote; primary key with `task_id` |
| `session_names.session_id` | TEXT | yes | the session it names; no foreign key |

### `blobs` and `call_memo` hold content shared across records and calls

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `blobs.hash` | TEXT, primary key | yes | SHA-256 of `content` |
| `blobs.content` | TEXT | yes | the string leaf |
| `blobs.bytes` | INTEGER | yes | its length as a JavaScript string |
| `blobs.refs` | INTEGER, default 0 | yes | how many records name it; partial index `blobs_unreferenced` where `refs <= 0` |
| `blobs.created_at` | INTEGER | yes | first write |
| `call_memo.key` | TEXT, primary key | yes | upstream `memoKey` |
| `call_memo.outcome` | TEXT | yes | a successful `ExecResult` as JSON |
| `call_memo.created_at` | INTEGER | yes | first write |

### `jobs` and `job_output` record process claims and what child processes printed

Indexes `jobs_open (ended_at, heartbeat_at)`, `jobs_task (task_id, id)`, `jobs_owner (owner_token, ended_at)`, `job_output_job (job_id, stream, seq)`. Semantics are [process-claims](../units/process-claims.md).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `jobs.id` | INTEGER, autoincrement | yes | job id |
| `jobs.kind` | TEXT | yes | `run` for a run claim, `process` for a child |
| `jobs.task_id` | TEXT | no | the task |
| `jobs.parent_job_id` | INTEGER, references `jobs(id)` | no | the run job that owns a child |
| `jobs.owner_token` | TEXT | yes | the owning process's random token |
| `jobs.pid`, `jobs.command`, `jobs.cwd` | INTEGER, TEXT, TEXT | no | what was spawned and where |
| `jobs.started_at`, `jobs.heartbeat_at` | INTEGER | yes | start and last heartbeat |
| `jobs.cancel_requested_at`, `jobs.ended_at` | INTEGER | no | the cross-process cancel flag and the end |
| `jobs.outcome` | TEXT | no | how the job ended, such as `exit:0`, `released` or `abandoned` |
| `job_output.id` | INTEGER, autoincrement | yes | row id |
| `job_output.job_id`, `job_output.stream` | INTEGER, TEXT | yes | the job and `stdout` or `stderr` |
| `job_output.seq` | INTEGER | yes | 0 for the head chunk, 1 for the tail chunk |
| `job_output.chunk` | TEXT | yes | the kept output |
| `job_output.dropped` | INTEGER, default 0 | yes | how much output was elided before this chunk |
| `job_output.created_at` | INTEGER | yes | write time |

### `command_log`, `artifacts`, `pending_interactions` and `module_approvals` record decisions, outputs, questions and trust

Indexes `command_log_task (task_id, id)`, `artifacts_task (task_id, id)`, UNIQUE `artifacts_logical (task_id, logical_path)`, `pending_interactions_task (task_id)`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `command_log.id` | INTEGER, autoincrement | yes | row id |
| `command_log.task_id`, `tool` | TEXT | yes | the task and the tool asked for |
| `command_log.command`, `parsed_json` | TEXT | no | the command and its parse |
| `command_log.decision` | TEXT | yes | `allowed`, `blocked`, `approved` or `denied` |
| `command_log.decided_by` | TEXT | yes | `policy` or `user` |
| `command_log.reason`, `scope`, `session_id` | TEXT | no | why, for how long an answer holds, and the session |
| `command_log.created_at` | INTEGER | yes | decision time |
| `artifacts.id` | INTEGER, autoincrement | yes | row id |
| `artifacts.task_id`, `logical_path` | TEXT | yes | the task and the path the producer named; one row per pair |
| `artifacts.physical_path` | TEXT | no | where the bytes went; NULL for a virtual destination |
| `artifacts.content` | TEXT | no | an inline copy |
| `artifacts.hash`, `bytes` | TEXT, INTEGER | yes | SHA-256 and size of the bytes |
| `artifacts.format`, `instance_id`, `state_id`, `slot` | TEXT | no | media type and who produced it |
| `artifacts.created_at` | INTEGER | yes | write time |
| `artifacts.interactive` | INTEGER, default 0 | yes | 1 when the artifact may run its own scripts |
| `pending_interactions.request_id` | TEXT, primary key | yes | the hub's request id |
| `pending_interactions.task_id`, `component`, `inputs_json` | TEXT | yes | the task, the gate component and its whole request |
| `pending_interactions.about`, `subject_project` | TEXT | no | the task and project a review task is about |
| `pending_interactions.created_at` | INTEGER | yes | when the gate parked |
| `module_approvals.path` | TEXT, primary key | yes | an absolute module path |
| `module_approvals.hash`, `mac` | TEXT | yes | the approved content hash and its HMAC under the machine key |
| `module_approvals.approved_at` | INTEGER | yes | approval time |

### `storage_index` appears only once a `both` concern has replayed

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `concern` | TEXT, primary key | yes | `journal`, `conversations`, `tasks` or `artifacts` |
| `fingerprint` | TEXT | yes | see [storage-files](storage-files.md) |
| `built_at` | INTEGER | yes | when the index was rebuilt |

## Errors surface at open, and a constraint refusal is the store's signal rather than a fault

| Condition | Response | Caller does |
| --- | --- | --- |
| A migration step throws | the step's transaction rolls back and the error leaves `openDb` | fix the cause; the next open resumes from that step |
| No addon is cached or built for this runtime's ABI | `Refusal` carrying the loader's message and ``Run `npm run abi` `` advice | run the command |
| Another process holds the write lock past `better-sqlite3`'s busy timeout | `database is locked` | retry |
| An insert or reopen claims a live seat | `UNIQUE constraint failed` naming `operation_records.session_id` and `session_seq`; `SqliteSessionStore` raises `PositionTaken` | upstream forks the conversation |
| An insert reuses an `operation_records.id` | `UNIQUE constraint failed` on `operation_records.id`; the store reopens a non-completed row or refuses `record '<id>' has already settled` | a completed refusal is a caller bug |
| A `sessions` row is deleted while a child still names it | the statement fails on the foreign key, and a surrounding transaction rolls back | delete children first |
| An older build opens this database | it applies no step, and its queries on `runs`, `run_id` or `session_positions` fail | open with a current build |

## A change here breaks every database already on disk, so migrations only append and nothing rolls back

- Editing a shipped migration makes fresh and existing databases disagree forever. Add a step instead.
- A step is idempotent where SQLite allows: add a column through `addColumn`, and guard a rebuild on the table's own shape, never on `user_version`, because tests rewind the version and two processes can race.
- `ALTER TABLE ADD COLUMN` may add only a `VIRTUAL` generated column.
- A column declared in both the bootstrap `SCHEMA` and a migration fails every first open with a duplicate column.
- Dropping or renaming a column breaks older builds, the explicit column lists `replayConversations` inserts, and every query naming it. No down-migration exists.
- The steps so far, each shaping what is above: 1 `session_ref`; 2 `sessions` and the first `operation_records`; 3 `job_output` and `jobs.cwd`; 4 `events` renamed `state_machine_events` and records split from `session_positions`; 5 `operation_id`; 6 `artifacts.interactive`; 7 a kept no-op; 8 positions keyed by record id; 9 `runs.forked_at`, retired with `runs`; 10 `blobs`; 11 `pending_interactions`; 12 `instance_id` rebuilt as TEXT with `-1` read as NULL; 13 record ids became scoped request hashes, `attempt` retired, colliding legacy ids suffixed `~~<rowid>`, and `interrupted` added; 14 positions folded into `request_json.session`, `op_position`, `landed_*`, the session's provider pair, and `session_outcome_json` folded into `result_json` and dropped; 15 `session_names`; 16 `runs` folded into `task_runtime` and dropped with every `run_id`; 17 `cut_at`, `forked_at_seq` and `fork_boundary_seq`.

## Several tables mean less, or something else, than their names suggest

- The bootstrap `SCHEMA` still creates `events` and `runs` on every open; `openDb` drops each only when empty, so a non-empty one is left in place.
- For a file-backed concern, unqualified names read a `TEMP` shadow without foreign keys, and `main.<table>` holds rows frozen at the switch under `file` or as of the last replay under `both`. The `op_position` claim then holds per connection.
- `module_approvals` exists in every database, and only the shared root's is read.
- `blobs` belongs to no storage concern, so it stays in the database whatever `storage` says.
- `call_memo` has no task column, and neither deleting a task nor pruning history removes a memo row.
- On a database older than migration 12, `artifacts.instance_id` and `task_runtime.root_instance_id` keep their old affinity and may hold numbers; readers coerce.
- `session_id` in `operation_records` and `sessions.id` hold legacy `task/run/name` spellings for conversations recorded before migration 15.
- `forked_at_seq` and `fork_boundary_seq` are `seq` values, which a file-backed journal re-mints at each replay; see [journal-events](journal-events.md).
