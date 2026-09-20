---
id: ui/surfaces/sidebar
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/drill-in-and-back-out, ux/patterns/verbs-on-the-thing-itself, ux/patterns/filter-in-place, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/keep-track-of-everything, product/chat-with-agents, product/author-processes-without-memorising-the-format, product/read-comfortably]
components: [ui/components/sidebar-row, ui/components/project-row, ui/components/status-pill, ui/components/file-tree, ui/components/context-menu]
mockups: [ui/assets/sidebar/at-root.html, ui/assets/sidebar/in-a-project.html, ui/assets/sidebar/settings.html, ui/assets/sidebar/collapsed.html]
siblings: [ui/surfaces/app-window, ui/surfaces/conversation-list, ui/surfaces/settings-view, ui/surfaces/logs-view, ui/surfaces/debug-view, ui/surfaces/components-view, ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/chat-view]
---

# Sidebar

The one column down the left edge of the [app window](app-window.md), from the top of the window to the bottom, on `--panel-2` with a 1px `--line` right edge: every open project as a row, with the rooms of the project the address stands in nested under it. It sits beside the title bar and the room, holds the way to every room, and folds to a 46px rail instead of closing.

## The title row reads first, then the root rows, the projects and Settings at the foot

- **Title row.** At least 34px tall: a 26px toggle `|◂` in `--dim`, then `JAIRA` in `.app-label`. The whole row drags the window, so it holds nothing else.
- **Root rows.** `▦ All tasks` and `✻ All conversations`, each a [sidebar-row](../components/sidebar-row.md) with its label in `.app-label`. They stand for every open project at once, take no hue, and sit above a `--line` rule.
- **Projects.** One [project-row](../components/project-row.md) per open project: a 7px dot in the project's hue, the name in `.data-secondary`, its [status-pill](../components/status-pill.md) counts, and a `▸` mark at the far end. The person's projects cycle through `--p1`, `--p2` and `--p3`; the shared `~/.jaira` root is grey `--p0`.
- **The open project.** The project the address stands in becomes a full-bleed band on `--panel` with a `--line` rule above and below, and takes the column's spare height. Its name moves up to `.data-title` with its parent folder right-aligned beside it in `.data-faint`, the `▸` goes, and its rooms hang under it behind a `--rule` indent: `❏ Files`, `▶ Tasks` and `✎ Chat`.
- **Open a project….** `+ Open a project…` in `.app-secondary` after the last project. While the app is busy it is dimmed to half and cannot be pressed.
- **Foot.** `⚙ Settings` under a `--line` rule.

The row of the room on screen is lit with a `--tint-accent` ground and `--text`. Pointing at that row swaps the tint for the ordinary hover fill. A row that browses something opens a drawer directly under it while it is current, indented behind a `--line` rule: the [file-tree](../components/file-tree.md) under Files, and the [conversation list](conversation-list.md) under Chat and under All conversations, where every conversation carries its project's chip.

Files, Chat and All conversations carry quiet verbs at the row's far end, 20px glyphs at half opacity until the row is pointed at or current: `+`, then `⌕`. A lit `⌕` is `--accent` on `--tint-accent`.

## Counts say what is live in each place and what ended since it was last looked at

- All tasks counts every project's work that is not a conversation, All conversations counts conversations, a project row counts all of that project's work, and its Tasks and Chat rows split the same work between them.
- `▶` running and `⏸` waiting are filled tints and stay while true. `✓`, `⛔` and `⚠` are flat and count what ended unseen.
- Pills that do not fit fold into one flat `+{n}` coloured like the most serious kind it hides. The open project's row folds sooner than a closed one, and each verb on a row takes room from its pills.
- A row with nothing live and nothing unseen shows no pills.

## Every state keeps the title row and the foot and changes what hangs between them

| State | Surface shows | Mockup |
| --- | --- | --- |
| at-root | Standing at the root, the first run included: the root rows, every project closed with its counts, `Open a project…` and Settings, and no room rows. With no project of the person's own, `~/.jaira` is the only project. | [at-root.html](../assets/sidebar/at-root.html) |
| in-a-project | The open project's band with its three rooms, the current room lit, and that room's drawer under it. | [in-a-project.html](../assets/sidebar/in-a-project.html) |
| empty | Cannot occur: the root rows, the shared root, `Open a project…` and Settings are always drawn. | |
| loading | Cannot occur as its own state: rows draw from the projects already open, and counts change as work loads. | |
| partial | Counts folded into `+{n}` where a row has no room for them, drawn on the All tasks row. | [at-root.html](../assets/sidebar/at-root.html) |
| error | Cannot occur in the column: a project that fails to open is reported by the [error notice](error-notice.md) and adds no row. | |
| settings | While Settings, Logs, Debug or Components is the room, a sheet covers the column below the title row. | [settings.html](../assets/sidebar/settings.html) |
| collapsed | The 46px rail, at the root and standing in a project side by side. | [collapsed.html](../assets/sidebar/collapsed.html) |

