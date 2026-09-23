---
id: engineering/units/interaction-gateway
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/everything-waiting-on-you-together, product/decisions-stay-yours, product/pick-up-where-it-left-off, ux/patterns/waiting-requests-gathered, ux/patterns/park-and-ask]
layer: service
owns_contracts: [engineering/contracts/inbox-channels]
requires: [engineering/units/interaction-hub, engineering/units/component-contracts, engineering/units/task-lifecycle, engineering/units/run-load, engineering/units/executor-tree, engineering/units/engine-wiring, engineering/units/scripted-doubles, engineering/units/project-sessions, engineering/units/app-log]
implemented_by: [packages/app/src/main/service.ts, packages/app/src/main/fastForward.ts, packages/persistence/src/interactions.ts]
verified_by: [packages/app/test/service.test.ts, packages/app/test/gateDurability.test.ts, packages/app/test/artifactGateReload.test.ts, packages/app/test/followUp.test.ts, packages/app/test/fastForward.test.ts]
siblings: [engineering/units/interaction-hub, engineering/units/component-contracts, engineering/units/task-lifecycle, engineering/units/ipc-bridge]
---

# Interaction gateway

## The gateway makes every hub request answerable from any open project, and keeps a gate's question across a quit

`AppService` in `service.ts`:

- builds one set of hubs per project session in `hubsFor(key)`, with one id counter per channel for the whole process, and records each request's session in `requestOwner`, so an answer is routed by its request id alone;
- publishes `interaction:requested`, `approval:requested`, `question:requested`, `userEvent:requested` and the matching `resolved` pushes, whose timing is [push-messages](../contracts/push-messages.md);
- writes a gate that names a task into `pending_interactions` through `InteractionStore.open` before publishing it, and deletes the row only when the hub reports `settled`;
- stamps a gate in `pendingOf` with its task, with `about` for a `review_artifacts` gate parked by a changeset review task, with `subjectProject` from `ProjectSession.subjectProject`, and in `withContract` with its parsed `config` or its `configError`;
- re-validates a gate answer in `submitInteraction` with `validateComponentResult`, against the live park's config and inputs or else the stored row's;
- lists in `pendingInteractions` the live gates of every session, then the stored rows of tasks not running in this process, marked `resumes: true` with artifact references filled by `rehydrateArtifactInputs`; the live copy wins a shared id;
- answers a stored gate in `answerRecoveredInteraction`: seeds the value on the hub, closes the row, publishes `interaction:resolved` and calls `resumeTask` without awaiting it;
- runs the follow-up loop for a `choose_option` whose state says `follow_up` beside `questions`;
- offers a gate or an agent's question to a task's controlling conversation while the task is being FAST-FORWARDED ([decision 0005](../decisions/0005-connect.md) §4): `offerToControl` is called from `publishInteraction` and the question hub's `onRequest` — never the approval hub's — and skips a gate whose component is not in `ANSWERABLE_COMPONENTS`; `autopilotAnswer` makes one prompt call outside any run, as the follow-up loop does, and hands an answer at or above `autopilot.askBelow` to the workflow host's `answer`, which checks it against the contract before it journals `jaira.answered`, then submits it;
- withdraws what a skip's interrupted agent parked (`withdrawSkipped`, fed by `SkipWithdrawals` over each run's journal): every question and approval whose `instanceId` — which the engine stamps on each request — is the skipped instance or one entered under it is dismissed or denied once; an `async` sibling's asks stay parked.

The follow-up loop, in `followUp` and `askFollowUp`, holds the park, then:

1. settles with `settledFollowUp(answers)` when `roundOf(inputs)` has reached `MAX_FOLLOW_UP_ROUNDS`;
2. otherwise makes one prompt call through `buildPromptExecutor` over `defaultTree` with refusal off, the task's `fakeRules` and `followUpServices()`, which is a validator and nothing else;
3. settles when the call returns no questions, reparks with `nextRoundInputs` when it returns some, which parks a new request and writes a new row, and on a thrown call logs `follow-up questions could not be asked; the answers given stand: <reason>` at `warn` and settles.

It deliberately does not own:

- Parking, seeding, holding and each channel's unattended answer: [interaction-hub](interaction-hub.md).
- Parsing configs and the answer rules: [component-contracts](component-contracts.md), for the contract [gate-components](../contracts/gate-components.md).
- Registering gates at run start, clearing a task's rows there and on a stop with no live run, and deleting a task: [task-lifecycle](task-lifecycle.md). Clearing rows on rewind: [rewind-and-fork](rewind-and-fork.md).
- The channel table and the preload whitelist: [ipc-bridge](ipc-bridge.md). The `command_log` rows of policy decisions: [tool-policy](tool-policy.md).

