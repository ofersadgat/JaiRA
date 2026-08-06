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
import type { EmbeddedModelConfig, LocalServerConfig, ModelRouterOptions } from "@declarative-ai/llm";
import { AgentApiExecutor, type AgentQuery } from "@declarative-ai/agents-api";
import { AgentCliExecutor, AgentCodexExecutor } from "@declarative-ai/agents-cli";
import type { Executor, ExecServices } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  MODEL_ROUTE_KEYS,
  type JairaAgentConfig,
  type JairaModelConfig,
  type JairaModelRoute,
  type ProbeResult,
} from "@jaira/shared";
import { AGENT_CLI, AGENT_CODEX, AGENT_SDK, agentSpawn } from "./agents";
import { AGENT_GENERIC_CLI, createGenericCliQuery } from "./genericAgent";
import { enabledAdapters, enabledGenericAgents } from "./executors";
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
 * and what crosses IPC to any UI is only the ORIGIN (`describe`). A route naming no credential is left
 * alone rather than defaulted, so the SDK's own `process.env` fallback still applies — which is what
 * keeps every existing setup working with no config at all.
 */
export function modelRouterOptions(models: JairaModelConfig = {}, secrets?: SecretResolver): ModelRouterOptions {
  const routes = models.routes ?? {};
  const options: ModelRouterOptions = {};
  const keyFor = (route: JairaModelRoute | undefined): string | undefined =>
    route?.credential !== undefined ? secrets?.lookup(route.credential)?.value : undefined;

  const anthropic = isEnabled(routes["anthropic"]) ? routes["anthropic"] : undefined;
  const anthropicKey = keyFor(anthropic);
  if (anthropicKey !== undefined) options.anthropicApiKey = anthropicKey;

  const openrouter = isEnabled(routes["openrouter"]) ? routes["openrouter"] : undefined;
  const openRouterKey = keyFor(openrouter);
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
  const adapters = enabledAdapters(agents);
  const spawn = agentSpawn({
    ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
    ...(options.observer !== undefined ? { observer: options.observer } : {}),
  });
  const query = options.query;

  if (adapters.includes("sdk")) {
    routes[AGENT_SDK] = new AgentApiExecutor({ ...(query !== undefined ? { query } : {}) }) as unknown as PromptRoute;
  }
  if (adapters.includes("cli")) {
    routes[AGENT_CLI] = new AgentCliExecutor({
      spawn,
      ...(agents.claudeCli?.command !== undefined ? { command: agents.claudeCli.command } : {}),
      ...(query !== undefined ? { query } : {}),
    }) as unknown as PromptRoute;
  }
  if (adapters.includes("codex")) {
    routes[AGENT_CODEX] = new AgentCodexExecutor({
      spawn,
      ...(agents.codex?.command !== undefined ? { command: agents.codex.command } : {}),
      ...(agents.codex?.sandbox !== undefined ? { sandbox: agents.codex.sandbox } : {}),
      ...(query !== undefined ? { query } : {}),
    }) as unknown as PromptRoute;
  }
  for (const spec of enabledGenericAgents(agents)) {
    // A generic CLI has no adapter of its own — it IS the `AgentQuery` JaiRA builds for it, which is
    // the same seam the built-ins are driven through.
    routes[spec.name ?? AGENT_GENERIC_CLI] = new AgentCliExecutor({
      label: spec.name ?? AGENT_GENERIC_CLI,
      query:
        query ??
        (createGenericCliQuery(spec, {
          ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
          ...(options.exec !== undefined ? { exec: options.exec } : {}),
        }) as never),
    }) as unknown as PromptRoute;
  }
  return routes;
}

/**
 * Is this provider route actually usable — cheaply, without a request?
 *
 * Cheap is the requirement, not a shortcut: this runs on every run to decide what to install, and a
 * probe that spawned a process or opened a socket would make starting a workflow pay for a health
 * check nobody asked for. So: a key that resolves, an endpoint that is configured, weights that are
 * named. Anything beyond that is what the settings screen's Test button is for.
 */
