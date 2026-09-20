---
id: engineering/units/engine-wiring
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/hand-work-to-agents, product/watch-agents-work-live, product/steer-agents-mid-task, ux/patterns/stream-then-settle]
layer: core
owns_contracts: []
requires: [engineering/units/executor-tree, engineering/units/scripted-doubles]
implemented_by: [packages/runtime/src/wiring.ts, packages/runtime/src/liveHandles.ts, packages/runtime/src/sessionServices.ts]
verified_by: [packages/runtime/test/agentSession.e2e.test.ts, packages/runtime/test/promptTranscript.test.ts, packages/runtime/test/agentPolicy.test.ts, packages/runtime/test/promptMemo.test.ts, packages/runtime/test/executorTree.test.ts, packages/runtime/test/liveHandles.test.ts]
siblings: [engineering/units/executor-tree, engineering/units/model-routing, engineering/units/live-turns, engineering/units/chat-turns, engineering/units/operation-record-store]
---

# Engine wiring

## The wiring turns a registry, a prompt executor and a pinned bundle into one run, and owns the order its layers compose in

`wiring.ts` holds four jobs:

- `buildPromptExecutor(options)` builds the prompt half: the tree it is given through `buildPromptTree`, or `ScriptedFakeExecutor` when `fakeRules` is set, then `withSecurityFloor` when a floor is given, then the repair loop `withRetry({validation: {turns, feedback: true}})` with `DEFAULT_REPAIR_TURNS`, then `withMemoize` outside everything when `memo` is given.
- `executeWorkflow(cfg)` puts the prompt executor and a dispatcher over `cfg.registry.functions` each under `withSessionLayers`, constructs the engine with the bundle, the stores, `answers`, `persistence`, `fanOut` and `split`, gives it a fresh `SchemaValidator` with the run's `workspace`, `policy`, `approve`, `askUser` and `abortSignal`, and calls `load` when `cfg.loaded` is set and `start(workflowStartOp(inputs))` otherwise. `statusOfResult` collapses the result to `completed`, `failed` or `canceled`.
- `withTurnStream(sink, inner, live?)` drains each prompt call's event stream into `TurnDelta`s and registers the call in `LiveCalls`.
- `LiveCalls` in `liveHandles.ts` is the register of calls in flight by session id: `get`, `canSend`, `settle(sessionId, timeoutMs?)` and `sessions`. `sessionServicesFor` in `sessionServices.ts` pairs one store as both `sessions` and `records`.

A `TurnDelta` is `{session?: {id, seq}, stateId?, at, text | thinking | entry}`, with exactly one of the last three. `entry` is `{kind: "message", role, content, parentToolUseId?}` for a finished turn and `{kind: "event", event}` for any other stream event, forwarded verbatim. Empty text and thinking fragments are skipped, and `stateId` is the resolved seed up to its first colon.

It deliberately does not own:

- The shape of the prompt tree, route resolution and the security floor's merge: [executor-tree](executor-tree.md). `defaultExecutorTree` lives in `wiring.ts` and belongs to [model-routing](model-routing.md).
- The scripted executor: [scripted-doubles](scripted-doubles.md).
- Loading and pinning the bundle: [workflow-snapshots](workflow-snapshots.md) and [task-lifecycle](task-lifecycle.md). Building the load description: [run-load](run-load.md).
- Storing events and records: [event-journal](event-journal.md) and [operation-record-store](operation-record-store.md). What the app does with each delta, the numbered pushes and the durable partial: [live-turns](live-turns.md).
- Running a typed message into a conversation: [chat-turns](chat-turns.md), which composes `withSessionLayers` and `withTurnStream` itself.

## The wiring is core code over the engine's executor, session and persistence seams, and both drivers call it

- Layer `core`, package `@jaira/runtime`. It calls [executor-tree](executor-tree.md) and [scripted-doubles](scripted-doubles.md), and imports persistence types only.
- Upstream seams: `createWorkflowExecutor` and `EngineConfig` from `@declarative-ai/hw`; `createOperationExecutor`, `withSessionPosition`, `withRecord`, `withRetry`, `withMemoize`, `ExecHandle.control` and `MapSessionStore` from `@declarative-ai/exec`; `SchemaValidator` from `@declarative-ai/validate`.
- Boundary: workflow and run. The engine is constructed with the resolved `WorkflowBundle` the caller pinned, never with authored source.
- Callers: app `startRun` wraps the prompt executor in `withTurnStream` with the project session's `LiveCalls`, passes `SqliteSessionStore` through `sessionStoreFor`, and tees `persistence.record` to `engine:event`. The CLI's task runs pass the SQLite store with no stream tap; `jaira run --workflows`, `jaira changeset review` and `jaira workflow check` use the in-memory store `sessionServicesFor()` makes.

## The wiring owns no durable data, only the register of calls in flight

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `WorkflowBundle` | read | the pinned snapshot `beginTaskRun` returns | none |
| Journal events | written through `cfg.persistence.record` | the task's journal | the app's tee pushes each as `engine:event` |
| Operation records and conversation positions | written by the session layers through `cfg.session` | `SqliteSessionStore`, or a `MapSessionStore` that dies with the process | [native-session-capture](native-session-capture.md) decorates `records` in the app |
| `LiveCalls` entries `{sessionId, control, settled}` | added in `register`, removed when the call settles | in memory, one register per project session | chat send reads it to wait and to steer |

