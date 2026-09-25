import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelStoreAt } from "../src/index";

describe("the models table — the catalog as this machine last learned it (decision 0009)", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jaira-models-"));
    dbFile = join(dir, "system", "jaira.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reading never creates a root that does not exist yet", () => {
    expect(modelStoreAt(dbFile)).toBeUndefined();
    expect(existsSync(dbFile)).toBe(false);
  });

  it("round-trips a row whole, and a later save of the same key replaces it", () => {
    const store = modelStoreAt(dbFile, { create: true })!;
    const row = {
      route: "codex-cli",
      model: "gpt-5.6-sol",
      canonicalId: "gpt-5-6-sol",
      source: "codex-models",
      parameters: { type: "object", additionalProperties: false, properties: { reasoning: { type: "object", properties: { effort: { enum: ["low", "ultra"] } } } } },
    };
    store.save([row], 1);
    store.save([{ ...row, label: "GPT-5.6-Sol" }], 2);
    store.close();
    const again = modelStoreAt(dbFile)!;
    expect(again.load()).toEqual([{ ...row, label: "GPT-5.6-Sol" }]);
    again.close();
  });

  it("loads oldest refresh first, so loading in order leaves the newest standing", () => {
    const store = modelStoreAt(dbFile, { create: true })!;
    store.save([{ route: "anthropic", model: "b", source: "late" }], 20);
    store.save([{ route: "anthropic", model: "a", source: "early" }], 10);
    expect(store.load().map((r) => r.model)).toEqual(["a", "b"]);
    store.close();
  });
});
