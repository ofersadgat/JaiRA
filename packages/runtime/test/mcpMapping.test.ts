/**
 * An MCP server's tools counted as standard tools (decision 0018, ruling 5): the mapping in settings and
 * the claim a tool makes, and a mapped call judged by its own line (or its server's) and the standard
 * tool it counts as, the stricter kept — with JaiRA's own tool preferred over the server's.
 */
import { describe, expect, it } from "vitest";
import { mappedCallOf, mcpClaimOf, mcpMappingOf, parseMcp, parsePermissionSet, type JairaMcpConfig, type McpToolMapping } from "@jaira/shared";
import { allowsCall, compilePolicy, decideMappedMcpCall, type MappedCallJudges } from "../src/policy";

const MCP: JairaMcpConfig = parseMcp({
  servers: {
    computer: {
      command: "computer-mcp",
      tools: {
        computer: { as: "screen" },
        take_screenshot: { as: "screenshot" },
        click_screen: { as: "control_input" },
        run: { as: "shell", args: { command: "cmd" } },
        read: { as: "read_file", args: { path: "file" } },
        reboot: { as: "power" },
      },
    },
  },
});

/** A JaiRA tool line that uses the agent's own — the server's — rather than JaiRA's. */
const native = (mode: string) => ({ mode, implementation: "native" });

const judged = (set: Record<string, unknown>, tool: string, input: Record<string, unknown> = {}, judges: MappedCallJudges = {}) => {
  const mapping = mcpMappingOf(MCP, `mcp__computer__${tool}`)!;
  const decision = decideMappedMcpCall(`mcp__computer__${tool}`, input, mapping, parsePermissionSet(set).permissionSet, "test", judges);
  return { action: decision.action, line: decision.parts.line, parts: decision.parts.parts.map((p) => `${p.subject}:${p.verdict}`) };
};

