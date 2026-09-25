/**
 * Who answers a prompt state — resolved from config, keyed by the model id's route prefix.
 *
 * A model id has always named its serving route (`anthropic/claude-sonnet-5`). What changed upstream
 * is that the prefix can now name an EXECUTOR rather than a provider: `claude-cli/sonnet` sends the
 * call to the CLI agent, which runs on its own subscription and needs no API key. That single fact is
 * what makes a prompt-only workflow runnable on a machine that has `claude` installed and nothing
 * else — which is the case JaiRA's own sync workflow was failing in.
 *
 * This module is the config half of it, and nothing more:
 *
 *  - {@link modelRouterOptions} turns `config.models.routes` into declarative-ai's
 *    `ModelRouterOptions`, RESOLVING each route's named credential through the secret chain. That
 *    closes a real gap: `createModelRouter()` used to be called with no options at all, so it fell
 *    back to `process.env` and a key stored in the OS keychain or a `.env.local` never reached the
 *    provider at all.
 *  - {@link agentPromptRoutes} builds one agent executor per enabled agent, keyed by the registry name
 *    it already has — so `claude-cli` is the same word in `models.default` and in a state's `function`.
 *  - {@link defaultModelId} answers "with nothing configured, what should run?" — the "if several are
 *    available, just pick one" rule, made explicit and reportable rather than left to a refusal.
 *
 * It deliberately does NOT re-implement provider routing. `ModelRouter` already dispatches
 * `anthropic`/`openrouter`/`local`/`embedded` with lazy client construction, per-server caching and
 * managed-server supervision; this hands it its options and stays out of the way.
 */
import { existsSync, statSync } from "node:fs";
import { keyForModel, ModelInfo } from "@declarative-ai/llm";
import type { EmbeddedModelConfig, LocalServerConfig, ModelRouterOptions } from "@declarative-ai/llm";
import { AGENT_DEFAULT_MODEL, AgentApiExecutor, type AgentQuery } from "@declarative-ai/agents-api";
import { AgentCliExecutor, AgentCodexExecutor, type ConnectMcpServer, type SpawnProcess, type StartMcpBridge } from "@declarative-ai/agents-cli";
import {
  type ExecServices,
  type Executor,
  type InlineFamily,
  type JsonValue,
  type Operation,
  type PromptOp,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { LlmMetrics } from "@declarative-ai/llm";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  MODEL_ROUTE_KEYS,
  type JairaAgentConfig,
  type JairaExecutorDefinition,
  type JairaModelConfig,
  type EmbeddedWeightsReport,
  type JairaModelRoute,
  type ProbeResult,
  type SecretOrigin,
  type WeightsFileCheck,
} from "@jaira/shared";
import { AGENT_CLI, AGENT_CODEX, AGENT_SDK, agentSpawn } from "./agents";
import { observeAgentRoute, type AgentOutcomeObserver } from "./agentOutcome";
import { CLAUDE_TOOLS, CODEX_TOOLS, CODEX_WRITE_SWITCH, GENERIC_CLI_TOOLS, permissionSetViewOf, withAgentPermissionSet } from "./agentTools";
import { mcpServersIn, mcpServersOfCall, type ResolvedMcpServer } from "./mcpServers";
import { AGENT_GENERIC_CLI, createGenericCliQuery, GENERIC_CLI_CAPS } from "./genericAgent";
import { defaultResolve, enabledAdapters, enabledGenericAgents } from "./executors";
import type { Exec } from "./exec";
import type { ExecEnv } from "./paths";
import type { ExecObserver } from "./exec";
import type { SecretResolver } from "./secrets";

/** An executor that can answer a prompt op — what a route resolves to. */
export type PromptRoute = Executor<ExecServices, WorkflowMetrics>;

/** Enabled unless config says otherwise — a project that configures nothing gets everything. */
function isEnabled(route: JairaModelRoute | undefined): boolean {
  return route?.enabled !== false;
}

/**
 * `config.models.routes` → `ModelRouterOptions`, with credentials resolved.
 *
 * The value never leaves this process: `SecretResolver.lookup` is called here, in the main process,
 * and what crosses IPC to any UI is only the ORIGIN (`describe`). A route naming no credential falls
 * back on the CONVENTIONAL variable, resolved through the same chain — see {@link remoteKeyFor} for
 * why asking the chain rather than leaving it to the SDK is the whole point.
 */
