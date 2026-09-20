---
id: ux/patterns/second-deliberate-step-for-irreversible
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/keep-history-within-bounds, product/parallel-work-without-collisions, product/author-processes-without-memorising-the-format, product/chat-with-agents, product/hand-work-to-agents, product/run-headless-and-in-ci]
siblings: [ux/patterns/arm-the-cut-then-confirm, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/verbs-on-the-thing-itself]
---

# Second deliberate step for the irreversible

An act that destroys something for good, or silently breaks what depends on it, never happens on one gesture. It takes one of three forms. A confirmation states exactly what will be lost, including what is not obvious, and that none of it comes back. A preview works out what would be removed, what would be kept and why, and a separate destructive action then applies it. An attempt that would break other things is refused with the names of what depends on the target, and the person may then go ahead anyway. From a terminal, the same guard is a flag the command needs before it acts.

## Use it when a loss is permanent or would break something without saying so

**Use when.** Deleting work or a chat, deleting or renaming a process file others refer to, trimming history, or removing a copy of the code that holds uncommitted changes.

**Do not use when.** The act can be undone: do it at once. The loss is part of a history shown in place: use [arm-the-cut-then-confirm](arm-the-cut-then-confirm.md). There is no way to go ahead: use [refuse-with-the-reason-and-the-fix](refuse-with-the-reason-and-the-fix.md).

## The loss is stated first, and a second deliberate act performs it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Asks for the destructive act, or for a preview | States what will be lost, works out the preview, or refuses and names what depends on the target | What will be lost, kept or broken |
| 2 | Confirms, applies, or goes ahead anyway | Performs the act | It is done, and final |
| 3 | Cancels, or dismisses the preview, instead | Changes nothing | Nothing was lost |

## Every state says what would go, what went, or why it cannot go

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a first destructive act is asked about like any other | Confirm, or cancel |
| empty | A preview that finds nothing old enough to remove says so | Change the age, and preview again |
| loading | The confirmation closes as soon as it is given, and nothing shows the act under way until it ends or fails | Wait |
| partial | A preview says how much history would go and how many unfinished pieces of work it keeps so they can still resume. Applying uses the age as it stands at that moment, which may differ from the one previewed | Apply, or dismiss |
| error | A failure after confirming is reported apart from the item until dismissed. Deleting several pieces of work stops at the first failure, leaving the rest in place | Retry what remains |
| denied | Deleting running work is unavailable, and a chosen set skips running work and says so. Renaming or deleting a process file others refer to is refused, naming them and saying how they will break | Stop the work first, or go ahead anyway |
| success | The item is gone, and a trim says how much history remains | Carry on |

## Nothing can be undone once confirmed, and cancelling loses nothing

A confirmed act is final, and where that is not obvious the confirmation says none of it comes back. Deleting a piece of work also removes its copy of the code, uncommitted changes included.

Cancelling, dismissing a preview, or pressing outside the question loses nothing.

## The confirm action holds focus, so a single Enter commits, and Escape does nothing

**Keyboard only.** The confirmation puts focus on its field, or on the confirm action when there is nothing to type, even when that action destroys. Enter commits, Escape does nothing, and focus is not kept inside the question. The reasons a trim keeps work are shown only on pointing at them.

**Screen reader.** The confirmation is not announced as a question needing a response.

**Small window.** The confirmation keeps a minimum width, so in a very narrow window part of it falls outside the window.

**Slow machine.** Deleting several pieces of work removes them one after another, each with its copy of the code, so a large set takes a while and shows nothing under way.

## This departs from the UX principles in one place

Deleting a piece of work discards the uncommitted changes in its copy of the code, and the confirmation says so, because that copy exists only for that work.
