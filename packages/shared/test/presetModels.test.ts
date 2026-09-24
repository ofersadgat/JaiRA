/**
 * A preset's model (`presetModels.ts`): what `models.presets.<name>.model` may hold, what a model field
 * naming a preset means, whether a model is available here, and `first-available` — the choice made
 * when a session is created, as a pure function over an availability predicate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chooseFirstAvailable,
  keptCandidate,
  mergeConfigLayers,
  modelAvailability,
  modelAvailabilityIn,
  parseConfig,
  parsePresetModel,
  presetModelSummary,
  presetNameRefusal,
  resolveModelField,
  routeHealthOf,
  shortModelName,
  type JairaPromptNode,
  type ModelAvailability,
} from "../src/index";

const BUILT_IN = fileURLToPath(new URL("../builtin/settings.json", import.meta.url));

/** A machine with the claude CLI and codex, and an OpenAI key — the routes a derived tree would have. */
const ROUTES: Record<string, JairaPromptNode> = {
  openai: { kind: "provider", provider: "openai", vendor: "openai" },
  "claude-cli": { kind: "agent", agent: "claude-cli", vendor: "anthropic" },
  "codex-cli": { kind: "agent", agent: "codex-cli", vendor: "openai" },
};

describe("the built-in settings layer", () => {
  it("ships a document the strict parser accepts, with simple, coder and planner and the judge on simple", () => {
    const config = parseConfig(JSON.parse(readFileSync(BUILT_IN, "utf8")));
    expect(Object.keys(config.models.presets ?? {}).sort()).toEqual(["coder", "planner", "simple"]);
    expect(config.models.presets!["coder"]!["reasoning"]).toEqual({ effort: "high" });
    expect(config.models.presets!["planner"]!["reasoning"]).toEqual({ effort: "high" });
    expect(config.functions.smart.model).toBe("simple");
    // No default model: what a state that names nothing runs on stays the machine's business.
    expect(config.executors["default"]).toBeUndefined();
  });

  it("merges weakest first, each layer over the one below, key by key", () => {
    const merged = mergeConfigLayers([
      { models: { presets: { coder: { model: "claude-opus-5-5", reasoning: { effort: "high" } } } } },
      null,
      { models: { presets: { coder: { reasoning: { effort: "low" } } } } },
      undefined,
    ]);
    expect(merged).toEqual({ models: { presets: { coder: { model: "claude-opus-5-5", reasoning: { effort: "low" } } } } });
    expect(mergeConfigLayers([undefined, null])).toBeUndefined();
  });
});

describe("a preset's model, parsed", () => {
  it("is a model id, or candidates and the one rule", () => {
    expect(parsePresetModel("claude-cli/opus", "m")).toBe("claude-cli/opus");
    expect(parsePresetModel({ candidates: ["a-1", "b-2"], choose: "first-available" }, "m")).toEqual({
      candidates: ["a-1", "b-2"],
      choose: "first-available",
    });
  });

  it("refuses what would quietly never choose — and names the field", () => {
    expect(() => parsePresetModel("", "m")).toThrow("m must be a model id");
    expect(() => parsePresetModel({ candidates: [], choose: "first-available" }, "m")).toThrow("m.candidates must be a non-empty list");
    expect(() => parsePresetModel({ candidates: ["a-1", ""], choose: "first-available" }, "m")).toThrow("m.candidates[1] must be a model id");
    // The rule the person wants next is not built: a config asking for it is refused, not ignored.
    expect(() => parsePresetModel({ candidates: ["a-1"], choose: "most-budget-left" }, "m")).toThrow('m.choose must be "first-available"');
    expect(() => parsePresetModel({ candidates: ["a-1"] }, "m")).toThrow("m.choose");
    expect(() => parsePresetModel({ candidates: ["a-1"], choose: "first-available", pick: 1 }, "m")).toThrow("m.pick is not a field");
  });

  it("is checked by the config parser, with the preset's path", () => {
    expect(() => parseConfig({ models: { presets: { coder: { model: { candidates: "gpt-5" } } } } })).toThrow(
      "config.models.presets.coder.model.candidates must be a non-empty list",
    );
    // A candidate is a model; one naming another preset would be a preset of presets.
    expect(() =>
      parseConfig({ models: { presets: { simple: { model: "claude-haiku-4-5" }, coder: { model: { candidates: ["simple"], choose: "first-available" } } } } }),
    ).toThrow("config.models.presets.coder.model names the preset 'simple'");
  });
});

