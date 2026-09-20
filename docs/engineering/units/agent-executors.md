---
id: engineering/units/agent-executors
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/bring-your-own-models-and-agents, product/work-inside-wsl, product/risky-actions-wait-for-approval, ui/surfaces/settings-executors, ui/surfaces/settings-providers, ux/patterns/checked-status-with-the-fix]
layer: core
owns_contracts: []
requires: [engineering/units/process-exec, engineering/units/secret-chain, engineering/units/host-tools]
implemented_by: [packages/runtime/src/agents.ts, packages/runtime/src/genericAgent.ts, packages/runtime/src/executors.ts]
verified_by: [packages/runtime/test/agents.test.ts, packages/runtime/test/genericAgent.test.ts, packages/runtime/test/executors.test.ts, packages/cli/test/genericAgent.e2e.test.ts]
siblings: [engineering/units/model-routing, engineering/units/executor-tree, engineering/units/tool-policy, engineering/units/process-claims]
---

# Agent executors

## The unit registers the coding-agent runtimes, lists and probes them, and refuses a state whose runtime cannot enforce its policy

- `agents.ts`: the registry names `claude-code` (`AGENT_SDK`), `claude-cli` (`AGENT_CLI`) and `codex-cli` (`AGENT_CODEX`); `registerAgentRuntimes(registry, options)`, which registers the chosen adapters, all three by default, as `runtime` entries; `agentSpawn`, the process seam every CLI adapter spawns through; and `gateCapabilities(registry, states, options)`, the start-time policy check.
- `genericAgent.ts`: `createGenericCliQuery(spec)`, an upstream `AgentQuery` that runs any configured binary through `Exec`; `GENERIC_CLI_CAPS`; and `registerGenericAgents`, which registers each enabled generic CLI under `name`, default `generic-cli`.
- `executors.ts`: `listExecutors`, which lists the three built-ins even when disabled and the configured generic CLIs after them; `enabledAdapters` and `enabledGenericAgents`, which decide what registers; and `probeExecutor` and `probeExecutors`, which check an executor without running an agent.

A generic CLI gets its prompt from a `{prompt}` argument, from stdin when `prompt` is `"stdin"`, or after `--`, and a model only through a `{model}` argument. It refuses, rather than drops, an output schema, declared tools, an allow-list, a deny-list, a permission mode and a model its arguments have no placeholder for. Its answer is its trimmed stdout, with no cost.

It deliberately does not own:

- How an agent is driven: argv, stream parsing, sessions, the MCP permission and tool bridge and its worker. Those are upstream `@declarative-ai/agents-api` and `@declarative-ai/agents-cli`. JaiRA only creates one `createMcpBridgeHost` per `AppService` and per CLI process and passes its `start` as `startBridge`.
- Agents reached by a model prefix, which `agentPromptRoutes` builds with the same spawn: [model-routing](model-routing.md).
- Compiling the policy and deciding a tool call: [tool-policy](tool-policy.md). The host tools the SDK adapter's built-ins are replaced by: [host-tools](host-tools.md).
- Job rows, heartbeats and orphans: [process-claims](process-claims.md). Path mapping and tree kill: [process-exec](process-exec.md).

## The unit is core code over the engine's runtime-function seam, and owns JaiRA's spawn for agents

- Layer `core`, package `@jaira/runtime`. It calls [process-exec](process-exec.md) for `resolveInvocation`, `NodeExec`, `killTree` and `detachedForTree`, [secret-chain](secret-chain.md) for probe credentials, and `claudeReplacements` from [host-tools](host-tools.md).
- Upstream seams: `runtimeFunction` and `RuntimeCapabilities` from `@declarative-ai/exec`; `createClaudeCodeFunction`, `DELEGATED_CAPS` and `AgentQuery` from `@declarative-ai/agents-api`; `createCliAgentFunction`, `createCodexAgentFunction`, `CODEX_CAPS`, `SpawnProcess`, `stderrTail` and `createMcpBridgeHost` from `@declarative-ai/agents-cli`.
- Boundary: Windows and WSL. An agent's whole argv goes through `resolveInvocation`, so a WSL project's agent runs inside the distro.
- Callers: app `startRun` registers the runtimes and runs `gateCapabilities` against the resolved states; app `listExecutors` and `probeExecutors` serve `executor:list` and `executor:probe` and remember results in `lastProbes`; CLI `buildRunEnvironment` and `assertCapabilities` with `unattended: true`.

