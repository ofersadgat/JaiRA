---
id: engineering/units/storage-policy
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/run-history-travels-with-the-repository]
layer: data
owns_contracts: [engineering/contracts/storage-files]
requires: [engineering/units/conversation-lookup]
implemented_by: [packages/persistence/src/shadow.ts, packages/persistence/src/rowFile.ts, packages/persistence/src/conversationFile.ts]
verified_by: [packages/persistence/test/shadow.test.ts, packages/persistence/test/conversationFile.test.ts, packages/persistence/test/rowFile.test.ts, packages/persistence/test/cut.test.ts]
siblings: [engineering/units/event-journal, engineering/units/project-store, engineering/units/operation-record-store]
---

# Storage policy

## Storage policy puts a concern's truth in files without changing one query, and leaves which rows get written to the stores

`settings.json` `storage` gives each concern a mode, `db`, `file` or `both`, and `storage.format` a conversation dialect, `claude` or `codex`. This unit makes a `file` or `both` concern read from its files while every store and query stays as written:

- `applyStorage(db, storage, sources, fingerprints)` in `shadow.ts` runs once per connection at open. For each file-backed concern in `CONCERN_TABLES` it calls `shadowTable`, which creates a `TEMP` table of the same name from the table's statement in `main.sqlite_master` with inline `REFERENCES` clauses stripped, then recreates the table's indexes. An unqualified table name resolves to `temp` before `main`, so every read and write lands in the shadow.
- It then fills each concern one of three ways, tried in order. Reuse: the mode is `both` and the files' fingerprint equals the one in `storage_index`, so the shadow is seeded from `main`. Replay: files exist, so the source folds them in; under `both` the result is written back to `main` children first and the new fingerprint stored. Seed: no files exist, so `seedFromMain` copies `main`'s rows with their identities.
- `CONCERN_TABLES` groups tables: `journal` is `state_machine_events`; `conversations` is `operation_records`, `sessions` and `session_names`; `tasks` is `task_runtime`; `artifacts` is `artifacts`.
- `rowFile.ts` holds the task and artifact files. `RowLog.appendFrom` re-reads the written row from the table with `SELECT *` and appends it; `replayRows` keeps the last line per key and inserts it with `INSERT OR REPLACE`, keeping only columns the table still has; `fingerprintOf` hashes each file's path, size and modification time; `removeTaskRows` deletes a task's file.
- `conversationFile.ts` holds the conversation file. `ConversationLog.append` writes one `jaira.<kind>` line in the configured dialect, followed by native turn lines when the line is a record that is not `open`. `replayConversations` keeps the last line per key, applies tombstones, folds legacy lines the way migrations 13, 14 and 16 fold the table, and inserts sessions, then records, then names in one transaction. `removeTaskConversations` deletes a task's directory.

The line shapes, keys and replay order are [storage-files](../contracts/storage-files.md).

It deliberately does not own:

- Which rows are written and when. `SqliteSessionStore` in [operation-record-store](operation-record-store.md), `RuntimeStore` in [task-lifecycle](task-lifecycle.md) and `SqliteArtifactStore` in [artifact-placement](artifact-placement.md) call `ConversationLog.append` and `RowLog.appendFrom` after their own writes.
- The journal file, its line-first append and its replay: [event-journal](event-journal.md).
- Which concerns and modes may be chosen. `parseStorage` in [project-config](project-config.md) refuses `jobs`, `job_output`, `sessions`, `events` and `snapshots` by name.
- The wire history a native turn line is built from: `messagesOfRecord` in [conversation-lookup](conversation-lookup.md).
- Deleting files: `deleteTask` in [task-lifecycle](task-lifecycle.md) and `pruneHistory` in [history-pruning](history-pruning.md). Tombstones are written by the session store during a cut in [rewind-and-fork](rewind-and-fork.md).

## The policy sits in the data layer under every store, on the derived and committed boundary

- Layer `data`, package `@jaira/persistence`. It calls the connection and `node:fs`; native turn lines call `messagesOfRecord`.
- No upstream seam. The engine reaches the shadows only as ordinary tables behind the stores.
- `openAt` in `project.ts` calls `applyStorage` with one replay source and one fingerprint per concern, and hands `RowLog`s to the task and artifact stores. `sessionStoreFor` hands a `ConversationLog` to a session store scoped to a task, and `forkTask` in `cut.ts` builds one for the copy.
- Boundary: derived and committed. Under `file` and `both` the files are the truth and meant to be committed, and the database is an index rebuilt at open. `storage_index` is created by `readFingerprint` and `writeFingerprint` with `CREATE TABLE IF NOT EXISTS`, outside the migration list.

## The files are the truth for a file-backed concern, and `main` is either frozen or an index

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `TEMP` shadow of each file-backed concern's tables | built per connection at open; read and written by every store | the concern's files | `main.<table>` stays reachable beside it |
| `main` copy of a file-backed concern's tables | read by reuse and seed; rewritten by replay under `both` | nothing under `file`, where it holds the rows as of the switch; an index under `both` | none |
| `system/conversations/<taskId>/conversations.jsonl` | appended by a task-scoped `SqliteSessionStore` and by `forkTask`; read by replay | the file | removed whole by `deleteTask` and `pruneHistory` |
| `system/taskRows/<taskId>.jsonl` | appended by `RuntimeStore` after each task row write; read by replay | the file | removed by `deleteTask` |
| `system/artifactRows/<taskId>.jsonl` | appended by `SqliteArtifactStore.put`; read by replay | the file | removed by `deleteTask` |
| `storage_index(concern, fingerprint, built_at)` in `main` | written under `both` after a replay; read at open | `main` | none |

