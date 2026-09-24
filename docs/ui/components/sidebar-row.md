---
id: ui/components/sidebar-row
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/filter-in-place, ux/patterns/drill-in-and-back-out]
serves: [product/keep-track-of-everything, product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/chat-with-agents]
surfaces: [ui/surfaces/sidebar]
reuses: [ui/components/status-pill, ui/components/context-menu]
implemented_by: [packages/app/src/renderer/sidebar.tsx, packages/app/src/renderer/App.tsx]
verified_by: [packages/app/test/pill.test.ts]
mockups: [ui/assets/sidebar-row/idle.html, ui/assets/sidebar-row/current.html, ui/assets/sidebar-row/lifted.html, ui/assets/sidebar-row/rail.html, ui/assets/sidebar-row/disabled.html]
siblings: [ui/components/project-row, ui/components/conversation-row, ui/components/file-tree]
---

# Sidebar row

A 26px line in the sidebar with a dim glyph and an uppercase label, quiet `+` and `⌕` verbs and status pills at its far end, lit with a pale accent ground when it is where the window stands, with what it holds opening beneath it.

## A sidebar row goes to a room of the app and holds that room's own verbs

**Use when.** The column offers a place to go that is a room rather than a thing: the two root rows that span every project, the three rooms inside the open project, the rooms that belong to no project, Settings, the theme switch and the way to open another project.

**Do not use when.** The line stands for a project: use [project-row](project-row.md). It stands for a conversation or a file inside a room: use [conversation-row](conversation-row.md) or the rows of the [file-tree](file-tree.md). The verb needs more than a glyph, or acts on a chosen item: offer it on the item with a [context-menu](context-menu.md).

## The label reads first, the glyph marks the room, and the verbs and counts wait at the far end

- **Glyph.** A text character in a 15px slot in `--dim`: `▦` all tasks, `✻` all conversations, `❏` files, `▶` tasks, `✎` chat, `≡` logs, `⌁` debug, `▤` components, `⚙` settings, `☾` or `☀` for the theme, `+` to open a project.
- **Label.** `.app-label`: uppercase, letterspaced, weight 700, `--dim`, one line with an ellipsis. `Open a project…` alone is sentence case in `.app-secondary`.
- **Verbs.** 20px square glyph buttons after the label, drawn at half strength until the row is under the pointer, is current, or the verb is on. Files carries `+` and `⌕`, Chat and All conversations carry `+` and `⌕`.
- **Counts.** A row of [status-pill](status-pill.md)s at the far end, given 96px less 20px for each verb. Files and the rooms outside projects carry none.
- **Ground.** None at rest; 6px corners. Rows in a group sit 1px apart.
- **Drawer.** Under the current row, when its room has something to browse: indented 6px with a 1px `--line` rule down its left and 8px inside it. Files opens the file tree, Chat and All conversations open the conversation list, Settings opens its pages. Tasks, All tasks, Logs, Debug and Components have none.
- **Where rows sit.** The root rows above the projects under a `--line` rule, the room rows nested inside the open project, `Open a project…` after the last project, and Settings alone in the foot under its own rule.

## Every state is where the row stands, how the column is folded, or whether it can be pressed

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: every row has a glyph and a label, and a row with nothing to count shows no pills. | |
| loading | Cannot occur: rows are fixed, and their counts change with what is loaded. | |
| partial | Cannot occur as a look of its own: pills that do not fit fold into `+{n}`, drawn under [status-pill](status-pill.md). | |
| error | Cannot occur: a row only goes somewhere. | |
| idle | Glyph and label in `--dim`, verbs at half strength, pills if anything counts. Shown in a column standing on a project's Tasks room. | [idle.html](../assets/sidebar-row/idle.html) |
| current | Ground `--tint-accent`, glyph and label in `--text`, verbs at full strength, and the drawer open beneath. A verb that is on, such as `⌕` with its find field showing, is `--accent` on `--tint-accent`. | [current.html](../assets/sidebar-row/current.html) |
| lifted | Settings, while it or Logs, Debug or Components is showing: a panel covers the column under the title row, headed by the Settings row with a `‹` before its glyph and its pages beneath, in two groups; Logs, Debug, Components and the theme row sit at the panel's foot under a rule. | [lifted.html](../assets/sidebar-row/lifted.html) |
| rail | The column collapsed to 46px: each row is a centred 34px glyph with no label, verbs, pills or drawer, 30px tall among the room glyphs. Logs, Debug, Components, the theme and Settings stand in the foot. | [rail.html](../assets/sidebar-row/rail.html) |
| disabled | `Open a project…` at half strength while the app is busy with an action. | [disabled.html](../assets/sidebar-row/disabled.html) |

