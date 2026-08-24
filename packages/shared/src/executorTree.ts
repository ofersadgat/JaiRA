/**
 * An executor, as a TREE — the configuration of every level, and the adaptive default underneath it.
 *
 * An executor in declarative-ai is a composition, not an object. `OperationExecutor` dispatches on
 * `op.kind` to a `FunctionExecutor` and a prompt executor; the prompt side is usually a
 * `PromptRouterExecutor` dispatching on the model's prefix to a `PromptExecutor` (a provider) or an
 * agent executor; and any of them can be wrapped in the cross-cutting steps of `./executorStack`.
 *
 * JaiRA hardcoded one instance of that tree, so none of it was configurable and none of it was
 * visible. This module is the tree as DATA — every level, each with its own settings.
 *
 * ## The two rules that make it usable
 *
 * **1. Absent means DERIVED, not empty.** What is stored is a sparse OVERLAY; the effective tree is
 * {@link resolveExecutorTree}, which builds the whole thing from what is actually available and then
 * lays the overlay on top. With an empty config the default executor is still a complete tree —
 * operation over function and a router over every provider and every configured agent.
 *
 * **2. A change pins only what changed.** Writing a rate limit onto the `anthropic` route stores
 * exactly that, so installing another agent tomorrow still adds a route by itself. The alternative —
 * materializing the resolved tree into `settings.json` on first edit — freezes today's answer into
 * everyone's configuration, and they never pick up a better one.
 *
 * That pair is why the settings screen can show the whole tree expanded while the file stays a few
 * lines: the screen renders the RESOLVED tree, and a write goes to the overlay.
 */
import type { Scope } from "./scopes";
import type { JsonValue } from "@declarative-ai/json";
import type { JairaExecutorSteps } from "./executorStack";

/** The levels of the hierarchy, by the upstream class each one builds. */
export type ExecutorNodeKind = "operation" | "function" | "router" | "provider" | "agent";

/** What every node has, whatever level it sits at. */
export interface JairaExecutorNodeBase {
  /**
   * The cross-cutting layers wrapped around THIS node (`./executorStack`).
   *
   * Per node rather than per executor, because that is where they belong: a rate limit on one
   * provider's route and a deadline on the whole tree are different statements, and one `steps` block
   * at the top could only make the coarser one.
   */
  steps?: JairaExecutorSteps;
  /**
   * WHERE anything running under this node may act — the scope table's floor (see `scopes.ts`).
   *
   * On the executor rather than in a key of its own because what an executor is allowed to touch is
   * a property of that executor: it inherits down the tree like every other node setting, and the
   * screen that configures an executor becomes the screen that bounds it. An operator writes
   * `/mnt/c/work/**` once and no workflow authored later can reach outside it.
   *
   * A state's `environment.permissions.scopes` narrows this; it can never widen it, for the same
   * reason a state cannot widen past its profile.
   */
  scopes?: Scope[];
}

/**
 * The top: dispatch on the KIND of operation.
 *
 * `OperationExecutor` is what a workflow actually runs against — a state is a prompt op or a function
 * op, and this is the thing that knows which. Its two children are the two halves.
 */
export interface JairaOperationNode extends JairaExecutorNodeBase {
  kind?: "operation";
  /** One line, for the settings screen and for a reader of the config. */
  description?: string;
  function?: JairaFunctionNode;
  prompt?: JairaPromptNode;
}

/**
 * The function half: registered functions — host code, human gates, delegated agents, tools.
 *
 * Its membership is the RUN's, not a setting: a workflow's states decide which functions have to be
 * registered, and the registry is assembled per run from what they name. What is configurable is
 * which of them this executor may REACH, which is a restriction rather than a definition.
 */
export interface JairaFunctionNode extends JairaExecutorNodeBase {
  kind?: "function";
  /**
   * ORDERED rules over the registry — `everything`, `nothing`, `+name`, `-name`, `*` glob.
   *
   * A rule list rather than an allow list, because the useful statements are subtractive. "Everything
   * the workflow registers, except the one that runs commands" is one rule after a baseline; as an
   * allow list it is a list of every function that exists, which has to be edited again every time a
   * workflow gains a state. Later rules win, so the list reads top to bottom like a firewall.
   *
   * Absent ⇒ everything, which is what a project that has never opened this screen should get.
   */
  rules?: string[];
}

