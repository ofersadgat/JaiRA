---
id: engineering/units/tool-policy
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed, ux/patterns/consent-to-exactly-what-was-shown, ui/components/command-approval, ui/components/composer-setting-chip, ui/surfaces/settings-configuration]
layer: core
owns_contracts: []
requires: [engineering/units/process-exec]
implemented_by: [packages/runtime/src/policy.ts, packages/runtime/src/command.ts, packages/runtime/src/tools.ts, packages/shared/src/toolVocabulary.ts, packages/shared/src/scopes.ts, packages/shared/src/operationVocabulary.ts, packages/persistence/src/commandLog.ts, packages/app/src/main/service.ts]
verified_by: [packages/runtime/test/policy.test.ts, packages/runtime/test/command.test.ts, packages/runtime/test/agentToolPlan.test.ts, packages/runtime/test/scopeEnforcement.test.ts, packages/runtime/test/scopeLayers.test.ts, packages/runtime/test/scopeWalkAndCommand.test.ts, packages/runtime/test/tools.test.ts, packages/shared/test/toolVocabulary.test.ts, packages/shared/test/permissionPresets.test.ts, packages/shared/test/scopes.test.ts, packages/app/test/approvals.test.ts, packages/persistence/test/prune.test.ts]
siblings: [engineering/units/host-tools, engineering/units/interaction-hub, engineering/units/executor-tree, engineering/units/agent-executors]
---

# Tool policy

## The unit decides what a tool call may do and where, and leaves remembering and asking to others

- `command.ts`: `parseCommand(line, dialect)` turns a line into `ParsedCommand`s in the `posix` or `powershell` dialect. It splits on separators, unwraps shell wrappers such as `sh -c` and `powershell -Command`, unwraps prefix wrappers such as `env`, `sudo`, `npx` and `pnpm`, and skips the value a `-C` or `-c` flag takes, as in `git -C <dir>`. A line it cannot model comes back `unparsed` with a reason, and it never throws.
- `policy.ts`: `decideCommand(policy, line, dialect)` judges every command on a line, authored `rules` first with the first match winning, then the built-in denies for destructive git and `rm -r .git`, then the built-in asks for push, merge, network programs, publishing, installing, deploying and credential paths, and keeps the strictest verdict. `compilePolicy(policy, options)` turns `JairaPolicy` into upstream `ExecPolicy`: `bash`, `run_command` and six other command tool names get `smart` in the baseline, `show_artifact` and every tool authored `smart` get a size-judging approver, a path under `.jaira/` is denied, and `scopeOf` narrows each call by the executor floor and the calling state's `permissions.scopes`. `policyCanEscalate` says whether a person could ever be asked.
- `tools.ts`: `gateTools` wraps named registry tools and builds a `ToolGate` over one `PermissionLedger` for one conversation turn. `planAgentTools` splits a grant into tools to inject, native names to ask about and native names to deny. `grantAlwaysGrantedTools` adds `show_artifact` to every prompt state of a run's resolved bundle. `profileRules` turns `TOOL_PROFILES` into upstream profile tables. `scopeNarrowingFor` and `commandSubjects` build the per-call narrowing. `compileClaudeScopeRules` and `claudePermissionSettings` compile a scope table into Claude Code permission rules. `createRunCommandFunction` builds `run_command`, which gates itself.
- `toolVocabulary.ts`: `TOOL_SPECS`, the one table of logical tool names with category, `readOnly`, Claude native name, `pathArgs`, `urlArgs` and `alwaysGranted`, and the `read-only`, `plan` and `full` `TOOL_PROFILES` generated from `readOnly`.
- `scopes.ts`: glob matching and `resolveScope`, `resolveUrlScope`, `resolveScopes`, `scopeModeOf` and `layeredScopeMode`. The most specific glob that says anything about the tool decides, an unmatched place is denied, and a call about several places takes the strictest answer.
- `operationVocabulary.ts`: `PERMISSION_MODES`, `PERMISSION_PROFILES`, `PermissionsDecl`, `ToolImplementation`, and the composer's `PERMISSION_PRESETS` with `presetModes` and `presetOf`. The same file holds the operation field tables the authoring form and the operation schema read.
- `commandLog.ts`: `CommandLog.record`, `list` and `summary` over `command_log`. In `service.ts`, `startRun` passes `compilePolicy` an `onDecision` that writes one row per decision, and `scopeFloorOf` reads the floor.

