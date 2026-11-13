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
ahead build it".

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
3. **A split (05, 06, 07, 10, 12).** The room's middle column can split into two panes, two at most,
   with a divider between them whose width is remembered like any pane (`PANE.splitRight`). The left
   pane is the room's middle column as today. The right pane has its OWN PATH: ‹ and › and a trail of
   crumbs in its head; holding ‹ (or pressing the name) lists the pane's path in a menu.
4. **Anything can go in a pane (06):** an artifact, a task's run or conversation, a state, a value.
5. **Focus.** The pane last pressed in is focused: a 2px --accent line along its top (an inset shadow,
   never a coloured left edge). A row pressed in the sidebar's Chat or Tasks list opens in the focused
   pane: on the right pane's path when that is focused, as today when the left is.
6. **The side panel follows the focused pane (10).** With the right pane focused on a task, the panel
   is that task's context; with the left focused, the room's rule as before.
7. **The pane's ⋯ menu (12):** Swap the panes, Only this pane, Move to the side panel, Close this pane.
8. **Drag (08, 09).** An artifact card's title bar dragged shows three drop zones over the room (Main
   view, Split, Side panel); a drop opens it there. A row of the sidebar's Chat or Tasks list dragged
   onto a pane opens it in that pane (the left: as a press does today; the right: on its path). Web and
   desktop only.

## The model

The right pane is a **panel stack** (`panelStack.ts`): the same entries, pushed, popped, gone forward
through (`ahead`), and drawn by the same faces (`faces.tsx` through `SidePanel`, in its `pane` frame).
Nothing new draws a task, a state or an artifact. `splitModel.ts` is the rest, pure: the split (its
stack, which pane is focused, which tab shows when narrow), the path's menu (`historyOf`, `walkTo`),
where a press from the sidebar lands (`routeOpen`), the panel's rule while the right pane is focused
(`focusRuleOf`), a place button's move (`placeMoveOf`), and whether two panes fit (`splitFits`).

An artifact's places are read from where it stands: `artifactInMain`, the side panel's top, the
right pane's top (`shownPlacesOf`). `PlaceButtons` lights them and moves between them; every way of
putting something somewhere (the buttons, the ⋯ menu, a drop) goes through `placeEntry`.

The split is the shell's state (`viewState.ts`' `splitView`), one for the window, drawn in the
Tasks, Files and Chat rooms beside their middle column. `PanelColumn` draws the right pane before its
own column, so the pane's faces get the same `FaceHost` the panel's do, over the pane's own stack.

## Chosen, not ruled

- **Narrow window (14).** When the room between the sidebar and the side panel cannot hold two panes
  of 360 (`SPLIT_PANE_MIN`) and a divider, the two become two tabs over one pane, a dot on the hidden
  tab when what it shows changed.
- **Phone.** No split: the Split button is not offered, and anything sent to "split" opens in the main
  view. No drag.
- **Two panes at most.** The split is not kept across a reload; the panel stack is not either.
- **A conversation in the right pane** is the task's conversation as the side panel draws it
  (`TaskConversation` over the task's own run), live, with its gates, approvals and the panel's own
  composer ("Ask for more changes…"), which sends into it (seen in `shots/split-view.mts --send`). It
  is not the Chat room's thread: that one's composer, its walk-ins and its title are bound to the
  store's one open conversation (`state.chat`, `chatSurfaceOf`). Swap or Only this pane brings it to the
  left as the Chat room's.
- **The ⋯ menu is the right pane's.** The left pane is the room's middle column, whose own head is
  the title bar. "Only this pane" makes the right pane's content the main view and closes the split.
- **The side panel's rule** while the right pane is focused on a task is that task's context beside
  its conversation (`convo`: Steps, Produced, Changes, Held): its conversation is on screen already.
  Focused on anything else (an artifact, a state), the panel keeps the room's rule.
- **The split is the window's**, like a pinned panel stack: it stays as the person moves between the
  Tasks, Files and Chat rooms, and is not drawn in the others.

## Build order

1. The icons and the place group on `PublishedView`, moving between the main view and the side panel.
2. The right pane: its stack, focus, divider, ⋯ menu, the panel following focus.
3. The narrow tabs and the phone rule.
4. Drop zones for an artifact's title bar; a sidebar row dragged onto a pane.
