# Design note: one reference type

**Status:** implemented. The grammar, expansion, the operation union, runtime references and the
snapshot closure all ship; `@declarative-ai/hw`'s `reference.ts` / `shape.ts` / `expand.ts` are this
document in code, and [WORKFLOWS.md](WORKFLOWS.md) is the authoring reference.

One thing here is NOT built: the tagged binding forms (`{"child": …}`, `{"input": …}`) still work
alongside the new spelling rather than having been removed. Both lower to the same base ref, so
nothing downstream can tell them apart — the migration in §10 is available, not enforced.

Today "point at a thing" has three unrelated spellings: a state id is a path
(`feature/plan`), a binding is a tagged object (`{"child": "c", "output": "x"}`), and an
expression or prompt variable is a dotted string (`children.c.outputs.x`,
`{{.inputs.issue}}`). The last two address the same namespace in two syntaxes, and none of
them can name something in another file. This collapses all of it into one reference type.

---

## 1. The grammar

A reference is a URI-ish path in two halves:

```text
<file-path> . <property-path>
```

The **file path** identifies a file — what we used to call the state id. The **property
path** says what within it. Either half may be empty.

| Form | Means |
| --- | --- |
| `feature/plan` | a file, whole |
| `feature/plan.outputs.plan_doc` | a property of that file |
| `.children.critique.outputs.outcome` | a property of **the current file** |
| `./goals`, `../shared/lint` | relative to the referring state's own id |
| `$/types/markdown` | `$` is shorthand for `$JAIRA` |
| `$JAIRA/lib/prompts.review` | a named root — `$JAIRA`, `$PROJECT` |
| `/opt/workflows/review`, `file:/opt/…` | absolute |

A **bare** file path hangs off the field's default root, `$JAIRA/workflows`. The leading dot
is what distinguishes "a property of this file" from "a sibling file":
`documentation.children.x` names the `documentation` file; `.children.x` names this one.

Anything else — `https:`, `git+ssh:`, an unknown `$VAR` — is refused rather than guessed at.

### 1.1 Where the file path ends

By **longest match against the directory listing**, the way a module resolver works. Take
everything before the last `/` as the directory, list it, and find the longest filename that
prefixes the remainder. What's left is the property path.

| Reference | Directory holds | File | Property path |
| --- | --- | --- | --- |
| `$/prompts/review.md` | `review.md` | `review.md` | — |
| `$/types/user.address` | `user.json` | `user.json` | `address` |
| `feature/plan.children.critique` | `plan.json` | `plan.json` | `children.critique` |
| `$/types/schemas.json.markdown` | `schemas.json` | `schemas.json` | `markdown` |

This replaces an earlier proposal to hard-code a list of recognized extensions. Longest match
needs no such list, admits any extension, and turns "no such file" into an error where the
reference is *parsed* rather than a reference that parses cleanly and fails later.

For an **extensionless** reference the probe order is `.json`, then `.yaml`/`.yml`, then the
name as written.

Three consequences, and the diagnostics that cover them, are in §9.

---

## 2. Three verbs over one grammar

The grammar unifies; what you *do* with a reference does not. Keeping the three apart is what
makes the whole thing tractable.

| Verb | Spelling | Resolved | Example |
| --- | --- | --- | --- |
| **Name** a state to run | bare path in a reference-typed field | load | `"state": "./critique"` |
| **Transclude** a document node | a shape mismatch (§3) | load | `"operation": "$/lib/review.operation"` |
| **Read** runtime data | a dotted path in a binding or guard | run | `.children.critique.outputs.outcome` |

Transclusion is **templating**: the referenced node is spliced in and then behaves exactly as
if it had been typed there. It duplicates configuration; it does not create a live link.

That is what makes cross-file references well-defined. A *runtime* reference into another
file would have no instance to resolve against — a state can run many times, and re-entry,
iteration, and fan-out all multiply instances — which is precisely why bindings are
structural today. Transclusion sidesteps the question by resolving before anything runs.

