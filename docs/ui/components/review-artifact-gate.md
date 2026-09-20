---
id: ui/components/review-artifact-gate
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask, ux/patterns/comments-turn-a-verdict-into-send-back, ux/patterns/quote-anchored-note]
serves: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you, product/read-what-work-produced]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface, ui/components/artifact-pane, ui/components/choice-list, ui/components/review-notes]
implemented_by: [packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/artifactGateReload.test.ts]
mockups: [ui/assets/review-artifact-gate/empty.html, ui/assets/review-artifact-gate/deciding.html, ui/assets/review-artifact-gate/sending-back.html, ui/assets/review-artifact-gate/feedback-alongside.html, ui/assets/review-artifact-gate/settled.html]
siblings: [ui/components/edit-artifact-gate, ui/components/changeset-review, ui/components/choose-option-gate]
---

# Review artifact gate

A process's decision about one artifact: the prompt with an eye glyph, the artifact in a framed scrolling well, a grey italic line saying what the decision will mean, and the author's verdicts as a row of buttons, which becomes a single blue `Send back with comments` once a comment or a note is written.

## A review artifact gate is for a verdict on one thing the person must read

**Use when.** A state of a process stops for a person to read one artifact the run produced, such as a plan or a spec, and give the verdict it names, optionally with a comment, notes on passages, or a small fix typed into the artifact itself.

**Do not use when.** The subject is a set of file changes decided change by change: use [changeset-review](changeset-review.md). The person writes or rewrites the artifact and gives no verdict: use [edit-artifact-gate](edit-artifact-gate.md). The decision needs nothing read first: use [choose-option-gate](choose-option-gate.md).

## The artifact reads first, what the decision means second, and the verdicts last

- **Heading.** Drawn by [gate-surface](gate-surface.md) with the eye glyph; `Review` when the state gives no prompt.
- **Artifact.** The [artifact-pane](artifact-pane.md) well, editable when the state allows it, taking notes on passages, with the note threads under it.
- **Summary.** A wrapping line 8px under the pane in `--dim`: `edited` and a comment glyph with the note count, both in `--warn`, then the verdict sentence in italic on a line of its own.
- **Comment box.** When the state asks for comments, `Comments (optional)` over a three-row box, above the verdicts so it is written before a verdict is clicked.
- **Verdicts.** The author's options through [choice-list](choice-list.md): words in a row, the first that is not dangerous filled blue, a dangerous one outlined in `--bad`.
- **Send back.** In place of the verdicts once feedback exists and the author named a second verdict that is not dangerous: a primary `Send back with comments` 14px under the comment box.

## Writing feedback changes the footer's shape, not only its words

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The artifact has no text: the well holds `({artifact} is empty)` in `--dim`, and the summary and verdicts draw as usual. | [empty.html](../assets/review-artifact-gate/empty.html) |
| loading | Cannot occur: the artifact arrives with the question. | |
| deciding | Nothing written: `no comments — your decision stands on its own`, then the comment box when asked for, then the verdict row. A click answers. | [deciding.html](../assets/review-artifact-gate/deciding.html) |
| sending back | A comment typed or a note saved, and the author named a send-back verdict: the verdict line reads `comments left — this goes back as "{verdict}"`, the row is gone, and the comment box stands over `Send back with comments`. Removing every note and clearing the comment brings the row back. | [sending-back.html](../assets/review-artifact-gate/sending-back.html) |
| feedback alongside | Feedback written where the author named no second verdict that is not dangerous, such as `approve` beside a dangerous `reject`: `comments left — your decision goes back with them`, and the row stays. Typing into an editable artifact adds `edited` to the summary in every state. | [feedback-alongside.html](../assets/review-artifact-gate/feedback-alongside.html) |
| settled | The pane read-only with its washes and no thread list, the summary as it was, and the footer in the shape it was answered in: the verdict row with the choice lit, or the comment over a filled, inert `Send back with comments`. | [settled.html](../assets/review-artifact-gate/settled.html) |
| error | The configuration does not parse, or an answer is refused: drawn by [gate-surface](gate-surface.md) and the window's error notice. | |

## Every gesture on the artifact counts toward sending it back

| On | Does | Feedback |
| --- | --- | --- |
| Select a passage and release | Opens the note card at the selection | As [artifact-pane](artifact-pane.md) |
| Save a note | Adds it to the review | Its passage is washed, the thread lists, the count shows, and the footer turns to send back when a send-back verdict exists |
| Type a comment | Adds it to the review | The same change of footer and verdict line |
| Type into an editable artifact | Changes the artifact that will go back with the verdict | The change is drawn in the pane and `edited` shows |
| Click a verdict | Sends it with any comment, notes and edit; an artifact left as it arrived is not sent back as an edit | The gate settles in place |
| `Send back with comments` | Sends the author's send-back verdict with the comment, notes and edit | The gate settles in place |

## The copy says what pressing will mean before it is pressed

| Where | String |
| --- | --- |
| Heading | `{prompt}`, or `Review` |
| Empty artifact | `({artifact} is empty)` |
| Counts | `edited` · `1 note` · `{n} notes` |
| Verdict line | `no comments — your decision stands on its own` · `comments left — this goes back as "{label}"` · `comments left — your decision goes back with them` |
| Collapsed button | `Send back with comments` |
| Comment label | `Comments (optional)` |
| Verdicts | `{label}` or `{value}`, such as `approve` · `reject` |

## The gate fits its host and keeps the verdicts under a bounded well

- It spans the session sheet, from the 360px context panel to a wide conversation column; in the modal it takes the wide 1100px frame. The well stops at 46% of the window's height, so the verdicts stay close under a long artifact.
- The summary wraps: the counts share a line, and the verdict sentence always takes its own.
- Theme: every colour is a token; the counts stay `--warn` in both themes.
- Focus: Tab reaches the pane's header, the artifact where editable, the note threads, the comment box, then the verdicts or `Send back with comments`. Notes need a pointer.
- Leaving before answering loses the notes and the comment; a typed edit is kept and is there on return.
- Missing content: without a prompt the heading is `Review`; without comments asked for, the comment box is absent and only notes can turn the footer.
