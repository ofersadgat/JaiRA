# Writing a JaiRA workflow

The reference for `.jaira/workflows/**/*.json` — every field, every binding form,
and the traps that fail silently.

This documents what the code **does** today, verified against
`@declarative-ai/hw`'s `format.ts` / `loader.ts` / `merge.ts` / `ref.ts` /
`engine.ts` and JaiRA's own registry. Where SPEC.md still describes the
pre-redesign format (`agent` / `ui` / `skill` / `params` blocks, bare-string
wiring), this file wins — see [DESIGN.md §1c](DESIGN.md).

Every table below marks each field **required** or **optional**. "Required"
always means *required given its context* — `operation.function` is required
only once `kind` is `function`, and even then an ancestor's `environment` may be
what supplies it (§5).

One reference type covers ids, transclusion and runtime reads — see
[REFERENCES.md](REFERENCES.md) for the full grammar and the reasoning; §2.1, §4
and §8 below are the authoring summary.

Check your work with:

```bash
npm run jaira -- workflow lint --project <dir>
```

---

## 1. The shape of a workflow

One **state** per file, JSON or YAML. A state's **id** is its path under
`.jaira/workflows/`, without the suffix:

```text
.jaira/workflows/
  feature/plan.json                    → state id  feature/plan
  feature/plan/goals.yaml              → state id  feature/plan/goals
  feature/plan/critique.json           → state id  feature/plan/critique
  feature/plan/critique/human_review.json
```

A **workflow** is a root state plus the transitive closure of the states it
declares as children. The root is whatever you name — `jaira task create
--workflow feature/plan` — and the workflow browser treats any state as a root
when no other state declares it as a child *and* its id is not nested under
another state's id. A state owns the namespace under its own id (§6), so a file
under `feature/plan/` is a substate of `feature/plan` whether or not it is wired
in yet; one that nothing reaches is reported as unreachable, not listed as a
workflow of its own.

The tree convention (a child's id should be a descendant path of its parent's) is
a **warning**, not a rule, so a shared library state can be mounted anywhere.

### Two places a state file can live

`.jaira/workflows/` is the project's own. Behind it sits a **shared base root**,
`~/.jaira/workflows/`, that every project on the machine can reach (DESIGN §3.1).
A bare state id is looked up in the project first and the shared root second —
shell `PATH` semantics, first match wins:

```text
~/.jaira/workflows/review.json          → state id  review     (shared)
~/.jaira/workflows/review/step.json     → state id  review/step
.jaira/workflows/review/step.json       → state id  review/step  ← wins here
```

Two consequences, and they are the point of the whole arrangement:

- **A project can run a workflow it does not contain.** Put `review` in the
  shared root once and every project can `--workflow review`.
- **A project can replace one state of it.** Write `review/step.json` in the
  project and it shadows the shared copy *under the same id* — so `review` still
  comes from the shared root, and only `step` is yours. That is an override, not
  a fork: later edits to the shared `review` still reach you.

An id is the same string whichever layer supplies it, so nothing about a state
file changes when you move it between the two.

**`$` layers too, and that is what you'll type most.** A `$/…` reference is
resolved against the same two roots, project first:

```jsonc
"prompt":    { "$ref": "$/prompts/critique.md" },   // yours if you have one,
"operation": "$/lib/review.operation",              // the shared one otherwise
"when":      { "$ref": "$/lib/guards.clean" }
```

So a shared *fragment* — a prompt, a type, a guard, an operation document — works
exactly like a shared state, and you override one the same way: drop a file at
the same path under your project's `.jaira/`.

When you mean one layer specifically, name it: `$JAIRA/lib/review` is always this
project's, `$BASE/lib/review` is always the shared one.

The app's **Workflows** pane lists both layers, marks a shared file the project
overrides, and has an "Override here" button that creates the project copy for
you.

### A state does exactly one thing

A state has **at most one `operation`**, and children. That is the whole model:

| What you want | How you write it |
| --- | --- |
| One structured LLM call | `operation.kind: "prompt"` |
| Anything else — host code, a UI gate, a delegated agent, a sub-workflow | `operation.kind: "function"` |
| Group other states | no `operation`, just `children` |

There is no `ui` block, no `agent` block, no `skill` block. **A UI state is a
function** whose registered implementation happens to render a dialog; **an agent
state is a function** whose registered implementation happens to drive Claude
Code. What distinguishes them is the *registry entry's capabilities*, never the
document. That is what lets one workflow run against the SDK adapter, the CLI
adapter, or a scripted test double without editing a single state file.

---

## 2. Top-level fields

