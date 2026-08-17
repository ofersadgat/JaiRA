---
id: engineering/units/conversation-lookup
type: engineering-unit
status: shipped
updated: 2026-08-17
implements: [] # the Chat and run-transcript surfaces are not catalogued yet
layer: data
owns_contracts: []
requires: []
decisions: []
verified_by:
  [
    "packages/persistence/test/sessionStore.test.ts",
    "packages/app/test/chatConversation.test.ts",
    "packages/app/test/chatDurability.test.ts",
    "packages/app/test/chatFork.test.ts",
    "packages/app/test/service.test.ts",
  ]
exceptions: []
siblings: []
---

# Conversation lookup

## Responsibility

How a conversation is stored, and how a reader gets from a **task id** to the
**turns on screen**. It owns the record/position/lineage model, the two readers
over it (`chatThread` and `sessionView`), and the rule about what a record
contains.

It does not own the *live* turn — what a call is streaming right now reaches the
screen over `session:turn` and is held in `liveTurns`. This unit is about what is
on disk, and about the moment the two hand over.

## Where this fits

- **Position in the architecture** — `data`. `SqliteSessionStore`
  (`packages/persistence/src/sessionStore.ts`) is the store; `views.ts` is the
  projection that finds a conversation in the journal; the two readers live in
  `packages/app/src/main/service.ts` and are reached over IPC. Nothing above the
  store parses a session id or a ref — those spellings are the store's.
- **Serves** — the Chat surface (whole conversation) and the run transcript panel
  (one state's contribution).
- **Neighbors** — `liveTurns` owns the in-flight turn; `sessionBands` owns how
  several conversations in one run are laid out against a clock. Neither reads
  records.
- **Depends on / used by** — depends on the journal (`state_machine_events`) for
  the index and on the run/task tables for scope. Used by the `chat:thread`,
  `chat:send`, `chat:plan` and `session:view` IPC handlers, by `sessionHistory`
  (and through it the run panel and `sessionBands`), and by provider replay —
  `materialize` is what a resumed conversation is rebuilt from.
- **History** — the model is upstream's (`@declarative-ai/exec`
  `SessionStore`/`RecordStore`); JaiRA supplies the SQLite implementation.
  Migration 4 normalised records and positions into their own tables; migration 7
  gave interrupted records the message they were called with.

## The model, in four facts

Most confusion about this code comes from expecting a `messages` table. There
isn't one.

1. **The unit of storage is a record, not a message.** One row of
   `operation_records` per model call, holding the whole payload as JSON.
2. **A record holds the messages its call contributed — a delta.**
   `LlmOutput.messages` is *"the messages this call APPENDED to the conversation,
   verbatim"*. A conversation's messages are its records concatenated.
3. **Order is a claimed position, not a timestamp.** `session_positions` maps
   `(session_id, seq) → record`. The primary key **is** the claim: a second
   claimant raises `PositionTaken`, and the correct answer to that is to fork.
4. **A session is a tree.** `sessions(id, parent, cursor)`. Editing a message
   mints a child branching from the parent at `cursor`; nothing is deleted. A
   fork inherits its prefix *by lineage*, never by copying.

Session ids are namespaced at the SQL boundary — `k(id)` = `${taskId}/${runId}/${id}`
— because a bare id like `#i1` names the first instance of *every* run.

```
sessions            #i1 ──────────────┬──────────────►  (cursor 2)
                                      └── #i1~edit1 ──►

session_positions   #i1@0   #i1@1   #i1@2 …
                      │       │       │
operation_records    rec     rec     rec        ← each holds its own delta
```

## The lookup path

Neither reader is handed a session id. Both are handed a **task id**, and the
journal is the index that gets them the rest.

