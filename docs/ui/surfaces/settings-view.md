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
siblings: [ui/surfaces/sidebar, ui/surfaces/app-window, ui/surfaces/settings-appearance, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-data, ui/surfaces/settings-files, ui/surfaces/inbox-strip]
---

# Settings view

The Settings room: one scrolling column right of the [sidebar](sidebar.md) that holds one settings page. It takes the place of whichever room was open, has no context panel, and its title bar holds only the empty filler. The list of pages is not here: it is the settings sheet that covers the sidebar while this room shows, as one list.

## The sidebar lists six pages in one list, and every page has the same head

- **Pages.** [Appearance](settings-appearance.md), [Connections](settings-connections.md), [Models](settings-models.md), [Tools](settings-tools.md), [Runs](settings-runs.md), [Data & history](settings-data.md) — the order a person sets things up in: how it looks, what it can reach, which model answers, what the tools may do, how a run behaves, and what it leaves behind. There are no group headings: which layer a page edits is its switch's to say, not the sidebar's. The page that edited the raw `settings.json` is gone, since every key has a row on a page and the file itself opens in the Files view; the Files page is Appearance's last section, [Files tree](settings-files.md).
- **Sidebar rows.** A 15px line glyph — a half-filled disc for Appearance, a plug for Connections, a cube for Models, a wrench for Tools, a play mark for Runs, stacked disks for Data & history — then the page's name. The page on screen takes the selected ground and lights its glyph.
- **Parts.** While a page is open, its sections are listed indented under its row; the one being read carries the accent down its edge as the page scrolls, and clicking one scrolls to it. A page of one section lists nothing.
- **Page head.** The page's name at 1.5× the app size, weight 650; under it one sentence — what the page is for, then whose settings these are (the [settings header](../components/settings-header.md) gives the three sentences). At the head's top-right, on every page, the layer switch: `Just you` · `This project` · `Shared (all projects)`, or `Just you` · `Shared (all projects)` with no project open. The sentence wraps and the switch keeps the corner.
- **Just you.** With `Just you` chosen, a segmented `What you changed` · `Every row` sits under the sentence. `What you changed` draws only the rows the personal layer states: a section left with none is not drawn, and a page left with none says `Nothing is set just for you on this page. Choose Every row to set something.` Every row the personal layer states carries a second line saying what it replaces — `instead of sonnet from Shared`, `instead of Classic from this project`, or `set nowhere else` where no other layer states it.
- **Sections.** A quiet sentence-case heading, with an `ⓘ` for what did not fit, over one bordered card of rows, at most 740px wide; a workspace section — File types, the permission sets, the functions table — takes up to 1040px. A row is its name, one sentence, and its control at the right edge. A row a layer may or may not state has a switch before its name that enables it; switched off, the row is dimmed and shows what it inherits.
- **Inbox strip.** The [inbox strip](inbox-strip.md) stays at the foot of the room while anything waits.

The four layers, weakest first: `Built in` (`$SYSTEM/settings.json`, what JaiRA ships — the presets `simple`, `coder` and `planner`, and `functions.smart.model: "simple"`), `Shared (all projects)` (`~/.jaira/settings.json`), `This project` (`.jaira/settings.json`) and `Just you` (`~/.jaira/personal-settings.json`, never in a checkout). `Built in` is read-only and has no segment: a value it holds shows as what a row inherits, and changing it writes the change into the layer being edited ([settings-json](../../engineering/contracts/settings-json.md)).

Photographs of every page in both themes are taken by `packages/app/shots/settings-tabs.mts`; the pages have no catalog mockups of their own, and the head's states are the [settings header](../components/settings-header.md)'s.

## The room changes only the page's head between states, and each page draws its own content

| State | Surface shows |
| --- | --- |
| shared | The default: `Shared (all projects)` filled, and the page reading and writing `~/.jaira/settings.json`. While a change is being written, the switch and every control on the page are at half strength and inert. |
| in a project | `This project` filled: the page reads and writes the project's `.jaira/settings.json`. |
| just you | `Just you` filled, `What you changed` · `Every row` under the sentence, and on `What you changed` only the rows the personal layer states, each saying what it replaces. |
| no project | No project is open: the switch is `Just you` · `Shared (all projects)`, and Data & history has no history sections. |
| empty | A page on `Just you` · `What you changed` whose rows the personal layer states none of: `Nothing is set just for you on this page. Choose Every row to set something.` under the head, and no sections. |
| loading | Cannot occur as its own look: the settings are read at launch and read again in place on entering. Checks that have not reported show as `not checked yet` at the head of Connections' Agents and `not checked` on each row. |
| error | Settings that cannot be read: a page that edits them shows `The configuration could not be read.` in `--dim` under its head. A save or check that fails puts the [error notice](error-notice.md) at the foot of the window and leaves the page as it was. |

## A person arrives from the sidebar and leaves for the room they came from

- `⚙ Settings` at the foot of the sidebar opens the settings sheet and this room at the page shown last, Connections the first time after launch. The rail's `⚙` expands the sidebar and does the same.
- A page in the sheet shows that page, and from Logs, Debug or Components it returns to Settings at that page. Opening Connections or Models shows the last check result without running a check.
- The switch opens on `Shared (all projects)` at launch and stays where it is put across pages; opening a project does not move it. Standing on no project while on `This project` moves it to `Shared (all projects)`. `Just you` opens on `What you changed` each time a window opens.
- `‹` or the Settings row at the top of the sheet leaves for the room shown before Settings. `≡ Logs`, `⌁ Debug` and `▤ Components` in the sheet leave for those rooms.
- Choosing an entry in the inbox strip leaves for the Tasks room with that task selected.

## The column keeps its pages narrow, moves no focus, and drops unsaved typing on leaving

- **Resize.** The column takes every pixel right of the sidebar. Pages keep their maximum width and stay at the left, so a wide window leaves space to their right. A wide table scrolls sideways inside its section, never the page.
- **Theme.** Ground, head, cards and rows are tokens with a light and a dark value, and the sheet's `Dark` or `Light` row switches them while Settings is open.
- **Focus.** Entering moves focus nowhere. Tab reaches the layer switch, then the page's controls in reading order.
- **Unsaved work.** Switches, choices and most fields are written the moment they change. A connection's opened settings, a key or token being typed, a preset's settings and a permission set's lines are held until their own `Save`; leaving the page or switching the layer drops the first three without a prompt. A permission set's lines are kept per layer until the page is left.
