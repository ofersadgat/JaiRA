# Engineering

Standing docs:

| Doc | Governs |
| --- | --- |
| [architecture.md](architecture.md) | The layers, the boundaries, how data moves |
| [principles.md](principles.md) | The values, and how tradeoffs resolve |
| [standards.md](standards.md) | The rules a reviewer can cite |

## Units

Template: [_templates/engineering-unit.md](../_templates/engineering-unit.md).

| Unit | Layer | Responsibility | Implements | Status |
| --- | --- | --- | --- | --- |
| [conversation-lookup](units/conversation-lookup.md) | data | How a conversation is stored, and how a reader gets from a task id to the turns on screen | — | shipped |

## Contracts

Template: [_templates/engineering-contract.md](../_templates/engineering-contract.md).

| Contract | Visibility | Owned by | Consumers | Status |
| --- | --- | --- | --- | --- |
| [gate-components](contracts/gate-components.md) | public | interaction-hub | Every gate state, the renderer, the CLI reviewer, `--interactions` | proposed |

## Decisions

Written by hand when a choice departs from the usual way and the reason must outlive the doc it is about. Template: [_templates/decision.md](../_templates/decision.md).

| # | Decision | Status | Supersedes |
| --- | --- | --- | --- |
| [0001](decisions/0001-decision-brief-gates.md) — gates get a decision brief; confidence decides whether to ask | proposed | — |
| [0002](decisions/0002-one-gate-vocabulary.md) — one gate vocabulary; a review's decisions come from gestures | proposed | — |
