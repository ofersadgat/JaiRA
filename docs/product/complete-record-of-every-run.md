---
id: product/complete-record-of-every-run
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can go back to any run and read exactly what each step was given, said, did and produced, in the order it happened, so that agent work can be reviewed and audited after the fact."
importance: 0.85
audience: user
metrics:
  - "Finished steps whose conversation cannot be read back: falls"
  - "Reviews that send work back naming the step responsible: rises"
  - "Time from opening a piece of work to reaching the step responsible for a bad result: falls"
requires: [product/hand-work-to-agents]
related: [product/watch-agents-work-live, product/failures-explain-themselves, product/know-what-work-costs, product/read-what-work-produced, product/rewind-to-where-it-went-wrong, product/keep-history-within-bounds, product/run-history-travels-with-the-repository]
verified_by: []
---

# Every run can be read back step by step, exactly as it happened

> As a developer, I can go back to any run and read exactly what each step was given, said, did and produced, in the order it happened, so that agent work can be reviewed and audited after the fact.

## Without this, reviewing agent work means trusting an account of it

The person is a developer who answers for what their agents did. A final result
and an agent's summary say what the agent claims. They do not show what it was
told, what it read, which commands it ran, what came back, or why the work went
where it did next.

## Each step keeps what it was given, every exchange and tool use, and what it produced

For every step of every run, the record keeps what the step was given, every
message it exchanged, every tool it used with both what was asked and what came
back, and what it produced. Around the steps it keeps where the work went next,
what a person was asked and how they answered, and what failed.

Each step's part of the record is what that step added, even where it continued
a conversation an earlier step began. A step that ran several times is kept as
each separate pass, and the passes are told apart by what each was given. Results
with a defined shape read as the values they are rather than as text.

The record reaches inside everything the work contains. Steps inside larger
steps, and the conversations of helper agents an agent started, are read the
same way as the steps around them. When a coding agent finishes, what it kept in
its own history is added to the record, so details it never reported while
working are there too.

What a person rewinds, deletes or trims as old history leaves the record.

## A complete record is what makes agent work reviewable, and what makes resuming and rewinding exact

Reviewing agent work means reading what the agent actually did. A record that
holds every exchange lets the person find the step that went wrong and send the
work back with feedback that names it. The same record is what resuming reads
from and what rewinding cuts, so its completeness is also what makes those
exact.

## Success shows as every step readable and the responsible step found quickly

| Metric | Read from | Success |
| --- | --- | --- |
| Finished steps whose conversation cannot be read back | The record of each finished step against the exchanges kept for it | Falls to zero |
| Reviews that send work back naming the step responsible | The record of each review's outcome and the feedback given with it | Rises |
| Time from opening a piece of work to reaching the step responsible for a bad result | The record of when a person opened the work and when they reached the step later rewound or sent back | Falls |
