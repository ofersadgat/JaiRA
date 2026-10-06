---
id: engineering/units/storage-policy
type: engineering-unit
status: shipped
updated: 2026-10-06
implements: [product/run-history-travels-with-the-repository]
layer: data
owns_contracts: [engineering/contracts/storage-files]
requires: [engineering/units/conversation-lookup]
implemented_by: [packages/persistence/src/fileStorage.ts, packages/persistence/src/fileLedger.ts, packages/persistence/src/rowFile.ts, packages/persistence/src/conversationFile.ts]
verified_by: [packages/persistence/test/fileStorage.test.ts, packages/persistence/test/conversationFile.test.ts, packages/persistence/test/rowFile.test.ts, packages/persistence/test/cut.test.ts]
siblings: [engineering/units/event-journal, engineering/units/project-store, engineering/units/operation-record-store]
---

# Storage policy

## Storage policy writes a concern to files as well as the database, and brings files that moved into the database at open

`settings.json` `storage` gives each concern a mode, `db` or `file`, and `storage.format` a conversation dialect, `claude` or `codex`. The database is the truth for every concern while JaiRA runs ([decision 0018](../decisions/0018-one-truth-per-side.md) §11). A `file` concern is also written to files as each change is saved, an export that is never read back while running: the journal's line just before its row, and a task's, an artifact's and a conversation's line just after it, re-read from the table. This unit decides at open whether those files are read, and how, and at close whether the next open may trust the database over them:

- `applyStorage(db, workspace, storage, files)` in `fileStorage.ts` runs once per open, before any store exists. For each file-backed concern in `CONCERN_TABLES` it compares the files' fingerprint with the one `storage_index` holds for this workspace and concern, and does one of three things. Export: there are no files, or the recorded fingerprint is `stale`, so the concern's `export` writes every task this workspace owns afresh from the database, replacing that task's file, and the new fingerprint is stored. Current: the fingerprints match, so nothing is read. Import: they differ, as after a `git pull`, a clone or a crash before a close, so `importFiles` replays the files and the new fingerprint is stored. Afterwards `noteFolder` takes the concern's folder as JaiRA leaves it. A concern opened in `db` whose `storage_index` row exists has its fingerprint set to `stale`, because its files stop being written. It reports `{ imported, exported, current }`.
- `importFiles` calls `stageTable` for each of the concern's tables, which creates a `TEMP` table of the same name from the table's statement in `main.sqlite_master` with inline `REFERENCES` clauses stripped, then recreates the table's indexes; it carries none of the change log's triggers. An unqualified name resolves to `temp` first, so the concern's replay writes there. In one transaction, each task the staged rows name that no workspace owns is claimed for this workspace, each task this workspace owns among them has its rows in `main` deleted, children first, and the staged rows inserted, parents first; `sessions` rows are upserted by id. A task another workspace owns, and a task the files do not name, is left alone. `state_machine_events.seq` and `artifacts.id` are left for `main` to mint again. The staging tables are dropped before anything else reads.
- `fileLedger.ts` keeps, per process, each concern file's size and modification time as JaiRA last left it. Every writer calls `noteWriting` before it appends, which marks a file that is not as JaiRA left it moved until the next open, so JaiRA's own later lines cannot pass a pull off as its own, and `noteWritten` after; removals call `noteRemoved`. `folderAsLeft` says whether every file under a folder is as JaiRA left it, none added, none removed and none moved.
- `keepFingerprints` at a project's close stores a file-backed concern's fingerprint only when `folderAsLeft` holds for its folder, so the next open trusts the database. Otherwise the old fingerprint stays, and the next open imports the files, which is how a `git pull` made while JaiRA ran is read in.
- `CONCERN_TABLES` groups tables: `journal` is `state_machine_events`; `conversations` is `operation_records`, `sessions` and `session_names`; `tasks` is `task_runtime`; `artifacts` is `artifacts`.
- `rowFile.ts` holds the task and artifact files. `RowLog.appendFrom` re-reads the written row from the table with `SELECT *` and appends it; `replayRows` keeps the last line per key and inserts it with `INSERT OR REPLACE`, every column the line names, so a column the table does not have fails the import; `exportRows` writes each task's file afresh from its rows; `fingerprintOf` hashes each file's path, size and modification time; `removeTaskRows` deletes a task's file.
- `conversationFile.ts` holds the conversation file. `ConversationLog.append` writes one `jaira.<kind>` line in the configured dialect, followed by native turn lines when the line is a record that is not `open`. `replayConversations` keeps the last line per key, applies tombstones, and inserts sessions, then records, then names. `exportConversations` writes each task's file afresh from its sessions, names and records. `removeTaskConversations` deletes a task's directory.

The line shapes, keys and import order are [storage-files](../contracts/storage-files.md).

It deliberately does not own:

