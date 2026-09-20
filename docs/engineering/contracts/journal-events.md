---
id: engineering/contracts/journal-events
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: event
owned_by: [engineering/units/event-journal]
consumers: ["@jaira/persistence views.ts, conversation.ts, load.ts, cut.ts, prune.ts, lifecycle.ts", "@jaira/app main service.ts and fanOut.ts", "@jaira/runtime chatTurn.ts", "@jaira/cli task status", "the renderer, through engine:event pushes", "people and tools reading committed journal files"]
since: 2026-07-17
siblings: [engineering/contracts/sqlite-schema, engineering/contracts/storage-files, engineering/contracts/push-messages, engineering/contracts/fan-out-host-answers]
---

# Journal events

A task's journal is the append-only record of its state machine: each row of `state_machine_events` and each line of its journal file holds one upstream engine event verbatim, beside the events JaiRA writes itself and the tombstone a rewind leaves.

## A caller reads the journal to learn what a machine did, and never to learn what a call said

**Use when.** Reconstructing what a task's machine did: which instances entered and ended, which operations ran, which transitions fired, what a fan-out made and where a call's conversation ended. Resuming, projecting, cutting or copying a task. Reading a committed journal file by hand.

**Do not use when.** Reading what a call returned or said, which operation records hold and which a row reaches through `session_ref` and `operation_id`: see [conversation-lookup](../units/conversation-lookup.md) and [operation-record-store](../units/operation-record-store.md). Following a turn still in flight: [session-live-protocol](session-live-protocol.md). The table's indexes and migration history are [sqlite-schema](sqlite-schema.md).

## The shape is one envelope per store around the engine's own event

### A table row holds the event verbatim beside the columns a query filters on

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `seq` | integer, autoincrement primary key | yes | order of insertion into this database; never written to a file |
| `task_id` | text | yes | the task whose machine emitted the event |
| `instance_id` | text | no | the event's `instanceId`; null when the event has none |
| `type` | text | yes | the event's `type` |
| `payload_json` | text | yes | the event as JSON, exactly as recorded |
| `created_at` | integer, epoch ms | yes | the time handed to `record`, or the line's `timestamp` on replay |
| `session_ref` | text, generated from `$.metrics.sessionRef` | no | the conversation position a call ended at, `<sessionId>@<seq>` |
| `operation_id` | text, generated from `$.operationId` | no | the join to the call's operation record |

### A journal file line wraps the same event in an envelope a person can grep

The file is `system/journal/<taskId>/journal.jsonl`: UTF-8, one JSON object per line, each ended by a newline. Characters of a task id outside `A-Za-z0-9._-` become `_` in the directory name. Files written before migration 16 are `system/journal/<taskId>/<runId>.jsonl`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | string | yes | the event's `type`, or `jaira.rewound` |
| `timestamp` | ISO 8601 string | yes | becomes `created_at` on replay |
| `taskId` | string | yes | the task a replay inserts the row under |
| `instanceId` | string, or a number on legacy lines | no | written when the event has one; a legacy number is read as its string and `-1` as absent |
| `runId` | number | no | on legacy per-run files only; never written |
| `event` | `EngineEvent` or `RewoundEvent` | yes | the event, verbatim |

A replay reads task directories in name order; inside each, legacy `<runId>.jsonl` files by run number, then `journal.jsonl`; lines in file order once tombstones are applied. `seq` is minted by that insert order.

### JaiRA's own line names the lines a rewind removed

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `event.type` | `"jaira.rewound"` | yes | a tombstone; written to the file only, never inserted into the table |
| `event.lines` | number array | yes | 0-based ordinals of the removed lines, counted over every line of the file that parses, tombstones included |

### The engine events are upstream's vocabulary, stored as the engine wrote them

The vocabulary is `EngineEvent` in `@declarative-ai/hw` `ports.ts`. `failure` is upstream `Failure` with `classification`, `reason`, and optional `retryAfterMs`, `rateLimited` and `detail`. `metrics` is `WorkflowMetrics`. A termination's `outcome` is one of `success`, `error`, `canceled`, `timeout`. A `?` marks an optional field.