export function modelRouterOptions(models: JairaModelConfig = {}, secrets?: SecretResolver): ModelRouterOptions {
  const routes = models.routes ?? {};
  const options: ModelRouterOptions = {};
  /**
   * This route's key, resolved — from the credential it NAMES, or from the conventional variable.
   *
   * The second half was missing, and the gap it left is the one that took the longest to see. A
   * route naming no credential was "left alone rather than defaulted, so the SDK's own `process.env`
   * fallback still applies" — but {@link routeUsable} does NOT ask `process.env`. It asks the secret
   * CHAIN for the same conventional variable, and the chain reads a keychain and four `.env` files
   * the SDK has never heard of.
   *
   * So the two halves disagreed exactly where it hurt: a key in `.env.local` made the route count as
   * usable, the route was derived, a call dispatched to it — and the provider, handed no key and
   * looking only at `process.env`, failed with `AI_LoadAPIKeyError` in four milliseconds. Judging a
   * route by one source and serving it from another is the bug; asking the chain in both places is
   * the fix, and it leaves the `process.env` case working because the chain's last link IS the
   * environment.
   */
  const keyFor = (route: JairaModelRoute | undefined): string | undefined =>
    route?.credential === undefined ? undefined : secrets?.lookup(route.credential)?.value;

  /**
   * One REMOTE route's key, by its route name — which is what carries the conventional variable.
   *
   * Read off `routes[key]` rather than a pre-filtered local, because `isEnabled(x) ? x : undefined`
   * spells "turned off" and "never configured" the same way, and here they are opposites: a route
   * nobody configured should still find `ANTHROPIC_API_KEY`, and one somebody turned OFF must not.
   * Collapsing them handed a disabled route its key — caught by the test that says so.
   */
  const remoteKeyFor = (key: string): string | undefined => {
    const route = routes[key];
    if (!isEnabled(route)) return undefined;
    const name = route?.credential ?? ROUTE_ENV_VAR[key];
    return name === undefined ? undefined : secrets?.lookup(name)?.value;
  };

  const anthropicKey = remoteKeyFor("anthropic");
  if (anthropicKey !== undefined) options.anthropicApiKey = anthropicKey;

  const openai = isEnabled(routes["openai"]) ? routes["openai"] : undefined;
  const openAiKey = remoteKeyFor("openai");
  if (openAiKey !== undefined) options.openAiApiKey = openAiKey;
  // A base URL is a legitimate thing to set on this route rather than a local-only idea: Azure
  // OpenAI and every gateway in front of it speak the same protocol, so pointing the route at one
  // is configuration rather than a route of its own.
  if (openai?.baseURL !== undefined) options.openAiBaseURL = openai.baseURL;

  const openRouterKey = remoteKeyFor("openrouter");
  if (openRouterKey !== undefined) options.openRouterApiKey = openRouterKey;

  const local = isEnabled(routes["local"]) ? routes["local"] : undefined;
  if (local?.baseURL !== undefined) {
    const server: LocalServerConfig = {
      baseURL: local.baseURL,
      ...(keyFor(local) !== undefined ? { apiKey: keyFor(local)! } : {}),
      ...(local.headers !== undefined ? { headers: local.headers } : {}),
      ...(local.supportsStructuredOutputs !== undefined ? { supportsStructuredOutputs: local.supportsStructuredOutputs } : {}),
      ...(local.serve !== undefined
        ? {
            serve: {
              command: local.serve.command,
              ...(local.serve.args !== undefined ? { args: local.serve.args } : {}),
              ...(local.serve.env !== undefined ? { env: local.serve.env } : {}),
              ...(local.serve.readyUrl !== undefined ? { readyUrl: local.serve.readyUrl } : {}),
              ...(local.serve.readyTimeoutMs !== undefined ? { readyTimeoutMs: local.serve.readyTimeoutMs } : {}),
            },
          }
        : {}),
    };
    options.local = server;
  }

  const embedded = isEnabled(routes["embedded"]) ? routes["embedded"] : undefined;
  if (embedded?.weights !== undefined) {
    const weights = embedded.weights;
    // A RESOLVER rather than one config, so a project can name several sets of weights and each model
    // id gets its own. Returning `undefined` refuses an unconfigured id BY NAME, which is what the
    // router turns into a legible error instead of loading whichever GGUF happened to be first.
    options.embedded = (providerId: string): EmbeddedModelConfig | undefined => {
      const w = weights[providerId];
      return w === undefined
        ? undefined
        : {
            modelPath: w.modelPath,
            ...(w.contextSize !== undefined ? { contextSize: w.contextSize } : {}),
            ...(w.gpuLayers !== undefined ? { gpuLayers: w.gpuLayers } : {}),
            ...(w.sequences !== undefined ? { sequences: w.sequences } : {}),
          };
    };
  }
  return options;
}

