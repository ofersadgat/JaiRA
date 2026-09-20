---
id: ux/patterns/choose-a-side-where-it-divided
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/try-another-direction, product/rewind-to-where-it-went-wrong, product/complete-record-of-every-run, product/chat-with-agents]
siblings: [ux/patterns/arm-the-cut-then-confirm, ux/patterns/nested-under-what-caused-it, ux/patterns/drill-in-and-back-out, ux/patterns/jump-to-the-place-and-mark-it]
---

# Choose a side where it divided

Where a history divided, a marker at the point of division says how many sides there are, which one is shown, and what each is. A history divides when a message in a chat is replaced, when a step runs again after failing or stopping, and when work is branched into a copy. Each side is named by what differs: a chat's sides by the message that opens each, a step's attempts by how each ended. Choosing a side shows it in place of the other, or goes to it and briefly marks it. A branched copy carries a marker back to the work it came from.

## Use it when alternatives of one history coexist and each must stay readable

**Use when.** The same history went two or more ways, and the person needs to read any of them without losing their place.

**Do not use when.** The history has one side: no marker appears. The inner work was started by the outer work rather than replacing part of it: use [nested-under-what-caused-it](nested-under-what-caused-it.md). The person is about to divide the history: that is [arm-the-cut-then-confirm](arm-the-cut-then-confirm.md), and this pattern takes over once it is done.

## The marker says the history divided, and choosing a side shows it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Reads past a point where history divided | Shows the marker with the number of sides and which one is shown | More exists here than they see |
| 2 | Opens the marker | Lists every side by name, oldest first, with the shown one marked | What each side is |
| 3 | Picks a side | Shows it in place, or goes to it and briefly marks it | Which side they are reading |
| 4 | Follows a copy's marker back | Opens the work the copy was branched from | Where this copy came from |

## Every state shows one side and keeps the others one choice away

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a marker appears only once history divides, and the first behaves like any other | Open the marker |
| empty | A history with one side has no marker | Read on |
| loading | Cannot occur as its own state: the sides arrive with the record they belong to | Read the record |
| partial | An older side of a chat is read-only and carries no live output. A chat replaced more than once has a marker only at its newest division | Pick the newest side to carry on |
| error | A copy whose origin was deleted says the origin no longer exists, and offers no way to it | Read the copy as it stands |
| denied | Cannot occur: every side can be read | Pick any side |
| success | The chosen side is shown, and the marker names it | Read it, or pick another |

## Choosing a side changes nothing, and the choice is forgotten on leaving

Choosing a side changes only what is read, so picking another undoes it. The choice is not kept: leaving the chat or the work and coming back shows the newest side again.

## The marker is reached by Tab, but its list of sides has no arrow-key movement

**Keyboard only.** The marker is a standard action reached by Tab and opened with Enter. The list of sides does not take focus and does not move with arrow keys, its choices come after everything else on the page in Tab order, and Escape closes it.

**Screen reader.** The marker is announced as opening a menu and reads out the number of sides and the side shown.

**Small window.** A long side name is cut short on the marker, and the list gives each name in full.

**Slow machine.** The sides come with the record already loaded, so choosing one waits on nothing.
