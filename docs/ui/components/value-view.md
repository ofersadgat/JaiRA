---
id: ui/components/value-view
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced, product/complete-record-of-every-run, product/read-comfortably]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/chat-view, ui/surfaces/files-view, ui/surfaces/context-panel, ui/surfaces/gate-modal]
reuses: [ui/components/markdown-view, ui/components/markdown-editor, ui/components/code-view, ui/components/code-editor, ui/components/data-tree, ui/components/table-view, ui/components/file-changes-list, ui/components/patch-view, ui/components/schema-form, ui/components/context-menu]
implemented_by: [packages/app/src/renderer/valueView.tsx, packages/app/src/renderer/fenceRender.tsx, packages/app/src/renderer/fileSurfaces.tsx, packages/app/src/renderer/valuePanel.ts, packages/app/src/renderer/renderChoice.ts, packages/app/src/renderer/jsonHighlight.ts]
verified_by: [packages/app/test/valueViewToggle.test.ts, packages/app/test/documents.test.ts, packages/app/test/fenceRender.test.ts, packages/app/test/tableView.test.ts, packages/app/test/jsonHighlight.test.ts]
mockups: [ui/assets/value-view/rendered.html, ui/assets/value-view/source.html, ui/assets/value-view/structured.html, ui/assets/value-view/changes.html, ui/assets/value-view/empty.html, ui/assets/value-view/error.html, ui/assets/value-view/inline.html]
siblings: [ui/components/artifact-pane, ui/components/run-value-field, ui/components/produced-artifacts, ui/components/computed-state-body]
---

# Value view

Any value something produced, under a thin line holding a small uppercase grey label such as `RESULT` at the left and, at the right, a joined switch of readings such as `Rendered | Source` with the chosen one shaded, and a quiet `…`, over the value drawn in the chosen reading.

## A value view is the one way to show a value that was produced

**Use when.** A value is shown to be read as what it is: a tool call's arguments and result, a structured output, a function's return, an artifact, a fenced block inside a document or an answer, the reading of an HTML or SVG file in Files, a value kept in the context panel. Its readings are offered wherever it turns up, so the same value looks the same in every place.

**Do not use when.** A person decides about one artifact, with notes and edits: use [artifact-pane](artifact-pane.md), which holds a value view. A set of changes is decided change by change: use [changeset-review](changeset-review.md). A file is edited in Files: that is the file's own editor.

## The value reads first, and the header is drawn only when it has something to say

- **Header.** Drawn when the value has a label, more than one reading, or a control from its host such as `Revert`; 6px between its parts and 3px above the value. A value with one reading and no label draws no header and no `…`.
- **Label.** The host's word for the value, such as `arguments`, `result`, `returned` or `error`, in the app face at 10/12.5 of the app size, uppercase with 0.07em tracking, in `--tok-hint`.
- **Switch.** At the right, after any host control: the readings joined in a 1px `--line` frame with radius 6px, split by hairlines, each at 10.5/12.5 in `--tok-hint`. The chosen reading is in `--text` at 600 on `--fill-ghost-selected`. On a code reading that can be typed into, a small `▾` joined to its segment chooses what draws it.
- **More.** A 22px `…` in `--tok-hint`, borderless until the pointer is over it or its menu is open.
- **Order.** The first reading that applies leads: a set of file changes, then a picture, video or sound, then for text a patch, rendered markdown or HTML, a table, highlighted code and parsed data, with the source always last. A value that arrived as data leads with JSON, then a form when a schema describes it, then the source. An artifact is read as what it carries, with its whole envelope as JSON last.
- **Inline.** A fenced block in a document or answer keeps its header in the block's top-right corner, over the content, on a translucent `--panel` ground with a slight blur, and the value starts at the block's top.