describe("a preset's name", () => {
  it("is one word no model id can be, so a model field naming it is never ambiguous", () => {
    for (const name of ["simple", "coder", "planner", "fast_cheap", "Review2"]) expect(presetNameRefusal(name)).toBeUndefined();
    // Every model id has a dash, a slash, a dot or a colon…
    for (const name of ["claude-opus-5-5", "gpt.fast", "claude-cli/opus", "ollama:llama3", "my-preset"]) {
      expect(presetNameRefusal(name)).toContain("a preset's name is a word");
    }
    // …save the few a family claims, which are refused by family.
    expect(presetNameRefusal("o3")).toContain("reads as a model id of the openai family");
    expect(presetNameRefusal("gpt5")).toContain("openai");
    // And the word a route reads as its own default.
    expect(presetNameRefusal("default")).toContain("its own model");
  });

  it("is refused by the parser when a layer spells one like a model", () => {
    expect(() => parseConfig({ models: { presets: { "my-fast": {} } } })).toThrow("config.models.presets.my-fast: a preset's name is a word");
  });

  it("in a model field means that preset's model — and anything else is a model id", () => {
    const presets = { simple: { model: { candidates: ["claude-haiku-4-5", "gpt-5.6-luna"], choose: "first-available" } }, bare: { temperature: 0 } };
    expect(resolveModelField("simple", presets)).toEqual({
      model: { candidates: ["claude-haiku-4-5", "gpt-5.6-luna"], choose: "first-available" },
      preset: "simple",
    });
    expect(resolveModelField("claude-sonnet-5", presets)).toEqual({ model: "claude-sonnet-5" });
    expect(resolveModelField("simple", undefined)).toEqual({ model: "simple" });
    // A preset that sets no model is nothing to resolve to, and not a model id either.
    expect(resolveModelField("bare", presets)).toEqual({ presetless: "bare" });
  });
});

describe("whether a model is available here", () => {
  it("routes a bare id by family, agents first, and names the route", () => {
    expect(modelAvailability(ROUTES, "claude-opus-5-5")).toEqual({ available: true, route: "claude-cli" });
    expect(modelAvailability(ROUTES, "gpt-5")).toEqual({ available: true, route: "codex-cli" });
  });

  it("falls to the next route that serves it when the first is signed out, and says why when none is left", () => {
    const signedOut = routeHealthOf({
      checkedAt: 1,
      routes: [],
      executors: [
        { name: "codex-cli", status: "needs-sign-in", detail: "not signed in" },
        { name: "claude-cli", status: "failed", detail: "claude was not found on PATH" },
      ],
    });
    expect(modelAvailability(ROUTES, "gpt-5", signedOut)).toEqual({ available: true, route: "openai" });
    expect(modelAvailability(ROUTES, "claude-opus-5-5", signedOut)).toEqual({
      available: false,
      why: "claude-cli: claude was not found on PATH",
    });
    const noKey = { ...ROUTES };
    delete noKey["openai"];
    expect(modelAvailability(noKey, "gpt-5", signedOut)).toEqual({ available: false, why: "codex-cli is not signed in" });
  });

  it("judges a prefixed id by the route it names, alone", () => {
    expect(modelAvailability(ROUTES, "claude-cli/opus")).toEqual({ available: true, route: "claude-cli" });
    expect(modelAvailability(ROUTES, "anthropic/claude-opus-5-5")).toEqual({ available: false, why: "the anthropic route is not set up here" });
  });

  it("says when nothing here serves the family, or nothing recognises the id", () => {
    expect(modelAvailability({ "codex-cli": ROUTES["codex-cli"]! }, "claude-fable-5-1")).toEqual({
      available: false,
      why: "nothing here serves anthropic models",
    });
    expect(modelAvailability(ROUTES, "phi4")).toEqual({ available: false, why: "no route here recognises it" });
  });

  it("treats a prompt half pinned to one leaf as serving everything, as far as its health goes", () => {
    expect(modelAvailabilityIn({ kind: "agent", agent: "claude-cli" }, "gpt-5")).toEqual({ available: true, route: "claude-cli" });
    expect(modelAvailabilityIn({ kind: "router", routes: ROUTES }, "gpt-5")).toEqual({ available: true, route: "codex-cli" });
    expect(modelAvailabilityIn(undefined, "gpt-5").available).toBe(false);
  });

  it("is optimistic about a route no check has looked at", () => {
    expect(routeHealthOf(undefined)("claude-cli")).toEqual({ ok: true });
    expect(routeHealthOf({ checkedAt: 1, routes: [], executors: [{ name: "claude-cli", status: "not-checked", detail: "" }] })("claude-cli")).toEqual({ ok: true });
  });
});

