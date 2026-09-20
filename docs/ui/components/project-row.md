---
id: ui/components/project-row
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/drill-in-and-back-out]
serves: [product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/keep-track-of-everything]
surfaces: [ui/surfaces/sidebar]
reuses: [ui/components/status-pill, ui/components/sidebar-row]
implemented_by: [packages/app/src/renderer/sidebar.tsx, packages/app/src/renderer/projects.ts, packages/app/src/renderer/pill.tsx, packages/app/src/renderer/App.tsx]
verified_by: [packages/app/test/projects.test.ts, packages/app/test/pill.test.ts]
mockups: [ui/assets/project-row/closed.html, ui/assets/project-row/open.html, ui/assets/project-row/partial.html]
siblings: [ui/components/sidebar-row, ui/components/address-bar, ui/components/conversation-row]
---

# Project row

A project's line in the sidebar: a 7px dot in the project's colour, the folder's name in mono, status pills and a `▸`; the open one grows into a band on the panel ground edged by two hairlines, its name bold with its parent folder faint beside it and its rooms nested beneath.

## A project row is how the column lists an open project and goes into it

**Use when.** The sidebar lists a project the window has open, including the shared root, and offers to stand on it.

**Do not use when.** The line is a room of the app, inside a project or not: use [sidebar-row](sidebar-row.md). A project must be named somewhere other than the sidebar: the [address-bar](address-bar.md) head crumb and a [conversation-row](conversation-row.md) chip carry the same colour and name in their own shapes.

## The name reads first, the colour ties it to the rest of the window, and the counts follow

- **Dot.** A 7px circle in the project's hue, the only colour on the row. Projects take `--p1` blue, `--p2` amber and `--p3` violet in turn by their place among the open projects; the shared root takes the grey `--p0`. The same hue marks the project's tile in the collapsed sidebar, the head of the address bar, its chip on the inbox strip and its chip on a conversation row.
- **Name.** The folder's own name, or `~/.jaira` for the shared root. Closed it is `.data-secondary` in `--dim`; open it is `.data-title`, bold in `--text`. It never changes case or face.
- **Parent folder.** On the open row only, the name of the folder the project sits in, in `.data-faint`, right-aligned against the pills. It tells two checkouts of the same repository apart.
- **Counts.** A row of [status-pill](status-pill.md)s for everything in the project: 96px of room closed, 62px open.
- **Twisty.** `▸` in `--dim` at the far end of a closed row. It is a mark, not a control: the whole row opens.
- **Open band.** The open project's section runs full bleed on `--panel` with a 1px `--line` rule above and below, no corners, and 4px of space outside each rule. Its room rows hang 12px in behind a 1px `--rule` line, and the band takes the column's spare height so a drawer inside it scrolls.
- **Spacing.** A closed row has 5px above and below its name; the open row has 8px above and 6px below.

## A project is closed or open, and a long name gives way inside either

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a row exists only for a project the window has open. | |
| loading | Cannot occur: a project is listed once it is open, with its counts. | |
| error | Cannot occur: a project folder that cannot be reached is skipped when the app opens, so it has no row. | |
| closed | Dot, name in `.data-secondary`, pills and `▸` on the column's `--panel-2` ground. A project with nothing to count ends at `▸`. Shown for three checkouts and the shared root in grey. | [closed.html](../assets/project-row/closed.html) |
| open | The band on `--panel`, name in `.data-title`, parent folder in `.data-faint`, pills folded to 62px, no `▸`, and the Files, Tasks and Chat rows nested under a `--rule` line. Exactly one project is open, or none when the window stands at the root. | [open.html](../assets/project-row/open.html) |
| partial | A name longer than its room: on the open row the parent folder shrinks away first and then the name ends in an ellipsis; on a closed row the name ellipsises before the pills. | [partial.html](../assets/project-row/partial.html) |

## Clicking a project stands on it, and clicking it again returns to the root

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over the row | Nothing | Ground `--fill-ghost-hover`; tooltip is the project's full path |
| Click a closed project | Stands the window on that project, in the room it was already showing | The row opens into the band with its rooms, any other open project closes, and the address bar's head changes |
| Click the open project | Returns the window to the root | The band closes back into a row, and the root rows show every project's work |
| Click the pills | Marks every ended task in the project as seen | Flat pills leave; live pills stay |

## The copy is the folder's name and where it lives

| Where | String |
| --- | --- |
| Name | `{folder name}` · `~/.jaira` for the shared root under the home folder, or its full path elsewhere |
| Beside the open name | `{parent folder name}`, such as `UbuntuCode` or `worktrees` |
| Row tooltip | `{full project path}` |
| Pills tooltip | `mark these seen` |
| Twisty | `▸` |

## The name keeps its width longest, and the parent folder is the first thing to go

- Resize: the pills and `▸` keep their size. On the open row the parent folder shrinks to nothing before the name is cut; the full path is always in the tooltip. With the sidebar collapsed, a project is a two-letter tile rather than a row.
- Theme: hues, band, rules and registers are tokens with dark values. In dark the band's ground sits close to the column's, so its two hairlines are what mark it.
- Focus order: the row is one tab stop in list order, and Enter or Space opens or closes it. It is announced as expanded or collapsed. The pills cannot be reached by keyboard.
- Long or missing content: a project at the top of a drive has no parent folder, so nothing stands beside its open name. Two projects with the same name and the same parent differ only by colour and tooltip.
