/**
 * MCP servers in `settings.json`, and MCP subjects in a permission set (the units doc `mcp-servers`):
 * the block parsed strictly and layered by server name; a tool's line, then its server's, then `other`;
 * a tool named from what the server says of it; lowering and reading back.
 */
import { describe, expect, it } from "vitest";
import {
  lowerPermissionSet,
  mcpFirstMode,
  mcpModeOf,
  mcpNameOfForeign,
  mcpSecretsOf,
  mcpServerOfForeign,
  mergeConfigDocuments,
  parseConfig,
  parseMcp,
  parseMcpSubject,
  parsePermissionSet,
  permissionSetOfEnvironment,
  shellSubjects,
  shellWithheld,
  subjectKindOf,
} from "../src";

describe("the mcp block", () => {
  it("reads a server JaiRA starts and one it calls, secrets by name", () => {
    const mcp = parseMcp({
      servers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"], env: { DEBUG: "1", TOKEN: { credential: "PW_TOKEN" } }, cwd: "C:/work" },
        figma: { url: "http://127.0.0.1:3845/mcp", enabled: false },
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: { credential: "LINEAR_AUTH" } } },
      },
    });
    expect(mcp.servers["playwright"]).toEqual({ command: "npx", args: ["@playwright/mcp@latest"], env: { DEBUG: "1", TOKEN: { credential: "PW_TOKEN" } }, cwd: "C:/work" });
    expect(mcp.servers["figma"]).toEqual({ url: "http://127.0.0.1:3845/mcp", enabled: false });
    expect(mcpSecretsOf(mcp.servers["linear"]!)).toEqual([{ field: "headers", key: "Authorization", credential: "LINEAR_AUTH" }]);
    expect(parseMcp(undefined)).toEqual({ servers: {} });
  });

  it("refuses what it has no place for, naming the field", () => {
    expect(() => parseMcp({ servers: { x: { command: "a", url: "http://b" } } })).toThrow(/both a command and a url/);
    expect(() => parseMcp({ servers: { x: {} } })).toThrow(/needs a command .* or a url/);
    expect(() => parseMcp({ servers: { x: { command: "a", type: "stdio" } } })).toThrow(/config\.mcp\.servers\.x\.type is not a setting/);
    expect(() => parseMcp({ servers: { x: { url: "http://b", env: {} } } })).toThrow(/x\.env is not a setting of a server JaiRA calls/);
    expect(() => parseMcp({ servers: { x: { url: "ftp://b" } } })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => parseMcp({ servers: { x: { command: "a", env: { K: 1 } } } })).toThrow(/x\.env\.K must be a string/);
    expect(() => parseMcp({ servers: { x: { command: "a", env: { K: { credential: "sk-ab cd" } } } } })).toThrow(/must NAME a secret/);
    expect(() => parseMcp({ servers: { x: { command: "a", env: { K: { credential: "A", extra: 1 } } } } })).toThrow(/nothing else/);
    expect(() => parseMcp({ other: {} })).toThrow(/config\.mcp\.other is not a setting/);
  });

  it("holds a name to what its tools' subject can carry, and keeps `dai` for the bridge", () => {
    for (const bad of ["a__b", "_a", "a_", "a b", "a.b", ""]) expect(() => parseMcp({ servers: { [bad]: { command: "x" } } })).toThrow(/not a server name/);
    expect(() => parseMcp({ servers: { dai: { command: "x" } } })).toThrow(/JaiRA's own bridge/);
    expect(Object.keys(parseMcp({ servers: { "my-server_2": { command: "x" } } }).servers)).toEqual(["my-server_2"]);
  });

  it("layers by server name: a project turns a shared server off without restating it", () => {
    const base = { mcp: { servers: { figma: { url: "http://127.0.0.1:3845/mcp" }, pw: { command: "npx", args: ["a"] } } } };
    const project = { mcp: { servers: { figma: { enabled: false }, gh: { url: "https://api.example/mcp" } } } };
    const config = parseConfig(mergeConfigDocuments(base, project));
    expect(config.mcp.servers).toEqual({
      figma: { url: "http://127.0.0.1:3845/mcp", enabled: false },
      pw: { command: "npx", args: ["a"] },
      gh: { url: "https://api.example/mcp" },
    });
    expect(parseConfig({}).mcp).toEqual({ servers: {} });
  });
});

