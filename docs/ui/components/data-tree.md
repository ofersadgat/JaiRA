---
id: ui/components/data-tree
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced, product/author-processes-without-memorising-the-format]
surfaces: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/context-panel, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/valueView.tsx, packages/app/src/renderer/fileSurfaces.tsx]
verified_by: [packages/app/test/valueViewToggle.test.ts, packages/app/test/fileRegistry.test.ts]
mockups: [ui/assets/data-tree/empty.html, ui/assets/data-tree/error.html, ui/assets/data-tree/success.html, ui/assets/data-tree/data-reading.html]
siblings: [ui/components/table-view, ui/components/code-view, ui/components/schema-form, ui/components/value-view]
---

# Data tree

A parsed JSON or YAML document as an indented mono list of `key: value` lines, a thin rule down the left of every nested level, a dim `{n}` or `[n]` after each object or list, and each leaf coloured by its type.

## A data tree shows what a structured document denotes, not how it is written

**Use when.** A JSON, JSON Lines or YAML document is read for its values: the `Data` reading above a JSON or YAML file in the Files view, the `Data` reading of a fenced block or a produced value, and the settings file's `Effective` reading.

**Do not use when.** Comments, anchors or the layout as written matter: read the source through [code-view](code-view.md). The document answers to a known schema and its fields are wanted: the `Form` reading draws a read-only [schema-form](schema-form.md). The value is rows and columns: use [table-view](table-view.md).

## The root's count reads first, then every key in order with its value on its line

- **Root.** The first line is the whole document's count alone, such as `{8}`, with no key and no rule. A YAML file holding several documents reads as a list of them.
- **Lines.** Mono at the data base size with a line height of 1.7. Each line is a key in `--dim` and a colon, then a leaf value or the container's count.
- **Nesting.** The members of a container sit 13px further in, with a 1px `--line` rule down their left edge. Every level is always open.
- **Leaves.** Written the way JSON writes them: strings in quotes in `--accent`, numbers and booleans in `--text`, `null` in `--dim`. A list's members are keyed by position from `0`.
- **Counts.** `{n}` after an object and `[n]` after a list, mono in `--dim` at the `.app-secondary` size. An empty container is its count with nothing under it.

## Every state is the tree, a statement that there is nothing, or where the parse stopped

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | In the Files view, a file holding only whitespace reads `This file is empty.` in `--dim`. As a value's `Data` reading, empty text reads `The document is empty.` in the parse panel described under error. | [empty.html](../assets/data-tree/empty.html) |
| loading | Cannot occur: the document is parsed and drawn in one step. | |
| partial | Cannot occur: no level folds and the tree has no cap, so every node is drawn. | |
| error | No tree. In the Files view, a `--tint-bad` wash with `does not parse:` and the parser's message and position in `--bad`. As a value's `Data` reading, a 1px `--line` bordered panel with the alert glyph and the message in `--warn` mono, its position after it in `--dim`. Comments and trailing commas in JSON are not errors. | [error.html](../assets/data-tree/error.html) |
| success | The tree, flush with its host's edge. | [success.html](../assets/data-tree/success.html) |
| data reading | A fenced block, a produced value or a pinned value switched to `Data`: the same tree under or beside the value's reading switch, which floats over the top right corner of a fenced block. | [data-reading.html](../assets/data-tree/data-reading.html) |

## The tree takes no input of its own

| On | Does | Feedback |
| --- | --- | --- |
| Drag across lines | Selects the keys and values for copying; the colons after keys are not copied | The system selection |
| Click a key or a count | Nothing: levels never fold | None |

## The copy is the parser's message and the document's own values

| Where | String |
| --- | --- |
| Empty file, Files view | `This file is empty.` |
| Empty text, value | `The document is empty.` |
| Parse error, Files view | `does not parse: {message} (line {line}, column {column})` |
| Parse error, value | `{message}` then ` — line {line}, column {column}` |
| Key | `{key}:` |
| Object count | the member count in braces, such as `{8}` |
| List count | the member count in brackets, such as `[3]` |
| Leaf | the value as JSON writes it, such as `"feature.ux"`, `3`, `true`, `null` |

## The tree grows with the document and scrolls with its host

- Width is the host's. Keys and counts never wrap, so a long key or a deep level runs past the edge and the Files view's upper half scrolls sideways. A string value wraps anywhere, inside a path too.
- Height has no cap: every node is drawn, and a large document is a long scroll in its host. Inside a fenced block the tree takes its full height.
- A string holding a line break shows `\n` inside its one quoted value.
- Theme: keys, leaves, rules and counts are tokens, so both themes keep the same roles.
- Focus: nothing in the tree is a tab stop. The reading switch above it is the value's.

## The tree departs from the UI direction in one place

- Container counts are mono but sized from the app voice's base, as `.app-secondary` is, rather than from the data voice's.
