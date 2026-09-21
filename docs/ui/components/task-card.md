---
id: ui/components/task-card
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/context-beside-what-you-stand-on, ux/patterns/drag-only-where-the-process-allows, ux/patterns/verbs-on-the-thing-itself, ux/patterns/nested-under-what-caused-it]
serves: [product/keep-track-of-everything, product/hand-work-to-agents, product/move-work-on-by-hand, product/large-work-splits-into-independent-pieces]
surfaces: [ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/run-view]
reuses: [ui/components/task-name, ui/components/status-pill]
implemented_by: [packages/app/src/renderer/board.tsx, packages/app/src/renderer/pill.tsx, packages/app/src/renderer/runViews.tsx]
verified_by: [packages/app/test/board.test.ts, packages/app/test/connectDrag.test.ts, packages/app/test/pill.test.ts]
mockups: [ui/assets/task-card/loading.html, ui/assets/task-card/queued.html, ui/assets/task-card/holding.html, ui/assets/task-card/running.html, ui/assets/task-card/waiting.html, ui/assets/task-card/stopped.html, ui/assets/task-card/error.html, ui/assets/task-card/success.html, ui/assets/task-card/selected.html, ui/assets/task-card/adopted.html, ui/assets/task-card/undo.html, ui/assets/task-card/execution.html]
siblings: [ui/components/task-board, ui/components/instance-index, ui/components/conversation-row]
---

# Task card

A borderless rounded tile in a board column: the task's name in mono with a status pill at the far end of the line, and under it a dim mono line naming where the task stands and, at its far end, which kind of waiting or how long ago it ended.

## A task card stands for one task on a board or one pass on a run's board

**Use when.** One task stands in a board column or in the at-this-level tray, or one execution of a declared child stands in a column of a run's board. Both are the same tile; the execution form adds a pass number and the inputs the call was given.

**Do not use when.** The item is a row in a list or a panel, such as a conversation in the sidebar or a state in a run's index: use [conversation-row](conversation-row.md) or [instance-index](instance-index.md). The column, its heading, its lanes and its drop edge belong to [task-board](task-board.md).

## The name reads first, the status second and the place third

- **Head line.** The name in `.data-text`, one line, drawn by [task-name](task-name.md). The [status-pill](status-pill.md) follows it at the far end, carrying a glyph and a word. Live facts are filled with a tint of their own colour, and outcomes are flat.
- **Second line.** Mono at the `.data-secondary` size in `--dim`, 2px under the head: the state id the task stands in, or `queued` before it has one. Its far end holds one word or an age.
- **Ground.** `--fill-ghost-hover`, no border, `--control-radius-sm` corners, 4px between cards. Status never colours the tile itself; the pill carries it.
- **Execution form.** The head shows the state's label, or the child key when the state has no label, and a small outlined pass-number chip after the pill when the column holds more than one pass. Under the head, a state with no label lists up to two inputs as dim mono lines, then `+{n} more`. The second line reads `running`, the duration, or the start time, and its far end is the raw status in words.

## Every state keeps the same two lines and changes the pill and the far end

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a card exists only for a task or an execution, and an empty column is drawn by the board as `—` or `not reached`. | |
| loading | The task's computed title is still settling, so the declaring state's label stands in, italic in `--dim`. Pill and second line draw as usual. | [loading.html](../assets/task-card/loading.html) |
| partial | Cannot occur: a card draws its name and its second line whole or not at all. | |
| queued | No pill, because nothing has happened. Second line `queued`. | [queued.html](../assets/task-card/queued.html) |
| holding | A queued task that waits for other tasks to finish: no pill, `queued`, far end `holding`. Its tooltip names the tasks it waits for. | [holding.html](../assets/task-card/holding.html) |
| running | Filled `--accent` pill `▶ running`; second line is the active state id. | [running.html](../assets/task-card/running.html) |
| waiting | Filled `--warn` pill `⏸ waiting`. Far end `gate` when the active state waits on a person, `blocked` when the run cannot go on with the inputs it was given. | [waiting.html](../assets/task-card/waiting.html) |
| stopped | Flat `--warn` pill `⚠ stopped` for an interrupted or canceled task; far end is the age. | [stopped.html](../assets/task-card/stopped.html) |
| error | Flat `--bad` pill `⛔ failed` for a failed or timed-out task; far end is the age. No reason is shown on the card. | [error.html](../assets/task-card/error.html) |
| success | Flat `--ok` pill `✓ done`; far end is the age, which becomes a date from seven days on. | [success.html](../assets/task-card/success.html) |
| selected | Ground `--tint-accent` and the name at weight 600. On the Tasks view several cards can be selected at once, each tinted. | [selected.html](../assets/task-card/selected.html) |
| adopted | A task another task took up as one of its children: drawn under that task's card, 14px in, with a 2px left edge of `--accent` mixed into `--line`. Its second line reads `adopted · {the state it ran}`; pill and far end as usual. It cannot be picked up: it moves with the task above it. | [adopted.html](../assets/task-card/adopted.html) |
| undo | A task a drop has just made or moved: the far end of its second line is the link `Undo`, in place of the word or the age, until it is used or the app closes. | [undo.html](../assets/task-card/undo.html) |
| execution | One pass of a state on a run's board: the pass chip, the inputs, the duration and the raw status. Passes stack oldest first. | [execution.html](../assets/task-card/execution.html) |

