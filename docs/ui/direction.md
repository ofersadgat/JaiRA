---
id: ui/direction
type: standing
status: proposed
updated: 2026-08-04
---

# Visual direction

The vocabulary: theme, tone, density, motion, typography, colour. Where
[principles.md](principles.md) is how we decide, this is what we decided —
the shared language a component doc can point at instead of re-specifying.

Phase 3 of [WORKFLOW.md](../../WORKFLOW.md) checks a design against this; a
component that must break it records an `exceptions` entry or amends this file.

> **Needs filling in.** This is the one standing doc that cannot be inferred from
> code without looking at the running app, and guessing at it would be worse than
> leaving it open — every wrong value here propagates into every component doc.
> The headings are the questions worth answering. `npm run app`, or
> `JAIRA_CAPTURE=<file.png> npm run app` for a screenshot without a human at the
> keyboard, is the fastest way to write the first draft from what exists.

## The one-line description

_To write._ If someone described this product's look in a sentence to a designer
who had never seen it, what is the sentence? Everything below should be
recognisably downstream of it.

## Tone of voice

_To write._ How the product talks: in labels, in empty states, in errors. Terse
or explanatory. Whether it ever uses "we". What it never does — apologise,
exclaim, personify the agent.

This section is cited more often than any other, because every component doc has
a Copy table.

## Colour

_To write._ The roles, not the hex values — surface, raised surface, border,
text, muted text, accent, and the status colours (running, parked at a gate,
failed, cancelled). Where the values live in code, link to them here rather than
duplicating; a token list copied into a doc is stale within a month.

Also: what colour is *not* allowed to be the only carrier of.

## Typography

_To write._ The family, the scale, and which sizes exist. Monospace: where it is
required (ids, hashes, paths, event streams) and where it is affectation.

## Spacing and density

_To write._ The base unit and the scale. This product shows dense state — boards,
trees, event streams — so the interesting question is which surfaces are allowed
to be dense and which must stay calm.

## Elevation and borders

_To write._ How separation is expressed. Whether panels are bordered, shadowed,
or only differentiated by surface colour.

## Motion

_To write._ Durations, easing, and what is allowed to animate. Runs here take
minutes; the honest question is what motion communicates *progress* versus what
merely fills time.

## Iconography

_To write._ The set, the weight, whether icons ever appear without a label.

## Dark and light

_To write._ Whether both are supported, which is primary, and what is allowed to
differ beyond colour.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created as a scaffold | The docs tree was created |
