---
id: ui/surfaces/settings-view
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects, product/agents-act-only-where-allowed, product/read-comfortably, product/keep-history-within-bounds]
components: [ui/components/settings-header]
mockups: []
siblings: [ui/surfaces/sidebar, ui/surfaces/app-window, ui/surfaces/settings-appearance, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-files, ui/surfaces/settings-data, ui/surfaces/settings-raw, ui/surfaces/inbox-strip]
---

# Settings view

The Settings room: one scrolling column right of the [sidebar](sidebar.md) that holds one settings page. It takes the place of whichever room was open, has no context panel, and its title bar holds only the empty filler. The list of pages is not here: it is the settings sheet that covers the sidebar while this room shows, in two groups.

## The sidebar lists the pages in two groups, and every page has the same head

- **Just you** (`this machine`). [Appearance](settings-appearance.md): how JaiRA looks for this person, stored in their own settings, with no layer switch.
- **Project & shared** (`layered`). [Connections](settings-connections.md), [Models](settings-models.md), [Tools](settings-tools.md), [Runs](settings-runs.md), [Files](settings-files.md), [Data & history](settings-data.md), then [settings.json](settings-raw.md) — the order a project is set up in: connect a service, pick a model, decide what the tools may do, adjust how runs behave.
- **Sidebar rows.** A group is an uppercase heading with its note at the right in `--dim`. A page is a 15px line glyph — a half-filled disc for Appearance, a plug for Connections, a cube for Models, a wrench for Tools, a play mark for Runs, a folder for Files, stacked disks for Data & history, braces for `settings.json` — then its name; `settings.json` is set in the data face, as the file it opens. The page on screen takes the selected ground and lights its glyph.
- **Parts.** While a page is open, its sections are listed indented under its row; the one being read carries the accent down its edge as the page scrolls, and clicking one scrolls to it. A page of one section lists nothing.
- **Page head.** The page's name at 1.5× the app size, weight 650; under it one sentence — what the page is for, then whose settings these are: `Editing {project}; anything left unset comes from ~/.jaira.` or `Editing ~/.jaira, shared by every project on this machine.`, with `Open a project to override it for one.` when none is open. At the head's top-right, always, the [layer switch](../components/settings-header.md); the sentence wraps and the switch keeps the corner.
- **Sections.** A quiet sentence-case heading, with an `ⓘ` for what did not fit, over one bordered card of rows, at most 740px wide; a workspace section — File types, the permission sets, the functions table — takes up to 1040px. A row is its name, one sentence, and its control at the right edge. A row a layer may or may not state has a switch before its name that enables it; switched off, the row is dimmed and shows what it inherits.
- **Inbox strip.** The [inbox strip](inbox-strip.md) stays at the foot of the room while anything waits.

| Page | Head's right edge |
| --- | --- |
| Appearance | Nothing |
| Connections, Models, Runs, Files, Data & history, `settings.json` | `This project` · `Shared (all projects)`; nothing with no project open |
| Tools | `This project` · `Shared (all projects)` · `Built in`; `Shared (all projects)` · `Built in` with no project open |

Photographs of every page in both themes are taken by `packages/app/shots/settings-tabs.mts`; the pages have no catalog mockups of their own.

## The room changes only the page's head between states, and each page draws its own content

| State | Surface shows |
| --- | --- |
| in a project | A project is open: the layer switch with `This project` or `Shared (all projects)` filled, and the page reading and writing that layer. While a change is being written, the switch and every control on the page are at half strength and inert. |
| no project | No project is open: no switch, the sentence says the page edits `~/.jaira`, and Data & history has no history sections. Tools keeps a switch of `Shared (all projects)` and `Built in`. |
| unlayered | Appearance: its own head with no switch, and the page starts at the top of the column. |
| empty | Cannot occur: a page is always shown, Connections the first time Settings opens after launch. |
| loading | Cannot occur as its own look: the settings are read at launch and read again in place on entering. Checks that have not reported show as `not checked yet` at the head of Connections' Agents and `not checked` on each row. |
| error | Settings that cannot be read: a page that edits them shows `The configuration could not be read.` in `--dim` under its head. A save or check that fails puts the [error notice](error-notice.md) at the foot of the window and leaves the page as it was. |

## A person arrives from the sidebar and leaves for the room they came from

- `⚙ Settings` at the foot of the sidebar opens the settings sheet and this room at the page shown last. The rail's `⚙` expands the sidebar and does the same.
- A page in the sheet shows that page, and from Logs, Debug or Components it returns to Settings at that page. Opening Connections or Models shows the last check result without running a check.
- `‹` or the Settings row at the top of the sheet leaves for the room shown before Settings. `≡ Logs`, `⌁ Debug` and `▤ Components` in the sheet leave for those rooms.
- Choosing an entry in the inbox strip leaves for the Tasks room with that task selected.

## The column keeps its pages narrow, moves no focus, and drops unsaved typing on leaving

- **Resize.** The column takes every pixel right of the sidebar. Pages keep their maximum width and stay at the left, so a wide window leaves space to their right. A wide table scrolls sideways inside its section, never the page.
- **Theme.** Ground, head, cards and rows are tokens with a light and a dark value, and the sheet's `Dark` or `Light` row switches them while Settings is open.
- **Focus.** Entering moves focus nowhere. Tab reaches the layer switch, then the page's controls in reading order.
- **Unsaved work.** Switches, choices and most fields are written the moment they change. A connection's opened settings, a key or token being typed, a preset's settings and a permission set's lines are held until their own `Save`; leaving the page or switching the layer drops the first three without a prompt. A permission set's lines are kept per layer until the page is left, and `settings.json`'s text stays with the file.
