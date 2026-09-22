---
id: ui/components/workflow-editor
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/one-document-several-readings, ux/patterns/draft-belongs-to-the-file, ux/patterns/problems-marked-where-they-are, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/inherited-unless-set-here]
serves: [product/author-processes-without-memorising-the-format, product/see-how-a-process-flows, product/share-processes-across-projects, product/complete-record-of-every-run, product/work-runs-the-process-it-started-with]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel, ui/surfaces/settings-appearance]
reuses: [ui/components/state-form, ui/components/schema-json-editor, ui/components/state-graph, ui/components/editor-chrome, ui/components/issue-mark]
implemented_by: [packages/app/src/renderer/stateEditor.tsx, packages/app/src/renderer/builtIn.tsx, packages/app/src/renderer/reading.ts]
verified_by: [packages/app/test/configPanel.test.ts, packages/app/test/childBindings.test.ts, packages/app/test/builtInStates.test.ts]
mockups: [ui/assets/workflow-editor/success.html, ui/assets/workflow-editor/new-file.html, ui/assets/workflow-editor/json.html, ui/assets/workflow-editor/graph.html, ui/assets/workflow-editor/error.html, ui/assets/workflow-editor/reading.html, ui/assets/workflow-editor/built-in.html]
siblings: [ui/components/file-panel, ui/components/schema-json-editor, ui/components/state-inspector, ui/components/schema-form]
---

# Workflow editor

One state file's editing surface: a quiet top line with the file's path cut from the front, an amber `shared copy` chip on the shared layer and a `Form | JSON | Graph` switch at its far end, over the chosen reading, with `Save` and `Revert` pinned at the foot.

## The workflow editor is the one surface for a state file, whether it is being written or read

**Use when.** A single state file is open: in the Files view's Configuration half, as a state's configuration pinned in the context panel from a box on a graph, as the configuration a run resolved against, or as the preview of the state file type in Settings › Appearance.

**Do not use when.** The document is JSON that is not a state: use [schema-json-editor](schema-json-editor.md) on its own. The question is what a state is doing or has done, rather than what it declares: use [state-inspector](state-inspector.md) beside it.

## The top line says which file, the switch says which reading, and the body holds that reading

- **Path.** `.app-secondary` in `--dim`, one line, ending in ` · new file` while the file is not on disk. A long path loses its start, so the file name stays in view; the whole path is its tooltip.
- **Shared copy.** A pill chip with a 1px `--warn` border and `--warn` text at ×0.80, shown when the file is the copy every project shares. Its tooltip says what editing it does.
- **Layer.** Where JaiRA ships a state of this id, the chip says which side of that the file is on and link buttons in `--accent` data type follow it. A shipped file: a hairline `built in · read-only` chip, then `Override for all projects` and `Override here`, and its path reads `$SYSTEM/workflows/{id}.json` with the real path as the tooltip. A file that overrides one: `overrides built in`, hairline in a project and `--warn` in the shared root, then `Compare with what ships`. The chip and links never shrink or wrap.
- **Switch.** Three joined buttons at ×0.88 of the app size, 2px by 11px padding. The chosen one is filled `--fill-accent` with `--on-accent` text at weight 600; the others are ghost buttons. The path grows to fill the line; the chip and the switch never shrink.
- **Body.** Form draws the [state-form](state-form.md), which scrolls on its own. JSON draws the [schema-json-editor](schema-json-editor.md) with `Workflow state` chosen as its schema and no Save row of its own. Graph draws the [state-graph](state-graph.md) filling the body.
- **Foot.** The [editor-chrome](editor-chrome.md) row, pinned under the body on every tab.

The Files view and a run's configuration offer all three readings. A configuration pinned from a graph offers Form and JSON, and keeps the whole editor at least 460px wide, scrolling sideways in a narrower panel.