```jsonc
{
  "id": "feature/plan",            // optional; derived from the path. If present it must resolve to the same state.
  "label": "Planning",             // shown on the board
  "description": "…",              // author's note; also useful prompt context

  "inputs":  { /* §3 */ },
  "outputs": { /* §3 */ },

  "operation":   { /* §4 */ },
  "environment": { /* §5 */ },

  "children":    { /* §6 */ },
  "sequence":    ["goals", "context", "critique"],
  "transitions": [ /* §7 */ ],
  "limits":      { "max_iterations": 3, "timeout": 600 }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | optional | The state's own path reference (§2.1). Derived from the file's location; a present one must resolve to that same state. |
| `label` | optional | Display name on the board. Falls back to the id. |
| `description` | optional | Author's note. |
| `inputs` | optional | Declared input slots (§3). |
| `outputs` | optional | Declared output slots (§3). A state with no outputs produces nothing. |
| `operation` | optional | The one thing this state does (§4). Absent ⇒ a pure composite. `{}` ⇒ "the operation my `environment` chain describes". |
| `environment` | optional | Defaults for this state's operation and every descendant's (§5). |
| `children` | optional | Declared child states (§6). **Absent ⇒ inferred from the directory**, alphabetically; `{}` ⇒ none. |
| `sequence` | optional | Order the cursor advances through `children`. **Absent ⇒ declaration order**; `[]` ⇒ no spine at all (§6). |
| `transitions` | optional | Control flow (§7). Absent ⇒ run the sequence, then terminate success. |
| `limits` | optional | `max_iterations` (guard value) and `timeout` (seconds). |

Nothing else is recognized. There is no `params` block — reusable configuration
is an input with a `default`, a literal binding, or an inherited `environment`.

### 2.1 References

Everywhere a workflow points at something — a state to run, a block to reuse, a
value to read — it writes one kind of **reference**: a path in two halves.

```text
<file-path> . <property-path>
```

| Form | Example | Means |
| --- | --- | --- |
| bare | `feature/plan` | a file under the default root, `$JAIRA/workflows` |
| `./`, `../` | `./goals` | relative to the **referring state's own id** |
| `$VAR/…` | `$JAIRA/prompts/review.md` | a named root — `$JAIRA`, `$PROJECT` |
| `$/…` | `$/prompts/review.md` | `$` is shorthand for `$JAIRA` |
| absolute | `/opt/workflows/review` | itself |
| `file:` | `file:/opt/workflows/review` | itself |
| a property | `feature/plan.outputs.plan_doc` | that property of that file |
| leading dot | `.children.critique.outputs.outcome` | a property of **the current file** |

Anything else — `https:`, `git+ssh:`, an unknown `$VAR` — is refused rather than
guessed at.

Three verbs share the grammar, and they behave differently:

| Verb | Where | When |
| --- | --- | --- |
| **Name** a state to run | `id`, `children[].state` | load |
| **Transclude** a document node | anywhere a block is expected (§2.2) | load |
| **Read** runtime data | a `binding` or a guard (§8) | run |

⚠️ **`./` is relative to the state's id, not to its file's directory.**
`feature/plan.json` sits in `feature/`, but the tree convention puts its children
in `feature/plan/`. So inside `feature/plan`, `./goals` is `feature/plan/goals`
and `../shared/lint` is `feature/shared/lint`. Resolving against the file's
directory would make relative references useless in precisely the case they exist
for.

**The canonical id keeps the bare spelling** whenever a reference lands under the
default root — `$JAIRA/workflows/feature/plan`, `./goals` from `feature/plan`,
and `feature/plan/goals` are one state with one id. That matters because the id
*is* an identity: it keys the snapshot hash, the event log, task rows, and
`$STATE_ID`. Only an out-of-tree state, which has no bare spelling, carries an
absolute id.

Out-of-tree states are read from disk on demand and copied into the task's
snapshot like any other, so a pinned run stays self-contained.

#### Where the file path ends

By **longest match against the directory listing**, the way a module resolver
works. Everything before the last `/` is the directory; the rest is matched
against what is in it, longest first.

| Reference | The directory holds | File | Property |
| --- | --- | --- | --- |
| `$/prompts/review.md` | `review.md` | `review.md` | — |
| `$/types/user.address` | `user.json` | `user.json` | `address` |
| `feature/plan.children.critique` | `plan.json` | `plan.json` | `children.critique` |

There is no fixed list of recognized extensions — any extension works, and a
reference that matches nothing is an error where it is *written* rather than
somewhere downstream. A reference with no extension probes `.json`, then
`.yaml`/`.yml`, then the bare name.

Two situations are legal but ambiguous enough to **warn**: a shorter candidate
also matching (`user.json` *and* `user.address.json`), and one state existing as
both `plan.json` and `plan.yaml` (JSON wins). Naming a **directory** is an error.

#### States can be YAML

A state file is `.json`, `.yaml` or `.yml`, interchangeably — both parse to the
same value tree, and the snapshot hash is over that value rather than the bytes,
so `plan.yaml` and an equivalent `plan.json` are one workflow with one identity.
YAML's excess is refused: a value JSON cannot represent, an alias cycle, or a
duplicate key is a load error.

### 2.2 Reusing a block: transclusion

A document reference is **templating**. The referenced node is spliced in and
then behaves exactly as if you had typed it there — it duplicates configuration,
it does not create a live link.

How you write it depends on what the position expects:

- the position expects an **object or array** ⇒ a **bare string** is a reference;
- the position expects a **string or number** ⇒ `{"$ref": "…"}` is a reference.

A string where a string belongs is a string. So a prompt containing
`feature/plan.outputs.summary` is just text, and no escaping is needed:

```jsonc
"operation": "$/lib/review.operation",                 // object position → reference
"prompt": "Review feature/plan.outputs.summary",       // string position → literal
"prompt": { "$ref": "$/prompts/review.md" },           // string position → reference
"schema": "$/types/markdown",                          // object position → reference
"when": { "$ref": "$/lib/guards.clean" }               // string position → reference
```

**Sibling keys override** what the reference brought in, by the same merge rules
as `environment` inheritance (§5.2). Key order is ignored:

```jsonc
"operation": {
  "$ref": "$/lib/review.operation",
  "model": "anthropic/claude-opus-4-5"
}
```

A **fragment** — a file holding reusable blocks rather than a state — lives
outside `workflows/`, conventionally `$/lib/`, `$/prompts/`, `$/types/`. That
keeps it out of directory inference (§6) and out of the workflow browser's root
derivation, so nothing there can be mistaken for a state that runs.

A reference to a **non-JSON/YAML file yields its text**, which is how a prompt
loads from a `.md` file. A property path on text is an error.

Every file a reference pulls in is **copied into the task's snapshot** and folded
into its hash, so editing a prompt fragment cannot change what an
already-started task is running.

⚠️ Two places the rule is narrower than it looks:

- **Inside a `schema`, `$ref` is always JSON Schema's own**, never ours — we never
  claim the key there. Our references inside a schema are the bare-string form,
  which JSON Schema has no use for, so the two vocabularies cannot collide. The
  cost is that a scalar inside a schema cannot be referenced.
- **Inside `args`, only `{"$ref": …}` works.** Nothing types a function's
  arguments, so there is no expected type to compare against.

A reference cycle is a load error naming the cycle.

Other fields have their own default roots — `config.artifacts.destination` hangs
off the worktree (§10).

---

## 3. Slots: `inputs` and `outputs`

A slot is a named, typed value. Both maps take the same shape:

```jsonc
"inputs": {
  "issue": {
    "kind": "blob",
    "schema": { "type": "string", "contentMediaType": "text/markdown" },
    "binding": ".inputs.issue",
    "default": "significant",
    "optional": true,
    "description": "The issue to plan against"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | optional (but see below) | JSON Schema for the value. Absent on an **input** ⇒ unconstrained, and nothing about it can be type-checked. Absent on a **derived output** ⇒ *inferred from its `binding`* — see §3.3. |
| `kind` | optional | One of `text` · `json` · `blob` · `prompt` · `function`. Derived from `schema` when omitted. |
| `binding` | see §3.3 | Where the value comes from (§8). |
| `default` | optional | Value used when nothing is wired in. Also the opt-out from the reachability rule (§11). |
| `optional` | optional | Slots are **required by default**. |
| `description` | optional | Author's note. |
| `name` | optional | Outputs only: the slot's external name, if it differs from its key. |

### `kind` — the five leaf kinds

`text` · `json` · `blob` · `prompt` · `function`

You rarely write it: `kind` is derived from `schema`. The one derivation worth
knowing is **`contentMediaType` ⇒ `blob`**, which is how an artifact slot is
declared (§10).

### Required by default

A slot is required unless it declares `optional: true` or a `default`. This is
also the explicit opt-out from the reachability rule (§11).

### 3.3 Outputs: produced vs. derived

An output with a **`binding`** is *derived* — computed when the state terminates,
from the operation, a child, an expression, or a literal. An output **without** a
binding is *produced*: the operation must return it, and it is filled directly.

**A derived output's `schema` is optional, and leaving it off does not make the
output untyped — it makes it take the type of what fills it.** Declaring one is a
constraint checked twice: the binding must satisfy it, and so must every consumer
reading the output. Declaring none used to mean the *top* type, which no typed
consumer accepts, so an undeclared output could not be wired into anything typed —
and the error landed on the parent, about a slot the parent did not write. It is
now inferred from the binding, by the same rule the binding check itself uses. A
*produced* output has nothing connected to it, so there is nothing to infer: its
schema stays unconstrained unless you write one.

```jsonc
"outputs": {
  "weaknesses":  { "schema": { "type": "array", "items": { "type": "string" } } },   // produced
  "summary":     { "binding": ".operation.output.report" },                          // from the call
  "features":    { "binding": ".operation.output" },                                 // the whole return
  "outcome":     { "binding": { "expr": ".children.critique.outputs.outcome" } },     // derived
  "plan_doc":    { "binding": ".children.context.outputs.plan_doc" },                // derived
  "critique":    { "binding": ".children.critique.outputs" }                         // whole child
}
```

**Binding from the operation is the more explicit form, and it can do things
producing cannot.** A produced output receives the call's result under a name it
must share with it; a bound one names its source, so it can RENAME (`summary`
from `report`), reshape it through an expression, or take a return that has no
names at all — a list, a blob — with `.operation.output`.

### ⚠️ JaiRA requires the binding: an unbound output is a lint ERROR

The format allows producing. JaiRA does not, and the check is an error rather
than a warning because of what it prevents: a produced output is filled by NAME,
silently, so a call that stops returning that name leaves a state that terminates
**successfully** having handed back nothing. Every other wire in a state is
written down; this was the one place "the obvious thing" stood in for saying it.

So the explicit form is two lines — what the call returns, and what the state
publishes from it:

```jsonc
"outputs":   { "goals": { "schema": …, "binding": ".operation.output.goals" } },
"operation": { "kind": "prompt", "prompt": …, "outputs": { "goals": { "schema": … } } }
```

`.operation.output.*` is typed from `operation.outputs` **and from nothing
else**, which is why the call has to declare its returns for the binding to
resolve.

**Two consequences worth knowing before you migrate a state.**

*A bound output is computed when the state TERMINATES.* A produced one is filled
the moment the operation returns, so anything that reads a value mid-state — a
guard, a child's wiring — must name the call's result rather than the slot:

```jsonc
"children":    { "fix": { "inputs": { "weaknesses": ".operation.output.weaknesses" } } },
"transitions": [{ "to": "fix", "when": ".operation.output.outcome === 'needs_changes'" }]
```

*A FUNCTION operation is exempt.* A host function returns one value and the
engine cannot index it, so `.operation.output.decision` resolves to nothing at
run time however the operation declares itself — a component's answer lands on
the state's slots by name or not at all. Outputs of a `kind: "function"` state
may therefore be produced, and the linter says nothing about them.

This is what SPEC's old `"from": "children.x.outputs.y"` became: an output's
`from` is now that slot's `binding`.

### 3.4 `output` defaults to the slot's name

A `{ child }` binding takes the child output **named by the slot it fills**, so
the common case says the name once:

```jsonc
"plan_doc": { "binding": ".children.context.outputs.plan_doc" }        // one output
"summary":  { "binding": ".children.context.outputs.notes" }           // renamed on the way through
"whole":    { "binding": ".children.context.outputs" }                 // the entire outputs object
```

Stopping at `.outputs` gives the whole object as **one value**.

### 3.5 Spreading a child's outputs

A slot key ending in `*` republishes **every** output of the named child as an
output of this state, prefixed with whatever precedes the `*`:

```jsonc
"outputs": {
  "ctx_*": { "binding": ".children.context.outputs" }
}
```

If `context` declares `plan_doc` and `notes`, this state gains `ctx_plan_doc` and
`ctx_notes` — each keeping the child's schema and optionality, each an ordinary
typed slot a consumer can bind to individually. A bare `"*"` key spreads them
unprefixed, and an explicitly declared slot always wins over one the spread would
have produced:

```jsonc
"outputs": {
  "ctx_*":        { "binding": ".children.context.outputs" },
  "ctx_plan_doc": { "schema": { "type": "string" }, "binding": ".children.context.outputs.final" }
}
```

The `*` lives in the **key**, not in `output`, for two reasons: a spread declares
N slots rather than one, and that belongs where the slots are declared; and
`{ "output": "ctx_" }` could not be told apart from selecting an output genuinely
named `ctx_`.

---

## 4. `operation`

One block, whatever the state does. `kind` picks which of the two shapes below
applies — `prompt` for one structured LLM call, `function` for everything else.
Every field is optional **in the file**; what the file leaves out, the
`environment` chain may supply (§5). What matters is the shape *after* merging.

**`kind: "prompt"` properties**

| Field | Required after merging | Meaning |
| --- | --- | --- |
| `kind` | **required** | `"prompt"`. |
| `prompt` | **required** | The prompt, as **text**. `{"$ref": "$/prompts/x.md"}` loads it from a file. |
| `system` | optional | System prompt. |
| `model`, `temperature`, `maxOutputTokens`, … | optional | The LLM call surface, **inline** on the op — not nested under a `config` bag. |
| `input` | optional | Parameter map (§4.3). Absent ⇒ the state's declared `inputs` are in scope. |
| `outputs` | optional | What the call RETURNS, by name (§4.4) — and the structured-output contract the model is held to. |
| `output` | optional | The single lowered slot (§4.4). Say it directly when the whole return is one value — a list, a blob. Absent ⇒ built from `outputs`, or from the state's produced outputs. |
| `session` | optional | Logical session this call joins. Absent ⇒ `"default"`. |
| `tools` | optional | Tool names the call may use mid-loop (§5.1). |
| `conversation` | optional | How much transcript to carry (§5.1). |
| `permissions` | optional | Authored permission baseline (§5.1). |

**`kind: "function"` properties**

| Field | Required after merging | Meaning |
| --- | --- | --- |
| `kind` | **required** | `"function"`. |
| `function` | **required** | Registry name (§4.2 lists what JaiRA registers). |
| `args` | optional | The function's authored arguments; rides as the op's bound `config` input. The one **untyped** position in the format. |
| `input` | optional | Parameter map (§4.3). Absent ⇒ the state's declared `inputs` are in scope. |
| `outputs` | optional | What the call RETURNS, by name (§4.4). |
| `output` | optional | The single lowered slot (§4.4). A delegated agent needs `kind: "blob"`. Absent ⇒ built from `outputs`, or from the state's produced outputs. |
| `session` | optional | Logical session this call joins. Absent ⇒ `"default"`. |
| `tools` | optional | Tool names the call may use mid-loop (§5.1). |
| `conversation` | optional | How much transcript to carry (§5.1). |
| `permissions` | optional | Authored permission baseline (§5.1). |

`prompt`, `system` and the LLM call surface are meaningless on a function op, and
`function`/`args` are meaningless on a prompt op.

### 4.1 Prompt operations

One structured LLM call.

```jsonc
"operation": {
  "kind": "prompt",
  "prompt": "Extract goals from {{.inputs.issue}}.",
  "system": "You are a careful planner.",
  "model": "anthropic/claude-sonnet-5"
}
```

- `prompt` is **text**. A reusable one is a reference to a file, which is what
  replaced the old `prompt.skill` and the never-implemented skill registry:

  ```jsonc
  "prompt": { "$ref": "$/prompts/extract_goals.md" }
  ```

  A referenced `.md` is still a template — interpolation applies either way.
- `{{.inputs.x}}` interpolates against the operation's **resolved inputs**. With no
  `operation.input` map, the state's declared `inputs` are in scope.
- **The operation IS the call**: `model`, `temperature`, `maxOutputTokens` and the
  rest sit directly on it, not nested under a `config` bag. **Models must be
  route-prefixed** — `anthropic/claude-sonnet-5`, not `claude-sonnet-5`. Omit it
  to inherit `models.default` from `.jaira/settings.json`, or set it once in an
  ancestor's `environment` (§5).

### 4.2 Function operations

Invoke a registered function by name.

```jsonc
"operation": {
  "kind": "function",
  "function": "choose_option",
  "args": { "prompt": "Approve this plan?", "options": ["approve", "block"] }
}
```

`args` rides as the op's bound `config` input — it is the authored surface for
whatever the function expects. It is the one **untyped** position in the format,
so a reference inside it must be written `{"$ref": …}` rather than as a bare
string.

**What JaiRA registers** (a state can name any of these):

| Name | What it is | Notes |
| --- | --- | --- |
| `choose_option` | UI gate | Renderer-backed; parks the state `waiting_for_user` |
| `review_artifact` | UI gate | |
| `edit_artifact` | UI gate | |
| `fill_form` | UI gate | |
| `confirm_action` | UI gate | |
| `claude-code` | Delegated agent, in-process SDK | `policyEnforcement: "callback"` |
| `claude-cli` | Delegated agent, `claude` subprocess | `policyEnforcement: "callback"` via the MCP bridge |
| `codex-cli` | Delegated agent, `codex exec` subprocess | `policyEnforcement: "config"` — see below |
| `generic-cli` | Non-Claude agent CLI | Registered only for what `config.agents.genericCli` declares, under the name it declares; **`policyEnforcement: "none"`**, so §5.1 refuses it whenever the policy can escalate to a human — which `policy.builtins: false` alone does not settle |
| `run_command` | Run one command, no agent | Takes `config.command`; gates itself against the project policy |

A UI gate's answer is validated twice — in the main process against the
component's contract, then by the engine against the state's output schema.

#### `codex-cli` is not `generic-cli`, and the difference is the policy

`codex exec` has no mid-run permission callback — nothing like Claude's
`--permission-prompt-tool` — so no tool call it makes reaches the approval UI.
What it *does* have is a real up-front channel: `--sandbox`
(`read-only` / `workspace-write` / `danger-full-access`), pinned on every run so
the blast radius never depends on the contents of `~/.codex/config.toml`. That is
`policyEnforcement: "config"`, which **passes** the §5.1 gate where `generic-cli`'s
`"none"` does not.

The gate does not disappear, it moves: an adapter declaring `config` gets its
injected tools **policy-wrapped by the engine**, so JaiRA's own `bash`/`write_file`
are still approved per call. Only codex's own built-ins answer to the sandbox alone.

`plan` maps to `read-only`, `bypassPermissions` to `danger-full-access`, and
everything else to `workspace-write`. Project settings:

```jsonc
"agents": { "codex": { "command": "codex", "sandbox": "read-only" } }
```

**A codex state must declare no `tools`.** Codex reaches JaiRA's tool bridge and then
auto-denies the call — the denial comes back as the text `user cancelled MCP tool
call`, which the agent would report as its answer, so a state would "succeed" having
done nothing. Until that is solved the adapter refuses instead, naming the tools.
Codex works from its own built-ins under the sandbox; a state that needs JaiRA's
tools belongs on `claude-code`/`claude-cli`.

Two more things codex **refuses rather than silently drops**: a per-tool deny list (it
has no such flag) and a native tool allow-list. It reports no cost either — codex
counts tokens, not money — so its runs land in the roll-up with `costSource:
"unknown"` rather than a made-up number.

Sessions: `codex exec resume` continues a conversation natively, so two states sharing
a `session` name share one codex thread. There is no fork primitive, so a *branch* is
replayed as a rendered transcript — lossy, and recorded as such (SESSIONS.md §6).

### 4.3 ⚠️ `operation.input` is a **parameter map**, not a binding map

This is the single most common silent failure.

```jsonc
// ✅ operation.input — values are PARAMETERS, so the wiring goes under `binding`
"operation": {
  "kind": "function",
  "function": "claude-code",
  "input": { "prompt": { "kind": "text", "binding": ".inputs.instruction" } }
}

// ✅ children.<key>.inputs — values are BARE BINDINGS
"children": {
  "critique": { "inputs": { "plan_doc": ".children.context.outputs.plan_doc" } }
}
```

Write `"input": { "prompt": ".inputs.instruction" }` and the loader sees a
parameter with **no binding**: the slot resolves to empty, the agent runs with no
instruction, and the state reports **success**. Nothing warns you.

### 4.4 `operation.outputs`, `operation.output`, and the blob rule

**`operation.outputs` says what the call returns**, by name — a map, exactly as
`operation.input` is one. For a prompt op it is also the **structured-output
contract** the model is held to:

```jsonc
"outputs": {
  "summary": { "schema": { "type": "string" }, "binding": ".operation.output.report" }
},
"operation": {
  "kind": "prompt",
  "prompt": "…",
  "outputs": { "report": { "schema": { "type": "string" } } }
}
```

The model is asked for `report`; the state publishes `summary`. Those are two
names with a binding between them, which is the point: the call owns its own
signature instead of borrowing it from whatever the state around it declares.

**`operation.output` is the single lowered slot** the executor seam actually
takes — one object for a prompt call, one value for an agent. `outputs` is
lowered into it, so you rarely write it. Write it directly to say the thing the
map cannot: that the whole return is ONE value with no field names.

```jsonc
"output": { "schema": { "items": { "type": "string" } } }   // returns a list
```

`.operation.output` then IS that list, and a slot binds it whole.

Declare neither and the loader falls back to the older rule: one object slot
built from the state's *produced* outputs, so the operation must return
`{ "<name>": …, … }`.

A **delegated agent returns one string**, not a record. Its output slot must
therefore be `blob`-kind, which is the engine's "this value *is* the whole
output" case:

```jsonc
"outputs": {
  "report": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
},
"operation": {
  "kind": "function",
  "function": "claude-code",
  "input":  { "prompt": { "kind": "text", "binding": ".inputs.instruction" } },
  "output": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
}
```

Declare it `json` instead and the returned string is read as a record of named
outputs, finds nothing, and the state fails with **"function operation did not
produce required output 'report'"**. A blob output fills **exactly one** produced
slot; declaring two is an error.

---

## 5. `environment` — defaults and inheritance

`environment` is an **`operation` with every field optional**. It supplies
defaults for this state's operation *and for every descendant's*.

```jsonc
// feature/plan.json — set once at the root
"environment": {
  "kind": "prompt",
  "model": "anthropic/claude-sonnet-5",
  "session": "planning",
  "tools": ["bash"]
}

// feature/plan/goals.json — says only what is different
"operation": { "prompt": "Extract goals from {{.inputs.issue}}." }
```

The effective operation is

```text
merge(root.environment, …, parent.environment, mount.environment, own.environment, own.operation)
```

with the **nearest layer winning**. One vocabulary covers both "the default for
this subtree" and "the operation here", so there is nothing extra to learn.

`mount.environment` is `children.<key>.environment` — the layer a PARENT applies to
one child rather than to all of them (§6.1). It is what lets one review state be
mounted twice, under two different agents.

**Two rules keep it predictable:**

- **Only a state that declares an `operation` gets one.** A pure composite under
  an `environment`-declaring root stays a pure composite; it would otherwise
  inherit its ancestor's operation and start running it. Write `"operation": {}`
  to opt in to a fully inherited operation.
- **A state mounted under two parents that give it different environments loads
  twice.** It is running as two different things, so it gets one entry per mount:
  the first keeps the plain id, and a later one that inherits something different
  gets a `#`-suffixed **variant** id hashed from its environment
  (`lib/review#3f9c1a20`). Two parents passing the *same* environment collapse
  back onto one entry, so the ordinary shared-library case grows no duplicates.
  Each parent points at the variant it actually runs, and everything downstream —
  the board, the lint surface, snapshots, the event log — sees one id with one
  operation, as before.

### 5.1 The execution-environment fields

`session`, `tools`, `conversation` and `permissions` are ordinary operation
fields — they say how the call runs rather than what it is, but every one of them
is a per-call decision, so they are written in the same block and inherited by
the same rule.

- **`session`** — the logical session owning the conversation transcript,
  workspace and permissions. Operations sharing an id share a conversation.
  ⚠️ Absent ⇒ a FRESH stream private to this operation — not a shared `"default"`
  session, which is what it used to mean. An implicit process-wide transcript is
  the thing that drives unbounded context growth, so sharing one is now something
  you ask for by naming it. The run's shared *workspace* is unaffected, being a
  separate concern. There is one spelling: `sessionId` is refused, not accepted
  as a synonym.
- **`tools`** — logical tool names the operation may call mid-loop, resolved
  through `registry.tools`. JaiRA registers `bash`. **Listing a tool here is what
  puts an agent's commands under the policy at all.**
  ⚠️ On a delegated agent it is a *grant*, not a fence: the agent keeps its own
  built-ins (`Bash`, `Read`, …) beside the tools you declare, and a declared
  `read_file` does not take its `Bash` away. The fence is `permissions.profile`
  (below) — a sync-style "may read, must not write" state declares **both** the
  tool and the profile.
- **`conversation.mode`** — `full_history` | `summary` | `fresh` |
  `selected_artifacts` (the last takes `artifacts: [names]`).
  ⚠️ `summary` is **per session, not per state**: one session has one transcript,
  so a session mixing `summary` and `full_history` is summarized for both. The
  lint surface warns — and it reads the *effective* mode, so an inherited one is
  caught too.
- **`permissions`** — the definition-authored baseline, beneath the project
  policy: per-tool modes (`allow`/`deny`/`ask`/`smart`), a `default` for unlisted
  tools, and a `profile` (`read-only` | `plan` | `full`).

  **`profile` is how a restriction survives delegation**, and each transport
  enforces it through the channel it actually has:

  | Transport | What a `read-only` profile does |
  | --- | --- |
  | provider route | the declared tools are permission-wrapped; a mutating tool is denied on its way through |
  | `claude-code` / `claude-cli` | the agent's write-capable built-ins (`Bash`, `Edit`, `Write`, `Task`, …) go on `--disallowedTools` up front; everything else answers to the permission callback, where an unclassifiable tool escalates rather than passing |
  | `codex-cli` | `--sandbox read-only` — the sandbox is its only channel, and the mapping is exact |
  | `generic-cli` | **refused**: it enforces nothing (`policyEnforcement: "none"`), so running would be a restriction in the workflow and none in the process |

  A `plan` profile maps to claude's own `--permission-mode plan` (and codex's
  read-only sandbox) instead of the deny list — plan mode still reads with those
  tools, and denying them would be a different restriction than the one authored.
  The sync workflow is the worked example: its states declare
  `"tools": ["read_file"], "permissions": {"profile": "read-only", "tools": {"read_file": "allow"}}` —
  the tool so a clipped digest can be re-read, the profile so "returns text for a
  person to accept and must not touch disk" is enforced rather than narrated, and
  the `allow` so the one declared tool runs without a human click per read.
  ⚠️ The enforcement rides on the run's approval wiring: a run with no approver
  builds no gate, and a delegated agent then runs under its transport's own
  defaults — the documented "without an approver, tools are handed over
  unguarded" rule, unchanged.
- **`configRef`** — the name of a preset in `config.models.presets`, merged
  UNDER this operation's own fields and OVER the project defaults. It is for the
  settings a model call has and a state should not have to repeat —
  `{"configRef": "fast"}` beside a prompt says "the cheap one", once, in a place
  a reader can look up. Not an operation field JaiRA owns: anything the engine
  does not claim is passed through to the call configuration, which is how this
  works without a loader change.

⚠️ **`model` names who ANSWERS, not just which weights.** There are three things
you can write, and the difference is how much of the decision you are taking:

| What you write | What it means |
| --- | --- |
| `claude-sonnet-5` | **Prefer this.** The model, with the transport left open. JaiRA reads the family off the name and picks a route that serves it, **preferring an agent** — an agent runs on a subscription already signed in, so this is the spelling that works on a machine with `claude` installed and no API key. |
| `claude-cli/sonnet` | The model **and** the route. Use it when the route is the point — a lens that must be codex, a call that must go to the provider. Refused, by name, when that route is not configured here. |
| *(nothing)* | Whatever this machine has. The project's default environment fills it in, and failing that the router answers with any route that can pick its own model. |

The part after a prefix reaches the transport with the prefix stripped, so
`sonnet` is what `claude` is asked for (DESIGN §8.3). A bare id gets the chosen
prefix written back into it before the call, so everything downstream — a memo
key, a price table, a diagnostic — still sees one spelling.

**Prefer the bare form in a workflow you intend to share.** Which model a state
wants is yours to say; which transport reaches it is a fact about somebody's
machine, and a workflow that states both is unrunnable everywhere the second one
is wrong. JaiRA's own feature workflow pinned `anthropic/claude-sonnet-5` on
every phase parent, and on a machine whose only credential was a `claude` login,
27 inherited leaves failed at their first call with a missing-API-key error.

A model nothing here can serve is refused when the run **starts**, naming the
state and both ways out — never at the first call, four layers down.

### 5.2 How each field merges

| Field | Merge |
| --- | --- |
| `kind`, `function`, `system`, `session` | nearest wins |
| `prompt` | **replaced whole** — a layer supplying a prompt supplies all of it |
| `model`, `temperature`, … | nearest wins, per field: root sets `model`, a child adds `temperature`, both survive |
| `args` | **deep merge** per key |
| `input` | merged per slot name; within a slot, per field |
| `input.<slot>.schema`, `input.<slot>.binding`, `output.…` | **replaced whole** |
| `tools`, `conversation.artifacts` | **replaced** — `"tools": []` is how you drop an inherited tool |
| `conversation` | merged per field |
| `permissions` | merged, with `permissions.tools` merged per tool name |

`schema` and `binding` are replaced rather than merged because merging them
produces nonsense: `".children.a.outputs.x"` merged with `".inputs.b"` is not a binding
at all, and one JSON Schema deep-merged into another (`{ type: "string" }` under
`{ type: "array", items }`) is not a schema.

**A layer that changes `kind` drops the inherited call settings**, along with
`prompt`, `system` and `function`. Without this, a root defaulting
`model: "…"` for its prompt states would hand `model` to every `choose_option`
gate in the subtree as if the author had written it there. The
execution-environment fields are *not* kind-specific — a gate under a
`session`-declaring root still joins that session.

⚠️ A `.children.<key>…` binding in an `environment` block names a child key that only
exists in the declaring state. It is meaningless once inherited; use
`{ input: … }`, which resolves in whatever state consumes it.

---

## 6. `children` and `sequence`

```jsonc
"children": {
  "goals":   { "inputs": { "issue": ".inputs.issue" } },
  "context": { "inputs": { "goals": ".children.goals.outputs.goals" } },
  "lint":    { "async": true },
  "shared":  { "state": "$/lib/review" }
},
"sequence": ["goals", "context", "critique"]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `children.<key>.state` | optional | The child's state reference (§2.1). **Absent ⇒ `./<key>`**, so a child whose key names it says nothing. |
| `children.<key>.inputs` | optional | Wiring into the child's declared inputs, as **bare bindings** (§8) — no `binding:` wrapper. Every required input of the child must be wired. |
| `children.<key>.async` | optional | `true` ⇒ the cursor does not wait for this child (see below). |
| `children.<key>.environment` | optional | Defaults for **this mount** of the child and its subtree (§6.1). |

### 6.1 `environment` on a child: one state, mounted twice

`environment` on a state applies to it and everything below it, so every child of
one parent inherits the same layer — and two children of one parent could not
differ in it. Declaring it **on the child** is how they differ:

```jsonc
"children": {
  "claude_review": {
    "state": "review/agent_review",
    "async": true,
    "environment": { "kind": "function", "function": "claude-cli" },
    "inputs": { "change": ".inputs.change" }
  },
  "codex_review": {
    "state": "review/agent_review",
    "async": true,
    "environment": { "kind": "function", "function": "codex-cli" },
    "inputs": { "change": ".inputs.change" }
  },
  "synthesize": {
    "state": "review/synthesize",
    "inputs": {
      "review_a": ".children.claude_review.outputs.report",
      "review_b": ".children.codex_review.outputs.report"
    }
  }
}
```

One `agent_review.json`, reviewed by two agents, merged by a third state that waits
for both by dataflow (§6, async children). The reviewed state leaves `function` to
the chain:

```jsonc
// review/agent_review.json
"operation": {
  "kind": "function",
  "input": { "prompt": { "kind": "text", "binding": ".inputs.change" } },
  "output": { "name": "report", "kind": "blob" }
}
```

Three rules worth knowing:

- **It is a DEFAULTS layer, not an override.** The order is
  parent's `environment` → the mount's → the child's own → the child's `operation`,
  nearest wins. So a state that names its own `operation.function` cannot be varied
  this way, which is right: a state that says what it runs means it. A state meant to
  be mounted under several runtimes leaves that field out.
- **Two mounts under different environments become two entries** internally (a state
  id with a `#`-suffixed variant), so validation, snapshots, the board and the events
  journal still see one id running one operation. Two mounts declaring the *same*
  thing collapse back to one.
- It works for any environment field, not just `function` — `model`, `tools`,
  `permissions`, `session`.

### `children` is optional — omit it and the directory decides

**Absent ⇒ every state one path segment below this one**, keyed by basename, in
**alphabetical** order. A state owns the namespace under its own id, so
`feature/plan` with no `children` block picks up `feature/plan/context`,
`feature/plan/critique` and `feature/plan/goals` — in that order, which is also
the order they run, since `sequence` then follows.

`"children": {}` declares **none**. That is the difference between "work it out"
and "there aren't any", and a leaf that happens to have a directory beside it
needs the second.

An inferred child gets no `inputs` wiring, so this is for children whose inputs
are all optional or defaulted. A child with a required input must be declared,
because nothing can guess where its value comes from.

### `sequence` is optional

**Absent ⇒ the order the children were declared in** (or, for inferred children,
alphabetical). JSON preserves key order, so the declaration block *is* the default
spine. Write one only to run children in a different order from how they read, or
to leave some out.

`"sequence": []` is the way to say "these children are declared but not in the
spine" — they then run only if a transition enters them.

### One child at a time, unless you say otherwise

The cursor points at one child and **holds** there until it resolves. `async:
true` is the only way to overlap children, and that is the only thing the flag
means:

```jsonc
"children": {
  "lint":   { "state": "./lint", "async": true },   // starts, cursor moves on
  "build":  { "state": "./build" },                 // cursor waits here
  "report": { "state": "./report" }                 // …then here
}
```

Ordering between *async* children is dataflow-driven: one whose input reads a
still-running producer parks on `PENDING` until that producer completes. Between
sync children the sequence itself is the order, and transitions are evaluated
between them — so a guard can end the state before the next child ever starts.

### A transition into a child is a jump

Entering a sequence member **moves the cursor to it**:

- **Backwards** — the member and everything after it are cleared (a *sequence
  reset*, recorded as `child.superseded`) and re-run. This is the re-plan loop.
- **Forwards** — the members it skipped stay skipped. The cursor does not fall
  back to fill them in.

---

## 7. `transitions` and `limits`

```jsonc
"transitions": [
  { "to": "terminate.success", "when": ".children.critique.outputs.outcome === 'clean'" },
  { "to": "goals",             "when": ".children.critique.outputs.outcome === 'needs_changes' && .run.iteration < .limits.max_iterations" },
  { "to": "terminate.success", "when": ".children.critique.outcome === 'success'" }
],
"limits": { "max_iterations": 3, "timeout": 600 }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `transitions[].to` | **required** | A declared child key, or one of `terminate.success` / `terminate.error` / `terminate.canceled` / `terminate.timeout`. |
| `transitions[].when` | optional | Guard expression. Absent ⇒ unconditional. |
| `limits.max_iterations` | optional | Exposed to guards as `.limits.max_iterations`. |
| `limits.timeout` | optional | **Seconds**; exceeding it terminates the state `terminate.timeout`. |

Transitions are evaluated **in order, first match wins**, when an operation
completes or a child terminates. A guard that evaluates to `PENDING` (it reads a
child still running) is **skipped this round** and retried — it does not fail and
does not fall through to a later transition permanently. The one exception is a
guard WAITING on a person (§7.4), which stops the list rather than skipping.

### ⚠️ Guards must infer to `boolean` — strictly

There is no truthiness coercion. `"when": ".outputs.goals"` is a **lint error**,
not a non-empty check. Write `".outputs.goals.length > 0"` — with the leading dot, like every other read.

### An unconditional transition fires at the first evaluation round

`{ "to": "terminate.success" }` with no guard is taken as soon as transitions are
evaluated — which is *after* the operation completes or a child terminates, not
on entry. In a state with children and no operation, the first child therefore
runs first. To terminate before any child runs, give the state an operation to
decide on, or an empty `sequence`.

### Re-entering a child

A transition back to a child key starts a **fresh instance** of it (§6, "a
transition into a child is a jump"). `run.iteration` counts the transitions this
instance has taken.

### 7.4 Waiting for a person: `on_user_event`

A guard can wait for somebody to DO something. The commonest something is dragging
a task's card from one column to another on the board:

```jsonc
"transitions": [
  { "to": "in_review", "when": "on_user_event('task_drag')" },
  { "to": "terminate.success" }
]
```

`on_user_event(event, options?)` takes the event type first — today `'task_drag'`
is the only one — and an options bag whose shape belongs to that event. It returns
`true` when the gesture happens and `false` when it does not.

| `task_drag` option | Meaning |
| --- | --- |
| `to_state` | The column the card has to be dropped on, as a **child key** of this state — the same namespace `to` names. Absent ⇒ **this rule's own `to`**, which is why the example above needs no options at all. |
| `timeout` | Seconds to wait before answering `false`. Absent ⇒ wait indefinitely, which is what a column on a board means: the task sits there until somebody moves it. |

**It is a guard, not a state.** "Wait for a drag" could have been a state whose
operation blocks, and it must not be: a state that waits is a place a task SITS,
and the task is already sitting somewhere — in the column drawn for the state it is
actually in. Written as a guard, the task stays where it is and the rule says what
would move it.

#### The conditions ahead of it are the preconditions

```jsonc
{ "to": "escalate", "when": ".inputs.severity > 2 && on_user_event('task_drag')" }
```

At severity 1 **nobody is asked**: `&&` short-circuits before the call, so no wait
is registered, no card becomes draggable, and the rules behind this one have their
turn immediately. This is the intended way to say "this move is available only
when…" — the condition and the offer are one rule.

#### Everything after it waits

While the answer is outstanding:

- **no later transition is evaluated** — including the state's own list, if the
  waiting rule was on a child mount;
- **the state does not terminate**, even with nothing left to run. It is paused on
  a decision, and the board shows the card as `paused`;
- **the sequence does not advance.** Nothing new starts in a state waiting to be
  told where to go.

That is what makes it an *async transition*: the pipeline stops at the rule that
asked, and resumes from the top of the same list when the answer arrives.

**Only one rule asks at a time.** A rule behind a waiting rule — or behind one that
already fires — is a rule about a decision this round will not reach, so its wait is
never registered and its column never lights up. Two rules offering the same card two
different moves are offered *in order*: the first, and then the second only if the
first is answered `false`.

#### A transition that fires cancels the waits it did not answer

The list is walked from the top every round, so a rule AHEAD of the waiting one can
become true while somebody is still deciding — a child finishes, an agent reports,
a limit is reached. When it fires, the outstanding wait is **cancelled**: the card
stops being draggable, and the offer disappears rather than sitting there belonging
to a decision that has already been made somewhere else. The same happens when the
state ends for any other reason — terminated, timed out, or superseded by a sequence
reset.

A drop that lands in that window is not an error. It answers a wait nobody is holding
any more, and nothing happens.

⚠️ **A state offering a drag does not finish on its own.** Its list is evaluated
after every round, so an unconditional offer is re-made forever and the run never
terminates — which is correct for a column somebody is meant to move cards out of,
and a hang for anything else. Give it a way out: a `timeout` in the options, a
rule ahead of it that terminates, or a condition that stops holding —
`.run.cursor !== 'in_review'` is the usual one, since `run.cursor` is the child the
run last entered.

#### An answer is used once

A taken transition **consumes** the answer. The next round asks again, registering
a fresh wait — so a card that was dragged into a column can be offered another
move, and the rule that moved it does not fire a second time on the memory of the
first drag.

#### What the board does with it

The card becomes draggable, and the columns its rules name light up as drop
targets. Nothing else appears: no dialog, no inbox entry, no badge. The board reads
the WAITS the running workflows have published rather than re-reading the workflow
file, which is why the preconditions above are honoured exactly — a wait exists only
because the engine reached the call.

A drag is offered only when **both ends are on screen**: the card, and a column
whose key matches `to_state` at the board level being viewed. A rule pointing at a
child of a deeper state offers nothing here.

#### Unattended runs answer `false`

A CLI run, or a scheduled one, has nobody to make the gesture. Rather than hanging,
the call answers `false` immediately and the rules behind it have their turn — so
write a fallback rule after any wait that a headless run might reach.

---

## 8. Binding forms

Everywhere a value is wired, one of these appears — under `binding:` in a
parameter (§3, §4.3), or bare in `children.<key>.inputs` (§6).

A **runtime reference** is a leading-dot path into this instance's data. It is
the preferred spelling, and the one the rest of this file uses:

| Form | Meaning |
| --- | --- |
| `".inputs.issue"` | This state's declared input |
| `".children.context.outputs.plan_doc"` | One named output of a declared child |
| `".children.context.outputs"` | A child's whole output object, as one value |
| `".artifacts.design_doc"` | A session-owned artifact |
| `{ "text": "hello" }` | A literal string |
| `{ "json": { "a": 1 } }` | A literal JSON value |
| `"add(.children.a.outputs.n, 1)"` | A computation (§9) — no wrapper needed |
| `{ "expr": "add(.children.a.outputs.n, 1)" }` | The same computation, wrapped |

**One rule decides all of these: a leading dot is *data*, a bare name is a
*document*.** It holds at every depth — at the top of a binding, inside an
expression, in a guard, in a `{{…}}` template hole — so there is nothing extra to
know about where you happen to be writing:

```jsonc
"binding": ".inputs.issue"                  // this instance's input
"binding": "add(.inputs.n, 1)"              // …and the same read, inside a computation
"binding": "$/lib/wiring.plan"              // a document: resolved and spliced in
"when":    ".children.critique.outcome === 'success'"
```

A bare name is resolved along `config.workflows.path` (§2.1), and **what it resolves
to decides how it reads** — a binding form is that binding, an operation document is
that operation, a `.md` is text, anything else is a JSON literal.

`{"expr": …}` stays as the explicit spelling. It says nothing the bare string does not,
and it is worth reaching for when a reader would otherwise have to squint to see that a
value is computed.

**The tagged forms are gone.** `{ "child": … }`, `{ "input": … }`,
`{ "artifact": … }` and `{ "conversation": … }` each said one of these separately
and were kept alongside the dotted spelling while workflows migrated. There is one
way to name a runtime value now, and no table mapping five spellings onto it —
see [REFERENCES.md §10](REFERENCES.md) for what each one became.

---

## 9. Expressions

Used in transition guards, in `{ "expr": … }` bindings, and — since they are the same
thing — in a **bare string binding**:

```jsonc
"binding": "add(.children.a.outputs.n, 1)"          // no wrapper needed
"binding": { "expr": "add(.children.a.outputs.n, 1)" }  // identical
```

**Namespaces** — all reached through the leading dot, which is what tells a read of this
instance's data apart from a name resolved along the path:

| Namespace | Available in | Contents |
| --- | --- | --- |
| `.inputs.*` | both | this instance's resolved inputs |
| `.outputs.*` | both | outputs produced so far |
| `.children.<key>.outputs.*` | both | a child's outputs |
| `.children.<key>.outcome` | both | `success` \| `error` \| `canceled` \| `timeout` |
| `.artifacts.*` | both | artifacts registered this run |
| `.operation.output` | both | **what this state's call returned** — the value itself: an object exposes its properties, a list *is* the list |
| `.operation.output.<name>` | both | one named value off an object return |
| `.operation.output.session` | both | the position a prompt call ended at — one of its outputs, not an envelope beside them |
| `.operation.outcome` \| `.cost` \| `.model` \| `.usage` | **guards only** | how the call went. Not a binding — a slot receives what a call returned, not how it went |
| `.children.<key>.operation.output.*` | both | a child's |
| `.run.iteration` | guards only | transitions taken by this instance |
| `.run.cursor` | guards only | the child key the cursor is at — see below |
| `.run.position` | guards only | its index in `sequence`; `-1` before any child runs |
| `.limits.*` | guards only | this state's declared limits |

⚠️ **The dot is required.** `children.a.outputs.n` without it is a *reference* — a name
searched along `config.workflows.path` — and fails to load if no document is there. The
error names the fix, but the rule is worth learning once rather than meeting as a
diagnostic: **a leading dot is data, a bare name is a document.**

**Operators:** `===` `!==` `==` `!=` `<` `<=` `>` `>=` `&&` `||` `!` `? :` `+` `-` `*`
`/`, with JavaScript semantics and standard precedence.

Arithmetic is **sugar for the built-ins** — `a + b` is `add(a, b)`, and both parse to
one node — so there is nothing extra to learn about how it lowers, types or waits.
Two rules decide the two ambiguous characters:

| Written | Reads as | Because |
| --- | --- | --- |
| `at(xs, -1)`, `xs[-1]`, `-2 + 5` | a **sign** | nothing that ends a value precedes the `-` |
| `.n - 1`, `.n -1`, `(4) - 1` | a **subtraction** | a number, a name or a closing bracket does |
| `$/lib/classify(x)`, `lib/review(x)` | a **reference path** | a bare NAME sits left of the `/` |
| `.total / 2`, `len(.xs) / 2`, `6 / 3` | a **division** | nothing that could be a reference does |

The one thing you cannot write is `foo / bar` for two bare names: that is the
reference `foo/bar`. A bare name is a document and never a number, so this is the
right way round.

### Reading a conversation

A conversation is addressed by **ref**, never by name — a session is a position, and
`messages(<ref>)` is the only way to read one:

```jsonc
"when": "at(messages(.operation.output.session), -1).content === 'continue'"
"when": "len(messages(.children.plan.operation.output.session)) > 4"
```

The ref comes from `.operation.output.session` — an opaque `{ id }`. To read a
*sibling's* conversation the ref flows as data: the parent wires
`.children.plan.operation.output.session` into a child's input, and the child calls
`messages()` on it.

Turns are typed `{ role, content }`, so `at(…, -1).content` is checked and `.text` is
a lint error.

⚠️ There is no `.conversations.<name>` namespace. It looked up a session by NAME, and
a name stopped addressing anything when a session became a position — it could only
ever reach a conversation that had had no calls.

### Calling an operation

An expression can apply an operation, and the operation may be anything the system can
run — a built-in, a function, or a PROMPT:

```jsonc
{ "expr": "add(.children.a.outputs.n, 1)" }
{ "expr": "classify(.inputs.issue).severity === 'high'" }
{ "expr": "$JAIRA/prompts/review(.inputs.plan)" }
```

The callee is a **reference**, resolved the same way every other reference is (§2.1):
bare names search `config.workflows.path`, and a rooted or dotted path names a file
directly. What it resolves to is an operation DOCUMENT — the same shape an `operation`
block is written in — so a project operation and a built-in are indistinguishable except
in where the name resolves:

```jsonc
// .jaira/functions/classify.json
{ "kind": "prompt", "prompt": "Classify {{.inputs.text}}.", "model": "anthropic/claude-sonnet-5",
  "input": { "text": { "kind": "text", "index": 0 } } }
```

Arguments bind positionally, by the callee's declared `index` (or declaration order).
Where a call takes an options bag rather than a list of values, write an **object
literal** — the aggregate literal, and the only place keys are written in an expression:

```jsonc
{ "expr": "notify(.inputs.owner, { channel: 'email', urgent: .inputs.severity > 2 })" }
```

Keys are bare identifiers or quoted strings, never computed (`get(o, k)` is the
spelling for a computed read); values are full expressions; a trailing comma is fine.

Every call is **memoized by content** — the callee plus its resolved arguments — so the
same call named twice is one execution, and a call in a guard costs one however many
rounds the guard is evaluated over. A call whose argument differs is a different call.

A call in a guard runs only when the guard actually **asks** for it: `.inputs.n > 3 &&
classify(.inputs.issue).severity === 'high'` does not classify anything at `n = 2`. That
matters most for a call that waits on a person (§7.4), where an unnecessary call is not a
wasted computation but a request somebody should never have seen.

### 9.1 Calling your own TypeScript

A callee's body can be a **`.ts` file** beside the workflow, and nothing at the call site
changes:

```ts
// $BASE/functions/confidence.ts
export const confidence = {
  /** @param rank blocker=3 … note=0. */
  score(rank: number, iteration: number, maxIterations = 3): number {
    return Math.max(0, 1 - 0.35 * (rank / 3) - 0.25 * (iteration / maxIterations));
  },
};
```

```jsonc
"outputs": { "score": { "binding": "confidence.score(.inputs.rank, .run.iteration)" } }
```

**The signature is READ from the TypeScript**, never declared beside it: parameter names,
their positions (which is why arguments bind positionally with no annotation), their
types converted to the wire schema, `?` and `| undefined` as optionality, a parameter
default as the slot's default, and a JSDoc `@param` as its description. There is nowhere
for a JSON restatement to disagree, because there is no JSON restatement.

**Use `.ts`, not `.js`.** A `.js` module has no annotations, so every slot is untyped —
and an untyped slot accepts anything, which is exactly the hole a typed consumer is
supposed to catch. `any`, `unknown`, and generic type variables degrade the same way, and
each is reported as a warning naming the parameter rather than swallowed.

**What a file contributes is its EXPORTS, not its name.** A default-exported function
contributes the filename; a default-exported *object* contributes one symbol per key,
nested to any depth, and the filename contributes nothing. `export const confidence = {…}`
above contributes `confidence.score` — and would still contribute it from `lib.ts`.

**Nothing reaches a function but its parameters.** No run context, no session, no ambient
handle. A throw becomes a classified failure rather than an exception crossing the seam,
so a retriable error raised inside one still reaches the retry machinery.

#### ⚠️ Approve it before it runs

A module is the one reference that is not inlined into the workflow, so JaiRA gates it:

```bash
jaira functions approve ~/.jaira/functions/confidence.ts
jaira functions list            # approved · CHANGED · missing
jaira functions revoke <file>
```

Until a file is approved it **contributes no symbols at all** — the call fails to resolve
and the workflow will not load, rather than resolving and refusing at run time. That reads
as harsh and is the only version that works: the rule has to be *an unknown file is an
unapproved file*, because a NEW file earlier on the search path changes which module a name
resolves to without touching anything that already existed. Editing an approved file puts
it back in that state until it is approved again.

#### You are asked, not just told

The gate holds, but it is a **question** wherever somebody can answer it. Starting a task
whose workflow reaches an unapproved module stops **before** the bundle is validated,
snapshotted or frozen — so nothing has happened, and answering yes starts the run for the
first time rather than resuming a half-started one.

| Where | What happens |
| --- | --- |
| The app | A dialog naming each file, its call sites, and its **full source**. Approve and it starts. |
| `jaira` on a terminal | The same, on stdout, then `[y/N]`. Anything but `y`/`yes` is no. |
| A pipe, CI, `--non-interactive` | Refuses, and prints the `jaira functions approve` line that answers it. |
| `--approve-functions` | Approves everything the workflow reaches, as part of starting it. |

`--non-interactive` and `--approve-functions` are both on `jaira run` and `jaira task start`.

This is possible because an unapproved module can be *named* even though it resolves to
nothing. Resolution consults a gated symbol index and gets a miss; the diagnosis consults an
ungated one — which parses declarations and runs no code — and learns which file would have
answered. A name missing from **both** is a typo and is left to fail as one, so
`confidence.nope` still reports `is not a known operation` while `confidence.score` becomes
a file to approve. `jaira workflow lint` and the app's workflow browser report it the same
way.

Approvals are **machine-local and never synced** (`$BASE/system/approvals.local.json`,
gitignored): an approval is a statement about a file on one disk, and propagating it would
let one compromised machine confer trust on the rest. Files under `node_modules/` are
exempt — their integrity is the lockfile's problem.

#### What a run is frozen to

At task start every reachable module is resolved, checked against its approval, and the
**transpiled** output is copied into the snapshot directory beside the state files. Their
hashes fold into the snapshot hash, so a workflow's identity covers the code it calls.

Two consequences worth knowing. A pinned re-run executes the **frozen copies**, not
what is on disk now — a stored hash can only detect drift and refuse, it cannot run the
version that was approved. And an unapproved or changed file **stops the run before
anything executes**, as an error rather than a prompt: a run is not the moment to be
deciding what code to trust.

### Built-in operations

Ship with the language; a built-in name wins over the path.

| | |
| --- | --- |
| arithmetic | `add` `sub` `mul` `div` `mod` `min` `max` `abs` `round` `floor` `ceil` — or their operator spellings |
| access | `get(obj, key)` `at(array, i)` — member access takes a *literal* name, these take a computed one |
| arrays | `len` `first` `last` `isEmpty` `slice` `sort` `unique` `reverse` `append` `range` `join` `contains` |
| aggregates | `sum` `avg` `dot` `any` `all` `pluck(xs, key)` `maxBy(xs, key)` `minBy(xs, key)` `sortBy(xs, key)` `find(xs, key, value)` |
| strings | `concat` `split` `trim` `lower` `upper` `replace` `startsWith` `endsWith` |
| objects | `keys` `values` `entries` `fromEntries` `merge` `pick` `omit` |
| json & types | `parse_json` `to_json` `typeof` `isArray` `isNull` `coalesce` |
| higher-order | `map` `filter` `flatMap` `reduce` — see below |

All are pure and **total**: `div(1, 0)` is `Infinity`, `at(xs, 99)` is nothing,
`parse_json('{')` is nothing. None throws, and none mutates — `append` returns a new
array, which is why there is no `push`. One deliberate choice inside that rule:
`avg([])` is `0`, not `NaN`, because every comparison against `NaN` is false and a
`NaN` score would make `score < ask_below` quietly false.

**The aggregates take a KEY NAME where the higher-order forms take an operation.** Both
work; the difference is what you have to have on disk. `map`/`filter`/`reduce` apply an
operation named by REFERENCE, so folding a column with `reduce` means authoring a
document for the fold. `sum(pluck(xs, 'total'))` says the same thing with no file at
all, which for the numeric cases — a weighted score, a winning row, a margin — is the
whole cost.

```jsonc
{ "expr": "sum(pluck(.inputs.scores, 'total'))" }
{ "expr": "maxBy(.inputs.scores, 'total').candidate_id" }
{ "expr": "max(0, 1 - dot(.inputs.weights, .inputs.signals))" }
```

### A key an identifier cannot spell

A property name after `.` may be **quoted**, which reaches the keys the identifier
grammar cannot — a hyphen (now subtraction), a dot (the accessor itself), a space:

```jsonc
{ "expr": ".inputs.config.\"claude-cli\".model" }
```

`get(.inputs.config, 'claude-cli')` is the same read; the quoted form is the one that
chains.

### Applying an operation to every element

`map`, `filter` and `flatMap` take an operation by NAME and apply it per element;
`reduce` folds with one, taking the accumulator first and the element second:

```jsonc
{ "expr": "map(.inputs.issues, classify)" }
{ "expr": "reduce(.inputs.parts, joinTwo, '')" }
```

Elements run in parallel (`reduce` in sequence, since each step needs the last), and
each application is memoized on its own — so a repeated element is one execution, and
re-running after one element changed pays for that element only.

A failed element is error **data** (§5 of EXPRESSIONS.md): it travels in the array, and
the consuming slot's declared type decides whether that is acceptable or the operation
terminates.

### Gating on where the cursor is

`run.cursor` is the child **most recently entered**, which lets a transition say
*if we are at x and y holds, go to z*:

```jsonc
"transitions": [
  { "to": "escalate", "when": ".run.cursor === 'review' && .outputs.severity === 'high'" },
  { "to": "terminate.success", "when": ".run.cursor === 'publish'" }
]
```

Transitions are evaluated after an operation completes or a child terminates, so
"the cursor is at `review`" means `review` has **run** — not that it is about to.
It is typed as the declared child keys, so a typo is a lint error rather than a
comparison that is quietly always false. Before any child is entered it is `""`.

Reading a **still-running** child yields `PENDING`, which propagates: a binding
that resolves to `PENDING` parks the consumer rather than failing it. That is the
dataflow join described in §6.

---

## 10. Artifacts

An artifact is **a `blob`-kind slot** — there is no `"type": "artifact"`. The
`contentMediaType` keyword is what makes it one:

```jsonc
"outputs": {
  "plan_doc": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
}
```

When the operation returns a string for that slot, the engine registers an
artifact and the slot's value becomes a reference:

```jsonc
{ "artifact": true, "name": "feature.plan.context#3.plan_doc", "format": "text/markdown", "content": "…" }
```

### Where the bytes go

Placement is configured per project, not per workflow — the same workflow produces
files wherever the project wants them (DESIGN §7.6):

```jsonc
// .jaira/settings.json
"artifacts": {
  "destination": "$DEFAULT",   // $CENTRAL | $CENTRAL_FLAT | virtual: | a path template
  "dir": "artifacts",          // what $ARTIFACT_DIR expands to, under $SYSTEM
  "inlineMaxBytes": 65536      // above this, content is stored by reference
}
```

| `destination` | Where a file lands |
| --- | --- |
| `$DEFAULT` | `<worktree>/<the path the producer used>` |
| `$CENTRAL` | `<project>/.jaira/system/artifacts/<taskId>/<the path the producer used>` |
| `$CENTRAL_FLAT` | `<project>/.jaira/system/artifacts/<taskId>/<instanceId>-<slot>.<ext>` |
| `virtual:` | nowhere — content stays in memory and in the run record |
| anything else | a template over `$WORKTREE`, `$PROJECT`, `$JAIRA`, `$SYSTEM`, `$ARTIFACT_DIR`, `$TASK_ID`, `$RUN_ID`, `$INSTANCE_ID`, `$STATE_ID`, `$SLOT`, `$RELPATH`, `$BASENAME`, `$EXT` |

The central placements anchor on `$SYSTEM` — `<project>/.jaira/system`, where
everything JaiRA generates lives (DESIGN §3) — rather than on the worktree, so a
`git worktree remove` does not take a run's output with it.

**An agent never learns where its file went.** JaiRA registers the `write_file` and
`read_file` tools, so a write goes through the destination and a read of the same
path comes back — whatever the configuration did with the bytes. Write `docs/plan.md`
under `$CENTRAL` and it is stored at `.jaira/system/artifacts/<taskId>/docs/plan.md`; read
`docs/plan.md` and you get it. An agent that uses its *own* write tool instead
bypasses this (see DESIGN §7.6's reconciliation note).

Two containment rules apply, and both refuse rather than silently relocating: a
producer-supplied path may not escape the destination root, and the destination
root may not escape its anchor (unless it is an explicitly absolute path).

⚠️ The detail panel still has no artifacts list or markdown preview — the
records exist, the view does not (TODO.md).

---

## 11. Validation

`jaira workflow lint` (and every task start) runs three checks beyond "the file
parses and every reference resolves":

1. **Binding compatibility** — a producer's output schema must be a subschema of
   the consuming slot's schema.
2. **Expression typing** — every guard and `{ expr }` leaf is inferred; a guard
   that is not boolean is an error, and a declared schema on an expr leaf is
   checked against the inferred type.
3. **Reachability** — referencing a producer that is not provably run on every
   path to its use is an **error**. A declared `default` is the explicit opt-out.
   This is why `T | undefined` never propagates silently.

Reachability understands that a transition can pre-empt the spine: a sequence
member is proven to run only if no transition could fire before it. A guard over
`children.<key>.outputs` cannot fire until that child completes (it evaluates to
`PENDING`, which is skipped), while a guard reading only this state's own
`outputs` can fire the moment the operation finishes — and therefore pre-empts
every child.

The unguarded-cycle warning applies only to an **authored** `sequence`. Writing
the order out is what turns "these run in this order" into a claim a transition
can contradict; a derived sequence makes no such claim, so a transition into one
of two mutually exclusive children is just control flow.

### Reference diagnostics

Resolution happens before any of the above, since expansion has to run first
(§2.2). What it reports:

| Situation | |
| --- | --- |
| A reference matches no file | error |
| A reference names a directory | error |
| An unknown scheme or `$VAR` | error |
| A property path on a text file | error |
| A reference cycle | error |
| YAML that is not JSON-representable, cyclic, or has duplicate keys | error |
| A shorter candidate also matches (`user.json` **and** `user.address.json`) | **warning** — the longest wins |
| One state as both `plan.json` and `plan.yaml` | **warning** — JSON wins |

Filenames match **case-sensitively on every platform**, so a workflow resolves
identically on Windows and Linux rather than inheriting the host's rules.

An **operation the environment chain never completed** — no `kind`, or a function
op with no `function` — is reported here too, against `operation`, rather than
aborting the load. One broken state would otherwise hide every other authoring
error in the workflow.

Errors block a task start; warnings do not. `jaira workflow lint` additionally
runs in `strict` mode, where an unregistered `functionRef` is an error — the
pre-run gate deliberately does not, because a state a run never enters never needs
its function.

### 11.1 Checking against a description

Lint answers *will this run?*. It cannot answer *is this the workflow I asked
for?* — nothing in the files knows what you wanted. So write that down, in
English, and check the files against it:

```bash
npm run jaira -- workflow check workflow.md --project <dir>
```

With no file named, it reads `workflow.md` in the project directory. The command
extracts the individual requirements your document makes — the steps, their
order, the branches and loops, where a **human** must decide, what is delegated
to a coding agent rather than a model, and the artifacts each step produces —
then judges each one against the workflows as they will run, and **exits non-zero
unless every requirement is satisfied**. That is the point: a pre-commit hook or
CI job can gate on the document and the workflows staying in step.

What the judge is shown, per state, is the file **verbatim** plus a `resolved:`
line — the operation after `environment` inheritance, the child order the cursor
follows, per-mount environments, and how many transitions guard control flow.
Both halves are needed: a state that inherits `function: "claude-cli"` from its
mount says nothing about agents in its own file (§5), and a judge reading only
the file would call it empty.

Findings that matter are reported per requirement, with the state ids that are
the evidence:

```text
conformance: gaps
  description  workflow.md
  workflows    feature/plan

  ⚠ R2  a human approves the plan  — partial
      the gate exists but only a blocked critique routes into it, so an approved
      plan never reaches a person
      states: feature/plan/critique/human_review
  ✓ R1  the issue becomes goals
      states: feature/plan/goals

  not described by the document:
  · an automatic fix pass the document does not mention
    (feature/plan/critique/address_weaknesses)
```

Three things it deliberately does **not** do:

- **Guess when the evidence is incomplete.** A file that will not parse, or a
  root that will not load, refuses the check rather than judging what remains —
  a conformance answer over partial evidence reads as a clean bill of health.
  A state too long for the digest is named on stderr, never clipped silently.
- **Take its own verdict on trust.** The findings are the evidence; a run that
  lists a missing requirement and then says `conforms` is reported and overruled.
- **Treat a naming difference as a divergence.** A state called `critique` can
  satisfy "review the plan". A missing human gate, a missing loop, work in the
  wrong order, or work delegated to a different kind of runtime than described,
  are all real differences.

Extras — behaviour the workflow has that the document does not mention — are
listed but never fail the check. They are how you notice that the *document* is
the thing that is out of date.

Options: `--workflow <rootStateId>` (repeatable) narrows the check to named
roots, `--model <id>` overrides the model, `--json` prints the requirements and
findings for a tool to consume, and `--fake` scripts the check itself — it is an
ordinary workflow run, so everything that works for a run works here.

With no file named the command reads `workflow.md` at the top of the project,
and failing that `.jaira/workflows/workflow.md` — the copy the app can show,
since the Files view only reaches what is under a layer root.

### 11.2 Syncing the two

The check reports and stops, which is the right shape for a CI gate and the
wrong one for someone sitting in front of both documents. In the app, opening a
description gives it a viewer of its own: a line saying which side has drifted,
and two buttons.

- **Rewrite the description** — from the workflows as they are. Used when the
  workflows are what changed.
- **Propose workflow changes** — from what the description asks for. Used when
  the description is what changed. The proposal is whole *files*: state files
  under `workflows/`, and the prompt files under `prompts/` they reference.

Both run the check first and act on its findings, so an edit is traceable to the
requirement that motivated it, and the report is shown beside the proposal.

**Prompts go in `prompts/`, and the proposal is told so.** A non-trivial prompt
is proposed as its own markdown file, referenced from the state with
`{"$ref": "$/prompts/<name>.md"}`, and grouped into subfolders as categories
emerge (`prompts/review/critique.md`). The instruction is emphatic on purpose:
a model's path of least resistance is to inline, and an inlined prompt is
invisible to the next workflow that needs the same instruction — where a file
under `prompts/` is a library entry the next proposal is told to look for and
reuse before writing a near-duplicate. Only a one-line prompt that does nothing
but glue its bound inputs together may stay inline.

**Nothing is written.** The rewritten description arrives as an unsaved draft in
the editor below the panel; proposed state files arrive as drafts against their
own rows in the tree, marked like any other unsaved edit. You read them, then
Save or Revert, per file. One side of this pair is prose somebody wrote and the
other is code that will run, and a model rewriting either straight to disk would
be a model with commit rights. The document a sync *reads* is the draft too —
what the editor is showing, not what the file says.

**Which side moved** is answered from `.jaira/system/sync.json`: the content hash of the
description and of every state file, as of the last sync that was **accepted**.
Accepted, not run — a proposal produced and discarded left both sides exactly
where they were, and recording it would claim they agree when nobody made them.
Saving what a sync proposed is what advances the baseline; when a sync finds
nothing to change, that *is* the agreement and the baseline moves immediately.

Both sides can have changed, and that case is not resolved for you: neither
button is recommended, and the line says so. There is no mechanical answer to
which of two edited documents is now the truth, and picking one would silently
overwrite the other.

**The layer decides what a description is judged against.** A description in the
shared root is checked against the *shared root's* workflows and recorded in
`~/.jaira/system/sync.json`; a project's is checked against its own and recorded in
`.jaira/system/sync.json`. So the shared root syncs with no project open — which is the
mode shared workflows are written in — and gets the same answer in every window.
Judging a machine-global document against whichever checkout happened to be open
would make its status change per window, and would scatter one document's
baseline across every project on the machine.

A proposed file is refused rather than offered when its path escapes the layer
root or names anything other than `workflows/` or `prompts/`, when the state it
names is authored as YAML (the proposal is JSON, and writing it would leave one
file in two syntaxes), and when another description owns that state (§11.3 —
prompt files have no owner; reuse across descriptions is the point of the
folder). All are reported in the panel with the file they would have touched.
Anything the run could not express as a file at all — a human gate needing a
function this project has not registered — comes back as a note instead of an
invented state.

**Review as changeset.** The applicable proposals are also lowered into one
changeset (CHANGESETS.md §1) — `before` read from the tree as it stands, the
source pinned by content hash — and the panel offers to walk it through the
same review gate an agent's worktree gets, in rounds: merge or revert settles a
change, a `comment` sends the whole changeset back to a model that revises the
commented files under the same authoring rules the proposal was written under
(the description included), and the revision returns to the gate. Merged
decisions are applied into the layer root, and the sync baseline moves exactly
when the final round merged everything.

### 11.3 A description per workflow, and how they nest

Any `.md` under `workflows/` is a description, and it is about the state file
beside it: `workflows/feature.md` describes the root `feature`,
`workflows/feature/plan.md` describes `feature/plan`. `workflows/workflow.md`
names no state and sits at the top.

Because the state tree is already hierarchical — `feature` *contains*
`feature/plan` — descriptions written at two levels would otherwise cover the
same states twice. One rule resolves it:

> **The nearest description owns a state.**

The same resolution `.gitignore` and CODEOWNERS use. `feature.md` owns `feature`
and everything below it *except* subtrees that have a description of their own;
`workflow.md` owns whatever nothing nearer claims. Every state file is
answerable to exactly one document, which is what makes both the baseline and a
proposal well-defined. A layer with a single `workflow.md` therefore behaves
exactly as it did before descriptions could nest.

Three things follow, and they are what make the rule real rather than stated:

- **The digest stops at a boundary.** A delegated subtree is rendered as its
  *contract* — label, resolved operation, declared slots — plus the prose of the
  document that owns it, and its states are not shown at all. Prose delegates to
  prose: the best account of a subtree is the description somebody wrote of it,
  not a rendering of its state files, and a parent stays a document about
  contracts rather than a second copy of its children.
- **A sync will not write past a boundary.** An edit naming a state another
  description owns is reported and not offered, because it was written blind and
  would overwrite what a more specific document is the authority on. Changing how
  such a state is *mounted* — its inputs, its place in `sequence`, a transition
  into it — is fair game, since the mount lives in a state you do own.
- **The panel says what it delegated.** Under the status line: which subtrees
  belong to which document, and how many states are in each. Without it you edit
  a delegated state, the panel says "in step", and the honest answer is nowhere
  on screen.

`.jaira/system/sync.json` holds one record per description, keyed by document path, and
each record covers only the states that document owns. Settling one workflow
neither disturbs another's baseline nor makes an unrelated edit read as drift.

---

## 12. A complete example

The SPEC §9 planning workflow, shipped as JaiRA's starter (`specPlanningFiles()`
in `@jaira/runtime`, which parameterizes the model names for testing).

**`feature/plan.json`** — a pure composite: children, a sequence, and a re-plan
loop. It declares the `environment` the whole subtree inherits, so the leaves say
only what is different, and its children omit `state` because each key already
names the child. The `sequence` is written out because the re-plan transition
jumps backwards into it, and because that is the claim the lint surface checks
the jump against.

```jsonc
{
  "label": "Planning",
  "environment": { "kind": "prompt", "model": "anthropic/claude-sonnet-5" },
  "inputs": { "issue": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "markdown" } } },
  "outputs": {
    "outcome": {
      "schema": { "type": "string", "enum": ["complete", "blocked"] },
      "binding": { "expr": ".children.critique.outputs.outcome === 'clean' ? 'complete' : 'blocked'" }
    },
    "plan_doc": { "binding": ".children.context.outputs.plan_doc" },
    // A "passthrough" output: the whole child result as one value.
    "critique": { "binding": ".children.critique.outputs" }
  },
  "children": {
    "goals":   { "inputs": { "issue": ".inputs.issue" } },
    "context": { "inputs": { "issue": ".inputs.issue", "goals": ".children.goals.outputs.goals" } },
    "critique": {
      "inputs": { "plan_doc": ".children.context.outputs.plan_doc", "severity_threshold": { "text": "significant" } }
    }
  },
  "sequence": ["goals", "context", "critique"],
  "transitions": [
    { "to": "terminate.success", "when": ".children.critique.outputs.outcome === 'clean'" },
    { "to": "goals", "when": ".children.critique.outputs.outcome === 'needs_changes' && .run.iteration < .limits.max_iterations" },
    { "to": "terminate.success", "when": ".children.critique.outcome === 'success'" }
  ],
  "limits": { "max_iterations": 3 }
}
```

**`feature/plan/goals.json`** — a prompt state. It names no `kind` and no model;
both come from the root's `environment`.

```jsonc
{
  "label": "Goals",
  "inputs":  { "issue": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "markdown" } } },
  "outputs": { "goals": { "schema": { "type": "array", "items": { "type": "string" } } } },
  "operation": { "prompt": "Extract goals from {{.inputs.issue}}." }
}
```

**`feature/plan/critique.json`** (abridged) — overrides only the model, and
declares an **empty sequence** because its two children are alternatives rather
than a spine. Without that, both would run in declaration order.

```jsonc
{
  "label": "Critique Plan",
  "operation": { "model": "anthropic/claude-opus-4-5", "prompt": "Review the plan document…" },
  "children": {
    "address_weaknesses": { "inputs": { /* … */ } },
    "human_review":       { "inputs": { /* … */ } }
  },
  "sequence": [],
  "transitions": [
    { "to": "terminate.success", "when": ".children.human_review.outcome === 'success'" },
    { "to": "terminate.success", "when": ".children.address_weaknesses.outcome === 'success'" },
    { "to": "terminate.success", "when": ".outputs.outcome === 'clean'" },
    { "to": "human_review",      "when": ".outputs.outcome === 'blocked'" },
    { "to": "address_weaknesses","when": ".outputs.outcome === 'needs_changes'" }
  ]
}
```

**`feature/plan/critique/human_review.json`** — a UI gate, which is just a
function state. Declaring `kind: "function"` drops the inherited call settings,
so the gate does not silently receive the root's `model` (§5.2).

```jsonc
{
  "label": "Human Review",
  "outputs": { "decision": { "schema": { "type": "string", "enum": ["approve", "request_changes", "block"] } } },
  "operation": {
    "kind": "function",
    "function": "choose_option",
    "args": {
      "prompt": "How should this critique be handled?",
      "options": ["approve", "request_changes", "block"]
    }
  }
}
```

### 12.1 A second example: one change, two agents

Reviewing with **both** Claude Code and codex, then merging what they found. It is
short because the pieces do the work: one review state mounted twice (§6.1), two
async children so the reviews overlap, and a dataflow join that needs no join
construct (§6).

> These three states are the fixture in `packages/runtime/test/twoAgentReview.e2e.test.ts`.
> That test runs them through both adapters' real argv builders and real stream
> parsers, with a fake process standing in for the two binaries — so the shapes below
> are ones that load and run, not ones that ought to.

**`review.json`** — the composite. The two mounts differ only in the agent they
run under.

```jsonc
{
  "label": "Review the change",
  "inputs": { "change": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/x-diff" } } },
  "outputs": { "report": { "binding": ".children.synthesize.outputs.report" } },
  "children": {
    "claude_review": {
      "state": "review/agent_review",
      "async": true,
      "environment": { "kind": "function", "function": "claude-cli" },
      "inputs": { "change": ".inputs.change" }
    },
    "codex_review": {
      "state": "review/agent_review",
      "async": true,
      "environment": { "kind": "function", "function": "codex-cli" },
      "inputs": { "change": ".inputs.change" }
    },
    "synthesize": {
      "inputs": {
        "review_a": ".children.claude_review.outputs.report",
        "review_b": ".children.codex_review.outputs.report"
      }
    }
  },
  "sequence": ["claude_review", "codex_review", "synthesize"]
}
```

Both reviews start without blocking. The cursor reaches `synthesize` immediately,
but its inputs read outputs of two unresolved children, so it waits for both —
that is the whole join. With no transitions declared, the state terminates
successfully once all three children finish.

**`review/agent_review.json`** — the state that runs *twice*. It names **no
`function`**: that is what makes it mountable under either agent, and the two
mounts load as two variants (§5).

```jsonc
{
  "label": "Agent review",
  "inputs": { "change": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/x-diff" } } },
  // A delegated agent answers with ONE string, so the slot it fills is blob-kind (§4.4).
  "outputs": { "report": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } } },
  "operation": {
    "kind": "function",
    // `operation.input` values are PARAMETERS, so the wiring goes under `binding` (§4.3).
    // The instruction is built with `concat`: the expression language has no `+` (§9), and a
    // function op gets no `{{…}}` rendering — that is a prompt op's own template.
    "input": {
      "prompt": {
        "kind": "text",
        "binding": { "expr": "concat('Review this change and list what is wrong: ', .inputs.change)" }
      }
    },
    "output": { "name": "report", "kind": "blob" }
  }
}
```

**`review/synthesize.json`** — an ordinary prompt state; nothing about it knows
two agents were involved.

```jsonc
{
  "label": "Synthesize",
  "inputs": {
    "review_a": { "schema": { "type": "string" } },
    "review_b": { "schema": { "type": "string" } }
  },
  "outputs": { "report": { "schema": { "type": "string" } } },
  "operation": {
    "kind": "prompt",
    "model": "anthropic/claude-sonnet-5",
    "prompt": "Two reviewers looked at one change. Merge their findings, drop duplicates, and flag anything they disagree on.\n\nReviewer A:\n{{.inputs.review_a}}\n\nReviewer B:\n{{.inputs.review_b}}"
  }
}
```

Three things worth knowing before running it:

- **Declare no `tools` on the codex mount.** Codex reaches JaiRA's tool bridge and
  auto-denies the call, so the adapter refuses rather than let the agent answer
  "user cancelled MCP tool call" and report success (§4.2). It reviews with its own
  built-ins under its sandbox.
- **Give the reviewers separate conversations, which is the default.** Naming one
  `session` for both would put two agents in one transcript; here each mount gets
  its own, and only `synthesize` sees both reports.
- **`codex-cli` needs `codex` on PATH**, and `claude-cli` needs `claude`. Both are
  registered whether or not the binary exists, so a missing one fails that state
  with a spawn failure naming the command (`codex exited with code -1`) rather than
  "unregistered function" — which would have pointed at the workflow instead of at
  the machine.

---

### 12.2 A third example: a board somebody moves cards on

Three columns, an agent working in each, and a person deciding when a ticket moves
between them (§7.4). Nothing here is a UI feature: the columns are children, the
moves are transitions, and the only thing that makes the cards draggable is a guard
that waits.

> These states are the fixture in `packages/runtime/test/userEvents.test.ts`, driven
> through the real hub — so this is a workflow that loads and runs, not one that ought
> to.

**`support/ticket.json`** — the board level. Each child is a column, left to right.

```jsonc
{
  "label": "Ticket",
  "inputs": {
    "issue": { "kind": "text", "schema": { "type": "string" } },
    "severity": { "schema": { "type": "number" } }
  },
  "children": {
    // Each column takes the ticket, not the previous column's output. A column reached by a
    // DRAG is not proven to have run after any particular other one, so wiring
    // `.children.triage.outputs.summary` into it is a reachability error (§11) — and the
    // checker is right: a person decides the order, so there is no order to prove.
    "triage":    { "state": "./triage",    "inputs": { "issue": ".inputs.issue" } },
    "in_review": { "state": "./in_review", "inputs": { "issue": ".inputs.issue" } },
    "done":      { "state": "./done",      "inputs": { "issue": ".inputs.issue" } }
  },
  // Only `triage` is on the spine. The other two columns are reached by a person
  // moving the card there, which is what `sequence` naming one child says (§6).
  "sequence": ["triage"],
  "transitions": [
    // Draggable from triage to in_review, but only for a real problem. At severity 1
    // nobody is asked, the card is not draggable, and the run simply ends after triage.
    { "to": "in_review",
      "when": ".run.cursor === 'triage' && .inputs.severity > 2 && on_user_event('task_drag')" },

    // …and from in_review to done. `to_state` is the rule's own `to`, so neither rule
    // has to name a column twice.
    { "to": "done",
      "when": ".run.cursor === 'in_review' && on_user_event('task_drag')" },

    { "to": "terminate.success", "when": ".run.cursor === 'done'" }
  ]
}
```

`.run.cursor` — the child the run last entered — is what stops each offer once it has
been taken. Without it the first rule would be re-made the moment `in_review` finished,
offering to drag the card into the column it is already in, and the run would never
terminate (§7.4).

**`support/ticket/triage.json`** — an ordinary agent state. The columns are states like
any other; nothing in them knows a person is watching.

```jsonc
{
  "label": "Triage",
  "inputs": { "issue": { "kind": "text", "schema": { "type": "string" } } },
  "outputs": { "summary": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } } },
  "operation": {
    "kind": "function",
    "function": "claude-cli",
    "input": { "prompt": { "kind": "text", "binding": { "expr": "concat('Summarize and classify this ticket: ', .inputs.issue)" } } },
    "output": { "name": "summary", "kind": "blob" }
  }
}
```

`in_review.json` and `done.json` are the same shape with different instructions.

⚠️ **A hand-moved column cannot be wired from the one before it.** Dataflow between
columns is the one thing this shape gives up: a state entered by a drag has no proven
predecessor, so `.children.triage.outputs.summary` in `in_review`'s wiring fails the
reachability check. Pass what every column needs from the board level's own inputs, or
give the consuming slot a `default`.

**What a person sees.** The ticket's card sits in the `Triage` column with a `paused`
pill while the workflow waits. Its cursor is a grab handle; picking it up dashes the
`In review` column and nothing else. Dropping it there answers that rule — the card
moves because the run moved, not because the board moved it — and a moment later the
card is in `In review`, paused again, now offering `Done`.

**Two variations worth knowing:**

```jsonc
// Give up after an hour and escalate instead — a wait with no `timeout` waits forever.
{ "to": "in_review", "when": "on_user_event('task_drag', { timeout: 3600 })" },
{ "to": "escalate" }

