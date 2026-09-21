---
id: ui/surfaces/debug-view
type: ui-surface
status: shipped
updated: 2026-09-21
kind: screen
realizes: [ux/patterns/checked-status-with-the-fix, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/absence-is-stated, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/stream-then-settle]
serves: [product/find-out-why-the-app-misbehaves, product/try-a-process-without-spending, product/failures-explain-themselves]
components: [ui/components/task-panel]
mockups: [ui/assets/debug-view/first-run.html, ui/assets/debug-view/warned.html, ui/assets/debug-view/running.html, ui/assets/debug-view/ended.html]
siblings: [ui/surfaces/app-window, ui/surfaces/sidebar, ui/surfaces/logs-view, ui/surfaces/components-view, ui/surfaces/settings-view, ui/surfaces/files-view]
---

# Debug view

The Debug room: a scrolling page that runs the two-state self-test JaiRA ships, recording the run in the shared root, and lays its verdict beside the evidence, with the self-test's task described in a 360px column on the right. It fills the window right of the [sidebar](sidebar.md), whose settings sheet stays over the sidebar column while it shows, and takes the place of every other room. The two columns have no divider and cannot be resized, and the title bar above them holds only the empty filler.

## The heading reads first, then four steps down the page, and the task beside them

The left column is on `--bg` with 12px by 14px padding and 16px between sections. Each section opens with an uppercase `--dim` caption and keeps 8px between its parts.

- **Heading.** `Workflow self-test` bold at 15/12.5 of the app base, over a `--dim` paragraph at most 70 characters wide saying what a pass proves, with `and` in italic.
- **What it runs.** A numbered list of the two states, each a state id in the data face followed straight on, with no space, by an app sentence in `--dim` whose value names are in the data face. Under it a disclosure in `--dim`, `The state files, as they load`, which opens to the path of each copy that loads over its JSON in a box on `--bg` with a 1px `--line` edge and 8px corners.
- **Where it comes from.** An accent-washed notice saying the self-test ships with JaiRA and that a copy in `~/.jaira` wins over it. Then one row per state: a 7px dot, the state id in the data face with the loading copy's path as its tooltip, a hairline pill naming the layer that copy is in, `built in`, `overridden`, `old copy` or `missing`, and `open ↗` in `--accent`; pointing at a row gives it a `--panel-2` ground. Then the ghost button `Re-check`, preceded by `Delete the old copy…` while a row reads `old copy`.
- **Run it.** One readiness notice, then the buttons `Run (live LLM)`, bordered on `--panel-2`, and ghost `Run scripted`, `New task` and `Cancel`.
- **Result.** Once a self-test has started: a band with 10px by 12px padding and the card radius holding the task's status glyph, the verdict word bold at 18/12.5 of the app base with 0.06em tracking, and the run's outcome in `--dim`. Under it `the greeting` and `the judgement`, each an uppercase `--dim` label over its value in a boxed data block, when the run published them, and the run's failure as boxed JSON when it has one.
- **What was actually said.** A 320px box with a 1px `--line` edge and 8px corners, split into a 200px list of the states that called a model, each with a status dot and its cost, and the chosen state's calls: a head line with the state id, its dot and cost, then each message under an uppercase `--dim` role word, its text in the data face at 11/12 keeping its line breaks. An answer still arriving is a last message under `writing` in `--accent` with a blinking caret. Tool calls inside a message are closed disclosures naming the tool.
- **Journal.** The task's journal as a caption `Conversation · {task title}` with `{n} turns` at its right, then one line per turn: a right-aligned uppercase role word in `--dim` in a 62px gutter, the state id in `--accent` data type, the text, and any value as `--dim` JSON. An output turn is `--ok`; a failed turn and a policy turn read in `--bad`.
- **Right column.** On `--panel` with a `--line` left edge and 13px padding: the [task-panel](../components/task-panel.md) for the self-test's task, with its instances, live events and outputs, or `Run the self-test to see its task here.` in `--dim`.

| Where | String |
| --- | --- |
| Heading | `Workflow self-test` · `Two prompt states run in sequence. The first is asked to say hello world; the second takes what it said as a declared input and reports whether it did. A pass means the model answered and that its output was validated, bound and carried into the next state.` |
| Captions | `What it runs` · `Where it comes from` · `Run it` · `Result` · `What was actually said` · `Journal` |
| Stages | `debug/hello_world/say` `asks for the greeting, publishes it as ` `greeting: string` · `debug/hello_world/check` `reads ` `.children.say.output.greeting` `, publishes ` `passed: boolean` ` and ` `verdict: string` |
| Disclosure | `The state files, as they load`; each file named by the path of the copy that loads |
| Source notice | `The self-test ships with JaiRA, so there is nothing to install and it runs with nothing in the shared root. A copy of one of its states in ~/.jaira wins over the built-in one, as an override of any built-in does.` |
| File rows | `built in` · `overridden` · `old copy` · `missing` · `open ↗` |
| Overridden notice | `One state loads from the shared root instead of from what ships, and a run uses what loads.`, or `{n} states load`; then `It is`, `They are`, `{n} of them is` or `{n} of them are`, and ` identical to what JaiRA itself installed there.` when a row reads `old copy` |
| Missing notice | `One state was found in no layer, so the run cannot start. The built-in layer is missing from this build.`, or `{n} states were` |
| Buttons | `Delete the old copy…` or `Delete {n} old copies…` · `Re-check` · `Run (live LLM)` · `Run scripted` · `New task` · `Cancel` |
| Button tooltips | `Replaces the model with canned replies — exercises everything except the provider` · `A new task, rather than another run on the last one` |
| Readiness | `Nothing has been checked yet, so a live run may find no provider. The scripted run needs none.` · `Nothing here reported healthy, so a live run will probably fail to find a model — see Settings › Providers. The scripted run needs none, and is the better first test anyway.` · `A live run goes to whatever models.default resolves to. Reported healthy: {names}.` |
| No project | `No project is open. A task belongs to a checkout, so open one from Settings before running.` |
| Result | `Started — no run has settled yet.` · `PASS` · `FAIL` · `NO VERDICT` · `{outcome}` · `the greeting` · `the judgement` |
| No verdict notice | `The run settled without publishing a verdict — look at the instance tree and the events beside it for where it stopped.` |
| Calls box | `States` · `{n}` · `${cost}` · `sent` · `reply` · `system` · `tool` · `writing` · `No model call yet.` · `Select a task to see what it ran.` |
| Journal | `Conversation · {task title}` · `{n} turns` · `state` · `tool` · `output` · `policy` · `waiting` · `failed` · `blocked` · `→` · `This task has not run yet.` |

