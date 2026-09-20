---
id: engineering/contracts/interactions-script-format
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/scripted-doubles]
consumers: ["@jaira/cli jaira run, jaira task start and jaira changeset review, through --interactions", "@jaira/app main service.ts startTask, rerunTask, resumeTask, rewindTask, forkTask, runSync, reviewChanges and reviewSyncChangeset", "tests and fixtures that answer gates headlessly"]
siblings: [engineering/contracts/fake-rules-format, engineering/contracts/gate-components, engineering/contracts/inbox-channels, engineering/contracts/jaira-cli]
---

# Interactions script format

A JSON object of answer queues, keyed by registered function name, that `ScriptedFunctions` registers as interactive host functions so a run's gates answer themselves.

## A caller scripts gates by function name, and never by state id

**Use when.** A run reaches gates that no person will answer: a headless test, a demo, `jaira run` or `jaira task start` in CI, or `jaira changeset review` with no terminal attached. A gate is an ordinary function op, so its answer is keyed by the function its state names, such as `choose_option`, not by the state.

**Do not use when.** Scripting prompt states: use [fake-rules-format](fake-rules-format.md). Answering a gate a person sees: the answer goes through [inbox-channels](inbox-channels.md) and is re-validated there. What each gate component returns is [gate-components](gate-components.md), and a scripted answer must already be in that shape.

## The shape is one FIFO queue per function name, with an optional shared queue

The CLI reads `--interactions <json|@file>` through `parseJsonText`, which strips a byte-order mark, then `parseInteractionScript`. The IPC field `interactions`, typed `Record<string, JsonValue[]>`, carries the same object on `task:start`, `task:rerun`, `task:resume`, `task:rewind`, `task:fork`, `workflow:sync`, `changeset:review` and `changeset:reviewSync`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `<functionName>` | JSON value array | no | the answers that function returns, one per call, first answer first; the key is registered as an interactive host function |
| `"*"` | JSON value array | no | one queue shared by every function `registerWildcard` registers, which answers a bundle function that has no queue of its own |

Each registered entry has capabilities `interactive: true`, `readOnly: true`, `memoizable: false`. A call takes the next answer off its function's queue, or off `"*"` when the function has none, and returns it as the function's value.

## Malformed scripts are refused only by the CLI, and an empty queue fails the state

| Condition | Response | Caller does |
| --- | --- | --- |
| The CLI text is not JSON | `--interactions: invalid JSON: <parser message>` | fix the file |
| The CLI value is not an object | refusal `interaction script must be a JSON object of functionName → response array` | pass an object |
| A CLI value under a name is not an array | refusal `interaction script for '<name>' must be an array of responses` | make it an array |
| A function's queue is empty | the call returns a failure as data, `scripted responses for '<name>' exhausted`, and the state fails unless a transition handles it | add answers |
| A function's value is `null` and there is no `"*"` queue | the call returns a failure as data, `no scripted response for interactive function '<name>'` | give the name an array |
| The CLI meets a gate function with no queue and no `"*"` | the function is unregistered and the state fails naming it | script it, or run with a terminal attached |
| The app meets a gate function with no queue | the interaction hub registers it and the run parks for a person | answer it in the app |

## A change to the key or the queue rule breaks every stored script, and no deprecation path exists

- Renaming a gate component's function breaks every script keyed on the old name, silently in the app, where the renamed gate parks for a person instead.
- Changing the queue order or the `"*"` rule changes which answer each call receives.
- There is no version field and no deprecation path.

## What the script answers depends on which driver registers it and in what order

- A scripted answer is returned as the function's value directly. It never passes the interaction hub, so it gets no durable gate row, no inbox entry and no `validateComponentResult` check.
- The CLI registers the script after the host tools, the command function and the agent runtimes, so a script key with one of their names replaces it. `on_user_event`, the changeset functions and the workflow's own TypeScript functions register after the script and replace a key with their name. The terminal changeset reviewer registers only when nothing registered `review_artifacts`, so a script for it wins.
- The app registers the script before everything else, so the agent runtimes, the host tools, the command function, the changeset functions, `on_user_event` and the workflow's own functions each replace a key with their name.
- In the app the `"*"` queue never answers: every bundle function with no entry is registered with the interaction hub before `registerWildcard` checks for an entry. In the CLI `"*"` answers every bundle function nothing registered before it.
- The app does not parse or validate `interactions`. The object reaches `ScriptedFunctions` as sent, and each call's `shift` removes the answer from the caller's own array. The CLI queues are copies.
- Tasks a fan-out makes and dependents a completed task releases do not inherit the script, so their gates park for a person in the app.
