/**
 * A stack of permission sets, composed (decision 0023 §2): merged line by line with the newest saying,
 * `unavailable` resolved into "not offered", and who set each line and each place kept.
 */
import { describe, expect, it } from "vitest";
import {
  chatStackSettingsOf,
  composePermissionSetLayers,
  decidedBy,
  layerOfLine,
  permissionSetIdOf,
  permissionStackOf,
  resolveChatPermissionStack,
  toolsLayerOf,
} from "../src/permissionLayers";
import { permissionStackViewOf } from "../src/permissionSetTree";
import { holdsTool, parsePermissionSet, type PermissionSetReader } from "../src/permissionSets";
import { mcpGateModes, mergeEntryDecl, mergePermissionMode, offeredTools, shellSubjects } from "../src/permissionSets";

describe("one line under a newer one (§2.1)", () => {
  it("makes a plain decision below the `**` of a newer place map — the person's example", () => {
    expect(mergePermissionMode("deny", { "C:": "allow" })).toEqual({ "**": "deny", "C:": "allow" });
  });

  it("lets a plain decision cover everywhere and clear the places below it", () => {
    expect(mergePermissionMode({ "**": "deny", "C:": "allow" }, "ask")).toBe("ask");
  });

  it("combines two maps, the same place taking the newer decision", () => {
    expect(mergePermissionMode({ "**": "deny", src: "allow", infra: "deny" }, { src: "ask", docs: "allow" })).toEqual({ "**": "deny", src: "ask", infra: "deny", docs: "allow" });
  });

  it("does not make `unavailable` a place's decision: a map over it offers the tool at its places only", () => {
    expect(mergePermissionMode("unavailable", { src: "allow" })).toEqual({ src: "allow" });
  });

  it("keeps the implementation below unless the newer entry names one", () => {
    expect(mergeEntryDecl({ mode: "ask", implementation: "native" }, "allow")).toEqual({ mode: "allow", implementation: "native" });
    expect(mergeEntryDecl({ mode: "ask", implementation: "native" }, { mode: { src: "allow" }, implementation: "app" })).toEqual({ mode: { "**": "ask", src: "allow" }, implementation: "app" });
    expect(mergeEntryDecl({ mode: "ask", implementation: "native" }, "unavailable")).toBe("unavailable");
    // An entry that does not read is not merged: the newer one stands, for the parser to report.
    expect(mergeEntryDecl("allow", 7)).toBe(7);
  });
});

