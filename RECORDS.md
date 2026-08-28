# Records — one conversation, stored once

**Status: BUILT.** `entries` is the record's conversation; `messages`, `thinking`, `toolCalls`,
`toolResults`, `sidechains`, `nativeLines` and `nativeSidechains` are gone from the contract
entirely — not deprecated, not read as a fallback — and every one of them is derived on read.
Replayed over run 11's own records, the same 17 operations store **3.83 MB instead of 10.44 MB —
63% less**, with nothing lost. Upstream 2232 tests and JaiRA 2810 pass.

The transcript's role-and-order weave is deleted with them: §1's join no longer has to be guessed on
every read, because the capture merges into the entries once, at close. What reaches the reader is
events, spliced by the index they were always stamped with.

One word, stream to store. What the live turn accumulates and what the record holds are the same
things at two moments, so both are `entries` — `TurnDelta.entry`, `session:turn.entry`,
`LiveTurnSnapshot.entries`, `value.entries`. They were "items" on the way in and "entries" once
stored, which made a translation out of what should be an append, and made two people describing the
same field to each other take four rounds to notice they agreed.

The measurements below are from that run (17 agent operations, the `feature` workflow), read out of
`.jaira/system/jaira.db`.

Four things the implementation found that this document did not anticipate:

- **Normalizing on the way IN breaks replay.** The first cut translated every provider part into the
  neutral block vocabulary, and `wrappers.test.ts` caught it: an Anthropic reasoning part carries a
  signature under `providerOptions` that has to come back byte-identical, and the AI SDK's `"tool"`
  role was being flattened to `"user"`. Content and role are stored VERBATIM now, and
  `blockOfPart` normalizes on READ — the wire gets the provider's shape, the projections get one
  vocabulary, and only one of the two can be the stored one.
- **A bare-string `content` is not the same as one text part.** Same rule, smaller case: providers
  use both spellings and both go back on the wire, so `MessageEntry.content` is `Block[] | string`
  and `blocksOf` is where a reader stops caring.
- **The signature arrives beside the message, not inside it.** The transport reports the block text
  on `message.content` and the provider metadata on a sibling `thinking[]`. A record keeping only
  the message replays a reasoning block the provider then refuses, so the two are married at the one
  point they are known to belong together — `signThinking`, in the stream loop.
- **`session_outcome_json` was the easiest 2.5 MB in the file.** Byte-identical to the payload's
  copy, sha for sha. It is dropped at the persist site whenever the payload carries the
  conversation, and kept whole when it does not — a value-mode core or a scripted fake has no other
  turns.
- **Removing a field removes the thing that MARKED it.** Recovery found un-captured records by
  looking for the absence of `nativeLines`; with the field gone, a re-open would have re-read every
  agent's files forever. The fold states when it happened (`capturedAt`) rather than being
  recognized by a leftover — which is the honest version of what the old test was really asserting.
- **The recovery path had to be inverted, not ported.** `foldNativeCapture` used to spread a capture
  onto a payload, which only worked while the capture WAS a field. Merging into entries is the
  runtime's rule and persistence must not import the runtime, so the store now takes a `fold`
  function, hands it the record's value, and stores what comes back.

An operation record stores what a call was asked and what it answered. It USED TO store the
answer three times over in three different encodings, plus two derived indexes that were
100% recoverable from one of them. The declared outputs — the part a workflow actually
binds to — were **2.4%** of the stored bytes:

| | bytes |
| --- | ---: |
| declared outputs (`result_json` → `value.value`) | 262,144 |
| `result_json` total | 8,344,594 |
| `session_outcome_json` total | 2,601,054 |

The format that replaced them is **one `Entry[]` per conversation**, provider-neutral in its core,
honest about what it does not recognize.

Migration of existing records was out of scope and there is no back-compatibility path: a record
written before this holds fields the code no longer knows. The store was erased rather than
migrated.

---

## 1. Why

Take one record as it was — `#i10:0`, the first `product/draft` call, 894,771 bytes:

