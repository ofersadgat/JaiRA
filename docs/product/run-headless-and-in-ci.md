---
id: product/run-headless-and-in-ci
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can do the essentials from a terminal: set up a project, create, start, resume, inspect and cancel work, check processes, review changes and trim history, all with exit codes a build can act on, so that the product fits scripts and CI as well as the desktop."
importance: 0.55
audience: developer
metrics:
  - "Builds that check processes before changes are merged: rises"
  - "Runs with no person present that fail because an answer was needed and none was written in advance: falls"
requires: [product/hand-work-to-agents]
related: [product/catch-process-mistakes-before-running, product/keep-process-and-description-in-step, product/try-a-process-without-spending, product/review-changes-before-they-land, product/only-approved-code-runs, product/keep-history-within-bounds]
verified_by: []
---

# Work can be run, checked and managed from a terminal, and a build can act on the result

> As a developer, I can do the essentials from a terminal: set up a project, create, start, resume, inspect and cancel work, check processes, review changes and trim history, all with exit codes a build can act on, so that the product fits scripts and CI as well as the desktop.

## Without this, a process that only runs from the desktop cannot take part in a build

The person is a developer wiring processes into scripts and pipelines. A process
that can only be started and checked from a desktop app cannot gate a merge or
run on a build machine, and a command that waits for someone to type an answer
on a build machine hangs until it is killed.

## The essentials work from a terminal, and every command's exit code says whether it succeeded

From a terminal, a person can set up a project, run a process once, create a
piece of work and start it, see how a piece of work stands and what it did most
recently, see all of a project's work at once, and cancel work, including work
another process is running. Starting work that already ran picks it up where it
stopped. They can also approve the code a process calls, go through the changes
on a branch one at a time, remove the separate copies of the code that work ran
in, and trim old history.

A command succeeds only when what it was asked to do succeeded, and starting work
succeeds only when the work completed. Checking processes for mistakes, and
checking them against their plain-language description, both fail when anything
is wrong, so a build can stop on them. Misusing a command is told apart from a
failure. Results can be written in a form a script reads.

Nothing waits silently for a person. Decisions a process will ask for are
answered from answers written in advance and given when the work starts, and a
decision with no answer written for it fails the step that reached it. Approving
code a process calls, or reviewing changes, is asked at the terminal when a
person is there. When nobody is, the command refuses and says what would let it
go ahead.

## Exit codes a build can trust turn a process check into a build step

A check is only worth having where the merge is decided, and only trustworthy if
success means success. Honest exit codes and no silent waiting let the person put
a process in front of every change without watching it.

## Success shows as more builds checking processes and fewer headless runs stopped for a missing answer

| Metric | Read from | Success |
| --- | --- | --- |
| Builds that check processes before changes are merged | The record of process checks run with no person present and their results | Rises |
| Runs with no person present that fail because an answer was needed and none was written in advance | The record of work that failed or was refused for want of an answer | Falls |

## Answers written in advance stand in for a person at the moment of deciding, which the principles otherwise require

A build has no person present, so answers the person wrote beforehand take that
place, and a decision with none still stops the work.
