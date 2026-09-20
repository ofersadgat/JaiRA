---
id: ui/surfaces/files-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/drill-in-and-back-out, ux/patterns/one-document-several-readings, ux/patterns/draft-belongs-to-the-file, ux/patterns/problems-marked-where-they-are, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/absence-is-stated]
serves: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running, product/try-one-step-on-its-own, product/share-processes-across-projects, product/read-what-work-produced, product/complete-record-of-every-run]
components: [ui/components/file-tree, ui/components/address-bar, ui/components/segmented-control, ui/components/file-panel, ui/components/folder-view, ui/components/state-inspector, ui/components/task-metrics, ui/components/task-board, ui/components/task-card, ui/components/task-name, ui/components/transcript, ui/components/value-view, ui/components/data-tree, ui/components/schema-form, ui/components/workflow-editor, ui/components/editor-chrome, ui/components/splitter, ui/components/context-menu]
mockups: [ui/assets/files-view/nothing-open.html, ui/assets/files-view/folder.html, ui/assets/files-view/file-open.html, ui/assets/files-view/halves.html, ui/assets/files-view/composite-state.html, ui/assets/files-view/leaf-state.html, ui/assets/files-view/data-readings.html]
siblings: [ui/surfaces/tasks-view, ui/surfaces/run-view, ui/surfaces/context-panel, ui/surfaces/sidebar, ui/surfaces/settings-view, ui/surfaces/confirm-dialog, ui/surfaces/error-notice]
---

# Files view

A project's Files room: the file tree under the sidebar's Files row, the address of what is open across the title bar, and under the address the open folder or file in the middle column with a 300px context panel on the right describing the end of the address. It fills the window right of the sidebar and takes the place of the other rooms while open.

## The address reads first, the open thing second and its description third

- **Tree.** A [file-tree](../components/file-tree.md) in the sidebar's Files drawer, one list per root. The root the address stands in has no heading; the others, such as `~/.jaira`, have one. Glyphs say the kind: `◻` workflow, `◈` prompt, `✦` skill, `⚙` configuration. A file's lint problems colour its name `--bad` or `--warn` with a dot and a count chip, rolled up onto the folders above it. An `--accent` `●` marks a file with unsaved edits and every folder above it. Types that are not text are `--dim`.
- **Address.** An [address-bar](../components/address-bar.md), absent while nothing is open. Grey mono folder crumbs from `.jaira` or `~/.jaira`, blue mono state crumbs below `workflows`, the last at weight 600. A state file adds its label in `--dim` and `{n} error` or `{n} warning` chips at the right, and a composite state adds the `Tasks` and `Conversation` [segmented-control](../components/segmented-control.md). Clicking the bar's background returns the panel to the open file.
- **Middle column.** A [file-panel](../components/file-panel.md) on `--bg`. A folder is a [folder-view](../components/folder-view.md). A file is its reading above and its editor below: the reading 320px tall by default, a horizontal divider, then the editor on `--panel` under a `--line` rule, headed by a bar reading `▄ SOURCE`, or `▄ CONFIGURATION` for a state file. Which reading and which editor a type gets is set in Settings › Appearance › File types; the column has no switch of its own.
- **Divider.** A 6px [splitter](../components/splitter.md) with a `--line` hairline.
- **Context panel.** On `--panel`, the first of these that applies: a pinned value, drawn by [context-panel](context-panel.md); a state reached from a conversation's workflow link, as a [state-inspector](../components/state-inspector.md) with `←`; the task, when asked for from a run, with its [task-metrics](../components/task-metrics.md); the run at the end of the address, headed `{name} · the run` with `the task ↗`; the open folder, headed `{name} · the folder` over its path, layer and what it holds; the open file, headed `{name} · the file` over its path, layer, type and size, or the state-inspector for a state file.

## The upper half shows what the file is and the lower half what it says

| File | Reading | Editor |
| --- | --- | --- |
| Composite state | Its [task-board](../components/task-board.md), where each [task-card](../components/task-card.md) is a task, until a task is chosen; then [run-view](run-view.md) for that task's run of the state | [workflow-editor](../components/workflow-editor.md) |
| Leaf state | A 190px list on `--panel` headed `Tasks here` `{n}` and `Recently`, rows of a status glyph and a [task-name](../components/task-name.md), beside the chosen task's [transcript](../components/transcript.md) | workflow-editor |
| Settings | `shared config with this project's laid over it` over a [data-tree](../components/data-tree.md) of the merged configuration | the settings text |
| Data with a schema | A read-only [schema-form](../components/schema-form.md) with transparent controls, when Form is the chosen reading | the data text |
| Markdown | Rendered through [value-view](../components/value-view.md) | a live-preview editor |

