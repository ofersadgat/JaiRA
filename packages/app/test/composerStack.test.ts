/**
 * The composer's permission stack (decision 0023 §4.1, rulings 8–11; §7.4): the form a conversation
 * keeps, the segments with their fold, the crumbs that are pickers and the tree, the remembered look,
 * what the Tools card writes as the tools layer, a pin, and the stack saved as a set — `composerStack.ts`.
 */
import { describe, expect, it } from "vitest";
import { defaultUiState, parsePermissionSet, type PermissionSetTree, type PermissionSetTreeSet, type PermissionStackView } from "@jaira/shared/browser";
import {
  belowSetOf,
  browserModeOf,
  childrenOf,
  collapsedOf,
  collapsedWordsOf,
  crumbsOf,
  decidedTagOf,
  effectiveMapOf,
  footFitOf,
  layerSegmentsOf,
  ownedFormOf,
  pinnedConfigOf,
  referenceOfPick,
  runtimeAnswersOf,
  runtimeMarkOf,
  runtimeRowsOf,
  runtimeWordsOf,
  saveStackRequestOf,
  segmentsOf,
  segmentWordsOf,
  stackBucketOf,
  stackFormOf,
  stackRowsOf,
  stackSettingsOf,
  STACK_BROWSER_MODE,
  standingOf,
  toolsWriteOf,
  treeAtOf,
  treeRowsOf,
  withLayerAdded,
  withLayerMoved,
  withLayerRemoved,
  withLayerSwapped,
  type LayerSegment,
} from "../src/renderer/composerStack";
import { mapOfSettings } from "../src/renderer/composerModel";
import { withMode } from "../src/renderer/uiState";

const ASK_FIRST = "$/permission-sets/chat/ask-first";
const BUILD = "$/permission-sets/app/build";
const DOCS = "$/permission-sets/web/docs-sites";

describe("the form a conversation keeps (§2.6)", () => {
  it("reads a stack as its layers, oldest first, and the tools layer's own lines beside them", () => {
    expect(stackFormOf({ permissionSet: { layers: [ASK_FIRST, BUILD], write_file: "allow" } as never })).toEqual({ layers: [ASK_FIRST, BUILD], tools: { write_file: "allow" } });
    // A `$ref` copy is its one layer; a bare reference is a stack of one; a whole map, its tools layer alone.
    expect(stackFormOf({ permissionSet: { $ref: ASK_FIRST, shell: "allow" } as never })).toEqual({ layers: [ASK_FIRST], tools: { shell: "allow" } });
    expect(stackFormOf({ permissionSet: ASK_FIRST as never })).toEqual({ layers: [ASK_FIRST], tools: {} });
    expect(stackFormOf({ permissionSet: { read_file: "allow" } as never })).toEqual({ layers: [], tools: { read_file: "allow" } });
  });

  it("takes the state's set as the bottom while nothing is chosen here, with no lines of its own", () => {
    expect(stackFormOf({ tools: ["read_file"], permissions: { source: ASK_FIRST } as never })).toEqual({ layers: [ASK_FIRST], tools: undefined });
    // A state whose map is written in place: the bottom of the stack it was lowered from.
    expect(stackFormOf({ tools: [], permissions: { source: "inline", stack: { layers: [{ id: "chat/ask-first", reference: "$SYSTEM/permission-sets/chat/ask-first" }, { id: "inline" }] } } as never })).toEqual({
      layers: ["$SYSTEM/permission-sets/chat/ask-first"],
      tools: undefined,
    });
    expect(stackFormOf({})).toEqual({ layers: [], tools: undefined });
  });

  it("is kept as the stack shape, and the renderer never parses `layers` as a line", () => {
    expect(stackSettingsOf({ layers: [ASK_FIRST], tools: { glob: "unavailable" } })).toEqual({ layers: [ASK_FIRST], glob: "unavailable" });
    const settings = { permissionSet: { layers: [ASK_FIRST], read_file: "allow" } as never };
    // What chunk 3 left: `permissionSetOfSettings` refused `layers`. The composer reads the lines alone.
    expect(mapOfSettings(settings).entries["read_file"]).toMatchObject({ mode: "allow" });
    expect(Object.keys(mapOfSettings(settings).entries)).toEqual(["read_file"]);
  });

  it("moves, swaps, adds and removes the conversation's own layers", () => {
    const form = { layers: [ASK_FIRST, BUILD, DOCS], tools: {} };
    expect(withLayerMoved(form, 2, -1).layers).toEqual([ASK_FIRST, DOCS, BUILD]);
    // Moving the bottom later makes the next layer the bottom: two presets stack like any two layers.
    expect(withLayerMoved(form, 0, 1).layers).toEqual([BUILD, ASK_FIRST, DOCS]);
    expect(withLayerMoved(form, 0, -1)).toBe(form);
    expect(withLayerSwapped(form, 0, "$/permission-sets/chat/read-only").layers[0]).toBe("$/permission-sets/chat/read-only");
    expect(withLayerAdded(form, "$/permission-sets/review/strict").layers.at(-1)).toBe("$/permission-sets/review/strict");
    expect(withLayerRemoved(form, 1).layers).toEqual([ASK_FIRST, DOCS]);
  });
});