**Runtime references are always current-instance**, i.e. always start with the leading dot.
There is no cross-file runtime reference.

---

## 3. How a reference is recognized: shape mismatch

No sigil in the common case. The **declared type of the position** decides:

- the position expects an **object or array** and holds a **string** ⇒ the string is a reference;
- the position expects a **string or scalar** and holds `{"$ref": "…"}` ⇒ that's a reference.

A string where a string is expected is a string. An object where an object is expected is an
object. Only a mismatch signals a reference, so the sigil appears exactly where referencing
is rare.

```jsonc
"operation": "$/lib/review.operation",          // object position, string  → reference
"prompt": "Extract goals from {{.inputs.issue}}", // string position, string  → literal
"prompt": { "$ref": "$/prompts/goals.md" },      // string position, object  → reference
"when": { "$ref": "$/lib/guards.clean" }         // string position, object  → reference
```

| Expected type | Reference spelled as | Positions |
| --- | --- | --- |
| object / array | a bare string | `operation`, `environment`, `inputs`, `outputs`, `children`, `children.<key>`, `schema`, `binding`, `transitions`, `sequence`, `limits`, `permissions`, `args` |
| string / scalar | `{"$ref": …}` | `prompt`, `system`, `when`, `function`, `session`, `label`, `description`, `model` and the rest of the prompt op's call fields (§7.2) |

Two fields are **reference-typed strings** rather than plain ones — `id` and
`children[].state`. They hold a path and are resolved as one; the mismatch rule keys off the
declared field type, so this is a fact about the format schema, not an exception to the rule.

`id` is by definition a reference to the current file, so a declared one must resolve to
itself.

### 3.1 Untyped positions

A function operation's argument bag is `Record<string, JsonValue>` — the expected type of any
value in it is "any JSON", so the mismatch rule has nothing to key off. There, **only the
explicit `{"$ref"}` form counts**, and a literal object with a `$ref` key is unrepresentable.

That untyped bag is inherent — only the function knows its own arguments — and confining it
to one field is the point of §7.2. Everything on a *prompt* operation is typed, so the
mismatch rule covers it entirely.

---

## 4. Transclusion

### 4.1 Merging

Sibling keys **override** the referenced node:

```jsonc
"operation": {
  "$ref": "$/lib/review.operation",
  "model": "anthropic/claude-opus-4-5"
}
```

Key **order is ignored**. It has to be: the snapshot hash canonicalizes with JCS (RFC 8785),
which sorts keys lexicographically, so `{pre, $ref, post}` and `{post, $ref, pre}` hash
identically. Giving order meaning would let two semantically different workflows share a
content address, and a task could then pin and execute a workflow it did not author.

The merge uses **the algebra already implemented for `environment` inheritance** — deep per
key for maps, whole-value replacement for arrays and for `prompt`/`schema`/`binding`. One
composition semantics for the format, not two.

### 4.2 Cycles

`a.operation` → `b.operation` → `a.operation` is a load error naming the cycle.

### 4.3 What a reference resolves *to*

By file type:

| Extension | Value | Property path |
| --- | --- | --- |
| `.json` | parsed JSON | applies |
| `.yaml` / `.yml` | parsed YAML | applies |
| anything else | the file's **text** | an error if non-empty |

JSON and YAML are interchangeable: both parse to the same value tree, and nothing downstream
can tell them apart. `snapshotHash` already hashes the *parsed, canonicalized* value rather
than the raw bytes, so a state authored in YAML and the same state in JSON hash identically —
content identity, not spelling identity. That falls out with no work.

This applies to **workflow files too**, not just referenced data: a state may be authored as
`plan.yaml` instead of `plan.json`. (One file is one *state*; a *workflow* is a root state
plus its transitive closure, so it is many files. Where this note says "state file" it means
the individual file.)

Only a YAML **reader** is ever needed, never a writer, which halves the dependency:

