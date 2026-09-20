---
id: ui/surfaces/context-panel
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/drill-in-and-back-out, ux/patterns/absence-is-stated, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/complete-record-of-every-run, product/know-what-work-costs, product/read-what-work-produced, product/work-runs-the-process-it-started-with, product/author-processes-without-memorising-the-format, product/try-one-step-on-its-own]
components: [ui/components/splitter, ui/components/icon, ui/components/value-view, ui/components/state-inspector, ui/components/task-metrics, ui/components/task-panel, ui/components/workflow-editor, ui/components/editor-chrome, ui/components/run-value-field]
mockups: [ui/assets/context-panel/absent.html, ui/assets/context-panel/file.html, ui/assets/context-panel/run.html, ui/assets/context-panel/task.html, ui/assets/context-panel/holding-value.html, ui/assets/context-panel/holding-surface.html]
siblings: [ui/surfaces/app-window, ui/surfaces/task-context, ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/chat-view, ui/surfaces/run-view]
---

# Context panel

The column at the right of the Files and Tasks rooms, and of Chat while it holds something, on `--panel` with a 1px `--line` left edge and 13px padding: it describes the last thing the person stood on, or holds one value they pinned there. It sits across a [splitter](../components/splitter.md) from the room's middle column and never replaces it.

## One rule picks what the panel describes, and a pinned value outranks the rule

| Room | First match wins |
| --- | --- |
| Files | A pinned value · the state behind a conversation, when its link was followed, with `←` · the task, when asked for from a run · the run the address ends on · the folder the address ends on · the open file, which for a state file is the [state-inspector](../components/state-inspector.md) |
| Tasks | A pinned value · the board column last clicked, as the state-inspector · the selected task, as the [task context](task-context.md) · `Select a task.` |
| Chat | A pinned value; with nothing pinned the panel is absent and Chat is one column |

## Every description opens with the thing's name and what kind of thing it is

- **Heading.** The name in mono at weight 600, then `· the file`, `· the folder`, `· the run` or `· the task` in `.sub`. A `←` link in `--accent` before the name goes back to where the description came from. A run's heading ends with `the task ↗` at the far right.
- **Sections.** 14px apart. A section heading is uppercase `--dim` with a count or a chip at its far end. Facts are key and value rows on a 72px key column in `--dim`, with values in `--text` and code values in mono.
- **File.** `path`, `layer` as `this project` or `shared`, `type`, and `size` as `{n} characters` or `not created yet`, then the absolute path in `.sub` on one line, cut from the front so the file name stays.
- **Folder.** `path`, `/` at a layer's root, `layer`, and `holds` as `{n} folders` or `no folders`, `, {n} files`, then ` · {n} states` in `.sub`, then the absolute folder path. A layer's root is named `.jaira` or `~/.jaira`.
- **Run.** A `This run` section headed by a status chip in words, `--ok` for completed, `--bad` for failed and `--warn` for anything else, such as `waiting for user`. Rows: `state` as an accent link, `started` as a local time, `took` once it ended, one row per input the run was called with, and `config` linking `the effective configuration`. Then [task-metrics](../components/task-metrics.md) for that run alone and the [task-panel](../components/task-panel.md) of the task it belongs to.
- **Task.** Task metrics for the whole task, then `States it ran` with its count: one row per pass in run order, the state id in mono and the pass's cost to three places, such as `$0.412`. The pass the middle column is showing takes `--fill-ghost-selected` at weight 600. The status mark on each row is not drawn and the cost is plain text. Then the task panel.

## A pinned value takes the whole column under a header that stays put

- **Header.** The value's title at weight 600, ending in an ellipsis with the full title on its tooltip, and a 14px `✕` in `--dim` at the far end that turns `--text` on `--panel-2` when pointed at. A `--line` rule sits below.
- **Value.** A [value-view](../components/value-view.md) with its reading switch, padded 10px; a web page or an editor runs full bleed. The body scrolls on its own and the column's padding goes.
- **State configuration.** Pinned by clicking a child box on a workflow's Graph tab. The title is the full state id, `Open in the editor` sits at the top right, and under it the [workflow-editor](../components/workflow-editor.md) with Form and JSON tabs only, unsaved edits of its own, and the [editor-chrome](../components/editor-chrome.md) Save row. Every part keeps a 460px minimum, so a narrower column scrolls sideways. Clicking an entry, exit, operation or any box pins a plain value of its JSON titled `Entry`, `Exit`, `operation` or `any`; outcome boxes and missing states pin nothing.
- **Effective configuration.** Pinned from `the effective configuration` on a run, a state or a state file; from a state file it reads the file on disk. The title is `{state name} · configuration`. A gutter line holds the state id, where the file came from and `open ↗`, over the workflow editor as a reading with Form, JSON and Graph tabs: boxes lose their borders, empty fields and sections are left out, nothing can be saved, and when a run is behind it the values that run produced sit in [run-value-field](../components/run-value-field.md) boxes under their rows.

