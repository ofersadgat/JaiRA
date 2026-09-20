---
id: product/try-a-process-without-spending
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can run a process with scripted answers in place of real models and people, and see exactly what a person will be asked at any decision and what their answer will return, so that I find mistakes in a process without spending money or waiting for a run to reach them."
importance: 0.45
audience: developer
metrics:
  - "Scripted runs per real run while a process is being written or changed: rises"
  - "Mistakes in how a decision is set up that are first found in a real run: falls"
requires: [product/repeatable-agent-processes]
related: [product/try-one-step-on-its-own, product/run-headless-and-in-ci, product/catch-process-mistakes-before-running, product/find-out-why-the-app-misbehaves]
verified_by: []
---

# A process can be rehearsed end to end without paying for a model or waiting on a person

> As a developer, I can run a process with scripted answers in place of real models and people, and see exactly what a person will be asked at any decision and what their answer will return, so that I find mistakes in a process without spending money or waiting for a run to reach them.

## Without this, testing a process means paying for a real run and waiting for it to reach the mistake

The person is a developer writing and changing processes. A mistake in a
process is often late in it, in what one step hands the next, or in what a
decision asks a person. A real run finds it only after every earlier step has
been paid for and waited on. The paths that break most, such as a decision sent
back or an agent replying with the wrong thing, are the ones a real run seldom
takes.

## Scripted replies stand in for models, agents and people, and everything else runs for real

A person can run a process with scripted replies in place of every model and
agent, and scripted answers in place of every person. The rest of the process
runs as it would for real: what each step hands on, the checks on what it is
given, the decisions it reaches and the record it keeps. Such a run costs
nothing and finishes in moments, so the person can steer it down any path they
choose. Scripted runs are started from a terminal. A process can also be tried
without keeping any record of the attempt.

A person can also see a decision a process puts to a person exactly as it will
be asked, filled in from a real setup they can change. They can answer it and
see what the answer returns to the process and whether it would be accepted. A
mistake in how the decision is set up is reported exactly as a real run would
report it.

## Rehearsing for free is what makes the unhappy paths worth testing

A real run of a long process costs money and minutes on every attempt. When an
attempt costs nothing, testing the path where a decision is sent back or a reply
is wrong becomes something a person actually does. A decision seen and answered
before any run means no real run is the first to find it cannot be answered.

## Success shows as more rehearsals per real run and fewer decisions breaking in real work

| Metric | Read from | Success |
| --- | --- | --- |
| Scripted runs per real run while a process is being written or changed | The record of work started with scripted replies and work started without | Rises |
| Mistakes in how a decision is set up that are first found in a real run | The record of real work that failed because a decision was set up wrongly | Falls |
