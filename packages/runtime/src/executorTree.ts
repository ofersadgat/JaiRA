/**
 * Building the executor TREE — a resolved configuration becomes the composition it describes.
 *
 * `@jaira/shared`'s `executorTree.ts` says what the tree IS and derives the adaptive default; this
 * turns one of those into the real thing:
 *
 * ```text
 *   operation   → OperationExecutor      dispatch on op.kind
 *   ├─ function → FunctionExecutor       the run's registry, optionally narrowed
 *   └─ prompt   → PromptRouterExecutor   dispatch on the model id's prefix
 *        ├─ anthropic  → PromptExecutor      via ModelRouter
 *        ├─ claude-cli → AgentCliExecutor
 *        └─ …
 * ```
 *
 * Each node's `steps` wrap that node, so a rate limit on one route and a deadline on the whole tree
 * are different statements — which is the thing one `steps` block at the top could not express.
 *
 * ## The ordering fix
 *
 * A router's `defaults` are applied BEFORE dispatch, and that is not a preference. `PromptRouterExecutor`
 * dispatches on `op.config.model`; a leaf's `defaults` are applied inside its own lowering. A default
 * model held only at the leaf is therefore invisible to the routing that has to happen first — a state
 * naming no model fell through to the provider path and was asked for `claude-cli/default` there,
 * which `ModelRouter` cannot serve. {@link withPromptDefaults} closes that by filling the op's config
 * on the way into the router.
 */
import {
  createOperationExecutor,
  finishedHandle,
  permanentFailure,
  type CapabilityRegistry,
  type ExecServices,
  type Executor,
  type InlineFamily,
  type JsonValue,
  type MemoCache,
  type ExecResult,
  type Operation,
  type ResolvedValue,
  type RuntimeCapabilities,
} from "@declarative-ai/exec";
import { createPromptExecutor, PromptRouterExecutor } from "@declarative-ai/promptop";
import { createModelRouter, type ModelRouterOptions } from "@declarative-ai/llm";
import { emptyWorkflowMetrics, mergeWorkflowMetrics, type WorkflowMetrics } from "@declarative-ai/hw";
import {
  unnamedRouteOf,
  type JairaAgentNode,
  type JairaExecutorSteps,
  type JairaFunctionNode,
  type JairaOperationNode,
  type JairaPromptNode,
  type JairaProviderNode,
  type JairaRouterNode,
} from "@jaira/shared";
import { composeExecutorStack, type StackReport, type StackedExecutor } from "./executorStack";
import { matchesModel } from "./modelRoutes";
import { functionAllowed } from "@jaira/shared";

export interface TreeDeps {
  /** How each provider route is reached, credentials already resolved. */
  router?: ModelRouterOptions;
  /** Named presets, selected per state by `operation.configRef`. */
  configs?: { get(id: string): Record<string, JsonValue> | undefined };
  /** One executor per agent runtime, keyed by its registry name — `agentPromptRoutes`. */
  agents?: Record<string, StackedExecutor>;
  /** The run's capability registry; the function half of the operation node. */
  registry?: CapabilityRegistry<WorkflowMetrics>;
  /** Where a `memoize` step stores answers. Absent ⇒ that step is skipped and reported. */
  memoCache?: MemoCache;
  /** Replaces the whole prompt half — the scripted `--fake` path, which needs no provider. */
  fakePrompt?: StackedExecutor;
  /**
   * Call config the project bounds every prompt with — see {@link withSecurityFloor}.
   *
   * A FLOOR rather than a default: it is merged over a state's own config rather than under it, so a
   * state can add to it and cannot drop it. What JaiRA puts here is the scope table compiled into a
   * delegated agent's own permission rules, which is how a sandbox reaches the agent's built-ins
   * instead of being enforced one callback at a time.
   */
  securityFloor?: Record<string, JsonValue>;
}

/** What the tree ended up being, so a caller can report a step that could not be applied. */
export interface TreeReport {
  /** Per node path (`prompt.routes.anthropic`) — what its stack applied and what it skipped. */
  stacks: Record<string, StackReport>;
}

/**
 * Build the PROMPT half of a resolved tree.
 *
 * Separate from the operation node because plenty of callers want only this: a summarizer and the
 * `--fake` path both answer prompts without a function registry, and handing them an operation
 * executor with an empty one would be handing them a dispatcher that can only fail on half its input.
 */
export function buildPromptTree(
  node: JairaPromptNode,
  deps: TreeDeps,
  report: TreeReport = { stacks: {} },
  path = "prompt",
): StackedExecutor {
  const built = buildBarePromptNode(node, deps, report, path);
  return stacked(built, node.steps, path, deps, report);
}

