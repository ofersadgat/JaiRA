---
id: engineering/units/model-routing
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/bring-your-own-models-and-agents, ui/surfaces/settings-connections, ui/components/provider-row, ui/components/model-cascade, ux/patterns/checked-status-with-the-fix, ux/patterns/refuse-with-the-reason-and-the-fix]
layer: core
owns_contracts: []
requires: [engineering/units/executor-tree, engineering/units/secret-chain, engineering/units/agent-executors]
implemented_by: [packages/runtime/src/modelRoutes.ts, packages/runtime/src/localServers.ts, packages/runtime/src/wiring.ts, packages/runtime/src/presetModels.ts, packages/shared/src/presetModels.ts]
verified_by: [packages/runtime/test/modelRoutes.test.ts, packages/runtime/test/localServers.test.ts, packages/app/test/forgeSignIn.test.ts, packages/runtime/test/presetModels.test.ts, packages/shared/test/presetModels.test.ts]
siblings: [engineering/units/executor-tree, engineering/units/agent-executors, engineering/units/secret-chain, engineering/units/engine-wiring]
---

# Model routing

## Routing decides which routes can answer a model on this machine, and refuses a run whose models nothing here serves

`modelRoutes.ts` and `defaultExecutorTree` in `wiring.ts` answer, from configuration and this machine:

- `modelRouterOptions(models, secrets)`: the provider routes as upstream `ModelRouterOptions`, with keys resolved. A remote route's key is its named `credential`, else its conventional variable `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, both looked up through the secret chain; a disabled route gets none. `local` takes `baseURL`, `headers`, `supportsStructuredOutputs`, `serve` and a named credential only; `embedded` becomes a resolver over its `weights`.
- `usableRouteKeys(models, secrets)`: the routes a derived tree is built from. A remote route needs a key the chain can find, `local` needs a `baseURL`, and `embedded` needs one weights file that exists.
- `agentPromptRoutes(agents, options)`: one prompt executor per enabled agent, keyed by its registry name, each wrapped in `normaliseAgentModel` so `""`, `default` and `<agent>/default` all reach the transport as `<agent>/default`. `agentPromptRouteNames` lists them with `claude-cli` first; `agentRouteVendors` says `claude-cli` and `claude-code` serve `anthropic`, `codex-cli` serves `openai`, and a generic CLI serves no vendor.
- `probeModelRoutes(models, options)`: a no-cost check of every route in `MODEL_ROUTE_KEYS`, reported as `ProbeResult`. The embedded route's line is decided from `checkWeightsFiles` (one row per model: stat'd, with its size, a split GGUF named by its first part and its parts summed) and `checkEmbeddedLoader` (does `node-llama-cpp` resolve), which `checkEmbeddedWeights` also answers IPC `model:checkWeights` with, so the list and the line cannot disagree.
- `discoverLocalServers(options)` in `localServers.ts`: IPC `model:probeLocal`, on demand only. `GET {base}/models` at Ollama `:11434/v1`, LM Studio `:1234/v1`, llama.cpp `:8080/v1`, vLLM `:8000/v1` and Jan `:1337/v1` in parallel, 800 ms each; `up` only for an OpenAI `{data: [{id}]}` list, so another program on the port is not a server; `inUse` on the row the `local` route's `baseURL` names (`sameServerUrl`: case, trailing slash and `localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0` do not matter), and that URL asked too as a `Configured` row when it is none of them.
- `knownModels()`: the upstream `ModelInfo` catalog as `{route}/{model}` ids with their input and output modalities, for the model picker, plus `AHEAD_OF_CATALOG`: the ids the built-in presets name that the catalog snapshot lacks (`anthropic/claude-opus-5-5`, `anthropic/claude-fable-5-1`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-sol`), each dropped once the catalog lists it.
- `withPresetModels(options, defaults, prompt)` in `presetModels.ts`: presets expanded in front of the prompt tree, and a preset's model chosen, below.
- `defaultExecutorTree(config, bundle, opts)`: the resolved default tree, and the start-time refusal.

It deliberately does not own:

- Placing a bare id, picking a route for a state that names none, and the refusal texts `namedModelAnswer` and `unnamedModelAnswer` write: [executor-tree](executor-tree.md).
- Looking up and storing a credential: [secret-chain](secret-chain.md).
- Driving an agent, its spawn and its function registration: [agent-executors](agent-executors.md).
- The availability snapshot's refresh and caching, which `AppService.refreshAvailability` in `service.ts` does.

## Routing is core code between configuration and the engine's model router, called by both drivers

- Layer `core`, package `@jaira/runtime`. It calls [executor-tree](executor-tree.md), [secret-chain](secret-chain.md) and the spawn and enablement helpers of [agent-executors](agent-executors.md).
- Upstream seams: `ModelRouterOptions`, `ModelInfo` and `keyForModel` from `@declarative-ai/llm`; `AgentApiExecutor` and `AGENT_DEFAULT_MODEL` from `@declarative-ai/agents-api`; `AgentCliExecutor`, `AgentCodexExecutor` and `StartMcpBridge` from `@declarative-ai/agents-cli`.
- Boundary: secrets live in the environment. Key values are read in the main process and never cross IPC; a probe reports only the `SecretOrigin`.
- Callers: CLI `buildRunEnvironment`; app `promptWiring`, `defaultTree`, `computeAvailability`, `probeModelRoutes` behind IPC `model:probe`, and `knownModels` for the composer. `buildPromptExecutor` puts `withPresetModels` in front of the tree whenever a caller passes `presets`, which both drivers do for every run that is not scripted.

## Routing reads configuration and the machine, and keeps nothing but the app's last probe

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `models.routes`, `models.presets`, `agents`, `executors.default` | read | layered `settings.json` | [project-config](project-config.md) parses and writes it |
| Credential values | read through `SecretResolver.lookup` | the keychain, `.env` files and the environment | [secret-chain](secret-chain.md) |
| A local server's answer | one bounded `GET` per probe | the server | none |
| Weights files and the `node-llama-cpp` package | `existsSync` and module resolution | the filesystem | none |
| Route probe results | written into `AvailabilitySnapshot.routes` | in memory in the app | Settings reads it; executor probes fill `executors` beside it |
| The model catalog | read | the `ModelInfo` snapshot upstream ships | none |

## A preset's model is chosen when its session is created, from the first candidate this machine can run

`models.presets.<name>.model` is a model id or `{ candidates, choose: "first-available" }` ([settings-json](../contracts/settings-json.md)). `withPresetModels` resolves it on the way into the prompt tree, BEFORE the router reads `op.config.model`: the provider leaf used to read `configRef` after routing, so a preset could never choose a route, and an agent route never read it at all. `resolvePresetCall` expands the preset under the state's inline config and over the default executor's defaults, drops `configRef`, and settles the model, strongest first: the state's own `model`, the preset's, the defaults' when that names a preset. A model field equal to a preset's name means that preset's model (`resolveModelField`), which is how `functions.smart.model: "simple"` and a Default model of `coder` work.

A candidate list is settled once per SESSION (`ctx.session.id`):

1. what this executor already chose for the session;
2. on a call past the session's first (`at.seq > 0`), the candidate matching the model the session's last call recorded (`recorded`, then `keptCandidate`: exact, or a dated snapshot of it, under any route). This is how a resumed task, or a chat turn built afresh, keeps its model;
3. `chooseFirstAvailable(candidates, available)`: the first candidate the host calls available. None available fails the call, naming each candidate and why.

A call with no session (the judge) chooses every time. The chosen id is written into `model`, so the record, and the conversation drawn from it, show the model that ran.

Available is `modelAvailabilityIn(configured, id, health)`: the id resolves to a route in the default tree built from every CONFIGURED route (a bare id through `servingRoutes`, agents first; a pinned leaf serves every id), and that route's health is good. The app's health is `routeHealthOf(availability)`: a route whose last probe `failed` or `needs-sign-in` is out, one never checked is in. Its lookup is `AppService.modelAvailabilityFor`, and its recorded model is `recordedModelAt`, the last model any of the session's previous 32 calls recorded. The CLI passes no health and no record lookup: configured is its whole test, and a session keeps its choice for the life of the process. Settings → Models → Presets asks the same question of `AvailabilitySnapshot.configured` (`candidateLookupOf`), so the candidate it marks "picked now" is the one a new session would take.

The start-time check reads a preset's candidates: a state naming a preset, or picking one with `configRef`, is served when any candidate is (`namedOrPresetAnswer`), and refused naming the preset and each candidate's reason when none is.

## The invariants judge a route by the same key that serves it, and refuse at start what would fail at the first prompt

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A named credential is resolved into the router, the conventional variable is found through the chain, a named credential wins over it, and a disabled route gets no key | `modelRoutes.test.ts` "RESOLVES a named credential into the router, which is how a keychain key reaches the provider", "finds the CONVENTIONAL variable through the chain when config names no credential", "lets a NAMED credential win over the conventional variable", "still says nothing for a route that is turned OFF, whatever the chain holds" |
| 2 | A route counts as usable only when its key resolves, never for a named credential that resolves to nothing | `modelRoutes.test.ts` "counts a provider route whose key resolves", "does NOT count a route whose named credential resolves to nothing" |
| 3 | The CLI agent is listed first, and a generic CLI's prompt route declares its own capabilities | `modelRoutes.test.ts` "names the CLI agent first, because it is the one that needs no API key", "a generic CLI's prompt route declares its OWN capabilities, not claude's" |
| 4 | A run naming a route this machine cannot reach is refused at start, and the same model written bare is accepted when an agent serves its family | `modelRoutes.test.ts` `"refuses a model whose route this machine cannot reach — the API-key failure, caught at start"`, "accepts the same model written BARE, because the CLI agent serves that family" |
| 5 | A bare model no configured route serves, and a prompt workflow nothing here can answer, are refused at start with the fix named | `modelRoutes.test.ts` "refuses a bare model no configured route serves, and says whose family it is", `"still refuses when genuinely nothing can answer — and names both fixes"`, "refuses a machine whose only route serves nothing but models a state names" |
| 6 | No refusal comes from a scripted run, a workflow with no prompt state, a caller that only reads the tree, or an agent whose binary a probe could not find | `modelRoutes.test.ts` "stays out of the way of a scripted run", "asks for nothing at all from a workflow with no prompt state", "says nothing about models when the caller only wants to READ the tree", "does not refuse over an agent whose binary a probe could not find" |
| 7 | A probe fails a remote route with no key, connects to a local server, passes an unanswered local route JaiRA may start, and fails embedded weights that are missing or have no loader | `modelRoutes.test.ts` "fails a remote route with no key rather than calling it 'not checked'", "CONNECTS to a local server rather than trusting that a URL means one is there", "still passes an unanswered local route that JaiRA is allowed to START", "fails embedded weights whose file is not on disk, naming the path", "fails embedded weights that exist but have no loader installed" |
| 8 | A probe of a named credential reports its origin and never its value | `modelRoutes.test.ts` "passes a remote route whose named credential resolves, and names only its origin" |
| 9 | The agent placeholder keeps its route prefix, and a real model passes through unchanged | `modelRoutes.test.ts` "keeps the ROUTE on the placeholder, so the session stays bound to the transport that ran", "leaves a real model alone" |
| 10 | A preset is expanded before routing, under the state's config and over the defaults, and a model field naming a preset means its model | runtime `presetModels.test.ts` "merges the preset under the state's own config, and takes configRef out", "lets the preset's model beat the default executor's, and the state's own beat both", "means the preset's model — for the judge's call, which states it as its own model", "means the preset's model — for the Default model, which fills a state that names none" |
| 11 | `first-available` takes the first available candidate, and refuses naming every candidate and why | shared `presetModels.test.ts` "takes the first candidate that can run here, and says where it runs", "refuses naming EVERY candidate and why, when none can run"; runtime "fails the call naming every candidate and why, when none can run" |
| 12 | A session keeps its choice, from memory and from its record, and a new session chooses again | runtime `presetModels.test.ts` "keeps it for every later call in the session, though the machine changed underneath", "reads the choice off the record when resumed …" |
| 13 | A candidate is unavailable when no configured route serves it or its route's probe failed or needs a sign-in, and the next serving route is tried | shared `presetModels.test.ts` "falls to the next route that serves it when the first is signed out, and says why when none is left" |

## Some routes pass the start check and fail at the first call, because the check is cheaper than the probe

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A route names a credential nobody set | the route is not usable; a state naming `<route>/…` is refused at start with `'<model>' names the '<route>' route, which is not available here …` | store the secret, or drop the prefix | the run is refused with the fix; Connections shows the route failed |
| A local server is down | the probe fails unless the route has `serve`, but `usableRouteKeys` counts it by `baseURL` alone | start the server | Connections shows it failed; a run starts and its first call fails |
| Embedded weights exist and `node-llama-cpp` is not installed | the probe fails and the route still counts as usable | install the loader | a run starts and its first call fails |
| An agent's binary is missing and a bare model names its family | named models are checked against every configured agent, while the run's tree holds only agents a probe passed, so the call goes to a usable provider of that family or fails at dispatch | install the binary, or add a provider key | the run starts and, with no provider key, its first prompt fails |
| No probe has run yet in the app | `availableExecutors` is `undefined`, so every enabled agent is a route | none needed | a missing binary fails at the call |
| Two availability refreshes overlap | a request during a pass gets one follow-up pass, coalesced, and never the stale answer | none needed | Settings updates when the follow-up lands |
| A local server does not answer the probe in time | the fetch is aborted after `ROUTE_TIMEOUT_MS` and reported as `no answer in time` | Recheck | Connections shows it failed |
| The process dies mid-probe | nothing durable is written; the snapshot is rebuilt at the next start | none needed | none |
| Every candidate of a preset is unavailable when a session starts | the call fails permanently: `none of the candidates of preset '<name>' is available here — <id>: <why>; …` | sign an agent in, add a key, or edit the preset's candidates | the state fails with the sentence |
| A session's recorded model is none of its preset's candidates | it chooses again, as a new session would | none needed | the conversation shows the model that answered |
| `models.routes.openai` is written in `settings.json` | the parser refuses the block, so the route takes only `OPENAI_API_KEY` and cannot be disabled or given a `baseURL` or credential | supply `OPENAI_API_KEY` through the chain and write no `openai` block | the settings are refused with `config.models.routes.openai names an unknown route` |

## The one budget is the local probe's timeout

- `ROUTE_TIMEOUT_MS = 1_500` in `packages/runtime/src/modelRoutes.ts`, overridable per call through `RouteProbeOptions.timeoutMs`.

## Routing checks named models against configuration rather than probes, on purpose

- A model a state names is checked against every configured agent rather than the probed ones, because a missing binary is a fact about this moment and a missing credential a fact about the configuration, and only the second should stop a whole run.