It deliberately does not own:

- Resolving a mode through the ledger and profiles, and escalating: upstream `decideToolCall`, `PermissionLedger`, `withPermission` and `createToolGate` in `@declarative-ai/permissions`.
- Parking an approval for a person and attaching the policy's reason: [interaction-hub](interaction-hub.md). The inbox channels: [inbox-channels](../contracts/inbox-channels.md).
- The tools themselves: [host-tools](host-tools.md) and [host-tool-vocabulary](../contracts/host-tool-vocabulary.md).
- Parsing `policy` and executor `scopes`: [project-config](project-config.md), with the shapes in [settings-json](../contracts/settings-json.md). Folding the compiled floor over every prompt call: `withSecurityFloor` in [executor-tree](executor-tree.md).
- Deleting `command_log` rows: [history-pruning](history-pruning.md) and [task-lifecycle](task-lifecycle.md).

## The unit is core logic behind the upstream permission seams, compiled once per run and once per turn

- Layer `core`. The runtime and shared files import upstream packages, `@jaira/shared` and `paths.ts` from [process-exec](process-exec.md), whose `dialectFor` picks the parser dialect by the same rule `interpreterFor` picks the shell, so the language judged is the language run. `commandLog.ts` is persistence code and the wiring is main-process code.
- Upstream seams: `ExecPolicy` with `baseline`, `smart` and `scopeOf`, and `Approver`, reach the engine on the services seam as `ctx.policy` and `ctx.approve`. `ScopeNarrowing` is the `scopeOf` callback. `ToolGate` is what a delegated agent's permission callback consults. `providerOptions.claudeCode.settings.permissions` carries `allow`, `ask` and `deny` rules to Claude Code.
- Boundary: Windows and WSL. A WSL project's commands are parsed as POSIX and a native Windows project's as PowerShell.
- Callers: app `startRun` compiles the run's policy with the floor, `workspaceRoot`, `askAboveBytes` and the audit, calls `grantAlwaysGrantedTools` and `policyCanEscalate`, and compiles the floor into Claude rules for the prompt executor. App `runChatMessage` compiles a policy with no audit, folds the message's per-tool modes into its baseline, and calls `planAgentTools` and `gateTools`. `chatOperationOf` writes the ask and scope rules into a turn's `providerOptions`. The CLI registers `run_command` and calls `policyCanEscalate`, and passes no policy to `executeWorkflow`.

## The settings and the snapshot hold the rules, and the database holds only the audit

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `policy` | read unchecked by `compilePolicy` and `policyCanEscalate` | layered `settings.json` | project-config requires only that it is an object |
| `artifacts.askAboveBytes` | read into `compilePolicy` | layered `settings.json` | artifact-placement reads the rest of `artifacts` |
| Root `scopes` of the first executor that has any | read by `scopeFloorOf` | layered `settings.json` | executor-tree parses the executor nodes |
| A state's or a message's `permissions` | read at each decision | the pinned snapshot, or the composer's overrides | chat-turns folds the overrides |
| `command_log` rows | written by the run's `onDecision` through `CommandLog.record`; read by `list` and `summary` | the project database, under every storage mode | board-projection draws them; history-pruning and task-lifecycle delete them |
| `PermissionLedger` | built by each `gateTools` call and each `run_command` command | memory | upstream decides against it |

