---
id: ux/patterns/refuse-with-the-reason-and-the-fix
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/hand-work-to-agents, product/try-one-step-on-its-own, product/large-work-splits-into-independent-pieces, product/pick-up-where-it-left-off, product/all-projects-in-one-place, product/bring-your-own-models-and-agents, product/failures-explain-themselves]
siblings: [ux/patterns/absence-is-stated, ux/patterns/button-says-what-will-happen, ux/patterns/checked-status-with-the-fix, ux/patterns/unattended-run-never-waits-silently]
---

# Refuse with the reason and the fix

When an action cannot be taken, the person is told why, and where possible what would make it possible. A refusal known in advance makes the action unavailable and puts the reason beside it. When several things block an action, the reason given is the first one the person can act on: no project to run in, then an unsaved file, then a file that does not parse, then problems in the process, then the values in the form. A warning never blocks. A refusal only the system can decide comes back as a report naming the cause, such as the other work a piece of work is waiting on. Where one step removes the obstacle, the refusal offers that step: a folder that is not a project is offered set-up, and an agent that is not signed in names the command that signs it in.

## Use it when an action can fail for a reason the person can understand or remove

**Use when.** Starting, resuming or running work, running one step, opening a folder, or using a model or agent can be impossible for a reason the person can act on.

**Do not use when.** The condition should not stop the person, as with a warning: show it and leave the action available. There is nothing to act on: say which kind of absence it is with [absence-is-stated](absence-is-stated.md). No person is at a terminal to read the refusal: use [unattended-run-never-waits-silently](unattended-run-never-waits-silently.md). The subject is whether a connection works: use [checked-status-with-the-fix](checked-status-with-the-fix.md).

## The person learns why before trying where possible, and what to do after trying otherwise

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Comes to an action | If the action is known to be impossible, makes it unavailable and states the first reason beside it | Why it cannot be taken, before trying |
| 2 | Takes an action | Refuses with the cause, or offers the step that removes the obstacle | Why it did not happen, and what to do |
| 3 | Takes the offered step, or fixes the cause | Performs the step, then lets the action through | The action is possible now |

## Every state names the obstacle and a way past it

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A folder that is not a project is offered set-up, saying what setting up creates and that nothing else in the folder is touched. With nothing configured that can answer a prompt, the settings for models and agents say so and name what is missing | Set up the project, or add a model provider or agent |
| empty | Cannot occur: a refusal always has a reason | Act on the reason |
| loading | Until a form's first check answers, its action is unavailable and the reason says the values are being checked | Keep filling values |
| partial | Work that cannot resume but can start again offers starting again and says why resuming is unavailable | Start again, or fix what blocks resuming |
| error | A refusal the system decides is reported apart from the action, such as work waiting on other work, or a request that must name one of several open projects. The report goes when the next action is taken or the view changes | Act on the cause, then take the action again |
| denied | A run blocked by errors in its process says how many errors beside the action. Starting work that waits on other work is refused naming what it waits on, and the start stays offered. An agent that cannot ask for approval is refused where the project's policy may require approval, naming the setting behind it | Fix the cause and take the action again |
| success | The action goes ahead | Follow the work |

## A refusal changes nothing, so there is nothing to undo

A refused action leaves everything as it was. A reason given in advance stays beside the action for as long as the obstacle does. A reported refusal lasts until the next action or a change of view, and is kept nowhere. Declining an offered step, such as set-up, leaves the folder exactly as it was.

Code that has not been approved is the one refusal that changes something: it becomes a request for approval of that code, as in [consent-to-exactly-what-was-shown](consent-to-exactly-what-was-shown.md).

## Unavailable actions are skipped by keyboard, and no reason reaches a screen reader

**Keyboard only.** An unavailable action cannot take focus. A reported refusal is dismissed by pointer, or goes away with the next action.

**Screen reader.** A reason beside an unavailable action is not tied to the action, and a reported refusal is not announced.

**Small window.** A reason beside an action is cut short to the space it has. A reported refusal wraps within most of the window's width.

**Slow machine.** While a later check is out, the action stays unavailable and keeps showing the previous reason if there was one.
