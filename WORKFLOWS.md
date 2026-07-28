# Writing a JaiRA workflow

The reference for `.jaira/workflows/**/*.json` — every field, every binding form,
and the traps that fail silently.

This documents what the code **does** today, verified against
`@declarative-ai/hw`'s `format.ts` / `loader.ts` / `engine.ts` and JaiRA's own
registry. Where SPEC.md still describes the pre-redesign format (`agent` / `ui` /
`skill` / `params` blocks, bare-string wiring), this file wins — see
[DESIGN.md §1c](DESIGN.md).

Check your work with:

```bash
npm run jaira -- workflow lint --project <dir>
```

---

## 1. The shape of a workflow

One **state** per file. A state's **id** is its path under
`.jaira/workflows/`, without `.json`:

```text
.jaira/workflows/
  feature/plan.json                    → state id  feature/plan
  feature/plan/goals.json              → state id  feature/plan/goals
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
  "id": "feature/plan",            // optional; derived from the path. If present it must match.
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

Nothing else is recognized. There is no `params` block — reusable configuration
is an input with a `default`, or a literal binding.

---

## 3. Slots: `inputs` and `outputs`

A slot is a named, typed value. Both maps take the same shape:

```jsonc
"inputs": {
  "issue": {
    "kind": "blob",                                        // optional; usually derived
    "schema": { "type": "string", "contentMediaType": "text/markdown" },
    "binding": { "input": "issue" },                        // optional; see §8
    "default": "significant",                               // optional
    "optional": true,                                       // slots are REQUIRED by default
    "description": "The issue to plan against"
  }
}
```

### `kind` — the five leaf kinds

`text` · `json` · `blob` · `prompt` · `function`

You rarely write it: `kind` is derived from `schema`. The one derivation worth
knowing is **`contentMediaType` ⇒ `blob`**, which is how an artifact slot is
declared (§9).

### Required by default

A slot is required unless it declares `optional: true` or a `default`. This is
also the explicit opt-out from the reachability rule (§10).

### Outputs: produced vs. derived

An output with a **`binding`** is *derived* — computed when the state terminates,
from a child, an expression, or a literal. An output **without** a binding is
*produced* — the operation must return it.

```jsonc
"outputs": {
  "weaknesses":  { "schema": { "type": "array", "items": { "type": "string" } } },   // produced
  "outcome":     { "binding": { "expr": "children.critique.outputs.outcome" } },     // derived
  "plan_doc":    { "binding": { "child": "context", "output": "plan_doc" } },        // derived
  "critique":    { "binding": { "child": "critique" } }                              // whole child
}
```

This is what SPEC's old `"from": "children.x.outputs.y"` became: an output's
`from` is now that slot's `binding`.

---

## 4. `operation`

### 4.1 Prompt operations

One structured LLM call.

```jsonc
"operation": {
  "kind": "prompt",
  "prompt": { "template": "Extract goals from {{inputs.issue}}." },
  "system": "You are a careful planner.",
  "config": { "model": "anthropic/claude-sonnet-5" },
  "input":  { /* optional; see §4.3 */ },
  "output": { /* optional; see §4.4 */ }
}
```

- `prompt.template` **or** `prompt.skill` — exactly one. A skill is a named
  template resolved through `registry.skills` at render time.
  ⚠️ JaiRA does not populate `registry.skills` yet, so `prompt.skill` fails at run
  time (TODO.md).
- `{{inputs.x}}` interpolates against the operation's **resolved inputs**. With no
  `operation.input` map, the state's declared `inputs` are in scope.
- `config` is the model surface. **Models must be route-prefixed** —
  `anthropic/claude-sonnet-5`, not `claude-sonnet-5`. Omit it to inherit
  `models.default` from `.jaira/config.json`.

### 4.2 Function operations

Invoke a registered function by name.

```jsonc
"operation": {
  "kind": "function",
  "function": "choose_option",
  "config": { "prompt": "Approve this plan?", "options": ["approve", "block"] },
  "input":  { /* … */ },
  "output": { /* … */ }
}
```

`config` rides as the op's bound `config` input — it is the authored surface for
whatever the function expects.

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
| `generic-cli` | Non-Claude agent CLI | Configured in `config.agents.genericCli`; **`policyEnforcement: "none"`**, so §8.2 refuses it unless `policy.builtins` is `false` |
| `run_command` | Run one command, no agent | Takes `config.command`; gates itself against the project policy |

A UI gate's answer is validated twice — in the main process against the
component's contract, then by the engine against the state's output schema.

### 4.3 ⚠️ `operation.input` is a **parameter map**, not a binding map

This is the single most common silent failure.

```jsonc
// ✅ operation.input — values are PARAMETERS, so the wiring goes under `binding`
"operation": {
  "kind": "function",
  "function": "claude-code",
  "input": { "prompt": { "kind": "text", "binding": { "input": "instruction" } } }
}

// ✅ children.<key>.inputs — values are BARE BINDINGS
"children": {
  "critique": { "state": "…/critique", "inputs": { "plan_doc": { "child": "context", "output": "plan_doc" } } }
}
```

Write `"input": { "prompt": { "input": "instruction" } }` and the loader sees a
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
  "input":  { "prompt": { "kind": "text", "binding": { "input": "instruction" } } },
  "output": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "text/markdown" } }
}
```

