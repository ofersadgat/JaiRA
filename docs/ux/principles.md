---
id: ux/principles
type: standing
status: proposed
updated: 2026-08-04
---

# UX principles

How interactions should behave, independent of what they look like. Phase 2 of
[WORKFLOW.md](../../WORKFLOW.md) reads this before designing a flow; a flow that
departs from one records an `exceptions` entry or amends this file.

A principle here should be able to *reject a flow*. If it can't, it is a slogan.

> **Partly seeded.** The first three are already true of the product and are
> stated so they can be cited. The rest are yours to write — and the fastest way
> to write them is to look at a flow you rejected and ask what rule you were
> applying.

## The system never destroys work to make a step simpler

A dirty worktree is refused rather than cleaned. Removing a worktree keeps its
branch. Generated content arrives as an unsaved edit the person can reject.

Rejects: any flow whose happy path overwrites something the person could still
want, including "we'll back it up first".

## A human answer is asked for once, explicitly, and validated where it lands

Gates park the run, ask, and re-validate at the trust boundary. There is no
implicit consent, no "continue unless you object" timeout.

Rejects: flows that infer approval from inaction.

## Waiting is a state, not an absence

A run taking minutes is normal here. Every flow says what the person sees while
it happens, and what they can do — including leave and come back.

Rejects: flows whose `loading` row says "spinner".

## Recoverability

_To write._ What must be undoable, for how long, and where we accept a one-way
door.

## How much the person is asked to hold in their head

_To write._ The rule for when information must be on screen versus remembered
from an earlier step.

## Density versus guidance

_To write._ This product's person is an expert. Where does that let us skip
explanation, and where does expertise make a mistake *more* expensive rather
than less?

## Accessibility floor

_To write._ The minimum every flow meets — keyboard, screen reader, small window,
slow machine — as a checkable bar rather than an aspiration.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created; first three seeded from observed behaviour | The docs tree was created |
