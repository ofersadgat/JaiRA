---
id: engineering/units/event-journal
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/complete-record-of-every-run, product/pick-up-where-it-left-off, product/run-history-travels-with-the-repository]
layer: data
owns_contracts: [engineering/contracts/journal-events]
requires: []
implemented_by: [packages/persistence/src/eventLog.ts, packages/persistence/src/journalFile.ts]
verified_by: [packages/persistence/test/journalFile.test.ts, packages/persistence/test/stores.test.ts, packages/persistence/test/cut.test.ts]
siblings: [engineering/units/storage-policy, engineering/units/run-load, engineering/units/board-projection, engineering/units/rewind-and-fork]
---

# Event journal

## The journal stores what a task's machine did, and leaves the vocabulary, the reading and the deleting to others

`SqliteEventLog` in `eventLog.ts` is the engine's persistence port for one task. `recorder(taskId)` returns a `record(event, atMs)` that appends the event as one line to `system/journal/<taskId>/journal.jsonl` when the journal is file-backed, then inserts it into `state_machine_events`. `list(taskId, {afterSeq, limit})` returns the task's rows in `seq` order as `StoredEvent`.

`journalFile.ts` owns the line and its replay: `appendJournal`, `readJournalFile`, `journalFiles` with its read order, `replayJournal`, the `jaira.rewound` tombstone written by `appendRewound`, `effectiveLines` that applies tombstones, and `removeTaskJournal`. The stored shapes are [journal-events](../contracts/journal-events.md).

It deliberately does not own:

- The event vocabulary. `EngineEvent` is upstream `@declarative-ai/hw`, stored verbatim.
- The events JaiRA adds beside the engine's. `fanout.made` and the mirrored element rows come from [fan-out-host](fan-out-host.md); `chat:` turns come from [chat-turns](chat-turns.md).
- Whether a file-backed concern replays, reuses or seeds, and the shadow table the rows land in: [storage-policy](storage-policy.md).
- Folding rows into a tree, a board, a conversation or a resume: [board-projection](board-projection.md) and [run-load](run-load.md).
- Deleting rows. Rewind and fork are [rewind-and-fork](rewind-and-fork.md), released failures are [run-load](run-load.md), task deletion is [task-lifecycle](task-lifecycle.md) and pruning is [history-pruning](history-pruning.md).

## The journal sits in the data layer, under the engine's persistence seam, on the derived and committed boundary

- Layer `data`, package `@jaira/persistence`. It calls the database connection and `node:fs`, nothing else.
- Upstream seam: `Persistence.record(event, atMs)` from `@declarative-ai/hw`, which is synchronous, as better-sqlite3 and `appendFileSync` are. The app passes the recorder to `executeWorkflow` inside a tee that also pushes `engine:event` over [push-messages](../contracts/push-messages.md); the CLI passes the recorder bare.
- Boundary: derived and committed. Under `storage.journal: "db"`, the default, the table is the truth and no file is written. Under `file` or `both` the file is the truth and is meant to be committed, since the `.gitignore` JaiRA writes hides only the database, the logs and the machine key, and the table is an index replayed from the files at open.
- `openAt` in `project.ts` gives `SqliteEventLog` a journal directory only when the concern is file-backed, and hands `replayJournal` to `applyStorage` as the journal's replay source.

## The table is the truth by default and the file is the truth once the journal is file-backed

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events`: `seq`, `task_id`, `instance_id`, `type`, `payload_json`, `created_at`, generated `session_ref` and `operation_id` | inserted by `record` and `replayJournal`; read by `list` | the table under `db`; the file under `file` and `both` | deleted by `rewindTask`, `releaseRevivedFailures`, `deleteTask`, `pruneHistory`; copied by `forkTask` through a recorder; queried directly by `views.ts`, `hasJournalHistory`, `prune.ts` |
| `system/journal/<taskId>/journal.jsonl` | appended by `record` and `appendRewound`; read by `replayJournal` and `effectiveLines` | the file, when file-backed | removed whole by `deleteTask` and `pruneHistory` |

## The invariants hold the file ahead of the table and keep one unreadable line from costing the history

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | When file-backed, no row reaches the table before its line is in the file | unasserted |
| 2 | A file-backed journal replayed into a new database gives back every event with its type, instance and time | `journalFile.test.ts` "survives the database being thrown away, which is what 'truth' means" |
| 3 | Two tasks never append to one file, and no line carries `seq` | `journalFile.test.ts` "writes one file per task, which is what makes two people's appends not conflict" |
| 4 | A line that does not parse costs that line only, never the file or the open | `journalFile.test.ts` `"drops a line it cannot parse and keeps the rest — a merge left one in the middle"` |
| 5 | Under `db` no journal file or directory is written | `journalFile.test.ts` "writes nothing to disk when the journal is a table, which is the default" |
| 6 | An event recorded through the port lists back verbatim, with its instance and time, and only under its own task | `stores.test.ts` "records EngineEvents through the Persistence port and lists them back" |
| 7 | A journal switched to files with no files yet keeps its database history, and once a file exists the files win over rows only the database holds | `journalFile.test.ts` "seeds from the database the first time, so the history does not read as deleted", "prefers the files once there are any, because that is what truth means" |
| 8 | A line a `jaira.rewound` tombstone names never reaches the table on replay | `cut.test.ts` `"survives a reopen — the file, replayed, holds what the table held"` |

## Every failure leaves the file whole, and a table that disagrees with it is corrected at the next open

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The table insert throws after the line was appended | `record` throws into the engine; the file holds an event the table lacks | the next open replays it | the run fails with the database error |
| A caller's transaction rolls back after `record` or `appendRewound` appended | the table loses the rows and the file keeps the lines, because the append is not part of the SQLite transaction | the next open replays the file's version | until reopen a rewind is refused with "refusing to cut a journal that disagrees with its file" |
| `releaseRevivedFailures` runs while file-backed | its delete reaches the table only; the file keeps the failure lines | none: the next open replays the released rows back | a rewind in the same session is refused as disagreeing with its file |
| The process is killed mid-append | the last line is truncated and skipped on read | none | that one event is missing after reopen |
| A git merge leaves a conflict marker or a broken line in a journal file | the line is skipped; every line that parses replays | none needed | the history reads whole |
| Two processes append to one database under `db` | SQLite serializes the inserts and `seq` orders them by commit; one task is never driven by two processes, because `beginTaskRun` refuses a task that is not startable | none needed | each process sees the other's events |
| Two processes append while file-backed | both append to the files, but each inserts into its own connection's shadow table, so neither lists the other's new events | reopen the project | another process's progress appears only after reopen |
| A retry records an event that is already in the journal | the journal has no idempotency key and keeps both rows; hw has not re-stated entries since 2026-09-08, and readers merge the re-stated `instance.entered` rows older journals hold by instance id | none needed | the entry is drawn once |

## Payloads are stored verbatim, so an upstream vocabulary change needs no migration, and nothing rolls back

- A new or changed `EngineEvent` needs no migration: `payload_json` is the event as the engine wrote it, and `session_ref` and `operation_id` are generated from it.
- Legacy payloads with numeric ids are coerced at read, in `list` and in `replayJournal`, and never rewritten.
- Migration 12 rebuilt the table with a `TEXT` `instance_id`, and migration 16 dropped `run_id`. Neither rolls back.

## The file is the truth and the database an index, which reverses the architecture's usual store

- Under `file` and `both` the journal's truth is a JSONL file and the table is replayed from it, where architecture.md names the database as the truth for events, so that a task's history can be committed and merged by git.