function routeUsable(key: string, route: JairaModelRoute | undefined, secrets: SecretResolver | undefined): boolean {
  if (!isEnabled(route)) return false;
  if (key === "local") return route?.baseURL !== undefined;
  if (key === "embedded") return Object.keys(route?.weights ?? {}).length > 0;
  // A remote fleet needs a key. A named credential must RESOLVE — config naming a secret nobody has
  // set is precisely the case that used to fail deep inside the provider SDK instead of here.
  if (route?.credential !== undefined) return secrets?.lookup(route.credential) !== undefined;
  return process.env[key === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"] !== undefined;
}

/** What each route's default model is called, for a config that names a route but no model. */
const ROUTE_DEFAULT_MODEL: Record<string, string> = {
  anthropic: "anthropic/claude-sonnet-5",
  openrouter: "openrouter/anthropic/claude-sonnet-4.5",
};

export interface DefaultModelOptions {
  agents?: JairaAgentConfig;
  secrets?: SecretResolver;
}

/**
 * The model id a prompt state should get when neither it nor config names one.
 *
 * "If several executors are available it should just pick one", expressed as an ORDER rather than as a
 * refusal. A configured provider route wins, because someone who set up a key meant to use it; an
 * agent comes next, because it needs no configuration at all and is therefore the only thing that can
 * work on a fresh machine; and `undefined` means nothing is available, which the caller reports.
 *
 * Returning an ID rather than an executor is what keeps this one mechanism: the id is what
 * `PromptRouterExecutor` dispatches on, what a state can override, and what shows up in a record — so
 * the automatic choice and an explicit one are the same kind of thing, and equally legible.
 */
export function defaultModelId(models: JairaModelConfig = {}, options: DefaultModelOptions = {}): string | undefined {
  if (models.default !== undefined) return models.default;
  const routes = models.routes ?? {};
  for (const key of MODEL_ROUTE_KEYS) {
    if (!routeUsable(key, routes[key], options.secrets)) continue;
    if (key === "local" || key === "embedded") {
      // A local route's model is whatever the server or the weights are called; there is no catalog
      // default to fall back on, so only a named set of weights can supply one.
      const first = key === "embedded" ? Object.keys(routes[key]?.weights ?? {})[0] : undefined;
      if (first !== undefined) return `embedded/${first}`;
      continue;
    }
    return ROUTE_DEFAULT_MODEL[key];
  }
  // Nothing configured — but an installed agent needs nothing configured. This is the branch that
  // makes a first run work on a machine with `claude` and no API key.
  const agentRoutes = Object.keys(agentPromptRouteNames(options.agents ?? {}));
  const first = agentRoutes[0];
  return first !== undefined ? `${first}/default` : undefined;
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
export function probeModelRoutes(models: JairaModelConfig = {}, secrets?: SecretResolver): ProbeResult[] {
  const routes = models.routes ?? {};
  return MODEL_ROUTE_KEYS.map((key): ProbeResult => {
    const route = routes[key];
    if (!isEnabled(route)) return { name: key, status: "disabled", detail: "turned off in this configuration" };

    if (key === "local") {
      if (route?.baseURL === undefined) {
        return { name: key, status: "not-checked", detail: "no server URL is configured, so nothing is served on this route" };
      }
      return {
        name: key,
        status: "ok",
        detail: `${route.baseURL}${route.serve !== undefined ? ` — started with '${route.serve.command}' if nothing answers` : " — expected to be running already"}`,
      };
    }

    if (key === "embedded") {
      const named = Object.keys(route?.weights ?? {});
      return named.length === 0
        ? { name: key, status: "not-checked", detail: "no weights are configured, so nothing is served on this route" }
        : { name: key, status: "ok", detail: `${named.length} model(s) configured: ${named.join(", ")}` };
    }

    // A remote fleet needs a key, and the ONLY honest check is whether one can be found.
    const variable = key === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY";
    if (route?.credential === undefined) {
      return process.env[variable] !== undefined
        ? { name: key, status: "ok", detail: `no credential named — using ${variable} from the environment` }
        : {
            name: key,
            status: "not-checked",
            detail: `no credential named and no ${variable} in the environment — name a secret to use this route`,
          };
    }
    const origin = secrets?.describe(route.credential);
    return origin === undefined
      ? { name: key, status: "failed", detail: `no value was found for '${route.credential}'`, credentialMissing: route.credential }
      : { name: key, status: "ok", detail: `'${route.credential}' resolves`, credential: origin };
  });
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
