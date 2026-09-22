---
id: engineering/units/conversation-lookup
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/complete-record-of-every-run, product/chat-with-agents, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/components/transcript, ui/components/session-sheet, ux/patterns/choose-a-side-where-it-divided, ux/patterns/absence-is-stated]
layer: data
owns_contracts: []
requires: [engineering/units/operation-record-store, engineering/units/event-journal, engineering/units/board-projection]
implemented_by: [packages/persistence/src/views.ts, packages/persistence/src/sessionStore.ts, packages/persistence/src/recordMessages.ts, packages/app/src/main/service.ts]
verified_by: [packages/persistence/test/sessionStore.test.ts, packages/persistence/test/recordCorners.test.ts, packages/app/test/service.test.ts, packages/app/test/chatConversation.test.ts, packages/app/test/chatDurability.test.ts]
siblings: [engineering/units/operation-record-store, engineering/units/live-turns, engineering/units/chat-turns, engineering/units/board-projection]
---

# Conversation lookup

## Conversation lookup gets a reader from a task id to the turns a conversation said, and writes nothing

A reader is handed a task id and never a session id. The journal is the index that leads to the records, and the records hold what was said. This unit owns that path:

- **The index.** `stateSessions(project, taskId)` in `views.ts` returns one `StateSession {instanceId, stateId, sessionId, seq, at, outcome}` per operation that ran in a conversation, in time order. `interruptedSessions` adds the calls that have no terminal event. `parseSessionRef` splits `<id>@<seq>` on the last `@`.
- **The store's reads** on `SqliteSessionStore`: `transcript(ref)` returns the rows along the lineage, oldest first, each ancestor only up to where its child left it; `forks(ref)` returns, per seam on that path, the parent's own tail and any sibling branch the path did not take; `lineageOf(id)`, `at(sessionId, seq)`, and `messages(ref)` and `bySession`, which skip `open` rows. `rowsOf` keeps one row per effective seat, the live claimant when there is one and else the newest dead row, and `projectValue` turns a result's reported `messages` into `entries`. A read resolves a name through `session_names` and never mints a session.
- **The wire history.** `messagesOfRecord` in `recordMessages.ts` is a record's finished main-chain `message` entries as `{role, content}`, without sidechain, event or partial entries. It is what a resume sends back to a provider and what native turn lines are written from.
- **The readers**, in main `service.ts`. `sessionHistory` joins `stateSessions` with each call's start time, cost, lineage and instance address into `SessionRef[]` for `session:history`. `sessionView` reads one instance's record through `store.at` for `session:view`. `chatThread` walks `store.transcript` from the conversation's position for `chat:thread`, adds edit `points` and `forks`, and joins each record to the journal seq its turn began at. Every view is derived from a record's one `entries` array by `turnsSaidBy`, `sidechainsOf`, `recordEventsOf`, `nativeOf` and `structuredOutputOf`.

It deliberately does not own:

- Writing records, claiming seats, handles and cuts: [operation-record-store](operation-record-store.md).
- The turn still streaming, and its handover to the stored record: [live-turns](live-turns.md) and [session-live-protocol](../contracts/session-live-protocol.md).
- Where a typed message goes and the host instance it continues: `chatContextOf` and `chatPositionOf` in [chat-turns](chat-turns.md).
- The instance tree, `instanceAddresses` and the run timeline `conversationView`: [board-projection](board-projection.md).
- Laying several conversations of one run out against a clock: the renderer's `sessionBands`, drawn by [run-conversation](../../ui/surfaces/run-conversation.md).

## A conversation is a tree of records, each holding only what its own call added

1. **The unit of storage is a record, not a message.** One `operation_records` row per call holds the whole payload as JSON. No messages table exists.
2. **A record holds the delta its call contributed**, opening with the `user` message it was called with. A conversation's messages are its records concatenated along the lineage. No reader subtracts a prefix or guesses a record's shape; the store writes one shape from the record's first instant.
3. **Order is a seat.** A record's seat is `session.id` and `session.seq` in its request, and its effective seat is `COALESCE(landed_session_id, session_id)` with the matching seq. A failed or interrupted row stays at its seat as history, and a landed row reads at the seat it landed on.
4. **A session is a tree.** `sessions(id, parent, cursor)`: an edited message, a divergence or a refused seat mints a child that leaves its parent at `cursor`, nothing is deleted, and the child inherits the prefix by lineage, never by copying.

