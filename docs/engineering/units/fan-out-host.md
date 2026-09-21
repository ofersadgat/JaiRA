---
id: engineering/units/fan-out-host
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/large-work-splits-into-independent-pieces, ux/patterns/nested-under-what-caused-it]
layer: service
owns_contracts: [engineering/contracts/fan-out-host-answers]
requires: [engineering/units/event-journal, engineering/units/task-lifecycle, engineering/units/rewind-and-fork, engineering/units/task-worktrees, engineering/units/app-log]
implemented_by: [packages/app/src/main/fanOut.ts]
verified_by: [packages/app/test/eachHosted.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/board-projection, engineering/units/run-load, engineering/units/adoption]
---

# Fan-out host

## The host makes a task of each hosted fan-out element and records the batch before it makes anything

`fanOutHostFor(deps)` in `fanOut.ts` returns the host for one parent run. The engine calls it for a mount whose wire says `each: "task"` or `each: "split"`, and it:

- writes one `fanout.made` row into the parent's journal before any task exists, so a copy cut afterwards carries the row and a host asked again finds the ids it chose;
- for `"split"`, keeps element 0 in the task that split and cuts a queued copy of that task per other element, each standing at the mount with its element as its own;
- for `"task"`, creates a fresh task per element rooted at the mounted state, mirrors each into the parent's journal, runs the tasks and waits for them;
- holds the task that split, in this process, for whatever its own element requires;
- answers the engine with what became of the elements. The answers and what each makes are [fan-out-host-answers](../contracts/fan-out-host-answers.md).

It deliberately does not own:

- Resolving elements, `combineElements`, running a one-element split inline and narrowing a split task's later mounts. Those are upstream `@declarative-ai/hw`.
- Creating a task, the start refusals and holding as a derived fact through `holdingOf`: [task-lifecycle](task-lifecycle.md). Cutting a copy of a task's journal: [rewind-and-fork](rewind-and-fork.md).
- Starting, waiting for and cancelling tasks, and starting dependents when a task completes. `startMadeTask`, `waitForTask`, `cancelTaskIn` and `releaseDependents` belong to [task-lifecycle](task-lifecycle.md) and reach the host as `FanOutDeps` callbacks.
- A copy's worktree and the branch it is based on: [task-worktrees](task-worktrees.md).
- The line at the mount, lanes and filing on the board: [board-projection](board-projection.md).
- Mirror rows written AFTER the fact, for a task that ran alone and was never an element: [adoption](adoption.md). It reuses this unit's rows and none of its code. An adoption's rows sit under a plain mount, which has no host to be asked about on resume, so they carry `adopted: true` and the task's `outputs`, and the load answers for them through a stand-in state. The host is never asked about an adopted child, and refuses nothing about one: `existingOf` and `recordedRuns` match on `origin.kind` and on `fanout.made`, and an adoption has neither.

## The host is main-process service code behind the engine's fan-out seam, and only the app wires it

- Layer `service`, in `packages/app/src/main`. It calls `@jaira/persistence` for `createTask`, `forkTask` imported as `copyTaskPrefix`, `gitFor`, the task store and the journal, and otherwise only its `FanOutDeps` callbacks.
- Upstream seam: `EngineConfig.fanOut` of type `FanOutHost`, which takes a `FanOutRequest` and resolves a `FanOutOutcome`, and `EngineConfig.split`, a list of `SplitEntry {expr, index}`, both in `@declarative-ai/hw` `engine.ts`. `startRun` in `service.ts` builds one host per parent run and passes the task's `split` entries beside it.
- Boundary: project and worktree. A split copy is bound to its own branch, `<parent branch>/<segment>` or `<segment>` where the segment comes from the element id, only when the project directory is a git checkout; otherwise it is unbound.
- The CLI passes neither `fanOut` nor `split` to `executeWorkflow`, so a hosted mount run by `jaira` fails with the engine's reason that it has no host.

## The batch record lives in the parent's journal and the provenance lives in each made task's file

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `fanout.made` row `{instanceId, stateId, childKey, occurrence, kind, runs: [{element, id, runId, title}]}` | written once per mount occurrence, before anything is made; read back by `recordedRuns` | the parent's journal, copied into every split copy's journal | `conversation.ts` draws the line at the mount from it |
| Made task meta `origin`, `split`, `dependsOn`, `branch`, `parentTaskId`, `title` | written through `createTask` or `copyTaskPrefix`; the task that split rewrites its own `split`, `title` and `dependsOn` once | `.jaira/system/tasks/<taskId>.json` | `existingOf` finds a made task by `origin`; `holdingOf`, `releaseDependents`, the start refusal and board filing read the rest |
| Mirrored `instance.entered` and `instance.terminated` whose instance id is the task id, for `"task"` mounts only | appended to the parent's journal | the parent's journal | the engine hands them back as `request.loaded` when the parent resumes; [adoption](adoption.md) writes the same two rows, marked `adopted`, under a plain mount |
| A copy's `instance.entered` at the mount, as element 0 with the element's inputs | appended to each split copy's journal after the copy is cut | the copy's journal | the copy's resume loads it and dispatches from the mount |