export interface AgentRouteOptions {
  execEnv?: ExecEnv;
  observer?: ExecObserver;
  exec?: Exec;
  /**
   * Replace the transport, for a test that drives the same executors with no binary.
   *
   * The same seam `registerAgentRuntimes` takes, and for the same reason: a fake query keeps every
   * bit of the executor — the tool split, the session shaping, the result mapping — and stands in
   * only for the SDK or the subprocess, which is the half a test cannot have.
   */
  query?: AgentQuery;
  /**
   * Replace the PROCESS seam the CLI executors spawn through — the same option
   * {@link AgentRuntimeOptions.spawn} is, one level down from {@link AgentRouteOptions.query}.
   *
   * A fake query stands in for the whole transport; a fake spawn keeps the real argv building and the
   * real stream parsing and stands in only for the binary, which is the half worth testing for a CLI
   * agent. Absent ⇒ JaiRA's own spawn, which is what production always wants.
   */
  spawn?: SpawnProcess;
  /** The bridge seam, the same one {@link AgentRuntimeOptions.startBridge} is: the persistent
   *  worker-hosted listener in production, upstream's per-run bridge when absent. */
  startBridge?: StartMcpBridge;
  /** How codex's bridge connects to a configured MCP server it proxies — upstream's MCP SDK client
   *  when absent; a probe stands in for the server with it. */
  connectMcpServer?: ConnectMcpServer;
  /** Hears every agent call's outcome — the same observer {@link AgentRuntimeOptions.onOutcome} is. */
  onOutcome?: AgentOutcomeObserver;
  /**
   * The configured MCP servers that are on, their secrets looked up (`resolveMcpServers`) — handed to
   * claude and codex on every call, less a server the call's permission set refuses outright
   * (`./mcpServers`). A generic CLI is handed none: JaiRA knows no way to tell one.
   */
  mcpServers?: Record<string, ResolvedMcpServer>;
}

/**
 * One prompt executor per ENABLED agent, keyed by the registry name it already uses.
 *
 * Keyed by the same word a state's `operation.function` names on purpose: `claude-cli` should mean one
 * thing whether it appears as a function reference or as a model prefix. Two spellings for one runtime
 * is exactly the kind of drift a settings screen then has to explain.
 *
 * Every CLI executor gets JaiRA's own spawn, for the same two reasons the function adapters do: it maps
 * the argv into the project's execution environment (a WSL project runs its agent inside the distro),
 * and it records the process as a job so an abandoned one is findable.
 */
