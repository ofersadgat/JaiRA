---
id: ui/components/state-form
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/pick-from-what-exists, ux/patterns/problems-marked-where-they-are, ux/patterns/absence-is-stated, ux/patterns/fold-to-a-summary-expand-in-place]
serves: [product/author-processes-without-memorising-the-format, product/repeatable-agent-processes, product/catch-process-mistakes-before-running, product/complete-record-of-every-run]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: [ui/components/slot-table, ui/components/operation-fields-editor, ui/components/file-link-field, ui/components/issue-mark, ui/components/run-value-field, ui/components/value-view]
implemented_by: [packages/app/src/renderer/stateEditor.tsx, packages/app/src/renderer/stateForm.ts, packages/app/src/renderer/completions.ts]
verified_by: [packages/app/test/stateForm.test.ts, packages/app/test/childBindings.test.ts, packages/app/test/configPanel.test.ts]
mockups: [ui/assets/state-form/empty.html, ui/assets/state-form/success.html, ui/assets/state-form/composite.html, ui/assets/state-form/partial.html, ui/assets/state-form/error.html, ui/assets/state-form/reading.html]
siblings: [ui/components/schema-form, ui/components/schema-json-editor, ui/components/state-graph, ui/components/state-inspector]
---

# State form

A scrolling column of ruled blocks for one workflow state: Label and Description beside right-aligned labels, then Inputs, Outputs, Operation, Children, Transitions, Environment and Limits, each opened by an uppercase heading with a dim note and a small `+ Add` at its far end.

## The state form edits one state's fields as controls and shows what it cannot edit as written

**Use when.** One state is authored or read field by field: the Form tab of the [workflow-editor](workflow-editor.md), in the Files view, in a state's configuration pinned beside a graph, and in the configuration a run resolved against.

**Do not use when.** The value is richer than a plain field: a computed binding, a reference with sibling keys, or a transition declared on one mount. The form keeps those exactly as written and they are edited as text in the [schema-json-editor](schema-json-editor.md). Values are given to a run or a setting: use [schema-form](schema-form.md). The question is what runs after what: use [state-graph](state-graph.md).

## The blocks run in the order a state is read: what it takes, gives, does, delegates, where next, then its defaults

Blocks are 8px apart. Each starts with a 1px `--line` rule and 8px of space, a heading at ×0.88 of the app size, weight 600, uppercase with .09em tracking, its name in `--text` and its note in sentence case `--dim` at the far right beside the block's button. Contents sit 11px in.

1. **Identity.** `Label` and `Description` with 78px right-aligned uppercase labels beside their boxes, 5px apart. Description is two rows tall.
2. **Inputs** and **Outputs.** Two [slot-table](slot-table.md) blocks. The Outputs binding heading says what an empty box means: `the component's answer lands here by name` for a function, `unbound — say where the value comes from` otherwise.
3. **Operation.** `Kind` stacked over a select. A linked kind shows a mono reference box, a `--dim` note and a preview of the file. A prompt, function or inherited kind shows the [operation-fields-editor](operation-fields-editor.md). `none` shows nothing more.
4. **Children.** One card per mounted child in run order: `--panel-2` ground, 1px `--line` border, 6px radius, 6px apart. The card's first line holds the run-order number in mono `--dim` tabular figures centred in 22px, the key box, the state box followed by `→ {state id}` in `--dim` mono when the box does not already say it, `spine` and `async` checkboxes, `↑` `↓` and `✕`. Under it, behind a 2px rule, the child's `INPUTS` wiring: `slot ← binding` rows with `+ Wire` and `✕`. Last, a fold `▸ environment · defaults for this mount only` holding a kind select, a function box, a model box and a note.
5. **Transitions.** `guard → target` rows with `↑` `↓` and `✕`; the guard box takes the wider share.
6. **Environment.** A `kind:` select and `Remove` in the heading once declared, then the operation fields for that layer; the kind narrows them, so `kind: function` offers no Prompt or Model.
7. **Limits.** `Max iterations` and `Timeout` side by side.
8. **Footnote.** A `--dim` paragraph on what the form edits and what stays on the JSON tab.

