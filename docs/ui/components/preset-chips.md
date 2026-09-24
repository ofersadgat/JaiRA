---
id: ui/components/preset-chips
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/schema-driven-form]
serves: []
surfaces: [ui/surfaces/settings-data, ui/surfaces/settings-appearance, ui/surfaces/settings-models, ui/surfaces/new-task-popover, ui/surfaces/context-panel, ui/surfaces/run-conversation]
reuses: []
implemented_by: [packages/app/src/renderer/controls.tsx, packages/app/src/renderer/schemaForm/SchemaForm.tsx, packages/app/src/renderer/configPane.tsx, packages/app/src/renderer/editorKnobs.tsx]
verified_by: [packages/app/test/schemaForm.test.ts, packages/app/test/schemaFormModel.test.ts]
mockups: [ui/assets/preset-chips/chosen.html, ui/assets/preset-chips/shape.html, ui/assets/preset-chips/disabled.html]
siblings: [ui/components/switch, ui/components/size-stepper, ui/components/segmented-control, ui/components/schema-form, ui/components/composer-setting-chip]
---

# Preset chips

A short row of borderless words in bold sans, all `--dim` but one, which is a filled `--fill-accent` pill with white text.

## Preset chips pick one of a few named answers

**Use when.** A value is one of two to four answers a person recognises by name: where produced files land, a tab width of 2, 4 or 8, or which shape a value takes in a form generated from a schema, such as `path`, `path + line` or `none`.

**Do not use when.** The setting is on or off: use [switch](switch.md). The value is a size with a range: use [size-stepper](size-stepper.md). Two readings of the same thing switch the view rather than set a value: use [segmented-control](segmented-control.md). A message's model, effort or permissions are chosen in the composer: use [composer-setting-chip](composer-setting-chip.md).

## The filled chip reads first and the others read as a list of alternatives

- **Chip.** App face at 11.5/12.5 of the app size, weight 600, 3px by 11px inset, `--control-radius-sm` corners, a transparent border and no ground, in `--dim`.
- **Chosen.** `--fill-accent` ground and border, `--on-accent` text and the `--sheen` highlight.
- **Row.** 6px apart, wrapping onto a second line when narrow. On its own line under a setting's statement, or before a switch row's label as the Tab width chips are.
- **Shape well.** In a schema form the chips follow the field's name on the same line, inside a well with a 1px `--line` border, `--control-radius` corners and a `--bg` ground, 1px apart. Each chip there is 18px tall with 8px sides at 10.5/12.5 of the app size and 5px corners.

## The chips differ only in which one is filled

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a row always names its presets, and a value with one possible shape draws no chips. | |
| loading | Cannot occur: the chips are fixed words and the value arrives with the form. | |
| partial | Cannot occur: every preset is drawn. | |
| error | Cannot occur on the chips: a value a form refuses is reported under the field's control. | |
| chosen | The preset matching the value in force is filled. In a layered settings pane that is the effective value, whether this layer states it or inherits it. | [chosen.html](../assets/preset-chips/chosen.html) |
| none chosen | The value in force matches no preset, such as an artifact destination written as a template of one's own: every chip is unfilled and the box under them holds the value. | [chosen.html](../assets/preset-chips/chosen.html) |
| shape | The chips inside their well after a field's name, with the chosen shape's control under the field. Drawn only while an optional field is switched on, and never in a form that only shows a value. | [shape.html](../assets/preset-chips/shape.html) |
| disabled | A layer that cannot be written, or the app carrying out an action: every chip at 50% opacity, the chosen one keeping its fill. | [disabled.html](../assets/preset-chips/disabled.html) |

## A click fills the chip and sets the value at once

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over an unfilled chip | Nothing | Ground `--fill-ghost-hover`, text `--text` |
| Click a preset | Sets the value to that preset and writes it | The fill moves to that chip; a template box under the row shows the preset's value |
| Click a shape | Keeps the value when it already fits that shape, otherwise starts the shape's own default | The fill moves and the control under the field changes to that shape's |
| Typing a value of one's own in the box under a preset row | Sets the value | The fill leaves the chips once no preset matches |

## The copy is the preset's name and a tooltip saying what it means

| Where | String |
| --- | --- |
| Artifact destination | `the workspace` · `one directory per task` · `one flat directory` · `memory only` |
| Destination tooltips | `beside the code the run is working on` · `outside the repo, grouped by task` · `outside the repo, filenames derived` · `recorded, but nothing is written to disk` |
| Tab width | `2` · `4` · `8`, then `Tab width` and `columns` |
| Shape | `{title}`, else `{const as JSON}`, else `text` · `number` · `integer` · `yes / no` · `object` · `list` · `choice` · `none` · `any`; `{label} {n}` when two shapes would read the same, such as `object 1` · `object 2` |
| Shape well, for a screen reader | `shape` |
| A shape with nothing to fill, under the field | `sends null` · `sends {const as JSON}` |

## The row wraps rather than scrolls and keeps the chosen chip's fill in both themes

- Resize: the row and the shape well wrap onto further lines; no chip shrinks or cuts its word.
- Theme: `--fill-accent` and `--on-accent` are tuned per theme so the white text keeps its contrast.
- Focus: every chip is a native button in the tab order, taking Enter and Space. No chip announces that it is the chosen one, and arrow keys do not move between them.
- Long content: a long schema title stays whole on its chip and pushes the rest onto the next line.

## The chip sizes depart from the type registers

- Both chip sizes are their own multiples of the app size, not a register.
