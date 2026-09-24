---
id: ui/components/schema-form
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/schema-driven-form, ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place]
serves: [product/hand-work-to-agents, product/try-one-step-on-its-own, product/decisions-stay-yours, product/bring-your-own-models-and-agents, product/author-processes-without-memorising-the-format, product/try-a-process-without-spending]
surfaces: [ui/surfaces/new-task-popover, ui/surfaces/context-panel, ui/surfaces/files-view, ui/surfaces/gate-modal, ui/surfaces/run-conversation, ui/surfaces/settings-runs, ui/surfaces/settings-data, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-connections, ui/surfaces/components-view]
reuses: [ui/components/settings-field, ui/components/switch, ui/components/preset-chips, ui/components/llm-config-form]
implemented_by: [packages/app/src/renderer/schemaForm/SchemaForm.tsx, packages/app/src/renderer/schemaForm/model.ts, packages/app/src/renderer/schemaForm/check.ts, packages/app/src/renderer/schemaForm/presentation.ts, packages/app/src/renderer/schemaForm/registry.ts, packages/app/src/renderer/runPanel.tsx, packages/app/src/renderer/runForm.ts]
verified_by: [packages/app/test/schemaForm.test.ts, packages/app/test/schemaFormModel.test.ts, packages/app/test/runForm.test.ts, packages/app/test/schemaCheck.test.ts]
mockups: [ui/assets/schema-form/success.html, ui/assets/schema-form/error.html, ui/assets/schema-form/layered.html, ui/assets/schema-form/list.html, ui/assets/schema-form/reading.html]
siblings: [ui/components/settings-field, ui/components/fill-form-gate, ui/components/state-form, ui/components/schema-json-editor, ui/components/llm-config-form]
---

# Schema form

A single column of settings rows, each a bold label with a grey hint on the left and its control on a right-hand rail, where an optional value has a pill switch before its name and a dashed `not set` box in place of its control.

## Every typed value a person gives goes through this one form

**Use when.** Something declares the values it accepts as a JSON Schema and a person fills them in or reads them: a state's inputs in the inspector's Run section and the New task popover, the form a `fill_form` gate asks for, the Memoization and Workflow lookup settings and an executor's call steps, a JSON document or value read as a form, and a component's arguments in the component gallery. A value with a dedicated widget, such as call settings drawn by [llm-config-form](llm-config-form.md), is still reached through it.

**Do not use when.** The value is free text with no schema, such as a chat message. The person edits a state file's structure: [state-form](state-form.md) has tables built for wiring. The person wants the document as text: [schema-json-editor](schema-json-editor.md). A bespoke settings row with its own control, such as a provider's switch, is a [settings-field](settings-field.md) alone.

## Names and what they accept read first, then the values on the rail

- **Row.** Each member is a [settings-field](settings-field.md) row: label, then after it on the same line a red `*` for a required value, the accepted kind in the data face at 10/12 of its base in `--dim`, and shape chips when the value may take several shapes. Under the label, the schema's description in `--dim` ending in the member's dotted path in mono.
- **Label.** The schema's title, or the key turned into lower-case words. Where the names are the author's own, such as a state's inputs, the key itself in mono with no path.
- **Switch.** Before an optional member's name, the [switch](switch.md): on draws the control, off draws a dashed `--line` box in `.app-secondary` saying what not set means.
- **Controls.** Text in a plain box; a number or integer in a mono box at most 120px wide; a fixed set of values in a mono box that offers them as the person types; a yes or no as a checkbox with `yes` or `no` beside it; markdown or other long text in a four-line box; an untyped value as mono JSON; a constant as a dashed box naming what it sends.
- **Blocks.** An object, a list or a long-text member spans the row with its label above it. A nested object's fields sit behind a 2px `--line` rule 11px in.
- **Shape chips.** A joined well of small word buttons, the chosen shape filled with `--fill-accent`, choosing among `text`, `number`, `yes / no`, `object`, `list`, `none` or the branch's own title; a union with no row of its own puts them above its body.
- **List.** One bordered `--panel` card per item with `↑`, `↓` and `✕` in quiet buttons, then a ghost `+ add`. An item with fields inside opens and closes behind a `▸` or `▾` caret and its index in mono, reading closed as its first two values joined by ` · `.
- **Map.** A member whose keys are the author's: one row per key of a mono key box, its value and a quiet `✕`, then `+ add key`.

