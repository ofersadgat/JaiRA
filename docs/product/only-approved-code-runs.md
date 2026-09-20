---
id: product/only-approved-code-runs
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can be sure that code a process calls runs on my machine only after I have read and approved it, and again whenever it changes, so that a process cannot run code I have not seen."
importance: 0.45
audience: developer
metrics:
  - "Runs that used process code not approved in its current form: falls"
  - "Changed process code that ran without being approved again: falls"
requires: [product/repeatable-agent-processes]
related: [product/risky-actions-wait-for-approval, product/run-headless-and-in-ci]
verified_by: []
---

# Code a process calls runs on your machine only once you have approved it as it is now

> As a developer, I can be sure that code a process calls runs on my machine only after I have read and approved it, and again whenever it changes, so that a process cannot run code I have not seen.

## Without this, starting a process can run any code on your machine

The person is a developer running processes, including ones they did not write.
A process can call code kept in the project. Starting the process would run that
code with the person's own access to their machine whether or not anyone read
it, and a later change to that code would run just as quietly.

## You see the code in full before anything runs, and you are asked again whenever it changes

Before work that calls a project's own code starts, the person is shown that code
in full, which parts of it the process calls, and whether it is new or has
changed since it was last approved. Nothing has run at that point.

Approving starts the work and is remembered on this machine until the code
changes. The approval is not carried with the repository to anyone else's
machine. Declining leaves nothing to undo, because nothing started.

Work started with no one there to ask refuses to start and says how to approve
the code, unless the person said when starting it that the code is approved.
Approvals can be listed and withdrawn from a terminal.

## Asking again on every change keeps approval from becoming a rubber stamp

A process is easy to share and easy to change, and code it calls can do
anything. Seeing that code in full when it would first run, and again after any
change, means code runs only on a person's say-so, and a change slipped into
code they approved before is caught.

## Success shows as no process code ever running in a form nobody approved

| Metric | Read from | Success |
| --- | --- | --- |
| Runs that used process code not approved in its current form | The record of each approval, the exact code it covered, and the code each run used | Stays at zero |
| Changed process code that ran without being approved again | The record of each approval and of later changes to the code it covered | Stays at zero |