describe("MCP subjects", () => {
  it("splits a subject at the server, the tool keeping whatever it is called", () => {
    expect(parseMcpSubject("mcp__figma")).toEqual({ server: "figma" });
    expect(parseMcpSubject("mcp__figma__get_code")).toEqual({ server: "figma", tool: "get_code" });
    expect(parseMcpSubject("mcp__my_srv__a__b")).toEqual({ server: "my_srv", tool: "a__b" });
    expect(parseMcpSubject("mcp__")).toBeUndefined();
    expect(parseMcpSubject("git")).toBeUndefined();
    expect(subjectKindOf("mcp__figma")).toBe("mcp");
    expect(subjectKindOf("mcp__figma__get_code")).toBe("mcp");
  });

  it("keeps MCP lines in a map, with no implementation", () => {
    const { permissionSet, issues } = parsePermissionSet({ mcp__figma: "ask", mcp__figma__get_code: { mode: "allow", implementation: "native" }, other: "deny" });
    expect(permissionSet.entries).toEqual({ mcp__figma: { kind: "mcp", mode: "ask" }, mcp__figma__get_code: { kind: "mcp", mode: "allow" } });
    expect(issues.map((issue) => issue.message)).toEqual(["'mcp__figma__get_code' is not a tool, so an implementation means nothing on it"]);
  });

  it("answers a tool by its own line, then its server's, then `other` — as git commit, git, the shell", () => {
    const { permissionSet } = parsePermissionSet({ mcp__figma: "ask", mcp__figma__get_code: "allow", mcp__figma__delete: { function: "smart" }, other: "deny" });
    expect(mcpModeOf(permissionSet, "mcp__figma__get_code")).toEqual({ mode: "allow", line: "mcp__figma__get_code" });
    expect(mcpModeOf(permissionSet, "mcp__figma__delete")).toEqual({ mode: { function: "smart" }, line: "mcp__figma__delete" });
    expect(mcpModeOf(permissionSet, "mcp__figma__whoami")).toEqual({ mode: "ask", line: "mcp__figma" });
    expect(mcpModeOf(permissionSet, "mcp__linear__list")).toEqual({ mode: "deny", line: "other" });
    expect(mcpModeOf(parsePermissionSet({ read_file: "allow" }).permissionSet, "mcp__linear__list")).toBeUndefined();
  });

  it("names a tool at what the server says of it, else at what it answered to", () => {
    expect(mcpFirstMode({ readOnlyHint: true }, "ask")).toBe("allow");
    expect(mcpFirstMode({ destructiveHint: true }, "allow")).toBe("deny");
    expect(mcpFirstMode({ readOnlyHint: false, destructiveHint: false }, { function: "smart" })).toEqual({ function: "smart" });
    expect(mcpFirstMode(undefined, "ask")).toBe("ask");
  });

  it("lowers into the gate's tool modes and reads back as the same lines; never a shell subject, never a door for the shell", () => {
    const { permissionSet } = parsePermissionSet({ bash: "deny", mcp__figma: "allow", mcp__figma__delete: { function: "smart" }, other: "deny" });
    // An allowing MCP line does not keep a denied shell: only a command or `script` can.
    expect(shellWithheld(permissionSet)).toBe(true);
    expect(shellSubjects(permissionSet)).toEqual({ bash: "deny" });
    const lowered = lowerPermissionSet(permissionSet, undefined, "$/permission-sets/chat/figma");
    expect(lowered.tools).toEqual([]);
    expect(lowered.permissions?.tools).toMatchObject({ mcp__figma: "allow", mcp__figma__delete: "ask", bash: "deny" });
    expect(lowered.permissions?.functions).toEqual({ mcp__figma__delete: "smart" });
    // Where the lines came from rides along, for "add to the permission set".
    expect(lowered.permissions?.source).toBe("$/permission-sets/chat/figma");
    const back = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back.entries["mcp__figma"]).toEqual({ kind: "mcp", mode: "allow" });
    expect(back.entries["mcp__figma__delete"]).toEqual({ kind: "mcp", mode: { function: "smart" } });
  });
});

describe("somebody else's server config", () => {
  it("keeps a command or a url and what goes with it, and reads ${NAME} as the secret NAME", () => {
    expect(mcpServerOfForeign({ type: "stdio", command: "npx", args: ["-y", "x"], env: { TOKEN: "${GH_TOKEN}", MODE: "fast", N: 3 }, disabled: false })).toEqual({
      command: "npx",
      args: ["-y", "x"],
      env: { TOKEN: { credential: "GH_TOKEN" }, MODE: "fast" },
    });
    expect(mcpServerOfForeign({ type: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer ${T}" } })).toEqual({
      url: "https://a.example/mcp",
      headers: { Authorization: "Bearer ${T}" },
    });
    expect(mcpServerOfForeign({ type: "sse" })).toBeUndefined();
  });

  it("makes a name safe for a subject", () => {
    expect(mcpNameOfForeign("github.com/org")).toBe("github-com-org");
    expect(mcpNameOfForeign("a__b")).toBe("a_b");
    expect(mcpNameOfForeign("dai")).toBe("dai-server");
    expect(mcpNameOfForeign("  ")).toBe("server");
  });
});
