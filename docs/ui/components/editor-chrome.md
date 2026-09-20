---
id: ui/components/editor-chrome
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/draft-belongs-to-the-file, ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/author-processes-without-memorising-the-format, product/decide-with-the-context-in-front-of-you]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel, ui/surfaces/run-conversation, ui/surfaces/gate-modal]
reuses: []
implemented_by: [packages/app/src/renderer/editorChrome.tsx]
verified_by: [packages/app/test/configPanel.test.ts]
mockups: [ui/assets/editor-chrome/clean.html, ui/assets/editor-chrome/unsaved.html, ui/assets/editor-chrome/error.html, ui/assets/editor-chrome/reading.html]
siblings: [ui/components/workflow-editor, ui/components/schema-json-editor, ui/components/file-panel, ui/components/edit-artifact-gate]
---

# Editor chrome

A quiet line of facts across the top of an editing surface and, pinned to its bottom edge above a 1px `--line` rule, a filled `Save`, an outlined `Revert` and a dim note such as `unsaved changes`.

## Editor chrome frames every surface that writes a document the person edits in place

**Use when.** A surface edits text or fields that are saved as a whole: a file's editor in the Files view, the [workflow-editor](workflow-editor.md), the [schema-json-editor](schema-json-editor.md), or the [edit-artifact-gate](edit-artifact-gate.md) handing edited content back to a run.

**Do not use when.** The surface reads a type and refuses typing: the host keeps the bottom row and puts its one-line note there instead of buttons. The form writes each setting as it changes, as [schema-form](schema-form.md) does. The answer is a verdict with verbs of its own, as in [confirm-action-gate](confirm-action-gate.md).

## The document sits between a line of facts above and the two buttons below

- **Top line.** One row, 8px gaps, never taller than its content. The host decides what it holds: the state editor puts the file path, a `shared copy` chip and its Form, JSON and Graph switch there; the JSON editor puts its schema picker and verdict there and lets them wrap; the graph puts its legend and zoom there. Nothing in the top line is part of the document.
- **Bottom row.** `Save` as the primary button in `--fill-accent`, then `Revert` as a ghost button, 6px apart. After them sits one short phrase: `unsaved changes` in `.app-secondary`, or the reason saving is refused in `--bad` at the same size. A host can add its own phrase after that, such as `new file — saving creates it`.
- **Ground.** The bottom row carries `--panel` and 8px of padding above its buttons, so a document scrolling under it disappears behind the rule.

## Every state is the two buttons enabled or dimmed, with at most one reason beside them

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look of its own: a document with nothing to save is the clean state. | |
| clean | The text matches what is saved: `Save` and `Revert` at half opacity and nothing beside them. | [clean.html](../assets/editor-chrome/clean.html) |
| unsaved | The text differs from what is saved: both buttons enabled and `unsaved changes` after them. A file that does not exist yet reads this way before any typing, followed by `new file — saving creates it`. The edit-artifact gate shows `Save` alone, enabled before anything is typed and with no phrase, because its content pane carries its own `Revert`. | [unsaved.html](../assets/editor-chrome/unsaved.html) |
| loading | A save under way dims `Save` until the host is done. `Revert` and `unsaved changes` stay. Drawn as the second specimen of the unsaved mockup. | [unsaved.html](../assets/editor-chrome/unsaved.html) |
| partial | Cannot occur: the row draws whole. | |
| error | The host refuses to save: `Save` dimmed, `Revert` enabled, and the reason in `--bad` in place of `unsaved changes`. The state editor gives `fix the JSON before saving` while its text does not parse. | [error.html](../assets/editor-chrome/error.html) |
| success | Drawn as clean: once the save lands, the text matches the file again and the phrase goes. Nothing announces the save. | [clean.html](../assets/editor-chrome/clean.html) |
| reading | A surface that refuses typing keeps the pinned row with no buttons and a single `.app-secondary` sentence naming the setting that holds it read-only. A reading of a run's configuration shows no bottom row at all. | [reading.html](../assets/editor-chrome/reading.html) |

## Save writes, Revert discards at once, and the phrase beside them follows the text

| On | Does | Feedback |
| --- | --- | --- |
| Click `Save` | The host writes the document and reads it back | `Save` dims while writing; the buttons dim and the phrase goes once the text matches the file |
| Click `Revert` | Puts the saved text back with no confirmation | Buttons dim and the phrase goes; a parse reason clears |
| Type in the document | The host keeps the difference from the saved file | `unsaved changes` appears and both buttons enable |
| Type the text back to what is saved | The unsaved edit ends | The row returns to clean |
| Tab | Reaches `Save`, then `Revert`, after the document's own controls | The focus ring on the button |

There is no key for saving.

## The copy is two verbs and a phrase about the text

| Where | String |
| --- | --- |
| Primary button | `Save` |
| Secondary button | `Revert` |
| Beside the buttons | `unsaved changes` |
| Refusal, state editor | `fix the JSON before saving` |
| Host phrase, file not on disk | `new file — saving creates it` |
| Row of a reading of a type | `The reading of this type — not a place to type. Appearance › File types.` |
| Row of the code view | `Code view — coloured, not an editor. Appearance › File types › text.` |

## The bottom row stays against the edge, wraps when narrow, and keeps the app's palette

- **Resize.** The row sticks to the bottom of the surface while the document above it scrolls, so `Save` is in reach however long the form is. In a column too narrow for the buttons and the phrase, the phrase wraps to a second line under them.
- **Theme.** The row and the top line use the window's tokens even when the document is painted in a palette chosen for its type.
- **Focus.** The top line's controls come first, then the document, then `Save` and `Revert`. A dimmed button takes no focus.
- **Long or missing content.** A long refusal wraps under the buttons. With no refusal and no edits the row holds only the two dimmed buttons.
