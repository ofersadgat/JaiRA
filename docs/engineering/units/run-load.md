---
id: engineering/units/run-load
type: engineering-unit
status: shipped
updated: 2026-09-22
implements: [product/pick-up-where-it-left-off, ux/patterns/button-says-what-will-happen]
layer: service
owns_contracts: []
requires: [engineering/units/event-journal, engineering/units/operation-record-store]
implemented_by: [packages/persistence/src/load.ts, packages/persistence/src/hostRows.ts]
verified_by: [packages/persistence/test/load.test.ts, packages/persistence/test/titleResume.test.ts, packages/app/test/load.test.ts, packages/persistence/test/hostRows.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/rewind-and-fork, engineering/units/event-journal, engineering/units/board-projection]
---

# Run load

## The load describes a stopped task for the engine to continue, and never decides whether to continue it

`buildTaskLoad(project, taskId, shape)` in `load.ts` joins the task's journal to its operation records and returns a `TaskLoad`:

- `loaded`, the `LoadedInstance` tree hw continues, folded by durable instance id;
- `answers`, recorded call results looked up by scoped operation id;
- `loadedOps`, the loaded state operations plus the recorded call answers;
- `frontier`, one entry per live leaf with its address, `stopped` as `mid-operation` or `between-children`, and `cause` as `interrupted` or `failed`;
- `unreadable`, each completed operation whose record is missing or holds no readable value;
- `blocked`, why nothing can be loaded.

Two releases run before a resume continues. `releaseUnconsumedFailures` deletes `failed` records with no provider session, which never reached a remote conversation. `releaseRevivedFailures` deletes the failure rows of the instances the load holds live, so the journal stops drawing an ending the retry undoes. `rehydrateArtifactInputs` and `artifactContentOf` fill a content-less artifact ref from the completed record of the instance that produced it. `occurrenceOf` is the occurrence rule the projection shares.

It deliberately does not own:

- Continuing the machine. hw's `WorkflowExecutor.load` does, reached through `executeWorkflow` in [engine-wiring](engine-wiring.md).
- Choosing to resume, the refusals worded from `blocked` and `unreadable`, `ResumePlan`, and taking up an open fast-forward and the held moves beside the load: [task-lifecycle](task-lifecycle.md).
- Storing and ordering the journal: [event-journal](event-journal.md), with the event shapes in [journal-events](../contracts/journal-events.md).
- Record rows, seats, handles and blobs: [operation-record-store](operation-record-store.md).
- Truncating a journal before a resume: [rewind-and-fork](rewind-and-fork.md).
- Folding the same journal for display: [board-projection](board-projection.md).

## The load is a read over two stores in the data package, shaped to an upstream type

- Layer `service`, in `@jaira/persistence`. It reads through `SqliteEventLog.list`, queries `operation_records` and `task_runtime` directly, and hydrates blob references with `hydrate`. It imports `CHAT_INSTANCE_PREFIX` from `@jaira/runtime`.
- Upstream seams: `LoadedInstance` and `CallResult` from `@declarative-ai/hw`, handed to `executeWorkflow` as `loaded` and `answers`. `hashOperation` and `scopedOperationId` from `@declarative-ai/exec` recompute the content key and scoped id the engine minted.
- Boundary: workflow and run. `shape` is the pinned snapshot's states, because the journal records which child entered and only the definition knows its index in a `sequence`.
- Callers: `AppService.resumeTask` and `resumable`, `jaira task start`, and the pending-gate listing in `service.ts` for `rehydrateArtifactInputs`.

## The fold follows nine rules, and each decides what a resume pays for again

