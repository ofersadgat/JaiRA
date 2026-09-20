---
id: engineering/contracts/session-live-protocol
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: event
owned_by: [engineering/units/live-turns]
consumers: ["@jaira/app renderer store.ts through liveTurnFold.ts", "@jaira/app renderer views that draw liveTurn: runViews.tsx, chatPane.tsx, fileSurfaces.tsx, session.tsx"]
siblings: [engineering/contracts/push-messages, engineering/contracts/chat-channels, engineering/contracts/journal-events]
---

# Session live protocol

The numbered `session:turn` deltas main pushes for the call a task is streaming, and the `session:live` snapshot a viewer seeds from, so that a viewer arriving mid-call holds exactly what a viewer from the start holds.

## A viewer uses the protocol for a call still in flight, and the record for everything settled

**Use when.** Drawing what a task's call is saying, thinking, calling or writing while it runs, and seeding that drawing after selecting a task or returning to one mid-call.

**Do not use when.** Reading anything settled: once `operation.completed` or `operation.failed` is journaled, the record holds the turn and `session:view` or `chat:thread` reads it, through [conversation-lookup](../units/conversation-lookup.md). Surviving a restart: a snapshot is process memory, and the throttled partial on the open record is the durable copy, owned by [live-turns](../units/live-turns.md). The push transport and project stamping are [push-messages](push-messages.md).

## The shape is a push per delta, the entries it may carry, and one snapshot channel

### A `session:turn` push carries exactly one delta and its ordinal

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"session:turn"` | yes | the discriminant |
| `taskId` | string | yes | the task whose run or typed turn produced the delta |
| `sessionId` | string | no | the conversation the call claims a position in; absent for a call with no session |
| `seq` | number | no | the position in that conversation |
| `stateId` | string | no | the part of the call's session seed before its first `:` |
| `text` | string | exactly one of `text`, `thinking`, `entry` | a non-empty answer fragment |
| `thinking` | string | exactly one of `text`, `thinking`, `entry` | a non-empty reasoning fragment |
| `entry` | JSON | exactly one of `text`, `thinking`, `entry` | a whole entry, stamped by main |
| `n` | number | no; main always sets it | this delta's ordinal in the task's counter |

### An entry is a finished message or a forwarded executor event, stamped with the host clock

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `kind` | `"message"` or `"event"` | yes | a finished turn, or anything else the executor emitted |
| `role` | string | on a message | the speaker |
| `content` | provider content parts | on a message | tool calls and tool results ride on it |
| `parentToolUseId` | string | no | the spawning tool call, on a subagent's message |
| `event` | the executor's event, verbatim | on an event | includes provider stream bookkeeping such as `stream_event` lines |
| `at` | epoch ms | yes | when the delta reached main |
| `startedAt` | epoch ms | no | on a finished main-chain assistant message: when its thinking, or else its text, began |
| `thoughtMs` | number | no | on the same message: from thinking start to text start, or to arrival when no text streamed |

### A `session:live` request returns the task's snapshot, or null when nothing streams

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| request `taskId` | string | yes | the task |
| request `project` | string | no | the project holding the task |
| `sessionId` | string | no | the position the tail belongs to |
| `seq` | number | no | the position the tail belongs to |
| `stateId` | string | no | the speaking state, as on the push |
| `providerSessionId` | string | no | the agent's own session id, read from `session_id` on forwarded event envelopes |
| `textStartedAt` | epoch ms | no | absent while no text streams |
| `thinkingStartedAt` | epoch ms | no | present with an empty `text` means still thinking, a withheld think included |
| `n` | number | yes | the ordinal of the last delta folded in |
| `text` | string | yes | the answer tail since the last finished assistant message |
| `thinking` | string | yes | the reasoning tail since the same |
| `entries` | JSON array | yes | main-chain entries in arrival order, at most 500, stream bookkeeping excluded |
| `sidechains` | record of spawning call id to JSON array | yes | subagent entries, at most 500 per call |
| `writing` | `{name, index, chars, head}` | no | a tool call whose arguments are still arriving: its name, its content block index when known, the characters so far, and the first 512 of them |

### A viewer seeds from the snapshot and folds only the deltas the snapshot has not seen

1. After the session view resolves, fetch `session:live`. Keep the current tail when it is at the same `sessionId` and `seq` and its `n` is at least the snapshot's; otherwise replace it with the snapshot, which is `null` when nothing streams.
2. Skip a push at the tail's `sessionId` and `seq` whose `n` is at most the tail's `n`.
3. A push at any other position replaces the tail with that delta alone.
4. An entry with `parentToolUseId` appends to `sidechains[parentToolUseId]` and nowhere else.
5. Any other entry first updates `writing` through `foldWriting`, then appends to `entries` unless `isStreamBookkeeping` says it is bookkeeping. A message with role `assistant` clears `text`, `thinking`, both clocks and `writing`.
6. A text or thinking fragment appends and starts its clock on the first non-empty fragment. An entry for which `startsThinking` is true starts the thinking clock while no text has streamed.
7. Drop the tail on `operation.completed` or `operation.failed` for the selected task and on `run:finished`. Main clears its own tail on the same settle events before it publishes them, and forgets the task and its counter when a run ends.

## The errors are few, because an absent tail is an answer

| Condition | Response | Caller does |
| --- | --- | --- |
| Nothing streams for the task, or the task is unknown | `null` | drop the tail |
| The project is not open, or several are and none is named | rejects with the project refusal | the store treats the rejection as `null` |
| A push names a task that is not selected | nothing; the store drops it | none |

## A change to any rule breaks both folds at once, and no deprecation path exists

- The fold exists twice, `LiveTurnLog.apply` in main and `foldLiveTurn` in the renderer, over `foldWriting`, `isStreamBookkeeping` and `startsThinking` in `@jaira/shared` `ipc.ts`. Either side can be the one holding the tail on screen, so a rule, the meaning of `n` or an entry's shape changes on both sides together.
- `partialRecordValue` projects the same snapshot into a record's `entries`, so a change to an entry's shape also changes what a crash leaves on the record.
- Main and the renderer ship together and nothing stores this shape directly, so a change needs no deprecation, and none is offered.

## Ordinals, clocks and state ids each mean less than their names suggest

- `n` counts per task only within one run. A run's end forgets the counter, so the next run or typed turn starts again at 1, and the renderer's clear on `run:finished` is what keeps the skip rule from discarding those pushes. Typed turns alone never reset it.
- A tail at an equal `n` is kept over the snapshot, so a viewer that selects a streaming task and receives a push before its seed lands keeps a tail that lacks everything said before the selection.
- Text and thinking pushes carry no `at`, so the renderer starts their clocks at its own time where main used the delta's arrival, and a seeded tail and a push-built tail can report slightly different thinking durations.
- The renderer asks `startsThinking` of subagent entries too, while main asks it only of main-chain entries.
- There is one tail per task. Two positions streaming in one task, as parallel children do, replace each other's tail on every delta, and a run and a typed turn in one task share it.
- `stateId` is `"chat"` for every typed turn, not the host's state id, because a typed turn's seed is `chat:chat:<hostInstanceId>:<index>`.
- The renderer's `LiveTurn` names no task, so a view that draws it without matching `sessionId` and `seq` can draw the previous task's tail until the seed lands.
- `providerSessionId` never reaches the renderer's tail, and an empty text or thinking fragment is never pushed.
