# Loops — a child is every pass it took

**Status: BUILT.** hw carries all of it (970 tests), the JaiRA side follows it (2817 tests), and
the authored workflows are migrated and lint clean at 79 states, 0 errors — with **all 31 backward
loops carrying the evidence that sent them back**, where none did before. The motivating evidence is
run 11 of task `t-1023xri08r`, since erased along with the rest of the pre-format store.

Four things the implementation found that this document did not anticipate:

- **`memberOf` refused to read an array's own properties.** Hanging the live pass's fields on the
  pass array — the trick `operationOutputOf` already uses to put `session` on a list return — did
  nothing, because `memberOf` answered `undefined` for every property of an array but `length`. So
  `.children.b.outcome` went quiet, a guard that had been true never fired, and the round loop spun
  synchronously with the whole test process wedged. Fixed at the source: an array answers `length`
  and then its own named properties, which is what the engine had been constructing all along.
- **`kind` on an operation output entry is ambiguous by arity.** A lone entry carrying it means "the
  whole return is this value"; the same entry beside a second one means "this field is bytes" — and
  reading it only when the map is short puts a cliff under the author, where adding an output
  silently rewraps the return. The load now REFUSES a `kind` on a multi-entry map and says where it
  belongs (§5).
- **The old single-slot spelling was a BARE return, and the map form is not.** Four authored states
  wired `.operation.output.exitCode` against `{"name":"result","schema":{…}}`. Re-keying that to
  `{result: {…}}` wraps it, so the migration had to add the explicit `kind` that says otherwise.
  Nothing warns when a wrapper appears; the binding just resolves to nothing.
- **Addressable history is not enough on its own.** It answers "what did the previous pass say"; it
  cannot answer "which of my three possible senders sent me back", because after a pass they all
  have a value at `[-2]`. That took a second change — §8 — and without it eleven of the workflow's
  loops had no honest wiring available.

A state that loops back to an earlier child re-runs it. That second pass USED TO be unable to see
the first: the sequence reset deleted the record before the new inputs resolved, so a
`prior_findings` wire that looked correct in the workflow file resolved to nothing, silently, on
every iteration. A child's history is addressable now — `.children.X` is the sequence of passes,
`.children.X[-1]` the current one — so a re-plan loop can be written as one, and §8 lets the rule
that fired say what it hands over.

---

## 1. Why

Run 11 spent 62 minutes and ended canceled at the product gate. Its `feature/product` state
ran `draft → critique` three times, then looped the whole `explore` block, then drafted
once more before the iteration cap forced it out.

The three drafts sent **byte-identical requests**:

| instance | request bytes | request sha |
| --- | ---: | --- |
| draft #1 (i10) | 15,849 | `f9797bbda5f5` |
| draft #2 (i12) | 15,849 | `f9797bbda5f5` |
| draft #3 (i14) | 15,849 | `f9797bbda5f5` |

Same prompt, three times, three independent samples. `feature/product/draft` declares no
findings input, so `product.json` has nothing to wire — the critique→draft loop has no
feedback channel at all.

The critique fared no better. `product.json` wires `prior_findings` from
`.children.critique.outputs.findings`, and the rendered prompt says:

```
## Findings from the previous pass

[empty]

If that is non-empty, this exploration is being re-opened because the critique
said the approach itself was wrong — not the execution.
```

Empty on all four critique passes and both `explore/brief` passes. The second brief's
request was byte-identical to the first (`c7acab0b62`), so the re-opened exploration was a
blind re-roll of the one that had just been rejected.

### 1.1 The wire is correct; the reset destroys it

`enterChild` (hw `engine.ts:1049-1063`) clears the target sequence member and every later
one, and only then resolves inputs:

```js
for (let i = seqIndex; i < sequence.length; i++) {
  const rec = instance.children.get(k);
  if (rec) { instance.children.delete(k); this.emit({ type: "child.superseded", … }); }
}
const resolved = this.resolveChildInputs(instance, decl);   // ← critique is already gone
```

