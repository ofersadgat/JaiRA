---
id: engineering/contracts/task-view-models
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: schema
owned_by: [engineering/units/board-projection, engineering/units/files-view-models, engineering/units/workflow-browser]
consumers: ["the renderer store and every Tasks, Files and Settings surface, through task:list, task:detail, task:all, board:view, board:roots, task:conversation, files:tree, state:view, state:slots, workflow:browse, project:list, history:size and history:prune", "@jaira/app main service.ts, which adds resume, project stamps and prune remainders", "@jaira/cli jaira board --json and jaira workflow list --json"]
since: 2026-07-17
siblings: [engineering/contracts/task-channels, engineering/contracts/journal-events, engineering/contracts/task-file, engineering/contracts/ipc-channels]
---

# Task view models

The task view models are the JSON shapes in `@jaira/shared` `view.ts` that task lists, boards, the task detail, the run timeline, the workflow browser, the file tree and the state inspector are drawn from, recomputed from the journal, the task rows and the files on every read.

## A caller reads these shapes to draw tasks and workflows, and never stores them

**Use when.** Drawing or scripting against a task list, a board level, a task's instance tree and timeline, a resume plan, the lint of a project's workflows, the Files tree or one state's inspector.

**Do not use when.** Persisting anything: every field is derived again on the next read, and the stored truth is [journal-events](journal-events.md), [task-file](task-file.md) and the `task_runtime` row. Reading a transcript: `SessionRef`, `SessionView`, `SessionTurn`, `SessionOutput`, `RunMetrics` and `OperationRecordView` share `view.ts` and belong to [conversation-lookup](../units/conversation-lookup.md); `ChatThreadView`, `ChatFork`, `ChatBranch` and `ChatEditPoint` to [chat-channels](chat-channels.md); `LogEntry`, `LogPage`, `LogQuery`, `LogPolicy` and `LogOverride` to [app-log](../units/app-log.md); `JobRow` and `JobOutputChunk` to [process-claims](../units/process-claims.md). `EffectiveState` is in `ipc.ts`: [ipc-channels](ipc-channels.md).

## The shape is eight families of plain JSON, every timestamp epoch milliseconds unless it says ISO

`TaskStatus` is `queued`, `running`, `stopping`, `completed`, `failed`, `canceled` or `interrupted`. `InstanceStatus` is `running`, `waiting_for_user`, `blocked`, `completed`, `failed`, `canceled` or `timeout`.

### A task row names the task, its standing and where it came from

`TaskSummary`, from `taskSummaries`, one per `task_runtime` row. `ProjectTask` is a `TaskSummary` with `project`, the directory of the session holding it.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task id |
| `title` | string | yes | the task file's title, or `(missing task file)` |
| `status` | `TaskStatus` | yes | the runtime row's status |
| `workflow` | string | yes | the root state id, or `""` when the file is missing |
| `labels` | string array | no | the task file's labels |
| `snapshotHash` | string | no | the pinned snapshot, once started |
| `parentTaskId` | string | no | the task this one reran, was forked from or was made by |
| `origin` | `TaskOrigin` | no | set for a fork or a fan-out-made task |
| `waitingFor` | `Holding` array | no | dependencies short of `completed`; present only when non-empty |
| `createdAt` | ISO 8601 string | yes | the task file's `createdAt`, or the row's creation time |
| `updatedAt` | number | yes | the row's clock, which moves for any change to the task |
| `project` | string | on `ProjectTask` | the session directory holding the task |