## The invariants keep one batch per mount and never start a task that still holds

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The task that split continues with element 0 and is retitled by it, every other element stands as a queued copy, and every task in the batch carries the same `fanout.made` row | `eachHosted.test.ts` "continues here with element 0, retitled by it, and leaves a queued copy per other element sharing one record at the mount" |
| 2 | Under `start: "manual"` no copy is started, by the host or by a dependency completing | `eachHosted.test.ts` "refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history" |
| 3 | Under the default `when_ready` a copy that holds for nothing starts at once, and a copy that holds starts when its last dependency completes | `eachHosted.test.ts` "starts a copy that holds for nothing at once, and a dependent the moment its dependency completes" |
| 4 | The task that split does not go past the mount while a task its own element requires has not completed | `eachHosted.test.ts` "holds the task that split when ITS element requires another, and goes on once that copy completes" |
| 5 | A copy resumes at the mount with the parent's history and runs the mount once, with its own element | `eachHosted.test.ts` "refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history" |
| 6 | An `each: "task"` mount makes one task per element under the parent, mirrors each as an instance whose id is the task id, and answers with the tasks' outputs gathered | `eachHosted.test.ts` "makes a task per element, waits for them in order, and reads their outputs back gathered" |
| 7 | A host asked again for the same key and occurrence makes no second task for an element it recorded or made | unasserted |
| 8 | Duplicate element ids, a `requires` naming an id outside the batch and a `requires` cycle are refused before anything is made | unasserted |
| 9 | A throw inside the host never rejects into the engine and always becomes an `error` answer | unasserted |

## Every failure leaves what was made in place, and resuming the parent asks the host again from its rows

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process dies after `fanout.made` and before every copy or task exists | a host asked again reads the recorded ids, finds made tasks by `origin`, and makes only the missing ones | resume the parent | the missing tasks appear |
| The process dies after a split copy's task row exists and before its `instance.entered` at the mount is appended | a host asked again skips the copy because its row exists, so the copy never gets the line that stands it at the mount | none | the copy does not resume at the mount |
| The process dies in a `"task"` batch after a task is created and before it is mirrored | `existingOf` finds the task by `origin` and the host mirrors it then | resume the parent | none beyond the resume |
| A dependency or element task ends in another process, such as a `jaira` run | `waitForTask` is settled only by this process's run-end handler, and `releaseDependents` does not run | stop and resume the parent; start a released copy by hand | the parent keeps waiting and a released copy stays queued |
| Starting a made task is refused, or a batch check fails | the host logs `child '<key>' (each: "<kind>") failed: <reason>` and answers `error` with reason `child '<key>': <reason>`; what was already made stays | fix the cause and resume the parent | the mount fails with that reason |
| A task the split's own element requires ends other than completed | the host answers `error` with `element '<id>' waits for '<title>', which ended <status>` | resume the parent once that task completes | the mount fails with that reason |
| A sequential `"task"` batch meets an element that does not succeed | the later element tasks exist, stay queued and are not started; the host answers with `combineElements` over the ends so far | fix the element and resume the parent | later element tasks read queued |
| The parent is stopped while it waits | a `"task"` mount cancels each element task it was waiting on and mirrors that task's end as its row reads at that moment; a holding split answers `canceled` and leaves the task it held for running | resume the parent | the parent and its element tasks stop |
| A scripted parent makes tasks that reach a gate | made and released tasks get the parent's `fake` rules but not its `interactions` script | answer the gate by hand | the made task waits on a person |
| Two writers reach one journal | cannot occur: the host writes only while the engine awaits it, and `async` elements append their mirror rows from one thread | none needed | none |

## The host departs from durable queues by waiting in memory and from its own field name

- A wait for a made task lives in memory, in `AppService.taskWaiters`, rather than in a durable row, because the `fanout.made` row, the mirrored rows and each task's `origin` are enough for a resumed parent to ask the host again.
- `fanout.made.runs[].runId` holds a task id. The name is upstream's type, kept from before runs collapsed into tasks.