Declare it `json` instead and the returned string is read as a record of named
outputs, finds nothing, and the state fails with **"function operation did not
produce required output 'report'"**. A blob output fills **exactly one** produced
slot; declaring two is an error.

---

## 5. `environment`

How the operation runs, as opposed to what it is. Kept a sibling of `operation`
because it is not part of the operation's identity.

```jsonc
"environment": {
  "session": "review",
  "tools": ["bash"],
  "conversation": { "mode": "summary" },
  "permissions": { "default": "ask", "tools": { "bash": "smart" } }
}
```

- **`session`** — the logical session owning the conversation transcript,
  workspace and permissions. States sharing an id share a conversation. Absent ⇒
  the run's default session (`"default"`).
- **`tools`** — logical tool names the operation may call mid-loop, resolved
  through `registry.tools`. JaiRA registers `bash`. **Listing a tool here is what
  puts an agent's commands under the policy at all.**
- **`conversation.mode`** — `full_history` | `summary` | `fresh` |
  `selected_artifacts` (the last takes `artifacts: [names]`).
  ⚠️ `summary` is **per session, not per state**: one session has one transcript,
  so a session mixing `summary` and `full_history` is summarized for both. The
  lint surface warns.
- **`permissions`** — the definition-authored baseline, beneath the project
  policy.

---

## 6. `children` and `sequence`

```jsonc
"children": {
  "goals":   { "state": "feature/plan/goals",   "inputs": { "issue": { "input": "issue" } } },
  "context": { "state": "feature/plan/context", "inputs": { "goals": { "child": "goals", "output": "goals" } } },
  "lint":    { "state": "feature/plan/lint",    "async": true }
},
"sequence": ["goals", "context", "critique"]
```

- `state` is the child's **full state id**, not a relative path.
- `inputs` values are **bare bindings** (§8) — no `binding:` wrapper here.
- `async: true` means starting this child does not block the sequence.

### ⚠️ A `sequence` is a cursor, not a barrier

It is the order the engine *advances* through, not a set of gates. Independent
children park and run **concurrently**; ordering is driven by **dataflow**. To
force `b` to run after `a`, wire one of `a`'s outputs into `b` — listing them in
`sequence` alone does not do it. A child whose input reads a still-running
producer parks on `PENDING` until that producer completes.

---

## 7. `transitions` and `limits`

```jsonc
"transitions": [
  { "to": "terminate.success", "when": "children.critique.outputs.outcome === 'clean'" },
  { "to": "goals",             "when": "children.critique.outputs.outcome === 'needs_changes' && run.iteration < limits.max_iterations" },
  { "to": "terminate.success", "when": "children.critique.outcome === 'success'" }
],
"limits": { "max_iterations": 3, "timeout": 600 }
```

- `to` is a **declared child key** or one of `terminate.success`,
  `terminate.error`, `terminate.canceled`, `terminate.timeout`.
- `when` is a guard expression; absent means unconditional. Evaluated **in order,
  first match wins**. A guard that evaluates to `PENDING` (it reads a child still
  running) is **skipped this round** and retried — it does not fail and does not
  fall through to a later transition permanently.
- `limits.timeout` is **seconds**, and exceeding it terminates the state
  `terminate.timeout`.

### ⚠️ Guards must infer to `boolean` — strictly

There is no truthiness coercion. `"when": "outputs.goals"` is a **lint error**,
not a non-empty check. Write `"outputs.goals.length > 0"`.

### ⚠️ An unconditional transition fires immediately

`{ "to": "terminate.success" }` with no guard runs as soon as the state is
evaluated — before any child has produced anything, so a parent whose outputs
read `children.x.outputs.y` then fails with *"child 'x' has not run"*. Guard on
the child you are waiting for: `"children.x.outcome === 'success'"`.

### Re-entering a child

A transition back to a child key starts a **fresh instance** of it and clears the
sequence's later children (a *sequence reset*, recorded as `child.superseded`).
`run.iteration` counts the transitions this instance has taken.

---

## 8. Binding forms

Everywhere a value is wired, one of these appears — under `binding:` in a
parameter (§3, §4.3), or bare in `children.<key>.inputs` (§6).

| Form | Meaning |
| --- | --- |
| `{ "text": "hello" }` | A literal string |
| `{ "json": { "a": 1 } }` | A literal JSON value |
| `{ "input": "issue" }` | This state's declared input, by name |
| `{ "child": "context", "output": "plan_doc" }` | One output of a declared child |
| `{ "child": "critique" }` | A child's whole output object |
| `{ "expr": "children.a.outputs.n + 1" }` | A small computation (§9) |
| `{ "artifact": "name" }` | A session-owned artifact by name |
| `{ "conversation": "review", "message": 0 }` | A transcript, or one message of it |

There are no bare-string references. SPEC's old
`"plan_doc": "children.context.outputs.plan_doc"` is
`{ "child": "context", "output": "plan_doc" }`, and its old
`{ "value": "significant" }` literal is `{ "text": "significant" }`.

