# Design note: an expression is an operation

**Status: mostly built.** Expressions lower to producer trees (§1), the operator set is a registry
(§2), an expression can CALL an operation — prompt or function — resolved along a search `path`
(§3, §4), one grammar covers bindings and expressions alike (§14), there is one spelling per thing
(§15), a conversation is read by ref (§16), snapshots pin the resolved
definition (§11), failures travel as data (§5), and the built-in operation library ships
(§3, `builtins.ts`). What remains is higher-order operations (§3.5), `.each` — which subsumes them
(§17) — and the items in [TODO.md](TODO.md).

Sections marked ⚠️ or "superseded" record where building contradicted the design — they are kept
because the reasoning that was wrong is usually the reasoning someone would repeat.

Today an expression is a closed, pure grammar evaluated by a hand-written interpreter
(`@declarative-ai/hw`'s `expr.ts`), and it is the *only* construct in the format that needs a
bespoke static analysis: `referencesOf` exists for it alone, and both the validator and the fan-out
planner re-parse its source text to find its dependencies. Meanwhile every other authored binding —
`{child}`, `{input}`, `{artifact}`, `{conversation}` — already lowers to an ordinary producer edge
over a registered function.

This collapses the last special case. An expression becomes a *tree of producer edges*, the operator
set becomes a registry, and the same move makes it possible to call an arbitrary operation — a
function op or a prompt op — from inside an expression, because by then there is no difference
between an operator and an operation.

`inferExpr.ts` already asserts the conclusion; this makes it literally true rather than a claim the
checker has to re-implement:

> Semantically an expression IS a pure `FunctionOp` producer whose output schema is the inferred
> type — so ordinary `isSubschema` binding checking applies to expr leaves with no special case.

---

## 1. Expressions lower to producer trees

`{"expr": ".children.review.outputs.severity === 'high'"}` currently lowers to **one** edge carrying
the source text, which the engine re-parses and interprets at resolution time:

```jsonc
{ "op": { "kind": "function", "functionRef": "expr.eval",
          "input": { "source": { "kind": "text", "binding": { "text": "…" } } } } }
```

Instead, the loader parses the expression and lowers it structurally:

```jsonc
{ "op": { "kind": "function", "functionRef": "op.eq", "input": {
    "left":  { "binding": { "op": { "kind": "function", "functionRef": "select",
                                    "input": { "value": { "binding": { "op": "review" } },
                                               "key":   { "binding": { "text": "severity" } } } } } },
    "right": { "binding": { "text": "high" } } } } }
```

Nothing about this shape is new. `{child}` already lowers to a two-level tree (`select` over a child
edge), `runResolver` already resolves each argument through `resolveRef` recursively, and
`resolveProducer` already walks nested edges. An expression tree is more of what the loader does on
every binding it touches.

**What it buys, beyond the authoring surface:**

- `referencesOf` stops being necessary. A dependency edge is a *leaf of the tree*, which the fan-out
  planner already walks — the `RESOLVER_REFS.expr` special case in `fanout.ts` and the re-parse in
  `validate.ts` both go away. ⚠️ **Overclaimed — see §1.3.**
- Operator typing stops being a hardcoded table. `inferExpr`'s per-operator signatures become the
  declared signatures of ordinary ops (§3), so **a user-defined pure function is indistinguishable
  from `eq`**.
- Effectful ops in an expression need no separate machinery. Once every node is a producer edge, a
  node that happens to be a prompt op is just another node.

### 1.0 `PENDING` is unchanged, and is why this works

`PENDING` already means *"not ready — park the consumer, retry next round"* and already propagates
through every operator. A binding that resolves to `PENDING` parks; a guard that evaluates to
`PENDING` is skipped for the round. An operation embedded in an expression tree inherits exactly that
protocol: schedule on first evaluation, return `PENDING`, return the value on a later round.

`PENDING` is an hw concept — nothing below hw knows it exists — which is what fixes several layering
questions later in this document.

### 1.1 Status: **done**. `expr.eval` is gone

`{ expr }` lowers to a tree of operator producer edges. An expression is parsed exactly once, at
load; no source string is carried through the document, and there is no interpreter left to invoke
at resolution time. `expr.eval` has been deleted from `RESOLVER_REFS`.

What moved with it:

- **`fanout.ts`** recognizes a context-rooted `children` chain structurally instead of re-parsing an
  expression's source. The three distinctions §1.3 warned about are preserved exactly.
- **`validate.ts`** types an expression leaf with `inferRef` over the tree and runs the reachability
  obligation over `referencePathsOf`. `firstChildRefOf` reads the child a leaf names structurally.
- **`inferExpr.ts`** gained `inferRef` — the same projection and join rules, reached over the tree
  instead of the AST, so the inferred type is still the leaf's producer schema and `isSubschema`
  binding checking still applies with no special case.
- A malformed expression is now a **load** error rather than a lint error, which is the treatment
  every sibling binding mistake already gets (`'x' is not a runtime reference`, `unrecognized
  binding form`).

**Guards and `{{…}}` template holes now lower too** — the last two places an expression was still
interpreted at run time. Both resolve the lowered tree against a scope, with lowering cached per
source string exactly as parsing was. `evaluate` has **no caller left outside its own module**: it
is kept deliberately, as the reference semantics the differential test compares against. Deleting it
would remove the oracle that proves lowering correct.

The validator still reads the authored `when` string with `inferExpression`/`referencesOf`, which is
the right layer for static analysis of what the author wrote — and the differential test is what
guarantees the two agree.

**§5.2's "fourth outcome" does not arise, and this is a correction.** A lowered expression cannot
yield an error *on data*: every operator's failure case is "producer is missing X", a malformed tree
the loader cannot emit, and reading a missing namespace or property yields `undefined` rather than
refusing. So the transition loop needs no error path — a non-value simply does not take the
transition. The claim was written assuming guards would resolve the kind of reference that *can*
fail; they do not, because expressions lower entirely through `context.get`.

**Everything lowers through `context.get`, including child reads** — the decision §1.3 forced, and
for a second reason found while writing the differential test: for a declared child that has not
started, the expression context yields `undefined` (so `children.c.outputs.x === 'y'` is simply
false), while a child producer edge REFUSES with "child 'c' has not run" and fails the whole
binding. Lowering child reads onto child edges would have quietly turned a false guard into a
failed state.

**The differential test earned its keep immediately.** It evaluates 42 expressions against two
contexts — including a child that has not started, one still running, and an empty context — and
compares the lowered tree's value against the interpreter's. It failed on four PENDING cases at
once, and the cause was a real bug in §2's resolvers: the engine seeds the context with the sentinel
*itself* for a running child (`{ outputs: PENDING, outcome: PENDING }`), so reading
`children.running.outcome` produces a *resolved value that is* PENDING rather than a pending
resolution. The interpreter collapses the two with `isPending(obj)` before every operator; the
resolvers did not, so `children.running.outcome === 'success'` compared a symbol against a string
and answered **`false`** — a guard firing on a child that had not finished. Fixed by normalizing
both directions (`operand`, `produced`) in `runResolver`.

### 1.4 Superseded: what the flip needed before it landed

Reading `validate.ts` before flipping: `producerSchemaOf` handles an `{ expr }` edge by parsing its
source and calling `inferExpression(ast, scope)` — **the inferred type IS the leaf's producer
schema**, which is what makes `isSubschema` binding checks work on expressions. It also reports
unresolved references and runs the reachability obligation over `referencesOf(ast)`.

None of that survives the source string disappearing. The flip therefore needs type inference over
the *tree*: an `inferRef` that composes each operator's signature, which is §2's "operator typing
stops being a hardcoded table" cashed out. That is the right end state — and it is a substantial
piece, not a mechanical edit. Getting it wrong is silent in the worst way: a wrong inferred schema
means a binding mismatch that `isSubschema` never catches.

Remaining, in order: `inferRef` over the tree · `collect` recognizing a context-rooted `children`
chain (§1.3) · the loader flip · deleting `expr.eval`.

### 1.3 The fan-out special case does not fully disappear — and why that matters

Found by reading `collect` before flipping the loader. It is worth stating before the flip, because
getting it wrong is silent.

`fanout.ts` counts how many consumers read each child output; a count of two makes the engine
**materialize** a blob output once rather than letting two readers race the same byte stream. Its
`{ expr }` case re-parses the source and reads `children.*` paths out of it, with a distinction that
is easy to miss: `children.P.outputs.X` is a read of one output, a coarser `children.P` is a read of
*every* output, and `children.P.outcome` is a read of **none** — it is the termination status, not
an output, and counting it would force a materialization nothing needs.

The plan was that lowering makes all of this structural: a child read becomes a producer edge, which
`collect` already recognizes. That works for the case that matters —
`children.c.outputs.x` lowers to `select({op: "c"}, "x")`, which `collect`'s existing `select` branch
reads as a specific-output read, and `children.c.outcome` lowers through the context with no producer
edge at all, so it correctly counts as nothing.

**But `children.c` on its own cannot lower to `{op: "c"}`, because they are different values.**
`{op: "c"}` resolves to the child's *outputs*; `children.c` in the expression context is
`{ outputs, outcome }` — the engine builds it that way. Lowering it to a child edge would silently
change what the expression evaluates to.

So `children.c` has to lower through the context, and then no producer edge exists for `collect` to
find — and the whole-child read stops being counted. The failure mode is not an error: fan-out
under-counts, the blob is not materialized, and two readers race one stream.

**The special case therefore survives, in a better form.** `collect` must recognize a context-rooted
member chain (`member(member(context("children"), key), …)`) structurally. That is still a real
improvement over re-parsing a source string — no second parser invocation, no `referencesOf`, and
the same walk that handles every other edge — but it is *recognition of a shape*, not the absence of
a rule. §1's claim above is corrected accordingly.

**Ordering consequence:** the flip must land together with the `collect` change and a fan-out test
that covers all four shapes (`children.c.outputs.x`, `children.c.outputs`, `children.c`,
`children.c.outcome`). A differential test — lower an expression, then assert the tree resolves to
what the interpreter returns for the same context — is the safety net for the value semantics; the
fan-out tally needs its own, because no value comparison would catch it.

### 1.2 Memoization is already built

The obvious worry is that a guard re-evaluated every scheduling round re-runs whatever it calls.
It does not, because `exec` already keys a memo on the operation's content hash:

```text
memoKey = sha256(canonicalize({ operationHash, workspaceTreeHash?, executorId? }))
```

A *resolved* op embeds its input values, so the op hash **is** the (callee + arguments) key — the
thing this design would otherwise have had to invent. `withMemoize` gates on the dispatched entry's
own `memoizable` capability, via `capabilitiesFor(op)`, so a clock-reading helper declaring
`memoizable: false` is correctly re-run and a pure operator is correctly cached.

Nothing to build. This is the single largest piece of the design that already exists.

---

## 2. The operator set is a registry — **built**

**Status:** built and in use — `{ expr }` lowers onto these, and the built-in library (§3) joins them
as ordinary entries in the same set.

`RESOLVER_REFS` gained `context.get`, `op.member`, `op.not`, the eight comparisons, and the three
lazy forms. Two things worth recording about how they turned out:

- **The semantics are shared, not restated.** `applyBinary` and `memberOf` were extracted out of the
  tree-walking evaluator and are now called by both it and the resolvers. Two implementations of
  "what does `.prop` reach" is exactly how the evaluator came to disagree with its own type-checker
  about prototype properties (§12) — so the lowered form cannot mean something different from what
  the interpreter meant, by construction rather than by care.
- **Laziness came out free, and §6 is less of a wart than it looked.** `runResolver` resolves
  arguments *on demand* (`arg(name)` calls `resolveRef` when asked), where `resolveInputs` — the
  path an operation dispatch takes — resolves every bound parameter up front. So `op.and`, `op.or`
  and `op.cond` simply do not ask for the branch they do not need. `false && PENDING` stays
  determinate at `false`, and an untaken branch is not evaluated, with no thunk and no new
  machinery. The §6 debt is narrower than stated: it is not "these three are special", it is "a
  resolver is pull-based and an operation dispatch is push-based", and generalizing means giving
  `exec` the pull.

`op.member` is deliberately distinct from `select`: `member` yields `undefined` for a missing
property (implicit optional chaining, what an expression means), while `select` REFUSES, because a
named child output that is not there is an authoring error.

**Bracket indexing (added 2026-08-12): `xs[-1]` is parser SUGAR for `at(xs, -1)`** — the exact AST
the call form parses to, so lowering, inference, static analysis and the interpreter cannot treat
the two differently, and negative indices count from the end because `at`'s already did. Two
consequences worth recording: `[` and `]` joined the expression-only character class in
`reference.ts`, so a bracket-bearing FILENAME stopped being addressable (it now fails loudly as an
unparseable expression rather than resolving to nothing); and an operation reference is still only
meaningful called — `$/prompts/review[-1]` is refused, not indexed.

---

## 2a. The operator set is a registry — design

`RESOLVER_REFS` today is `expr.eval`, `select`, `scope.get`, `artifact.get`, `conversation.get` —
"registered functions authored binding sugar desugars ONTO … after desugaring there is no special
wiring case left for the checker or the engine to know about, only producer edges."

The operators join it: `op.eq`, `op.lt`, `op.not`, `op.and`, `op.or`, `op.cond`, and so on.
`expr.eval` itself is deleted — there is no interpreter left to call.

Two consequences:

- **The validator already reads the registry.** `validate.ts` takes
  `functions?: ReadonlyMap<string, FunctionCapabilities>` and gates on entries, skipping
  `RESOLVER_REF_SET` as engine built-ins. Guarding "no effectful callee inside a `when`" is a few
  lines in a check that already runs, because entries are `pure | host | runtime` with required,
  total capability records — the purity classification exists.
- **The operator set becomes extensible without touching the grammar.** Adding `op.concat` is a
  registration, not a parser change.

---

## 3. Calling: the callee is a reference — **built**

**Status:** built end to end. `classify(inputs.issue)` resolves along the `path` to an operation
document, runs — prompt operations and function operations alike — and binds its result, in operation
inputs, output bindings and guards. Memoized by the resolved op's content hash, so a call named twice
is one execution and a call whose argument changed is a different call. A rooted callee
(`$JAIRA/prompts/review('x')`) works alongside the bare and dotted forms.

What is NOT built: higher-order operations (§3.5).

**An operator and a call are the same node.** The AST had five compute nodes — `unary`, `binary`,
`logical`, `cond`, `call` — which was a taxonomy over *syntax*, not over meaning. All five lower to
one `FunctionOp` with its arguments bound; the only thing that ever differed was the name in
`functionRef`. They are now one `apply { op, args }`:

| Written | Parses to |
| --- | --- |
| `a === b` | `apply("op.strictEq", [a, b])` |
| `!a` | `apply("op.not", [a])` |
| `a ? b : c` | `apply("op.cond", [a, b, c])` |
| `classify(x)` | `apply("classify", [x])` |

A built-in is one whose name resolves in `RESOLVER_REFS`; anything else is a reference resolved
along the `path`. **That is §2's stated aim actually reached** — "a user-defined pure function is
indistinguishable from `eq`" — because the two now differ only in where the name resolves.

It also collapsed the positional→named mapping into one mechanism: `OPERATOR_PARAMS` gives each
built-in's parameter names in order, which is precisely the `index` mapping §3.3 defines for a
user-defined callee. An operator is not special; it just has a signature that ships with the
language.

Three further decisions the grammar settles:

- **A callee is a dotted PATH, not an arbitrary expression.** `(a ? f : g)(x)` is refused with "only
  a name may be called". An operation is *named* by a reference; there is no first-class function
  value to apply, so admitting one would promise something the model cannot deliver.
- **The callee is not in the data scope.** `referencesOf` collects a call's *arguments* and skips its
  callee, and inference does the same. Otherwise `classify(x)` reads as a reference to an undeclared
  namespace called `classify`, and the validator rejects it. This is the "which namespace does the
  callee live in" question from the design, answered by §3.2's rule rather than by a `functions.*`
  namespace.
- **`evaluate` refuses a call.** It is the reference semantics the lowering is checked against, not a
  second execution path — applying an operation needs a resolved callee and a scope, so it is
  refused rather than half-implemented.

A call's result infers to the universal schema for now: the type is the callee's declared output,
which is not known until the callee is resolved. Unknown, not wrong.

### 3.5 Higher-order operations — designed, not built

`map(issues, classify)` is the remaining feature, and it is a different shape from everything else in
§3: it needs to run an operation a number of times that is **not known until run time**.

**Why it cannot be a built-in.** The library in `builtins.ts` is pure and synchronous by
construction. `map` has to dispatch, so it belongs with the engine's embedded-op machinery, not with
`add`.

**Why it cannot be a static walk.** `runEmbeddedOps` finds the operations to run by walking the
binding tree. For `map`, the set depends on the resolved array — one operation per element. So the
engine has to resolve the array argument first, then construct one bound operation per element.

**The pattern already exists, and extends.** A call is: the engine runs it, records the result under
the resolved op's hash, and resolution reads it back by deriving the same hash (`resolveEmbedded`,
shared by both sides so they cannot disagree). Higher-order is the same with a loop:

