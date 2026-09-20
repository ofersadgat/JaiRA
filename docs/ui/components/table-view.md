---
id: ui/components/table-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced]
surfaces: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/context-panel, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/valueView.tsx, packages/app/src/renderer/fileSurfaces.tsx]
verified_by: [packages/app/test/tableView.test.ts, packages/app/test/valueViewToggle.test.ts, packages/app/test/fileRegistry.test.ts]
mockups: [ui/assets/table-view/empty.html, ui/assets/table-view/partial.html, ui/assets/table-view/success.html]
siblings: [ui/components/data-tree, ui/components/code-view, ui/components/value-view]
---

# Table view

A CSV or TSV document as a grid of small mono cells in thin `--line` borders, the first row a dim header on `--panel` that stays at the top while the grid scrolls inside a frame at most 340px tall.

## A table view reads delimited text as the rows and columns it holds

**Use when.** Comma- or tab-separated text is read: the `Table` reading above a CSV or TSV file in the Files view, and the `Table` reading a CSV value leads with in a conversation, a gate or a pinned value.

**Do not use when.** The text is being changed: the editor below it in the Files view does that. The data is nested rather than rows: use [data-tree](data-tree.md). A table inside a markdown document is drawn by that document's reading.

## The header names the columns, and every row below keeps one line per cell

- **Header.** The first row, always, whether or not the file means it as one. Mono at the `.data-text` size in `--dim`, weight 500, on `--panel`, pinned to the top of the frame while the rows scroll under it.
- **Cells.** Mono at the same size in `--text`, line height 1.5, 2px by 7px padding, left-aligned, bordered 1px `--line` on every side. A cell never wraps; past 320px it ends in an ellipsis.
- **Shape.** The grid is as wide as its columns, not as wide as its host. A row with fewer fields than the header ends early and a row with more runs past it; nothing is padded to agree.
- **Frame.** The grid scrolls both ways inside a frame at most 340px tall.
- **Cut note.** Past 500 rows under the header, a `.app-secondary` line in `--dim`, 6px under the grid, says how many are not drawn.

## Every state is the grid, the grid cut at 500 rows, or a statement that there is nothing

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | In the Files view, a file holding only whitespace reads `This file is empty.` in `--dim`. As a value's `Table` reading, text with no rows reads `No rows.` in `--dim`. | [empty.html](../assets/table-view/empty.html) |
| loading | Cannot occur: the text is split and drawn in one step. | |
| partial | More than 500 rows under the header: the first 500 are drawn and the cut note sits after the last of them, reached by scrolling to the end of the frame. | [partial.html](../assets/table-view/partial.html) |
| error | Cannot occur: any text splits into rows, and a malformed row is drawn ragged rather than refused. | |
| success | The whole grid, header first, ragged rows as they are. | [success.html](../assets/table-view/success.html) |

## Scrolling moves the rows under a fixed header, and nothing else responds

| On | Does | Feedback |
| --- | --- | --- |
| Scroll inside the frame | Moves the rows, and the columns sideways | The header stays at the top |
| Drag across cells | Selects their text for copying | The system selection |
| Pointer over a cut cell | Nothing: no tooltip carries the rest of it | None |

## The copy is the file's own cells and two statements about what is not drawn

| Where | String |
| --- | --- |
| Empty file, Files view | `This file is empty.` |
| No rows, value | `No rows.` |
| Cut note | `{n} more row — the whole file is under Source.` for one, `{n} more rows — the whole file is under Source.` for more |
| Header and cells | the fields as the file holds them, quotes removed and doubled quotes read as one |

## The frame keeps the grid bounded and gives up width to scrolling

- The frame stops at 340px tall wherever the view sits. In the Files view's upper half a taller half leaves the space under the frame empty, and a shorter half scrolls, frame and all.
- A grid wider than its host scrolls sideways inside the frame, never the page around it. A cut cell's full value is under Source.
- Theme: borders, header ground and text are tokens, so the grid keeps its structure in both themes.
- Focus: cells take no focus and no keys.
