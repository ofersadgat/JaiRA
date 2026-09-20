---
id: ui/surfaces/app-window
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/the-window-remembers-its-arrangement, ux/patterns/drill-in-and-back-out, ux/patterns/context-beside-what-you-stand-on]
serves: [product/all-projects-in-one-place, product/keep-track-of-everything, product/everything-waiting-on-you-together, product/read-comfortably]
components: [ui/components/address-bar, ui/components/segmented-control, ui/components/splitter, ui/components/status-pill, ui/components/context-menu, ui/components/icon]
mockups: [ui/assets/app-window/first-run.html, ui/assets/app-window/success.html, ui/assets/app-window/room.html, ui/assets/app-window/collapsed.html, ui/assets/app-window/holding.html]
siblings: [ui/surfaces/sidebar, ui/surfaces/context-panel, ui/surfaces/inbox-strip, ui/surfaces/error-notice, ui/surfaces/crash-screen, ui/surfaces/confirm-dialog, ui/surfaces/gate-modal, ui/surfaces/module-approval-dialog, ui/surfaces/new-task-popover, ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/chat-view, ui/surfaces/logs-view, ui/surfaces/debug-view, ui/surfaces/components-view, ui/surfaces/settings-view]
---

# App window

The whole desktop window, drawn edge to edge with no frame or menu bar of the operating system: the [sidebar](sidebar.md) runs down the left at full height, and right of it a title bar sits over one room and, while something waits, the [inbox strip](inbox-strip.md). Every other surface lives inside it or floats over it, and nothing displaces it except the [crash screen](crash-screen.md).

## The sidebar reads first, then the address across the top, then the room under it

- **Sidebar.** Full height at the left, 250px wide by default, on `--panel-2`. A 6px [splitter](../components/splitter.md) with a `--line` hairline stands on its right edge, and is absent while the sidebar is collapsed to its 46px rail.
- **Title bar.** Across everything right of the sidebar, at least 34px tall, on `--panel` with a 1px `--line` rule below. It holds the address of what is open, and right of that an empty filler that drags the window and keeps clear the corner where the operating system draws its three window buttons. The window has no caption of its own; its name in the taskbar is `{project} · {room} — JaiRA`, with `no project` when none is open and the open file's path in place of the room in Files.
- **Room.** Exactly one fills the rest. Files and Tasks are a middle column on `--bg`, a splitter and the [context panel](context-panel.md) at the right, 300px wide in Files and 360px in Tasks by default. Chat is one column until a value is pinned, when it grows the same splitter and a 420px context panel. Logs, Debug, Components and Settings are one column.
- **Inbox strip.** 40px at the foot, under the room and never under the sidebar.
- **Overlays.** From lowest to highest: a dialog on its `--scrim`, the [error notice](error-notice.md) of a failed action, a [context-menu](../components/context-menu.md), and the notice of an interface failure. A menu opened from a dialog draws over it, and a failed action's notice draws over the dialog that caused it.

| Room | Title bar holds |
| --- | --- |
| Files | The [address-bar](../components/address-bar.md) of the open folder or file, or nothing before one is open |
| Tasks | The address bar of the board or run. While a run is on the address, a [segmented-control](../components/segmented-control.md) `Tasks` · `Conversation`. While the bar names the project the sidebar stands in, a `+ New task` button that opens the [new task popover](new-task-popover.md) |
| Chat | The conversation's title in the app face in `--dim`, or `New conversation` |
| Logs, Debug, Components, Settings | Only the filler |

## The frame stays the same in every room and changes only at its edges

| State | Surface shows | Mockup |
| --- | --- | --- |
| first_run | No project of the person's own. The sidebar lists `All tasks`, `All conversations`, the shared `~/.jaira` root in grey and `Open a project…`. The Tasks room opens on the shared root's workflows with no tasks in them, and the context panel says `Select a task.` | [first-run.html](../assets/app-window/first-run.html) |
| empty | Cannot occur as a state of the window: a room with nothing in it says so inside the room, inside the same frame. | |
| loading | Cannot occur: the arrangement and the open projects are restored before the window appears. | |
| success | Standing in a project: its band open in the sidebar with the current room lit, the address in the title bar, the room with its context panel, and the inbox strip while anything waits. | [success.html](../assets/app-window/success.html) |
| room | The title bar in each room: a file's address, a run's address with its reading switch and `+ New task`, a conversation's title, and the bare filler. | [room.html](../assets/app-window/room.html) |
| collapsed | The sidebar is a 46px rail of glyphs and project tiles, the splitter beside it is gone, and the room takes the width. | [collapsed.html](../assets/app-window/collapsed.html) |
| holding | A value pinned from its own `…` menu fills the context panel with a header and a close. In Chat the panel appears for it, with its splitter, and leaves when it is closed. | [holding.html](../assets/app-window/holding.html) |
| modal | A dialog centred over a `--scrim` that covers the whole window, sidebar included. A module approval comes before a command approval that names no task, and only one of the two shows. A confirmation shows independently of both. | [confirm-dialog](../assets/confirm-dialog/confirm.html) |
| error | A failed action puts the [error notice](error-notice.md) above the foot of the window. A failure inside the interface puts its own notice at the foot. A room that throws while drawing is replaced, with the sidebar, by the [crash screen](crash-screen.md). | [error-notice](../assets/error-notice/action-failed.html) |

## The window opens on launch and is left only through the operating system's buttons

- Launching the app opens the projects that were open when it closed, in the Tasks room, standing at the most recently opened project.
- A sidebar row changes the room, the project or both. The title bar's address moves through levels inside the room, as in [drill-in-and-back-out](../../ux/patterns/drill-in-and-back-out.md). An inbox strip entry switches to Tasks and selects the task that asks.
- Settings, Logs, Debug and Components are left through the sidebar's settings sheet, which returns to the room the person came from.
- Nothing inside the page closes the window. The window buttons at the top right are the operating system's own.

## The sidebar and the context panel keep their widths, and unsaved edits go when the window does

- **Resize.** The sidebar drags between 180 and 520px and resets to 250 on a double click. The context panel drags between 220 and 680px in Files, 260 and 760px in Tasks, and up to 1200px while it holds a pinned value; in Chat it runs from 280 to 1200px. Each width is remembered per room for the person, and the middle column takes what is left, so a wide panel on a narrow window crowds it. The window has no smallest size and nothing folds on its own.
- **Theme.** The sidebar's `Dark` or `Light` row switches every colour at once, because every colour here is a token.
- **Focus order.** Tab follows reading order: the sidebar from its toggle down, the sidebar's splitter, the title bar's crumbs and buttons, the room, then the context panel. The inbox strip takes no focus.
- **Unsaved work.** Edits not saved to disk are discarded without a prompt when the window closes or reloads.

## The window sets one data string in the app face

- The conversation title in Chat's title bar is data, a task's title, and is set in the app face with no register.
