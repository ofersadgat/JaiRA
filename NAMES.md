# Design note: scoped names

**Status:** the upstream half (§11, `declarative-ai`) is built, reviewed and tested (2026-09-19, `08dae7e`);
the JaiRA half is not started beyond the `$`-spellings, which the repo and `~/.jaira` now use throughout. It extends
[REFERENCES.md](REFERENCES.md) — same rule, one more reading of it — and generalizes what
`@declarative-ai/hw`'s `session.ts` does for one field so that it holds for any position.
Decision [0004](docs/engineering/decisions/0004-remote-review.md) (remote review) is its first consumer, and
[usage-readings](docs/engineering/contracts/usage-readings.md) is what `$pick`'s `model_limits` reads.

The aim is **no new structure**. Sessions, workspaces, a merge request that survives a loop,
model roles, and values defined elsewhere are all compositions of mechanics the format already
has in part: the shape-mismatch rule, file resolution, scoping, priority, and the environment.

---

## 1. The rule

A position has an expected type. What sits in it is read by shape (REFERENCES.md §3), and the
string case gains a second reading:

| In the position | Means |
| --- | --- |
| the expected shape | a literal |
| a **string** where an object is expected | a **variable string** |
| — starting with `$` | a **reference**: file resolution, as today (`$/lib/review.operation`) |
| — anything else | a **scoped name** (§3) |
| an **object** where a string is expected | `{ "$ref": <variable string> }`, read the same two ways |
| an object **with `$`-keys** where an object is expected | a **special object** (§2): `$`-keys instruct, plain keys override |

In an untyped position — a function's `args` — only the explicit `{ "$ref" }` form counts
(REFERENCES.md §3.1, unchanged). Inside `args` there are no format keys at all: a parameter the
function calls `workspace`, `session` or `schema` holds a name like any other.

**A scoped name is usable only where a VALUE is read** — a binding, an argument, a call setting,
`tools`, `permissions`, and the two positions that provide (`session`, `workspace`). A name reads per
instance, so it cannot stand for STRUCTURE the loader needs before any instance exists (`inputs`,
`operation.input`, `children`, `operation`). There a declared name is passed over — it is not the
"first usable match" of §6 — and the string means what it always did, a path off the default root.

Measured against the workflows that exist: no object position holds a bare string today (every
string `binding` is an expression, and `session` appears only as `null`), so reading a non-`$`
string as a scoped name changes no authored file.

## 2. `$`-keys: anything the state system acts on

**A key that does something in the state system is spelled with a leading `$`.** A reader can
then tell at a glance what is an instruction and what is payload for the operation.

