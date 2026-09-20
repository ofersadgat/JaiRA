---
id: engineering/units/executor-tree
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/components/executor-tree, ui/surfaces/settings-executors, product/bring-your-own-models-and-agents, ux/patterns/inherited-unless-set-here]
layer: core
owns_contracts: []
requires: []
implemented_by: [packages/shared/src/executorTree.ts, packages/shared/src/executorStack.ts, packages/shared/src/executors.ts, packages/runtime/src/executorTree.ts, packages/runtime/src/executorStack.ts]
verified_by: [packages/shared/test/executorTree.test.ts, packages/runtime/test/executorTree.test.ts, packages/runtime/test/executorStack.test.ts, packages/runtime/test/securityFloor.test.ts]
siblings: [engineering/units/model-routing, engineering/units/engine-wiring, engineering/units/agent-executors, engineering/units/project-config, engineering/units/tool-policy]
---

# Executor tree

## The tree unit resolves who answers a prompt from what is available and a sparse overlay, and builds that answer as executors

The shared half in `packages/shared/src` is pure data and decisions, so the Settings screen renders the same tree a run builds:

- `executorTree.ts`: the node types `operation`, `function`, `router`, `provider` and `agent`; `resolveExecutorTree(overlay, availability)`; bare-id placement `routeForBareModel`, `vendorOfModel`, `isRoutePrefixed` and `matchesModel`; the no-model pick `unnamedRouteOf`; the start-time answers `unnamedModelAnswer` and `namedModelAnswer`; function rules `parseFunctionRule` and `functionAllowed`; the overlay writers `pin` and `isPinned`; `EXECUTOR_NODES` and `BUILTIN_FUNCTIONS`.
- `executorStack.ts`: the step types, `EXECUTOR_STEP_ORDER` and the `EXECUTOR_STEPS` schemas the form renders from. `executors.ts`: the executor kinds and the probe, availability and secret-origin shapes that cross IPC.

The runtime half builds executors from a resolved node. `buildPromptTree` makes a router, a provider over `createModelRouter`, or the registered agent executor a node names, and wraps each node in its own steps through `composeExecutorStack`. `withSecurityFloor` folds a call config over every prompt call. `buildExecutorTree` adds the operation and function levels and has no production caller.

It deliberately does not own:

- Which provider routes are usable, which agents exist and whose models they serve, the probes, and refusing a run at start: [model-routing](model-routing.md).
- Building the agent executors a node selects: [agent-executors](agent-executors.md) and `agentPromptRoutes` in [model-routing](model-routing.md).
- Parsing `executors` in `settings.json`: [project-config](project-config.md). Compiling the scope table into the floor: [tool-policy](tool-policy.md).
- The repair loop, the fake and the session layers around the tree: [engine-wiring](engine-wiring.md).

## The tree is core decision code split across shared and runtime, over the engine's executor composition

- Layer `core`. The shared half calls nothing; the runtime half calls only the shared half.
- Upstream seams: `PromptRouterExecutor`, `createPromptExecutor` and `withRateLimit` from `@declarative-ai/promptop`; `createModelRouter` from `@declarative-ai/llm`; `createOperationExecutor`, `withRetry`, `withMemoize`, `withDeadline`, `AdaptiveRateController`, `finishedHandle` and `permanentFailure` from `@declarative-ai/exec`.
- Callers: `buildPromptExecutor` builds `tree.prompt`, which the app and the CLI resolve through `defaultExecutorTree`. The app's `computeAvailability` resolves the same tree for the Settings screen, and `executorTreePane.tsx` writes edits with `pin`.
- Only `executors.default.prompt` reaches a run. Its nodes' `steps`, `defaults`, `model` and `allow` are built; the root node's `steps`, `function.rules`, `function.steps` and every executor other than `default` are parsed and never built. The app's security floor reads the first non-empty root `scopes` of any executor.

## The overlay is the only stored fact, and the resolved tree is derived on every use

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| The overlay `executors.default` | read by `resolveExecutorTree`; `pin` returns a new overlay with one dotted path set or removed | layered `settings.json` | [project-config](project-config.md) parses and writes it; the Settings screen marks pinned fields with `isPinned` |
| `ExecutorAvailability {providers, agents, vendors}` | read | computed per call by [model-routing](model-routing.md) | the app filters `agents` by its last probes |
| The resolved tree | derived, never written | the overlay plus availability | the app keeps a copy in `AvailabilitySnapshot.tree` for Settings |
| Memoized answers of a `memoize` step | read and written through `StackDeps.memoCache` | `SqliteMemoCache` in the project database | [operation-record-store](operation-record-store.md) owns the cache |
| `TreeReport` and `StackReport` | written while building | in memory | nothing reads them in production |

