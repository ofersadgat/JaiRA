---
id: engineering/contracts/task-channels
type: engineering-contract
status: shipped
updated: 2026-09-22
visibility: internal
kind: api
owned_by: [engineering/units/task-lifecycle, engineering/units/rewind-and-fork]
consumers: ["@jaira/app renderer store.ts task actions", "@jaira/app renderer taskAction.ts, through task:detail", "@jaira/app main index.ts handler table", "@jaira/app tests driving AppService"]
siblings: [engineering/contracts/chat-channels, engineering/contracts/inbox-channels, engineering/contracts/ipc-channels, engineering/contracts/task-view-models, engineering/contracts/refusal-errors]
---

# Task channels

The IPC request channels the renderer invokes to create, start, stop, resume, rerun, rewind, fork, rename and delete a task, and to approve the module files a start refused on.

## A caller reaches for these to change what a task is doing, and for nothing it only reads

**Use when.** Acting on a task's lifecycle from the renderer, asking which of resume, start or rerun its primary action performs, or answering an `ApprovalRequired` refusal.

**Do not use when.** Typing into a conversation: [chat-channels](chat-channels.md). Answering a gate, an approval or a question: [inbox-channels](inbox-channels.md). Reading tasks with `task:list` or `task:detail`: [ipc-channels](ipc-channels.md), with the shapes in [task-view-models](task-view-models.md). Working from a terminal: [jaira-cli](jaira-cli.md). How a call is invoked and how its failure travels: [preload-bridge](preload-bridge.md).

## The shape is one request per channel, and every request may name its project

### Every request resolves its project the same way

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `project` | `ProjectRef`, a string | no | a project directory, or `"shared"` for the shared root; absent names the only open user project |

### Creating and renaming answer the task's summary

`task:create` takes `CreateTaskRequest` and answers a `TaskSummary` with `status: "queued"`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `title` | string | yes | the task's name |
| `workflow` | string | yes | root state id; not checked until the first start |
| `description` | string | no | free text |
| `labels` | string array | no | free labels |
| `inputs` | `Record<string, JsonValue>` | no | the root inputs, fixed for the task's life |
| `sources` | `Record<string, {taskId, output}>` | no | inputs taken from a task, per input name; read at creation when that task has completed, else the new task holds for it and the value is read at its start. Recorded `bound` with `from` |
| `provenance` | `Record<string, InputProvenance>` | no | how the typed `inputs` were settled; absent reads `{via: "asked"}` for each |
| `branch` | string | no | branch binding; refused on the shared root |
| `project` | `ProjectRef` | no | where the task is recorded, and whose config governs its runs |

`task:rename` takes `{taskId: string; title: string; project?}` and answers the renamed `TaskSummary`. The title is trimmed. Both answers fill only `taskId`, `title`, `status`, `workflow`, `labels`, `createdAt` and `updatedAt`.

### Starting, resuming and rerunning share one request

`task:start`, `task:resume` and `task:rerun` take `StartTaskRequest` and answer `{taskId: string}`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task to start, to resume, or to copy and start |
| `interactions` | `Record<string, JsonValue[]>` | no | scripted gate answers keyed by function name: [interactions-script-format](interactions-script-format.md) |
| `fake` | `JsonValue` | no | scripted prompt rules, parsed in main as `FakeRule[]`: [fake-rules-format](fake-rules-format.md) |
| `overrides` | `ChatSettings` | no | settings written into the root state's prompt operation and pinned as the snapshot; read by `task:start` and `task:rerun` only |
| `project` | `ProjectRef` | no | as above |

| Channel | `taskId` answered | Resolves when |
| --- | --- | --- |
| `task:start` | the task asked about | the run is wired and detached; its end arrives as `run:finished` over [push-messages](push-messages.md) |
| `task:resume` | the task asked about | the same, with the machine loaded from its record |
| `task:rerun` | a new task, `parentTaskId` naming the one asked about | the new task's start resolved |

