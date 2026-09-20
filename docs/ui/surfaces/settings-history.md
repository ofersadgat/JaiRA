---
id: ui/surfaces/settings-history
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/absence-is-stated]
serves: [product/keep-history-within-bounds, product/pick-up-where-it-left-off]
components: []
mockups: [ui/assets/settings-history/success.html, ui/assets/settings-history/preview.html, ui/assets/settings-history/settled.html, ui/assets/settings-history/loading.html, ui/assets/settings-history/disabled.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-configuration]
---

# Settings history

The History section of the Settings room: how much run history the open project stores, a day count with `Preview` that reports what trimming would delete, and a grey report box that offers `Delete permanently`. It fills the settings column with no layer header above it, is listed only while a project is open, and replaces whichever section was showing.

## The stored counts read first, the trim controls second, and the report last

- **Title.** `Stored history` in the app face at 14/12.5 of the app size, weight 600, with `{tasks} tasks · {events} events · {commands} commands` under it in `--dim` at 11/12.5.
- **Controls.** One wrapping line in `--dim` at 11/12.5: `older than`, a 56px number box starting at `30`, `d`, then a ghost `Preview`, 8px apart.
- **Report.** After a preview or a delete, a box on `--panel-2` with a 1px `--line` border, 8px corners and 8px padding. It stacks its lines 6px apart, each sized to its content at the left: the result sentence in `--dim`, the `Delete permanently` button in `--bad` when a preview found tasks, a `kept {n} unfinished task(s)` line when unfinished tasks were protected, and a ghost `Dismiss`.
- The parts sit 10px apart in one column with no width cap.

## The pane moves from counts, to a preview, to a settled report

| State | Surface shows | Mockup |
| --- | --- | --- |
| success | The counts and the controls, with no report. | [success.html](../assets/settings-history/success.html) |
| preview | A preview found tasks: `would delete the history of {n} task(s): {events} events, {commands} commands`, the red `Delete permanently`, `kept {n} unfinished task(s)` when some were protected, and `Dismiss`. | [preview.html](../assets/settings-history/preview.html) |
| settled | A report with nothing left to confirm, drawn stacked: a preview that found nothing reads `nothing matches — no task history is old enough`, and a delete reads `deleted the history of {n} task(s); {events} events remain` with the counts above already lowered. Both end in `Dismiss`. | [settled.html](../assets/settings-history/settled.html) |
| loading | Right after a project opens and before its counts arrive: `Open a project to see its history.` in `--dim` alone. | [loading.html](../assets/settings-history/loading.html) |
| disabled | While a delete or any other write in the window is in flight: `Preview` and `Delete permanently` at reduced strength and inert. | [disabled.html](../assets/settings-history/disabled.html) |
| empty | Not a look of its own: a project with no history shows `0 tasks · 0 events · 0 commands` in the success look, and every preview settles on `nothing matches`. | |
| error | Not a look of its own: a count, preview or delete that fails is reported by the [error-notice](error-notice.md) and the pane keeps its last look. | |

## Nothing is deleted until the preview's own button is pressed

| On | Does | Feedback |
| --- | --- | --- |
| The number box | Sets the day count; below zero or empty becomes `0` | The box shows the number |
| `Preview` | Works out, without deleting, which task history is older than the count | The report box appears or is replaced |
| `Delete permanently` | Deletes that history at once, with no further confirmation, using the number in the box when pressed | The report turns to the deleted sentence and the counts drop |
| Pointer on `kept {n} unfinished task(s)` | Nothing | A tooltip lists each kept task as `{task id}: {reason}` |
| `Dismiss` | Clears the report | The box goes |

Changing the day count after a preview leaves that preview's report on screen. `Delete permanently` then deletes by the new count, not the previewed one.

## The copy counts what goes and what stays

| Where | String |
| --- | --- |
| Title | `Stored history` · `{tasks} tasks · {events} events · {commands} commands` |
| Controls | `older than` · `d` · `Preview` |
| Report | `would delete the history of {n} task(s): {events} events, {commands} commands` · `nothing matches — no task history is old enough` · `deleted the history of {n} task(s); {events} events remain` · `kept {n} unfinished task(s)` |
| Buttons | `Delete permanently` · `Dismiss` |
| Before the counts arrive | `Open a project to see its history.` |

## A person arrives from the Settings panel with a project open

- The sidebar's Settings panel lists `History` only while a project is open.
- Closing the project while standing here leaves the column blank, with no header and no sentence.
- Choosing another section or room leaves. The day count returns to `30` and the report is kept until dismissed or replaced.

## The controls wrap in a narrow column, and the report sizes to its lines

- Resize: the controls line wraps; the report box spans the column while its lines keep their own width.
- Theme: the report ground, border and `--bad` button are tokens in both themes.
- Focus: nothing takes focus on entry. The order is the number box, `Preview`, then the report's buttons.
- Long content: the sentences are short and fixed apart from their counts; the kept tasks are listed only in the tooltip.

## The pane departs from the direction in its sizes and its plural

- The title and the controls use sizes of their own, 14/12.5 and 11/12.5 of the app size, rather than the registers.
- Counts are written `task(s)` rather than choosing singular or plural.