describe("the tools layer the Tools card writes (§2.6 step 5, ruling 8)", () => {
  const below = { read_file: "ask", web_fetch: "ask", shell: "ask", other: "ask" };
  const form = { layers: [ASK_FIRST], tools: {} };

  it("draws what the stack comes to, and writes back only what differs — `unavailable` for a tool unticked over a layer that offers it", () => {
    const map = effectiveMapOf(form, below, { entries: {} });
    expect(Object.keys(map.entries).sort()).toEqual(["read_file", "shell", "web_fetch"]);
    const lower = belowSetOf(below);
    // Nothing changed: nothing written.
    expect(toolsWriteOf(form, lower, map).tools).toEqual({});
    const next = parsePermissionSet({ read_file: "allow", shell: "ask", other: "ask" }).permissionSet;
    expect(toolsWriteOf(form, lower, next)).toEqual({ layers: [ASK_FIRST], tools: { read_file: "allow", web_fetch: "unavailable" } });
  });

  it("reads a tool the tools layer made unavailable as not offered", () => {
    const map = effectiveMapOf({ layers: [ASK_FIRST], tools: { web_fetch: "unavailable" } }, below, { entries: {} });
    expect(map.entries["web_fetch"]).toBeUndefined();
  });

  it("over nothing, is the whole map", () => {
    const next = parsePermissionSet({ read_file: "allow", other: "deny" }).permissionSet;
    expect(toolsWriteOf({ layers: [], tools: {} }, belowSetOf({}), next).tools).toEqual({ read_file: "allow", other: "deny" });
  });

  it("owns an inherited stack before an edit: the state's lines beyond the stack under it become the tools layer", () => {
    const inherited = parsePermissionSet({ ...below, shell: "allow" }).permissionSet;
    expect(ownedFormOf({ layers: [ASK_FIRST], tools: undefined }, belowSetOf(below), inherited)).toEqual({ layers: [ASK_FIRST], tools: { shell: "allow" } });
    // An inherited map IS what the stack comes to.
    expect(effectiveMapOf({ layers: [ASK_FIRST], tools: undefined }, below, inherited)).toBe(inherited);
  });
});

const viewOf = (layers: PermissionStackView["layers"]): Pick<PermissionStackView, "layers"> => ({ layers });

