/**
 * Editing `config.models` from the Models pane — the layer rules, as tests.
 *
 * The standing invariant is the one `executorConfig.test.ts` holds: every document this produces must
 * survive the REAL `parseConfig`. A settings form that can write a file the app then refuses to load
 * is worse than no form, because the refusal arrives at the next launch rather than at the save.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "@jaira/shared";
import {
  MODEL_ROUTES,
  applyModelPatch,
  checkModelId,
  defaultModel,
  formatJson,
  formatServe,
  parseJsonBlock,
  parseServe,
  routeBlock,
} from "../src/renderer/modelsConfig";

/** Run a produced document through the real parser — the invariant every case here asserts. */
function loadable(doc: unknown): ReturnType<typeof parseConfig> {
  return parseConfig(doc);
}

describe("patching config.models", () => {
  it("writes a preset and leaves the rest of the document alone", () => {
    const doc = applyModelPatch({ artifactDir: "out", models: { presets: { fast: {} } } }, { "presets.slow": { topP: 1 } });
    expect(doc).toMatchObject({ artifactDir: "out", models: { presets: { fast: {}, slow: { topP: 1 } } } });
    expect(loadable(doc).models.presets?.["slow"]).toEqual({ topP: 1 });
  });

  it("writes a nested route field through a dotted path", () => {
    const doc = applyModelPatch({}, { "routes.anthropic.credential": "ANTHROPIC_API_KEY" });
    expect(routeBlock(doc, "anthropic")).toEqual({ credential: "ANTHROPIC_API_KEY" });
    expect(loadable(doc).models.routes?.["anthropic"]?.credential).toBe("ANTHROPIC_API_KEY");
  });

  it("does not mutate the document it was given", () => {
    // The store holds the last-read ConfigView; editing it in place would leave the UI showing a value
    // the write might still be refused for.
    const before = { models: { routes: { anthropic: { credential: "A" } } } };
    applyModelPatch(before, { "routes.anthropic.credential": "B" });
    expect(before.models.routes.anthropic.credential).toBe("A");
  });

  it("REMOVES a key on undefined, which is how a layer goes back to inheriting", () => {
    const doc = applyModelPatch({ models: { presets: { fast: {} } } }, { "presets.fast": undefined });
    expect(loadable(doc).models.presets?.["fast"]).toBeUndefined();
  });

  it("deletes an emptied route rather than leaving `{}` behind", () => {
    // An empty object reads as a deliberate, if inert, override — which is the opposite of what
    // clearing the box meant.
    const doc = applyModelPatch({ models: { routes: { anthropic: { credential: "K" } } } }, { "routes.anthropic.credential": undefined });
    expect((doc as { models?: unknown }).models).toBeUndefined();
    expect(loadable(doc).models.routes).toBeUndefined();
  });

  it("keeps a sibling route when one is cleared", () => {
    const doc = applyModelPatch(
      { models: { routes: { anthropic: { credential: "A" }, openrouter: { credential: "B" } } } },
      { "routes.anthropic.credential": undefined },
    );
    expect(loadable(doc).models.routes?.["openrouter"]?.credential).toBe("B");
    expect(loadable(doc).models.routes?.["anthropic"]).toBeUndefined();
  });

  it("turns a route off with `false`, and back on by removing the key", () => {
    const off = applyModelPatch({}, { "routes.local.enabled": false });
    expect(loadable(off).models.routes?.["local"]?.enabled).toBe(false);
    const on = applyModelPatch(off, { "routes.local.enabled": undefined });
    expect(loadable(on).models.routes?.["local"]).toBeUndefined();
  });

  it("produces a loadable document for every field of every route the pane offers", () => {
    // The pane and the parser disagreeing about which fields a route has is exactly the bug the
    // parser's strictness exists to catch, so the two are checked against each other here.
    let doc: unknown = {};
    for (const route of MODEL_ROUTES) {
      for (const field of route.fields) {
        const key = `routes.${route.key}.${field}`;
        if (field === "credential") doc = applyModelPatch(doc, { [key]: "SOME_KEY" });
        else if (field === "baseURL") doc = applyModelPatch(doc, { [key]: "http://localhost:1234/v1" });
        else if (field === "supportsStructuredOutputs") doc = applyModelPatch(doc, { [key]: false });
        else if (field === "serve") doc = applyModelPatch(doc, { [key]: parseServe("ollama serve") });
        else if (field === "weights") doc = applyModelPatch(doc, { [key]: { q: { modelPath: "/w.gguf" } } });
      }
    }
    expect(() => loadable(doc)).not.toThrow();
  });
});

describe("the text fields", () => {
  it("round-trips a server launch line", () => {
    expect(parseServe("ollama serve")).toEqual({ command: "ollama", args: ["serve"] });
    expect(formatServe(parseServe("llama-server -m model.gguf"))).toBe("llama-server -m model.gguf");
  });

  it("treats a blank launch box as 'do not start anything'", () => {
    expect(parseServe("   ")).toBeUndefined();
    expect(formatServe(undefined)).toBe("");
  });

  it("round-trips a JSON block, and shows an empty object as blank", () => {
    expect(parseJsonBlock(formatJson({ q: { modelPath: "/w" } }), "weights")).toEqual({ q: { modelPath: "/w" } });
    expect(formatJson({})).toBe("");
    expect(parseJsonBlock("  ", "weights")).toBeUndefined();
  });

  it("refuses malformed JSON by name rather than silently keeping the old value", () => {
    // A box that accepts a typo and saves nothing is the worst of both: the screen says one thing and
    // the file says another.
    expect(() => parseJsonBlock("{ nope", "presets")).toThrow(/presets is not valid JSON/);
    expect(() => parseJsonBlock("[1,2]", "presets")).toThrow(/presets must be a JSON object/);
  });

  it("requires a model id to name its route, which is the parser's rule too", () => {
    // A bare id is legal now: its family places it, and which route serves that family is the
    // operator's business rather than the author's.
    expect(() => checkModelId("claude-sonnet-5")).not.toThrow();
    expect(() => checkModelId("claude-cli/sonnet")).not.toThrow();
    // Neither a route in front nor a family behind — nothing can place this one.
    expect(() => checkModelId("planner")).toThrow(/names no route/);
    // Empty is legal: it means "choose automatically", not "a bad id".
    expect(() => checkModelId("")).not.toThrow();
  });
});
