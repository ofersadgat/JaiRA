/**
 * A permission set's MCP bucket (the units doc `mcp-servers`): one group per configured server, its
 * button the server's line, a line per tool it names (`mcpBucketModel.ts`) — and Connections' MCP rows:
 * what a server's row says of how it answered, and what a detected source offers (`connectionsModel.ts`).
 * The model is asserted as data; the rows that draw it are the universal tree's.
 */
import { describe, expect, it } from "vitest";
import { mcpToolLines, parsePermissionSet, type ConfigView, type McpDetectedSource, type McpServerStatus, type PermissionSet } from "@jaira/shared/browser";
import {
  mcpAddLabel,
  mcpGroupHint,
  mcpGroupModeOf,
  mcpGroupsOf,
  mcpLineCount,
  mcpToolHint,
  unnamedMcpTools,
  withMcpServerMode,
  withMcpTool,
  withoutMcpServer,
} from "../src/renderer/mcpBucketModel";
import { detectedSaid, effectiveServers, mcpDetail, mcpStatusLine, mcpWord, newFromSource } from "../src/renderer/connectionsModel";
import { sectionCountOf } from "../src/renderer/composerPermissionSet";

const setOf = (decl: Record<string, unknown>): PermissionSet => parsePermissionSet(decl).permissionSet;

const playwright: McpServerStatus = {
  name: "playwright",
  state: "ready",
  transport: "stdio",
  where: "npx @playwright/mcp@latest",
  tools: [
    { name: "browser_snapshot", description: "Capture the page", annotations: { readOnlyHint: true } },
    { name: "browser_evaluate", description: "Run JavaScript on the page", annotations: { destructiveHint: true } },
    { name: "browser_click", description: "Click an element", annotations: {} },
    { name: "browser_close", annotations: {} },
  ],
  credentials: [],
  checkedAt: 1,
};

describe("the model", () => {
  it("a group per configured server, then one the map names that nothing configures", () => {
    const permissionSet = setOf({ mcp__gone__x: "allow", other: "ask" });
    expect(mcpGroupsOf(permissionSet, [playwright]).map((group) => [group.server, group.configured])).toEqual([
      ["playwright", true],
      ["gone", false],
    ]);
  });

  it("a server with no line of its own shows `other`, and the first change writes its line", () => {
    const permissionSet = setOf({ other: { function: "smart" } });
    expect(mcpGroupModeOf(permissionSet, "playwright")).toEqual({ function: "smart" });
    const next = withMcpServerMode(permissionSet, "playwright", "ask");
    expect(next.entries["mcp__playwright"]).toEqual({ kind: "mcp", mode: "ask" });
    expect(next.other).toEqual({ function: "smart" });
  });

  it("names a tool at what the server says of it — read-only allowed, destructive refused — else at the group's mode", () => {
    let permissionSet = setOf({ mcp__playwright: { function: "smart" }, other: "deny" });
    const [snapshot, evaluate, click] = playwright.tools;
    permissionSet = withMcpTool(permissionSet, "playwright", snapshot!);
    permissionSet = withMcpTool(permissionSet, "playwright", evaluate!);
    permissionSet = withMcpTool(permissionSet, "playwright", click!);
    expect(permissionSet.entries["mcp__playwright__browser_snapshot"]?.mode).toBe("allow");
    expect(permissionSet.entries["mcp__playwright__browser_evaluate"]?.mode).toBe("deny");
    expect(permissionSet.entries["mcp__playwright__browser_click"]?.mode).toEqual({ function: "smart" });
    expect(sectionCountOf(permissionSet, "mcp")).toBe(4);
    expect(Object.keys(withoutMcpServer(permissionSet, "playwright").entries)).toEqual([]);
  });

  it("says what the group holds, open and folded", () => {
    const permissionSet = setOf({ mcp__playwright: { function: "smart" }, mcp__playwright__browser_snapshot: { function: "smart" }, mcp__playwright__browser_evaluate: "deny", other: "deny" });
    const [group] = mcpGroupsOf(permissionSet, [playwright]);
    expect(mcpGroupHint(permissionSet, group!, true)).toBe("4 tools · 2 named here; any other playwright tool is decided by smart");
    expect(mcpGroupHint(permissionSet, group!, false)).toBe("4 tools · 2 named (browser_evaluate denied); the rest smart");
    expect(mcpGroupHint(setOf({ other: "ask" }), group!, false)).toBe("4 tools · every tool asks");
    expect(mcpToolHint(playwright.tools[0])).toBe("Capture the page · read-only, says the server");
    expect(mcpToolHint(playwright.tools[1])).toBe("Run JavaScript on the page · destructive, says the server");
    expect(mcpToolHint(playwright.tools[3])).toBe("");
    const unnamed = unnamedMcpTools(permissionSet, group!);
    expect(unnamed.map((tool) => tool.name)).toEqual(["browser_click", "browser_close"]);
    expect(mcpAddLabel("playwright", unnamed)).toBe("name another playwright tool: 2 more, from browser_click to browser_close");
  });
});

