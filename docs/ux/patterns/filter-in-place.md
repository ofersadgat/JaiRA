---
id: ux/patterns/filter-in-place
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/chat-with-agents, product/author-processes-without-memorising-the-format, product/find-out-why-the-app-misbehaves, product/keep-track-of-everything]
siblings: [ux/patterns/ordered-by-urgency-then-recency, ux/patterns/pick-from-what-exists, ux/patterns/absence-is-stated]
---

# Filter in place

A list that can grow long narrows as the person types, in the same place, without opening another view. Conversations are matched by title and files by path. For those two lists the filter appears only when the person asks for it, and takes the typing focus at once. A file tree being filtered flattens to the matching files, so a match deep inside closed folders shows without opening them. A log keeps its filters always present: how severe an entry must be at least, where it came from, and its text. It asks the system for matching entries instead of narrowing the entries already shown. In the conversation and file filters, Escape clears the typed text.

## Use it when the person knows part of a name and the list is long

**Use when.** The person knows part of what they want, and scrolling for it would be slow: a conversation, a file, a log entry of some severity or source.

**Do not use when.** The person needs to search inside things: the conversation and file filters match titles and paths, never what is inside. A name must be given and only existing names are valid: offer them with [pick-from-what-exists](pick-from-what-exists.md). The problem is what comes first, not how long the list is: [ordered-by-urgency-then-recency](ordered-by-urgency-then-recency.md).

## The list narrows with each keystroke and comes back whole in one step

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Asks for the filter | Shows the filter with typing focus in it | They can type |
| 2 | Types | Narrows the list at each keystroke. A log waits for a short pause in typing, then asks for the matching entries | What matches |
| 3 | Presses Escape or deletes the text | Restores the full list | Everything is back |

## Every state shows the matches or says there are none, except the file tree

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | The full list, unfiltered | Type to narrow it |
| empty | Conversations with no match say nothing matches. A file tree with no match shows no files and says nothing. A log with no match says there is nothing to show, the same as a log with no entries | Change the text, or clear it |
| loading | Conversations and files narrow at once. A log says it is reading while matches arrive, and offers older matches as the person scrolls | Scroll for older entries |
| partial | A filtered file tree lists only the matching files, flat, without their folders | Open a match, or clear the filter |
| error | Conversation and file filters cannot fail: they narrow what is already shown. A log whose query fails shows no error | Change a filter to ask again |
| denied | Cannot occur: anyone who sees a list can filter it | Type |
| success | The narrowed list | Open an item |

## Clearing restores the list, but a closed file filter keeps narrowing the tree

Clearing the text restores the full list at any time. Closing the conversation filter also clears its text. Closing the file filter hides it but leaves the tree narrowed by the text until the filter is opened and cleared.

Typing into the file filter discards a new file or folder name being typed into the tree, because the flattened tree has nowhere to put it. No filter is kept across a restart.

## Filters take focus and clear by keyboard, and the number of matches is not announced

**Keyboard only.** The conversation and file filters take the typing focus when they open, and Escape clears them. The log's filters are reached by Tab, and its text is cleared by deleting it.

**Screen reader.** How many items match is not announced as the list narrows. The log's filters have names, and the conversation and file filters are named only by their placeholder text.

**Small window.** The list narrows where it stands, so filtering needs no more room than the list.

**Slow machine.** Conversation and file filters rework the whole list at each keystroke, and the file filter walks the whole tree each time. A log waits for a pause of 0.18 seconds in typing before it asks the system.