`TaskOrigin`, from `taskOriginOf`, and `Holding`, from `holdingOf`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `TaskOrigin.kind` | `"fork"`, `"split"` or `"task"` | no | absent reads as `fork` |
| `TaskOrigin.taskId` | string | yes | the parent task |
| `TaskOrigin.title` | string | no | the parent's title while its file exists |
| `TaskOrigin.key` | string | for `split` and `task` | the mount's child key in the parent |
| `TaskOrigin.index` | number | for `split` and `task` | the element's 0-based position |
| `TaskOrigin.at` | number | yes | the parent's `seq` the copy was cut before; 0 for a `task` |
| `TaskOrigin.boundary` | number | yes | the copy's own last copied `seq`; 0 for a `task` |
| `TaskOrigin.boundaryAt` | number | yes | when the boundary event happened, or 0 |
| `TaskOrigin.label` | string | yes | `before <child key or state name>`, `before <to>`, `before message <n>`, `at a transition`, `at <event type>`, `event <seq>` or `a task since deleted` for a fork; `element <index + 1> of <key>` with ` (<item>)` for a fan-out |
| `Holding.taskId`, `title`, `status` | string, string, `TaskStatus` | yes | one dependency still short of `completed` |

### An instance node is one state instance folded from the journal

`InstanceNode`, from `projectRun`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `instanceId` | string | yes | the durable instance id |
| `stateId` | string | yes | the state definition |
| `childKey` | string | no | the key it was mounted under; absent on a root |
| `element` | number | no | its position in a fan-out batch |
| `parentInstanceId` | string | no | the parent instance |
| `status` | `InstanceStatus` | yes | `waiting_for_user` while an interactive function operation runs or a `call.waiting` is unsettled |
| `index` | number | yes | the last `transition.taken` index, 0 before any |
| `operation` | `OperationView` | no | the state's own operation, set from `operation.started` |
| `superseded` | boolean | yes | a later entry under the same key or a `child.superseded` replaced it |
| `startedAt` | number | yes | when it was entered |
| `endedAt` | number | no | when it terminated; cleared when a re-stated entry revives it |
| `inputs` | object of JSON values | no | the resolved inputs from `instance.entered`, unwrapped |
| `inputProvenance` | object of `InputProvenance` | no | per name in `inputs`, how it was settled: `{via: "bound", "inferred" or "asked", confidence?, from?}`. The root's is the task file's; a child's reads `bound`, except what a directed transition handed it |
| `made` | `{taskId, kind: "split", "task" or "adopt"}` | no | the task this node's element became, or the task adopted as this child; such a node has no operation and no children |
| `label` | string | no | the state's `label` resolved against `inputs`, or a settled computed `label` |
| `address` | `AddressStep` array | no | the node's position from the root |
| `calls` | `OperationCall` array | no | every `operation.dispatched`, in order, once per operation id |
| `title` | `InstanceTitle` | no | the latest settled `title` |
| `children` | `InstanceNode` array | yes | entered children in journal order, superseded ones kept |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `OperationView.kind` | `"prompt"` or `"function"` | yes | the operation's kind |
| `OperationView.status` | `"running"`, `"completed"` or `"failed"` | yes | how it stands |
| `OperationView.reason` | string | no | the failure reason, from the operation or its instance's termination |
| `OperationView.classification` | string | no | the failure's classification; `interrupted` means the call was cut |
| `OperationView.costUsd` | number | no | the cost `operation.completed` reported |
| `AddressStep.childKey`, `occurrence` | string, number | yes | the key, and which entry under it in this parent, counting superseded ones |
| `AddressStep.element` | number | no | the element within that entry |
| `OperationCall.operationId`, `kind` | string, `"prompt"` or `"function"` | yes | the record id `run:records` keys on, and the call's kind |
| `InstanceTitle.outcome` | `"value"` or `"error"` | yes | how the title settled |
| `InstanceTitle.text` | string | no | the title; a non-string value is JSON text |
| `InstanceTitle.fallback`, `error` | boolean, string | no | the binding failed and a `failureValue` stands in, and why |
| `BlockedChild.stateId`, `reason` | string, string | yes | a child whose inputs did not resolve and never became an instance |
| `PathStep.instanceId`, `stateId` | string, string | yes | one step of a path, outermost first |
| `PathStep.childKey` | string | no | the step's key |
| `TaskHeading.text` | string | yes | the nearest declared title, or the declaring state's label |
| `TaskHeading.pending`, `fallback`, `error` | boolean, boolean, string | no | the label stands in while the live title settles; a fallback value; why no computed title |
| `TaskHeading.instanceId`, `stateId` | string, string | yes | the instance and state the title belongs to |

