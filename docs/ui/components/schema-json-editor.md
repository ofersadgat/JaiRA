---
id: ui/components/schema-json-editor
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/pick-from-what-exists, ux/patterns/problems-marked-where-they-are, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel, ui/surfaces/components-view]
reuses: [ui/components/splitter, ui/components/editor-chrome]
implemented_by: [packages/app/src/renderer/schemaEditor.tsx, packages/app/src/renderer/jsonHighlight.ts, packages/app/src/renderer/jsonCursor.ts]
verified_by: [packages/app/test/jsonHighlight.test.ts, packages/app/test/jsonCursor.test.ts, packages/app/test/completionPipeline.test.ts, packages/app/test/schemas.test.ts]
mockups: [ui/assets/schema-json-editor/plain.html, ui/assets/schema-json-editor/success.html, ui/assets/schema-json-editor/error.html, ui/assets/schema-json-editor/completing.html, ui/assets/schema-json-editor/reference.html]
siblings: [ui/components/state-form, ui/components/schema-form, ui/components/code-editor, ui/components/workflow-editor]
---

# Schema JSON editor

A bordered box of coloured mono JSON under a one-line bar reading `Schema`, a picker, `Add missing fields`, `Fields`, a verdict chip and `Wrap`, with each key's description trailing its line in grey italic and red notices under the box.

## The editor is for hand-writing JSON that a known schema describes

**Use when.** A person edits a JSON document as text and the app knows what the document should be: the JSON tab of a state file, a `.json` file in the Files view, a state opened from a graph box in the context panel, and a component's arguments in the component gallery. Without a schema it is still the coloured editor every JSON file gets.

**Do not use when.** The person wants controls for the same document: the Form tab is [state-form](state-form.md), and typed values for something that declares them are [schema-form](schema-form.md). Code with diagnostics and go-to-definition is [code-editor](code-editor.md). A reading of a state file's JSON tab is a plain read-only text box, not this editor.

## The text fills the space, the bar says what it is held to, and problems sit under the text

- **Bar.** `Schema` in `.app-secondary` beside a picker at most 200px wide. With a schema chosen: ghost `Add missing fields`, ghost `Fields` or `Hide fields`, and a pill chip for the verdict. Last, `Wrap`: an unstyled checkbox standing over its word. The bar wraps onto a second line in a narrow pane.
- **Hint.** With a schema chosen, the schema's one-line description in `.app-secondary` sits 4px under the bar.
- **Box.** 1px `--line`, radius 6px, `--bg` ground, at least 140px tall and taking the rest of the height. The border turns `--accent` while the text has focus. Text is the data face at the editor size with 1.55 line height and a tab two columns wide. Keys are `--accent`, strings `--tok-string`, numbers, `true`, `false` and `null` `--tok-number`, punctuation `--dim`.
- **Key descriptions.** The first described key on a line carries its schema description 1.6em after the line's end, italic in `--tok-hint`, cut at 72 characters with `…`. They take no width, so wrapping lines is never thrown off by them.
- **Under the box.** One `--tint-bad` notice per violation: the path in bold data face, ` — `, the message. For text that does not parse, one red line instead.
- **Field reference.** `Fields` opens a column to the right of the box behind a [splitter](splitter.md): the schema's title as a heading, a one-line legend, then a two-column list of field names in mono against a type chip, the allowed values in mono and the description.
- **Save row.** Where the host saves through the editor, the shared Save and Revert row of [editor-chrome](editor-chrome.md) is pinned under it. The state file's JSON tab uses the workflow editor's own row instead.

## The verdict chip names the state and the space under the box explains it

| State | Rendered as | Mockup |
| --- | --- | --- |
| plain | No schema picked, `none — plain JSON`: the picker and `Wrap` alone, coloured text, no hint line, no descriptions, no chip, no completions. | [plain.html](../assets/schema-json-editor/plain.html) |
| empty | Cannot occur as a look of its own: an empty box with no schema is the plain state, and under a schema empty text reads `not JSON`. | |
| loading | Not a look of its own: until the first check answers after the editor opens or a schema is picked, the chip reads `checking…` in `--dim`. A later check keeps the last verdict until its answer arrives, 300ms after typing stops. | |
| partial | Cannot occur: the document is drawn whole, and what does not fit scrolls inside the box. | |
| success | `conforms` in `--ok` with no notices. Stacked below: the component gallery holds a component's arguments to that component's schema only, so the picker is a chip naming it, such as `choose_option config`, with the schema's hint as its tooltip. A reading draws the same with no Save row: the caret and selection work and typing does nothing. | [success.html](../assets/schema-json-editor/success.html) |
| error | The document parses but breaks the schema: `{n} problems` in `--bad` and one notice each, `(root)` standing for the top level. Stacked below, text that does not parse: `not JSON`, `Add missing fields` disabled, the notices gone and the red `not valid JSON: {parse error}` line in their place. | [error.html](../assets/schema-json-editor/error.html) |
| completing | The caret sits in a quoted key position: a 260px menu on `--panel` with a `--lift` shadow opens under the caret, headed `inside {path}` or `at the top level` and `tab ⇥`. Rows are the keys that fit there and are not yet written, required ones first with a `--warn` `★`: key in `--accent` mono, type, description ellipsised. The highlighted row is `--fill-accent` with `--on-accent` text. When nothing follows the caret on its line, the rest of the highlighted key is ghosted in `--tok-hint` after it. More than ten matches end in `+{n} more — keep typing`; near the window's bottom the menu opens above the caret. | [completing.html](../assets/schema-json-editor/completing.html) |
| reference | `Hide fields` in the bar and the reference column open, 300px by default. A field with fields inside it has a `▸` that turns `▾` and opens an indented list behind a `--line` rule; a map opens to `each entry — the key is yours to name` over the fields every entry takes. Required fields start with `★`. Lists open six levels deep at most. | [reference.html](../assets/schema-json-editor/reference.html) |