## The gateway is main-process service code between the IPC handlers and the hubs

- Layer `service`, `packages/app/src/main`, with its table in `@jaira/persistence` `interactions.ts`. It calls the hubs, `parseComponentConfig` and `validateComponentResult` from `@jaira/shared`, `InteractionStore` and `rehydrateArtifactInputs` from `@jaira/persistence`, `resumeTask`, and `buildPromptExecutor` and the follow-up helpers from `@jaira/runtime`.
- Boundary: renderer and main. `index.ts` hands each of the four submit channels' requests over unchecked; the check in `submitInteraction` is the trust-boundary check for gate answers, and the other three channels have none.
- Upstream seam: none of its own. It reaches the engine only through the hubs.

## The table holds a gate while a person owes it an answer, and memory holds everything else

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `pending_interactions`: `request_id` primary key, `task_id`, `component`, `inputs_json`, `about`, `subject_project`, `created_at` | upserted by `publishInteraction`; deleted on a `settled` report and by `answerRecoveredInteraction`; read by `pendingInteractions`, `configOf`, `findStoredInteraction` | the project database; not a storage concern, so never mirrored to files | `startRun` and `cancelTaskIn` call `clearTask`; `rewindTask` in `cut.ts` calls `clearTask`; `deleteTask` deletes the task's rows |
| `requestOwner`, request id to session key | set on every request; deleted on resolve and by `closeSession` | this process | none |
| `ProjectSession.requestTask`, request id to task id | set by `publishInteraction`; deleted on resolve | this process | `cancelTaskIn` and `rewindTask` reject a task's gates through it |
| `ProjectSession.subjectProject` and `fakeRules` | read here | this process | `reviewChanges` and `reviewSyncChangeset` write `subjectProject`; `startRun` writes `fakeRules` |

## The invariants keep one live question per gate, checked in main, and never lost to a graceful quit

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A parked gate is listed with its task and pushed as requested, and its task reads `waiting_for_user` until a valid answer completes it and resolved is pushed | `service.test.ts` "parks on the gate, shows it as pending, and completes once the UI answers" |
| 2 | An answer to an unknown id is refused | `service.test.ts` "rejects an unknown interaction id" |
| 3 | An answer outside the component's contract is refused and the gate stays parked | `service.test.ts` "refuses an out-of-contract answer, and the gate stays open for a valid one" |
| 4 | The renderer receives the contract parsed in main | `service.test.ts` "hands the renderer a parsed component contract" |
| 5 | Stopping a task settles its parked gate, and closing the project leaves no live park | `service.test.ts` "canceling a parked run fails the gate rather than hanging", "closing the project releases parked gates" |
| 6 | A gate parked at a graceful close is asked again by the resumed run after reopen, as one question, and answering it continues the task | `gateDurability.test.ts` "is being asked again when the app opens, by a run that is running again", "re-parks ONE question, not the dead process's row beside the live one", "continues the task when the re-parked gate is answered" |
| 7 | A re-parked gate is held to the contract a live one is held to, and stopping the task forgets it | `gateDurability.test.ts` "holds a re-parked gate to the same contract a live one is held to", "forgets the re-parked gate when the task is stopped" |
| 8 | A review gate's document reads as the document before and after a reopen, never as the bare reference | `artifactGateReload.test.ts` "is the document both times, never the bare reference" |
| 9 | An answered follow-up round leaves the list at once, the model's questions park under a new id with the answered round's row gone, and the next state receives every round's answers as one `{answers}` | `followUp.test.ts` "asks the model, parks the follow-ups as a second round, and hands the next state every round's answers" |
| 10 | A chooser whose state does not say `follow_up` settles on the answer, and a failed follow-up call settles with the answers given | `followUp.test.ts` "settles on the click when the state did not ask for follow-ups, with only that round's answers", "settles with the answers given when the model cannot be asked" |
| 11 | Answering a stored gate seeds the answer, closes its row and resumes the task, which does not ask that gate again | unasserted |
| 12 | The loop settles without calling the model once round five is answered | unasserted |
| 13 | An approval, question or user-event answer reaches only the session that raised the request | unasserted |
| 14 | A fast-forward's conversation answers what is at or above `autopilot.askBelow`, each answer marked `settled_by: control` with its confidence, and leaves the rest to the person as it would have been | `fastForward.test.ts` "answers the questions for you, marks each with its confidence, never offers the approval, and ends on arrival", "leaves a question to the person below autopilot.askBelow — a platform setting, very low by default" |
| 15 | A fast-forward ends on arrival and on a failure on the way, and the target's own question is the person's | `fastForward.test.ts` "answers the questions for you…", "ends when something on the way FAILS, and says nothing more for the person" |
| 16 | An answer the conversation gave survives a restart as the gate's mark, and the resumed run does not ask that gate again | `fastForward.test.ts` "keeps settled_by across a restart, and the resumed run does not ask the answered gates again" |

