---
id: ui/components/size-stepper
type: ui-component
status: shipped
updated: 2026-09-13
realizes: []
serves: [product/read-comfortably]
surfaces: [ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/editorKnobs.tsx]
verified_by: []
mockups: [ui/assets/size-stepper/success.html, ui/assets/size-stepper/at-a-bound.html, ui/assets/size-stepper/disabled.html]
siblings: [ui/components/preset-chips, ui/components/switch, ui/components/settings-field, ui/components/file-types-pane]
---

# Size stepper

A small bordered box holding a number in bold mono, a faint unit such as `px` or `×`, and two tiny `▲` `▼` arrows stacked at its right edge.

## A size stepper sets a number whose exact value matters and whose range is known

**Use when.** A person sets a text size or a spacing multiple and knows the value they want, such as 12 against 12.5: the app text and data text sizes, the separate editor size, and an editor's line spacing. The box is a third of a slider's width, so it shares a line with the thing it sizes.

**Do not use when.** The value is one of a few fixed answers, such as a tab width of 2, 4 or 8: use [preset-chips](preset-chips.md). The setting is on or off: use [switch](switch.md). The number is a field of a form generated from a schema: [schema-form](schema-form.md) draws its own number box.

## The number reads first, the unit second, and the arrows are the quietest part

- **Box.** 1px `--line` border, `--control-radius` corners, `--panel` ground, 3px above and below, 9px on the left and 4px on the right, 5px between its parts. It never grows or shrinks.
- **Number.** The `.data-num` register in `--text`, right-aligned in a 34px column with no border of its own and no browser spin buttons.
- **Unit.** `.data-faint`, `px` for a text size and `×` for line spacing.
- **Arrows.** `▲` over `▼`, each 15px by 10px in `--dim`, with no ground or border.
- **Ranges.** App text 11 to 17px from 12.5, data text 10 to 16px from 12, separate editor size 10 to 20px from 13, all stepping by 0.5. Line spacing 1.1 to 2.2 × stepping by 0.05, from 1.5 for code and diffs, 1.6 for markdown and 1.55 for JSON.

## Only the arrows and the whole box ever fade

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a size always has a value, its default when nothing is set. | |
| loading | Cannot occur: the size arrives with the settings the pane is drawn from. | |
| partial | Cannot occur: the box draws its number, unit and arrows together. | |
| error | Cannot occur as its own look: a number typed past a bound draws as at a bound. | |
| success | The size inside its range with both arrows at full strength. Beside a font stack, alone at the end of a switch row, and as line spacing in `×`. | [success.html](../assets/size-stepper/success.html) |
| at a bound | At the maximum `▲` fades to 35%, at the minimum `▼` does. A number typed past a bound stands in the box as typed, with the same arrow faded. | [at-a-bound.html](../assets/size-stepper/at-a-bound.html) |
| disabled | While the app carries out an action, such as creating or starting a task, the whole box fades to 55% and neither the number nor the arrows answer. | [disabled.html](../assets/size-stepper/disabled.html) |

## Each press moves the size one step and the text on screen follows at once

| On | Does | Feedback |
| --- | --- | --- |
| Type a number | Sets the size to it on every keystroke; a box that holds no number yet changes nothing | The number stands as typed and the app redraws at the new size |
| `▲` or `▼` | Moves the size one step, first rounding it onto the step's grid, and holds it inside the range | The number changes; the arrow fades when the bound is reached |
| An arrow with the number past a bound | Brings the size back to that bound in one press | The number jumps to the bound |
| Up or Down arrow key in the box | Steps the size by the same amount within the range | The number changes |
| Pointer over an arrow | Nothing | The arrow turns `--text` |

A font size typed past a bound draws the app at the nearest bound, and the stored value is held to that bound the next time the settings are read.

## The copy is the number, its unit and the bound each arrow stops at

| Where | String |
| --- | --- |
| Number | `{size}`, such as `12.5` or `1.55` |
| Unit | `px` · `×` |
| `▲` tooltip | `larger (max {max})`, such as `larger (max 17)` |
| `▼` tooltip | `smaller (min {min})`, such as `smaller (min 1.1)` |

## The box keeps its width in every host and every theme

- Resize: the box has a fixed width and never wraps; the row beside it gives up width first.
- Theme: border, ground and text are tokens, so both themes keep the same contrast.
- Focus: the number box, then `▲`, then `▼`, in the tab order. A faded arrow is skipped.
- Long content: sizes are at most four characters, which fit the 34px column.

## The arrows and the faded states depart from the type registers

- The arrows are set at a literal 7px, below every register.
- At a bound and disabled are drawn with opacity, not with `--tok-hint`.
