---
id: ui/components/markdown-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced, product/chat-with-agents, product/keep-process-and-description-in-step]
surfaces: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/context-panel, ui/surfaces/gate-modal, ui/surfaces/settings-appearance]
reuses: [ui/components/value-view, ui/components/code-view]
implemented_by: [packages/app/src/renderer/markdown.tsx, packages/app/src/renderer/fenceRender.tsx, packages/app/src/renderer/documents.tsx]
verified_by: [packages/app/test/markdown.test.ts, packages/app/test/fenceRender.test.ts, packages/app/test/documents.test.ts]
mockups: [ui/assets/markdown-view/empty.html, ui/assets/markdown-view/success.html, ui/assets/markdown-view/front-matter.html]
siblings: [ui/components/markdown-editor, ui/components/artifact-pane, ui/components/message]
---

# Markdown view

Rendered markdown in the app's sans face: sized-down bold headings, paragraphs, bulleted lists, `--line` bordered tables, grey-ruled quotes, `--accent` links and small bordered mono code chips, with fenced blocks drawn as the values they hold and a dim `front matter` disclosure on top when the document has a header.

## A markdown view is the reading of markdown that nobody is changing

**Use when.** Markdown is only read: the `Rendered` reading above a markdown file or a workflow description in the Files view, an agent's answer in a conversation, a value's `Rendered` reading in a gate or a pinned value. It is also what stands in for the editor while the editor loads.

**Do not use when.** The text may be typed into, or a change must be drawn over it: use [markdown-editor](markdown-editor.md). The person must judge or annotate one artifact inside a gate: use [artifact-pane](artifact-pane.md), which hosts this view. The text is source to be read as written: use `Source`, or [code-view](code-view.md).

## The document reads top to bottom with its header folded away above it

- **Front matter.** A YAML header at the very top of the document becomes one closed disclosure, `front matter`, in `--dim` at the `.app-secondary` size. Open, the header is drawn as a YAML value with its own `Code | Data | Source` switch, 6px under the summary, at most 260px tall and scrolling inside.
- **Body.** The app face at 13/12.5 of the app base, line height 1.6, `--text`. Paragraphs, lists, quotes and tables stand 10px apart. Lists indent 20px.
- **Headings.** Bold, line height 1.3, 16px above and 6px below. A first-level heading is 18/12.5 of the app base, a second-level one 15/12.5, the third and fourth levels the body's size.
- **Inline code.** Mono at the data base size on `--bg`, with a 1px `--line` border and 4px corners.
- **Quotes and rules.** A quote is `--dim` text 10px right of a 3px `--line` rule. A thematic break is a 1px `--line` line with 14px above and below.
- **Tables.** Collapsed 1px `--line` borders, 3px by 7px cell padding, each column aligned as the table's alignment row asks.
- **Links.** `--accent`, underlined. A bare web address in the text becomes a link.
- **Fenced blocks.** A block in a language the app can read holds that value's own reading: coloured code with its reading switch floating over the top right corner, a table for CSV, a patch for a diff, a nested document for markdown. A block with no language, or one the app does not know, is its source in a `--bg` box with a 1px `--line` border and 6px corners.

## Every text renders, so the only other state is a file with nothing in it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | In the Files view, a file holding only whitespace reads `This file is empty.` in `--dim`. | [empty.html](../assets/markdown-view/empty.html) |
| loading | Cannot occur: the text is parsed and drawn in one step. A fenced block whose colouring is still loading shows its text plainly in the same box, as [code-view](code-view.md) draws it. | |
| partial | Cannot occur: an answer still arriving is shown by its conversation as plain text, and becomes this view once it settles. | |
| error | Cannot occur: every text renders. Raw HTML in the source shows as literal text, a link to anything but a web, mail or relative address is `--accent` text that goes nowhere, and an image from anywhere but a web, data or relative address is left out. | |
| success | The whole document, front matter closed. | [success.html](../assets/markdown-view/success.html) |
| front matter | The disclosure opened: the header as a YAML value in its `Code` reading, the body continuing under it. | [front-matter.html](../assets/markdown-view/front-matter.html) |

## Links leave, the header opens, and fenced blocks bring their own controls

| On | Does | Feedback |
| --- | --- | --- |
| Click a link | Opens the address in a new window | The window opens |
| Click `front matter`, or Enter or Space on it | Opens or closes the header | The disclosure triangle turns and the header appears or goes |
| A fenced block's reading switch | Draws that block another way, as [value-view](value-view.md) describes | The block redraws in place |
| Drag across the text | Selects it, straight through fenced code | The system selection |

## The view's own copy is one label and one statement

| Where | String |
| --- | --- |
| Header disclosure | `front matter` |
| Empty file | `This file is empty.` |
| Everything else | the document's own words |

## The view flows with its host and only wide blocks scroll sideways

- Text wraps to the host's width and breaks a long word rather than overflowing. A plain fenced block scrolls sideways inside its box; a wide table widens the view, and the host scrolls.
- In a conversation message or a value's body the text is at the app base size, and in a message the line height is 1.65 with no margin above the first block or below the last.
- Theme: every colour is a token, so the reading follows the window. A coloured fenced block takes the palette chosen for its language.
- Focus: links, the `front matter` disclosure and each fenced block's controls are tab stops in document order.
- A long header stays inside its 260px box when opened; a document with no header draws no disclosure.

## The markdown view departs from the UI direction in two places

- Prose written by agents and authors is set in the app face, though the direction gives words something else chose to the data face.
- Body and heading sizes are their own multiples of the app base rather than the ten registers, and the fifth and sixth heading levels take the browser's sizes.
