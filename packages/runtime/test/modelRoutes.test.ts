/**
 * Who answers a prompt state — the config half of DESIGN §8.3.
 *
 * The bug these exist for: "Propose workflow changes" refused with `no model configured` on a machine
 * that had `claude` installed and working. It was right that a prompt op needs something to dispatch
 * on and wrong that the something has to be a provider — an installed CLI agent needs no key, no
 * endpoint and no configuration at all, so the one setup that obviously worked was the one being
 * turned away.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  parseConfig,
  unnamedRouteOf,
  type JairaConfig,
  type JairaPromptNode,
  type ProbeResult,
} from "@jaira/shared";
import {
  agentPromptRouteNames,
  agentPromptRoutes,
  normaliseAgentModel,
  modelRouterOptions,
  probeModelRoutes,
  usableRouteKeys,
} from "../src/modelRoutes";
import { defaultExecutorTree } from "../src/wiring";
import { SecretResolver } from "../src/secrets";
import { syncWorkflowFiles, syncRootId } from "../src/syncWorkflow";
import { loadBundle } from "@declarative-ai/hw";

/** A secret chain over a temp dir, so a "resolvable credential" is a real lookup, not a stub. */
function secretsWith(entries: Record<string, string>): SecretResolver {
  const dir = mkdtempSync(join(tmpdir(), "jaira-routes-"));
  writeFileSync(join(dir, ".env.local"), Object.entries(entries).map(([k, v]) => `${k}=${v}`).join("\n"), "utf8");
  // `env: {}` so the developer's own ANTHROPIC_API_KEY cannot make a test pass that should not.
  return new SecretResolver({ projectDir: dir, env: {} });
}

const config = (over: Partial<JairaConfig>): JairaConfig => ({ ...defaultConfig(), ...over });

const syncBundle = () => loadBundle(syncWorkflowFiles(), syncRootId("document"));

/** One prompt state that NAMES a model — the shape the start-time check had a hole for. */
const namedBundle = (model: string) =>
  loadBundle({ solo: { label: "Solo", operation: { kind: "prompt", prompt: "hi", model } } }, "solo");

describe("modelRouterOptions — config.models.routes → ModelRouterOptions", () => {
  it("RESOLVES a named credential into the router, which is how a keychain key reaches the provider", () => {
    // The gap this closes: `createModelRouter()` used to be called with no options, so it read
    // `process.env` and a key stored anywhere else — the OS keychain, a project `.env.local` — never
    // reached the SDK at all.
    const options = modelRouterOptions(
      { routes: { anthropic: { credential: "MY_KEY" } } },
      secretsWith({ MY_KEY: "sk-ant-xyz" }),
    );
    expect(options.anthropicApiKey).toBe("sk-ant-xyz");
  });

  it("says nothing when NOTHING has the key, so the SDK's own env fallback still applies", () => {
    // Which is what keeps every setup that worked before this existed working with no config at all.
    expect(modelRouterOptions({ routes: { anthropic: {} } }, secretsWith({})).anthropicApiKey).toBeUndefined();
    expect(modelRouterOptions({}).anthropicApiKey).toBeUndefined();
  });

  it("finds the CONVENTIONAL variable through the chain when config names no credential", () => {
    // The disagreement this closes, and it is the one that produced a live AI_LoadAPIKeyError.
    // `routeUsable` asks the secret CHAIN for `ANTHROPIC_API_KEY`, so a key in `.env.local` made the
    // anthropic route count as usable and a call was dispatched to it — while this function, asking
    // only about a NAMED credential, handed the provider nothing. The provider then looked at
    // `process.env`, which knows nothing about `.env.local`, and failed permanently in four
    // milliseconds. One route judged by one source and served from another.
    const options = modelRouterOptions({ routes: { anthropic: {} } }, secretsWith({ ANTHROPIC_API_KEY: "sk-ant-env" }));
    expect(options.anthropicApiKey).toBe("sk-ant-env");
  });

  it("lets a NAMED credential win over the conventional variable", () => {
    // Naming one is the more specific statement, and the only reason to name one is to not use the
    // variable everything else defaults to.
    const secrets = secretsWith({ ANTHROPIC_API_KEY: "sk-ant-conventional", MY_KEY: "sk-ant-named" });
    expect(modelRouterOptions({ routes: { anthropic: { credential: "MY_KEY" } } }, secrets).anthropicApiKey).toBe(
      "sk-ant-named",
    );
  });

  it("does the same for the other two remote fleets", () => {
    const secrets = secretsWith({ OPENAI_API_KEY: "sk-oai", OPENROUTER_API_KEY: "sk-or" });
    const options = modelRouterOptions({ routes: { openai: {}, openrouter: {} } }, secrets);
    expect(options.openAiApiKey).toBe("sk-oai");
    expect(options.openRouterApiKey).toBe("sk-or");
  });

  it("still says nothing for a route that is turned OFF, whatever the chain holds", () => {
    const secrets = secretsWith({ ANTHROPIC_API_KEY: "sk-ant-env" });
    expect(modelRouterOptions({ routes: { anthropic: { enabled: false } } }, secrets).anthropicApiKey).toBeUndefined();
  });

  it("maps a local server, its auto-start spec included", () => {
    const options = modelRouterOptions({
      routes: { local: { baseURL: "http://localhost:11434/v1", serve: { command: "ollama", args: ["serve"] } } },
    });
    expect(options.local).toMatchObject({ baseURL: "http://localhost:11434/v1", serve: { command: "ollama", args: ["serve"] } });
  });

  it("maps embedded weights to a RESOLVER, so an unconfigured id is refused by name", () => {
    const options = modelRouterOptions({ routes: { embedded: { weights: { "qwen-7b": { modelPath: "/w/q.gguf" } } } } });
    const resolve = options.embedded as (id: string) => unknown;
    expect(resolve("qwen-7b")).toMatchObject({ modelPath: "/w/q.gguf" });
    expect(resolve("something-else")).toBeUndefined();
  });

  it("a disabled route contributes nothing", () => {
    const options = modelRouterOptions(
      { routes: { anthropic: { enabled: false, credential: "MY_KEY" } } },
      secretsWith({ MY_KEY: "sk-ant-xyz" }),
    );
    expect(options.anthropicApiKey).toBeUndefined();
  });
});

