---
id: ui/components/issue-mark
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/problems-marked-where-they-are, ux/patterns/jump-to-the-place-and-mark-it]
serves: [product/catch-process-mistakes-before-running, product/author-processes-without-memorising-the-format]
surfaces: [ui/surfaces/files-view]
reuses: []
implemented_by: [packages/app/src/renderer/issues.ts, packages/app/src/renderer/stateEditor.tsx]
verified_by: [packages/app/test/issues.test.ts]
mockups: [ui/assets/issue-mark/clean.html, ui/assets/issue-mark/marked.html, ui/assets/issue-mark/revealed.html]
siblings: [ui/components/state-inspector, ui/components/state-form, ui/components/slot-table, ui/components/file-link-field, ui/components/schema-json-editor]
---

# Issue mark

A 2px `--bad` red or `--warn` amber border on the one box in a state's form that holds a value the linter complained about, with the complaint as the tooltip of its row, and a brief blue wash over that row when the person jumps to it.

## Marks put each lint problem on the box that holds it

**Use when.** A state file open in the Files view has lint issues and the form draws a control for the path an issue names: a slot's name, type or binding, a child's wiring, a transition's condition or target, an operation's field, a link's path, the limits.

**Do not use when.** The problem is the document breaking its JSON schema while it is typed as text: [schema-json-editor](schema-json-editor.md) lists those under the text. The form is a reading, or a state shown in the context panel: those are drawn with no issues, so nothing is marked. The list of every issue with its message is the Validation section of [state-inspector](state-inspector.md).

## The box says which value is wrong, and its row says why

- **Box.** The input, select or text area that holds the value takes a 2px border, `--bad` for an error and `--warn` for a warning. The border grows inward, so the row does not reflow and the text moves in by a pixel.
- **Text.** A type shown as text rather than as a box, such as a linked or unmodelled type, takes the colour in its text at weight 600 instead.
- **Row, table or block.** The element that answers for the path carries no colour of its own. Its tooltip lists every issue at or under its path, one per line, errors first.
- **Worst wins.** A box with both an error and a warning is red. A box whose neighbour answers for a more specific path does not light up for it: a slot's binding box stays plain for a problem with the slot's type, which marks the type picker.
- **Stronger than the form's own warnings.** An unresolved link or an unwired required input is amber by the form's own check; when the linter calls it an error the border turns `--bad`.

## A form is clean, marked, or showing the one issue just chosen

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a mark exists only on a control the form draws. | |
| loading | Not a look of its own: marks come from the last lint of the saved files, so while an unsaved edit is open they describe the saved file. | |
| partial | Not a look of its own: an issue no box answers for colours nothing, and is carried only by the tooltip of the row, table or block around its path. | |
| success | No issues: every box keeps its 1px `--line` border. | [clean.html](../assets/issue-mark/clean.html) |
| marked | An output's binding box in `--bad` for an error, and an empty prompt box in `--warn` for a warning, each row's tooltip holding the message. | [marked.html](../assets/issue-mark/marked.html) |
| revealed | The row an issue was chosen for, scrolled to the middle of the form with any closed disclosure around it opened, washed with 26% `--accent` for about half a second and fading out by one second. The red border stays. | [revealed.html](../assets/issue-mark/revealed.html) |

## Choosing an issue elsewhere brings its box into view

| On | Does | Feedback |
| --- | --- | --- |
| An issue in the inspector's Validation list | Switches the editor to its Form tab, finds the most specific row, table or block that answers for the issue's path, opens the disclosures around it and scrolls it to the middle | The wash over that element, then the standing border on its box |
| Pointer resting on a marked row, table or block | Nothing | The tooltip lists its issues |
| Saving a fix | The files are linted again | The box's border returns to `--line` when its issues are gone |

A path claims only what lies under it on a key or index boundary: `inputs.plan` covers `inputs.plan.kind` and `inputs.plan[0]`, never `inputs.planner`.

## The copy is the linter's own messages

| Where | String |
| --- | --- |
| Tooltip | `{message}` per issue, one per line, errors first, each repeated message shown once |
| Examples | `selects output 'ids', which the producer does not declare` · `prompt operation has an empty prompt (no template and no skill)` · `required child input '{name}' is not wired` · `transition to sequence member '{key}' can cycle; add limits.max_iterations or a run.iteration guard` |

## The mark follows its box through resize, theme and focus

- Resize: the border belongs to the box, so it narrows and wraps with the form's columns.
- Theme: `--bad`, `--warn` and `--accent` carry the marks in both themes. On the box, colour is the only carrier of error against warning; the tooltip and the inspector's list carry the words.
- Focus order: marks add no stops. A focused marked box shows the focus ring outside its coloured border.
- Long or missing content: a long tooltip is the platform's own and wraps as the platform wraps it. An issue with no path marks nothing in the form.

## The mark departs from the direction in weight and motion

- The warning and error borders are 2px where every other box edge is 1px.
- The reveal's wash animates even when the person has asked the system for reduced motion.
