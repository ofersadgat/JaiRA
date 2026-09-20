---
id: ui/components/state-inspector
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/schema-driven-form, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/problems-marked-where-they-are, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/absence-is-stated]
serves: [product/try-one-step-on-its-own, product/catch-process-mistakes-before-running, product/work-runs-the-process-it-started-with, product/bring-your-own-models-and-agents, product/see-how-a-process-flows]
surfaces: [ui/surfaces/context-panel, ui/surfaces/files-view, ui/surfaces/tasks-view]
reuses: [ui/components/schema-form]
implemented_by: [packages/app/src/renderer/files.tsx, packages/app/src/renderer/runPanel.tsx, packages/app/src/renderer/runForm.ts, packages/app/src/renderer/board.tsx]
verified_by: [packages/app/test/configPanel.test.ts, packages/app/test/runForm.test.ts]
mockups: [ui/assets/state-inspector/empty.html, ui/assets/state-inspector/success.html, ui/assets/state-inspector/blocked.html, ui/assets/state-inspector/unparsed.html, ui/assets/state-inspector/file-only.html]
siblings: [ui/components/task-panel, ui/components/task-metrics, ui/components/instance-index, ui/components/file-panel]
---

# State inspector

The context panel describing one workflow state: the state's key in bold mono with `· the state`, a `RUN` section with a form of its inputs and a filled Run button, a `HISTORY` list of earlier runs, then uppercase-headed sections for validation, environment, transitions, children, references, dependants and snapshot drift.

## The inspector answers everything about a state that is not in its file

**Use when.** The context panel describes a workflow state: the state file open in the Files view, a column clicked on a Tasks board, or the workflow link in a conversation's gutter. It is where a state is tried on its own and where its wiring, problems and runs are read.

**Do not use when.** The file is not a state, such as a prompt: the panel says only where the file is and what it is. The subject is a task or one run of it: that is [task-panel](task-panel.md) with [task-metrics](task-metrics.md) and [instance-index](instance-index.md).

## Trying the state comes first, then what it has done, then how it is wired

- **Header.** `←` in `--accent` when the panel was asked to describe the state from a conversation, then the last segment of the state id in the data face at 13/12 of its base and weight 600, then `· the state` in `.app-secondary`. The full id is the key's tooltip.
- **Headings.** Each section opens with a bare heading in the app face at 11/12.5 of its base, uppercase with .09em tracking in `--dim`, and a count or note at its right end in `--dim` at weight 400. Sections stand 14px apart; lines inside them 5px.
- **Run.** `runs in {project}` with the project in `--text` at 600. Notices, then the [schema-form](schema-form.md) of the state's declared inputs with keys in the data face; an input wired from elsewhere is listed above the form with its binding in mono and no control. Then the filled `Run` button, and beside it while it is disabled the reason in `.app-secondary`, wrapping.
- **History.** Rows of a status glyph, the task title and, for a run now standing in another state, that state's key, under small uppercase group labels `started here` and `also passed through`. The selected task's row takes `--fill-ghost-selected` at weight 600.
- **Validation.** `lints clean`, or one tinted notice per issue: `--tint-bad` with `--bad` text for an error, `--tint-warn` with `--warn` for a warning, the path in bold, ` — `, the message.
- **Environment.** A grid of `executor`, `from` and `model` in `--dim` against their values in mono, an outlined `available` chip in `--ok` or `not available` in `--bad`, and under it the link `the effective configuration` in `--accent` mono.
- **Wiring.** Transitions as three-column rows between hairlines: the condition in mono, `→` in `--dim`, the target's key in `--accent` with ` ↺` when it goes back. Children as a numbered list in run order with a `composite` chip. References with a green `✓` or red `✗` and the reference in mono. Referenced by with `❏` and the state id in mono. Snapshot drift as an amber notice. A section with nothing to list is left out.

Run and History are left out wherever the panel cannot start a task.

