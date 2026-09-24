---
id: engineering/units/view-addressing
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/keep-history-within-bounds, product/share-processes-across-projects, ux/patterns/live-facts-and-unseen-counts, ux/patterns/absence-is-stated, ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/settings-data, ui/components/project-row]
layer: service
owns_contracts: []
requires: [engineering/units/project-sessions, engineering/units/board-projection, engineering/units/files-view-models, engineering/units/workflow-browser, engineering/units/task-lifecycle, engineering/units/history-pruning, engineering/units/conversation-lookup, engineering/units/operation-record-store, engineering/units/agent-executors, engineering/units/interaction-hub, engineering/units/project-layout]
implemented_by: [packages/app/src/main/service.ts]
verified_by: [packages/app/test/service.test.ts, packages/app/test/shell.test.ts, packages/app/test/maintenance.test.ts, packages/app/test/workflowSync.test.ts]
siblings: [engineering/units/project-sessions, engineering/units/board-projection, engineering/units/files-view-models, engineering/units/ipc-bridge]
---

# View addressing

## The unit decides which database answers each read and what machine facts the projections get, and computes none of the views

The read methods of `AppService` in `service.ts` resolve a request's `project` to a session, pick a fallback when none is open, and hand the persistence projections what only the main process knows:

- Task reads: `listTasks`, `taskDetail`, `conversation`, `runRecords`, `effectiveState` and `board` go to the named session and refuse when there is none to answer. `taskDetail` adds `resume` from `resumable` only when the task's status is startable. `effectiveState` adds `values` from `runValuesOf`: the inputs a named or last execution was entered with, each child's entered inputs by key, and the operation's result read through the record at its conversation position.
- Cross-project reads: `listAllTasks` stamps every open session's summaries with `project` and sorts them newest first, with an optional `workflows` filter; `listProjects` returns one `ProjectSummary` per session, user projects first by label, then the shared root; `listSystemTasks` is the shared root's summaries or nothing.
- Browse reads: `boardRoots` answers an empty board, and `filesTree`, `stateView` and `stateSlots` fall back to the shared root, instead of refusing when the request resolves to no session.
- History: `historySize` for the named session and `pruneHistory` for the unqualified one, which also pushes `store:invalidate` for `tasks`, `board` and each pruned task after an apply that removed any.
- Machine facts: `gateVocabulary` is the union of every session's `interactive` function names; `viewOptions` passes it as `interactiveFunctions`; `stateViewOptions` adds `knownExecutors` from `listExecutors()` and `availableExecutors`, the enabled executors whose last probe did not fail; `hiddenRulesFor` compiles the hidden rules.

It deliberately does not own:

- The projections: [board-projection](board-projection.md) and [files-view-models](files-view-models.md). The browse and lint: [workflow-browser](workflow-browser.md).
- Opening, keying and closing sessions, and the shared root's lazy open: [project-sessions](project-sessions.md).
- The transcript readers `sessionHistory` and `sessionView`: [conversation-lookup](conversation-lookup.md). What `resumable` answers: [task-lifecycle](task-lifecycle.md).
- The prune rule and what it deletes: [history-pruning](history-pruning.md).
- The channel names and shapes: [ipc-channels](../contracts/ipc-channels.md).

## The unit is main-process service code on the renderer boundary, and it calls down into persistence only

- Layer `service`, in `packages/app/src/main`. It calls `@jaira/persistence` projections and stores, `sessionKey` and `jairaBasePaths` from [project-layout](project-layout.md), and the session's hubs for parked requests.
- No upstream seam.
- Boundary: renderer and main. Every read arrives through `index.ts` handlers, and the renderer names the project it stands on.
- Addressing rule, in `sessionOf`: a named directory resolves by `sessionKey`; `"shared"` resolves to the shared root; no name resolves only when exactly one user project is open, and never to the shared root. `session` turns a miss into a refusal.
- Files tree rule, in `filesTree`: no user project open, or `project` naming the shared root by alias or directory, gives the shared root's tree; otherwise the named project's tree, or every open project's when the name is not open. The shared root never appears inside a project's tree.
- `stateView` that resolves to no session reads the shared project when its `workflows/` exists, and `baseStateView` from the file alone only when that project cannot open.

## The unit stores nothing, and each fact it injects has its truth elsewhere

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `AppService.sessions`, keyed by `sessionKey` | read on every request | process memory | opened and closed by [project-sessions](project-sessions.md) |
| `ProjectSession.interactive` | read into the gate vocabulary | process memory | set by the session's registry |
| Parked requests: `hub.list()`, `approvals.list()`, `questions.list()`, `requestTask` | read by `listProjects` for `waiting` | the session's hubs | [interaction-hub](interaction-hub.md), [interaction-gateway](interaction-gateway.md) |
| `lastProbes` and `listExecutors()` | read by `stateViewOptions` | process memory and the effective config | [agent-executors](agent-executors.md) probes |
| `settings.json` `files.hidden`, `user-settings.json` `filesHidden` | read per call by `hiddenRulesFor` | the files | [project-config](project-config.md), [user-settings](user-settings.md) |
| Journal rows and operation records for `values` | read by `runValuesOf` | the journal and the record store | [event-journal](event-journal.md), [operation-record-store](operation-record-store.md) |