1. the engine resolves the array argument synchronously (it is operators and context reads);
2. for each element it binds that element into the operation's first free parameter, hashes, runs,
   and records — which gives PER-ELEMENT memoization for free, so a re-run only pays for elements
   whose values changed;
3. resolution rebuilds the same per-element hashes, reads the results, and assembles the array —
   `PENDING` if any is missing, so the existing park-and-retry join covers a partially-run map.

**Passing the operation.** No new mechanism: `map`'s second parameter declares `kind: "function"`,
and the model already says a producer edge on such a parameter yields the op DEFINITION rather than
running it. Lowering has the callee's signature in hand, so an argument in that position resolves as
an operation reference instead of a data path. Partial binding comes free — `{op, parameters}` is
already "these bound, the rest free".

**The four decisions, settled:**

| Question | Decision | Why |
| --- | --- | --- |
| Parallelism | `Promise.all` over elements, then check the results | The expensive case is an LLM call per element; the executor stack already owns rate limiting and budget, so throttling here would be a second, worse copy of it. |
| Memo key | per element, the bound op's hash | The test that matters is **"would someone else making the identical call reuse this answer?"** — so the key is content-addressed by construction: `hashOperation` over the resolved op IS "this callee with these arguments". A map over an array where one element changed re-runs one operation. |
| Failure | an element's failure is error DATA; the array carries it | Failures are values (§5), so a failed element is an error value and `map` returns an array of values-and-error-values. Nothing new decides anything: the consuming slot's declared type does, element-wise — it accepts errors and the array flows, or it does not and this is the implicit unwrap. Failing the whole map on the first error would discard both the successful results and which element failed. |
| Fan-out | unchanged | A `map` reads its array argument once; the argument walk already counts that. |

⚠️ **The memo's SCOPE is currently wrong, and this applies to plain calls too.** `hashOperation` is
content-addressed, but the results live in a `Map` on the engine INSTANCE — so two runs of a task, or
two tasks making the identical call, share nothing. It has to be an injectable cache the host can
back durably, which is also what would let `exec`'s `withMemoize` do the work instead of a bespoke
map. Related: the lightweight run path calls `runFunction` directly and so bypasses the executor
stack entirely, meaning an embedded FUNCTION call gets no memoize, retry, rate-limit or budget
wrapper. A prompt callee goes through `promptExecutor.start` and does.

