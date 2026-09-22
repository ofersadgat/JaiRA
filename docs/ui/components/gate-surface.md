---
id: ui/components/gate-surface
type: ui-component
status: shipped
updated: 2026-09-22
realizes: [ux/patterns/park-and-ask, ux/patterns/absence-is-stated, ux/patterns/fold-to-a-summary-expand-in-place]
serves: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you, product/complete-record-of-every-run, product/pick-up-where-it-left-off]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/choose-option-gate, ui/components/review-artifact-gate, ui/components/edit-artifact-gate, ui/components/fill-form-gate, ui/components/confirm-action-gate, ui/components/changeset-review, ui/components/computed-state-body, ui/components/icon]
implemented_by: [packages/app/src/renderer/components.tsx, packages/app/src/renderer/runViews.tsx]
verified_by: [packages/app/test/gateDurability.test.ts, packages/app/test/fastForward.test.ts]
mockups: [ui/assets/gate-surface/asking.html, ui/assets/gate-surface/outside-a-sheet.html, ui/assets/gate-surface/error.html, ui/assets/gate-surface/success.html, ui/assets/gate-surface/never-answered.html, ui/assets/gate-surface/unknown-function.html, ui/assets/gate-surface/answered-for-you.html]
siblings: [ui/components/agent-question, ui/components/command-approval, ui/components/waiting-on-sheet, ui/components/letterhead]
---

# Gate surface

A process's question to a person: the author's prompt as a heading with a small line glyph for the kind of answer, an optional quiet sentence under it, then the control that answers it, the same control again once answered with nothing pressable and a quiet `Show the record` under it.

## A gate surface holds every decision a process declares, live or settled

**Use when.** A state of a process stops for a person through one of the built-in answers: pick an option, review one artifact, edit one, fill a form, confirm an action, or review a set of changes. It also holds a state calling a function the app draws no control for. The same surface draws the question while it waits and after it has settled, in the place it was asked.

**Do not use when.** A running agent asks something of its own accord: use [agent-question](agent-question.md). A command waits on policy: use [command-approval](command-approval.md). A task waits to be moved to a column by hand: use [waiting-on-sheet](waiting-on-sheet.md). The line naming the state above the question belongs to [letterhead](letterhead.md).

## The prompt reads first, the control second, and the record last

- **Heading.** The glyph, then the author's prompt. The glyph names the kind: a branching arrow for an option, an eye for a review, two sheets for a set of changes, a pencil for an edit, a ruled sheet for a form, a tick for a confirm. A function with no component has no glyph, and its name is the heading.
- **Heading in a session sheet.** The sheet's section-label look: small, uppercase with wide tracking, in `--dim`, the glyph at the left edge and the prompt pushed to the right edge.
- **Heading elsewhere.** In the fallback section at the end of a task's conversation and in the modal: the prompt in `--text` at 17/12.5 of the app size, line height 1.35, sentence case, with a 16px glyph in `--dim` 4px before it. The fallback section has a 2px `--accent` rule above it.
- **Note under the heading.** `Answering this continues the task.` at 11/12.5 in `--dim` on a live question that outlasted the app closing. `Never answered.` in italic `--dim` on a settled question nobody answered.
- **Control.** Drawn by the component for the kind: [choose-option-gate](choose-option-gate.md), [review-artifact-gate](review-artifact-gate.md), [edit-artifact-gate](edit-artifact-gate.md), [fill-form-gate](fill-form-gate.md), [confirm-action-gate](confirm-action-gate.md) or [changeset-review](changeset-review.md).
- **Answered for you.** Settled in a session sheet, when a fast-forward's controlling conversation gave the answer ([decision 0005](../../engineering/decisions/0005-connect.md) §4) — the same box an agent's answered `AskUserQuestion` draws under its block in a [work-row](work-row.md): the settled-by box under the control, 8px above it, in the accent rather than in `ok` — 8% `--accent` over `--panel`, a 1px edge at 32% — with a two-star glyph in `--accent`, `Answered for you by the conversation`, the confidence in the data face after a `·`, and a quiet `Answer it yourself` at the far right.
- **Record.** Settled in a session sheet only: a quiet `Show the record` button 12px under the control, opening the call as [computed-state-body](computed-state-body.md) draws it.