### `task:resumable` answers the plan the primary action follows

`task:resumable` takes `{taskId: string; project?}` and answers a `ResumePlan`, whose fields are in [task-view-models](task-view-models.md). Its `kind` is decided in this order:

| `kind` | When |
| --- | --- |
| `none` | the task is unknown, or its status is not startable |
| `fresh` | no snapshot is pinned, or the journal holds no event |
| `none`, with `blocked` | the load is blocked or has an unreadable operation; `blocked` carries the block or the first unreadable reason |
| `none` | the load finds no machine in the journal |
| `continue` | a frontier entry's cause is `interrupted` |
| `retry` | every frontier entry's cause is `failed`, or the frontier is empty |

### `task:move` publishes a person's move, and answers how it landed

`task:move` takes `TaskMoveRequest` and answers `TaskMoveResult`, `{taskId: string; status}`. It is `task_move`, published ([decision 0005](../decisions/0005-connect.md)): the board's drop sends it, and a conversation's tool will.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task to move |
| `toState` | string | yes | a child key of the instance the move is for |
| `by` | `"person"` or `"control"` | no | who asked, journaled on `transition.taken`; absent reads `"person"` |
| `skip` | boolean | no | interrupt the running state rather than wait for it to end |
| `inputs` | `Record<string, JsonValue>` | no | handed to the target over the workflow's own wiring, per input name |
| `instanceId` | string | no | the composite whose child `toState` is; absent names the task's root instance |
| `path` | string[] | no | child keys entered beneath `toState`, in order: each is directed at the composite above it the moment the journal says that composite entered, so it goes straight to the named child |
| `interactions`, `fake` | as `task:start` | no | script the run a reopen starts |
| `project` | `ProjectRef` | no | as above |

| `status` | When |
| --- | --- |
| `answered` | a transition of the task was waiting on `on_user_event('task_move' or 'task_drag', {to_state})` for this state, and now has its answer. Not tried with `skip` or `instanceId` |
| `taking` | the task runs in this process, has the move, and nothing stands in its way |
| `held` | the task runs in this process and takes the move when its running state ends; journaled `jaira.moveHeld`, so a resume after a crash or a close re-queues it, and a stop drops it ([journal-events](journal-events.md)) |
| `reopened` | the task was not running and was started again by load with the move waiting; a `completed` task is reopened under its own id, and any other status steps past the state it stopped in |

### `task:fastForward` runs a task to a state ahead of it, `task:skip` goes there directly, and `task:answerYourself` takes an answer back

`task:fastForward` takes `TaskFastForwardRequest` — `{taskId, target, toState, instanceId?, path?, through?, by?, inputs?, interactions?, fake?, project?}` — and answers `{taskId, controlTaskId, status: "fast-forwarding"}` ([decision 0005](../decisions/0005-connect.md) §4). It is what `task:connect` hands a forward move; no transition is handed to anybody. The task's controlling conversation is found — its own root when that is a prompt, else the nearest task above it whose root is — or GIVEN one: `chat/control` is grafted onto the task's own frozen root, a diverged document, idle. Then the task is started or resumed and its spine walks it forward. While it does, `TaskDetail.fastForward` holds the strip's content, a gate or an agent's question that parks is first offered to the conversation, and an answer at or above `autopilot.askBelow` settles it, journaled `jaira.answered`. It ends when the target is entered, a state on the way ends `error` or `timeout`, the run ends, the task is stopped, or Skip is pressed. Rejected with the reason when the task runs in another process, runs here with no conversation, or has nothing left to run.

`task:skip` takes `{taskId, project?}` and answers `TaskMoveResult`: the fast-forward's own move, as `task:move` with `skip: true`. Rejected when the task is not being fast-forwarded.

`task:answerYourself` takes `{taskId, at, project?}` and answers `{taskId}`: a fast-forward still running is ended and the run stopped, then `task:rewind` to `at` — the seq of the ENTRY of the state whose gate the conversation answered (`InstanceNode.settledBy.at`), so the state asks again.

