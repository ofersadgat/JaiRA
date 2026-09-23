---
id: ui/surfaces/settings-appearance
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/preview-beside-the-setting, ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings]
serves: [product/read-comfortably, product/read-what-work-produced]
components: [ui/components/size-stepper, ui/components/switch, ui/components/status-pill, ui/components/file-types-pane]
mockups: [ui/assets/settings-appearance/face-menu.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-files]
---

# Settings appearance

The Appearance page of the Settings room: how JaiRA looks on this machine, for every project. It is built from the settings page shape the person picked from t3code (2026-09-23): a title and one sentence saying whose settings these are, then sections, each a quiet sentence-case heading over one bordered card of rows. It is reachable with no project open and has no layer header.

## The page is six sections, each listed under the tab in the sidebar

- **Head.** `Appearance`, and under it `How JaiRA looks on this machine, for every project.`
- **Mode.** Three tiles, `Light` · `Dark` · `System`, each a miniature of the task board in the current theme; `System` is split light | dark and follows the operating system, and again whenever it changes.
- **Theme.** A card per theme — `Ink rail` (marked `default`), `Classic`, `Hairline`, `High contrast`, `Blueprint`, `Pastel`, `Pastel rail`, `Zinc` — each a miniature task board in that theme's colours (sidebar, three columns, a running, waiting, failed and done card), with its name and one sentence. The chosen card has an accent ring and a ✓. On `System` every card is split light | dark.
- **Board.** Rows for `Lane colours` (a switch), `Columns` (`Box` · `Line`) and `Status wash` (a switch), then `Preview`: three columns drawn with the board's own `Column` and `Tile` — a selected running card, a done card, a waiting card at a gate, a failed card and a queued one — in the window's theme, following each option as it is flipped.
- **Conversation.** `Batches that ran in turn` (`One after another` · `Side by side`), then `Preview`: two elements of one fan-out in the conversation's own sheet markup, down the page or side by side as a band.
- **Text.** `App font` and `Data font`, each with its face stack and size at the right and the stack the stylesheet receives on one line under the sentence; `Editor size` (follows the data font until its switch is on, then its own stepper); `Smooth text`; and `Preview`, a file row and a task row with both voices side by side.
- **File types.** The [file-types-pane](../components/file-types-pane.md), taking the page's full width.

Rows and headings stop at 740px; File types takes up to 1040px. While Appearance is open, the sidebar lists `Mode` · `Theme` · `Board` · `Conversation` · `Text` · `File types` indented under it; the one being read carries the accent down its edge as the page scrolls, and clicking one scrolls to it.

## A row says what it is and shows what it is set to

Every row is a name, one sentence under it, and its control at the right edge; the far right no longer repeats the value in words. A `↺` beside the name appears only while the value differs from what it would be untouched, and its tooltip says what it goes back to. An `ⓘ` holds whatever did not fit in the sentence.

| Row | ↺ appears when | Goes back to |
| --- | --- | --- |
| Lane colours, Columns, Status wash | the person set it | the theme's own (`Back to Ink rail's own: line`) |
| Batches that ran in turn | it is `Side by side` | one after another |
| App font, Data font | a family is chosen or the size moved | the shipped face and size |
| Editor size | it has a size of its own | following the data font |

## Every choice applies to the whole window as it is made

| On | Does | Feedback |
| --- | --- | --- |
| A mode tile | Sets light, dark or system | The window repaints, the OS window controls with it |
| A theme card | Paints the window in that theme and puts the three board options back to what it was designed with | The window and every preview repaint at once |
| A board option | Departs from the theme's own for that option | The task preview follows; a `↺` appears |
| A batch layout | Changes how a sequential fan-out is drawn in every run's conversation | The conversation preview follows |
| `+ add…`, a family, `✕`, a stepper | As before: the face menu, adding or removing a family, a size | Every register of that voice redraws |
| A section in the sidebar | Scrolls the page to that section | It is lit as soon as it is clicked |

Nothing is saved by a button and nothing is left unsaved.

## The previews depart from real surfaces only in taking no clicks

- The task and conversation previews are the app's own components and classes, drawn with fixed sample content and inert.
- The theme cards are drawn from a colour table (`paletteCards.tsx`), a copy of the stylesheet, because each card shows its own theme while the window is painted in another.

## A person arrives from the Settings panel with or without a project, and leaves by choosing another section

- The sidebar's Settings panel lists `Appearance` whether or not a project is open. The light/dark switch in the panel's foot flips what is on screen and makes the other one an explicit choice.
- Choosing another section, `‹`, or another room leaves. Every choice is already applied and written.