### A board level files each task's card under a column of the level's children

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `BoardView.level` | string | yes | the state whose children are the columns; `""` on the roots board |
| `BoardView.label` | string | no | the level state's label; `All workflows` on the roots board |
| `BoardView.breadcrumb` | `{stateId, label?}` array | yes | root to level inclusive, each with the label its column shows; empty on the roots board |
| `BoardView.columns` | `BoardColumn` array | yes | the level's children in `sequence` order then declaration order; on the roots board one per workflow root and per workflow a task ran without a file |
| `BoardView.atLevel` | `BoardCard` array | yes | cards whose path stops at the level with no resting child, and queued tasks whose root is the level |
| `BoardView.finished` | `BoardCard` array | yes | completed, failed and canceled tasks that went through the level; each is also in a column |
| `BoardColumn.key`, `stateId` | string, string | yes | the child key and its state; on the roots board both are the root id |
| `BoardColumn.label` | string | no | the child's label |
| `BoardColumn.cards` | `BoardCard` array | yes | the cards filed there |
| `BoardCard.taskId`, `title`, `workflow` | string | yes | as in `TaskSummary` |
| `BoardCard.status` | `TaskStatus` | yes | the task row's status |
| `BoardCard.activeStatus` | `InstanceStatus` | no | the deepest live instance's status; never set on the roots board |
| `BoardCard.activeStateId` | string | no | the deepest state on the path; on the roots board only while live |
| `BoardCard.activePath` | `PathStep` array | yes | where the run is, or where it came to rest |
| `BoardCard.hasSubBoard` | boolean | yes | the path goes below the card's column; on the roots board whenever the path is non-empty |
| `BoardCard.labels`, `heading`, `waitingFor`, `origin` | as above | no | copied from the summary and the heading |
| `BoardCard.updatedAt` | number | yes | the row's clock |
| `BoardCard.under` | string | no | the task this card files beneath: the task that adopted it. A board draws it indented under that card when both are in one column, which the root listing always arranges |
| `BoardCard.endedAt` | number | no | the last instance termination, only for an ended task |

### A task detail is the tree, the timeline and the one run summary

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `TaskDetail.taskId`, `title`, `workflow`, `status`, `createdAt` | as in `TaskSummary` | yes | the task |
| `TaskDetail.description`, `labels`, `inputs` | string, string array, object | no | from the task file |
| `TaskDetail.snapshotHash`, `branch`, `worktreePath` | string | no | from the runtime row |
| `TaskDetail.origin`, `waitingFor`, `heading` | as above | no | provenance, holding and name |
| `TaskDetail.instances` | `InstanceNode` array | yes | at most one root tree: when the journal holds several, the stamped `root_instance_id`, else the newest |
| `TaskDetail.activePath` | `PathStep` array | yes | the live path, empty once the root ends |
| `TaskDetail.blocked` | `BlockedChild` array | yes | every blocked child in the journal |
| `TaskDetail.runs` | `RunView` array | yes | empty until the task has started and pinned, then exactly one |
| `TaskDetail.timeline` | `TimelineEntry` array | yes | the last 200 journal events, oldest first |
| `TaskDetail.resume` | `ResumePlan` | no | added by the app only for a startable status |
| `RunView.outcome` | `"success"`, `"error"`, `"canceled"`, `"interrupted"` or `"running"` | yes | the row's outcome, or `running` when it has none |
| `RunView.snapshotHash`, `startedAt` | string, number | yes | the pin and the row's start time |
| `RunView.endedAt`, `outputs`, `failure` | number, JSON, JSON | no | from the row |
| `TimelineEntry.seq`, `type`, `at`, `event` | number, string, number, JSON | yes | one stored event verbatim |
| `TimelineEntry.instanceId`, `stateId` | string, string | no | when the event names them |
| `ResumePlan.taskId` | string | yes | the task |
| `ResumePlan.kind` | `"continue"`, `"retry"`, `"fresh"` or `"none"` | yes | what starting it again does, decided as in [task-channels](task-channels.md) |
| `ResumePlan.replayed` | number | yes | operations taken from the record rather than run again |
| `ResumePlan.frontier` | `{stateId, stopped: "mid-operation" or "between-children"}` array | yes | where it picks up |
| `ResumePlan.blocked` | string | no | why an unreadable history makes the plan `none` |

