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
ahead build it". Amended three times the same day (below): "07 and 09 are the correct design for split
view panels"; "both panels should be fully self contained. I.e. their ui should be identical. You should
be able to close either of them."; and "like 09, each panel goes the whole way top to bottom. they both
have breadcrumb paths and are identical other than potentially different paths. when you open something
in a split view, the only thing different there is that you're opening a different path. if you opened
the same path, the two panels should look pixel identical".

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
   remembered like any pane (`PANE.splitRight`). Each goes the whole way top to bottom, its head at
   the window's top. The panes are IDENTICAL but for their paths: one component, the same head — ‹ Back,
   › Forward walking the pane's history, crumbs saying where what it shows stands (as amended
   2026-11-24: not its history), ⋯, ✕ — and the same view for the same place, to the pixel. Holding ‹,
   or pressing the last crumb, lists "This pane's history", newest first, the current one marked. One
   pane is the unsplit main view.
4. **Anything can go in a pane (06), as the real view:** a conversation is the Chat room's thread with
   its composer, a task's run its run, an artifact the artifact — not a side panel's face. The room's
   own view is an entry like these, on whichever pane holds it.
5. **Focus.** The pane last pressed in is focused: a 2px --accent line along its top (never a coloured
   left edge). A row pressed in the sidebar's Chat or Tasks list lands in the focused
   pane. The focused pane is the main view as far as the rest of the app is concerned (the person,
   2026-11-24: "whatever panel is focused should be treated as the active/main panel"): the room
   follows it (`followOf`) — in Chat the focused pane's conversation is the open one (its start page,
   none), in Tasks its task is the selected one, the board staying where it is — so the sidebar's
   selected row, the side panel and the address are the focused pane's. Following moves no path
   (`roomMoved`); a pane on an artifact, a state or a run's subagent leaves the room where it was.
   Each pane keeps its own history (the person, 2026-11-24: "each pane should have its own history
   that the arrows should navigate through"): the room moving within itself — a sidebar row, a new
   conversation — is a step on the focused pane's path, which its ‹ and › walk; only the window coming
   to a room drops what was on top, and the start page is taken the place of by what is opened from it.
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
  `headless`): the pane's head names it and carries its three place buttons. (Undone by the third
  amendment: the head is the path's, and the place buttons are the artifact view's.)
- **Closing is symmetric** (`closePane`): the other pane is the only view, its path kept. Swap
  exchanges the panes with their paths; Only this pane is closing the other.
- **The room's address is in the head of the pane holding the room** while that pane has a head
  (`RoomAddress` from `TitleBar.tsx`: the Tasks room's crumbs with its run reading toggle and New task,
  the conversation's name, the file's) — the room's tools stay with the room.
- **The main view is the first pane** in a room with panes: an artifact sent there goes on that
  pane's path. `artifactInMain` is what is left where there are no panes: a phone, the Debug room.

## Amended 2026-11-13 (third): one path, one picture

The person rejected the second build ("the main chat and the split view aren't identical panels"):
an empty window-wide strip sat over both panes, the heads differed (the room's pane carried the
conversation's glyph and its "this machine / project" chip, an artifact's carried its place buttons),
and the room's conversation was drawn by the room's thread while the same conversation in the other
pane was drawn another way. Then the ruling quoted above. What changed:

- **No title bar over a room with panes** (`UniversalApp.tsx`): each pane's head is at the window's top.
  The empty stretch of a head is what the window is moved by (`DRAG_REGION`), as the title bar's was.
  The OS draws the window's buttons over the top row's right end (`titleBarOverlay`): the side panel's
  head keeps them clear at its end while it stands open (`SidePanel`'s `top`); folded or absent, the
  last pane's head does (less the rail's 60), and the folded rail starts under them.
- **A head is a function of the path only**: ‹ › crumbs ⋯ ✕, the same pieces in the same order. The
  place buttons are the artifact's view's (its title bar, the same in either pane), not the head's;
  the room's address (the Tasks room's crumbs and tools) is the crumb of the room's own entry
  (`RoomAddress`), drawn for that path, whichever pane holds it.