```text
task id
  └─ stateSessions(project, taskId)
       ├─ operation.completed and operation.failed rows whose session_ref is "<id>@<end>"   seat = end - 1
       └─ interruptedSessions: unterminated operation.started events, paired in start order
          with placed records that no terminal event accounts for
            └─ StateSession {instanceId, sessionId, seq}
                 ├─ sessionView: store.at(sessionId, seq), then turnsSaidBy
                 └─ chatThread: position "<sessionId>@<seq + 1>", then store.transcript
                      └─ chain: walk parent and cursor to the root, rows oldest first
```

A typed chat message is recorded on its host's session under instance `chat:<hostInstanceId>`, so a conversation continued by hand is more records on one chain. Its `operation.completed` carries no `operationId`, so `chatThread` joins its record to the journal by seat.

## The lookup reads the data layer and answers the renderer through three channels

- `views.ts`, `recordMessages.ts` and the store's reads are layer `data` in `@jaira/persistence`. `stateSessions` and `interruptedSessions` query `project.db` directly; `interruptedSessions` reads `task_runtime`, `state_machine_events` and `operation_records` in one pass.
- The readers sit in `@jaira/app` main `service.ts`, beside the channels they answer, `session:history`, `session:view` and `chat:thread` in [ipc-channels](../contracts/ipc-channels.md).
- Upstream seam: the join rides upstream's `withSessionPosition`, which reports the position a call ended at as `metrics.sessionRef`, and hw puts those metrics on `operation.completed` and on a post-dispatch `operation.failed`. The `session_ref` column is generated from that payload, so it cannot drift from the event.

