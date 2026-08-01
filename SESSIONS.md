# Sessions — Append-Only Conversation Streams with Forking

**Status: BUILT.** All nine steps of §15 are implemented and green — `declarative-ai` on branch
`sessions/append-only-streams`, JaiRA on `claude/brave-antonelli-dbc5ac`.

The **model** below held up in full: positions, forking, copy-on-write lineage, per-operation
granularity, compaction and resync as new sessions rather than rewrites. Four things about the
**mechanism** did not, and this document has been corrected in place. Each is flagged where it
appears, but together they are worth reading first, because each one replaced an invention with
something the codebase already had:

1. **There is no message store, and no delta channel.** A session IS the `OperationRecord`s sharing a
   session id. A record already holds what its call produced — for a prompt op an `LlmOutput`, which
   carries the messages verbatim — so appending a turn and recording a call are ONE write, and the
   "executor reports the delta" of §7 needs no channel to report through. §3's `ResolvedSession` grew
   a `report` callback during implementation and then lost it again; the response was always the delta.
2. **The reservation is a database constraint, not a lock.** `PRIMARY KEY (session_id, seq)` on the
   records table is what makes two writers at one position impossible — durably, and across processes,
   which the in-process lock §5 sketched does not manage. findmyprompt already had the shape:
   `MemoStore.open`/`put` writes a stub row and fills it in.
3. **Recording is its own wrapper.** findmyprompt fused the two-phase write into its memo store
   because that class owned the connection. "Has this been computed?" and "this call is happening,
   record it" have different keys and different lifetimes, so `withRecord` is separate — and once it
   is, a delegated agent records the same way a prompt op does.
4. **A session is locked to one provider.** The `(session, provider) → handle` map §9 proposed models
   a many-to-many that cannot occur: using a conversation with a different provider is a FORK. The
   handle lives on the record, which is also what makes §11's divergence check possible at all.

There were **no back-compatibility constraints**, and the behaviour this replaced — a shared
`"default"` session, in-memory-only transcripts, `withSession`'s synthesized two-turn fold, and the
engine's own parallel transcript writer — is gone.

---

## 1. Why

Today a "session" in JaiRA is a mutable bucket of turns keyed by an authored name. Three things fall
out of that and all three are problems:

1. **History is rewritten in place.** `SummarizingSessionStore` replaces older turns with a summary on
   `put` ([summary.ts](packages/runtime/src/summary.ts)). Anything holding a reference to "the
   conversation as of turn 14" silently starts referring to different content. It also invalidates the
   Anthropic prompt cache on every compaction, which is a strict prefix match.
2. **There is no way to branch.** Re-running a state, fanning out variants, or replaying a
   conversation against a different provider all mean "continue from a known point without disturbing
   what came after" — and no such point is addressable.
3. **The transcript is lossy and not durable.** The fold synthesizes one user turn plus a stringified
   assistant turn, so tool calls and results are discarded; and the store is run-scoped and in-memory,
   so nothing survives the run.

The fix is to make a session an **append-only stream** whose identifier commits to its contents at a
position, so that "continue from here" and "branch from here" are the same primitive.

### The governing rule

> **A session mirrors what the remote provider's session does.**

Most behaviour in this document is *derived* from that rule rather than configured. Repair turns
append because the provider appended them. A retry forks because the retry resolves to an
already-appended position and the provider branches too. There is no policy switch for either; if an
implementation needs one, the model has drifted.

---

## 2. Model

A **session** is an append-only sequence of messages. A **session id** identifies a session *at a
position* in that sequence — so an id is a commitment about content, not just a name.

Three ways a session comes into being, recorded as the **edge** to its parent:

| Edge | Meaning | Prefix shared with parent? | Carries a cursor? |
| --- | --- | --- | --- |
| `root` | A brand-new empty stream | — | no |
| `fork` | Branch at position *n*; parent untouched | yes, byte-identical | yes |
| `compaction` | Older turns replaced by a summary | **no** — content differs | no |
| `resync` | Remote diverged; contents re-read from the provider | **no** | no |

**Compaction is a new session, not a fork.** A fork's prefix is byte-identical to its origin's — that
is what `[0:14]` asserts. A compacted stream's first message is a summary that appears nowhere in the
origin, so calling it a fork would make the notation lie. Same reasoning for `resync`. Only `fork`
edges carry a cursor.