- Which rows are written and when. `SqliteSessionStore` in [operation-record-store](operation-record-store.md), `RuntimeStore` in [task-lifecycle](task-lifecycle.md) and `SqliteArtifactStore` in [artifact-placement](artifact-placement.md) call `ConversationLog.append` and `RowLog.appendFrom` after their own writes.
- The journal file, its line-first append, its replay and its export: [event-journal](event-journal.md).
- Which concerns and modes may be chosen. `parseStorage` in [project-config](project-config.md) refuses `jobs`, `job_output`, `sessions`, `events` and `snapshots` by name, and reads the retired `both` as `file`.
- The wire history a native turn line is built from: `messagesOfRecord` in [conversation-lookup](conversation-lookup.md).
- Deleting files: `deleteTask` in [task-lifecycle](task-lifecycle.md) and `pruneHistory` in [history-pruning](history-pruning.md). Tombstones are written by the session store during a cut in [rewind-and-fork](rewind-and-fork.md).
- Reading files that change while JaiRA runs. Watching them is separate, unbuilt work.

## The policy sits in the data layer under every store, on the derived and committed boundary

- Layer `data`, package `@jaira/persistence`. It calls the connection and `node:fs`; native turn lines call `messagesOfRecord`.
- No upstream seam. Every store reads and writes `main`, file-backed or not.
- `openAt` in `project.ts` calls `applyStorage` with one `dir`, `replay`, `fingerprint` and `export` per concern, none for a replica, and hands `RowLog`s to the task and artifact stores; its `close` calls `keepFingerprints`. `sessionStoreFor` hands a `ConversationLog` to a session store scoped to a task, and `forkTask` in `cut.ts` builds one for the copy.
- Boundary: derived and committed. Under `file` the files are an export of the database, meant to be committed so that history travels with the repository, and read back only at open when they moved. `storage_index` is created by `readFingerprint` and `writeFingerprint` with `CREATE TABLE IF NOT EXISTS`, outside the migration list.

## The database is the truth for every concern, and the files are its export

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `main` tables of a file-backed concern | read and written by every store; the rows of the tasks the files name replaced by an import | `main` | the change log's triggers record what an import brings in |
| `TEMP` staging copy of a concern's tables | built by an import, filled by the concern's replay, dropped before anything else reads | the concern's files | none |
| `system/conversations/<taskId>/conversations.jsonl` | appended by a task-scoped `SqliteSessionStore` and by `forkTask`; written by an export; read by an import | `main` while JaiRA runs; the file at an import | removed whole by `deleteTask` and `pruneHistory` |
| `system/taskRows/<taskId>.jsonl` | appended by `RuntimeStore` after each task row write; written by an export; read by an import | `main` while JaiRA runs; the file at an import | removed by `deleteTask` |
| `system/artifactRows/<taskId>.jsonl` | appended by `SqliteArtifactStore.put`; written by an export; read by an import | `main` while JaiRA runs; the file at an import | removed by `deleteTask` |
| `storage_index(workspace, concern, fingerprint, built_at)` in `main` | written at an export, an import, a close whose files are as JaiRA left them, and as `stale` at an open in `db`; read at open | `main` | none |
| The file ledger: each concern file's size and modification time as JaiRA last left it, and the files found moved | in process memory; taken from each folder at open, noted by every append and removal, read at close | the process's own writes | every process keeps its own |

## The invariants keep the database the truth and let files that moved speak only for their tasks

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An unqualified write to a staged table lands in the staging table while `main.<table>` stays reachable | `fileStorage.test.ts` "takes an unqualified write while main stays reachable" |
| 2 | A staging table keeps the generated columns, the indexes and every one-row constraint, and drops the foreign keys | `fileStorage.test.ts` "brings the generated columns and the indexes", "drops the foreign keys, whose parents are in main, and keeps every constraint about one row" |
| 3 | The default configuration, every concern in the database, does nothing at all | `fileStorage.test.ts` "does nothing at all when everything is in the database, which is the default" |
| 4 | A concern switched on with no files has them written from the database, and the next open reads nothing from them | `fileStorage.test.ts` "starts a concern's files from the database when it has none"; `conversationFile.test.ts` "starts its files from the database, and the next open reads nothing from them"; `journalFile.test.ts` "starts its files from the database, so they hold the history the database does" |
| 5 | Files as JaiRA left them are not read; files that moved replace the rows of the tasks they name and no other, a task no workspace owned becomes this one's, another workspace's is untouched, and nothing stays staged | `fileStorage.test.ts` "reads files that moved, in place of the rows of the tasks they speak for — no other", "trusts the database after a close recorded the files as they were"; `rowFile.test.ts` "are not read while they are as JaiRA left them: the database is the truth", "are read when one moved underneath — the `git pull` case — for the tasks they speak for"; `workspace.test.ts` "brings in its own files' tasks and leaves every other workspace's alone" |
| 6 | An import is in the change log as what it brought into `main`, never as what it staged | `sync.test.ts` "logs nothing an import stages, only what it brings into the database" |
| 7 | A file-backed concern survives the database being deleted, keeping the last state of each row | `conversationFile.test.ts` "survives the database being thrown away", "keeps the SETTLED state, not the open one it superseded"; `rowFile.test.ts` "keeps the LAST state of a row, not the first", "survives the database being thrown away, the machine's outcome included", "survives the database being thrown away, and keeps the upsert's last word" |
| 8 | A line that does not parse costs that line only | `conversationFile.test.ts` "drops a line it cannot parse and keeps the rest" |
| 9 | A conversation line is read in either dialect whatever `storage.format` says, and both dialects import to the same rows | `conversationFile.test.ts` "reads a file written in the OTHER dialect, and a file holding both", "dresses the line differently and records the same thing" |
| 10 | Native turn lines are written only for a settled record, in the other tool's own shape | `conversationFile.test.ts` "emits a settled turn in Claude Code's own shape, beside the row it came from", "emits a rollout's `response_item` under the codex dialect, with typed content blocks", "is emitted at the SETTLE only, so a streaming call does not spray transcripts" |
| 11 | The retired `both` is read as `file` | `fileStorage.test.ts` "reads `both`, retired, as `file`"; `rowFile.test.ts` "`both`, retired, is read as `file`" |
| 12 | Nothing is written to a file for a concern kept in the database | `conversationFile.test.ts` "writes nothing when conversations are a table, which is the default" |
| 13 | A record or session named by a tombstone is absent after an import | `cut.test.ts` `"survives a reopen — the file, replayed, holds what the table held"` |
| 14 | Recovery at open reaches the task row file | `rowFile.test.ts` "records the interruption recovery does at OPEN, or a crashed task never settles" |
| 15 | A pull that lands in the files while JaiRA runs is read in at the next open, and JaiRA's own later appends do not make the close take it as JaiRA's | `journalFile.test.ts` "reads in at the next open a pull that landed while JaiRA ran — the close does not take it as its own" |
| 16 | A concern put back in files after a spell in the database alone has its files written afresh from the database | `journalFile.test.ts` "writes its files afresh when put in them again, after a spell in the database alone" |

