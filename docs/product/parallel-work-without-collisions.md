---
id: product/parallel-work-without-collisions
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can run several pieces of work on the same repository at the same time, each on its own branch in its own copy of the code, so that they never overwrite each other or my uncommitted work."
importance: 0.8
audience: user
metrics:
  - "Pieces of work running at the same time on one repository: rises"
  - "Uncommitted work lost when a working copy was removed: falls"
requires: [product/hand-work-to-agents]
related: [product/review-changes-before-they-land, product/large-work-splits-into-independent-pieces, product/keep-track-of-everything, product/agents-act-only-where-allowed]
verified_by: []
---

# Several pieces of work run on one repository at once without touching each other or your own changes

> As a developer, I can run several pieces of work on the same repository at the same time, each on its own branch in its own copy of the code, so that they never overwrite each other or my uncommitted work.

## Without this, two agents in one copy of the code undo each other's work

The person is a developer who wants several agents working on the same
repository while they keep working in it too. Agents editing one copy of the
code overwrite each other's changes, build on each other's half-finished edits
and can overwrite work the person has not committed. Keeping them apart by hand
means running one at a time.

## Work bound to a branch gets its own copy of the code to work in

A piece of work can be bound to a branch. The first time it starts, it gets its
own working copy of the repository on that branch, kept outside the project, and
its agents and commands run in that copy. A branch that does not exist yet is
created. Work that is not bound to a branch runs in the project as it is, with
no separation from anything else there.

A working copy that holds uncommitted changes is removed only when a person
insists, and its branch is always kept. A working copy that has disappeared is
made again rather than breaking the work.

## Running agents side by side is the point, and separation is what makes it safe

The value of handing work to agents grows with how many can work at once. That
holds only while they cannot destroy each other's work or the person's own, and
the cost of a collision is work that was never committed and cannot be
recovered.

## Success shows as more work running at once and no uncommitted work lost

| Metric | Read from | Success |
| --- | --- | --- |
| Pieces of work running at the same time on one repository | The record of when each piece of work ran and on which repository | Rises |
| Uncommitted work lost when a working copy was removed | The record of working copies removed, including those refused because they held uncommitted changes | Stays at zero |
