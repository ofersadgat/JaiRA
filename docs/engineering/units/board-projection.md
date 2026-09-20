---
id: engineering/units/board-projection
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/keep-track-of-everything, product/complete-record-of-every-run, product/failures-explain-themselves, product/know-what-work-costs, product/large-work-splits-into-independent-pieces, ux/patterns/drill-in-and-back-out, ux/patterns/nested-under-what-caused-it, ui/components/task-board, ui/components/task-card, ui/components/task-name, ui/components/task-panel, ui/components/instance-index]
layer: data
owns_contracts: [engineering/contracts/task-view-models]
requires: [engineering/units/event-journal, engineering/units/task-lifecycle, engineering/units/workflow-snapshots, engineering/units/workflow-browser, engineering/units/run-load, engineering/units/tool-policy]
implemented_by: [packages/persistence/src/projection.ts, packages/persistence/src/views.ts, packages/persistence/src/conversation.ts, packages/persistence/src/shape.ts, packages/persistence/src/runLabel.ts]
verified_by: [packages/persistence/test/projection.test.ts, packages/persistence/test/conversationPath.test.ts, packages/persistence/test/madeTurn.test.ts, packages/persistence/test/runLabel.test.ts, packages/app/test/eachHosted.test.ts, packages/app/test/runCut.test.ts]
siblings: [engineering/units/files-view-models, engineering/units/conversation-lookup, engineering/units/run-load, engineering/units/view-addressing]
---

# Board projection

## The projection turns one task's journal into the tree, board, summary, detail and timeline a person reads, and writes nothing

`projection.ts` is a pure fold over upstream `EngineEvent`s:

- `projectRun(events, shape?, atMs?)` builds the instance forest. It sets `waiting_for_user` while an interactive function operation runs or a `call.waiting` is unsettled, supersedes a child when its key is entered again or `child.superseded` names it, keeps the elements of one fan-out batch beside each other, lists `calls` in dispatch order once per operation id, keeps the latest settled `title` and `label`, records `instance.blocked` as a `BlockedChild`, merges a re-stated `instance.entered` into the instance it names, and stamps each node's `address` with `occurrenceOf`.
- `activePathOf`, `restingPathOf`, `boardPathOf` and `restingChildOf` answer where a run is and where it came to rest, with `isLive` deciding which instances still count.
- `headingOf` names a task after the nearest instance on its board path whose state declares a title.
- `projectBoard(shape, level, tasks)` files cards into the level's columns, `atLevel` and the `finished` census; `breadcrumbOf` walks root to level.

`shape.ts` reduces a `WorkflowBundle` to the `WorkflowShape` the fold reads: label, children in `sequence` order then declaration order, `interactive` and `titled`. `runLabel.ts` resolves a state's `label` against one run's inputs with `resolveLabel`, and `checkLabel` asks the same of declared inputs for lint.

`views.ts` joins the fold to a `Project`: `taskSummaries`, `taskOriginOf`, `bundleFor`, `runCauses`, `runCostUsd`, `taskRun`, `instanceAddresses`, `boardView` and `taskDetailView`. `conversation.ts` holds `conversationView`, the timeline of journal turns merged with command-log turns. Every shape these return is [task-view-models](../contracts/task-view-models.md).

It deliberately does not own:

- A board for an arbitrary state, the roots board, the file tree and the state inspector: [files-view-models](files-view-models.md).
- `StateSession`, `parseSessionRef`, `stateSessions` and `interruptedSessions`, which sit in `views.ts`, and every transcript: [conversation-lookup](conversation-lookup.md).
- The resume plan a detail carries, folded by the app from [run-load](run-load.md), and which database answers a read: [view-addressing](view-addressing.md).
- `holdingOf`, the task row and the task file: [task-lifecycle](task-lifecycle.md).

## The projection is a data-layer read that both hosts call, over the engine's event vocabulary

