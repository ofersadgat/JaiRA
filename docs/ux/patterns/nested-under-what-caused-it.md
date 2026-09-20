---
id: ux/patterns/nested-under-what-caused-it
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/watch-agents-work-live, product/complete-record-of-every-run, product/large-work-splits-into-independent-pieces]
siblings: [ux/patterns/drill-in-and-back-out, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/choose-a-side-where-it-divided, ux/patterns/stream-then-settle]
---

# Nested under what caused it

Work started by other work is shown inside the work that started it, not beside it as a peer. A helper agent's conversation sits under the tool call that started it, and can be opened in place or entered as a level of its own, and helpers it starts nest the same way. Pieces a step split off are named at that step, each with its standing and a way to go to it, and the step marks the ones it waits for. Work made for another piece of work is filed with that work, and a piece holding for others says which.

## Use it when the inner work is the outer work's machinery or parts

**Use when.** The person asked for the outer work, and the inner work exists to carry it out: a helper agent an agent started, or the pieces a step split its work into.

**Do not use when.** The inner work is a peer the person manages on its own terms: list it with the rest, and keep only a pointer where it was made. Two sides of one history are not parent and child: use [choose-a-side-where-it-divided](choose-a-side-where-it-divided.md).

## The outer work shows where inner work began, and the person opens or enters it there

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Reads the outer work | Shows where inner work was started, with how much it said or how it stands | Something was started here, and how it stands |
| 2 | Opens it in place | Shows the inner conversation under the call, live while it runs, as in [fold-to-a-summary-expand-in-place](fold-to-a-summary-expand-in-place.md) | What it did or is doing |
| 3 | Or enters it | Makes the inner conversation a level of the address, as in [drill-in-and-back-out](drill-in-and-back-out.md) | Where they stand, and the way back out |
| 4 | Goes to a split-off piece | Opens that piece | How that piece stands |

## Every state keeps the inner work reachable from where it was caused

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: nesting appears only once work has started other work | Read the outer work |
| empty | A helper agent that has produced nothing says it has said nothing | Wait |
| loading | The outer conversation says it is loading, and a running helper's output arrives live under its call | Watch, or enter it |
| partial | Split-off pieces show their standing as it changes, and a piece holding for others says which pieces it waits for, or how many | Go to a piece |
| error | Entering something that is not a helper's conversation says so. A helper's conversation that no longer exists drops from the address without a word | Go back up the address |
| denied | In a chat, a helper's conversation opens only in place and cannot be entered | Read it in place |
| success | The inner work reads inside the outer, and each split-off piece is one step away | Read it, or go to a piece |

## Opening changes nothing, and what was opened in place closes on leaving

Opening or entering inner work changes only what is read, so there is nothing to undo. Openings in place are not kept: leaving the outer work closes them.

## Opening works by keyboard, entering gives inner work the whole view, and it loads only when opened

**Keyboard only.** Opening in place, entering, and going to a split-off piece are standard actions reached by Tab. No key goes back out: the person uses the address.

**Screen reader.** Nothing announces new output from a running helper.

**Small window.** Entering a helper's conversation shows it as the whole conversation, without the outer work around it.

**Slow machine.** Entering a helper's conversation fetches its record at that moment, and what arrives live is shown as it comes.