The three `child.superseded` events at seq 195–197 are exactly `explore`, `draft`,
`critique` going away as `explore` is re-entered. `prior_findings` is optional, so
`resolveChildInputs` hits `continue` and the input is never set — no park, no error, no
diagnostic.

**This is general.** No backward transition to an earlier sequence member can carry a later
member's output back, because entering it destroys that output first. Any workflow that
tries reads as correct and does nothing.

### The governing rule

**A child is not its latest record; it is every pass it took.** `.children.X` is the
sequence, indexed by pass. The reset stops destroying history and starts appending to it.

---

## 2. The model

Each child key holds an array of pass records. One index across all children means one
pass, so `[-2]` compares like with like:

- a pass that ran regenerates the child's record at that index
- a pass that did not — a child before the jump target, or one outside the `sequence`
  altogether — carries its previous record forward, by reference, not by copy
- a child that has not run at an index has no value there

Sequence membership decides what the CURSOR walks, not what can run: a rule may name any declared
child, and entering a non-member deliberately leaves the cursor alone so the spine resumes where it
was (SPEC §3.3's `repair`). Such a child is never cleared by a reset either — the reset only names
members — so its record survives a pass boundary and reads the same at every index after it.

```
sequence: [context, explore, draft, critique]

pass 0   context₀   explore₀   draft₀   critique₀
pass 1   context₀   explore₀   draft₁   critique₁      ← looped to draft
pass 2   context₀   explore₂   draft₂   critique₂      ← looped to explore
```

`context` is carried forward at every index; `explore` is carried at index 1 and
regenerated at 2. `.children.draft[1]` and `.children.critique[1]` are the same pass, so a
critique can name the draft it judged.

### 2.1 Holes are absent, not null

A child with no record at an index reads as absent. Nothing special is needed to work with
that — `filter`, `last`, `at`, `find` and `isNull` already compose (`builtins.ts`,
`lowerExpr.ts:27`), so "the latest pass that produced findings" is an expression, not a new
primitive. Convenience wrappers can follow if the same shape appears in three workflows.

---

## 3. Addressing

```
.children.critique          the sequence of passes
.children.critique[-1]      the current pass
.children.critique[-2]      the pass before it
.children.critique.output   sugar for .children.critique[-1].output
```

### 3.1 Indexing is already built

`xs[-1]` is sugar for `at(xs, -1)`, negative indices included, emitting the identical AST —
expr.ts:460:

> SUGAR for `at(value, index)` and deliberately nothing more: the bracket emits the exact
> AST the call form parses to, so lowering, inference, static analysis and the interpreter
> all treat `xs[-1]` and `at(xs, -1)` as one expression — there is no second semantics to
> keep in step.

So the indexing half needs no grammar work.

### 3.2 The alias is one rule at one seam

It does **not** come free: `memberOf` returns `undefined` for every property on an array
except `length`, so once `.children.X` is an array, `.children.X.output` resolves to nothing
rather than falling through to the last element.

The landing site is singular. resolve.ts:314, on the `select` producer:

> `select` is the child-output projection and NOTHING else — the loader emits it in exactly
> one place, for `.children.<key>.outputs.<name>`

So implicit `[-1]` is one rule where that producer is emitted, plus the child producer edge.

### 3.3 A bracketed reference lowers as an expression

`EXPRESSION_ONLY` (reference.ts:300) includes `[` and `]`, so `".children.X[-1].output"`
fails `isPathSpelling` and takes the expression lowering path rather than the ref
desugarer. That is functionally fine, but it means bracketed and dotted child reads lower
differently, and the dataflow join lives on the ref path. Both paths must agree on parking;
see §6.

---

## 4. The pass counter

`run.iteration` today counts **every transition an instance takes** (`engine.ts:916`), not
loops. In run 11 it reached 4: `→draft`, `→draft`, `→explore`, `→confidence` — and the last
is an exit, not a loop.

That is already a latent bug independent of this proposal. `product.json`'s `context` child
declares a forward jump:

```json
{ "when": ".children.context.outputs.matched === true", "to": "draft" }
```

Had it fired, `iteration` would have been 1 before any loop existed, and a
`max_iterations: 3` budget would silently have been 2.

**Split the two:**

| | means |
| --- | --- |
| `.run.index` | transitions this instance has taken — today's `run.iteration` |
| `.run.iteration` | backward jumps into an earlier sequence member — the pass number |

`.run.iteration` is then the index into §2's arrays, which is the meaning authors already
assume when they write `.run.iteration < .limits.max_iterations`.

**This is the one change static inference cannot catch.** The spelling survives and the
number changes, so every existing guard shifts silently. The sites are enumerable: nine
workflow files under `feature/`, `changesetGate.ts:497`, `demoWorkflow.ts:72`, and the
warning text at `validate.ts:287`. Hand-check all twelve.

---

## 5. `output`, one name

Reads and declarations converge on the singular:

```jsonc
"operation": { "output": { "features": { "schema": … }, "feature_docs": { "schema": … } } }
```

```
.operation.output.features
.children.draft[-1].output.features
```

`NamedParameterDecl` becomes `ParameterDecl` here: the map key is the name, and
`outputSlotFor` already hardcodes `name: "output"` while turning the keys into schema
*properties*, so the `name` field was vestigial in this path.

The map is not redundant sugar. Across the workflows, `operation.outputs` appears 49 times,
and **30 of them declare more than one name**:

| names | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| declarations | 19 | 11 | 5 | 13 | 1 |

What it buys is `required`, derived per entry from `optional !== true && default ===
undefined`. The four states that declare the single slot by hand today all hand-roll the
object — `{"name":"result","schema":{"type":"object","required":["exitCode","stdout","stderr"],…}}`
— and hand-maintained `required` is a drift bug waiting to happen.

**The blob case needs one line, not a heuristic.** `outputSlotFor` currently drops each
entry's `kind` and always returns `kind: "json"`, which is why a separate single-slot field
existed at all — it was the only way to say "the whole return is bytes." Have it honour a
single entry's `kind` instead. The arity rule that depends on is already implemented, at
`engine.ts:2619`:

> A BLOB-kind operation output is the WHOLE value, not a record of named outputs (§7.1) …
> fills exactly ONE produced output slot

Promote that from a runtime failure to a load-time error while you are there.

**Blast radius:** 378 `.children.X.outputs.*` references in the workflows, plus 3 own-`.outputs.*`.
Every one fails at load as a bad reference (`projectProperty` returns `undefined` for an
undeclared property), so the rewrite is mechanical and nothing degrades silently.

---

## 6. Pending

While a pass is running, its element is the pending marker — the same signal a running
child gives today, not absence. The distinction is load-bearing and is exactly the failure
in §1.1: `undefined` on an optional input means *proceed without it*, while pending means
*wait*. resolve.ts:239:

> IN FLIGHT is still PENDING and not `undefined` — §6 is explicit that a
> started-but-unfinished [child parks]

Indexing already handles this. `operand` collapses only a top-level pending value, so the
array passes through with its element intact; `at(xs, -1)` returns that element and
`produced()` collapses it, parking the consumer; `at(xs, -2)` returns a settled record and
reads normally. No exemption and no new propagation rule.

**One case does need work.** `map`, `filter`, `flatMap` and `reduce` do not evaluate inline
— the engine dispatches per element (resolve.ts:485, "Applied per element by the ENGINE"),
so a pending element would be bound into an element call. Those four must park when any
element is pending, which is the same principle the object-literal resolver already states:
"an object holding a sentinel is not one a consumer can read."

How the marker is *represented* — the existing unique symbol, or something else — is out of
scope here and changes nothing above.

---

## 7. What it fixes

`feature/product` becomes writable as intended:

```jsonc
"draft": {
  "inputs": {
    "issue":       ".inputs.issue",
    "framing":     ".children.explore.output.winner",
    "residue":     ".children.explore.output.residue",
    "working_set": ".children.context.output.working_set",
    "findings":    ".children.critique[-2].output.findings"
  }
}
```

`[-2]` because at the moment `draft` runs in pass *n*, `critique[-1]` is pass *n*'s critique
— which has not run yet — and `[-2]` is the one that sent it back. The same wire lets
`explore/brief` see the blockers that re-opened it, which is what its prompt has always
asked for and never received.

The three identical drafts become three revisions.

---

## 8. A transition may wire the child it enters

A mount says what a child ALWAYS takes. That is the wrong question the moment a child can be
re-entered from more than one place — and the `feature` workflow has eleven such loops, where
`review`, `acceptance` and `implementation` can each send an earlier phase back with their own
evidence for doing so.

A mount cannot answer it. It can only name a value true of every arrival, and coalescing candidates
there is worse than useless: after a pass, EVERY earlier sibling has a value at `[-2]`, so "the
finding that sent me here" picks the wrong one confidently. The rule that fired is the only thing
that knows.

```jsonc
"transitions": [
  { "to": "engineering",
    "when": ".children.review.output.verdict === 'revise'",
    "inputs": { "returned_findings": { "$expr": ".children.review.output.findings" } } }
]
```

Merged over the mount per NAME, so a rule restates only what it changes and the child's other inputs
stay the mount's problem. Checked exactly as a mount's wiring is — the target must declare the name,
the value must fit the slot, and reachability is asked at the target's mount. Only a TAKEN transition
supplies any: the sequence cursor reaches a child by running out of work, which carries no evidence
at all, and `inputs` on a `terminate.*` rule is refused because there is no child to hand them to.

### 8.1 A rule reads the world its GUARD read

Both halves of that object say `.children.review.output`, and they mean the same review. The wiring
resolves BEFORE the pass opens and before the sequence reset — where the guard was evaluated — rather
than at entry with the mount's.

The alternative is worse than untidy. Resolving it at entry would put the reset in between, so the
CURRENT pass would mean the one being abandoned in `when` and the one being started in `inputs`,
and an author would have to write `[-2]` in one half of an object whose other half says nothing of
the kind. The two spellings that survive are each right where they are: a rule says
`.children.review.output`, a MOUNT — which resolves at entry, after the reset — says `[-2]`.

### 8.2 Accumulating needs no history

The target has not been cleared when the rule is evaluated either, so its last output is readable
alongside the source's. "What I just found, on top of what you already had" is one expression:

```jsonc
{ "to": "collect",
  "when": ".run.iteration < .limits.max_iterations",
  "inputs": { "all": { "$expr": "concat(.children.collect.output.all, .children.judge.output.found)" } } }
```

No indexing, no walking the passes. History remains what §2 built it for — comparing a pass with the
one before it — rather than something every accumulating loop has to reach into.

The lint earned its place immediately. Wiring the eleven loops against a critique's findings schema
was refused — `review` publishes its own severity enum (`should-fix`, not `significant`) and a
`design_findings` is declared as bare objects — so the consumer is typed to what the producers
actually guarantee rather than to what would have read nicely.

## 9. Open

- **Where the alias is emitted** — the `select` seam covers `.children.X.output.<name>`.
  Confirm `.children.X.output` (the whole record) and `.children.X.outcome` take the same
  rule, since those lower through different cases.
- **Bracketed vs dotted lowering** (§3.3) must agree on parking. Worth a test that reads a
  running child both ways and asserts both park.
- **Carry-forward identity** — a child untouched by a reset should share its record by
  reference across indices, not copy it. Cheap, but it should be stated so nobody
  deep-clones.