---

## 9. Expressions

Used in transition guards and `{ "expr": … }` bindings.

**Namespaces:**

| Namespace | Available in | Contents |
| --- | --- | --- |
| `inputs.*` | both | this instance's resolved inputs |
| `outputs.*` | both | outputs produced so far |
| `children.<key>.outputs.*` | both | a child's outputs |
| `children.<key>.outcome` | both | `success` \| `error` \| `canceled` \| `timeout` |
| `artifacts.*` | both | artifacts registered this run |
| `conversations.*` | both | transcripts by session id |
| `run.iteration` | guards only | transitions taken by this instance |
| `limits.*` | guards only | this state's declared limits |

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

⚠️ **Artifacts are in-memory only today.** Nothing is written to disk;
`config.artifactDir` is parsed and unused. Content travels inline in the event
journal, so a large artifact bloats the database, and there is no content hash and
no artifact viewer.

DESIGN §7.6 settles how it *should* work — placement becomes configurable
(`virtual` / `as-written` / `central-relative` / `central`, rooted at the task
worktree or `.jaira/`), and JaiRA registers the agent's `write_file`/`read_file`
tools so it controls where bytes land while the agent keeps seeing its own path.
None of that is built yet; TODO.md has the list.

---

## 11. Validation

`jaira workflow lint` (and every task start) runs three checks beyond "the JSON
parses":

1. **Binding compatibility** — a producer's output schema must be a subschema of
   the consuming slot's schema.
2. **Expression typing** — every guard and `{ expr }` leaf is inferred; a guard
   that is not boolean is an error, and a declared schema on an expr leaf is
   checked against the inferred type.
3. **Reachability** — referencing a producer that is not provably run on every
   path to its use is an **error**. A declared `default` is the explicit opt-out.
   This is why `T | undefined` never propagates silently.

Errors block a task start; warnings do not. `jaira workflow lint` additionally
runs in `strict` mode, where an unregistered `functionRef` is an error — the
pre-run gate deliberately does not, because a state a run never enters never needs
its function.

---

## 12. A complete example

The SPEC §9 planning workflow, shipped as JaiRA's starter (`specPlanningFiles()`
in `@jaira/runtime`).

**`feature/plan.json`** — a pure composite: children, a sequence, and a re-plan
loop.

```jsonc
{
  "label": "Planning",
  "inputs": { "issue": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "markdown" } } },
  "outputs": {
    "outcome": {
      "schema": { "type": "string", "enum": ["complete", "blocked"] },
      "binding": { "expr": "children.critique.outputs.outcome === 'clean' ? 'complete' : 'blocked'" }
    },
    "plan_doc": { "binding": { "child": "context", "output": "plan_doc" } }
  },
  "children": {
    "goals":   { "state": "feature/plan/goals",   "inputs": { "issue": { "input": "issue" } } },
    "context": { "state": "feature/plan/context", "inputs": { "issue": { "input": "issue" }, "goals": { "child": "goals", "output": "goals" } } },
    "critique": {
      "state": "feature/plan/critique",
      "inputs": { "plan_doc": { "child": "context", "output": "plan_doc" }, "severity_threshold": { "text": "significant" } }
    }
  },
  "sequence": ["goals", "context", "critique"],
  "transitions": [
    { "to": "terminate.success", "when": "children.critique.outputs.outcome === 'clean'" },
    { "to": "goals", "when": "children.critique.outputs.outcome === 'needs_changes' && run.iteration < limits.max_iterations" },
    { "to": "terminate.success", "when": "children.critique.outcome === 'success'" }
  ],
  "limits": { "max_iterations": 3 }
}
```

**`feature/plan/goals.json`** — a prompt state.

```jsonc
{
  "label": "Goals",
  "inputs":  { "issue": { "kind": "blob", "schema": { "type": "string", "contentMediaType": "markdown" } } },
  "outputs": { "goals": { "schema": { "type": "array", "items": { "type": "string" } } } },
  "operation": {
    "kind": "prompt",
    "prompt": { "template": "Extract goals from {{inputs.issue}}." },
    "config": { "model": "anthropic/claude-sonnet-5" }
  }
}
```

**`feature/plan/critique/human_review.json`** — a UI gate, which is just a
function state.

```jsonc
{
  "label": "Human Review",
  "outputs": { "decision": { "schema": { "type": "string", "enum": ["approve", "request_changes", "block"] } } },
  "operation": {
    "kind": "function",
    "function": "choose_option",
    "config": {
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
3. A guard must infer to boolean — `"when": "outputs.x"` is an error, not a
   truthiness test.
4. An unguarded `terminate.success` fires before children run.
5. `sequence` orders the cursor, not execution — wire outputs to serialize.
6. Models must be route-prefixed (`anthropic/claude-sonnet-5`).
7. `contentMediaType` is what makes a slot an artifact; there is no
   `"type": "artifact"`.
8. `environment.tools` is what subjects an agent's commands to the policy.
9. A `generic-cli` state is refused outright unless `policy.builtins` is `false`.
10. `prompt.skill` parses and lints, but no skill registry exists yet — it fails at
    run time.
