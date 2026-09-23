---
id: engineering/units/cli
type: engineering-unit
status: shipped
updated: 2026-09-22
implements: [product/run-headless-and-in-ci, product/try-a-process-without-spending, ux/patterns/unattended-run-never-waits-silently, ux/patterns/consent-to-exactly-what-was-shown]
layer: cli
owns_contracts: [engineering/contracts/jaira-cli]
requires: [engineering/units/project-store, engineering/units/task-lifecycle, engineering/units/run-load, engineering/units/process-claims, engineering/units/engine-wiring, engineering/units/module-approvals, engineering/units/scripted-doubles, engineering/units/agent-executors, engineering/units/host-tools, engineering/units/tool-policy, engineering/units/artifact-placement, engineering/units/changesets, engineering/units/board-projection, engineering/units/workflow-browser, engineering/units/description-sync, engineering/units/history-pruning, engineering/units/task-worktrees, engineering/units/operation-record-store]
implemented_by: [packages/cli/bin/jaira.js, packages/cli/src/main.ts, packages/cli/src/cli.ts, packages/cli/src/changesetReviewer.ts, packages/cli/src/commandApprover.ts, packages/cli/src/index.ts, packages/cli/build.mjs]
verified_by: [packages/cli/test/commandApproval.test.ts, packages/cli/test/run.test.ts, packages/cli/test/task.e2e.test.ts, packages/cli/test/jobs.e2e.test.ts, packages/cli/test/logSink.test.ts, packages/cli/test/home.test.ts, packages/cli/test/moduleApproval.test.ts, packages/cli/test/prune.test.ts, packages/cli/test/workflow.test.ts, packages/cli/test/workflowCheck.test.ts, packages/cli/test/changesetReview.test.ts, packages/cli/test/changesetReviewer.test.ts, packages/cli/test/genericAgent.e2e.test.ts, packages/cli/test/board.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/project-sessions, engineering/units/ipc-bridge]
---

# CLI

## The CLI turns a command line into calls on persistence and the runtime, and owns only dispatch, the durable run loop and the terminal prompts

`packages/cli` builds the `jaira` binary:

- `bin/jaira.js` enables source maps, then dynamically imports the bundled `dist/cli.mjs` and sets `process.exitCode` from `main`. The `jaira` wrapper package imports this file too.
- `main` in `main.ts` wires SIGINT to an `AbortSignal` and passes a y/N `confirm` and a line reader `ask` only when stdin and stdout are both TTYs. For `confirm`, anything but `y` or `yes`, end of input included, is no. `ask` writes its question to stderr, because stdout is the run's one JSON report, and answers `undefined` at end of input or when its signal aborts.
- `runCli(argv, io)` in `cli.ts` installs a silent library log sink, or a stderr sink when `JAIRA_LOG` is set; lifts `--home` into `JAIRA_HOME` for the dispatch and restores it after; dispatches; maps `UsageError` to usage and exit 2 and any other throw to `error: <message>` and exit 1. Its `finally` calls `resetUserModules()` and closes the MCP bridge host.
- `openWithRecoveryNote` is the one project open every project command uses. It builds the process's js/ts module pair with `prepareUserModules` and prints the recovered tasks and orphaned processes the open found.
- `runTaskNow` drives one durable run for `task start` and for `run` without `--workflows`.
- `buildRunEnvironment` assembles the registry and prompt executor the same way the app does, with no availability probes, and folds the executor's scope floor over every prompt call as `securityFloorOf` compiles it.
- `commandApprover.ts` answers a run's approvals ([tool-policy](tool-policy.md)). `governRun(config, approvals, where)` is the run's `policy` and `approve`: `compileRunPolicy`, the recipe the app's `startRun` uses, with `command_log` rows through `policyAuditRow` where the run has a task, and the approver of an `ApprovalHub`. `cliApprovals` builds that hub: in `ask` mode it puts one request at a time to the terminal, drawn by `renderApproval` as the line with its parts numbered, the matched words marked and one row per part, and `choicesFor` offers once, for this run at the asking parts' narrowest and widest widths, or deny; in `deny` mode it refuses each request with `unattendedRefusal`, which names why nobody was asked and, per asking part, the `policy.rules` entry, toolset line or `policy.tools` entry that would answer it, and hands that reason to `ApprovalHub.decide` so `run_command`'s failure carries it. `commandApprovalsOf` in `cli.ts` picks the mode from `--approve`, `--non-interactive` and whether `io.ask` exists, and `approvalGateOf` refuses `--approve ask` without a terminal as a usage error before anything is made. `where.functions` is what decides a toolset line that names a FUNCTION ([0007](../decisions/0007-toolsets.md), amended 2026-09-22): `runPermissionFunctions` in `cli.ts` registers `smart` and the approval prompt on the run's registry and loads a function along the run's own path and module approvals, each answer audited into `command_log`; `CliApprovals.prompt` is the approval prompt, asked at the terminal in the approvals' queue (`renderApprovalPrompt`, `[y] allow  [n] deny`) or failed with nobody to ask.
- `runTaskNow` calls `grantAlwaysGrantedTools` on the pinned bundle before the run, as the app's `startRun` does, and shuts the approval gate when the run is stopped.
- `reviewChangesetOnTerminal` and `registerCliChangesetReviewer` in `changesetReviewer.ts` answer `review_artifacts` one change at a time at the terminal, re-checking the answer with `checkDecisions`.

