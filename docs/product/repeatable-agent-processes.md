---
id: product/repeatable-agent-processes
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can write down once how a kind of work gets done, with its steps, who does each, what each must hand on and when to go back, so that agents follow my process every time instead of improvising one."
importance: 0.95
audience: developer
metrics:
  - "Runs of one process that take a different path through its steps for equivalent work: falls"
  - "Work done on a written process rather than improvised in a conversation: rises"
  - "Work that fails because a step received something an earlier step never promised: falls"
requires: []
related: [product/hand-work-to-agents, product/decisions-stay-yours, product/catch-process-mistakes-before-running, product/share-processes-across-projects, product/author-processes-without-memorising-the-format]
verified_by: []
---

# Agents follow the process you wrote down, the same way every time

> As a developer, I can write down once how a kind of work gets done, with its steps, who does each, what each must hand on and when to go back, so that agents follow my process every time instead of improvising one.

## Without this, an agent makes up its own way of doing the work each time

The person is a developer who hands recurring kinds of work to coding agents,
such as planning a feature, reviewing a change or writing a document. Left to
itself, an agent decides the process as it goes. Two runs of the same kind of
work take different steps, and a person cannot review or trust what they cannot
predict.

## You write down once how the work is done, and every run follows it

A process is made of steps, and a step can be made of smaller steps. Each step
does one thing: asks a model for an answer in a shape the author set, hands a
job to a coding agent, runs the developer's own code, runs a command, or asks a
person.

Each step says what it needs and what it hands on. What a step hands on is
checked against what it promised before any later step uses it, so a step that
produced the wrong thing is caught at that step instead of misleading the steps
after it.

The author decides where the work goes after each step and on what condition,
including back to an earlier step with what was learned, and how many times it
may go back. Steps that do not depend on each other run at the same time, and a
step can run once for each of many items.

Steps can share one conversation on purpose, so a later step builds on what an
earlier one said. A prompt or passage used in several places is written once.

## Agent work on a written process can be predicted, reviewed and improved

The same kind of work goes through the same steps, and the points where a person
decides are where the author put them. A process that went wrong is fixed once,
and every later run gets the fix.

## Success shows as one process taking one path and less work improvised

| Metric | Read from | Success |
| --- | --- | --- |
| Runs of one process that take a different path through its steps for equivalent work | The record of the steps each run of a process went through | Falls |
| Work done on a written process rather than improvised in a conversation | The record of each piece of work and whether it ran on a process | Rises as a share of all work |
| Work that fails because a step received something an earlier step never promised | The record of each failure and the step it happened in | Falls to zero, because the step that produced it is where it is caught |