describe("a stack composed", () => {
  const ASK_FIRST = { read_file: "deny", "git push": "ask", shell: "ask", web_fetch: "ask", other: "ask" };
  const BUILD = { read_file: { "C:": "allow" }, git: "allow", "npm run build": { "packages/app": "allow" } };

  it("merges line by line: the person's example, and §2.2's git and git push", () => {
    const { permissionSet, issues } = composePermissionSetLayers([
      { id: "chat/ask-first", decl: ASK_FIRST },
      { id: "app/build", decl: BUILD },
    ]);
    expect(issues).toEqual([]);
    expect(permissionSet.entries["read_file"]).toEqual({ kind: "tool", mode: "deny", places: { "C:": "allow" } });
    // A newer `git: allow` does not override an older `git push: ask`: it did not name it.
    expect(shellSubjects(permissionSet)).toMatchObject({ git: "allow", "git push": "ask" });
    expect(permissionSet.other).toBe("ask");
  });

  it("keeps who said each line and each place", () => {
    const composed = composePermissionSetLayers([
      { id: "chat/ask-first", decl: ASK_FIRST },
      { id: "app/build", decl: BUILD },
      { id: "runtime", decl: { web_fetch: { "docs.example.com": "allow" } } },
    ]);
    expect(decidedBy(composed, "read_file")).toBe("chat/ask-first");
    expect(decidedBy(composed, "read_file", "C:")).toBe("app/build");
    expect(decidedBy(composed, "read_file", "src")).toBeUndefined();
    expect(decidedBy(composed, "git  push")).toBe("chat/ask-first");
    expect(decidedBy(composed, "git")).toBe("app/build");
    expect(decidedBy(composed, "npm run build")).toBeUndefined();
    expect(decidedBy(composed, "npm run build", "packages/app")).toBe("app/build");
    expect(decidedBy(composed, "web_fetch", "**")).toBe("chat/ask-first");
    expect(decidedBy(composed, "web_fetch", "docs.example.com")).toBe("runtime");
    expect(decidedBy(composed, "other")).toBe("chat/ask-first");
  });

  it("lets a newer plain decision take the whole line, its places and their provenance with it", () => {
    const composed = composePermissionSetLayers([
      { id: "chat/ask-first", decl: ASK_FIRST },
      { id: "app/build", decl: BUILD },
      { id: "tools", decl: { read_file: "allow" } },
    ]);
    expect(composed.permissionSet.entries["read_file"]).toEqual({ kind: "tool", mode: "allow" });
    expect(composed.provenance["read_file"]).toEqual({ everywhere: "tools", places: {} });
  });

  it("drops a tool the stack comes to `unavailable` on, says who took it, and lets a newer layer offer it again", () => {
    const base = { id: "chat/full", decl: { read_file: "allow", web_fetch: { mode: "allow", implementation: "native" }, mcp__figma: "allow", mcp__figma__delete: "allow", other: "allow" } };
    const tools = { id: "tools", decl: { web_fetch: "unavailable", mcp__figma__delete: "unavailable" } };
    const composed = composePermissionSetLayers([base, tools]);
    expect(composed.permissionSet.entries["web_fetch"]).toBeUndefined();
    expect(offeredTools(composed.permissionSet)).toEqual(["read_file"]);
    expect(composed.unavailable).toEqual({ web_fetch: "tools", mcp__figma__delete: "tools" });
    // The merged map still says it, for a stack saved as a set.
    expect(composed.decl["web_fetch"]).toBe("unavailable");
    // An MCP tool line stays, refused at the gate: absent, its server's `allow` would answer for it.
    expect(mcpGateModes(composed.permissionSet)).toEqual({ mcp__figma: "allow", mcp__figma__delete: "deny" });

    const back = composePermissionSetLayers([base, tools, { id: "this run", decl: { web_fetch: { "docs.example.com": "allow" } } }]);
    // Offered again at its place only — `unavailable` is not a `**` — and as ours: `unavailable` took
    // the agent's implementation with it.
    expect(back.permissionSet.entries["web_fetch"]).toEqual({ kind: "tool", places: { "docs.example.com": "allow" } });
    expect(back.provenance["web_fetch"]).toEqual({ places: { "docs.example.com": "this run" } });
    expect(back.unavailable).toEqual({ mcp__figma__delete: "tools" });
  });

  it("reports what is wrong with a layer against that layer, and keeps the older line it could not replace", () => {
    const { permissionSet, issues } = composePermissionSetLayers([
      { id: "chat/ask-first", decl: ASK_FIRST },
      { id: "app/broken", decl: { read_file: 7, "git commit": "unavailable" } },
    ]);
    expect(issues.map((issue) => [issue.layer, issue.path])).toEqual([
      ["app/broken", "read_file"],
      ["app/broken", "git commit"],
    ]);
    expect(permissionSet.entries["read_file"]).toEqual({ kind: "tool", mode: "deny" });
    expect(permissionSet.entries["git commit"]).toBeUndefined();
  });

  it("writes no `other` for a layer that says none, so an added layer never replaces the one below", () => {
    const { permissionSet } = composePermissionSetLayers([
      { id: "chat/read-only", decl: { read_file: "allow", other: "deny" } },
      { id: "web/docs", decl: { web_fetch: "allow" } },
    ]);
    expect(permissionSet.other).toBe("deny");
  });

  it("offers nothing for a stack with nothing in it", () => {
    expect(composePermissionSetLayers([]).permissionSet).toEqual({ entries: {} });
  });
});

