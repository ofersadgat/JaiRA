/**
 * The text half of "add to the permission set" (decision 0007 §4), and the provenance lowering writes so an
 * approval can name the permission set that asked.
 */
import { describe, expect, it } from "vitest";
import {
  INLINE_PERMISSION_SET,
  addToPermissionSetText,
  chosenWidths,
  describeAddition,
  lowerStatePermissionSets,
  overridePermissionSetText,
  parsePermissionSet,
  resolvePermissionSetDecl,
  permissionSetTextFollows,
  type CommandApproval,
  type CommandPart,
  type PermissionSetReader,
} from "../src";

describe("an override that keeps following what it overrides", () => {
  it("starts from the lower layer's file by an EXPLICIT root, and says the one line more", () => {
    const text = overridePermissionSetText("$SYSTEM/permission-sets/ask-first", { "git  commit": "allow", terraform: "deny" });
    expect(text).toBe('{\n  "$ref": "$SYSTEM/permission-sets/ask-first",\n  "git commit": "allow",\n  "terraform": "deny"\n}\n');
    expect(permissionSetTextFollows(text, "$SYSTEM/permission-sets/ask-first")).toBe(true);
    expect(permissionSetTextFollows(text, "$BASE/permission-sets/ask-first")).toBe(false);
    expect(permissionSetTextFollows("[]", "$BASE/x")).toBe(false);
  });

  it("refuses a bare `$`, which is searched from the top layer down and would find the override itself", () => {
    expect(() => overridePermissionSetText("$/permission-sets/ask-first", { git: "allow" })).toThrow(/explicit root/);
    expect(() => overridePermissionSetText("./ask-first", { git: "allow" })).toThrow(/explicit root/);
  });

  it("resolves to the lower file's entries with the new line over them, and parses clean", () => {
    const files: Record<string, unknown> = {
      "$/permission-sets/ask-first": JSON.parse(overridePermissionSetText("$SYSTEM/permission-sets/ask-first", { "git commit": "allow" })),
      "$SYSTEM/permission-sets/ask-first": { read_file: "allow", shell: "ask", "git commit": "ask", other: "deny" },
    };
    const read: PermissionSetReader = (reference) => {
      if (!Object.hasOwn(files, reference)) throw new Error(`no ${reference}`);
      return { value: files[reference], key: reference, from: reference };
    };
    const issues: never[] = [];
    const resolved = resolvePermissionSetDecl("$/permission-sets/ask-first", read, "plan", issues);
    expect(issues).toEqual([]);
    expect(resolved).toEqual({ read_file: "allow", shell: "ask", "git commit": "allow", other: "deny" });
    expect(parsePermissionSet(resolved).issues).toEqual([]);
  });
});

describe("a line added to a file somebody wrote", () => {
  it("adds a new subject at the end and changes one already there, leaving the rest byte for byte", () => {
    const text = '{\n    // reads\n    "read_file": "allow",\n    "git commit": "ask"\n}\n';
    expect(addToPermissionSetText(text, { "git commit": "allow" })).toBe('{\n    // reads\n    "read_file": "allow",\n    "git commit": "allow"\n}\n');
    expect(addToPermissionSetText(text, { terraform: "deny" })).toBe('{\n    // reads\n    "read_file": "allow",\n    "git commit": "ask",\n    "terraform": "deny"\n}\n');
    // An empty map, a file on one line, and an entry object with no mode of its own.
    expect(addToPermissionSetText("{}\n", { git: "allow" })).toBe('{\n  "git": "allow"\n}\n');
    expect(addToPermissionSetText('{ "read_file": "allow" }', { git: "allow" })).toBe('{ "read_file": "allow", "git": "allow" }');
    expect(JSON.parse(addToPermissionSetText('{\n  "write_file": { "implementation": "native" }\n}', { write_file: "allow" }))).toEqual({ write_file: "allow" });
  });

  it("keeps CRLF, finds a key its author spaced differently, and changes only the mode of an object entry", () => {
    const text = '{\r\n  "git   commit": "ask",\r\n  "write_file": { "mode": "ask", "implementation": "native" }\r\n}\r\n';
    const out = addToPermissionSetText(text, { "git commit": "deny", write_file: "allow", rm: "allow" });
    expect(out).toBe('{\r\n  "git   commit": "deny",\r\n  "write_file": { "mode": "allow", "implementation": "native" },\r\n  "rm": "allow"\r\n}\r\n');
  });

  it("refuses what is not a permission set map, and what is not a subject", () => {
    expect(() => addToPermissionSetText('["shell"]', { git: "allow" })).toThrow(/not a map/);
    expect(() => addToPermissionSetText('"$/permission-sets/x"', { git: "allow" })).toThrow(/not a map/);
    expect(() => addToPermissionSetText("{ nope", { git: "allow" })).toThrow(/does not parse/);
    expect(() => addToPermissionSetText("{}", { other: "allow" })).toThrow(/not a subject/);
    expect(() => addToPermissionSetText("{}", { $ref: "allow" } as never)).toThrow(/not a subject/);
  });

  it("describes the line as it will be written", () => {
    expect(describeAddition({ "git commit": "allow" })).toBe('"git commit": "allow"');
    expect(describeAddition({ git: "deny", script: "deny" })).toBe('"git": "deny", "script": "deny"');
  });
});