## The page grows from the checks down to the verdict as the self-test runs

| State | Surface shows | Mockup |
| --- | --- | --- |
| first_run | Nothing run from this window: the four steps with every state `built in` on a green dot, `New task` and `Cancel` at half opacity, a readiness notice, and `Run the self-test to see its task here.` on the right. | [first-run.html](../assets/debug-view/first-run.html) |
| warned | Whatever stands in the way, said where it applies. An `overridden` or `old copy` state on a `--dim` dot adds the amber overridden notice, and `old copy` adds the delete button; a `missing` state on a `--bad` dot adds a `--bad` notice and disables its own `open ↗`. With no check reported, or none healthy, the readiness notice is amber. Standing at the root with no project, the amber no-project notice appears and every run button is at half opacity. A failed run adds its message on a `--bad` wash under the buttons. | [warned.html](../assets/debug-view/warned.html) |
| loading | Looks like running with fewer parts: while a run is being started, the delete, re-check and run buttons are at half opacity, and `Started — no run has settled yet.` in `--dim` stands under `Result` in place of the band until the run's first record arrives. | [running.html](../assets/debug-view/running.html) |
| running | The run buttons are at half opacity and `Cancel` is live. The band is amber `NO VERDICT` with `▶` and `running`, because nothing is published until the run settles. The calls box follows the state being called and the journal and the task panel grow as events arrive. | [running.html](../assets/debug-view/running.html) |
| ended | The band names the verdict: green `PASS` only when the check published a literal true, red `FAIL` when it published false, amber `NO VERDICT` otherwise, with the amber notice and the failure JSON once the run has settled. Three are drawn stacked. | [ended.html](../assets/debug-view/ended.html) |
| empty | Cannot occur: the heading, the steps and the three file rows are always drawn. | |
| elsewhere | A task chosen in another room takes the selection, so `Result`, the calls box and the journal leave the page and the right column returns to its empty line. They come back when the self-test is run again. | [first-run.html](../assets/debug-view/first-run.html) |

## A person arrives from the settings sheet, runs the test here, and leaves for the state files

- `⌁ Debug` at the foot of the sidebar's settings sheet opens the room and reads the three files' status again. Debug is lit in the sheet.
- `Run (live LLM)` reads again which copies load, writes no file, then runs again on the last self-test task, or creates `Self-test (live)` in the shared root when there is none. `Run scripted` does the same with canned replies, and a task it creates is `Self-test (scripted)`. `New task` always creates a fresh task.
- `Re-check` reads again which copy of each state loads. `Delete the old copy…` asks in a [confirm-dialog](confirm-dialog.md) naming each file, and on yes deletes the shared-root copies that are still identical to a version JaiRA shipped, so those states load from what ships. A failure notice goes away when it is clicked.
- `Cancel` stops the self-test's task.
- `open ↗` on a file row, or `Open state ↗` in the task panel, leaves for the [files view](files-view.md) with the copy of that state that loads open, read-only when it is the shipped one.
- A section, `Logs` or `Components` in the settings sheet leaves for that room, and `‹` leaves for the room shown before Settings.

## The page scrolls as one column, and the self-test outlives leaving the room

- **Resize.** The right column stays 360px and the page takes the rest. Notices and the heading's paragraph wrap; a long state id in a row ends in an ellipsis, and the row's tooltip is the path of the copy that loads. The calls box stays 320px tall and both of its halves scroll on their own.
- **Theme.** Washes, bands, dots and boxes are tokens with a light and a dark value.
- **Focus.** Entering moves focus nowhere. Tab follows the page: the disclosure, each `open ↗`, the delete and re-check buttons, the run buttons, the failure notice, then the task panel's buttons. A button at half opacity takes no focus. The state rows in the calls box take a pointer only.
- **Long or missing content.** A long state id in the calls list ends in an ellipsis. A missing greeting or judgement leaves its field out.
- **Unsaved work.** None. A self-test keeps running when the room is left, and returning shows it again while it is still the selected task.

## The page departs from the visual direction in three places

- The file paths in the disclosure, the state ids in the calls box and the task title in the journal caption are data set in the app face.
- The journal caption uppercases the task's title.
- The role words and captions take the label's size and case at their own weight and tracking, not `.app-label`.