/**
 * What can serve a call — the list a derived executor tree is built from.
 *
 * `defaultModelId` used to answer a different and worse question: *what one model id should a state
 * get?* A single id could never route to an agent, because `PromptRouterExecutor` dispatches on
 * `op.config.model` while a leaf's defaults are applied after routing — so a chosen `claude-cli/…`
 * fell through to the provider path and was refused there. What a state with no model needs is a
 * default EXECUTOR, and these are the two halves it is derived from.
 */
describe("what can serve a call", () => {
  it("counts a provider route whose key resolves", () => {
    expect(usableRouteKeys({ routes: { anthropic: { credential: "MY_KEY" } } }, secretsWith({ MY_KEY: "k" }))).toEqual([
      "anthropic",
    ]);
  });

  it("does NOT count a route whose named credential resolves to nothing", () => {
    // Config naming a secret nobody has set is exactly the case that used to fail deep inside the
    // provider SDK, long after the run started, instead of being skipped here.
    expect(usableRouteKeys({ routes: { anthropic: { credential: "ABSENT" } } }, secretsWith({}))).toEqual([]);
  });

  it("counts nothing at all on a machine with no keys and no endpoints", () => {
    expect(usableRouteKeys({}, secretsWith({}))).toEqual([]);
  });

  it("names the CLI agent first, because it is the one that needs no API key", () => {
    // Which makes it the route a first run lands on: nothing configured, and it still works.
    expect(Object.keys(agentPromptRouteNames({}))[0]).toBe("claude-cli");
  });

  it("offers no agents at all when every one of them is turned off", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(Object.keys(agentPromptRouteNames(agents))).toEqual([]);
  });

  it("a generic CLI's prompt route declares its OWN capabilities, not claude's", () => {
    // Left to `AgentCliExecutor`'s default this route advertised `policyEnforcement: "callback"` —
    // for a binary with no callback — so the engine handed it raw tools and believed a restricted
    // state could run here enforced. The function-path registration always declared `"none"`; the
    // prompt route must say the same word.
    const routes = agentPromptRoutes({ genericCli: [{ name: "opencode", command: "opencode" }] }, {});
    expect(routes["opencode"]!.capabilities.policyEnforcement).toBe("none");
    expect(routes["claude-cli"]!.capabilities.policyEnforcement).toBe("callback");
  });
});