| Key | Does |
| --- | --- |
| `$ref` | resolve a variable string here; sibling plain keys override the result (REFERENCES.md §4.1, the environment's merge algebra) |
| `$in` | the scope a name lives in: `"parent"`, `"global"`, or an ancestor's state id |
| `$join` | take the name an ancestor wrote, whatever it is called: `"parent"`, `"nearest"`, `"global"`, an id |
| `$fork` | branch the conversation rather than append (today's `fork`) |
| `$any` | an ordered list of alternatives (§6) |
| `$pick` | the expression that chooses among them (§6) |

Today's session spellings are the same thing under older names: `{ "name": "review", "in":
"parent" }` is `{ "$ref": "review", "$in": "parent" }`, and `{ "join": "nearest", "fork": true }`
is `{ "$join": "nearest", "$fork": true }`.

**The rename reaches existing keys too.** Inside any value that could be an operation’s payload
(args, call fields, a `names` block, a config object) an instruction is a `$`-key: `{ "expr": … }`
becomes `{ "$expr": … }`, and the `{ "binding": … }` wrapper inside `args` becomes `$binding` — both
are otherwise indistinguishable from a literal object in an untyped bag. The format’s own structural
keys — `inputs`, `children`, `binding` on a slot, `each` on a mount wire — are never payload and
stay bare.

## 3. A scoped name

A scoped name is an identity: the pair `(name, scope)`. Two uses that resolve to the same pair
are the same thing; nothing else makes them so.

**Where the scope is.**

1. If an `environment.names.<name>` entry is visible at the use (written by this state or
   inherited), the scope is **the state that wrote the entry**.
2. Otherwise the scope is **the state that wrote the use** — what a session name means today.
3. `$in` / `$join` redirect either.

Resolved at load to `(name, state id)`; no lookup happens while a workflow runs. At run time the
state id resolves to its **nearest enclosing instance**, and the key is `name#<instance
address>`. That is the whole of why loops and fan-out behave: a scope above a loop is one
instance on every pass; a scope inside it is a new one per pass; an `each` element is
`key[i]`; and the key is an address, not an instance id, so a resumed task resolves the same
key. (All of this was `session.ts` — `normalizeSession`, `sessionKeyOf`, the address
anchoring in `resourceKeyFor` — and is now `scope.ts`: `anchorScope`, `joinedWriter`,
`scopedKeyOf`, `keyOfScopedName`, `addressPath`, with `session` as its first user.)

## 4. `environment.names`: configuration, when a name needs any

```jsonc
"environment": {
  "names": {
    "impl": { "from": "main" },
    "plan": { "$any": [ … ], "$pick": "…" },
    "review": {}
  },
  "session":   "draft",
  "workspace": "impl",
  "model":     { "$ref": "plan" }
}
```

**Sometimes no entry is needed, because the position provides the value.** `"session":
"draft"` has none: the session position creates the conversation the first time the name is
used, and that conversation is what the name is bound to. An entry exists for a name whose
position needs to be told something (a workspace's base, a role's alternatives), or to say
where a name lives: `"review": {}` declares that `review` is scoped here, so two children that
both write `"review"` share it.

**An inner entry of the same name**, three cases:

| The descendant writes | Means |
| --- | --- |
| `"impl": { "from": "dev" }` | **override** (the default): a new `impl`, scoped here, configured only by this block |
| `"impl": { "$ref": "impl", "from": "dev" }` | a new `impl` scoped here, with the enclosing one's configuration **pasted in** and overridden. Inside an entry its own name means the enclosing one, so this is not a cycle. Transclusion is templating: nothing links the two afterwards. |
| `"impl": { "$in": "parent", "branch": "x" }` | **contribute**: the same `impl` the parent scopes, with this information added to it. This is what scope redirection is for — a child putting its information into a parent. |

**The plain keys beside a `$ref` are overrides of the NAME**, in every position that takes one —
`session`, `workspace`, and a value alike. They go into the identity's configuration with every
other writer's, and stay off the declaration that travels down the chain.

Two writers that give one identity conflicting configuration — by contribution, or with
`{ "$ref": "impl", … }` overrides at two use sites — are a **lint error**, compared by VALUE: key
order is never a disagreement. `$in` entries are collected into their target scope before any use is
resolved, so a sibling sees what another sibling contributed.

**A role is the exception, because it has no identity.** An entry holding `$any` (§6) is a ROLE:
nothing is created for it, it has no key, and a use of it IS the pick. Two things follow. It is
declared WHOLE where it is scoped — a `$in` contribution may not carry `$any` / `$pick`; a descendant
that wants different alternatives scopes a role of its own, pasting the enclosing one with
`{ "$ref": "plan" }` if it should start from it. And the plain keys beside a use of one
(`"model": { "$ref": "plan", "reasoning": { … } }`) are THAT USE's own: laid over whichever
alternative is chosen, there and nowhere else, so two uses may differ. Every alternative must then
be an object — one with no keys to override is an error at the use.

`names` is therefore the one key in `environment` that does not deep-merge by name down the
tree: nearest entry wins whole, and extension is said with `$ref`.

## 5. Types

**A name generates its own type** — from its entry's block, or, with no entry, from the
position that first provides its value. Putting a name into a position whose expected type it
does not match is an **error at that bind point**, reported where the name is written into the
position and not at its definition. One name is one type; `impl` cannot be a workspace in one
place and a session in another.

What is checked is the identity's whole configuration — its entry, every contribution, and the
overrides beside each `$ref`. In a value position the expected type is the position's own: a
function's parameter (its signature), a typed call setting. For `session` and `workspace` the engine
hands the configuration to the host opaquely, so only the HOST can say what type it is: it declares
a schema per position (`validateBundle(bundle, { positions: { workspace: … } })`), and a position
with none declared goes unchecked.

## 6. Priority

A bare name resolves in one order, first usable match wins:

1. enclosing scopes, nearest first (§3);
2. the position's default root, searched across the layers — project `.jaira`, then `~/.jaira`
   — exactly as `$/` searches them today.

A `$…` reference starts at its root and never walks scopes.

A value may be a list of alternatives with a rule for choosing:

```jsonc
{ "$any":  [ { "model": "claude-fable-5-1", "effort": "high" }, { "model": "astra-…" } ],
  "$pick": ".any[.any.map(model_limits).map('remaining').indexOf(max)]" }
```

`$pick` is an **expression, and what it returns is the value used**. It reads the resolved
alternatives as `.any`. Absent, the first usable alternative wins.

**Usable** means the alternative is THERE. One written as a reference (`{ "$ref": "$/roles.plan" }`)
whose own target is missing — no such file on any layer, or no such property in it — is skipped with
a warning, which is what lets a base layer list a role a project may not define. Only the
alternative's OWN reference is asked: a role file that exists and itself points at something missing
is a mistake, and a load error like any other. `null` is a value — it may be listed and chosen.

**When a pick happens belongs to the position, not to the author.** A model is fixed when its
session is created: the pick runs then, its result is journaled once, every later call in that
session uses it — one that continues the conversation by ref included, since that is a position in
it and not another session — a resumed task reads the journaled choice rather than picking again,
and the next session picks afresh. Editing the alternatives affects sessions created afterwards.

**What ships of this today (2026-09-23) is a subset, in the settings layers rather than in state
files:** a preset's `model` may be `{ "candidates": [...], "choose": "first-available" }`
(`models.presets.<name>.model`, `presetModels.ts`) — `$any` over model ids, with the one `$pick` that
needs no readings: the first candidate this machine can run (a configured route, not failing, not
signed out). It is fixed when its session is created, kept for the session's life, read back off the
session's record on a resume, and chosen again by the next session, as above. There is no `$pick`
expression and no other rule; `"choose"` refuses anything but `"first-available"`. The rule with the
most rate limit left waits for [usage-readings](docs/engineering/contracts/usage-readings.md).

## 7. Default arguments, typed

A function's default arguments live in the environment **under the function's name**, which is
what keeps them typed — the loader checks the block against that function's parameters:

```jsonc
"environment": { "functions": { "review_artifacts": {
  "args": { "remote": { "$ref": "$/remotes.origin", "draft": true } }
} } }
```

Precedence: the state's own `args`, then the nearest `environment.functions.<name>.args`
(merged per key down the tree), then the function's own default. The merge is deep for literal maps
and WHOLE wherever either side is a `$`-instruction, at any depth: a nearer literal replaces a name
at the key where they meet, and the two are never merged into each other. A child mount's
`environment.functions` is checked against the function at that line, like a state's own. This is not the operation's
`args`, so `merge.ts`'s rule that a change of `kind` drops inherited `args` never meets it.

## 8. Expressions: receiver calls

`recv.name(args)` is sugar for `name(recv, args)` and lowers to the same AST, as `xs[i]`
already lowers to `at(xs, i)`. It applies when `recv` is a runtime value — a leading-dot read
or a call's result — and `name` is an operation; a bare `confidence.score(…)` stays a module
symbol, and `.inputs.f(x)` stays a call of a callable value when the DECLARED type of
`.inputs` has a property `f` — a slot, or a property its schema names. The loader and the type
checker both answer from that declaration, so what is checked is what runs; a callable that is not
an input is called as `(.children.k.output.f)(x)`. Two builtin changes make §6's example read as written:
`map(xs, 'key')` with a string plucks, and `indexOf(xs, op)` means `indexOf(xs, op(xs))`
(`indexOf` itself is new).

Memoization is the executor-level `withMemoize` wrapper and is right for deterministic
functions. A function that reads live state — `model_limits` — is not deterministic and
registers with the existing `memoizable: false` capability.

## 9. Above the root

Nothing new. The roots every project runs are the base layer's workflows (`~/.jaira`, reached
as `$`), and a root's `environment` is the top of the chain. What all roots share is one
layered file they reference — `"environment": { "$ref": "$/environment" }` — which a project
shadows whole, or extends by pasting the base's (`{ "$ref": "$BASE/environment", … }`).
Settings edits those files.

## 10. The features, as compositions

| Wanted | Said as |
| --- | --- |
| a conversation shared by a loop | `"session": "draft"` written above the loop |
| a fresh one per pass | the same, written inside the loop body — or `null` |
| workspaces separate from sessions | two positions, `session` and `workspace`, each naming what it likes: many sessions in one workspace, or one session across several |
| a file in a workspace | the workspace's path as a reference root |
| the same merge request on every review round | `remote` is an object parameter of `review_artifacts`; its identity is a scoped name written above the loop; its defaults come from §7; its details return as ordinary output |
| one place that defines remotes | `$/remotes`, layered |
| a value defined elsewhere | `$/vars.threshold`, layered; already works in any binding |
| model roles | `"model": { "$ref": "plan" }`; `plan` is a `names` entry or a layered file holding `$any` / `$pick`. Keys beside the `$ref` override the chosen alternative for that use (§4) |
| chosen per session, again for the next | §6 — the position's binding time |
| switching models | edit the alternatives; sessions created afterwards see it |

## 11. What changes

**Upstream (`declarative-ai`):** the mismatch handler (`shape.ts`, `expand.ts`) learns the
non-`$` reading; `session.ts`'s normalize / anchor / key half becomes position-independent and
`session` becomes its first user; `environment.names` and `environment.functions`;
`environment.workspace` as a position, with the resource bundle keyed on it rather than on the
session's name; `$any` / `$pick`; the `$`-key renames of §2; receiver-call sugar and the two
builtins; the `positions` seam on `validateBundle` (§5).

**JaiRA:** the workspace position's provider (worktrees) and the schema of its configuration
(`positions.workspace`, §5), `model_limits`, the journaled pick,
the `remote` parameter and `$/remotes`, the Settings surfaces that edit `$/environment`. The
feature workflow is generated by scripts, so its migration is mechanical.

## 12. Open

- A name does not cross an `each: "task"` / `"split"` boundary by scope — the sub-task has its
  own root. It crosses by value, through the mount's inputs.
- One session across several workspaces: a delegated agent's conversation is stored under the
  directory it ran in, so its resume handle is paired with the workspace as well as the
  provider, and crossing replays the prefix instead of resuming.
- What `model_limits` can know, per provider, and who holds it: the executor does, and the contract is
  [usage-readings](docs/engineering/contracts/usage-readings.md). The unit is percent of a window, never
  tokens, which is why §6's example ranks on `remaining`.
