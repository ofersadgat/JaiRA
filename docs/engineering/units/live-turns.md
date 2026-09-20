---
id: engineering/units/live-turns
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/watch-agents-work-live, ux/patterns/stream-then-settle, ux/patterns/say-what-it-is-doing-and-for-how-long]
layer: service
owns_contracts: [engineering/contracts/session-live-protocol]
requires: [engineering/units/engine-wiring, engineering/units/operation-record-store]
implemented_by: [packages/app/src/main/liveTurns.ts, packages/app/src/renderer/liveTurnFold.ts]
verified_by: [packages/app/test/liveTurns.test.ts]
siblings: [engineering/units/chat-turns, engineering/units/native-session-capture, engineering/units/renderer-store, engineering/units/conversation-lookup]
---

# Live turns

## Live turns hold the call a task is streaming, in main and in the renderer, until the settled record replaces it

In main, `packages/app/src/main/liveTurns.ts`:

- `LiveTurnLog`, one per `ProjectSession`, folds each `TurnDelta` into one `LiveTurnSnapshot` per task. `apply(taskId, delta)` returns the delta's ordinal `n` and the entry stamped with host-clock times; `snapshot` returns a copy or `null`; `clear` drops the tail and keeps the counter; `drop` forgets both.
- `LiveTurnFlusher` writes the snapshot into the open record at most once per interval through `SqliteSessionStore.update`, and `flush()` writes it at once for a stop. `dispose()` cancels the timer and writes nothing.
- `partialRecordValue(snapshot)` projects a snapshot into the settled record's own encoding: `{value: {entries}}` with main-chain and subagent message entries in one array sorted by `at`, then the text and thinking tail as one assistant entry marked `partial: true` with `timing {startedAt, thoughtMs}`. Event entries are left out. It is `null` when nothing is recordable.

In the renderer, `packages/app/src/renderer/liveTurnFold.ts` holds `foldLiveTurn`, `alreadyFolded`, `tailIsAhead` and `liveTurnOfSnapshot`. `store.ts` is its only caller and holds one `liveTurn` for the selected task.

Both folds call `foldWriting`, `isStreamBookkeeping` and `startsThinking` from `@jaira/shared` `ipc.ts`. The deltas, the snapshot and the merge rules between the two sides are [session-live-protocol](../contracts/session-live-protocol.md).

It deliberately does not own:

- Producing deltas. `withTurnStream` drains the prompt handle's events into `TurnDelta`s: [engine-wiring](engine-wiring.md).
- The record row, its `status = 'open'` guard and the provider handle stamp: [operation-record-store](operation-record-store.md). Reading settled turns: [conversation-lookup](conversation-lookup.md).
- The renderer's state and when it refetches: [renderer-store](renderer-store.md). Drawing the tail is the transcript's `entriesOf`.
- Folding the agent's own session file into a settled or crashed record: [native-session-capture](native-session-capture.md).

## Main's log sits in the service layer behind the prompt stream, and the renderer reaches it only through pushes and one channel

- Layer `service`. `startRun` and `runChatMessage` in `service.ts` each build a flusher, register `liveFlush` for the task, and wire `withTurnStream` so that each delta runs `liveTurns.apply`, then `liveFlush.note()`, then publishes `session:turn` with the returned `n`.
- Upstream seam: the `events` iterator of an `ExecHandle` from `@declarative-ai/exec`. hw never drains it, so `withTurnStream` is its one consumer, and nothing in the engine reads the tail.
- Boundary: renderer and main. The renderer holds a copy only; `session:live` serves main's snapshot back, and neither path carries a person's answer.
- Clearing: the journal tee of a run and of a typed turn calls `liveTurns.clear` on `operation.completed` and `operation.failed` before publishing `engine:event`. A run's `finally` calls `liveTurns.drop`, disposes its flusher and deletes `liveFlush`. A typed turn's `whileChatting` disposes its flusher, and clears the tail and `liveFlush` only once no typed turn is left in flight for the task.
- `task:cancel` and `chat:cancel` call the task's `liveFlush` before they abort, while the record is still open.

## Main's log is memory only, and the record row is the tail's one durable copy

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `LiveTurnLog` tail per task | written by `apply`; read by `snapshot`, `session:live` and the flusher; deleted by `clear` and `drop` | this process, while a call streams | none |
| `LiveTurnLog` counter per task | incremented per applied delta; kept by `clear`; deleted by `drop` | this process | every `session:turn` push carries it as `n` |
| Open record `result_json` and `provider_session_id` | replaced wholesale by `update(ref, {value, providerSessionId})` on each flush; the handle is written only where the row has none | the record row, until the settle replaces the value | the executor's settle; [native-session-capture](native-session-capture.md) at close and at recovery |
| `ProjectSession.liveFlush` | registered by a run or a typed turn; called by both cancel paths | memory | [chat-turns](chat-turns.md), the run path |
| Renderer `AppState.liveTurn` | folded from pushes for the selected task; seeded in `refreshSession`; set to `null` on a settle event for the selected task and on `run:finished` | the renderer | every view that draws the tail |