The commands, flags, output and exit codes are [jaira-cli](../contracts/jaira-cli.md).

It deliberately does not own:

- Opening, recovering and closing a project: [project-store](project-store.md). Creating, starting, finishing and cancelling a task: [task-lifecycle](task-lifecycle.md). Building the resume load and releasing failed records: [run-load](run-load.md).
- The run claim, heartbeat and cross-process cancel flag: [process-claims](process-claims.md).
- Approving, freezing and compiling workflow modules: [module-approvals](module-approvals.md).
- Running the machine: [engine-wiring](engine-wiring.md) over upstream `@declarative-ai/hw`.
- The board, the workflow browser, pruning, worktrees and the conformance check it prints: [board-projection](board-projection.md), [workflow-browser](workflow-browser.md), [history-pruning](history-pruning.md), [task-worktrees](task-worktrees.md), [description-sync](description-sync.md).
- Validating a changeset decision set: [changesets](changesets.md).

## The CLI is its own layer beside the app, bundles every JaiRA package into one file, and answers approvals at the terminal or not at all

- Layer `cli`. It imports `@jaira/persistence`, `@jaira/runtime` and `@jaira/shared`, and upstream `@declarative-ai/hw` for `loadBundle`, `validateBundle` and `moduleHash`. `index.ts` re-exports `@jaira/runtime` so older importers of `@jaira/cli` keep working.
- `build.mjs` bundles the workspaces and declarative-ai into `dist/cli.mjs` and emits `dist/mcpBridgeWorker.mjs` beside it. Exactly the packages in `dependencies` stay external, `better-sqlite3` and `typescript` among them.
- Boundary: workflow and run. Every durable start goes through `beginTaskRun`, which pins the snapshot.
- Boundary: renderer and main does not apply. A gate is answered by `--interactions`, by the terminal reviewer, or not at all. A command or tool approval is answered at the terminal or refused. `gateCapabilities` runs with `unattended` true when nobody chose the refusals — no terminal, or `--non-interactive` — so there a policy that can escalate refuses a state whose agent asks through a callback; at a terminal, or under `--approve deny`, it does not.
- The CLI passes neither `fanOut` nor `split` to `executeWorkflow`, so a hosted fan-out mount fails with the engine's reason: see [fan-out-host](fan-out-host.md).