export function agentPromptRoutes(agents: JairaAgentConfig = {}, options: AgentRouteOptions = {}): Record<string, PromptRoute> {
  const routes: Record<string, PromptRoute> = {};
  const commands: Record<string, string | undefined> = { [AGENT_CLI]: agents.claudeCli?.command, [AGENT_CODEX]: agents.codex?.command };
  const bind = (name: string, executor: PromptRoute): void => {
    routes[name] = normaliseAgentModel(name, observeAgentRoute(name, executor, options.onOutcome, commands[name]));
  };
  const adapters = enabledAdapters(agents);
  const spawn =
    options.spawn ??
    agentSpawn({
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(options.observer !== undefined ? { observer: options.observer } : {}),
    });
  const query = options.query;
  // The servers each call is handed, read off the call's permission set. Codex's are started by its
  // bridge, in THIS process, so a WSL project's stdio servers are handed over as the distro runs them.
  const claudeServers = mcpServersOfCall(options.mcpServers ?? {}, permissionSetViewOf);
  const codexServers = mcpServersOfCall(mcpServersIn(options.mcpServers ?? {}, options.execEnv), permissionSetViewOf);

  // EVERY agent route is held to the permission set of each call it answers (decision 0007 §3): the
  // executor's own declaration says which natives it has and what channel a permission set reaches it by,
  // and `withAgentPermissionSet` applies the plan where the route is finally known.
  if (adapters.includes("sdk")) {
    bind(
      AGENT_SDK,
      withAgentPermissionSet(
        CLAUDE_TOOLS,
        new AgentApiExecutor({ ...(query !== undefined ? { query } : {}), ...(claudeServers !== undefined ? { mcpServers: claudeServers } : {}) }),
        { label: AGENT_SDK },
      ),
    );
  }
  if (adapters.includes("cli")) {
    bind(
      AGENT_CLI,
      withAgentPermissionSet(
        CLAUDE_TOOLS,
        new AgentCliExecutor({
          spawn,
          ...(agents.claudeCli?.command !== undefined ? { command: agents.claudeCli.command } : {}),
          ...(options.startBridge !== undefined ? { startBridge: options.startBridge } : {}),
          ...(query !== undefined ? { query } : {}),
          ...(claudeServers !== undefined ? { mcpServers: claudeServers } : {}),
        }),
        { label: AGENT_CLI },
      ),
    );
  }
  if (adapters.includes("codex")) {
    // Codex's one channel is its sandbox, and the sandbox is fixed when the executor is built — so
    // there is one executor per setting of the switch, and the permission set picks. `permissionMode: "plan"`
    // is nothing but `--sandbox read-only` on this transport (`sandboxFor`), and an explicit mode
    // outranks everything else the executor would read.
    //
    // The MCP servers are not a reason for another executor: they are read off each call, and codex's
    // bridge proxies them, putting every call to the gate before it is forwarded — so a tool's line is
    // answered at the call, whatever it says, and nothing about them is fixed at construction.
    const codex = (readOnly: boolean): AgentCodexExecutor =>
      new AgentCodexExecutor({
        spawn,
        ...(agents.codex?.command !== undefined ? { command: agents.codex.command } : {}),
        ...(agents.codex?.sandbox !== undefined ? { sandbox: agents.codex.sandbox } : {}),
        ...(options.startBridge !== undefined ? { startBridge: options.startBridge } : {}),
        ...(options.connectMcpServer !== undefined ? { connectMcpServer: options.connectMcpServer } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(readOnly ? { permissionMode: "plan" as const } : {}),
        ...(codexServers !== undefined ? { mcpServers: codexServers } : {}),
      });
    const writing = codex(false);
    const reading = codex(true);
    bind(
      AGENT_CODEX,
      withAgentPermissionSet(CODEX_TOOLS, writing, {
        label: AGENT_CODEX,
        switched: (switches) => (switches[CODEX_WRITE_SWITCH] === false ? reading : writing),
      }),
    );
  }
  for (const spec of enabledGenericAgents(agents)) {
    // A generic CLI has no adapter of its own — it IS the `AgentQuery` JaiRA builds for it, which is
    // the same seam the built-ins are driven through. Its CAPABILITIES are its own, though, and they
    // must be stated: left to `AgentCliExecutor`'s default this route advertised `policyEnforcement:
    // "callback"` — claude's record, for a binary with no callback — and a capability gate reading
    // the route believed a restricted state could run here enforced. `GENERIC_CLI_CAPS` is the same
    // honest record the function-path registration has always declared, and `approvalCallback: false`
    // is its runtime half: there is no channel to route an approver through, so one must not be built.
    bind(
      spec.name ?? AGENT_GENERIC_CLI,
      // It declares no tools and no channel, so a permission set that refuses anything is refused here —
      // what the engine's own rule did for a narrowing profile, now that there is no profile.
      withAgentPermissionSet(
        GENERIC_CLI_TOOLS,
        new AgentCliExecutor({
          label: spec.name ?? AGENT_GENERIC_CLI,
          capabilities: GENERIC_CLI_CAPS,
          approvalCallback: false,
          query:
            query ??
            createGenericCliQuery(spec, {
              ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
              ...(options.exec !== undefined ? { exec: options.exec } : {}),
            }),
        }),
        { label: spec.name ?? AGENT_GENERIC_CLI },
      ),
    );
  }
  return routes;
}

/**
 * Normalise the "your own default" placeholder for one agent route.
 *
 * All that survives of the old per-agent model block, and it is not configuration — it is a fix.
 * `<agent>/default` is a named route default, not a provider-native model: the transport maps it to
 * no `--model` flag, which is the zero-configuration path a fresh machine produces and so has to
 * work. The ROUTE is kept in front of it — rather than handing over the transport's own generic
 * placeholder — because a conversation's remote identity is a handle PAIRED with the provider that
 * minted it, and that provider is read off this id: collapsing every agent to one name would let a
 * codex call be offered a claude handle.
 *
 * It is a request, not a record. What a settled call carries is the model the agent reports it
 * actually used (`AgentExecutor.resolvedModel` substitutes it), because a persisted model id is read
 * back as a fact — by a price table, by a session's provider half, by a person reading the record —
 * and `default` answers all three wrong.
 *
 * The limits that used to live here moved to the executor tree's route node, which is what they are
 * about: a limit on a route, not on the binary underneath it.
 */
export function normaliseAgentModel(name: string, inner: PromptRoute): PromptRoute {
  const executor = inner;
  const prefix = `${name}/`;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      if (op.kind !== "prompt") return executor.start(op, ctx);
      const config = isPlainObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
      const asked = typeof config["model"] === "string" ? config["model"] : "";
      const bare = asked.startsWith(prefix) ? asked.slice(prefix.length) : asked;
      if (bare !== "" && bare !== "default") return executor.start(op, ctx);
      return executor.start({ ...op, config: { ...config, model: `${name}/default` } as JsonValue }, ctx);
    },
  };
}

/**
 * Re-exported, not defined here: {@link matchesModel} moved to `@jaira/shared` when the routing that
 * reads an `allow` list moved there too. It stays exported from this module because it has always
 * been part of `@jaira/runtime`'s surface, and a move is not a reason to break an import.
 */
export { matchesModel } from "@jaira/shared";

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The environment variable a remote route's key is read from when config names no credential.
 *
 * These are the provider SDKs' OWN variables, which is what makes checking them honest: with no
 * `credential` configured the SDK reads exactly this, so its presence is the difference between a
 * route that works and one that fails on its first call.
 */