1. **By instance id.** A second `instance.entered` for a known id clears its termination and does not advance its parent. A `chat:` instance is skipped with all its events.
2. **One root.** `task_runtime.root_instance_id` wins where stamped; otherwise the newest parentless entry is the machine.
3. **Revival.** Under a live parent, a child is live when it never terminated, or when it ended without success after the parent's last advancement, which is a transition taken or a new child entered. A child that succeeded after that advancement is listed in the parent's `unanswered`. A superseded child is not loaded and still counts toward the next occurrence under its key. The root is live unless it ended with success.
4. **Answers.** Only a `completed` record is an answer. A record whose content key a `call.waiting` named is neither an answer nor a loaded site. Every record's sequence raises its instance's `nextSite`, loaded or not.
5. **Required reads.** A completed operation on a live instance or on one that succeeded must have a readable value, or it lands in `unreadable`. A failed instance's own record is not required.
6. **Fields.** The last `value.settled` per field loads, a fallback's value included; a settle with no value removes the field.
7. **A person's move.** A `transition.taken` carrying `by` was directed ([decision 0005](../decisions/0005-connect.md), [journal-events](../contracts/journal-events.md)). An instance that ended `skipped` is never revived, although its row lands after the transition that decided it. A directed transition on an instance that had terminated clears its termination and every ancestor's, so a reopened task that died loads live. A directed transition with no later entry of its `to` under that instance loads as `LoadedInstance.directed`, the entry the run still owes.
8. **An adopted child.** An `instance.entered` carrying `adopted` is an adoption's mirror ([adoption](adoption.md)): a task that ran alone, standing for this child. It is emitted as history under the stand-in state id `jaira:adopted:<stateId>`, with the `outputs` on its `instance.terminated` row as its operation's value, and is never live and never revived; a success after the parent's last advancement still reads `unanswered`. A mirror with no end yet sets `blocked`, naming the task that has not completed. `withAdoptedStandIns` adds the stand-in state to the bundle a loaded run is handed. An adopted ELEMENT of a batch keeps its `element`, so the engine regroups it with the batch; a `"task"` batch's rows go to the fan-out host as they are. An inline batch whose every element is adopted is folded into ONE row under `jaira:adopted-batch:<stateId>`, its outputs gathered (`inlineBatches`), because the engine loads an inline element under the mounted state, where a per-element stand-in is never consulted (2026-09-22).
9. **The host's own rows are not the machine.** `jaira.fastForward`, `jaira.fastForwardEnded`, `jaira.moveHeld`, `jaira.moveDropped` and `jaira.reopened` ([journal-events](../contracts/journal-events.md)) carry no instance and are skipped by the fold. What a person asked of the task that the stopped process was still carrying out — an open fast-forward, an outstanding held move — is read beside the load, by `restoreHostModes` in `app/main/hostModes.ts` over `hostRows.ts`, and handed to the same start: the mode to the session, the holds to the run's `DirectedTransitions` port, which the loaded engine drains when it attaches and each loaded instance claims as it is built.

A frontier entry is `mid-operation` when its operation started and never settled, or settled as an `interrupted` failure. Its cause is `failed` when the instance ended in `error` or `timeout`.