describe("the segments (§4.1, §7.4)", () => {
  const view = viewOf([
    { id: "chat/ask-first", reference: "$SYSTEM/permission-sets/chat/ask-first", via: ASK_FIRST, scope: "built in", role: "bottom", icon: "ask", lines: 17 },
    { id: "project/build-safe", reference: "$JAIRA/permission-sets/project/build-safe", via: "$/permission-sets/project/build-safe", scope: "project", role: "standing", icon: "layers", lines: 2 },
    // A file built of layers is several layers, one `via`: one segment, the file itself.
    { id: "chat/ask-first", reference: "$SYSTEM/permission-sets/chat/ask-first", via: BUILD, scope: "built in", role: "named", icon: "ask", lines: 17 },
    { id: "app/build", reference: "$JAIRA/permission-sets/app/build", via: BUILD, scope: "project", role: "named", icon: "layers", lines: 4 },
    { id: "web/docs-sites", reference: "$BASE/permission-sets/web/docs-sites", via: DOCS, scope: "global", role: "named", icon: "web", lines: 1 },
    { id: "runtime", scope: "runtime", role: "runtime", icon: "history", lines: 3 },
    { id: "tools", scope: "this conversation", role: "own", icon: "tool", lines: 2 },
  ]);
  const form = { layers: [ASK_FIRST, BUILD, DOCS], tools: { glob: "allow", web_search: "unavailable" } };

  it("is one per layer, oldest first, a standing layer among them with no place in the form", () => {
    const layers = layerSegmentsOf(view, form);
    expect(layers.map((layer) => [layer.id, layer.role, layer.reference, layer.index])).toEqual([
      ["chat/ask-first", "bottom", ASK_FIRST, 0],
      ["project/build-safe", "standing", "$/permission-sets/project/build-safe", undefined],
      ["app/build", "named", BUILD, 1],
      ["web/docs-sites", "named", DOCS, 2],
    ]);
  });

  it("is drawn from the form alone until the engine has composed it", () => {
    expect(layerSegmentsOf(null, form).map((layer) => [layer.id, layer.role, layer.index])).toEqual([
      ["chat/ask-first", "bottom", 0],
      ["app/build", "named", 1],
      ["web/docs-sites", "named", 2],
    ]);
  });

  it("ends in tools and +, the run's answers riding on tools, and folds the middle into ⋯ n, keeping the first", () => {
    const layers = layerSegmentsOf(view, form);
    const whole = segmentsOf(layers, 9, 3, false);
    expect(whole.map((segment) => segmentWordsOf(segment))).toEqual(["chat/ask-first", "project/build-safe", "app/build", "web/docs-sites", "tools · 9", "+"]);
    // No runtime segment: the answers are the tools segment's mark, in --accent.
    expect(whole.map((segment) => runtimeMarkOf(segment))).toEqual([null, null, null, null, "· 3", null]);
    expect(runtimeMarkOf(segmentsOf(layers, 9, 0, false).at(-2)!)).toBeNull();
    const folded = segmentsOf(layers, 9, 3, true);
    expect(folded.map((segment) => segmentWordsOf(segment))).toEqual(["chat/ask-first", "⋯ 3", "tools · 9", "+"]);
    const fold = folded[1]!;
    expect(fold.kind === "fold" ? fold.layers.map((layer) => layer.id) : []).toEqual(["project/build-safe", "app/build", "web/docs-sites"]);
  });

  it("does not fold a middle of one: a fold of one layer hides one for one", () => {
    const two = layerSegmentsOf(viewOf(view.layers.filter((layer) => layer.via === ASK_FIRST || layer.via === DOCS)), { layers: [ASK_FIRST, DOCS], tools: {} });
    expect(segmentsOf(two, 1, 0, true).map((segment) => segment.kind)).toEqual(["layer", "layer", "tools", "add"]);
  });

  it("collapses to the shield, the bottom's icon and +n: the layers over the bottom, and one for what this conversation changed", () => {
    const layers = layerSegmentsOf(view, form);
    // Three layers over the bottom, and tools lines of its own.
    expect(collapsedOf(layers, 2, 0)).toMatchObject({ icon: "ask", more: 4 });
    expect(collapsedOf(layers, 0, 3).more).toBe(4);
    expect(collapsedOf(layers, 0, 0).more).toBe(3);
    // The bottom alone, nothing changed: no count.
    expect(collapsedWordsOf(collapsedOf(layers.slice(0, 1), 0, 0))).toBeNull();
    expect(collapsedWordsOf(collapsedOf(layers.slice(0, 1), 0, 1))).toBe("+1");
    expect(collapsedOf(layers.slice(0, 2), 1, 2).title).toBe("Permissions: chat/ask-first; 1 more layer: project/build-safe; 1 line of this conversation's own; 2 answers from this run");
  });

  it("fits the foot: the stack folds before any word drops, then collapses to the shield as the words drop", () => {
    const chips = [
      { full: 180, short: 110, icon: 30 },
      { full: 70, short: 60, icon: 30 },
    ];
    const stack = { full: 400, folded: 260, collapsed: 70 };
    // Chips 250 + gaps 10 + stack.
    expect(footFitOf(700, chips, stack, 5)).toEqual({ step: 0, look: "whole" });
    expect(footFitOf(600, chips, stack, 5)).toEqual({ step: 0, look: "folded" });
    expect(footFitOf(450, chips, stack, 5)).toEqual({ step: 1, look: "folded" });
    expect(footFitOf(300, chips, stack, 5)).toEqual({ step: 1, look: "collapsed" });
    expect(footFitOf(220, chips, stack, 5)).toEqual({ step: 2, look: "collapsed" });
    expect(footFitOf(100, chips, stack, 5)).toEqual({ step: 3, look: "collapsed" });
    // The live note's words go with the chips' while they have words.
    expect(footFitOf(700, chips, stack, 5, 60)).toEqual({ step: 0, look: "folded" });
  });

  it("lists this stack above the scopes in the shield's browser: each layer oldest first, then tools", () => {
    const layers = layerSegmentsOf(view, form);
    expect(stackRowsOf(layers, 9, 3).map((row) => [row.kind, row.label, row.hint])).toEqual([
      ["root", "This conversation", "oldest first"],
      ["layer", "chat/ask-first", "built in · 17 lines"],
      ["layer", "project/build-safe", "project · pinned · 2 lines"],
      ["layer", "app/build", "project · 4 lines"],
      ["layer", "web/docs-sites", "global · 1 line"],
      ["tools", "tools", "9 offered · 3 from this run"],
    ]);
  });
});

