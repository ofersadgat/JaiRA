---
id: ui/principles
type: standing
status: proposed
updated: 2026-08-04
---

# UI principles

How we decide what a screen looks like. Distinct from
[direction.md](direction.md), which is the visual language itself — principles
are the reasoning, direction is the vocabulary.

Phase 3 of [WORKFLOW.md](../../WORKFLOW.md) reads both before drawing anything.

> **Needs your answers.** Two are seeded from what the app already does. The rest
> are judgment calls that belong to you; a UI principles file written by
> inference will be ignored the first time it is inconvenient.

## Every state is designed, not just the populated one

Empty, loading, partial, error, denied — each gets a rendering and a mockup, and
the empty state is where a component's real quality shows. A design reviewed only
in its happy state has not been reviewed.

Rejects: a component doc whose States table has one row.

## An error says what happened and what to do next

Both halves. "Failed to open database" is half a message; the version that names
the command that fixes it is the whole one — the CLI already works this way, and
the UI should not be worse.

## Information hierarchy

_To write._ How we decide what reads first on a surface, and what we do when two
things both claim primacy.

## Density

_To write._ This is an expert tool with a lot of state — runs, events, trees.
Where do we spend space, and where do we compress?

## Motion

_To write._ What motion is allowed to mean. Anything that isn't communicating a
state change is decoration; is decoration allowed here?

## Reuse versus fit

_To write._ How close a component has to be before extending it beats writing a
new one — the rule that phase 3's Goal 3 applies.

## Consistency with the CLI

_To write._ The same operations exist in both surfaces. Where should they look
like siblings, and where is the terminal's shape genuinely different?

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created; two seeded from observed behaviour | The docs tree was created |