## The journal and the record store are the truth, and the load is derived per call

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events` of the task | read in `seq` order; `releaseRevivedFailures` deletes, for live instance ids, non-success `instance.terminated`, `operation.failed`, `call.waiting`, `call.settled`, and `value.settled` with no value and no fallback | event-journal: the table, or the file when file-backed | every journal reader; rewind-and-fork cuts it |
| `operation_records` `id`, `status`, `request_json`, `result_json`, `instance_id`, `sequence` | read; `releaseUnconsumedFailures` deletes `failed` rows with a null `provider_session_id` | operation-record-store | the run that continues reopens `interrupted` records |
| `blobs` | read through `hydrate` | the blob store | none |
| `task_runtime.root_instance_id` | read | the row, stamped by migration 16 or mapped by `stampFork` | task-lifecycle |
| `TaskLoad` | returned, never stored | derived | `resumable`, `resumeTask`, `jaira task start` |

## The invariants keep every answered operation answered and every hole reported

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Completed work loads with its value, an entered and unterminated instance is live, and the frontier names it | `persistence/test/load.test.ts` "loads what completed, presents what was cut, and points at the frontier"; `app/test/load.test.ts` "answers every operation a completed run made, and re-enters nothing", "names the live leaf a stopped run would re-enter" |
| 2 | A completed operation whose record cannot be read is reported, never dispatched again in silence | `persistence/test/load.test.ts` "refuses a description with a hole in it, rather than quietly re-dispatching"; `app/test/load.test.ts` "refuses a payload that carries no value rather than guessing one" |
| 3 | A child that finished after its parent's last advancement is owed a round on the live parent | `persistence/test/load.test.ts` "seeds the round a stopped run still owed" |
| 4 | A re-stated entry merges into one tree, and history with several trees resolves to the newest root | `persistence/test/load.test.ts` "merges a re-stated spine into one tree instead of growing a second one", "takes the newest root when history grew several trees" |
| 5 | An unhandled failure is live again, a handled one stays history, and a stop's unwind is revived with its cut call read as `mid-operation` | `persistence/test/load.test.ts` `"presents an unhandled failure live again — a retry with its history intact"`, "leaves a failure a transition handled as history", "revives what a stop unwound, and reads a cut call as mid-operation" |
| 6 | A superseded instance is not loaded and still counts its entry | `persistence/test/load.test.ts` "skips a superseded instance and still counts its entry" |
| 7 | The elements of one fan-out batch share one occurrence and each carries its element | `persistence/test/load.test.ts` "gives the elements of one batch one occurrence, and each its element" |
| 8 | Answers are keyed by scoped identity, and a deferred call is never an answer | `persistence/test/load.test.ts` "rebuilds an instance's sites and answers repeats by scoped identity", `"never answers a deferred call — an event is not a memo"` |
| 9 | An empty journal loads nothing | `persistence/test/load.test.ts` "describes nothing when nothing was recorded" |
| 10 | Only `failed` records with no provider session are freed | `persistence/test/load.test.ts` "deletes failed records with no provider handle, and keeps every witness" |
| 11 | Only live instances lose failure rows, a fallback's settle stays, and nothing is deleted when nothing is live | `persistence/test/load.test.ts` "removes the terminations of the revived chain and the failed call, and keeps handled history", "keeps a fallback's journal row when the retry revives its instance", "touches nothing when nothing is live" |
| 12 | A settled field loads and is not evaluated again, and a field that failed with nothing standing in is left to evaluate | `persistence/test/load.test.ts` "loads the last settled value per field, a fallback's value included, on the instance it settled on", "drops a field whose binding failed with nothing standing in, so the retry evaluates it again"; `titleResume.test.ts` "hands the settled title back as a field, and the continuing run never asks for it again" |
| 13 | A prompt record holding an `LlmOutput` loads its projected value, a function value carrying its own `finishReason` is left whole, and a blob reference loads as its content | `app/test/load.test.ts` "projects the recorded LlmOutput, so a bound output still resolves", "leaves a prompt row that already holds the projected value alone", "does not unwrap a function op whose value carries a finishReason of its own", "hydrates a value the record stored by reference, rather than loading the reference" |
| 14 | A resume of a resumed task keeps what the earlier round answered | `app/test/load.test.ts` "moves the frontier on, keeping what the earlier round answered" |
| 15 | A content-less artifact ref among a gate's inputs is filled from the producing record, and every other input is returned as it was | `persistence/test/load.test.ts` "fills in a content-less ref among a gate's inputs and leaves everything else alone", "answers nothing for a name that does not parse, an unknown instance, or a non-string slot" |
| 16 | A `chat:` instance never enters the loaded tree | unasserted |

## A hole refuses the resume, and a release that outruns its start changes the verb

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A completed operation's record is missing or unreadable | `unreadable` lists it; `resumeTask` refuses, and `resumable` answers `none` with the first reason as `blocked` | rerun as a new task | refusal naming the state; the strip's hint says resuming is unavailable |
| The releases run and the start then refuses, as `resumeTask` does on holding or a git failure and `jaira task start` does on any `beginTaskRun` refusal | the freed records and failure rows stay deleted; the next load reads the failed chain as never terminated, so its cause becomes `interrupted` | none needed: the next resume continues the same chain | the failure note leaves the conversation, and Retry reads Resume |
| The journal or conversations are file-backed | both releases delete table rows only, and the next open replays them from the files | none | the old failure is drawn again beside the retry |
| The process is killed between the two releases | each release is one `DELETE`, and the failure rows stay until the next resume deletes them | resume again | none beyond the resume |
| A killed append cost a journal file its last line | an instance whose settle or end was on that line reads as live | none | that state is entered again on resume |
| An op renders differently on its way out, so its request no longer hashes to the engine's key | its site is absent while `nextSite` stays above it, so the engine mints a fresh site | none | the call is made and paid for again |
| Two resumes of one task run the releases twice | the second deletes nothing, because the first left no handle-less failed record and no failure row on a live instance | none needed | none |
| A chat turn writes to a stopped task between the event query and the record query | its events are skipped as `chat:`, and its records sit on an instance the tree never emits | none needed | none |

## Old journals load unchanged, and nothing here migrates

- Journals written before 2026-09-08 re-state `instance.entered` for the live spine; rule 1 merges them.
- A history holding several parentless trees from in-place restarts loads its newest tree, or the one migration 16 stamped.
- History with counter ids cannot load and is only rerun.