### A timeline turn is one journal event or command-log entry, in time order

`ConversationView` is `{taskId, title, turns, waitingOn?}`, with at most the last 400 turns and `title` falling back to the task id.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `seq` | number | yes | the journal `seq`, or `last journal seq + 1 + command id` for a command-log turn |
| `at` | number | yes | when it happened; turns sort by `at`, then `seq` |
| `kind` | `TurnKind` | yes | see below |
| `stateId` | string | no | the state the event names |
| `instanceId` | string | no | the instance; absent on `blocked`, `tool` and `policy` |
| `path` | string | no | child keys from the root joined by `/`, an element spelled `key[i]`; `""` is the root and absent is unknown |
| `text` | string | no | `started`: the operation kind; `terminated`: the reason or outcome; `failure` and `blocked`: the reason; `transition`: the target; `tool` and `policy`: the command, reason or tool |
| `tool` | string | no | the tool, on `tool` and `policy` |
| `ok` | boolean | no | whether it went well, where that applies |
| `data` | JSON | no | `output`: the operation's metrics; `tool` and `policy`: `{reason, decision}` when both a command and a reason exist |
| `made` | `MadeBatch` | on `made` | the batch, read from where this task stands |

`TurnKind` is `entered`, `started`, `terminated`, `output`, `failure`, `blocked`, `transition` and `made` from the journal, `tool` and `policy` from the command log, where `policy` is a decision a person made, and `interaction`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `MadeBatch.kind` | `"split"`, `"task"` or `"adopt"` | yes | how the mount made its elements; `adopt` is one task that ran alone, drawn from its mirrored entry and not from a `fanout.made` row |
| `MadeBatch.runs` | `MadeTask` array | yes | every element's task, in element order |
| `MadeTask.taskId`, `element`, `title` | string, number, string | yes | the task, its position, its current title or the recorded one |
| `MadeTask.id` | string | no | the element's own id |
| `MadeTask.status` | `TaskStatus` | yes | the task's row status now, or `queued` when it has no row |
| `MadeTask.holding` | number | yes | how many dependencies it still holds for |
| `MadeTask.self`, `waitsFor` | boolean, boolean | yes | this is the reading task; the reading task's `dependsOn` names it |