## Clicking a row goes to its room, and its verbs act without going there first

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row | Nothing | Ground `--fill-ghost-hover`; verbs at full strength; the label keeps its colour |
| Click a root row while in a project | Puts the address at the root, then shows that room across every project | The project folds, the row lights, its drawer opens |
| Click a room row in the project, or a row in the foot | Shows that room | The row lights, and its drawer opens |
| Click the current row | Nothing | None; a drawer closes only when another row is chosen |
| Click `⚙` in the rail | Expands the column, then opens Settings | The column widens with the Settings panel over it |
| Click the lifted Settings row or its `‹` | Returns to the room the window showed before Settings | The panel leaves |
| Click `+` on Files | Opens `New file…`, `New folder…` and a workflow or state entry, right-aligned under the `+`; nothing opens when there is no root to create in | A context menu |
| Click `+` on Chat | Shows Chat with a new conversation ready to start | The start screen in the middle column |
| Click `+` on All conversations | Puts the address at the root, then the same | The new conversation belongs to the shared root |
| Click `⌕` | Shows or hides the find field in that row's drawer | The verb lit `--accent`; the field takes the typing focus. On a row that is not current, the verb lights and nothing else shows until the row is chosen |
| Click the pills | Marks what the row counts as seen | Flat pills leave; live ones stay |
| Click the theme row | Switches between light and dark | The whole window changes theme |
| Click `Open a project…` | Opens `Open project…` and `New project…` under the row | A context menu |

Whether a find field is showing lasts for the session only.

## The copy names the room and says each verb as a sentence

| Where | String |
| --- | --- |
| Root rows | `All tasks` · `All conversations` |
| Project rooms | `Files` · `Tasks` · `Chat` |
| Rooms outside projects | `Logs` · `Debug` · `Components` · `Settings` |
| Row tooltip | `{label}` |
| Back | `‹`, tooltip `back to where you were`, announced `Back` |
| `+` on Files | tooltip `new file, folder or workflow` |
| `+` on Chat and All conversations | tooltip `new conversation` |
| `⌕` | tooltip `find in files` · `find in chat` · `find in conversations` |
| Theme row in light | `☾` `Dark`, tooltip `switch to dark`, announced `Toggle theme` |
| Theme row in dark | `☀` `Light`, tooltip `switch to light`, announced `Toggle theme` |
| Open another | `+` `Open a project…`, tooltip `open another project` |
| Pills | tooltip `mark these seen` |
| Settings pages | under `Just you`, `Appearance`; under `Project & shared`, `Connections` · `Models` · `Tools` · `Runs` · `Files` · `Data & history` · `settings.json` |

## The label gives way to the verbs and pills, and the rail keeps only the glyph

- Resize: the row takes the column's width, from 180px to 520px. Glyph, verbs and pills keep their size and the label ellipsises; at the default 250px, `All conversations` is cut short whenever it shows a pill beside its two verbs.
- Theme: grounds, tints and glyph colours are tokens, and the theme row names the theme it switches to.
- Focus order: the back button, the row, then each verb, in column order. Enter and Space act; arrow keys do nothing. The current row is announced as the current page, and a verb that toggles is announced as pressed or not. The pills cannot be reached by keyboard.
- Long or missing content: labels are fixed words, so only a narrow column cuts them. A drawer taller than the column scrolls inside itself and the foot stays on screen.

## The row bends three rules of the type registers

- The verbs at rest are dimmed by opacity rather than set in `--tok-hint`.
- A room row goes somewhere yet takes `.app-label`, the register kept for a heading over a group.
- `Open a project…` stands where a project would be, and is set in `.app-secondary` rather than `.app-absent`.
