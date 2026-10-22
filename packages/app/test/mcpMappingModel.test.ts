/**
 * A server's tools counted as standard tools (decision 0019, ruling 5), as Settings draws them: under the
 * server in a permission set's MCP bucket, following what they count as (withheld where the set uses
 * JaiRA's own), and on Connections, a field per tool and the claims a tool makes, to accept.
 */
import { describe, expect, it } from "vitest";
import { parsePermissionSet, type McpServerConfig, type McpServerStatus, type PermissionSet } from "@jaira/shared/browser";
import { countsAsWords, mappedMcpToolsOf, unnamedMcpTools, type McpGroup } from "../src/renderer/mcpBucketModel";
import { serverSchemaOf, unacceptedClaims } from "../src/renderer/connectionsModel";

const setOf = (decl: Record<string, unknown>): PermissionSet => parsePermissionSet(decl).permissionSet;

const status: McpServerStatus = {
  name: "computer",
  state: "ready",
  transport: "stdio",
  where: "computer-mcp",
  tools: [
    { name: "take_screenshot", description: "Capture the screen", annotations: { readOnlyHint: true }, claim: { as: "screenshot" } },
    { name: "click_screen", description: "Click", annotations: {} },
    { name: "read_text_file", description: "Read a text file", annotations: {}, inputs: ["file", "encoding"] },
    { name: "computer", description: "Use the computer", annotations: {} },
  ],
  mappings: { click_screen: { as: "control_input" }, read_text_file: { as: "read_file", args: { path: "file" } }, computer: { as: "screen" } },
  credentials: [],
  checkedAt: 1,
};
const group: McpGroup = { server: "computer", status, configured: true };
const native = (mode: string) => ({ mode, implementation: "native" });

describe("the bucket: a server's mapped tools", () => {
  it("follow what they count as — the stricter with the server's line where the set writes one", () => {
    const rows = mappedMcpToolsOf(setOf({ control_input: native("ask"), read_file: native("allow"), screenshot: native("allow"), mcp__computer: "deny", other: "allow" }), group);
    expect(rows.map((row) => [row.tool, row.mode, row.withheld])).toEqual([
      ["click_screen", "deny", false],
      ["computer", "deny", false],
      ["read_text_file", "deny", false],
    ]);
    const loose = mappedMcpToolsOf(setOf({ control_input: native("ask"), read_file: native("allow"), screenshot: native("allow") }), group);
    expect(loose.map((row) => [row.tool, row.mode])).toEqual([
      ["click_screen", "ask"],
      // `screen` comes to the stricter of its pair.
      ["computer", "ask"],
      ["read_text_file", "allow"],
    ]);
    expect(loose.find((row) => row.tool === "read_text_file")?.hint).toBe("counts as read_file (path from file) — answers to its line");
  });

  it("are withheld where the set uses JaiRA's own of what they count as", () => {
    const rows = mappedMcpToolsOf(setOf({ control_input: "allow", read_file: "allow", screenshot: "allow" }), group);
    expect(rows.every((row) => row.withheld && row.mode === "deny")).toBe(true);
    expect(rows[0]!.hint).toBe("counts as control_input — withheld: this set uses JaiRA's own control_input");
  });

  it("leave the 'name another' list, since they are drawn already", () => {
    expect(unnamedMcpTools(setOf({}), group).map((tool) => tool.name)).toEqual(["take_screenshot"]);
  });

  it("say what they count as in words", () => {
    expect(countsAsWords({ as: "screen" })).toBe("screenshot when it only looks, control_input otherwise");
    expect(countsAsWords({ as: "shell", args: { command: "cmd" } })).toBe("shell (command from cmd)");
  });
});

describe("Connections: what a server's tools count as", () => {
  const server: McpServerConfig = { command: "computer-mcp", tools: { read_text_file: { as: "read_file", args: { path: "file" } } } };

  it("is a field per tool the server lists, the places following the standard tool picked", () => {
    const schema = serverSchemaOf(server, status) as { properties: Record<string, { properties?: Record<string, { properties?: Record<string, { enum?: string[] }>; enum?: string[] }> }> };
    const tools = schema.properties["tools"]!.properties!;
    expect(Object.keys(tools)).toEqual(["click_screen", "computer", "read_text_file", "take_screenshot"]);
    const read = tools["read_text_file"] as unknown as { properties: { as: { enum: string[] }; args: { properties: Record<string, { enum?: string[] }> } } };
    expect(read.properties.as.enum).toContain("read_file");
    expect(read.properties.as.enum).toContain("screen");
    // The place read_file reads, picked from the tool's own arguments.
    expect(read.properties.args.properties).toEqual({ path: { type: "string", title: "path", enum: ["file", "encoding"] } });
    // A tool mapped to nothing that reads a place offers no places.
    expect((tools["click_screen"] as unknown as { properties: Record<string, unknown> }).properties["args"]).toBeUndefined();
  });

  it("has no field before the probe has listed anything and nothing is mapped", () => {
    expect((serverSchemaOf({ command: "x" }, undefined) as { properties: Record<string, unknown> }).properties["tools"]).toBeUndefined();
  });

  it("offers a tool's own claim to accept, until the configuration says something for that tool", () => {
    expect(unacceptedClaims({ command: "computer-mcp" }, status)).toEqual([{ tool: "take_screenshot", claim: { as: "screenshot" } }]);
    expect(unacceptedClaims({ command: "computer-mcp", tools: { take_screenshot: { as: "screenshot" } } }, status)).toEqual([]);
  });
});
