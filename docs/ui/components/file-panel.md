---
id: ui/components/file-panel
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/draft-belongs-to-the-file, ux/patterns/absence-is-stated]
serves: [product/author-processes-without-memorising-the-format, product/read-what-work-produced, product/read-comfortably]
surfaces: [ui/surfaces/files-view]
reuses: [ui/components/splitter, ui/components/editor-chrome, ui/components/code-editor, ui/components/markdown-editor, ui/components/schema-json-editor, ui/components/workflow-editor, ui/components/code-view, ui/components/folder-view]
implemented_by: [packages/app/src/renderer/files.tsx, packages/app/src/renderer/fileSurfaces.tsx, packages/app/src/renderer/fileTypes.ts, packages/app/src/renderer/editorThemes.ts]
verified_by: [packages/app/test/fileTypes.test.ts, packages/app/test/fileRegistry.test.ts]
mockups: [ui/assets/file-panel/empty.html, ui/assets/file-panel/half.html, ui/assets/file-panel/folded.html, ui/assets/file-panel/whole.html, ui/assets/file-panel/error.html]
siblings: [ui/components/folder-view, ui/components/value-view, ui/components/editor-chrome, ui/components/workflow-editor]
---

# File panel

The Files view's middle column with a document open: the file's reading on the grey ground above, a 6px draggable rule, and below it on `--panel` a full-width `▄ SOURCE` or `▄ CONFIGURATION` bar over the editor with Save and Revert pinned at its foot.

## The file panel shows one open document as what it is above and what it says below

**Use when.** A document is open in the Files view. The panel decides only the arrangement: which reading goes above and which editor below come from the file's type and the person's choices in Settings › Appearance › File types.

**Do not use when.** The address ends on a folder: the column is [folder-view](folder-view.md). One value is shown outside the Files view, such as a produced artifact in a conversation: use [value-view](value-view.md) or the editor itself.

## The reading takes the top, the bar names the bottom, and the editor fills it

- **Reading.** The upper half, on `--bg`, 320px tall until dragged, scrolling on its own. A state file reads as its board or conversation, markdown rendered, a workflow description as its sync panel, JSON and YAML as a data tree, CSV as a table, a settings file as the effective configuration, HTML and SVG drawn, a patch as its changes.
- **Rule.** A 6px [splitter](splitter.md) with a 1px `--line` hairline that turns `--accent` under the pointer or on focus.
- **Lower half.** `--panel` ground with a 1px `--line` top border, 10px 15px 14px padding, 8px gaps, at least 140px tall.
- **Bar.** A full-width button: the fold glyph `▁`, `▄` or `█` in `--dim`, then `CONFIGURATION` for a state file or `SOURCE` for anything else, in the app face at weight 600, uppercase with .07em tracking in `--dim`. Folded with unsaved edits, an `--accent` dot sits at its far right.
- **Editor.** A state file gets the [workflow-editor](workflow-editor.md), or its JSON as text; a settings file a plain mono box that is checked before it is written; other JSON the [schema-json-editor](schema-json-editor.md); markdown the live [markdown-editor](markdown-editor.md); other text the [code-editor](code-editor.md), a plain mono box where no grammar exists, or the read-only [code-view](code-view.md). Each fills the half and scrolls inside itself, with the [editor-chrome](editor-chrome.md) Save row pinned at the bottom.

## The lower half is half, folded or the whole column

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Nothing is open: `Select a file in the tree.` in `--dim` at the top of the column. | [empty.html](../assets/file-panel/empty.html) |
| loading | Cannot occur as a look of its own: an editor still loading holds its band with the text uncoloured, as the editor's own doc draws it. | |
| partial | Cannot occur: each half draws its document whole, and what a fold hides is the folded state. | |
| success | Half: reading, rule, bar with `▄`, and the editor. Save and Revert are disabled until the text differs; then both enable and `unsaved changes` follows them. A file not on disk yet says `new file — saving creates it`. | [half.html](../assets/file-panel/half.html) |
| folded | The reading takes the column; the rule is gone; the lower half is only the bar, `▁` and 6px by 15px padding, with the unsaved-edits dot when there are any. | [folded.html](../assets/file-panel/folded.html) |
| whole | No reading and no rule; the bar reads `█` and the editor takes the column with no top border. A type with no reading is always drawn this way, with no bar. | [whole.html](../assets/file-panel/whole.html) |
| error | A settings file that does not parse on Save: `not valid JSON: {message}` in `--bad` under the box, cleared by typing or Revert. A type nothing can edit: `Nothing here can edit {type}.` in `--dim` where the editor would be. | [error.html](../assets/file-panel/error.html) |

A state file that names no state reads `This file does not name a state.` in place of the form. The Code view writes nothing and puts `Code view — coloured, not an editor. Appearance › File types › text.` where Save would be.

## The bar cycles the fold, the rule sizes the reading, and both are kept

| On | Does | Feedback |
| --- | --- | --- |
| Click the bar | Moves folded to half, half to whole, whole to folded; kept for the person across files and restarts | Glyph and layout change at once; the tooltip names the position and the next one |
| Drag the rule | Sets the reading's height, between 80px and the column's height less 200px; kept for the person | The hairline turns `--accent` |
| Up or Down arrow on the focused rule | Moves it 12px, 48px with Shift | Halves resize |
| Double-click the rule | Restores 320px | Halves resize |
| Type in the editor | Holds the unsaved text, which stays with the file when another file is opened | The file's row in the tree gains the unsaved dot |
| Save | Writes the file and reads it back | Save disables while writing; `unsaved changes` goes |
| Revert | Drops the unsaved text | Buttons disable; a parse error clears |

## The copy is the half's name and the fold's position

| Where | String |
| --- | --- |
| Empty | `Select a file in the tree.` |
| Bar | `Configuration` for a state file · `Source`, both drawn uppercase |
| Bar tooltip | `{position} — click for {next position}`, positions `folded away` · `half the column` · `the whole column` |
| Unsaved dot | tooltip `unsaved edits` |
| Rule | label `Resize the viewer` |
| Buttons | `Save` · `Revert` |
| Beside the buttons | `unsaved changes` · `new file — saving creates it` |
| Parse error | `not valid JSON: {message}` |
| No editor | `Nothing here can edit {type}.`, such as `image/png` |
| No state | `This file does not name a state.` |
| Code view | `Code view — coloured, not an editor. Appearance › File types › text.` |

## The editor keeps its floor and the reading gives up height first

- The lower half claims its 140px first; a window made shorter takes the difference from the reading, down to 80px. Editors keep at least 200px, the plain box 120px, bordered `--line` with a 6px radius.
- Width is the middle column's, between the sidebar and the context panel.
- Theme: the column uses the window's tokens. A half painted in a palette chosen for that type and reading takes those colours and nothing outside it changes.
- Focus: tab order runs down the column: the reading's own controls, the rule, the bar, the editor, then Save and Revert.
- Unsaved work: unsaved edits outlive leaving the file and switching files, and are marked on its tree row, and on the bar while folded, until they are saved, reverted or the window is closed.