// Drop somewhere OTHER than where the rule goes. Rare, and the reason `to_state` exists:
// dragging to the parking column records the decision and routes to a state that says so.
{ "to": "record_parked", "when": "on_user_event('task_drag', { to_state: 'parked' })" }
```

---

## 13. The traps, in one list

Every one of these fails **silently or misleadingly**:

1. `operation.input` values need a `binding:` wrapper; `children.*.inputs` values
   do not. Getting it backwards resolves the slot to empty and reports success.
2. A delegated agent's output slot must be `blob`-kind, or the state fails with
   "did not produce required output".
3. A guard must infer to boolean — `"when": ".outputs.x"` is an error, not a
   truthiness test.
4. Omitting `sequence` runs **every** child, in declaration order. A state that
   means "these are alternatives" needs `"sequence": []` plus transitions.
5. Omitting `children` infers them from the directory — adding a state file under
   a composite's namespace adds it to the run. `"children": {}` opts out.
6. Only `async: true` overlaps children; everything else runs one at a time.
7. `run.cursor` is the child that just RAN, not the one about to.
8. A binding reference needs its leading dot — `children.c.outputs.x` without it
   is a *document* reference and fails as a missing file.
9. `./x` is relative to the state's **id**, not to its file's directory.
10. An `environment` block only *defaults* an operation — a state with no
    `operation` block never gets one. Write `"operation": {}` to inherit it whole.
11. `prompt`, `schema` and `binding` are replaced by an inheriting layer, not
    merged; `args` is merged. A layer that changes `kind` drops the inherited
    call settings.
12. Models must be route-prefixed (`anthropic/claude-sonnet-5`).
13. `contentMediaType` is what makes a slot an artifact; there is no
    `"type": "artifact"`.
14. `tools` is what subjects an agent's commands to the policy — and it is a
    grant, not a fence: a delegated agent keeps its own built-ins beside it. A
    state that must not write declares `permissions.profile: "read-only"` too.
15. A `generic-cli` state is refused outright while the policy can escalate to a
    human — which `policy.builtins: false` alone does not settle: a `default` or a
    rule of `require_approval` keeps it escalating.
16. Inside a `schema`, `$ref` is always **JSON Schema's** — ours is the bare-string
    form. Inside `args`, only `{"$ref": …}` works, because nothing types that
    position.
17. A transcluded fragment is a **copy**, not a link — editing it changes future
    loads, never a task already pinned to a snapshot.
18. `plan.json` and `plan.yaml` are one state id, so having both is a warning and
    the JSON wins. Two files whose names differ only past a dot
    (`user.json`, `user.address.json`) make `$/types/user.address` ambiguous —
    also a warning, longest match wins.
19. A guard that waits (`on_user_event`, §7.4) **stops the list** — everything
    after it, the state's own rules included, waits with it, and the state will
    not terminate. An offer with nothing to stop it being re-made after every
    round is a run that never ends: bound it with `.run.cursor`, a `timeout`, or
    a rule ahead of it.
20. A column a person drags a card INTO cannot be wired from the column before
    it: a hand-moved state has no proven predecessor, so the reachability check
    rejects it (§12.2).
21. A `.ts` function contributes NOTHING until it is approved (§9.1). Editing an
    approved file un-approves it. You are ASKED before a run rather than left to
    read the parse error it would otherwise cause — but only where somebody can
    answer: the app shows the file and its source, `jaira` prompts on a terminal,
    and everywhere else (a pipe, CI, `--non-interactive`) it refuses with the
    `jaira functions approve <file>` line that answers it.
22. A `.js` function module types nothing. Every parameter is an untyped slot that
    accepts anything, so a wrong argument reaches the code instead of the linter.
23. A module contributes its EXPORTS, not its filename — an exported OBJECT
    contributes its keys and the filename contributes nothing, so `confidence.ts`
    exporting `{ confidence: {...} }` gives `confidence.score`, not
    `confidence.confidence.score`.