/** The node itself, before its own steps are wrapped around it. */
function buildBarePromptNode(
  node: JairaPromptNode,
  deps: TreeDeps,
  report: TreeReport,
  path: string,
): StackedExecutor {
  if (node.kind === "agent") return buildAgentNode(node, deps, path);
  if (node.kind === "provider") return buildProviderNode(node, deps);
  return buildRouterNode(node as JairaRouterNode, deps, report, path);
}

/** The provider path: `PromptExecutor` over `ModelRouter`, which owns every model-route prefix. */
function buildProviderNode(node: JairaProviderNode, deps: TreeDeps): StackedExecutor {
  const provider = createPromptExecutor({
    router: createModelRouter(deps.router ?? {}),
    ...(deps.configs !== undefined ? { configs: deps.configs } : {}),
  });
  return constrained(node, node.provider, provider);
}

/**
 * One agent runtime.
 *
 * The executors themselves are built by `agentPromptRoutes` — they need a spawn, an exec environment
 * and a job observer, none of which belong to a tree walk. This selects one and applies the node's
 * own model rules to it.
 */
function buildAgentNode(node: JairaAgentNode, deps: TreeDeps, path: string): StackedExecutor {
  const name = node.agent;
  const inner = name === undefined ? undefined : deps.agents?.[name];
  if (inner === undefined) {
    // Refused at the node rather than at the call, and by NAME: a tree that silently dropped a route
    // would send its calls to the fallback, which is a different executor answering as if it were
    // the one that was asked for.
    return refusing(
      `${path} names the agent '${name ?? "(unnamed)"}', which is not registered here — it may be turned off, or not installed`,
    );
  }
  return constrained(node, name, inner);
}

/** Dispatch on the model id's prefix, with each route built in turn. */
function buildRouterNode(
  node: JairaRouterNode,
  deps: TreeDeps,
  report: TreeReport,
  path: string,
): StackedExecutor {
  const routes: Record<string, StackedExecutor> = {};
  for (const [prefix, child] of Object.entries(node.routes ?? {})) {
    routes[prefix] = buildPromptTree(child, deps, report, `${path}.routes.${prefix}`);
  }
  // Absent ⇒ THE PROVIDER PATH, which is what `JairaRouterNode.fallback` documents and what JaiRA
  // did before any of this was configurable: it owns every prefix the model-route vocabulary knows
  // and produces the authoritative error for one it does not. Left genuinely absent, a router with no
  // routes has nothing to advertise capabilities from and upstream refuses to construct it — so a
  // bare `{ kind: "router" }`, which is what a caller with no configuration passes, would throw.
  const fallback = buildPromptTree(node.fallback ?? { kind: "provider" }, deps, report, `${path}.fallback`);

  const dispatching =
    Object.keys(routes).length === 0
      ? fallback
      : new PromptRouterExecutor({ routes, fallback });
  // A call that names no model has chosen no prefix, so there is nothing to dispatch on — the router
  // is free to answer it with any route that can, and {@link unnamedRouteOf} takes the first. Left to
  // dispatch it would go to the fallback: a different executor answering as if it were the one that
  // could have. A call that DOES name a prefix still dispatches, so `anthropic/…` on a machine with
  // only `claude-cli` is refused by the route that owns that prefix rather than quietly rerouted.
  const unnamed = unnamedRouteOf(node.routes);
  const router = unnamed === undefined ? dispatching : unnamedTo(routes[unnamed]!, dispatching);

  // OUTSIDE the router, so a default model a state did not name is filled in BEFORE the prefix is read.
  return node.defaults === undefined ? router : withPromptDefaults(node.defaults, router);
}