### `task:connect` sends a task to a state, and answers which of three things that was

`task:connect` takes `TaskConnectRequest` and answers `TaskConnectResult` ([decision 0005](../decisions/0005-connect.md) §1). It composes `task:move`, `task:adopt` and the dynamic workflow generator and owns none of them; `connectTask` in `persistence/connect.ts` holds the order. The board's drop sends it, the conversation's `move_task` tool does, and `jaira task move` is the same call.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task to send |
| `target` | string | yes | a state id; a workflow's own root id means "into this workflow" |
| `workflow` | string | no | the composite that holds the target; narrows the second resolution to it and skips the first when it is not the task's own |
| `forward` | `"fast-forward"` or `"skip"` | no | how a forward move crosses the states between; absent reads `fast-forward`: the states between RUN, with the task's controlling conversation answering on the way (`task:fastForward`) |
| `skip` | boolean | no | `true` is `forward: "skip"` |
| `by` | `"person"` or `"control"` | no | who asked, journaled on the move |
| `dryRun` | boolean | no | answer what would happen and change nothing: no task, no document, no pin, no journal row |
| `start` | boolean | no | `false` leaves a task the connect makes queued where no move has to be taken; a move an engine has to take starts one regardless |
| `supplied` | `{[input]: {value, via: "inferred" or "asked", confidence?}}` | no | values a conversation hands the target by its own declared names; journaled `jaira.supplied` |
| `askAfter` | boolean | no | what the board's drop and its hover send: where a MODIFIED workflow (`plan.resolution: "modify"`) leaves required inputs of the target open, do not refuse — make the conversation without the target and answer `asking`. The app then gives that conversation its opening turn, which asks for them in words; its `start_task` mounts the target. A dry run answers the same `asking` and writes nothing. A `move` or `adopt` that leaves a required input open is still refused |
| `interactions`, `fake` | as `task:start` | no | script a run the connect starts; `fake` also answers the opening turn `askAfter` gives |
| `project` | `ProjectRef` | no | as above |

Resolution, in order, stopping at the first that applies:

| `plan.resolution` | When | What it does |
| --- | --- | --- |
| `move` | the task's pinned definition mounts the target, at any depth | `task:move` from the deepest instance the task stands in that the path passes through, with `path` for the rest of the way down |
| `adopt` | one composite mounts the task's root state as a child and either is the target or mounts it as a child too; tried only for a task in no document that nothing made | `task:adopt` into a new task of that composite, then `task:move` of the new task unless the target is what comes next anyway |
| `modify` | neither | `generateDocumentVersion`: `new` for a task that finished well, whose task is made and which adopts the source as its first child; `augmented` for a task already in a document; `cloned` for one standing inside a real workflow. Then `task:move` |

`TaskConnectResult` is `{ok: true, dryRun, plan, taskId?, moved?, controlTaskId?, undo?, asking?}` or `{ok: false, dryRun, refusal, plan?}`. `taskId` is the task that stands at the target: the moved task, or the parent a connect made, absent from a dry run that would make one. `moved` is `task:move`'s status, or `fast-forwarding` for a forward move that runs the states between, when `controlTaskId` names the conversation answering on the way. `asking` answers `askAfter`: the required inputs the conversation `taskId` is about to ask for, as `ConnectMissingInput`s; nothing moved, so `moved` is absent. A refusal carries `plan` wherever the resolution got far enough to have one, so a preview can say what was refused.

An `askAfter` connect that answers `asking` makes, for `new`, the document, its task and the adoption, the task queued and its conversation idle; for `cloned`, the diverged copy with the conversation grafted on; for `augmented`, nothing. The app then runs one turn of that conversation, as a typed turn runs, whose message is `askingMessage` from `persistence/connect.ts`: what the person did, each open input by its declared name, description and schema, and to ask for them in plain words and call `start_task` with the answers named in `asked`. The model's reply is the question. An idle conversation's first turn begins a new session named `chat:<root instance>`, so the conversation has a thread from then on.

