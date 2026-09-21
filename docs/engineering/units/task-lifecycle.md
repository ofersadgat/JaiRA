---
id: engineering/units/task-lifecycle
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/hand-work-to-agents, product/pick-up-where-it-left-off, product/work-runs-the-process-it-started-with, product/only-approved-code-runs, product/large-work-splits-into-independent-pieces, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/button-says-what-will-happen, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/consent-to-exactly-what-was-shown, ui/components/activity-strip, ui/surfaces/module-approval-dialog]
layer: service
owns_contracts: [engineering/contracts/task-file, engineering/contracts/task-channels]
requires: [engineering/units/workflow-snapshots, engineering/units/module-approvals, engineering/units/workflow-browser, engineering/units/run-load, engineering/units/engine-wiring, engineering/units/fan-out-host, engineering/units/task-worktrees, engineering/units/process-claims, engineering/units/interaction-gateway, engineering/units/interaction-hub, engineering/units/live-turns, engineering/units/event-journal, engineering/units/storage-policy, engineering/units/operation-record-store, engineering/units/model-routing, engineering/units/tool-policy, engineering/units/agent-executors, engineering/units/host-tools, engineering/units/artifact-placement, engineering/units/native-session-capture, engineering/units/scripted-doubles, engineering/units/project-sessions, engineering/units/app-log]
implemented_by: [packages/persistence/src/lifecycle.ts, packages/persistence/src/runtime.ts, packages/persistence/src/taskStore.ts, packages/shared/src/task.ts, packages/app/src/main/service.ts]
verified_by: [packages/persistence/test/lifecycle.test.ts, packages/persistence/test/holding.test.ts, packages/persistence/test/moduleApproval.test.ts, packages/persistence/test/stores.test.ts, packages/persistence/test/rowFile.test.ts, packages/persistence/test/systemProject.test.ts, packages/shared/test/shared.test.ts, packages/app/test/service.test.ts, packages/app/test/resume.test.ts, packages/app/test/eachHosted.test.ts, packages/app/test/gateDurability.test.ts, packages/app/test/taskMove.test.ts]
siblings: [engineering/units/run-load, engineering/units/rewind-and-fork, engineering/units/fan-out-host, engineering/units/task-worktrees, engineering/units/workflow-snapshots]
---

# Task lifecycle

## The lifecycle owns a task's standing from creation to deletion, and leaves the machine, the load and the cut to its neighbours

A task is one state machine under one id. Its half in `@jaira/persistence` keeps the durable bookkeeping; its half in `AppService` sequences a run in the main process.

- `createTask` in `lifecycle.ts` refuses a branch on the shared root and an id that exists, writes the task file, then inserts a `queued` `task_runtime` row.
- `beginTaskRun` refuses an unknown task, a status `isStartableStatus` rejects, a task with journal history unless `continues` is set, and a task holding for a dependency. It then loads the pinned snapshot, else a supplied bundle, else the live workflow files, and pins the hash and sets `running` in one transaction. For a task that names a versioned frozen document the pinned snapshot is the document's latest version (`currentPin` in [workflow-snapshots](workflow-snapshots.md)), and a version that differs from the one the task last ran under is journaled as `workflow.version` in the same transaction. `hasJournalHistory` does not count that row.
- `AppService.startTask` and `startRun` wire and detach one run, and on its end call `finishTaskRun`, publish `run:finished`, settle `taskWaiters` and, when it completed, `releaseDependents`.
- `cancelTaskIn` stops a run here, raises the cross-process cancel flag for a run elsewhere, or records `canceled` for a task nothing runs.
- `resumeTask` continues a stopped task by load, and `resumable` answers the `ResumePlan` the primary action follows.
- `rerunTask` always mints a new task linked by `parentTaskId` and starts it.
- `moveTask` publishes a person's move ([decision 0005](../decisions/0005-connect.md)): it answers the transition waiting on exactly that move, else hands the live run's `DirectedTransitions` port a directed transition, else reopens the task by load with the move queued on a port of its own. `LiveRun.directed` is that port, and `beginTaskRun`'s `reopen` is the one way a `completed` task runs again under its own id.
- `deleteTask` removes the worktree, then every row and file of the task.
- `holdingOf` derives holding from `dependsOn`. `startMadeTask`, `waitForTask` and `releaseDependents` serve the fan-out host.
- `RuntimeStore.recoverInterrupted` marks abandoned `running` tasks `interrupted` at open, and `resumeSuspended` resumes the tasks the last close left waiting on a person.
- `moduleApprovals` keeps the files a start refused on for `functions:pending`, and `functionsApprove` approves and rebuilds the module pair.