const ROUTE_ENV_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * A remote route's key, as an ORIGIN — resolved through the chain, or from the conventional variable.
 *
 * Two paths because there are two setups and both are legitimate: a project that NAMES a secret gets
 * it looked up wherever it lives (keychain, `.env.local`, …), and a project that names nothing falls
 * back on the SDK's own variable. Reporting "no key" for the second would be reporting a failure for
 * the commonest working configuration there is.
 */
function routeKeyOrigin(
  key: string,
  route: JairaModelRoute | undefined,
  secrets: SecretResolver | undefined,
): { found: boolean; named?: string; origin?: SecretOrigin; variable: string } {
  const variable = ROUTE_ENV_VAR[key] ?? "";
  if (route?.credential !== undefined) {
    const origin = secrets?.describe(route.credential);
    return origin === undefined
      ? { found: false, named: route.credential, variable }
      : { found: true, named: route.credential, origin, variable };
  }
  const origin = secrets?.describe(variable);
  if (origin !== undefined) return { found: true, origin, variable };
  return { found: secrets === undefined && process.env[variable] !== undefined, variable };
}

/**
 * Is this provider route actually usable — cheaply, without a request?
 *
 * Cheap is the requirement, not a shortcut: this runs on every run to decide what to install, and a
 * probe that spawned a process or opened a socket would make starting a workflow pay for a health
 * check nobody asked for. So: a key that resolves, an endpoint that is configured, weights that
 * exist on disk. Anything needing a socket is {@link probeModelRoutes}'s job.
 *
 * `existsSync` is the one filesystem call here, and it earns its place: a `modelPath` pointing at a
 * GGUF that is not there is indistinguishable from a working route until the loader fails minutes
 * into a run, and a stat is cheaper than every other thing this function already does.
 */
function routeUsable(key: string, route: JairaModelRoute | undefined, secrets: SecretResolver | undefined): boolean {
  if (!isEnabled(route)) return false;
  if (key === "local") return route?.baseURL !== undefined;
  if (key === "embedded") return namedWeights(route).some(([, w]) => existsSync(w.modelPath));
  // A remote fleet needs a key. A named credential must RESOLVE — config naming a secret nobody has
  // set is precisely the case that used to fail deep inside the provider SDK instead of here.
  return routeKeyOrigin(key, route, secrets).found;
}

/** A route's weights as entries, so "how many" and "which files" are one traversal. */
function namedWeights(route: JairaModelRoute | undefined): Array<[string, { modelPath: string }]> {
  return Object.entries(route?.weights ?? {});
}

/**
 * Which provider routes can actually serve a call — the routes a derived tree is built from.
 *
 * This replaced `defaultModelId`, which answered a different and worse question: *what one model id
 * should a state get?* A single id could never route to an agent, because `PromptRouterExecutor`
 * dispatches on `op.config.model` while a leaf's defaults are applied after routing — so a chosen
 * `claude-cli/…` fell through to the provider path and was refused there. What a state with no model
 * needs is a default EXECUTOR that can route, and `resolveExecutorTree` builds one from this list.
 */
export function usableRouteKeys(models: JairaModelConfig = {}, secrets?: SecretResolver): string[] {
  const routes = models.routes ?? {};
  return MODEL_ROUTE_KEYS.filter((key) => routeUsable(key, routes[key], secrets));
}

/**
 * Health-check the configured provider routes without calling one.
 *
 * There is no `--version` for a route and no free endpoint to poke, so this reports exactly what can
 * be observed for nothing — and says `not-checked` where that is nothing at all. Pressing Test must
 * never start a generation, which is the same rule {@link probeExecutor} follows for a binary.
 *
 * Every route is listed, configured or not, for the reason the built-in executors are: the list is
 * what the settings screen renders, and a route you have not set up yet has to be visible or there is
 * nowhere to set it up.
 */
export async function probeModelRoutes(
  models: JairaModelConfig = {},
  options: RouteProbeOptions = {},
): Promise<ProbeResult[]> {
  const routes = models.routes ?? {};
  return Promise.all(MODEL_ROUTE_KEYS.map((key) => probeOneRoute(key, routes[key], options)));
}

export interface RouteProbeOptions {
  secrets?: SecretResolver;
  /** Injected so a test can answer a server without one. Defaults to the global `fetch`. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  /**
   * Injected for the same reason. Absent, a weights file is STAT'd (`node:fs`'s `statSync`), which
   * says its size too; given, it is the whole of the check and no size is reported.
   */
  exists?: (path: string) => boolean;
  /** How a weights file is stat'd when `exists` is not injected. Defaults to `node:fs`'s `statSync`. */
  stat?: (path: string) => { size: number; isFile(): boolean };
  /** Resolve a module id — the embedded route needs an optional package to be installed. */
  resolve?: (id: string) => string;
  /**
   * How long a local server gets to answer.
   *
   * Short on purpose. This runs at startup, and a settings screen that takes ten seconds to tell
   * someone their server is down is a settings screen nobody waits for. A server that cannot answer
   * a `GET /models` in a second and a half is not one a workflow should be pointed at either.
   */
  timeoutMs?: number;
}

