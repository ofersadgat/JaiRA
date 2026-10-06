---
id: engineering/units/event-journal
type: engineering-unit
status: shipped
updated: 2026-10-06
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

`journalFile.ts` owns the line, its replay and its export: `appendJournal`, `readJournalFile`, `journalFiles` with its read order, `replayJournal`, `exportJournal`, the `jaira.rewound` tombstone written by `appendRewound`, `effectiveLines` that applies tombstones, and `removeTaskJournal`. Each append and removal is noted in the file ledger, `fileLedger.ts`, so a close can tell JaiRA's own lines from a pull's ([storage-policy](storage-policy.md)). The stored shapes are [journal-events](../contracts/journal-events.md).

It deliberately does not own:

- The event vocabulary. `EngineEvent` is upstream `@declarative-ai/hw`, stored verbatim.
- The events JaiRA adds beside the engine's. `fanout.made` and the mirrored element rows come from [fan-out-host](fan-out-host.md); `chat:` turns come from [chat-turns](chat-turns.md).
- Whether a file-backed concern's files are exported, imported or left as they are at open, and the staging table an import replays into: [storage-policy](storage-policy.md).
- Folding rows into a tree, a board, a conversation or a resume: [board-projection](board-projection.md) and [run-load](run-load.md).
- Deleting rows. Rewind and fork are [rewind-and-fork](rewind-and-fork.md), released failures are [run-load](run-load.md), task deletion is [task-lifecycle](task-lifecycle.md) and pruning is [history-pruning](history-pruning.md).

## The journal sits in the data layer, under the engine's persistence seam, on the derived and committed boundary

- Layer `data`, package `@jaira/persistence`. It calls the database connection and `node:fs`, nothing else.
- Upstream seam: `Persistence.record(event, atMs)` from `@declarative-ai/hw`, which is synchronous, as better-sqlite3 and `appendFileSync` are. The app passes the recorder to `executeWorkflow` inside a tee that also pushes `engine:event` over [push-messages](../contracts/push-messages.md); the CLI passes the recorder bare.
- Boundary: derived and committed. Under `storage.journal: "db"`, the default, the table is the truth and no file is written. Under `file` the table is still the truth while JaiRA runs, and the file is its export, meant to be committed, since the `.gitignore` JaiRA writes hides only the database, the logs and the machine key; the files are imported at open only when they moved since JaiRA last had them ([decision 0018](../decisions/0018-one-truth-per-side.md) §11).
- `openAt` in `project.ts` gives `SqliteEventLog` a journal directory only when the concern is file-backed, and hands `replayJournal`, the journal files' fingerprint and `exportJournal` to `applyStorage`.