## A crash can leave a file one state behind, and a merge that the fold cannot resolve stops the project opening

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed after a store's table write and before its line is appended | the change is in `main` and not in the file; no close recorded the fingerprint, so when anything else was appended since the last close the next open imports the files and puts that task's rows back one state | none | the task row or record is one state behind after reopen |
| The process is killed mid-append | the truncated last line is skipped at the next import | none | that state is missing |
| A merge leaves conflict markers in a file | marker lines are skipped and every line that parses is imported | resolve the merge | the states on those lines are missing |
| Two people continue one task on two branches, and two live records end up claiming one seat | the fold's insert hits the `op_position` index and the import transaction throws | remove one record's lines or append a tombstone for it | the project does not open, with a UNIQUE constraint error |
| One record id appears under two task ids, such as a copied task directory | the import hits the primary key | remove the copy | the project does not open |
| Two machines' artifact row files carry the same `artifacts.id` | `INSERT OR REPLACE` into the staging table keeps one row and silently drops the other | none | one artifact's logical path no longer resolves |
| A record's string of 1024 characters or more is imported in a clone or after the database was deleted | the line holds a `{"$blob": hash}` reference whose bytes live only in the `blobs` table, which no concern covers | none | a reference object shows where the text was |
| A write reaches the table through a store with no task scope, or outside the session store | nothing is appended: `recoverInterrupted` settling `open` records, and `foldNativeCapture` through the unscoped store the app's crash recovery uses | none | `main` holds the change, but a clone, or an import after the files moved, has those calls `open` again, so a resumed conversation's history leaves their turns out, and a recovered agent transcript is gone |
| `deleteTask` or `pruneHistory` is killed after deleting rows and before removing files | the files survive, and an import after they next move brings the rows back | delete or prune again | the task or its history reappears |
| A file is rewritten with its size and modification time unchanged | the open reads the files as current and imports nothing | delete that workspace and concern's `storage_index` row | `main` keeps its rows until the files change |
| Files change while JaiRA has the project open, such as by a `git pull` mid-session | nothing reads them while JaiRA runs; the ledger finds them moved, so the close keeps the old fingerprint and the next open imports them | none needed | the pulled states appear after the next open |
| A second process, such as the CLI, opens a workspace another process has open | the files moved since the last close, by the first process's own appends, so the second imports them; each process's ledger then finds the other's appends moved, so neither close records the fingerprint and the next open imports again | none | the rows of the tasks the files name are replaced by what the files hold |
| A store appends the same state twice, such as a flush repeated after a settle | the file gains another whole line and an import keeps the last | none needed | none |

## Switching a concern between modes loses nothing the database holds

- Switching a concern from `file` to `db` stops writing its files; `main` already holds every row.
- Switching a concern to `file` with no files exports them from `main`. Files left from an earlier time under `file` are written afresh from `main`, because the open in `db` marked the concern's fingerprint `stale`.
- A concern whose files are all removed has them exported again from `main` at the next open.
- A `file` concern keeps the foreign keys SQLite enforces on its tables; only an import's staging tables drop them.

## The files are an export, and row logs append in the opposite order to the journal

- Under `file` a concern is written to JSONL files so that history can be committed and merged by git, while the database stays the truth as architecture.md names it; the files are read back only at open, when they moved, which is how a pull or a clone arrives.
- Row and conversation lines are appended just after the table write, re-reading the row, where the journal appends its line just before its row, so that a line can never differ from the row it records.