describe("defaultExecutorTree — the refusal that reported the bug", () => {
  it("no longer refuses a prompt workflow just because nothing names a model", () => {
    // This is the exact call the sync panel makes. It used to throw
    // "no model configured: set models.default in .jaira/settings.json".
    const tree = defaultExecutorTree(config({}), syncBundle(), { secrets: secretsWith({}) });
    expect(Object.keys((tree.prompt as { routes?: Record<string, unknown> }).routes ?? {})).toContain("claude-cli");
  });

  it("gives that tree a route that answers a state naming no model, which is every state in it", () => {
    // A route the run cannot reach is not a route. Every state in the sync workflow names no model, so
    // without this the router had no prefix to dispatch on and the call went to the provider fallback
    // — reported as "child 'requirements' terminated with error" with the real reason four layers down.
    const tree = defaultExecutorTree(config({}), syncBundle(), { secrets: secretsWith({}) });
    expect(unnamedRouteOf((tree.prompt as { routes?: Record<string, JairaPromptNode> }).routes)).toBe("claude-cli");
  });

  it("refuses a machine whose only route serves nothing but models a state names", () => {
    // A key resolves, so there IS a route — but a remote fleet has no default, and these states name
    // no model. Said at the start of the run, where it is a configuration problem, rather than by the
    // SDK at the first call, where it reads as "model must be a non-empty string".
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    const models = { routes: { anthropic: { credential: "MY_KEY" } } };
    expect(() =>
      defaultExecutorTree(config({ agents, models }), syncBundle(), { secrets: secretsWith({ MY_KEY: "sk-ant-xyz" }) }),
    ).toThrow(/no default model: 'anthropic'/);
  });

  it("refuses a model whose route this machine cannot reach — the API-key failure, caught at start", () => {
    // The bug, exactly. JaiRA's feature workflow pinned `anthropic/claude-sonnet-5` on every phase
    // parent; the machine had a `claude` login and no API key. The check returned early because SOME
    // state named a model, so the run started and each inherited leaf then failed in four
    // milliseconds inside `@ai-sdk/anthropic` — permanently, and long after anyone could act on it.
    expect(() =>
      defaultExecutorTree(config({}), namedBundle("anthropic/claude-sonnet-5"), { secrets: secretsWith({}) }),
    ).toThrow(/'anthropic' route, which is not available here/);
  });

  it("accepts the same model written BARE, because the CLI agent serves that family", () => {
    // Which is the fix the refusal above recommends, and the whole point of dropping the prefix: the
    // author says which model, and the machine answers who serves it.
    const tree = defaultExecutorTree(config({}), namedBundle("claude-sonnet-5"), { secrets: secretsWith({}) });
    expect(Object.keys((tree.prompt as { routes?: Record<string, unknown> }).routes ?? {})).toContain("claude-cli");
  });

  it("does not refuse over an agent whose binary a probe could not find", () => {
    // `available` is what a health check saw a moment ago; a missing binary is a fact about this
    // moment rather than about the configuration. Refusing seven phases because an optional lens's
    // binary is not installed today would be refusing a run that never reaches it — and it is the
    // same call the function path already makes by registering codex whether or not it is present.
    const tree = defaultExecutorTree(config({}), namedBundle("codex-cli/default"), {
      secrets: secretsWith({}),
      available: new Set(["claude-cli"]),
    });
    expect(Object.keys((tree.prompt as { routes?: Record<string, unknown> }).routes ?? {})).not.toContain("codex-cli");
  });

  it("refuses a bare model no configured route serves, and says whose family it is", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(() =>
      defaultExecutorTree(config({ agents }), namedBundle("claude-sonnet-5"), { secrets: secretsWith({}) }),
    ).toThrow(/is a anthropic model and no route here serves anthropic/);
  });

  it("says nothing about models when the caller only wants to READ the tree", () => {
    // A screen rendering the routes on offer is not about to call anything, and a chat panel that
    // cannot describe itself because a workflow names an unreachable model is a UI outage standing
    // in for a run-time refusal.
    expect(() =>
      defaultExecutorTree(config({}), namedBundle("anthropic/claude-sonnet-5"), {
        secrets: secretsWith({}),
        refuse: false,
      }),
    ).not.toThrow();
  });

  it("still refuses when genuinely nothing can answer — and names both fixes", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(() => defaultExecutorTree(config({ agents }), syncBundle(), { secrets: secretsWith({}) })).toThrow(
      /enable an agent executor .*models\.routes/s,
    );
  });

  it("asks for nothing at all from a workflow with no prompt state", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    const functionOnly = { states: { root: { operation: { kind: "function", functionRef: "noop" } } } } as never;
    expect(() => defaultExecutorTree(config({ agents }), functionOnly)).not.toThrow();
  });

  it("stays out of the way of a scripted run", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(() => defaultExecutorTree(config({ agents }), syncBundle(), { fake: true })).not.toThrow();
  });
});

