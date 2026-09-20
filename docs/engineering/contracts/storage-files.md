---
id: engineering/contracts/storage-files
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/storage-policy]
consumers: ["@jaira/persistence replay at open in conversationFile.ts and rowFile.ts", "@jaira/persistence SqliteSessionStore, RuntimeStore and SqliteArtifactStore, which append", "@jaira/persistence cut.ts, whose cuts append tombstones and whose forks append a copy's lines", "@jaira/persistence lifecycle.ts deleteTask and prune.ts pruneHistory, which remove files", "Claude Code and Codex session readers, through native turn lines", "git, merging committed system/ directories", "people reading a committed file"]
since: 2026-08-24
siblings: [engineering/contracts/journal-events, engineering/contracts/sqlite-schema, engineering/contracts/jaira-layout]
---

# Storage files

The append-only JSONL files that hold a project's conversations, task rows and artifact map when those concerns are file-backed, and the fingerprint that lets `both` skip replaying them.

## A caller reaches for these files when a concern is file-backed, and never for the journal or a task's metadata

**Use when.** `storage.conversations`, `storage.tasks` or `storage.artifacts` in `settings.json` is `file` or `both`, and code appends to, replays, removes or tools read these files, or a person commits or merges them.

**Do not use when.** Reading or writing the journal file: [journal-events](journal-events.md). Reading a task's metadata file `system/tasks/<taskId>.json`: [task-file](task-file.md). Querying the tables the files replay into: [sqlite-schema](sqlite-schema.md). Nothing JaiRA reads comes from a native turn line.

## The shape is one file per task per concern, each line a whole row state

### Each concern writes one file per task

Every file is UTF-8, one JSON object per line, each line ended by a newline. In a file or directory name, each character of a task id outside `A-Za-z0-9._-` becomes `_`, and an id that is empty, `.` or `..` becomes `_`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `system/conversations/<taskId>/conversations.jsonl` | file | when `storage.conversations` is file-backed | the task's `operation_records`, `sessions` and `session_names` states and tombstones, with native turn lines |
| `system/conversations/<taskId>/<runId>.jsonl` | file | no | written before migration 16; read, never written |
| `system/taskRows/<taskId>.jsonl` | file | when `storage.tasks` is file-backed | the task's `task_runtime` states |
| `system/artifactRows/<taskId>.jsonl` | file | when `storage.artifacts` is file-backed | the task's `artifacts` states |

### A conversation line wears a Claude or a Codex envelope, chosen by `storage.format` and detected per line

A line with a string `uuid`, a string `type` and a `parentUuid` key is read as Claude's; a line with a `jaira.*` type and no `uuid` as Codex's; any other line is skipped.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `uuid` | string, Claude only | yes | `jaira-<ms in base 36>-<n in base 36>`, where `n` counts lines written by one store instance |
| `parentUuid` | string or null, Claude only | yes | the previous line written by the same store instance, or null for its first |
| `timestamp` | ISO 8601 string | yes | when the line was appended |
| `type` | string | yes | `jaira.record`, `jaira.session`, `jaira.name`, `jaira.tombstone` or legacy `jaira.position` |
| `jaira` | object, Claude only | yes | the row |
| `payload` | object, Codex only | yes | the row |

### A `jaira.record` row is an operation record whole, keyed by task and record id

The key is `task_id`, `run_id`, `record_id` and `attempt`, which for a current line is the task id, an empty run and attempt 1.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `record_id` | string | yes | `operation_records.id` |
| `task_id` | string or null | yes | the task |
| `status` | string | yes | `open`, `completed`, `failed` or `interrupted` |
| `request_json` | string or null | yes | the request as stored, with its `scope` and `session` |
| `result_json` | string or null | yes | the result as stored, with `{"$blob": <sha256>}` in place of each string leaf of 1024 characters or more |
| `error_json`, `metrics_json` | string or null | yes | as stored |
| `provider_session_id` | string or null | yes | the handle the call reported |
| `landed_session_id`, `landed_seq` | string or null, number or null | no | where the call ran when that is not its asked seat |
| `started_at` | number | yes | epoch ms |
| `ended_at` | number or null | yes | epoch ms |
| `run_id`, `attempt`, `session_outcome_json` | number, number, string | no | legacy lines only |

### A `jaira.session` row is a lineage row, and a `jaira.name` row an alias

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes, session | the session id; the key |
| `parent` | string or null | yes, session | the session this branch left |
| `cursor` | number | yes, session | the parent seat this branch starts at |
| `provider`, `provider_session_id` | string or null | no, session | the current remote pair; absent on legacy lines |
| `cut_at` | string or null | no, session | the message id a rewound remote is copied up to |
| `created_at` | number | yes, session | epoch ms |
| `task_id` | string | yes, name | the task; the key with `name` |
| `name` | string | yes, name | what was written |
| `session_id` | string | yes, name | the session it names |