This also means the original is never mutated, which is what makes an id a durable content
commitment, and it keeps compaction's prompt-cache cost honest (a genuinely new prefix pays one cold
cache write).

### Identifiers

The **canonical key is opaque and globally unique** — hw and every executor treat it as a string and
never parse it. Only the session store interprets structure.

A human-readable **label** is stored alongside for observability, encoding lineage:

```
planning[0:14]/b        a fork of `planning` taking its first 14 messages
planning[0:14]/b[0:31]/c   a fork of that fork
```

The label is derived, may be truncated for display on deep chains, and is **never** a foreign key.
Lineage is queried from the table, not parsed from the string.

Because the key is opaque, the label format can change later without touching hw, promptop, or any
adapter.

---

## 3. The session reference

The value that flows through inputs, outputs and expressions:

```ts
interface SessionRef {
  /** Opaque, globally unique, marks a session AT a position. The only ENUMERABLE property. */
  readonly id: string;
}
```

The resolved form the wrapper hands an executor carries more, but those properties are
**non-enumerable** — same technique as the resolved-definition snapshot — so `JSON.stringify`, the
events journal, and `inputs_json` / `outputs_json` all see `{ id }` and nothing else:

```ts
interface ResolvedSession extends SessionRef {
  /** non-enumerable */ mode: "append" | "fork";
  /** non-enumerable */ providerSessionId?: string;
  /** non-enumerable, lazy */ messages: () => Promise<ModelMessage[]>;
}
```

**`messages` is lazy because the cheap path never needs it.** A native-fork adapter (Claude Code)
branches server-side off existing history and reads zero messages. Only replay strategies materialize
the transcript.

**`messages` is a cache, never the source of truth.** Non-enumerable properties are dropped by object
spread, `JSON.parse(JSON.stringify(x))`, deep-clone helpers, and the Electron structured-clone IPC
boundary. Since `fork` is expressed at the consumption site, somebody will eventually write
`{ ...session, fork: true }`. The executor must therefore resolve messages **from `id`** and use an
attached accessor only if present. Losing it must cost a store read, never correctness.

### Requesting a fork

`fork` is expressed where a session is **consumed**, not carried on the value produced. A position
marker should not encode an intent about how a later caller will use it.

```jsonc
{ "session": { "expr": ".children.plan.operation.outputs.session" }, "fork": true }
```

| `fork` | Meaning |
| --- | --- |
| absent or `false` | Append if the position is still the head; fork automatically if it is not |
| `true` | Always fork. **Skips the reservation entirely** — the answer is already known |

**`false` and absent are the same thing**, deliberately. A stricter reading — "append, and error if a
fork would be required" — would mean the caller holds an exclusivity claim on the position, and
enforcing that is state the prompt executor must not carry (§6). With a stateless executor, a call is
just *given a position, produce a result and a new position*; if the position is no longer the head,
forking is the only answer that means anything. `true` remains useful because deliberate divergence —
fan three variants out from one point — cannot be inferred from stream state.

---

## 4. Resolution

For a prompt operation, in order:

1. `session` present with a value → use it.
2. `session` present and **`null`** → new `root` session. This **beats the environment**.
3. `session` absent → inherit `environment.session` (nearest-wins merge, WORKFLOWS.md §5).
4. Neither → new `root` session.

Notes for the implementer:

- **`""` is an error, never "fresh".** Prompt templates interpolate `{{.inputs.*}}`; a bad ref
  resolving to an empty string would otherwise silently produce an isolated conversation that *looks
  like it worked*. `null` is the only explicit "fresh" marker.
- **`null` must survive the environment merge as a value, not as absence.** A child's `null` overrides
  an ancestor's session; an *absent* key inherits it. Most merge implementations conflate the two.
- **Normalize `sessionId` → `session` before merging**, or a child's `sessionId: null` will sit
  alongside an ancestor's `session: "planning"` instead of overriding it (REFERENCES.md flags this
  hazard for the non-null case already).
- **Absent no longer means `"default"`.** [`DEFAULT_SESSION`](packages/shared/src/conversation.ts)
  goes away as an implicit fallback; an undeclared op gets its own session. `"default"` remains
  reachable by writing it explicitly. This is a deliberate behaviour change — an implicit
  process-wide shared transcript is the thing driving unbounded context growth.
- **An unresolvable id is an error** — unknown, pruned, or belonging to another task. Never
  silently create, which would turn a typo into a plausible-looking result.

### Resolution is instance-scoped

