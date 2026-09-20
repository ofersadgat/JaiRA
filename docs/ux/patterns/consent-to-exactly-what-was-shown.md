---
id: ux/patterns/consent-to-exactly-what-was-shown
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/only-approved-code-runs, product/risky-actions-wait-for-approval]
siblings: [ux/patterns/park-and-ask, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/unattended-run-never-waits-silently]
---

# Consent to exactly what was shown

When the person is asked to let something run on their machine, the question shows the thing itself in full rather than a summary, with the reason it was stopped, and nothing has run while the question is open. Code a process calls is asked about before work starts: every line of each file, what the process calls from it, and whether the file was never approved or has changed since it was. The approval is remembered on this machine for that exact content, so any change to the file asks again. In the app, approving records each file as it reads at the moment of approving, so a file changed between being shown and being approved is approved as it then reads. In a terminal, the approval is bound to the content that was shown. A command an agent proposes is asked about while the agent waits, as in [park-and-ask](park-and-ask.md), showing the exact command.

## Use it when an approval lets something run and a summary could hide what it authorises

**Use when.** A person's yes lets code or a command act on their machine or beyond it.

**Do not use when.** The decision is about what work produced rather than what will run: use [park-and-ask](park-and-ask.md) or [per-change-review](per-change-review.md). The act destroys something and needs a statement of what will be lost: use [second-deliberate-step-for-irreversible](second-deliberate-step-for-irreversible.md).

## The system stops before running, shows everything, and asks again when it changes

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Starts work, or an agent proposes a command | Stops before running and shows the full code or the exact command, what calls it, whether it is new or changed, and why it was stopped | Exactly what would run, and that nothing has |
| 2 | Approves | For code, records the approval and starts the work. For a command, runs it for that call or for longer, as the person chose | That it will run |
| 3 | Declines | For code, leaves the work unstarted. For a command, tells the agent it was denied, and the agent carries on without it | That nothing ran |
| 4 | Changes an approved file and starts work again | Asks again, marking the file as changed since it was approved | What moved since they said yes |

## Every state says whether anything has run and what an answer would allow

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Code never approved on this machine is marked as never approved and shown in full | Read it, then approve or cancel |
| empty | Cannot occur as its own state: the question is asked only when there is something to approve | Nothing |
| loading | Cannot occur: nothing runs until the question is answered | Answer |
| partial | Several files are approved together in one question that counts them and those changed. An unapproved file found only after approving raises a question of its own | Approve all shown, or cancel |
| error | If starting fails after code is approved, the approval stays recorded and the failure is reported apart from the question | Fix the cause and start again |
| denied | Declined code leaves the work unstarted, and a denied command reaches the agent as a denial. Without a person at a terminal, work needing code approval is refused, naming the command that approves it | Approve later, or approve from the terminal |
| success | Approved code runs and is not asked about again until it changes. An allowed command runs | Follow the work |

## A code approval can be withdrawn, a command approval cannot, and declining loses nothing

A code approval is withdrawn from the terminal, after which the file is asked about again.

A command approval cannot be withdrawn once given. An allowance wider than one call covers at most the rest of the agent call or conversation turn it was given in, and is never kept beyond it, so the next step or turn asks again. In a conversation it spares nothing: every tool call there asks the person, whatever was chosen before.

Declining changes nothing, and starting the work again asks again.

## Code approval takes no keyboard focus, and a terminal defaults to no

**Keyboard only.** Code approval is asked over whatever the person is doing, with standard buttons, but the focus is not moved into it and Escape does not cancel it. A command approval uses standard buttons where the agent's work is shown. In a terminal the question is a yes-or-no prompt whose default is no, and ending the input answers no.

**Screen reader.** Code approval is not identified as a dialog, and nothing is announced when it or a command approval arrives.

**Small window.** Each file's code scrolls within its own space. With several long files the question as a whole does not scroll, and the approve and cancel actions can fall below the window's edge, out of reach.

**Slow machine.** Nothing runs until the approval is recorded and the approved code is prepared, however long that takes.