**Scope.** `map`, `filter` and `flatMap` all fit this shape. `reduce` does not — each step depends on
the previous, so the operations cannot be constructed up front; it wants a sequential runner and is
worth doing separately. `zip` is pure and belongs in `builtins.ts` with the rest.

### Dispatch: what reading the engine actually showed

The remaining step is running an embedded operation. Having read `runFunctionOp`, the shape of the
work is clearer than the design assumed — and it is the reason the "synthetic child" option existed.

**Dispatch is entangled with instance bookkeeping.** `runFunctionOp` emits `operation.started` /
`operation.failed` against an instance id, reads its environment from `instance.def.environment`,
resolves tools and a session from it, rolls metrics into the instance, and hands the result to
`acceptOpOutputs`, which writes the instance's *outputs*. An embedded operation has none of that: no
state id, no declared environment of its own, and an output that belongs to a binding rather than to
the instance.

So there is no reusing `runFunctionOp` as-is. Two viable shapes:

- **A lightweight run path** — resolve tools and session from the ENCLOSING instance's environment,
  call `runFunction` (or the prompt executor) directly, return the value to the binding, and skip
  `acceptOpOutputs` and the instance events entirely. Roughly the middle of `runFunctionOp` without
  either end. The embedded op then has no identity in the run record, which is either a feature or a
  gap depending on whether you want a call to be visible in the timeline.
- **A synthetic child**, which gives it an identity and reuses everything, at the cost of generated
  keys in the event log and in `run.cursor`'s typed key set.

**Resolution must stay synchronous.** This is the constraint that decides the plumbing.
`renderTemplate` resolves inside a `String.replace` callback, which cannot await, and
`firstMatchingTransition` is sync too. So `resolveRef` cannot become async. The workable shape is the
one children already use: the engine RUNS the embedded ops first, memoized by op hash, and
resolution READS the results — `resolveProducer` consulting a memo exactly as it consults
`scope.childOutputs`. `PENDING` covers the not-yet-run case for free.

That is a two-pass flow — collect embedded ops from the bindings, resolve each one's `parameters`
synchronously (they are operators and context reads), run them, then resolve the tree with the memo
populated.

### What dispatch still needs

1. **Callee resolution** in the loader — a local child key first, then a reference along the `path`,
   read as an op document (§3.2, §3.4). `lowerExpression` needs it injected; it is deliberately pure
   today.
2. **Positional → named** lowering via the callee's declared `index` (§3.3).
3. **Engine dispatch for an author-embedded op.** `resolve.ts` refuses one by design today —
   *"running it belongs to the engine's dispatch, not to reference resolution"* — which is exactly
   the seam a lowered call lands on.
4. **Built-in op documents** under `$JAIRA/functions`, which §4 has already put on the path.

---

## 3a. Calling: the callee is a reference — design

An expression gains call syntax, and the callee is an ordinary reference — the same reference type
that names a state to run or transcludes a document node ([REFERENCES.md](REFERENCES.md)).

```jsonc
"when": "classify(.inputs.issue).severity === 'high'"
```

`exec` already decided the layering here. A `{op}` binding on a `prompt`/`function`-kind parameter
passes the op **definition** as the value (higher-order, implemented); and a *string* op ref
reaching `exec` is refused with the instruction:

> `input '<name>'` names a declared child rather than embedding its definition — **resolve the local
> name against the enclosing scope before dispatching the operation**

So: **hw resolves a callee reference to an embedded op document; `exec` dispatches documents.**

### 3.1 Three tiers, no new machinery

| Written | Means |
| --- | --- |
| `classify` | the op document itself — higher-order value, `kind: "function"` |
| `classify(x)` | applied |
| `classify(x)` with fewer args than parameters | partially applied |

All three already exist in the model. Note that partial application via `functionRef`-as-op-id is an
**id-family** mechanism; in the inline family (`op: Operation<InlineFamily> | string`) it is spelled
"embed the op with some parameters pre-bound." Same semantics, different spelling — be deliberate
about which family a given surface authors in.

### 3.2 Resolution order in callee position

A **local child key** wins over a path lookup, exactly as a lexical scope wins over a module path.
`{op: "<string>"}` already means "the declared child named this," so extending the string case to
"…otherwise, a reference" is the natural increment rather than a new rule.

### 3.3 Positional arguments

`Parameter` deliberately carries no name — "the NAME of a parameter lives in its container" — so an
unnamed parameter would mean `input` admits an array, which ripples into `mergeSlotMap`,
`resolveInputs`, and the memo hash.

Instead, **positional arguments are lowered to named ones at load time**, using the callee's declared
`index` — which exists for exactly this: *"positional sort key for bare/tuple ingestion: the i-th
positional value fills the parameter with the i-th smallest `index`."*

`eq(a, b)` emits `{input: {left: …, right: …}}`. The model does not change, every lowered op has
named inputs, and two spellings of one call hash identically under `hashOperation` — which is what
keeps §1.2's memoization sound.

Both spellings are accepted; named arguments are required wherever a signature is not statically
known (§3.4).

### 3.4 Where a signature comes from

Calling by name needs the callee's parameter names, order, and schemas at **load** time — for
positional lowering and for typing the call's result.

Registry entries do not carry one. `RegisteredFunction` has `impl`, `capabilities`, `description`;
`Signature<F>` exists in the model but is not on an entry.

**Decision: the op document on the `path` is the authoritative signature.** Anything callable by name
from an expression resolves to a document that declares its own `input` parameters (with `index`) and
its `output` — so the signature is authored data: versioned, inspectable, overridable by shadowing
the document earlier on the path (§4), and uniform across built-ins and user-defined ops. Built-ins
are documents too, served by a virtual overlay (§4.3), each naming its registry entry.

This keeps the required change **entirely inside hw and JaiRA** — no change to `ops` or `exec`.

Adding `Signature` to registry entries remains worthwhile as a *separate* improvement, so a validator
can check that a document's declaration matches the impl it names. It is not a prerequisite.

A **runtime-chosen** callee (`.inputs.reviewer(x)`) has no load-time document. Positional lowering is
therefore unavailable there and named arguments are required; the alternative — deferring positional
binding to dispatch — was rejected because it moves an authoring error to run time.

---

## 4. `path`: one search list for every reference — **hw side done**

**Status:** built in `@declarative-ai/hw`. `ReferenceOptions.defaultRoot` takes an ordered list, a
bare reference is searched along it (first match wins), `path` is an inherited `environment` field
with the `$INHERITED` splice, and the loader threads the inherited path into expansion. The
shadowing diagnostic §4.4 asked for is implemented, not deferred.

**Two limits worth naming:**

- **`children[].state` does not search.** It resolves through `ref.ts`'s `resolveStateRef`, which
  does path arithmetic with no filesystem in hand — so it has nothing to test a candidate's
  existence against and would always take the first entry. Searching there needs an existence
  oracle (the bundle's own file map, or the vfs), which is a separate decision. It *does* fold a
  rooted or absolute spelling back against every entry, so `$BASE/lib/review` and a project's own
  `lib/review` name one state rather than two.
- **JaiRA's half is now built too**: `config.workflows.path` (default
  `["$JAIRA/workflows", "$JAIRA/functions", "$BASE/workflows", "$BASE/functions"]`), expanded
  against the same `$JAIRA`/`$PROJECT`/`$BASE` roots a reference uses, and passed at every load
  site. The parser refuses a **bare** entry outright, because that failure is otherwise circular and
  baffling — a bare path entry would need the path to resolve itself.

  The workflows directory is forced **first**, whatever the config lists. It is the root this
  project's own states are authored under, and a layer that configuration could push behind another
  would stop being an override. Configuration decides what comes *after*, which is where `$BASE`
  sits.

  `$JAIRA/functions` and `$BASE/*` are in the default path before anything is in them. That is safe
  — an entry naming a directory that does not exist lists as empty and the search moves on — and it
  means §3's callee documents have a home the day they are written, and a machine with no shared
  root behaves exactly as it did before one existed. The `Vfs` overlay serving *built-in* documents
  (§4.3) is still to come; a project can already put its own there.

The cycle §9 flagged breaks where predicted, and the rule is sharper than "path entries may not be
bare": the path a state resolves under is read off its **raw** `environment`, so a state whose
`environment` is itself a transclusion cannot use a path declared inside that same transclusion —
you cannot resolve a reference with a path you have not loaded yet. Everything else inherits
normally. Pinned by a test.

---

## 4a. `path` — design

A bare reference today hangs off a single default root, so `eq` would mean
`<workflowRoot>/eq`. Rather than special-casing the callee position, **`path` replaces the single
default root with an ordered list**, with the semantics of a shell `PATH`.

| Form | Searches? |
| --- | --- |
| `/opt/x`, `file:/opt/x` | no — itself |
| `$JAIRA/lib/x`, `$BASE/lib/x` | no — a NAMED root is exactly one place |
| `$/functions/eq`, `$/prompts/goals.md` | **yes** — the LAYER ROOTS, first match wins |
| `./goals`, `../shared/lint` | anchored to the referring state's id, then searched (§4.1) |
| `eq`, `feature/plan` | **yes** — the state path, first match wins |
| `.inputs.issue` | n/a — a property of this file, not a file reference |

`./x` never consulting the path is what a shell does, and it is also what the existing rule requires:
a relative reference is anchored to the referrer's id-as-a-directory, and searching would make that
meaningless.

The mechanism is small. `defaultRoot` is already documented as a **per-field** notion — "a bare path
hangs off a per-field DEFAULT ROOT" — so `ReferenceOptions.defaultRoot` becomes
`string | readonly string[]`, tried in order. Everything else — `$VAR` roots, `./`, absolute,
`file:`, and longest-match `splitAtFile` — is untouched.