- a state normalizes to JSON when written into a snapshot, as it already does — the snapshot
  re-serializes it anyway to strip a derived `id`, and the hash is over the parsed value, so
  normalizing changes nothing;
- a referenced non-state file (`.md`, `.yaml` data) is copied **byte-for-byte** into the
  snapshot, never re-serialized.

What it touches: `stateIdFromPath` (strips `.json`/`.state.json` today), the four
directory walks that filter on `.json` (`readWorkflowFiles`, the browser's tolerant read,
the snapshot walk, and directory inference), and the extensionless probe order in §1.1.

YAML is a superset of JSON, so three rules apply on parse:

- the value must be **JSON-representable** — no non-string keys, dates, or `NaN`, or it cannot
  be canonicalized or snapshotted;
- **anchors and aliases** may produce cycles, which `canonicalize` refuses outright — a load
  error with a real message, not a stack overflow;
- **duplicate keys** are an error, not last-wins.

---

## 5. Runtime references

In a binding or a guard, a leading-dot path reads this instance's data. The namespaces are
unchanged; only the spelling is.

```jsonc
"binding": ".children.critique.outputs.outcome"
"binding": ".inputs.issue"
"binding": ".artifacts.design_doc"
"binding": ".conversations.review.messages.0"
```

The leading dot is **required everywhere**, including inside an expression. ⚠️ This
reverses an earlier rule — the dot used to be optional in an `{"expr": …}`, on the
reasoning that an expression "can only ever address runtime space, so there is no
file-path alternative in that position."

That premise stopped being true when an expression gained call syntax (EXPRESSIONS.md §3).
A callee is a reference resolved along the `path`, so an expression addresses *both*
spaces, and a bare name has to mean one of them. Making it mean a document — the same
thing a bare name means in every other position — is what lets one rule cover the whole
format:

**A leading dot is a property of the current state. A bare name is a document on the
search path.**

The rule pays for itself immediately. An expression needs no wrapper to be a binding,
because a binding string and an expression are now the same grammar:

```jsonc
"binding": ".inputs.issue"
"binding": "add(.inputs.n, 1)"
"binding": { "expr": "add(.inputs.n, 1)" }   // identical; the wrapper is emphasis
```

`{"expr": …}` therefore stays as a spelling rather than as a necessity.

Literal bindings — `{"text": …}`, `{"json": …}` — stay as they are.

---

## 6. Schemas

Schemas are **transparent to expansion** and **opaque to merge**. These are independent
properties and an earlier draft wrongly bundled them.

- *Transparent to expansion*, so a shared type library works:
  `{"type": "object", "properties": {"doc": "$/types/markdown"}}`. Composing is the point of
  a `$/types` folder; linking a whole schema is not enough on its own.
- *Opaque to merge*, because deep-merging two JSON Schemas is meaningless
  (`{"type": "string"}` under `{"type": "array", "items": …}`).

JSON Schema has its own `$ref`, so **inside a schema document `$ref` is always JSON
Schema's**, never ours. We never claim the key there. Our references inside a schema are the
bare-string form, which JSON Schema has no use for, so the two grammars never touch.

The cost is that a *scalar* inside a schema (`description`) cannot be referenced. Acceptable.

Expansion actively helps here: the subtype checker currently rejects an unresolved `$ref`, so
inlining a shared type before checking makes it checkable for the first time.

---

## 7. Fallout in the format

These are not part of the reference system, but the reference system is what makes them
possible or necessary.

### 7.1 `prompt` becomes a string; skills are deleted

```jsonc
"prompt": "Extract goals from {{.inputs.issue}}."
"prompt": { "$ref": "$/prompts/extract_goals.md" }
```

A referenced `.md` is still a template — `{{.inputs.x}}` interpolation applies either way.

