---
id: ui/components/artifact-pane
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/quote-anchored-note, ux/patterns/one-document-several-readings]
serves: [product/read-what-work-produced, product/decide-with-the-context-in-front-of-you]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/value-view, ui/components/markdown-view, ui/components/markdown-editor, ui/components/file-changes-list, ui/components/review-notes]
implemented_by: [packages/app/src/renderer/components.tsx, packages/app/src/renderer/reviewNotes.tsx]
verified_by: [packages/app/test/selectionHold.test.ts]
mockups: [ui/assets/artifact-pane/reading.html, ui/assets/artifact-pane/edited.html, ui/assets/artifact-pane/edited-data.html, ui/assets/artifact-pane/writing-a-note.html, ui/assets/artifact-pane/notes.html]
siblings: [ui/components/value-view, ui/components/changeset-review, ui/components/diff-editor]
---

# Artifact pane

A bordered well on the page ground holding one artifact in its reading, a small `Rendered | Source` switch at its top right, and, when anything is typed into it, the change drawn over the text with a `Revert` button beside the switch, with the review's notes listed under the well.

## An artifact pane is the body of a gate about one artifact

**Use when.** A process shows a person one artifact to judge or to change: the body of [review-artifact-gate](review-artifact-gate.md) and of [edit-artifact-gate](edit-artifact-gate.md). It reads, edits and takes notes on the one document in one place.

**Do not use when.** A value is shown in a transcript or a panel with nothing to decide: use [value-view](value-view.md). The artifact is a set of file changes: use [changeset-review](changeset-review.md).

## The artifact reads first, its switch and Revert sit above it, and the notes follow it

- **Well.** `--bg` with a 1px `--line` border, radius 8px, 10px padding, 12px under the heading, at most 46% of the window's height, scrolling inside itself.
- **Header.** The artifact's [value-view](value-view.md) header across the top of the well: the reading switch, such as `Rendered | Source` with the chosen reading in `--text`, and the `…` menu, both otherwise in `--tok-hint`. `Revert` stands before them as a ghost button once the text differs from what arrived.
- **Artifact.** Markdown in the app face through [markdown-view](markdown-view.md), or through [markdown-editor](markdown-editor.md) when it may be edited; other types in their own reading.
- **Marked passages.** A passage a note is about has a 26% `--warn` wash and a dotted `--warn` underline. The passage whose thread the pointer is over deepens to 55% with a solid underline.
- **Note being written.** A 320px floating card at the selection, drawn by [review-notes](review-notes.md), while the passage keeps a 30% `--accent` wash.
- **Threads.** Under the well, 12px down, the notes as [review-notes](review-notes.md) threads in a bordered list headed by the count.

## The pane shows what changed without leaving the document

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur in the pane: an artifact with no text is drawn by its gate as a sentence in the same well. | |
| loading | Cannot occur as its own look: while the editor loads, the rendered reading stands in with the same text. | |
| reading | The artifact in its reading, with the switch. An editable artifact that is untouched looks the same, and a click places a caret in it. | [reading.html](../assets/artifact-pane/reading.html) |
| edited | Markdown that differs from what arrived: the editor stays, added text washed 16% `--ok`, removed text washed 16% `--bad` and struck through, and `Revert` in the header. | [edited.html](../assets/artifact-pane/edited.html) |
| edited data | Any other type that differs: the first keystroke replaces the editor with the change as a one-file list, `1 file` with green and red line counts over an `update` row that opens to the diff. `Revert` in the header is the way back to the editor. | [edited-data.html](../assets/artifact-pane/edited-data.html) |
| writing a note | Where notes are taken, releasing a drag selection over the artifact opens the note card at the selection with the focus in it, and the passage stays washed in `--accent`. | [writing-a-note.html](../assets/artifact-pane/writing-a-note.html) |
| notes | Each saved note washes its passage in `--warn`, and the threads list under the well. A note whose words are no longer in the text lists as `text changed` in `--warn`. Settled, the washes stay and the threads are not listed. | [notes.html](../assets/artifact-pane/notes.html) |

## Selecting writes a note, typing makes a change, and Revert takes the change back

| On | Does | Feedback |
| --- | --- | --- |
| Drag across text and release, where notes are taken | Opens the note card for that passage | Card at the selection, passage washed `--accent`, caret in the card |
| Right-click while the card is open | Opens the window's menu over the held passage | The passage stays held |
| Type in an editable artifact | Changes the artifact, unsaved until the gate is answered | Markdown: the change is drawn in place. Other types: the change list replaces the editor. `Revert` appears |
| `Revert` | Throws away what was typed | The original reading returns and `Revert` goes |
| Pointer over a marked passage | Lights its thread | The thread's row takes `--fill-ghost-hover` |
| Pointer over a thread | Lights its passage | The wash deepens to 55% with a solid underline |
| Click a thread's quote | Selects that passage again in the well | The passage is selected and scrolled into view |

## The pane's own copy is one button

| Where | String |
| --- | --- |
| Revert | `Revert` |
| Revert tooltip | `throw away what you typed` |
| Reading switch | As [value-view](value-view.md), such as `Rendered` · `Source` |
| Change list | `1 file` · `+{added}` · `−{removed}` · `update` · `{artifact}` |
| Note card and threads | As [review-notes](review-notes.md) |

## The well keeps the artifact inside a bounded, scrolling frame

- It spans its host, from the 360px context panel to a wide conversation column, and in the modal it widens with the modal to 1100px. Its height stops at 46% of the window and the artifact scrolls inside it.
- The note card opens below the selection, or above it when there is no room under it, and never past the window's right edge.
- Theme: the washes are mixed from `--warn`, `--accent`, `--ok` and `--bad` into transparent, so the text under them reads in both themes.
- Focus: Tab reaches `Revert`, the reading switch and `…`, then the artifact where it can be edited, then the threads. Writing a note needs a pointer. A marked passage cannot be clicked or focused and a screen reader does not announce it; the thread list is the way to a passage.
- Missing content: without notes no list is drawn. An artifact that is not text, such as a picture, shows its preview and takes no notes.
