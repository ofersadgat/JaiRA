---
id: engineering/decisions/0024-canvas-opens-to-edit
type: decision
status: built
updated: 2026-11-07
decides_for: [engineering/decisions/0020-artifacts-and-the-design-canvas]
---

# 0024. A canvas opens to edit, runs by the artboard, and takes comments

The person, 2026-11-07: "i thought the design for the canvas had all the figma style ui with it. i
didnt see any ui to select / move / manipulate / add ui elements / add comments / etc". Then: "There is
a mismatch in design here. The default is edit mode and if the user wants to, they can click run on an
element or on the whole panel which runs the ui in the element or panel as though it were real. Please
look at docs for the Claude design canvas for a comparison."

Mockup: https://claude.ai/artifact/JkX2HXDA9wn3Z2fTDuWiLG (today first, then the proposal).

## What was wrong

Decision 0020 built the editor (every tool, the panels, saving, Play, Export), but a canvas opened as a
board you could only look at, with clicks switched off on every artboard. The editor was behind a small
Edit button at the far right of that board's bar, and the phone had no editor at all. Play only
appeared once something was selected, and it replaced the whole canvas with one artboard.

Claude Design is the other way round. Its sources:

- The Design type's own `reference/format.md`: artboards marked `"is_interactive": true` "get the
  blue mark and a Play button", and a link between artboards "moves Play to that artboard, in place or
  full window (not while editing)".
- Anthropic's support pages: whoever can save gets the editor ("click-to-select, a properties panel,
  inline text editing"), and a viewer without write access gets a preview to view and export. Comments
  have a mode: click an element or artboard, write, and a "Send to Claude" checkbox decides whether
  Claude takes the comment as a request.

## Rulings (2026-11-07)

1. "We can leave off run element. I meant artboard." Run is per artboard. There is no per-element run.
2. "Interactive ones." ▶ is offered only on an artboard marked `is_interactive`, as in Claude Design.
3. "I think we should follow Claude codes example." The editor is what opens for whoever can save. The
   board stays only where nobody saves.
4. Comments: "Now."

## What is built

**Opening.** On a computer, a canvas at its newest version opens straight into the editor:
inline in the conversation, in the side panel, and in the main view. Its Edit and Done buttons are
gone. Where nobody saves, the board is drawn instead: a version a newer one replaced (a save over it
would only be refused), and the phone. On the board an interactive artboard still has ▶.
(`PublishedView.editing`)

**Running.** ▶ on an interactive artboard's label runs it where it sits. The runtime switches it to
`play`, the frame takes the pointer, and it gets a green ring and "· running". The other artboards
stay editable around it. On a running artboard's label, ■ stops it and ⤢ fills the editor's box with
it. That view keeps the old Play view's "← Back to the canvas" and adds "Full screen". A link to
another artboard moves the run to that artboard, which is panned into view. In the full view, the view
follows the link. "▶ Run canvas" in the top bar runs every interactive artboard, and "■ Stop" (or Esc)
stops them all. The "Works" checkbox in an artboard's Properties is what marks it interactive. The old
"▶ Play" that depended on a selection is gone.

**Comments.** There is a Comment tool (C) in the rail. A press on an artboard puts a pin where it
landed, over the element there. The runtime's `dc:pick` now carries `at`, the press in the artboard's
own pixels. The box takes the words and has a "Send to Claude" checkbox, ticked by default. Pins are
numbered in the order they were written. An opened pin shows what was written, where it went, and
Resolve / Reopen / Delete. A Comments tab lists them all, can show the resolved ones, and opens a pin
and brings its artboard into view.

- Stored in `artifact_comments` (migration 34), beside the versions and never in `canvas.json`. There,
  a comment would be a person's edit of that file, and the model's next publish of it would be refused
  over a note. The table is synced (`artifactComment`), carried in a replica's bundle, and deleted with
  its task. It is only in the database, whatever `storage.artifacts` says: a comment is resolved and
  removed, which a row file's last-wins log would keep as rows that never leave.
- A comment for Claude goes into the task's conversation as the person's own message, under the
  composer's kept settings (`chatSettings`), through `sendChatMessage`. The send is started, not
  awaited. The message names the canvas (title and `artifact://` address), the artboard file, the
  place, and the element (tag, its own words, its template id at the version it was written on).
  `commentMessage` in `service.ts` builds it.
- A note for people is never sent, and Claude has no tool to read comments.
- IPC: `artifact:comments`, `artifact:comment`, `artifact:settleComment`.

**Found and fixed while checking it in the app.** Opening in the editor by default puts it in narrow
columns: a conversation's column in the side panel gives the board about 170 px.