The file is [task-file](../contracts/task-file.md); the renderer's verbs are [task-channels](../contracts/task-channels.md).

It deliberately does not own:

- Turning a registry, a prompt executor and a bundle into a run: [engine-wiring](engine-wiring.md). Continuing a loaded machine is upstream `@declarative-ai/hw`.
- Building the load and the two releases that precede it: [run-load](run-load.md).
- Cutting a journal and copying a task: [rewind-and-fork](rewind-and-fork.md).
- Making tasks of fan-out elements: [fan-out-host](fan-out-host.md).
- The worktree a bound task runs in: [task-worktrees](task-worktrees.md). Run claims, heartbeats and the cancel flag: [process-claims](process-claims.md).
- The snapshot format: [workflow-snapshots](workflow-snapshots.md). The approval store and the module freeze: [module-approvals](module-approvals.md).
- Parked gates and their durable rows: [interaction-gateway](interaction-gateway.md). The live tail: [live-turns](live-turns.md). Typed turns: [chat-turns](chat-turns.md). The terminal verbs: [cli](cli.md).

## The lifecycle is service code on the workflow and run boundary, and the only path into a run

- Layer `service`: `lifecycle.ts`, `runtime.ts` and `taskStore.ts` sequence stores in the data package, and `AppService` in `packages/app/src/main/service.ts` answers the IPC handlers in `index.ts`. The CLI calls `createTask`, `beginTaskRun` and `cancelTask` directly.
- Boundary: workflow and run. `beginTaskRun` pins `snapshot_hash`, and every later start of the task reads that snapshot.
- Boundary: renderer and main. `functionsApprove` re-reads and hashes each file in main and accepts no hash from the renderer.
- Upstream seams: `loadBundle` and `validateBundle` from `@declarative-ai/hw` at a first start; `executeWorkflow` with `loaded` and `answers`, which reaches hw's `WorkflowExecutor.load`; the persistence port through the task's recorder, teed to `engine:event`.

## A start runs its refusals in a fixed order, and where one lands decides what it leaves behind

1. `open.live` already holds the task: refused.
2. `holdingOf` names an unfinished dependency: refused before anything is made.
3. `ensureWorkspace` materializes the worktree.
4. The registry is built, and `interactions.clearTask` deletes the task's durable gates.
5. `beginTaskRun` refuses or pins, with `continues` set when a load is supplied.
6. `resolveUserFunctions`, file, search and web tools, then `gateCapabilities`; an issue records the task `failed` and refuses.
7. `open.live.set` and the `RunOwner` claim.
8. Hub registration, `parseFakeRules`, `buildPromptExecutor` with the start-time model check in `defaultTree`, the turn stream, session services and `compilePolicy`; `approvals.allow` reopens the approval gate.
9. The request resolves. Detached, `prepareUserFunctions` and `executeWorkflow` run; a throw inside records `failed`; `finally` releases the claim and deletes `open.live`.

