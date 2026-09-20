---
id: ux/patterns/drag-only-where-the-process-allows
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/move-work-on-by-hand]
siblings: [ux/patterns/show-the-request-not-the-outcome, ux/patterns/park-and-ask, ux/patterns/waiting-requests-gathered]
---

# Drag only where the process allows

A piece of work can be moved by hand only when a running process is waiting for exactly that move. Only such work can be picked up, and while it is held, the places the process would accept are distinguished from the rest and the one under the pointer is marked. Dropping it asks the process to take the move. The work stays where it was until the process has moved it, as in [show-the-request-not-the-outcome](show-the-request-not-the-outcome.md), and then appears in its new place. Inside the work, the wait says where the work must go and how long it has waited, and offers the same move as an explicit action. A wait that would end the work rather than move it offers no move. Work waiting for a move is not gathered with the other requests in [waiting-requests-gathered](waiting-requests-gathered.md).

## Use it when a person's judgement completes a step by moving the work on

**Use when.** A process leaves the move to its next stage to a person, and moving the work is the natural way to say it is ready.

**Do not use when.** The move would bypass the process: it is never offered. The person must choose among outcomes or give an answer: use [park-and-ask](park-and-ask.md).

## The person drops the work where the process accepts it, and the process moves it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Picks up a piece of work that a process is waiting to have moved | Distinguishes the places that would take it, and marks the one under the pointer | Where it may go |
| 2 | Drops it on one of them, or takes the explicit action inside the work | Delivers the move to the waiting process and leaves the work where it was | That the move was asked for |
| 3 | Nothing | Shows the work in its new place once the process has moved it | That it moved |

## Every state shows the work where the process has it, not where it was dropped

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: work becomes movable only when a process waits for it | Nothing |
| empty | No process waits for a move, so no work can be picked up | Nothing |
| loading | Between the drop and the process moving it, the work stays where it was, with nothing marking the move as sent | Wait |
| partial | A wait whose destination is not among the places shown offers no place to drop, though the explicit action inside the work still offers the move | Take the explicit action |
| error | A move the process stopped waiting for before the drop landed is dropped without a word, and the work stays where the process left it | Open the work to see where it is |
| denied | Dropping anywhere that would not take the work is refused on the spot, and the work returns | Drop it on a distinguished place |
| success | The work sits in its new place, and the wait inside the work is gone | Follow the work |

## A move the process has taken cannot be undone, and an abandoned drag loses nothing

Once delivered, the process carries on from the move. The way back is to [rewind](../../product/rewind-to-where-it-went-wrong.md) the work to before it.

Letting go anywhere that does not take the work, or cancelling the drag, leaves everything as it was.

## Dragging needs a pointer, and the explicit action is the keyboard route

**Keyboard only.** Work cannot be dragged by keyboard. The explicit action inside the work is a standard button and makes the same move.

**Screen reader.** Movable work and accepting places are not announced as such. The wait inside the work states in text where the work must go.

**Small window.** When the accepting place is out of view, the explicit action inside the work makes the same move.

**Slow machine.** The work appears in its new place only when the view refreshes after the process has moved it, so the move can lag behind the drop.