/** Send a prompt that names no model to `only`; everything else dispatches as usual. */
function unnamedTo(only: StackedExecutor, dispatching: StackedExecutor): StackedExecutor {
  const route = only;
  const router = dispatching;
  const pick = (op: Operation<InlineFamily>): typeof route => {
    if (op.kind !== "prompt") return router;
    const config = isObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
    return typeof config["model"] === "string" && config["model"] !== "" ? router : route;
  };
  return {
    capabilities: router.capabilities,
    metrics: router.metrics,
    // Answered by whoever would answer the CALL, or a state's capabilities would be read off the
    // fallback while the work went somewhere else.
    ...(router.capabilitiesFor !== undefined || route.capabilitiesFor !== undefined
      ? {
          capabilitiesFor: (op: Operation<InlineFamily>) => {
            const target = pick(op);
            return target.capabilitiesFor?.(op) ?? target.capabilities;
          },
        }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => pick(op).start(op, ctx),
  };
}

/**
 * Fill an op's config from this node's defaults, on the way IN.
 *
 * The whole point is the ordering. `createPromptExecutor` takes a `defaults` layer and applies it
 * during lowering — inside the leaf, after routing has already happened. A default model stated
 * there can therefore never influence which route serves the call, so `models.default: "claude-cli/…"`
 * used to fall through to the provider path and be refused by a router that does not own that prefix.
 *
 * UNDER the state's own config, like every other defaulting layer here: a state that names a setting
 * keeps it.
 */
export function withPromptDefaults(
  defaults: Record<string, JsonValue>,
  inner: StackedExecutor,
): StackedExecutor {
  const executor = inner;
  // The SAME filling `start` does, so a question about a call is answered for the call that will
  // actually run. `capabilitiesFor` used to forward the op untouched, which asked the router about a
  // call with no model where `start` would dispatch one WITH the default's — two different routes
  // whenever the default names one the unnamed rule would not pick, and the engine then read a
  // provider's capability record for work an agent was about to do.
  const filled = (op: Operation<InlineFamily>): Operation<InlineFamily> => {
    if (op.kind !== "prompt") return op;
    const config = isObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
    return { ...op, config: { ...defaults, ...config } as JsonValue };
  };
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(filled(op)) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => executor.start(filled(op), ctx),
  };
}

/**
 * A node's model rules — which ids it may be asked for, and what it is asked for by default.
 *
 * `allow` REFUSES rather than substituting: quietly running a permitted model in place of a forbidden
 * one is invisible and can be an order of magnitude off in price. The placeholder is normalised to
 * the transport's own (`agent/default`), because a named `default` reaches a binary as a model called
 * `default`, which none of them has.
 */
function constrained(
  node: JairaProviderNode | JairaAgentNode,
  owner: string | undefined,
  inner: StackedExecutor,
): StackedExecutor {
  if (node.model === undefined && node.allow === undefined && node.defaults === undefined) return inner;
  const executor = inner;
  const prefix = owner === undefined ? "" : `${owner}/`;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      if (op.kind !== "prompt") return executor.start(op, ctx);
      const config = isObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
      const asked = typeof config["model"] === "string" ? config["model"] : "";
      const bare = prefix.length > 0 && asked.startsWith(prefix) ? asked.slice(prefix.length) : asked;
      const wantsDefault = bare === "" || bare === "default";
      const model = wantsDefault ? node.model : bare;

      if (node.allow !== undefined) {
        const only = node.allow.map((p) => `'${p}'`).join(", ");
        if (model === undefined) {
          return finishedHandle(
            permanentFailure<WorkflowMetrics>(
              `'${owner ?? "this route"}' is restricted to ${only}, and this state asked for its own default, ` +
                `which no list can vouch for. Name a model, or give this route a default.`,
            ),
          );
        }
        if (!node.allow.some((pattern) => matchesModel(pattern, model))) {
          return finishedHandle(
            permanentFailure<WorkflowMetrics>(
              `'${owner ?? "this route"}' is restricted to ${only}, and this state asked for '${model}'.`,
            ),
          );
        }
      }

      return executor.start(
        {
          ...op,
          config: {
            ...(node.defaults ?? {}),
            ...config,
            // Only when THIS node resolved one. Writing a placeholder here would be re-prefixed by
            // the provider-level wrapper underneath (`agent/default` becoming `claude-cli/agent/
            // default`), so the node that has no model to state says nothing and lets that layer —
            // which owns the placeholder — answer.
            ...(model === undefined ? {} : { model: `${prefix}${model}` }),
          } as JsonValue,
        },
        ctx,
      );
    },
  };
}

/**
 * The whole tree: dispatch on the kind of operation.
 *
 * The function half is the run's registry — a workflow's states decide what has to be registered, so
 * this only narrows it. The prompt half is everything above.
 */
export function buildExecutorTree(
  tree: JairaOperationNode,
  deps: TreeDeps,
): { executor: StackedExecutor; prompt: StackedExecutor; report: TreeReport } {
  const report: TreeReport = { stacks: {} };
  const promptTree = deps.securityFloor === undefined
    ? undefined
    : withSecurityFloor(deps.securityFloor, buildPromptTree(tree.prompt ?? { kind: "router" }, deps, report));
  const prompt = stacked(
    promptTree ?? deps.fakePrompt ?? buildPromptTree(tree.prompt ?? { kind: "router" }, deps, report),
    // A `fakePrompt` still gets the prompt node's steps: a scripted run has little to gain from a
    // cache, but silently dropping a configured step is how a wiring bug survives every test.
    deps.fakePrompt !== undefined ? tree.prompt?.steps : undefined,
    "prompt",
    deps,
    report,
  );

  // Guarded on the REGISTRY ITSELF rather than on `deps.registry`, which is the same condition stated
  // twice — `narrowedFunctions` returns undefined exactly when there is no registry. One guard means
  // the compiler can see it, which is what lets the dispatcher be built without a cast.
  const functions = narrowedFunctions(tree.function, deps);
  const operation = functions === undefined ? prompt : createOperationExecutor({ functions, prompt });

  return {
    executor: stacked(operation, tree.steps, "", deps, report),
    prompt,
    report,
  };
}