This removes the `template` xor `skill` rule, `SKILL_PREFIX`/`skillRef`/`skillNameOf`, the
skill branch in `runPromptOp`, `registry.skills` and `SkillTemplate` from the exec contract,
and JaiRA's `skillsDir` plumbing. `prompt.skill` is currently **broken** — JaiRA never
populates `registry.skills`, so it lints and then fails at run time (WORKFLOWS.md trap 16) —
so this closes an open TODO by deletion rather than by building the missing half.

### 7.2 `operation` becomes a discriminated union over the call type

`config` does two unrelated jobs: the `LlmConfiguration` surface for a prompt op, and an
arbitrary argument bag for a function op. Rather than renaming one of them, drop the nesting
and let the prompt variant *be* the call:

```ts
type OperationDecl =
  | ({ kind: "prompt"; prompt: string; input?: …; output?: … } & AuthoredLlmConfig)
  | { kind: "function"; function: string; args?: Record<string, JsonValue>; input?: …; output?: … };
```

so `model`, `maxOutputTokens`, `seed`, `toolChoice`, `maxSteps` and the rest sit directly on
a prompt operation as first-class typed fields. Three payoffs: the mismatch rule (§3) works
throughout a prompt op, because every position is typed; the "a layer that changes `kind`
drops the inherited `config`" special case disappears, since the variants share no such
field and the drop falls out of the union; and the untyped `{"$ref"}`-only caveat (§3.1)
shrinks to `args`, where it is inherent — only the function knows its own arguments.

**Two fields of `LlmConfiguration` already name things §5 of WORKFLOWS.md moved onto the
operation last round**, so the authored type is not a plain intersection:

```ts
type AuthoredLlmConfig = Omit<LlmConfiguration, "tools" | "sessionId"> & {
  /** Logical names, resolved through `registry.tools`. */
  tools?: string[];
  /** The logical session id. `sessionId` is accepted as a synonym. */
  session?: string;
};
```

**`tools` is authored-versus-resolved, not a clash.** `LlmConfiguration.tools` is
`ToolDefinition[]` — declarations handed to the model. What an author writes is `string[]`,
logical names the runner resolves through `registry.tools` before the call. The authored
form stays `string[]`.

**`session` and `sessionId` are synonyms**, with `session` canonical, so an
`LlmConfiguration`-shaped block pastes in unchanged. Three rules make that safe:

- **Both present and different is an error.** Silently picking one would be a coin flip over
  which conversation the call joins.
- **Normalization happens at parse, before merging.** Otherwise the two spellings would be
  two keys to the merge algebra, and a child's `sessionId` would sit alongside an ancestor's
  `session` instead of overriding it (§4.1) — the operation would then carry both and the
  error above would fire on a document that is perfectly well-formed.
- **Normalization also precedes hashing**, so the two spellings share a content address
  rather than producing redundant snapshots. This is safe in a way that normalizing *sugar*
  would not be: an alias table is fixed, whereas the desugaring is expected to improve, and
  hashing the authored form is what keeps a lowering change from invalidating stored
  snapshots. It is the same principle that already makes a YAML and a JSON spelling of one
  state hash identically (§4.3).

A later step could type `args` too, if a registry entry declared an argument schema — but
reference detection happens during expansion, before validation, so the loader would need
the registry in hand. Out of scope here.

### 7.3 `children[].state` may be omitted

A child with no `state` takes `./` + its key:

```jsonc
"children": { "critique": { "inputs": { "plan_doc": ".children.context.outputs.plan_doc" } } }
```

Composes with directory inference: inference gives you the children, and this lets you
*declare* one — to wire inputs or mark it `async` — without restating its path. A child whose
key differs from its state (mounting a library state locally) still writes `state`.

### 7.4 Fragments live under `$/`, not under `workflows/`

`$/types/`, `$/prompts/`, `$/lib/`. This settles by construction a collision that would
otherwise exist: directory inference and root derivation walk only `.json` under
`workflows/`, so nothing outside it can be mistaken for a state that runs, or reported as a
spurious workflow root.

---

## 8. Pipeline

