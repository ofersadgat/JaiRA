---
id: ui/components/fill-form-gate
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask, ux/patterns/schema-driven-form]
serves: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface, ui/components/schema-form, ui/components/switch]
implemented_by: [packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/components.e2e.test.ts, packages/app/test/schemaFormModel.test.ts]
mockups: [ui/assets/fill-form-gate/blocked.html, ui/assets/fill-form-gate/ready.html, ui/assets/fill-form-gate/settled.html]
siblings: [ui/components/choose-option-gate, ui/components/edit-artifact-gate, ui/components/question-stepper]
---

# Fill form gate

A process's request for a few typed values: the prompt with a ruled-sheet glyph, one row per field with its label on the left and its box on a right-hand rail, a switch before each optional field, and a blue `Submit` with the first problem written beside it while it is disabled.

## A fill form gate is for several typed answers sent together

**Use when.** A state of a process stops for a person to give values of declared kinds, such as a title, a severity and an estimate, or to confirm or overrule readings a draft took, and each value lands on its field's name.

**Do not use when.** The answer is a pick among a few named options: use [choose-option-gate](choose-option-gate.md), whose steps also ask several small questions in turn. The answer is a whole document: use [edit-artifact-gate](edit-artifact-gate.md). Values are gathered before work starts or kept as settings: that is [schema-form](schema-form.md) on its own.

## The fields read first, and Submit says what still blocks it

- **Heading.** Drawn by [gate-surface](gate-surface.md) with the ruled-sheet glyph; `Fill in the form` when the state gives no prompt.
- **Fields.** The [schema-form](schema-form.md) rows with no configuration paths shown. A required field has a red `*` after its label; an optional one has a [switch](switch.md) before it. The type hint follows in the data face, and the field's description sits under the label in `--dim`. The control sits on the rail: a text box, a box in the data face that offers an enum's values as the person types, a number box up to 120px wide, a checkbox with `yes` or `no`, or for a multiline field a four-row box across the full width once switched on.
- **Submit.** A row 14px under the fields: a primary `Submit`, then, while it is disabled, the reason in `--dim` at 11/12.5 of the app size on the same line.

## Submit is disabled until the whole form passes the check

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a form must name at least one field, and one that names none shows the invalid configuration line of [gate-surface](gate-surface.md). | |
| loading | Cannot occur as its own look: until the first check answers, the form is drawn as blocked with `checking…` beside `Submit`. | |
| blocked | A field fails the check: `Submit` at half opacity with the first problem beside it, led by the count when there are several. A field the person has typed in shows its problem in `--bad` under the box, and the box's border turns `--bad`; an untouched field shows none. Required text starts empty, an optional field without a default starts switched off over `not set — left out of the answer`, and while a new check runs after typing `Submit` stays disabled with nothing beside it. | [blocked.html](../assets/fill-form-gate/blocked.html) |
| ready | Every field passes: `Submit` filled blue with nothing beside it. A form whose fields all carry defaults opens this way, each switched on and filled. | [ready.html](../assets/fill-form-gate/ready.html) |
| settled | The same rows holding what was sent, the boxes at 55% opacity and the switches inert, with no `Submit`. An optional field that was not sent is switched off over `not answered`, even when it has a default. | [settled.html](../assets/fill-form-gate/settled.html) |
| error | The configuration does not parse, or an answer is refused: drawn by [gate-surface](gate-surface.md) and the window's error notice. A check that cannot be run blocks `Submit` with `could not be checked: {reason}`. | |

## Typing is checked as it goes, and Submit sends only what is set

| On | Does | Feedback |
| --- | --- | --- |
| Type in a field | Changes that value; the form is checked a moment after typing pauses | The field's problem appears or clears under it, and the reason beside `Submit` follows |
| Switch an optional field on | Puts it in the answer, starting from its default or an empty value | The control replaces the dashed note |
| Switch it off | Leaves it out of the answer | The dashed note returns |
| Pick from a choice box's list | Fills the box with that value | As typing |
| `Submit` | Sends one record of every field that is set, keyed by field name | The gate settles in place |

## The copy is the author's fields, and the gate's own words say what is missing

| Where | String |
| --- | --- |
| Heading | `{prompt}`, or `Fill in the form` |
| Label | `{label}`, or the field's name as lower-case words, such as `notes` |
| Under the label | `{description}` |
| Type hint | `at least 1 character` · `minor / significant / critical` · `one of {n}` · `suggestions · any text` · `number` · `yes / no` |
| Required mark and tooltip | `*` · `required` |
| Switch tooltip | `set {name}` · `leave {name} out` |
| Unset field | `not set — left out of the answer` · settled: `not answered` |
| Checkbox | `yes` · `no` |
| Button | `Submit` |
| Beside Submit | `checking…` · `{field}: {problem}` · `{n} problems — {field}: {problem}` · `could not be checked: {reason}` |
| Problems | `can't be empty` · `must be one of: {values}` · `enter a number` · `'{text}' is not a number` |

## The rows stack in a narrow host, and half-made answers are lost when the task is left

- It spans its host. Each row is a label column and a control rail of 140px to 15rem; where the form is 380px wide or less, as in the 360px context panel, every row stacks its control under its label.
- The reason beside `Submit` stays on one line and drops under the button when the row is too narrow. `Submit` carries the same words as its tooltip.
- Leaving the task loses everything typed; the form opens again on its defaults.
- Theme: every colour is a token; problems stay `--bad` in both themes.
- Focus: Tab moves row by row through each switch and control, then `Submit` once it is enabled.
- Missing content: without a label the field's name stands in, and without a description there is no line under the label.

## The settled form departs from the type registers

- A sent value is quietened by 55% opacity on its box, where the direction reserves quietening for `--tok-hint`.