describe("the run's answers, on the Tools card's lines (2026-11-03)", () => {
  const answers = runtimeAnswersOf({ read_file: "allow", "npm run build @ packages": "allow", "git commit": "deny", git: "allow", "cargo build": "allow" });

  it("marks each answer on the line it is about: a tool, a command line, a program's group, else a line of its own", () => {
    const rows = runtimeRowsOf(answers, ["read_file", "shell"], ["npm run build", "git push"], ["npm", "git"]);
    expect(rows.byTool["read_file"]?.map((answer) => answer.key)).toEqual(["read_file"]);
    expect(rows.bySubject["npm run build"]?.map((answer) => [answer.width, answer.place])).toEqual([["npm run build", "packages"]]);
    // `git commit` has no line of its own, and `git` is the program: both are lines inside git's group.
    expect(rows.byProgram["git"]?.map((answer) => answer.width)).toEqual(["git commit", "git"]);
    expect(rows.loose.map((answer) => answer.width)).toEqual(["cargo build"]);
  });

  it("reads as `this run · allow`, and says where", () => {
    expect(runtimeWordsOf({ decision: "deny", place: undefined })).toBe("this run · deny");
    expect(runtimeWordsOf({ decision: "allow", place: "packages" })).toBe("this run · allow in packages");
  });
});

const set = (scope: PermissionSetTreeSet["scope"], bucket: string, name: string, extra: Partial<PermissionSetTreeSet> = {}): PermissionSetTreeSet => {
  const token = scope === "built in" ? "$SYSTEM" : scope === "global" ? "$BASE" : "$JAIRA";
  return { id: `${bucket}/${name}`, name, bucket, scope, reference: `$/permission-sets/${bucket}/${name}`, explicit: `${token}/permission-sets/${bucket}/${name}`, file: `${scope}/permission-sets/${bucket}/${name}.json`, lines: 17, icon: "ask", inStack: false, ...extra };
};
const TREE: PermissionSetTree = {
  scopes: [
    {
      scope: "built in",
      layer: "system",
      label: "built in",
      sets: [],
      buckets: [
        { name: "chat", path: "chat", buckets: [], sets: [set("built in", "chat", "ask-first", { inStack: true, shadowedBy: "project" }), set("built in", "chat", "read-only"), set("built in", "chat", "auto")] },
        { name: "chat_control", path: "chat_control", buckets: [], sets: [set("built in", "chat_control", "ask-first")] },
      ],
    },
    {
      scope: "global",
      layer: "base",
      label: "~/.jaira",
      sets: [],
      buckets: [{ name: "feature", path: "feature", sets: [], buckets: [{ name: "implementation", path: "feature/implementation", buckets: [], sets: [set("global", "feature/implementation", "writes-asking")] }] }],
    },
    { scope: "project", layer: "project", label: ".jaira", sets: [], buckets: [{ name: "chat", path: "chat", buckets: [], sets: [set("project", "chat", "ask-first", { lines: 18 })] }] },
    { scope: "runtime", label: "runtime", buckets: [], sets: [{ id: "runtime", name: "runtime", bucket: "", scope: "runtime", file: "this task's answers, for this run", lines: 2, icon: "history", inStack: true }] },
  ],
};

