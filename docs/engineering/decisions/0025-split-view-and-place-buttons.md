---
id: engineering/decisions/0025-split-view-and-place-buttons
type: decision
status: built
updated: 2026-11-13
decides_for: [engineering/decisions/0008-side-panels, engineering/decisions/0020-artifacts-and-the-design-canvas]
---

# 0025. Three places for an artifact, and panes with their own paths

The person, 2026-11-13, over the canvas "Artifacts: main, split, side panel (round 2)"
(artifact://t-8c3atezj6l/@a-3gtknh8f15): boards 02, 05, 06, 07, 08, 09, 10 and 12 accepted, then "go
ahead build it". Amended twice the same day (below): "07 and 09 are the correct design for split view
panels", then "both panels should be fully self contained. I.e. their ui should be identical. You should
be able to close either of them."

## What was there

A published artifact's title bar had two verbs: →| (`adopt` flipped) put it alone in the side panel,
and the eye put it over the main view (`artifactInMain`), where only ‹ Back took it away. The middle
column was always one thing: the room's own.

## Rulings (2026-11-13)

1. **Three place buttons (02).** One compact group of three icons replaces →| and the eye: Main view
   (a plain rectangle), Split (the rectangle halved), Side panel (the rectangle with a right-hand
   column). It is drawn on the card in the conversation and in the head of wherever the artifact is
   shown, the place it is in lit (--accent on --tint-accent). Pressing another place MOVES it there:
   it is closed where it was.
2. **The side panel's width is unchanged** ("keep it as is").
3. **Panes (05, 06, 07, 10, 12; as amended, 07 and 09, and self-contained).** The room's middle column
   is one pane, or two side by side (two at most) with a divider between them whose width is
   remembered like any pane (`PANE.splitRight`). The panes are IDENTICAL: one component, the same head
   — ‹ Back, › Forward, the pane's path as crumbs (every crumb but the last walks the pane back to it),
   what stands on top's own controls, ⋯, ✕ — the same body for the same thing whichever side it is
   on, the same behaviour. Holding ‹, or pressing the last crumb, lists "This pane's path", newest
   first, the current one marked.
4. **Anything can go in a pane (06), as the real view:** a conversation is the Chat room's thread with
   its composer, a task's run its run, an artifact the artifact — not a side panel's face. The room's
   own view is an entry like these, on whichever pane holds it.
5. **Focus.** The pane last pressed in is focused: a 2px --accent line along its top (an inset shadow,
   never a coloured left edge). A row pressed in the sidebar's Chat or Tasks list lands in the focused
   pane.
6. **The side panel follows the focused pane (10).** With the focused pane on a task of its own path,
   the panel is that task's context; on the room, the room's rule as before.
7. **The pane's ⋯ menu (12)**, the same on either pane: Swap the panes, Only this pane, Move to the
   side panel, Close this pane.
8. **Closing.** ✕ on EITHER pane closes it, and the other is the only (unsplit) main view with its path
   kept. One rule, one code path (`closePane`).
9. **Drag (08, 09).** An artifact card's title bar dragged shows three drop zones over the room (Main
   view, Split, Side panel); a drop opens it there. A row of the sidebar's Chat or Tasks list dragged
   over a pane of a split fills THAT pane with a dashed "Open here" zone saying "This pane goes on to
   <name>; ‹ Back returns to <what it showed>"; the drop puts it on that pane's path, either pane. Web
   and desktop only.

## Amended 2026-11-13 (first): two equal panes