**Critical invariant.** The resolved position for an inherited `environment.session` must be derived
**per instance, from the parent instance**, never from a global name → head map.

This is what makes retry work. Restart a failed state and its input binding re-resolves to the same
position; the position has since been appended to (by the failed attempt), so it forks — automatically,
from exactly the right place. With a global head pointer, a restart would resolve to the post-failure
head and stack the retry on top of the failure, which is precisely the outcome the model avoids.

A fan-out follows from the same invariant: each child inherits the parent's position, the parent's is
unchanged, and nothing is last-write-wins.

---

## 5. Fork detection — reserve, then call

The check happens **before** the request is handed to the provider, because *is this a fork* and *how
do I shape the request* are the same decision. A fork must replay history and must **not** pass a
resume handle, or it appends to the wrong remote stream. Decided anywhere else, the two can disagree.

**The pre-check must reserve the position, not observe it.** A peek leaves a TOCTOU window the length
of the whole model call. Two ops both see head == 14, both conclude "linear append", and one clobbers
the other. Survivable if both replayed — the loser forks on the way out. **Not** survivable if the
winner took the resume-by-handle fast path, because by the time it loses it has already appended
remotely and there is nothing to retroactively fork.

**AS BUILT: the reservation is `PRIMARY KEY (session_id, seq)`.** Not a lock, and not a
reserve-then-release pair — the record IS the claim.

Protocol:

1. `withSessionPosition` resolves `ctx.sessionRequest` to `(session, position)`.
2. If `fork: true` → mode = `fork`, and no check is needed: the answer is already known.
3. `withRecord`, composed inside it, writes a STUB record at that position — `result` NULL, so a call
   in flight is visible and a crashed one leaves evidence. A duplicate key means the position is held.
4. The call runs; the stub is filled in on return, **success or failure**.
5. A `PositionTaken` failure travels back to `withSessionPosition`, which forks and retries ONCE.

This is better than the in-process lock this section originally proposed in the way that matters: a
lock is not durable and does not span processes, and the `jobs` table's one-process-per-run guarantee
is a fact about now, not about the row that outlives the run. It also removes the release entirely —
there is nothing to leak, so the "leaked reservation pins the stream" failure cannot happen.

⚠️ **Draws retry; sessions FORK.** findmyprompt's `appendDraw` answers the same unique violation by
recomputing `MAX(index)` and retrying at the next slot. That is right for a draw list, whose order
commits to nothing, and wrong here: appending at 15 instead of 14 continues a conversation containing
a turn this call never saw. Both call sites say so, because the two look identical.

---

## 6. Layering — shared policy, per-executor mechanism

**The prompt executor is stateless.** It holds nothing across calls: no stream ownership, no cached
head, no notion of "this session is mine". Every call is *given a position, produce a result and a
new position*. All durable state lives in the store; the reservation (§5) is call-scoped, owned by the
wrapper, and released unconditionally. Anything that would require the executor to remember something
between calls — including a strict-append mode (§3) — is out of the model, not merely unimplemented.

**The wrapper keeps the policy. The executor owns the mechanism.** AS BUILT that is THREE layers, not
two, and the split is forced rather than chosen:

```
withMemoize( withSessionPosition( withRecord( core ) ) )
```

| Layer | Package | Owns |
| --- | --- | --- |
| `withSessionPosition` | `exec` | Resolve `ctx.sessionRequest` → `ctx.session`; fork on `PositionTaken`; detect divergence (§11); report the effective END position |
| `withRecord` | `exec` | Claim the position by writing a stub; fill it in on success AND failure |
| `withSession` | `promptop` | The above, plus the two things only the llm layer knows: reading a session out of an op's config, and projecting an `LlmOutput` back down |
| Executor | — | Shape the request, perform the fork, report the handle it ended in |

**Why the policy is in `exec` and not `promptop`.** `hw` is where the request comes from, and it
cannot depend on `promptop`. A delegated agent needs resolution and forking exactly as much as a
prompt op does, so putting them in the llm layer would have left the one runtime with a native fork
primitive unable to reach it.

**Two seams, not one.** `ctx.sessionRequest` is what the caller WANTS — which conversation, whether
to branch. `ctx.session` is where it resolved to. A requester knows the first and must not know the
second, because only the store knows where a conversation currently is.

The decision reaches the executor via **`ExecServices`**, not by rewriting the op's config, which is
what hardcoded replay and forced `providerSessionId` to be refused outright.

