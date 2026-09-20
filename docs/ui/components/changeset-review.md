---
id: ui/components/changeset-review
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/per-change-review, ux/patterns/park-and-ask, ux/patterns/comments-turn-a-verdict-into-send-back, ux/patterns/quote-anchored-note, ux/patterns/button-says-what-will-happen]
serves: [product/review-changes-before-they-land, product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you, product/keep-process-and-description-in-step, product/parallel-work-without-collisions]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface, ui/components/diff-editor, ui/components/image-diff, ui/components/review-notes]
implemented_by: [packages/app/src/renderer/changesetReview.tsx, packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/reviewChanges.test.ts, packages/app/test/reviewSync.test.ts, packages/app/test/componentGallery.test.ts]
mockups: [ui/assets/changeset-review/empty.html, ui/assets/changeset-review/error.html, ui/assets/changeset-review/deciding.html, ui/assets/changeset-review/sending-back.html, ui/assets/changeset-review/reverted.html, ui/assets/changeset-review/warned.html, ui/assets/changeset-review/cannot-show.html, ui/assets/changeset-review/settled.html]
siblings: [ui/components/review-artifact-gate, ui/components/file-changes-list, ui/components/gate-surface, ui/components/patch-view]
---

# Changeset review

A process's question about a set of file changes: a bordered list of changed files on the left with three-letter action tags, the chosen file's diff on the right with `Revert` above it and a comment box under it, and across the foot a whole-review comment, a tally such as `✓ 5 keeping · 4 you did not open`, an italic verdict line and one blue button that reads `Apply the review` or `Send back with comments`.

## A changeset review is for deciding, change by change, which files land

**Use when.** A state of a process stops for a person to decide a set of file changes: an agent's working copy before it merges, or the workflow files a sync proposed. The same component draws that question again, inert, when the answered state is read back in the conversation.

**Do not use when.** The changes are only shown, with nothing to decide: use [file-changes-list](file-changes-list.md). One document gets one verdict: use [review-artifact-gate](review-artifact-gate.md). A patch file is read on its own: use [patch-view](patch-view.md).

## The list of changes reads first, the chosen change second, and what the review will do last

- **Heading.** Drawn by [gate-surface](gate-surface.md) with the two-sheets glyph; `Review the proposed changes` when the state gives no prompt.
- **Source line.** `against` in `--dim` at 12/12.5, then the address the changes are measured from in mono.
- **List.** Up to 260px wide, at least 180px, 10px left of the detail; a 1px `--line` frame with 8px corners on `--bg`, rows split by hairlines. A row is one button, 6px by 8px inset: the action tag, then the path in the app face, cut at its start so the file name stays, then any of a `--warn` comment glyph with the note count, a `--warn` `⚠` for a file that moved, and an `--accent` `•` for a change not yet opened. The chosen row sits on `--fill-ghost-selected`; a pointer over a row gives `--fill-ghost-hover`.
- **Action tag.** A 1px `--line` box with 4px corners: a file glyph with a plus, a minus or two lines, and the action in the app face at 11/12.5, bold, uppercase, in `--dim`; `--ok` for a create and `--bad` for a delete. Three letters in the list, the whole word in the detail.
- **Detail.** A 1px `--line` frame with 8px corners on `--bg`, 10px inset, scrolling on its own. Its head: the full action tag, the path as an `--accent` mono link that opens the file in the Files view, or plain mono where the host cannot open files, then at the far end the `Inline | Side by side` toggle and `Revert` outlined in `--bad`. Under the head, in order: the change's reason in `--dim`; any warnings in `--warn`; the [diff-editor](diff-editor.md), the [image-diff](image-diff.md), or the reason the change cannot be shown; the [review-notes](review-notes.md) box and threads; `COMMENT ON THIS WHOLE FILE (OPTIONAL)` over a two-row mono box; and one `--dim` line at 11/12.5 saying what will happen to the file.
- **Foot.** A hairline, then `COMMENT ON THE WHOLE REVIEW (OPTIONAL)` over a two-row box, the tally in `--dim` with a glyph before each count, the verdict in italic on its own line, and 14px under it the button.

