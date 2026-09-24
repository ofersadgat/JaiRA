---
id: ui/surfaces/settings-data
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/schema-driven-form, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/absence-is-stated]
serves: [product/read-what-work-produced, product/run-history-travels-with-the-repository, product/keep-history-within-bounds, product/pick-up-where-it-left-off]
components: [ui/components/settings-header, ui/components/settings-field, ui/components/preset-chips, ui/components/schema-form, ui/components/switch]
mockups: []
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-runs, ui/surfaces/settings-files]
---

# Settings data

The Data & history page of the [Settings view](settings-view.md): what a run leaves behind — where the files it produces land, which of its records live in files and which in the database — and, for the project that is open, how much history is stored and what trimming it would delete. The first two sections are layered settings; the last two are the open project's own records.

## Where artifacts land reads first, then how records are stored, then what is stored and what pruning would free

- **Head.** `Data & history`, the lead `Where runs keep what they produce, and how much there is.` followed by the layer sentence, and the [layer switch](../components/settings-header.md) at the head's top-right.
- **Artifacts.** `Destination`, across the row: four [preset-chips](../components/preset-chips.md) over a mono template box and a line of the variables it may use. Then `Artifact directory`, a mono box, and `Keep inline below`, a number.
- **Storage.** `Journal`, `Conversations`, `Tasks` and `Artifact map`, each `file`, `db` or `both`, and `Session line shape`, `claude` or `codex`.
- **Stored history.** Only while a project is open. A sentence under the heading saying these are the open project's records whichever layer the switch is on, then three rows, `Tasks`, `Events` and `Commands`, each with its count in the data face at the right edge.
- **Pruning.** Only while a project is open. `Older than`: a number box starting at `30`, `days`, and a ghost `Preview`. After a preview or a delete, a second row reports it.

Each section is a quiet sentence-case heading with an `ⓘ` over one bordered card, at most 740px wide. Every row in Artifacts and Storage is led by a switch that says whether the layer being edited states it.

## The settings read as stated or inherited, and pruning moves from counts to a preview to a settled report

| State | Surface shows |
| --- | --- |
| stated | A row's switch on: the control is live and edits this layer. |
| inherited | The switch off: the row dimmed, its control inert, showing what it inherits. |
| no project | Artifacts and Storage only, editing the shared root. Stored history and Pruning are not drawn. |
| counts pending | Right after a project opens and before its counts arrive: `Open a project to see its history.` in `--dim` in place of the last two sections. |
| preview | A preview found tasks: a `Would delete` row, `The history of {n} task(s): {events} events, {commands} commands.`, a red `Delete permanently` and a ghost `Dismiss`; an `ⓘ` lists the unfinished tasks kept. |
| settled | A preview that found nothing reads `Nothing matches — no task history is old enough.`; a delete reads `Deleted` and `The history of {n} task(s); {events} events remain.`, with the counts above already lowered. Both end in `Dismiss`. |
| writing | While a change or a delete is in flight: every switch, chip, box, `Preview` and `Delete permanently` at half strength and inert. |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of the sections. A count, preview or delete that fails is reported by the [error-notice](error-notice.md) and the page keeps its last look. |
| empty | Not a look of its own: a project with no history shows three zero counts, and every preview settles on `Nothing matches`. |

| Where | String |
| --- | --- |
| Section heads | `Artifacts` · `Storage` · `Stored history` · `Pruning` |
| Section notes | `Where a file an agent produces actually lands. A path template rather than a mode, because which backend and how the path is derived are independent questions and an enum conflates them.` · `Which run state lives in files and which in the database — files merge in git, SQLite does not.` · Stored history's sentence `This project's own records — they are the open project's whichever layer the switch above is on.` · `An unfinished task is never pruned: it can still be resumed, so its history is kept whatever its age.` |
| Destination | `Destination`, `Pick one, or write a template of your own.`, key `artifacts.destination` · chips `the workspace` · `one directory per task` · `one flat directory` · `memory only` · placeholder `$JAIRA/artifacts/$TASK_ID/$RELPATH` · `Variables: $JAIRA $PROJECT $TASK_ID $RELPATH $ARTIFACT_DIR` |
| Artifact rows | `Artifact directory`, `What $ARTIFACT_DIR expands to, inside the root's system/ directory.`, placeholder `artifacts` · `Keep inline below`, `Content smaller than this rides along in bindings and prompts rather than being read back.` |
| Storage rows | `Journal`, `The engine's event stream.` · `Conversations`, `Every model call and the transcripts they make up.` · `Tasks`, `What was asked for, and where each run of it got to.` · `Artifact map`, `The map from what a producer said it wrote to where the bytes went.` · `Session line shape`, `Which agent's JSONL a file-backed conversation is WRITTEN in.` |
| Stored history | `Tasks`, `Every task this project has kept a record of.` · `Events`, `What its runs recorded, step by step.` · `Commands`, `Every command an agent ran, and what it was told.` |
| Pruning | `Older than`, `Delete the history of finished tasks older than this. Preview first: nothing is deleted until you confirm.` · `days` · `Preview` |
| Report | `Would delete` · `Deleted` · `The history of {n} task(s): {events} events, {commands} commands.` · `Nothing matches — no task history is old enough.` · `The history of {n} task(s); {events} events remain.` · `Kept {n} unfinished task(s): {task id} ({reason}), …` |
| Buttons | `Delete permanently` · `Dismiss` |
| Before the counts arrive | `Open a project to see its history.` |

## Nothing is deleted until the preview's own button is pressed

| On | Does | Feedback |
| --- | --- | --- |
| A destination chip | Writes that destination | The chip fills and the template box shows it |
| A row's switch | On pins the value the row shows into this layer; off removes the key, so it inherits | The row enables, or dims and shows what it inherits |
| Typing in a box, or a choice | Writes the layer as it changes; an emptied box removes the key | Every control disables until the write lands |
| The day count | Sets the cutoff; below zero becomes `0` | The box shows the number |
| `Preview` | Works out, without deleting, which finished tasks' history is older than the cutoff | The report row appears or is replaced |
| `Delete permanently` | Deletes that history at once, with no further confirmation, by the number in the box when pressed | The report reads `Deleted` and the counts drop |
| `Dismiss` | Clears the report | The row goes |

Changing the day count after a preview leaves that preview's report on screen; `Delete permanently` then deletes by the new count.

## A person arrives from the sidebar, and the day count does not outlive the visit

- `Data & history` in the sidebar shows this page, with or without a project open; with none open, the settings are the shared root's and there is no history to show.
- Choosing another page or room leaves. The settings are already written; the day count returns to `30` on the next visit.
- Closing the project while standing here removes the last two sections.

## The page keeps its width cap, and the counts stay in their column

- **Resize.** Sections stop at 740px. A row's control drops under its sentence in a card 380px wide or less; Destination always runs across the row.
- **Theme.** Chips, cards, dimmed rows, the counts and the `--bad` delete button are tokens in both themes.
- **Focus.** Nothing takes focus on entry. The order runs down the page: each row's switch before its control, then the day count, `Preview`, and the report's buttons.
- **Long content.** The unfinished tasks a prune keeps are listed only behind the report's `ⓘ`.

## The page departs from the direction in its plural

- Counts are written `task(s)` rather than choosing singular or plural.