- *Narrow.* Below 760 px the properties panel is closed, and the top bar's "Panel" button or Ctrl+\
  (Claude Design's own toggle) opens it over the board. The top bar wraps. Before this, the rail, a
  board at least 280 px wide and the 250 px panel overflowed the column, and the top bar's controls
  ended up outside it.
- *Fit.* The editor fitted the canvas once, from its first width, and narrowing then left the artboards
  wider than the board. Now it fits again whenever its box changes size, until the person pans or
  zooms. It is never fitted from a box not yet measured, and never below 5%. The top bar has a Fit
  button. This is the same fix the board got in e20f0dcb.
- *A drawn artboard drew "no such artifact".* A frame loads from the grant of the version the canvas
  opened at, which does not hold a file drawn after it. This dates from 0020. Now it is framed from the
  grant of the version that first saved it (`serveVersion`), with a placeholder until then.
- *A frame that loads again showed its old text.* A frame back from the full view loaded its grant's
  text, which was behind the person's saves. Now it is handed the editor's text whenever the two
  differ.
- *A comment named the opened version.* Its element id is of the editor's current source. The editor's
  own version is now sent with each comment.
- *A stopped artboard kept the run.* Running let the design scroll its own page and build up state
  (an input focused near the edge scrolls it). Stopped, it stayed that way, and a press landed on bare
  page and picked nothing. Now an artboard that stops is loaded afresh from its source (its frame's
  key), in the editor and on the board: a run is a trial.
- *The top bar kept one height.* Wrapped, it grew and shrank as the status changed and controls came
  and went, and each change of the board's height fitted the canvas again under the pointer. Its words
  now give way first (an ellipsis), and past that it scrolls.
- *A comment's box ran off a narrow board.* It is now a float against its pin (`popover.tsx`, the
  standing rule), so the board's edges no longer clip it.

## Round 2: the person's notes on the real conversation (2026-11-07)

In "I dont like how the chat panel looks…" (t-elvj5dhzoy): "1. i dont see any of the ui buttons. 2. why
does it say that there is a v16, but I dont see it in the conversation? 3. I should be able to pan with
pressed middle click 4. the attached is how the claude code version looks 5. sometimes panning will
select the elements 6. I think the eye icon to see the artifact full screen in the main panel makes more
sense than having it open in the side panel. I think an arrow to the right pointing at a vertical line
… would be better for open in side panel".

- **1 and 2 had one cause.** v16 was the person's save, and it was `canvas.json` reformatted: a press on
  an artboard's name saved even when nothing moved. A version the person saves belongs to no call, yet
  it counted as replacing v15's card. So every card read "v16 is newer · Show vN", no card drew v16, and
  "Show v15" opened the look-only board, which has no buttons. Now only Claude's publishes replace a
  card (`callCardOf`, `publishedCard.ts`), and the newest call's card shows the person's newest version
  in the editor. A press that moves nothing saves nothing.
- **3 and 5.** The middle button pans from anywhere: the bare board, a label, a note, a handle. Over an
  artboard, the frame takes the press, so its runtime tells the host where the pointer is (`dc:pan`,
  start / move / end, in the frame's pixels). The host places that in the window from where the frame
  stands as it reads it, pans by how far it moved, and commits at once (`flushSync`). Distances measured
  inside the frame do not work, because the frame moves under the pointer as the pan goes: 40 px panned
  119, then 26. Space held pans too, the capture layer laid over the frames. The look-only board pans
  with the middle button as well.
- **4.** The editor's chrome is now Claude Code's. The board is the whole box. A floating bar at the top
  left holds the tools, with pen / line / arrow and rectangle / oval each behind a ⌄ (and pages, when
  there are several). A floating bar at the top right holds the version or save status, ▷ (run the
  canvas) or ■, the properties panel toggle (Ctrl+\), and the zoom % ⌄ (fit, 50, 100, 200). Each
  artboard's label has its title on the left and, at the artboard's right edge, ▶ (interactive ones),
  ⤢ (on its own) and ⬇ (a PNG or PDF menu). The properties panel is a floating card. Menus are
  Popovers. The narrow top bar, the side rail and the selection-bound PNG / PDF buttons are gone. On a
  board narrower than 600 px the tools wrap and the canvas bar moves to the bottom right, because the
  two ran into each other at the top.
- **6.** The eye shows the artifact in the main view. →| (⇤ turned round) opens it in the side panel.

Seen: `shots/canvas.mts` passed end to end twice in a row on this round's code (full suite: 449 files
pass). The label press and the middle pan (exactly 40, 30, both runs) are now its own checks. Its last step opens the main view through the eye, for
comparison with Claude Code's picture.