describe("the stack a node is, in §2.6's order", () => {
  /** A reader over a table of set files, as the loader's follows `$/permission-sets/<id>`. */
  const readerOver = (files: Record<string, unknown>): PermissionSetReader => (reference) => {
    const id = /permission-sets\/(.+)$/.exec(reference)?.[1];
    const value = id !== undefined ? files[id] : undefined;
    if (value === undefined) throw new Error(`reference '${reference}' matches no file`);
    return { value, key: id!, from: reference };
  };
  const FILES = {
    "chat/ask-first": { read_file: "ask", write_file: "ask", web_fetch: "ask", shell: "ask", git: "ask", other: "ask" },
    "chat/build-safe": { write_file: { packages: "allow" }, git: "allow", shell: "deny" },
    "chat/web": { web_fetch: "allow", shell: "allow" },
    "app/build": { layers: ["$/permission-sets/chat/ask-first"], write_file: "allow" },
  };
  const read = readerOver(FILES);
  const STANDING = { chat: ["$/permission-sets/chat/build-safe"] };

  it("is the bottom, the bucket's standing layers, the conversation's own, then the tools layer — each newer than the last", () => {
    const issues: Parameters<typeof permissionStackOf>[3] = [];
    const layers = permissionStackOf({ layers: ["$/permission-sets/chat/ask-first", "$/permission-sets/chat/web"], shell: "ask" }, read, "", issues, { standing: STANDING, ownId: "tools" });
    expect(issues).toEqual([]);
    expect(layers!.map((layer) => [layer.id, layer.role])).toEqual([
      ["chat/ask-first", "bottom"],
      ["chat/build-safe", "standing"],
      ["chat/web", "named"],
      ["tools", "own"],
    ]);
  });

  it("merges newest first per line: standing under the conversation's layers, under the tools layer", () => {
    const { permissionSet, stack } = resolveChatPermissionStack({ layers: ["$/permission-sets/chat/ask-first", "$/permission-sets/chat/web"], shell: "ask" }, read, { standing: STANDING });
    // The standing layer loosens the preset's `git`; the conversation's layer loosens `web_fetch` and
    // `shell` over the standing layer's `deny`; the tools layer takes `shell` back to `ask`.
    expect(permissionSet.entries["git"]).toMatchObject({ mode: "allow" });
    expect(permissionSet.entries["web_fetch"]).toMatchObject({ mode: "allow" });
    expect(permissionSet.entries["shell"]).toMatchObject({ mode: "ask" });
    // A place map over the preset's plain line makes the preset's word its `**`.
    expect(permissionSet.entries["write_file"]).toMatchObject({ mode: "ask", places: { packages: "allow" } });
    expect(layerOfLine(stack, "git")).toBe("chat/build-safe");
    expect(layerOfLine(stack, "web_fetch")).toBe("chat/web");
    expect(layerOfLine(stack, "shell")).toBe("tools");
    expect(layerOfLine(stack, "write_file", "packages")).toBe("chat/build-safe");
    expect(layerOfLine(stack, "write_file")).toBe("chat/ask-first");
    expect(layerOfLine(stack, "other")).toBe("chat/ask-first");
  });

  it("takes a tool away with `unavailable` in the tools layer, which a lower layer offers", () => {
    const { permissionSet } = resolveChatPermissionStack({ layers: ["$/permission-sets/chat/ask-first"], web_fetch: "unavailable" }, read, {});
    // Not held, so not offered — and not handed to an agent (decision 0023 §1).
    expect(holdsTool(permissionSet, "web_fetch")).toBe(false);
    expect(offeredTools(permissionSet)).not.toContain("web_fetch");
    expect(offeredTools(permissionSet)).toContain("read_file");
  });

  it("lays the standing layers under a whole map with no layers — the tools layer, in the `chat` bucket", () => {
    const { permissionSet, stack } = resolveChatPermissionStack({ read_file: "allow", other: "deny" }, read, { standing: STANDING });
    expect(stack.layers.map((layer) => layer.id)).toEqual(["chat/build-safe", "tools"]);
    expect(permissionSet.entries["git"]).toMatchObject({ mode: "allow" });
    expect(permissionSet.other).toBe("deny");
  });

  it("follows a set FILE built of layers whole, and lays the standing layers of the NAMED set's bucket over it", () => {
    // A state names `app/build`: the file is the stack it is itself, and the bucket is `app`'s.
    const layers = permissionStackOf("$/permission-sets/app/build", read, "", [], { standing: { ...STANDING, app: ["$/permission-sets/chat/web"] } });
    expect(layers!.map((layer) => [layer.id, layer.role])).toEqual([
      ["chat/ask-first", "bottom"],
      ["app/build", "bottom"],
      ["chat/web", "standing"],
    ]);
  });

  it("offers NOTHING when its own preset cannot be read, and says why — and leaves out a standing layer it cannot read, saying so", () => {
    const broken = resolveChatPermissionStack({ layers: ["$/permission-sets/chat/nope"], read_file: "allow" }, read, {});
    expect(broken.permissionSet).toEqual({ entries: {} });
    expect(broken.issues[0]!.message).toMatch(/matches no file/);
    const typo = resolveChatPermissionStack({ layers: ["$/permission-sets/chat/ask-first"] }, read, { standing: { chat: ["$/permission-sets/chat/missing"] } });
    expect(typo.permissionSet.entries["read_file"]).toMatchObject({ mode: "ask" });
    expect(typo.issues.map((issue) => issue.message).join()).toMatch(/standing layer '\$\/permission-sets\/chat\/missing' of 'chat'/);
  });

  it("names a layer by its set id, whatever root it is searched from", () => {
    expect(permissionSetIdOf("$/permission-sets/chat/ask-first")).toBe("chat/ask-first");
    expect(permissionSetIdOf("$SYSTEM/permission-sets/feature/implementation/writes-asking.json")).toBe("feature/implementation/writes-asking");
    expect(permissionSetIdOf("./mine")).toBeUndefined();
  });
});

