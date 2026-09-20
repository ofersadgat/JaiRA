---
id: ui/surfaces/tasks-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/drill-in-and-back-out, ux/patterns/verbs-on-the-thing-itself, ux/patterns/drag-only-where-the-process-allows, ux/patterns/live-facts-and-unseen-counts, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/keep-track-of-everything, product/all-projects-in-one-place, product/hand-work-to-agents, product/move-work-on-by-hand, product/see-what-changed-since-you-looked]
components: [ui/components/address-bar, ui/components/segmented-control, ui/components/task-board, ui/components/task-card, ui/components/task-name, ui/components/status-pill, ui/components/splitter, ui/components/context-menu, ui/components/state-inspector]
mockups: [ui/assets/tasks-view/empty.html, ui/assets/tasks-view/no-board.html, ui/assets/tasks-view/listing.html, ui/assets/tasks-view/narrowed.html, ui/assets/tasks-view/dragging.html]
siblings: [ui/surfaces/files-view, ui/surfaces/chat-view, ui/surfaces/run-view, ui/surfaces/task-context, ui/surfaces/new-task-popover, ui/surfaces/context-panel, ui/surfaces/sidebar, ui/surfaces/inbox-strip]
---

# Tasks view

The Tasks room: the window's title bar carries the board's address, the column under it holds one board per open project, and a context panel 360px wide on the right describes whatever was chosen last. It fills the window right of the sidebar and takes the place of the Files, Chat and Settings rooms while it is open.

## The address reads first, the boards second and the panel third

- **Title bar.** An [address-bar](../components/address-bar.md) on `--panel` over a `--line` rule. It opens with the project crumb in the project's hue and a chevron menu listing `All projects`, every open project and `Open another project…`. A blue crumb follows for each workflow level drilled into, named by the state's label or the last segment of its id. While every project is listed, that project's pills follow the crumbs. `+ New task` sits at the far right while the address stands in one project and opens [new-task-popover](new-task-popover.md).
- **Middle column.** On `--bg`, one section per project, each a [task-board](../components/task-board.md) of [task-card](../components/task-card.md)s closed by a `--line` rule. Every section after the first opens with the same address bar standing on its own project. The first has none, because the title bar already names it.
- **Divider.** A 6px [splitter](../components/splitter.md) drawn as a `--line` hairline that turns `--accent` under the pointer.
- **Context panel.** On `--panel` with a `--line` left edge and 13px padding. The first of these that applies fills it: a value pinned from anywhere, drawn by [context-panel](context-panel.md); the state behind the column clicked last, drawn by [state-inspector](../components/state-inspector.md); the task behind the card clicked last, drawn by [task-context](task-context.md); otherwise `Select a task.` in `--dim`.

## The root lists every project and a project narrows the column to itself

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | The project list could not be read. The bar holds `All projects` in the app face with its chevron menu, the column reads `Open a project to see its board.` and the panel reads `Select a task.`. JaiRA's shared root always stands as a group, so a window with no project open still lists that group. | [empty.html](../assets/tasks-view/empty.html) |
| no board | A group whose board has not arrived, or failed to arrive, reads `No board here yet.` in `--dim`, and the other groups draw as usual. Loading and failure look the same. A state that declares no children reads `This state has no children.` in its group. | [no-board.html](../assets/tasks-view/no-board.html) |
| partial | Cannot occur: each group draws its whole board or the sentence that stands for it. | |
| listing | At the root, every project's group stacks into one scrolling list, each as tall as its board, and the workflow columns wrap onto further rows. The bar's project crumb and pills follow the group scrolled to the top of the column. Blank room after the last group lets it reach the top when more than one project is open. | [listing.html](../assets/tasks-view/listing.html) |
| narrowed | Standing in one project, its group fills the column alone with no header and its board scrolls inside itself. Below the workflow roots the columns are numbered in run order and scroll sideways. Every selected card is tinted `--tint-accent`, and the panel describes the one touched last. | [narrowed.html](../assets/tasks-view/narrowed.html) |
| dragging | A card that a waiting process offers a move can be picked up. Each column that would take it gets a dashed `--accent` edge, and the one under the pointer fills with `--fill-ghost-selected`. The card appears in its new column once the process has moved it. | [dragging.html](../assets/tasks-view/dragging.html) |
| run on the address | The middle column becomes [run-view](run-view.md) and the bar grows one crumb per run and the `Tasks` and `Conversation` [segmented-control](../components/segmented-control.md). | [run-view board](../assets/run-view/board.html) |

## A person arrives from the sidebar or a waiting request and goes deeper from a card

- `All tasks` in the sidebar opens the room at the root, listing every project. A project's `Tasks` row opens it standing in that project.
- The bar's chevron menu narrows to the project chosen, or lists them all again from `All projects`. Clicking the project crumb in the listing narrows to the group it names; inside a project it returns to the workflow roots.
- Choosing an entry on the [inbox-strip](inbox-strip.md), or a task named in the [logs-view](logs-view.md), switches here with that task selected.
- A click on a card selects it and fills the panel with that task; Ctrl-click and Shift-click add to the selection. A click on a column describes its state in the panel.
- Double-clicking a column, or `Open` in its menu, drills one level and adds a crumb. Double-clicking a card puts that run on the address. Any crumb walks back out.
- Right-clicking a card or a column opens its verbs in a [context-menu](../components/context-menu.md). Deleting a task asks first in [confirm-dialog](confirm-dialog.md).
- `Open state ↗` in the task panel leaves for the [files-view](files-view.md) with that state open. Any other sidebar row leaves the room and keeps its layout.

## The panel keeps its width and the column gives way

- **Resize.** The divider sets the panel between 260 and 760px, or up to 1200px while a value is pinned, and a double-click restores 360px. The width survives a restart. The middle column takes the rest; a board's columns keep 210 to 320px, and past that the board scrolls sideways.
- **Theme.** Grounds, edges, pills and project hues are tokens with a light and a dark value.
- **Focus.** Entering the room moves focus nowhere. Cards and columns are pointer targets; crumbs, `+ New task` and the panel's buttons take the keyboard.
- **Long or missing content.** A project crumb ends in an ellipsis at 240px and a state crumb at 220px. Card names ellipsise, and the panel shows them whole.
- **Unsaved work.** None lives in the room; leaving it loses nothing.