describe("what the rows say", () => {
  it("one group per server: its sentence, its count and its own mode; open, a line per named tool and the add line", () => {
    const permissionSet = setOf({ mcp__playwright__browser_evaluate: "deny", other: "ask" });
    const groups = mcpGroupsOf(permissionSet, [playwright]);
    expect(groups.map((group) => group.server)).toEqual(["playwright"]);
    expect(mcpGroupHint(permissionSet, groups[0]!, true)).toBe("4 tools · 1 named here; any other playwright tool asks");
    // With no line of its own, the group's button shows what any tool of it answers to.
    expect(mcpGroupModeOf(permissionSet, "playwright")).toBe("ask");
    expect(mcpLineCount(permissionSet)).toBe(1);
    // Open: the one tool it names, saying what the server says of it, then the line that names another.
    const lines = mcpToolLines(permissionSet, "playwright");
    expect(lines.map((line) => [line.tool, line.mode])).toEqual([["browser_evaluate", "deny"]]);
    expect(mcpToolHint(playwright.tools.find((tool) => tool.name === lines[0]!.tool))).toBe("Run JavaScript on the page · destructive, says the server");
    expect(mcpAddLabel("playwright", unnamedMcpTools(permissionSet, groups[0]!))).toBe("name another playwright tool: 3 more, from browser_click to browser_snapshot");
  });

  it("with no server and no line there is no group — the section then says so, or read-only is not drawn", () => {
    expect(mcpGroupsOf(setOf({ other: "ask" }), [])).toEqual([]);
    // Not asked yet is the same nothing as asked and none.
    expect(mcpGroupsOf(setOf({ other: "ask" }), undefined)).toEqual([]);
  });

  it("Connections: a row per server saying how it answered, and what each detected source would add", () => {
    const config = {
      base: null,
      project: { mcp: { servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } } },
      effective: { mcp: { servers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] }, linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: { credential: "LINEAR_AUTH" } } } } } },
      baseFile: "",
      projectFile: "p",
      baseDir: "",
    } as unknown as ConfigView;
    const linear: McpServerStatus = {
      name: "linear",
      state: "not started",
      reason: "LINEAR_AUTH is not stored anywhere",
      fix: "store it in the box on the right",
      transport: "http",
      where: "https://mcp.linear.app/mcp",
      tools: [],
      credentials: [{ field: "headers", key: "Authorization", credential: "LINEAR_AUTH" }],
      checkedAt: 1,
    };
    const detected: McpDetectedSource[] = [
      { source: "port", label: "Figma Dev Mode", where: "http://127.0.0.1:3845/mcp", state: "found", servers: [{ name: "figma", config: { url: "http://127.0.0.1:3845/mcp" } }], detail: "answering, 21 tools" },
      { source: "project", label: "This project's .mcp.json", where: "p/.mcp.json", state: "found", servers: [{ name: "playwright", config: { command: "npx" } }] },
    ];
    // A row per server the layers add up to, each a word and then how it is reached and what it
    // listed — or, for one that did not start, why.
    const servers = effectiveServers(config);
    expect(Object.keys(servers)).toEqual(["playwright", "linear"]);
    expect([mcpWord(true, playwright), mcpDetail(true, servers["playwright"]!, playwright)]).toEqual(["ready", "stdio · npx @playwright/mcp@latest · 4 tools"]);
    expect([mcpWord(true, linear), mcpDetail(true, servers["linear"]!, linear)]).toEqual(["not started", "LINEAR_AUTH is not stored anywhere"]);
    // The detection panel: what each source lists, and what its Add would write.
    const [figma, projectFile] = detected;
    expect(detectedSaid(figma!)).toBe("figma · answering, 21 tools");
    // Figma is new and one click from being ours; playwright is already configured.
    expect(newFromSource(figma!, servers)).toEqual([{ name: "figma", config: { url: "http://127.0.0.1:3845/mcp" } }]);
    expect(newFromSource(projectFile!, servers)).toEqual([]);
    expect(mcpStatusLine({ url: "http://x/mcp" }, { ...linear, state: "ready", transport: "http", where: "http://x/mcp", tools: [playwright.tools[0]!] })).toBe("HTTP · http://x/mcp · answered with 1 tool");
  });
});