| `type` | Payload fields | Written by | Meaning |
| --- | --- | --- | --- |
| `instance.entered` | `instanceId, stateId, childKey?, parentInstanceId?, element?, inputs` | engine; fan-out host; chat turns | an instance began; `element` is its position in a fan-out batch |
| `instance.blocked` | `stateId, childKey?, parentInstanceId?, reason` | engine | a child could not be entered because its inputs did not resolve; no instance exists |
| `operation.started` | `instanceId, stateId, op` where `op` is `prompt` or `function` | engine; chat turns | the operation began, before its inputs resolved |
| `operation.dispatched` | `instanceId, stateId, op, operationId` | engine | the operation's record row exists; `operationId` is the scoped id |
| `operation.completed` | `instanceId, stateId, op, operationId?, metrics?` | engine; chat turns | the operation succeeded; `metrics.sessionRef` is where its conversation ended |
| `operation.failed` | `instanceId, stateId, op, operationId?, failure, metrics?` | engine; chat turns | the operation failed; `metrics` is present only when the call ran |
| `call.waiting` | `instanceId, stateId, call, operationId` | engine | a deferred call started and the state now waits on it |
| `call.settled` | `instanceId, stateId, call, operationId, outcome` where `outcome` is `value` or `error` | engine | the deferred call ended; a cancelled wait is `error` |
| `value.settled` | `instanceId, stateId, field, outcome, value?, error?, fallback?` | engine | a computed field such as `title` settled, with its value |
| `fanout.made` | `instanceId, stateId, childKey, occurrence, kind, runs: [{element, id?, runId, title}]` where `kind` is `task` or `split` | fan-out host | the tasks a hosted fan-out made of its elements; `runId` is a task id |
| `transition.taken` | `instanceId, stateId, to, index, iteration` | engine; chat turns | a transition fired; `index` counts every transition and `iteration` only backward ones |
| `child.superseded` | `instanceId, stateId, childKey` | engine | the instance named dropped its child under `childKey` |
| `instance.terminated` | `instanceId, stateId, outcome, failure?` | engine; fan-out host; chat turns | the instance ended |

What the fan-out host makes around `fanout.made` and its mirrored rows is [fan-out-host-answers](fan-out-host-answers.md).

### A chat turn journals a synthetic child whose id is derived from its host

`runChatTurn` in `@jaira/runtime` `chatTurn.ts` writes a typed message into the host task's journal as a child of the instance the conversation belongs to.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `instanceId` | `chat:<hostInstanceId>` | yes | derived, so every message of one conversation lands on one instance |
| `parentInstanceId` | string | on `instance.entered` | the host instance |
| `stateId` | string | yes | the host instance's own state id |
| `childKey` | `"ask"` | on `instance.entered` | the one reserved key per host |
| `index` | integer | on `transition.taken` | 1 for the second message, then one more per message; `iteration` is always 0 |

The first message writes `instance.entered` with `inputs: {}`, and each later one writes `transition.taken` to the host's state id. Then every message writes `operation.started`, then `operation.completed` or `operation.failed` with `metrics.sessionRef`, then `instance.terminated`.

## Errors are skipped on read and refused at a cut, and none is thrown by a reader

| Condition | Response | Caller does |
| --- | --- | --- |
| A line does not parse, or has no string `type` or `taskId` | skipped by `readJournalFile`, so replay and `effectiveLines` never see it | nothing; that event is gone from the table |
| A journal file cannot be read | treated as empty | nothing |
| A line's `timestamp` does not parse | `created_at` becomes 0 | nothing |
| A rewind finds the file's surviving line count differs from the table's row count | `rewindTask` refuses with `task '<id>': the journal file holds N events and the table M — refusing to cut a journal that disagrees with its file` | reopen the project so the table is replayed from the file |
| A rewind or fork is asked of a file-backed task with legacy per-run files | refused with `task '<id>' has history in per-run journal files, which a cut cannot address` | re-run the task as a new task |
| The table insert in `record` throws | the error reaches the engine or the caller; a file-backed line is already written | the run fails; the next open replays the line |

## A change to any event or to the envelope breaks every stored journal, and no deprecation path exists

- Renaming or reshaping an upstream event breaks projections, load, cut and fork together. Stored payloads are never migrated, so a reader keeps accepting an old shape for as long as any journal holds it.
- Changing the line envelope, its field names or the ordinal rule of `jaira.rewound` breaks replay of every committed journal file.
- Changing the `chat:` prefix or the `ask` key breaks resume filtering in `load.ts`, the id mapping in `cut.ts` and the conversation readers for existing journals.
- Changing `fanout.made` breaks the fan-out host's reuse of recorded ids and the line at the mount for existing tasks.
- Legacy forms are read indefinitely rather than deprecated: `runId` lines, per-run files, numeric instance ids and re-stated entries.

## Sequence numbers, ordinals and operation ids each mean less than their names suggest

- `seq` lasts only as long as the table that minted it. A file-backed journal re-mints every `seq` at each open that replays, so a `seq` kept across a reopen, such as `task_runtime.forked_at_seq` and `fork_boundary_seq`, can name a different event.
- A tombstone's ordinals count only lines that parse. A line that stops parsing after a rewind, such as one a merge broke, shifts every later ordinal, and the tombstone then removes different events.
- `operationId` on `operation.*` is scoped to the dispatch site, and on `call.*` it is the bare content hash. Both fill the `operation_id` column, and comparing one kind with the other matches nothing.
- A chat turn writes no `operation.dispatched`, and its `operation.completed` and `operation.failed` carry no `operationId`; its record joins through `session_ref`.
- `buildTaskLoad` skips every event of a `chat:` instance, while the tree and conversation projections keep it.
- The fan-out host writes `fanout.made`, its mirrored rows and a split copy's entry through a bare recorder, not the app's tee, so none of them is pushed as `engine:event`.
- Journals written before 2026-09-08 hold re-stated `instance.entered` rows under an id already entered; readers merge them by id.
- Numeric instance ids are coerced only by `SqliteEventLog.list` and `replayJournal`. A query that reads `payload_json` directly, as `views.ts` does, sees the number.
