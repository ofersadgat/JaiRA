---
id: engineering/units/<unit-name>
type: engineering-unit
status: proposed
updated: YYYY-MM-DD
implements: [ui/components/<name>, ux/flows/<name>, product/<name>]
layer: data | core | service | api | ui | cli
owns_contracts: [engineering/contracts/<name>]
requires: [engineering/units/<other>]
decisions: [engineering/decisions/<NNNN>-<slug>]
verified_by: ["packages/…/foo.test.ts"]      # added in phase 6
exceptions: [{doc: engineering/standards, rule: "…", why: "…"}]
siblings: [engineering/units/<confusable>]
---

# <Unit name>

## Responsibility

What this owns, in one sentence — and what it deliberately does not.

## Where this fits

- **Position in the architecture** — the layer from
  [architecture.md](../architecture.md), which side of which boundary, and what
  it may and may not call. If it doesn't fit the map, say whether the map or the
  design is wrong.
- **Serves** — the UI, flow, and product ids above.
- **Neighbors** — the units nearest this one and the boundary between them. If
  this could have been a change to an existing unit, say why it isn't.
- **Depends on / used by** — upstream units; downstream consumers.
- **History** — what it replaces, and the decision record if there is one.

## Data

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| | | | |

## Invariants

Phrased so a test can assert them. Phase 6 consumes these verbatim and fills in
the test that defends each — when someone later changes an invariant, this table
is how they find what will break and why it was written that way.

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | | `packages/…/foo.test.ts` |

## Failure modes

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| | | | |

Every row needs a UX state. If one has none, either the flow or this spec is
incomplete.

## Budgets

Only where there is real risk of exceeding them, with numbers.

| Budget | Limit | Why this is at risk |
| --- | --- | --- |
| | | |

## Compatibility

What breaks. What migrates. Whether it can be rolled back after the migration
has run.

## Security and permissions

Who can do this, what they can see, and what is now reachable that wasn't.

## Out of scope

What this deliberately does not do, and which product deliverable that leaves
unmet.
