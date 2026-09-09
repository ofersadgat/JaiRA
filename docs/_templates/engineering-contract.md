---
id: engineering/contracts/<contract-name>
type: engineering-contract
status: proposed
updated: YYYY-MM-DD
visibility: public | internal
kind: api | schema | event | format | cli
owned_by: [engineering/units/<unit-name>]
consumers: ["<who calls this>"]
since: <version or date>
siblings: [engineering/contracts/<neighbouring-contract>]
---

# <Contract name>

<What this is, in one sentence.>

## <When a caller reaches for this contract, and when it does not>

**Use when.**

**Do not use when.**

## <The shape, exhaustively>

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| | | | |

## <The errors, and what the caller does about each>

| Condition | Response | Caller does |
| --- | --- | --- |
| | | |

## <What a change here breaks, and the deprecation path>

## <What fails silently or works differently than the obvious reading>
