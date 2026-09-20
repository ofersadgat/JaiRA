---
id: product/work-runs-the-process-it-started-with
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can change a process while work is running on it without disturbing that work, so that improving a process is never a risk to work already in flight."
importance: 0.45
audience: developer
metrics:
  - "Work whose steps changed because its process was edited while it ran: falls"
  - "Changes made to a process while work on it is running: rises"
requires: [product/repeatable-agent-processes]
related: [product/pick-up-where-it-left-off, product/catch-process-mistakes-before-running, product/try-one-step-on-its-own]
verified_by: []
---

# Changing a process never disturbs work already running on it

> As a developer, I can change a process while work is running on it without disturbing that work, so that improving a process is never a risk to work already in flight.

## Without this, improving a process puts every piece of work on it at risk

The person is a developer who improves their processes as they use them. Work
on a process can run for hours or wait days for a decision. If a change reached
work already under way, one edit could send that work into steps that do not fit
what it has already done, and nobody could say which version produced the
result. The safe choice would be never to edit a process while anything runs on
it, which means rarely improving it.

## Work keeps the exact process it started with, whatever changes afterwards

When work starts, it keeps a copy of its process as last saved, including the
prompts and the code the process calls. It runs that copy to the end, and
nothing done to the process afterwards reaches it.

The copy stays with the work. Stopping and carrying on later, or recovering after
a crash or after the app closes, continues on the same copy.

A person can tell when work is running an older version of its process than the
one saved now. Work under way is never moved onto a changed process. To try a
change, a person starts new work, which keeps the new version.

## A process is only improved if editing it is safe while it is in use

Authors who fear breaking running work stop editing, and their processes stop
getting better. Because each piece of work keeps its own copy, every result can
also be traced to the exact process that produced it.

## Success shows as no work changed underneath it and more editing while work runs

| Metric | Read from | Success |
| --- | --- | --- |
| Work whose steps changed because its process was edited while it ran | The record of the process each piece of work started with and the steps it went through | Falls to zero and stays there |
| Changes made to a process while work on it is running | The record of changes to each process and the work running on it at the time | Rises, because editing is no longer a risk |
