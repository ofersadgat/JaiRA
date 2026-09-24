---
id: ui/surfaces/settings-appearance
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/preview-beside-the-setting, ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings, ux/patterns/inherited-unless-set-here]
serves: [product/read-comfortably, product/read-what-work-produced, product/share-processes-across-projects]
components: [ui/components/settings-header, ui/components/size-stepper, ui/components/switch, ui/components/status-pill, ui/components/file-types-pane]
mockups: [ui/assets/settings-appearance/face-menu.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-files, ui/surfaces/settings-connections]
---

# Settings appearance

The Appearance page of the Settings room, first in its list: how JaiRA looks. How it looks is a setting like any other — the `appearance` block of the settings, which Shared, a project or `Just you` may each state ([settings-json](../../engineering/contracts/settings-json.md)) — so the page has the same [layer switch](../components/settings-header.md) as every other page, and every row has the set / not set switch every layered row has. It is built from the settings page shape the person picked from t3code (2026-09-23): a title and one sentence saying whose settings these are, then sections, each a quiet sentence-case heading over one bordered card of rows. It is reachable with no project open.

## The page is seven sections, each listed under the tab in the sidebar

- **Head.** `Appearance`, the lead `How JaiRA looks.` followed by the layer sentence, and the switch at the head's top-right.
- **Mode.** Three tiles, `Light` · `Dark` · `System`, each a miniature of the task board in the current theme; `System` is split light | dark and follows the operating system, and again whenever it changes. The whole section is one setting, `appearance.mode`, with its switch before the heading.
- **Theme.** A card per theme — `Ink rail` (marked `default`), `Classic`, `Hairline`, `High contrast`, `Blueprint`, `Pastel`, `Pastel rail`, `Zinc` — each a miniature task board in that theme's colours (sidebar, three columns, a running, waiting, failed and done card), with its name and one sentence. The chosen card has an accent ring and a ✓. On `System` every card is split light | dark. One setting, `appearance.palette`, switched at the heading.
- **Board.** Rows for `Lane colours` (a switch), `Columns` (`Box` · `Line`) and `Status wash` (a switch), each with its own set / not set switch, then `Preview`: three columns drawn with the board's own `Column` and `Tile` — a selected running card, a done card, a waiting card at a gate, a failed card and a queued one — in the window's theme, following each option as it is flipped.
- **Conversation.** `Batches that ran in turn` (`One after another` · `Side by side`), then `Preview`: two elements of one fan-out in the conversation's own sheet markup, down the page or side by side as a band.
- **Text.** `App font` and `Data font`, each with its face stack and size at the right and the stack the stylesheet receives on one line under the sentence; `Editor size` (follows the data font until its own switch is on, then its own stepper); `Editor palette` (`Follows the window` or a named editor theme, for every editor a file type has not been given one of its own); `Smooth text`; and `Preview`, a file row and a task row with both voices side by side.
- **File types.** The [file-types-pane](../components/file-types-pane.md), taking the page's full width; one setting as far as the layers go (`appearance.renderers` and `appearance.editors`), switched at the heading.
- **Files tree.** What the Files tree leaves out, and why: the section described in [settings-files](settings-files.md).

Rows and headings stop at 740px, Files tree included; File types takes up to 1040px. While Appearance is open, the sidebar lists `Mode` · `Theme` · `Board` · `Conversation` · `Text` · `File types` · `Files tree` indented under it; the one being read carries the accent down its edge as the page scrolls, and clicking one scrolls to it.

## A row says whether this layer states it, what it is, and what it is set to

Every row is a switch, a name, one sentence under it, and its control at the right edge; the far right no longer repeats the value in words. The switch says whether the layer being edited states the setting: on, the control edits it; off, the row is dimmed, its control inert, and it shows what the window gets from the layers below. A `↺` beside the name appears only while the value differs from what it would be untouched, and its tooltip says what it goes back to. An `ⓘ` holds whatever did not fit in the sentence. On `Just you`, a row the personal layer states says what it replaces — `instead of Classic from Shared`.

| Row | ↺ appears when | Goes back to |
| --- | --- | --- |
| Lane colours, Columns, Status wash | the person set it | the theme's own (`Back to Ink rail's own: line`) |
| Batches that ran in turn | it is `Side by side` | one after another |
| App font, Data font | a family is chosen or the size moved | the shipped face and size (`Back to DM Sans, 12.5 px`) |
| Editor size | it has a size of its own | following the data font |

## Every choice applies to the whole window as it is made, and lands in the layer on the switch

| On | Does | Feedback |
| --- | --- | --- |
| A row's or section's switch, on | Writes the value the row shows into the layer being edited, so nothing changes until it is edited | The row brightens and its control comes alive |
| The same switch, off | Removes the setting from the layer, so it inherits again | The row dims and shows what it now inherits; the window repaints if that differs |
| A mode tile | Sets light, dark or system | The window repaints, the OS window controls with it |
| A theme card | Paints the window in that theme and puts the three board options back to what it was designed with | The window and every preview repaint at once |
| A board option | Departs from the theme's own for that option | The task preview follows; a `↺` appears |
| A batch layout | Changes how a sequential fan-out is drawn in every run's conversation | The conversation preview follows |
| `+ add…`, a family, `✕`, a stepper | The face menu, adding or removing a family, a size | Every register of that voice redraws |
| A section in the sidebar | Scrolls the page to that section | It is lit as soon as it is clicked |

Nothing is saved by a button and nothing is left unsaved. The window paints the look in effect where the address stands — a project's own look while standing in it — while the frame and the OS window controls take Shared's with `Just you` over it, since they are drawn before any project is open.

## The previews depart from real surfaces only in taking no clicks

- The task and conversation previews are the app's own components and classes, drawn with fixed sample content and inert.
- The theme cards are drawn from a colour table (`paletteCards.tsx`), a copy of the stylesheet, because each card shows its own theme while the window is painted in another.

## A person arrives from the Settings panel with or without a project, and leaves by choosing another page

- The sidebar's Settings panel lists `Appearance` first, whether or not a project is open. The light/dark switch in the panel's foot flips what is on screen, writing the mode into the strongest layer that states it, or `Just you` when none does.
- Switching the layer redraws every row from that layer; nothing is held to drop.
- Choosing another page, `‹`, or another room leaves. Every choice is already applied and written.
