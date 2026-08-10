---
id: ux/flows/<flow-name>
type: ux-flow
status: proposed
updated: YYYY-MM-DD
satisfies: [product/<feature-name>]
actor: "<which person from the product spec>"
trigger: "<what happened just before step 1>"
patterns: [ux/patterns/<pattern-name>]
siblings: [ux/flows/<adjacent-flow>]
---

# <Flow name>

Who, from what trigger, to what value — one paragraph.

## Where this fits

- **Serves** — the product feature, and which part of its story this path covers.
- **Neighbors** — the adjacent flows, and why this is not one of them.
- **Depends on / used by** — patterns used; flows that hand off to this one.
- **History** — what path this replaces.

## Steps

| # | Actor does | System does | Actor knows |
| --- | --- | --- | --- |
| 1 | | | |

`Actor knows` is what is true on their screen at that moment. If a step needs
knowledge from three steps back, that is a finding, not a step.

## States

| State | Actor sees | Can do next |
| --- | --- | --- |
| first_run | | |
| empty | | |
| loading | | |
| partial | | |
| error | | |
| denied | | |
| success | | |

Omit a state only by asserting here that it cannot occur.

## Reversibility

What undoes this and for how long. What is lost on abandonment mid-flow.

## Success signal

How the actor knows they got the value — the observable behind the feature's
metrics.

## Accessibility

Keyboard-only, screen reader, small window, slow machine. For this flow
specifically, not as a blanket promise.
