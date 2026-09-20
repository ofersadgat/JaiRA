---
id: ui/components/run-value-field
type: ui-component
status: shipped
updated: 2026-09-13
realizes: []
serves: [product/complete-record-of-every-run, product/failures-explain-themselves]
surfaces: [ui/surfaces/context-panel]
reuses: []
implemented_by: [packages/app/src/renderer/readValue.tsx, packages/app/src/renderer/reading.ts]
verified_by: [packages/app/test/configPanel.test.ts]
mockups: [ui/assets/run-value-field/empty.html, ui/assets/run-value-field/success.html, ui/assets/run-value-field/long.html]
siblings: [ui/components/value-view, ui/components/slot-table, ui/components/state-form]
---

# Run value field

Under a slot row, a child's wire or an operation in a state's configuration read against one run, an uppercase `VALUE` label in `--accent` over a grey box holding what that run actually put through it: text as written, anything else as indented JSON.

## A run value field answers what came through a row that says where it comes from

**Use when.** A form over a state is a reading of one execution, and the row has a recorded value for it: a declared input as the state received it, an output filled from the call's result by name, the input a child was called with, or the operation's whole result.

**Do not use when.** No run is behind the form, or the row has no recorded value: draw nothing, never an empty box. The value stands on its own with a choice of reading and a menu, such as a produced artifact: use [value-view](value-view.md).

## The accent label marks the one fact that came from the run, and the box holds it

- **Label.** `value` in the form's field-label style: uppercase, .04em tracking, the app face at ×0.88 of its base, in `--accent` where every other field label is `--dim`.
- **Box.** 4px under the label. `--panel-2` ground, 1px `--line` border, `--control-radius` corners, 6px by 9px padding, text at ×0.96 of the data size in `--text`. A string keeps its line breaks and wraps at the column's edge; a number, list or object is JSON indented two spaces.
- **Placement under a slot.** In the open block under the slot's row, indented 8px behind a 2px rule, sharing one line in equal widths with the slot's labelled `default` and `description` when those are set.
- **Placement under a wire.** Directly under the child's `slot ← binding` row, 2px below it.
- **Placement under the operation.** After the Operation inputs and Operation output tables, for the whole result the call returned.

An output derived from children never shows one, and neither does any row of the Operation inputs or Operation output tables, because the run records no value for them apart from the call.

## Every state is the box, the box scrolling, or nothing

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | No run is behind the form, or the row has none: nothing is drawn. A slot with no value, default or description also loses the block under its row, so the row stands alone. | [empty.html](../assets/run-value-field/empty.html) |
| loading | Cannot occur: recorded values arrive with the configuration they belong to, and the panel says `Reading the state…` until both are read. | |
| partial | Cannot occur: a value is drawn whole, and a long one scrolls inside its box. | |
| error | Cannot occur: a value that was never recorded is absent, which is the empty state. | |
| success | Text in the box as written, and a number, list or object as indented JSON. | [success.html](../assets/run-value-field/success.html) |
| long | The box grows with its content up to 260px and then scrolls inside itself, so a long document never pushes the rest of the form away. | [long.html](../assets/run-value-field/long.html) |

## The field takes no input beyond reading, selecting and scrolling

| On | Does | Feedback |
| --- | --- | --- |
| Drag across the text | Selects it for copying | The platform's selection highlight |
| Wheel over a box at its 260px limit | Scrolls the value inside the box | The box's own scrollbar moves |

## The copy is one label and the value itself

| Where | String |
| --- | --- |
| Label | `value`, drawn uppercase |
| Box, text | `{value}` exactly as recorded |
| Box, anything else | `{value}` as JSON indented two spaces, one entry to a line for a list or object, such as `0.72` |

## The box wraps to the column, scrolls past 260px, and is absent when there is nothing

- **Resize.** The box takes the width it is given and wraps at any character, so a long path or token never widens the panel. It never forces its row wider.
- **Theme.** Label, ground, border and text are tokens with a light and a dark value.
- **Focus.** The field takes no keys and holds no control.
- **Long or missing content.** Past 260px the box scrolls. A missing value draws nothing, and an empty string draws an empty box, because the run recorded it.

## The value departs from the visual direction in two places

- The value is data drawn in the app face at the data voice's size.
- The label uses the form's own uppercase field style in `--accent` rather than `.app-label`.
