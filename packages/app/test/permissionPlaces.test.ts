/**
 * The card's lines take places, and a line can be `unavailable` (decision 0023 §1, §4.2); Settings →
 * Tools shows what a set comes to in a stack and lists a bucket's standing layers (§4.3). Every edit is a
 * pure function of the map (`composerPermissionSet.ts`), and the table and the rail are pure readings
 * (`stackPreviewModel.ts`, `permissionSetsHost.ts`, `functionsModel.ts`) — tested here, there being no
 * DOM harness for the components that draw them.
 */
import { describe, expect, it } from "vitest";
import { declOfPermissionSet, parsePermissionSet, permissionSetSummary, permissionSetsAt, type PermissionSet, type PermissionSetRecord } from "@jaira/shared";
import {
  CREDENTIALS_PICK,
  commandGroupsOf,
  groupHeadOf,
  groupSentence,
  groupSummary,
  holdsProgramLine,
  addableTools,
  canBeUnavailable,
  elsewhereLabel,
  elsewhereOf,
  isUnavailableLine,
  linePlaceKindOf,
  placeOptionsOf,
  placeProblem,
  placeRowsOf,
  placesSentence,
  runnerRowsOf,
  runsAFile,
  withPlace,
  withPlaceMode,
  withPlacePicked,
  withSubjectMode,
  withUnavailable,
  withoutPlace,
  writtenCountOf,
} from "../src/renderer/composerPermissionSet";
import { cellOf, type SetColumn } from "../src/renderer/functionsModel";
import { CREDENTIAL_PLACES, placeGlyphOf, placeNoun, placeWordsOf, setIconGlyph } from "../src/renderer/permissionSetWords";
import { permissionSetRailRows, standingBucketsOf, standingIdsOf, standingLayersOf } from "../src/renderer/permissionSetsHost";
import { answerAt, defaultBaseOf, lineChainOf, stackPreviewOf } from "../src/renderer/stackPreviewModel";

const set = (decl: Record<string, unknown>): PermissionSet => parsePermissionSet(decl).permissionSet;
const decl = (permissionSet: PermissionSet): Record<string, unknown> => declOfPermissionSet(permissionSet) as Record<string, unknown>;

describe("a line's places, as the card draws them", () => {
  it("lists a line's places most specific first, a file before a folder, the deeper folder first, and its own `**` last", () => {
    const rows = placeRowsOf(set({ read_file: { "**": "ask", $PROJECT: "allow", "src/app": "allow", src: "deny", "**/.env": "ask" } }), "read_file");
    expect(rows.map((row) => [row.place, row.anywhere])).toEqual([
      ["**/.env", false],
      ["src/app", false],
      ["$PROJECT", false],
      ["src", false],
      ["**", true],
    ]);
  });

  it("has no place rows for a plain line — its mode is the whole of it", () => {
    expect(placeRowsOf(set({ read_file: "allow" }), "read_file")).toEqual([]);
  });

  it("knows each line's kind of place, and that some take none", () => {
    expect(linePlaceKindOf("read_file")).toBe("path");
    expect(linePlaceKindOf("web_fetch")).toBe("site");
    expect(linePlaceKindOf("git push")).toBe("branch");
    expect(linePlaceKindOf("npm run build")).toBe("path");
    expect(linePlaceKindOf("web_search")).toBeUndefined();
    expect(linePlaceKindOf("other")).toBeUndefined();
    expect(linePlaceKindOf("mcp__figma")).toBeUndefined();
  });

  it("words and glyphs a place by what it names", () => {
    expect(placeWordsOf("path", "$WORKTREE")).toBe("the task's worktree");
    expect(placeWordsOf("path", "**")).toBe("everywhere else");
    expect(placeWordsOf("branch", "**")).toBe("every other branch");
    expect(placeWordsOf("path", "~/.ssh")).toBe("credentials");
    expect(placeWordsOf("site", "*.github.com")).toBe("its subdomains");
    expect(placeWordsOf("path", "src")).toBeUndefined();
    expect(placeGlyphOf("path", "**/.env")).toBe("script");
    expect(placeGlyphOf("path", "src/**")).toBe("folder");
    expect(placeGlyphOf("path", "~/.ssh")).toBe("folder");
    expect(placeGlyphOf("site", "github.com")).toBe("web");
    expect(placeGlyphOf("branch", "main")).toBe("git");
    expect(placeNoun("site", 5)).toBe("5 sites");
    expect(placeNoun("path", 1)).toBe("1 place");
  });

  it("says where a call none of a line's places match goes: script for a command that runs a file, then the shell, then other", () => {
    const ps = set({ "npm run build": { "packages/app": "allow" }, script: "smart", shell: "ask", other: "deny" });
    expect(runsAFile("npm run build")).toBe(true);
    expect(runsAFile("git push")).toBe(false);
    expect(elsewhereOf(ps, "npm run build")).toEqual({ line: "script", mode: { function: "smart" } });
    expect(elsewhereLabel(ps, "npm run build")).toBe("elsewhere: as script");
    expect(placesSentence(ps, "npm run build", "1 place")).toBe("1 place; elsewhere it is script's");
    expect(elsewhereOf(set({ "git push": { main: "ask" }, git: "allow" }), "git push")).toEqual({ line: "git", mode: "allow" });
  });

  it("says, in a layer that writes no other, that elsewhere is what the sets under it say", () => {
    const ps = set({ "npm run build": { packages: "allow" } });
    expect(elsewhereOf(ps, "npm run build")).toBeUndefined();
    expect(elsewhereLabel(ps, "npm run build")).toBe("elsewhere: as below");
    expect(placesSentence(ps, "npm run build", "1 place")).toBe("1 place; elsewhere, what the sets under it say");
    expect(placesSentence(set({ read_file: { "**": "ask", src: "allow" } }), "read_file", "1 place")).toBe("1 place; the most specific decides");
  });
});

