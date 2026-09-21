---
id: engineering/units/chat-turns
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/chat-with-agents, product/steer-agents-mid-task, ui/components/composer, ui/components/composer-setting-chip, ux/patterns/button-says-what-will-happen]
layer: service
owns_contracts: [engineering/contracts/chat-channels]
requires: [engineering/units/engine-wiring, engineering/units/live-turns, engineering/units/native-session-capture, engineering/units/tool-policy, engineering/units/host-tools, engineering/units/executor-tree, engineering/units/event-journal, engineering/units/operation-record-store, engineering/units/conversation-lookup, engineering/units/board-projection, engineering/units/interaction-hub]
implemented_by: [packages/runtime/src/chatOperation.ts, packages/runtime/src/chatTurn.ts, packages/app/src/main/service.ts, packages/app/src/main/session.ts]
verified_by: [packages/runtime/test/chatOperation.test.ts, packages/runtime/test/chatOperationLoaded.test.ts, packages/runtime/test/chatTurn.test.ts, packages/app/test/chatMessage.test.ts, packages/app/test/chatConversation.test.ts, packages/app/test/chatDurability.test.ts]
siblings: [engineering/units/live-turns, engineering/units/conversation-lookup, engineering/units/rewind-and-fork, engineering/units/task-lifecycle]
---

# Chat turns

## A chat turn runs one typed message as a synthetic child of the conversation's host, and leaves reading, streaming and cutting to others

- `chatPlanFor(path, overrides)` in `chatOperation.ts` takes the settings a message inherits from the first state on the path whose operation is a prompt, as `holdsConversation` decides: the pinned snapshot's merged `operation.config` model and reasoning, `operation.system`, every other config key as passthrough, and `environment.tools` and `environment.permissions`. An override wins per field, and `origin` says `inherited`, `override` or `unset`. An inherited `{expr}` value is listed in `unresolved` and not used.
- `chatOperationOf(plan, {message, session})` builds the `PromptOp`: the message as `user`, empty `input`, a `text` output. With no `tools` setting it declares `ALWAYS_GRANTED_TOOLS`; with a list it declares `planAgentTools(...).inject` and writes the native ask rules and compiled scope rules into `providerOptions`.
- `stateWithChatSettings(state, settings)` writes the same settings into a copy of a root state, so the opening message, which is a run started by `task:start` with `overrides`, runs under them.
- `runChatTurn` in `chatTurn.ts` resolves the position, starts the executor with scope `{instanceId, sequence: index}`, and journals the turn on instance `chat:<hostInstanceId>` under child key `ask`. The event sequence is in [journal-events](../contracts/journal-events.md).
- In `service.ts`, `sendChatMessage` and `runChatMessage` find the host and the position, steer or wait, assemble the executor, tools and policy, and run the turn. `cancelChatTurn` stops every typed turn in flight for a task. `chatPlan` and `chatStartPlan` answer what a message would run under. The channels are [chat-channels](../contracts/chat-channels.md).

It deliberately does not own:

- Reading a conversation. `chatThread`, `sessionHistory` and the record chain are [conversation-lookup](conversation-lookup.md).
- The live tail and its throttled partial: [live-turns](live-turns.md). Folding the agent's session file into the record: [native-session-capture](native-session-capture.md).
- Starting the opening run and rerunning a task: [task-lifecycle](task-lifecycle.md). Cutting or copying a conversation at a message: [rewind-and-fork](rewind-and-fork.md).
- Whether a position appends or forks. That is the session store's rule under the upstream `SessionStore` contract: [operation-record-store](operation-record-store.md).
- `LiveCalls`, `withTurnStream`, `withSessionLayers` and `buildPromptExecutor`: [engine-wiring](engine-wiring.md).

## The unit is main-process service code over a pure half in the runtime, and the engine never sees a typed turn

- Layer `service`. `chatOperation.ts` and `chatTurn.ts` live in `@jaira/runtime` and import only upstream types, `@jaira/shared` and `tools.ts`. The host half is `AppService` in `packages/app/src/main`, with per-project state on `ProjectSession`.
- Upstream seams: `Executor.start`, `SessionStore.resolve` and `SessionStore.refAt` from `@declarative-ai/exec`; the `EngineEvent` shapes and `LoadedState` from `@declarative-ai/hw`. Nothing binds to a chat child and no transition fires from it, so `executeWorkflow` is not called.
- Boundary: renderer and main. A message enters only through `chat:send`. Settings come from the task's pinned snapshot; only `chat:startPlan` reads the live state file, because no snapshot exists before the first message.
- `service.ts` reads `operation` from `chatOperationOf` and discards `environment`. Tools reach the call through `gateTools`, permissions through the folded `ExecPolicy`, and the session through the position `runChatTurn` resolves.
- A turn's prompt tree is built with `refuse` left on, over every state of the pinned snapshot, while `chatPlan` and `chatStartPlan` build theirs with `refuse: false`.

