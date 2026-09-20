---
id: ui/components/diff-editor
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/per-change-review, ux/patterns/quote-anchored-note, ux/patterns/problems-marked-where-they-are]
serves: [product/review-changes-before-they-land, product/read-what-work-produced, product/decide-with-the-context-in-front-of-you, product/read-comfortably]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/chat-view, ui/surfaces/files-view, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/monacoDiff.tsx, packages/app/src/renderer/editorThemes.ts, packages/app/src/renderer/editorLook.ts]
verified_by: [packages/app/test/editorLook.test.ts, packages/app/test/tsProject.test.ts]
mockups: [ui/assets/diff-editor/empty.html, ui/assets/diff-editor/loading.html, ui/assets/diff-editor/inline.html, ui/assets/diff-editor/side-by-side.html, ui/assets/diff-editor/selecting.html]
siblings: [ui/components/code-editor, ui/components/patch-view, ui/components/image-diff, ui/components/file-changes-list]
---

# Diff editor

Two versions of one text compared in the editor palette, in one column or two, with removed lines on a red wash, added lines on a green wash, the changed characters washed more strongly, and the frame growing with the content from 120 to 620px before it scrolls.

## The diff editor compares one file's before and after, and can take edits to the after

**Use when.** One text file changed and a person reads the difference: a change in a review of several files, a row opened in a list of changed files, a patch file opened in the Files view, or the diff preview in the appearance settings. It is also where a reviewer edits the proposed side, selects a passage to note, or picks lines to put back.

**Do not use when.** The file is a picture: use [image-diff](image-diff.md). A patch file is read as its hunks with the patch's own line numbers: use [patch-view](patch-view.md). A markdown document is being edited and its change should show over the prose: the [markdown-editor](markdown-editor.md) draws that. A single text with nothing to compare: use [code-editor](code-editor.md).

## The changed lines read first, the code second, and the gutter last

- **No chrome.** No header, toolbar, file name or layout switch of its own. The host draws those above it.
- **Frame.** The host's 1px `--line` border with 6px corners. Height is the taller side's content plus 8px, never under 120px and never over 620px; beyond that it scrolls.
- **Inline.** One column: two narrow line-number columns, before and after, a `−` or `+` beside each changed line, and the removed lines above the lines that replaced them.
- **Side by side.** Before on the left, after on the right, each with its own line numbers; a blank band stands opposite lines that only one side has, so the rest stay level.
- **Washes.** Removed lines on a red wash, added lines on a green wash, the changed characters inside them on a stronger wash. The palette decides the exact hues.
- **Code.** The same face, size, line height and palette as the [code-editor](code-editor.md), with a gutter three digits wide and no fold arrows or overview ruler. The palette chosen for Changes in Settings wins, then the one chosen for the file's type, then the editor palette.
- **Marks.** For TypeScript and JavaScript, compiler squiggles on both sides: the after side against the proposed tree, the before side against the tree as it was, so a squiggle that is gone on the right is a problem the change fixed.

## Every state is the same comparison at a different moment

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Identical or empty texts: no washes and no marks, the text or a single empty line at the 120px floor. No message is drawn. | [empty.html](../assets/diff-editor/empty.html) |
| loading | Drawn by the host while the editor loads: `loading the diff editor…` in `--dim` where the diff will be, or the patch's text uncoloured in the Files view. | [loading.html](../assets/diff-editor/loading.html) |
| partial | Cannot occur: both texts are drawn whole, and what is past the ceiling is reached by scrolling. | |
| error | Cannot occur as a look of its own: a check that fails draws nothing, and a text with no grammar is compared uncoloured. | |
| inline | One column, removals above additions. The hosts in a review and a list of changed files start here. The after side is editable when the host allows it and read-only otherwise, with no visible difference until a keystroke. | [inline.html](../assets/diff-editor/inline.html) |
| side by side | Two columns at any width; a narrow host does not switch it back to one. A patch file in the Files view opens this way. | [side-by-side.html](../assets/diff-editor/side-by-side.html) |
| selecting | Text selected on the after side in the palette's selection colour. A selection touching a changed line, or the line next to one, lets the host offer to put those lines back; any selection that is not blank lets the host open a note on it. | [selecting.html](../assets/diff-editor/selecting.html) |

## Edits land on the after side, and the before side never changes

| On | Does | Feedback |
| --- | --- | --- |
| Type on the after side, where allowed | Changes the proposed text; the host keeps it | Washes are recomputed as the text changes |
| Type on the before side, or on a read-only after side | Nothing | The editor's read-only notice |
| Select text on the after side | Tells the host the quoted passage and where it sits on screen | The host opens its note box at the selection, or relabels its revert action |
| The host's revert of selected lines | Puts the before text back over every changed block the selection touches, as one step that undo reverses | Those washes disappear |
| The host resets the after text, such as undoing a reviewer's edits | Replaces the text as one undoable step | The proposal's washes return |
| The host switches between one column and two | Rebuilds the comparison | The layout changes; the caret and scroll position start over |
| Click into either side | Makes the diff the editor in front | Every editor on screen repaints in the Changes palette |
| Pointer over a squiggle or a symbol | As in [code-editor](code-editor.md) | The editor's box with the message or signature |

## The diff has no words of its own

| Where | String |
| --- | --- |
| Loading, drawn by the host | `loading the diff editor…` |
| Problem box | `{compiler message} ts({code})` |
| Read-only notice | `Cannot edit in read-only editor` |

## The diff takes its host's width and its content's height

- Width is the host's. In two columns each side gets half, and long lines scroll sideways inside their side.
- Height follows the content between 120 and 620px and changes as the after side is edited, so the page around it moves.
- Theme: the window's theme changes only what surrounds the frame; inside, the Changes or editor palette holds, following the app only when set to.
- Focus: each side is a tab stop inside the editor, and Tab in an editable after side indents.
- Missing content: a created file compares against nothing and a deleted file against nothing on the after side, so one side is empty and the other is all wash. Without a file name there are no squiggles.

## The inside of the frame departs from the UI direction

- Colours come from the Changes or editor palette rather than the app's tokens, as in [code-editor](code-editor.md).