describe("adding, re-moding and taking out a place", () => {
  it("adds a place to a plain line at the line's own mode, which becomes its `**` — so nothing changes until it is re-moded", () => {
    const next = withPlace(set({ read_file: "allow", other: "deny" }), "read_file", "$PROJECT");
    expect(decl(next)["read_file"]).toEqual({ "**": "allow", $PROJECT: "allow" });
  });

  it("adds a place to a line with no `**` at what it falls to there", () => {
    const next = withPlace(set({ "npm run build": { "packages/app": "allow" }, script: "deny", other: "ask" }), "npm run build", "packages/client");
    expect(decl(next)["npm run build"]).toEqual({ "packages/app": "allow", "packages/client": "deny" });
  });

  it("gives a line its own default with `**`, and only where it has none", () => {
    const placed = set({ "npm run build": { packages: "allow" }, other: "ask" });
    expect(decl(withPlace(placed, "npm run build", "**"))["npm run build"]).toEqual({ "**": "ask", packages: "allow" });
    const own = set({ read_file: { "**": "deny", src: "allow" } });
    expect(withPlace(own, "read_file", "**")).toEqual(own);
  });

  it("adds every credential place at ask with `credential files`", () => {
    const next = withPlacePicked(set({ read_file: "allow" }), "read_file", CREDENTIALS_PICK);
    expect(decl(next)["read_file"]).toEqual({ "**": "allow", ...Object.fromEntries(CREDENTIAL_PLACES.map((place) => [place, "ask"])) });
  });

  it("refuses a place on a line whose calls name none, on an unavailable line, on an MCP line, and on a line the set does not hold", () => {
    const ps = set({ web_search: "allow", web_fetch: "unavailable", mcp__figma: "allow", other: "ask" });
    expect(withPlace(ps, "web_search", "github.com")).toEqual(ps);
    expect(withPlace(ps, "web_fetch", "github.com")).toEqual(ps);
    expect(withPlace(ps, "mcp__figma", "src")).toEqual(ps);
    expect(withPlace(ps, "read_file", "src")).toEqual(ps);
    expect(placeProblem(ps, "web_search", "x")).toBe("'web_search' takes no place — its calls name none");
  });

  it("re-modes one place, and the `**` row is the line's own mode", () => {
    const ps = set({ read_file: { "**": "ask", src: "allow" } });
    expect(decl(withPlaceMode(ps, "read_file", "src", "deny"))["read_file"]).toEqual({ "**": "ask", src: "deny" });
    expect(decl(withPlaceMode(ps, "read_file", "**", { function: "smart" }))["read_file"]).toEqual({ "**": "smart", src: "allow" });
    expect(withPlaceMode(ps, "read_file", "docs", "deny")).toEqual(ps);
  });

  it("keeps a line's places when its head's mode is changed — the head is its `**`", () => {
    expect(decl(withSubjectMode(set({ read_file: { "**": "ask", src: "allow" } }), "read_file", "deny"))["read_file"]).toEqual({ "**": "deny", src: "allow" });
  });

  it("takes a place out; the last one leaves a plain line, and a line with nothing left is taken out", () => {
    const ps = set({ read_file: { "**": "ask", src: "allow", docs: "deny" }, "npm run build": { packages: "allow" }, other: "ask" });
    expect(decl(withoutPlace(ps, "read_file", "src"))["read_file"]).toEqual({ "**": "ask", docs: "deny" });
    expect(decl(withoutPlace(withoutPlace(ps, "read_file", "src"), "read_file", "docs"))["read_file"]).toBe("ask");
    expect(decl(withoutPlace(ps, "read_file", "**"))["read_file"]).toEqual({ src: "allow", docs: "deny" });
    expect(Object.hasOwn(decl(withoutPlace(ps, "npm run build", "packages")), "npm run build")).toBe(false);
  });

  it("keeps the authored order of the lines through every edit", () => {
    const ps = set({ shell: "ask", read_file: "allow", write_file: "deny", other: "ask" });
    expect(Object.keys(decl(withPlace(ps, "read_file", "src")))).toEqual(["shell", "read_file", "write_file", "other"]);
  });

  it("refuses a typed place that is empty, already named, or a site with a space in it", () => {
    const ps = set({ read_file: { "**": "ask", src: "allow" }, web_fetch: "ask" });
    expect(placeProblem(ps, "read_file", "  ")).toBe("name a place, like src");
    expect(placeProblem(ps, "read_file", "src")).toBe("'src' has a row already");
    expect(placeProblem(ps, "read_file", "**")).toBe("the line's own mode is its ** — it has a row already");
    expect(placeProblem(ps, "web_fetch", "github .com")).toBe("a site has no spaces — a host, and a path after it");
    expect(placeProblem(ps, "read_file", "packages/app")).toBeUndefined();
  });

  it("offers places of the line's kind it does not name yet, and `everywhere else` while it has no `**`", () => {
    const path = placeOptionsOf(set({ read_file: { "**": "ask", $PROJECT: "allow" } }), "read_file").map((option) => [option.id, option.label]);
    expect(path).toEqual([
      ["$WORKTREE", "the task's worktree"],
      ["$TEMP", "temp"],
      ["~", "your home folder"],
      [CREDENTIALS_PICK, "credential files"],
    ]);
    expect(placeOptionsOf(set({ web_fetch: { "github.com": "allow" } }), "web_fetch").map((option) => option.id)).toEqual(["**"]);
    expect(placeOptionsOf(set({ git_push: { main: "ask" } }), "git_push").map((option) => option.label)).toEqual(["every other branch"]);
    expect(placeOptionsOf(set({ web_search: "allow" }), "web_search")).toEqual([]);
  });

  it("draws a runner's own line with places as a line of its own, though it has no mode", () => {
    const row = runnerRowsOf(set({ "runner:npm": { packages: "allow" }, "runner:*": "ask" })).find((one) => one.program === "npm");
    expect(row).toMatchObject({ program: "npm", placed: true });
    expect(row?.own).toBeUndefined();
  });
});