- **One function draws a path** (`PaneBody`), in every pane and unsplit alike. What the room stands
  on is `here` (`splitModel.ts`): the room's own entry (the board, the file, the Chat start page,
  which only the room draws) or — the Chat room on a conversation — that conversation's own entry, so
  the room's conversation and the same conversation opened anywhere else are one path, one view.
- **The same path is the same picture**, which the rig measures (below), and four things that made a
  view's picture depend on its history rather than its path were fixed on the way: the focus line is a
  2px row in every pane's flow (a box laid over the pane put its text in another layer, smoothed
  differently; an inset shadow bled a hairline along its foot); each pane is a layer of its own
  (`will-change`), so what stands beside it does not change how its text is smoothed; the day over a
  thread is worked out where the thread settles and, nothing having passed under it, is the first
  message's day (`ChatThread`), not whatever a scroll last left.
- **Leaving a pane is going back**: what a pane gives away (an artifact moved to another place) is
  ahead of it, › away (`leavePane`).

Measured (shots/split-view.mts): the same conversation in both panes and the same artifact in both
panes, each pane photographed while the other is focused (neither focused in its own picture), the
panes equally wide at an even width; and the unsplit main view of the conversation at the pane's width
against the pane's content. The numbers are in the build's commit.

## Amended 2026-11-24: crumbs are where a pane stands, ‹ › where it has been

The person: "why did you make the header a breadcrumb of the history? the breadcrumb is meant to be a
resource path / hierarchy, not history", then "Yes, build it". Until then a pane's one list was both:
its entries were its crumbs and what ‹ walked back along, so every step a pane took became a crumb
("A › B › C" for three conversations opened in turn), and pressing a crumb lower down cut the list
there. They are two things now:

- **A pane's path is its history** (`PanePath`: where it has been, oldest first, what it shows last;
  what › goes forward to in `ahead`). Every opening is a step on the pane it lands in — a sidebar row,
  a link inside it, a place button, a crumb — and somewhere it has been before is a new step, not a
  walk back (`pushPath`). ‹ and › walk it, and holding ‹ (or pressing the last crumb) lists "This
  pane's history". The Chat start page is the one step that what is opened from it takes the place of.
- **The crumbs say where what it shows stands** (`trailOf`, `parentOf`), whatever way the pane came to
  it: an artifact under its conversation; a run's subagent, a rerun, a command's terminal, a step of a
  run under its task; a conversation, a task, a state, the room's own view alone. Each crumb but the
  last goes there ("Go to …"), a step.
- **An artifact is opened in a pane as a step** like anything else (`artifactPathOf` and
  `openPathInPane`, which put the conversation › artifact trail in as history, are gone): its crumbs
  say it stands under its conversation; ‹ goes back to what the pane showed. Moved to another place,
  its pane goes back a step, or closes if it held nothing before it (`leavePane`).
- **A link inside a pane's face** (a face steps a panel stack, whose push walks back to what is lower
  down) is taken by where it lands (`PanelColumn`'s `onPaneStack`): the same place changed is changed
  where it stands; somewhere else is a step; the stack walked back goes up to the shown entry's parent.

## The model

A pane's path is its history, in a panel stack's shape (`entries`, what › goes forward to in `ahead`)
of the side panel's entry kinds and the room. `splitModel.ts` is pure: the panes, which is focused, which
tab shows when narrow; ‹ › (`paneBack`, `paneForward`, `pushPath`); the crumbs (`trailOf`, `parentOf`);
the history's menu (`historyOf`, `walkTo`); opening on a pane's path (`openInPane`, `openInSplit`); closing, Only this pane
and Swap (`closePane`, `onlyPane`, `swapPanes`); the room moving to stand on `here` (`roomMoved`);
where a press from the sidebar lands (`routeOpen`: the room goes there itself while the focused pane
stands on `here`, else the pane goes on); the panel's rule (`focusRuleOf`); a place button's move (`placeMoveOf`,
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
- **The Chat room's conversation has no title bar of its own any more**: its name is the pane's crumb.
  Renaming it, and the model and placement chips the bar carried, are where the thread itself draws
  them (the composer's chips, the placement under the box) or the conversation list's ⋯.
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
6. (Second amendment) One pane component; the room an entry; symmetric ✕.
7. (Third amendment) No title bar over panes; heads by path alone; one function draws a path; the
   pixel comparison in the rig.