describe("the crumbs that are pickers (§4.1)", () => {
  it("are the set's path, each dropping what sits beside it — the scopes, a scope's buckets, a bucket's sets", () => {
    const crumbs = crumbsOf(TREE, { scope: "built in", bucket: "chat", set: "chat/ask-first" });
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Built in", "chat", "ask-first.json"]);
    // The runtime scope is this task's answers, no file: not a place to pick a layer from.
    expect(crumbs[0]!.siblings.map((choice) => choice.label)).toEqual(["Built in", "Global", "Project"]);
    expect(crumbs[1]!.siblings.map((choice) => choice.label)).toEqual(["chat", "chat_control"]);
    expect(crumbs[2]!.siblings.map((choice) => choice.label)).toEqual(["ask-first.json", "read-only.json", "auto.json"]);
    expect(crumbs[2]!.on).toBe("set:built in:chat/ask-first");
    // So swapping ask-first for read-only is two presses: the set's crumb, then its sibling.
    expect(crumbs[2]!.siblings[1]!.set?.id).toBe("chat/read-only");
  });

  it("walk a nested bucket a folder at a time, and drill into a folder picked", () => {
    const crumbs = crumbsOf(TREE, { scope: "global", bucket: "feature/implementation", set: "feature/implementation/writes-asking" });
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Global", "feature", "implementation", "writes-asking.json"]);
    expect(childrenOf(TREE, { scope: "global", bucket: "" }).map((choice) => [choice.kind, choice.label])).toEqual([["bucket", "feature"]]);
    expect(childrenOf(TREE, { scope: "global", bucket: "feature" }).map((choice) => [choice.kind, choice.label, choice.hint])).toEqual([["bucket", "implementation", "1 set"]]);
    // With no set chosen yet the last crumb asks for one.
    expect(crumbsOf(TREE, { scope: "built in", bucket: "chat" }).at(-1)!.label).toBe("choose a set");
  });

  it("find a layer where its reference names it: the copy named exactly, else the nearest", () => {
    expect(treeAtOf(TREE, "$SYSTEM/permission-sets/chat/ask-first", "chat/ask-first")).toEqual({ scope: "built in", bucket: "chat", set: "chat/ask-first" });
    // `$/…` finds the nearest copy: the project's, which shadows what ships.
    expect(treeAtOf(TREE, ASK_FIRST, "chat/ask-first")).toEqual({ scope: "project", bucket: "chat", set: "chat/ask-first" });
  });

  it("lay what was looked at: a shadowed copy by its exact reference, any other by the nearest", () => {
    expect(referenceOfPick(set("built in", "chat", "ask-first", { shadowedBy: "project" }))).toBe("$SYSTEM/permission-sets/chat/ask-first");
    expect(referenceOfPick(set("built in", "chat", "read-only"))).toBe("$/permission-sets/chat/read-only");
  });
});