- Layer `data`, package `@jaira/persistence`. It reads `project.events`, `project.runtime`, `project.tasks`, `project.commands` and `project.db`, and calls `loadSnapshot` and `readWorkflowFiles`, `workflowLoadOptions`, `holdingOf` and `occurrenceOf`.
- No engine port. It reads the `EngineEvent` vocabulary of `@declarative-ai/hw` as stored in [journal-events](../contracts/journal-events.md), and calls `loadBundle`, `parseExpression` and `selfPathOf`.
- Boundary: workflow and run. `bundleFor` draws from the task's pinned snapshot and falls back to the live files only when there is none or it cannot be read.
- Boundary: renderer and main. Every return value is plain JSON, sent over IPC by the app and printed by the CLI.
- Callers: the app's `task:list`, `task:detail`, `board:view`, `task:conversation`, `project:list` and `task:all` in `service.ts`; `stateViews.ts`; `jaira board`, and the failure causes the CLI prints after a run.

## The projection stores nothing, and the journal is the truth for every instance it draws

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events` | read whole per task by `project.events.list`; one row by `seq` in `taskOriginOf` | the journal, see [event-journal](event-journal.md) | written by the engine, the fan-out host and chat turns |
| `task_runtime` row | read: `status`, `snapshotHash`, `forkedAtSeq`, `forkBoundarySeq`, `rootInstanceId`, `outcome`, `outputsJson`, `failureJson`, timing | the row | [task-lifecycle](task-lifecycle.md) |
| Task file | read by `tryRead`: `title`, `workflow`, `labels`, `description`, `inputs`, `origin`, `dependsOn` | the file, see [task-file](../contracts/task-file.md) | task-lifecycle and the fan-out host |
| `command_log` | read by `project.commands.list` into `tool` and `policy` turns | the table | written by [tool-policy](tool-policy.md) |
| Workflow shape | read by `bundleFor` then `workflowShape` | the pinned snapshot, else the live `workflows/` | [workflow-snapshots](workflow-snapshots.md), [workflow-browser](workflow-browser.md) |
| View models | computed per call, never stored | the rows and files above | the app, the CLI and `stateViews.ts` |

## The invariants keep the board a faithful fold of the journal, with a card that never jumps columns

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The tree and active path come from the journal alone, and an event naming an unknown instance is skipped, never thrown | `projection.test.ts` "builds the instance tree and the active path from the journal", "ignores events for unknown instances rather than throwing" |
| 2 | An interactive function operation reads `waiting_for_user` while it runs, and a non-interactive one never does | `projection.test.ts` "reports waiting_for_user while an interactive function runs", "a non-interactive function state is not waiting_for_user" |
| 3 | A reset or a re-entered key supersedes earlier instances without deleting them, while the elements of one batch sit side by side | `projection.test.ts` "supersedes cleared sequence members instead of dropping their history", "re-entering a child key supersedes the previous instance even without a reset event", "keeps the elements of a fan-out beside each other, and lets a new batch supersede them" |
| 4 | A blocked child never becomes an instance | `projection.test.ts` "records a blocked child without inventing an instance for it" |
| 5 | Calls are listed in dispatch order, and a call a resumed run re-dispatched is listed once | `projection.test.ts` "keeps every call, in dispatch order, on a state that has no operation of its own", "does not double a call a resumed run re-dispatched" |
| 6 | A re-stated entry merges into the instance it continues, and a revived failure reads running again | `projection.test.ts` "merges a re-stated spine into the instance it continues", "reads a revived failure's re-entry as running again" |
| 7 | A card sits in the column its path enters or last rested in, including a run parked between children, and does not change column when the run ends | `projection.test.ts` "places each task in the column its active path enters", "files a task parked between children under the column it came to rest in", "rests on the LATEST child when a loop ran one twice", "places a finished task in the column it came to rest in" |
| 8 | An ended task that went through the level is in `finished` as well as in its column | `projection.test.ts` "lists an ended task in finished as well as in its column" |
| 9 | A task whose path never reached the level is on no column of it, and a queued task is only at its own root's level | `projection.test.ts` "leaves a task whose path never reached this level off the board entirely", "puts a queued task at the level that is its own workflow root", "keeps a queued task off a level below its root, where it has not arrived" |
| 10 | A task a mount made is filed in that mount's column on its parent's board, and a split copy stands in the mount's column | `eachHosted.test.ts` "makes a task per element, waits for them in order, and reads their outputs back gathered", "continues here with element 0, retitled by it, and leaves a queued copy per other element sharing one record at the mount" |
| 11 | A running card has no `endedAt`, and an ended one is dated by its last instance to terminate | `projection.test.ts` "puts no ending on a card whose run is still going", "dates a finished card by the last of its instances to terminate" |
| 12 | The heading is the nearest declared title, the declaring state's label is `pending` only while that instance is live, and no declarer gives no heading | `projection.test.ts` "names the task after the NEAREST declared title, not an ancestor's", "shows the declaring state's label while its title is pending, even when an ancestor's has settled", "is nothing when no state on the path declares a title, and no longer pending once the run has ended", "puts the heading on the board card" |
| 13 | The breadcrumb carries the label the board draws, and a cyclic shape never loops the walk | `projection.test.ts` "carries the label the board draws for each level", "terminates on a cyclic shape" |
| 14 | A turn's `path` spells an element `key[i]`, a blocked turn carries no instance, and a re-stated entry is not narrated again | `conversationPath.test.ts` "spells an element of a fan-out as key[i], the way the engine addresses it", "carries NONE for a blocked child, because there never was one", "is folded into the instance it continues, not narrated again" |
| 15 | A fan-out's `made` line is one per mount, read from where the reading task stands, and a mirrored row or node is claimed only by the task its provenance names | `madeTurn.test.ts` "is one `made` line at the mount listing every run, read from where this task stands", "says how each run stands now, off its row", "is not claimed by a task that did not make it, even when the id is a task's", "marks a mirrored element's node as made, so no panel is drawn for it" |
| 16 | A label without a leading dot is a literal, and a label richer than an input path is refused rather than half-evaluated | `runLabel.test.ts` "treats a bare word as a literal, so no existing label had to grow quotes", "refuses an expression richer than a path instead of half-evaluating it" |
| 17 | A fork's origin names, in words, the parent's event it was cut before | `runCut.test.ts` "is a second task that asks the question again, while the original keeps its answers" |
| 18 | A legacy journal holding several root trees draws only the one `root_instance_id` names, or else the newest | unasserted |

## Every failure degrades a read rather than a record, and one bad task file fails every list in its project

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A task file does not parse | `tryRead` throws, so `taskSummaries`, `boardView` and `taskDetailView` throw for the whole project | repair or delete the file | every task list and board of the project errors |
| A task file is missing | the summary and detail read `(missing task file)` with workflow `""` | recreate or delete the task | a placeholder row |
| The pinned snapshot is missing or corrupt | `bundleFor` loads the live files instead, without saying so | none | columns and labels from the current workflow, which may not be what ran |
| Neither a snapshot nor the live workflow loads | no shape: `boardView` returns a level with no columns, and in a detail an interactive operation reads `running`, with no declared labels and no pending heading | fix the workflow | a board with no columns |
| `boardView` is asked with no level, or for a level the newest task's workflow does not hold | the shape is the most recently updated task's workflow, so other workflows' tasks are on no column | ask `board:view` with a level, which resolves the owning workflow | tasks of other workflows missing |
| `jaira board` projects without a gate vocabulary | `functionRefsOf` treats every function operation as interactive | none | every running function state shows waiting |
| A task's journal outgrows the limits | `taskDetailView` keeps the last 200 events and `conversationView` the last 400 turns | none | the earliest history is not shown |
| A fork's parent has been deleted, or the event at `forkedAtSeq` is gone | the label reads `a task since deleted`, or `event <seq>` | none | a vaguer origin line |
| Another process appends while a read folds | the read sees the rows committed when it listed them, which is a consistent prefix of an append-only journal | read again | the view catches up on the next push |
| Two writers, a process killed mid-write, a retry that duplicates | the projection writes nothing; a duplicated dispatch is deduplicated by operation id and a re-stated entry merged by instance id | none needed | the call and the step are drawn once |

## Budgets are the two tail limits

- `TIMELINE_LIMIT` is 200 events, in `views.ts`.
- `CONVERSATION_LIMIT` is 400 turns, in `conversation.ts`, overridable through `ConversationOptions.limit`.