const ROUTE_TIMEOUT_MS = 1_500;

/** The package the `embedded` route loads weights with — optional, and absent in most installs. */
export const EMBEDDED_MODULE = "node-llama-cpp";

/** A split GGUF's part, by name: `…-00001-of-00003.gguf` is part 1 of 3. */
const SPLIT_PART = /-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * Each weights entry, looked for on disk — the per-model rows the embedded route's probe is made of.
 *
 * A split model is named by its FIRST part (that is what the loader is handed); its other parts are
 * looked for beside it, and a missing one is an `error` on a row that otherwise `exists`, because the
 * loader fails on it just the same. Never throws: an unreadable file is a row that says so.
 */
export function checkWeightsFiles(
  weights: Record<string, { modelPath: string }> | undefined,
  options: Pick<RouteProbeOptions, "exists" | "stat"> = {},
): WeightsFileCheck[] {
  return Object.entries(weights ?? {}).map(([id, { modelPath }]) => {
    if (options.exists !== undefined && options.stat === undefined) return { id, modelPath, exists: options.exists(modelPath) };
    const stat = options.stat ?? statSync;
    const first = statOf(modelPath, stat);
    if (first.error !== undefined || first.size === undefined) {
      return { id, modelPath, exists: false, ...(first.error !== undefined ? { error: first.error } : {}) };
    }
    const split = SPLIT_PART.exec(modelPath);
    if (split === null) return { id, modelPath, exists: true, sizeBytes: first.size };
    const part = Number(split[1]);
    const parts = Number(split[2]);
    if (part !== 1) return { id, modelPath, exists: true, parts, error: `this is part ${part} of ${parts} — name the first part, …-00001-of-${split[2]}.gguf` };
    let sizeBytes = first.size;
    for (let n = 2; n <= parts; n++) {
      const path = modelPath.replace(SPLIT_PART, `-${String(n).padStart(5, "0")}-of-${split[2]}.gguf`);
      const held = statOf(path, stat);
      if (held.size === undefined) return { id, modelPath, exists: true, parts, error: `part ${n} of ${parts} is missing: ${path}` };
      sizeBytes += held.size;
    }
    return { id, modelPath, exists: true, sizeBytes, parts };
  });
}