## The journal indexes a conversation and the record row holds it

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events.session_ref`, `operation_id` and the `operation.*` payloads | read by `stateSessions`, `interruptedSessions`, `sessionHistory` and `chatThread` | the event payload | written by [event-journal](event-journal.md) |
| `operation_records` status, effective seat, `instance_id`, `request_json`, `result_json` | read | the record row | written by [operation-record-store](operation-record-store.md) |
| `sessions.parent`, `cursor` and `session_names` | read by `chain`, `forks`, `lineageOf` and name resolution | the lineage rows | written by [operation-record-store](operation-record-store.md) |
| `task_runtime.outcome`, `status`, `ended_at` | read by `interruptedSessions` to admit a task and to tell `running` from `interrupted` | the task row | written by [task-lifecycle](task-lifecycle.md) |

## The invariants make every call that ran findable and keep the readers agreeing about what it said

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A settled call is listed at the seat one back from where it ended, whether it completed or failed, and an operation with no conversation is not listed | `sessionStore.test.ts` "reads one row per operation that ran in a conversation, one position back from where it ended", `"lists a FAILED call too — it ran, it said things, and its transcript is in the store"` |
| 2 | Calls with no terminal event are paired with their records in start order, and nothing is listed when the counts differ | `sessionStore.test.ts` "pairs several in-flight calls in start order, which both lists share", "says nothing rather than guessing when the two lists disagree" |
| 3 | An `open` record reads `running` while its task has not ended and `interrupted` once it has | `sessionStore.test.ts` "calls a live run's in-flight conversation running rather than interrupted", "still calls an open record interrupted once the run it belongs to has ended" |
| 4 | A call that settled and lost its event, a stopped call, and a call reclaiming a failed call's seat are each still listed | `sessionStore.test.ts` "lists a call that SETTLED and then lost its event, on a run the engine died in", "recovers the call somebody STOPPED, on a run whose outcome is canceled", "lists a call that reclaimed a FAILED call's position, while it runs" |
| 5 | A conversation reads back along its lineage at any position, a branch sharing its parent's prefix | `sessionStore.test.ts` `"forks by lineage — the branch shares the prefix and diverges after it"`, "reads a conversation AT a position, not merely at its head", "says where a branch came from, which is the other direction from `forks`" |
| 6 | A streamed partial is visible to a transcript read with its status and never enters replayed history | `sessionStore.test.ts` `"streams into the open row, visible with its status — and out of materialized history"` |
| 7 | The wire history leaves out subagent turns, event entries and the partial entry | `recordCorners.test.ts` "derives messages from entries, and leaves a subagent's turns out of them", `"skips EVENT entries — a context injection is not a turn"`, `"skips the PARTIAL entry — a turn nobody finished must not go back on the wire"` |
| 8 | A state's turns are read straight off its record, with nothing subtracted | `service.test.ts` "reads a state's turns straight off its record, without subtracting a phantom prefix" |
| 9 | `sessionView` and `chatThread` show the same stopped turn: its question, its tool traffic and its half-written answer | `chatDurability.test.ts` "is recovered for the run's transcript too, not only the chat's", `"stays on screen — the half-written answer is part of the conversation"`, "survives an agent's tool traffic, which is user-role messages nobody typed" |
| 10 | An edited message branches, the thread follows the new branch, and the side it replaced is reported | `chatConversation.test.ts` `"replaces it — the branch keeps what came before and drops what came after"`, "says WHERE the conversation split, and what it said down the other side" |
| 11 | A thread already on screen is never replaced by a read that answers nothing | `chatDurability.test.ts` "never replaces a conversation with an empty one" |

## A call with a missing event is recovered by pairing, and an ambiguous pairing shows nothing rather than the wrong state

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A run is stopped mid-call | the record settles where it stood and the journal has no `operation.completed` or `operation.failed` | `interruptedSessions` admits the `canceled` task and pairs the start with the record | the transcript ends in the fragment the call was writing |
| The process is killed mid-call | the journal holds `operation.started` only, and the record stays `open` until recovery settles it | the same pairing, reading `interrupted` once the task has ended | the turn shows its question and what streamed |
| The engine throws after a call returned | the record is `completed` and no event names it | the same pairing, reading `success` | the transcript reads normally |
| An operation that holds no seat is in flight beside an unterminated call, such as a gate waiting on a person | the start and record counts differ, so `interruptedSessions` lists nothing | none; the call is listed once the other operation settles | the in-flight conversation is missing from the history |
| A composite or a task that never ran is read | `chatThread` answers null; `sessionView` answers `empty: "this state ran no model call, so there is no conversation to show"` | none needed | the stated absence |
| A listed seat has no record | `sessionView` answers `empty: "no record of this conversation was kept"` | none | that sentence |
| `chat:thread` answers null or rejects while a thread is on screen | `kept` in `chatPane.tsx` keeps the thread, and the rejection is swallowed | the next read replaces it | the last thread stays |
| A reader runs while a call is writing | every query is one SQLite read, so the reader sees a whole state before or after that write; readers write nothing, so two readers cannot conflict | none needed | an `open` turn shows what has streamed so far |
| The branch a thread's path took at a seam holds no record yet, as just after an edit is sent | `chatThread` cannot place the seam as a turn and drops it from `forks` | none; the seam is reported once the branch's first record lands | no marker for that split until then |

## Readers accept every shape older databases hold and migrate nothing

- A result whose conversation rides as a `messages` sibling, which migration 14 folded out of `session_outcome_json`, is read as `entries` by `projectValue`.
- A numeric instance id on an old failed event is matched against a record's text `instance_id` as a string in `interruptedSessions`.

## The readers live in the main process, and in-flight calls are joined by order rather than by key

- `sessionHistory`, `sessionView`, `chatThread` and the record folds sit in `service.ts` rather than `@jaira/persistence`, because they build `@jaira/shared` view models and resolve a chat host through the pinned snapshot and the projected instance tree.
- `interruptedSessions` pairs starts with records by start order, because a call with no terminal event leaves no key joining the two.
