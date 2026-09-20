---
id: product/see-how-a-process-flows
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can see at once what runs after what in a process, what sends it back, where each value comes from and which steps share a conversation, so that I understand a process without assembling it in my head from what is written."
importance: 0.45
audience: developer
metrics:
  - "Mistakes in how steps connect found by running work rather than while writing: falls"
  - "Time from starting a new process to the first work on it that finishes: falls"
requires: [product/repeatable-agent-processes]
related: [product/author-processes-without-memorising-the-format, product/catch-process-mistakes-before-running]
verified_by: []
---

# You can see how a process moves without piecing it together in your head

> As a developer, I can see at once what runs after what in a process, what sends it back, where each value comes from and which steps share a conversation, so that I understand a process without assembling it in my head from what is written.

## Without this, understanding a process means reading all of it and holding it in memory

The person is a developer reading a process to change it, review it, or find out
why work went where it did. What follows a step, what sends work back, which
step supplies a value and which steps see each other's conversation are each
written in a different place. Answering any one of those means reading the whole
process and keeping the rest in mind.

## The whole process is seen at once, and any part shows exactly what it connects to

A person sees a process as its steps in the sequence they run, with moving on,
going back, and ending other than in success told apart. Every value is traced
from the step that produces it to each step that uses it, including the values
that decide where the work goes next.

Steps that share one conversation are seen together as one conversation, and
steps that merely look alike are not.

Singling out one step, one value, or one rule for where work goes brings out
exactly what it connects to.

From any step the person can go to that step's own definition and into the steps
inside it, and come back to the whole. A reference to a step that does not exist
is marked where the reference is.

## The questions an author asks most are answered by looking rather than by reading

What comes next, what feeds this step, and whether two steps share a
conversation are the questions behind most mistakes in how a process is put
together. Seeing the answer at once catches those mistakes before any work runs
into them, and lets someone new to a process understand it quickly.

## Success shows as fewer connection mistakes reaching work and faster first runs

| Metric | Read from | Success |
| --- | --- | --- |
| Mistakes in how steps connect found by running work rather than while writing | The record of failures caused by a value or step that did not exist, compared with mistakes reported while writing | Falls |
| Time from starting a new process to the first work on it that finishes | The record of when a process was first saved and when work on it first finished | The median falls |