| `ConnectPlan` field | Type | Meaning |
| --- | --- | --- |
| `resolution` | `"move"`, `"adopt"` or `"modify"` | which of the three |
| `modification` | `"new"`, `"augmented"` or `"cloned"`, optional | which modification, for `modify` |
| `workflow`, `workflowLabel` | string | the workflow the task will stand in; `jaira:dynamic:…` from a `new` dry run, whose document does not exist yet |
| `standsAt` | `{path: string[], stateId, label?}` | child keys from that workflow's root to where the task will stand |
| `move` | `ConnectMove`, optional | the directed transition it ends in; absent where the adoption alone reaches the target |
| `forward` | `"fast-forward"` or `"skip"`, optional | how a `forward` move crosses what it passes; absent for any other direction |
| `adopt` | `AdoptPlan`, optional | the adoption that is part of it; absent from a `new` dry run |
| `adoptedAs` | string, optional | the child key the task becomes |
| `mount` | `"plain"` or `"split"`, optional | the mount a modification adds; `split` makes one held task per element |
| `inputs` | `{name, via: "wire", "literal" or "default", from?, each?}` array | how each input of the target settles |
| `asks` | `ConnectMissingInput` array | inputs nothing determines that are not required |
| `branch` | string, optional | the branch a made parent takes up |

| `ConnectMove` field | Type | Meaning |
| --- | --- | --- |
| `direction` | `"backward"`, `"next"`, `"forward"` or `"aside"` | `aside` is a child on no spine, as a document's children are |
| `instanceId` | string, optional | the composite whose child is entered; absent names the root instance |
| `to`, `path` | string, string[] | the child entered, and the child keys entered beneath it |
| `passes` | string[] | the states a forward move steps over, as paths of child keys |
| `stepsPast` | string, optional | the state a task that is not running stopped in, which the move records `skipped` |
| `answersRule` | boolean, optional | a transition of the workflow is waiting on exactly this move, so nothing is stepped over and no input is checked |

| `refusal.code` | When | Also carries |
| --- | --- | --- |
| `unknown-task`, `unknown-target` | the task has no row, or no state of that id is on the workflow path | |
| `already-there` | the target is the task's own root | |
| `never-run` | the task has no journal, so it stands nowhere | |
| `unloadable` | the task's pinned workflow or its journal does not load | |
| `fast-forward` | a forward move would step over states, did not say `skip`, and cannot be run: from a host that drives no run (the CLI), or in the app for a task running with no conversation, running in another process, or with nothing left to run — the message says which | `plan` with `move.passes` |
| `ambiguous-workflow` | more than one composite holds both | `candidates: [{workflow, label?, childKey, targetKey?}]`; call again with `workflow` |
| `inputs-missing` | a required input of the target, of an ancestor entered on the way down, of the adopting workflow or of a new document's conversation would not be bound | `missing: [{state, name, schema?, description?, reason}]` |
| `running` | the move is a new transition and an engine is running the task, which picks a new version up only at its next load | |
| `adopt` | the adoption refused | `adopt`, the `AdoptRefusal` |
| `generate` | the generator or its lint refused | |

`ConnectUndo` is `{kind: "adopt", parentTaskId, adoptedTaskId, made}` or `{kind: "move", taskId, after, pin?, wasCompleted?, asking?}`. `after` is the task's last journal seq before the move. `asking: true` marks an `askAfter` connect of a `cloned` or `augmented` task, which moved nothing.

### `task:connectUndo` takes a connect back with the token it handed out