## The invariants keep one tail per task, count every delta once, and never let bookkeeping crowd out the conversation

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Deltas for one position accumulate text, thinking and entries | `liveTurns.test.ts` "accumulates text, thinking and entries for one position" |
| 2 | A delta for another position replaces the tail and is never concatenated onto it | `liveTurns.test.ts` `"replaces the tail when a different position speaks — never concatenates two states"` |
| 3 | `n` never decreases within one run, across replacements and `clear` alike | `liveTurns.test.ts` "keeps `n` monotone across replacements, so stale pushes stay skippable" |
| 4 | Every main-chain entry carries `at`, and a finished assistant message carries `startedAt` and `thoughtMs` | `liveTurns.test.ts` "stamps entries with times: completion on every entry, start + thought duration on a finished turn" |
| 5 | A withheld think starts the thinking clock from its bookkeeping, only while no text has streamed, and other bookkeeping never restarts a running clock | `liveTurns.test.ts` "starts the thinking clock off BOOKKEEPING, for a think whose text the provider withholds", "takes a thinking or signature delta as the same notice, so a dropped block start costs nothing", "ignores stream bookkeeping that is not a thinking block, and does not restart a running clock" |
| 6 | Stream bookkeeping never enters `entries`, and the call being written stays in `writing` until the message carrying it lands | `liveTurns.test.ts` "holds the call being written, and drops the bookkeeping it read it from", "lets go of the half-written call once the turn carrying it lands" |
| 7 | A subagent entry goes only to its spawning call's chain, and a finished assistant message restarts both tails and their clocks | `liveTurns.test.ts` "routes a subagent's entries to its chain and restarts the tails on a finished assistant turn" |
| 8 | The provider session id is taken from the stream's envelopes | `liveTurns.test.ts` "sniffs the provider session id off the stream's envelopes" |
| 9 | A served snapshot never changes afterwards, and two tasks never share a tail | `liveTurns.test.ts` `"hands out copies — a mutating log must not reach into a snapshot already served"`, "tracks tasks independently and answers null where nothing streams" |
| 10 | The partial is one `entries` array ending in a `partial: true` entry, and a started clock with no text is still written | `liveTurns.test.ts` "projects finished turns into ONE array, clocks on the turns and subagents in place", `"carries the turn in flight as an entry marked partial — a fragment is not a finished turn"`, "persists the started clock as the partial, so a crash mid-think is not a blank", "stays null with nothing recordable at all" |
| 11 | The flusher writes at most once per interval even under a stream that never pauses, and a throwing write never stops it | `liveTurns.test.ts` "coalesces a burst into one flush, and a later burst into a second", `"keeps flushing under a stream that never goes quiet — throttle, not trailing debounce"`, "survives a flush that throws, and goes quiet after dispose" |
| 12 | A stop writes the exact tail before anything is aborted | unasserted |
| 13 | The renderer's fold and main's fold give the same tail for the same deltas | unasserted |
| 14 | A push already counted in a seed is skipped, and a tail ahead of a seed is kept | unasserted |

## A failure costs at most one flush interval of durability, and the tail on screen recovers when the record lands

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed mid-call | the open row holds the last flush, at most one interval old, with the provider handle | for a task whose status was `running`, the open sweep settles the row `interrupted` and native capture folds the agent's file into it | the partial turn after reopen |
| A flush throws | swallowed; the next `note` schedules another | the next interval | none; pushes continue |
| A timer fires after the settle | `update` matches no open row and writes nothing | none needed | none |
| A flush and the settle race on one row | `update` repeats the `status = 'open'` guard on its write, so a settle landing between its read and write is not overwritten | none needed | none |
| Two positions stream in one task at once, as parallel children do | each delta replaces the other's tail in main and in the renderer, and each flush replaces that record's partial with what arrived since the last switch | the settle replaces the partial | the tail flips between the two; a crash keeps a short partial |
| A run and a typed turn stream in one task at once | they share one tail and one `liveFlush` slot: the later registration takes the slot, either one's settle or end clears the other's tail, and the run's end deletes the slot | none | the tail blanks mid-call, and a stop can flush the wrong record or none |
| A task is selected while it streams and a push arrives before its seed lands | `select` keeps the previous tail, the push replaces it with that one delta, and the seed's `n` is then not above the tail's, so `tailIsAhead` keeps the push-built tail | the next finished assistant message restarts the text, and the record replaces the entries at settle | the live turn lacks what was said before the selection |
| Between a selection and its seed | `liveTurn` still holds the previous task's tail and names no task; the run conversation and `SessionPanel` match `sessionId` and `seq` before drawing it, while the Chat view and the leaf file surface do not | the seed replaces it | the previous task's tail shows briefly |
| `session:live` rejects | the store takes it as `null` and replaces a tail that is not ahead with nothing | the next push or refresh | the tail blanks, then rebuilds from later deltas only |
| A delta is delivered twice or out of turn | cannot duplicate: `n` is minted once per applied delta, and the renderer skips a push at its position whose `n` is not above the tail's | none needed | none |

## The flush interval and the entry caps are the only budgets, and both are constants

- One flush per 400 ms per streaming task: the `LiveTurnFlusher` default `intervalMs` in `liveTurns.ts`. Each flush rewrites the record's whole `result_json`, and with conversations file-backed it appends one record line.
- 500 entries per position and per subagent chain: `LIVE_ENTRY_LIMIT` in `liveTurns.ts` and in `liveTurnFold.ts`. The oldest entries are dropped first.
- 512 characters of a tool call's argument JSON in `writing.head`: `WRITING_HEAD_MAX` in `@jaira/shared` `ipc.ts`.

## The tail is folded twice by design, and its durable copy is throttled

- Main and the renderer each run the fold over the same shared helpers, so a viewer that arrives late seeds from main and then holds what a viewer from the start holds; any rule changed on one side is changed on both.
- The partial reaches the database on a throttle rather than per delta, because better-sqlite3 writes synchronously on the main process thread.
