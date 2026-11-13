---
id: engineering/decisions/0025-split-view-and-place-buttons
type: decision
status: built
updated: 2026-11-13
decides_for: [engineering/decisions/0008-side-panels, engineering/decisions/0020-artifacts-and-the-design-canvas]
---

# 0025. Three places for an artifact, and a split with its own path

The person, 2026-11-13, over the canvas "Artifacts: main, split, side panel (round 2)"
(artifact://t-8c3atezj6l/@a-3gtknh8f15): boards 02, 05, 06, 07, 08, 09, 10 and 12 accepted, then "go
ahead build it". Amended the same day (below): "07 and 09 are the correct design for split view panels".

## What was there

A published artifact's title bar had two verbs: →| (`adopt` flipped) put it alone in the side panel,
and the eye put it over the main view (`artifactInMain`), where only ‹ Back took it away. The middle
column was always one thing: the room's own.

## Rulings (2026-11-13)

1. **Three place buttons (02).** One compact group of three icons replaces →| and the eye: Main view
   (a plain rectangle), Split (the rectangle halved), Side panel (the rectangle with a right-hand
   column). It is drawn on the card in the conversation and in the head of wherever the artifact is
   shown, the place it is in lit (--accent on --tint-accent). Pressing another place MOVES it there:
   it is closed where it was. The main view keeps its ‹ Back beside the group.
2. **The side panel's width is unchanged** ("keep it as is").
3. **A split (05, 06, 07, 10, 12; as amended, 07 and 09).** The room's middle column can split into
   two panes, two at most, with a divider between them whose width is remembered like any pane
   (`PANE.splitRight`). The two panes are EQUAL: each is a main view with its OWN PATH and the same
   head — ‹ Back, › Forward, the pane's path as crumbs (every crumb but the last walks the pane back to
   it), then ⋯ and ✕. Holding ‹, or pressing the last crumb, lists "This pane's path", newest first,
   the current one marked. While split, the room's address is the left pane's crumbs ("Chat › Pricing
   page redesign"), not the window's title bar's.
4. **Anything can go in a pane (06), as the real view:** a conversation is the Chat room's thread with
   its composer, a task's run its run, an artifact the artifact — not a side panel's face.
5. **Focus.** The pane last pressed in is focused: a 2px --accent line along its top (an inset shadow,
   never a coloured left edge). A row pressed in the sidebar's Chat or Tasks list opens in the focused
   pane: on the right pane's path when that is focused, as today when the left is.
6. **The side panel follows the focused pane (10).** With the focused pane's own path on a task, the
   panel is that task's context; on the room, the room's rule as before.
7. **The pane's ⋯ menu (12):** Swap the panes, Only this pane, Move to the side panel, Close this pane.
8. **Drag (08, 09).** An artifact card's title bar dragged shows three drop zones over the room (Main
   view, Split, Side panel); a drop opens it there. A row of the sidebar's Chat or Tasks list dragged
   over a pane of a split fills THAT pane with a dashed "Open here" zone saying "This pane goes on to
   <name>; ‹ Back returns to <what it showed>"; the drop puts it on that pane's path — the left's too,
   ‹ returning to what it showed. Web and desktop only.

## Amended 2026-11-13: two equal panes

The first build made the right pane a second side panel: the panel's frame and faces (its title, its
tabs, "beside the conversation"), the left pane headless, the window's title bar across both. The person
looked at it beside boards 07 and 09 and said: "07 and 09 are the correct design for split view
panels". What changed:

- **Both panes have the same head** (`PaneHead` in `SplitPane.tsx`): ‹ › (disabled where there is
  nowhere to go), the crumbs, ⋯, ✕. The left's crumbs start at the room ("Chat", "Tasks", "Files")
  and what it stands on; the title bar draws no address while split (`TitleBar.tsx`).
