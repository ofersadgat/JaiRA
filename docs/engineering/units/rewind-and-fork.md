---
id: engineering/units/rewind-and-fork
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/rewind-to-where-it-went-wrong, product/try-another-direction, product/large-work-splits-into-independent-pieces]
layer: service
owns_contracts: [engineering/contracts/task-channels]
requires: [engineering/units/task-lifecycle, engineering/units/run-load, engineering/units/operation-record-store, engineering/units/event-journal, engineering/units/storage-policy, engineering/units/interaction-gateway, engineering/units/interaction-hub, engineering/units/process-claims, engineering/units/chat-turns, engineering/units/app-log]
implemented_by: [packages/persistence/src/cut.ts, packages/app/src/main/service.ts]
verified_by: [packages/persistence/test/cut.test.ts, packages/persistence/test/holding.test.ts, packages/app/test/runCut.test.ts, packages/app/test/chatCut.test.ts]
siblings: [engineering/units/run-load, engineering/units/task-lifecycle, engineering/units/operation-record-store, engineering/units/fan-out-host]
---

# Rewind and fork

## A cut is one journal seq, and rewind deletes what follows it while fork copies what precedes it

Both verbs take a `seq` of the task's `state_machine_events`, and both are defined over `partitionAt(events, seq)` in `cut.ts`:

- every event before `seq` is kept;
- an instance entered at or after `seq` is doomed, with every event and record it has;
- of a kept instance, an event past `seq` survives only as `operation.dispatched`, `operation.completed`, `operation.failed` or `instance.terminated` following an `operation.started` before `seq`, so a call already running keeps its settle while a transition, a child entered or a turn typed is cut.

`rewindTask(project, taskId, seq)` deletes the dropped half in place, in one transaction: each conversation a doomed record is seated in is cut at its lowest seat through `SqliteSessionStore.cutSession`, the other doomed records go through `dropRecords`, a file-backed journal gets a `jaira.rewound` line, the dropped rows are deleted, the task's `pending_interactions` are cleared, and `markCut` leaves the task `interrupted`.

`forkTask(project, taskId, seq, options)` copies the kept half into a new task. `createTask` makes the copy, then one transaction inserts the lineage of every conversation a kept record sits on, the task's `session_names`, the kept records under new ids, one more `blobs.refs` per record per blob, the kept events through the copy's recorder, and `stampFork`. Every instance and session id is minted fresh with `uuidv7`; a `chat:` id maps through its host; a record id is recomputed with `scopedOperationId` over the new scope. A conversation keeps its provider handle only with a message id to cut the remote at, stored as `cut_at`.

| `standing` | The copy's status | Its start, end and outcome | Caller |
| --- | --- | --- | --- |
| `startable` | `interrupted` | the parent's start, now, `interrupted` | a run fork, resumed at once |
| `asIs` | the parent's status when `completed`, `failed` or `canceled`, else `interrupted` | the parent's, or now and `interrupted` | a chat fork, continued by a message |
| `queued` | `queued` | none | a split copy, with `ofLiveTask`, `id`, `branch`, `origin`, `split` and `dependsOn` from the fan-out host |

`AppService.rewindTask` and `forkTask` in `service.ts` put the verbs behind [task-channels](../contracts/task-channels.md). Both refuse a task in `open.live` or with a `jobs.liveRunJob`. A rewind rejects the task's parked gates with `the task was rewound to before this question` and dismisses its questions, cuts, and then resumes the task when `resumable` names a frontier, or else restores the status and outcome it had. A fork without a message copies `startable` and resumes the copy; with one, it copies `asIs` and sends the message into the copy's first instance that spoke, without awaiting the reply.

It deliberately does not own:

- Resuming the cut task or the copy: [task-lifecycle](task-lifecycle.md), through [run-load](run-load.md). Neither verb enters a state.
- Cutting a conversation's rows and branches and stamping its remote: `cutSession` in [operation-record-store](operation-record-store.md).
- The tombstone lines and their replay: [journal-events](../contracts/journal-events.md) and [storage-files](../contracts/storage-files.md).
- When a split copies a task and what it stamps on the copy: [fan-out-host](fan-out-host.md).
- The message sent into a chat fork: [chat-turns](chat-turns.md). The origin label drawn at the seam: [board-projection](board-projection.md).