```
task id
  └─ latest run                                     runtime.listRuns(taskId)
       └─ journal: operation.completed / .failed    stateSessions()
            carrying metrics.sessionRef = "<id>@<seq+1>"
            └─ …or, for a call with no terminal event:
               interruptedSessions() pairs orphan operation.started
               events against orphan records, in start order
                 └─ session id + seq
                      └─ position "<id>@<seq+1>"     chatPositionOf()
                           └─ store.transcript(position)
                                └─ chain(): walk parent/cursor to the root
                                     └─ rows, oldest first, forks walked
```

`stateSessions` is the whole index. It reads `session_ref`, a **generated column**
over the event payload (migration 1), so it cannot drift from the event it came
from. `NOT NULL` on it means exactly "this operation ran in a conversation".

`interruptedSessions` is the recovery arm, and exists because a terminal event can
be missing three different ways: the process died mid-call; the engine threw
*after* the call returned (so the record is settled and whole, and nothing in the
journal points at it); or the run was **cancelled**, which terminates the instance
and settles the record but writes no `operation.completed`/`operation.failed` at
all. It pairs unterminated `operation.started` events against records the journal
does not already name, in start order — and refuses to pair at all when the two
lists differ in length, because a conversation attributed to the wrong state is
worse than one that is merely missing.

### Two readers, two questions

| | `sessionView(taskId, instanceId)` | `chatThread(taskId)` |
| --- | --- | --- |
| Asks | what did **this instance add**? | the **whole conversation**, in order |
| Reads | one record (`store.at`) | the chain from the tip (`store.transcript`) |
| Surface | run transcript panel | Chat |
| Fold | `turnsSaidBy` | `turnsSaidBy`, per row, concatenated |

Both fold through the same function. They answer different questions; they must
never disagree about whether a turn happened.

A chat turn is recorded on its **host's** session under instance
`CHAT_INSTANCE_BASE + host` (`1_000_000 + n`), so a conversation continued by hand
is more records on one chain rather than a second conversation beside the first.

### A run holds several conversations

Not one. States share a session on purpose (`environment.session`) and just as
deliberately do not, so a run is a set of chains, not a single thread. That is why
there is no "read the run" reader: `sessionBands` lays the chains out against a
clock, one panel per session per band, and never merges two — merging would claim
a conversation nobody had.

## Data

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `operation_records` | written by `open`/`streamPartial`/`close`, read by every projection | the record's own row | native capture folds `nativeLines` in |
| `session_positions` | written once at `open` | the position claim | never updated |
| `sessions` | written at branch creation | lineage | `compact` / `resync` mint derived ids |
| `state_machine_events.session_ref` | generated column | the event payload | `stateSessions` |

## Invariants

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A record holds only the messages its own call contributed; a session's messages are its records concatenated | `sessionStore.test.ts` |
| 2 | A record carries the message its call was made with, at every instant of its life — at birth, through every flush, and through the settle | `sessionStore.test.ts` — "the message the call was made with" |
| 3 | A settled record is never doubled by the splice: the provider's delta already opens with the question | `sessionStore.test.ts` |
| 4 | `messageTimes` stays index-aligned with `messages` across any splice | `sessionStore.test.ts` |
| 5 | An open (streaming) row never reaches materialized history — a half-written turn is not replayed into a provider | `sessionStore.test.ts` |
| 6 | Every non-success run outcome — `error`, `interrupted`, `canceled` — can still have its conversation found | `sessionStore.test.ts` — "a run the process died inside" |
| 7 | A conversation never comes back shorter than it was, by any of the five routes | `chatDurability.test.ts` |
| 8 | An edit forks; the replaced branch stays reachable and renders through the same viewer | `chatFork.test.ts` |
| 9 | The two readers agree about what a record said | `chatDurability.test.ts` — "not only the chat's" |

## The rule about record shape, and why it is a rule

**A record is the delta it will finally be, from its first instant, and only ever
grows.** Four writers keep that true, all through one function (`openingMessage`):

| Moment | Writer |
| --- | --- |
| birth | `insertRecord` — the row is created holding `{value:{messages:[question]}}` |
| streaming | `streamPartial` — keeps it in front of each flush's turns |
| errored settle | `preservePartial` — carries it through |
| success settle | the provider's authoritative delta, which already contains it |

