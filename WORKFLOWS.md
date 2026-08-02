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
--workflow feature/plan` — and the workflow browser treats any state no other
state declares as a child as a root.

The tree convention (a child's id should be a descendant path of its parent's) is
a **warning**, not a rule, so a shared library state can be mounted anywhere.

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
| `schema` | optional (but see below) | JSON Schema for the value. Absent ⇒ unconstrained, and the checker treats it as universal — so nothing about it can be type-checked. |
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
from a child, an expression, or a literal. An output **without** a binding is
*produced* — the operation must return it. So `binding` is required for a derived
output and must be absent for a produced one; there is no third case.

```jsonc
"outputs": {
  "weaknesses":  { "schema": { "type": "array", "items": { "type": "string" } } },   // produced
  "outcome":     { "binding": { "expr": ".children.critique.outputs.outcome" } },     // derived
  "plan_doc":    { "binding": ".children.context.outputs.plan_doc" },                // derived
  "critique":    { "binding": ".children.critique.outputs" }                         // whole child
}
```

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
| `output` | optional | Output slot (§4.4). Absent ⇒ built from the state's produced outputs. |
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
| `output` | optional | Output slot (§4.4). Absent ⇒ built from the state's produced outputs. A delegated agent needs `kind: "blob"`. |
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
  to inherit `models.default` from `.jaira/config.json`, or set it once in an
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
| `edit_markdown` | UI gate | |
| `fill_form` | UI gate | |
| `confirm_action` | UI gate | |
| `claude-code` | Delegated agent, in-process SDK | `policyEnforcement: "callback"` |
| `claude-cli` | Delegated agent, `claude` subprocess | `policyEnforcement: "callback"` via the MCP bridge |
| `codex-cli` | Delegated agent, `codex exec` subprocess | `policyEnforcement: "config"` — see below |
| `generic-cli` | Non-Claude agent CLI | Configured in `config.agents.genericCli`; **`policyEnforcement: "none"`**, so §5.1 refuses it unless `policy.builtins` is `false` |
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

### 4.4 `operation.output` and the blob rule

Omit `output` and the loader builds one object slot from the state's *produced*
outputs — so the operation must return `{ "<name>": …, … }`.

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
- **`conversation.mode`** — `full_history` | `summary` | `fresh` |
  `selected_artifacts` (the last takes `artifacts: [names]`).
  ⚠️ `summary` is **per session, not per state**: one session has one transcript,
  so a session mixing `summary` and `full_history` is summarized for both. The
  lint surface warns — and it reads the *effective* mode, so an inherited one is
  caught too.
- **`permissions`** — the definition-authored baseline, beneath the project
  policy.

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
    "state": "$/review/agent_review",
    "async": true,
    "environment": { "kind": "function", "function": "claude-cli" },
    "inputs": { "change": ".inputs.change" }
  },
  "codex_review": {
    "state": "$/review/agent_review",
    "async": true,
    "environment": { "kind": "function", "function": "codex-cli" },
    "inputs": { "change": ".inputs.change" }
  },
  "synthesize": {
    "state": "$/review/synthesize",
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
| `limits.max_iterations` | optional | Exposed to guards as `limits.max_iterations`. |
| `limits.timeout` | optional | **Seconds**; exceeding it terminates the state `terminate.timeout`. |

Transitions are evaluated **in order, first match wins**, when an operation
completes or a child terminates. A guard that evaluates to `PENDING` (it reads a
child still running) is **skipped this round** and retried — it does not fail and
does not fall through to a later transition permanently.

### ⚠️ Guards must infer to `boolean` — strictly

There is no truthiness coercion. `"when": ".outputs.goals"` is a **lint error**,
not a non-empty check. Write `"outputs.goals.length > 0"`.

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
| `.operation.outputs.session` | both | the conversation position this state's call ended at |
| `.children.<key>.operation.outputs.session` | both | a child's |
| `.run.iteration` | guards only | transitions taken by this instance |
| `.run.cursor` | guards only | the child key the cursor is at — see below |
| `.run.position` | guards only | its index in `sequence`; `-1` before any child runs |
| `.limits.*` | guards only | this state's declared limits |

⚠️ **The dot is required.** `children.a.outputs.n` without it is a *reference* — a name
searched along `config.workflows.path` — and fails to load if no document is there. The
error names the fix, but the rule is worth learning once rather than meeting as a
diagnostic: **a leading dot is data, a bare name is a document.**

**Operators:** `===` `!==` `==` `!=` `<` `<=` `>` `>=` `&&` `||` `!` `? :`, with
JavaScript semantics. There is **no arithmetic syntax** — no `+`, `-`, `*`, `/` — so
computation is done by CALLING an operation (below). A leading `-` on a number is a
sign, so `-1` is a literal.

### Reading a conversation

A conversation is addressed by **ref**, never by name — a session is a position, and
`messages(<ref>)` is the only way to read one:

```jsonc
"when": "at(messages(.operation.outputs.session), -1).content === 'continue'"
"when": "len(messages(.children.plan.operation.outputs.session)) > 4"
```

The ref comes from `.operation.outputs.session` — an opaque `{ id }`. To read a
*sibling's* conversation the ref flows as data: the parent wires
`.children.plan.operation.outputs.session` into a child's input, and the child calls
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

Every call is **memoized by content** — the callee plus its resolved arguments — so the
same call named twice is one execution, and a call in a guard costs one however many
rounds the guard is evaluated over. A call whose argument differs is a different call.

### Built-in operations

Ship with the language; a built-in name wins over the path.

| | |
| --- | --- |
| arithmetic | `add` `sub` `mul` `div` `mod` `min` `max` `abs` `round` `floor` `ceil` |
| access | `get(obj, key)` `at(array, i)` — member access takes a *literal* name, these take a computed one |
| arrays | `len` `first` `last` `isEmpty` `slice` `sort` `unique` `reverse` `append` `range` `join` `contains` |
| strings | `concat` `split` `trim` `lower` `upper` `replace` `startsWith` `endsWith` |
| objects | `keys` `values` `entries` `fromEntries` `merge` `pick` `omit` |
| json & types | `parse_json` `to_json` `typeof` `isArray` `isNull` `coalesce` |
| higher-order | `map` `filter` `flatMap` `reduce` — see below |

All are pure and **total**: `div(1, 0)` is `Infinity`, `at(xs, 99)` is nothing,
`parse_json('{')` is nothing. None throws, and none mutates — `append` returns a new
array, which is why there is no `push`.

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
// .jaira/config.json
"artifacts": {
  "destination": "$DEFAULT",   // $CENTRAL | $CENTRAL_FLAT | virtual: | a path template
  "dir": "jaira-artifacts",    // what $ARTIFACT_DIR expands to
  "inlineMaxBytes": 65536      // above this, content is stored by reference
}
```