describe("the expanded browser's tree (§4.1)", () => {
  it("opens every scope and the bucket that holds the selection, with each set's icon and whether it is in the stack", () => {
    const rows = treeRowsOf(TREE, {}, { scope: "built in", bucket: "chat", set: "chat/read-only" });
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.label}${row.on ? " ←" : ""}${row.inStack ? " (in the stack)" : ""}`)).toEqual([
      "Built in",
      "  chat",
      "    ask-first.json (in the stack)",
      "    read-only.json ←",
      "    auto.json",
      "  chat_control",
      "Global",
      "  feature",
      "Project",
      "  chat",
    ]);
  });

  it("opens and shuts what the person toggled, over that", () => {
    const rows = treeRowsOf(TREE, { "scope:built in": false, "bucket:global:feature": true }, undefined);
    expect(rows.map((row) => row.label)).toEqual(["Built in", "Global", "feature", "implementation", "Project", "chat"]);
  });
});

describe("the remembered look (ruling 11)", () => {
  it("is compact until ⤢, and stays expanded — for every segment — until ⤡", () => {
    const ui = defaultUiState();
    expect(browserModeOf(ui)).toBe("compact");
    expect(browserModeOf(withMode(ui, STACK_BROWSER_MODE, "expanded"))).toBe("expanded");
    // A word another version wrote cannot put it into a look it no longer has.
    expect(browserModeOf(withMode(ui, STACK_BROWSER_MODE, "docked"))).toBe("compact");
    expect(browserModeOf(undefined)).toBe("compact");
  });
});

describe("a pin, and the stack saved as a set (§7.3, §7.4)", () => {
  it("pins a layer to the bucket's standing layers in the project's settings, starting from what stands", () => {
    const doc = { model: "x", permissions: { layers: { app: ["$/permission-sets/app/a"] } } };
    expect(pinnedConfigOf(doc, ["$/permission-sets/chat/base-one"], "chat", BUILD, true)).toEqual({
      model: "x",
      permissions: { layers: { app: ["$/permission-sets/app/a"], chat: ["$/permission-sets/chat/base-one", BUILD] } },
    });
    // Pinned already: no second copy. Unpinned: taken out by its set id, whatever root wrote it.
    expect(pinnedConfigOf({ permissions: { layers: { chat: [BUILD] } } }, [], "chat", BUILD, true)).toEqual({ permissions: { layers: { chat: [BUILD] } } });
    expect(pinnedConfigOf({ permissions: { layers: { chat: ["$JAIRA/permission-sets/app/build"] } } }, [], "chat", BUILD, false)).toEqual({ permissions: { layers: { chat: [] } } });
    expect(pinnedConfigOf(null, undefined, "chat", BUILD, true)).toEqual({ permissions: { layers: { chat: [BUILD] } } });
  });

  it("reads the standing layers and the bucket they are by — the bottom's", () => {
    expect(standingOf({ permissions: { layers: { chat: [BUILD] } } }, "chat")).toEqual([BUILD]);
    expect(standingOf({}, "chat")).toEqual([]);
    expect(stackBucketOf({ layers: ["$/permission-sets/feature/implementation/writes-asking"], tools: {} })).toBe("feature/implementation");
    expect(stackBucketOf({ layers: [], tools: {} })).toBe("chat");
  });

  it("saves the stack's own layers and its tools layer's lines, in the bottom's bucket", () => {
    expect(saveStackRequestOf({ layers: [ASK_FIRST, DOCS], tools: { web_search: "unavailable" } }, "  docs-first ", "project")).toEqual({
      layer: "project",
      bucket: "chat",
      name: "docs-first",
      permissionSet: { layers: [ASK_FIRST, DOCS], web_search: "unavailable" },
    });
  });
});

describe("runtime and Everything (§4.1, §7.4)", () => {
  it("lists this run's answers by width and place", () => {
    expect(runtimeAnswersOf({ "node build.mjs @ packages/dc-runtime": "allow", "runner:npm": "allow" })).toEqual([
      { key: "node build.mjs @ packages/dc-runtime", width: "node build.mjs", place: "packages/dc-runtime", decision: "allow" },
      { key: "runner:npm", width: "runner:npm", place: undefined, decision: "allow" },
    ]);
  });

  it("tags a line with the layer that decided it — the one that took a tool away first", () => {
    const view: Pick<PermissionStackView, "lines"> = {
      lines: [
        { subject: "read_file", value: "ask", layer: "chat/ask-first", places: {} },
        { subject: "web_search", value: "unavailable", layer: "tools", places: {}, unavailable: "tools" },
        { subject: "npm run build", value: { packages: "allow" }, places: { packages: { decision: "allow", layer: "app/build" } } },
      ],
    };
    expect(decidedTagOf(view, "read_file")).toBe("chat/ask-first");
    expect(decidedTagOf(view, "web_search")).toBe("tools");
    expect(decidedTagOf(view, "npm run build")).toBe("app/build");
    expect(decidedTagOf(view, "glob")).toBeUndefined();
  });
});

// Keep the type in use: a segment's shape is what the bar and the cards are handed.
const _segment: LayerSegment | undefined = undefined;
void _segment;
