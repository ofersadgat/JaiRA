---
id: ux/patterns/jump-to-the-place-and-mark-it
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/catch-process-mistakes-before-running, product/complete-record-of-every-run, product/everything-waiting-on-you-together, product/find-out-why-the-app-misbehaves, product/decide-with-the-context-in-front-of-you]
siblings: [ux/patterns/problems-marked-where-they-are, ux/patterns/drill-in-and-back-out, ux/patterns/follow-the-live-edge, ux/patterns/waiting-requests-gathered, ux/patterns/choose-a-side-where-it-divided]
---

# Jump to the place and mark it

Anything that points at a place takes the person there when chosen: a problem in a process, a bookmark into a long run, a side of a divided history. The jump switches to the reading that holds the place, opens whatever folds hide it, brings it into view, and marks it for about a second so the eye lands on it. When the place is not drawn because its content is still being read, the jump waits and lands once the place appears. A note on a passage marks its passage by selecting it again. A code definition in another file opens that file at the definition. A log entry and a waiting request open the work they name without marking a place inside it.

## Use it when a list or summary refers to places inside larger content

**Use when.** Problems, bookmarks, notes or sides are listed apart from the content they are about, and the person needs to see the place itself to act.

**Do not use when.** What the pointer refers to is short enough to show beside the pointer. The place is a level the person should be able to return through: go into it with [drill-in-and-back-out](drill-in-and-back-out.md). The target is the newest output: [follow-the-live-edge](follow-the-live-edge.md) keeps the view there.

## Choosing a pointer brings the place into view and marks it briefly

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Chooses a pointer | Switches to the reading that holds the place, opens folds that hide it, and brings it into view | They are being taken to the place |
| 2 | Nothing | Marks the place for about a second, first waiting for the place to be drawn if it is still being read | Exactly where the place is |
| 3 | Chooses the same pointer again after moving away | Brings the place into view and marks it again | The pointer still leads there |

## Every state either lands on the place or leaves the view where it was

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a pointer exists only once there is a place for it to point at | Choose a pointer |
| empty | A problem about a whole file has no place inside it, so it is not offered as a pointer | Read the problem where it is listed |
| loading | A bookmark into a run whose conversation is still being read waits, then lands when the place appears | Wait |
| partial | A log entry or a waiting request opens the work it names, with no mark on a place inside it | Find the place in the work |
| error | A place that no longer exists or cannot be found gets no jump, and nothing says so | Look for the place by reading |
| denied | Cannot occur: every pointer shown leads somewhere the person may go | Choose it |
| success | The place is in view and briefly marked | Act on it |

## A jump moves only the view, and the scroll position it left is not kept

A jump changes nothing in the content, so there is nothing to undo, and a mark ends on its own. Going back through the address returns to the earlier place but not to where it was scrolled.

## Most pointers are buttons, focus stays on the pointer, and arrival is not announced

**Keyboard only.** Problems, bookmarks, sides of a divided history and the links in a log entry are standard buttons reached by Tab. A waiting request is chosen by pointer only. After a jump, focus stays where it was and does not move to the place.

**Screen reader.** Arrival at the place is not announced, and the mark is not conveyed.

**Small window.** The place is brought into view within whatever the window shows.

**Slow machine.** A bookmark tries again each time more of the conversation arrives, so it lands late but lands.