## The task file holds what a task is, and its runtime row holds how it stands

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `system/tasks/<taskId>.json` as `TaskMeta` | written by `createTask` and `renameTask`; read by every summary and start | the file | the fan-out host rewrites a split task's `title`, `split` and `dependsOn`; people editing by hand |
| `task_runtime`: `status`, `snapshot_hash`, `started_at`, `ended_at`, `outcome`, `outputs_json`, `failure_json`, `parent_task_id`, `root_instance_id` | inserted by `createTask`; `beginTask`, `setStatus`, `endTask` and `recoverInterrupted` | the table, or the `taskRows` file when `storage.tasks` is file-backed | `markCut` and `stampFork` from rewind-and-fork; `setWorktree` from task-worktrees; views |
| Holding | derived by `holdingOf` from `dependsOn` and each dependency's status | never stored | board filing, `dependencyBaseOf`, `TaskSummary.waitingFor` |
| `operation_records` left `open` | settled `interrupted` by `recoverInterrupted`, keeping `result_json` | operation-record-store | native capture recovery |
| A deleted task's rows | `deleteTask` removes `state_machine_events`, `command_log`, `job_output`, `jobs`, `operation_records`, `session_names`, `artifacts`, `pending_interactions`, `task_runtime`, then file-backed journal, conversation and row files, then the task file | the stores named | history-pruning trims ended tasks without deleting them |
| `AppService.moduleApprovals` | set when a start throws `ApprovalRequired`; deleted when a start succeeds | memory, by task id | none |
| `ProjectSession.live` and `AppService.taskWaiters` | set at step 7 and by `waitForTask`; cleared in the run's `finally` and end handler | memory | rewind, fork, delete and chat read `live`; the fan-out host waits |