## The invariants keep a read in the database it names and never guess between projects

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A task read with no project open is refused, and so is an unknown task | `service.test.ts` "throws for an unknown task and when no project is open"; `shell.test.ts` "still refuses a read that names a task, because tasks need a project" |
| 2 | With two or more user projects open, an unqualified read refuses rather than answering for one of them | `service.test.ts` "opens another project ALONGSIDE the first, and refuses to guess between them" |
| 3 | With exactly one user project open, an unqualified read answers for it, and never for the shared root | `service.test.ts` "still answers for the only user project when a task names none", "is never what an unqualified call resolves to" |
| 4 | A task is read from the database of the project that holds it, and not found in another | `workflowSync.test.ts` "reads a task's detail from the project it belongs to" |
| 5 | The root files tree lists every open project and never the shared root; a named project narrows it; a name that is not open falls back to every project; no project gives the shared root | `service.test.ts` "puts every project in the files tree at the root, and the shared root in none of them", "narrows the tree to the project the shell is standing on", "falls back to every project when the address names one that is not open"; `shell.test.ts` "still shows the shared root, because it belongs to the machine" |
| 6 | A board with a level comes from the workflow that holds the level, and without one from the live workflow before any run | `shell.test.ts` "opens the board of a state in a workflow other than the newest task's"; `service.test.ts` "projects the root board from the live workflow before any run" |
| 7 | With no project open the roots board is empty and never throws | `shell.test.ts` "gives an empty board rather than throwing" |
| 8 | A shared state viewed with no user project open is the full view, with the runs that passed through it | `shell.test.ts` "views a shared state from its file, because the shared root is authorable without one"; `service.test.ts` "shows a shared SUBSTATE what has run through it, not just the root" |
| 9 | The cross-project task list is newest first and every row names its project | `service.test.ts` "lists every project's tasks as one recency-ordered list, each stamped with its project" |
| 10 | Project groups put user projects before the shared root, and each counts only its own tasks | `workflowSync.test.ts` "lists every project it can draw a board for, the user's first", "counts each group's own tasks, not the other's" |
| 11 | An effective state for a named task carries that execution's recorded values | `service.test.ts` "carries what that execution put through the state" |
| 12 | A prune plan deletes nothing, a running task is skipped, and a negative age is refused | `maintenance.test.ts` "plans without deleting, then applies", "refuses to prune a task that is still running", "rejects nonsense arguments rather than deleting the wrong thing" |
| 13 | `waiting` never counts a parked request whose task is not `running` | unasserted |
| 14 | A detail carries `resume` only for a task whose status is startable | unasserted |

## Every failure is a refusal or a fallback, and the history pane is the one read whose target the caller cannot name

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| `history:prune` with two or more user projects open | `pruneHistory` calls `session()` unqualified, and `PruneRequest` has no `project` | close all but one project | error notice "several projects are open, so this call must name one" |
| `history:prune` with no user project open | refused `no project is open`, even while standing on the shared root | open a project | error notice |
| One user project open while standing on the shared root | `history:size` reports the shared root's size, and plan and apply act on the user project | none | the plan lists the other project's tasks |
| A named project is not open | `session` refuses `project '<ref>' is not open`; `filesTree` falls back to every project instead | reopen it | error notice, or the whole tree |
| Two or more user projects open, for a state view, board or roots board | `effectiveConfig` reads the shared root's `settings.json` alone, so executor availability ignores each project's `agents` block | none | an executor reads available or unavailable by the shared settings |
| The shared root's `settings.json` is malformed while no single user project answers | `effectiveConfig` throws inside `stateViewOptions`, and inside `filesTree` when it draws the shared tree | fix the file | state views, boards and the shared tree error |
| The shared root's project cannot open | the error is kept and not retried; `listProjects` and `listAllTasks` omit it, `listSystemTasks` answers nothing, and `stateView` falls back to `baseStateView` | fix the cause and restart | no shared group, and `fileOnly` state views |
| A board level's workflow does not load | `boardForState` answers null and `board` falls back to `boardView` | fix the workflow | a board with no columns |
| A read runs while another request writes | each read is synchronous on the main thread, so it sees a whole write or none | none needed | the next push refetches |
| A prune apply is retried, or the process dies mid-prune | a retried apply deletes nothing more, because the rows are gone; a partial apply is history-pruning's | none needed | the remaining size is shown |

## Browse reads never create the shared root, and the listings do

- `filesTree`, `stateView` and the lint of a shared state use `sharedIfPresent`, which opens the shared project only when its `workflows/` exists, so looking never creates a database.
- `listProjects` and `listAllTasks` call `sharedSession` first, which runs `initBase` and opens the database, so the shared group exists before anything has run in it.