describe("first-available", () => {
  /** A fake machine: what it can run, and why it cannot run the rest. */
  const machine =
    (runs: Record<string, string>, why: Record<string, string> = {}) =>
    (model: string): ModelAvailability =>
      runs[model] !== undefined ? { available: true, route: runs[model]! } : { available: false, why: why[model] ?? "not here" };

  it("takes the first candidate that can run here, and says where it runs", () => {
    const coder = ["claude-opus-5-5", "gpt-5.6-terra"];
    expect(chooseFirstAvailable(coder, machine({ "claude-opus-5-5": "claude-cli", "gpt-5.6-terra": "codex-cli" }))).toEqual({
      model: "claude-opus-5-5",
      route: "claude-cli",
      index: 0,
    });
    expect(chooseFirstAvailable(coder, machine({ "gpt-5.6-terra": "codex-cli" }))).toEqual({ model: "gpt-5.6-terra", route: "codex-cli", index: 1 });
  });

  it("asks only as far as the first that can", () => {
    const asked: string[] = [];
    chooseFirstAvailable(["a-1", "b-2", "c-3"], (model) => {
      asked.push(model);
      return model === "b-2" ? { available: true, route: "r" } : { available: false, why: "no" };
    });
    expect(asked).toEqual(["a-1", "b-2"]);
  });

  it("refuses naming EVERY candidate and why, when none can run", () => {
    const outcome = chooseFirstAvailable(
      ["claude-fable-5-1", "gpt-5.6-sol"],
      machine({}, { "claude-fable-5-1": "claude-cli is not signed in", "gpt-5.6-sol": "nothing here serves openai models" }),
      "planner",
    );
    expect(outcome).toEqual({
      refused:
        "none of the candidates of preset 'planner' is available here — claude-fable-5-1: claude-cli is not signed in; gpt-5.6-sol: nothing here serves openai models",
      unavailable: [
        { model: "claude-fable-5-1", why: "claude-cli is not signed in" },
        { model: "gpt-5.6-sol", why: "nothing here serves openai models" },
      ],
    });
  });
});

describe("a session keeping its choice", () => {
  it("matches what the record says answered — under its route, or as a dated snapshot — and nothing looser", () => {
    const simple = ["claude-haiku-4-5", "gpt-5.6-luna"];
    expect(keptCandidate(simple, "claude-cli/claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(keptCandidate(simple, "anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(keptCandidate(simple, "codex-cli/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    // `gpt-5-mini` answered, and `gpt-5` is not it.
    expect(keptCandidate(["gpt-5"], "gpt-5-mini")).toBeUndefined();
    expect(keptCandidate(simple, "claude-cli/claude-sonnet-5")).toBeUndefined();
    expect(keptCandidate(simple, undefined)).toBeUndefined();
  });
});

describe("saying it", () => {
  it("shortens a Claude family id to the family, and leaves the rest as they are", () => {
    expect(shortModelName("claude-opus-5-5")).toBe("opus");
    expect(shortModelName("claude-cli/claude-haiku-4-5")).toBe("haiku");
    expect(shortModelName("gpt-5")).toBe("gpt-5");
    expect(shortModelName("openrouter/openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("summarises a candidate list as its rule and its names", () => {
    expect(presetModelSummary({ candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "first-available" })).toBe("first available: opus · gpt-5.6-terra");
    expect(presetModelSummary("claude-cli/opus")).toBe("claude-cli/opus");
    expect(presetModelSummary(undefined)).toBe("not set");
  });
});