describe("unavailable", () => {
  it("is offered for a tool, the shell and an MCP line, and never for a command, a runner, script or other", () => {
    expect(["read_file", "shell", "mcp__figma", "mcp__figma__get_code"].every(canBeUnavailable)).toBe(true);
    expect(["git push", "runner:*", "script", "other"].some(canBeUnavailable)).toBe(false);
  });

  it("writes the line as `unavailable`, its mode, places and implementation gone with it", () => {
    const ps = set({ write_file: { mode: { "**": "ask", src: "allow" }, implementation: "native" }, other: "ask" });
    const next = withUnavailable(ps, "write_file");
    expect(decl(next)["write_file"]).toBe("unavailable");
    expect(isUnavailableLine(next, "write_file")).toBe(true);
    expect(withUnavailable(ps, "git push")).toEqual(ps);
  });

  it("writes it for an MCP server that had no line", () => {
    expect(decl(withUnavailable(set({ other: "ask" }), "mcp__figma"))["mcp__figma"]).toBe("unavailable");
  });

  it("offers the tool again when a mode is picked on it", () => {
    const next = withSubjectMode(set({ web_search: "unavailable" }), "web_search", "allow");
    expect(decl(next)["web_search"]).toBe("allow");
    expect(isUnavailableLine(next, "web_search")).toBe(false);
  });

  it("is a line the section writes, and not one its add menu offers again", () => {
    const ps = set({ web_search: "unavailable", web_fetch: "ask" });
    expect(writtenCountOf(ps, "web")).toBe(2);
    expect(addableTools(ps, "web")).not.toContain("web_search");
  });
});

