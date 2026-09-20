---
id: ui/components/code-editor
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/problems-marked-where-they-are, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/one-document-several-readings]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running, product/read-what-work-produced, product/read-comfortably]
surfaces: [ui/surfaces/files-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/monacoDiff.tsx, packages/app/src/renderer/documents.tsx, packages/app/src/renderer/editorThemes.ts, packages/app/src/renderer/editorLook.ts]
verified_by: [packages/app/test/editorLook.test.ts, packages/app/test/tsProject.test.ts, packages/app/test/documents.test.ts]
mockups: [ui/assets/code-editor/loading.html, ui/assets/code-editor/success.html, ui/assets/code-editor/problems.html, ui/assets/code-editor/fitted.html]
siblings: [ui/components/code-view, ui/components/diff-editor, ui/components/markdown-editor, ui/components/schema-json-editor]
---

# Code editor

A source editor inside its host's 1px `--line` frame: dim line numbers in a narrow gutter, coloured mono code on the editor palette's ground, a caret, and red squiggles under what the project's compiler rejects.

## The code editor is where source is typed, or read with a real caret

**Use when.** A text file with a grammar is edited in the Files view, a produced value in a code format is editable, or a person chose the editor as the reading of a file type in Settings.

**Do not use when.** Code is only read and a selection must drag through it and the page around it, as in a fenced block in a conversation: use [code-view](code-view.md). Two versions of a text are compared: use [diff-editor](diff-editor.md). Markdown prose is edited: use [markdown-editor](markdown-editor.md). JSON is edited against its schema: use [schema-json-editor](schema-json-editor.md).

## The code reads first, the gutter second, and the marks over the code last

- **Frame.** The host's: in the Files view a 1px `--line` border with 6px corners, at least 200px tall, filling the editor half; in a value's body a 320px band with the same frame.
- **Gutter.** Line numbers at least two digits wide in the palette's dim colour, 10px before the code. No fold arrows, no glyph margin, no overview ruler.
- **Code.** `--font-data` at the editor size, which is `--size-data` unless the advanced type settings separate them. Line height 1.5 times the size, tabs two columns, 6px above the first line and below the last. It does not scroll past the last line.
- **Palette.** The editor palette from Settings, Monokai Light unless changed, and it does not follow the window's light or dark. All editors on screen share one palette: when two file types ask for different ones, the editor most recently opened or clicked into decides it.
- **Marks.** A red squiggle under each error and an amber one under each warning, only for TypeScript and JavaScript files inside a project, and only from that project's own compiler.
- **Look.** Line numbers and indent guides on; word wrap, minimap, current-line highlight, visible whitespace and bracket colours off. Each is a switch in Settings and applies at once.

## Every state keeps the frame and changes what is inside it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look of its own: an empty file draws one numbered line in the success look, with no message. | |
| loading | The text alone, uncoloured in `--dim` mono with no gutter, in the same frame. The editor then opens coloured by a quick tokenizer, and more of the code is told apart a moment later when the full grammar arrives; the text never moves. | [loading.html](../assets/code-editor/loading.html) |
| partial | Cannot occur: the editor draws the whole text it is given. | |
| success | Gutter, coloured code and a caret. A read-only editor looks the same and answers a keystroke with the editor's own notice above the caret. | [success.html](../assets/code-editor/success.html) |
| problems | Squiggles under each range the compiler names, for this file only. The file is checked on opening and again 0.4 seconds after typing pauses; an answer about text that has since changed is dropped. | [problems.html](../assets/code-editor/problems.html) |
| error | Cannot occur as a look of its own: a check that fails draws nothing and leaves the last marks where they were, and a type with no grammar opens uncoloured. | |
| fitted | A fenced block being edited inside a document: the editor is as tall as its text, wraps long lines with an unnumbered continuation, shows no scrollbars, and passes the wheel to the document. | [fitted.html](../assets/code-editor/fitted.html) |

## Typing edits the text, and the compiler answers in place

| On | Does | Feedback |
| --- | --- | --- |
| Type | Changes the text; the host holds it as an unsaved edit | Characters appear; the host marks the file unsaved |
| Click into the text | Makes this editor the one in front | Every editor on screen repaints in the palette this file type asks for |
| Pointer over a symbol, TypeScript or JavaScript in a project | Asks the project about the symbol | A box under the pointer with the signature coloured in the file's grammar and its documentation |
| Pointer over a squiggle | Nothing | The same box with the compiler's message |
| F12, Ctrl-click, or the editor's right-click menu | Follows a definition or lists references through the project | A place in this file moves the caret there or peeks inline; a definition in another file opens it in the Files view with the caret centred on it and focus in the editor |
| A keystroke in a read-only editor | Nothing | The editor's read-only notice |
| Theme, palette, editor size or a look switch changes | Applied to the open editor | It repaints; the caret and scroll position stay |

## The only words in the frame are the file's and the editor's own

| Where | String |
| --- | --- |
| Loading | `{the file's text}`, uncoloured |
| Problem box | `{compiler message} ts({code})` |
| Read-only notice | `Cannot edit in read-only editor` |

## The editor takes its host's width and height, and scrolls inside itself

- Width is the host's, laid out again whenever the host resizes. Height fills the host's band, or in the fitted state follows the text.
- A long line scrolls sideways unless word wrap is on; a long file scrolls inside the frame.
- Theme: the window's theme changes only the frame. The code repaints with it only when the palette is set to follow the app, which then picks a light or dark palette to match.
- Focus: the text is one tab stop, and Tab inside it indents rather than leaving. Arriving at a definition from another file puts focus in the editor.
- Missing content: text that is not a file in a project, such as a produced value, gets no squiggles, no symbol box and no navigation.

## The inside of the frame departs from the UI direction

- Colours inside the frame come from the editor palette rather than the app's tokens, because an editor holds one palette that people choose for reading code.
- The symbol box, the right-click menu and the read-only notice are drawn in the editor's own faces and colours rather than the app's two voices.
