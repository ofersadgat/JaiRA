/**
 * The configuration's writable layers in their order — Shared, then the project, then "Just you" —
 * and the two questions a settings row asks of them: what would this be WITHOUT my layer, and which
 * layer says so. `configLayering.test.ts` covers the merge rules themselves.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SOURCE,
  CONFIG_LAYERS,
  inheritedDoc,
  inheritedValue,
  layersBelow,
  mergeConfigLayers,
  parseConfig,
  statesPath,
  statingLayer,
  valueAtPath,
  type ConfigView,
} from "../src/index";

function view(docs: { base?: unknown; project?: unknown; you?: unknown }): ConfigView {
  return {
    system: null,
    base: (docs.base ?? null) as never,
    project: (docs.project ?? null) as never,
    you: (docs.you ?? null) as never,
    effective: parseConfig(mergeConfigLayers([docs.base, docs.project, docs.you]) ?? {}) as never,
    baseFile: "~/.jaira/settings.json",
    projectFile: docs.project === undefined ? "" : "/work/.jaira/settings.json",
    youFile: "~/.jaira/personal-settings.json",
    baseDir: "~/.jaira",
  };
}

describe("the layers' order", () => {
  it("is Shared, then the project, then you — weakest first", () => {
    expect(CONFIG_LAYERS).toEqual(["base", "project", "you"]);
    expect(layersBelow("you")).toEqual(["base", "project"]);
    expect(layersBelow("project")).toEqual(["base"]);
    expect(layersBelow("base")).toEqual([]);
  });

  it("merges three documents so the strongest stating a key wins it, key by key", () => {
    const merged = mergeConfigLayers([
      { memo: { enabled: true }, artifacts: { dir: "shared", inlineMaxBytes: 1 } },
      { artifacts: { dir: "project" } },
      { artifacts: { inlineMaxBytes: 2 }, appearance: { palette: "zinc" } },
    ]);
    expect(merged).toEqual({ memo: { enabled: true }, artifacts: { dir: "project", inlineMaxBytes: 2 }, appearance: { palette: "zinc" } });
  });

  it("skips an absent layer, and says nothing when every layer is absent", () => {
    expect(mergeConfigLayers([null, { memo: { enabled: true } }, undefined])).toEqual({ memo: { enabled: true } });
    expect(mergeConfigLayers([null, undefined, null])).toBeUndefined();
  });
});

describe("what a layer inherits, and from where", () => {
  const layered = view({
    base: { artifacts: { dir: "shared" }, appearance: { palette: "pastel" } },
    project: { artifacts: { dir: "project" } },
    you: { artifacts: { dir: "mine" }, appearance: { palette: "zinc", mode: "dark" } },
  });

  it("reads the weaker layers merged, and never the layer itself", () => {
    expect(inheritedDoc(layered, "you")).toEqual({ artifacts: { dir: "project" }, appearance: { palette: "pastel" } });
    expect(inheritedDoc(layered, "project")).toEqual({ artifacts: { dir: "shared" }, appearance: { palette: "pastel" } });
    expect(inheritedDoc(layered, "base")).toEqual({});
  });

  it("names the strongest layer stating a key — below a given one, when asked", () => {
    expect(statingLayer(layered, "artifacts.dir")).toBe("you");
    expect(statingLayer(layered, "artifacts.dir", "you")).toBe("project");
    expect(statingLayer(layered, "appearance.palette", "you")).toBe("base");
    expect(statingLayer(layered, "appearance.mode", "you")).toBe(BUILT_IN_SOURCE);
    expect(statingLayer(layered, "memo.enabled")).toBe(BUILT_IN_SOURCE);
  });

  it("answers the value a row would have without the layer, the shipped default where nobody states one", () => {
    expect(inheritedValue(layered, "artifacts.dir", "you")).toEqual({ value: "project", from: "project" });
    expect(inheritedValue(layered, "appearance.mode", "you")).toEqual({ value: "light", from: BUILT_IN_SOURCE });
    // A key with no default at all: nothing, and it is said to come from what ships.
    expect(inheritedValue(layered, "functions.smart.model", "you")).toEqual({ value: undefined, from: BUILT_IN_SOURCE });
  });

  it("counts null as a statement, since null is how a layer takes a palette's option back", () => {
    expect(statesPath({ appearance: { laneColors: null } }, "appearance.laneColors")).toBe(true);
    expect(statesPath({ appearance: {} }, "appearance.laneColors")).toBe(false);
    expect(valueAtPath({ a: [1] }, "a.0")).toBeUndefined();
  });
});