describe("the functions table, over places and unavailable", () => {
  const column = (decl: Record<string, unknown>): SetColumn => ({ id: "chat/auto", bucket: "chat", name: "auto", here: false, decl });

  it("reads a line with places as its own mode and how many places it names", () => {
    expect(cellOf(column({ read_file: { "**": "ask", $PROJECT: "allow", "**/.env": "ask", "~/.ssh": "deny" } }), "read_file")).toMatchObject({ text: "ask · 3 places", kind: "ask" });
  });

  it("colours a map with no `**` as the loosest of its places, and says the range", () => {
    const cell = cellOf(column({ "npm run build": { "packages/app": "allow", infra: "deny" } }), "npm run build");
    expect(cell).toMatchObject({ text: "2 places", kind: "allow" });
    expect(cell.title).toBe("chat/auto: elsewhere, as a less specific line says; at 2 places from allow to deny — open it");
  });

  it("reads `unavailable` as such", () => {
    expect(cellOf(column({ web_search: "unavailable" }), "web_search")).toMatchObject({ text: "unavailable", kind: "unavailable", mode: undefined });
    expect(cellOf(column({}), "web_search")).toMatchObject({ text: "—", kind: "none" });
  });
});

describe("Show it in a stack", () => {
  const readOnly = { id: "chat/read-only", decl: { read_file: "allow", write_file: "deny", script: "deny", shell: "deny", "git status": "allow", other: "deny" } };
  const buildSafe = { id: "project/build-safe", decl: { "npm run build": { packages: "allow" }, "runner:npm": "allow" } };

  it("draws each place the layer writes, then elsewhere, with the base's answer, the layer's, the result and who said it", () => {
    const rows = stackPreviewOf(readOnly, buildSafe);
    expect(rows.map((row) => [row.subject, row.where, row.base?.mode, row.layer?.mode, row.result.mode, row.decidedBy])).toEqual([
      ["npm run build", "in packages", "deny", "allow", "allow", "project/build-safe"],
      ["npm run build", "elsewhere", "deny", undefined, "deny", "chat/read-only · script"],
      ["runner:npm", "", undefined, "allow", "allow", "project/build-safe"],
    ]);
  });

  it("finds the place of a base's line that holds the layer's place", () => {
    const base = { id: "chat/x", decl: { read_file: { "**": "ask", packages: "deny" }, other: "ask" } };
    const layer = { id: "app/y", decl: { read_file: { "packages/app": "allow" } } };
    const [first] = stackPreviewOf(base, layer);
    expect(first).toMatchObject({ where: "in packages/app", base: { mode: "deny", line: "read_file", place: "packages" }, result: { mode: "allow" }, decidedBy: "app/y" });
  });

  it("says a tool a layer takes away is unavailable, and who took it", () => {
    const [row] = stackPreviewOf({ id: "chat/full", decl: { web_search: "allow", other: "allow" } }, { id: "web/quiet", decl: { web_search: "unavailable" } });
    expect(row).toMatchObject({ base: { mode: "allow" }, layer: { mode: "unavailable" }, result: { mode: "unavailable" }, decidedBy: "web/quiet" });
  });

  it("asks, said so, where neither set has a line", () => {
    const [row] = stackPreviewOf({ id: "a/b", decl: {} }, { id: "c/d", decl: { "git push": { main: "ask" } } });
    expect(row).toMatchObject({ result: { mode: "ask" } });
    const elsewhere = stackPreviewOf({ id: "a/b", decl: {} }, { id: "c/d", decl: { "git push": { main: "ask" } } })[1]!;
    expect(elsewhere.decidedBy).toBe("no line in either — ask");
  });

  it("walks a line's less specific lines, and a layer's own answer is its own line alone", () => {
    expect(lineChainOf("git push --force")).toEqual(["git push --force", "git push", "git", "shell", "other"]);
    expect(lineChainOf("runner:npm")).toEqual(["runner:npm", "runner:*"]);
    const ps = set({ git: "allow", other: "deny" });
    expect(answerAt(ps, "git push", undefined)).toEqual({ mode: "allow", line: "git" });
    expect(answerAt(ps, "git push", undefined, true)).toBeUndefined();
  });

  it("lays a standing layer on its bucket's ask-first first, any other set on chat/ask-first, never on itself", () => {
    const offered = ["chat/ask-first", "chat/read-only", "app/ask-first", "project/build-safe"];
    expect(defaultBaseOf("project/build-safe", offered, { app: ["$/permission-sets/project/build-safe"] })).toBe("app/ask-first");
    expect(defaultBaseOf("project/build-safe", offered, {})).toBe("chat/ask-first");
    expect(defaultBaseOf("chat/ask-first", offered, {})).toBe("chat/read-only");
  });
});