## The form says what each value is, whether it is set, and what is wrong with it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look of its own: a schema with no members draws no rows, and each host says so in its own words. | |
| loading | Not a look of its own: until the first check answers, a host with a send button keeps it disabled with `checking…` beside it. | |
| partial | Not a look of its own: some fields fail and others pass, drawn as the error state on the failing fields only. | |
| success | A form a gate asks for, in its modal placement: required fields starred, the accepted kind after each name, an optional field switched off reading `not set — left out of the answer`, a notes field on as a full-width box. | [success.html](../assets/schema-form/success.html) |
| error | Problems show only on a field the person has touched: its box border turns `--bad` and the message sits under the control in red. A list item holding a problem opens and its caret turns red and disabled. The host names the first problem beside its disabled button, drawn here in the 340px New task popover, where every row stacks. | [error.html](../assets/schema-form/error.html) |
| layered | A settings layer: the switch means set in this layer, an inherited value reads `not set here — inherits {value}`, and nothing is starred. A layer that cannot be edited, stacked below, keeps its whole shape with every box at 55% opacity and the switches, chips and buttons disabled. | [layered.html](../assets/schema-form/layered.html) |
| list | A component's arguments in the component gallery: closed items reading as their summary, one item open with its shape chips and fields, `+ add` under the list. | [list.html](../assets/schema-form/list.html) |
| reading | A document read as a form in the Files view: only the members it states, no switches, no kinds, no errors and no list controls, every item open, the boxes without ground or border, the paths hidden and the values at 55% opacity. | [reading.html](../assets/schema-form/reading.html) |

## Switches set and unset, chips pick a shape, and a checking host checks every edit

| On | Does | Feedback |
| --- | --- | --- |
| Switch on | Sets the value: the one it shows, an inherited one pinned as it stands, or a starting value of its kind, the declared default where there is one | The control replaces the dashed box |
| Switch off | Removes the key, or releases it to the layer beneath | The dashed box returns with what applies instead |
| A shape chip | Keeps the value if it fits the new shape, otherwise starts that shape afresh | The chip fills and the body swaps |
| Typing in a control | Writes the value and marks the field touched; where the host checks, the values go through the run's own rules a moment after typing pauses | A message appears or clears under the field |
| `+ add` or `+ add key` | Appends an item at the shape's starting value, or a key named `key`, `key2` and on | A new row, open |
| `↑`, `↓` or `✕` | Moves or removes an item; an open item stays open where it goes | The cards reorder |
| A map key, then Enter or leaving the box | Renames the key in place, refusing an empty or taken name; Escape puts the old name back | The key box shows the name that holds |
| `▸` or `▾` | Opens or closes an item | The fields or the summary line |

A settings layer writes each change at its own path as it is made. A form a host submits sends only what is set.

## The copy says what not set means and what a value must be

| Where | String |
| --- | --- |
| Switch, tooltip and spoken name | `set {name}` · `leave {name} out` · `set {name} here` · `{name} is set here — switch off to inherit it` |
| Not set | `not set` · `not set — the default applies: {default}` · `not set here — inherits {value}` · a host's own, such as `not set — left out of the answer` or `not answered` |
| Required | `*`, tooltip `required` |
| Accepted kind | `text` · `number` · `integer` · `yes / no` · `list` · `{a} / {b} / {c}` · `one of {n}` · `suggestions · any text` · `keys → {kind}` · `{low} to {high}` · `at least {n}` · `at most {n}` · `at least {n} characters` · `{media type}`, parts joined by ` · ` |
| Constant | `sends {value}` · `sends null` |
| Yes or no | `yes` · `no` |
| List | `+ add` · `[{i}]` · tooltips `move up` · `move down` · `remove` · `open this row` · `close this row` · `this row has a problem in it` |
| Closed summary | `{first value} · {second value}` · `{n} fields` · `{n} items` · `empty` · `none` · `not set` |
| Map | `+ add key` · tooltip `remove {key}` · key box spoken name `key` |
| Shape chips | spoken name `shape`; a repeated word numbered, such as `text 2` |
| Field messages | `required` · `can't be empty` · `must be at least {n} characters` · `must be at most {n}` · `enter a number` · `'{text}' is not a number` · `must be a whole number` · `must be one of: {values}` · `must match {pattern}` · `needs at least one item` · `items {i} and {j} are the same` · `isn't allowed here` · `matches more than one shape` · `doesn't match the chosen shape` |
| Checker failures | `this schema can't be checked: {error}` · `could not be checked: {message}` |
| Host summary | `checking…` · `{n} problems — {path}: {message}` · `{path}: {message}` |
| Renamed members | `attempts after a retriable failure` for a retry's transient attempts · `raise concurrency after` for a rate limit's increase |
| Run inputs wired elsewhere | `bound to {binding}` · `a spread — republished from a child`, listed above the form with no control |

## The rows stack in a narrow box and long text wraps under its label

- Resize: each form measures its own box, not the window. Wider than 380px, a row is the statement and a rail of 140px to 15rem; narrower, the control drops under the statement. A nested form stacks sooner.
- Theme: every ground, rule and colour is a token; not set is carried by the dashed box and its words as well as by the switch.
- Focus order: per row, the switch, the shape chips, then the control. An item with fields puts its caret and `↑`, `↓`, `✕` before its fields; a one-line item puts them after its box. `+ add` closes the list.
- Long content: hints wrap at 1.4 line height; the path at the end of a hint ellipsises; accepted kinds and messages wrap anywhere. A closed list item's summary ellipsises.
- Missing content: a member with no description has no hint line. A schema that refers back to itself draws the repeated part once and stops.

## The form's chrome is sized outside the type registers

- Labels, hints, paths and kinds use their own ratios of the base sizes and a 550 label weight rather than the ten register classes.
- A locked layer and a disabled box are dimmed with 55% opacity.