⚠️ **Where the projection happens is a decision, not an accident.** Narrowing an `LlmOutput` to the
op's output value exists so everything above the executor speaks one vocabulary. Applied to the whole
RESULT it destroys the payload a session needs, and the layer that wanted it then has to smuggle it
back down — which is exactly how the `report` callback got invented. The core runs in record mode and
`withSession` projects on its way out, being the last layer that wants the payload.

`withSessionPosition` forces `sessionResume: true` in `capabilitiesFor` so an outer `withMemoize`
refuses to cache. A memoize composed INSIDE it keys on `id@position` (§6, Memoization).

### Strategies

Selected by adapter capability:

| Strategy | Providers | Append | Fork |
| --- | --- | --- | --- |
| **Replay** | Anthropic Messages API, anything via the AI SDK | Send full history | Free — a different key on the way out |
| **Native fork** | Claude Code / Claude Agent SDK | Resume by handle | `resume` + `forkSession`; record the **new** handle it returns. No replay cost |
| **Append-only remote** | Anthropic Managed Agents | Append by handle | **Cannot.** Abandon the handle; see §13 |

A fork must **never** inherit the parent's provider handle unless the adapter declares native fork —
otherwise two branches write into one remote session.

### Memoization

`withSession` currently inlines `messages` into the op config specifically so `withMemoize` keys on
real conversation content. Once messages are lazy and out of the config, the durable `call_memo` loses
that, and two calls with identical user text at different positions would collide.

**The memo key must include `id@position`.** The id is already a content commitment with a digest, so
this is a valid content proxy — but it must be wired deliberately, not noticed after a bad cache hit.

---

## 7. Transcript content

**Mirror the provider's full log, including tool calls, tool results, and everything else it considers
part of the transcript.** The stored log is the source of truth for replay, so fidelity wins over
clean cursor arithmetic.

Consequences:

- **The wrapper cannot synthesize the transcript.** It only sees `op.user` and a final result value —
  exactly the lossy behaviour this replaced. **The executor reports the delta**: the real messages
  exchanged plus the provider's own identifiers. This inverts who owns transcript content and is the
  single largest change in this document.

  **AS BUILT there is no channel for that report, because none is needed.** The RESPONSE is the delta:
  a prompt op's payload is an `LlmOutput` carrying `messages` verbatim, and the record stores that
  payload. A `SessionOutcome` channel exists only for an executor whose payload is NOT already a
  conversation — a delegated agent answers with text and keeps its transcript server-side, so it
  reports what it added and, critically, the provider session id it ended in.
- **ONE OPERATION IS ONE ENTRY.** This section originally said an operation appends many entries and
  that `[0:14]` counts ours rather than the provider's. As built the unit is the RECORD: a call that
  produced six turns advances a conversation by one, and `[0:14]` means "after fourteen calls". That
  is more consistent, not less — §8 already committed to per-operation forking, so this is the
  granularity the expression language exposes anyway, and there is no second numbering to reconcile.
  It remains true that a position must never be handed to a provider as an index.
- **Store `ModelMessage` verbatim, including `providerOptions`.** That bag is where provider-specific
  content lives (message level *and* part level), and some of it is load-bearing on return — an
  Anthropic reasoning part carries a signature that must come back byte-identical. Never round-trip
  through a lossier shape. In particular, the existing `{ role, content: string }` filter in
  [summary.ts](packages/runtime/src/summary.ts) must go; it silently drops anything with parts.
- **Repairs append.** The repair loop (up to 2 turns) produces turns the provider genuinely saw, so
  they are in its log and must be in ours. This is also correct on its own terms — the model needs to
  see its own bad output to fix it.
- **Append on error.** If the provider appended turns and the call then failed, those entries exist
  remotely. Not recording them means the next append-by-handle meets a remote head we do not mirror,
  which is divergence (§11) on the very next call. Fold the delta, mark the operation failed, release
  the reservation.
- **Retries fork, and nothing has to remember to do it.** Restarting a failed state re-resolves its
  input binding to the pre-failure position, which has since been appended to — so §5 forks. The
  failed branch is preserved for observability; the trunk stays clean and does not replay "here is
  your bad output, here is the error" into every later call.

Repairs append and retries fork because that is what the remote does in each case. Do not implement
them as two configurable rules.

---

## 8. The `operation.*` namespace