## A quit keeps the question, but a crash, a colliding id or a second process can lose or misroute it

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed while a gate is parked | the row stays, since it was written in one statement before the request was published; recovery marks the task `interrupted` and nothing resumes it | the row lists with `resumes: true`, and answering it seeds and resumes the task | the gate, whose answer continues the task |
| The app closes while a gate or a wait is parked | `ProjectSession.close` marks the task suspended, abandons gates so rows stay, denies approvals, dismisses questions and declines waits; the run ends `canceled` with `SUSPENDED_WAITING` | `resumeSuspended` at the next open resumes the task, and it re-parks | the same question, live again |
| The app closes while a follow-up model call runs | a held round is on no list, so the task is not marked suspended and ends plainly `canceled`, with no row | resume the task by hand | a stopped task and no question |
| The app closes on round two or later | the resumed run's start clears the task's rows and the state re-parks its first round | none | the questions start again from round one |
| A resumed task re-reaches a gate its earlier process left a row for | `startRun` clears the task's rows before the run parks its own request | none needed | one question |
| A resume started by answering a stored gate refuses | the row is already closed; the seed is dropped and `answering <component> could not continue <taskId>: <reason>` is logged at `error` | none: the answer is lost | the gate disappears and the task stays stopped |
| A request id minted in this process equals a stored row's id | ids restart at `ui-1` in every process and `open` upserts on `request_id`: a live park in the same project overwrites the stored row, and in another project the stored row is hidden and an answer to that id reaches the live park | none | an earlier process's question vanishes, or its answer lands on another gate |
| A second process has the project open | each process lists the other's parked gates as stored rows; answering one there closes the row and the resume refuses a task that is running | answer it in the process that parked it | the gate disappears in one window and stays parked, rowless, in the other |
| A task is stopped while its follow-up model call runs | `hold` already removed the request from `requestTask`, so `cancelTaskIn` misses it, and the call has no abort signal; its reply reparks a new gate with a row | answer it, which clears it | a question on a stopped task |
| A gate's config does not parse, or its function is not a built-in component | `configOf` returns nothing, so no main-side check runs | the engine's output schema check is the only one | the gate shows the config error, and any value is accepted |
| A stored row's `inputs_json` does not parse | the row reads as `{}`, so its contract usually fails to parse and the answer is unchecked | none | the gate shows a config error |
| The same gate is answered twice | the second finds no park and no row | none needed | the error notice `no pending interaction '<id>'` |
| A person answers an approval | `onResolved` writes a `command_log` row only for a request in `ProjectSession.approvalRun`, which nothing fills | none | the command log shows the policy's escalation as `allowed` and nothing after it |
| The app closes during a fast-forward | the mode is in memory and goes with the process; the task resumes as any suspended task does, and its questions are the person's | move it forward again | the strip's ordinary form, no Skip |
| The fast-forward's model call fails or returns nothing usable | the question is left to the person and counted as left | none needed | the question, unmarked |

## The table was created by migration 11 and lost its run column in migration 16

- Migration 11 created `pending_interactions`; migration 16 dropped its `run_id`. Neither rolls back.
- A row parked before loaded inputs were rehydrated holds an artifact as `{artifact: true, name}`. `pendingOfStored` fills the content from the record store on every read and never rewrites the row.

## The follow-up call is bounded by the hub's round constant

- `MAX_FOLLOW_UP_ROUNDS = 5` in runtime `followUp.ts`: at most five rounds reach the person, so one gate makes at most four model calls. Each call sends every input of the state beyond its config as JSON, so its cost grows with what the author wires into the state.

## The gateway departs from the architecture's usual run discipline in two places

- Only a gate is stored. An approval and a question end with the agent turn that asked them, and a wait is asked again by the run that resumes, so none of the three has a row.
- A fast-forward's model call, like the follow-up call, runs outside any run with no session, record, tool or abort signal; its context is the controlling conversation's thread, read, not continued, so nothing it does appears in that conversation — the answer is drawn on the gate it settled instead.
- The follow-up model call runs outside any run, with no session, record, journal, tool or abort signal, because the engine is still inside the gate's call and the question is about the person's answers rather than the state's work.
