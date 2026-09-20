---
id: ux/patterns/follow-the-live-edge
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/watch-agents-work-live, product/chat-with-agents]
siblings: [ux/patterns/stream-then-settle, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/say-what-it-is-doing-and-for-how-long]
---

# Follow the live edge

While a conversation grows, the view stays on its newest part for as long as the person is reading there. Once the person moves back into earlier content, arrivals stop moving the view, so what they are reading stays put. Moving back to the end follows again. In a chat, a single action also returns to the end while work is under way, and sending a message always does. Going to a marked place in the conversation stops following, and every conversation opens at its end. This holds for a chat, a piece of work's conversation, one step's conversation and a helper agent's conversation.

## Use it when content grows at one end and the person both watches and reads back

**Use when.** Output arrives at the end while the person watches it, and they also read back through what came before. Pair it with [stream-then-settle](stream-then-settle.md), which decides how the arriving output is shown.

**Do not use when.** The content does not grow while it is viewed. Or the person must be taken to one particular place: use [jump-to-the-place-and-mark-it](jump-to-the-place-and-mark-it.md), which releases the view from following.

## Where the person stands decides whether the view follows

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens a conversation, or stays at its end | Opens it at the end and keeps the newest content in view as it arrives | They are seeing the latest |
| 2 | Moves back into earlier content | Leaves the view where it is, and in a chat with work under way offers the way back to the end | They are reading history, and nothing will pull them away |
| 3 | Moves to the end, uses the way back, or sends a message | Follows again | They are back at the latest |
| 4 | Goes to a marked place in the conversation | Stops following so that place stays in view | Arrivals will not take them away from it |

## Every state keeps the person either at the newest content or where they chose to read

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: every conversation opens at its end, however far back the person had read in another | Read, or move back |
| empty | Nothing has arrived, so there is nothing to follow, and the conversation says so as in [absence-is-stated](absence-is-stated.md) | Wait, or send a message |
| loading | Each arrival lands in view while the person stands at the end or within about a line of it | Watch, or move back |
| partial | The person has moved back and arrivals leave the view alone. A chat with work under way offers the way back, and every other conversation offers none, so the person moves to the end themselves | Return to the end |
| error | Cannot occur as its own state: following only decides where the view stands, and a failure arrives like any other content | Read the failure |
| denied | Cannot occur: nothing about following is refused | Keep reading |
| success | The person is at the end and sees each arrival as it lands | Keep watching, or move back |

## Following changes nothing, and the reading position is not kept

Following moves only the view, so there is nothing to undo. The reading position lasts only while the conversation stays open. Opening another conversation, or coming back to this one, starts at the end.

## The way back is reached by Tab, nothing is announced, and the view never shows an arrival at the old position

**Keyboard only.** The way back to the end in a chat is a standard action reached by Tab. No key of its own returns to the end.

**Screen reader.** Nothing announces that following stopped, or that the way back is on offer.

**Small window.** Following behaves the same at any width.

**Slow machine.** The view moves to the newest content before that content is drawn, so an arrival never appears first at the old position.
