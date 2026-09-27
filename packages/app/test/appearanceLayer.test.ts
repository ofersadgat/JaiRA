/**
 * The look read from, and written to, the layered configuration (`appearanceLayer.ts`): a change is a
 * few paths of ONE layer's document, never the merged one, and it is taken out of the stronger layers
 * so it shows.
 */
import { describe, expect, it } from "vitest";
import { clearedAbove, defaultAppearanceConfig, mergeConfigLayers, parseConfig, statedChanges, withPaths, type ConfigView } from "@jaira/shared";
import { lookOf, rendererWrites, rendererWritten, targetLayerOf } from "../src/renderer/appearanceLayer";

function view(docs: { base?: unknown; project?: unknown; you?: unknown }): ConfigView {
  return {
    system: null,
    base: (docs.base ?? null) as never,
    project: (docs.project ?? null) as never,
    you: (docs.you ?? null) as never,
    effective: parseConfig(mergeConfigLayers([docs.base, docs.project, docs.you]) ?? {}) as never,
    baseFile: "",
    projectFile: "",
    youFile: "",
    baseDir: "",
  };
}

describe("the look the window paints", () => {
  it("is the effective block, and the defaults before anything is read", () => {
    expect(lookOf(null)).toEqual(defaultAppearanceConfig());
    expect(lookOf(view({ base: { appearance: { palette: "pastel" } }, you: { appearance: { mode: "dark" } } }))).toMatchObject({ palette: "pastel", mode: "dark" });
  });
});

describe("writing a layer's document", () => {
  it("writes the paths it is given and takes an emptied container with it", () => {
    const doc = { memo: { enabled: true }, appearance: { palette: "zinc" } };
    expect(withPaths(doc, [["appearance.mode", "dark"]])).toEqual({ memo: { enabled: true }, appearance: { palette: "zinc", mode: "dark" } });
    expect(withPaths(doc, [["appearance.palette", undefined]])).toEqual({ memo: { enabled: true } });
    // Never the document it was handed.
    expect(doc.appearance).toEqual({ palette: "zinc" });
  });

  it("lands a change made outside Settings where the window will show it", () => {
    // The strongest layer that states it — a flip written under a stronger layer would do nothing.
    const layered = view({ base: { appearance: { mode: "light" } }, project: { appearance: { mode: "dark" } } });
    expect(targetLayerOf(layered, "appearance.mode")).toBe("project");
    // Nobody states it: it is the person's own.
    expect(targetLayerOf(view({}), "appearance.mode")).toBe("you");
  });
});

describe("a change made on one layer's page (the person's rule, 2026-09-25)", () => {
  it("is taken out of every stronger layer that states it, so it shows", () => {
    // The bug it fixes: a theme picked on Shared snapped back to the personal layer's.
    const layered = view({
      base: { appearance: { palette: "ink" } },
      project: { appearance: { palette: "classic", mode: "dark" } },
      you: { appearance: { palette: "pastel-rail", buckets: "box" }, memo: { enabled: true } },
    });
    const next = withPaths(layered.base, [["appearance.palette", "zinc"]]);
    expect(clearedAbove(layered, "base", next)).toEqual([
      { layer: "project", doc: { appearance: { mode: "dark" } } },
      { layer: "you", doc: { appearance: { buckets: "box" }, memo: { enabled: true } } },
    ]);
    // Nothing stronger than the personal layer, and nothing it did not change.
    expect(clearedAbove(layered, "you", withPaths(layered.you, [["appearance.palette", "zinc"]]))).toEqual([]);
    expect(clearedAbove(layered, "base", layered.base)).toEqual([]);
  });

  it("never reaches past its own document when it takes a statement out", () => {
    const layered = view({ base: { appearance: { palette: "ink" } }, you: { appearance: { palette: "zinc" } } });
    expect(clearedAbove(layered, "base", withPaths(layered.base, [["appearance.palette", undefined]]))).toEqual([]);
  });

  it("takes out a stronger parent that is not a block, and leaves the lists layers add to", () => {
    // Built by hand: the parser would refuse the `null`, and only the layers' own documents matter here.
    const layered = { ...view({}), base: {}, you: { executors: { reviewer: null }, files: { hidden: ["dist"] } } } as unknown as ConfigView;
    const next = { executors: { reviewer: { model: "sonnet" } }, files: { hidden: ["build"] } };
    expect(statedChanges(layered.base, next)).toEqual([["executors", "reviewer", "model"], ["files", "hidden"]]);
    expect(clearedAbove(layered, "base", next)).toEqual([{ layer: "you", doc: { files: { hidden: ["dist"] } } }]);
  });

  it("takes a written path out of the stronger layers even when this layer already said the same (the person, 2026-09-26)", () => {
    // The person's machine: Shared says zinc, Just you says pastel-rail over it. Picking zinc on Shared
    // left Shared's document as it was, so read off the document alone there was nothing to carry up.
    const layered = view({
      base: { appearance: { palette: "zinc", laneColors: null } },
      you: { appearance: { palette: "pastel-rail", laneColors: null, editorTheme: "solarized-light" } },
    });
    const writes = [["appearance.palette", "zinc"], ["appearance.laneColors", null]] as const;
    const next = withPaths(layered.base, writes);
    expect(clearedAbove(layered, "base", next)).toEqual([]);
    expect(clearedAbove(layered, "base", next, writes.map(([path]) => path))).toEqual([{ layer: "you", doc: { appearance: { editorTheme: "solarized-light" } } }]);
    // A ↺ is a removal, and never reaches past its own document.
    expect(clearedAbove(layered, "base", withPaths(layered.base, [["appearance.palette", undefined]]), ["appearance.palette"])).toEqual([]);
  });

  it("takes out only the leaves a block written whole states", () => {
    const layered = view({ base: {}, you: { appearance: { editors: { code: { wrap: true, brackets: false } } } } });
    const next = withPaths(layered.base, [["appearance.editors.code", { wrap: false }]]);
    expect(clearedAbove(layered, "base", next, ["appearance.editors.code"])).toEqual([{ layer: "you", doc: { appearance: { editors: { code: { brackets: false } } } } }]);
  });

  it("keeps a key with dots of its own whole — an event name", () => {
    const layered = { ...view({}), base: {}, you: { events: { "git.push": { enabled: false }, "git.merge_request.opened": { enabled: true } } } } as unknown as ConfigView;
    const next = withPaths({}, [[["events", "git.push", "enabled"], true]]);
    expect(next).toEqual({ events: { "git.push": { enabled: true } } });
    expect(clearedAbove(layered, "base", next)).toEqual([{ layer: "you", doc: { events: { "git.merge_request.opened": { enabled: true } } } }]);
  });
});