## The CLI holds only process-scoped state, and every durable fact it touches belongs to another unit

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `process.env.JAIRA_HOME` | set from `--home` for one dispatch, restored in `finally` | the environment | every lazy base-root lookup in shared and persistence |
| The library log sink | installed at the start of every `runCli` | this process | `@declarative-ai/log` callers |
| The js/ts module pair | built once per process by `prepareUserModules`, rebuilt after an approval, reset in `finally` | this process; approvals live in the base root's database | [module-approvals](module-approvals.md) |
| The MCP bridge host | started by the first agent run, closed in `finally` | this process | agent executors |
| A run's `ApprovalHub` and its `CommandGrants` | built per run by `commandApprovalsOf`; "for this run" answers live in it | this process, for one run | the policy reads the grants; nothing else |
| `command_log` rows | written by the run's policy through `policyAuditRow` | the project database | [tool-policy](tool-policy.md), history-pruning |
| The run claim | taken by `RunOwner` after `beginTaskRun`, released in `finally` | the `jobs` table | [process-claims](process-claims.md); the app's cancel |
| Task row status, journal, records, snapshot, artifacts | written through `beginTaskRun`, the recorder, the task's session store, `persistEngineArtifacts` and `finishTaskRun` | the project database and `.jaira/system/` | the app, through the same units |

## The invariants keep a headless command from hanging, guessing or taking over another process's task

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A missing required flag or an unknown command or subcommand exits 2 with usage | `run.test.ts` "reports usage errors distinctly"; `workflow.test.ts` "reports an unknown subcommand as a usage error" |
| 2 | A durable start records a pinned snapshot, the journal and the task row, and ends `completed` with exit 0 | `task.e2e.test.ts` "create → start → completed, with snapshot and EngineEvent journal" |
| 3 | A task left `running` by a dead process reads `interrupted` at the next open, and starting it again runs against the same pinned snapshot | `task.e2e.test.ts` "crash recovery: a running task is marked interrupted and re-runs from the pinned snapshot" |
| 4 | A failed run reports the operation-level causes from the journal, and a failed or cancelled task can be started again | `task.e2e.test.ts` "reports the root cause of a failure, not just the parent's summary", "failed runs record the failure and allow retry", "cancel settles the run, and the task can be started again" |
| 5 | A task another live process claims is refused, and cancelling it raises the flag instead of writing a status | `jobs.e2e.test.ts` "is refused rather than taking the task over", "requests a cancel instead of writing a terminal status" |
| 6 | A run's claim is released however the run ends | `jobs.e2e.test.ts` "records a run job and releases it when the run ends", "releases the claim even when the run fails" |
| 7 | An interactive function nothing answers fails its state, and an invalid workflow is refused before anything runs | `run.test.ts` "fails the state when an interactive function is reached unregistered", "rejects an invalid workflow before executing anything" |
| 8 | Unapproved modules are never run without a yes: refused with the approve command when nobody can answer or under `--non-interactive`, asked with the source on a TTY, approved by name under `--approve-functions` | `moduleApproval.test.ts` "refuses and prints the command that answers it", "refuses on --non-interactive even with a terminal attached", "shows the source and does not run when the answer is no", "approves and starts when the answer is yes", "approves without asking, and says which files it approved" |
| 9 | A library refusal is printed once, without module scopes, unless `JAIRA_LOG` is set | `logSink.test.ts` "says it ONCE, in the CLI's own words", "hands the library stream back when asked for it" |
| 10 | `--home` works anywhere on the line and leaves the environment as it found it | `home.test.ts` "reads and writes the root it was given, not the default one", "is a loan: the environment is exactly as it was afterwards", "is a global flag: it works before a subcommand and between its arguments" |
| 11 | A policy that can escalate refuses the run before any state executes | `genericAgent.e2e.test.ts` "refuses the run when the project's policy can escalate (DESIGN §8.2)" |
| 12 | `changeset review` with no terminal and no script refuses before any work, and the terminal reviewer re-asks on a key outside the five decisions | `changesetReview.test.ts` "refuses headless with nothing to answer the gate, before any work"; `changesetReviewer.test.ts` "re-asks on an answer outside the five decisions rather than guessing" |
| 13 | A capability refusal after `beginTaskRun` closes the task `failed` rather than leaving it `running` | unasserted |
| 14 | A run started by `jaira` is held to the project's policy and audited into `command_log`: a line the policy asks about is asked at a terminal, runs on a yes, is refused on a no, and "for this run" remembers its parts | `commandApproval.test.ts` "ASKS, showing the line taken apart into its parts — and a yes runs it", "REFUSES on a no, and the state fails saying the command was refused", "remembers an answer FOR THIS RUN by its parts: the second state's line is not asked about", "audits every decision into command_log, as an app run does" |
| 15 | With nobody to ask, an `ask` is refused and never waited on, and the refusal names why and the setting that would allow it; `--approve deny` never asks; `--approve ask` with no terminal is a usage error before anything is made | `commandApproval.test.ts` "REFUSES, naming what would let the line run — the terminal, or the setting that asked", "refuses a BUILT-IN ask with the policy rule that would answer it, and runs nothing", "never asks under --approve deny", "refuses --approve ask with no terminal as a usage error, before anything is made" |
| 16 | A toolset hands claude and codex the same in a CLI run as in an app run | `commandApproval.test.ts` "claude is handed the same under %s", "codex is handed the same under %s, by a route and as a function" |