| field | bytes | what it is |
| --- | ---: | --- |
| `value.messages` | 269,008 | byte-identical to `session_outcome_json.messages` (sha-verified) |
| `value.nativeLines` | 227,019 | Claude Code's session `.jsonl`, captured verbatim |
| `value.toolResults` | 146,578 | 21/21 reconstructible from `messages` |
| `value.sidechains` | 80,755 | the subagent's messages, keyed by `tool_use` id — 787,044 b across the run's four subagent records, against 192,986 b of `nativeSidechains` saying it again |
| `value.thinking` | 51,855 | 11 entries against 11 `thinking` blocks in `messages` |
| `value.toolCalls` | 30,778 | 21/21 reconstructible from `messages` |
| `value.value` | ~15,000 | the declared outputs |

Three things were wrong here, and only one of them was about bytes.

**The same conversation is encoded three times.** `messages` (normalized), `nativeLines`
(the agent's own file), and `session_outcome_json.messages` (again, verbatim). Inside
`nativeLines`, `toolUseResult` is 140,638 b — 62% of it — and its payload is the same text
as the corresponding `tool_result` block, differing only by a `N\t` line-number prefix.

**Two of the fields are indexes, not data.** `toolResults` is `{toolCallId, output}`, which
is exactly the `tool_result` block's `{tool_use_id, content}`. `toolCalls` is
`{toolCallId, toolName, input}`, and the `tool_use` block carries *more* (`caller`).
Verified 21/21 on both.

**The join between the encodings does not exist in the data.** A captured line carrying a
`toolUseResult` has no `tool_use_id` — only `sourceToolAssistantUUID`, pointing at an
assistant line whose body was stripped on capture (`nativeSession.ts:243`, "The body rode
the stream"). So the reader cannot join them by key, and does not try. From
`transcript.ts:660`:

> Paired by ROLE AND ORDER rather than by the stored index, deliberately: the file has
> message lines the stream never carried (the prompt itself), so index arithmetic against
> the turns is off by one the moment a run begins, and drifts further every time the
> agent's vocabulary grows.

That heuristic existed *only because* the two encodings were separate. It was the real cost, and
merging them is what removed it — `transcript.ts` has no weave now.

### The governing rule

**One conversation is one array.** Everything an operation's call produced is a sequence of
entries in provider-neutral shape, with what does not map kept verbatim beside it. A field
that can be computed from that array is computed, not stored.

---

## 2. Entries

```ts
interface BaseEntry {
  uuid: string;
  parentUuid?: string;
  timestamp: string;                    // ISO 8601
  /** Subagent membership. Absent = main chain. */
  sidechain?: { id: string; parentToolUseId?: string };
  provider: string;                     // "anthropic" | "openai" | …
  /** ONLY fields with no home above. Never a copy of a hoisted field, and never a
   *  per-record invariant (see §6) — those live once, on the record. */
  providerData?: Record<string, JsonValue>;
}

interface MessageEntry extends BaseEntry {
  kind: "message";
  role: "user" | "assistant";
  content: Block[];
}

interface EventEntry extends BaseEntry {
  kind: "event";
  /** Open vocabulary by design — see §3.2. */
  event: { type: string; data?: JsonValue };
}

type Entry = MessageEntry | EventEntry;
```

### 2.1 There is no index field

`nativeLines` today is `{index, line}[]`, and `index` is not the array position. From
`nativeSession.ts:249`:

```js
if (ownMessage) index += 1;
```

It increments only on own-chain message lines, so it means "how many main-chain messages
precede this line" — a foreign key into the *messages* array. It exists to bridge two
representations. With one array it has no job: position is the order, and `uuid` is the
identity that lets a live-streamed entry and a captured one be merged without duplicating.

### 2.2 Events are entries, not a second channel

Of 93 captured lines in `#i10:0`, **28 are not messages**:

| line type | n | bytes | what the reader does with it |
| --- | ---: | ---: | --- |
| `attachment` | 7 | 38,074 | renders `context: <type>` |
| `queue-operation` | 2 | 15,432 | renders `queued: <op>` |
| `ai-title` | 10 | 1,468 | names the conversation (`agentTitleOf`) |
| `last-prompt` | 9 | 3,239 | nothing — "Stored faithfully, told never" |

Drop `kind: "event"` and those are lost. Two of them are rendered in the transcript today
and a third names the conversation, so the format needs both kinds.

Two capture-time cleanups the reading code already justifies: stop capturing `last-prompt`
(stored, never shown), and keep only the **last** `ai-title` — the agent re-emits it at
every checkpoint, "57 identical lines in one observed file" (`transcript.ts:711`).

---

## 3. Blocks

```ts
interface TextBlock       { type: "text";        text: string }
interface ThinkingBlock   { type: "thinking";    thinking: string; signature?: string }
interface ToolUseBlock    { type: "tool_use";    id: string; name: string;
                            input: JsonValue; caller?: string }
interface ToolResultBlock { type: "tool_result"; toolUseId: string; isError?: boolean;
                            data?: JsonValue; text?: string }        // §4

/** Any block this version has no case for — stored exactly as the provider sent it. */
interface OtherBlock { type: string; [k: string]: JsonValue }

type KnownBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;
type Block = KnownBlock | OtherBlock;
```

### 3.1 The unrecognized block keeps its own type

A provider that starts emitting `{type: "new_feature", newData: 2}` must be stored as it
sent it. No synthetic `type: "unknown"` tag: the stored data would then be a claim the
provider never made.

### 3.2 …and the type system still forces a fallback

Putting `OtherBlock` in the union naively breaks the *known* cases, because
`OtherBlock.type: string` is assignable to every literal. Measured under `--strict`:

```
Property 'toUpperCase' does not exist on type 'string | number | boolean | ...'
```

`case "text":` narrows to `TextBlock | OtherBlock`, so `b.text` stops being a string.

The shape that works moves discrimination into a guard:

```ts
const KNOWN_BLOCKS = ["text", "thinking", "tool_use", "tool_result"] as const;
const isKnownBlock = (b: Block): b is KnownBlock =>
  (KNOWN_BLOCKS as readonly string[]).includes(b.type);

function render(b: Block): string {
  if (!isKnownBlock(b)) return renderGeneric(b);   // structurally unskippable
  switch (b.type) {
    case "text":        return b.text;             // precise
    case "thinking":    return b.thinking;
    case "tool_use":    return b.name;
    case "tool_result": return b.toolUseId;
    default:            return assertNever(b);
  }
}
```

Verified: `render` compiles clean under `--strict`, and removing a known case produces
exactly one error — `Argument of type 'ToolUseBlock' is not assignable to parameter of type
'never'`. The guard is the forced fallback; `assertNever` is the missing-case alarm.

This mirrors a policy the reader already holds deliberately — unknown line types are
rendered rather than filtered, because "a filter here would quietly shrink the transcript
every time [the vocabulary] grew" (`transcript.ts:713`).

Entries need no equivalent: `EventEntry.event.type` is a bare `string` with no sibling
literals to be confused with, so nothing degrades.

---

## 4. Tool results

A tool result has two faces: what the model saw, and what the provider recorded. They are
not the same, and neither derives from the other in general.

| case | rendered (what the model saw) | structured |
| --- | --- | --- |
| Glob, no matches | `"No files found"` | `{"filenames":[],"durationMs":258,"numFiles":0,"truncated":false}` |
| Grep, bad path | `"<tool_use_error>Path does not exist: …</tool_use_error>"` | `"Error: Path does not exist: …"` |
| Read | `"1\t# Product features\n2\t\n3\tStanding doc…"` | `{"type":"text","file":{"filePath":…,"content":"# Product features\n\nStanding doc…","numLines":39,"startLine":1,"totalLines":39}}` |
| StructuredOutput | `"Structured output provided successfully"` | identical string |

The Glob case has prose that exists nowhere in the structured form; the structured form has
`durationMs` and `truncated` that exist nowhere in the prose.

```ts
interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  isError?: boolean;
  /** The provider's structured record, when it kept one. */
  data?: JsonValue;
  /** What the model saw. Absent when a renderer covers `data`'s shape (§4.2). */
  text?: string;
}
```

At least one is present. Discriminated by presence — no `kind` tag.

`text` matters beyond display: `defaultMessagesOf` reads `record.result.value.messages`, so
the record's entries are what the session store materializes, which is what
`conversationPreamble` replays verbatim in `full_history` mode.

### 4.1 The shapes that occur

192 `toolUseResult` entries across the run, in 10 shapes:

| n | bytes | shape | tool |
| ---: | ---: | --- | --- |
| 83 | 938,427 | `file+type` | Read |
| 37 | 93,896 | `content+filenames+mode+numFiles+numLines` | Grep |
| 26 | 3,081 | *(bare string)* | — |
| 17 | 90,936 | `appliedLimit+content+filenames+mode+numFiles+numLines` | Grep |
| 7 | 14,879 | `interrupted+isImage+noOutputExpected+stderr+stdout` | Bash |
| 6 | 11,500 | *(bare array)* | — |
| 6 | 3,136 | `filenames+mode+numFiles` | Glob |
| 4 | 32,263 | `agentId+agentType+content+prompt+status+toolStats+totalDurationMs+totalTokens+usage` | Task |
| 4 | 707 | `durationMs+filenames+numFiles+truncated` | Glob (empty) |
| 2 | 196 | `matches+query+total_deferred_tools` | ToolSearch |

`data` is not always a record — 26 bare strings and 6 bare arrays.

### 4.2 A renderer registry, keyed by shape

Where a structured shape fully determines what the model saw, `text` is **not stored** and
is re-rendered on read. This is declared per shape, not decided per record.

Keyed by **shape, not tool name**, for three reasons the data gives: 84 `Read` calls
produced 83 `file+type` entries, so a tool does not always yield its shape;
`mcp__dai__read_file` is a second tool that plausibly yields the same one; and the captured
result carries no tool id to join on anyway (§1).

The first entry, covering 43% of all `toolUseResult` bytes in the run:

```
shape:  { type: "text", file: { filePath, content, numLines, startLine, totalLines } }
render: f => f.content.split("\n")
              .map((l, i) => `${(f.startLine ?? 1) + i}\t${l}`)
              .join("\n")
```

Verified against every file read in the run: **82 of 83 reproduce byte-for-byte**. No
left-padding — zero matched a padded variant. The 83rd is not a rendering failure: it is a
memory-file read whose result never appeared as a `tool_result` block at all.

All 83 `file+type` entries carry `type: "text"` and a string `file.content`, with no
exceptions, so the shape is self-identifying.

Anything without a registered shape stores `text` as it came. That is the fail-safe
direction: a new tool, a new provider, or an unrecognized variant costs bytes, never
fidelity.

**The renderer is an assumption, so pin it.** Nothing compares the re-render against the
original at capture time. Hoist Claude Code's `version` onto the record (§6) — it is
already stamped on every captured line — and select the renderer by it. A format change
then shows up as a version delta to re-verify rather than as silent divergence in what a
replayed run sees.

---

## 5. Sidechains

A subagent conversation is stored twice today, under two different keys:

- `sidechains` — keyed by `toolu_012Js…`, the spawning `tool_use` id; a 57-message array, 80,720 b
- `nativeSidechains` — keyed by `agent-a730293e…`, the agent id; `{agentId, meta, lines}`, 76 lines, 42,954 b

Same conversation, two encodings, two key spaces, and no join between them. It is §1's
problem again one level down, and it dissolves the same way: a subagent's entries are
ordinary `Entry`s carrying

```ts
sidechain: { id: "agent-a730293e…", parentToolUseId: "toolu_012Js…" }
```

which holds both keys on one object. Whether they live inline in the parent array or in a
sibling map is an implementation choice; the identity is the same either way.

---

## 6. Per-record invariants

Six fields are stamped on every captured line and have one or two distinct values across
the whole record:

| field | lines carrying it | distinct values |
| --- | ---: | ---: |
| `sessionId` | 93 | 1 |
| `cwd` | 72 | 2 |
| `version` | 72 | 2 |
| `gitBranch` | 72 | 2 |
| `entrypoint` | 72 | 2 |
| `userType` | 72 | 2 |

12,978 bytes, 6% of `nativeLines`, to say the same six things ninety-odd times. They belong
on the record, once. `version` earns its place twice over as the renderer pin (§4.2).

These are host and provider facts, not properties of an entry. Nothing in `providerData`
may repeat them.

---

## 7. What this removes

`toolResults`, `toolCalls`, `thinking`, `nativeLines`, `nativeSidechains`, `sidechains`,
and the duplicate `messages` — replaced by one `Entry[]`, the per-record invariants, and a
renderer registry.

Measured against run 11:

| | bytes |
| --- | ---: |
| `messages` duplicated in `session_outcome_json` | ~2,601,054 |
| file-read `text`, re-rendered instead (82 reads) | 992,439 |
| `toolResults` + `toolCalls`, derived | ~1,200,000 est. |
| per-record invariants, hoisted | ~12,978 / record |

The 926,897 b of structured file data those 82 reads carry is **retained** — it is the
richer face, and the one the transcript renders.

---

## 8. The Ref layer — BUILT

Deduplication inside a record is most of the win, but not all of it. The same file read by
three loop passes is still three copies, and a `Read` of a 67 KB file appears once per pass.

A record should be generic over its leaves: **values in memory, refs on disk.**

```ts
type Record_<T> = { input: T; output: T };
// stored:   Record_<Ref>     — content-addressed, hydrated in one batched resolve
// in memory: Record_<Value>  — no per-field lookups at runtime
```

Both open questions are answered, in `blobStore.ts` and migration 10:

**Scope: CONTENT-ADDRESSED.** Record-scoped needs no reachability question but misses exactly the
case that motivated the layer — the repetition is BETWEEN records, not within one. The GC that buys
lives where it belongs: `prune` releases a deleted run's references and sweeps what nothing names.
`refs` is a count rather than a flag, because two records sharing a blob is the point and deleting
one must not take the bytes the other still names. A leaf is a STRING over 1 KB and nothing else:
containers are mostly structure, structure is what differs between records, and a reference is 76
bytes, so below that a ref is a second copy with extra steps.

**Hydration: BATCHED, always.** `hydrate` collects every hash in one walk and reads them in one
statement, so a record costs two queries whatever it holds — pinned by a test that counts them. A
layer costing N queries to undo N copies has not saved anything. A hash with no row stays the
reference it is rather than becoming `null`: a missing blob is worth seeing, and silently emptying
it would make a pruned record look like one that said nothing.

The identity half already exists: `artifacts.hash` is a sha-256, "identity independent of
location". What is missing is a content-addressed table — today two artifacts with the same
hash are two rows, each carrying its own copy of `content`.

In memory, note that `Engine.artifacts` (`engine.ts:2705`) is push-only: artifact `content`
is held inline for the life of a run and never pruned on child supersede.

---

## 9. Open questions

- ~~**Does `session_outcome_json` survive?**~~ SETTLED: the payload owns the conversation, so the
  outcome's copy is dropped whenever the payload carries one and kept whole when it does not.
- ~~**`thinking` content equality.**~~ SETTLED by measurement: across all 17 records of run 11,
  every reasoning segment's text appears as a `thinking` block of the messages — 17/17 content-equal,
  not merely count-equal. 459,603 bytes of restatement.
- **Bash rendering.** `{interrupted, isImage, noOutputExpected, stderr, stdout}` holds the
  two streams separately; the rendered form interleaves them, and the interleaving order is
  not recoverable from the parts. It is not a registry candidate unless that ordering turns
  out to be captured somewhere.
- **Where sidechain entries live** — inline in the parent array, or a sibling map keyed by
  `sidechain.id`. Affects ordering semantics for the transcript weave.
