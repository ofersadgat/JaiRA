# Design note: an expression is an operation

**Status: mostly built.** Expressions lower to producer trees (§1), the operator set is a registry
(§2), an expression can CALL an operation — prompt or function — resolved along a search `path`
(§3, §4), snapshots pin the resolved definition (§11), failures travel as data (§5), and the built-in
operation library ships (§3, `builtins.ts`). What remains is higher-order operations (§3.5) and the
items in [TODO.md](TODO.md).

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

`{"expr": "children.review.outputs.severity === 'high'"}` currently lowers to **one** edge carrying
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
"when": "classify(inputs.issue).severity === 'high'"
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
  oracle (the bundle's own file map, or the vfs), which is a separate decision.
- **JaiRA's half is now built too**: `config.workflows.path` (default
  `["$JAIRA/workflows", "$JAIRA/functions"]`), expanded against the same `$JAIRA`/`$PROJECT` roots a
  reference uses, and passed at every load site. The parser refuses a **bare** entry outright,
  because that failure is otherwise circular and baffling — a bare path entry would need the path to
  resolve itself.

  The workflows directory is forced **first**, whatever the config lists. Configuration decides what
  comes *after*: only the first entry produces bare state ids, and a bare id keys the snapshot hash,
  the event log and task rows, so letting configuration reorder it would silently re-identify every
  state in the project.

  `$JAIRA/functions` is in the default path before anything is in it. That is safe — an entry naming
  a directory that does not exist lists as empty and the search moves on — and it means §3's callee
  documents have a home the day they are written. The `Vfs` overlay serving *built-in* documents
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

| Form | Consults `path`? |
| --- | --- |
| `/opt/x`, `file:/opt/x` | no — itself |
| `$JAIRA/lib/x`, `$/functions/eq` | no — that root |
| `./goals`, `../shared/lint` | **no** — anchored to the referring state's own id |
| `eq`, `feature/plan` | **yes** — first match wins |
| `.inputs.issue` | n/a — a property of this file, not a file reference |

`./x` never consulting the path is what a shell does, and it is also what the existing rule requires:
a relative reference is anchored to the referrer's id-as-a-directory, and searching would make that
meaningless.

The mechanism is small. `defaultRoot` is already documented as a **per-field** notion — "a bare path
hangs off a per-field DEFAULT ROOT" — so `ReferenceOptions.defaultRoot` becomes
`string | readonly string[]`, tried in order. Everything else — `$VAR` roots, `./`, absolute,
`file:`, and longest-match `splitAtFile` — is untouched.

### 4.1 Identity stays anchored to the primary root

This is the rule that keeps the change safe. Both `ref.ts` and `reference.ts` say why:

> The canonical id keeps the BARE spelling whenever it lands under the default root. The id is an
> identity — it keys the snapshot hash, the event log, task rows, and `$STATE_ID`. If `feature/plan`
> canonicalized to an absolute host path, every stored snapshot would drift the day this shipped,
> and one workflow would carry different ids on two machines.

If `identityOf` folded a match back to a bare id against *whichever* path entry matched, two
different files at two entries would both produce the bare id `foo` — a collision in the thing that
keys the snapshot hash and the event log.

**So: `path` decides lookup; only the first (project) entry produces bare ids.** Anything found
further along canonicalizes to an absolute POSIX path, which is what out-of-tree references already
do. `eq` gets an absolute id, correctly — it *is* out of tree.

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
  `when: "outputs.result.error.classification === 'policy-denied'"`. Because `ErrorClass` is a closed
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
| `expr.ts` member access | `{"expr": "inputs.o.constructor"}` → a function as a slot value |
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