## The detail and the foot follow what the person did, never a menu of verdicts

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The set holds no changes: an empty list frame, `Pick a change on the left.` in the detail, `✓ 0 keeping`, `no comments — this round is applied` and `Apply the review`. | [empty.html](../assets/changeset-review/empty.html) |
| error | The state's input holds no set of changes: one line at 11/12.5 in `--bad`, `This state's changeset input is malformed: {reason}`, and nothing to decide. | [error.html](../assets/changeset-review/error.html) |
| loading | The chosen text change's diff before the editor has loaded: `loading the diff editor…` in `--dim` where the diff goes, while the list, `Revert` and the comment boxes already work. | [loading.html](../assets/diff-editor/loading.html) |
| partial | Drawn as deciding: changes not yet opened keep their dot, and the tally counts them in `--accent` at 600. An unopened change is kept if the set is applied. | |
| deciding | The first change is chosen and opened on arrival, and every other row carries the dot. Each untouched change counts as keeping, the verdict says the round is applied, and the file line says `will be written`. A selection touching changed lines turns `Revert` into `Revert these lines`; typing into the diff adds a ghost `Undo my edits`. Both are drawn under the main specimen. | [deciding.html](../assets/changeset-review/deciding.html) |
| sending back | Any file comment, note or whole-review comment: the tally adds `{n} commented` in `--warn`, the verdict reads `comments left — nothing is written, the set goes back`, and the button becomes `Send back with comments`. The commented file's line says `left alone; your comment goes back to the model`, and every other change's says `judged, files left alone`. | [sending-back.html](../assets/changeset-review/sending-back.html) |
| reverted | A refused change: its path struck through in `--dim` with `reverted` in `--bad` at the row's end, the diff showing the file as it was with no washes, a ghost `Put it back` in place of `Revert`, `{n} removed` in `--bad`, and `will not be written`. The row reads `reverted` on a round being sent back too, where nothing is written. | [reverted.html](../assets/changeset-review/reverted.html) |
| warned | A file that moved since the changes were made has `⚠` on its row and a `--warn` sentence over its diff; a file with unsaved edits in the editor gets a second `--warn` sentence. The mockup is at 420px, where the list sits above the detail. | [warned.html](../assets/changeset-review/warned.html) |
| cannot show | A change with no text to compare, such as a binary file: its reason in `--warn` where the diff goes, no layout toggle, and the comment box asks about the change as a whole. A picture whose bytes the change carries draws the image diff instead, also with no layout toggle. | [cannot-show.html](../assets/changeset-review/cannot-show.html) |
| settled | The answered question read back in the conversation: the same layout rebuilt from the recorded decisions, with refused rows struck, comments, notes and edits in place, no `Revert`, `Put it back` or `Undo my edits`, read-only boxes, and the button as it read when pressed, filled and inert. No move check runs. The unopened dots and count describe this reading, not the original review. | [settled.html](../assets/changeset-review/settled.html) |

The line under a detail depends on which tree the process applies to. On the base tree a kept change `will be written` and a refused one `will not be written`; on a proposal it `stays as proposed` or `will be rolled back to the base`.

An author can name the verdicts instead of the one button: each option is its own button, filled blue or outlined in `--bad` for a dangerous one. Settled, the chosen option keeps that look and the others go ghost.

## Gestures on a change decide it, and one button ends the review

| On | Does | Feedback |
| --- | --- | --- |
| Click a row | Chooses that change and counts it as opened | The row takes the chosen ground, its dot goes, the unopened count drops, and the detail swaps |
| Click the path in the detail head | Opens that file in the Files view | The window moves to Files |
| `Inline` or `Side by side` | Lays the diff out that way for every change until the review closes | The diff is rebuilt |
| `Revert` with no changed lines selected | Refuses the change and throws away its edits, file comment and notes without asking | Row struck with `reverted`; tally and file line change |
| `Revert these lines` | Puts the original back over the selected changed lines | Those washes go; `Undo my edits` appears |
| `Put it back` | Restores the change as it was proposed, without the earlier edits | The diff and `Revert` return |
| Type into the diff's after side | Keeps the reviewer's version of the file; typing it back to the proposal drops it | `Undo my edits` appears or goes |
| `Undo my edits` | Drops the reviewer's version | The proposal's diff returns |
| Select text in the diff and save a note | Anchors a note to the passage | The row's note count, the thread under the diff, and the send-back footer |
| Type in either comment box | Adds feedback; any text that is not blank sends the round back | Verdict and button text change as soon as it is typed |
| The button or an author's option | Sends every change's decision and the whole-review comment | The question settles in place |

Choosing a note's quote in its thread does not bring the passage back into view in the diff.

## The copy says what will happen to each file and to the set

| Where | String |
| --- | --- |
| Heading, no prompt given | `Review the proposed changes` |
| Source line | `against {address}` |
| List tag | `cre` · `upd` · `del` · `ren`, drawn uppercase |
| List path | `{path}` · `{old path} → {path}` for a rename; tooltip `{path}` |
| Note count | `{n}` · tooltip `1 note` · `{n} notes` |
| Moved mark | `⚠` · tooltip `this file moved since the review was produced` |
| Unopened mark | `•` · tooltip `you have not opened this one` |
| Refused row | `reverted` |
| Nothing chosen | `Pick a change on the left.` |
| Detail tag | `create` · `update` · `delete` · `rename`, drawn uppercase |
| Layout | `Inline` · `Side by side`, group label `How to lay the diff out` |
| Revert | `Revert` · tooltip `refuse this change — select lines first to revert only those` |
| Revert lines | `Revert these lines` · tooltip `put the original back over the selected lines` |
| Restore and undo | `Put it back` · `Undo my edits` |
| Moved notice | `⚠ this file moved since the review was produced — what you merge may not be what you read (§3.2); applying will re-check and refuse` |
| Unsaved notice | `✎ this file has unsaved edits in the editor — a merge writes past them` |
| Loading | `loading the diff editor…` |
| File comment | `Comment on this whole file (optional)` · placeholder `For anything that is not about one passage…` |
| File comment, cannot show | `Comment on this change (optional)` · placeholder `Nothing here to select, so say it about the change as a whole…` |
| File line | `will be written` · `stays as proposed` · `will not be written` · `will be rolled back to the base` · `judged, files left alone` · `left alone; your comment goes back to the model` |
| Review comment | `Comment on the whole review (optional)` · placeholder `Anything that is about the set rather than one file…`, empty once settled |
| Tally | `{n} keeping` · `{n} removed` · `{n} commented` · `{n} you did not open`, tooltip `derivation approves what you did not touch` |
| Verdict | `no comments — this round is applied` · `comments left — nothing is written, the set goes back` |
| Button | `Apply the review` · `Send back with comments` · `{option label}` |
| Malformed | `This state's changeset input is malformed: {reason}` · default reason `no input holds a changeset` |

## The review lays itself out by its own width and scrolls inside its host

- Two panes when the review itself is wider than 720px, one column below that, with the list above the detail and capped at 30% of the window's height. It asks its own width, so the same review is two panes in a wide conversation and one in the 360px context panel.
- In the modal it takes up to 1100px or 94% of the window's width and 90% of its height, and scrolls inside. In the section at the end of a task's conversation it stops at 60% of the window's height and scrolls.
- The list and the detail scroll independently; the foot stays under both.
- Theme: every colour outside the diff is a token; the diff is painted in its own palette.
- Focus: Tab moves through the list rows, the path link, the layout toggle, `Revert`, the diff, the note threads, the file comment, the review comment and the button. The moved and unopened marks exist only as tooltips, and the layout toggle does not announce which word is chosen.
- Leaving before answering discards every decision, edit, comment and note, and the question stays waiting.
- Missing content: without a reason the line under the head is absent; a change with no before or after compares against an empty side.

## The list and the head depart from the UI direction

- Paths in the list are set in the app face, where a path takes the data face.
- The moved-file notice cites a section number, `§3.2`, that means nothing to the person reading it.
