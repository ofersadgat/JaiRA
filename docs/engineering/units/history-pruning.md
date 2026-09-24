---
id: engineering/units/history-pruning
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/keep-history-within-bounds, ux/patterns/second-deliberate-step-for-irreversible, ui/surfaces/settings-data]
layer: service
owns_contracts: []
requires: [engineering/units/task-lifecycle, engineering/units/event-journal, engineering/units/operation-record-store, engineering/units/storage-policy]
implemented_by: [packages/persistence/src/prune.ts]
verified_by: [packages/persistence/test/prune.test.ts, packages/app/test/maintenance.test.ts, packages/app/test/service.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/operation-record-store, engineering/units/storage-policy, engineering/units/event-journal]
---

# History pruning

## Pruning deletes how ended tasks ran and keeps what they were, and it reports the plan whether or not it deletes

`pruneHistory(project, { before?, dryRun? })` in `prune.ts` returns `PruneResult` with `tasks`, `events`, `commands`, `skippedTasks` and `dryRun`:

1. It reads every `task_runtime` row. A task whose status is `queued`, `running` or `interrupted` goes to `skippedTasks` with `task is <status>; its history is still required to resume or display it`.
2. Any other task is a candidate when its `ended_at`, else its `updated_at`, is at or before `before`, which defaults to now, and it has at least one `state_machine_events` or `command_log` row. A task with neither appears in no list.
3. Unless `dryRun`, one transaction deletes, per candidate, its journal rows, its `command_log`, the `job_output` of its jobs, its `jobs`, and its `operation_records` after releasing the blobs each record's `result_json` and `request_json` name. It then deletes, pass after pass until a pass deletes none, every `sessions` row created before the cutoff that no record sits on and no session names as its parent, then every `session_names` row whose session is gone, then calls `collectBlobs`.
4. After the commit it removes each candidate's journal directory when `storage.journal` is file-backed, and its conversation file when `storage.conversations` is.

A pruned task keeps its task file, its `task_runtime` row with status, outcome and outputs, its `artifacts`, its `pending_interactions` and every `call_memo` row, so the board still shows how it ended while its conversation and instance tree read empty. `historySize(project)` counts `task_runtime`, `state_machine_events` and `command_log` rows.

The app's `pruneHistory({ olderThanDays, apply })` behind `history:prune` computes `before` as now less `olderThanDays` days, refuses a negative or non-finite count with `olderThanDays must be a non-negative number`, deletes only with `apply: true`, and then publishes `store:invalidate` for `tasks`, `board` and each pruned task. `historySize` answers `history:size`. The CLI's `jaira prune` takes `--older-than <days>` and deletes only with `--apply`.

It deliberately does not own:

- Deleting a task whole: `deleteTask` in [task-lifecycle](task-lifecycle.md).
- Blob reference counts and the lineage rows' meaning: [operation-record-store](operation-record-store.md). File-backed concerns and their shadow tables: [storage-policy](storage-policy.md). The journal's files: [event-journal](event-journal.md). The tables: [sqlite-schema](../contracts/sqlite-schema.md).
- The terminal command's output and exit code: [cli](cli.md).

## Pruning is service code that holds the eligibility rule itself, so no caller can widen it

- Layer `service`, package `@jaira/persistence`. It sequences the journal, the command log, the job tables, the record store, the lineage rows and the blob store in one transaction, then the files. No upstream seam.
- The status and age rule lives in `pruneHistory`, not in the app or the CLI, so both surfaces prune the same tasks.
- Boundary: derived and committed. Under a file-backed concern the files leave the working tree, and a committed copy stays in git's history, because JaiRA never touches the index.

## The database and the file-backed concern files hold what pruning deletes, and nothing records that it ran

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| A candidate's `state_machine_events`, `command_log`, `jobs`, `job_output` and `operation_records` rows | counted by the scan; deleted by task id in the transaction | the database, or the journal and conversation files when those concerns are file-backed | written by event-journal, tool-policy, process-claims and operation-record-store |
| `sessions` and `session_names` | deleted by age and reference, across every task rather than only the candidates | the database, or the conversation files when file-backed | operation-record-store |
| `blobs` | released per record, then collected once nothing names them | the database | operation-record-store |
| `system/journal/<taskId>/` and the task's conversation file | removed after the commit | the files, when file-backed | event-journal and storage-policy |
| `PruneResult` and `HistorySize` | computed per call | the tables at call time | Settings › Data & history and `jaira prune` |

## The invariants keep resumable history and referenced rows out of reach

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A running, interrupted or queued task keeps its history at any age | `prune.test.ts` "never prunes a running or interrupted task, however old", `"keeps a queued task's rows too — it has not run yet"`; `maintenance.test.ts` "refuses to prune a task that is still running" |
| 2 | A pruned task loses its journal and command log and keeps its row and outcome | `prune.test.ts` "drops a terminal task's journal and command log, and keeps the task itself"; `maintenance.test.ts` "plans without deleting, then applies" |
| 3 | Only a task that ended at or before the cutoff is pruned | `prune.test.ts` "respects the age cutoff" |
| 4 | A plan deletes nothing and reports what an apply would delete | `prune.test.ts` "reports the plan without deleting anything"; `maintenance.test.ts` "plans without deleting, then applies" |
| 5 | A prune leaves no job output without its job and passes SQLite's foreign key check | `prune.test.ts` "leaves no orphaned rows and passes SQLite's own FK check" |
| 6 | A negative day count is refused before anything is read | `maintenance.test.ts` "rejects nonsense arguments rather than deleting the wrong thing"; `service.test.ts` "logs a refusal where it is decided, and marks it so the boundary will not re-file it" |
| 7 | A session that a child session still names, or that was created after the cutoff, survives | unasserted |
| 8 | A blob that a surviving record still names survives | unasserted |

## A prune cannot be undone, and its protected set is narrower than what resume can use

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A `failed` or `canceled` task ended before the cutoff | both are startable yet outside the protected set, so their journal and records go; the app's resume then refuses `cannot be resumed: nothing was recorded`, and the CLI's `task start` walks the pinned workflow again from its root | re-run it as a new task | Resume is refused; a task the app closed while it waited on a person logs `could not resume` at the next open |
| A task is `stopping` | it is outside the protected set; with a cutoff of 0 days its rows go while its run still settles and appends, and a task left `stopping` by a dead process goes once it is older than the cutoff | none | the task's history holds only what arrived after the prune |
| Several projects are open in the app | `history:prune` carries no project, so the service refuses `several projects are open, so this call must name one` | close the other projects, or run `jaira prune --project <dir>` | the refusal shows in Settings › Data & history |
| A task ends between the plan and the apply | the apply scans again with its own cutoff, so it can delete tasks the plan did not list | plan again before applying | the apply deletes more than was shown |
| Another process starts a candidate between the scan and the transaction | the status is read outside the transaction and not read again | none | the started task loses its history |
| Two processes prune at once | SQLite serializes the two transactions, and the second deletes nothing more, though it reports the counts it scanned before the first committed | none needed | the second report overstates what it deleted |
| The process dies inside the transaction | nothing commits | prune again | nothing changed |
| The process dies after the commit and before the files are removed | the files still hold the history, and the next open replays it | prune again | pruned history returns |
| A prune is repeated | candidates already pruned have no journal or command rows, so they appear in no list | none needed | an empty plan |

## Nothing migrates, and a prune has no rollback

- A prune changes no schema. Deleted rows and files are gone, and a committed file comes back only through git.
