import { describe, expect, it } from "vitest";
import { chatStackSettingsOf, permissionStackOf, permissionStackViewOf, type PermissionSetReader } from "@jaira/shared";
import { stackFormOf, withLayerMovedTo, withLayerRemoved, withLayerReplaced, withUnsavedAdded, withUnsavedLines, withUnsavedMerged, nextUnsavedKey, type StackForm } from "../src/renderer/composerStack";
import { boardLayersOf, layerActsOf, mergedLines } from "../src/renderer/permissionBoard";

/** A reader over a few sets, as the stack follows references. */
const SETS: Record<string, Record<string, unknown>> = {
  "deny-all": { read_file: "deny", grep: "deny", other: "deny" },
  "ask-all": { read_file: "ask", grep: "ask", other: "ask" },
  "app/build": { read_file: { "src/**": "allow" } },
};
const read: PermissionSetReader = ((reference: string) => {
  const id = reference.replace(/^\$\/permission-sets\//, "");
  return SETS[id] !== undefined ? { value: SETS[id], from: reference } : undefined;
}) as unknown as PermissionSetReader;

describe("an unsaved layer in a conversation's stack", () => {
  it("is a layer of its own, named in `layers` and kept under `$unsaved`, in its place", () => {
    const node = chatStackSettingsOf(["$/permission-sets/deny-all", "$unsaved/1", "$/permission-sets/app/build"], { grep: "allow" }, { "1": { read_file: { "docs/**": "allow" } }, "2": { gone: "allow" } });
    expect(node["$unsaved"]).toEqual({ "1": { read_file: { "docs/**": "allow" } } });
    const issues: never[] = [];
    const layers = permissionStackOf(node, read, "", issues, { ownId: "tools" });
    expect(issues).toEqual([]);
    expect(layers?.map((layer) => [layer.id, layer.role])).toEqual([
      ["deny-all", "bottom"],
      ["unsaved:1", "named"],
      ["app/build", "named"],
      ["tools", "own"],
    ]);
    expect(layers?.[1]).toMatchObject({ decl: { read_file: { "docs/**": "allow" } }, unsaved: { key: "1", name: "Layer 1" } });
    const view = permissionStackViewOf(layers!, () => ({ scope: "this conversation", icon: "layers" }));
    expect(view.layers[1]).toMatchObject({ unsaved: { key: "1" }, own: { read_file: { "docs/**": "allow" } } });
  });
});

describe("the stack form's layer acts", () => {
  const form: StackForm = stackFormOf({ permissionSet: { layers: ["$/permission-sets/deny-all", "$/permission-sets/app/build"], grep: "allow" } } as never);

  it("adds an empty unsaved layer where the + was pressed, with the next free key", () => {
    const added = withUnsavedAdded(form, 1);
    expect(added.layers).toEqual(["$/permission-sets/deny-all", "$unsaved/1", "$/permission-sets/app/build"]);
    expect(added.unsaved).toEqual({ "1": {} });
    expect(nextUnsavedKey(added)).toBe("2");
    expect(withUnsavedAdded(form, 0).layers[0]).toBe("$unsaved/1");
  });

  it("moves a layer to a place, and keeps an unsaved layer's lines while it is named", () => {
    const added = withUnsavedLines(withUnsavedAdded(form, 1), "1", () => ({ read_file: "ask" }));
    expect(withLayerMovedTo(added, 1, 2).layers).toEqual(["$/permission-sets/deny-all", "$/permission-sets/app/build", "$unsaved/1"]);
    expect(withLayerRemoved(added, 1).unsaved).toEqual({});
  });

  it("replaces an unsaved layer with a set, its lines going; merges a set into it, the set winning where both say", () => {
    const held = withUnsavedLines(withUnsavedAdded(form, 1), "1", () => ({ read_file: { "src/**": "allow" }, grep: "ask" }));
    const replaced = withLayerReplaced(held, 1, "$/permission-sets/ask-all");
    expect(replaced.layers[1]).toBe("$/permission-sets/ask-all");
    expect(replaced.unsaved).toEqual({});
    const merged = withUnsavedMerged(held, "1", { read_file: "deny", other: "deny" });
    expect(merged.unsaved!["1"]).toEqual({ read_file: { "**": "deny", "src/**": "allow" }, grep: "ask", other: "deny" });
  });

  it("merges line by line: a plain answer is the set's everywhere, the layer's places stay", () => {
    expect(mergedLines({ read_file: { "src/**": "allow", "**": "ask" } }, { read_file: "deny" })).toEqual({ read_file: { "**": "deny", "src/**": "allow" } });
    expect(mergedLines({ read_file: { "src/**": "allow" } }, { read_file: { "src/**": "ask" } })).toEqual({ read_file: { "src/**": "ask" } });
  });
});

describe("the board's layer heads", () => {
  const view = {
    layers: [
      { id: "deny-all", reference: "$/permission-sets/deny-all", via: "$/permission-sets/deny-all", scope: "built in" as const, role: "bottom" as const, icon: "layers", lines: 3 },
      { id: "safe", reference: "$/permission-sets/safe", via: "$/permission-sets/safe", scope: "project" as const, role: "standing" as const, icon: "layers", lines: 1 },
      { id: "unsaved:1", via: "$unsaved/1", scope: "this conversation" as const, role: "named" as const, icon: "layers", lines: 1, unsaved: { key: "1", name: "Layer 1" } },
      { id: "runtime", scope: "runtime" as const, role: "runtime" as const, icon: "history", lines: 0 },
      { id: "tools", scope: "this conversation" as const, role: "own" as const, icon: "chat", lines: 0 },
    ],
  };
  const layers = boardLayersOf(view);

  it("knows each layer's place in the conversation's order, and that an unsaved one is written with it", () => {
    expect(layers.map((layer) => [layer.label, layer.entry ?? null, layer.writes])).toEqual([
      ["Root · deny-all", 0, "none"],
      ["safe", null, "set"],
      ["Layer 1", 1, "unsaved"],
      ["This run", null, "none"],
      ["This conversation", null, "conversation"],
    ]);
  });

  it("lets the root and an unsaved layer swap, move and go; pins the run's answers and the conversation's lines", () => {
    expect(layerActsOf(layers[0]!)).toMatchObject({ swap: true, move: true, remove: true, addBefore: true });
    expect(layerActsOf(layers[1]!)).toMatchObject({ swap: false, move: false, unpin: true });
    expect(layerActsOf(layers[2]!)).toMatchObject({ swap: true, save: true });
    expect(layerActsOf(layers[3]!)).toMatchObject({ move: false, forget: true, addBefore: true });
    expect(layerActsOf(layers[4]!)).toMatchObject({ move: false, remove: false, clear: true, save: true });
  });
});