### A `jaira.tombstone` row names a row that is gone, and a `jaira.position` row is legacy

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `record_id` | string | no, tombstone | removes the current-format record of this id and `task_id` |
| `session_id` | string | no, tombstone | removes that session row |
| `task_id` | string or null | no, tombstone | the deleted record's task, or the writing store's task for a session |
| `session_id`, `seq`, `task_id`, `run_id`, `record_id`, `attempt` | string, number, string or null, number or null, string, number | legacy position | a seat claim, folded into its record's `request_json.session` |

A tombstone is written when a cut or `dropRecords` deletes a record and when a cut drops a branch. No tombstone exists for a name.

### Native turn lines follow a record line whose status is not `open`

One line per message of `messagesOfRecord` over the record's result, after the row line, each time such a record line is appended.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| Claude `uuid`, `parentUuid`, `timestamp` | string, string or null, string | yes | threaded like the row lines |
| Claude `sessionId` | string | yes | the record id |
| Claude `type` | `"user"` or `"assistant"` | yes | the message's role |
| Claude `userType`, `isSidechain` | `"external"`, `false` | yes | the values a main-chain turn carries |
| Claude `message` | `{role, content}` | yes | the message verbatim |
| Codex `timestamp` | ISO 8601 string | yes | append time |
| Codex `type` | `"response_item"` | yes | a rollout item |
| Codex `payload` | `{type: "message", role, content}` | yes | `content` is the message's blocks, or one `input_text` or `output_text` block wrapping a string |

### A row file line holds one table row as the database returned it

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `table` | string | yes | `task_runtime` or `artifacts`; legacy `runs` lines are skipped |
| `timestamp` | ISO 8601 string | yes | append time |
| `row` | object | yes | every column of the row from `SELECT *`, `artifacts.id` included |

The key is `task_id` for `task_runtime`, and `task_id` with `logical_path` for `artifacts`.

### The `both` fingerprint is a hash of each file's path, size and modification time

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `storage_index.fingerprint` | string | yes | the first 32 hex characters of SHA-256 over `<path>:<size>:<mtimeMs>` per file, or `<path>:gone` for a file that vanished, sorted by path and joined by newlines |
| files covered | list | yes | journal: every journal file, legacy ones included; conversations: every `.jsonl` inside a task directory; tasks and artifacts: every `.jsonl` in their directory |

### Replay folds every file, keeps the last line per key and inserts once

- Conversation files are read by task directory name, then file name; row files by file name.
- For each key the last line read wins, and a tombstone after a line removes it.
- Legacy record lines that share a content id keep the bare id for the greatest run, then attempt, then task, and the others become `<id>~~<task>.<run>.<attempt>`. A legacy position line folds into its record's request. A legacy `session_outcome_json` with `messages` joins `result_json` as `messages` when the result has no `entries`.
- Conversations insert sessions, then records, then names, in one transaction; rows insert with `INSERT OR REPLACE` in one transaction, dropping columns the table no longer has.

## Errors are skipped lines, and only a constraint violation stops a replay

| Condition | Response | Caller does |
| --- | --- | --- |
| A line does not parse, matches no envelope, or has no object row | skipped | nothing; that state is gone |
| A file cannot be read | treated as empty | nothing |
| No file exists for the concern | the replay source answers `undefined` and the concern is seeded from `main` | nothing |
| After folding, two live records claim one seat | the replay transaction throws a UNIQUE constraint error and the project does not open | remove one record's lines, or append a tombstone for it, and reopen |
| One record id appears under two task ids | primary key violation; the project does not open | remove the copy |
| A row line names a table the concern does not own | skipped | nothing |

## Renaming a field or line type breaks every committed file, and no file is ever migrated

- Renaming a row field, a `jaira.*` type or an envelope field breaks replay of every committed file; nothing rewrites files.
- Changing either dialect's detection rule can leave the other dialect's lines unread.
- Changing native turn line shapes breaks only other tools' readers.
- Legacy forms are read indefinitely: per-run files, `run_id` and `attempt`, `jaira.position` lines, `session_outcome_json`, and `runs` row lines.

## Several behaviours differ from what an append-only file seems to promise

- Every streamed flush appends another whole record line, so a file grows with each partial and replays as the last.
- Row and conversation lines are appended after the table write, so a crash can lose the last state; the journal writes its line first.
- `storage.format` shapes conversation lines only; row files have one shape.
- A record's long strings are blob references whose bytes live only in the database's `blobs` table, so a clone or a deleted database replays references, not text.
- An `artifacts` row line carries its database `id`, so lines written by two machines can share one, and `INSERT OR REPLACE` then keeps only one of the rows.
- A write through a store with no task scope, or outside the session store, appends nothing: `recoverInterrupted` settling `open` records, and a recovered native capture folded through the unscoped store at open.
- `uuid` counters and `parentUuid` chains restart with each store instance, so two lines can share a `uuid`.
- The fingerprint includes absolute paths, so a moved checkout replays in full once.
- When every file of a concern is removed, the next open seeds from `main`, so under `file` the rows `main` held when the concern was switched on reappear.
- A tombstone names only a current-format record key, so a legacy record line cannot be tombstoned.