## The invariants keep a call on the route it asked for, or on one that can serve it, and never on a silent substitute

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An empty overlay resolves to a whole tree, a route derived later appears despite an unrelated pin, and an overlay route refines the derived one rather than replacing it | shared `executorTree.test.ts` "builds a whole tree from nothing at all", "adds a route for something installed later, even with an unrelated override pinned", "REFINES a derived route rather than replacing it" |
| 2 | A state naming no model goes to the first route that answers one, a route given a model wins over an agent that picks its own, and a provider route with no model never answers it | shared `executorTree.test.ts` "goes to the only route there is", "prefers a route that was given a model over an agent that picks its own", "is not answered by bare provider routes, however many there are"; runtime `executorTree.test.ts` "forwards a state that names no model to a route that can answer it", "still answers a state that names no model when there are several routes to choose from" |
| 3 | A router's `defaults` fill a call before prefix dispatch and under the state's own config, and `capabilitiesFor` answers for the route the call will reach | runtime `executorTree.test.ts` "routes a state that names no model, using the default it supplies", "lets a state's own model win over the default", "supplies its other call settings too, under the state's own", "answers capabilitiesFor for the route the default will DISPATCH to, not for the unnamed pick" |
| 4 | A bare model id goes to an agent of its family before a provider, never to an agent of another family, honours an `allow` list over the family, carries the chosen prefix written in, and is left alone when nothing serves it | shared `executorTree.test.ts` "prefers the agent that serves the family over the provider that also would", "never hands a model to an agent that does not serve its family", "takes an allow list as the last word, in both directions", "leaves an unroutable id alone rather than guessing"; runtime `executorTree.test.ts` "sends 'claude-sonnet-5' to the CLI agent, prefix written in" |
| 5 | An id that names a route is dispatched by that prefix even when the route is unreachable here | runtime `executorTree.test.ts` "still refuses a route the author NAMED but this machine cannot reach", "still dispatches a state that names a prefix the sole route does not own" |
| 6 | An agent node whose agent is not registered refuses by name and never falls through to the provider path | runtime `executorTree.test.ts` "refuses a route whose agent is not registered, rather than falling through" |
| 7 | A node's `allow` list refuses a model outside it, and a node with no model leaves the call's model alone | runtime `executorTree.test.ts` "applies a node's own model rules, and refuses outside them", "leaves the model alone when the node has none to state" |
| 8 | Each node is wrapped in its own steps, applied in `EXECUTOR_STEP_ORDER` whatever order they were written in, and a `memoize` step with no store is skipped and reported | runtime `executorTree.test.ts` "wraps each node in its OWN steps, so a route's limit is not the tree's"; `executorStack.test.ts` "applies them in the canonical order, whatever order they were authored in", "applies every step a definition names, and only those", "skips memoization with no store, and says so rather than pretending", "does not memoize an executor that declares itself unmemoizable" |
| 9 | The security floor reaches every prompt call, survives a state's own `providerOptions`, keeps both sides of every array, and leaves function ops untouched | `securityFloor.test.ts` "reaches a call that authored nothing", "survives a state that authors an UNRELATED provider's options", `"cannot be dropped by a state authoring rules of its own — the lists UNION"`, "does not touch a function op" |
| 10 | `pin` writes one path, removes the containers an un-pin emptied, and never mutates the overlay it was given | shared `executorTree.test.ts` "pins one dotted path and nothing else", "un-pins on undefined, collapsing every container it emptied", "does not mutate the overlay it was given" |
| 11 | Function rules take the last match, match globs, and read a list of only additions as an allow list | shared `executorTree.test.ts` "takes the LAST matching rule, so order is the meaning", "matches a glob, so a family of functions is one rule", "reads a list of only additions as an allow list" |
| 12 | `namedModelAnswer` refuses a prefixed route that is not available and a bare model whose family nothing serves, naming the way out | shared `executorTree.test.ts` "refuses a prefixed route that is not available, and names both ways out", "refuses a bare model whose family nothing here serves, and says whose it is" |

## Every failure is a named refusal at the call, except settings that are parsed and never built

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A node names an agent that is disabled or not registered | permanent failure `<path> names the agent '<name>', which is not registered here — it may be turned off, or not installed` | enable or install the agent | the state fails with that reason |
| A call asks a node with an `allow` list for a model outside it, or for its default when the node has no `model` | permanent failure `'<owner>' is restricted to <patterns>, …` | name an allowed model, or give the node a `model` | the state fails with that reason |
| A `memoize` step is built with no store, as in the CLI and a gate's follow-up call | the step is skipped and the skip is recorded in a report nobody reads | none | every call reaches the provider |
| Two runs use one route with a `rateLimit` step | each `buildPromptExecutor` builds its own `AdaptiveRateController`, so the limit bounds each run and not the route | none | concurrent runs can exceed the configured rate |
| A long run uses a node with a `deadline` step | the window starts when the run's tree is built, so later calls get what is left of it | raise `maxDurationMs` | late calls in the run time out |
| A `transient` retry re-attempts a call | each attempt passes rate admission again and is a new provider call | none needed | none beyond the delay |
| A project sets `function.rules`, root `steps`, `function.steps`, or an executor other than `default` beyond its `scopes` | the setting parses and nothing builds it | none | Settings shows it and no run enforces it |
| A process dies or two writers edit the overlay | cannot occur here: the tree is derived in memory and the overlay file is written by [project-config](project-config.md) | none needed | none |

## The tree departs from authored composition in three places

- The step order is JaiRA's, `memoize`, `retry`, `rateLimit`, `deadline` from outermost in, and cannot be authored, because a hit must skip everything and each retry must be admitted by the limiter again.
- An absent field is derived from what is available rather than stored as a default, so a route installed later appears without editing `settings.json`.
- The security floor merges over the state's config, deeply and with arrays unioned, where every other defaulting layer merges under it, because a state must not be able to drop the project's scope rules.