## The invariants keep one machine per task and never start a task over its own history

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A start pins a snapshot, and a later start of the task runs that snapshot whatever the files say | `lifecycle.test.ts` "create → start → finish, snapshotting the workflow at start", "re-runs an interrupted task from the pinned snapshot, even after workflow edits" |
| 2 | A start that fails validation or names an unknown workflow leaves the task `queued` with nothing pinned | `lifecycle.test.ts` "enforces validation at task start and leaves the task queued on failure", "rejects duplicate ids and unknown workflows" |
| 3 | An unreadable state file outside the root's closure does not block a start, and the files are named when the root fails to load | `lifecycle.test.ts` "starts despite an unrelated half-saved state file", "names the unreadable files when the workflow itself will not load" |
| 4 | An unapproved module refuses the start with `ApprovalRequired` before anything is pinned, and the start succeeds once approved | `moduleApproval.test.ts` "raises an answerable refusal naming the file and the symbol, not a parse error", `"leaves the task startable — the refusal comes before anything is pinned"`, "starts once the file is approved, so the answer is all that was missing" |
| 5 | A task with journal history never starts without continuing its recorded machine | `eachHosted.test.ts` "refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history" |
| 6 | A holding task is refused a start naming each unfinished dependency and its status, and a dependency that no longer exists is not waited for | `holding.test.ts` "names every dependency that has not completed, with its standing, and skips one that is gone", "is what beginTaskRun refuses on, with the names" |
| 7 | A second start of a task running in this process is refused | `service.test.ts` "refuses to start the same task twice concurrently" |
| 8 | A failed task stays startable, and resuming it retries under the same id | `service.test.ts` "records a failed run and leaves the task retryable" |
| 9 | A resume does not ask a gate that was already answered | `resume.test.ts` "continues from the frontier and does not put an answered gate again" |
| 10 | `ResumePlan.kind` is `fresh` without journal history, `continue` when a live leaf was interrupted and `retry` when every live leaf failed, and a stopped task's plan keeps what it finished | `resume.test.ts` `"says a task that never ran simply STARTS — there is nothing to resume and nothing to copy"`, "says a task whose start died before it journaled anything starts IN PLACE", `"calls a failed task a RETRY — nothing is live to continue"`, "offers a real plan, not the fallback, when the second call failed", "gives a STOPPED task a plan, keeping what it finished before someone pressed stop"; `eachHosted.test.ts` "refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history" |
| 11 | A resume of a completed task is refused and logged as a warning | `resume.test.ts` "refuses to resume a completed task, and says so in the log as a WARNING" |
| 12 | A rerun is a new task pointing back through `parentTaskId`, and the original is untouched | `service.test.ts` "reruns a failed task as a NEW task, chained to its predecessor", "reruns a completed task as a fresh copy, since a finished lifecycle cannot restart" |
| 13 | Stopping a run parked on a gate rejects the gate, so the run ends | `service.test.ts` "canceling a parked run fails the gate rather than hanging" |
| 14 | A cancel of a task nothing runs records `canceled`, and `canceled` is startable | `service.test.ts` "records a terminal canceled status for a queued task"; `lifecycle.test.ts` `"cancel settles the run and closes dangling ones — and leaves the task resumable"`; `shared.test.ts` "classifies terminal and startable statuses" |
| 15 | Delete refuses a running task and an unknown id, and removes everything of any other task, `interrupted` included | `lifecycle.test.ts` "deletes a finished task: rows, journal, jobs, artifacts, and the JSON file", "refuses to delete a running task, and leaves it intact", `"deletes an interrupted task — pruning protects it, deleting is the user declining to resume"`, "delete is an error for an unknown task"; `service.test.ts` "refuses to delete a running task, then deletes it once it has finished", "delete of an unknown task says so" |
| 16 | A task on the shared root is never bound to a branch | `systemProject.test.ts` "refuses a task bound to a branch, which is how its runs stay out of worktrees" |
| 17 | A task file whose `id` differs from its file name does not parse | `shared.test.ts` "accepts a valid meta and enforces the id/file-name match" |
| 18 | Recovery at open marks every unclaimed `running` task `interrupted`, settles its `open` records `interrupted` with their partials, and a file-backed row records it | `stores.test.ts` "recovery marks running tasks interrupted and closes their dangling runs", "recovery settles the crashed task's open records, keeping their streamed partials"; `rowFile.test.ts` "records the interruption recovery does at OPEN, or a crashed task never settles" |
| 19 | A task the app closed while it waited on a person runs again at the next open and asks the same question | `gateDurability.test.ts` "records WHY the close ended the run, so the open knows to resume it", "is being asked again when the app opens, by a run that is running again" |
| 20 | A completed task starts every task that held only for it, except a split copy whose `start` is `manual` | `eachHosted.test.ts` "starts a copy that holds for nothing at once, and a dependent the moment its dependency completes", "refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history" |
| 21 | An approval records the hash of the file as main reads it at approval time | unasserted |
| 22 | A move published to a running task is held until its running state ends, is journaled `transition.taken` with `by`, and records what it stepped over `skipped`; with `skip` the running state's gate is withdrawn and the state ends `skipped` | `taskMove.test.ts` "is held while the state it is in runs, taken when that state ends, and journaled with who asked", "with SKIP, interrupts the running state: its gate is withdrawn, and it and what was stepped over end skipped" |
| 23 | A move a `standing` rule was waiting on answers that rule, and a standing rule nobody answers neither parks the sequence nor holds the task open | `taskMove.test.ts` "answers the transition that was waiting on exactly this move, and the workflow's own rule moves the task", "a standing rule nobody answers changes nothing: the task runs as written and finishes" |
| 24 | A finished task takes a move by being reopened under its own id, while a plain resume of it stays refused; a stopped task reopened to take one does not ask its stopped state's question again | `taskMove.test.ts` "reopens a FINISHED task to take it, under its own id — and a plain resume of it is still refused", "reopens a STOPPED task past the state it stopped in, without asking that state's question again" |
| 25 | A task that dies mid-skip resumes in the skip's target with what it stepped over still `skipped`, and makes the entry the skip still owed when the target never entered | `taskMove.test.ts` "resumes in the state the skip went to, with what it stepped over still skipped", "makes the entry the skip still OWED when the process died before the target entered" |