## The journal and the record store hold every turn, and the in-memory maps only order and stop them

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `chat:<host>` events in the task journal | appended by `runChatTurn` through `project.events.recorder`, then published as `engine:event`; read by `chatContextOf` through `projectRun` | the task journal | `load.ts` skips `chat:` instances when building a resume; `cut.ts` maps them on fork; projections draw them |
| Task-scoped `operation_records` rows, one per turn | opened and settled through the session layers; read by `modelOfRecord` and by the `branchAt` check | the record row | [live-turns](live-turns.md) writes the partial; [native-session-capture](native-session-capture.md) folds at close; [conversation-lookup](conversation-lookup.md) reads it |
| The pinned snapshot | read by `chatContextOf` through `bundleFor(project, snapshotHash)` | `system/snapshots/<hash>/` | `beginTaskRun` pins it |
| `ProjectSession.chatDone` | the newest send's completion promise per task, resolved in `sendChatMessage`'s `finally` | memory | none |
| `ProjectSession.chatTurns` | the abort controllers of the typed turns in flight per task | memory | `ProjectSession.close` aborts them |
| `ProjectSession.liveCalls`, `liveTurns`, `liveFlush` | registered and cleared per turn | memory | shared with the run path |

## The invariants keep a conversation on one instance and one branch, and keep a turn from ever being a run

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The first message enters `chat:<host>` under `ask` with `inputs: {}` and every later one takes `transition.taken`, so a conversation is one instance that is never superseded | `chatTurn.test.ts` "takes a transition per message instead of re-entering, so nothing is superseded"; `chatMessage.test.ts` "continues the conversation rather than starting one beside it" |
| 2 | Every turn ends with `instance.terminated`, so an idle conversation projects as completed | `chatTurn.test.ts` "projects as a completed child, so an idle conversation does not read as work in flight" |
| 3 | A failed turn journals `operation.failed` with `metrics.sessionRef`, and the next message appends on the same branch | `chatTurn.test.ts` "says WHERE it failed, which is what makes the turn findable afterwards"; `chatMessage.test.ts` "keeps its place, so the next message continues the same conversation"; `chatDurability.test.ts` "survives being stopped over and over" |
| 4 | A chat child never hosts a conversation: addressing it continues its host at the next index | `chatMessage.test.ts` "continues the conversation when the REPLY is what was addressed, rather than nesting inside it" |
| 5 | A composite or an unknown instance gets `null` from planning and a refusal from sending | `chatMessage.test.ts` "ANSWERS null for a COMPOSITE rather than failing at being asked", `"still answers null, not a plan, for an instance this run does not have"`, "keeps SENDING a refusal, because a typed message deserves a reason" |
| 6 | Settings are the host's own merged ones, an override wins per field, and `[]` tools is an answer, not an absence | `chatOperation.test.ts` "reads the host's own merged call config, not its ancestors'", "lets an override win per field, and says which is which", "treats an empty tool list as a real answer, not as absence"; `chatOperationLoaded.test.ts` `"lets the nearest layer win, already resolved — no merging left to do here"` |
| 7 | An inherited expression is reported, never defaulted | `chatOperation.test.ts` "is reported rather than silently defaulted" |
| 8 | The operation binds the session to an exact position and never asks for a fork | `chatOperation.test.ts` "binds the session to an exact position and asks for no fork" |
| 9 | A composer tool list replaces the state's, no list still grants the always-granted tools, and every offered tool resolves at send | `chatOperation.test.ts` "take the person's whole list over the state's, rather than adding to it", "reach a conversation that declared none at all"; `chatMessage.test.ts` `"hands over every tool the composer offers — all of them registered, none of them fatal"` |
| 10 | The services the host passes reach the executor unchanged | `chatTurn.test.ts` "passes the services through verbatim, so a delegated agent finds its gates" |
| 11 | Sends to one task run one at a time, in arrival order, on one branch | `chatDurability.test.ts` "keeps both, in one conversation, with everything said before them", "keeps all of them when a whole handful arrives at once" |
| 12 | A turn whose process died keeps its position, and the next message appends after it | `chatDurability.test.ts` "keeps its place, so the next message appends instead of forking away from it" |
| 13 | A typed turn never moves the task's status | `chatMessage.test.ts` `"does not move the task's status — a conversation is not a second execution"` |
| 14 | `branchAt` replaces the message at that position on a new branch that can itself be edited, and a position the task's store does not hold is refused | `chatConversation.test.ts` `"replaces it — the branch keeps what came before and drops what came after"`, `"can be edited again — the second edit forks the branch the first one made"`, `"refuses a position that names nothing in this conversation, rather than forking a stranger's"` |
| 15 | A turn publishes its journal events as `engine:event` | `chatConversation.test.ts` "narrates itself to the window, the way a run does" |
| 16 | `chat:startPlan` reads the state file, folds picks over it, and answers for a state no layer supplies | `chatConversation.test.ts` `"reads them off the state file — what the first message would inherit, and from where"`, "folds a pick over the file, and says it was a pick", `"answers for a state no layer supplies, rather than blanking the composer"` |
| 17 | `effective.permissions` names the preset the per-tool map matches, else `custom` | `chatMessage.test.ts` "names the permission posture after the per-tool MAP, which is what reaches the executor" |
| 18 | A blank message is refused, and a stop with nothing in flight answers `canceled: false` | `chatMessage.test.ts` "refuses an empty message rather than sending a turn that says nothing"; `chatConversation.test.ts` "says plainly that there was nothing to stop" |
| 19 | A message to a steerable call joins that call's turn and writes no record and no journal event | unasserted |
| 20 | A stop flushes the live partial before it aborts any turn | unasserted |
| 21 | `effective.model` prefers the model that answered the last turn over the router's default | unasserted |

