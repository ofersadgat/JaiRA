---
id: engineering/contracts/fake-rules-format
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/scripted-doubles]
consumers: ["@jaira/cli jaira run and jaira task start, through --fake", "@jaira/app main service.ts startTask, rerunTask, resumeTask, rewindTask, forkTask, runSync, reviewChanges, reviewSyncChangeset and sendChatMessage", "the renderer's Debug view scripted self-test, selfTestScript in debugWorkflow.ts", "tests and fixtures such as happyRules and blockedRules"]
siblings: [engineering/contracts/interactions-script-format, engineering/contracts/jaira-cli, engineering/contracts/task-channels]
---

# Fake rules format

A JSON array of rules that `ScriptedFakeExecutor` answers every prompt operation of a run from, so a workflow runs with no model provider.

## A caller scripts prompts with fake rules, and scripts nothing else

**Use when.** A run's prompt states must be answered without a provider: a headless test, a demo, a screenshot fixture, the Debug view's scripted self-test, or a CI run of `jaira run --fake` or `jaira task start --fake`. A prompt state routed to an agent by a model prefix such as `claude-cli/sonnet` is a prompt op, and the rules answer it too.

**Do not use when.** Scripting a gate, which is a registered function: use [interactions-script-format](interactions-script-format.md). Scripting a delegated agent reached as a function op, such as `function: "claude-cli"`: the rules do not reach it, and it runs the real binary.

## The shape is an ordered array of rules, each matching on a model and a prompt fragment

The CLI reads `--fake <json|@file>` through `parseJsonText`, which strips a byte-order mark. The IPC field `fake` carries the same array as JSON on `task:start`, `task:rerun`, `task:resume`, `task:rewind`, `task:fork`, `workflow:sync`, `changeset:review` and `changeset:reviewSync`. `sendChatMessage` accepts it in process; the `chat:send` channel type has no such field.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `model` | string | no | matches when equal to the op's `config.model`, compared as a string; an op with no string model compares as `""` |
| `promptIncludes` | string | no | matches when the prompt tail contains it; the tail is `op.user` after the last `</conversation-history>`, trimmed, and the system prompt is never searched |
| `output` | any JSON value | exactly one of `output` and `error` | the op's value on a match; `null` counts as present |
| `error` | string | exactly one of `output` and `error` | fails the op permanently with this reason on a match |
| `cost` | number | no | the `costUsd` reported for a matched `output`; default `0.01` |

A prompt is answered by the first rule in array order whose present fields all match. A rule with neither `model` nor `promptIncludes` matches every prompt.

A matched `output` answers with:

| Field | Value |
| --- | --- |
| `value` | the rule's `output` |
| `metrics` | `durationMs: 1`, `costUsd: cost ?? 0.01`, `costSource: "table"` |
| `session.messages` | a `user` message holding `op.user`, then an `assistant` message holding `output`, run through `JSON.stringify` unless it is a string |

The executor declares `structuredOutput: true`, `memoizable: true`, `policyEnforcement: "none"`, `sessionResume: false`, `streaming: false`, and emits no stream events.

## Every malformed script is refused before the run, and every unmatched prompt fails its state

| Condition | Response | Caller does |
| --- | --- | --- |
| The CLI text is not JSON | `--fake: invalid JSON: <parser message>` | fix the file |
| The value is not an array | refusal `fake script must be a JSON array of rules` | pass an array |
| An entry is not an object | refusal `fake rule <i> must be an object` | fix entry `i` |
| An entry has both or neither of `output` and `error` | refusal `fake rule <i> must have exactly one of 'output' or 'error'` | fix entry `i` |
| No rule matches a prompt | permanent failure `no fake rule matched model '<model>', prompt '<first 80 characters of the tail>'` | add a rule that matches |
| The matched rule has `error` | permanent failure with that reason, `costUsd: 0`, `costSource: "unknown"` | none; this is the scripted outcome |
| The run's abort signal has fired | `canceled` failure with reason `aborted` | none |

## A change to the rule shape breaks every scripted test and fixture, and no deprecation path exists

- Renaming or retyping a field breaks every stored `--fake` file, `happyRules`, `blockedRules`, `selfTestScript` and each test that builds rules inline.
- Changing first-match order or the tail rule changes which rule answers in every existing script, with no error.
- There is no version field and no deprecation path.

## Rules match literal text, so they stop matching silently when a workflow changes

- Field types are not checked after the `output` and `error` test. A `model` that is not a string never matches.
- Under a fake run no executor tree applies. `model` is compared with the id exactly as the state wrote it, with no route prefix written in, and router `defaults` never supply a model, so a state naming none matches only rules whose `model` is absent or `""`.
- A rule keyed on a sentence of a prompt stops matching when the prompt is reworded, and the run fails only when it reaches that state.
- A prompt that itself quotes `</conversation-history>` shortens the tail that `promptIncludes` searches.
- A schema-invalid `output` is sent through the repair loop, which asks the same rules again, so it fails after `DEFAULT_REPAIR_TURNS` more identical answers unless the CLI set `--repair-turns`.
- A `choose_option` follow-up round asks the task's rules with a prompt op that names no model.
- Tasks a fan-out makes and dependents a completed task releases inherit the rules. They do not inherit an interactions script.
- No memo store is wired under a fake run, in the app or the CLI, so a scripted run never reads or writes cached answers.
- In the app, `fake` is parsed after `beginTaskRun` has marked the task running and after the run's job claim is taken. A malformed value refuses the start and leaves the task reading `running` in that process until the app quits.
