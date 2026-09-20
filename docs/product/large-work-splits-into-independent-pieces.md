---
id: product/large-work-splits-into-independent-pieces
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can have a large piece of work divide itself into separate pieces, each stopped, rewound or resumed on its own, and each started as soon as what it depends on is finished, so that one part going wrong never holds the rest hostage."
importance: 0.65
audience: user
metrics:
  - "Whole pieces of work started again because one of their parts failed: falls"
  - "Time a piece spends waiting after everything it depends on has finished: falls"
requires: [product/hand-work-to-agents, product/pick-up-where-it-left-off]
related: [product/repeatable-agent-processes, product/parallel-work-without-collisions, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/keep-track-of-everything]
verified_by: []
---

# One part of large work going wrong never holds the rest back, because each part is work of its own

> As a developer, I can have a large piece of work divide itself into separate pieces, each stopped, rewound or resumed on its own, and each started as soon as what it depends on is finished, so that one part going wrong never holds the rest hostage.

## Without this, work with several parts can only be stopped, rewound or resumed as a whole

The person is a developer whose processes produce work with several parts, such
as a product decision that yields five features to build. While those parts live
inside one piece of work, one part failing stops all of them, rewinding one part
rewinds the others, and a part that is ready waits on a part that is not.

## Each part becomes its own piece of work, and starts the moment what it depends on is finished

Where a process decides that several things need doing, it can make each of them
a piece of work of its own, named for what it is about.

A process can file the pieces under the work that made them. That work waits for
all of them and then carries on with what they produced. They work in the same
code as the work that made them, one after another unless the process lets them
run together, and stopping that work stops the pieces it is waiting on. When one
of them fails, the work waiting on it is told that it failed.

A process can instead set the pieces beside the work. The work keeps one of the
things as its own and carries on with it, and each other thing becomes a piece
that holds the work's history up to that point and goes through the rest of the
process by itself. Each of these pieces works on its own branch. When there is
only one thing, nothing is split and the work carries on with it.

A piece set beside the work that depends on other pieces waits for them, says
which ones it is waiting for, and starts by itself the moment the last of them
finishes, from the code of the one that finished most recently. Starting it
earlier is refused with the names of what it waits for. The process can leave
those starts to the person instead.

Stopping, rewinding, branching or resuming one piece leaves what the other pieces
have done as it is. Each piece shows the other pieces made alongside it and how
each of them stands.

## Splitting large work means one failure costs one part

A job with five independent parts held in one piece of work is only as
recoverable as its weakest part. As separate pieces, a part that goes wrong is
fixed and resumed alone while the others finish, and a part that is ready starts
without anyone watching for the moment it can.

## Success shows as no whole job restarted for one part and no piece idle once it could start

| Metric | Read from | Success |
| --- | --- | --- |
| Whole pieces of work started again because one of their parts failed | The record of work that split, and of each piece's failures, resumes and restarts | Falls |
| Time a piece spends waiting after everything it depends on has finished | The record of when each piece's dependencies finished and when the piece started | Falls to near zero |