### The workflow browser lists state files, roots and lint

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `WorkflowBrowser.workflows` | `WorkflowEntry` array | yes | one per derived root, by id |
| `WorkflowBrowser.files` | `WorkflowFileEntry` array | yes | every state file of every layer, by state id then layer |
| `WorkflowBrowser.unreachable` | string array | yes | state ids no successfully loaded root reaches |
| `WorkflowEntry.rootId`, `layer` | string, `"project"` or `"base"` | yes | the root and the layer its file came from |
| `WorkflowEntry.label` | string | no | the root file's label |
| `WorkflowEntry.states` | string array | yes | the closure in id order; `[rootId]` when the load failed |
| `WorkflowEntry.snapshotHash` | string | no | the hash the live bundle would pin; absent when the load failed |
| `WorkflowEntry.issues` | `LintIssue` array | yes | strict validation, component config, label and output-binding issues |
| `WorkflowEntry.loadError` | string | no | why the closure could not load |
| `WorkflowEntry.needsApproval` | `ModuleApproval` array | no | unapproved modules behind `loadError`, shaped as in [refusal-errors](refusal-errors.md) |
| `WorkflowEntry.taskIds`, `driftedTasks` | string arrays | yes | tasks running this root, and those pinned to another hash |
| `WorkflowFileEntry.stateId`, `file`, `layer`, `root` | string, string, layer, string | yes | the id, the path under `root` with `/`, the layer, the absolute `workflows/` directory |
| `WorkflowFileEntry.label`, `error` | string | no | the file's label; why it did not parse |
| `WorkflowFileEntry.shadowed` | boolean | no | a base file a project file of the same id overrides |
| `LintIssue.stateId`, `path`, `message` | string | yes | where and what |
| `LintIssue.severity` | `"error"` or `"warning"` | yes | errors are what `lintErrors` and `jaira workflow lint` count |

### The file tree and the state view describe the Files view's roots and one selected state

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `FileTree.roots` | `FileRoot` array | yes | one per shown project, or the shared root alone |
| `FileRoot.layer`, `label`, `dir`, `prefix`, `exists`, `nodes` | layer, string, string, string, boolean, `FileNode` array | yes | the root; `label` is the project's basename or `~/.jaira`; `prefix` is where the layer sits inside it, `.jaira` or `""` |
| `FileRoot.project` | string | no | the project directory, on a project root |
| `FileNode.path`, `name`, `kind`, `mime`, `layer` | string, string, `FileKind`, string, layer | yes | `path` is root-relative with `/`; `kind` is `directory`, `workflow`, `prompt`, `skill`, `config` or `other` |
| `FileNode.project`, `stateId`, `shadowed`, `error`, `lint`, `children` | string, string, boolean, string, `FileLint`, `FileNode` array | no | the project on a project node; the id of a state file; overridden base copy; parse error; lint counts; a directory's entries, directories first |
| `FileLint.errors`, `warnings` | number | yes | this file's counts, or the total beneath a directory |
| `FileLint.unchecked` | boolean | no | no loaded root validated this file; never on a directory |
| `StateView.stateId`, `layer`, `file`, `exists` | string, layer, string, boolean | yes | the state and its defining file |
| `StateView.label`, `rootId` | string | no | its label, and the root chosen to describe it |
| `StateView.operation` | `{kind, functionRef?, model?}` | no | its operation |
| `StateView.children` | `{key, stateId, label?, hasChildren}` array | yes | columns in run order |
| `StateView.board` | `BoardView` or `null` | yes | null for a leaf or a state no workflow holds |
| `StateView.tasksHere`, `tasksRecent` | `BoardCard` arrays | yes | tasks not ended inside the state; the eight most recently updated ended ones |
| `StateView.transitions` | `{when, to, loops}` array | yes | `when` is the guard or `always`; `loops` marks a target that is the state or an ancestor |
| `StateView.environment` | `{executor?, available, from?}` | yes | the executor, whether it is available, and `environment` when inherited |
| `StateView.issues` | `LintIssue` array | yes | the chosen root's issues for the state, plus operation and executor errors |
| `StateView.references` | `{ref, resolved, layer?}` array | yes | `$ref` strings found in the state |
| `StateView.referencedBy`, `driftedTasks` | string arrays | yes | states declaring it as a child; drifted tasks among `tasksHere` |
| `StateView.fileOnly` | boolean | no | read from the file alone, so lists are unknown rather than empty |
| `StateSlots.inputs`, `outputs` | `{name, optional, description?}` arrays | yes | declared slots; `optional` when `optional` or a `default` is set |
| `StateSlots.session` | `{declared}` | no | the raw `session` declaration, where `null` is a declaration |

