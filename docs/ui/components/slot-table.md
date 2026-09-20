---
id: ui/components/slot-table
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/problems-marked-where-they-are]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running, product/repeatable-agent-processes]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: [ui/components/file-link-field, ui/components/issue-mark, ui/components/run-value-field, ui/components/value-view]
implemented_by: [packages/app/src/renderer/slotTable.tsx, packages/app/src/renderer/slotForm.ts]
verified_by: [packages/app/test/stateForm.test.ts, packages/app/test/configPanel.test.ts]
mockups: [ui/assets/slot-table/empty.html, ui/assets/slot-table/success.html, ui/assets/slot-table/produced.html, ui/assets/slot-table/partial.html, ui/assets/slot-table/error.html, ui/assets/slot-table/reading.html]
siblings: [ui/components/state-form, ui/components/operation-fields-editor, ui/components/schema-form]
---

# Slot table

An uppercase title with `+ Add` at its far end, a dim line of column names, then one ruled row per slot: a name box, a type picker with a `list` checkbox and `🔗 Link`, a binding box, an `opt` checkbox and `✕`, with a `▸ default & description` fold under each row.

## A slot table declares what a state or its operation takes and hands back

**Use when.** A state declares its Inputs or Outputs, or its operation declares its Operation inputs or Operation output: every name, its type, and where its value comes from.

**Do not use when.** Values are wired into a child's declared slots: that is the `slot ← binding` list inside a child's card in [state-form](state-form.md). Values are entered for a run or a setting: use [schema-form](schema-form.md).

## The title names the table, the column line names the boxes, and each row is one slot

- **Title line.** The table's name in the form's section heading: app face ×0.88, weight 600, uppercase, .09em tracking, in `--text`. `+ Add` is a small ghost button at the far right. The block starts with a 1px `--line` rule and 8px above its title, and its contents sit 11px in.
- **Column line.** `Name`, `Type` and the binding heading at ×0.80, uppercase, .06em tracking, in `--dim`, each cut with an ellipsis. The binding heading says what an empty box means where the table gives it a meaning.
- **Row.** Name, type and binding take shares of 1, 1.3 and 1.4 of the width with 5px gaps; `opt` and `✕` take only what they need. Boxes use the app face at ×0.96 with 3px by 6px padding. Rows are divided by a 1px `--line` rule with 6px above each.
- **Type cell.** A select of the ten types, `list` beside it, a media-type box when the type is `artifact`, then `🔗 Link` drawn by [file-link-field](file-link-field.md). Linked, the select becomes a mono reference box and the toggle reads `🔗 Linked` in `--accent`; while no file answers the reference, the box takes a `--warn` border and the note beside it squeezes the box to a few characters and wraps over several lines.
- **Fold.** `▸ default & description` at ×0.84 in `--dim`, opening to `▾` over a default box and a description box side by side. It is indented 8px behind a 2px rule of `--dim` at 30%, and starts open when either is set.
- **Linked preview.** Under a row whose type points at a readable file, `▾ what {reference} says` opens onto that file drawn by [value-view](value-view.md), behind a 2px `--rule` edge and capped at 320px.

The ten types are `any`, `text`, `url`, `file path`, `artifact`, `number`, `integer`, `datetime`, `boolean` and `object`. Binding boxes offer every path this state can read, as the person types.

## Every state is a list of rows, the line that says there are none, or a row the table will not touch

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | `none declared` in `--dim` under the title, with `+ Add` still offered. | [empty.html](../assets/slot-table/empty.html) |
| loading | Cannot occur: rows draw from the document already in hand. | |
| partial | A row the table cannot edit keeps its value and refuses the edit. A computed binding is a dimmed box showing its JSON. A schema beyond the ten types is a one-line mono summary in `--dim`, such as `object +required +properties`, with the whole schema on its tooltip. A name ending in `*` republishes a child's outputs and reads `per child` as its type. | [partial.html](../assets/slot-table/partial.html) |
| success | Rows with types chosen, `list` ticked, an artifact's media type, `opt` ticked on an optional input, and a fold open where a default or description is set. A linked type shows its reference box and `🔗 Linked`. | [success.html](../assets/slot-table/success.html) |
| produced | An Outputs table where an empty binding means the call fills the slot by name: the column line reads `Binding — empty means {meaning}` and each empty box shows that meaning as an italic placeholder, so it does not read as a box left unfilled. | [produced.html](../assets/slot-table/produced.html) |
| error | A problem the checker found marks the box it is about with a 2px `--bad` border, or `--warn` for a warning: the type select for a type problem, the binding box for everything else about the slot. Every message sits on the row's tooltip. | [error.html](../assets/slot-table/error.html) |
| reading | The configuration a run resolved against: no `+ Add`, `opt`, `Link` or `✕`; boxes lose their borders; the type is said in words, such as `list of text` or `artifact · text/markdown`; `optional` is written only where true; the fold is open and labels its `default` and `description`, with the run's value beside them. An empty table is left out. | [reading.html](../assets/slot-table/reading.html) |

