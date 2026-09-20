---
id: ux/patterns/park-and-ask
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you, product/agents-ask-instead-of-guessing, product/risky-actions-wait-for-approval, product/pick-up-where-it-left-off]
siblings: [ux/patterns/waiting-requests-gathered, ux/patterns/ask-one-or-several-questions, ux/patterns/consent-to-exactly-what-was-shown, ux/patterns/unattended-run-never-waits-silently, ux/patterns/schema-driven-form]
---

# Park and ask

When work reaches a point only a person may settle, it stops and waits for as long as it takes. There are three triggers: a decision the process declares, a question an agent asks, and a command held for approval. The question is asked inside the work that is asking, beside what it is about, and is reachable from anywhere through [waiting-requests-gathered](waiting-requests-gathered.md). The person answers, a declared decision's answer is checked against what the decision allows, and a refused answer changes nothing. Once settled, the question stays in the work's record as the answer that was given.

## Use it when the work must not go on by its own judgement and the answer can wait

**Use when.** The call belongs to a person and must be attributable to one, and waiting hours for the answer does no harm. This covers a decision the process declares, an agent that is unsure, and a risky command.

**Do not use when.** The input is needed before any work starts: collect it with [schema-driven-form](schema-driven-form.md) alone. Nobody can be present, as in a terminal run with no one at it: use [unattended-run-never-waits-silently](unattended-run-never-waits-silently.md). The person only needs to know that something happened: use [live-facts-and-unseen-counts](live-facts-and-unseen-counts.md). Approving a command or code also needs [consent-to-exactly-what-was-shown](consent-to-exactly-what-was-shown.md) on top of this shape.

## The work stops, the person answers in place, and the work carries on with the answer

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Nothing, or works elsewhere | Stops the work at the point, keeps a declared decision so it outlasts the app closing, and adds the request to those waiting on the person | Work is waiting on them, and in which project |
| 2 | Goes to the request | Opens the asking work at the step that asks, with the question beside what it is about | What is asked, about what, and whether answering will carry on work that is no longer running |
| 3 | Answers: picks, writes an own answer, edits, approves or denies, or tells an agent to use its own judgement | Checks a declared decision's answer against what the decision allows, then refuses it or accepts it | Whether the answer was accepted |
| 4 | Nothing | Carries the work on with the answer, removes the request from those waiting, and keeps the question in the record as answered | The work is moving again, and what they answered |

## Every state leaves the person a way to answer, read the record, or move the work

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a question exists only once work has reached it, so a first question behaves like any other | Answer it |
| empty | No question waiting on the work. A settled question reads as the answer given, and one the work moved past unanswered says it was never answered | Read the record, or rewind to before the question to be asked again |
| loading | Nothing marks an answer on its way: the question stays answerable until the system reports it settled, and a second answer sent meanwhile is refused. When answers open follow-up questions, the question goes away and nothing stands in its place until the next questions arrive or the work moves on | Wait for the work to move or for the next questions |
| partial | A question in several parts keeps the parts answered so far until the last is sent, as in [ask-one-or-several-questions](ask-one-or-several-questions.md). A declared decision whose work is no longer running says that answering carries the work on | Finish answering |
| error | A question the process declares wrongly says its configuration is invalid and why, and offers no way to answer. A refused answer leaves the question open, and the reason is reported apart from the question and does not stay. If work cannot be carried on after answering a decision that outlasted a restart, the question is already gone, the answer is not kept, and the failure is written only to the app's log | Fix the process and stop or rewind the work, or answer a refused question again |
| denied | The person denied an approval or told an agent to use its own judgement: the agent is told and carries on without it. Stopping the work withdraws its waiting decision and question and refuses its waiting approvals | Resume or rewind the work |
| success | The question stays where it was asked, unchangeable, showing the answer given, and the work continues | Read the record, or follow the work |

## An accepted answer is final, and a half-made answer is lost when the person leaves it

An accepted answer cannot be changed. The way back is to [rewind](../../product/rewind-to-where-it-went-wrong.md) the work to before the question, which asks it again.

Picks, notes and form values made toward an answer last only while the question stays in view. Going to other work or restarting the app discards them, and the question stays waiting.

A declared decision outlasts the app closing and is still waiting, in the same place, when the project opens again. An agent's question and an approval do not: closing the project dismisses the question and denies the approval.

## Answering works by keyboard alone, and nothing is announced when a question arrives

**Keyboard only.** Every answer is given with standard buttons and fields reached by Tab. A list of choices does not move with arrow keys and does not send on Enter.

**Screen reader.** Nothing is announced when a question arrives or when an answer is refused.

**Small window.** The question sits in the work's conversation and narrows with it. An approval that belongs to no piece of work is asked on its own, over whatever the person is doing, and fits inside the window.

**Slow machine.** The only sign an answer was received is the question settling when the system reports it, however long that takes.

## This departs from the UX principles in one place

An answer to an agent's question goes back to the agent as given, without the check a declared decision's answer gets.