### 4.1 Identity is bare under *every* entry — which is what makes the path a layering mechanism

**Revised.** This section previously said the opposite, and the reasoning it gave was sound for the
model it assumed. That model changed when the shared base root landed (DESIGN §3), so the rule
changed with it. Both versions are recorded here because the discarded one is the obvious design and
the reason it was discarded is not.

The original rule: only the FIRST path entry produces bare ids, because

> The canonical id keeps the BARE spelling whenever it lands under the default root. The id is an
> identity — it keys the snapshot hash, the event log, task rows, and `$STATE_ID`. If `feature/plan`
> canonicalized to an absolute host path, every stored snapshot would drift the day this shipped,
> and one workflow would carry different ids on two machines.

and if a match at any entry folded back to a bare id, two different files at two entries would both
produce the id `foo` — a collision in the very thing meant to tell them apart.

**That collision is now the feature.** The shared base root exists so a project can take a workflow
it does not contain and replace one state of it. That override only works if the project's
`feature/plan` and the base's `feature/plan` are the *same id*, one shadowing the other. Under the
old rule the base copy canonicalized to an absolute host path, so the project's file was not an
override at all — it was a second, differently-named state, and nothing shadowed anything.

**So: a match under ANY path entry keeps its bare spelling** (longest matching root wins, so nested
entries do not lengthen an id). A target under no entry at all — a genuinely out-of-tree reference —
still gets an absolute POSIX id, because it has no bare spelling to fold back to.

**And the "collision" was never one.** An id is a RELATIVE PATH resolved against a search path —
the same arrangement `PATH`, `NODE_PATH` and a classpath have always had. Three facts, which are
worth stating together because the original argument reads as though they were in doubt:

- **An id has always needed a project to mean anything.** `feature/plan` already named a different
  file in two different projects, long before a second entry existed. Adding one changes nothing
  about that.
- **Within one resolution it is still exactly one file.** First match wins, deterministically; the
  shadowed copy is inert and never a second participant in the same bundle. Nothing collides.
- **Portability is satisfied, not traded away.** `feature/plan` is spelled `feature/plan` on every
  machine, whichever layer supplies it — which is precisely what the original rule was protecting
  and what an absolute host id would have destroyed.

### 4.1a `$` is the sigil for "resolve against the layers"

One list underpins both searches: the **layer roots**, `[<project>/.jaira, ~/.jaira]`
(`jairaPaths().roots`). Everything else is derived from it.

| Spelling | Resolves against |
| --- | --- |
| `$/lib/review` | each layer root in turn — `<root>/lib/review` |
| `feature/plan` | `<root>/workflows`, `<root>/functions` per root (`workflowSearchPath`) |
| `$JAIRA/…`, `$BASE/…` | one named root, never searched |

This is what makes the *fragments* a state is assembled from layer as whole states do — prompts,
types, guards, operation documents. Without it an override model covers state files and nothing
inside them, which is half a feature: a project could inherit a shared workflow but not the shared
prompt that workflow transcludes.

Naming a root still pins it, and that distinction is the useful one: `$/lib/review` means "the
project's if there is one, the shared one otherwise", `$BASE/lib/review` means "the shared one, and
I mean it".

`config.workflows.path` is therefore **absent by default** — the generated list is the answer, and
setting it is an override that replaces rather than extends. Nothing is written down twice, so
adding a third layer is one entry in `roots` and nothing else.

Two supporting details:

- **The first entry is not configurable.** The project's own `workflows/` always leads, so a state
  the project defines always wins over one it inherits.
- **Shadowing stops being a warning.** With layering as the intent, `ReferenceOptions.shadowing:
  "override"` silences the §4.4 diagnostic; JaiRA passes it at every load site, because one warning
  per overridden state is how a warning stops being read. The diagnostic still fires by default for
  callers that layer roots *without* meaning to.

### 4.2 Inheritance, and the sentinel

`path` is declared in `environment` and merged down the ancestor chain like every other environment
field, nearest layer winning.

Arrays **replace** in that merge, deliberately: *"which is what makes `"tools": []` the way to drop
an inherited tool; a unioning merge would leave no way to take one away."* Rather than exempting
`path` from the one array rule, splice with a sentinel — the idiom this project already uses for
`artifacts.destination: "$DEFAULT"`:

```jsonc
"environment": { "path": ["./ops", "$INHERITED"] }   // prepend to what the chain supplied
"environment": { "path": ["./ops"] }                  // shadow everything, built-ins included
```

**Path entries may not themselves be bare** — otherwise resolving the path needs the path. `$VAR`,
absolute, or relative only, exactly as a shell `PATH` holds directories rather than names to search
for.

Two loader constraints:

- `path` must be added to `OPERATION_OWN_FIELDS`. Any field outside that set is hoisted into the LLM
  call configuration, so forgetting it ships a `path` parameter to the model on every prompt op.
- `path` must stay **out** of `KIND_SPECIFIC`. A prompt op's guards call functions too, so it has to
  survive a kind change.

**Known wart, accepted deliberately.** `environment` is defined as "an operation shape, all fields
optional," and every other field in it is an operation field. `path` is not — it is resolution
context that never reaches an operation. It lives there anyway because the merge machinery is
generic over `OperationFields` and a sibling block would need its own inheritance chain. The
alternative (a top-level `resolution: { path }` block) remains open if the wart bites.

### 4.3 Built-ins

Built-ins are op documents under `$/functions`, served by an in-memory `Vfs` overlay — the `Vfs` is
already injected "so a bundle can resolve in memory," and `roots` already maps `$VAR` to a path with
`$` aliasing `$JAIRA`. **No new URI scheme.** `resolveReference` refuses every scheme but `file:`,
and a new one would have to be learned by lint, the ambiguity warnings, and any future
go-to-definition.

Overriding a built-in is then just shadowing: put a document earlier on the path.

### 4.4 The cost, stated plainly

Shadowing becomes global. Adding a file in an earlier path entry can silently change what an existing
reference means anywhere in the workflow — the classic `PATH` hazard.

The mitigation is visibility, and the machinery exists: `splitAtFile` already warns when a reference
matches more than one candidate. Extend it to report cross-entry shadowing, and give
`jaira workflow lint` a resolution table. If you take `PATH` semantics you have to buy the `which -a`
that goes with them.

---

## 5. Errors are values — **foundation built, routing not wired**

**Status:** the vocabulary exists; nothing routes on it yet, so behaviour is unchanged.

- `json`: `Failure<D = never>` — generic in the **detail**, invariant in the `classification`, which
  is the constraint that keeps `classifyError`, the retry loop and the AIMD controller reading one
  value. `FAILURE_SCHEMA` is the data-plane shape, with `classification` as an `enum`.
- `json`: `ERROR_CLASSES` hoisted out of `encodedError.ts`, where the closed set was a *private*
  duplicate of the union. A closed set is only useful if everything enumerating it enumerates the
  same one, and the schema needed the same list.
- `hw` (`errorValue.ts`): `isFailureValue` and `admitsError` — the predicate that decides
  route-vs-terminate.

**A failure is a value with a type — always.** Different kinds of failure are differently *shaped*;
none of them is "not data". So routing is not a question about a failure's provenance, it is
ordinary type checking against what the consumer declared. Terminating is the implicit unwrap — the
default a language with `Result` spells `?` — and declaring the error type is how an author opts
into handling it instead.

**The value is WRAPPED — `{ error: <failure> }` — not a bare failure.** Two reasons, and the second
is the one that made it worth changing:

- **A bare failure is indistinguishable from data that looks like one.** A classifier operation
  returning `{ classification, reason }` is an entirely plausible thing for a workflow to have, and
  sniffing those fields reads its output as an error. The `error` key is a discriminator nothing
  else in the data plane claims. (It is also what §5.2's handler spelling always assumed —
  `outputs.result.error.classification === 'policy-denied'`.)
- **It makes the union writable, which dissolves the exception.** "Any value, or an error" is
  `{ "anyOf": [ {}, "$/types/failure" ] }`. An unconstrained slot then has no branch requiring
  `error`, so it declares none — the ordinary reading of what the author wrote, rather than a
  special case carved out of the rule. There is no longer an exception to flag.

The short spelling works because a string where a schema belongs is a document reference and `anyOf`
items expand, so a shared type library keeps the union to one line.

**`admitsError` therefore checks two things**, and needs both:

1. the slot has a branch that **declares** a failure — one requiring `classification`; and
2. the failure is an `isSubschema` of that branch.

(2) alone — pure "would this value validate" — is far too permissive, and this is the trap worth
recording: **JSON Schema objects are open**, so `{type: "object", properties: {plan}}` accepts a
failure quite happily, having never said `plan` was required. Routing on that would push failures
into precisely the slots nobody thought about. Acceptance has to be *declared*, not merely
survivable.

(1) alone would collapse every failure into one kind, so a slot handling a policy denial would also
swallow a provider timeout. Keeping the subschema check is what makes "differently shaped by kind"
real: a slot declaring the narrow kind refuses the wide one, and a slot declaring the general shape
accepts a specific one.

**Two findings from building it:**

- `isSubschema` does not prove `X ⊆ (A | B)` from `X ⊆ B` — a union on the *supertype* side is not
  decomposed. Since a union is the natural spelling for "the value or the error", `admitsError`
  walks the branches itself.
- An unconstrained slot accepts nothing here. Under pure subschema reasoning `{}` accepts every
  value, a failure included; the exception is deliberate, because a slot with no schema means the
  author said nothing, and silence must not read as "I handle errors here".

### 5.0 Routing: operation inputs are wired; two places are not