## The cut is service code that sequences six stores under one rule

- Layer `service`: `cut.ts` in `@jaira/persistence` writes the journal, records, lineage, names, blobs, gates and the runtime row together, and imports `CHAT_INSTANCE_PREFIX` from `@jaira/runtime`. The service methods add the liveness refusal and the resume.
- Upstream seams: `uuidv7` from `@declarative-ai/hw`; `hashOperation` and `scopedOperationId` from `@declarative-ai/exec`, so a later dispatch at a kept site in the copy never computes the parent's record id.
- Boundary: derived and committed. A file-backed journal and conversation file are appended to, never edited, so a rewind leaves tombstones rather than removing lines.
- Boundary: workflow and run. The copy pins the parent's `snapshot_hash`.

## A cut writes every store a task's history spans, and each store stays the truth for its part

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `state_machine_events` | rewind deletes the dropped seqs; fork records the kept events under the copy's ids | event-journal | every journal reader |
| `system/journal/<taskId>/journal.jsonl` | rewind appends `jaira.rewound` naming dropped lines by ordinal; fork appends the copy's lines | the file when the journal is file-backed | replay at open |
| `operation_records` | rewind deletes doomed records and releases their blobs; fork inserts copies with rewritten `scope`, `session` and `metrics.sessionRef` | operation-record-store | the resume that follows reopens `interrupted` records |
| `sessions` and `session_names` | rewind drops branches past a seat and restamps `provider_session_id` and `cut_at`; fork inserts the lineage and names under new ids, with `#i<id>` names following their instance | operation-record-store | conversation readers |
| `blobs.refs` | fork adds one per copied record per distinct blob | the blob store | history-pruning collects zero-ref blobs |
| Conversation file lines | rewind appends `jaira.tombstone` and cut session rows; fork appends the copy's `session`, `name` and `record` lines | the file when conversations are file-backed | storage-policy |
| `pending_interactions` | rewind clears the task's rows | interaction-gateway | the inbox |
| `task_runtime` | rewind `markCut`; fork `stampFork` sets `snapshot_hash`, `root_instance_id`, `forked_at_seq`, `fork_boundary_seq`, status, times and outcome | the row | `taskOriginOf` draws the seam |

## The invariants keep a cut to one partition and a copy independent of its parent

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A cut at a state's entry drops the state, everything after it and the parent's motion past it | `cut.test.ts` "at a state's entry: the state and everything after it go, the parent's motion past it goes too" |
| 2 | A cut at a transition drops the rule and keeps the state that took it entered | `cut.test.ts` "at a transition: the rule is what goes, the state that took it stays entered" |
| 3 | A call already running when the cut lands keeps its settle | `cut.test.ts` "keeps the settle of a call that was already running when the cut landed" |
| 4 | A cut in a chat thread keeps the turns before the point and drops that turn and every later one | `cut.test.ts` "cuts a chat thread at a turn: the turns before stay, the turn and everything typed after go" |
| 5 | A rewind deletes from the table, the record store and the file alike, and a replay of the file after the database is gone holds the same history | `cut.test.ts` "deletes everything from the state's entry on, in the table, the store and the file", `"survives a reopen — the file, replayed, holds what the table held"` |
| 6 | A cut conversation holds no row past its seat, loses every branch that left past it, and offers its remote only as a copy cut at the last kept message | `cut.test.ts` "deletes the tail, and offers the remote as a copy cut at the last kept message", "takes every branch that left the tail with it, and leaves branches above the cut alone", "drops the handle when the kept rows carry no message id to cut at" |
| 7 | A running task and a seq the journal does not hold are refused | `cut.test.ts` "refuses a running task and a point the journal does not have"; `runCut.test.ts` "refuses while the task is running" |
| 8 | A fork shares no instance, record or session id with its parent, never resumes the parent's remote, and outlives the parent's deletion | `cut.test.ts` "copies the kept prefix under new ids, and the copy outlives its parent" |
| 9 | A chat fork stands as its parent does | `cut.test.ts` "stands as its parent does when asked to (a chat fork)" |
| 10 | A copy of a running task is refused unless the caller says the cut is at a parked point, and a `queued` copy has no start, end or outcome and takes its own binding and provenance | `holding.test.ts` "refuses a live parent unless the caller says the cut is at a parked point", "keeps everything so far, stands queued with no start and no end, and takes its own binding and provenance", "unbinds the copy when asked, rather than copying the parent's branch" |
| 11 | A rewound run resumes and asks the cut question again, and a run fork asks it again while the original keeps its answers | `runCut.test.ts` "deletes the state and everything after it, and the resume asks the question again", "is a second task that asks the question again, while the original keeps its answers" |
| 12 | A rewind among turns typed after the run finished leaves the task finished, and the next message takes the cut message's place | `chatCut.test.ts` "deletes the message and everything after it, and the next message goes where it stood", "can cut the last message alone" |
| 13 | A chat fork shares every turn before the point and takes the new message after them | `chatCut.test.ts` "is a second conversation that shares everything up to the message and takes a new one from there" |