describe("where a lowered block's subjects came from", () => {
  const read: PermissionSetReader = (reference) => ({ value: { shell: "ask", "git commit": "ask", read_file: "allow" }, key: reference, from: reference });
  const sourceOf = (tools: unknown): unknown => {
    const lowered = lowerStatePermissionSets("plan", { environment: { tools } }, read).def as { environment: { permissions?: { source?: string } } };
    return lowered.environment.permissions?.source;
  };

  it("is the reference for a permission set named by one, and `inline` for a map — or a `$ref` that says more — on the state", () => {
    expect(sourceOf("$/permission-sets/ask-first")).toBe("$/permission-sets/ask-first");
    expect(sourceOf({ shell: "ask" })).toBe(INLINE_PERMISSION_SET);
    expect(sourceOf({ $ref: "$/permission-sets/ask-first", "git commit": "allow" })).toBe(INLINE_PERMISSION_SET);
  });

  it("is written only beside `subjects`, so a block that judges no shell line is exactly what it was", () => {
    expect(sourceOf({ read_file: "allow", other: "deny" })).toBeUndefined();
    expect(sourceOf(["shell"])).toBeUndefined();
  });
});

describe("the widths an answer remembers", () => {
  const part = (verdict: CommandPart["verdict"], widths: string[]): CommandPart => ({
    span: { start: 0, end: 0 },
    matched: [],
    text: "",
    kind: "command",
    subject: widths[0] ?? "shell",
    verdict,
    decidedBy: { source: "permissionSet", reason: "" },
    widths,
  });
  const approval: CommandApproval = {
    line: "",
    dialect: "posix",
    verdict: "asks",
    parts: [part("asks", ["git commit", "git"]), part("allowed", ["rm"]), part("asks", ["script"]), part("asks", []), part("asks", ["git commit", "git"])],
  };

  it("takes one per asking part — the chosen one where it is the part's own, else the narrowest — and never an allowed part's", () => {
    expect(chosenWidths(approval)).toEqual(["git commit", "script"]);
    expect(chosenWidths(approval, ["git"])).toEqual(["git", "script"]);
    expect(chosenWidths(approval, ["rm", "npm"])).toEqual(["git commit", "script"]);
  });
});

describe("adding a line over places and layers (decision 0023)", () => {
  it("replaces a place map whole — a remembered answer is a plain decision, which covers everywhere — and keeps a wrapper's implementation", () => {
    expect(JSON.parse(addToPermissionSetText('{ "read_file": { "**": "deny", "src": "allow" } }', { read_file: "allow" }))).toEqual({ read_file: "allow" });
    expect(addToPermissionSetText('{ "edit": { "mode": { "src": "allow" }, "implementation": "native" } }', { edit: "deny" })).toBe('{ "edit": { "mode": "deny", "implementation": "native" } }');
  });

  it("refuses `layers`, which is no subject", () => {
    expect(() => addToPermissionSetText("{}", { layers: "allow" })).toThrow(/not a subject/);
  });
});

describe("adding an answer AT A PLACE, allow or deny (decision 0023 §2.8, §4.4)", () => {
  it("joins the line: a new line is the place alone, a plain line becomes its `**`, a place map gains the place", () => {
    expect(JSON.parse(addToPermissionSetText("{}", { "npm run build": { packages: "deny" } }))).toEqual({ "npm run build": { packages: "deny" } });
    expect(JSON.parse(addToPermissionSetText('{ "npm run build": "ask" }', { "npm run build": { packages: "deny" } }))).toEqual({ "npm run build": { "**": "ask", packages: "deny" } });
    expect(JSON.parse(addToPermissionSetText('{ "read_file": { "**": "deny", "src": "allow" } }', { read_file: { src: "deny", docs: "allow" } }))).toEqual({ read_file: { "**": "deny", src: "deny", docs: "allow" } });
    // The wrapper keeps its implementation; the place joins its mode.
    expect(JSON.parse(addToPermissionSetText('{ "edit": { "mode": "ask", "implementation": "native" } }', { edit: { src: "allow" } }))).toEqual({ edit: { mode: { "**": "ask", src: "allow" }, implementation: "native" } });
  });

  it("writes a place into a new override alone — elsewhere the line is the lower layer's", () => {
    expect(overridePermissionSetText("$SYSTEM/permission-sets/ask-first", { "npm run build": { packages: "deny" } })).toBe(
      '{\n  "$ref": "$SYSTEM/permission-sets/ask-first",\n  "npm run build": { "packages": "deny" }\n}\n',
    );
    expect(describeAddition({ "npm run build": { packages: "deny" }, git: "allow" })).toBe('"npm run build": { "packages": "deny" }, "git": "allow"');
  });

  it("refuses `icon`, which names the file's icon and is no subject", () => {
    expect(() => addToPermissionSetText("{}", { icon: "allow" })).toThrow(/not a subject/);
  });
});