A state's operation is not currently addressable — its result lands directly in the state's declared
output slots — while a *child* is addressable via `children.<key>.outputs`. That asymmetry is why
engine metadata has nowhere to live. **Give the operation node its own outputs.**

`operation` is **its own namespace**, not a child. Making it a child would perturb the instance tree
and make `run.cursor` / `run.position` / `sequence` ambiguous.

Add to the expression namespace table (WORKFLOWS.md §9): `operation.*` and
`children.<key>.operation.*`.

Shape is a **typed union** — common core on every kind, llm-only extras — so that
`operation.outputs.session` on a `ui` op is a load-time authoring error, not a runtime `undefined`:

| Field | Kinds | Notes |
| --- | --- | --- |
| `outcome` | all | mirrors `children.<key>.outcome` |
| `usage`, `cost` | all | previously reachable only through the events journal |
| `provider`, `model`, `attempts` | all | resolved values, post-repair |
| `session` | llm only | a `SessionRef` |

**`operation.outputs.session` is the END position.** You append *at* a position but do not know the
end until the provider resolves, so the end marker is the only value that can exist when hw reads it —
and it is what consumers want ("append after me", "fork after me").

There is **no start marker**, deliberately. Recovery after an error does not need one: restart the
state and §4's instance-scoped resolution forks from the right place automatically.

Note the granularity: **authored forking is per-operation.** If one agentic op appends 40 entries, a
workflow cannot branch at entry 20. The store should still address finer positions so a human can
scrub a transcript in the UI, but the expression language exposes only operation boundaries.

State outputs may be `binding`s over `operation.outputs.*`; derived outputs already resolve
engine-side on termination (DESIGN §7.5), so much of that path exists.

---

## 9. Persistence

Sessions become durable **for observability**. The built schema
([db.ts](packages/persistence/src/db.ts)) currently has `task_runtime`, `runs`, `events`,
`command_log`, `jobs`, `artifacts`, `call_memo` — no conversation storage at all.

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,   -- opaque outside the store; globally unique
  label         TEXT,               -- derived display form, e.g. 'planning[0:14]/b'
  parent_id     TEXT REFERENCES sessions(id),
  parent_cursor INTEGER,            -- fork edges ONLY: prefix length taken from the parent
  edge          TEXT NOT NULL,      -- root | fork | compaction | resync
  digest        TEXT,               -- content commitment over the materialized prefix
  task_id       TEXT,
  run_id        TEXT,
  created_at    INTEGER NOT NULL
);