/**
 * The function registry, narrowed to what this node allows.
 *
 * A `has` that answers false is what makes the refusal legible: `FunctionExecutor` reports an
 * unregistered function by name, which is the same message a workflow naming a typo gets — and a
 * restriction that produced some other error would be a restriction nobody could diagnose.
 */
function narrowedFunctions(
  node: JairaFunctionNode | undefined,
  deps: TreeDeps,
): CapabilityRegistry<WorkflowMetrics>["functions"] | undefined {
  const functions = deps.registry?.functions;
  if (functions === undefined || node?.rules === undefined) return functions;
  const rules = node.rules;
  const permitted = (name: string): boolean => functionAllowed(rules, name);
  return {
    ...functions,
    has: (name: string) => permitted(name) && functions.has(name),
    get: (name: string) => (permitted(name) ? functions.get(name) : undefined),
  } as CapabilityRegistry<WorkflowMetrics>["functions"];
}

/** Wrap a node in its own steps, recording what the stack ended up being. */
function stacked(
  executor: StackedExecutor,
  steps: JairaExecutorSteps | undefined,
  path: string,
  deps: TreeDeps,
  report: TreeReport,
): StackedExecutor {
  if (steps === undefined) return executor;
  const built = composeExecutorStack(executor, { steps }, {
    name: path.length === 0 ? "executor" : path,
    ...(deps.memoCache !== undefined ? { memoCache: deps.memoCache } : {}),
  });
  report.stacks[path] = built.report;
  return built.executor;
}

/** A node that cannot be built refuses BY NAME, rather than being dropped into the fallback. */
function refusing(reason: string): StackedExecutor {
  return {
    // Stated rather than left empty. `{}` typechecked only behind the cast this used to carry, and a
    // node that advertises nothing is read by a gate as a node that permits everything.
    capabilities: { ...REFUSING_CAPS },
    metrics: { merge: mergeWorkflowMetrics, empty: emptyWorkflowMetrics },
    start: () => finishedHandle(permanentFailure(reason, emptyWorkflowMetrics())),
  };
}

/** A node that can only refuse: it runs nothing, so every capability is the conservative answer. */
const REFUSING_CAPS: RuntimeCapabilities = {
  structuredOutput: false,
  mutatesWorkspace: false,
  policyEnforcement: "none",
  sessionResume: false,
  streaming: false,
  interactive: false,
  readOnly: true,
  memoizable: false,
  runtime: "edge-safe",
};

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fold the project's security floor into every prompt call — OVER the state's own config.
 *
 * The opposite direction from {@link withPromptDefaults}, and the difference is the whole point. A
 * default is a value a state may replace; a floor is one it may not. `{...defaults, ...config}` lets
 * a state that authors `providerOptions` drop the compiled scope rules entirely — not even
 * deliberately, since `providerOptions` merges shallowly and a state setting an unrelated provider's
 * options would take ours with it.
 *
 * So this merges the other way and DEEPLY, down to the permission arrays: a state may add rules of
 * its own, and cannot remove the ones the project bounds it with.
 */
export function withSecurityFloor(
  floor: Record<string, JsonValue>,
  inner: StackedExecutor,
): StackedExecutor {
  const executor = inner;
  const filled = (op: Operation<InlineFamily>): Operation<InlineFamily> => {
    if (op.kind !== "prompt") return op;
    const config = isObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
    return { ...op, config: deepMergeOver(config, floor) as JsonValue };
  };
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(filled(op)) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => executor.start(filled(op), ctx),
  };
}

/**
 * `over` wins, object by object, and arrays UNION.
 *
 * Arrays union rather than replace because the arrays here are permission rule lists: a state adding
 * `deny: ["Bash"]` and a floor adding `deny: ["Read(/etc/**)"]` both mean their entry, and the
 * strictest posture is the one that keeps both. Replacement in either direction would silently drop
 * one of them.
 */
function deepMergeOver(base: Record<string, JsonValue>, over: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...new Set([...existing, ...value])] as JsonValue;
    } else if (isObject(existing) && isObject(value)) {
      out[key] = deepMergeOver(existing as Record<string, JsonValue>, value as Record<string, JsonValue>) as JsonValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}