`task:connectUndo` takes `{undo?: ConnectUndo, taskId?, project?}` and answers `{taskId, removed?}`. A real connect also KEEPS its token on the card's task file (`TaskMeta.connectUndo`, [task-file](task-file.md)), so it survives a restart: given a `taskId` whose task keeps one, the kept token is used — a move's `after` re-read from its place in the journal, counted in rows — whatever `undo` says. Neither kept nor given refuses with `task '<id>' has no connect to take back`. A use clears the kept token, and `TaskSummary.undoable` and `BoardCard.undoable` say which tasks still keep one.

| `undo.kind` | Does |
| --- | --- |
| `adopt` | cuts the parent's journal at the mirror row and releases the adoption, resuming nothing; a parent the connect made that had entered nothing of its own is deleted, row and file, after its `worktree_path` is cleared because the tree is the adopted task's. `removed` names it. A parent that ran something is kept; a turn of its conversation is not something it ran |
| `move` | `task:rewind` to `after + 1` when the journal holds anything later, which puts a cloned task back under its previous pin; a task that had completed is put back completed with the outputs its reopening cleared, read from the `jaira.reopened` row ([journal-events](journal-events.md)); then the pin is put back if it still differs. With `asking`, the journal is cut at `after + 1` WITHOUT a resume and the task's status and outcome are put back as they were. A kept token carries `asking` too, so an Undo after a restart still takes the conversation back |

Either kind first stops a turn the task's conversation is taking and waits for it to land, up to the chat wait, so the opening turn an `askAfter` drop started cannot write after the cut.

### `task:adopt` takes a task up as a child, and answers the plan or the refusal

`task:adopt` takes `TaskAdoptRequest` and answers `TaskAdoptResult` ([decision 0005](../decisions/0005-connect.md) §2, [adoption](../units/adoption.md)).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task to adopt |
| `childKey` | string | no | which child of the parent's root it stands for; needed only where the root mounts the task's state more than once |
| `workflow` | string | unless `parentTaskId` | the root state id of the NEW task that adopts |
| `parentTaskId` | string | no | adopt INTO this task instead of making one; its workflow is what it runs under |
| `also` | `{taskId, childKey?}` array | no | more tasks the same parent takes up |
| `inputs` | `Record<string, JsonValue>` | no | what the form supplied for the parent's inputs the adopted tasks do not determine; never overrides an inferred one |
| `suppliedVia` | `"asked"` or `"inferred"` | no | how `inputs` were settled; absent reads `asked` |
| `title` | string | no | the new task's title; absent takes the adopted task's |
| `dryRun` | boolean | no | answer what would happen and change nothing |
| `start` | boolean | no | `false` leaves the parent standing past the child, not started |
| `interactions`, `fake` | as `task:start` | no | script the parent's run |
| `project` | `ProjectRef` | no | as above |

`TaskAdoptResult` is `{ok: true, dryRun, plan, taskId?, started?}` or `{ok: false, dryRun, refusal}`. `taskId` is the parent and is absent from a dry run. `started` is false when `start` was false or the parent holds.

| `AdoptPlan` field | Type | Meaning |
| --- | --- | --- |
| `workflow`, `title` | string | the parent's workflow and title |
| `parentTaskId` | string, optional | the existing task adopted into |
| `adopted` | `{taskId, title, childKey, stateId, shape, index?, pending, stateChanged}` array | each child taken up, in sequence order; `shape` is `child` or `split`, `index` the split element, `pending` a task that has not completed |
| `cursor`, `next` | string, string optional | the child the parent stands past, and the one that runs next |
| `inputs`, `provenance` | objects | the parent's inputs as recorded, and how each was settled |
| `asks` | `{name, required, schema?, description?}` array | declared inputs nothing determined |
| `branch` | string, optional | the branch the parent takes up |
| `waitsFor` | string array | tasks the parent holds for |