describe("standing layers in the rail, and a set's icon", () => {
  const record = (id: string, decl: Record<string, unknown>): PermissionSetRecord => ({ id, bucket: id.split("/")[0]!, name: id.split("/")[1]!, files: [{ layer: "project", file: `${id}.json`, format: "json", decl: decl as never }] });

  it("reads each bucket's standing layers from the settings in effect, by set id", () => {
    const standing = standingLayersOf({ effective: { permissions: { layers: { chat: ["$/permission-sets/project/build-safe", "  ", 3] } } } });
    expect(standing).toEqual({ chat: ["$/permission-sets/project/build-safe"] });
    expect(standingIdsOf(standing, "chat")).toEqual(["project/build-safe"]);
    expect(standingBucketsOf(standing, "project/build-safe")).toEqual(["chat"]);
    expect(standingLayersOf(null)).toEqual({});
    expect(standingLayersOf({ effective: { permissions: {} } })).toEqual({});
  });

  it("lists a bucket's standing layers under its heading, and gives every set its icon", () => {
    const records = [record("chat/ask-first", { other: "ask" }), record("project/build-safe", { icon: "terminal", "npm run build": "allow" }), record("project/docs", { web_fetch: "allow" })];
    const rows = permissionSetRailRows(permissionSetsAt(records, "project"), "project", {}, undefined, { chat: ["$/permission-sets/project/build-safe"] });
    expect(rows.flatMap((row) => (row.kind === "bucket" ? [[row.path, row.standing]] : []))).toEqual([
      ["chat", ["project/build-safe"]],
      ["project", undefined],
    ]);
    expect(rows.flatMap((row) => (row.kind === "set" ? [[row.id, row.icon, row.summary]] : []))).toEqual([
      ["permissionSet:chat/ask-first", "ask", "0 lines · other ask"],
      ["permissionSet:project/build-safe", "terminal", "1 line · no other"],
      ["permissionSet:project/docs", "layers", "1 line · no other"],
    ]);
    expect([setIconGlyph("ask"), setIconGlyph("smart"), setIconGlyph("terminal"), setIconGlyph("hammer")]).toEqual(["lock", "star", "terminal", "layers"]);
  });

  it("says a set that writes no other says none", () => {
    expect(permissionSetSummary(set({ "npm run build": "allow" }))).toBe("1 line · no other");
  });
});