-- AS BUILT. `session_messages` and `session_providers` do NOT exist; this one table replaced both.
-- Modelled on findmyprompt's `generation_results`, which is where `OperationRecord` came from.
CREATE TABLE IF NOT EXISTS operation_records (
  session_id  TEXT REFERENCES sessions(id),   -- NULL for a record outside any conversation
  seq         INTEGER,                        -- position; counts OPERATIONS, not messages
  id          TEXT NOT NULL,
  source      TEXT,                           -- the OPERATION, not a resolved call definition
  inputs      TEXT,
  result      TEXT,                           -- NULL while PENDING (the two-phase write)
  metrics     TEXT,
  external_id TEXT,                           -- the provider's handle as of this record
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)                -- ...which IS the position reservation (§5)
);
```

Three corrections to what this section originally proposed, each of which deleted something:

- **A session is a VIEW over records, not a store.** There is no message table because a record
  already holds what its call produced. A record with no `session_id` — a plain memoized call — is an
  ordinary row in the same table.
- **`session_providers` modelled an impossible relation.** `(session, provider) → handle` is a
  many-to-many, and a conversation is LOCKED to the provider it was used with: using it with another
  is a fork. The handle is a property of what happened, so it lives on the record, and reading it at
  an earlier position reports what was true THEN — which is what makes §11's check possible.
- **`source` is the OPERATION, not a resolved call definition.** Operations are immutable over a run:
  a layer that adjusts one (a budget clamping `maxOutputTokens`) produces a NEW operation, so naming
  it is precise rather than lossy. Resolution that depends on the EXECUTOR — a `defaults ← preset ←
  inline` merge, a router picking a provider — is not in the op and belongs in a resolved-operation
  record written once per resolution, not copied onto every row.

- **Copy-on-write.** `operation_records` holds only what *this* session appended. Materializing =
  walk the parent chain, take each parent's entries below its `parent_cursor`, then this session's own.
  A recursive CTE handles it. Storage cost is proportional to divergence, not branch count.
- **`seq` continues from `parent_cursor`** on a fork, so a position is a single integer across the
  whole chain and `[0:n]` needs no translation.
- **The external handle is keyed by `(session, provider)`**, not by session. The same node replayed
  against the Messages API and against a `claude` subprocess has two unrelated handles and you want
  both cached.
- **Pruning already exists** (§12, `jaira prune`) and must learn about lineage. A session with
  children cannot be deleted independently without orphaning their prefixes. Pick one: prune whole
  lineages, prune leaves only, or materialize a child's prefix before deleting its parent.
- **Size.** Full tool history for an agentic adapter is not small — a real Claude Code session runs to
  megabytes of file contents and command output. It also means raw command output now lives durably,
  next to a `command_log` that records policy decisions about those same commands. Neither blocks the
  design; both are far cheaper to plan for than to retrofit.
- **Layering.** `@jaira/runtime` must not import `@jaira/persistence` (DESIGN §4.2a). The durable
  store is constructed app/CLI-side and injected via `ctx.sessions`, exactly as
  `SummarizingSessionStore` is today.

---

## 10. Provider reference

Verified behaviour of each backend, since the strategies in §6 depend on it.

**Anthropic Messages API** — fully stateless. No session id, no resume, no fork; you resend
`messages[]` every call. The only server-side state is the prompt cache, a strict prefix match with a
5-minute (or 1-hour) TTL — which *rewards* this design: two forks sharing messages 0–13 share cache
reads, and rewriting history invalidates everything after the edit point.

**Claude Agent SDK / `claude` CLI** — has exactly the primitive we want. `resume: <sessionId>` plus
`forkSession: true` starts a **new session id seeded with a copy of the original's history, leaving
the original untouched**. The new id is on the result message (and, in TS, on the init system message).
Transcripts are JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>`
is the absolute working directory with every non-alphanumeric character replaced by `-`; a resume from
a different cwd silently starts a fresh session. `listSessions()` / `getSessionMessages()` read
transcripts back — that is the `resync` read path. Forking branches the conversation, **not** the
filesystem.

**Anthropic Managed Agents** — real server-side sessions (`sesn_…`) with an append-only event stream
and `events.list` for history, but **no fork**. A session cannot be created from another session's
event N. `initial_events` on create accepts at most 50 events and **only** `user.message` /
`user.define_outcome` — no assistant or tool events — so a mid-conversation branch cannot be
faithfully reconstructed. It also compacts server-side on its own
(`agent.thread_context_compacted`), which is a live source of divergence (§11).

**Vercel AI SDK** — no server state by design; `messages: ModelMessage[]` in, `chatId` is an
application-level routing token, and `resumeStream` resumes an in-flight *stream*, not a conversation.
`ModelMessage` is the provider-neutral core with `providerOptions` as a namespaced sidecar at message
and part level — which is exactly the portable-core-plus-per-provider-extras shape this design wants,
one level down.

---

## 11. Divergence

The remote can move without us: Managed Agents compacts server-side, a Claude Code session can be
resumed outside JaiRA. Then the remote head has advanced or its history was rewritten, our mirror is
stale, and the digest no longer describes what the provider will actually send.

**On detected divergence: log an error, then start a new session with a `resync` edge, contents
re-read from the provider.** Do not silently continue — the id is a content commitment, and the same
reasoning that makes an unresolvable id an error applies here.

Detection: verify on handle-append rather than trusting it. Re-sync requires a provider *read* API,
which is per-adapter — Claude Code has `getSessionMessages()`, Managed Agents has `events.list`, the
Messages API has neither (and, being stateless, cannot diverge). Where no read API exists the new
session starts **empty** rather than re-synced, and that must be visible on the edge rather than
silent.

**AS BUILT the check is exact rather than heuristic.** We resumed a handle; the call reports the one
it actually ran in; on an APPEND those must agree. That comparison only became possible once the
handle moved onto the record (§9) — the `(session, provider)` map this document originally proposed
could not express "what was true at position 14" and therefore could not notice a change at all.

A **fork is exempt**. A new handle is exactly what a native fork returns, so treating that as
divergence would resync on every branch — and from the outside the two are indistinguishable unless
you remember which one you asked for.

A read that THROWS still resyncs, emptily. Losing the conversation is bad; carrying on against a
mirror known to be wrong is worse.

---

## 12. Contract changes

