/**
 * A permission set's MCP bucket (the units doc `mcp-servers`): one group per configured server, its
 * button the server's line, a line per tool it names — and Connections' MCP rows. The model is asserted
 * as data and the rows as their static markup, since the renderer has no DOM harness.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePermissionSet, TOOL_CATEGORIES, type ConfigView, type McpServerStatus, type PermissionSet } from "@jaira/shared/browser";
import { McpBucket, mcpServerFold } from "../src/renderer/mcpBucket";
import {
  mcpAddLabel,
  mcpGroupHint,
  mcpGroupModeOf,
  mcpGroupsOf,
  mcpToolHint,
  unnamedMcpTools,
  withMcpServerMode,
  withMcpTool,
  withoutMcpServer,
} from "../src/renderer/mcpBucketModel";
import { McpServerRows, mcpStatusLine } from "../src/renderer/mcpServersRows";
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

describe("drawn", () => {
  const category = TOOL_CATEGORIES.find((one) => one.id === "mcp")!;
  const draw = (permissionSet: PermissionSet, servers: McpServerStatus[] | undefined, open: string[], locked = false): string =>
    renderToStaticMarkup(
      createElement(McpBucket, { category, permissionSet, servers, locked, write: () => undefined, open: new Set(open), toggle: () => undefined }),
    );

  it("one group per server: fold, name, sentence, count and its own mode; open, a line per named tool and the add line", () => {
    const permissionSet = setOf({ mcp__playwright__browser_evaluate: "deny", other: "ask" });
    const html = draw(permissionSet, [playwright], ["mcp", mcpServerFold("playwright")]);
    expect(html).toContain("cx-cat cx-sub mcp-group open");
    expect(html).toContain('<span class="mono">playwright</span>');
    expect(html).toContain("4 tools · 1 named here; any other playwright tool asks");
    expect(html).toContain('class="cx-tool on set-held"');
    expect(html).toContain("browser_evaluate");
    expect(html).toContain("Run JavaScript on the page · destructive, says the server");
    expect(html).toContain("name another playwright tool: 3 more, from browser_click to browser_snapshot");
    expect(html).toContain("set-minus");
  });

  it("with no server and no line, the section says so; read-only, it is not drawn", () => {
    expect(draw(setOf({ other: "ask" }), [], [])).toContain("nothing here — add a server in Settings → Connections");
    expect(draw(setOf({ other: "ask" }), [], [], true)).toBe("");
  });

  it("Connections: a row per server saying how it answered, the secrets it is sent, and the detection panel", () => {
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
    const html = renderToStaticMarkup(
      createElement(McpServerRows, {
        config,
        layer: "project",
        busy: false,
        editable: true,
        secrets: { keychain: false },
        onSave: () => undefined,
        mcp: {
          report: { servers: [playwright, linear], checkedAt: 1 },
          detected: [
            { source: "port", label: "Figma Dev Mode", where: "http://127.0.0.1:3845/mcp", state: "found", servers: [{ name: "figma", config: { url: "http://127.0.0.1:3845/mcp" } }], detail: "answering, 21 tools" },
            { source: "project", label: "This project's .mcp.json", where: "p/.mcp.json", state: "found", servers: [{ name: "playwright", config: { command: "npx" } }] },
          ],
          rechecking: false,
          recheck: () => undefined,
          storeSecret: async () => undefined,
          problem: null,
        },
      }),
    );
    expect(html).toContain("ready</span> — stdio · npx @playwright/mcp@latest · 4 tools");
    expect(html).toContain("not started</span> — LINEAR_AUTH is not stored anywhere");
    expect(html).toContain("cfg-key-box missing");
    expect(html).toContain("Servers other tools on this machine already run");
    expect(html).toContain("answering, 21 tools");
    // Figma is new and one click from being ours; playwright is already configured.
    expect(html).toContain(">Add<");
    expect(html).toContain(">added<");
    expect(html).toContain("a command JaiRA starts (stdio), or a URL it calls (HTTP)");
    expect(mcpStatusLine({ url: "http://x/mcp" }, { ...linear, state: "ready", transport: "http", where: "http://x/mcp", tools: [playwright.tools[0]!] })).toBe("HTTP · http://x/mcp · answered with 1 tool");
  });
});
