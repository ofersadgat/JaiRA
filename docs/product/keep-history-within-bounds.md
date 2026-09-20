---
id: product/keep-history-within-bounds
type: product-feature
status: shipped
updated: 2026-09-13
story: "As an operator, I can remove old run history, seeing first exactly what would go, without ever losing anything unfinished work needs to resume, so that history does not grow forever and trimming it never breaks work in progress."
importance: 0.3
audience: operator
metrics:
  - "Work that could not be picked up because its history had been trimmed: falls"
  - "Growth of the history held by projects that trim: falls"
requires: [product/complete-record-of-every-run]
related: [product/pick-up-where-it-left-off, product/run-history-travels-with-the-repository, product/find-out-why-the-app-misbehaves]
verified_by: []
---

# Old run history can be trimmed without breaking work that is still going

> As an operator, I can remove old run history, seeing first exactly what would go, without ever losing anything unfinished work needs to resume, so that history does not grow forever and trimming it never breaks work in progress.

## Without this, history grows forever or trimming it risks work in progress

The person looks after a project's storage. A record that is never trimmed
eventually costs disk space and speed. A trim that could remove what unfinished
work resumes from would make the whole record untrustworthy, so without a safe
one nobody trims.

## You see what would go, then trim ended work older than you choose, and unfinished work is always kept

A person can see how much history a project holds and ask what trimming
everything older than a number of days would remove. They see which pieces of
work would lose their history, and which were kept and why, before anything is
removed.

Only work that has ended is eligible: work that completed, failed or was
stopped, and ended before the cutoff. Work waiting to start, running, or cut off
by a crash or by the app closing is kept whatever its age. Trimming removes how a
piece of work went: its step-by-step record, its conversations, the commands it
ran and their output. The piece of work itself stays, with what it was and how it
ended.

Work that failed or was stopped cannot be picked up again once its history is
trimmed.

From a terminal, trimming reports what would go and removes nothing unless the
person explicitly asks for it.

## Trimming is only worth doing if it can never cost work in progress

The record of how work went is what makes it reviewable and resumable. Because
unfinished work is never eligible, the person can keep that record affordable
without first checking what is still in progress.

## Success shows as history staying bounded and less work left unable to resume after a trim

| Metric | Read from | Success |
| --- | --- | --- |
| Work that could not be picked up because its history had been trimmed | The record of attempts to pick up work and why any were refused | Falls |
| Growth of the history held by projects that trim | The record of how much history each project holds over time | Falls |

## Trimming deletes records for good, which the principles otherwise avoid

Trimming cannot be undone. The person is told so and sees exactly what goes
before choosing it, and only ended work is ever eligible.