## The invariants keep every query unchanged and let only the files decide a file-backed concern

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An unqualified read of a shadowed table reads the shadow while `main.<table>` stays reachable | `shadow.test.ts` `"serves an unqualified read while main stays reachable — the claim every query rests on"` |
| 2 | A shadow keeps the generated columns, the indexes and every one-row constraint, and drops the foreign keys | `shadow.test.ts` "brings the generated columns, which is what lets a join keep working", "brings the indexes, so a shadowed table is not a table scan", "drops the foreign keys, because a temp child cannot resolve a main parent", "keeps every constraint that is about one row" |
| 3 | A concern is shadowed whole, never one table of it, and the default configuration shadows nothing | `shadow.test.ts` "shadows a concern's whole table group, not one table of it", "does nothing at all when everything is in the database, which is the default" |
| 4 | A concern switched on with no files starts from `main`'s rows, identities included, and once files exist they win | `conversationFile.test.ts` "seeds from the database the first time, then prefers the files"; `shadow.test.ts` "copies the rows already in the database, identities included" |
| 5 | A file-backed concern survives the database being deleted, keeping the last state of each row | `conversationFile.test.ts` "survives the database being thrown away", "keeps the SETTLED state, not the open one it superseded"; `rowFile.test.ts` "keeps the LAST state of a row, not the first", "survives the database being thrown away, and keeps the upsert's last word" |
| 6 | A line that does not parse costs that line only | `conversationFile.test.ts` "drops a line it cannot parse and keeps the rest" |
| 7 | A conversation line is read in either dialect whatever `storage.format` says, and both dialects replay to the same rows | `conversationFile.test.ts` "reads a file written in the OTHER dialect, and a file holding both", "dresses the line differently and records the same thing" |
| 8 | Native turn lines are written only for a settled record, in the other tool's own shape | `conversationFile.test.ts` "emits a settled turn in Claude Code's own shape, beside the row it came from", "emits a rollout's `response_item` under the codex dialect, with typed content blocks", "is emitted at the SETTLE only, so a streaming call does not spray transcripts" |
| 9 | `both` reuses its index only while the fingerprint matches, and `file` persists no index | `rowFile.test.ts` "reuses the persisted index when the files have not moved", ``"replays instead when a file moved underneath it — the `git pull` case"``, "does not persist an index under `file`, which is what makes the two modes different" |
| 10 | Nothing is written to a file for a concern kept in the database | `conversationFile.test.ts` "writes nothing when conversations are a table, which is the default" |
| 11 | A record or session named by a tombstone is absent after replay | `cut.test.ts` `"survives a reopen — the file, replayed, holds what the table held"` |
| 12 | Recovery at open reaches the task row file | `rowFile.test.ts` "records the interruption recovery does at OPEN, or a crashed task never settles" |

## A crash loses at most the last state, and a merge that the fold cannot resolve stops the project opening

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed after a store's table write and before its line is appended | row and conversation lines are appended after the write, so the change lived only in the shadow and dies with the connection | none | the task row or record is one state behind after reopen |
| The process is killed mid-append | the truncated last line is skipped | none | that state is missing |
| A merge leaves conflict markers in a file | marker lines are skipped and every line that parses replays | resolve the merge | the states on those lines are missing |
| Two people continue one task on two branches, or two processes append while file-backed, and two live records end up claiming one seat | each connection's `op_position` index saw only its own claim; replay's plain insert hits the index and the replay transaction throws | remove one record's lines or append a tombstone for it | the project does not open, with a UNIQUE constraint error |
| One record id appears under two task ids, such as a copied task directory | replay hits the primary key | remove the copy | the project does not open |
| Two machines' artifact row files carry the same `artifacts.id` | `INSERT OR REPLACE` keeps one row and silently drops the other | none | one artifact's logical path no longer resolves |
| A record's string of 1024 characters or more is replayed in a clone or after the database was deleted | the line holds a `{"$blob": hash}` reference whose bytes live only in the `blobs` table, which no concern covers | none | a reference object shows where the text was |
| A write reaches the table through a store with no task scope, or outside the session store | nothing is appended: `recoverInterrupted` settling `open` records, and `foldNativeCapture` through the unscoped store the app's crash recovery uses | none | after the next open those calls are `open` again, so a resumed conversation's history leaves their turns out, and a recovered agent transcript is gone |
| `deleteTask` or `pruneHistory` is killed after deleting rows and before removing files | the files survive | delete or prune again | the task or its history reappears |
| A file is rewritten with its size and modification time unchanged under `both` | the stale index is reused | delete that concern's `storage_index` row | stale rows until the files change |
| A store appends the same state twice, such as a flush repeated after a settle | the file gains another whole line and replay keeps the last | none needed | none |

## Legacy files are read and never written, and switching a concern back to `db` returns to what `main` held

- Legacy per-run `<runId>.jsonl` conversation files, `run_id` and `attempt` fields, `jaira.position` lines, `session_outcome_json`, and `runs` lines in task row files are read and folded, never written.
- Switching a concern from `file` to `db` reads `main`, which holds the rows as of the switch to `file`; from `both` it holds the rows as of the last replay. What was written since stays only in the files.
- A concern whose files are all removed seeds from `main` again, so under `file` the rows `main` held at the switch reappear.
- Choosing `file` or `both` gives up the foreign keys SQLite enforced for that concern's tables.

## The files are the truth and the database an index, and row logs append in the opposite order to the journal

- Under `file` and `both` a concern's truth is a JSONL file and its table is replayed from it, where architecture.md names the database as the truth, so that history can be committed and merged by git.
- Row and conversation lines are appended after the table write, re-reading the row, where the journal appends its line first, so that a line can never differ from the row it records.