describe("the tools layer the composer writes (ruling 8)", () => {
  it("is what differs from the stack below, and `unavailable` for a tool unticked over a layer that offers it", () => {
    const below = parsePermissionSet({ read_file: "ask", web_fetch: "ask", "git push": "ask", other: "ask" }).permissionSet;
    const wanted = parsePermissionSet({ read_file: "allow", other: "ask" }).permissionSet;
    // `git push` is no tool: absent says nothing of it, so it stays as below.
    expect(toolsLayerOf(below, wanted)).toEqual({ read_file: "allow", web_fetch: "unavailable" });
    expect(chatStackSettingsOf(["$/permission-sets/chat/ask-first"], { read_file: "allow" })).toEqual({ layers: ["$/permission-sets/chat/ask-first"], read_file: "allow" });
  });
});

describe("the whole stack, composed for \"Everything\" (§7.4)", () => {
  it("tags every line, and every place, with the layer that decided it — runtime among the layers, under the tools", () => {
    const view = permissionStackViewOf(
      [
        { id: "chat/ask-first", decl: { read_file: "ask", web_fetch: "ask", other: "ask" }, reference: "$/permission-sets/chat/ask-first", role: "bottom" },
        { id: "app/build", decl: { read_file: { src: "allow" } }, reference: "$/permission-sets/app/build", role: "standing" },
        { id: "tools", decl: { web_fetch: "unavailable" }, role: "own" },
      ],
      (layer) => ({ scope: layer.reference !== undefined ? "built in" : "this conversation", icon: "layers" }),
      { "git push @ main": "deny" },
    );
    expect(view.layers.map((layer) => [layer.id, layer.role, layer.lines])).toEqual([
      ["chat/ask-first", "bottom", 3],
      ["app/build", "standing", 1],
      ["runtime", "runtime", 1],
      ["tools", "own", 1],
    ]);
    const line = (subject: string) => view.lines.find((each) => each.subject === subject)!;
    expect(line("read_file")).toMatchObject({ layer: "chat/ask-first", places: { src: { decision: "allow", layer: "app/build" } } });
    expect(line("web_fetch")).toMatchObject({ layer: "tools", unavailable: "tools" });
    expect(view.runtime).toEqual({ "git push @ main": "deny" });
  });
});
