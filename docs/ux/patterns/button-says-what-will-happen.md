---
id: ux/patterns/button-says-what-will-happen
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/pick-up-where-it-left-off, product/review-changes-before-they-land, product/steer-agents-mid-task, product/rewind-to-where-it-went-wrong, product/try-one-step-on-its-own]
siblings: [ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/comments-turn-a-verdict-into-send-back, ux/patterns/show-the-request-not-the-outcome]
---

# The button says what will happen

The main action's wording comes from what it will actually do in the situation at hand, decided by the system that will do it, so the words cannot promise one act while the system performs another. Stopped work that can continue offers to resume, naming the step where it picks up and how much finished work it keeps. Work whose step failed offers to retry that step and keep what came before it. Work with nothing to resume offers to start again from the top, and finished work offers to run again, which makes a new piece of work. A review's action says whether it accepts the changes or sends them back, as in [comments-turn-a-verdict-into-send-back](comments-turn-a-verdict-into-send-back.md). A message box says whether the next message joins the turn under way or waits for it, and whether it replaces an earlier message or starts a new conversation from it. Where an action's target is not obvious, such as the project a step will run in, the target is named before the action is taken.

## Use it when one action performs different acts and the difference matters

**Use when.** One action does different things depending on the situation, and the person would decide differently if they knew which: resume or start over, keep the work or copy it, join a turn or wait, accept or send back.

**Do not use when.** The act never varies: a plain name is enough. The action is not possible at all: make it unavailable and say why with [refuse-with-the-reason-and-the-fix](refuse-with-the-reason-and-the-fix.md).

## The system names the act before it is taken and performs exactly that act

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Comes to the action | Works out which act it would perform and names it, with what is kept and where it continues | What will happen if they take it |
| 2 | Takes it | Performs exactly the named act | That the act they read is the act taken |
| 3 | Nothing | Reports the result. When the act made a new piece of work, the view moves to the new work | Which work is now running |

## Every state names the act that taking the action would perform

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Work never started offers to start it and says it runs the process | Start |
| empty | Cannot occur: an offered action always names an act | Take it |
| loading | The wording arrives with the work's own facts, so no act is named before the system has decided it. Work the system has no plan for, such as finished or running work, is offered running again | Take the action |
| partial | Stopped work that can continue offers to resume, naming where it picks up and how much finished work it keeps without running any of it again | Resume |
| error | Work whose step failed offers to retry that step, naming how much finished work before it is kept | Retry |
| denied | Work that waits on other work says what it waits for and still offers its act, which the system refuses if taken. Work that cannot resume offers to start again and says why resuming is unavailable. The work's own action stays offered while the work runs, and is refused if taken | Wait, or start again |
| success | Finished work offers to run again, and its actions on the item say this makes a new piece of work. Taking it moves the view to the copy | Follow the copy |

## The wording commits to nothing, and a copy leaves the original untouched

Reading the wording changes nothing. Taking the action does only what was named: resuming and retrying keep the finished work, and running again as a new piece of work leaves the original exactly as it was. Undoing any of them is the named act's own undo, such as stopping or rewinding the work.

## The action works by keyboard, but what it keeps is given only to a resting pointer

**Keyboard only.** The action is a standard button reached by Tab. What it keeps and where it continues is shown only while a pointer rests on it, so a keyboard user gets the act's name without that detail.

**Screen reader.** The act is the action's own name and is announced. Whether a message joins or waits is plain text beside the message box and is not announced when it changes.

**Small window.** Detail stated beside an action is cut short to fit.

**Slow machine.** The wording is worked out again each time the work's facts are read, so it is as current as the last read.
