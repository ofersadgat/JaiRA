---
id: ui/surfaces/sidebar
type: ui-surface
status: shipped
updated: 2026-11-16
kind: panel
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/drill-in-and-back-out, ux/patterns/verbs-on-the-thing-itself, ux/patterns/filter-in-place, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/keep-track-of-everything, product/chat-with-agents, product/author-processes-without-memorising-the-format, product/read-comfortably]
components: [ui/components/sidebar-row, ui/components/project-row, ui/components/status-pill, ui/components/file-tree, ui/components/context-menu]
mockups: [ui/assets/sidebar/at-root.html, ui/assets/sidebar/in-a-project.html, ui/assets/sidebar/settings.html, ui/assets/sidebar/collapsed.html]
siblings: [ui/surfaces/app-window, ui/surfaces/conversation-list, ui/surfaces/settings-view, ui/surfaces/logs-view, ui/surfaces/debug-view, ui/surfaces/components-view, ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/chat-view]
---

# Sidebar

The one column down the left edge of the [app window](app-window.md), from the top of the window to the bottom: a 68px RAIL of what is global beside a PANEL of the one place the address stands in. The rail holds the root rooms, a tile per open project, Open and Settings. The panel is the open project, a root room, or Settings. Hidden, the panel goes and the rail stays. The column's ground is `--panel-2`, or `--chrome` under a named palette, with a 1px `--line` right edge (1.5px `--rule` under the contrast palette).

## The rail reads first, then the panel's head, its tabs and its drawer