## Every failure leaves the turn's message and position in place, and the next message continues from them

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two sends reach one task at once | each takes the previous send's promise before any await; one that cannot steer into a call in flight waits for it and re-reads the position | none needed | both messages and answers, in order |
| A wait passes `CHAT_WAIT_MS`, on the send ahead or on a call registered on the same session | the send goes ahead at the position it read, and an occupied position forks | none | the message lands on a branch the thread may not show |
| The model or transport fails, or the turn is stopped | `runChatTurn` returns `failure` and journals `operation.failed` with the position, then `instance.terminated` as `error` or `canceled` | the next message continues | the failure text under the composer |
| The executor throws | journaled as `operation.failed` with classification `permanent` at the resolved position plus one | the next message continues | the failure text under the composer |
| The session store's `resolve` throws | the rejection escapes after `operation.started`, so the turn has no end event | the next message | the send's error text |
| The process is killed mid-turn | the journal holds `operation.started` with no end; the record stays `open` with the last flush, because the open sweep settles records only for tasks whose status is `running` and a typed turn never sets it | the next message appends after it | the typed message and the flushed partial stay in the thread |
| Stop while sends wait behind the turn | `cancelChatTurn` aborts the registered controllers and deletes the set; a waiting send registers its controller only when its turn starts | stop again | a message sent before the stop still runs |
| Stop on a message steered into a run's call | `chat:cancel` holds no controller for that call | `task:cancel` | the run keeps going |
| The task's last run was stopped with `task:cancel` | typed turns are not aborted, and the approval gate the cancel shut stays shut, because only a run calls `approvals.allow` | start or resume a run of the task | a typed turn's approval requests are denied without asking |
| The pinned workflow names a model no route can serve | the send is refused by the executor tree's start-time check, whatever `overrides.model` says | make a route that serves it available | the refusal text under the composer |
| A refusal | `Refusal` for a blank message, a missing snapshot or an unopened project, logged at `warn`; `NoConversationHere` is a plain `Error`, so the IPC boundary logs it at `error` | fix the request | the refusal text under the composer |
| A send is retried | a new turn at the next index; nothing is idempotent | none | the message appears twice |
| Two processes send to one task | cannot occur: only the app runs typed turns, and the CLI has no chat command | none needed | none |

## A send waits up to two bounded intervals before its turn starts

- `CHAT_WAIT_MS = 120_000` in `service.ts`, applied first to the send ahead and then to a call registered on the conversation's session, so one send can wait 240 s.

## A typed turn departs from a run by bypassing the engine, the job claim and the audit

- The turn journals its own events instead of running through `executeWorkflow`, because nothing binds to its output and no transition fires from it.
- The chat instance terminates between messages and reopens with a transition, so a task with an idle conversation never reads as busy.
- `buildPromptExecutor` gets no observer and `compilePolicy` no `onDecision`, so a typed turn claims no job, an agent it spawns is not tracked for orphan cleanup, and its tool decisions write no `command_log` rows.
