---
id: ui/components/task-board
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/ordered-by-urgency-then-recency, ux/patterns/context-beside-what-you-stand-on, ux/patterns/drill-in-and-back-out, ux/patterns/verbs-on-the-thing-itself, ux/patterns/drag-only-where-the-process-allows, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/absence-is-stated]
serves: [product/keep-track-of-everything, product/hand-work-to-agents, product/move-work-on-by-hand, product/complete-record-of-every-run]
surfaces: [ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/run-view]
reuses: [ui/components/task-card, ui/components/context-menu]
implemented_by: [packages/app/src/renderer/board.tsx, packages/app/src/renderer/runViews.tsx, packages/app/src/renderer/taskDrag.ts, packages/app/src/renderer/App.tsx]
verified_by: [packages/app/test/board.test.ts, packages/app/test/taskDrag.test.ts, packages/app/test/runViews.test.ts, packages/app/test/runDragOffers.test.ts]
mockups: [ui/assets/task-board/empty.html, ui/assets/task-board/root-listing.html, ui/assets/task-board/level.html, ui/assets/task-board/dragging.html, ui/assets/task-board/run-board.html]
siblings: [ui/components/task-card, ui/components/address-bar, ui/components/instance-index, ui/components/state-graph]
---

# Task board

A row of rounded hairline columns on `--panel-2`, each under a `--panel-3` band holding a loose sequence number, the child state's name in bold mono and a count at the far end, with borderless task cards stacked inside and an uppercase `AT THIS LEVEL` row of cards wrapping underneath.

## A board shows where work stands in one process level, one column per place

**Use when.** The tasks at one level of a process are shown by where each stands, one column per child state: a project's board on the Tasks view, or a state with children open in Files. The same columns show one run's passes, one column per declared child, on a run's Tasks reading.

**Do not use when.** One item is being drawn: that is [task-card](task-card.md), which every column holds. A run's states in the order they ran belong in [instance-index](instance-index.md). The shape of a process, what runs after what, is [state-graph](state-graph.md). The path to the level shown is the [address-bar](address-bar.md) above the board.

## Columns read first, the lanes inside them second, and the tray last

- **Board.** 10px inset. Columns sit 10px apart in one row and share the tallest column's floor. A column is 210px wide at least and 320px at most.
- **Column.** `--panel-2` ground, 1px `--line` edge, 9px corners. The band on `--panel-3` with a `--line` hairline under it holds the sequence number in `.data-num`, the name in mono at the `.data-title` size and weight, never uppercased, and the count at the far end in `.app-secondary`. The band stays at the top of the board while a long column scrolls under it.
- **Order.** Below a project's roots, columns run left to right in the order the children run, numbered from 1, and the row scrolls sideways past the view's width. At the roots the columns are the project's processes, unnumbered, and wrap onto further rows 12px apart.
- **Cards.** 6px inside the column, 4px apart. A column with no cards shows `—`, or `not reached` on a run's board, in `--dim`.
- **Lanes.** A column that mixes kinds groups its cards: running, then paused, then not started, then finished with the most recently ended first. Only not started and finished get a heading: an `.app-label` word, a `--line` rule running right, and the count in `.data-num`. Those two lanes are drawn at 72% opacity and come to full on hover. A column of one kind has no lanes.
- **Tray.** Tasks at this level that stand in no column: an uppercase `AT THIS LEVEL` caption in `--dim`, then 210px cards wrapping in rows 8px apart, laned the same way. Only the Tasks view draws it.

## Every state keeps the columns and changes what fills them

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A level with no child states shows `This state has no children.` in `--dim` where the columns would be. An empty column inside a board shows `—`, drawn in the level mockup. | [empty.html](../assets/task-board/empty.html) |
| loading | Cannot occur on the board: until a project's board has arrived the Tasks view shows `No board here yet.` in its place. | |
| partial | A run's board whose declared children are not yet known shows columns only for the children that ran, drawn like the run board. | [run-board.html](../assets/task-board/run-board.html) |
| error | Cannot occur: a failed task is a card with a failed pill, and the board itself has no failure. | |
| root listing | The project's processes as unnumbered columns that wrap onto further rows. | [root-listing.html](../assets/task-board/root-listing.html) |
| level | Numbered columns in run order in one row, lanes where a column mixes kinds, empty columns as `—`, and the tray. A column the context panel describes has an `--accent` edge and its band on `--fill-ghost-selected`, and no card is selected meanwhile; a selected card is drawn by task-card. | [level.html](../assets/task-board/level.html) |
| dragging | While a card offered a move is held, each column that would take it gets a dashed `--accent` edge and the one under the pointer fills with `--fill-ghost-selected`. Every other column is unchanged and refuses the drop. | [dragging.html](../assets/task-board/dragging.html) |
| run board | One column per declared child, one card per pass stacked oldest first, `not reached` in a column no pass entered. No tray, no lanes. | [run-board.html](../assets/task-board/run-board.html) |

