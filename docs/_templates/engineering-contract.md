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
siblings: [engineering/contracts/<confusable>]
---

# <Contract name>

What this is, in one sentence.

## Use when

When a caller should reach for this contract.

## Don't use when

When they shouldn't.

## Instead consider

| Situation | Use | Why |
| --- | --- | --- |
| | [engineering/contracts/…](…) | |

## Where this fits

- **Serves** — the unit that owns it and the deliverables behind it.
- **Neighbors** — nearby contracts and the line between them.
- **Depends on / used by** — the consumers above, named specifically if public.
- **History** — what version introduced it; what it supersedes.

## Shape

The signature, schema, route, or format. Exhaustive — this is reference
material, and the audience-facing copy in phase 7 points here.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| | | | |

## Errors

| Condition | Response | What the caller should do |
| --- | --- | --- |
| | | |

## Compatibility

What a change here breaks, and the deprecation path. For `visibility: public`,
this section is mandatory before any change lands.

## Traps

The things that fail silently, or work differently than the obvious reading
suggests.
