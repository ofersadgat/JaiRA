/**
 * Settings → Permission sets as data (decision 0007 §6): the whole-map text edit, what an override can and
 * cannot say, and what one layer's pane reads off every layer's files.
 */
import { describe, expect, it } from "vitest";
import {
  comparePermissionSets,
  isPermissionSetDirty,
  newPermissionSetText,
  overridesOf,
  parsePermissionSet,
  resolvePermissionSetChoice,
  setPermissionSetText,
  permissionSetOfAt,
  permissionSetRailOf,
  permissionSetRailSummary,
  permissionSetsAt,
  permissionSetStanding,
  usedByLine,
  type PermissionSetRecord,
} from "../src/index";

const SHIPPED = { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" } as const;

describe("setPermissionSetText — a whole map, written over somebody's file", () => {
  const text = `{\n  // what this project reads\n  "read_file": "allow",\n  "glob":      "allow",\n\n  "bash": { "mode": "ask", "implementation": "native" },\n  "other": "deny"\n}\n`;

  it("leaves a file alone when the map is what it already says", () => {
    expect(setPermissionSetText(text, { read_file: "allow", glob: "allow", bash: { mode: "ask", implementation: "native" }, other: "deny" })).toBe(text);
  });

  it("replaces a changed value where it stands, keeping the comment, the alignment and the blank line", () => {
    const out = setPermissionSetText(text, { read_file: "allow", glob: "ask", bash: "deny", other: "deny" });
    expect(out).toBe(`{\n  // what this project reads\n  "read_file": "allow",\n  "glob":      "ask",\n\n  "bash": "deny",\n  "other": "deny"\n}\n`);
  });

  it("takes a removed line out with its line, and adds a new one BEFORE other", () => {
    const out = setPermissionSetText(text, { read_file: "allow", bash: { mode: "ask", implementation: "native" }, "git status": "allow", other: "deny" });
    expect(out).toBe(
      `{\n  // what this project reads\n  "read_file": "allow",\n\n  "bash": { "mode": "ask", "implementation": "native" },\n  "git status": "allow",\n  "other": "deny"\n}\n`,
    );
    expect(parsePermissionSet(JSON.parse(out.replace(/\/\/.*$/m, ""))).issues).toEqual([]);
  });

  it("removes the LAST line with the comma before it, and appends where there is no other", () => {
    expect(setPermissionSetText(`{\n  "read_file": "allow",\n  "bash": "ask"\n}\n`, { read_file: "allow" })).toBe(`{\n  "read_file": "allow"\n}\n`);
    expect(setPermissionSetText(`{\n  "read_file": "allow"\n}\n`, { read_file: "allow", edit: { mode: "ask", implementation: "native" } })).toBe(
      `{\n  "read_file": "allow",\n  "edit": { "mode": "ask", "implementation": "native" }\n}\n`,
    );
  });

  it("keeps a one-line file on one line, and CRLF as CRLF", () => {
    expect(setPermissionSetText(`{ "read_file": "allow", "bash": "ask" }`, { bash: "deny", glob: "allow" })).toBe(`{ "bash": "deny", "glob": "allow" }`);
    expect(setPermissionSetText(`{\r\n  "read_file": "allow"\r\n}\r\n`, { read_file: "allow", glob: "ask" })).toBe(`{\r\n  "read_file": "allow",\r\n  "glob": "ask"\r\n}\r\n`);
  });

  it("keeps a $ref it is told to keep, drops one it is not, and writes one first where there was none", () => {
    const over = `{\n  "$ref": "$SYSTEM/permission-sets/chat/read-only",\n  "bash": "ask"\n}\n`;
    expect(setPermissionSetText(over, { bash: "allow" }, "$SYSTEM/permission-sets/chat/read-only")).toBe(`{\n  "$ref": "$SYSTEM/permission-sets/chat/read-only",\n  "bash": "allow"\n}\n`);
    expect(setPermissionSetText(over, {}, "$SYSTEM/permission-sets/chat/read-only")).toBe(`{\n  "$ref": "$SYSTEM/permission-sets/chat/read-only"\n}\n`);
    expect(setPermissionSetText(over, { bash: "ask", other: "deny" })).toBe(`{\n  "bash": "ask",\n  "other": "deny"\n}\n`);
    expect(setPermissionSetText(`{\n  "bash": "ask"\n}\n`, { bash: "ask" }, "$BASE/permission-sets/x/y")).toBe(`{\n  "$ref": "$BASE/permission-sets/x/y",\n  "bash": "ask"\n}\n`);
  });

  it("refuses a file that is not a map, having changed nothing", () => {
    expect(() => setPermissionSetText(`["read_file"]`, {})).toThrow(/not a map/);
    expect(() => setPermissionSetText(`{ "a": `, {})).toThrow(/does not parse/);
  });

  it("writes a new file one line per subject, $ref first, and refuses a bare-$ follow", () => {
    expect(newPermissionSetText({ bash: "ask", edit: { mode: "ask", implementation: "native" } }, "$SYSTEM/permission-sets/chat/full")).toBe(
      `{\n  "$ref": "$SYSTEM/permission-sets/chat/full",\n  "bash": "ask",\n  "edit": { "mode": "ask", "implementation": "native" }\n}\n`,
    );
    expect(() => newPermissionSetText({}, "$/permission-sets/chat/full")).toThrow(/explicit root/);
  });
});

describe("overridesOf — what $ref plus siblings can say", () => {
  it("holds only the lines that differ, reading a bare mode and { mode } as one statement", () => {
    expect(overridesOf(SHIPPED, { ...SHIPPED, bash: "ask", "git log": "allow", glob: { mode: "allow" } })).toEqual({
      siblings: { bash: "ask", "git log": "allow" },
      dropped: [],
    });
  });

  it("names a line that was taken OUT, which an override cannot say", () => {
    const { glob: _gone, ...rest } = SHIPPED;
    expect(overridesOf(SHIPPED, rest).dropped).toEqual(["glob"]);
  });

  it("does not count a missing other that reads as the same mode", () => {
    expect(overridesOf({ read_file: "allow" }, { read_file: "allow", other: "ask" })).toEqual({ siblings: {}, dropped: [] });
  });
});

const records: PermissionSetRecord[] = [
  {
    id: "chat/read-only",
    bucket: "chat",
    name: "read-only",
    files: [
      { layer: "project", file: ".jaira/permission-sets/chat/read-only.json", format: "json", follows: "$SYSTEM/permission-sets/chat/read-only", decl: { ...SHIPPED, bash: "ask" } },
      { layer: "system", file: "built in/permission-sets/chat/read-only.json", format: "json", decl: { ...SHIPPED } },
    ],
  },
  { id: "chat/full", bucket: "chat", name: "full", files: [{ layer: "system", file: "built in/permission-sets/chat/full.json", format: "json", decl: { bash: "allow", other: "allow" } }] },
  { id: "feature/writes-asking", bucket: "feature", name: "writes-asking", files: [{ layer: "project", file: ".jaira/permission-sets/feature/writes-asking.json", format: "json", decl: { edit: "ask", other: "ask" } }] },
  { id: "team/review", bucket: "team", name: "review", files: [{ layer: "base", file: "~/.jaira/permission-sets/team/review.json", format: "yaml", problem: "bad" }] },
];

describe("what one layer's pane reads", () => {
  it("a project sees all three layers, and marks what it states and what that overrides", () => {
    const ats = permissionSetsAt(records, "project");
    expect(ats.map((at) => [at.id, at.source.layer, at.here, at.lower?.layer])).toEqual([
      ["chat/read-only", "project", true, "system"],
      ["chat/full", "system", false, undefined],
      ["feature/writes-asking", "project", true, undefined],
      ["team/review", "base", false, undefined],
    ]);
    expect(ats.map((at) => permissionSetStanding(at))).toEqual([
      { here: true, label: "overrides built in" },
      { here: false, label: "built in" },
      { here: true, label: "this project" },
      { here: false, label: "all projects" },
    ]);
  });

  it("built in sees only what ships, and says when a nearer layer hides it", () => {
    const ats = permissionSetsAt(records, "system");
    expect(ats.map((at) => at.id)).toEqual(["chat/read-only", "chat/full"]);
    expect(permissionSetStanding(ats[0]!)).toEqual({ here: true, label: "built in", shadowed: "overridden in this project" });
    expect(permissionSetsAt(records, "base").map((at) => at.id)).toEqual(["chat/read-only", "chat/full", "team/review"]);
  });

  it("draws the rail as the bucket hierarchy, each bucket with the layer that defines it", () => {
    const rail = permissionSetRailOf(permissionSetsAt(records, "project"));
    expect(rail.map((row) => [row.bucket.path, row.bucket.layer, row.permissionSets.map((at) => at.name)])).toEqual([
      ["chat", "system", ["read-only", "full"]],
      ["feature", "project", ["writes-asking"]],
      ["team", "base", ["review"]],
    ]);
  });

  it("summarises a row from its draft, and says so; a broken file says it could not be read", () => {
    const [readOnly, , , broken] = permissionSetsAt(records, "project");
    expect(permissionSetRailSummary(readOnly!)).toBe("4 lines · other deny");
    const draft = parsePermissionSet({ read_file: "allow", other: "deny" }).permissionSet;
    expect(isPermissionSetDirty(readOnly!, draft)).toBe(true);
    expect(isPermissionSetDirty(readOnly!, permissionSetOfAt(readOnly!))).toBe(false);
    expect(permissionSetRailSummary(readOnly!, draft)).toBe("unsaved · 1 line · other deny");
    expect(permissionSetRailSummary(broken!)).toBe("could not be read");
  });

  it("keeps the selection through a write that has not landed, and falls to the first otherwise", () => {
    const ats = permissionSetsAt(records, "project");
    expect(resolvePermissionSetChoice(ats, "chat/full")).toBe("chat/full");
    expect(resolvePermissionSetChoice(ats, "chat/new", "chat/new")).toBe("chat/new");
    expect(resolvePermissionSetChoice(ats, "chat/gone")).toBe("chat/read-only");
    expect(resolvePermissionSetChoice([], undefined)).toBeUndefined();
  });

  it("says who uses a permission set in a line", () => {
    expect(usedByLine(undefined)).toBe("no state names it");
    expect(usedByLine(["chat/control"])).toBe("used by chat/control");
    expect(usedByLine(["a", "b"])).toBe("used by a and b");
    expect(usedByLine(["sync/review", ...Array.from({ length: 18 }, (_, i) => `s${i}`)])).toBe("used by sync/review and 18 more states");
  });

  it("compares with what ships, line by line", () => {
    expect(comparePermissionSets(SHIPPED, { read_file: "allow", bash: { mode: "ask", implementation: "native" }, "git status": "allow", "git log": "allow", other: "deny" })).toEqual([
      { subject: "glob", theirs: "allow" },
      { subject: "bash", theirs: "deny", ours: "ask · native" },
      { subject: "git log", ours: "allow" },
    ]);
  });
});
