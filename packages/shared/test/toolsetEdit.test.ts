/**
 * The text half of "add to the toolset" (decision 0007 §4), and the provenance lowering writes so an
 * approval can name the toolset that asked.
 */
import { describe, expect, it } from "vitest";
import {
  INLINE_TOOLSET,
  addToToolsetText,
  chosenWidths,
  describeAddition,
  lowerStateToolsets,
  overrideToolsetText,
  parseToolset,
  resolveToolsetDecl,
  toolsetTextFollows,
  type CommandApproval,
  type CommandPart,
  type ToolsetReader,
} from "../src";

describe("an override that keeps following what it overrides", () => {
  it("starts from the lower layer's file by an EXPLICIT root, and says the one line more", () => {
    const text = overrideToolsetText("$SYSTEM/toolsets/chat/ask-first", { "git  commit": "allow", terraform: "deny" });
    expect(text).toBe('{\n  "$ref": "$SYSTEM/toolsets/chat/ask-first",\n  "git commit": "allow",\n  "terraform": "deny"\n}\n');
    expect(toolsetTextFollows(text, "$SYSTEM/toolsets/chat/ask-first")).toBe(true);
    expect(toolsetTextFollows(text, "$BASE/toolsets/chat/ask-first")).toBe(false);
    expect(toolsetTextFollows("[]", "$BASE/x")).toBe(false);
  });

  it("refuses a bare `$`, which is searched from the top layer down and would find the override itself", () => {
    expect(() => overrideToolsetText("$/toolsets/chat/ask-first", { git: "allow" })).toThrow(/explicit root/);
    expect(() => overrideToolsetText("./ask-first", { git: "allow" })).toThrow(/explicit root/);
  });

  it("resolves to the lower file's entries with the new line over them, and parses clean", () => {
    const files: Record<string, unknown> = {
      "$/toolsets/chat/ask-first": JSON.parse(overrideToolsetText("$SYSTEM/toolsets/chat/ask-first", { "git commit": "allow" })),
      "$SYSTEM/toolsets/chat/ask-first": { read_file: "allow", bash: "ask", "git commit": "ask", other: "deny" },
    };
    const read: ToolsetReader = (reference) => {
      if (!Object.hasOwn(files, reference)) throw new Error(`no ${reference}`);
      return { value: files[reference], key: reference, from: reference };
    };
    const issues: never[] = [];
    const resolved = resolveToolsetDecl("$/toolsets/chat/ask-first", read, "plan", issues);
    expect(issues).toEqual([]);
    expect(resolved).toEqual({ read_file: "allow", bash: "ask", "git commit": "allow", other: "deny" });
    expect(parseToolset(resolved).issues).toEqual([]);
  });
});

describe("a line added to a file somebody wrote", () => {
  it("adds a new subject at the end and changes one already there, leaving the rest byte for byte", () => {
    const text = '{\n    // reads\n    "read_file": "allow",\n    "git commit": "ask"\n}\n';
    expect(addToToolsetText(text, { "git commit": "allow" })).toBe('{\n    // reads\n    "read_file": "allow",\n    "git commit": "allow"\n}\n');
    expect(addToToolsetText(text, { terraform: "deny" })).toBe('{\n    // reads\n    "read_file": "allow",\n    "git commit": "ask",\n    "terraform": "deny"\n}\n');
    // An empty map, a file on one line, and an entry object with no mode of its own.
    expect(addToToolsetText("{}\n", { git: "allow" })).toBe('{\n  "git": "allow"\n}\n');
    expect(addToToolsetText('{ "read_file": "allow" }', { git: "allow" })).toBe('{ "read_file": "allow", "git": "allow" }');
    expect(JSON.parse(addToToolsetText('{\n  "write_file": { "implementation": "native" }\n}', { write_file: "allow" }))).toEqual({ write_file: "allow" });
  });

  it("keeps CRLF, finds a key its author spaced differently, and changes only the mode of an object entry", () => {
    const text = '{\r\n  "git   commit": "ask",\r\n  "write_file": { "mode": "ask", "implementation": "native" }\r\n}\r\n';
    const out = addToToolsetText(text, { "git commit": "deny", write_file: "allow", rm: "allow" });
    expect(out).toBe('{\r\n  "git   commit": "deny",\r\n  "write_file": { "mode": "allow", "implementation": "native" },\r\n  "rm": "allow"\r\n}\r\n');
  });

  it("refuses what is not a toolset map, and what is not a subject", () => {
    expect(() => addToToolsetText('["bash"]', { git: "allow" })).toThrow(/not a map/);
    expect(() => addToToolsetText('"$/toolsets/chat/x"', { git: "allow" })).toThrow(/not a map/);
    expect(() => addToToolsetText("{ nope", { git: "allow" })).toThrow(/does not parse/);
    expect(() => addToToolsetText("{}", { other: "allow" })).toThrow(/not a subject/);
    expect(() => addToToolsetText("{}", { $ref: "allow" } as never)).toThrow(/not a subject/);
  });

  it("describes the line as it will be written", () => {
    expect(describeAddition({ "git commit": "allow" })).toBe('"git commit": "allow"');
    expect(describeAddition({ git: "deny", script: "deny" })).toBe('"git": "deny", "script": "deny"');
  });
});

describe("where a lowered block's subjects came from", () => {
  const read: ToolsetReader = (reference) => ({ value: { bash: "ask", "git commit": "ask", read_file: "allow" }, key: reference, from: reference });
  const sourceOf = (tools: unknown): unknown => {
    const lowered = lowerStateToolsets("plan", { environment: { tools } }, read).def as { environment: { permissions?: { source?: string } } };
    return lowered.environment.permissions?.source;
  };

  it("is the reference for a toolset named by one, and `inline` for a map — or a `$ref` that says more — on the state", () => {
    expect(sourceOf("$/toolsets/chat/ask-first")).toBe("$/toolsets/chat/ask-first");
    expect(sourceOf({ bash: "ask" })).toBe(INLINE_TOOLSET);
    expect(sourceOf({ $ref: "$/toolsets/chat/ask-first", "git commit": "allow" })).toBe(INLINE_TOOLSET);
  });

  it("is written only beside `subjects`, so a block that judges no shell line is exactly what it was", () => {
    expect(sourceOf({ read_file: "allow", other: "deny" })).toBeUndefined();
    expect(sourceOf(["bash"])).toBeUndefined();
  });
});

describe("the widths an answer remembers", () => {
  const part = (verdict: CommandPart["verdict"], widths: string[]): CommandPart => ({
    span: { start: 0, end: 0 },
    matched: [],
    text: "",
    kind: "command",
    subject: widths[0] ?? "bash",
    verdict,
    decidedBy: { source: "toolset", reason: "" },
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