## Typing checks the document, and the keyboard completes keys

| On | Does | Feedback |
| --- | --- | --- |
| Typing | Changes the document and checks it 300ms after the last keystroke | The chip and notices change when the answer arrives |
| Pick a schema | Holds the document to it. A `.json` file's pick is remembered for that file, and a file opened with no pick is held to the schema its content matches. A state file's JSON tab opens on `Workflow state` every time | Hint, chip, descriptions and completions appear or change |
| `Add missing fields` | Adds every field the schema expects and the document lacks, keeps every value it has, and rewrites the text with two-space indents | The text changes in one step that Ctrl+Z undoes |
| `Fields` or `Hide fields` | Opens or closes the reference, remembered for the window | The column appears or goes |
| `Wrap` | Wraps long lines instead of scrolling sideways, remembered across restarts | Both the colour and the caret wrap together |
| ↓ or ↑ with the menu open | Moves the highlight, wrapping at the ends | The filled row moves |
| Tab with the menu open, or pressing a row | Writes `"{key}": ` in place of what was typed | The menu closes |
| Pointer over a row | Nothing | That row takes the highlight |
| Enter with the menu open | Starts a new line; it never accepts a key | The menu closes with the caret off the key |
| Escape with the menu open | Hides the menu until the next keystroke | The line under it shows |
| Tab or Shift+Tab with no menu | Inserts a tab, or with a selection indents or outdents the selected lines; focus stays in the box | The text shifts |
| Drag the reference's divider, or double-click it | Resizes the reference between 200px and 620px, remembered; a double click restores 300px | The editor takes the remaining width |
| `▸` or `▾` | Opens or closes that field's list | The nested list appears or goes |

## The copy is the schema's own words plus a few labels

| Where | String |
| --- | --- |
| Picker | `Schema` · `none — plain JSON` · `Workflow state` · `Workflow state (prompt)` · `Prompt operation` |
| Picker tooltips and hint line | `a state file as it lives under workflows/ — WORKFLOWS.md §2` · `a state whose operation is one structured LLM call` · `an operation block on its own — what a state $refs, or what you paste into one` |
| Locked picker | `{schema label}`, tooltip `{schema hint}` |
| Buttons | `Add missing fields`, tooltip `{schema hint}`, or while the text does not parse `fix the JSON first — a document that cannot be read cannot be merged into` · `Fields` · `Hide fields` |
| Chip | `checking…` · `conforms` · `not JSON` · `{n} problem` or `{n} problems` |
| Wrap | `Wrap`, tooltip `wrap long lines instead of scrolling sideways` |
| Notices | `{path}` or `(root)`, then ` — {message}`, such as `unknown field 'descripton' — nothing else is recognized here` or `must be array` |
| Parse failure | `not valid JSON: {parse error}` |
| Line description | `{key description}`, cut at 72 characters with `…` |
| Menu | `inside {path}` · `at the top level` · `tab ⇥` · `★` · `+{n} more — keep typing` |
| Reference | `{schema title}` · `★ marks what a complete document needs — required after the environment merge, never in the file itself.` · `each entry — the key is yours to name` |
| Divider | `Resize the field reference` |

## The box scrolls on its own, and the menu follows the caret or hides

- Resize: the box absorbs every change of height and width, including the room notices take under it. The menu is clamped to the editor's width and hides while the caret is scrolled out of view.
- Theme: a palette chosen for the file's type may repaint the box's ground, text and token colours; otherwise both themes use the window's tokens. Verdicts are carried by the chip's words as well as its colour.
- Focus order: the picker, `Add missing fields`, `Fields`, `Wrap`, the text, the divider, the reference's disclosures, then the Save row. A locked chip takes no focus. While editing, Tab inside the text never leaves it; the menu is driven from the text and takes no focus.
- Long content: with wrap off, lines run past the box and it scrolls sideways, carrying the descriptions out of view with them. Field names in the reference never break. The picker ellipsises past 200px.
- Missing content: a key the schema does not describe has no trailing description. A schema with no description for a field shows only its type chip.

## The editor quiets some text with opacity and sizes a data key from the app base

- The type word in a menu row is quieted with 80% opacity instead of `--tok-hint`.
- Menu keys are the data face sized from the app base.
- `Wrap` is an unstyled checkbox that takes its label's width and stands above the word.
