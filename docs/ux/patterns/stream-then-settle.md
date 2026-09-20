---
id: ux/patterns/stream-then-settle
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/watch-agents-work-live, product/complete-record-of-every-run, product/chat-with-agents, product/steer-agents-mid-task]
siblings: [ux/patterns/follow-the-live-edge, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/nested-under-what-caused-it, ux/patterns/show-the-request-not-the-outcome]
---

# Stream then settle

While an agent or model works, what it produces appears as it arrives: its words, its reasoning, the tools it uses, and the work of any helper agents it starts, shown under the call that started them as in [nested-under-what-caused-it](nested-under-what-caused-it.md). Everything still arriving is marked as in progress, and text still arriving is shown as plain text, so half of a formatted structure cannot swallow what follows it. When the call ends, its permanent record takes the stream's place in one step, formatted, with nothing missing and nothing shown twice. A call that ends before it finishes keeps what had arrived as its record and says so.

## Use it when a call runs long enough that its output is worth watching

**Use when.** A call takes seconds to hours, and what it produces along the way lets the person judge whether it is heading the right way: an agent working a step, or a reply in a conversation. Pair it with [follow-the-live-edge](follow-the-live-edge.md) to keep the view on the newest output.

**Do not use when.** The result arrives at once. Or a partial result would mislead because it only means something whole: show it once complete, and say what is happening meanwhile with [say-what-it-is-doing-and-for-how-long](say-what-it-is-doing-and-for-how-long.md).

## Output arrives in place and becomes the record without a gap or a repeat

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Starts work or sends a message | Shows the message as pending, as in [show-the-request-not-the-outcome](show-the-request-not-the-outcome.md), then appends each fragment as it arrives and states the activity under way: writing, thinking and for how long, or which tool is running on what | That it is working, on what, and for how long |
| 2 | Watches, or leaves and comes back | On return, rebuilds the stream from everything that had already arrived and carries on from there without repeating a fragment | Nothing was lost while they were away |
| 3 | Nothing | When the call completes, puts its formatted record in the stream's place in one step | The answer is complete and final |
| 4 | Stops the work, or the app closes mid-call | Keeps what had arrived as the call's record, with a note that the call ended before it finished and that everything shown is what was recorded | What they see is all that was produced before the end |

## Every state says whether the output is still coming, complete, or cut short

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A new conversation shows the opening message as pending and states that work is under way until the first fragment arrives | Wait, or stop |
| empty | A conversation or helper agent that has produced nothing says that nothing has been said yet | Send a message, or wait |
| loading | Fragments as they arrive, in plain text, with the activity under way and how long thinking has taken | Watch, [steer](../../product/steer-agents-mid-task.md), or stop |
| partial | A call that was stopped or cut off shows what had arrived, with the note that it ended before finishing | [Resume](../../product/pick-up-where-it-left-off.md) the work, or rewind it |
| error | A failed call is marked as failed where it ended, and the reason for the failure is stated with the conversation | Read the reason, then resume or rewind the work |
| denied | Reasoning the provider withheld is shown as having happened and marked as withheld, and it cannot be opened | Keep reading: nothing more can be recovered |
| success | The formatted record in the stream's place, with nothing missing and nothing repeated | Read it, or continue the conversation |

## Watching changes nothing, and closing mid-call loses at most the last moment of output

Watching a stream changes nothing, so there is nothing to undo. Leaving the conversation loses nothing, because the stream is held apart from the view and rebuilt on return.

While output arrives, the call's in-progress record is saved at most every 0.4 seconds. If the app closes mid-call, what had been saved stays as the call's record, and at most the output of that last interval is lost.

## Streaming takes no input, is not announced to a screen reader, and redraws the whole conversation per fragment

**Keyboard only.** Streaming needs no input, so a keyboard-only person watches it like anyone else.

**Screen reader.** Arriving output and the stated activity are not announced. A person using one learns of new output only by reading the conversation again.

**Small window.** Text still arriving wraps to the width of the conversation, so a narrow window hides none of it.

**Slow machine.** Each arriving fragment redraws the whole conversation, and a long conversation is drawn in full. While a call is in flight, only its newest 500 messages and tool events stay in the stream, and the settled record holds all of them.
