---
id: ui/components/agent-question
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask, ux/patterns/ask-one-or-several-questions, ux/patterns/own-answer-beside-offered-options]
serves: [product/agents-ask-instead-of-guessing, product/decide-with-the-context-in-front-of-you]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/components-view]
reuses: [ui/components/choice-list, ui/components/question-stepper, ui/components/icon]
implemented_by: [packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/choices.test.ts]
mockups: [ui/assets/agent-question/one-tap.html, ui/assets/agent-question/held-for-answer.html, ui/assets/agent-question/several.html]
siblings: [ui/components/gate-surface, ui/components/command-approval, ui/components/choose-option-gate]
---

# Agent question

A block under a running agent's words, below a blue rule: a speech-bubble glyph and `The agent has a question`, the question, the agent's options as cards or words with an `Other` card to type in, and a red-outlined `Let the agent decide`.

## An agent question is how a running agent asks the person something mid-turn

**Use when.** An agent working inside a step asks the person to choose, one question or a batch of up to four, and waits for the answer to come back into its work.

**Do not use when.** A process declares the decision: use [gate-surface](gate-surface.md) with [choose-option-gate](choose-option-gate.md), which draws the same options but settles in the record and cannot be dismissed. The agent waits on a command that policy held: use [command-approval](command-approval.md).

## The question reads first, the options second, and the way out last

- **Place.** Under the transcript of the step whose agent is running, in its session sheet: a 2px `--accent` rule 12px under the transcript, then 8px of space.
- **Heading.** A 16px speech-bubble glyph in `--dim`, then `The agent has a question` or `The agent has questions` in `--text` at 17/12.5 of the app size, sentence case, 8px above what follows.
- **Question.** For one question, its sentence in `--text`, then its header in a pill 14px lower when the agent gave one.
- **Options.** Drawn by [choice-list](choice-list.md): cards when any option explains itself, a row of words with the first filled blue when none does, a box at each option's right on a multi-select, and a full-width `Other` card last.
- **Buttons.** A row 14px under the options: a primary `Answer` when a click does not answer, then `Let the agent decide` outlined in `--bad`, though dismissing destroys nothing.
- **Several questions.** The [question-stepper](question-stepper.md) under the heading in place of the sentence and list. Each step shows its header pill and its options, and not the question's sentence; `Let the agent decide` joins the step buttons.

## The buttons change with whether a click can be the whole answer

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the block is drawn only while an agent waits on a question. | |
| loading | Cannot occur: the options arrive with the question, and nothing marks an answer on its way. | |
| one tap | One question, one pick, nothing typed in `Other`: the options and `Let the agent decide` alone. | [one-tap.html](../assets/agent-question/one-tap.html) |
| held for answer | A multi-select, or words typed in `Other`: `Answer` appears before the dismiss, disabled at half opacity until the question has a pick or words. | [held-for-answer.html](../assets/agent-question/held-for-answer.html) |
| several | A batch: `The agent has questions`, `Question {i} of {n}`, one step at a time, a ghost `Back` from the second step, a primary `Next` that is `Confirm` on the last and is disabled until the step has a pick or words, then `Let the agent decide`. | [several.html](../assets/agent-question/several.html) |
| settled | Cannot occur here: an answered or dismissed question leaves the block at once. The agent's tool row in the transcript then holds the question with the answer lit, as [choice-list](choice-list.md) and [question-stepper](question-stepper.md) draw a settled question, and a dismissed one with nothing lit. | |
| error | Cannot occur in the block: a refused answer is reported in the window's [error-notice](../surfaces/error-notice.md), and the block stays as it was. | |

## A pick answers, holds, or steps, and the dismiss always ends the wait

| On | Does | Feedback |
| --- | --- | --- |
| Click an option, one tap | Answers with that option | The block goes and the agent carries on |
| Click an option otherwise | Picks it, or toggles it on a multi-select | A ring or a filled box; `Answer` or the step button enables |
| Type in `Other` | Makes the words the answer and holds it | `Answer` appears |
| `Answer` or `Confirm` | Sends every answer in one go | The block goes and the agent carries on |
| `Next`, `Back` | Moves between the batch's questions | As [question-stepper](question-stepper.md) |
| `Let the agent decide` | Dismisses the question; the agent is told to use its own judgement | The block goes and the agent carries on |

## The copy is the agent's words, and the app's own are few

| Where | String |
| --- | --- |
| Heading | `The agent has a question` · `The agent has questions` |
| Question, one only | `{question}`, such as `Which cache interval should the probe use?` |
| Header pill | `{header}`, such as `Interval` |
| Options | `{label}` · `{description}` |
| Own answer | `Other` · `Type your own answer…` |
| Buttons | `Answer` · `Let the agent decide` |
| Steps | `Question {i} of {n}` · `Back` · `Next` · `Confirm` |

## The block narrows with its sheet and starts over each time it is drawn

- It spans the session sheet, from the 360px context panel to a wide conversation column; words wrap, cards stack, and the button row wraps.
- Every new question opens with nothing picked. Leaving the task and coming back also opens it with nothing picked and on its first step.
- Theme: every colour is a token; the rule stays `--accent` and the dismiss outline `--bad` in both themes.
- Focus: the block takes no focus when it arrives. Tab reaches the options, the `Other` box, `Back`, the step button or `Answer`, then `Let the agent decide`; a disabled button is skipped.
- Missing content: without a header there is no pill, and in a batch a step without one shows only its options. Without descriptions the options are a row of words with the first filled blue.