## Every failure ends the process with a verdict, and a killed run is recovered by the next open

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two processes start one task | the second finds a live run claim and throws `task '<id>' is already running in another process` | wait, or `task cancel` | exit 1 |
| The process is killed mid-run | the claim goes stale and the row stays `running`; the journal and records hold what finished | the next project open marks it `interrupted`; `task start` loads it and continues | `recovered N interrupted task(s)` on stderr |
| A start throws after `beginTaskRun` and before `executeWorkflow` for a reason other than the capability gate, such as compiling a module | the claim is released and the row stays `running` | the next open marks it `interrupted` | exit 1, then the recovery note |
| A resume finds operations with no readable record | refused with `cannot be resumed: N operation(s) have no readable record`, before anything runs | re-run as a new task | exit 1 |
| A retried start meets a failed call | `releaseUnconsumedFailures` deletes a failed record that consumed no provider sequence, so the continuing run makes that call fresh and does not duplicate it | none needed | none |
| `task start` on a `completed` task | failed records and revived failure events are released before `beginTaskRun` refuses the status | none | exit 1, and the task's history lost those failures |
| `run` without `--workflows` is repeated | each invocation creates a new `run · <root>` task labelled `adhoc` | delete the extra tasks | one task per invocation |
| SIGINT during a run | the engine aborts, the task finishes `canceled` | `task start` continues it | exit 1 |
| A gate is reached headless with no `--interactions` | the reviewer is not registered and the state fails | script it, or attach a TTY | exit 1 with a failed report |
| A run meets an `ask` with nobody to answer | the approver refuses at once with a reason naming why nobody was asked and what to write; an agent is told no and goes on, `run_command` fails its state with that reason | answer at a terminal, or write the rule or toolset line named | `refused: …` on stderr; exit 1 if the state fails |
| Two things ask at the terminal at once — parallel states, or an approval beside the changeset reviewer or a publish question | approvals queue behind each other; the reviewer and the publish question read the same stdin on their own, so a line typed may answer whichever is reading | answer one prompt at a time | prompts interleave on stderr and stdout |
| SIGINT while an approval is on screen | the gate is shut, the parked request and every later one is denied, and the prompt returns | none | the run winds down `canceled` |
| An unknown `--flag`, a stray positional or a string flag with no value | `parseArgs` throws a `TypeError`, not a `UsageError` | fix the command line | exit 1, no usage |

## The CLI departs from the app in three deliberate ways

- It is silent about library log records by default, because every refusal already reaches the person once as `error:`.
- The module pair is per process rather than per project, so a command that opens two projects shares one compiler and one approvals store.
- `run --workflows <dir>` executes in memory with nothing recorded, because a bare directory of states has no `.jaira/` to record into.
