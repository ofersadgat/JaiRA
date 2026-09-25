import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelInfo, type CatalogSource, type ModelInfoInterface } from "@declarative-ai/llm";
import type { ProbeResult } from "@jaira/shared";
import { CATALOG_RETRY_MS, CATALOG_STALE_MS, CatalogRefresher, catalogSources, embeddedModelsSource, knownModels, localModelsSource, type CatalogStore, type PlannedSource } from "../src";
import type { SecretResolver } from "../src/secrets";

const ok = (name: string, version = "1.0"): ProbeResult => ({ name, status: "ok", detail: "", version });
const secrets = (values: Record<string, string>): SecretResolver =>
  ({ lookup: (name: string) => (values[name] !== undefined ? { value: values[name]!, origin: "env" } : undefined) }) as unknown as SecretResolver;
const names = (planned: PlannedSource[]): string[] => planned.map((p) => p.source.name);

describe("catalogSources — what this machine asks, in merge order", () => {
  it("asks OpenRouter always, and nothing that needs a key or a binary it has not got", () => {
    expect(names(catalogSources({ executors: [] }, { sdkClaude: () => undefined }))).toEqual(["openrouter-models", "openrouter-native-mirrors"]);
  });

  it("adds Anthropic's list with a key, each WORKING agent, a local server and embedded weights", () => {
    const planned = catalogSources(
      {
        secrets: secrets({ ANTHROPIC_API_KEY: "sk-ant" }),
        executors: [ok("claude-cli"), ok("claude-code"), ok("codex-cli"), { ...ok("generic"), status: "failed" }],
        models: { routes: { local: { baseURL: "http://localhost:1234/v1" }, embedded: { weights: { "qwen3-8b-q4": { modelPath: "C:/w/qwen.gguf" } } } } },
      },
      { sdkClaude: () => "C:/sdk/claude.exe" },
    );
    expect(names(planned)).toEqual([
      "openrouter-models",
      "openrouter-native-mirrors",
      "anthropic-models",
      "claude-cli-models",
      "claude-code-models",
      "codex-cli-models",
      "local-models",
      "embedded-models",
    ]);
    // A fingerprint never carries the key itself.
    expect(planned.find((p) => p.source.name === "anthropic-models")?.fingerprint).not.toContain("sk-ant");
  });

  it("leaves out an agent whose check failed, and claude-code when the SDK's binary cannot be found", () => {
    const planned = catalogSources({ executors: [ok("claude-code"), { ...ok("codex-cli"), status: "failed" }] }, { sdkClaude: () => undefined });
    expect(names(planned)).toEqual(["openrouter-models", "openrouter-native-mirrors"]);
  });

  it("the embedded source's fingerprint moves when a weights file arrives or changes at its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-weights-"));
    try {
      const file = join(dir, "qwen.gguf");
      const print = (): string =>
        catalogSources({ executors: [], models: { routes: { embedded: { weights: { "qwen3-8b-q4": { modelPath: file } } } } } }, { sdkClaude: () => undefined }).find(
          (p) => p.source.name === "embedded-models",
        )!.fingerprint;
      const missing = print();
      writeFileSync(file, "GGUF");
      const arrived = print();
      expect(arrived).not.toBe(missing);
      writeFileSync(file, "GGUF, a larger file");
      expect(print()).not.toBe(arrived);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an agent's fingerprint moves with its version and its sign-in", () => {
    const print = (probe: ProbeResult): string =>
      catalogSources({ executors: [probe] }, { sdkClaude: () => undefined }).find((p) => p.source.name === "codex-cli-models")!.fingerprint;
    const base = print(ok("codex-cli", "0.147.0"));
    expect(print(ok("codex-cli", "0.147.0"))).toBe(base);
    expect(print(ok("codex-cli", "0.156.0"))).not.toBe(base);
    expect(print({ ...ok("codex-cli", "0.147.0"), accounts: [{ label: "someone@else", active: true }] })).not.toBe(base);
  });
});

describe("localModelsSource / embeddedModelsSource", () => {
  it("lists a local server's models as free rows", async () => {
    const asked: string[] = [];
    const rows = await localModelsSource("http://localhost:1234/v1/", async (url) => {
      asked.push(url);
      return JSON.stringify({ data: [{ id: "qwen3-32b" }, { id: "" }, { object: "model" }] });
    }).fetchRows();
    expect(asked).toEqual(["http://localhost:1234/v1/models"]);
    expect(rows).toEqual([expect.objectContaining({ route: "local", model: "qwen3-32b", inputPerMillion: 0, outputPerMillion: 0, source: "local-models" })]);
  });

  it("fails on an answer that is not a model list, for the refresh to skip it", async () => {
    await expect(localModelsSource("http://x/v1", async () => "{}").fetchRows()).rejects.toThrow("did not answer a model list");
  });

  it("reads each configured GGUF's header into a row", async () => {
    const rows = await embeddedModelsSource({ "qwen3-8b-q4": "C:/w/qwen.gguf" }, async ({ model, source }) => ({
      route: "embedded",
      model,
      inputPerMillion: 0,
      outputPerMillion: 0,
      contextLength: source.length,
    })).fetchRows();
    expect(rows[0]).toMatchObject({ route: "embedded", model: "qwen3-8b-q4", canonicalId: "qwen3-8b-q4" });
  });
});

