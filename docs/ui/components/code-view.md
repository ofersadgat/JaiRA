---
id: ui/components/code-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings]
serves: [product/read-what-work-produced, product/read-comfortably]
surfaces: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/context-panel, ui/surfaces/gate-modal, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/monacoDiff.tsx, packages/app/src/renderer/textmate.ts, packages/app/src/renderer/documents.tsx]
verified_by: [packages/app/test/textmate.test.ts, packages/app/test/documents.test.ts]
mockups: [ui/assets/code-view/empty.html, ui/assets/code-view/loading.html, ui/assets/code-view/plain.html, ui/assets/code-view/coloured.html]
siblings: [ui/components/code-editor, ui/components/markdown-view, ui/components/value-view]
---

# Code view

Read-only source in a rounded box with a thin `--line` border, coloured in a syntax palette that brings its own ground, which a selection can be dragged straight through into the text around it.

## A code view is source that is read, never typed into

**Use when.** Source is shown with no caret: a fenced code block in an answer or a document, a value's `Code` reading where it cannot be edited, a document's front matter, and a file in the Files view when `Code view` is chosen for its text in Settings › Appearance › File types. Many can sit in one conversation, because none of them is an editor.

**Do not use when.** The text is typed into, or needs diagnostics, hover or go-to-definition: use [code-editor](code-editor.md). Two texts are compared: use [diff-editor](diff-editor.md). The text is markdown to be read as a document: use [markdown-view](markdown-view.md).

## The box frames the code, and the palette paints everything inside it

- **Box.** 1px `--line` border, 6px corners, 8px by 10px padding. Mono at the data base size, line height 1.5. Lines never wrap; there are no line numbers.
- **Colours.** The palette chosen for that language's reading, with its own ground and text colour, painted on each block separately, so two blocks on screen can be in two palettes. `Follows the app` gives the Light+ palette in a light window and Dark+ in a dark one; Monokai, Monokai Light, Solarized Light and One Dark stay as chosen whatever the window's theme.
- **Rows.** Coloured, every line is followed by a blank row, so the code reads double-spaced, and text ending in a line break ends with an empty line. The plain box shows the same text single-spaced.
- **Tabs.** A tab is as wide as the code tab width set in Appearance.

## The code is plain while its colours are on their way, and stays plain where there are none

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A box one line tall with nothing in it; nothing states that the text is empty. | [empty.html](../assets/code-view/empty.html) |
| loading | Until the colouring code has loaded, the raw text in `--dim` mono at the `.data-text` size, wrapped anywhere, at most 340px tall and scrolling. In the Files view it fills a bordered band at least 200px tall. | [loading.html](../assets/code-view/loading.html) |
| partial | Cannot occur: a block is coloured whole or shown plain whole. | |
| error | Cannot occur as its own look: colouring that fails leaves the plain box, with no message. | |
| plain | The text in `--text` on `--bg` inside the box, single-spaced: while the colours are on their way, and for good when the language has no grammar or colouring fails. | [plain.html](../assets/code-view/plain.html) |
| coloured | The text in the palette, on the palette's ground, double-spaced. | [coloured.html](../assets/code-view/coloured.html) |

## Selection passes through the box, and a theme change recolours what follows the app

| On | Does | Feedback |
| --- | --- | --- |
| Drag across the box and beyond it | Selects the code and the text around it in one selection | The system selection |
| Scroll sideways inside the box | Shows the rest of a long line | The box's own scrollbar |
| Turn the window dark or light | Recolours every block set to follow the app | Light+ and Dark+ swap; chosen palettes stay |
| Choose a palette in Appearance › File types | Recolours that language's readings | The blocks repaint |

## The code view has no copy of its own

| Where | String |
| --- | --- |
| The box | the source as written |
| Under it in the Files view, from its host | `Code view — coloured, not an editor. Appearance › File types › text.` |

## The box takes its text's height, and in the Files view a coloured file is cut at the band

- Width is the host's; a long line scrolls sideways inside the box and never widens the host.
- Height is the text's. In a conversation, a gate or a pinned value the box grows with the code and its host scrolls.
- In the Files view's lower half the plain box scrolls inside the band, but the coloured box is cut off at the bottom of the band with no way to scroll to the rest of the file.
- Theme: the border follows the window; the ground and code colours are the palette's.
- Focus: the coloured text is one tab stop, and the arrow keys scroll it; the plain box takes no focus.

## The code view departs from the UI direction in one place

- Code colours and grounds come from syntax palettes rather than the app's tokens, including under `Follows the app`.
