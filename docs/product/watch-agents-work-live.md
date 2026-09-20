---
id: product/watch-agents-work-live
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can watch what an agent is doing while it does it, including what it is writing, how long it has been thinking, which tools it is using and what the helpers it started are doing, so that I can step in the moment it goes the wrong way."
importance: 0.8
audience: user
metrics:
  - "Time from an agent going wrong to the person stopping or steering it: falls"
  - "Work stopped early and then resumed or rewound, rather than run to a bad end and started again: rises"
requires: [product/hand-work-to-agents]
related: [product/complete-record-of-every-run, product/steer-agents-mid-task, product/pick-up-where-it-left-off, product/keep-track-of-everything]
verified_by: []
---

# You see what an agent is doing while it does it, so you can step in as soon as it goes wrong

> As a developer, I can watch what an agent is doing while it does it, including what it is writing, how long it has been thinking, which tools it is using and what the helpers it started are doing, so that I can step in the moment it goes the wrong way.

## Without this, you learn an agent went the wrong way only when its result arrives

The person is a developer who hands work to agents that run for minutes at a
time. If what an agent does shows only once it finishes, a wrong direction is
found after the time and money are spent, and the only thing left to do is throw
the result away.

## What the agent writes, thinks and runs appears as it happens, and becomes the record when it finishes

While an agent works, what it writes, its reasoning, each tool it uses and what
that tool gave back appear as they happen. The work of helper agents it started
appears too, one message at a time. While watching, the person can tell whether
the agent is writing, thinking or running something, and for how long. How long
it has been thinking is shown even when the model does not share its reasoning.

This holds for a step of a process and for a conversation alike. Leaving and
coming back loses nothing that already arrived. When the agent finishes, what
the person watched becomes the permanent record of that step, with nothing
missing and nothing shown twice.

Reading back through earlier output is not disturbed by new output arriving, and
getting back to the newest output is immediate.

## Seeing the direction early is what makes stopping early possible

An agent heading the wrong way spends minutes and money before its result shows
it. Seeing that direction while it forms lets the person stop or correct the
agent at the first wrong step, which makes the cost of a mistake that step rather
than the whole run.

## Success shows as agents corrected sooner and fewer runs taken to a bad end

| Metric | Read from | Success |
| --- | --- | --- |
| Time from an agent going wrong to the person stopping or steering it | The record of when each step started and when a person stopped or messaged it, for work later rewound | Falls |
| Work stopped early and then resumed or rewound, rather than run to a bad end and started again | The record of stops followed by a resume or rewind, against work started again after it ended | Rises |
