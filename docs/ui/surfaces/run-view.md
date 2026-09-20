---
id: ui/surfaces/run-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/drill-in-and-back-out, ux/patterns/context-beside-what-you-stand-on, ux/patterns/drag-only-where-the-process-allows, ux/patterns/one-document-several-readings, ux/patterns/absence-is-stated]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/move-work-on-by-hand, product/keep-track-of-everything]
components: [ui/components/address-bar, ui/components/segmented-control, ui/components/task-board, ui/components/task-card]
mockups: [ui/assets/run-view/empty.html, ui/assets/run-view/board.html, ui/assets/run-view/conversation.html]
siblings: [ui/surfaces/run-conversation, ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/task-context]
---

# Run view

One run read in the middle column, either as a board of the executions under it or as its conversation, chosen by a `Tasks` and `Conversation` switch in the title bar. In the Tasks room it replaces the project boards once a run is on the address; in the Files room it is the upper half of a composite state's file. The context panel stays beside it.

## The address names the run and the switch says how it is read

- **Title bar.** The [address-bar](../components/address-bar.md) ends in one crumb per run walked into, in the app face after a dim `▸`, the last on `--panel-2`. The first run crumb carries the task's name and its chevron lists the other tasks standing in that state. A deeper crumb carries the execution's label, or `#` and the last eight characters of its id, and its chevron lists the executions beside it.
- **Switch.** A [segmented-control](../components/segmented-control.md) reading `Tasks` and `Conversation` in the bar's tools, the chosen side on `--panel-2` in `--text` and the other in `--dim`. Each room remembers its own choice. The Files room hides the switch where only one reading exists.
- **Board reading.** A [task-board](../components/task-board.md) with one column per declared child, numbered in run order, and one [task-card](../components/task-card.md) per execution, oldest first. A column holds a pass-number chip on each card when it ran more than once, and reads `not reached` when nothing ran there.
- **Conversation reading.** [run-conversation](run-conversation.md) for the run at the end of the address, which fills the column and pins its strip or composer at the foot.

## The run is drawn as a board, a conversation or a stated absence

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | The address names a run the task does not hold: `This task has not run here yet.` in `--dim`, with the bar and switch unchanged. | [empty.html](../assets/run-view/empty.html) |
| loading | Cannot be told apart from the board: until the state's declared children arrive the board draws the columns that ran, and the unreached columns join when they arrive. | |
| error | Cannot occur as a view of its own: a failed execution is a card with a `--bad` pill on the board and a red letterhead in the conversation. | |
| board | The executions as cards under their child columns. A click marks one card with `--tint-accent`; in the Tasks room it also describes that execution in the context panel. When the run waits for a move, the card it rests on can be dragged, and the columns that would take it get a dashed `--accent` edge. | [board.html](../assets/run-view/board.html) |
| conversation | The run's sheets, notes and waiting sheets down the column, with the strip or the composer under them. A run that declared and entered no children is read this way whatever the switch says. | [conversation.html](../assets/run-view/conversation.html) |
| subagent step | The address ends on a subagent's conversation, which fills the column with no board and no composer, whatever the switch says. | [run-conversation subagent](../assets/run-conversation/subagent.html) |

In the Files room with no run walked into, the upper half draws the state's own task board instead, where each card is a task and a click selects it.

## A double-click walks in and a crumb walks back out

- A person arrives by double-clicking a card on the Tasks room's board, which puts that task's run on the address, or by opening a composite state's file in the Files room.
- Double-clicking a card walks into that execution; double-clicking a column walks into its newest execution. A column nothing reached cannot be opened. Each walk adds a crumb.
- `walk in →` on a subagent row in the conversation adds a crumb for that subagent.
- Any crumb walks back to its level. The bar's project and state crumbs leave the run for the board above it.
- A run crumb's chevron menu walks sideways to another execution or another task without going back up.

## The board scrolls sideways and the conversation follows its newest line

- **Resize.** The view takes the middle column's width. Board columns keep 210 to 320px and the board scrolls sideways past them; the conversation scrolls down inside itself and keeps its strip in view.
- **Theme.** Every ground, edge and pill is a token with a light and a dark value.
- **Focus.** Walking in moves focus nowhere. The switch and the crumbs are buttons in the tab order; cards and columns are pointer targets.
- **Long or missing content.** Run crumbs end in an ellipsis at 190px. An execution with no label is named by its child key.
- **Unsaved work.** A message typed but not sent in the conversation's composer is lost when another task is selected.