Every binding and guard box offers the paths this state can read as the person types; a guard also offers the operation's outcome and the run's counters. A key box offers the unused states one level below this one, and a state box offers those and every other state.

## Every state is the same blocks, each full, empty with a sentence, held as written, or marked

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A new state: empty boxes with their placeholders, `none declared` under both slot tables, `Kind` at `none — groups its children`, and one `--dim` sentence per empty block saying what its absence means. | [empty.html](../assets/state-form/empty.html) |
| loading | Cannot occur as a look of its own: the form draws from the document in hand. What a child declares arrives a moment later and adds a blank wiring row for each required input it names. | |
| success | A state with an operation: identity, both slot tables, the operation's fields, and the `none` sentences under Children, Transitions and Environment. | [success.html](../assets/state-form/success.html) |
| composite | A state with no operation of its own: its children as cards with their wiring and folds, transitions, and a limit. | [composite.html](../assets/state-form/composite.html) |
| partial | What the form keeps as written is shown and refuses typing: a structured wire or a guard held as an object is a dimmed box of its JSON; a linked operation is a reference box with its note. | [partial.html](../assets/state-form/partial.html) |
| error | A required child input nobody has wired yet is a row already, both boxes outlined in `--warn`, with `required — nothing runs until this is bound` as the placeholder. A problem the checker reports marks the exact box in a 2px `--bad` or `--warn` border, puts the message on its row's tooltip, and turns an amber wiring row red. A function naming an executor that is turned off gets a `--warn` line under the operation. | [error.html](../assets/state-form/error.html) |
| reading | The configuration a run resolved against: no `+ Add`, `+ Wire`, `Remove`, `↑` `↓`, `✕` or footnote; boxes lose their borders; empty Label, Description, Environment and Limits are left out, and so is `Kind` when it is inherited; spine and async read `in the sequence` and `async` only when true. The `none` sentences under Children and Transitions stay. | [reading.html](../assets/state-form/reading.html) |

Going to a problem from the inspector switches to the Form tab, opens any fold hiding the box, scrolls it to the middle and washes it in `--accent` for one second.

## Each control edits one part of the state, and order controls change what runs first

| On | Does | Feedback |
| --- | --- | --- |
| Type in Label or Description | Writes it; blank removes it | The editor's `unsaved changes` |
| Choose a Kind | Switches the operation; `none` removes it; a linked kind keeps the old block until a reference is typed | The block below redraws |
| `+ Add` under Children | Adds an empty child in the sequence | A new card |
| Type a key or a state | Names the mount; a blank state means the state of that key one level below this one | `→ {state id}` updates, and a blank row appears for each required input the child declares |
| Tick `spine` | Puts the child in the sequence, or leaves it to be reached only by a transition | The tick |
| Tick `async` | Starts the child without holding the sequence | The tick |
| `↑` or `↓` | Moves the child or transition one place; the first and last rows have that arrow dimmed | The card or row moves |
| `+ Wire` | Adds an empty wire; a wire with a blank value is not written | A new row |
| Fill an amber wiring row | Wires the required input | The amber border goes |
| `+ Add` under Transitions | Adds an empty rule; a rule with no target is not written, and an empty guard always matches | A new row |
| `+ Add` or `Remove` under Environment | Declares an empty defaults layer or removes it | The fields appear or go |
| Type in Max iterations or Timeout | Writes a number once it is one; blank removes it | The editor's `unsaved changes` |
| `✕` | Removes that child, wire or transition | The row goes |

## The copy says what each block is and what an empty one means