## Every section says whether it is clean, broken or unknown

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | No state to describe: `Select a state.` in `--dim`. | [empty.html](../assets/state-inspector/empty.html) |
| loading | Cannot occur as a look of its own: until the project's tasks are read, History reads `No runs — searched 0 tasks in {project}.` | |
| partial | Cannot occur: a section is drawn whole or left out. | |
| success | A clean state that can run: the form, `Run` enabled with the tooltip `starts {state id} #{n}`, runs in both history groups, `lints clean`, the executor `available`, and the wiring sections. | [success.html](../assets/state-inspector/success.html) |
| blocked | Run refused, with the first reason that applies beside the button, in this order: `select a state to run`, `open a project to run this`, `save this file before running it`, `this file does not parse`, `{n} validation errors — fix them first`, the form's first problem such as `goal: can't be empty`, `checking…`, `busy`. Unsaved edits add an amber `Unsaved edits — the run uses the last saved file.` above the form; issues are listed under Validation; a missing executor reads `not available`; pinned tasks add Snapshot drift. With no runs, History says how many tasks it searched. | [blocked.html](../assets/state-inspector/blocked.html) |
| unparsed | A state file that does not parse: a red `This file does not parse, so its inputs cannot be read.` in place of the form, Run refused, and an issue about `this file`, which is never a link. Drawn at the Tasks view's 360px, reached from a conversation, with the `←`. | [unparsed.html](../assets/state-inspector/unparsed.html) |
| file only | Read with no project open: a neutral `--tint-accent` notice saying what is not known, Validation `not checked`, History `runs through this state · not known without a project`. A shared state still runs, in the shared root. With no executor named, Environment reads `no executor named — inherited or not a function operation`. | [file-only.html](../assets/state-inspector/file-only.html) |

## Run starts the state, an issue points into the editor, and a row opens its task

| On | Does | Feedback |
| --- | --- | --- |
| Edit an input | Holds the value for this state, kept when another file is opened; the form is never disabled, even while a run starts | Problems appear under a box once it has been left; the reason beside Run updates |
| Run | Creates the task `{state id} #{n}` in the project named above the form and starts it | Run disables while busy; the new run heads `started here` |
| A history row | Selects that task in the project that holds it | The row takes the selected ground and the view follows the task |
| An issue with a path, in the Files view | Brings the control it is about into view in the editor beside the panel; elsewhere issues are plain text | The editor scrolls to it and marks it |
| the effective configuration | Holds what a run here resolves against in this panel, headed `{key} · configuration` with a close | The panel swaps to the configuration |
| `←` | Returns the panel to what it described before the conversation's link | The panel changes back |
| Pointer over an issue or a row | Nothing | The issue deepens by 18% of its own colour; the row takes `--fill-ghost-hover` |

## The copy says what the state is, where it runs and why it cannot

| Where | String |
| --- | --- |
| Header | `{key}` · `· the state`; back tooltip `back to what you were reading` |
| Headings | `Run` · `History` · `Validation` · `Environment` · `Transitions` · `Children` · `References` · `Referenced by` · `Snapshot drift`, drawn uppercase |
| Run | count `{n} inputs`, drawn uppercase; `runs in {project}` where `{project}` is `the shared root`, the project's folder name or `this project` |
| Wired input | `bound to {binding}` · `a spread — republished from a child` |
| No inputs | `This state declares no inputs.` |
| Notices | `Unsaved edits — the run uses the last saved file.` · `This file does not parse, so its inputs cannot be read.` |
| Run button | `Run`; tooltip `starts {state id} #{n}`, or the reason |
| Reasons | `select a state to run` · `open a project to run this` · `save this file before running it` · `this file does not parse` · `{n} validation error` or `{n} validation errors` then ` — fix them first` · `{n} problems — {path}: {message}` · `{path}: {message}` · `checking…` · `busy` |
| History | count `{n}`; groups `started here` · `also passed through` · `runs through this state · not known without a project`, tooltip `open a project to see tasks that ran through this state` |
| History empty | `No runs — searched {n} task in {project}.` or `tasks`; tooltip `no task in {project} names '{state id}' as its workflow` |
| History row | `{task title}` · `{key of the state it stands in}`; tooltip `{task id} · {local date and time}` |
| File only | `Read from the file alone, with no project open. Lint results, dependants, drift and runs are not known — open a project to see them.` |
| Validation | count `{n}`; `lints clean` · `not checked`; issue `{path}` or `this file`, then ` — {message}`; tooltip `show the control this is about` |
| Environment | `executor` · `from` · `model`; chips `available` · `not available`; `no executor named — inherited or not a function operation` |
| Configuration link | `the effective configuration`; tooltip `read what a run here resolves against` |
| Transitions | count `{n}`; `{condition}` `→` `{target key}`, with ` ↺` when it goes back |
| Children | note `in run order`, drawn uppercase; chip `composite` |
| Snapshot drift | `{n} task(s) here are pinned to an older snapshot and will not see an edit until they are re-run.` |

## The panel scrolls as one column and wraps sentences, never keys

- The panel is 300px in the Files view and 360px in the Tasks view until dragged; it scrolls as a whole.
- The key, history titles, references and transition columns ellipsise. Notices, issue messages, the Run reason and wired bindings wrap anywhere.
- Theme: tints, chips and badges are tokens with a light and a dark value; severity is also carried by the section's words.
- Focus: `←`, the form's controls, `Run`, each issue that links to a control and the configuration link are in tab order. History rows are pointer only.
- Missing content: a state that names no executor, has no transitions, children, references, dependants or pinned tasks shows only the sections that apply.

## The inspector sets its key and its lists outside the registers

- The key uses a literal 13/12 of the data base instead of `.data-title`.
- Child keys and history task titles are data set in the app face.
- Section headings are bare headings uppercased by the element, not `.app-label`, and `{n} inputs` and `in run order` are uppercased with them.