describe("a renderer edit, in one layer", () => {
  const layer = { appearance: { renderers: { "text/markdown:preview": { read: "source", theme: { read: "one-dark" } } } } };

  it("states a field, and takes one back with null so it inherits again", () => {
    const [[path, block]] = rendererWrites(layer, [{ key: "text/markdown:preview", edit: { read: null, write: "monaco" } }]) as [[string, unknown]];
    expect(path).toBe("appearance.renderers");
    expect(block).toEqual({ "text/markdown:preview": { write: "monaco", theme: { read: "one-dark" } } });
  });

  it("takes a whole line back, and leaves no empty line behind", () => {
    expect(rendererWrites(layer, [{ key: "text/markdown:preview", edit: null }])).toEqual([["appearance.renderers", undefined]]);
    expect(rendererWrites(layer, [{ key: "text/markdown:preview", edit: { read: null, theme: { read: null } } }])).toEqual([["appearance.renderers", undefined]]);
  });

  it("writes an empty off-list as nothing said", () => {
    const [[, block]] = rendererWrites(null, [{ key: "text/css:text", edit: { off: [] } }, { key: "text/x:text", edit: { off: ["a", "a"] } }]) as [[string, unknown]];
    expect(block).toEqual({ "text/x:text": { off: ["a"] } });
  });
});

describe("what a renderer edit states, for the stronger layers", () => {
  it("names each field picked, and none taken back", () => {
    expect(
      rendererWritten([
        { key: "text/markdown:preview", edit: { read: "source", write: null, theme: { read: "one-dark", write: null } } },
        { key: "text/css:text", edit: { off: [] } },
        { key: "text/x:text", edit: null },
      ]),
    ).toEqual([
      ["appearance", "renderers", "text/markdown:preview", "read"],
      ["appearance", "renderers", "text/markdown:preview", "theme", "read"],
    ]);
  });

  it("takes a renderer picked on Shared out of Just you, leaving its other lines", () => {
    const layered = view({
      base: { appearance: { renderers: { "text/markdown:preview": { read: "source" } } } },
      you: { appearance: { renderers: { "text/markdown:preview": { read: "live", write: "monaco" }, "text/css:text": { read: "source" } } } },
    });
    const edits = [{ key: "text/markdown:preview", edit: { read: "source" } }];
    const next = withPaths(layered.base, rendererWrites(layered.base, edits));
    expect(clearedAbove(layered, "base", next, rendererWritten(edits))).toEqual([
      { layer: "you", doc: { appearance: { renderers: { "text/markdown:preview": { write: "monaco" }, "text/css:text": { read: "source" } } } } },
    ]);
  });
});