## The settings sheet holds everything that belongs to no project

- **Ground.** Opaque `--panel-2` with the `--lift` shadow, from under the title row to the bottom of the window. The foot's Settings row is not drawn while it is open.
- **Header.** The Settings row lifted to the top with `‹` left of its glyph, lit while Settings is the room.
- **Sections.** `Providers`, `Executors`, `Configuration`, `Files`, `Appearance`, `Conversation` and `History`, the last only while a project is open. The section on screen takes `--fill-ghost-selected`, `--text` and weight 600, and only while Settings is the room.
- **Rest.** Pinned to the sheet's foot under a `--line` rule: `≡ Logs`, `⌁ Debug`, `▤ Components`, then `☾ Dark` in light or `☀ Light` in dark. The one on screen is lit.

## The rail keeps every room one click away in 46px

- A centred `▸|`, the root glyphs `▦` `✻`, a 20px `--line` rule, then a 28px tile per project holding the first two letters or digits of its name in mono at weight 600, or `·` when it has none.
- A tile sits on `--panel` with a `--line` border in `--dim`. The project the address stands in has its tile on a 22% wash of its hue with a border in the hue and `--text`.
- Standing in a project adds a second rule and the room glyphs `❏` `▶` `✎`, each 34 by 30px. The current one is lit with `--tint-accent`.
- The foot holds `≡` `⌁` `▤`, the theme glyph and `⚙`. No labels, verbs, pills or drawers are drawn, so running work shows nowhere in the rail. The rail scrolls when its tiles run past the window.

## Each row goes somewhere, and every way into Settings has a way back

- A root row puts the address at the root and shows that room. A project row stands in that project; the open project's own row goes back to the root. A room row shows that room in the open project.
- `+` on Files opens a [context-menu](../components/context-menu.md) of a new file, folder or workflow, right-aligned under the button. `+` on Chat opens a new conversation; on All conversations it goes to the root first, so the conversation belongs to the shared root.
- `⌕` switches the drawer's filter field on or off. On a row that is not current it only lights, and the field appears when that room is opened.
- A row's pills mark that row's share seen. `Open a project…` opens a menu of `Open project…` and `New project…`.
- Settings opens the sheet. `‹` or the header row leaves it for the room shown before it. A section shows Settings at that section, from Logs, Debug or Components as well.
- The toggle folds the column to the rail and back. A tile stands in its project, or goes back to the root from the project already stood in. The rail's `⚙` expands the column and opens the sheet in one step.

| Where | String |
| --- | --- |
| Toggle tooltip | `hide the sidebar` · `show the sidebar` |
| Back tooltip | `back to where you were` |
| Verb tooltips | `new conversation` · `new file, folder or workflow` · `find in files` · `find in chat` · `find in conversations` |
| Pills tooltip | `mark these seen`; each pill `{n} {kind}`; the fold `{n} more` |
| Project row and tile tooltip | `{absolute path}` |
| Open a project tooltip | `open another project` |
| Theme tooltip | `switch to dark` · `switch to light` |

## The column keeps its width, folds only on request, and gives up paths before names

- **Resize.** The window's splitter drags the column between 180 and 520px, and a double click returns it to 250. The width and whether the column is folded are remembered for the person. The open project is never remembered; it follows the address.
- **Long content.** Labels and names end in an ellipsis. On the open project, the parent folder gives up its width before the name does. A drawer takes the band's spare height and scrolls inside it.
- **Theme.** Grounds, rules, hues and pills are tokens with a light and a dark value. In dark, the open band is carried by its two rules more than by its ground.
- **Focus.** Rows, verbs, the toggle and the tiles are buttons in reading order. The pills and the settings sections take no focus, so marking seen and choosing a section need a pointer.
- **Unsaved work.** None is held here; a file with unsaved edits is marked in the file tree.

## The sidebar departs from the visual direction in three places

- Room rows set their labels in `.app-label`, the register for a heading over a group, because each heads the drawer that opens under it.
- A rail tile lowercases a project name, which is data.
- The current settings section is marked with the ghost fill and weight, not the accent tint the room rows use.
