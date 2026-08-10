---
id: engineering/contracts/gate-components
type: engineering-contract
status: proposed
updated: 2026-08-05
visibility: public
kind: api
owned_by: [engineering/units/interaction-hub]
consumers: ["every workflow state with a UI gate", "@jaira/app renderer", "--interactions scripting"]
since: proposed — extends the five shipped components (DESIGN §1f)
---

# Gate components

The five built-in UI components a `FunctionOp` can name, and what each returns.
A gate's result lands directly on the state's declared outputs, with no adapter
in between, so **the result shape is the contract**.

## Use when

A run needs a human decision before it can continue.

## Don't use when

The decision is derivable. If a host function can compute it — "did the tests
pass", "is the composite's score above its best parent" — it must, and
[WORKFLOW.md §0.6](../../../WORKFLOW.md) decides whether a person is asked at
all.

## Instead consider

| Situation | Use | Why |
| --- | --- | --- |
| The answer is arithmetic | a `function` state | A gate spends attention; arithmetic doesn't need it |
| The person should write, not approve | `edit_markdown` | Their words are faster than a revision round |

## Where this fits

- **Serves** — every phase's `gate` child.
- **Neighbors** — the interaction hub owns delivery; this owns shape.
- **Depends on / used by** — validated in the main process by
  `validateComponentResult`; authored config by `parseComponentConfig`.
- **History** — the five shipped in phase 4 (DESIGN §1f). This doc proposes two
  additions, recorded in
  [decision 0001](../decisions/0001-decision-brief-gates.md).

## Shape — shipped today

| Component | Returns |
| --- | --- |
| `choose_option` | `{ decision, comments? }` |
| `review_artifact` | `{ decision, comments? }` |
| `edit_markdown` | `{ content }` |
| `confirm_action` | `{ confirmed }` |
| `fill_form` | a flat object of its fields |

`fill_form` reads a JSON-Schema **subset**: `string` · `number` · `boolean` ·
`enum`, with `optional`, `default`, `multiline`. Not arbitrary schemas — that is
what a form can honestly render.

## Shape — proposed additions

Both are additive. No existing state file changes, and both result shapes stay
where they are.

### 1. Option objects on `choose_option`

`options` accepts objects as well as bare values:

| Field | Required | Meaning |
| --- | --- | --- |
| `value` | yes | What `decision` becomes. A bare string stays shorthand for `{value}`. |
| `label` | optional | Display text. Defaults to `value`. |
| `means` | optional | What happens next if this is chosen. |
| `pros` | optional | Array of strings. |
| `cons` | optional | Array of strings. |
| `drives` | optional | The criterion or finding that argues for it. |
| `recommended` | optional | At most one. Rendered with the confidence reasons beside it. |

Returns `{ decision, comments? }`, unchanged.

### 2. Multi-select

For decisions that are "which of these", not "which one" — which findings to
accept, which deliverables to keep, which candidate elements to carry forward.

Two ways, and the decision record picks one:

- **`enum` + `multiple: true`** in the `fill_form` subset, returning an array in
  that field. Smallest change; keeps one form component.
- **A sixth component, `select_many`**, returning `{ selected[], comments? }`.
  Clearer contract; one more component to build, validate, and script.

## Errors

| Condition | Response | Caller does |
| --- | --- | --- |
| Undeclared `decision` | Refused in the main process | Fix the state's options |
| Missing required field | Refused in the main process | Fix the form config |
| `choose_option` with no options | ERROR at parse time, not an empty dialog | Fix the state file |

Re-validation happens in main because the renderer is the untrusted side of the
IPC boundary; the engine's own output-schema check is a second, independent
gate.

## Compatibility

Additive in both directions. Bare-string options keep working; a
`multiple: true` field is ignored by nothing, because nothing reads it yet.
`--interactions` scripting keys on **function name**, so scripted answers are
unaffected.

**Until these land, gates degrade honestly**: option objects render as `enum`
values with pros and cons folded into the prompt text, and a multi-select
renders as one boolean per item. Worse to read, same decision, and no state file
changes when the components catch up.

## Traps

- A gate's outputs are ordinary state outputs. Renaming a result field is a
  workflow-wide breaking change, not a UI tweak.
- Declaring `kind: "function"` on a gate **drops inherited call settings** — do
  it, or the gate silently receives the subtree's `model`
  ([WORKFLOWS.md §5.2](../../../WORKFLOWS.md)).
- A `sequence` is a cursor, not a barrier: independent gates park at once. If
  two gates must be answered in order, wire one's output into the other.