The first build made the right pane a second side panel: the panel's frame and faces (its title, its
tabs, "beside the conversation"), the left pane headless, the window's title bar across both. The person
looked at it beside boards 07 and 09 and said: "07 and 09 are the correct design for split view
panels". So both panes got the same head with the path as crumbs, a pane draws the real view
(`PaneBody.tsx`: `ChatThread` over the conversation's own run through `usePaneChatSurface`; an artifact
filling the pane; a run as its conversation; a state, a value or a subagent as its face's body alone),
and a row dropped on a pane goes on that pane's path.

## Amended 2026-11-13 (second): one pane component

That build still had a privileged left pane ("the room with things on top of it") beside a right pane
of another kind, an artifact drawn with two heads (the pane's and its own title bar), ✕ on the left
moving the right's content across, the window's title bar an empty strip and the Tasks room's tools
hidden while split. The person: "both panels should be fully self contained. I.e. their ui should be
identical. You should be able to close either of them." What changed:

- **One `Pane`, drawn once or twice** (`SplitPane.tsx`' `Panes`). Nothing in it is about a side but its
  place in the row and the divider before the second. The model has no left or right: `SplitState.panes`
  is one or two paths, and every operation takes a pane's index.
- **The room is an entry** (`ROOM`), on whichever pane holds it — at most one, it is one view; the
  window opens on one pane whose path is the room alone. That pane draws the room's column, kept
  mounted under anything put on top of it. No pane holding it (its pane was closed), it is kept mounted
  out of sight, and goes on the focused pane's path again when the room moves (`roomMoved`).
- **One head per artifact.** In a pane the artifact has no title bar of its own (`PublishedView`'s
  `headless`): the pane's head names it and carries its three place buttons.
- **Closing is symmetric** (`closePane`): the other pane is the only view, its path kept. Swap
  exchanges the panes with their paths; Only this pane is closing the other.
- **The room's address is in the head of the pane holding the room** while that pane has a head
  (`RoomAddress` from `TitleBar.tsx`: the Tasks room's crumbs with its run reading toggle and New task,
  the conversation's name, the file's) — the room's tools stay with the room.
- **The main view is the first pane** in a room with panes: an artifact sent there goes on that
  pane's path. `artifactInMain` is what is left where there are no panes: a phone, the Debug room.

## The model

A pane's path is a panel stack's shape (`entries`, what › goes forward to in `ahead`) of the side
panel's entry kinds and the room. `splitModel.ts` is pure: the panes, which is focused, which tab shows
when narrow; ‹ › and crumbs (`paneBack`, `paneForward`, `crumbTo`, `pushPath`); the path's menu
(`historyOf`, `walkTo`); opening on a pane's path (`openInPane`, `openInSplit`); closing, Only this pane
and Swap (`closePane`, `onlyPane`, `swapPanes`); the room moving (`roomMoved`); whether a pane has a
head (`paneHeaded`: always while split, alone once its path is more than the room); where a press
from the sidebar lands (`routeOpen`: the room goes there itself while the focused pane stands on it,
else the pane goes on); the panel's rule (`focusRuleOf`); a place button's move (`placeMoveOf`,
`shownPlacesOf`); the drop zones (`dropZonesOf`, `zoneAt`, `openHereLine`); and whether two panes fit
(`splitFits`).

Every way of putting something somewhere (the buttons, the ⋯ menu, a drop) goes through `places.ts`.
The split is the shell's state (`viewState.ts`' `splitView`), one for the window, drawn by the Tasks,
Files and Chat rooms in place of their middle column. `PanelColumn` hands the panes the side panel's
faces over each pane's own path (`paneFaces`) for what they draw by a face.

## Chosen, not ruled

- **Narrow window (14).** When the room between the sidebar and the side panel cannot hold two panes
  of 360 (`SPLIT_PANE_MIN`) and a divider, the two become two tabs over one pane, a dot on the hidden
  tab when what it shows changed.
- **Phone.** No panes: the Split button is not offered, and anything sent to "split" opens in the main
  view, over the room. No drag.
- **Two panes at most.** The split is not kept across a reload; the panel stack is not either.
- **The window's title bar stays as a strip** (the window is dragged by it, the OS draws its buttons
  in it: `titleBarStyle: "hidden"` with `titleBarOverlay`), holding nothing of any room once the
  room's address is in a pane's head. With one pane on the room alone, it is the room's address as
  it always was, and the pane has no head.
- **✕ only while split**: the only pane does not close; its ‹ goes back along its path.
- **The side panel's rule** while the focused pane stands on a task of its own path is that task's
  context beside its conversation (`convo`: Steps, Produced, Changes, Held). On anything else (an
  artifact, a state) or on the room, the room's rule.
- **The split is the window's**, like a pinned panel stack: it stays as the person moves between the
  Tasks, Files and Chat rooms, and is not drawn in the others.
- **A row's long press is not its menu once it became a drag** (`pressWasDrag`): the row's own press
  never hears the release, which lands on the drag's sheet.

## Build order

1. The icons and the place group on `PublishedView`, moving between the main view and the side panel.
2. The second pane: its path, focus, divider, ⋯ menu, the panel following focus.
3. The narrow tabs and the phone rule.
4. Drop zones for an artifact's title bar; a sidebar row dragged onto a pane.
5. (First amendment) Both heads with crumbs, the real views, "Open here".
6. (Second amendment) One pane component; the room an entry; one head per artifact; symmetric ✕.
