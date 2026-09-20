---
id: ux/patterns/quote-anchored-note
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/decide-with-the-context-in-front-of-you, product/review-changes-before-they-land]
siblings: [ux/patterns/comments-turn-a-verdict-into-send-back, ux/patterns/per-change-review, ux/patterns/jump-to-the-place-and-mark-it]
---

# Quote-anchored note

The person selects a passage of a document under review, or lines of a proposed change, and writes a note about it. The note keeps the exact words it was written against and where they were, is signed with the name the person's repository identity gives or a generic name when there is none, and is listed with the other notes, quoting its words. On a document the passage stays marked, choosing a listed note selects its passage again, and pointing at a marked passage or at its note lights the other. When the text around the words changes, the note follows its words, and where they occur more than once it takes the occurrence nearest where it was written. When the words are gone, the note stays and says its text changed rather than pointing at other words. Notes take replies and can be deleted until the review is sent.

## Use it when feedback is about one part of a long text and the reviser needs to know which

**Use when.** A person reviews a document or a set of code changes, and whoever revises must find the exact place each remark applies to.

**Do not use when.** The subject has no text to select, such as an image or a change that cannot be shown: comment on the whole thing. The remark is about the whole: use the review's general comment. Either way the review then behaves as in [comments-turn-a-verdict-into-send-back](comments-turn-a-verdict-into-send-back.md).

## The person selects, writes, and the note stays tied to its words

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Selects a passage of a document with the pointer and lets go, or selects lines of a change | Opens a note beside the selection, quoting the words, with the focus in the note | Which words the note is about |
| 2 | Writes and saves | Records the words, their position, the author and the time, and lists the note. On a document, marks the passage | That the note is attached where they meant |
| 3 | On a document, chooses a listed note or points at a marked passage | Selects the note's passage again and brings it into view, or lights the note that belongs to the passage | Where each note applies |
| 4 | Replies to a note, or deletes it | Adds the signed reply under the note, or removes the note and its mark | The thread as it will be sent |

## Every state keeps a note either on its words or saying they are gone

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a review with no notes lists none and behaves like any other | Select a passage |
| empty | An empty document says it is empty and offers nothing to select. A note with no words cannot be saved | Write the note, or comment on the whole |
| loading | Cannot occur: attaching and marking happen as the person acts | Keep writing |
| partial | On a document, a note being written keeps its passage marked while the focus is in the note | Save it, or cancel it |
| error | A note whose words are no longer in the text stays, says its text changed, and cannot select a passage | Delete it, or reply to say what it meant |
| denied | An image, or a change that cannot be shown, takes no notes | Comment on the whole thing |
| success | The note is listed with the count of notes, its passage is marked on a document, and the review's stated outcome counts it as feedback | Reply, delete, or send the review |

## A note can be withdrawn until the review is sent, and leaving the review loses every note

Cancelling a note being written, by its own action or by Escape, discards it. Deleting a saved note takes effect at once, without confirmation and without undo. In a set of changes, refusing a whole change discards the notes on it without asking.

Once the review is sent, its notes are part of the record and cannot change.

Leaving the review before it is sent discards every note, and the review stays waiting.

## Notes on a document need a pointer, and marked passages are invisible to a screen reader

**Keyboard only.** On a document a note opens only when a pointer selection is released, so there is no keyboard way to start one. In a change's lines any selection opens a note at once and moves the focus into it, which ends a selection being made by keyboard. In a note, Enter saves, Shift with Enter starts a new line, and Escape cancels.

**Screen reader.** Marked passages are painted over the text and are not exposed to assistive technology. The listed notes quote their words, which is how a screen reader user learns where each applies.

**Small window.** A note opens beside its selection, is kept within the window's width, and opens above the selection when there is no room below. It keeps a fixed width, and it does not follow the passage when the text scrolls.

**Slow machine.** Each pointer movement over the text searches the whole text for every note's words to decide which one to light.

## This departs from the UX principles in one place

Refusing a whole change discards the notes written on it without asking, because a note on a change that has left the review has nothing to be about.
