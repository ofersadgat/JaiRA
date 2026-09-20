---
id: ui/components/markdown-editor
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/draft-belongs-to-the-file, ux/patterns/unsaved-proposal]
serves: [product/author-processes-without-memorising-the-format, product/keep-process-and-description-in-step, product/decide-with-the-context-in-front-of-you, product/read-comfortably]
surfaces: [ui/surfaces/files-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/settings-appearance]
reuses: [ui/components/value-view, ui/components/code-editor]
implemented_by: [packages/app/src/renderer/markdownEditor.tsx, packages/app/src/renderer/documents.tsx]
verified_by: [packages/app/test/markdownBands.test.ts, packages/app/test/markdownReading.test.ts, packages/app/test/markdownDiff.test.ts, packages/app/test/longDocument.test.ts, packages/app/test/markdownHighlight.test.ts, packages/app/test/languages.test.ts]
mockups: [ui/assets/markdown-editor/empty.html, ui/assets/markdown-editor/drawn.html, ui/assets/markdown-editor/revealed.html, ui/assets/markdown-editor/changed.html]
siblings: [ui/components/markdown-view, ui/components/code-editor, ui/components/artifact-pane]
---

# Markdown editor

Markdown that looks rendered while it is typed into: big bold headings, `•` bullets, `☐` and `☑` tasks, tinted quote bands, drawn tables and framed code blocks in the host's sans face, with the raw marks appearing only on the lines the caret is on.

## A markdown editor is where markdown is written, and where a change to it is shown in place

**Use when.** Markdown is typed into: a markdown file or a workflow description in the Files view's lower half, or an artifact a gate lets the person edit. It also draws a change over a markdown artifact without leaving the document, and serves as the reading of markdown when `Live preview` is chosen for reading in Settings › Appearance › File types.

**Do not use when.** The markdown is only read and no change is drawn: use [markdown-view](markdown-view.md), which is lighter and draws fenced blocks as full values. The file is treated as source, with its marks always visible: use [code-editor](code-editor.md).

## The document reads as rendered text, and the line under the caret reads as its source

- **Prose.** The host's app face at the host's size, line height 1.6 by default, 8px above the first line and below the last. No gutter and no current-line tint unless Appearance turns them on; lines wrap by default.
- **Headings.** The `#` marks are hidden. Weight 650 at 1.7em for the first level, 1.4em for the second, 1.18em for the third and 1.05em for the rest. A heading underlined with `===` or `---` loses its underline row.
- **Inline marks.** Bold at 700, italic, struck through. Inline code in mono on `--panel-2` with 3px corners. A link is its text alone in `--accent`, underlined. An image is its alt text in `--dim` italic, with no picture.
- **Lists.** A bullet mark is drawn as `•` in `--dim`; numbers stay as typed. A wrapped item hangs under its own text. Task boxes are `☐` in `--dim` and `☑` in `--accent`.
- **Quotes.** The `>` is hidden; the line gets a 2px `--rule` left edge, a 45% `--panel-2` wash and 10px of inset, with the text in `--dim` italic.
- **Breaks and definitions.** A thematic break is a 1px `--rule` line through the middle of its row. A link definition line stays as written at 55% opacity. Single line breaks inside a paragraph join into one flowing paragraph.
- **Tables.** A real table: header cells on `--panel-2` at weight 650, 1px `--line` borders, 4px by 9px padding, cells top-aligned and aligned per the alignment row, inline marks drawn, columns at least 3.5em. It is never wider than the editor and scrolls sideways.
- **Fenced blocks.** A box with a 1px `--line` border, 6px corners and 6px by 8px padding on `--bg`, holding the block's own value reading with its switch floating top right. In a writable editor that reading is an editor for its language, and what is typed there is written back into the block. A block with no language, or one the app does not know, holds its source in `--dim` mono.
- **Selection and caret.** Selected text has a 24% `--accent` wash, the caret is `--text`, and the focused editor draws no outline.

## The document is drawn, opened line by line under the caret, or drawn with a change over it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | One blank line; nothing states that the document is empty. A file not saved yet says `new file — saving creates it` in the row under it. | [empty.html](../assets/markdown-editor/empty.html) |
| loading | Cannot occur as its own look: while the editor loads, [markdown-view](markdown-view.md) draws the same text in its place. | |
| partial | Cannot occur: the editor always holds the whole document. | |
| error | Cannot occur: any text is valid markdown. | |
| drawn | The editor without focus, and every read-only editor: no mark is visible anywhere, every table and fenced block is drawn. | [drawn.html](../assets/markdown-editor/drawn.html) |
| revealed | The focused editor. Every line a selection touches shows its marks. A fenced block holding the caret becomes a mono band on `--bg` with `--line` sides, rounded at its first and last line, its language named small in `--dim` at the top right, its code coloured in the app's token colours. A table holding the caret becomes mono source on a 40% `--panel-2` band, its header line at weight 650 under a top rule, its alignment row and pipes dim and faint. | [revealed.html](../assets/markdown-editor/revealed.html) |
| changed | A change drawn over the document: added words on a 16% `--ok` wash, removed words struck through on a 16% `--bad` wash at the place they were removed, a removed line break drawn as `¶`. The document stays editable and the removed words cannot be typed into. | [changed.html](../assets/markdown-editor/changed.html) |

## The caret decides what shows as source, and every edit keeps the caret and the history

| On | Does | Feedback |
| --- | --- | --- |
| Type, where the editor is writable | Changes the document | The marks redraw at once; the host marks the text unsaved |
| Move the caret onto a line, by click or arrow keys | Shows that line's marks | The marks appear on that line and hide on the one left |
| Click a drawn table | Places the caret in the table | The table turns into its source |
| Click inside a drawn fenced block | Gives focus to the block's own reading or editor | The block stays drawn |
| Arrow keys into a fenced block's lines | Moves the caret into the block's source | The block turns into its band |
| Leave the editor | Nothing | Every mark hides again |
| Ctrl+Z, or Ctrl+Shift+Z or Ctrl+Y | Undoes or redoes | The document steps back or forward |
| Keep typing while a change is drawn | Recomputes the change against the original | Washes and struck words move with the text |
| Change an Appearance setting for markdown | Applies line numbers, wrapping, current line or tab width | The editor updates with the caret and history kept |

## The editor's own copy is glyphs; the words are the document's

| Where | String |
| --- | --- |
| Bullet | `•` |
| Task box | `☐` open · `☑` done |
| Fenced block band | `{language}`, the first word after the backticks, lower-cased |
| Removed line break | `¶` |
| Under the reading in the Files view | `The reading of this type — not a place to type. Appearance › File types.` |

## The editor fills a band in the Files view and grows with its content everywhere else

- In the Files view's lower half the editor fills the band, at least 200px tall, and scrolls inside itself. In a gate or a value it grows with the document and its host scrolls.
- With wrapping off in Appearance, long lines scroll sideways. A drawn table wider than the editor scrolls sideways inside itself.
- Text size is the host's; the editor size preference in Settings does not reach it. Fenced block bands and table source use the data face at the data base size.
- A drawn fenced block takes the height of its content and measures again when its reading or the window changes.
- Theme: every colour is a token. A palette chosen for markdown repaints the text and grounds inside the editor only.
- Focus: the editor is one tab stop, and Tab leaves it. Each drawn fenced block's controls and editor are tab stops of their own.

## The markdown editor departs from the UI direction in three places

- Heading sizes are multiples of the surrounding text, in em, rather than of a voice's base.
- Quiet parts of the source use opacity: the table alignment row at .55, its pipes at .6, link definitions at .55.
- The editor text size preference does not apply to this editor.