describe("a program's group takes places like any line (§4.2, §3.4)", () => {
  // The layer the real-app check drew wrong: a bare program with places, and a subcommand with places,
  // in a set that writes no shell and no other.
  const layer = set({ "npm run build": { packages: "allow" }, git: { packages: "allow" } });

  it("a bare program with only places has no mode of its own, and is still a line of the set", () => {
    const groups = commandGroupsOf(layer);
    expect(groups).toEqual([
      { program: "npm", subs: [{ subject: "npm run build", mode: "ask" }] },
      { program: "git", placed: true, subs: [] },
    ]);
    expect(holdsProgramLine(groups[1]!)).toBe(true);
    expect(holdsProgramLine(groups[0]!)).toBe(false);
    // Its place rows are the line's, as any line's are.
    expect(placeRowsOf(layer, "git")).toEqual([{ place: "packages", mode: "allow", anywhere: false }]);
    // With a `**` too, that is its own mode.
    const both = commandGroupsOf(set({ git: { "**": "deny", packages: "allow" } }));
    expect(both).toEqual([{ program: "git", own: "deny", placed: true, subs: [] }]);
  });

  it("the head claims no mode the set does not write", () => {
    const [npm, git] = commandGroupsOf(layer);
    // git: places and no `**` — `elsewhere: as below`, faded, no mode.
    expect(groupHeadOf(layer, git!)).toMatchObject({ label: "elsewhere: as below", follows: true });
    expect(groupHeadOf(layer, git!).mode).toBeUndefined();
    // npm: no line of its own, and nothing in this layer for it to fall to.
    expect(groupHeadOf(layer, npm!)).toMatchObject({ label: "not written", follows: true });
    expect(groupHeadOf(layer, npm!).mode).toBeUndefined();
    // In a set that writes a shell line, it says which line it falls to, not that line's mode.
    const withShell = set({ shell: "ask", "npm test": "allow" });
    const head = groupHeadOf(withShell, commandGroupsOf(withShell)[0]!);
    expect(head).toMatchObject({ label: "as shell", follows: true });
    expect(head.mode).toBeUndefined();
    expect(head.title).toContain("shell's, which asks");
    // A program with a mode of its own shows it, unfaded.
    const own = set({ git: "deny", "git status": "allow" });
    expect(groupHeadOf(own, commandGroupsOf(own)[0]!)).toMatchObject({ mode: "deny", follows: false });
  });

  it("the group's words say its places, and where nothing answers, that it falls through", () => {
    const [npm, git] = commandGroupsOf(layer);
    expect(groupSentence(layer, git!)).toBe("every git command — 1 place; elsewhere, what the sets under it say");
    expect(groupSummary(layer, git!)).toBe("every git command — 1 place");
    expect(groupSentence(layer, npm!)).toBe("1 subcommand named; any other npm falls through to the sets under it");
    const mixed = set({ shell: "ask", git: { "**": "allow", packages: "deny" }, "git push": "ask" });
    const [group] = commandGroupsOf(mixed);
    expect(groupSentence(mixed, group!)).toBe("1 subcommand named; any other git: 1 place; the most specific decides");
    expect(groupSummary(mixed, group!)).toBe("1 place · push");
  });

  it("the head's mode sets the bare line's `**` and keeps its places; its places add, re-mode and go", () => {
    const anywhere = withSubjectMode(layer, "git", "deny");
    expect(decl(anywhere)["git"]).toEqual({ "**": "deny", packages: "allow" });
    const added = withPlace(layer, "git", "src", "ask");
    expect(decl(added)["git"]).toEqual({ packages: "allow", src: "ask" });
    expect(decl(withPlaceMode(layer, "git", "packages", "deny"))["git"]).toEqual({ packages: "deny" });
    // Its last place gone, a line with no mode says nothing and is taken out.
    expect(Object.hasOwn(withoutPlace(layer, "git", "packages").entries, "git")).toBe(false);
  });
});