| Where | String |
| --- | --- |
| State configuration | `Reading {state id}…` · `Nothing under either root defines {state id}.` · `{path} · new file` · `new file — saving creates it` · `shared copy` · `fix the JSON before saving` |
| Effective configuration | `Reading the state…` · `That state's configuration could not be read.` · `The workflow that ran has no state called {state id}.` |
| Where the file came from | `the file this run pinned` · `as it stands on disk now` · in `--warn`, `the workflow has changed since this run — this is the file as it stands now` |
| Tooltips | `←` `back to the run above` · `back to the state` · `Back to {state id}` · `Back`; `the task ↗` `describe the task this run belongs to`; state link `open its file`; config link `read what this run resolves against`; pass row `open {state id} and read this run's pass through it`; `✕` `Close this and give the panel back` |

## Every state describes one thing, holds one value, or says in one dim line why it cannot

| State | Surface shows | Mockup |
| --- | --- | --- |
| absent | Empty, loading and error look alike: one line in `--dim` at the top of the panel. `Select a task.` in Tasks and `Select a file.` in Files before anything is chosen; `Reading the run…` under the run heading while it loads; `That run is no longer in this task — it was re-run.` for a run replaced by a re-run; `no task` and `That task could not be read.` | [absent.html](../assets/context-panel/absent.html) |
| file | The file or folder the address ends on, as a short list of facts over its absolute path. | [file.html](../assets/context-panel/file.html) |
| run | The run the address ends on, its metrics, and its task's panel. | [run.html](../assets/context-panel/run.html) |
| task | The task asked for from a run, its metrics, every pass it made, and its panel. | [task.html](../assets/context-panel/task.html) |
| holding-value | A value pinned from its `…` menu, over any description, in Files, Tasks and Chat alike. | [holding-value.html](../assets/context-panel/holding-value.html) |
| holding-surface | A state's configuration with unsaved changes, and a run's configuration read against a workflow that has changed since. | [holding-surface.html](../assets/context-panel/holding-surface.html) |

## The panel follows where the person stands, and every link in it has a way back

- In Files and Tasks the panel is always there; its content changes with the address, a click on a card or a column, and the links inside it.
- `Open in context panel` in a value's `…` menu pins that value, and it stays through changes of room and address. Pinning another replaces it, and `✕` hands the panel back to its rule or, in Chat, removes it.
- On a run, `←` steps the address back one level and `the task ↗` describes the task; the task's `←` returns to the description it came from. The state link opens that state's file in Files, and `the effective configuration` pins the run's configuration.
- A row of `States it ran` opens that state's file with that pass's conversation beside it and the run on the address.
- `Open in the editor` and `open ↗` open the state's file in Files, and the pin stays until it is closed.

## The panel keeps its dragged width per room, and a pin's unsaved edits go when the pin does

- **Resize.** The splitter drags the panel between 220 and 680px in Files and between 260 and 760px in Tasks, defaults 300 and 360, and up to 1200px while a value is pinned; a pinned configuration never draws narrower than 480px there. In Chat it drags between 280 and 1200px from 420. A double click resets it, and each room remembers its own width.
- **Long content.** Names, state ids and input previews end in an ellipsis, with the whole text on a tooltip for previews and pinned titles. The file heading's name is never cut. Absolute paths are cut from the front.
- **Theme.** Grounds, rules, chips and links are tokens with a light and a dark value.
- **Focus.** Links, buttons and editor fields are in reading order. The rows of `States it ran` take no focus, so they need a pointer, and the `✕` is named only by its tooltip.
- **Unsaved work.** A pinned state configuration keeps its unsaved edits apart from the file's. Closing the pin or pinning anything else discards them without a prompt, and no pin survives a restart.

## The panel departs from the visual direction in three places

- A pinned value's title and a configuration's state id are data set in the app face.
- A run's input names, a file's character count and a folder's counts are data set in the app face.
- The pass on screen in `States it ran` is marked with the ghost fill and weight, not the accent tint.
