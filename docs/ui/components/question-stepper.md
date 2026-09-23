---
id: ui/components/question-stepper
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/ask-one-or-several-questions]
serves: [product/decide-with-the-context-in-front-of-you, product/agents-ask-instead-of-guessing]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: [ui/components/choice-list]
implemented_by: [packages/app/src/renderer/choices.tsx]
verified_by: [packages/app/test/choices.test.ts]
mockups: [ui/assets/question-stepper/answered.html, ui/assets/question-stepper/unanswered.html, ui/assets/question-stepper/read-only.html]
siblings: [ui/components/choice-list, ui/components/choose-option-gate, ui/components/agent-question, ui/components/fill-form-gate]
---

# Question stepper

Several questions shown one at a time: a grey `Question 2 of 3 · optional` line, one question's header pill, description and options, and a row of `Back` and `Next` buttons that becomes `Confirm` on the last question.

## A question stepper asks a set of questions in order and sends them together

**Use when.** Two or more questions belong to one answer: a process's decision in several parts, or a running agent's batch of questions. The set is also paged this way once settled.

**Do not use when.** One question is asked: use [choice-list](choice-list.md) directly. The answers are typed values that can be seen all at once: use [fill-form-gate](fill-form-gate.md).

## The position reads first, the step's options second, and the buttons last

- **Step line.** `Question {i} of {n}` in `--dim`, 6px above the question, followed by ` · optional` at 11/12.5 of the app size when the question may be passed.
- **Question.** The step's header in a pill followed by the question's own sentence, then its description in `--dim`, then its options, drawn by [choice-list](choice-list.md). The heading above is the set's, so each step prints its own question (until 2026-09-22 it did not, and a step showed only its pill and options).
- **A typed step.** A question with a `schema` answers a value of it. While the pick or the own answer cannot be read as one, or the schema refuses it, the reason stands under the options in `--bad` (`expects a number`, `must be ≥ 1`) and the step button is disabled; the own-answer box says what to type (`Type a number…`).
- **Buttons.** A row 14px under the options, 8px apart: a ghost `Back` from the second question on, then the step button. The host may add its own button after them, such as an agent question's `Let the agent decide`.

## The step button says whether this step answers, passes or sends

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a stepper is drawn only for two or more questions. | |
| loading | Cannot occur: every question arrives with the set. While a process works out follow-up questions after `Confirm`, the host draws nothing in the stepper's place. | |
| answered | The step has a pick or own words: the step button is primary, `Next`, or `Confirm` on the last question. A question with a default opens answered. | [answered.html](../assets/question-stepper/answered.html) |
| unanswered | A required step with nothing picked: the step button is primary and disabled at half opacity. An optional step: a ghost `Skip`, or `Skip and confirm` on the last question. | [unanswered.html](../assets/question-stepper/unanswered.html) |
| read-only | A settled set: the picks lit and inert, ghost `Back` and `Next` to page through it, no `Confirm` on the last page and no host button. A passed question shows nothing lit. | [read-only.html](../assets/question-stepper/read-only.html) |

## Stepping keeps every answer until the set is sent

| On | Does | Feedback |
| --- | --- | --- |
| `Next` or `Skip` | Shows the next question | The step line counts up; `Back` appears |
| `Back` | Shows the previous question with its answer kept | The step line counts down |
| `Confirm` or `Skip and confirm` | Sends every answer at once; a passed question is left out | The host settles |
| Picking or typing in the step | Answers this question | The step button turns from disabled or `Skip` to primary |

## The copy is the position and five verbs

| Where | String |
| --- | --- |
| Step line | `Question {i} of {n}` |
| Optional marker | ` · optional` |
| Buttons | `Back` · `Next` · `Skip` · `Confirm` · `Skip and confirm` |
| Header pill | `{header}`, such as `Sort`, `Boundary` or `Rows` |

## The stepper keeps one height per question and forgets its place when redrawn

- It has no width of its own; the options wrap and stack as [choice-list](choice-list.md) does, and the button row wraps at the 360px context panel.
- The block's height follows the question on screen, so the buttons move as the steps change length.
- Nothing half-made is kept: going to another task and back opens the set on its first question again, with only the defaults picked.
- Theme: all tokens, as the list.
- Focus: Tab moves through the step's options and boxes, then `Back`, then the step button. A disabled step button is skipped.
- Missing content: without a description the pill sits directly over the options; without a header the description leads.