## Every state is a reading of the same document, saved, unsaved, unreadable or read-only

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look of its own: a state file that does not exist yet is the new file state. | |
| new file | The path ends ` · new file`; the form holds nothing but its empty sentences; `Save` and `Revert` are enabled before any typing, followed by `unsaved changes` and `new file — saving creates it`. | [new-file.html](../assets/workflow-editor/new-file.html) |
| loading | Cannot occur: the document arrives with the file. The JSON tab's verdict chip reads `checking…` until its first check answers. | |
| partial | Cannot occur as a look of its own: parts the form cannot hold are drawn read-only inside the form, as the state form shows. | |
| success | The Form tab over a saved file: `Save` and `Revert` dimmed and nothing beside them. On the shared layer the chip sits between the path and the switch. | [success.html](../assets/workflow-editor/success.html) |
| json | The JSON tab: the schema line, the coloured text and its verdict. An edit on either editing tab is one edit to the same document, so the foot reads `unsaved changes` on both. | [json.html](../assets/workflow-editor/json.html) |
| graph | The Graph tab: the legend and zoom line over the picture. The foot stays, because the picture draws the unsaved text. | [graph.html](../assets/workflow-editor/graph.html) |
| built in | A shipped file: the form is the inert reading, the JSON tab is the document as read-only text, and there is no foot. An override that a layer already holds is at half opacity, and `Override here` is too with no project open. Over a file that overrides a shipped one, `Compare with what ships` replaces the body with a side-by-side read-only diff, shipped on the left, and reads `Back to the file` while it shows. | [built-in.html](../assets/workflow-editor/built-in.html) |
| error | The text does not parse. Form and Graph each give one `--bad` sentence naming the parse error and the JSON tab as the place to fix it. The JSON tab keeps the text editable, its chip reads `not JSON` and a `--bad` line gives the parse error. `Save` is dimmed beside `fix the JSON before saving`. | [error.html](../assets/workflow-editor/error.html) |
| reading | A run's configuration or a type preview: no foot row at all; the switch stays live; the form refuses input and loses its box borders; the JSON tab is a plain read-only document filling the body, with no schema line. | [reading.html](../assets/workflow-editor/reading.html) |

## The switch changes the reading, and every editing reading writes the one document

| On | Does | Feedback |
| --- | --- | --- |
| Click `Form`, `JSON` or `Graph` | Draws that reading of the current text; the Files view remembers the tab per file and opens a new file on the last tab chosen; a host without the remembered tab shows Form | The chosen button fills |
| Return to Form from JSON | Reads the text into the form again | The fields show the text's edits |
| Edit any field on Form | Rewrites the whole document as JSON indented two spaces | `unsaved changes`, and the file's row in the tree is marked |
| Click `Save` | Writes the text; the Files view checks the processes again from the saved file | `Save` dims while writing, then the foot returns to clean |
| Click `Revert` | Puts the saved text back and redraws the form from it | The phrase goes |
| Choose a problem in the state inspector | Switches to Form, opens any fold hiding the box, scrolls it to the middle and washes it | An `--accent` wash for one second, then the box's issue border stays |

There are no keys for switching tabs or saving.

## The copy names the three readings and says what editing the shared copy reaches

| Where | String |
| --- | --- |
| Switch | `Form` · `JSON` · `Graph` |
| Switch tooltips | `the fields, as controls` · `the document, as text` · `what runs after what, and what makes it` |
| Path | `{path}`, then ` · new file` when it is not on disk |
| Chip | `shared copy` · tooltip `Editing the shared copy. Every project that has not overridden this state will see the change.` |
| Built-in chip | `built in · read-only` · tooltip `This file ships with JaiRA and cannot be edited. Override it to change what runs.` |
| Override links | `Override for all projects` · `Override here`; tooltips `Copy this file into the shared root (~/.jaira) and open the copy` · `Copy this file into this project's .jaira/ and open the copy` · `The shared root already has a copy of this state, and it is the one that loads` · `This project already has a copy of this state, and it is the one that loads` · `Open a project to override this state for it alone` |
| Override chip | `overrides built in`; tooltips `The shared copy of a state JaiRA ships. Every project that has not overridden it runs this file.` · `This project's copy of a state JaiRA ships. It runs here instead of the built-in one.` |
| Compare | `Compare with what ships` · `Back to the file`; while reading `reading what ships…`; `The built-in file could not be read.` |
| Form, unreadable | `This file is not valid JSON ({message}) — fix it on the JSON tab to use the form.` |
| Graph, unreadable | `This file is not valid JSON ({message}) — fix it on the JSON tab to see the graph.` |
| JSON, unreadable | `not JSON` · `not valid JSON: {message}` |
| Foot | `Save` · `Revert` · `unsaved changes` · `fix the JSON before saving` · `new file — saving creates it` |

## The top line keeps its facts on one row, and an unsaved edit stays with the file

- **Resize.** The path shrinks first, losing its start. The body takes every pixel between the top line and the foot; the form and the JSON text scroll inside it, and the graph pans.
- **Theme.** The top line and foot use the window's tokens. The JSON text takes the palette chosen for state files, and nothing outside it changes.
- **Focus.** Tab goes to the three switch buttons, then into the body, then `Save` and `Revert`. The path and chip take no focus.
- **Long or missing content.** The path's tooltip carries it whole. A document too long for the body scrolls there, never the page around it.
- **Unsaved work.** In the Files view the unsaved edit and the chosen tab belong to the file, survive opening other files, and last while the app is open. A configuration pinned from a graph holds its own unsaved edit, and closing the pin discards it without asking. The first form edit reformats the whole file.

## The editor departs from the visual direction in two places

- The file path is data set in the app face.
- The middle button of the switch has square corners and does not overlap its left neighbour, so a doubled border shows between `Form` and `JSON`.