## Round 3: keyboard shortcuts (2026-11-08)

The person: "the canvas should have common keyboard shortcuts like ctrl+z for undo".

- **Undo and redo.** Ctrl+Z undoes, and Ctrl+Shift+Z or Ctrl+Y redoes (Cmd on a Mac). `canvasHistory.ts`
  keeps what the canvas was before each edit: `canvas.json` as the editor holds it, and every artboard's
  source, up to 200 steps. One press, one drag or one key is one step: the calls made in one turn are
  kept together, and a drag is recorded once, at its first move. An undo is an edit of the files, so what
  it changed is saved as the person's next version. It never rewinds the version history, and Claude's
  publishes are not undone.
- **Copy, cut, paste, duplicate.** Ctrl+C, Ctrl+X, Ctrl+V and Ctrl+D work on what is selected.
  - A note: pasted a step down and to the right.
  - An artboard: becomes a new file (`<Name>Copy.dc.html`) beside the original, its source copied.
  - An element: goes in right after the selected element, or last in a selected artboard's outermost
    box (`elementMarkup`, `insertAfter` in the runtime's `edit.ts`).
  The clipboard is the window's, so an artboard copied in one canvas can be pasted into another.
- **The rest.**
  - Arrows nudge a selected artboard or note by 1 px, or 10 with Shift. An element sits in its page's
    flow, so it is still dragged.
  - Enter edits the text of a note, or of an element holding one text.
  - Ctrl+= and Ctrl+- zoom in and out, Ctrl+0 is 100%, Shift+1 fits, and Shift+2 zooms to the selection.
    The zoom menu lists these.
  - The existing keys stay: Delete, Esc, Ctrl+\, Space held, and the tools' letters.
- **Whose keys.** Several editors can be open at once: inline, in the side panel, and in the main view.
  Before this, a key read off the window reached every one of them. Now the keys belong to the editor
  the person last pressed in (its board, its bars, its menus and comment boxes, which carry
  `data-canvas-keys`, or one of its artboards). A press anywhere else gives them back to the page. When
  an artboard holds the focus, its runtime tells the editor its keys (`dc:key`), in edit mode only,
  since a running artboard's keys are the design's.

Seen: `shots/canvas.mts` gains a keys step. Ctrl+D copies an artboard into its own file, Shift+→ moves the
copy 10 px, Ctrl+Z twice takes both back with the file, Ctrl+Y redoes and Ctrl+Z undoes again, each saved
as the person's version. Ctrl+0 shows 100% and Shift+1 fits. With an artboard holding the focus, Ctrl+Z
and Ctrl+Shift+Z come back to where they were. After a press outside the editor, Ctrl+Z saves nothing.
Its first drag now presses on an element of the design, not the bare margin, where it drags nothing.

## Not done

- **Comments on the phone and on the board.** The phone has no comment tool and no pins. The board
  for older versions draws no pins.
- **Live comments.** Comments are read when the editor opens and after each of the person's own
  changes. One made on another device appears when the canvas is opened again.
- **Claude answering in a thread.** Claude answers a comment in the conversation, not under the pin.
- **The thread can fold the editor away.** In one rig run the conversation redrew with its turn
  folded ("Every step · 46 notes", the composer briefly "no model configured"), and the editor
  inline under it was unmounted, taking a running artboard with it. Saved edits survive, since a save
  is a second after a change. The cause is the conversation's folding, not looked into here.
- **The phone's editor.** Anthropic's own pages disagree on whether Claude Design edits in its phone
  apps.

## Seen

- Tests: `packages/app/test/artifactComments.test.ts`. It covers the store, the change log, deletion
  with the task, refusals, the failure when the task has no conversation, the send into a real chat
  task's conversation, and the message's wording.
- The real app with a real agent: `packages/app/shots/canvas.mts` (see its header), in the side panel's
  narrow column. The editor opens with no Edit or Done. Select, delete, move and every drawing tool
  save, and a drawn artboard draws. ▶ runs an artboard in place, where a click in it picks nothing,
  then ⤢ and ■. PNG and PDF export. A note and a comment for Claude are pinned: the note is kept and not
  sent, and the comment reaches the conversation naming the editor's version. A pin is opened and
  resolved.
- It passed end to end on the final product code. Other runs on that same code failed in the rig:
  the design differs every run, and the bare-margin point and the thread fold above both cost runs.
  The rig now presses only where the frame names an element.
- Rig traps: the thread scrolls back toward its live edge after a save, so scroll first, let it settle,
  then measure. The exports folder must be emptied first, since an export of the same artboard keeps
  its name. Don't press anything by its text when the agent's reply may say the same word.