/** One file's size, or why there is none. Not being there is no error — it is `exists: false`. */
function statOf(path: string, stat: NonNullable<RouteProbeOptions["stat"]>): { size?: number; error?: string } {
  try {
    const held = stat(path);
    return held.isFile() ? { size: held.size } : { error: "this is a folder, not a weights file" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? {} : { error: (e as Error).message };
  }
}

/** Whether the embedded route's loader resolves from here — the other half of its probe. */
export function checkEmbeddedLoader(options: Pick<RouteProbeOptions, "resolve"> = {}): EmbeddedWeightsReport["loader"] {
  try {
    (options.resolve ?? defaultResolve)(EMBEDDED_MODULE);
    return { module: EMBEDDED_MODULE, installed: true };
  } catch (e) {
    return { module: EMBEDDED_MODULE, installed: false, error: (e as Error).message.split("\n")[0]! };
  }
}

/** Every weights entry and the loader, together — what `model:checkWeights` answers. */
export function checkEmbeddedWeights(
  weights: Record<string, { modelPath: string }> | undefined,
  options: Pick<RouteProbeOptions, "exists" | "stat" | "resolve"> = {},
): EmbeddedWeightsReport {
  return { weights: checkWeightsFiles(weights, options), loader: checkEmbeddedLoader(options) };
}

async function probeOneRoute(
  key: string,
  route: JairaModelRoute | undefined,
  options: RouteProbeOptions,
): Promise<ProbeResult> {
  if (!isEnabled(route)) return { name: key, status: "disabled", detail: "turned off in this configuration" };

  if (key === "local") return probeLocalRoute(route, options);
  if (key === "embedded") return probeEmbeddedRoute(route, options);

  // A remote fleet needs a key, and the ONLY honest check is whether one can be found. Asking the
  // provider whether the key WORKS would mean a request, and a settings screen that quietly bills
  // someone for opening it is worse than one that reports slightly less.
  const found = routeKeyOrigin(key, route, options.secrets);
  if (found.found) {
    return {
      name: key,
      status: "ok",
      detail:
        found.named === undefined
          ? `${found.variable} is set${found.origin ? ` (${found.origin.source})` : ""}`
          : `'${found.named}' resolves`,
      ...(found.origin !== undefined ? { credential: found.origin } : {}),
    };
  }
  return {
    name: key,
    status: "failed",
    detail:
      found.named === undefined
        ? `no key — ${found.variable} is not set and this route names no credential`
        : `no value was found for '${found.named}'`,
    fix: `store a key under ${found.named ?? found.variable}, or turn this route off`,
    ...(found.named !== undefined ? { credentialMissing: found.named } : {}),
  };
}

/**
 * The local route: is a URL configured, and does anything answer it?
 *
 * The second half is the point. A `baseURL` alone told us nothing — the previous check reported `ok`
 * for a server that had never been started, which is precisely the configuration a user is trying to
 * diagnose when they open this screen. So the probe CONNECTS: one `GET` at the ready URL, short
 * timeout, no generation and therefore no cost.
 *
 * A route with a `serve` block that nothing answers is still `ok`, and deliberately: the router
 * starts that server on demand, so "nothing is listening yet" is the expected steady state rather
 * than a fault. What the detail says is which of the two happened.
 */
async function probeLocalRoute(route: JairaModelRoute | undefined, options: RouteProbeOptions): Promise<ProbeResult> {
  if (route?.baseURL === undefined) {
    return {
      name: "local",
      status: "not-checked",
      detail: "no server URL is configured, so nothing is served on this route",
      fix: "set a server URL — http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio",
    };
  }
  const url = route.serve?.readyUrl ?? `${route.baseURL.replace(/\/+$/, "")}/models`;
  const reached = await canReach(url, options);
  if (reached.ok) {
    return { name: "local", status: "ok", detail: `${route.baseURL} answered` };
  }
  if (route.serve !== undefined) {
    return {
      name: "local",
      status: "ok",
      detail: `nothing is listening on ${route.baseURL} yet — '${route.serve.command}' will be started when a state needs it`,
    };
  }
  return {
    name: "local",
    status: "failed",
    detail: `nothing answered ${url}: ${reached.reason}`,
    fix: "start the server, correct the URL, or give this route a launch command so JaiRA can start it",
  };
}

/** One GET, bounded. Any answer at all counts — a 404 from a live server still proves it is there. */
async function canReach(url: string, options: RouteProbeOptions): Promise<{ ok: boolean; reason: string }> {
  const call = options.fetch ?? ((u: string, init: { signal: AbortSignal }) => fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ROUTE_TIMEOUT_MS);
  try {
    const response = await call(url, { signal: controller.signal });
    // Not `response.ok`: a server that answers 404 for `/models` is unmistakably RUNNING, and
    // refusing it here would fail every shim whose route table differs from Ollama's.
    return { ok: true, reason: `HTTP ${response.status}` };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, reason: controller.signal.aborted ? "no answer in time" : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The embedded route: are weights named, is each file actually there, and is the loader installed?
 *
 * All three, because each fails differently and each used to pass. The old check counted KEYS — so a
 * config naming a GGUF that had been moved, on a machine without `node-llama-cpp`, reported `ok` and
 * failed at the first prompt with a message from inside a package the user had never heard of.
 */
async function probeEmbeddedRoute(
  route: JairaModelRoute | undefined,
  options: RouteProbeOptions,
): Promise<ProbeResult> {
  const named = namedWeights(route);
  if (named.length === 0) {
    return {
      name: "embedded",
      status: "not-checked",
      detail: "no weights are configured, so nothing is served on this route",
      fix: 'name a GGUF: { "qwen2.5-7b": { "modelPath": "/models/qwen.gguf" } }',
    };
  }
  // The same rows `model:checkWeights` answers with, so the route's line and the per-model list
  // cannot disagree about which file is there.
  const rows = checkWeightsFiles(route?.weights, options);
  const absent = rows.filter((row) => !row.exists);
  if (absent.length === rows.length) {
    return {
      name: "embedded",
      status: "failed",
      detail: `no weights file exists: ${absent.map((row) => `${row.id} → ${row.modelPath}`).join(", ")}`,
      fix: "correct the modelPath, or download the GGUF to that location",
    };
  }
  if (!checkEmbeddedLoader(options).installed) {
    return {
      name: "embedded",
      status: "failed",
      detail: `the weights are there, but '${EMBEDDED_MODULE}' is not installed, so nothing can load them`,
      fix: `install ${EMBEDDED_MODULE}, or serve the same weights through a local server instead`,
    };
  }
  const usable = rows.filter((row) => row.exists);
  return {
    name: "embedded",
    status: "ok",
    detail:
      absent.length === 0
        ? `${usable.length} model(s) ready: ${usable.map((row) => row.id).join(", ")}`
        : `${usable.length} of ${named.length} ready — missing: ${absent.map((row) => row.id).join(", ")}`,
    ...(absent.length === 0 ? {} : { fix: `correct the modelPath for ${absent.map((row) => row.id).join(", ")}` }),
  };
}

/** The agent route NAMES, without building the executors — the cheap half of {@link agentPromptRoutes}. */
export function agentPromptRouteNames(agents: JairaAgentConfig = {}): Record<string, true> {
  const out: Record<string, true> = {};
  const adapters = enabledAdapters(agents);
  // CLI first: it is the one that works with no API key and no SDK package installed, which is what
  // "pick one" should land on when nothing at all is configured.
  if (adapters.includes("cli")) out[AGENT_CLI] = true;
  if (adapters.includes("sdk")) out[AGENT_SDK] = true;
  if (adapters.includes("codex")) out[AGENT_CODEX] = true;
  for (const spec of enabledGenericAgents(agents)) out[spec.name ?? AGENT_GENERIC_CLI] = true;
  return out;
}

/**
 * Whose models each agent route serves — the `vendors` half of `ExecutorAvailability`.
 *
 * A fact about the BINARY, which is why it is derived here rather than configured: `claude-cli` is
 * the `claude` program, so it answers for Anthropic's models and there is nothing for anyone to
 * decide. It is what lets a state say `claude-sonnet-5` and reach the CLI, and — the half that
 * matters more — what stops the same id reaching `codex-cli` because it happened to sort first.
 *
 * A generic CLI gets NO entry, deliberately. JaiRA does not know what binary someone pointed it at
 * or which models that binary knows, and the cost of guessing is a call silently routed to a program
 * that has never heard of the model. Such a route joins the candidates by stating an `allow` list —
 * which is somebody saying it rather than JaiRA assuming it.
 */
export function agentRouteVendors(agents: JairaAgentConfig = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const adapters = enabledAdapters(agents);
  if (adapters.includes("cli")) out[AGENT_CLI] = "anthropic";
  if (adapters.includes("sdk")) out[AGENT_SDK] = "anthropic";
  if (adapters.includes("codex")) out[AGENT_CODEX] = "openai";
  return out;
}

/**
 * A named executor DEFINITION as a prompt route (`config.executors.<name>`).
 *
 * A definition is selected the way everything else is — by prefix — so `review/…` reaches the
 * executor a project called `review`. What this wrapper does is turn that name back into something
 * the transport underneath understands: the definition's `provider` becomes the prefix and its
 * `model` the rest, so `review/anything` arrives at `claude-cli` as `opus`.
 *
 * The state keeps the last word on the model, as everywhere else: a state that names one under this
 * definition gets it, and the definition's own `model` fills in only when the state asked for the
 * placeholder. Its `config` merges UNDER the state's, for the same reason an executor's does.
 */
export function retargetRoute(
  name: string,
  definition: JairaExecutorDefinition,
  inner: PromptRoute,
): PromptRoute {
  const provider = definition.provider;
  if (provider === undefined) return inner;
  const executor = inner;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      if (op.kind !== "prompt") return executor.start(op, ctx);
      const config = isPlainObject(op.config) ? (op.config as Record<string, JsonValue>) : {};
      const asked = typeof config["model"] === "string" ? config["model"] : "";
      const prefix = `${name}/`;
      const bare = asked.startsWith(prefix) ? asked.slice(prefix.length) : asked;
      const wantsDefault = bare === "" || bare === "default";
      const model = wantsDefault ? definition.model : bare;
      return executor.start(
        {
          ...op,
          config: {
            ...(definition.config ?? {}),
            ...config,
            model: model === undefined ? AGENT_DEFAULT_MODEL : `${provider}/${model}`,
          } as JsonValue,
        },
        ctx,
      );
    },
  };
}

/**
 * Every model that can be used, as `{route}/{model}` ids.
 *
 * The catalog, not a guess and not "what this project happens to name". `ModelInfo` starts from the
 * committed snapshot and is kept current by this machine (`CatalogRefresher`, decision 0009) from what
 * each route reports — so a model a provider or an agent names today is listed without a release, and
 * no hand-kept list sits beside it. An earlier version listed only the ids the open workflow mentioned,
 * which made the picker a mirror of the file you were already reading rather than a menu of choices.
 *
 * AGENT routes have rows of their own (`claude-cli/…`, `codex-cli/…`: what the binary says it runs),
 * beside the provider rows the composer still offers for them. A row a source marked unavailable
 * (codex's hidden models) is not a choice and is left out.
 */
export interface KnownModel {
  /** The `{route}/{model}` id, as a state would write it. */
  id: string;
  /** What it can be GIVEN and what it can PRODUCE — what the picker filters on. */
  input: string[];
  output: string[];
}

export function knownModels(): KnownModel[] {
  return ModelInfo.instance
    .list()
    .filter((row) => row.available !== false)
    .map((row) => ({
      id: keyForModel(row),
      // Defaulted rather than left empty: every model takes text and answers with it, and a filter
      // over an absent field would hide a row for saying nothing rather than for being unable.
      input: [...(row.modalities?.input ?? ["text"])],
      output: [...(row.modalities?.output ?? ["text"])],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