| Where | String |
| --- | --- |
| Identity | `Label` · placeholder `a short name — what the board shows` · `Description` · placeholder `an author's note — also useful prompt context` |
| Headings | `Operation` · `Children` · `Transitions` · `Environment` · `Limits`, drawn uppercase |
| Notes | Operation `what this state does when the cursor is on it` · Children `in run order` when there are two or more · Transitions `first match wins` when there are two or more · Environment `defaults for this state and every descendant` · Limits `how far this state may go before it is stopped` |
| Kind | `none — groups its children` · `prompt — one model call` · `function — host code, a gate, or an agent` · `inherited — whatever the environment chain says` · `linked — a block held in another file` |
| Linked operation | placeholder `$/lib/review.operation` · `spliced in whole; sibling keys would override it, and those stay on the JSON tab` |
| Turned off | `{function} is turned off in this project, so it is not registered` |
| Empty blocks | Children `none — this state runs its own operation and nothing below it` · Transitions `none — the state terminates when its children are done` · Environment `none — this state adds no defaults to what it inherits` · wiring `none — the child's inputs must all be optional or defaulted, or it cannot run` |
| Child row | placeholders `key` · `./{key}` or `state id (defaults to the key)` · `→ {state id}` with tooltip `this mount runs the state '{state id}'` · `spine` · `async` · reading `in the sequence` · `async` |
| Child tooltips | spine `in the sequence: the cursor walks into it. Off means it runs only if a transition names it.` · async `SPEC §10.4: starting this child does not block the sequence` · `move up` · `move down` · `remove` |
| Wiring | `Inputs` · `wired into the child's declared slots` · `+ Wire` · placeholders `the child's input` · `.inputs.issue` · `required — nothing runs until this is bound` · tooltip `a referenced value — edit it on the JSON tab` |
| Mount environment | `environment` · ` · defaults for this mount only` · `kind…` · `prompt` · `function` · placeholders `function — e.g. claude-code on one mount, codex-cli on another` · `model` · `anything else on this mount's environment is kept as written — edit it on the JSON tab` |
| Transitions | placeholders `guard — empty is unconditional, and must infer to boolean` · `child key or terminate.success` · tooltip `a lowered guard — edit it on the JSON tab` |
| Environment | `kind: inherited` · `kind: prompt` · `kind: function` · `+ Add` · `Remove` |
| Limits | `Max iterations` · placeholder `guard value: limits.max_iterations` · `Timeout` · placeholder `seconds — then terminate.timeout` |
| Footnote | `A plain reference is editable here — 🔗 links a value to a file and unlinking gives back what was inline. Anything richer than that (a reference with sibling overrides, a computed binding) is kept exactly as written and shown read-only; edit those on the JSON tab.` |

## The form scrolls under a fixed Save row, holds its rows by proportion, and keeps typing in place

- **Resize.** The form is the scroller inside its editor, so the Save row below it never moves. Rows share the width by proportion; a mount's `→ {state id}` gives way first and ends in an ellipsis. The pinned configuration beside a graph keeps the form at least 460px wide and scrolls sideways below that.
- **Theme.** Rules, card grounds, borders, issue colours and the arrival wash are tokens.
- **Focus.** Tab runs down the blocks in order and along each row; a card's wiring and its environment fold come after its first line.
- **Long or missing content.** Boxes scroll long text in place; textareas resize vertically and in a reading grow to their text. A block with nothing in it says what that means in one `--dim` sentence rather than standing blank.
- **Unsaved work.** Every edit rewrites the state's text as the workflow editor's unsaved edit. A seeded wiring row is a placeholder and writes nothing until a value is typed, so opening a state never marks it unsaved.

## The form departs from the visual direction in four places

- Keys, state ids, bindings, guards and model ids are data typed in the app face.
- Headings and field labels are uppercase styles of their own rather than `.app-label`.
- The run-order number and a mount's state id use raw data sizes rather than `.data-num` and `.data-faint`.
- A child is a bordered card with its own ground inside a ruled block.