- **Rail.** 68px wide, a centred column with a gap of 4, on `--panel-3`, or `--chrome` under a named palette. A `--line` stands on its right while the panel is open.
- **Rail head.** 34px, empty, a handle that drags the window: on macOS the window's three buttons stand in it. The toggle that hides the panel leads the window's top row instead, in the [app window](app-window.md)'s title bar or the head of the pane at the window's left. On a phone the head is 44px and holds the toggle `|◂`, which closes the drawer.
- **Rail items.** Each is 60px wide with radius 8, padding 6 above and 5 below, and a gap of 3. It holds an icon in a 34 by 30px box, or a project's tile, with a caption under it in the app face at 0.78, on one line: `--dim` at weight 500, or `--text` at 600 on the item you are on. A pointed-at item takes `--fill-ghost-hover`. A root room you are in has its icon box on `--tint-accent` and its glyph in `--accent`.
- **Rail order.** `▦ All tasks` and `✻ All chats` come first, then a 28px `--line` rule, a tile per open project, and `+ Open` on a dashed 34px square. The foot sits under a `--line` rule: the Update row while an update is pending, then `⚙ Settings`. The items between head and foot scroll when they run past the window; the foot does not.
- **Project tile.** A 34px square with radius 10, holding the first two letters or digits of the project's name, lowercased, in mono, or `·` when it has none. It sits on `--panel` with a `--line` edge. The open project's tile is on a 22% wash of its hue with a 1.5px edge in the hue. Around the tile, a 44px ring shows what the project has running, waiting and stopped, each in its kind's colour, the running ones breathing. The tile's fill takes the ring's leading kind at 26%, and under the letters it says the oldest wait you owe or how long the work has run. The caption is the project's name.
- **Badge.** Over an item's top right: the count of the most urgent thing waiting in it, on a 16px pill filled in that kind's colour — running `--accent`, waiting and warning `--warn`, failed `--bad`, done `--ok` — the number in data at 0.7, bold, in `--panel`; `•` when there is no number.
- **Panel.** `--sidebar` wide, 250px by default, in one of three forms.
  - **The open project.** A 40px head that drags the window, padded 0 8 0 12: the project's name in `.data-title`, then its `⚙`. A project of several workspaces shows `name › [machine | workspace]` there instead, each half of the pill a menu, with `✕` to let the narrowing go. The machine menu lists every machine: each row under the pointer shows `Add` (a machine with a workspace already takes a second one), which opens [Add's card](open-project.md#adds-card-the-four-answers-and-one-button) where the menu stood — Project, Where, Bring, Then and `Add <machine>`; `Add a workspace…` at its foot opens it at Where it goes. A project of one workspace has the same menu on its name, titled `Workspaces`. Under the head, the project's rooms as tabs on a `--panel-3` track with radius 8, padding 2 and a margin of 0 8 6. Each tab, `Files`, `Tasks` or `Chat`, is 26px tall with radius 6; the chosen one is on `--panel` with a `--line` ring and its name at 600 in `--text`. A tab with something waiting carries a 6px dot in the colour of the most urgent. Under the tabs, the chosen room's verbs: a filled `+ New` and, for Files and Chat, a field-shaped `⌕ Search files` or `⌕ Search chat` toggle that fills the rest of the row. Then the room's drawer, padded 0 6 6: the [file-tree](../components/file-tree.md) for Files; the project's tasks under a column head for Tasks (grouped by Status, Workflow, Workspace or Nothing; sorted by State, Name, or when each was updated or made); the [conversation list](conversation-list.md) for Chat.
  - **A root room.** A 40px head with the room's name in `.app-title` and its verbs as 24px glyph buttons. All conversations has `+` and `⌕` there, and the conversation list of every project as its drawer. All tasks has its [status-pill](../components/status-pill.md) counts and `Every project's board is open beside the sidebar.`
  - **Settings.** A 40px head of `‹`, `Settings` in `.app-title` and the pills of what needs attention, then the settings pages, the one on screen with its sections under it. At its foot, under a `--line` rule: `≡ Logs`, `⌁ Debug`, `▤ Components`, then `☾ Dark` in light or `☀ Light` in dark, each a 28px row. The row on screen is lit: `--tint-accent` in the classic palette, a ring or a raised ground in the others.

## Every state keeps the rail and changes the panel beside it

| State | Surface shows | Mockup |
| --- | --- | --- |
| at-root | Standing at the root, the first run included: All tasks lit in the rail, every open project's tile with its ring, and the panel as the root room with its counts. With no project of the person's own, `~/.jaira` is the only tile. | [at-root.html](../assets/sidebar/at-root.html) |
| in-a-project | The open project's tile lit, and the panel as that project: its name and `⚙`, the Files, Tasks and Chat tabs with the current one chosen, its verbs, and its drawer. | [in-a-project.html](../assets/sidebar/in-a-project.html) |
| empty | Cannot occur: All tasks, All chats, Open and Settings are always drawn, and so is the shared root's tile. | |
| loading | Cannot occur as its own state: tiles draw from the projects already open, and rings and badges change as work loads. | |
| partial | A drawer longer than the panel scrolls inside it. Rail items past the window's height scroll between the head and the foot. | [in-a-project.html](../assets/sidebar/in-a-project.html) |
| error | Cannot occur in the column: a project that fails to open is reported by the [error notice](error-notice.md) and adds no tile. | |
| settings | While Settings, Logs, Debug or Components is the room, the panel is Settings: its pages, and the three rooms and the theme at its foot. | [settings.html](../assets/sidebar/settings.html) |
| collapsed | The rail alone, at the root and standing in a project side by side. The open project's rooms hang under its tile as 40 by 26px icons, `❏` `▶` `✎`: the current one on `--panel` with a `--line` ring, and a 6px dot on one with something waiting. `≡ Logs`, `⌁ Debug` and `▤ Components` join the foot above Settings. | [collapsed.html](../assets/sidebar/collapsed.html) |

## Each item goes somewhere, and every way into Settings has a way back

- A root item puts the address at the root and shows that room. A project's tile stands in that project, at the workspace or machine its title was last narrowed to.
- `+ Open` opens a [context-menu](../components/context-menu.md) of `Open project…` (note `forge or machine`: the [Open dialog](open-project.md) — a repository on a signed-in forge or a folder on any machine, taken to any machine), `Open a folder here…` (the system's folder dialog) and `New project…`, then `New project on {machine}…` for each paired machine, an offline one dimmed. While the app is busy `+ Open` cannot be pressed.
- A tab shows that room in the open project. `+ New` on Files opens a menu of a new file, folder or workflow, right-aligned under the button; on Tasks, a menu of the project's workflows to start; on Chat, a new conversation where the title points, with `⌄` beside it listing the other workspaces when the project has several. `⌕` switches the drawer's filter field on or off.
- A task or conversation pressed in a drawer opens in the focused pane, or in its room when that pane stands on the room.
- The toggle at the head of the window's top row hides the panel and shows it again. `⚙ Settings` in the rail while the panel is hidden shows it and opens Settings in one step.
- `‹` or leaving Settings returns to the room shown before it, never to Logs, Debug or Components. A page shows Settings at that page, from Logs, Debug or Components as well. The pills in Settings' head and on Logs open what needs attention.

| Where | String |
| --- | --- |
| Toggle tooltip | `hide the sidebar` · `show the sidebar` |
| Back tooltip | `back to where you were` |
| Project settings tooltip | `{project}'s settings` |
| Verb tooltips | `new conversation` · `new conversation in {place}` · `more ways to start` · `new file, folder or workflow` · `start a task` · `find in files` · `find in chat` · `find in conversations` |
| Search toggle | `Search files` · `Search chat` · `Searching…` |
| Tile tooltip | `{absolute path}` |
| Open tooltip | `open another project` |
| Theme tooltip | `switch to dark` · `switch to light` |
| Tasks drawer, nothing in it | `No tasks yet.` · `No tasks here.` (narrowed to a machine) |
| All tasks | `Every project's board is open beside the sidebar.` |

## The panel keeps its width, folds for a narrow window, and gives up steps before names

- **Resize.** The window's splitter drags the panel between 180 and 520px, and a double click returns it to 250. The width and whether the panel is hidden are remembered for the person. A window too narrow for the room beside it hides the panel before the side panel. The open project is never remembered; it follows the address.
- **Long content.** Captions end in an ellipsis at the rail's width. In a narrowed project's title, the steps before the current one shrink to their icons, oldest first, and only then does its name trim. A drawer scrolls inside the panel.
- **Theme.** The column draws in its own token scope, so every ground, rule, hue and badge has a light and a dark value, and each palette its own.
- **Focus.** Rail items, tabs, verbs and drawer rows are buttons in reading order. The toggle is the first of the window's top row, not the sidebar's.
- **Phone.** The sidebar is a drawer: an `Inbox` item leads the rail, the rail's head holds the toggle that closes it, the panel's head is 48px and its tabs 34px, and the paired machines' row sits at the panel's foot.
- **Unsaved work.** None is held here; a file with unsaved edits is marked in the file tree.

## The sidebar departs from the visual direction in two places

- A rail tile lowercases a project name, which is data.
- A rail caption is set in the app face at 0.78, smaller than any register, so a word fits under a 34px icon.