## The unit keeps registrations and probes in memory, and records processes through its observer

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `registry.functions` entries under the agent names | written once per run | in memory | the engine dispatches them; `gateCapabilities` reads their capabilities |
| `agents.claudeCode`, `agents.claudeCli`, `agents.codex`, `agents.genericCli` | read | layered `settings.json` | [project-config](project-config.md) parses and writes it |
| `jobs` rows of kind `process` and `job_output` | written through the `ExecObserver` a caller passes | the project database | [process-claims](process-claims.md) owns them |
| The bridge host and its worker thread | created at the first agent that needs a bridge, closed when the service disposes | in memory, one per `AppService` or CLI process | upstream serves every run on it |
| `ProbeResult` per executor | written by a probe | `AppService.lastProbes` and the availability snapshot, in memory | state views and the default tree read which executors are `ok` |

## The invariants keep an agent inside its environment and never let a policy it cannot enforce reach it

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Only the adapters asked for are registered, and codex registers with capabilities that let it run under a real policy | `agents.test.ts` "registers all three adapters as runtime entries", "registers only what was asked for", "registers codex with the capabilities that let it run under a real policy" |
| 2 | A disabled executor stays in the list and is left out of the registry rather than registered as a refusing stub | `executors.test.ts` "keeps a disabled executor in the LIST, so it can be turned back on", "leaves a disabled adapter OUT rather than registering a refusing stub", "filters disabled generic CLIs out of the registration list" |
| 3 | An agent's command and workspace are mapped for a WSL project, and project config reaches codex's argv | `agents.test.ts` "maps a WSL project's agent command through the one Exec mapper", "passes the codex binary and sandbox from project config down to the argv"; `genericAgent.test.ts` "runs in the task's workspace, translated for a WSL project" |
| 4 | An agent's stderr is always drained, forwarded to the observer, and never stops the child from exiting, and a binary that cannot launch is named | `agents.test.ts` "drains even with NO observer attached, because the deadlock does not care why nobody read", "still exits when the child writes more to stderr than a pipe holds", "forwards stderr to the observer", "names a binary that could not be launched, rather than a sentinel -1" |
| 5 | An agent's failure resolves as data and never rejects | `agents.test.ts` "reports an agent failure as data, not a rejection" |
| 6 | A function state whose runtime enforces no policy is refused under a policy that can ask, from either state shape, and in an unattended run so is one that escalates by callback; host functions, prompt states and unregistered refs are never checked | `agents.test.ts` "blocks a policy that can ask against a runtime that enforces nothing", "reads the AUTHORED `function` field as well as the loaded `functionRef`", "passes when the runtime can enforce the policy", "ignores host functions, prompt states and unregistered refs", "says nothing when the policy cannot escalate", "warns when an escalating runtime has no one to ask" |
| 7 | A generic CLI refuses declared tools, a deny-list, a permission mode and a model it has no placeholder for, rather than running without them | `genericAgent.test.ts` `"refuses a state's declared tools rather than dropping them — the binary has no bridge to serve them"`, "refuses a deny-list and a permission mode by the same rule", "REFUSES rather than running the binary's default under another name" |
| 8 | A generic CLI declares no policy enforcement, so a run under an escalating policy is refused | `genericAgent.test.ts` "declares that it enforces no policy, so §8.2 refuses it under an escalating policy"; `genericAgent.e2e.test.ts` "refuses the run when the project's policy can escalate (DESIGN §8.2)" |
| 9 | A generic CLI reports a timeout, a cancellation and a missing binary each as its own failure, and reports no cost | `genericAgent.test.ts` "reports a timeout distinctly from a failure", "forwards the abort signal and reports cancellation", "reports a missing binary as a start failure, not a crash", "reports no cost, because a generic CLI does not tell us what it spent" |
| 10 | A probe runs nothing but `--version` or a package resolution, bounds a hang, never runs a disabled executor, and reports a credential's origin only | `executors.test.ts` "checks a CLI with --version, and reports the version it answered with", "reports a hang as a timeout rather than waiting on it", "does not run anything for a disabled executor", "checks the SDK adapter by resolving its package, not by spawning anything", "passes once the credential resolves, and names only its origin" |
| 11 | A probe fails an executor whose required key nothing supplies, and never asks for a key for a runtime that signs itself in | `executors.test.ts` "fails a working binary whose named credential nothing supplies", "fails the SDK adapter when the package is there but no key is", "never looks for a key for a runtime that signs itself in" |
| 12 | A generic CLI refuses a state that declares an output schema | unasserted |
| 13 | An observer that throws never changes the agent's outcome | unasserted |