Expansion is a pre-pass; everything after it is what exists today.

```text
parse → expand references → infer children → inherit environment → desugar → validate
```

Expansion first means inference and inheritance see a document as though the author had typed
it out, and validation type-checks the expanded result with no new machinery.

### 8.1 Snapshots

A pinned run reads only its snapshot, so **every referenced file joins the snapshot closure
and the hash** — including `.md` and `.yaml` fragments. Otherwise editing a prompt file would
silently change what a pinned task executes.

Out-of-tree targets (`$/types/…` is outside `workflows/`) reuse the `_external/` +
`meta.ids` mapping already built for out-of-tree states.

Resolution must be reproducible from the snapshot, which it is: the snapshot contains exactly
the files that resolved, so longest match over the pinned copy finds the same targets.

Hashing continues to hash the **authored, unexpanded** form, so improving expansion never
invalidates a stored snapshot.

---

## 9. Diagnostics

| Situation | Level | Why |
| --- | --- | --- |
| A shorter candidate also matches (`user.json` **and** `user.address.json`) | **warn** | Longest match is deterministic, but intent is not — and adding a file changes an existing reference's meaning. |
| `plan.json` **and** `plan.yaml` both exist | **warn** | `json` wins. A stale file left behind after a conversion is otherwise silent. |
| A reference names a **directory** | **error** | No sensible value; no index-file convention. |
| No file matches | error | Reported where the reference is parsed. |
| Property path on a non-JSON/YAML file | error | Text has no properties. |
| Reference cycle | error | Names the cycle. |
| Unknown scheme or `$VAR` | error | Never guessed at. |
| YAML that is not JSON-representable, cyclic, or has duplicate keys | error | Cannot be canonicalized or snapshotted. |

Filenames match **case-sensitively on every platform**, so a workflow resolves identically on
Windows and Linux rather than inheriting the host's rules.

---

## 10. Migration

One pass, not two. Every authored workflow changes.

| Today | After |
| --- | --- |
| `{"child": "c", "output": "x"}` | `".children.c.outputs.x"` |
| `{"child": "c"}` (defaults to slot name) | `".children.c.outputs.<slot>"` |
| `{"child": "c", "output": "*"}` | `".children.c.outputs"` |
| `{"input": "issue"}` | `".inputs.issue"` |
| `{"artifact": "design_doc"}` | `".artifacts.design_doc"` |
| `{"conversation": "review", "message": 0}` | `".conversations.review.messages.0"` |
| `{"text": …}`, `{"json": …}`, `{"expr": …}` | unchanged |
| `"prompt": {"template": "…"}` | `"prompt": "…"` |
| `"prompt": {"skill": "x"}` | `"prompt": {"$ref": "$/prompts/x.md"}` |
| `"state": "feature/plan/critique"` | omit it, or `"./critique"` |
| prompt op `config: {model: …}` | `model` etc. directly on the operation (§7.2) |
| function op `config` | `args` (§7.2) |
| `operation.session` | unchanged; `sessionId` also accepted, normalized to `session` (§7.2) |

The `ctx_*` output spread becomes a reference to the child's outputs object, so it survives
unchanged in meaning.

Every snapshot hash changes. That is not a break for in-flight work: snapshots are
content-addressed and stored, so an already-pinned task keeps executing the copy it pinned.
Only the next run of an *unpinned* task picks up the new form.

---

## 11. Deferred

- **Cross-run references** — "the outcome of the documentation task's critique". Genuinely
  useful, but it needs a task/run coordinate (`$TASK/<id>/…`), not a file path, and it crosses
  the snapshot-pinning boundary. Out of scope here.
- **Referencing a scalar inside a schema** — blocked by reserving `$ref` for JSON Schema (§6).
- **An index-file convention for directory references** — currently an error (§9).
- **A typed argument schema for function operations**, which would remove the last untyped
  position (§3.1/§7.2). Needs the registry available during expansion.
