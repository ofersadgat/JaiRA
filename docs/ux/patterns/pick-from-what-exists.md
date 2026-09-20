---
id: ux/patterns/pick-from-what-exists
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/author-processes-without-memorising-the-format, product/hand-work-to-agents, product/chat-with-agents, product/bring-your-own-models-and-agents]
siblings: [ux/patterns/schema-driven-form, ux/patterns/own-answer-beside-offered-options, ux/patterns/name-it-where-it-will-live, ux/patterns/filter-in-place]
---

# Pick from what exists

Wherever a person must name something that already exists, the names that exist at that point are offered, narrowing as the person types, so a name misremembered by one character is never entered. This covers a value wired into a step, a condition, a step or function to call, a process to start work on, a file mentioned to an agent, a model, and a field a document may hold. Offers are scoped to what is valid in that position: what a wire can read is not what a condition can read. A mentioned file goes with the message. A value outside the offers is still accepted where the target accepts one.

## Use it when the valid names are knowable and a wrong one would fail later

**Use when.** The names that can go in a position are known to the system, and a wrong name would fail only when work runs or an agent reads it.

**Do not use when.** The value is free text by nature. The person answers a question from offered answers: use [own-answer-beside-offered-options](own-answer-beside-offered-options.md). The thing is being named for the first time: use [name-it-where-it-will-live](name-it-where-it-will-live.md).

## The person types, takes a real name, or knowingly types past the offers

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Starts typing a name, or the mention mark for a file | Offers the matching names valid in this position | What exists here |
| 2 | Takes an offer | Puts the name in, and for a mentioned file attaches its content to the message | The name is real |
| 3 | Keeps typing past the offers | Accepts the typed value where the target accepts values outside the offers | They chose something not offered |

## Every state leaves the person able to type on or narrow the offers

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: offers come from what exists, not from what the person used before | Type |
| empty | No match offers nothing. With no project open, mentioning a file offers nothing | Type the value freely |
| loading | File offers are fetched as each character is typed, and an answer for text already typed past is dropped | Keep typing |
| partial | When more names match than are shown, the offers say how many more and to keep typing | Type more to narrow |
| error | A mentioned file that cannot be read goes with the message as a note carrying the reason | Remove it, or mention another |
| denied | Nothing offered is refused. A process with errors can still be picked for new work, and the pick says how many errors it has and that it will probably fail | Pick another process, or start anyway |
| success | The real name is in place | Carry on |

## A taken name is removed like typed text, and a mentioned file is lost with an unsent message

Removing an inserted name is ordinary editing. A mentioned file stays attached until the message is sent or the file is removed. Leaving the conversation before sending discards it.

## Offers work by keyboard, but each place uses different keys

**Keyboard only.** In the document editor, arrow keys move through field offers, Tab takes one rather than leaving the field, Escape hides them until the next edit, and Enter is never taken. For file mentions, Enter takes the first match and Escape closes the offers, and arrow keys do not move through them. Offers in forms follow the platform's own suggestion list.

**Screen reader.** Offer lists other than the platform's own are not announced as lists of choices.

**Small window.** Offers that would run past the edge of the view open on the other side of the text. File mentions show a short list that scrolls.

**Slow machine.** File offers are asked for on every keystroke without waiting for a pause, and older answers are dropped.
