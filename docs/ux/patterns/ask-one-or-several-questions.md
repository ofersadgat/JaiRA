---
id: ux/patterns/ask-one-or-several-questions
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/decide-with-the-context-in-front-of-you, product/agents-ask-instead-of-guessing, product/decisions-stay-yours]
siblings: [ux/patterns/own-answer-beside-offered-options, ux/patterns/park-and-ask, ux/patterns/schema-driven-form]
---

# Ask one or several questions

A lone question with a single choice is answered the moment the person picks. Anything more holds the answer until an explicit confirm: several picks allowed, a confirm the process asks for, or words written as an own answer as in [own-answer-beside-offered-options](own-answer-beside-offered-options.md). A comment the process invites is written before picking and goes with the pick. Several questions are asked one at a time with their position in the set. Each must be answered, or passed where it is optional, before moving on, earlier ones can be revisited, and the last confirm sends every answer together. An option the process names as the default starts already picked. Where the process asks for follow-ups, the answers can raise another round of questions, asked the same way, until nothing new is raised or five rounds in all have been asked.

## Use it when the answers are small picks that belong to one decision

**Use when.** A person settles a decision a process declares, or answers an agent, by choosing among a few offered options, possibly across several related questions.

**Do not use when.** The answer is typed values of declared kinds: use [schema-driven-form](schema-driven-form.md). The answer is a judgement on a document or on a set of changes: use [comments-turn-a-verdict-into-send-back](comments-turn-a-verdict-into-send-back.md) or [per-change-review](per-change-review.md).

## One pick sends a lone question, and a set is stepped through and sent together

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Reads the question, or the first of several | Shows the options with any default already picked, and for a set states the position and whether the question is optional | What is asked, how many questions there are, and which must be answered |
| 2 | Picks, on a lone single-choice question | Sends the pick at once | That the answer is given |
| 3 | Picks or writes on each question of a set, and moves forward or back | Holds every answer, and keeps a required question with no answer from being passed | Where they are in the set, and what they have answered |
| 4 | Confirms on the last question | Sends all answers together, and where the process asks for follow-ups, may ask a further round | That the answers are sent, or that new questions follow |

## Every state shows how far through the set the person is and what blocks sending

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: questions arrive only with the work that asks them | Answer |
| empty | A required question with no answer cannot be passed. An optional one offers to be passed, and on the last question passing also confirms | Answer, or pass an optional question |
| loading | While follow-up questions are worked out, the questions go away and nothing stands in their place | Wait for the next round or for the work to move |
| partial | Answers are held across the set until the last confirm. Each step shows its position, whether it is optional, and any short heading and explanation the question has, but not the question's own text | Go back, change an answer, or confirm |
| error | A question the process declares wrongly says so and cannot be answered. A refused answer leaves the questions open. If follow-up questions cannot be worked out, the answers already given stand | Fix the process, or answer again |
| denied | An agent's questions can be declined as a whole, which tells the agent to use its own judgement. A declared decision cannot be declined | Decline, or answer |
| success | The questions stay in the record with the answers picked, and a set still pages one question at a time | Read the record |

## Answers can change until the last confirm, and leaving first loses them

Before the last confirm, going back reaches any earlier question and its answer can be changed. A pick that answers a lone question at once cannot be taken back.

After sending, the way back is to [rewind](../../product/rewind-to-where-it-went-wrong.md) the work. A follow-up round is a new set of questions, so an earlier round cannot be revisited from it.

Leaving the questions before confirming discards the answers, and the questions stay waiting. If the app closes while a follow-up round is being worked out, that round's answers are not kept.

## Every option is a button reached by Tab, and single picks carry no chosen state for a screen reader

**Keyboard only.** Options, forward, back and confirm are standard buttons reached by Tab. Arrow keys do not move between options, Enter does not move forward, and Escape does nothing.

**Screen reader.** Options that allow several picks are announced as checkboxes with their state. Options that allow one pick are plain buttons with no grouping and no chosen state. Nothing is announced when the step changes or a follow-up round arrives.

**Small window.** The questions narrow with the conversation they are asked in.

**Slow machine.** Moving between questions waits on nothing. The only wait is for follow-up questions, and it shows only as the questions being gone.

## This departs from the UX principles in one place

While a follow-up round is worked out, nothing says so, so the wait reads as an absence.