describe("the mapping, in settings and as a tool's claim", () => {
  it("is a server's `tools`, each a standard tool (or `screen`) and where it reads a place", () => {
    expect(MCP.servers["computer"]!.tools?.["read"]).toEqual({ as: "read_file", args: { path: "file" } });
    expect(mcpMappingOf(MCP, "mcp__computer__take_screenshot")).toEqual({ as: "screenshot" });
    expect(mcpMappingOf(MCP, "mcp__computer__unknown")).toBeUndefined();
    expect(mcpMappingOf(MCP, "mcp__other__take_screenshot")).toBeUndefined();
  });

  it("refuses what names no standard tool, and an argument the tool does not read a place from", () => {
    expect(() => parseMcp({ servers: { s: { command: "x", tools: { a: { as: "reed_file" } } } } })).toThrow(/standard tool's name/);
    expect(() => parseMcp({ servers: { s: { command: "x", tools: { a: { as: "read_file", args: { url: "u" } } } } } })).toThrow(/'url' is not an argument read_file reads a place from — it reads path/);
    expect(() => parseMcp({ servers: { s: { command: "x", tools: { a: { as: "screenshot", args: { path: "p" } } } } } })).toThrow(/screenshot reads no place/);
    expect(() => parseMcp({ servers: { s: { command: "x", tools: { a: { as: "shell", extra: 1 } } } } })).toThrow(/'extra' is not part of a mapping/);
  });

  it("reads a tool's own claim off its `_meta`, and only a well-formed one", () => {
    expect(mcpClaimOf({ "jaira/tool": { as: "read_file", args: { path: "uri" } } })).toEqual({ as: "read_file", args: { path: "uri" } });
    expect(mcpClaimOf({ "jaira/tool": { as: "delete_everything" } })).toBeUndefined();
    expect(mcpClaimOf({ other: 1 })).toBeUndefined();
    expect(mcpClaimOf(undefined)).toBeUndefined();
  });

  it("reads one call as the standard tool reads it: `screen` by its action, places from the named arguments", () => {
    const screen: McpToolMapping = { as: "screen" };
    expect(mappedCallOf(screen, { action: "screenshot" }).tool).toBe("screenshot");
    expect(mappedCallOf(screen, { action: "zoom" }).tool).toBe("screenshot");
    expect(mappedCallOf(screen, { action: "left_click", coordinate: [1, 2] }).tool).toBe("control_input");
    expect(mappedCallOf({ as: "read_file", args: { path: "file" } }, { file: "a.txt", encoding: "utf8" })).toEqual({ tool: "read_file", input: { path: "a.txt" } });
    // An argument not named is read from the server tool's argument of the same name.
    expect(mappedCallOf({ as: "web_fetch" }, { url: "https://x.org", max: 3 })).toEqual({ tool: "web_fetch", input: { url: "https://x.org" } });
  });
});

describe("a mapped call, judged", () => {
  it("prefers JaiRA's own: withheld where the set holds JaiRA's tool it counts as", () => {
    expect(judged({ screenshot: "allow", other: "deny" }, "take_screenshot")).toMatchObject({ action: "deny", parts: ["mcp__computer__take_screenshot:denied"] });
    // `screen` is withheld only when JaiRA holds the whole pair.
    expect(judged({ screenshot: "allow", control_input: "ask" }, "computer", { action: "left_click" }).action).toBe("deny");
    expect(judged({ screenshot: "allow" }, "computer", { action: "screenshot" }).action).not.toBe("deny");
  });

  it("is the standard tool's line alone where the set has none for the tool or its server", () => {
    expect(judged({ screenshot: native("allow"), other: "deny" }, "take_screenshot")).toMatchObject({ action: "allow", parts: ["screenshot:allowed"] });
    expect(judged({ control_input: native("deny"), other: "allow" }, "click_screen")).toMatchObject({ action: "deny", parts: ["control_input:denied"] });
    // Nothing for the standard tool either: `other` answers for it.
    expect(judged({ other: "deny" }, "take_screenshot")).toMatchObject({ action: "deny", parts: ["screenshot:denied"] });
  });

  it("keeps the stricter of the tool's own line (or its server's) and the standard tool's", () => {
    expect(judged({ mcp__computer: "ask", screenshot: native("allow") }, "take_screenshot")).toMatchObject({ action: "require_approval", parts: ["mcp__computer__take_screenshot:asks", "screenshot:allowed"] });
    expect(judged({ mcp__computer__click_screen: "allow", control_input: native("deny") }, "click_screen")).toMatchObject({ action: "deny" });
    expect(judged({ mcp__computer__take_screenshot: "deny", screenshot: native("allow") }, "take_screenshot")).toMatchObject({ action: "deny" });
    expect(judged({ mcp__computer: "allow", screenshot: native("allow") }, "take_screenshot")).toMatchObject({ action: "allow" });
  });

  it("splits the single `computer` tool by its action", () => {
    const set = { screenshot: native("allow"), control_input: native("deny") };
    expect(judged(set, "computer", { action: "screenshot" })).toMatchObject({ action: "allow", parts: ["screenshot:allowed"] });
    expect(judged(set, "computer", { action: "type", text: "hi" })).toMatchObject({ action: "deny", parts: ["control_input:denied"] });
  });

  it("asks before what counts as `power`, as before a push", () => {
    expect(judged({ power: native("allow") }, "reboot", {}, { builtins: true })).toMatchObject({ action: "require_approval", parts: ["power:asks"] });
    expect(judged({ power: native("allow") }, "reboot", {}, { builtins: false })).toMatchObject({ action: "allow" });
  });

  it("judges what counts as `shell` part by part, the parts drawn after the tool's name", () => {
    const shell = (input: Record<string, unknown>) => ({
      line: String(input["command"]),
      dialect: "posix" as const,
      verdict: "denied" as const,
      parts: [{ span: { start: 0, end: 8 }, matched: [{ start: 0, end: 8 }], text: "git push", kind: "command" as const, subject: "git push", verdict: "denied" as const, decidedBy: { source: "permissionSet" as const, reason: "no" }, widths: ["git push"] }],
    });
    const decision = decideMappedMcpCall("mcp__computer__run", { cmd: "git push" }, mcpMappingOf(MCP, "mcp__computer__run")!, parsePermissionSet({ shell: native("allow") }).permissionSet, "test", { shell });
    expect(decision.parts.line).toBe("mcp__computer__run: git push");
    expect(decision.parts.parts.map((p) => [p.subject, p.verdict, decision.parts.line.slice(p.span.start, p.span.end)])).toEqual([["git push", "denied", "git push"]]);
  });

  it("puts a mapped file tool's place to the scope tables", () => {
    const scope = (tool: string, input: Record<string, unknown>) => (tool === "read_file" && String(input["path"]).startsWith("secrets/") ? ("deny" as const) : undefined);
    expect(judged({ read_file: native("allow") }, "read", { file: "notes.txt" }, { scope })).toMatchObject({ action: "allow" });
    expect(judged({ read_file: native("allow") }, "read", { file: "secrets/key" }, { scope })).toMatchObject({ action: "deny", parts: ["read_file:denied"] });
  });
});

describe("the compiled policy and the read-only judge", () => {
  it("narrow a mapped call by what it counts as, on whichever route asks", () => {
    const permissionSet = parsePermissionSet({ screenshot: native("allow"), control_input: native("deny"), other: "allow" }).permissionSet;
    const policy = compilePolicy({}, { permissionSet, mcp: MCP });
    const narrow = (tool: string, input: Record<string, unknown>) => policy.scopeOf!({ name: tool } as never, input as never, undefined as never);
    expect(narrow("mcp__computer__take_screenshot", {})).toBeUndefined();
    expect(narrow("mcp__computer__click_screen", { x: 1, y: 2 })).toBe("deny");
    // A tool nobody mapped answers as before: its lines, then `other`.
    expect(narrow("mcp__computer__unmapped", {})).toBeUndefined();
  });

  it("calls a mapped look a look", () => {
    const permissionSet = parsePermissionSet({ screenshot: native("allow"), control_input: native("deny"), other: "deny" }).permissionSet;
    expect(allowsCall({}, permissionSet, "mcp__computer__take_screenshot", {}, "posix", { mcp: MCP })).toBe(true);
    expect(allowsCall({}, permissionSet, "mcp__computer__click_screen", {}, "posix", { mcp: MCP })).toBe(false);
    expect(allowsCall({}, permissionSet, "mcp__computer__take_screenshot", {}, "posix")).toBe(false);
  });
});