## The table is the truth, and a file-backed journal's file is its export

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events`: `seq`, `task_id`, `instance_id`, `type`, `payload_json`, `created_at`, generated `session_ref` and `operation_id` | inserted by `record`, and by an import from `replayJournal`'s staging table; read by `list` | the table | deleted by `rewindTask`, `releaseRevivedFailures`, `deleteTask`, `pruneHistory`; copied by `forkTask` through a recorder; queried directly by `views.ts`, `hasJournalHistory`, `prune.ts` |
| `system/journal/<taskId>/journal.jsonl` | appended by `record` and `appendRewound`; rewritten whole by `exportJournal`; read by `replayJournal` at an import and by `effectiveLines` | the table while JaiRA runs; the file at an import | removed whole by `deleteTask` and `pruneHistory` |

## The invariants hold the file ahead of the table and keep one unreadable line from costing the history

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | When file-backed, no row reaches the table before its line is in the file | unasserted |
| 2 | A file-backed journal imported into a new database gives back every event with its type, instance and time | `journalFile.test.ts` "survives the database being thrown away, which is what 'truth' means" |
| 3 | Two tasks never append to one file, and no line carries `seq` | `journalFile.test.ts` "writes one file per task, which is what makes two people's appends not conflict" |
| 4 | A line that does not parse costs that line only, never the file or the open | `journalFile.test.ts` `"drops a line it cannot parse and keeps the rest — a merge left one in the middle"` |
| 5 | Under `db` no journal file or directory is written | `journalFile.test.ts` "writes nothing to disk when the journal is a table, which is the default" |
| 6 | An event recorded through the port lists back verbatim, with its instance and time, and only under its own task | `stores.test.ts` "records EngineEvents through the Persistence port and lists them back" |
| 7 | A journal switched to files with no files yet has them written from its database history; files as JaiRA left them are not read, and files that moved replace the events of the tasks they name | `journalFile.test.ts` "starts its files from the database, so they hold the history the database does", "reads nothing from files as JaiRA left them, and what they say when they moved since" |
| 8 | A line a `jaira.rewound` tombstone names never reaches the table on an import | `cut.test.ts` `"survives a reopen — the file, replayed, holds what the table held"` |
| 9 | A pull that lands in a journal file while JaiRA runs is read in at the next open, whatever JaiRA appended after it | `journalFile.test.ts` "reads in at the next open a pull that landed while JaiRA ran — the close does not take it as its own" |
| 10 | A journal put back in files after a spell in the database alone has its files written afresh | `journalFile.test.ts` "writes its files afresh when put in them again, after a spell in the database alone" |

## Every failure leaves the file whole, and a table that disagrees with it is corrected only by an import

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The table insert throws after the line was appended | `record` throws into the engine; the file holds an event the table lacks, and a clean close records the files as they are, so the next open does not read it | an import, after a crash or the files moving again, brings it in; deleting the journal's `storage_index` row forces one | the run fails with the database error |
| A caller's transaction rolls back after `record` or `appendRewound` appended | the table loses the rows and the file keeps the lines, because the append is not part of the SQLite transaction | an import brings in the file's version; deleting the journal's `storage_index` row forces one at the next open | until an import a rewind is refused with "refusing to cut a journal that disagrees with its file" |
| `releaseRevivedFailures` runs while file-backed | its delete reaches the table only; the file keeps the failure lines | none: an import, after a crash or the files moving, brings the released rows back | until then a rewind of that task is refused as disagreeing with its file |
| The process is killed mid-append | the last line is truncated and skipped at the next import | none | that one event is missing after an import |
| A git merge leaves a conflict marker or a broken line in a journal file | the line is skipped; every line that parses is imported | none needed | the history reads whole |
| Two processes append to one database under `db` | SQLite serializes the inserts and `seq` orders them by commit; one task is never driven by two processes, because `beginTaskRun` refuses a task that is not startable | none needed | each process sees the other's events |
| Two processes append while file-backed | both insert into the one table, as under `db`, and append to the files; a process that opens while another has the project open finds files that moved since the last close and imports them, replacing the events of the tasks they name and minting their `seq` again | none | each process sees the other's events |
| A retry records an event that is already in the journal | the journal has no idempotency key and keeps both rows; hw has not re-stated entries since 2026-09-08, and readers merge the re-stated `instance.entered` rows older journals hold by instance id | none needed | the entry is drawn once |

## Payloads are stored verbatim, so an upstream vocabulary change needs no migration, and nothing rolls back

- A new or changed `EngineEvent` needs no migration: `payload_json` is the event as the engine wrote it, and `session_ref` and `operation_id` are generated from it.
- Legacy payloads with numeric ids are coerced at read, in `list` and in `replayJournal`, and never rewritten; `exportJournal` writes them as stored.
- Migration 12 rebuilt the table with a `TEXT` `instance_id`, and migration 16 dropped `run_id`. Neither rolls back.

## The file is an export the database reads back only at open

- Under `file` the journal is also written to a JSONL file so that a task's history can be committed and merged by git, while the table stays the truth as architecture.md names it; the file is imported at open when it moved, which is how a pull or a clone arrives, and never read back while JaiRA runs ([decision 0018](../decisions/0018-one-truth-per-side.md) §11).