/** How one rule reads: a baseline, or a signed pattern. */
export type FunctionRuleKind = "everything" | "nothing" | "allow" | "deny";

/** Parse one rule token. `undefined` for anything that is not a rule at all. */
export function parseFunctionRule(rule: string): { kind: FunctionRuleKind; pattern?: string } | undefined {
  const token = rule.trim();
  if (token === "everything" || token === "*") return { kind: "everything" };
  if (token === "nothing") return { kind: "nothing" };
  if (token.startsWith("+")) return { kind: "allow", pattern: token.slice(1).trim() };
  if (token.startsWith("-")) return { kind: "deny", pattern: token.slice(1).trim() };
  // A bare name is an ALLOW, so `read_file` and `+read_file` mean the same thing. Refusing it would
  // be pedantry about a sign nobody thinks to type first.
  return token.length > 0 ? { kind: "allow", pattern: token } : undefined;
}

/**
 * May this executor call that function?
 *
 * Walked in ORDER, last match winning, starting from "everything" — which is what an empty list
 * means and therefore the only baseline that keeps an unconfigured project working. A list whose
 * first rule is `nothing` is the deny-by-default form, and reads as one.
 */
export function functionAllowed(rules: string[] | undefined, name: string): boolean {
  if (rules === undefined || rules.length === 0) return true;
  let allowed = true;
  let stated = false;
  for (const rule of rules) {
    const parsed = parseFunctionRule(rule);
    if (parsed === undefined) continue;
    if (parsed.kind === "everything") {
      allowed = true;
      stated = true;
      continue;
    }
    if (parsed.kind === "nothing") {
      allowed = false;
      stated = true;
      continue;
    }
    if (parsed.pattern === undefined || !matchesGlob(parsed.pattern, name)) continue;
    allowed = parsed.kind === "allow";
    stated = true;
  }
  // A list of only `+` rules is an ALLOW LIST: nothing was said about anything else, so nothing else
  // is permitted. Reading it as "everything, plus these" would make `+read_file` a no-op.
  if (!stated) return !rules.some((r) => parseFunctionRule(r)?.kind === "allow");
  return allowed;
}

/** `*` matches any run of characters; everything else is literal. */
export function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * The functions JaiRA itself can register, for a form that would otherwise ask someone to type a
 * name from memory.
 *
 * Not exhaustive and it cannot be: a workflow registers a sub-workflow under its own state id, and
 * an agent under whatever name its config gives it. So this is a STARTING POINT the form offers
 * beside a free-text box, never a list the parser validates against — refusing a name because JaiRA
 * did not think of it would refuse every workflow's own states.
 */
export const BUILTIN_FUNCTIONS: Array<{ name: string; what: string }> = [
  { name: "choose_option", what: "human gate — pick one of several options" },
  { name: "review_artifact", what: "human gate — approve or reject a produced file" },
  { name: "edit_markdown", what: "human gate — edit a document before it continues" },
  { name: "fill_form", what: "human gate — supply structured input" },
  { name: "confirm_action", what: "human gate — a yes/no before something irreversible" },
  { name: "read_file", what: "tool — read a file from the workspace" },
  { name: "write_file", what: "tool — write a file into the workspace" },
  { name: "run_command", what: "tool — run a shell command, under the project's policy" },
];

export type JairaPromptNode = JairaRouterNode | JairaProviderNode | JairaAgentNode;

/** What every prompt-answering node carries: the call settings it supplies. */
export interface JairaPromptNodeBase extends JairaExecutorNodeBase {
  /**
   * The default LLM configuration this node supplies — merged UNDER a state's own config.
   *
   * On a ROUTER it is applied BEFORE dispatch, and that ordering is load-bearing rather than tidy.
   * `PromptRouterExecutor` dispatches on `op.config.model`, while a leaf's `defaults` are applied
   * inside its own lowering — so a default model held only at the leaf is invisible to the routing
   * that has to happen first. A state naming no model would fall through to the provider path and be
   * asked for `claude-cli/default` there, which the provider router cannot serve.
   */
  defaults?: Record<string, JsonValue>;
}