| `refusal.code` | When |
| --- | --- |
| `unknown-task`, `unknown-workflow` | the task, the parent or the workflow does not exist or does not load |
| `not-mounted`, `ambiguous-child` | no child of the root mounts the task's state, or more than one does and `childKey` does not say which |
| `unsupported-mount` | the child fans out inline or `each: "task"` |
| `already-adopted` | the task already has an `origin` |
| `parent-state` | `parentTaskId` names a task that is running or finished, has entered that child, or stands past it |
| `schema-misfit` | a recorded output does not fit the mounted state's current slot; `path` is `outputs.<name><path>` |
| `hole` | a child before the cursor is neither adopted nor unread; `reference` is `<where> → children.<key>` |
| `split-element` | the split's list is not a parent input or an adopted sibling's output, or the element is not in it |
| `inputs-conflict` | two children, or the child and the existing parent, disagree on an input bound by a plain path |
| `inputs-missing` | a real adoption with a required `ask` left; never answered by a dry run |
| `workspace` | adopted tasks on different branches, or an existing parent standing in another tree |

### `task:inputSources` answers the outputs that fit a slot

`task:inputSources` takes `{slots: [{key, schema}], project?}` and answers `Record<key, InputSourceOption[]>`, newest task first and at most 20 per slot.

| Field | Type | Meaning |
| --- | --- | --- |
| `taskId`, `title`, `status`, `workflow` | strings | the source task |
| `output` | string | the output's name on its root state |
| `preview` | string, optional | the value shortened to 80 characters; absent while `pending` |
| `pending` | boolean | the task has not completed, so a task created from it holds |

A completed task's output is offered when its value validates against the slot's schema with the run's validator; an artifact is offered as its content. A `queued`, `running`, `stopping` or `interrupted` task's declared output is offered when its schema equals the slot's once `description`, `title` and `default` are set aside, or the slot takes anything.

### Stopping and deleting take only the task

`task:cancel` and `task:delete` take `{taskId: string; project?}` and answer `{taskId: string}`. A cancel of a run in this process sets `stopping` and answers; `canceled` is written when the run settles.

### Rewinding and forking take a journal seq

`task:rewind` answers `{taskId}` of the same task. `task:fork` answers `{taskId}` of the copy.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task to cut or copy |
| `at` | number | yes | a `state_machine_events.seq` of that task, as a view was handed it in `ConversationTurn.seq` or `ChatEditPoint.seq` |
| `message` | string | no, `task:fork` only | trimmed; non-empty makes a chat fork that sends it as the copy's next turn |
| `overrides` | `ChatSettings` | no, `task:fork` only | settings for that message |
| `interactions` | `Record<string, JsonValue[]>` | no | scripts the resume that follows |
| `fake` | `JsonValue` | no | scripts the resume or the message that follows |
| `project` | `ProjectRef` | no | as above |

### Module approval reads the refused files and approves them by path

`functions:pending` takes `{taskId: string; project?}` and answers `ModuleApproval[]`, empty unless the task's last start refused with `ApprovalRequired`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `file` | string | yes | absolute path with forward slashes |
| `hash` | string | yes | the file's hash as it reads now |
| `source` | string | yes | the file's source as it reads now |
| `previousHash` | string | no | the hash approved before, present when the file changed since |
| `symbols` | string array | no | the symbols the workflow calls from the file; absent for a file reached only as an import |

`functions:approve` takes `{files: string[]; project?}` and answers `{approved: number}`. Main reads and hashes each file itself, approves it in the machine-wide store, and rebuilds the module pair with the project's workflow search path.

## Every error arrives as a message, and most leave nothing half done