| `destination` | Where a file lands |
| --- | --- |
| `$DEFAULT` | `<worktree>/<the path the producer used>` |
| `$CENTRAL` | `<worktree>/jaira-artifacts/<taskId>/<the path the producer used>` |
| `$CENTRAL_FLAT` | `<worktree>/jaira-artifacts/<taskId>/<instanceId>-<slot>.<ext>` |
| `virtual:` | nowhere — content stays in memory and in the run record |
| anything else | a template over `$WORKTREE`, `$PROJECT`, `$JAIRA`, `$ARTIFACT_DIR`, `$TASK_ID`, `$RUN_ID`, `$INSTANCE_ID`, `$STATE_ID`, `$SLOT`, `$RELPATH`, `$BASENAME`, `$EXT` |

**An agent never learns where its file went.** JaiRA registers the `write_file` and
`read_file` tools, so a write goes through the destination and a read of the same
path comes back — whatever the configuration did with the bytes. Write `docs/plan.md`
under `$CENTRAL` and it is stored at `jaira-artifacts/<taskId>/docs/plan.md`; read
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
14. `tools` is what subjects an agent's commands to the policy.
15. A `generic-cli` state is refused outright unless `policy.builtins` is `false`.
16. Inside a `schema`, `$ref` is always **JSON Schema's** — ours is the bare-string
    form. Inside `args`, only `{"$ref": …}` works, because nothing types that
    position.
17. A transcluded fragment is a **copy**, not a link — editing it changes future
    loads, never a task already pinned to a snapshot.
18. `plan.json` and `plan.yaml` are one state id, so having both is a warning and
    the JSON wins. Two files whose names differ only past a dot
    (`user.json`, `user.address.json`) make `$/types/user.address` ambiguous —
    also a warning, longest match wins.