/**
 * Dispatch on the model id's PREFIX — the natural top of the prompt half.
 *
 * Its routes are the whole vocabulary: `anthropic` reaches a provider, `claude-cli` reaches an agent,
 * and a name of your own reaches whatever you configured under it. Absent routes are DERIVED from
 * what is available, so a fresh machine gets a router over everything without configuring one.
 */
export interface JairaRouterNode extends JairaPromptNodeBase {
  kind?: "router";
  /** prefix → the node it dispatches to. Merged over the derived routes, never replacing them. */
  routes?: Record<string, JairaPromptNode>;
  /**
   * Where an id whose prefix names no route goes. Absent ⇒ the provider path, which owns every prefix
   * `MODEL_ROUTE_KEYS` knows and produces the authoritative error for one it does not.
   */
  fallback?: JairaPromptNode;
}

/**
 * One provider route — `PromptExecutor` over `ModelRouter`.
 *
 * `kind` is OPTIONAL, and that is the point of the routes map: a node under `routes.anthropic` is a
 * provider because the prefix it sits under is one, so writing it down would be writing down the
 * obvious. Resolution supplies it from what was derived for that prefix.
 */
export interface JairaProviderNode extends JairaPromptNodeBase {
  kind?: "provider";
  /** The route prefix. Implied by the routes key it sits under, and statable for a bare node. */
  provider?: string;
  /** The model, as the provider knows it — bare, because the prefix is the provider. */
  model?: string;
  /** Patterns the asked-for model must match. Absent ⇒ anything. */
  allow?: string[];
}

/** One agent runtime — an SDK, a CLI, codex, a configured generic. `kind` is optional for the same
 *  reason a provider's is: under a routes key, the prefix already says which it is. */
export interface JairaAgentNode extends JairaPromptNodeBase {
  kind?: "agent";
  /** The registry name. Implied by the routes key it sits under. */
  agent?: string;
  model?: string;
  allow?: string[];
}

/** What is installed and reachable, which is what a derived tree is derived FROM. */
export interface ExecutorAvailability {
  /** Model-route prefixes that can serve a call — `anthropic`, `local`, … */
  providers: string[];
  /** Agent runtimes that are enabled and working — `claude-cli`, … */
  agents: string[];
}

/** The name of the executor every UI-initiated operation uses when nothing says otherwise. */
export const DEFAULT_EXECUTOR = "default";

// --- resolution --------------------------------------------------------------

/**
 * The tree a run actually gets: derived from what is available, with the overlay laid on top.
 *
 * Every field of the result is present, which is what lets a settings screen render the whole thing;
 * {@link isPinned} answers which of them the overlay states, which is what lets it mark them.
 *
 * The derived shape is deliberately the one JaiRA already built by hand — an operation executor over
 * a function executor and a router over everything — so turning it into configuration changes what
 * can be SAID, not what happens by default.
 */
export function resolveExecutorTree(
  overlay: JairaOperationNode | undefined,
  available: ExecutorAvailability,
): JairaOperationNode {
  const node = overlay ?? {};
  return {
    kind: "operation",
    ...(node.description !== undefined ? { description: node.description } : {}),
    function: { kind: "function", ...(node.function ?? {}) },
    prompt: resolvePromptNode(node.prompt, available),
    ...(node.steps !== undefined ? { steps: node.steps } : {}),
  };
}

/**
 * One prompt node, resolved.
 *
 * A node that states its `kind` is taken at its word — someone who pinned the prompt half to a single
 * agent meant to, and deriving a router around it would be overruling them. Anything else becomes the
 * router, because that is the only shape that can reach everything.
 */
function resolvePromptNode(node: JairaPromptNode | undefined, available: ExecutorAvailability): JairaPromptNode {
  if (node?.kind === "provider") return { ...node, kind: "provider" };
  if (node?.kind === "agent") return { ...node, kind: "agent" };

  const router = (node ?? {}) as JairaRouterNode;
  const routes: Record<string, JairaPromptNode> = {};
  // Derived first, so an overlay entry REFINES a route rather than replacing the set. That is the
  // whole adaptive property: pinning a rate limit on one provider must not stop a newly installed
  // agent from getting a route tomorrow.
  for (const provider of available.providers) routes[provider] = { kind: "provider", provider };
  for (const agent of available.agents) routes[agent] = { kind: "agent", agent };
  for (const [prefix, override] of Object.entries(router.routes ?? {})) {
    routes[prefix] = mergePromptNode(routes[prefix], override, prefix, available);
  }

  return {
    kind: "router",
    routes,
    // The fallback is the provider path unless something says otherwise: it owns every prefix the
    // model-route vocabulary knows, and produces the authoritative error for one it does not.
    fallback: router.fallback === undefined ? { kind: "provider" } : resolvePromptNode(router.fallback, available),
    ...(router.defaults !== undefined ? { defaults: router.defaults } : {}),
    ...(router.steps !== undefined ? { steps: router.steps } : {}),
  };
}

