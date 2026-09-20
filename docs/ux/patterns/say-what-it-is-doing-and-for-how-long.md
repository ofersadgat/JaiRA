---
id: ux/patterns/say-what-it-is-doing-and-for-how-long
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/watch-agents-work-live, product/pick-up-where-it-left-off, product/steer-agents-mid-task, product/keep-process-and-description-in-step]
siblings: [ux/patterns/stream-then-settle, ux/patterns/live-facts-and-unseen-counts, ux/patterns/absence-is-stated, ux/patterns/follow-the-live-edge]
---

# Say what it is doing and for how long

Whenever something is under way, the product says in words what it is doing and how long it has been at it, counting while it happens. An agent is thinking, answering, writing a named file with how much it has written, or running a named tool on what. A piece of work is running in a named step, or waiting on the person there, with how long it has taken. One wait is counted by one clock only. Stopping is a phase of its own: the work says it is waiting for the agent to finish what it is doing, and a forced stop is offered rather than taken. When the activity ends, the outcome takes its place.

## Use it whenever something takes more than a moment

**Use when.** An agent's call, a piece of work, a check that reads the process and its description, or a stop takes long enough that the person could wonder whether anything is happening, and could leave and come back.

**Do not use when.** The operation is instant. Or many pieces of work are summarised at a glance: use [live-facts-and-unseen-counts](live-facts-and-unseen-counts.md). When the output itself is worth watching, pair this with [stream-then-settle](stream-then-settle.md).

## The activity is named and counted until the outcome replaces it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Starts work or sends a message | Says work is under way, then names the activity and what it acts on, and starts counting | It is working, on what, and for how long |
| 2 | Watches, or leaves and comes back | Keeps the statement current as the activity changes, counting each from when it began | Whether it is moving or has stalled |
| 3 | Asks to stop | Says it is stopping and waiting for the agent to finish, and offers a forced stop | It is stopping, and that they can insist |
| 4 | Nothing | Replaces the activity with the outcome, and a finished thought states how long it took | It ended, and how |

## Every state says what is happening now, or what ended

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Before anything arrives, the work says only that it is working | Wait, or stop |
| empty | Nothing is under way, so no activity is stated, and work that completed says nothing beyond its result | Read the result, or start work |
| loading | The current activity with its count: thinking counts in tenths of a second, a file being written counts its size, and everything else counts in seconds. A chat being answered is marked busy where chats are listed | Watch, [steer](../../product/steer-agents-mid-task.md), or stop |
| partial | A stopping piece of work says it is waiting for the agent to finish, with a forced stop on offer from the start. Work waiting on the person says where and for how long | Force the stop, or answer |
| error | The activity gives way to the failure, and failed or stopped work says so with the way to carry on | Read the reason, then resume or retry |
| denied | Cannot occur: stating progress refuses nothing | Keep watching |
| success | The activity gives way to the outcome, and a finished thought keeps its duration | Read the result |

## Watching changes nothing, and a stopped piece of work is carried on by resuming it

Stating progress changes nothing, so there is nothing to undo. A stop, once asked, is not withdrawn: the work is carried on afterwards by [resuming](../../product/pick-up-where-it-left-off.md) it.

Leaving loses nothing. On return, the activity is stated again with its count from when it began.

## Stop is reached by Tab, progress is not announced, and a narrow window shortens the description

**Keyboard only.** Stop and forced stop are standard actions reached by Tab.

**Screen reader.** Neither the activity nor its count is announced as it changes.

**Small window.** A description too long for the width is cut short, and the count stays whole.

**Slow machine.** A count ticks only while its activity is under way, ten times a second for thinking and once a second otherwise, and stops when the activity ends.

## This departs from the UX principles in one place

While answers to a question open follow-up questions, nothing says that the next questions are being prepared.