describe("the config surface", () => {
  it("accepts a prefix-keyed routes block and round-trips it", () => {
    const parsed = parseConfig({
      models: {
        routes: { anthropic: { credential: "ANTHROPIC_API_KEY" }, local: { baseURL: "http://localhost:1234/v1" } },
        presets: { fast: { model: "anthropic/claude-haiku-4-5", temperature: 0 } },
      },
    });
    expect(parsed.models.routes?.["anthropic"]?.credential).toBe("ANTHROPIC_API_KEY");
    expect(parsed.models.presets?.["fast"]).toMatchObject({ temperature: 0 });
  });

  it("refuses a setting placed under a route that has no such setting", () => {
    // A `baseURL` under `anthropic` is not a harmless extra key — it is an endpoint that will never be
    // consulted, and the question it produces later ("why is it still calling the public API?") is far
    // harder to trace than a refused save naming the field.
    expect(() => parseConfig({ models: { routes: { anthropic: { baseURL: "http://x" } } } })).toThrow(
      /baseURL is not a setting the 'anthropic' route has/,
    );
  });

  it("refuses a credential that looks like the secret itself", () => {
    expect(() => parseConfig({ models: { routes: { anthropic: { credential: "sk ant 123" } } } })).toThrow(/must NAME a secret/);
  });

  it("refuses models.default outright, naming where the default call settings went", () => {
    // It could never route: the prompt router dispatches on `op.config.model` while a leaf's defaults
    // are applied after routing, so a default naming an agent was invisible to the routing that had
    // to happen first. Refused rather than dropped — a config carrying it was relying on it.
    expect(() => parseConfig({ models: { default: "claude-cli/sonnet" } })).toThrow(
      /executors\.default\.prompt\.defaults\.model/,
    );
  });
});

/**
 * The route health check, now that it actually observes something.
 *
 * What it used to do was count keys. A `local` route reported `ok` for a server that had never been
 * started, and an `embedded` route reported `ok` for a GGUF that had been moved — which is the exact
 * configuration someone opens this screen to diagnose. So the checks now connect and stat, and the
 * ones that cannot be done for free are still not done at all.
 */
