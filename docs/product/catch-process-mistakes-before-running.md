---
id: product/catch-process-mistakes-before-running
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can see every mistake in my processes, such as a step that uses a value nothing produces, an input nobody supplies, a decision nobody could answer or an error in the code a process calls, as soon as I save and before any work runs into it, so that work does not fail on authoring mistakes."
importance: 0.7
audience: developer
metrics:
  - "Work that fails on a mistake the check reports: falls"
  - "Time from saving a mistake to seeing it reported: falls"
requires: [product/repeatable-agent-processes]
related: [product/author-processes-without-memorising-the-format, product/run-headless-and-in-ci, product/share-processes-across-projects, product/try-one-step-on-its-own]
verified_by: []
---

# Mistakes in a process show up when you save it, not when work runs into them

> As a developer, I can see every mistake in my processes, such as a step that uses a value nothing produces, an input nobody supplies, a decision nobody could answer or an error in the code a process calls, as soon as I save and before any work runs into it, so that work does not fail on authoring mistakes.

## Without this, a mistake in a process is found by the work that reaches it

The person is a developer writing and changing processes. Many mistakes only
surface when work reaches the step they are in. Found that way, a mistake costs
the time and money spent getting there, and often an answer a person already
gave along the way.

## Every saved change is checked at once, and each mistake is reported where it is

Every change to a process is checked again as soon as it is saved. The check
finds a step that uses a value nothing produces, an input nobody supplies, a
reference to something that does not exist, and a decision a person could not
answer, such as a choice with nothing to choose from. Each mistake is reported
against the exact part of the process it is in. A person can tell that something
contains mistakes, and how many, without opening it.

A step that no process uses cannot be checked in context, so it is said to be
unchecked rather than looking clean. A process that cannot be read at all is
described as such, and the others are still checked. Shared processes are
checked even with no project open.

Code a process calls is checked the way the project checks its own code, while
it is being written.

Running a step that has mistakes is refused, and the refusal says why. Warnings
are reported and never refuse. The same check runs from a terminal, where a
mistake fails the build.

## A mistake found while writing costs a moment, and found by work it costs the run

A process mistake is cheapest the moment it is made. Every step a piece of work
completes before reaching it is paid for twice, once on the failed run and again
after the fix.

## Success shows as no work failing on a mistake the check already knew about

| Metric | Read from | Success |
| --- | --- | --- |
| Work that fails on a mistake the check reports | The record of each failure compared with the mistakes reported for the process that work started with | Falls to zero |
| Time from saving a mistake to seeing it reported | The record of when each change was saved and when its mistakes were reported | Stays within a second |
