# Engineering

Standing docs for this area:

| Doc | Governs |
| --- | --- |
| [architecture.md](architecture.md) | The layers, the boundaries, how data moves. A unit names its layer and may depend downward only. |
| [principles.md](principles.md) | The values, and how tradeoffs get resolved when two pull apart. |
| [standards.md](standards.md) | The concrete rules a reviewer can cite by name. |

Source: [WORKFLOW.md §4](../../WORKFLOW.md).

## Units

A module, store, service, or job. Template:
[_templates/engineering-unit.md](../_templates/engineering-unit.md).

| Unit | Layer | Responsibility | Implements | Status |
| --- | --- | --- | --- | --- |
| [conversation-lookup](units/conversation-lookup.md) | data | How a conversation is stored, and how a reader gets from a task id to the turns on screen | — | shipped |

## Contracts

APIs, schemas, events, formats, CLI surfaces. Check here before inventing one.
Template: [_templates/engineering-contract.md](../_templates/engineering-contract.md).

| Contract | Visibility | Owned by | Consumers | Status |
| --- | --- | --- | --- | --- |
| [gate-components](contracts/gate-components.md) | public | interaction-hub | Every gate state, the renderer, `--interactions` | proposed |

## Decisions

Numbered, immutable once accepted — a reversal is a new record superseding the
old one. An architecture amendment gets one. Template:
[_templates/decision.md](../_templates/decision.md).

| # | Decision | Status | Supersedes |
| --- | --- | --- | --- |
| [0001](decisions/0001-decision-brief-gates.md) — gates get a decision brief; confidence decides whether to ask | proposed | — |

## Exceptions to standards

| Unit | Rule | Why |
| --- | --- | --- |
| _none yet_ | | |