## Each reading draws the value as what it is, and absence and failure say so

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | An absent value reads `undefined`. A table with no rows reads `No rows.`, and a patch with nothing in it `No hunks in this patch.`, in `--dim`. | [empty.html](../assets/value-view/empty.html) |
| loading | Cannot occur as its own look: a reading whose editor or colouring is still loading shows the same text plainly in its place, and the form reading shows the source until it is ready. An opened file in a Files reading says `loading the diff editor…`, as [file-changes-list](file-changes-list.md) draws it. | |
| rendered | Markdown as a document in the app face, through [markdown-view](markdown-view.md), or [markdown-editor](markdown-editor.md) where the host lets it be typed into. HTML in a sandboxed frame 360px tall on white with a 1px `--line` border and radius 6px, its scripts inert; an interactive artifact granted a frame of its own runs, and a message it sends fills the conversation's composer, cut to 4000 characters. A picture, video or sound in its player on `--panel-2` with radius 6px, up to 420px tall, a sound bar up to 420px wide. | [rendered.html](../assets/value-view/rendered.html) |
| source | Source: the text exactly as produced, in the data face at 11.5/12 with line height 1.55 in `--dim`, wrapping anywhere and scrolling past 340px; data is indented JSON. Inside a message it is the message's own prose instead: the app face at 13/12.5 in `--text`, never cut. JSON: the same box in `--text`, keys in `--accent` and strings, numbers and punctuation in their token colours; where a schema describes a key its description is ghosted at the end of the line in italic `--tok-hint`, cut at 80 characters, and long lines scroll sideways inside the value. Code: coloured source through [code-view](code-view.md), or [code-editor](code-editor.md) where it can be typed into. Plain text that can be typed into is a box in the data face. | [source.html](../assets/value-view/source.html) |
| structured | Data: the parsed document as [data-tree](data-tree.md) draws it, with `{n}` and `[n]` counts on containers. Table: rows and columns as [table-view](table-view.md) draws them, the header row sticking while the table scrolls past 340px, and past 500 rows `{n} more rows — the whole file is under Source.` Form: the fields a schema declares, read-only, with boxes that have no ground or border. | [structured.html](../assets/value-view/structured.html) |
| changes | Files: a set of file changes as the collapsed list of [file-changes-list](file-changes-list.md). Diff: a patch as the change it describes, through [patch-view](patch-view.md), scrolling past 460px. | [changes.html](../assets/value-view/changes.html) |
| error | A document that does not parse, read as data, a table or a form: a box with a 1px `--line` border, radius 6px and `8px 10px` padding holding an alert glyph and the parser's message in `--warn` in the data face, then ` — line {l}, column {c}` in `--dim`. The source is one segment away. | [error.html](../assets/value-view/error.html) |
| inline | A fenced block in a document or an answer: the header over the block's top-right corner, the reading under it at the size of its content. | [inline.html](../assets/value-view/inline.html) |

## The switch changes the reading, and the menus act on the value

| On | Does | Feedback |
| --- | --- | --- |
| A reading's segment | Shows the value in that reading, kept while the value stays on screen | The segment is shaded and bold, and the value redraws |
| `▾` | Shows that reading and opens `Drawn by`, offering `Monaco` and `Code view` with the current one ticked | The menu opens under the arrow |
| `Monaco` or `Code view` | Draws the code as an editor, or as coloured text a selection can be dragged through that cannot be typed into | The code redraws |
| `…` | Opens a menu of what can be done with the value | The menu opens under `…`, aligned to its right edge |
| `Download…` | Saves what the chosen reading shows, through the system's save dialog | The save dialog opens with the file name filled in |
| `Open in context panel` | Keeps the value on screen in the context panel while the person carries on | The context panel shows the value, titled with its path, its name, its label, or `Value` |

## The copy is the readings' names and what each one does

| Where | String |
| --- | --- |
| Readings | `Files` · `Preview` · `Rendered` · `Code` · `Source` · `JSON` · `Data` · `Diff` · `Table` · `Form` |
| Reading tooltips | `The files this changes, as a diff` · `Play or show it` · `As markdown, rendered` · `As HTML, rendered` · `Highlighted, in an editor` · `The text exactly as it was produced` · `The value as JSON` · `Parsed — the value this document denotes` · `The change this patch describes` · `As rows and columns` · `As the fields its schema declares` |
| Switch, for a screen reader | `How to show this` |
| Arrow | `▾` · tooltip `Which renderer draws this` · menu title `Drawn by` · `Monaco` · `Code view` |
| More | `…` · tooltip `What else can be done with this` |
| More menu | `Download…` with `{file name}` beside it · `Open in context panel` with `keeps it on screen while you carry on` |
| File name | `{artifact's file name}`, or `value.{ext}` where `{ext}` is the extension of its type, `txt` for other text, and `json` for anything else |
| Frame titles | `Rendered HTML` · `Interactive artifact` |
| Table cut | `{n} more row — the whole file is under Source.` · `{n} more rows — the whole file is under Source.` |
| Empty | `undefined` · `No rows.` · `No hunks in this patch.` |
| Parse failure | `{message}` · ` — line {l}, column {c}` |

## The value takes its host's width and keeps long content inside itself

- It has no width of its own and shrinks to any host. Wide JSON, tables and patches scroll sideways inside the value, never the conversation around it.
- Heights are bounded where a value is an aside: source, JSON and tables stop at 340px and patches at 460px, then scroll; the HTML frame is always 360px; pictures and video stop at 420px.
- The reading chosen for a value is forgotten when the value leaves the screen. Which renderer draws code by default for a type follows the Appearance settings.
- Theme: every colour is a token except the HTML frame's ground, which stays white in the dark theme.
- Focus: Tab reaches any host control, each reading's segment and arrow, then `…`, then whatever the reading holds. The menus close on Escape.
- Missing content: an unlabelled value with one reading draws only the value.

## Two parts of the header and frame depart from the type registers and tokens

- The `▾` is set at 8/12.5 of the app size, below every register.
- The HTML frame's ground is literal white rather than a token, so a page reads as it would in a browser.