## A click describes, a double click enters, and a right click offers the verbs

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a column | Nothing | Edge turns `--rule` |
| Click a card | Selects it; the context panel describes the task, or on a run's board on the Tasks view, that pass | Card tinted `--tint-accent`, name at 600 |
| Ctrl-click or Cmd-click a card, Tasks view | Adds it to the selection or takes it out; an emptied selection clears | Every selected card tinted; the panel follows the last card touched |
| Shift-click a card, Tasks view | Selects the range from the anchor in drawing order: columns left to right, lanes top to bottom, then the tray, within one project | The range tinted |
| Double-click a card | Tasks view: puts that task's run on the address. Files: goes one level down the task's own path. Run board: walks into that pass | The address gains levels |
| Right-click a card, Tasks view | Inside a selection of several: the group's verbs, titled with the count. Otherwise selects the card, then offers its verbs | [context-menu](context-menu.md) at the pointer |
| Click a column outside its cards, Tasks view | The context panel describes that child state | `--accent` edge, band on `--fill-ghost-selected` |
| Double-click a column | Opens that level. On a run's board, walks into the column's newest pass; a column not reached does nothing | The address gains a level |
| Right-click a column outside its cards, Tasks view | Offers the column's verbs, titled with the state id | Menu at the pointer |
| Drag a card, only where a waiting process offers it a move | Marks the columns that would take it | Dashed `--accent` edges; cursor `grabbing` |
| Drop on a column that takes it | Asks the waiting process to make the move | The card appears in the new column once the process has moved it |
| Choose `Delete…` or `Delete {n} tasks…` | Asks first, naming everything that goes | The confirm dialog |

A disabled verb stays in its place. `Re-run` and `Delete…` are disabled while the task runs; `Cancel` is disabled once it completed, failed or was canceled. A group verb counts only the members it applies to and names what it skipped; it is disabled at zero.

## The copy names places in data and verbs in app words

| Where | String |
| --- | --- |
| No child states | `This state has no children.` |
| Empty column | `—` on a task board · `not reached` on a run's board |
| Lane headings | `Not started` · `Finished`, drawn uppercase |
| Tray caption | `At this level`, drawn uppercase |
| Column tooltip | Tasks view `click to describe {state id}, double-click to open it` · Files `double-click to open {state id}` · run board `double-click to walk into {key}` or `{key} was not reached` |
| Card verbs | `Open` · `Start` for a queued task, `Re-run as a new task` with note `fresh copy` for an ended task or a conversation, else `Re-run` · `Cancel` · `Copy task id` · `Delete…` |
| Group verbs, title `{n} tasks` | `Re-run {n} tasks` with note `running skipped` · `Cancel {n} tasks` with note `finished skipped` · `Copy task ids` · `Delete {n} tasks…` with note `running skipped`; every `{n} tasks` reads `1 task` for one |
| Column verbs, title `{state id}` | `Open` · `Describe` · `Select {n} tasks` · then the group verbs |
| Delete one, confirm | Title `Delete "{task title}"?`, using the task's own title even where the card shows a computed name · note `This deletes the task, every run it made, and its worktree — uncommitted work included. None of it comes back.` · button `Delete` |
| Delete several, confirm | Title `Delete {n} tasks?` · note `This deletes each task, every run it made, and its worktree — uncommitted work included. None of it comes back.` · button `Delete` |

## The board scrolls instead of squeezing, and takes no keys

- Narrowed to one project, the board fills its column and scrolls both ways inside it. Listing every project, each board grows to its own height and the whole column scrolls.
- Column names and card names ellipsise; counts, sequence numbers and pills keep their width.
- Theme: grounds, edges and the drop marks are tokens, so both themes keep them.
- Focus: columns and cards are not tab stops. Selecting, opening, the verbs and the move are pointer gestures only; the context panel's buttons are the keyboard route.
- The Files view draws the board without the tray, without column descriptions or verbs, and without moves.

## Two quiet marks do not use the quiet register

- The tray caption is an uppercase caption of its own instead of `.app-label`.
- The not started and finished lanes are quietened with 72% opacity instead of `--tok-hint`.