| Condition | Response | Caller does |
| --- | --- | --- |
| `project` names no open project, or is absent with none or several open | `project '<ref>' is not open`, `no project is open`, or `several projects are open, so this call must name one` | name the project |
| An unknown task | `unknown task '<id>'`; `task:resume` says `cannot resume unknown task '<id>'`; a start whose file is gone says `no task file for '<id>' in <dir>` | refresh the list |
| `task:create` binds a branch on the shared root | `a shared task cannot be bound to a branch — the shared root is not a checkout` | drop the branch |
| A start of a task already running in this process | `task '<id>' is already running in this process` | wait, or stop it |
| A start or resume of a holding task | `task '<id>' is waiting for '<title>' (<status>), … to complete` | wait for the dependencies |
| A start of a task whose status cannot start | `task '<id>' is <status>; only queued/interrupted/failed tasks can start` | rerun it |
| A start of a task with journal history | `task '<id>' is <status> and already has history — …Resume it to continue, or re-run it as a new task.` | call `task:resume` or `task:rerun` |
| An unapproved module | the `ApprovalRequired` message listing each file | call `functions:pending`, show the sources, call `functions:approve`, then retry the start |
| The root does not load, or fails validation | the load error with any `unreadable files:`, or `workflow validation failed for '<workflow>':` with each issue | fix the workflow |
| A state whose runtime cannot enforce the policy | `<stateId>: <reason>` joined by `; `, with the task recorded `failed` | fix the state, then resume |
| A model the start-time check cannot serve, a malformed `fake`, or a policy that does not compile | the check's message, after the task was marked `running` | restart the app before trying again |
| `task:resume` of a running, unstartable or never-pinned task | `task '<id>' is already running`, `… is <status> and cannot be resumed — run it again instead`, or `… has no pinned snapshot to resume against — run it instead` | rerun or start it |
| `task:resume` of a history that cannot load | `task '<id>' cannot be resumed: <blocked>`, or `… N operation(s) have no readable record (first: <state> — <reason>). Running it again would repeat them.` | rerun it |
| `task:move` to a state that is not a child of the instance named, or naming an instance the task does not have | `cannot move task '<id>' to '<state>': '<state>' is not a declared child of '<stateId>'` for a running task, `… it is not a state of '<stateId>'` or `… it has no instance '<instanceId>'` for one that is not; nothing is started | pick a state of that level |
| `task:move` of a task another process is running, or one that never ran and names no document | `task '<id>' is <status> in another process — move it there`, or `task '<id>' has never run, so it stands nowhere to be moved from — start it instead` | move it there, or start it |
| `task:connectUndo` of a running task, or of an adoption whose mirror row is gone | `'<title>' is running — stop it before taking the move back`, `task '<id>' is running — …`, or `'<title>' no longer holds the task it adopted — there is nothing to take back` | stop it, or nothing |
| `task:move` of a history that cannot load | `task '<id>' cannot be moved: <blocked>`, or `… N operation(s) have no readable record (first: <state> — <reason>). Reopening it would repeat them.` | rerun it |
| `task:create` names a source task that does not exist, or one that completed without that output | `input '<name>' is taken from task '<id>', which does not exist`, or `… from '<title>', which completed without producing '<output>'` | pick another source |
| A start of a task whose source completed without the output it owed | `task '<id>' takes '<name>' from '<title>', which has not produced '<output>'` | create the task again with another source |
| A resume of a task that adopted one whose outputs no longer fit, or one that has not completed | `task '<id>' cannot continue: what '<title>' produced does not fit the child it was adopted as — <path> <reason>`, or `… cannot be resumed: it adopted '<title>', which has not completed — it continues when that does` | rewind past the mirror row, or wait |
| A rewind, fork or delete of a running task | `task '<id>' is running — stop it before rewinding it`, `… forking it`, or `… cancel it before deleting it` | stop it first |
| A cut the journal cannot take | `has no journal event <seq>`, `nothing in task '<id>' comes after event <seq>`, `… comes before event <seq>`, `has never run, so there is nothing to fork`, `has history in per-run journal files, which a cut cannot address`, or `the journal file holds N events and the table M — refusing to cut a journal that disagrees with its file` | refresh the view, rerun, or reopen the project, as the message says |
| A chat fork whose copy has no instance that spoke | `the fork of '<id>' holds no conversation to continue`, after the copy exists | delete the copy |
| A bound task's worktree cannot be removed | `could not remove the task's worktree: <reason>`, with nothing deleted | fix the worktree |
| `task:rename` with a blank title | `a task needs a title` | give a title |
| `functions:approve` in a process without module support, or on a file it cannot read | `this process has no js/ts function support to approve into`, or `cannot approve '<file>': it could not be read` | fix the path; files before it are already approved |

## A change to a channel breaks the renderer in the same build, and there is no deprecation path

- Channel names live in `IPC_CHANNELS`, which the preload whitelist is built from. The renderer and main ship together, so a change lands in both at once and no older caller exists.
- `primaryAct` in `taskAction.ts` maps `continue` and `retry` to `task:resume`, `fresh` to `task:start`, and anything else to `task:rerun`. A new `kind`, or a change to when one is answered, changes what the button does. `runViews.test.ts` pins the verbs: "says Resume where instances were still live", "says Retry where the run ended and nothing is live", "falls back to the restart verbs when there is nothing to resume", "STARTS a task that recorded nothing, rather than copying one with nothing to copy", "says nothing at all for a run that finished or is still going", "explains a record it cannot read, rather than silently dropping the button".
- `at` is a journal seq, so a change to how seqs are minted or cut breaks every view that hands one over.

## Several answers arrive before the work they name is done, and some refusals leave work behind

- `task:start`, `task:resume` and `task:rerun` resolve once the run is wired. Success says nothing about the outcome.
- `task:rerun` always creates a new task, whatever the status, and answers the new id. When that task's start refuses, it stays `queued` and a retry makes another.
- `task:resume` ignores `overrides`. A start applies them only while no snapshot is pinned and only to a root state with a prompt operation, and then skips `validateBundle`.
- A malformed `fake`, a model the check refuses, or a policy that does not compile refuses after the task is marked `running` and held in `open.live`, so the task stays running in this process and a later stop only reaches `stopping`.
- A start refused by `beginTaskRun` or later has already deleted the task's durable gates and, for a bound task, cut its worktree.
- `task:cancel` of a finished task answers `{taskId}` and changes nothing, where `jaira task cancel` refuses.
- `functions:pending` ignores `project`: the list is keyed by task id alone, set when a `task:start` or `task:rerun` start refuses with `ApprovalRequired`, and cleared when a later start of that task succeeds.
- `task:resumable` and `task:detail` throw for a startable task with history whose snapshot is missing or corrupt, because the plan loads the snapshot without a fallback.
- `task:connect` answers a refusal as data, as `task:adopt` does. A real connect writes in order — the document, its task, the adoption, the move — and a refusal or rejection part-way leaves what was written: the `adopt` refusal of a `new` names the document and the task already made, and a `task:move` that rejects after an adoption leaves the adoption.
- `task:connect` decides whether inputs will bind statically, from the lowered wires and the loaded machine: a wire counts as bound when every child it reads has ended well, and a computed expression that reads nothing is taken to resolve. The engine's own entry is still the judge.
- A `move` undo of a task that had completed restores `completed` and `success` but not the outputs the reopen cleared.
- The `Undo` token lives in the renderer's memory: it does not survive a restart, after which `task:rewind` takes the same thing back.
- `task:adopt` answers a refusal as data and rejects only for a broken installation, an unapproved module included. A real adoption whose parent then refuses to start has already written the parent and the mirror rows.
- `task:rewind` and `task:delete` of a task that adopted others clear those tasks' `origin` and `parentTaskId` where the mirror row is gone.
- `task:resumable` has no renderer caller. The renderer reads the same plan from `task:detail`'s `resume`, present only for a startable task.
- A rewind whose cut leaves no frontier restores the task's status and outcome without resuming, and its outputs are cleared.
- A run fork whose resume refuses rejects the request while the copy stays. A chat fork answers the copy's id before its message is answered; a failed message is only logged.
- A rejection crosses IPC as its message alone, so `ApprovalRequired.pending` is read back through `functions:pending`.