`resolveInputs` now consults `admitsError`: a binding that cannot resolve becomes a `permanent`
failure value, and it flows into the slot when the slot declared it accepts one. Otherwise the
operation terminates with it, which is exactly what every binding did before — so a workflow that
does not opt in is unaffected.

Still unwired:

- **`exec` refusing a failed `{ result }` at dispatch** ("there is no value to pass"). This is the
  case with the most obvious value — an operation that genuinely failed — and it needs `admitsError`
  to move down a layer, since `exec` cannot import from `hw`. `FAILURE_SCHEMA` is already in `json`,
  which `exec` depends on, so the move is available.
- **Guards.** §5.2's consequence stands: a lowered guard can resolve to a failure, so evaluation
  gains a fourth outcome (`true` / `false` / `PENDING` / error) that the transition loop has no path
  for. It is blocked behind guard lowering (§1.1) rather than behind anything here.

---

## 5a. Errors are values — design

`Failure` becomes generic in its **detail**, invariant in its **classification**:

```ts
interface Failure<D = never> {
  classification: ErrorClass;   // fixed, closed enum — the retry loop and AIMD read this
  reason: string;
  retryAfterMs?: number;
  rateLimited?: boolean;
  detail?: D;
}
```

The invariance is not incidental. `Failure` exists so that "an llm call's failure, an execution's
failure, and a stored record's failure are the SAME value — which is what lets the retry loop and the
AIMD controller read a classification off any of them without re-deriving one from prose." A type
parameter that could vary `classification` would break `classifyError`, the retry machinery, and the
AIMD controller at once. A defaulted parameter is source-compatible, so every existing
unparameterized `Failure` keeps compiling.

Errors already travel as data at the exec layer — impls **resolve** with `Result<O, Failure>` rather
than throwing, `runFunction` never throws, and a failure branch may carry a partial value. What is
missing is that `Failure` lives in the *result envelope*, never in the *data plane*: hw's
`resolveRef` returns `{error}` and fails the state, and `exec` refuses to pass a failed `{result}`
("there is no value to pass").

### 5.1 The routing rule

**If the consuming slot's declared type accepts the error, it flows as a value. If not, the operation
terminates with it.**

The sharpening this needs: the check is static, the decision is dynamic. If the error branch were
part of the producer's declared output schema, then every ordinary binding — every slot that
sensibly does not accept errors — would become statically invalid, and lint would light up
everywhere.

So it is a separate predicate, not a schema union:

```text
admitsError(slotSchema) = does this slot's schema validate a canonical Failure value
```

Computed at load time, stored on the slot, consulted at run time to route-or-terminate. Ordinary
binding checks are unchanged.

### 5.2 Two consequences

- **Guard evaluation gains a fourth outcome.** With expressions as producer trees, an error raised
  inside `eq(classify(x), 'high')` propagates to a parameter that certainly does not admit errors —
  so a guard now yields `true` / `false` / `PENDING` / **error**, and the transition loop needs a
  terminate path it does not have today.
- **The handler spelling falls out.** A state whose output slot admits errors, plus
  `when: ".outputs.result.error.classification === 'policy-denied'"`. Because `ErrorClass` is a closed
  seven-member union, giving it an `enum` schema makes strict expression typing catch a misspelled
  classification as a lint error rather than a comparison that is quietly always false — the property
  `run.cursor` already has.

`encodedError.ts` already persists `{classification, reason, retryAfterMs}` as JSON "so a resumed run
re-reads the classification and reaches the same" decision. That is the canonical wire form; do not
mint a second one.

---

## 6. Laziness — deferred, and it is a correctness debt

`&&`, `||` and `?:` are not ordinary functions today. Evaluation short-circuits on *determinate*
values: `false && PENDING` is `false`, and a conditional evaluates only the taken branch. But
resolving an op's inputs resolves **every** bound parameter and returns `PENDING` if any one is.

Lower them to plain two-input ops and two things break, one of them silently:

1. `false && PENDING` becomes `PENDING`. A guard that fires today parks forever. **This is a
   behavior regression, not a cost regression.**
2. Once §3 admits arbitrary callees, the untaken branch of a conditional *runs* — with a budget
   attached.

**Interim:** `op.and`, `op.or`, `op.cond` stay hw resolver ops, resolved in `runResolver` and never
dispatched to `exec`. This is a special case, and it is the one the eventual work removes.

**To keep removal cheap:** define the three now with the exact names and signatures they would have
as registry entries, so migrating is deleting cases and registering functions.

**What it waits on:** `exec` has no representation for an unevaluated parameter — `resolveLiteralInputs`
rejects anything unresolved as a wiring bug. Generalizing means `Parameter.lazy` in `ops` plus a thunk
in `exec`'s input resolution. Tracked in [TODO.md](TODO.md).

---

## 7. What belongs where

The recurring finding of this design is that most of the machinery exists one or two layers down, and
that the layering is already settled by the code rather than open for negotiation.

| Layer | What it owns here |
| --- | --- |
| **`json`** | A JSON Schema for `Failure`, with `classification` as an `enum`; the `D` type parameter. Reuse `encodedError`'s wire form. |
| **`ops`** | `Parameter.lazy` as a declaration (deferred, §6). `Signature` on registry entries — optional, not a prerequisite (§3.4). |
| **`exec`** | **Nothing.** Dispatch, memoization, capability gating, retry, cancellation and error-as-data are built. A thunk representation only if §6's generalization happens. |
| **`hw`** | Everything else: expression→tree desugaring; operators as `RESOLVER_REFS`; callee reference resolution to an embedded document; `path` as an ordered default root; engine dispatch for author-embedded ops; reifying `Failure` into the data plane; `inferExpr` reading declared signatures; the source-map sidecar; the loader restructure (§9). |
| **JaiRA** | `path` in `.jaira/config.json` and its `$INHERITED` merge; the `Vfs` overlay serving `$/functions`; built-in op documents; lint output showing where a callee resolved and what it shadowed. |

---

## 8. Diagnostics

Desugaring at load time destroys the source text that error messages point into. `ExprError` carries
a character position today; a lowered tree does not, and "somewhere in a nested `op.eq`" is a
regression.

**A source map, held as a sidecar — not in the document.** `snapshotHash` hashes the *value tree*, so
spans stored inside the lowered nodes would make cosmetic reformatting of an expression change
workflow identity.

---

## 9. Ordering: the loader restructure

The loader currently desugars slots and child wiring **before** it merges the environment chain:

```text
… parse inputs → parse outputs → resolve children[].state → mergeOperationChain([inherited, env, op])
```

Every reference resolved in the first three steps now needs the merged `path` from the fourth. The
loader becomes strictly **merge-environment-then-resolve**, parent before child. This is a
restructure of state loading, not a parameter addition, and it is the first piece of work.

**Status: the ordering half is done** (hw `merge.ts`, `loader.ts`). `desugarState` computes the
environment before it desugars anything, and `resolutionEnvironment(inherited, own)` is now the one
definition of the chain — shared by a state's own effective operation and by what its children
inherit. What remains is threading it into reference resolution, which cannot land before `path`
exists (§4).

Unifying the two expressions of that rule turned up a bug they had already drifted into: `loadBundle`
computed the children's inherited environment from the **raw** document while `desugarState` used the
**expanded** one. A transcluded `environment` (`"environment": "$/lib/env"`) therefore reached the
state that declared it and never reached its children — and since the raw value is the reference
*string*, what the children inherited was that string spread character by character
(`{"0": "$", "1": "/", …}`). Both sites now read the expanded document. Covered by a test in
`inheritance.test.ts`.

A subtlety the remaining half must handle: a state's own `environment` may itself contain `$ref`
transclusions, which need a path to resolve. §4.2's rule that path entries may not be bare is what
breaks the cycle.

---

## 10. Open questions

- **Does `environment` stay the home for `path`?** §4.2 records the wart and why it was accepted. A
  top-level `resolution` block is the alternative.
- **`{error: …}` as a wrapper on the value position, or a distinct `RefKind`?** The wrapper is less
  machinery; the kind makes the opt-in structural. §5.1's `admitsError` predicate works either way,
  which is why this is deferrable.
- **Do the `RESOLVER_REFS` operators get their own namespace prefix?** The existing names are
  inconsistent (`select` bare, `scope.get` dotted). Worth settling before adding a dozen more.
- **Migration.** See §11 — the problem is not the one it first looks like.
- **Sandbox surface for call syntax.** §12 closed the prototype routes ahead of §3. What is still
  open is the callee side: `f(x)` where `f` resolves to a value rather than a reference. §3.2's
  "local child key, then reference" rule is what keeps a callee from ever being an arbitrary value —
  worth stating as an invariant in the implementation, not just a resolution order.

---

## 11. Two evaluations, two hashes

Everything in §1–§5 — path lookup, reference resolution, transclusion, expression lowering,
positional-to-named binding, signature reading — is **definition evaluation**. It runs once, before
anything executes, and it is not runtime evaluation happening early. Runtime evaluation is a separate
stage with its own inputs and its own product.

| Stage | Inputs | Product | Hashed as |
| --- | --- | --- | --- |
| **Definition evaluation** | authored documents + `path` + the loader | a fully resolved definition | the snapshot / pin identity |
| **Runtime evaluation** | resolved definition + instance data | a resolved operation | `hashOperation` → the memo key |

Each stage hashes the **output** of its own stage. `exec` already does this for the second — the memo
key is the content hash of an op whose parameters are all bound to literal values, which is why §1.2's
memoization needs nothing built.

**The first stage should work the same way, and today it does not.** `snapshotHash` covers
`bundle.source` — the authored documents — which is the *input* to definition evaluation, and
`loadSnapshot` re-runs the loader over stored files to get back to a definition. Pinning the input
means a pin fixes bytes rather than meaning.

### 11.1 Snapshot the resolved definition

Make definition evaluation a build step whose output is what gets stored, hashed, and pinned.

