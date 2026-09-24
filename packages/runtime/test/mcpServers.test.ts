/**
 * MCP servers on the Node side (the units doc `mcp-servers`): what other tools here list, read from
 * fixture files and never started; the tools probe, with a lister standing in for a server; what claude
 * and codex are handed, MEASURED through the real chain; and a call to an MCP tool judged by its line,
 * its server's, or `other`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lowerPermissionSet, parseMcp, parsePermissionSet } from "@jaira/shared";
import { handedToClaude, handedToCodex, type HandedEnvironment } from "../src/agentHanded";
import { ApprovalHub } from "../src/approval";
import {
  detectMcpServers,
  handedMcpServers,
  mcpServersIn,
  mcpServersOfCall,
  noteMcpCall,
  probeMcpServers,
  resolveMcpServers,
  type McpLister,
  type McpView,
} from "../src/mcpServers";
import { CommandGrants, commandDecisionOf, compilePolicy, decideMcpCall } from "../src/policy";

vi.setConfig({ testTimeout: 60_000 });

const map = (decl: Record<string, unknown>): HandedEnvironment => lowerPermissionSet(parsePermissionSet(decl).permissionSet, undefined, "$/permission-sets/chat/mcp");
const setOf = (decl: Record<string, unknown>) => parsePermissionSet(decl).permissionSet;
const viewOf = (decl: Record<string, unknown>): McpView => {
  const permissionSet = setOf(decl);
  return {
    lineOf: (subject) => {
      const own = (key: string) => permissionSet.entries[key]?.mode;
      const server = /^mcp__[^_]+(?:_[^_]+)*/.exec(subject)?.[0] ?? subject;
      if (own(subject) !== undefined) return { mode: own(subject)!, line: subject };
      if (own(server) !== undefined) return { mode: own(server)!, line: server };
      return permissionSet.other !== undefined ? { mode: permissionSet.other, line: "other" } : undefined;
    },
    lines: () => Object.fromEntries(Object.entries(permissionSet.entries).filter(([, e]) => e.kind === "mcp").map(([k, e]) => [k, e.mode!])),
  };
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jaira-mcp-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