## A refusal after the task is marked running strands it until the app restarts

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process dies between the task file write and the row insert | the file has no row, and lists walk rows | none needed | nothing appears |
| The process dies mid write of a task file | `writeFileSync` leaves truncated JSON, and `taskSummaries` throws for the whole project | repair or delete the file | every task list and board of the project fails |
| Any task file in the project does not parse when a run completes | `releaseDependents` reads every file through `TaskFileStore.list`, throws inside the run's `try`, and the catch records the completed task `failed` | repair the file, then resume | a finished task reads failed |
| Two starts of one task race in one process | `open.live` is set only after `ensureWorkspace` and `beginTaskRun` await, and `beginTaskRun` reads the status before its `running` transaction, so both can pass | none | two runs journal into one task |
| Another process drives the task | `beginTaskRun` refuses its `running` status | stop it there | refusal naming the status |
| `ensureWorkspace` fails | the error is thrown before `beginTaskRun` | fix git and start again | the task stays startable |
| A start is refused at step 5 or later | the task's durable gates are already deleted, and a bound task's worktree already exists | none for the gates | a parked question leaves the inbox |
| `resolveUserFunctions`, `parseFakeRules`, the model check or `compilePolicy` throws | the error escapes outside the run's `try`; the row stays `running`, and past step 7 the task stays in `open.live` with its claim beating, so Stop sets `stopping` and aborts a controller nothing listens to | restart the app: recovery marks a `running` row `interrupted`, and Force stop settles a `stopping` one | task stuck running or stopping |
| `gateCapabilities` finds a runtime that cannot enforce the policy | `finishTaskRun` records `failed`, and the start refuses | fix the state, then resume | failed with the reason |
| The process dies mid-run | the next open marks the task `interrupted` once its claim is stale | Resume | Resume offered |
| The app reopens inside the claim's stale window after a crash | `recoverInterrupted` sees a fresh heartbeat and leaves the task `running`; Stop raises a cancel flag nothing polls | Stop again after the window, or reopen the project | running with nothing running |
| The process dies while a task is `stopping` | recovery sweeps only `running` | Force stop, which records `canceled` because nothing is live | Stopping with Force stop |
| A task running in another process is stopped | `requestCancel` sets the flag its owner's heartbeat polls | none needed | stopping, then canceled |
| The process dies between the copy and the start in `rerunTask`, or the copy's start refuses | the copy stays `queued`, and a retried rerun mints another | start or delete the copies | extra queued tasks |
| The process dies while a move is held for a running state | the hold is in the engine's memory, so the move is gone; the journal holds no row for it | publish the move again after resuming | the task resumes in the state it was in |
| A move reaches a run after its engine let go and before the run settled | the port keeps it, and the run-end handler publishes it again when the run completed, which reopens the task | none needed | the task finishes, then reopens at the target |
| A `skip` interrupts a state whose agent has a tool approval or a question parked | the agent's call is aborted and the state ends `skipped`, but only a gate withdraws itself on a skip; the approval or question stays on the inbox until answered or the task is stopped | answer or dismiss it | a stale inbox entry for a state nobody is in |
| A stopped task takes a typed turn that needs approval | `approvals.stop` holds until the next `startRun` calls `allow`, and chat turns never call it | resume the task or restart the app | each approval in the turn is denied unasked |

## The runtime row absorbed the runs table, and neither migration rolls back

- Migration 16 folded the last run's `started_at`, `ended_at`, `outcome`, `outputs_json` and `failure_json` into `task_runtime`, added `parent_task_id`, stamped `root_instance_id`, and dropped `run_id` from every table. Migration 17 added `forked_at_seq` and `fork_boundary_seq`. Neither rolls back; the schema is [sqlite-schema](../contracts/sqlite-schema.md).
- `origin`, `split` and `dependsOn` are optional in the task file, and `parseTaskMeta` checks only `id`, `title`, `workflow` and `createdAt`, so older files parse unchanged.

## Resume loads rather than re-runs, and a rerun is always a new task

- A task with journal history is refused a plain start and continues by load, where architecture.md describes an interrupted run re-running against its pin, because a fresh walk would continue its old remote conversations with their whole transcript as preamble.
- A rerun mints a new task even for a startable one, so one journal holds one machine.
- A start carrying `overrides` pins a bundle built in memory and skips `validateBundle`, because a supplied bundle was never in the directory validation reads against.