Every concern this section used to enumerate dissolves rather than needing a mitigation:

- **Loader drift under a pin** — there is no loader re-run. A pinned task deserializes a definition
  instead of re-deriving one, so a lowering change cannot silently alter a running task.
- **`path` resolution being project-dependent** — a resolved callee is *in* the definition. It does
  not need to be tracked into a referenced closure, because it is not a reference any more.
- **A format version folded into the identity** — unnecessary. A lowering change produces a different
  resolved definition, so it produces a different hash. Visible by construction.
- **Bundles built in code rather than loaded from files** — no longer a special case. Both are
  resolved definitions.

The existing `snapshotHashWithReferences` / `_external/` machinery exists to pull document-reference
targets into the identity, for a reason that is entirely correct — *"a referenced prompt or shared
type is part of what the workflow IS… leaving it out of the identity would let two materially
different workflows share a content address, and a task would pin one and run the other."* Snapshotting
the resolved definition satisfies that argument by construction: what was referenced is now inlined.

### 11.2 What this changed in the code — **done**

- `snapshotHash` hashes the resolved bundle rather than `bundle.source`.
- `ensureSnapshot` stores the resolved definition; `loadSnapshot` **deserializes** rather than
  calling `loadBundle`, and needs no options — there are no unresolved references left for a root to
  resolve. `views.ts`'s `bundleFor` follows.
- The referenced-file machinery is gone: `snapshotHashWithReferences`, the `_referenced/` copies,
  the portable-name mapping and the snapshot `Vfs`. A fragment is inlined, so it is in the identity
  by construction rather than by bookkeeping. `lifecycle.ts` no longer collects `onReferencedFile`.
- `stripDerivedId` and the JSON/YAML-equivalence argument for hashing a canonical value rather than
  bytes both survive unchanged — a resolved definition is a canonical value too, and more so.

**Two things the design note did not anticipate, both found by doing it:**

- **The loader re-run was also in hw's executor**, not only in JaiRA's snapshot store.
  `HierarchicalWorkflowDefinition` held raw `StateDef`s and both `WorkflowExecutor.start` and
  `workflowIdentify` called `loadBundle` on every start — so a pinned bundle was re-evaluated at
  execution time no matter what the snapshot stored. The definition is now the resolved
  `WorkflowBundle`; callers holding authored files run the pre-pass themselves, once.
- **Three call sites read `bundle.source` precisely because that was what a snapshot stored** —
  hw's own comment in `agents.ts` says so. Two of them are the §8.2 capability gate (`cli.ts`,
  `service.ts`), which would have fallen back to `{}` on a snapshot-loaded bundle and passed every
  pinned run silently: *a check that never fires is worse than no check, because it reads as one
  that passed* — which is the exact hazard that comment was written about. All three now read
  `bundle.states`; `functionRefOf` already accepted either shape.

### 11.3 What this sharpens

§8's source-map advice gets a stronger reason and cuts the other way from what that section implies.
With the *resolved* definition hashed, spans stored inside lowered nodes are in the identity — so
reformatting a workflow file, which does not change its canonical authored value, would change
character offsets and invalidate every snapshot downstream of it. The sidecar is not a preference; it
is what keeps cosmetic edits out of the pin.

### 11.4 Open

- **Is a resolved definition always serializable?** ✅ **Confirmed, after one fix.** A loaded bundle
  round-trips through JSON — schemas, derived output slots, expanded spreads, `slotMeta`, lowered
  operations and all — with one exception that had to be corrected first: `LoadedState.fanOut` was a
  `Set`, and `JSON.stringify(new Set([…]))` is `{}`. Every entry gone, no error raised. It is now a
  sorted array, sorted so the serialized form is stable whatever order the fan-out walk produced,
  which is what makes it safe to fold into a content hash. Not a live bug before this — nothing
  JSON-serializes a bundle today — but a silent one exactly where §11 depends on it. Invariant test
  in `loader.test.ts`.
- **What does the snapshot directory look like to a human?** ⚠️ **Now a real regression, accepted.**
  It used to be recognizably the workflow someone wrote; it is now the resolved form — same file
  layout, but desugared bindings, inlined fragments and derived output schemas. Storing the authored
  files alongside would fix it, at the cost of two things in a directory whose whole point is being
  content-addressed by one of them. Deferred rather than decided.
- **Old snapshots are unreadable** — the chosen hard cutover. A task pinned to a pre-change snapshot
  must restart on current workflows, which is the escape hatch DESIGN §5.3 already names as the only
  migration story. Nothing detects this and reports it nicely; `loadSnapshot` will simply fail its
  content-address check.

---

## 12. Prerequisite, done: property lookup on data is an own-property lookup

Found while reading the evaluator ahead of §3, and fixed before call syntax rather than after.

Native property lookup falls through to the prototype, so `constructor`, `__proto__`, `toString` and
every prototype method were readable wherever an author-controlled key indexed into data — yielding a
**function** as a value, in a dataflow that is JSON all the way down. `inferExpr`'s `projectProperty`
had always documented the intended rule (*"`.length` is the ONE property an array or a string
exposes"*), so the evaluator was disagreeing with its own type-checker.

Latent today only because the grammar has no call form. §3 adds one, and `x.constructor(…)` is the
standard route out of a sandbox — so this had to be settled first.

| Site | What leaked |
| --- | --- |
| `expr.ts` member access | `{"expr": ".inputs.o.constructor"}` → a function as a slot value |
| `inferExpr.ts` `projectProperty` | typed a prototype name as `ANY` instead of reporting a bad reference |
| `resolve.ts` `select` | `{"child":"c","output":"constructor"}` → a function, not "no such output" |
| `reference.ts` `selectProperty` | `$/types/user.constructor` → a function spliced in by transclusion |
| `validate.ts` producer-schema check | a function used as a schema; the "does not declare" error skipped |
| `shape.ts` `fieldShape` | a document key named `constructor` got a function as its `Shape` |
| `engine.ts` permission lookup | a tool named `constructor` resolved its permission mode to a function |

**And the write-side variant.** `JSON.parse` creates `__proto__` as a real own property rather than
invoking the setter, so it reached the merge through `Object.entries` — and assigning it back out
*did* invoke the setter, replacing the merged operation's prototype with authored content. The result
carried fields that property access saw and `Object.keys`, spread and `JSON.stringify` did not.

That one was corruption without a victim: every consumer reads the merge result through a later
`{...base}` spread, which drops the prototype again. It would have stopped being harmless at exactly
§4 — an inherited `path` is read off the merge result **directly**, so `__proto__` would have become
a way to inject a root deciding where references resolve from, invisible to anything enumerating
keys. `merge.ts` now refuses the key.

Covered by regression tests in `expr.test.ts`, `references.test.ts`, `resolve.test.ts` and
`inheritance.test.ts`.

---

## 13. Superseded: hashing the authored form

Kept because the reasoning is the natural first answer and the reason it is wrong is not obvious.

The first answer to "does this design invalidate every snapshot?" is *no, because `snapshotHash`
covers `bundle.source` — what the author wrote — and desugaring happens downstream of it.* That much
is factually true of the code today.

The mistake is what follows from it. Treating the authored form as the identity makes the snapshot
the **input** to definition evaluation, so `loadSnapshot` has to re-run the loader, and a pin fixes
bytes rather than meaning. That framing generates a chain of problems that all look real:

- semantic drift when a pinned task re-loads through a newer loader, with no hash change to signal it;
- `path`-resolved callees needing to be tracked into the referenced closure, since they are resolved
  against the project filesystem rather than the snapshot;
- a loader/format version folded into the identity, to make the drift visible;
- programmatically built bundles (no `bundle.source`) behaving differently from authored ones.

None of these are worth solving. They are artifacts of hashing the wrong stage's output — §11 removes
all four by hashing the resolved definition instead.

---

## 14. One grammar: a dot is data, a bare name is a document — **built**

**Status: built.** A binding may be written as an expression with no wrapper, the leading dot is
required in every position, and a bare name anywhere resolves along the search `path`.

The starting complaint was small: `{"expr": "add(children.a.outputs.n, 1)"}` needed a wrapper that
`".inputs.issue"` did not, for no reason a reader could name. Fixing it turned out to need a rule
rather than a special case, because a binding string and an expression string overlap: both can be
a dotted path, and something has to decide what one means.

### 14.1 The rule, and why it is not a classifier

The first two designs were both wrong in the same way. Both asked *"is this string a reference or an
expression?"* and answered with a test on the string — a lexical one (does it contain parens or
operators?) or a positional one (is it the whole binding, or nested inside a call?). Both produce a
grammar with a seam in it, and a seam is a thing to maintain and eventually get wrong.

There is no seam, because there is nothing to classify:

> **A leading dot names a property of the current state. A bare name names a document, resolved
> along the search `path`.**

That is one rule, applied at every depth, and it makes a binding string and an expression string the
same language. `"binding": "add(.inputs.n, 1)"`, `"when": ".run.cursor === 'plan'"` and
`"binding": ".inputs.issue"` differ in what they compute, not in how they are read.

**The consequence is a migration, and it is the right way round.** It was the BARE spelling that used
to read runtime data inside an expression — `children.a.outputs.n` — so every guard, every `{expr}`
and every `{{…}}` template hole gained a dot. Roughly 260 sites across two repositories. What is
bought is that the rule now needs no exceptions section.

### 14.2 What made the reversal necessary

REFERENCES.md §5 originally made the dot *optional* inside an expression, on solid-looking reasoning:

> an expression can only ever address runtime space — there is no file-path alternative in that
> position

That premise was true when written and stopped being true at §3, which gave an expression call
syntax whose callee is a reference along the `path`. From then on an expression addressed both
spaces, and "bare means runtime" was a second rule competing with the one every other position used.
The doc kept asserting the old rule after the code had outgrown it — including claiming the dot was
*accepted* inside an expression when the parser in fact rejected it.