## A single click describes the card and a double click enters it

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over | Nothing | Ground deepens to `--fill-ghost-selected` |
| Click | Selects the card; the context panel describes that task or execution | `--tint-accent` ground, name at 600 |
| Ctrl-click or Cmd-click, Tasks view | Adds the card to the selection or takes it out | Every chosen card tinted; the panel follows the last card touched |
| Shift-click, Tasks view | Selects every card from the anchor to this one in the order the board draws them | The range tinted |
| Double-click | Tasks view: opens that run on the address. Files view: goes one level down the task's own path. Run board: walks into that execution | The address extends |
| Right-click, Tasks view | Opens the card's verbs in a [context-menu](context-menu.md) | Menu at the pointer |
| Drag, when a waiting transition offers this task a move, or on the Tasks view when the task stands somewhere | Picks the card up; the board marks the columns that would take it | Cursor `grab`, then `grabbing` |
| Click `Undo` | Takes back the move that made or moved this task; the click neither selects nor opens the card | The board redraws |
| Drop on a column that takes it | Asks the waiting process to make the move | The card appears in the new column once the process has moved it |

## The copy is the status in one word and the place in data

| Where | String |
| --- | --- |
| Pill | `▶ running` · `⏸ waiting` · `⛔ failed` · `⚠ stopped` · `✓ done` |
| Pill tooltip | `{status}`, the raw status such as `waiting_for_user` or `timeout` |
| Second line | `{state id}` or `queued` |
| Far end, parked | `gate` · `blocked` · `holding` |
| Far end, ended | `just now` · `1 second ago` · `{n} seconds ago`, likewise minute, hour and day · `{Mon D}` from seven days · `{Mon D, YYYY}` for another year |
| Far end tooltip, ended | `{local date and time}` |
| Far end tooltip, holding | `waiting for {title}, {title}` then ` and {n} more` |
| Card tooltip | `{status} · {local date and time}` once ended, else `double-click to open this run` where a double-click goes somewhere, else `{state id}` or `{status}` |
| Execution second line | `running` · `{duration}` such as `2 m 41 s` · `{start time}`; far end `{status}` with spaces, such as `waiting for user` |
| Execution inputs | `{input} {preview}` for two inputs, then `+{n} more` |
| Execution tooltip | `{state id} · {start} — double-click to walk in` |

## The card takes its column's width and gives up the name first

- Width is the column's, between 210 and 320px; in the at-this-level tray every card is 210px and they wrap in rows.
- The pill and the far-end word never shrink. The name and the state id ellipsise, and no tooltip carries a cut name in full; the context panel shows it whole.
- Text on a card cannot be selected, so a press on the name never starts a text selection.
- Theme: ground, tint and pill colours are tokens, and a pill's fill is mixed from its own colour, so both themes keep the pair matched.
- Focus: a card is not a tab stop and takes no keys. Selecting, opening, the verbs and the move are pointer gestures; the context panel's buttons are the keyboard route.

## The status words and the second line's words are app words set in the data face

- `running`, `waiting`, `failed`, `stopped`, `done`, `queued`, `gate`, `blocked` and `holding` are JaiRA's words drawn in mono, because a column of pills and second lines is read down like figures.