## A settled question is the same control, lit and inert

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a gate surface is drawn only for a question that was asked. | |
| loading | Cannot occur: the surface draws whole from the question. An answer on its way changes nothing, and the question stays answerable until the run reports it settled. | |
| asking | The heading and the live control. A question that outlasted the app closing, so that no run is going behind it, adds `Answering this continues the task.` under the heading; nothing else differs. | [asking.html](../assets/gate-surface/asking.html) |
| outside a sheet | In the modal, and in the section at the end of a task's conversation that holds a question whose sheet is not drawn, such as while the run's record loads: the large sentence-case heading. The section adds a 2px `--accent` rule above it. | [outside-a-sheet.html](../assets/gate-surface/outside-a-sheet.html) |
| error | The state's configuration does not parse: the heading is the component's own name, and a red line at 11/12.5 reads the reason in place of any control. | [error.html](../assets/gate-surface/error.html) |
| refused | A submitted answer the run refuses leaves the control as it was, and the reason shows in the window's [error-notice](../surfaces/error-notice.md), not under the question. | |
| success | The control as answered: the pick lit with its ring or fill, the words as typed, the artifact as edited. Buttons keep full colour with no pointer and no hover; an affirmative option that was not chosen loses its fill. `Show the record` opens the call's name, its arguments and what it returned; the button then reads `Hide the record`. | [success.html](../assets/gate-surface/success.html) |
| answered for you | The success form, then the settled-by box saying the conversation answered and how sure it was, with `Answer it yourself`. Only on a question a fast-forward answered; a question the person answered has no box, and an approval never has one because the conversation is never offered it. | [answered-for-you.html](../assets/gate-surface/answered-for-you.html) |
| never answered | The run was stopped on the question, the call failed, or its record holds no result: `Never answered.` over the empty control, with the record toggle under it. | [never-answered.html](../assets/gate-surface/never-answered.html) |
| unknown function | The heading is the function's name with no glyph. Live, an uppercase `Response (JSON)` label over a six-row mono box and a plain `Submit`. Settled, the answer as indented JSON in a bordered `--bg` block up to 220px tall. | [unknown-function.html](../assets/gate-surface/unknown-function.html) |

## Answering belongs to the control, and the surface adds only the record toggle

| On | Does | Feedback |
| --- | --- | --- |
| Answering in the control | Sends the answer to the run | The run moves on and the same place redraws as the settled question |
| `Show the record` | Opens the call under the control | The call block appears; the label becomes `Hide the record` |
| `Answer it yourself` | Stops the fast-forward if it is still going, and rewinds the task to where this state was entered: the answer and everything after it are deleted, and the state asks again — now of the person | The question returns live in the same place; the strip leaves the fast-forward form |
| `Hide the record` | Closes it | The label returns to `Show the record` |
| `Submit`, unknown function | Sends the box's text as JSON, or as plain text when it does not parse | As any answer |

## The copy is the author's prompt, and the surface's own words are few

| Where | String |
| --- | --- |
| Heading | `{prompt}` · `{function name}` when no component draws it |
| Heading, no prompt given | `Choose an option` · `Review` · `Edit` · `Fill in the form` · `Confirm this action` · `Review the proposed changes` |
| Recovered question | `Answering this continues the task.` |
| Settled, unanswered | `Never answered.` |
| Invalid configuration | `This state's {component} config is invalid: {reason}`, the component name in mono |
| Answered for you | `Answered for you by the conversation` · `· confidence {0.00}` · `Answer it yourself` · its tooltip: `Rewind to this question, so it is asked again and answered by you` |
| Record toggle | `Show the record` · `Hide the record` |
| Unknown function | `Response (JSON)` · `Submit` |

## The surface takes its host's width and never truncates the prompt

- It has no width of its own. In a session sheet it spans the sheet, from the 360px context panel to a wide conversation column. The modal is 380 to 720px, and 1100px for an artifact review, an edit or a set of changes.
- A long prompt wraps. In a session sheet it wraps in the space right of the glyph.
- Theme: every colour is a token, and the settled look keeps a chosen fill in both themes.
- Focus: the heading is not focusable. Tab moves through the control's own fields and buttons, then `Show the record`. A settled control's fields and options are skipped by Tab.
- Missing content: without a prompt the heading is the kind's default sentence.

## The heading departs from the type registers in a session sheet

- In a session sheet the author's prompt takes the uppercase app-label look and is split from its glyph across the line, where a prompt is a sentence in `--text` everywhere else.
