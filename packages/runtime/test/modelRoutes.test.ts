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
import { defaultConfig, parseConfig, type JairaConfig } from "@jaira/shared";
import { agentPromptRouteNames, defaultModelId, modelRouterOptions } from "../src/modelRoutes";
import { modelDefaults } from "../src/wiring";
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

  it("says nothing when a route names no credential, so the SDK's own env fallback still applies", () => {
    // Which is what keeps every setup that worked before this existed working with no config at all.
    expect(modelRouterOptions({ routes: { anthropic: {} } }, secretsWith({})).anthropicApiKey).toBeUndefined();
    expect(modelRouterOptions({}).anthropicApiKey).toBeUndefined();
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

describe("defaultModelId — 'if several are available, just pick one'", () => {
  it("an explicit models.default always wins", () => {
    expect(defaultModelId({ default: "openrouter/openai/gpt-5" })).toBe("openrouter/openai/gpt-5");
  });

  it("prefers a configured provider route — someone who set up a key meant to use it", () => {
    const chosen = defaultModelId(
      { routes: { anthropic: { credential: "MY_KEY" } } },
      { agents: {}, secrets: secretsWith({ MY_KEY: "k" }) },
    );
    expect(chosen).toBe("anthropic/claude-sonnet-5");
  });

  it("falls back to an AGENT when no provider route is usable — the reported bug", () => {
    // Nothing configured at all: no key, no endpoint, no default. An installed CLI agent needs none
    // of those, so this is the branch that makes a first run work.
    const chosen = defaultModelId({}, { agents: {}, secrets: secretsWith({}) });
    expect(chosen).toBe("claude-cli/default");
  });

  it("does NOT pick a provider route whose named credential resolves to nothing", () => {
    // Config naming a secret nobody has set is exactly the case that used to fail deep inside the
    // provider SDK, long after the run started, instead of being skipped here.
    const chosen = defaultModelId(
      { routes: { anthropic: { credential: "ABSENT" } } },
      { agents: {}, secrets: secretsWith({}) },
    );
    expect(chosen).toBe("claude-cli/default");
  });

  it("has nothing to offer when every agent is turned off and no route is configured", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(defaultModelId({}, { agents, secrets: secretsWith({}) })).toBeUndefined();
  });

  it("names the CLI agent first, because it is the one that needs no API key", () => {
    expect(Object.keys(agentPromptRouteNames({}))[0]).toBe("claude-cli");
  });
});

describe("modelDefaults — the refusal that reported the bug", () => {
  it("no longer refuses a prompt workflow just because models.default is unset", () => {
    // This is the exact call the sync panel makes. It used to throw
    // "no model configured: set models.default in .jaira/config.json".
    const defaults = modelDefaults(config({}), syncBundle(), { secrets: secretsWith({}) });
    expect(defaults).toEqual({ model: "claude-cli/default" });
  });

  it("still refuses when genuinely nothing can answer — and names BOTH fixes", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    expect(() => modelDefaults(config({ agents }), syncBundle(), { secrets: secretsWith({}) })).toThrow(
      /enable an agent executor .*models\.routes.*models\.default/s,
    );
  });

  it("asks for nothing at all from a workflow with no prompt state", () => {
    const agents = { claudeCode: { enabled: false }, claudeCli: { enabled: false }, codex: { enabled: false } };
    const functionOnly = { states: { root: { operation: { kind: "function", functionRef: "noop" } } } } as never;
    expect(modelDefaults(config({ agents }), functionOnly)).toEqual({});
  });

  it("stays out of the way of a scripted run", () => {
    expect(modelDefaults(config({}), syncBundle(), { fake: true })).toEqual({});
  });
});

describe("the config surface", () => {
  it("accepts a prefix-keyed routes block and round-trips it", () => {
    const parsed = parseConfig({
      models: {
        default: "claude-cli/sonnet",
        routes: { anthropic: { credential: "ANTHROPIC_API_KEY" }, local: { baseURL: "http://localhost:1234/v1" } },
        presets: { fast: { model: "anthropic/claude-haiku-4-5", temperature: 0 } },
      },
    });
    expect(parsed.models.default).toBe("claude-cli/sonnet");
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

  it("still requires models.default to be route-prefixed, and now says the agent form too", () => {
    expect(() => parseConfig({ models: { default: "claude-sonnet-5" } })).toThrow(/claude-cli\/sonnet/);
  });
});
