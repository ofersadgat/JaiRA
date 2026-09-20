---
id: ui/components/choose-option-gate
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask, ux/patterns/ask-one-or-several-questions, ux/patterns/own-answer-beside-offered-options]
serves: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/gate-surface, ui/components/choice-list, ui/components/question-stepper]
implemented_by: [packages/app/src/renderer/components.tsx, packages/app/src/renderer/choices.tsx]
verified_by: [packages/app/test/choices.test.ts, packages/app/test/followUp.test.ts]
mockups: [ui/assets/choose-option-gate/one-tap.html, ui/assets/choose-option-gate/held-for-confirm.html, ui/assets/choose-option-gate/steps.html, ui/assets/choose-option-gate/settled.html]
siblings: [ui/components/review-artifact-gate, ui/components/confirm-action-gate, ui/components/fill-form-gate, ui/components/agent-question]
---

# Choose option gate

A process's decision among named options: the prompt as the heading with a branching-arrow glyph, then option cards or a row of words that answer on the click, or that hold the pick for a blue `Confirm` under them, or a set of questions stepped through one at a time.

## A choose option gate is for a decision whose outcomes the process names

**Use when.** A state of a process stops for a person to pick among outcomes it declares, such as `approve`, `request_changes` or `block`, or to answer several small questions that settle one step, such as the product questions a spec cannot answer from the repository.

**Do not use when.** The decision is about an artifact the person must read first: use [review-artifact-gate](review-artifact-gate.md). The decision is one yes or no on an action: use [confirm-action-gate](confirm-action-gate.md). The answer is typed values: use [fill-form-gate](fill-form-gate.md). A running agent asks: use [agent-question](agent-question.md), which draws the same list.

## The prompt reads first, the options second, and the confirm last

- **Heading and notes.** Drawn by [gate-surface](gate-surface.md), with the branching-arrow glyph.
- **One decision.** The options through [choice-list](choice-list.md): words in a row when no option explains itself, cards otherwise. A comment box sits under them when the state asks for comments; a card for an own answer closes them when the state allows one.
- **Confirm.** A primary `Confirm` 14px under the options, drawn only while a click does not answer: the state asks for a confirm, allows several picks, or own words are typed.
- **Several questions.** The [question-stepper](question-stepper.md) under the heading in place of the list, each step with its header pill, its description, its options with any default already picked, and an own-answer card where allowed.

## One decision answers on the click unless something asks for a second look

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a state must name at least one option or one question, and a state that names none shows the invalid configuration line of [gate-surface](gate-surface.md). | |
| loading | Cannot occur for the gate itself. After `Confirm` on a state that asks follow-up questions, the gate goes away and nothing stands in its place until the next round arrives. | |
| one tap | A single-choice decision with no confirm asked for: options with no `Confirm`. A comment box under them does not change this, and neither does an empty own-answer card. | [one-tap.html](../assets/choose-option-gate/one-tap.html) |
| held for confirm | The state asks for a confirm, allows several picks, or own words are typed: a pick lights with a ring or a filled box, and `Confirm` appears under the list, disabled at half opacity until something is picked or written. | [held-for-confirm.html](../assets/choose-option-gate/held-for-confirm.html) |
| steps | Several questions: the stepper with `Question 1 of {n}`, defaults picked, and `Confirm` on the last step. A state that asks follow-up questions looks the same; after `Confirm` a new round of this gate may arrive with new questions. | [steps.html](../assets/choose-option-gate/steps.html) |
| settled | The same list or stepper, read-only: the decision lit, a comment as typed, own words in their card. | [settled.html](../assets/choose-option-gate/settled.html) |
| error | The configuration does not parse, or an answer is refused: drawn by [gate-surface](gate-surface.md) and the window's error notice. | |

## A pick either answers or holds, and Confirm sends what is held

| On | Does | Feedback |
| --- | --- | --- |
| Click an option, one tap | Sends that option, with any comment typed | The gate settles in place and the run moves on |
| Click an option, held | Picks it, or toggles it where several may be picked | Ring or filled box; `Confirm` enables |
| Type in the own-answer card | Makes the words the decision and holds it | `Confirm` appears |
| `Confirm` | Sends the pick, the picks, or the own words | The gate settles in place |
| `Next`, `Back`, `Skip` in steps | Moves between questions | As [question-stepper](question-stepper.md) |

## The copy is the author's, and the gate adds one verb

| Where | String |
| --- | --- |
| Heading | `{prompt}`, or `Choose an option` when the state gives none |
| Confirm | `Confirm` |
| Options, own answer, comment | As [choice-list](choice-list.md): `{label}` · `{description}` · `Your own answer` · `Type your own answer…` · `Comments (optional)` |
| Steps | As [question-stepper](question-stepper.md): `Question {i} of {n}` · ` · optional` · `Back` · `Next` · `Skip` · `Confirm` · `Skip and confirm` |

## The gate takes its host's width and loses half-made answers when left

- It spans the session sheet, from the 360px context panel to a wide conversation column; a row of words wraps and cards stack.
- Theme: every colour is a token.
- Focus: Tab moves from the options to the comment or own-answer box, then `Confirm`. Enter or Space on a focused option does what a click does.
- Leaving the task before answering loses picks and typed words; the gate opens again with only the defaults picked.
- Missing content: without descriptions the options draw as words, and without a prompt the heading is `Choose an option`.
