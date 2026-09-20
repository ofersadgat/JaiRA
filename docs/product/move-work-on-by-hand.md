---
id: product/move-work-on-by-hand
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can move a piece of work to its next stage myself wherever the process leaves that choice to me, so that manual stages fit in the same process as automated ones."
importance: 0.25
audience: user
metrics:
  - "Moves by hand that the process accepted: rises"
  - "Moves by hand to a stage the process did not allow: falls"
requires: [product/hand-work-to-agents]
related: [product/decisions-stay-yours, product/repeatable-agent-processes, product/keep-track-of-everything]
verified_by: []
---

# Stages a person moves on by hand belong to the same process as the automated ones

> As a developer, I can move a piece of work to its next stage myself wherever the process leaves that choice to me, so that manual stages fit in the same process as automated ones.

## Without this, a stage that ends on a person's judgement sits outside the process

The person is a developer whose work passes through stages that no question
settles: a change is ready for review when they say it is, a piece of work is
done when they are satisfied with it. If a process cannot wait on that judgement,
those stages are tracked somewhere else, and the process either skips them or
dresses them up as questions.

## The process waits for you to move the work on, and only to the stages it allows

A process can wait at a point for a person to move the work on, rather than for
an answer to a question. There the person moves the work to one of the stages the
process allows from where it stands, and to no other. Work that is not waiting
for such a move cannot be moved by hand.

The work moves only when the process accepts the move, so the stage the person
sees it in is always the stage it is in. From there the process carries on by
itself. Work waiting for a move when the app is closed is still waiting for it
when the app opens again.

## Manual stages inside the process are followed and recorded like every other step

Kept inside the process, a manual stage is in the record like any other: when the
person moved the work and where to. The steps after it follow without anyone
starting them, and no part of the work has to be tracked anywhere else.

## Success shows as manual stages moved through the process and never around it

| Metric | Read from | Success |
| --- | --- | --- |
| Moves by hand that the process accepted | The record of each move a person made and the stage the work carried on from | Rises as processes put manual stages inside |
| Moves by hand to a stage the process did not allow | The record of moves a person made against the stages the process allowed at that point | Stays at zero |