## The invariants keep one conversation per session name and keep watching from changing a call's outcome

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A function op, such as a delegated agent, passes the same session layers as a prompt op: it gets a resolved position, two states naming one session share one conversation in order, a state naming none gets its own, and a state entered twice appends to one conversation | `agentSession.e2e.test.ts` "hands the agent a RESOLVED position, not just a request", "puts two states that name one conversation into one conversation, in order", "gives a state that declares no session its own conversation", "appends both passes to ONE conversation" |
| 2 | A prompt call's messages and provider handle are recorded while the op still answers with its output value | `promptTranscript.test.ts` "keeps the messages the call produced, and still answers with the op's output value", "stores the provider's own session handle, so a later call can resume it" |
| 3 | `AskUserQuestion` from an agent reaches `cfg.askUser` and never the approver | `agentPolicy.test.ts` `"routes AskUserQuestion to the askUser seam and carries the answers back — never to the approver"` |
| 4 | A `memo` answers a repeated prompt from the store, and with no `memo` nothing is written | `promptMemo.test.ts` "answers a repeated prompt from the store instead of the provider", `"writes nothing when no memo is configured — the default stays off"` |
| 5 | Every stream event reaches the sink in order with the position the call runs at, a call in no conversation still forwards with no position, and a stream that ends badly never fails the call | `executorTree.test.ts` "forwards each delta with the position it belongs to", "says nothing when the call runs in no conversation", "forwards whole turns and unknown events, not only text", "does not fail the call when the stream ends badly" |
| 6 | A call in flight is found by session id, carries no control when its transport cannot be steered, and leaves the register when it settles however it settles | `liveHandles.test.ts` "is reachable by the session id both ends already know", "is registered without control when the transport cannot be steered", "is forgotten when it fails, not only when it succeeds", `"is passed through unregistered — nobody can address it, so nobody can steer it"` |
| 7 | `settle` returns at once when nothing runs, releases on failure, returns `false` at its bound, and the first of two calls sharing a session id removes only its own entry | `liveHandles.test.ts` `"is just the handle's own promise — there is no queue to store or flush"`, "releases the waiter when the call FAILED, rather than leaving it hanging", "sees the entry already gone once the wait resolves", "returns at once when nothing is running there", "GIVES UP at the bound rather than inheriting whatever the call is parked on", "lets the FIRST to finish forget only its own entry" |
| 8 | A sink that throws loses that one delta and never ends the drain | unasserted |
| 9 | An embedded prompt call inside a function op passes exactly one session layer, so it never claims its position twice | unasserted |

## Every failure settles the call, and what is lost is a transcript turn or a live delta

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A memoized prompt is answered from the store | `withRecord` claims the position before the memo is asked, and the replay carries no session outcome, so the record holds no messages | none | that turn reads as a gap in the transcript |
| The sink throws, as an IPC send to a closed window does | the throw is caught for that delta and the drain goes on | none needed | that window misses the delta; the stored record is whole |
| The event stream throws | the drain stops and the call still settles | none needed | streaming stops early; the record lands at close |
| A state runs a delegated agent as a function op | `withTurnStream` wraps only `cfg.prompt`, and a function op reaches the registry through the dispatcher, so no delta is published and the call is not in `LiveCalls` | none | nothing streams and the agent cannot be steered until it settles |
| Two calls claim one conversation position | upstream `withSessionPosition` forks the later call onto a branch, and `LiveCalls` keeps whichever registered last | none needed | the conversation shows a fork |
| A chat message waits on a call that does not settle | `settle` gives up at `CHAT_WAIT_MS` and returns `false`, and the message is appended beside the call | none needed | the message lands on a fork |
| The model's output fails its schema | the repair loop re-asks with the errors, each attempt a real provider call | fails after `DEFAULT_REPAIR_TURNS` repairs | the state fails with the validation reason |
| The process dies mid-call | the open record row keeps the last flushed partial; the in-memory register is gone | crash recovery and native capture at the next open | the state reads interrupted with its partial turn |
| A caller passes `definitions` or sets `memo.enabled` in settings | `PromptExecutorOptions` has no `definitions` field and nothing reads `memo.enabled`, so both are dropped | name a `memoize` step on an executor node instead | nothing is memoized and no named executor is reachable |

## The budgets are the repair turns and the chat wait

- `DEFAULT_REPAIR_TURNS = 2` in `wiring.ts`; the CLI overrides it with `--repair-turns`.
- `CHAT_WAIT_MS = 120_000` in `packages/app/src/main/service.ts`, the bound chat send passes to `LiveCalls.settle`.

## The wiring departs from the session design's layer order, and records every operation

- The memo sits inside both session layers, the reverse of `withMemoize(withSessionPosition(...))`, because an outer `withMemoize` refuses any executor that declares `sessionResume`, which the position layer does.
- `withSessionLayers` wraps every operation unconditionally, so a call with no position is still recorded, because the changeset gate's inputs and decisions are recovered from its record.
- Under `fakeRules`, `buildPromptExecutor` builds a bare router and discards it, so tree `steps`, router `defaults` and bare-id placement never apply to a scripted run, because the fake answers every prompt itself.
