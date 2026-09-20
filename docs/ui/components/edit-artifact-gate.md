---
id: ui/components/edit-artifact-gate
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask]
serves: [product/decisions-stay-yours, product/read-what-work-produced]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface, ui/components/artifact-pane, ui/components/editor-chrome, ui/components/value-view]
implemented_by: [packages/app/src/renderer/components.tsx, packages/app/src/renderer/editorChrome.tsx]
verified_by: [packages/app/test/components.e2e.test.ts]
mockups: [ui/assets/edit-artifact-gate/editing.html, ui/assets/edit-artifact-gate/dirty.html, ui/assets/edit-artifact-gate/empty.html, ui/assets/edit-artifact-gate/nothing-to-type-into.html, ui/assets/edit-artifact-gate/settled.html]
siblings: [ui/components/review-artifact-gate, ui/components/fill-form-gate, ui/components/artifact-pane]
---

# Edit artifact gate

A process's request to write or rewrite one artifact: the prompt with a pencil glyph, the artifact open in its editor inside a framed well, and under the well a hairline bar with a blue `Save` that gains a grey `unsaved changes` once anything is typed.

## An edit artifact gate hands the person the text and takes back whatever they save

**Use when.** A state of a process stops for a person to change one artifact the run produced, such as tidying a plan, or to write one from nothing, such as a release note, and the text they hand back is the whole answer.

**Do not use when.** The person judges the artifact and gives a verdict, perhaps with a small fix: use [review-artifact-gate](review-artifact-gate.md). The answer is a few typed values: use [fill-form-gate](fill-form-gate.md). A set of file changes is decided change by change: use [changeset-review](changeset-review.md).

## The text reads first, and the one action sits under it

- **Heading.** Drawn by [gate-surface](gate-surface.md) with the pencil glyph; `Edit` when the state gives no prompt.
- **Well.** The [artifact-pane](artifact-pane.md), always writable and taking no notes: markdown in its live-preview editor under a `Rendered | Source` switch, other text in its own editor, and the change drawn in place once typed.
- **Bar.** Directly under the well, a 1px `--line` hairline on `--panel` with 8px above its contents: a primary `Save`, then `unsaved changes` in `--dim` at 11/12.5 of the app size while the text differs from what arrived. The bar sticks to the bottom of the scrolling conversation while the gate is in view.
- **Nothing to type into.** For a picture, a sound or a video: the item in its [value-view](value-view.md) reading inside the same well, a `--warn` sentence 10px under it at 12/12.5 of the app size, and a primary `Done` 14px under that. No bar.

## Every state keeps Save pressable, because handing the text back unchanged is an answer

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The state names no source: the well reads `undefined` under a `JSON \| Source` switch, nothing in it can be typed into, and `Save` hands back empty text. | [empty.html](../assets/edit-artifact-gate/empty.html) |
| loading | Cannot occur as its own look: while the editor loads, the rendered reading stands in with the same text, as [artifact-pane](artifact-pane.md) draws it. | |
| editing | The text in its editor, untouched, with `Save` alone in the bar. | [editing.html](../assets/edit-artifact-gate/editing.html) |
| dirty | The text differs from what arrived: added words washed `--ok`, removed words washed `--bad` and struck through, `Revert` in the well's header, and `unsaved changes` beside `Save`. Text that is not markdown shows the change as a one-file list in the well instead. Typing the text back to what arrived clears all three. | [dirty.html](../assets/edit-artifact-gate/dirty.html) |
| nothing to type into | `This is {type}, so there is nothing here to type into. Submitting hands it back unchanged.` under the item, and `Done`. | [nothing-to-type-into.html](../assets/edit-artifact-gate/nothing-to-type-into.html) |
| settled | The well read-only with no bar: the edit drawn over the text where the answer differed, the plain reading where it did not. A changed edit keeps `Revert` in the well's header, and pressing it changes nothing. A picture, sound or video keeps its sentence and loses `Done`. | [settled.html](../assets/edit-artifact-gate/settled.html) |
| error | The configuration does not parse, or an answer is refused: drawn by [gate-surface](gate-surface.md) and the window's error notice. | |

## Typing changes the draft, and Save or Done sends it

| On | Does | Feedback |
| --- | --- | --- |
| Type in the well | Changes the text that `Save` will send | The change is drawn, `Revert` appears in the header and `unsaved changes` beside `Save` |
| `Revert` | Throws away what was typed | The text returns as it arrived; `Revert` and `unsaved changes` go |
| `Save` | Sends the text as it stands, typed or untouched | The gate settles in place |
| `Done` | Sends the item back unchanged | The gate settles in place |
| The reading switch | Shows the text another way | As [value-view](value-view.md) |

## The copy is the prompt and three verbs

| Where | String |
| --- | --- |
| Heading | `{prompt}`, or `Edit` |
| Bar | `Save` · `unsaved changes` |
| Revert and its tooltip | `Revert` · `throw away what you typed` |
| Nothing to type into | `This is {type}, so there is nothing here to type into. Submitting hands it back unchanged.`, with `not text` in place of the type when the item names none |
| Done | `Done` |

## The gate fits its host, and its draft outlives leaving the task

- It spans the session sheet, from the 360px context panel to a wide conversation column; in the modal it takes the wide 1100px frame. The well stops at 46% of the window's height and scrolls inside itself.
- Leaving the task keeps what was typed for this question, and it is there on return while the app stays open.
- Theme: every colour is a token; the washes read in both themes.
- Focus: Tab reaches `Revert`, the reading switch and `…`, then the editor, then `Save`. For a picture, sound or video Tab reaches the reading's controls, then `Done`.
- Missing content: without a prompt the heading is `Edit`; without a source the well is the empty state above.

## The sentence for an item that cannot be typed into departs from the colour roles

- It says what is so, not what is wrong, and is still drawn in `--warn`.