## The invariants keep a risky call from resolving to allow and a narrowing from widening

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A destructive command never resolves to allow, however it is spelled or whatever shares its line | `policy.test.ts` "denies the same operations however they are dressed up", "takes the strictest verdict on a line"; `command.test.ts` "finds a destructive command hidden after a benign one", "strips prefix wrappers (env, sudo, npx)" |
| 2 | A line the parser cannot model is never allowed without asking | `policy.test.ts` "asks rather than allows: %j"; `command.test.ts` "reports an unterminated quote", "refuses to model PowerShell expression syntax"; `scopeWalkAndCommand.test.ts` "escalates a line it could not parse" |
| 3 | A path under `.jaira/` is denied to command and file tools at any size | `policy.test.ts` "denies .jaira wherever it appears", "denies .jaira/ by path, for command and file tools alike", "still refuses .jaira/ whatever the size" |
| 4 | A matching authored rule is never overridden by a built-in | `policy.test.ts` "takes precedence over the built-ins, first match winning", "honours a custom default and lets built-ins be disabled" |
| 5 | `show_artifact` has no baseline mode, so it asks like `write_file` unless a project authors `smart`, and under `smart` a payload above the ceiling asks | `policy.test.ts` "has the RULE without taking the tool's permission away", "passes what is ordinary and asks about what is enormous"; `tools.test.ts` "asks before it produces anything, however small" |
| 6 | Every `smart` decision reaches `onDecision` with its parsed command | `policy.test.ts` "records every decision for the audit trail (§10.2)" |
| 7 | `policyCanEscalate` is false only when the built-ins are off and no rule or default asks | `policy.test.ts` `"is true whenever a human could be asked — which is what §8.2 gates on"` |
| 8 | No tool with a Claude built-in is left unplanned, and an ungranted one is listed to deny | `agentToolPlan.test.ts` "denies the built-in of a tool nobody granted", "leaves no tool with a built-in unaccounted for", "keeps the two axes independent" |
| 9 | `show_artifact` is injected by every grant list, and never twice | `agentToolPlan.test.ts` "is injected by a list that never mentions it", "is not doubled when the list does mention it" |
| 10 | Every profile answers for every tool and for unknown names, and `read-only` never allows a writer | `toolVocabulary.test.ts` "says something about every tool in the table, under every profile", "keeps read-only meaning read-only"; `agentToolPlan.test.ts` "keeps read-only meaning read-only, and asks about what it cannot classify" |
| 11 | Every tool has one entry and one category, and the gateable set equals what the registration functions build | `toolVocabulary.test.ts` "gives every tool a category the menu can draw", "names each tool once"; `tools.test.ts` `"names every tool JaiRA registers — the set is the WHOLE gateable one"` |
| 12 | An unmatched path or URL is denied, an unusable glob matches nothing, an empty set is denied, and case never escapes a deny | `scopes.test.ts` `"DENIES a path no scope matches — the sandbox, with no deny rule written"`, "treats an unusable glob as matching NOTHING, never everything", "denies an empty set rather than permitting a call about nowhere", "denies a url no scope matches, so the default posture is no network", "ignores case by default, so a deny cannot be escaped by spelling" |
| 13 | A state's table never widens the executor floor | `scopeLayers.test.ts` "refuses to let a state open a door the floor shut", "refuses a place the floor never named, whatever the state says", "applies the floor even when the state's table is silent" |
| 14 | A denying scope refuses through the gate and through the wrapped tool, and a remembered approval never rescues it | `scopeEnforcement.test.ts` `"refuses through the GATE — what a delegated agent's callback asks"`, `"refuses through the WRAPPED TOOL — what a composed runtime runs"`, "remembers an approval for the run without rescuing a denied place" |
| 15 | A shell command is judged at its working directory and every path it names, strictest winning | `scopeWalkAndCommand.test.ts` "always includes the working directory, not only when no path is named", "resolves every path argument against the directory it runs in", "takes the strictest place, through the narrowing" |
| 16 | Every compiled Claude rule is path-scoped | `scopeWalkAndCommand.test.ts` `"scopes EVERY rule — a bare one would outrank a specific one"`, "emits nothing for a tool that names no place" |
| 17 | A preset writes a mode for every offered tool, and one edit makes the map custom without changing the rest | `permissionPresets.test.ts` "assigns a mode to EVERY offered tool, so nothing falls through to a default", "becomes CUSTOM when one tool is changed, and keeps every other mode", `"IGNORES a mode for a tool no longer offered — stale is not custom"` |
| 18 | A `command_log` row keeps its decision, decider, scope and parsed intent, and pruning a terminal task removes its rows | `approvals.test.ts` "records what policy decided and what the human then chose", "keeps the parsed intent in the log, so the audit shows what was matched"; `prune.test.ts` "drops a terminal task's journal and command log, and keeps the task itself" |
| 19 | `run_command` never runs a command its policy refuses | unasserted |