describe("probeModelRoutes — what can actually be reached", () => {
  const answers = { fetch: async () => ({ ok: true, status: 200 }) };
  const refuses = {
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const find = (results: ProbeResult[], name: string): ProbeResult => results.find((r) => r.name === name)!;

  it("fails a remote route with no key rather than calling it 'not checked'", async () => {
    const results = await probeModelRoutes({ routes: { anthropic: {} } }, { secrets: secretsWith({}) });
    const anthropic = find(results, "anthropic");

    // "not checked" was the old answer, and it is the wrong one: nothing is missing from the CHECK,
    // the key is missing from the machine. A route in this state cannot serve a single call.
    expect(anthropic.status).toBe("failed");
    expect(anthropic.detail).toContain("ANTHROPIC_API_KEY");
    expect(anthropic.fix).toContain("ANTHROPIC_API_KEY");
  });

  it("passes a remote route whose named credential resolves, and names only its origin", async () => {
    const results = await probeModelRoutes(
      { routes: { anthropic: { credential: "MY_KEY" } } },
      { secrets: secretsWith({ MY_KEY: "sk-ant-xyz" }) },
    );

    expect(find(results, "anthropic").status).toBe("ok");
    expect(JSON.stringify(results)).not.toContain("sk-ant-xyz");
  });

  it("CONNECTS to a local server rather than trusting that a URL means one is there", async () => {
    const up = await probeModelRoutes(
      { routes: { local: { baseURL: "http://localhost:11434/v1" } } },
      { secrets: secretsWith({}), ...answers },
    );
    const down = await probeModelRoutes(
      { routes: { local: { baseURL: "http://localhost:11434/v1" } } },
      { secrets: secretsWith({}), ...refuses },
    );

    expect(find(up, "local").status).toBe("ok");
    expect(find(down, "local").status).toBe("failed");
    expect(find(down, "local").detail).toContain("nothing answered");
  });

  it("still passes an unanswered local route that JaiRA is allowed to START", async () => {
    // Not a fault: the router launches it on demand, so "nothing listening yet" is the steady state.
    const results = await probeModelRoutes(
      { routes: { local: { baseURL: "http://localhost:11434/v1", serve: { command: "ollama", args: ["serve"] } } } },
      { secrets: secretsWith({}), ...refuses },
    );

    expect(find(results, "local").status).toBe("ok");
    expect(find(results, "local").detail).toContain("ollama");
  });

  it("fails embedded weights whose file is not on disk, naming the path", async () => {
    const results = await probeModelRoutes(
      { routes: { embedded: { weights: { qwen: { modelPath: "/models/gone.gguf" } } } } },
      { secrets: secretsWith({}), exists: () => false },
    );

    expect(find(results, "embedded").status).toBe("failed");
    expect(find(results, "embedded").detail).toContain("/models/gone.gguf");
  });

  it("fails embedded weights that exist but have no loader installed", async () => {
    const results = await probeModelRoutes(
      { routes: { embedded: { weights: { qwen: { modelPath: "/models/qwen.gguf" } } } } },
      {
        secrets: secretsWith({}),
        exists: () => true,
        resolve: () => {
          throw new Error("Cannot find module");
        },
      },
    );

    expect(find(results, "embedded").status).toBe("failed");
    expect(find(results, "embedded").detail).toContain("node-llama-cpp");
  });

  it("says a route is off without checking it", async () => {
    const results = await probeModelRoutes(
      { routes: { local: { enabled: false, baseURL: "http://localhost:11434/v1" } } },
      {
        secrets: secretsWith({}),
        fetch: async () => {
          throw new Error("this route should never have been reached");
        },
      },
    );

    expect(find(results, "local").status).toBe("disabled");
  });
});

/**
 * The per-executor model block (DESIGN §8.3) — the three limits, enforced.
 *
 * A prefix used to select an executor and nothing more, so "run this on the CLI agent, and only ever
 * with sonnet" was not expressible. These check that it now is, and that a refusal is a REFUSAL: a
 * disallowed model must never be quietly swapped for a permitted one, because running something other
 * than what was asked for is invisible and can be an order of magnitude off in price.
 */
/**
 * What survives of the per-agent model block: the placeholder fix, and nothing configurable.
 *
 * `<agent>/default` is a NAMED model id, so a transport's own placeholder branch never fires and it
 * forwards the word — `claude --model default`, which no CLI knows. That is exactly the
 * zero-configuration path a fresh machine produces, so it has to work. The LIMITS that used to live
 * here moved to the executor tree's route node, which is what they are about.
 */
describe("normaliseAgentModel", () => {
  const promptOp = (model?: string): unknown => ({
    kind: "prompt",
    user: { kind: "text", binding: { text: "hi" } },
    config: model === undefined ? {} : { model },
    input: {},
    output: { answer: { kind: "json" } },
  });

  function spy(): { seen: Array<Record<string, unknown>>; executor: never } {
    const seen: Array<Record<string, unknown>> = [];
    return {
      seen,
      executor: {
        capabilities: {},
        metrics: { merge: (a: unknown) => a },
        start: (op: { config: Record<string, unknown> }) => {
          seen.push(op.config);
          return { events: [], result: Promise.resolve({ value: null, metrics: {} }), cancel: async () => undefined };
        },
      } as never,
    };
  }

  it("keeps the ROUTE on the placeholder, so the session stays bound to the transport that ran", () => {
    // `<route>/default` rather than the transport's generic `agent/default`: the provider half of a
    // conversation's remote identity is read off this id, and every agent claiming `agent` would let
    // one adapter be offered another's handle. It is a REQUEST, and never what gets recorded — the
    // transport asks for no `--model` and the settle substitutes the model that actually answered
    // (`AgentExecutor.resolvedModel`), so nothing downstream ever reads `default` as a fact.
    const { seen, executor } = spy();
    normaliseAgentModel("claude-cli", executor).start(promptOp("claude-cli/default") as never, {} as never);
    expect(seen[0]?.["model"]).toBe("claude-cli/default");
  });

  it("leaves a real model alone", () => {
    const { seen, executor } = spy();
    normaliseAgentModel("claude-cli", executor).start(promptOp("claude-cli/opus") as never, {} as never);
    expect(seen[0]?.["model"]).toBe("claude-cli/opus");
  });

  it("leaves a function op alone — it has no model to normalise", () => {
    const { seen, executor } = spy();
    normaliseAgentModel("claude-cli", executor).start(
      { kind: "function", functionRef: "x", input: {}, output: { o: { kind: "json" } } } as never,
      {} as never,
    );
    expect(seen).toHaveLength(1);
  });
});
