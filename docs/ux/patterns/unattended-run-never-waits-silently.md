---
id: ux/patterns/unattended-run-never-waits-silently
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/run-headless-and-in-ci, product/catch-process-mistakes-before-running, product/keep-process-and-description-in-step, product/try-a-process-without-spending, product/only-approved-code-runs]
siblings: [ux/patterns/park-and-ask, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/consent-to-exactly-what-was-shown]
---

# Unattended run never waits silently

Work run from a terminal never waits for an answer nobody can give. A person counts as present only when both the command's input and its output are a terminal, and then code approval and a review of changes are asked at the terminal, unless a flag says never to ask. Otherwise an answer comes from a script given with the command, code approval can be granted by a flag, and anything else that needs a person is refused at once, naming the flag, command or setting that fixes it. Other decisions a process declares are answered only by a script, and a script with no answer for a decision fails the work at that step with the reason. The outcome is the exit status: zero when the work completed or the check found the process and its description in step, one for a failure or a refusal, and two for a command used wrongly. Progress, warnings and refusals go to the error stream, and results go to the output stream.

## Use it when work or checks run from scripts or pipelines

**Use when.** A command starts, resumes or checks work where nobody may be watching, and whatever runs it acts on the exit status.

**Do not use when.** The person is in the app and can answer in place: use [park-and-ask](park-and-ask.md).

## The command asks only someone present, otherwise answers from a script or refuses with the fix

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Runs a command, with scripted answers, a flag, or neither | Reports work recovered from an interruption and processes left running by an earlier session, refuses work another process is already running, then starts | What it is doing, and what was left over |
| 2 | Nothing, unless asked at the terminal | At anything needing a person, asks if one is present, uses the script or flag if given, and otherwise refuses at once naming the fix | Why it stopped, and how to make it go |
| 3 | Nothing, or interrupts | Prints the result and exits with a status that reflects it. A first interrupt stops the work gracefully, and a second ends the command at once | Pass or fail, in a form a script can act on |

## Every state ends in an exit status and a line saying what to do

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A command given without what it needs prints how it is used and exits with the usage status | Add the missing arguments |
| empty | A command with nothing to act on says so and succeeds, such as reviewing a checkout with no changes. Pruning history only reports what it would delete unless told to apply | Add the flag to apply |
| loading | A few lines name the task, the process version pinned for it and its working copy, then nothing until the result | Wait, or interrupt |
| partial | Work interrupted earlier is reported as recovered, and processes left running by an earlier session are named in a warning | Resume the recovered work, or end the leftover processes |
| error | Anything needing a person, with nobody present and no script or flag, is refused naming what answers it, and exits with the failure status | Script the answer, pass the flag, or attach a terminal |
| denied | Work whose agents would need command approvals is refused before any step runs, naming the app and the setting that removes the need. Work already running in another process is refused | Run it in the app, change the setting, or wait for the other process |
| success | The result is printed and the exit status is zero | Read the result, or let the script go on |

## Stopped work resumes by starting it again, and nothing is deleted without the flag

A cancel requested from another terminal asks the running command to stop, and it honours the request. Interrupted or cancelled work continues from where it stopped when it is started again, as in [pick-up-where-it-left-off](../../product/pick-up-where-it-left-off.md).

Code approved by flag or at the prompt stays approved until withdrawn, as in [consent-to-exactly-what-was-shown](consent-to-exactly-what-was-shown.md). Pruning deletes history only when told to apply.

## Everything is typed, and a first interrupt leaves an open prompt waiting

**Keyboard only.** Everything is typed. A first interrupt does not dismiss an open yes-or-no prompt, which still waits for its answer or a second interrupt.

**Screen reader.** Output is plain lines of text.

**Small window.** Output is plain lines that wrap as the terminal wraps them.

**Slow machine.** Nothing times out, and a long step shows no sign of progress between its first lines and the result.