## Every control edits the row it sits on, and the row says what it now declares

| On | Does | Feedback |
| --- | --- | --- |
| `+ Add` | Adds a row typed `any` | A blank row at the foot of the table |
| Type in the name, binding, default or description | Edits the slot; a row with no name is not written, and a default is read as JSON or else as text | The editor's `unsaved changes` |
| Choose a type | Sets the slot's schema; choosing `artifact` fills `text/markdown` | The media-type box appears or goes |
| Tick `list` | Makes the slot a list of that type | The tick |
| Tick `opt` | Marks the input optional | The tick |
| `🔗 Link` | Replaces the type with an empty reference box | `🔗 Linked` in `--accent` |
| `🔗 Linked` | Removes the reference and gives back the type the row had | The select returns |
| `▸ default & description` | Opens or closes the fold | The caret turns to `▾` or `▸` |
| `✕` | Removes the row | The row goes |

## The copy names each box and says what an empty one means

| Where | String |
| --- | --- |
| Titles | `Inputs` · `Outputs` · `Operation inputs` · `Operation output`, drawn uppercase |
| Add | `+ Add` |
| Empty table | `none declared` |
| Column line | `Name` · `Type` · `Binding — where the value comes from` or `Binding — empty means {meaning}` |
| Empty meanings | `the component's answer lands here by name` · `unbound — say where the value comes from` · `the call returns this name` |
| Name placeholder | `name`, or `name, or prefix* to spread a child` where there is no `opt` column |
| Binding placeholders | `default binding (optional)` · `.children.critique.output.outcome` · `.inputs.instruction` |
| Produced tooltip | `§3.3: an output with a binding is derived, one without is produced — there is no third case` |
| Computed binding tooltip | `a computed binding — edit it on the JSON tab` |
| Spread | `per child` · tooltips `a spread: republishes every output of the bound child, prefixed` and `a spread — each slot keeps the child's own schema (§3.5)` |
| Custom schema tooltip | `{schema} — edit it on the JSON tab` |
| Type list | `list` · tooltip `wrap the type in an array — a list of these` |
| Media type | placeholder `text/markdown` · tooltip `the content's media type — what makes this slot a blob` |
| Linked reference | placeholder `$/types/markdown` · `no file here yet — the linter will call this unresolved` |
| Optional | `opt` · tooltip `SPEC §4.1: a slot is required unless it says otherwise` · reading `optional` |
| Fold | `default & description` · reading labels `default` · `description` |
| Default | placeholder `default — also the opt-out from the reachability rule` · tooltip `JSON, or plain text for a string: significant, 3, ["a"]` |
| Description placeholder | `description` |
| Remove tooltip | `remove` |

## Rows share the width by proportion, cut long text, and wrap only in a reading

- **Resize.** The three main columns shrink together and keep their proportions; `opt` and `✕` never shrink. A column heading and a custom-schema summary end in an ellipsis. A state's configuration pinned in the context panel keeps the form at least 460px wide and scrolls sideways below that, because narrower rows stop being readable.
- **Theme.** Rules, borders, the fold's edge and the issue colours are tokens.
- **Focus.** Tab runs along each row: name, type, `list`, media type, `Link`, binding, `opt`, `✕`, then the fold's summary and its boxes, then the next row.
- **Long or missing content.** Long names and bindings scroll inside their boxes. In a reading a type summary wraps instead of cutting. A row with nothing to show under it in a reading has no fold.

## The table departs from the visual direction in three places

- Slot names, bindings and defaults are data typed in the app face.
- The title and column line are uppercase styles of their own rather than `.app-label`.
- An empty binding's meaning is dimmed with opacity rather than `--tok-hint`.