The birth write is load-bearing, not tidy: a process killed between `open` and the
first flush reaches no later writer, and that row is all anybody will ever have.

### What this replaced, and the argument against it

The store used to tolerate **two** record shapes and guess between them at read
time. `ownMessages` dropped a leading run of messages whenever a record began with
the previous record's list in full, on the theory that a record might carry the
history it was called with rather than its own delta.

The argument that killed it:

- The upstream contract says delta (`LlmOutput.messages`, quoted above), and
  `MapSessionStore` — the reference implementation — states it as *"a
  conversation's messages ARE its records"*.
- `materialize()` concatenates records **without subtracting anything**. If a
  cumulative record existed, provider replay would already have been sending the
  model its own history twice over. Nothing guards it, so nothing writes it.
- Checked empirically across every adjacent record pair in a real database:
  zero cumulative records.

What the guess actually did was lose data. Two byte-identical consecutive
deltas — ask the same question twice, get the same answer twice — and the second
pair was read as history and dropped. Its companion in `recordEventsOf` subtracted
the *previous record's* length from every provider-event index, so in an ordinary
chat every event after the first collapsed onto index 0 and drew above the turn it
happened after.

**The general lesson, worth keeping:** when a reader has to sniff the shape of
what it reads, the shape is under-specified at the write. Fix it at the write.

## Failure modes

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Run cancelled mid-call | Record settles `failed` holding everything streamed plus the question; no terminal event | `interruptedSessions` finds it by pairing | Transcript reads normally, ending in the fragment it was cut off writing |
| Process killed mid-call | Row stays `open` with the question and whatever flushed | Same pairing; `recoverInterrupted` re-reads the agent's own session file | Turn visible immediately; excluded from replay until settled |
| Engine throws after the call returned | Record `completed`, journal has nothing | Same pairing; reported as the success it was | Normal |
| Two calls want one position | `PositionTaken` | Fork | Fork seam with tabs for each side |
| A read answers `null` | The last good thread stands (`kept`) | Next read replaces it | No blank — never |
| Record predates conversations being kept | `store.at` finds nothing | None | "this run was recorded before conversations were kept" |

## Compatibility

**Migration 7** splices the question into interrupted records already on disk. It
is narrowed to `failed` records holding messages on the result channel — a record
whose messages live on `session_outcome_json` would be *shadowed* rather than
repaired, since `projectValue` prefers the result when it has messages — and it is
naturally idempotent, so a half-finished upgrade is re-runnable.

It is the first migration to use a `run(db)` step rather than `sql`. SQLite's JSON1
can read a blob but cannot prepend to an array, and the contortion that fakes one
(`json_group_array` over a `UNION ALL`, ordered by a synthetic column) relies on an
ordering SQLite does not promise.

Rollback: the data change is additive and the old readers tolerated a leading user
message, so an older build reads a migrated database correctly. The reverse is what
migration 7 exists for.

## Budgets

| Budget | Limit | Why this is at risk |
| --- | --- | --- |
| Partial flush writes | one per debounce window, not one per delta | A chatty stream would otherwise put a synchronous `UPDATE` of the whole payload on the main thread per token; `LiveTurnFlusher` is the throttle |
| `transcript()` queries | one per branch in the lineage | A conversation edited N times walks N+1 branches. Fine at the depths seen; if forks ever nest deeply this becomes a recursive CTE |

## Security and permissions

None of this widens reach: a record is only ever read within the task and run that
wrote it (`SessionScope`), which is the boundary `k()` enforces in SQL rather than
in a caller's discipline.

## Out of scope

- **The live turn.** Streaming, the `n` merge protocol, and the handover to the
  stored record belong to `liveTurns`.
- **Nested fork seams.** `chatThread` reports the newest fork only; a conversation
  edited three times has three, nested, and a tab row inside a tab row is a case
  nobody has had yet.
- **Cross-session interleaving.** Deliberately not offered — see "a run holds
  several conversations".
