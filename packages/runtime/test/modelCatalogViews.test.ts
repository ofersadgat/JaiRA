import { describe, expect, it } from "vitest";
import { ModelInfo, parametersFromNames } from "@declarative-ai/llm";
import type { ProbeResult } from "@jaira/shared";
import { catalogStatusView, describedFrom, levelsSummary, nativeModelIds, reasoningViewOf, versionOf, type CatalogSourceStatus } from "../src";

const probe = (name: string, version: string): ProbeResult => ({ name, status: "ok", detail: "", version });

/** A table as today's sources left it, trimmed: codex's own rows, claude's alias rows, one API row. */
function table(): ModelInfo {
  return new ModelInfo([
    {
      route: "codex-cli",
      model: "gpt-5.6-sol",
      canonicalId: "gpt-5-6-sol",
      source: "codex-models",
      parameters: parametersFromNames([], {
        reasoning: { efforts: ["low", "high", "ultra"], defaultEffort: "low", descriptions: { low: "Fast responses with lighter reasoning" }, budget: false },
      }),
    },
    {
      route: "codex-cli",
      model: "default",
      canonicalId: "gpt-5-6-sol",
      source: "codex-models",
      parameters: parametersFromNames([], { reasoning: { efforts: ["low", "high", "ultra"], defaultEffort: "low", budget: false } }),
    },
    { route: "codex-cli", model: "gpt-5.5", canonicalId: "gpt-5-5", source: "codex-models", available: false, parameters: parametersFromNames([]) },
    { route: "claude-cli", model: "sonnet", canonicalId: "sonnet", source: "claude-models", parameters: parametersFromNames([], { reasoning: { efforts: ["low", "medium", "high", "max"], budget: false } }) },
    {
      route: "anthropic",
      model: "claude-opus-5-5",
      source: "anthropic-models",
      parameters: parametersFromNames([], { reasoning: { efforts: ["low", "medium", "high", "xhigh", "max"], budget: false } }),
    },
    {
      route: "anthropic",
      model: "claude-sonnet-4-6",
      source: "anthropic-models",
      parameters: parametersFromNames([], { reasoning: { efforts: ["low", "max"], budget: { minimum: 1024, maximum: 127999 } } }),
    },
  ]);
}