/**
 * Can this node answer a state that names no model?
 *
 * An AGENT can: it picks its own, which is what makes a subscription CLI runnable with nothing
 * configured at all. A provider cannot unless the route was given a `model` — a remote fleet has no
 * default, and asking one for a model called "default" is asking for a model that does not exist.
 */
function answersUnnamed(node: JairaPromptNode): boolean {
  // An `allow` list with no model of its own answers NOTHING unnamed: `constrained` refuses a call
  // that asked for the route's default because no list can vouch for a model it was never told. Saying
  // otherwise here let a run START and then fail permanently at its first prompt — which is exactly
  // the failure the start-time check exists to catch.
  const model = (node as JairaProviderNode).model;
  if (node.kind === "agent") return model !== undefined || (node as JairaAgentNode).allow === undefined;
  return model !== undefined;
}

/**
 * Which route a call that names no model goes to — the first that can answer one.
 *
 * A prefix is how a call CHOOSES a route, and a call that names no model has not chosen. Dispatching
 * it anyway sends it to the fallback, which is the provider path: a machine with `claude` installed
 * and no API key sent every unnamed state to a provider it has no key for, and was told "model must be
 * a non-empty string" from four layers down.
 *
 * So the router is free to answer it with anything that can, and takes the first. "First" is meant:
 * the derived order is providers then agents, and a route somebody gave a model to therefore wins over
 * an agent that picks its own — which is the only preference in here that anyone stated.
 *
 * This is a decision the router MAKES rather than a default written into the tree. A `<prefix>/default`
 * synthesized into `defaults.model` would answer the same call and would then sit on the settings
 * screen looking like a choice somebody made, and would go stale the moment another route appeared.
 */
export function unnamedRouteOf(routes: Record<string, JairaPromptNode> | undefined): string | undefined {
  return Object.entries(routes ?? {}).find(([, node]) => answersUnnamed(node))?.[0];
}

/**
 * Will this prompt half answer a state that names no model — and if not, why not?
 *
 * Every workflow JaiRA ships is written without model ids, deliberately, so it runs on whatever a
 * machine has. This is the question that has to be answerable BEFORE such a run starts, because the
 * failure otherwise surfaces as an empty model from inside a provider SDK, several layers under the
 * state that asked.
 *
 * Three ways it is yes: a leaf that picks its own model, a router with a route that does, or a router
 * carrying a stated default that says which route to use.
 */
export function unnamedModelAnswer(
  node: JairaPromptNode | undefined,
): { answers: true } | { answers: false; routes: string[]; pinned?: string } {
  if (node === undefined) return { answers: false, routes: [] };
  if (node.kind === "provider" || node.kind === "agent") {
    if (answersUnnamed(node)) return { answers: true };
    const pinned = (node as JairaProviderNode).provider ?? (node as JairaAgentNode).agent;
    return { answers: false, routes: [], ...(pinned !== undefined ? { pinned } : {}) };
  }
  const router = node as JairaRouterNode;
  if (router.defaults?.["model"] !== undefined) return { answers: true };
  if (unnamedRouteOf(router.routes) !== undefined) return { answers: true };
  return { answers: false, routes: Object.keys(router.routes ?? {}) };
}

/**
 * Lay one route's override over what was derived for it.
 *
 * The derived node supplies the identity — which provider or agent this prefix IS — and the override
 * supplies everything else. A route the overlay invents (a prefix nothing derived) is taken whole,
 * which is how a project names an executor of its own.
 */