describe("detecting what other tools on this machine list", () => {
  it("reads each known file, converts its entries, and starts nothing", async () => {
    const root = fixture({
      "home/.claude.json": JSON.stringify({
        mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } },
        projects: { "C:/work/app": { mcpServers: { "local tools": { type: "http", url: "http://localhost:9000/mcp" } } }, "C:/other": { mcpServers: { nope: { command: "x" } } } },
      }),
      "appdata/Claude/claude_desktop_config.json": JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["fs"] } } }),
      "home/.cursor/mcp.json": JSON.stringify({ mcpServers: {} }),
      "project/.mcp.json": JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } }),
      // VS Code's file allows comments and a trailing comma, and names its map `servers`.
      "project/.vscode/mcp.json": '{\n  // mine\n  "servers": { "deno": { "type": "stdio", "command": "deno", "args": ["run", "x"], }, },\n}',
    });
    const list: McpLister = vi.fn(async () => ({ transport: "http" as const, tools: [{ name: "get_code", annotations: {} }, { name: "whoami", annotations: {} }] }));
    const sources = await detectMcpServers({
      home: join(root, "home"),
      appData: join(root, "appdata"),
      platform: "win32",
      projectDir: join(root, "project"),
      list,
    });
    // `projects` is keyed by the directory Claude Code saw; neither entry here is this project's, so
    // only the list Claude Code keeps for every project is.
    const claude = sources.find((s) => s.source === "claude-code")!;
    expect(claude.state).toBe("found");
    expect(claude.servers.map((s) => s.name)).toEqual(["github"]);
    expect(claude.servers[0]!.config).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: { credential: "GITHUB_TOKEN" } } });

    const byLabel = Object.fromEntries(sources.map((s) => [s.label, s]));
    expect(byLabel["This project's .mcp.json"]!.servers).toEqual([{ name: "playwright", config: { command: "npx", args: ["@playwright/mcp@latest"] } }]);
    expect(byLabel["Claude Desktop"]!.servers.map((s) => s.name)).toEqual(["filesystem"]);
    expect(byLabel["Cursor"]!.state).toBe("none listed");
    expect(byLabel["Cursor, this project"]!.state).toBe("not found");
    expect(byLabel["VS Code, this project"]!.servers).toEqual([{ name: "deno", config: { command: "deno", args: ["run", "x"] } }]);
    // The known port is ASKED — the only thing detection does that is not a file read.
    expect(byLabel["Figma Dev Mode"]).toMatchObject({ state: "found", where: "http://127.0.0.1:3845/mcp", detail: "answering, 2 tools", servers: [{ name: "figma", config: { url: "http://127.0.0.1:3845/mcp" } }] });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("finds this project's own entry in ~/.claude.json whatever its slashes and case", async () => {
    const root = fixture({});
    const project = join(root, "Work", "App");
    writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [project.replace(/\\/g, "/").toLowerCase()]: { mcpServers: { mine: { url: "http://x.test/mcp" } } } } }));
    const [claude] = await detectMcpServers({ home: root, platform: "linux", projectDir: project, ports: [] });
    expect(claude!.servers).toEqual([{ name: "mine", config: { url: "http://x.test/mcp" } }]);
  });

  it("says a port that does not answer is not found, without waiting on it", async () => {
    const root = fixture({});
    const hang: McpLister = (_server, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const sources = await detectMcpServers({ home: root, platform: "darwin", list: hang, timeoutMs: 50 });
    expect(sources.find((s) => s.source === "port")).toMatchObject({ state: "not found", detail: "not answering" });
    expect(sources.find((s) => s.source === "claude-desktop")!.where).toBe(join(root, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  });
});

describe("resolving and probing the configured servers", () => {
  const mcp = parseMcp({
    servers: {
      pw: { command: "npx", args: ["@playwright/mcp"], env: { TOKEN: { credential: "PW_TOKEN" } } },
      figma: { url: "http://127.0.0.1:3845/mcp" },
      off: { command: "x", enabled: false },
      gh: { url: "https://gh.example/mcp", headers: { Authorization: { credential: "GH_AUTH" } } },
    },
  });
  const secrets: Record<string, string> = { PW_TOKEN: "t0k" };

  it("hands over the servers that are on, each secret looked up; one whose secret is nowhere is left out and named", () => {
    const resolved = resolveMcpServers(mcp, (name) => secrets[name]);
    expect(resolved.servers).toEqual({
      pw: { command: "npx", args: ["@playwright/mcp"], env: { TOKEN: "t0k" } },
      figma: { url: "http://127.0.0.1:3845/mcp", headers: {} },
    });
    expect(resolved.missing).toEqual({ gh: ["GH_AUTH"] });
  });

  it("asks each server side by side: ready with its tools, failed with why, not started with why", async () => {
    const list: McpLister = async (server) => {
      if ("command" in server) return { transport: "stdio", tools: [{ name: "browser_click", description: "Click", annotations: { destructiveHint: false } }] };
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const report = await probeMcpServers(mcp, { lookup: (name) => secrets[name], describe: (name) => (secrets[name] !== undefined ? { source: "keychain" } : undefined), list, now: () => 7 });
    const by = Object.fromEntries(report.servers.map((s) => [s.name, s]));
    expect(by["pw"]).toMatchObject({ state: "ready", transport: "stdio", where: "npx @playwright/mcp", tools: [{ name: "browser_click" }] });
    expect(by["pw"]!.credentials).toEqual([{ field: "env", key: "TOKEN", credential: "PW_TOKEN", origin: { source: "keychain" } }]);
    expect(by["figma"]).toMatchObject({ state: "failed", reason: "nothing is listening", fix: "start the server, then Re-check" });
    expect(by["off"]).toMatchObject({ state: "not started", reason: "turned off" });
    expect(by["gh"]).toMatchObject({ state: "not started", reason: "GH_AUTH is not stored anywhere", credentials: [{ credential: "GH_AUTH" }] });
    expect(report.checkedAt).toBe(7);
  });

  it("gives up on a server at its deadline", async () => {
    const hang: McpLister = (_server, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const report = await probeMcpServers(parseMcp({ servers: { slow: { command: "x" } } }), { lookup: () => undefined, list: hang, timeoutMs: 30 });
    expect(report.servers[0]).toMatchObject({ state: "failed", reason: "no answer in 30 ms" });
  });
});

describe("what an agent is handed", () => {
  const servers = resolveMcpServers(
    parseMcp({ servers: { figma: { url: "http://127.0.0.1:3845/mcp" }, pw: { command: "npx", args: ["@playwright/mcp"], env: { K: "v" }, cwd: "C:/w" } } }),
    () => undefined,
  ).servers;

  it("every server that is on, less one every line of which refuses — nothing else of the permission set is written into it", () => {
    expect(handedMcpServers(servers)).toEqual({
      figma: { url: "http://127.0.0.1:3845/mcp", headers: {} },
      pw: { command: "npx", args: ["@playwright/mcp"], env: { K: "v" }, cwd: "C:/w" },
    });
    expect(Object.keys(handedMcpServers(servers, viewOf({ mcp__pw: "deny", other: "allow" })))).toEqual(["figma"]);
    // A server whose own line refuses but which names a tool it allows is still handed over.
    expect(Object.keys(handedMcpServers(servers, viewOf({ mcp__pw: "deny", mcp__pw__browser_click: "allow", other: "deny" })))).toEqual(["pw"]);
    // `ask` and a function are answered at the call now, on codex as on claude: the server is handed over.
    expect(Object.keys(handedMcpServers(servers, viewOf({ mcp__figma: "ask", mcp__pw: { function: "smart" }, other: "deny" })))).toEqual(["figma", "pw"]);
  });

  it("is read off each call, and is nothing at all with no server configured", () => {
    expect(mcpServersOfCall({}, () => undefined)).toBeUndefined();
    const ofCall = mcpServersOfCall(servers, (ctx) => ((ctx as { view?: McpView }).view));
    expect(Object.keys(ofCall!({ view: viewOf({ mcp__figma: "deny" }) } as never))).toEqual(["pw"]);
    expect(Object.keys(ofCall!({} as never))).toEqual(["figma", "pw"]);
  });

  it("codex's bridge starts a WSL project's stdio server in the distro, its variables carried by WSLENV", () => {
    expect(mcpServersIn(servers, "windows")).toBe(servers);
    const inWsl = mcpServersIn(servers, { wsl: "Ubuntu" });
    expect(inWsl["figma"]).toEqual(servers["figma"]);
    expect(inWsl["pw"]).toMatchObject({ command: "wsl.exe", args: ["-d", "Ubuntu", "--cd", expect.any(String), "--", "npx", "@playwright/mcp"], env: { K: "v", WSLENV: expect.stringMatching(/(^|:)K\/u$/) } });
    expect(inWsl["pw"]).not.toHaveProperty("cwd");
  });
});

describe("an MCP call, MEASURED through the real chain", () => {
  const servers = resolveMcpServers(parseMcp({ servers: { figma: { url: "http://127.0.0.1:3845/mcp" }, pw: { command: "npx" } } }), () => undefined).servers;
  const probes = ["mcp__figma__get_code", "mcp__figma__whoami", "mcp__figma__delete", "mcp__pw__browser_click", "mcp__linear__list"];
  const lines = { read_file: "allow", mcp__figma: "allow", mcp__figma__whoami: "ask", mcp__figma__delete: "deny", mcp__pw: "deny", other: "ask" };

  it("claude: each tool answers to its own line, then its server's, then `other` — and a refused server is not handed over", async () => {
    const handed = await handedToClaude(map(lines), { mcpServers: servers, mcpProbes: probes });
    expect(handed.mcp).toEqual({
      mcp__figma__get_code: "allow",
      mcp__figma__whoami: "ask",
      mcp__figma__delete: "deny",
      mcp__pw__browser_click: "deny",
      mcp__linear__list: "ask",
    });
    expect(handed.removed).toEqual(expect.arrayContaining(["mcp__figma__delete", "mcp__pw"]));
    expect(handed.mcpServers).toEqual(["figma"]);
  });

  it("claude: a server's line widens past a stricter `other`", async () => {
    const handed = await handedToClaude(map({ mcp__figma: "allow", other: "deny" }), { mcpServers: servers, mcpProbes: ["mcp__figma__get_code", "mcp__pw__x"] });
    expect(handed.mcp).toEqual({ "mcp__figma__get_code": "allow", "mcp__pw__x": "deny" });
  });

  it("claude: a state that declares no permission set is handed every server", async () => {
    const handed = await handedToClaude({}, { mcpServers: servers });
    expect(handed.mcpServers).toEqual(["figma", "pw"]);
  });

  it("codex: every mode answers at the bridge that proxies the server — the same answers claude's callback gives", async () => {
    for (const via of ["route", "function"] as const) {
      const handed = await handedToCodex(map(lines), { mcpServers: servers, mcpProbes: probes, via });
      expect(handed.mcp).toEqual({
        mcp__figma__get_code: "allow",
        mcp__figma__whoami: "ask",
        mcp__figma__delete: "deny",
        // Refused outright: the server is not handed over, so not started for nothing.
        mcp__pw__browser_click: "deny",
        mcp__linear__list: "deny",
      });
      // Pointed at the bridge under the server's own name, each tool it listed approved on codex's side:
      // the gate at the bridge is the one that decides.
      expect(handed.mcpServers).toEqual([
        'mcp_servers.figma={url="<url>/figma",required=true,startup_timeout_sec=30,tool_timeout_sec=86400,tools={"get_code"={approval_mode="approve"},"whoami"={approval_mode="approve"},"delete"={approval_mode="approve"}}}',
      ]);
    }
  });

  it("codex: a tool whose line is a FUNCTION is decided by it at the bridge", async () => {
    const handed = await handedToCodex(map({ mcp__figma: { function: "judge" }, other: "deny" }), {
      mcpServers: servers,
      mcpProbes: ["mcp__figma__get_code"],
      functions: async () => "allow",
    });
    expect(handed.mcp).toEqual({ mcp__figma__get_code: "allow" });
  });
});

describe("judging an MCP call by name", () => {
  const permissionSet = setOf({ mcp__figma: "ask", mcp__figma__get_code: "allow", mcp__figma__delete: { function: "smart" }, other: "deny" });

  it("is one part, its widths the tool and its server", () => {
    const decision = decideMcpCall("mcp__figma__whoami", permissionSet, "$/permission-sets/chat/x")!;
    expect(decision.action).toBe("require_approval");
    expect(decision.parts).toMatchObject({ line: "mcp__figma__whoami", verdict: "asks", permissionSet: "$/permission-sets/chat/x" });
    expect(decision.parts.parts[0]).toMatchObject({ kind: "mcp", subject: "mcp__figma__whoami", widths: ["mcp__figma__whoami", "mcp__figma"], decidedBy: { source: "permissionSet", entry: "mcp__figma" } });
    expect(decideMcpCall("mcp__figma__get_code", permissionSet, "inline")!.action).toBe("allow");
    expect(decideMcpCall("mcp__figma__delete", permissionSet, "inline")!.parts.parts[0]).toMatchObject({ verdict: "function", decidedBy: { function: "smart" } });
    expect(decideMcpCall("mcp__other__x", permissionSet, "inline")!.action).toBe("deny");
    expect(decideMcpCall("read_file", permissionSet, "inline")).toBeUndefined();
  });

  it("settles an asking call by what was remembered for this run — at the tool, or the whole server", () => {
    const grants = new CommandGrants();
    grants.rememberParts(decideMcpCall("mcp__figma__whoami", permissionSet, "inline")!.parts, "allow", ["mcp__figma"]);
    expect(decideMcpCall("mcp__figma__list", permissionSet, "inline", grants)!.parts.parts[0]).toMatchObject({ verdict: "allowed", decidedBy: { source: "remembered", entry: "mcp__figma" } });
    // Never a call its line refuses, never one a function decides.
    expect(decideMcpCall("mcp__figma__delete", permissionSet, "inline", grants)!.parts.parts[0]!.verdict).toBe("function");
  });

  it("the narrowing keeps the decision against the call's input, by the tool the gate was asked about by its server", async () => {
    const lowered = map({ mcp__figma: "ask", other: "allow" });
    const policy = compilePolicy({});
    const input = {};
    noteMcpCall(input, "mcp__figma__whoami");
    expect(policy.scopeOf?.({ name: "mcp__figma" }, input, lowered.permissions)).toBe("ask");
    expect(commandDecisionOf(input)!.parts.line).toBe("mcp__figma__whoami");

    // The approval names the tool, draws it as its one part, and "add to the permission set" is possible.
    const hub = new ApprovalHub({ onRequest: () => undefined });
    void hub.approver({ taskId: "t1" })({ tool: "mcp__figma", input, sessionId: "s" });
    await Promise.resolve();
    await Promise.resolve();
    const [request] = hub.list();
    expect(request).toMatchObject({ tool: "mcp__figma__whoami", command: "mcp__figma__whoami", parts: { line: "mcp__figma__whoami", permissionSet: "$/permission-sets/chat/mcp" } });
    hub.denyAll();
  });
});

describe("the tools probe against a real server", () => {
  it("starts a stdio server over the MCP SDK, lists its tools with their annotations, and closes it", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const at = (path: string): string => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
    const root = fixture({
      "server.cjs": [
        `const { Server } = require(${at("server/index.js")});`,
        `const { StdioServerTransport } = require(${at("server/stdio.js")});`,
        `const { ListToolsRequestSchema } = require(${at("types.js")});`,
        `const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });`,
        `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [`,
        `  { name: "get_code", description: "Read the code", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },`,
        `  { name: "delete_file", description: "Delete a file", inputSchema: { type: "object" }, annotations: { destructiveHint: true, title: "Delete" } },`,
        `] }));`,
        `server.connect(new StdioServerTransport());`,
      ].join("\n"),
    });
    const report = await probeMcpServers(parseMcp({ servers: { fixture: { command: process.execPath, args: [join(root, "server.cjs")], env: { PROBE: { credential: "PROBE_VALUE" } } } } }), {
      lookup: (name) => (name === "PROBE_VALUE" ? "1" : undefined),
    });
    expect(report.servers[0]).toMatchObject({
      name: "fixture",
      state: "ready",
      transport: "stdio",
      tools: [
        { name: "get_code", description: "Read the code", annotations: { readOnlyHint: true } },
        { name: "delete_file", description: "Delete a file", annotations: { destructiveHint: true, title: "Delete" } },
      ],
    });
  });
});
