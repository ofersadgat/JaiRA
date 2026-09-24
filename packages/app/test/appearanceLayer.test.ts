/**
 * The look read from, and written to, the layered configuration (`appearanceLayer.ts`): a change is a
 * few paths of ONE layer's document, never the merged one, and what a row pins is what it shows.
 */
import { describe, expect, it } from "vitest";
import { defaultAppearanceConfig, mergeConfigLayers, parseConfig, type ConfigView } from "@jaira/shared";
import { lookOf, pinnedValue, rendererWrites, targetLayerOf, withPaths } from "../src/renderer/appearanceLayer";

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

  it("pins what a row shows, and only the editor knobs a surface honours", () => {
    const look = defaultAppearanceConfig();
    expect(pinnedValue(look, "appearance.palette")).toBe(look.palette);
    expect(pinnedValue(look, "appearance.laneColors")).toBeNull();
    const editors = pinnedValue(look, "appearance.editors") as Record<string, Record<string, unknown>>;
    expect(Object.keys(editors["json"]!).sort()).toEqual(["lineHeight", "tabSize", "wrap"]);
    // And the layer it writes is one the parser accepts.
    expect(() => parseConfig({ appearance: { editors } })).not.toThrow();
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