## Every failure reaches the state as data, and some processes start without a record

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| An agent's binary is missing | the adapter is registered anyway and the call fails naming the binary; a probe fails with the shell's words | install it or fix `command` | the state fails; Settings shows the executor failed with the fix |
| An agent writes more stderr than a pipe holds | the drain keeps reading, the tail keeps the last characters | none needed | none |
| The observer throws | the error goes to `onError`; the app logs `recording a child process failed (<phase>)` at warn | none | a warning in Logs |
| The bridge cannot serve the CLI agent | upstream fails the call as `bridge_unreachable` | run the state again | the state fails |
| Two runs share the bridge worker | cannot collide: upstream separates runs by a per-run token in the URL path | none needed | none |
| The run is stopped | `kill` ends the agent's whole process tree | none needed | the run stops |
| JaiRA dies while an agent runs | the job row's heartbeat goes stale; the agent keeps running and nothing kills it | kill the process by hand | the next `jaira` command warns of a process left running; the app shows nothing |
| A chat turn, a follow-up round, or an app run's generic CLI prompt route starts an agent | no observer reaches that spawn, so no `process` job row is written | none | an agent that outlives JaiRA is missing from the orphan report |
| An agent runs with a bridge | its argv carries the bridge URL with the run's token, and the observer writes it to `jobs.command` and the app's `started` log entry | none | the token is readable in Logs until the run ends |
| An executor names a `credential` | only the probe resolves it; nothing passes the value to the agent, and `agentSpawn` ignores `SpawnOptions.env` | put the key where the binary reads it | the probe passes and the agent may still lack its key |
| A prompt state reaches a generic CLI or `claude-cli` through a model prefix | `gateCapabilities` reads function ops only, so the start check does not examine it | none | the run starts |
| A probe names an executor that does not exist | the app refuses `unknown executor '<name>'` | none | an error notice |

## The one budget is the probe's timeout

- `DEFAULT_TIMEOUT_MS = 10_000` in `packages/runtime/src/executors.ts`, overridable through `ProbeOptions.timeoutMs`. A generic CLI run has no time limit unless `GenericCliQueryOptions.timeoutMs` is set, and no caller sets it.

## The unit keeps its own spawn instead of upstream's, and registers codex whether or not it is installed

- Every CLI adapter spawns through `agentSpawn` rather than upstream's default, because only JaiRA's seam maps the argv into WSL, records the process as a job and kills the whole tree.
- `claude-cli` and `codex-cli` register whether or not their binary exists, so a state naming one fails with the binary's own launch error rather than as an unregistered function; only `enabled: false` leaves one out.
