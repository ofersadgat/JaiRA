---
id: ux/patterns/show-the-request-not-the-outcome
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/move-work-on-by-hand, product/decisions-stay-yours, product/hand-work-to-agents]
siblings: [ux/patterns/stream-then-settle, ux/patterns/drag-only-where-the-process-allows, ux/patterns/park-and-ask, ux/patterns/button-says-what-will-happen]
---

# Show the request, not the outcome

When the person asks for something whose result the system decides, the product shows what was asked and waits for the system to say what happened. A sent message appears in the chat marked as pending until the chat's record holds it. A piece of work moved by hand stays where it was until the process moves it, and an answered question stays answerable until the system reports it settled. When the result differs from the request, what really happened is shown: re-running finished work opens the new copy that actually runs.

## Use it when the system owns the result and an early display could claim something false

**Use when.** A process decides whether work moves, a record decides what was said, or a decision checks the answer. Showing the result before the system reports it could claim something that never happens.

**Do not use when.** The effect is local and certain, such as folding or filtering: apply it at once. When the result arrives as output worth watching, carry on from the pending request with [stream-then-settle](stream-then-settle.md).

## The request is shown as taken, and the result replaces it only when reported

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Sends a message, moves work by hand, answers a question, or re-runs work | Shows a message as pending, and leaves moved work and an answered question as they were | The request was taken |
| 2 | Waits, or keeps working | Carries out the request, which may join a turn already running | The result is not known |
| 3 | Nothing | Replaces the pending message with the recorded one, moves the work, settles the question, or opens the work that actually ran | What actually happened |

## Every state shows either the request as asked or the result as recorded

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | The first message of a new chat is pending until the chat's record holds it | Wait, or stop the work |
| empty | Cannot occur: the pattern exists only once a request is made | Make a request |
| loading | A pending message sits above the answer it provoked. Moved work and an answered question show no sign that the request is on its way | Wait |
| partial | A message sent while a turn is running joins that turn and stays pending until the turn records it, and several can be pending at once | Wait, or send another |
| error | A refused send is reported in the chat and the message stays pending until the person leaves the chat. If the first message's work fails to start, the message stays pending and the failure is not shown in the chat | Send again, or start the work again |
| denied | Moving work to a place the process does not accept is refused as the work is dropped, and it returns to where it was, as in [drag-only-where-the-process-allows](drag-only-where-the-process-allows.md) | Move it where the process is waiting |
| success | The recorded message replaces the pending one with nothing shown twice, moved work appears in its new place, and a re-run opens the work that ran | Read the result, or follow the work |

## A request cannot be withdrawn, and leaving loses only the pending display

A request is sent the moment it is made, so there is nothing to undo here. Its result is reversed by [rewinding](../../product/rewind-to-where-it-went-wrong.md) the work.

Leaving a chat while a message is pending discards the pending display. The message itself was sent, and it is there once recorded when the person comes back.

## Waiting takes no input and is not announced, and a slow system keeps the request pending longer

**Keyboard only.** Waiting for a result takes no input.

**Screen reader.** Nothing announces that a message is pending, or that its record arrived.

**Small window.** Nothing about a pending request depends on the width of the window.

**Slow machine.** A pending message stays pending as long as the system takes to record it. Moved work appears in its new place when the view next updates, which happens as the work records progress.

## This departs from the UX principles in two places

A message whose words repeat an earlier message in the same chat is never shown as pending, so nothing stands for it while it waits.

A first message whose work fails to start stays pending, with the failure out of sight.
