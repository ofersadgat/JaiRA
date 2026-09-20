---
id: ux/patterns/arm-the-cut-then-confirm
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/rewind-to-where-it-went-wrong, product/try-another-direction, product/chat-with-agents]
siblings: [ux/patterns/choose-a-side-where-it-divided, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/verbs-on-the-thing-itself, ux/patterns/button-says-what-will-happen]
---

# Arm the cut, then confirm

To take work back to an earlier point, or to replace or branch from a message in a chat, the person first arms the point. The product then shows in place what the act would change. A rewind marks everything from the point on as about to be lost, counts it, and names what is deleted. Replacing a message says that everything after it is left behind, and branching a chat says the next message starts a new chat while this one stays unchanged. Nothing happens until the person confirms the rewind or sends the message. Cancelling disarms and leaves everything as it was.

## Use it when an act discards or leaves behind part of a history

**Use when.** The person must see exactly which part of a history an act would lose or leave behind before it happens, or the act changes what sending the next message will do.

**Do not use when.** The act discards a whole item: use [second-deliberate-step-for-irreversible](second-deliberate-step-for-irreversible.md). The act loses nothing: branching a piece of work from a step opens the copy at once, with no arming.

## Arming shows the consequence in place, and only confirming or sending acts

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Chooses to rewind, replace or branch at a point | For a rewind, marks and counts what would be lost and names it. For a replacement or a chat branch, says what sending will now do | Exactly what the act would change |
| 2 | Confirms the rewind, or sends the message | Cuts the history at the point, or starts the replacement or the new chat | The work carries on from the point |
| 3 | Cancels instead | Disarms, clears any unsent message, and restores the view | Nothing changed |

## Every state shows what the cut would take, or what it took

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: arming is offered only on history that exists | Arm a point |
| empty | A history with no point to cut at offers no rewind, replacement or branch | Start the work |
| loading | A rewound piece of work enters the step again and carries on. In a chat, nothing shows the cut under way until the shortened chat appears | Wait |
| partial | Armed: what would be lost is marked and counted, a rewind of work adds that files it edited stay as they are, and the next action says what it will do | Confirm or send, or cancel |
| error | A failed rewind of work is reported apart from the conversation until dismissed. A failed rewind in a chat is not shown | Try again |
| denied | Rewinding running work is refused with the reason that it must be stopped first, and in a chat that refusal is not shown | Stop the work, then rewind |
| success | A rewind ends the history at the point and the work carries on. A replacement leaves the old side readable, and a branch opens the new copy | Follow the work |

## A confirmed rewind is permanent, and an armed point is lost on leaving

A confirmed rewind cannot be undone, and what it cut does not come back. Files an agent changed are not restored by it. A replaced message stays readable through [choose-a-side-where-it-divided](choose-a-side-where-it-divided.md). A branch leaves the original untouched, and the copy is deleted like any other work.

Arming, and any message typed for a replacement or branch, are lost when the person leaves the chat or the work.

## Arming works by keyboard, but focus stays put, and one rewind confirms on a single Enter

**Keyboard only.** The actions that arm a point are standard actions reached by Tab, each named for what it does. Arming does not move focus to the confirmation or to the message box, and Escape does not cancel. A rewind asked from a piece of work's details is confirmed in a separate question whose confirm action already holds focus, so a single Enter rewinds.

**Screen reader.** An armed rewind is presented as an alert asking for a response, and the line counting what would be lost reads as a note.

**Small window.** The statement of what the act will do is cut to one line, so in a narrow window part of the consequence can be hidden.

**Slow machine.** Arming asks the system for nothing, so it is immediate however slow the machine.

## This departs from the UX principles in one place

In a chat, a rewind under way, its failure and its refusal are not shown.
