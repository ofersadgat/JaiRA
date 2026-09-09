---
id: engineering/units/<unit-name>
type: engineering-unit
status: proposed
updated: YYYY-MM-DD
implements: [ui/components/<name>, ux/patterns/<name>, product/<name>]
layer: data | core | service | api | ui | cli
owns_contracts: [engineering/contracts/<name>]
requires: [engineering/units/<other>]
implemented_by: []
verified_by: []
siblings: [engineering/units/<neighbouring-unit>]
---

# <Unit name>

## <What this unit owns, and what it deliberately does not>

## <Where it sits in the architecture, and what it may call>

## <The data it owns, and where the truth lives>

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| | | | |

## <The invariants, each phrased so a test can assert it>

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | | |

## <The failure modes, each with a recovery and the state the person sees>

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| | | | |

## <What is backward compatible, what migrates, and whether it rolls back>

## <Where this departs from the usual way the architecture does things, if it does>