Some of this is upstream (`@declarative-ai/exec`, `@declarative-ai/promptop`). JaiRA has precedent for
owning a store when upstream does not fit (`SummarizingSessionStore`), but the wrapper should stay
upstream — fork it only as a last resort.

**AS BUILT — `@declarative-ai/exec`:**
- `SessionStore` is `resolve` / `fork` / `messages` / `compact?` / `resync?`. NOT the `get`-returning-
  an-effective-id this section originally asked for: `get`/`put` can only OBSERVE, and §5's own TOCTOU
  argument rules that out. A store that had to fork reports it on the resolved session.
- `ExecServices` carries `sessionRequest` (what the caller wants), `session` (where it resolved),
  `records`, `sessionReader`, and `onDivergence`.
- `withRecord` + `withSessionPosition` — the two-phase write and the resolve/fork policy, both here
  rather than in `promptop`, because `hw` needs them and cannot depend on that package.
- `OperationRecord` (in `ops`) gains `session?: { id, seq }`.
- **No `SessionState`, no `SessionDelta`, no `SessionLease`.** All three were scaffolding for a
  message store that turned out not to be needed.

**`@declarative-ai/promptop` — `wrappers.ts`:**
- `withSession` stops rewriting the op config with inline `messages`; passes the resolved session via
  services instead.
- Stops synthesizing the fold from `op.user` + stringified result. It folds NOTHING now — `withRecord`
  writes the record, and the response already carries the delta.
- Records on failure as well as success.
- Reports the **effective END** position on the outcome rather than echoing the input key.
- Stops hard-refusing `providerSessionId`.
- Projects the `LlmOutput` on its way out, over a record-mode core (§6).

**`@declarative-ai/hw`:**
- States `ctx.sessionRequest` for BOTH prompt and function ops, and resolves none of it.
- **Stops writing transcripts entirely.** Its synthesized user + stringified-assistant pair was the
  second of two mechanisms doing one job; with a session layer composed, both would write to the same
  position and the loser would fork. Only the read remains, for `{ conversation }` bindings.

**`@declarative-ai/agents-api`:**
- `resume` + `forkSession` on the query seam; `sessionId` on the result; `sessionResume: true`.
- `AgentSessionReader` — the provider read API §11 needs.

**JaiRA:**
- New `sessions` and `operation_records` tables and a durable store
  ([persistence](packages/persistence/src)) — see §9 for why the other two do not exist.
- `DEFAULT_SESSION` no longer an implicit fallback
  ([conversation.ts](packages/shared/src/conversation.ts)).
- `SummarizingSessionStore` becomes a **compaction-producing** store: emit a new session with a
  `compaction` edge instead of mutating in place, and drop the `{ role, content: string }` filter
  ([summary.ts](packages/runtime/src/summary.ts)).
- `operation.*` in the expression resolver, the load-time reference lint, and WORKFLOWS.md §9.
- Pruning learns about lineage.

### The `summary` / `full_history` lint

[`conversationModesOf`](packages/shared/src/conversation.ts) detects conflicts by grouping *authored*
state files by static session name. Once sessions are runtime values you cannot statically tell which
states share one, so that lint degenerates.

Preferred fix: make conversation mode a property of the **session**, not the state. DESIGN already
says compaction is per-session and treats a state-level declaration as an authoring hazard, so this is
where it belonged. Failing that: lint what is statically visible and detect the real conflict at
runtime, when a session carrying a summary mode receives a `full_history` write.

---

## 13. Known limits

State these; do not try to engineer around them.

- **Managed Agents cannot mirror a fork.** The remote is append-only with no fork, and
  `initial_events` refuses assistant and tool events. We fork, the remote cannot follow, and the new
  remote session starts thinner than ours. This is the one place the governing rule (§1) cannot be
  satisfied, and it is inherent to the provider.
- **Forks share a worktree.** Forking branches the conversation, not the filesystem — the same
  constraint Anthropic documents for `forkSession`. **JaiRA does not fork worktrees.** So forks are
  for replay, observability, and provider portability — *not* for speculative "try two approaches and
  compare". Write this down; upstream leaves a per-branch workspace isolation hook open
  (`Workspace` is documented as a Session-owned resource that a fan-out *may* isolate) and someone
  will otherwise wire it up by accident.
