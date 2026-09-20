---
id: ui/components/review-notes
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/quote-anchored-note, ux/patterns/jump-to-the-place-and-mark-it]
serves: [product/decide-with-the-context-in-front-of-you, product/review-changes-before-they-land]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/reviewNotes.tsx]
verified_by: [packages/app/test/selectionHold.test.ts]
mockups: [ui/assets/review-notes/composing.html, ui/assets/review-notes/threads.html, ui/assets/review-notes/record.html]
siblings: [ui/components/artifact-pane, ui/components/changeset-review, ui/components/review-artifact-gate]
---

# Review notes

A small floating card at a text selection, signed with the author's name, quoting the passage behind an amber rule over a `What should change here?` box with `Comment` and `Cancel`, and under the content a bordered list headed `2 notes` whose threads each quote their passage in grey italic above signed messages and a `Reply as {author}…` box.

## Review notes are the one way to write, list and answer a note on a passage

**Use when.** A person comments on a passage of an artifact under review or on lines of a proposed change. [artifact-pane](artifact-pane.md) and [changeset-review](changeset-review.md) host both halves: the card at the selection and the thread list under the content.

**Do not use when.** The remark is about the whole review: that is the comment box of [choice-list](choice-list.md). The content cannot be selected, such as a picture or a change that cannot be shown. How notes turn a verdict into a send-back belongs to [review-artifact-gate](review-artifact-gate.md), and the washes on marked passages belong to the pane that holds the text.

## The quote reads first in both halves, and the words about it follow

- **Card.** 320px wide on `--panel` with a 1px `--line` border, radius 10px, the lift shadow and 10px padding, its parts 8px apart: a 13px comment glyph in `--dim` beside the author's name at 600 in `--text`; the quote in italic `--dim`, 8px in from a 2px `--warn` rule; a three-row box in the data face; then a primary `Comment` and a ghost `Cancel`.
- **List.** 12px under the content, in a 1px `--line` border with radius 8px. A head on `--panel-2` in `--dim` holds the comment glyph and the count. Each thread below it is padded `8px 10px` under a `--line` hairline.
- **Thread.** The quote centred on one line in italic `--dim`, with a small ghost ✕ at the row's right. Each message sits 6px under the last and 8px in from a 2px `--line` rule: the glyph and author at 600 in `--dim`, then the words in `--text` with their line breaks kept. Last, 10px in, a reply box and a ghost `Reply`.

## A note is being written, is listed, or is part of the record

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a drawn list: with no notes nothing is drawn under the content, and the card exists only while a passage is held. | |
| loading | Cannot occur: a saved note is listed at once, with nothing to wait for. | |
| composing | The card at the selection with the focus in its box. `Comment` is disabled at half opacity until the box holds words. | [composing.html](../assets/review-notes/composing.html) |
| threads | The list, each thread in the order written, replies under the note they answer. The thread whose passage the pointer is over, in the list or in the text, takes `--fill-ghost-hover`. A note whose words are no longer in the content reads `text changed` in upright `--warn` at half opacity where its quote was, and keeps its messages and reply box. | [threads.html](../assets/review-notes/threads.html) |
| error | Cannot occur as its own look: a note whose words are gone is the `text changed` thread above. | |
| record | A sent review read in a settled set of changes: the threads with no ✕ and no reply box. A settled single artifact lists no threads and keeps only its washes. | [record.html](../assets/review-notes/record.html) |

## Saving lists the note, and the list leads back to each passage

| On | Does | Feedback |
| --- | --- | --- |
| Enter or `Comment`, with words in the box | Saves the note, signed and dated | The card closes, the passage is washed, and the thread joins the list with the count raised |
| Shift and Enter | Starts a new line in the note | The box scrolls; it keeps three rows |
| Escape or `Cancel` | Discards the note | The card closes and the passage is let go |
| Press inside the card | Keeps the passage held | The passage stays washed |
| Click a quote | Selects its passage again in the content | The passage is selected and scrolled into view |
| ✕ | Deletes the thread at once, with no confirmation and no undo | The thread goes, the count drops and the wash goes |
| Enter or `Reply`, with words in the box | Adds a signed reply to the thread | The message appears last in the thread and the box empties |
| Pointer over a thread | Lights its passage | The row takes `--fill-ghost-hover` and the host deepens the passage's wash |

## The copy is the person's name, the quote and five verbs

| Where | String |
| --- | --- |
| Author | `{name}` from the repository's identity, or `you` when it has none |
| Note box | `What should change here?` |
| Card buttons | `Comment` · `Cancel` |
| List head | `1 note` · `{n} notes` |
| Quote | `{passage}` with runs of white space made single; over 90 characters, its first 44 and last 44 around `…` |
| Quote tooltip | `show this passage` · `this passage is no longer in the artifact` |
| Gone passage | `text changed` |
| ✕ tooltip | `delete this thread` |
| Reply | `Reply as {author}…` · `Reply` |

## The card is pinned to the window and the list is the keyboard's way to a passage

- The card keeps 320px. It opens 8px below the selection, or above it when less than 160px of window is left under the selection, and never nearer than 8px to the window's side edges. It is fixed to the window, so it stays where it opened when the content scrolls.
- The list spans its host, from the 360px context panel to a wide conversation column. A quote stays on one line, and one wider than the line is clipped at both ends with no ellipsis; messages wrap.
- Theme: every colour is a token, and the quote's rule stays `--warn` in both themes.
- Focus: the card takes the focus in its box, and Tab reaches `Comment` and `Cancel`. In an artifact the card opens only when a pointer selection is released, so a note cannot be started from the keyboard. In the list Tab reaches each quote, ✕, reply box and `Reply`; a `text changed` quote is skipped.
- Missing content: a person with no name in the repository's identity signs as `you`.

## The quote and the note's words depart from the two voices

- A quoted passage is data, and is set in the app face in italic.
- A note is typed in the data face and listed in the app face.