## Every file line appended before a rollback outlives it

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The task runs in this process or another, or is `stopping` | refused: `is running — stop it before rewinding it` or `forking it`, or `is stopping — stop it before cutting its journal` | stop it and let it settle | refusal |
| The journal file's surviving lines disagree with the table, as after a retry while file-backed | the rewind refuses after `cutSession` and `dropRecords` ran, and the transaction rolls back | reopen the project before rewinding | refusal naming both counts |
| A rewind's transaction does not commit after a file append: that refusal, or a kill | SQLite rolls back, and the files keep every line already appended: `jaira.tombstone` and cut session rows, and `jaira.rewound` once the check passed | none | after reopen the files win: records are gone while journal events still name them, and a resume can refuse as unreadable |
| The fork's transaction throws, or the process is killed inside it | `createTask` already wrote the copy's file and `queued` row, and conversation lines appended before the throw stay in the copy's file | delete the copy | an extra queued task with the parent's title |
| A rewind is retried at the same seq | refused `has no journal event <seq>`, because that event is gone | none needed | refusal |
| A fork is retried | each call mints another copy; with `id` given, the second is refused as existing | delete the extra copy | a duplicate task |
| The cut leaves no frontier, or the load is blocked or unreadable | the service restores the status and outcome the task had and does not resume; `markCut` already cleared `outputs_json` and `failure_json` | none | the task reads as before, shorter and without its outputs |
| The resume after a rewind or a run fork refuses | the cut or the copy stands, and the request rejects | clear the cause, then resume | refusal; the task or its copy reads interrupted |
| A chat fork's copy has no instance that spoke | refused `the fork of '<id>' holds no conversation to continue` after the copy exists | delete the copy | refusal and an extra task |
| The first message into a chat fork fails | logged `the fork's first message failed: <reason>` after the request already answered | send the message again | the fork opens with no reply |
| Two writers reach one task during a cut | none in this process: the checks and the cut run with no await between them; a start in another process between the status read and the transaction is not detected | none | none shown |

## The fork stamp needs migration 17, and a cut is never taken back

- Migration 17 added `sessions.cut_at`, `task_runtime.forked_at_seq` and `task_runtime.fork_boundary_seq`. It does not roll back.
- `forked_at_seq` is a seq of the parent's journal, which a file-backed replay re-mints at each open; [journal-events](../contracts/journal-events.md) says what that does to the label.

## A cut appends tombstones and copies rows, where a store would ordinarily delete and share

- A rewind of a file-backed journal appends a line naming the removed lines by physical ordinal rather than rewriting the file, so the file stays append-only and merges in git.
- A fork copies records and lineage rather than sharing them with its parent, so deleting or pruning either task never reaches the other.