- **A pane draws the real view** (`PaneBody.tsx`): a conversation is `ChatThread` over the
  conversation's own run (`useTaskRun`) through `usePaneChatSurface` — the room's chat surface with
  everything about the conversation taken from that one, its walk-ins the pane's, its composer
  sending by the conversation's id. An artifact fills the pane. A run that is not a conversation is its
  conversation as the run is read (`TaskConversation`, by the face of its Conversation tab without the
  panel's head and tabs); a state, a value or a subagent is its face's body alone.
- **The left pane has a path too.** It stands on the room (the store's selection, as always) and
  what was put on top of it — a row dropped on it, Swap, Only this pane, an artifact sent to the main
  view while split. ‹ from its first entry returns to the room, which stays mounted under it. The room
  moving (a press in the sidebar, a navigating link) drops what was on top of it.
- **Swap and Only this pane no longer navigate the room**: Swap replaces the left's top with the
  right's and the right's path with what the left showed; Only this pane puts the right's content on
  the left's path and closes the right.
- **The drop zones for a row** over a split are the panes alone, the hovered one drawn "Open here"
  with what ‹ will return to (`openHereLine`).

## The model

Both paths are panel stacks' shapes (`panelStack.ts`: `entries`, what › goes forward to in `ahead`)
of the side panel's entry kinds; the left's may be empty (the room). `splitModel.ts` is pure: the split
(both paths, which pane is focused, which tab shows when narrow), ‹ › and crumbs (`paneBack`,
`paneForward`, `crumbTo`, -1 the room), the path's menu (`historyOf`, `walkTo`), opening on a pane's
path (`openInPane`, `openInSplit`), where a press from the sidebar lands (`routeOpen`), the room moving
(`leftMoved`), the panel's rule (`focusRuleOf`), Swap and Only this pane (`swapPanes`, `onlyPane`), a
place button's move (`placeMoveOf`, `shownPlacesOf`), the drop zones (`dropZonesOf`, `zoneAt`) and
whether two panes fit (`splitFits`).

An artifact's places are read from where it stands: `artifactInMain` or the left path's top (the main
view), the right path's top, the side panel's top. `PlaceButtons` lights them and moves between them;
every way of putting something somewhere (the buttons, the ⋯ menu, a drop) goes through `places.ts`.

The split is the shell's state (`viewState.ts`' `splitView`), one for the window, drawn in the
Tasks, Files and Chat rooms beside their middle column. `PanelColumn` draws the right pane before its
own column, and hands both panes the side panel's faces over each pane's own path (`paneFaces`) for
what they draw by a face.

## Chosen, not ruled

- **Narrow window (14).** When the room between the sidebar and the side panel cannot hold two panes
  of 360 (`SPLIT_PANE_MIN`) and a divider, the two become two tabs over one pane, a dot on the hidden
  tab when what it shows changed.
- **Phone.** No split: the Split button is not offered, and anything sent to "split" opens in the main
  view. No drag.
- **Two panes at most.** The split is not kept across a reload; the panel stack is not either.
- **⋯ and ✕ on both panes**, both heads being the same: ✕ on the left closes the left — the right's
  content becomes the main view, as the right's Only this pane does.
- **The window's title bar stays as a strip while split** (the window is dragged by it, its buttons
  are drawn in it), empty of the room's address; the room's tools in it (Tasks' run reading toggle
  and New task) are not drawn while split.
- **The side panel's rule** while the focused pane's own path is on a task is that task's context
  beside its conversation (`convo`: Steps, Produced, Changes, Held): its conversation is on screen in
  the pane. On anything else (an artifact, a state) or on the room, the room's rule.
- **The split is the window's**, like a pinned panel stack: it stays as the person moves between the
  Tasks, Files and Chat rooms, and is not drawn in the others.
- **A row's long press is not its menu once it became a drag** (`pressWasDrag`): the row's own press
  never hears the release, which lands on the drag's sheet.

## Build order

1. The icons and the place group on `PublishedView`, moving between the main view and the side panel.
2. The right pane: its stack, focus, divider, ⋯ menu, the panel following focus.
3. The narrow tabs and the phone rule.
4. Drop zones for an artifact's title bar; a sidebar row dragged onto a pane.
5. (Amended) Two equal panes: both heads with crumbs, the real views, the left's path, "Open here".
