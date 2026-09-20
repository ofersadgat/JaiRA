---
id: engineering/units/scripted-doubles
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/try-a-process-without-spending, product/run-headless-and-in-ci, ux/patterns/unattended-run-never-waits-silently]
layer: core
owns_contracts: [engineering/contracts/fake-rules-format, engineering/contracts/interactions-script-format]
requires: []
implemented_by: [packages/runtime/src/fakeExecutor.ts, packages/runtime/src/scriptedFunctions.ts]
verified_by: [packages/cli/test/run.test.ts, packages/cli/test/task.e2e.test.ts, packages/runtime/test/promptMemo.test.ts, packages/runtime/test/changesetGate.test.ts]
siblings: [engineering/units/engine-wiring, engineering/units/interaction-hub, engineering/units/interaction-gateway, engineering/units/cli]
---

# Scripted doubles

## The doubles answer prompts and gates from scripts, and decide nothing about where those scripts come from

`ScriptedFakeExecutor` in `fakeExecutor.ts` is a prompt executor that answers each prompt op from the first matching rule of a [fake-rules-format](../contracts/fake-rules-format.md) array, and `parseFakeRules` refuses a malformed array. `ScriptedFunctions` in `scriptedFunctions.ts` registers one interactive host function per key of an [interactions-script-format](../contracts/interactions-script-format.md) object, each returning the next answer from its queue; `registerWildcard` registers a function under the `"*"` queue, and `parseInteractionScript` refuses a malformed object.

It deliberately does not own:

- Where the fake replaces the prompt half and what still wraps it: `buildPromptExecutor` in [engine-wiring](engine-wiring.md).
- Gates a person answers, and re-validating their answers: [interaction-hub](interaction-hub.md) and [interaction-gateway](interaction-gateway.md).
- Reading `--fake` and `--interactions` and registration order in the CLI: [cli](cli.md). Registration order in the app belongs to `startRun` in `service.ts`.
- Delegated agents reached as function ops, which run for real under a fake: [agent-executors](agent-executors.md).

## The doubles sit in the core layer behind the engine's two injection points, and call nothing of JaiRA's but the refusal helper

- Layer `core`, package `@jaira/runtime`. They import `refusal` from `@jaira/shared` and nothing else of JaiRA's.
- Upstream seams: the `Executor` interface of `@declarative-ai/exec`, which reaches the engine as `WorkflowRunConfig.prompt`, and `hostFunction` entries in `CapabilityRegistry.functions`, which the engine dispatches function ops through. Metrics use `emptyWorkflowMetrics` and `mergeWorkflowMetrics` from `@declarative-ai/hw`; a failed call is `failureOf` from `@declarative-ai/exec`.
- Boundary: renderer and main. A scripted gate answer is a registered function's return value and never crosses the interaction hub.
- Callers: CLI `runWiringOf` and `buildRunEnvironment`; app `startRun`, `sendChatMessage` and `askFollowUp`, which reads the task's rules for a follow-up round.

## The scripts live only in memory, for as long as the run that was given them

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| The rule array | read on every prompt | the request that started the run: the CLI flag or the IPC `fake` field | the app keeps it per task in `ProjectSession.fakeRules` until the run ends; `askFollowUp`, the fan-out host's `startTask` and `releaseDependents` pass it on |
| The answer queues | one answer removed per call | the caller's object in the app; a copy made by `parseInteractionScript` in the CLI | none |
| `ScriptedFakeExecutor.calls`, `ScriptedFunctions.calls` | appended per call | in memory | tests read them |

## The invariants keep a scripted run answering in order and failing by name

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A prompt is answered by the first rule in array order whose present fields match, so a narrower rule listed before a broader one wins | `run.test.ts` "runs the SPEC §9 planning workflow end-to-end with a fake executor (subprocess)" |
| 2 | A matched `error` rule fails its state with exactly that reason, and the reason reaches the run's causes | `task.e2e.test.ts` "reports the root cause of a failure, not just the parent's summary" |
| 3 | A prompt no rule matches never produces a value | `promptMemo.test.ts` `"would fail without the cache — the control for the test above"` |
| 4 | A scripted gate answer becomes the gate function's value and the run completes on it | `run.test.ts` `"routes a blocked critique through a scripted interactive function"`; `task.e2e.test.ts` "interactive path: scripted interactions recorded through to completion" |
| 5 | Successive calls of one function take successive answers from its queue | `changesetGate.test.ts` `"carries the revised changeset into round two — the model answered, the gate re-reviews, apply writes it"` |
| 6 | In the CLI a gate function with no queue is unregistered and fails its state by name rather than waiting | `run.test.ts` "fails the state when an interactive function is reached unregistered" |
| 7 | `promptIncludes` never matches text inside the `</conversation-history>` preamble | unasserted |
| 8 | An empty or missing queue returns a failure as data and never throws into the engine | unasserted |
| 9 | `registerWildcard` never replaces a function already registered | unasserted |
| 10 | A matched `output` records a user and an assistant message, so a scripted run's conversations are not empty | unasserted |

## Every failure is the state's own, except a malformed rule array the app reads too late

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| No rule matches a prompt | permanent failure `no fake rule matched model '<m>', prompt '<first 80 characters>'` | add a rule | the state fails with that reason |
| A function's queue runs out | failure as data `scripted responses for '<name>' exhausted` | add answers | the state fails with that reason |
| The app receives a `fake` value that is not a valid rule array | `parseFakeRules` throws after `beginTaskRun` marked the task running, the task was added to `live` and the job claim was taken; nothing undoes them | quit the app; the next open recovers the task as interrupted | the start is refused and the task reads running |
| The app receives an `interactions` object with a `"*"` queue | every unscripted gate is registered with the hub first, so `"*"` answers nothing | name each function in the script | the run waits on you |
| A scripted task is resumed or re-run without its script | the rules and queues were never stored, so prompts go to the real executor tree and gates to a person | pass the script again with the resume | the run calls real models or waits on you |
| A schema-invalid `output` is repaired | the repair loop asks the same rules again and gets the same answer | fix the rule's `output` | the state fails after the repair turns |
| A CLI script file is read while it is being written | the text is parsed whole, and a truncated file is refused as invalid JSON | rerun | the command refuses before running |
| Two calls take from one queue at once | cannot occur: calls run on one thread and each `shift` is atomic | none needed | none |
| Two runs are given one in-process `interactions` object | both shift the same arrays, so an answer one run takes is gone for the other | give each run its own object | a later gate fails as exhausted |

## Scripted gate answers bypass the one path the architecture allows a human answer

- A scripted answer is a registered function's value, not a submission through the interaction hub, so it skips re-validation in the main process and `validateComponentResult`, because no person gives it and the script's author owns its shape.