### The project and history summaries count tasks per open project

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ProjectSummary.project`, `label` | string, string | yes | the session directory; the basename, or the shared root's home-relative path |
| `ProjectSummary.kind` | `"user"` or `"shared"` | yes | a checkout or the shared root |
| `ProjectSummary.tasks`, `running` | number | yes | all task rows; running ones, waiting included |
| `ProjectSummary.statuses` | partial map of `TaskStatus` to number | yes | the rows split by status |
| `ProjectSummary.waiting` | number | yes | running tasks with a parked gate, approval or question |
| `ProjectSummary.ended` | `{taskId, status, updatedAt}` array | yes | every task neither `running` nor `queued` |
| `HistorySize.tasks`, `events`, `commands` | number | yes | rows stored |
| `PruneResult.tasks` | `{taskId, endedAt?, events, commands}` array | yes | tasks whose history is or would be removed |
| `PruneResult.events`, `commands`, `dryRun` | number, number, boolean | yes | totals, and whether this was a plan |
| `PruneResult.skippedTasks` | `{taskId, status, reason}` array | yes | tasks the prune rule refused |
| `remaining` | `HistorySize` | on `history:prune` | the size after the call |

## Errors come from the producers, and a browse answers empty where a task read refuses

| Condition | Response | Caller does |
| --- | --- | --- |
| A task id has no runtime row | `taskDetailView` and `conversationView` refuse `unknown task '<id>' in <projectDir>` | read from the project that holds the task |
| A task file does not parse | its parse error leaves every list, board and detail of that project | repair or delete the file |
| No project is named and none, or several, are open | refused `no project is open` or `several projects are open, so this call must name one` | name the project |
| A named project is not open | refused `project '<ref>' is not open`; `files:tree` shows every open project instead | open it or name another |
| No project is open for a browse | `board:roots` answers an empty board; `files:tree` and `state:view` answer from the shared root | nothing |
| A state nothing defines | `state:view` answers `exists: false` with no board; `state:slots` omits it | nothing |

## Adding an optional field is safe, and renaming or retyping one breaks the renderer and scripts at once

- Every shape is computed per read and never persisted, so no change needs a migration, and an older journal simply leaves a newer optional field absent.
- Renaming, retyping or making required any field breaks the renderer surfaces and any script reading `jaira board --json` or `jaira workflow list --json`.
- Changing `TurnKind`, `InstanceStatus` or `TaskStatus` values breaks the renderer's lanes, pills and error routing, which switch on them.
- Changing `AddressStep` or the `key[i]` spelling of `path` breaks the rail and the placing of panels, which match addresses against paths.
- The shapes carry no version, so there is no deprecation path.

## Several fields mean less, or something else, than their names suggest

- `ConversationView.waitingOn` and the `interaction` turn kind are declared and never produced.
- `BoardCard.status` is the task row and `activeStatus` the deepest live instance, so a `running` task parked on a gate reads `waiting_for_user` only in `activeStatus`, and never on the roots board.
- `jaira board` builds its shape without a gate vocabulary, so every running function state there reads `waiting_for_user`.
- `board:view` without a level, or through `boardView` directly, projects only the most recently updated task's workflow; tasks of other workflows are on no column.
- `TaskOrigin.at` and `boundary` are `seq` values, which a file-backed journal re-mints at each open, as [journal-events](journal-events.md) says, so a fork's label can name a different event after a reopen. `taskOriginOf` always sets `kind`.
- `TaskSummary.createdAt` is an ISO string from the file and `updatedAt` is the row's epoch clock; `BoardCard.endedAt` is the journal's, and the only one that says when a run ended.
- `ProjectSummary.ended` includes `stopping` tasks, and `running` includes those waiting on a person.
- `ProjectTask.project` and `ProjectSummary.project` are directories, including for the shared root, and never the `shared` alias.
- A turn's absent `path` means the journal did not record where, which is different from `""`, the root.
- `WorkflowEntry.issues` is empty when `loadError` is set, which is not the same as clean; `FileLint.unchecked` carries that distinction into the tree.