- **Fan-out determinism.** Structural fan-out is deterministic because the engine controls dispatch
  order. Two states in unrelated subtrees receiving the same id through data flow are ordered by
  arrival, so which one keeps the trunk depends on completion order. Derive fork ids from stable
  inputs (child key + iteration, or a content hash) rather than random UUIDs, or lineage names change
  between runs and the observability this exists for gets worse.
- **Cross-provider replay is best-effort.** `providerOptions` is namespaced and ignored by other
  providers, which is what makes replay work at all — but provider-specific reasoning content does not
  transfer, and Fable-family thinking blocks are dropped outright by other models.

---

## 14. Open items — RESOLVED

1. **Label spelling for `compaction` / `resync` roots.** → `planning~compact1` / `planning~resync1`.
   Naming the EDGE rather than a bare generation counter means a reader can tell a provider re-read
   from a summary without querying the table, and neither can be mistaken for the `[0:n]` prefix
   assertion, since no cursor appears.
2. **Session scope.** → **No scope check at all.** An id is a capability: hold one and you may use it.
   Only unknown and pruned ids are errors, so §4's "belonging to another task" is not a rejection
   reason. That puts all the weight on lineage-aware pruning, which becomes the only thing in the
   system that can invalidate a held id.
3. **`messages` supplied vs derived.** → **Derived only.** The lazy accessor on the resolved session
   is how a caller that needs them gets them: replay for a provider with no server-side session, and
   fork-by-messages. Not a user-supplied seeding override.

### One decision this document did not anticipate

**The RESOURCE BUNDLE separates from the conversation.** One `sessionId` used to key both the
transcript and the workspace / permission ledger / `"session"`-scoped approval scope. Those cannot
share a key once a session is a POSITION, because a position moves on every call — a `"session"`
approval would cover exactly one operation, and every fork would ask for its own worktree, which §13
rules out.

So the resource key is the **declared** session, inherited from the enclosing instance when an
operation declares none. A fork, a retry and a loop iteration all change where the conversation is;
none of them changes what the author declared, so all three keep one worktree and one set of
approvals. That is also the answer to "states get replayed and looped, so how do you tell the
iterations apart?" — the resource key was never derived from the iteration.

---

## 15. Implementation order — ALL NINE DONE

Each step was independently reviewable, and the order held. Two notes for anyone reading this as a
record rather than a plan:

- **Step 4 was the gate, as predicted, and it was also the step that was wrong.** The contract it
  describes below (`get` returning an effective id, a delta folded through a channel) is not what
  shipped; see §5, §6, §7 and §12. The rework that followed touched only the plumbing — positions,
  forking, copy-on-write, lineage, digests and pruning were all unaffected.
- **Steps 6 and 7's second half arrived out of order.** Compaction landed with step 4 because the
  lease-based contract left no `put` to compact on; step 7's wiring landed after step 8's design was
  already clear, because a delegated op turned out never to reach the session layer at all.

⚠️ **The bug worth remembering:** `withSession` read the session off the op's CONFIG, which `hw`
consumes as an `OPERATION_OWN_FIELD` before lowering. So the path only ever worked for standalone
`promptop` use — which is exactly what its tests exercised. Every test passed; production was unwired.

1. **Storage.** Tables, the copy-on-write materializer (recursive CTE), lineage edges, digest. No
   behaviour change — just a durable store nothing reads yet.
2. **Session reference + resolution.** `SessionRef`, the four-way resolution order, `null` handling,
   `""` rejection, instance-scoped resolution, `DEFAULT_SESSION` removal.
3. **`operation.*` namespace.** Typed union, resolver, load-time lint, WORKFLOWS.md §9. Ship it with
   `outcome`/`usage` before `session` exists — it is independently useful and de-risks the
   expression-layer change.
4. **Upstream contract changes.** `SessionStore.get` returning an effective id; `ResolvedSession` on
   `ExecServices`; `withSession` folding an executor-reported delta.
5. **Replay strategy.** Get the whole loop working end to end against the Messages API / AI SDK path,
   including reserve-then-call, fork-on-conflict, append-on-error, and the memo key change.
6. **Compaction as a new session.** Rewrite `SummarizingSessionStore`; drop the `Turn` filter.
7. **Native fork strategy.** Claude Code `resume` + `forkSession`, handle recording, cwd-bound
   transcript caveats.
8. **Divergence detection and `resync`.** Needs the provider read APIs from step 7.
9. **Pruning.** Lineage-aware.

Steps 1–3 are additive and land safely on their own. Step 4 is the blocking upstream change; nothing
past it works without it.