describe("reasoningViewOf — what the Thinking chip and the effort fields draw", () => {
  const executors = [probe("codex-cli", "codex-cli 0.147.0"), probe("claude-cli", "2.1.142 (Claude Code)")];

  it("a model's own levels, the source's descriptions where it gave them, its default, and no budget", () => {
    expect(reasoningViewOf("codex-cli/gpt-5.6-sol", executors, table())).toMatchObject({
      reasoning: true,
      levels: [{ level: "low", description: "Fast responses with lighter reasoning" }, { level: "high" }, { level: "ultra" }],
      defaultLevel: "low",
      budget: false,
      from: "codex 0.147.0",
    });
  });

  it("an agent running a model its own list lacks is described by that model's API row, and says so", () => {
    const view = reasoningViewOf("claude-cli/claude-opus-5-5", executors, table());
    expect(view.levels?.map((l) => l.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(view.from).toBe("anthropic/claude-opus-5-5");
  });

  it("a budget, with its range, where the model takes one", () => {
    expect(reasoningViewOf("anthropic/claude-sonnet-4-6", executors, table()).budget).toEqual({ minimum: 1024, maximum: 127999 });
  });

  it("nothing at all for a model nothing describes", () => {
    expect(reasoningViewOf("local/qwen3-coder", executors, table())).toEqual({});
  });

  it("names the source a person would recognise", () => {
    expect(versionOf(probe("claude-cli", "2.1.142 (Claude Code)"))).toBe("2.1.142");
    const row = table().lookup("claude-cli/sonnet")!;
    expect(describedFrom(row, "claude-cli/sonnet", executors)).toBe("claude 2.1.142");
    expect(describedFrom(table().lookup("anthropic/claude-opus-5-5")!, "anthropic/claude-opus-5-5", executors)).toBe("Anthropic's model list");
  });
});

describe("levelsSummary", () => {
  it("a run of levels as a range, a gap spelled out, the default named, and none said so", () => {
    const t = table();
    expect(levelsSummary("anthropic/claude-opus-5-5", t)).toBe("low–max");
    expect(levelsSummary("claude-cli/sonnet", t)).toBe("low, medium, high, max");
    expect(levelsSummary("codex-cli/gpt-5.6-sol", t)).toBe("low, high, ultra, default low");
    expect(levelsSummary("codex-cli/gpt-5.5", t)).toBe("no thinking level");
    expect(levelsSummary("local/unknown", t)).toBeUndefined();
  });
});

describe("catalogStatusView — the Catalog section", () => {
  const status: CatalogSourceStatus[] = [
    { name: "codex-cli-models", at: 1000, tookMs: 900, ok: true, fetched: 3, applied: 3, models: ["codex-cli/gpt-5.6-sol", "codex-cli/default", "codex-cli/gpt-5.5"] },
    { name: "anthropic-models", at: 1000, tookMs: 900, ok: false, fetched: 0, applied: 0, error: "HTTP 401", models: [] },
  ];

  it("one row per source, asked or not, each saying what it asks and when it is asked again", () => {
    const view = catalogStatusView({
      status,
      planned: [{ source: { name: "openrouter-models", fetchRows: async () => [] }, fingerprint: "x" }],
      executors: [probe("codex-cli", "codex-cli 0.147.0")],
      refreshing: false,
      table: table(),
    });
    expect(view.sources.map((s) => [s.name, s.state])).toEqual([
      ["openrouter-models", "not asked yet"],
      ["openrouter-native-mirrors", "not configured"],
      ["anthropic-models", "failed"],
      ["claude-cli-models", "not configured"],
      ["claude-code-models", "not configured"],
      ["codex-cli-models", "ok"],
      ["local-models", "not configured"],
      ["embedded-models", "not configured"],
    ]);
    expect(view.lastAt).toBe(1000);
    const codex = view.sources.find((s) => s.name === "codex-cli-models")!;
    expect(codex).toMatchObject({ version: "0.147.0", changesWith: "the agent is updated or signs in as someone else", nextAt: 1000 + 24 * 60 * 60 * 1000 });
    expect(codex.models).toEqual([
      { id: "gpt-5.6-sol", levels: "low, high, ultra, default low" },
      { id: "default", levels: "low, high, ultra, default low", alias: "→ gpt-5.6-sol" },
      { id: "gpt-5.5", levels: "no thinking level", hidden: true },
    ]);
    const anthropic = view.sources.find((s) => s.name === "anthropic-models")!;
    expect(anthropic).toMatchObject({ error: "HTTP 401", fix: "replace the Anthropic key under Connections, then Refresh", nextAt: 1000 + 60 * 60 * 1000 });
    expect(view.sources.find((s) => s.name === "local-models")?.error).toBe("no local server URL is set");
  });
});

describe("nativeModelIds — what a preset candidate's box suggests", () => {
  it("the native routes' ids, newest first, an alias over its dated snapshot, nothing hidden", () => {
    const t = new ModelInfo([
      { route: "anthropic", model: "claude-haiku-4-5", releasedAt: 100 },
      { route: "anthropic", model: "claude-haiku-4-5-20251001", releasedAt: 100 },
      { route: "anthropic", model: "claude-opus-5-5", releasedAt: 300 },
      { route: "openai", model: "gpt-5.6-terra", releasedAt: 200 },
      { route: "openai", model: "gpt-old", available: false },
      { route: "openrouter", model: "qwen/qwen3-max", releasedAt: 999 },
      { route: "codex-cli", model: "default" },
    ]);
    expect(nativeModelIds(t)).toEqual(["claude-opus-5-5", "gpt-5.6-terra", "claude-haiku-4-5"]);
  });
});