## A conversation turn and a CLI run are governed far less than an app run, and the audit records only policy's side

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A line does not parse, or holds PowerShell `$(`, `@(`, a backtick or `iex` | `require_approval` with `command could not be parsed (<reason>)` | the person decides | an approval for the raw line |
| An agent runs `pnpm publish` or `pnpm add <pkg>` | `pnpm` is a prefix wrapper, so the program reads as `publish` or `add`, the publish and install asks never match, and the verdict is allow | author a rule whose `program` is the word after `pnpm` | the command runs without asking |
| A call goes through `gateTools` | the gate keeps the stricter of the `profileRules()` table and the resolved mode. The `full` table, which applies when no profile is set, maps every tool to `ask`, so every call reaches the approver however it is authored, a `session` or `workflow-run` answer does not stop the next question, and the `smart` approver is never consulted, so a command the policy denies is put to the person instead | none | every tool call in a conversation asks the person |
| A person answers an approval with `session`, `workflow-run` or `always` | the answer lives in the ledger that asked; `gateTools` builds one per turn and `run_command` one per command | none | the next turn or command asks again |
| A conversation turn's tool call names a place the executor floor refuses | `gateTools` is given no floor and does not read `policy.scopeOf`, and the chat executor gets no compiled floor, so the gate and the wrapped tools narrow only by the message's own `permissions.scopes` | none | the call asks as if no floor existed |
| A conversation grants a tool list that leaves out a tool with a Claude built-in | `chatOperationOf` writes the ask and scope rules but not the `denyNatives` `planAgentTools` computed | none | the agent uses its own built-in for the ungranted tool |
| A prompt state answered by a model provider declares tools | JaiRA sets no `EngineConfig.permissions`, and upstream `resolveTools` wraps a non-delegating runtime's tools only when `permissions.approve` is set | none | declared tools, `bash` included, run without policy or approval |
| A run is started by `jaira` | `executeWorkflow` gets no `policy` and no `approve`, so no command policy, scope or audit applies, and `run_command` meets `ask` with no approver | run the task from the app | `run_command` states fail with `command refused: <reason>` |
| `run_command` runs a command | it builds no `scopeOf`, so scope tables never narrow it | none | the command runs wherever its policy allows |
| Several executors declare root `scopes`, or a route declares them | `scopeFloorOf` takes the first executor in settings order; route `scopes` are parsed and never enforced | move the table to that executor | the other tables are not in force |
| The floor does not cover the project directory | nothing warns: `coversProjectPath` has no production caller | fix the glob | every call about a place in the project is refused |
| A run's decision is `require_approval` | the row is written `decision: "allowed"`, `decidedBy: "policy"`; the person's answer is written only for requests in `ProjectSession.approvalRun`, which nothing fills; a conversation turn writes no rows, because its `compilePolicy` has no `onDecision` | none | the log shows the escalation as allowed and no answer |
| Two runs audit at once, the process dies mid-insert, or a call is decided twice | SQLite serializes the inserts and each is atomic; nothing deduplicates, so a decision made twice is two rows | none needed | each decision listed |
| `gateTools` is asked for a name nothing registered | throws `tool '<name>' is not registered` | pick a registered tool | the send is refused with that message |

## Migration 16 dropped the audit's run column, and nothing else here is stored

- `command_log.run_id` was dropped by migration 16; it does not roll back. Every other input is configuration or snapshot data read at each start or turn, so a policy change applies to the next start or message without migration.

## The one budget is the size above which a smart payload asks

- `askAboveBytes` defaults to 4194304, `DEFAULT_ASK_ABOVE_BYTES` in `packages/shared/src/config.ts`.

## Policy matches parsed intent and profile tables shadow upstream's, both on purpose

- A verdict is decided over `ParsedCommand`s rather than a pattern over the raw line, so a flag in another position or a wrapper cannot change it; the cost is that a line the parser cannot model asks.
- `gateTools` registers tables under upstream's own `read-only`, `plan` and `full` names, so an agent's built-ins get an answer from the profile rather than an escalation for want of a `readOnly` flag.