function mergePromptNode(
  derived: JairaPromptNode | undefined,
  override: JairaPromptNode,
  prefix: string,
  available: ExecutorAvailability,
): JairaPromptNode {
  if (override.kind === "router") return resolvePromptNode(override, available);
  if (derived === undefined) {
    // Nothing derived this prefix, so the overlay is declaring it. Without a stated kind there is
    // nothing to build, and guessing between a provider and an agent would be guessing at which
    // transport a call reaches — so it is left as authored and the parser is what refuses it.
    return { ...override, ...(override.kind === undefined ? {} : { kind: override.kind }) } as JairaPromptNode;
  }
  return { ...derived, ...override, kind: override.kind ?? derived.kind } as JairaPromptNode;
}

/**
 * Does the overlay STATE this path, or is the value derived?
 *
 * `path` is dotted, relative to the executor node (`prompt.routes.anthropic.steps.rateLimit.rpm`).
 * The settings screen marks a pinned field so "the shared root says this" and "I pinned this" are
 * distinguishable — which is the difference between a value that will follow a better default and one
 * that never will again.
 */
export function isPinned(overlay: JairaOperationNode | undefined, path: string): boolean {
  let cursor: unknown = overlay;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return false;
  }
  return true;
}

/**
 * Write one dotted path into the overlay, returning a NEW overlay. `undefined` un-pins it.
 *
 * Un-pinning is the operation the whole design turns on: clearing a box does not write an empty
 * value, it REMOVES the override so the field goes back to being derived — and a container the
 * removal emptied goes with it, so an untouched branch leaves no trace in the file.
 */
export function pin(
  overlay: JairaOperationNode | undefined,
  path: string,
  value: unknown,
): JairaOperationNode {
  const next = structuredClone(overlay ?? {}) as Record<string, unknown>;
  const parts = path.split(".");
  const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor = next;
  for (const part of parts.slice(0, -1)) {
    const held = cursor[part];
    cursor[part] = held !== null && typeof held === "object" && !Array.isArray(held) ? { ...(held as object) } : {};
    chain.push({ parent: cursor, key: part });
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;

  for (const { parent, key } of chain.reverse()) {
    const block = parent[key];
    if (block !== null && typeof block === "object" && !Array.isArray(block) && Object.keys(block).length === 0) {
      delete parent[key];
    }
  }
  return next as JairaOperationNode;
}

// --- the hierarchy, as data --------------------------------------------------

export interface ExecutorNodeSpec {
  kind: ExecutorNodeKind;
  title: string;
  /** What this level IS, addressed to someone reading the tree for the first time. */
  hint: string;
  /** The upstream class it builds, so the screen and the code name the same thing. */
  builds: string;
  /** Whether a settings screen may change what this level is. */
  configurable: boolean;
}

/**
 * Every level, in the order they nest.
 *
 * `function` is marked NOT configurable, and that is a statement rather than an omission: a run's
 * function registry is assembled from what its states name — interactive gates, agent runtimes,
 * tools — so "which functions exist" is not a setting. What IS configurable is which of them this
 * executor may reach, which the node's `allow` says.
 */
export const EXECUTOR_NODES: ExecutorNodeSpec[] = [
  {
    kind: "operation",
    title: "Operation",
    hint: "The top. Dispatches on the KIND of operation a state runs — a prompt, or a registered function — and holds one executor for each.",
    builds: "OperationExecutor",
    configurable: false,
  },
  {
    kind: "function",
    title: "Functions",
    hint: "Host code, human gates, delegated agents and tools. Which of them EXIST is the run's business — a workflow's states decide that — so what is settable here is which this executor may reach.",
    builds: "FunctionExecutor",
    configurable: true,
  },
  {
    kind: "router",
    title: "Router",
    hint: "Dispatches a prompt on its model id's PREFIX. Its routes are derived from everything available, so a provider or agent you set up appears here without being added.",
    builds: "PromptRouterExecutor",
    configurable: true,
  },
  {
    kind: "provider",
    title: "Provider",
    hint: "One serving route — a remote fleet, a local server, embedded weights — reached through the model router.",
    builds: "PromptExecutor",
    configurable: true,
  },
  {
    kind: "agent",
    title: "Agent",
    hint: "One agent runtime, answering the prompt by running rather than by returning a completion.",
    builds: "AgentApiExecutor / AgentCliExecutor / AgentCodexExecutor",
    configurable: true,
  },
];

export function executorNode(kind: string): ExecutorNodeSpec | undefined {
  return EXECUTOR_NODES.find((n) => n.kind === kind);
}