### 14.3 What a bare name resolves TO decides how it reads

The design mistake worth recording is a false dichotomy: is the target a binding *declaration* to
splice, or a *value*? Neither. It is whatever is there, and its own shape says how it reads —
REFERENCES.md §3's mismatch principle applied to the target rather than to the position.

| Resolved node | Reads as |
| --- | --- |
| a binding form (`{child}`, `{expr}`, `.inputs.x`) | that binding, re-entering the desugarer |
| an operation document | the operation — §3.1's higher-order value |
| text (a `.md`) | a text literal |
| anything else | a JSON literal |

`bindingForDocument` is that dispatch, and it is deliberately ONE function with two callers reaching
it from opposite directions: expansion, splicing a path written as a whole binding, and lowering,
resolving a bare name inside an expression. `"binding": "lib/x"` and `"binding": "id(lib/x)"` have to
agree about what `lib/x` is.

**The `.md` case needs the file type, and only expansion has it.** A prompt fragment's text and a
JSON string are both strings by the time anything downstream sees them; without the extension, a
transcluded prompt would be parsed as an expression.

**Wrapping data happens in expansion, not in the desugarer, and that is what keeps typo detection.**
Only expansion knows a value arrived from a *file*, which is what licenses reading an unrecognized
object as data. An unrecognized object typed inline is a misspelled binding tag and still errors, as
it always has.

### 14.4 What the change did NOT touch, and why that was the design

`.inputs.n` lowers to precisely the tree `inputs.n` used to lower to — `context.get` at the root,
`op.member` above it. Only the surface syntax moved. So `fanout.ts`, `pathOfRef`,
`referencePathsOf`, `resolve.ts` and the validator's reachability walk all needed **no change at
all**: they read the lowered form, which is unchanged. A change to a language's syntax that reaches
its dataflow analysis is a change that has gone wrong somewhere.

Three things fell out rather than being built:

- **The callee sandbox closes structurally.** `pathOf` returns `undefined` for a self-rooted chain,
  so runtime data can reach neither callee position nor a `/` path segment. §10's open question about
  keeping a callee from being an arbitrary value is now a property of the AST rather than a rule to
  remember.
- **`selfPathOf` and `pathOf` are exactly disjoint** — one of them answers for any given chain, and
  which one is decided by the dot. That is the rule as a pair of functions.
- **`inferExpr`'s duplicate `pathOf` went away.** It had drifted into being a private copy of
  `expr.ts`'s; unifying them is the same discipline §2 applied to `applyBinary` and `memberOf`.

### 14.5 The diagnostics, which are load-bearing here

A migration this wide is only safe if the failure is loud and names the fix. Two do:

- an unresolvable bare name whose head is a runtime namespace says *"'children.a.outputs.n' resolves
  to no document on the search path — did you mean '.children.a.outputs.n', which reads this state's
  data?"* A resolver message about the filesystem would send the reader hunting for a missing file.
- **a template hole is recognized WITHOUT the dot and then fails to lower.** A regex demanding the
  dot would leave `{{inputs.x}}` unrecognized and render it as literal text into the prompt — the
  same mistake, silently. Relatedly, `renderTemplate` now lowers *outside* its `catch`: a hole that
  cannot be lowered is an authoring error, while a hole that lowers and does not resolve is
  legitimately empty, and swallowing both made the first look like the second.

Two failure modes also separate cleanly, which is the rule paying rent: `.bogusroot.x` is a runtime
read of a namespace that does not exist — a validator error — while `bogusroot.x` is a reference to a
document that does not exist, and fails at load.

### 14.6 Open

- **A call in a guard still cannot resolve its callee.** `engine.ts`'s `exprRef` lowers with no
  options, so `resolveOperation` is absent — pre-existing, and unrelated to the dot, but §3's claim
  that a call works "in operation inputs, output bindings and guards" overstates the third. Guards
  would have to be lowered at load, like every other expression, rather than at first evaluation.
- **`resolveDocument` is called twice for a binding path** — once inside `expandReferenced` and once
  to learn the file's extension. Correct and cheap at load time, but it is a seam where a future
  caching layer would have to keep both in step.

---

## 15. One spelling per thing — **built**

Nothing has released, so a compatibility spelling is pure cost: a second thing to
document, to test, and to keep meaning what the first one means.

**The four tagged binding forms are gone.** `{child}`, `{input}`, `{artifact}` and
`{conversation}` each said one thing the dotted spelling says, and were kept beside it
while workflows migrated (REFERENCES.md §10, "available, not enforced"). Their lowerings
moved INTO `desugarRuntimeReference`, the only caller that still needed them — `.inputs.x`
builds its `scope.get` edge directly rather than round-tripping through an `{input}` object
the loader then takes apart again.

`{expr}` survives, and not as compatibility: §14 makes a bare string an expression too, so
the wrapper is a choice about emphasis rather than a second mechanism.

`resolve.ts`'s `NON_TREE_FORMS` shrank with them. It listed every sugar keyword so a form
written inside a `refs` tree — where the loader does not walk — was NAMED rather than
recursed into until the stack died. Four of the six no longer exist.

