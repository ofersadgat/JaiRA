---
id: product/principles
type: standing
status: proposed
updated: 2026-08-04
---

# Product principles

Who we serve, what we optimize for, and what we refuse to do. Phase 1 of
[WORKFLOW.md](../../WORKFLOW.md) reads this before framing a feature, and amends
it when the answer changes.

This file settles the arguments that would otherwise be re-run per feature: when
two audiences want opposite things, when a feature is good but not ours, when
"users asked for it" isn't sufficient.

> **Needs your answers.** Only the first section is filled in, and only with what
> the product visibly already does. The rest are the questions worth answering
> once, in your words — a principles file written by inference is a file nobody
> feels bound by.

## Who we serve

The primary person is a **developer orchestrating coding agents**: someone who
wants a run to be reproducible, interruptible, and reviewable, and who is willing
to trade convenience for not losing work.

Two things follow from that, and both are visible in the product today:

- **The human stays in the loop by construction, not by discipline.** A run parks
  at a gate and the answer is validated at the trust boundary. "The agent did
  something I didn't approve" is a class of failure the design removes rather
  than warns about.
- **Nothing is written on the user's behalf without their edit.** `workflow
  check` produces unsaved edits, not saved files.

Secondary audiences — and what we owe each of them differently — _to write_.

## What we optimize for

_To write._ When speed, safety, and surface area conflict, which wins, and what
evidence moves the answer.

## What we refuse to do

_To write._ The features that would be popular and are still wrong for this
product. This list is the most useful thing in the file — it is what stops the
same proposal arriving every quarter.

## When a feature is good but not ours

_To write._ The test for whether something belongs in JaiRA versus in
declarative-ai versus in the user's own workflow files.

## How we treat "users asked for it"

_To write._ What counts as evidence, and how much of it changes an importance.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created; "who we serve" seeded from observed behaviour | The docs tree was created |