Every editor ends in the [editor-chrome](../components/editor-chrome.md) row: `Save`, `Revert` and `unsaved changes`. A text type whose chosen reading is coloured code shows it read-only over the pinned line `Code view — coloured, not an editor. Appearance › File types › text.`.

## Every state of the room keeps the tree and says what is absent

| State | Surface shows | Mockup |
| --- | --- | --- |
| nothing open | No address, `Select a file in the tree.` in the column and `Select a file.` in the panel. With no project open the drawer reads `Open a project to browse its files.`. Between choosing a file and its arrival the room looks the same, with no spinner, and a file that cannot be read leaves it that way. A state file's panel shows the plain file facts until the state has been read. | [nothing-open.html](../assets/files-view/nothing-open.html) |
| folder | The address ends on the folder. The column lists `↰ ..`, then folders at weight 600 with `▸`, then files with their glyphs and lint chips, or `This folder is empty.`. | [folder.html](../assets/files-view/folder.html) |
| file open | The reading over the editor. Unsaved edits enable `Save` and `Revert` and add `unsaved changes`; a file not yet on disk has the size `not created yet` and the note `new file — saving creates it`. `Save` is disabled while a save runs, and a saved file clears its dots. | [file-open.html](../assets/files-view/file-open.html) |
| folded or whole | The bar cycles the lower half. Folded, the reading fills the column and the bar reads `▁`, with `●` when the file holds unsaved edits. Whole, the reading and divider are gone and the bar reads `█`. A type with no reading gives the editor the column with no bar, and a type that is not text reads `Nothing here can edit {mime}.`. | [halves.html](../assets/files-view/halves.html) |
| composite state | The state's board of tasks above its form, the switch in the address and the state inspector in the panel. Choosing a task turns the board into that task's run; walking into a run adds run crumbs and puts the run in the panel. | [composite-state.html](../assets/files-view/composite-state.html) |
| leaf state | The list of its tasks beside the chosen task's conversation, or `Nothing here right now.` and `Select a run to see what it said.`. While that task waits, `Waiting on you — {prompt or component name}` and `Answer` follow the transcript in `--warn` on a `--warn` outline; the conversation column does not scroll, so a transcript taller than the half pushes that line out of sight. | [leaf-state.html](../assets/files-view/leaf-state.html) |
| data readings | The settings file's effective configuration, a data file read as a form, and a form with nothing to draw: `No schema for this document, so there are no fields to draw. Choose one in the editor’s Schema picker, or read it as Data.`. An empty file reads `This file is empty.`, the form reads `Loading the form…` while it loads, and a file that does not parse reads `does not parse: {message} (line {n}, column {n})`. | [data-readings.html](../assets/files-view/data-readings.html) |
| error | Cannot occur as a view of its own: a failed save raises the [error-notice](error-notice.md) and keeps the edits, and settings text that is not JSON reads `not valid JSON: {message}` under the box. | |

## The tree, the address and a board lead here, and every exit keeps the edits

- The sidebar's Files row opens the room at the project the address stands in. `Open state ↗` in a task panel and opening a state from a board or a menu arrive with that state open.
- Clicking a file in the tree opens it; clicking a folder folds or opens it. Right-clicking a row opens its verbs in a [context-menu](../components/context-menu.md), and deleting asks first in [confirm-dialog](confirm-dialog.md). The Files row's `+` offers a new file, folder or workflow, which is named in a row typed into the tree.
- A folder crumb opens that folder and a state crumb opens that state; a chevron lists what else is at that level. A folder row opens the folder, and `↰ ..` goes up.
- On a composite state's board of tasks, a click chooses a task and a double-click follows its path one level down. Double-clicking an execution on a run's board walks into it and puts it on the address.
- `Answer` beside a waiting task selects that task, whose question waits in its conversation.
- Leaving for another room keeps every unsaved edit with its file, marked in the tree, and nothing asks first.

## The halves and the panel keep the sizes they were given

- **Resize.** The panel is 220 to 680px wide, or up to 1200px while a value is pinned, and a double-click restores 300px. The reading is dragged between 80px and the column less 200px, and a double-click restores 320px. When the window shrinks the reading gives way first, down to 80px, and the editor keeps at least 140px.
- **Remembered.** The panel width, the reading's height, the lower half's position and the tree's open folders survive a restart. The tree's filter and a half-typed new name do not.
- **Theme.** Grounds, edges and marks are tokens with a light and a dark value. A half whose type has a palette chosen in Appearance is painted in that palette.
- **Focus.** Arriving moves focus nowhere. The tree's filter field and a new-name row take focus when they appear.
- **Long or missing content.** Crumbs end in an ellipsis at 220px and tree names at the drawer's edge. A state with no label has none in the bar.

## The leaf list sets task names in the app face

- The rows of `Tasks here` and `Recently` draw task names, which are data, in the sans.