/** A store in memory, recording what was saved. */
function memoryStore(): CatalogStore & { saved: ModelInfoInterface[][] } {
  const saved: ModelInfoInterface[][] = [];
  const rows: ModelInfoInterface[] = [];
  return {
    saved,
    load: () => [...rows],
    save: (batch) => {
      saved.push([...batch]);
      rows.push(...batch);
    },
  };
}

/** A source that answers `rows` and counts how often it was asked. */
function counting(name: string, rows: () => ModelInfoInterface[] | Promise<ModelInfoInterface[]>): CatalogSource & { asked: number } {
  const source = { name, asked: 0, fetchRows: async () => (source.asked++, rows()) };
  return source;
}

describe("CatalogRefresher — asks again only when it should", () => {
  const row = (model: string, extra: Partial<ModelInfoInterface> = {}): ModelInfoInterface => ({ route: "codex-cli", model, ...extra });

  it("merges a source into the table and saves only what changed", async () => {
    const table = new ModelInfo([]);
    const store = memoryStore();
    const refresher = new CatalogRefresher(() => store, { table, now: () => 1000 });
    const source = counting("codex-cli-models", () => [row("gpt-5.6-sol")]);
    const report = await refresher.refresh([{ source, fingerprint: "v1" }]);
    expect(report?.added).toEqual(["codex-cli/gpt-5.6-sol"]);
    expect(store.saved).toEqual([[row("gpt-5.6-sol")]]);
    expect(table.lookup("codex-cli/gpt-5.6-sol")).toEqual(row("gpt-5.6-sol"));
  });

  it("re-asks when the fingerprint moves or a day passes — not before — and always when forced", async () => {
    let now = 0;
    const refresher = new CatalogRefresher(() => memoryStore(), { table: new ModelInfo([]), now: () => now });
    const source = counting("s", () => [row("m")]);
    await refresher.refresh([{ source, fingerprint: "a" }]);
    now = CATALOG_STALE_MS - 1;
    expect(await refresher.refresh([{ source, fingerprint: "a" }])).toBeUndefined();
    await refresher.refresh([{ source, fingerprint: "b" }]); // an agent was updated
    now += CATALOG_STALE_MS;
    await refresher.refresh([{ source, fingerprint: "b" }]); // a day on
    await refresher.refresh([{ source, fingerprint: "b" }], { force: true }); // Re-check
    expect(source.asked).toBe(4);
  });

  it("retries a source that failed after an hour, not on every pass", async () => {
    let now = 0;
    const refresher = new CatalogRefresher(() => memoryStore(), { table: new ModelInfo([]), now: () => now });
    const source = counting("down", () => {
      throw new Error("offline");
    });
    await refresher.refresh([{ source, fingerprint: "x" }]);
    now = CATALOG_RETRY_MS - 1;
    await refresher.refresh([{ source, fingerprint: "x" }]);
    now = CATALOG_RETRY_MS;
    await refresher.refresh([{ source, fingerprint: "x" }]);
    expect(source.asked).toBe(2);
  });

  it("collapses requests made while one runs into ONE follow-up, with the latest inputs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const refresher = new CatalogRefresher(() => memoryStore(), { table: new ModelInfo([]) });
    const slow = counting("slow", async () => (await gate, [row("m")]));
    const first = refresher.refresh([{ source: slow, fingerprint: "1" }]);
    const second = refresher.refresh([{ source: slow, fingerprint: "2" }]);
    const third = refresher.refresh([{ source: slow, fingerprint: "3" }]);
    expect(second).toBe(third);
    release();
    await Promise.all([first, second]);
    expect(slow.asked).toBe(2); // the first pass, and one follow-up for fingerprint "3"
  });

  it("reports each source's last outcome, the failure's reason included", async () => {
    let now = 5000;
    const refresher = new CatalogRefresher(() => memoryStore(), { table: new ModelInfo([]), now: () => now++ });
    const good = counting("codex-cli-models", () => [row("a"), row("b")]);
    const bad = counting("anthropic-models", () => {
      throw new Error("HTTP 401");
    });
    await refresher.refresh([
      { source: good, fingerprint: "1" },
      { source: bad, fingerprint: "1" },
    ]);
    expect(refresher.status()).toEqual([
      { name: "codex-cli-models", at: 5001, tookMs: 1, ok: true, fetched: 2, applied: 2, models: ["codex-cli/a", "codex-cli/b"] },
      { name: "anthropic-models", at: 5001, tookMs: 1, ok: false, fetched: 0, applied: 0, error: "HTTP 401", models: [] },
    ]);
    expect(refresher.refreshing).toBe(false);
  });

  it("loads what earlier refreshes kept over the table", () => {
    const table = new ModelInfo([]);
    const store = memoryStore();
    store.save([row("kept")]);
    expect(new CatalogRefresher(() => store, { table }).loadStored()).toBe(1);
    expect(table.lookup("codex-cli/kept")).toBeDefined();
  });
});

describe("knownModels", () => {
  it("lists the catalog, a hidden model left out — no hand-kept list beside it", () => {
    const hidden = "codex-cli/test-hidden-model";
    ModelInfo.instance.upsert({ route: "codex-cli", model: "test-hidden-model", available: false });
    ModelInfo.instance.upsert({ route: "codex-cli", model: "test-shown-model" });
    const ids = knownModels().map((m) => m.id);
    expect(ids).toContain("codex-cli/test-shown-model");
    expect(ids).not.toContain(hidden);
    // What the presets name is in the catalog now, not in a list kept beside it.
    expect(ids).toContain("anthropic/claude-opus-5-5");
  });
});