**`sessionId` is refused, not accepted.** It was a synonym for `session` so an
`LlmConfiguration`-shaped block could paste in unchanged. What that cost: an equality check
at parse, a normalization that had to run BEFORE the merge (or a child's `sessionId` would
sit beside an ancestor's `session` instead of overriding it), and a rule about which
spelling wins — to save an author one rename.

**Refused rather than ignored**, which is the part worth keeping. `sessionId` is not in
`OPERATION_OWN_FIELDS`, and anything unrecognized is passed through to the LLM call
configuration — so silently dropping it would ship the author's session declaration to the
model as a call parameter while the operation quietly started a fresh conversation. That is
the same hazard §4.2 records for `path`, met from the other direction.

---

## 16. A conversation is read by REF — **built**

`messages(<session ref>)` is the only way to read a conversation:

```jsonc
"when": "at(messages(.operation.output.session), -1).content === 'continue'"
"when": "len(messages(.children.plan.operation.output.session)) > 4"
```

### 16.1 The namespace it replaces was already dead

`.conversations.<name>` looked a session up by NAME. The engine mirrors transcripts under
the session's **id** — a position, `planning@3` — so the lookup matched only before any call
had happened. From the first call on it missed, and the resolver refused with *"conversation
'planning' is not available"*.

Nothing had noticed, because the failure needs a workflow that reads a conversation after
writing to it, and the tests that covered the namespace wrote nothing. This is the shape of
bug a position model creates on the way in: a name that used to be an address quietly stops
being one, and the code that took names keeps compiling.

### 16.2 What it cost to add: almost nothing

Every piece existed. `.operation.output.session` was already a typed, opaque `{ id }` ref
with `additionalProperties: false`. `conversation.get` was already the resolver that reads a
transcript **synchronously** — which is load-bearing, because `resolveRef` cannot be async
and a guard resolves inside `firstMatchingTransition`.

So `messages` is an **alias** onto `conversation.get`, applied at parse exactly as `===`
becomes `op.strictEq`. Syntax is sugar, the operation is the meaning, and the AST carries the
operation — so `messages(s)` and `a === b` are one kind of node by the time anything
downstream looks, and neither needs a case of its own.

It is a resolver rather than a `builtins.ts` function because it reads the run's mirrored
transcripts, and the built-in library is pure and synchronous by construction with no scope
to read.

### 16.3 Three decisions

- **The argument is a ref, never a string.** A bare string would be a second spelling, and
  the plausible thing to write by hand is a session NAME — which addresses nothing. Refusing
  it is what stops §16.1's bug being reintroduced by an author rather than by the code.
- **Turns are typed** `{ role, content }`, so `at(messages(s), -1).content` is checked and
  `.text` is a lint error. The property `run.cursor` already has, and the reason for typing a
  closed shape at all. Both inference paths carry it — the AST one and the lowered-tree one —
  because the differential test requires them to agree.
- **Reading a sibling's conversation flows as DATA.** The parent wires
  `.children.plan.operation.output.session` into a child's input, and the child calls
  `messages()` on it. More verbose than a name, and correct for a reason the name never was:
  an operation that declared no session has no name at all, and was previously unreadable.

### 16.4 Open

`conversationModesOf` still maps a state declaring no session to the name `"default"`, which
nothing produces — an undeclared session is a fresh per-instance stream (`s_i<n>`,
unauthorable). Summary mode therefore never fires for one, which is the case that grows
fastest, since such a conversation is joined by dataflow and can span many calls.

The fix is not to patch the mapping, because there is no name to map TO. The opt-in has to
key on the DECLARING STATE, which the name was standing in for while sessions were names;
`sessionRequest.seed` carries `<stateId>:<session.id>` and is the available hook. One
wrinkle shapes it: `messages(ref)` carries no request, so the store must LEARN a lineage's
opt-in at resolve time and apply it on later reads. That works — a conversation only grows
past one call after a resolve — but it changes what `modes.conflicts` is checking.

---

## 17. `.each` — fan-out is an expression, designed

**Status: designed, not built.** This is the successor to §3.5: `map(xs, f)` runs an *operation* per
element, and what authors keep reaching for is a *state* per element — a child with its own subtree,
its own approvals, its own session. `.each` is one operator covering both, with the operation-level
case falling out as the degenerate one.

The motivating shape: a prompt op returns an array of items, and each item should be handled by a
child state.

```jsonc
"children": {
  "review": {
    "state":  "./review_item",
    "async":  true,
    "inputs": { "item": ".children.extract.outputs.items.each", "ctx": ".inputs.context" }
  }
}
```

### 17.1 One rule: distribute over the axis, collect at the enclosing binding

`.each` marks an **axis**. The expression it appears in is evaluated once per element of that axis,
and the results are re-collected at the edge of the enclosing **binding**. That is the whole
definition, and it is jq's `.[]` — a stream the enclosing construct collects — rather than a new kind
of node.

Everything else follows from where that boundary falls:

| Position | Boundary | Effect |
| --- | --- | --- |
| `children.<key>.inputs.*` | the child mount | N child **instances** — a scatter |
| an output slot's `binding` | the slot | one value, an **array** |
| `operation.input.*` | the parameter | one value, an array — this is `map` |
| a transition `when` | the guard | an array where boolean is required ⇒ **lint error**, free |

⚠️ **The same text scatters in one position and maps in another.** `.children.review.each.outputs.report`
is N instances when it wires a mount and a `T[]` when it fills a slot. The rule is uniform — only the
boundary differs — but this belongs in [WORKFLOWS.md](WORKFLOWS.md) §13 as its own line, because
nothing about the text says which one is meant.

This subsumes §3.5 rather than sitting beside it: `classify(.inputs.issues.each)` **is**
`map(.inputs.issues, classify)`. `map`/`filter`/`flatMap` stay as the named spellings; `.each` is the
primitive, and it is strictly more expressive (§17.2).

### 17.2 Axis identity is SYNTACTIC, and distinct axes multiply

Two `.each` occurrences name the same axis **iff they are applied to the same source expression**
after lowering. Distinct axes take the **cartesian product**; a repeated axis is correlated.

This is Einstein index notation, and saying so is the cheapest way to teach it: a repeated index
correlates, distinct indices multiply. Correlation is therefore written by naming an axis and using
it twice:

```jsonc
// the parent state
"inputs": {
  "items":   { "schema": { "type": "array" } },
  "indexes": { "binding": "range(0, len(.inputs.items))" }
},
"children": {
  "review": {
    "inputs": {
      "item":      "at(.inputs.items,      .inputs.indexes.each)",
      "otheritem": "at(.inputs.otheritems, .inputs.indexes.each)"
    }
  }
}
```

**Why identity cannot be the resolved value.** That was the first proposal, and cartesian kills it: if
`.items` and `.otheritems` happen to hold equal arrays at run time, value-identity collapses them to
one axis and dispatches 2 instances rather than 4. The number of child instances would depend on the
data. The shape of a run has to be a property of the document.

A near-miss worth stating: `.inputs.indexes.each` and `range(0, len(.inputs.items)).each` are two axes
and multiply, even when `indexes` is bound to exactly that expression. Which is *why* the idiom names
the axis first — `indexes` reads as a loop-variable declaration, because that is what it is.

**Where the loop variable lives.** As a bound input slot on the state that owns the loop. Not as a
sibling entry in the mount's own `inputs` block: every binding there resolves against the PARENT
instance's scope, whose roots are fixed (`inputs`, `outputs`, `operation`, `children`, `artifacts`),
so one sibling wire is not addressable from another — and a wire naming an input the child does not
declare is a lint error today, and would never be resolved even if it were not. A parent input with a
`binding` is resolved at instance entry, before any child is entered, so it is in scope exactly when a
mount needs it. Repeating the axis expression at both use sites works identically and needs no slot;
the slot is the de-duplicated spelling, and it is typed and lint-visible besides.

This is also where `.each` exceeds `map`: `concat(.a.each, .b.each)` is an outer product, and no
composition of `map`/`flatMap` expresses it. `.each` is the primitive and the named forms are the
special cases, not the reverse.

### 17.3 The gather half: `.children.<key>` becomes an array of records

The transformation is a pair — scatter on the way in, gather on the way out — which is WDL's
`scatter` (a scattered call's outputs become arrays of that output's type).

**The array lives at `.children.<key>`, not at `.children.<key>.outputs`.** What a fanned mount
produces is N child *records*, each `{outcome, outputs, operation}`, and the elements of one record are
connected — which output came from which outcome is information, and struct-of-arrays discards it. So
every read is uniform:

```jsonc
".children.review.each.outputs.report"          // T[]
".children.review.each.outcome"                 // Outcome[]
".children.review.each.operation.output.session"
```

Reorganizing is the author's job, in an output binding, with the same operator — `.each` is the
projection tool as well as the scatter marker, so there is no `pluck`, no lambda, and no
struct-of-arrays alias.

**What this costs, and why it is acceptable.** `.children.k.outcome === 'success'` is the most common
guard in the language and it stops typechecking. The objection mostly dissolves: an element
terminating `error` with no transition handling it is *already* fatal to the parent, and extending
that elementwise means the author who wants "all of them must succeed" writes no guard at all. What is
left is deliberate branching on PARTIAL failure, which has no cheap spelling — guards infer to boolean
strictly, and `filter` takes a predicate by NAME, so today it needs a project-level operation document.
Two `any`/`all` built-ins over boolean arrays would close it (§17.8).

⚠️ The validator must special-case `.children.k.outputs.report` on a fanned mount with "this mount fans
out — write `.each.outputs.report`". Without it the arity change surfaces as an opaque type error at a
read site far from the mount that caused it.

### 17.4 Results are flat, and only single-axis order is promised

A multi-axis mount yields **N×M instances, flat** — `Record[]`, not nested — so the read type does not
vary with the number of axes. An instance that needs to know which combination produced it echoes its
inputs into its own outputs; under the index idiom the author who cares already holds the index.

- **Single axis: source-array order**, which is what `map` already promises implicitly. The common case
  must not inherit the rare case's caveat.
- **Cartesian: unspecified.** But unspecified ≠ nondeterministic — the enumeration stays a pure
  function of the inputs, or a resumed run reassembles results in a different order than the original
  once durable mid-run resume lands.

⚠️ For WORKFLOWS §13: **never correlate a fanned result back to a source array by index.** Echo the
input into the child's outputs instead.

### 17.5 `.each` is surface syntax; it lowers to an explicit fan-out node

The cost of an inline marker is that `children.review` becomes one instance or forty based on a marker
buried in the fourth of six bindings, while the consumer twenty lines away silently changes type. That
is the trap class WORKFLOWS §13 exists to enumerate.

So `.each` lowers to a **fan-out node on the mount**, exactly as the tagged binding forms lowered to
`select` and as `{child, output}` did before them. The loader is where it happens, and everything
downstream reads the lowered form: one declared key carrying an axis. Which means

- the blob fan-out tally, the validator's `childrenProps` typing, reachability, the board and
  `jaira workflow lint` need no knowledge of `.each` at all;
- `keyBy` and any per-mount cap live on the node, writable directly by the rare author who needs them
  and absent from everyone else's file;
- lint and the board can DISPLAY the axis even though nobody typed a `forEach:` field.

The upstream prerequisite for this has landed: `consumptionOf` (hw `format.ts`) is now the single owner
of "what does this path shape consume", replacing the positional `path[2]` tests in the fan-out tally,
so a namespace that grows an `each` segment is one edit rather than a hunt through three places that
each fail silently. See §1.3 — a miscounted consumer is a wrong number, not an error.

### 17.6 Limits declare what they meter

Cartesian makes a stray second axis a valid workflow costing N×M rather than a lint error, and for a
*state* fan-out each instance may carry a worktree, a session and an approval gate. Max-parallelism
bounds resource pressure; it does not bound COUNT — 8-at-a-time over a 50×40 mount is still 2000 agent
runs. So:

- **A lint warning when a mount has more than one axis**, naming them and the product. It is the only
  thing that catches the typo.
- **A limit declares its scope**, `"scope": "subtree" | "operation"`, rather than a `leafOnly` flag.
  "Leaf" mis-describes precisely the state a fan-out creates: one with both an operation and children
  is not a leaf, but it does have a unit of work. With the scope named on the limit,
  `environment.limits` merges nearest-wins like every other environment field and §5.2 needs no
  exception.

The scope flag earns its place on the third combination: an inherited `max_children` is subtree-scoped
and not per-operation, which the declaring block alone cannot express.

⚠️ The fourth combination is the trap — an inherited `timeout` with `scope: subtree` gives every
descendant its own full budget, so a "2 hour" bound permits arbitrarily more than two hours in total.
Lint it, or name it in §13.

### 17.7 Settled edges

| Case | Behaviour |
| --- | --- |
| Empty axis | Zero instances, `[]`, immediate success. A sync mount must **not** park. |
| Axis is `PENDING` | The mount parks — the existing dataflow join, unchanged. |
| Nested `.each` (array of arrays) | Refused in v1; `flatMap` covers it. |
| Per-element blob outputs | An array of live streams is not readable in order, so a fanned mount drains each element. `materializeFanOut`'s single-stream assumption breaks. |
| Element identity | Positional, with a content-key opt-in on the lowered node. Deliberately **not** inherited from `map`'s content-hash memo: collapsing two equal elements into one execution is right for a pure call and a different proposition when the instance owns a worktree and an approval. |

### 17.8 Open

- **`any`/`all` over boolean arrays** — needed only for deliberate partial-failure branching, so
  deferring is defensible. But then the elementwise-fatal rule is the *entire* failure story for a
  fanned mount, and that should be a stated decision rather than an omission.
- **Is `max_iterations` enforced?** It is a value exposed to guards and nothing more. With `timeout`
  enforced and `max_children` proposed as enforced, one advisory entry in a block of bounds is a trap
  of the same species as the ones this document keeps cataloguing.
- **Does `.each` collect at anything narrower than the binding edge?** Keeping the binding as the sole
  boundary is predictable, and it is what makes the guard case a free lint error. The cost is that
  `all(.children.k.each.outcome === 'success')` cannot work as written — the array materializes before
  `all` sees it — so the aggregate spelling has to take an `Outcome[]` rather than rely on
  distribution inside a call.
