/**
 * A generic CLI held to a permission set, end to end, with a real process standing in for the binary.
 *
 * Everything but the agent is real: the engine resolves the state's lowered map, JaiRA's route wraps the
 * generic executor (`withAgentPermissionSet`, the bridged declaration), the generic query writes the
 * config file from the registration's `mcp` template and starts the binary through `NodeExec`, and the
 * bridge is the production one (`createMcpBridgeHost`, one listener on a worker thread). The stand-in is
 * a Node script doing what opencode does with that config: it reads the file its variable names, connects
 * to the server listed there as a streamable-HTTP MCP client, lists the tools, calls them, and prints its
 * answer.
 *
 * What is proven: the registration's placeholders reach a real process; a held tool is served and the
 * rest are not there to call; every call is put to the gate at the bridge before it runs (an `allow`
 * runs, an `ask` goes to the approver); and the file holding the bridge's address is gone after the run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Tool } from "@declarative-ai/exec";
import type { Approver } from "@declarative-ai/permissions";
import { loadBundle } from "@declarative-ai/hw";
import { lowerPermissionSet, parsePermissionSet, type JairaGenericCliAgent } from "@jaira/shared";
import { createMcpBridgeHost } from "../src/agents";
import { agentPromptRoutes } from "../src/modelRoutes";
import { compilePolicy } from "../src/policy";
import { JAIRA_TOOL_NAMES } from "../src/tools";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

vi.setConfig({ testTimeout: 60_000 });

const host = createMcpBridgeHost();
const dir = mkdtempSync(join(tmpdir(), "jaira-generic-bridge-"));
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);

/** The stand-in binary: read the config, connect, list, call, answer — or say what went wrong. */
const STAND_IN = join(dir, "stand-in.cjs");
writeFileSync(
  STAND_IN,
  `const { readFileSync } = require("node:fs");
const { Client } = require(process.env.SDK_CLIENT);
const { StreamableHTTPClientTransport } = require(process.env.SDK_HTTP);
(async () => {
  const configPath = process.env.STAND_IN_CONFIG;
  const url = JSON.parse(readFileSync(configPath, "utf8")).mcp.dai.url;
  const client = new Client({ name: "stand-in", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const results = [];
  for (const call of JSON.parse(process.env.STAND_IN_CALLS)) {
    const result = await client.callTool(call);
    results.push({ name: call.name, text: (result.content && result.content[0] && result.content[0].text) || "", isError: result.isError === true });
  }
  await client.close();
  const report = JSON.stringify({ configPath, prompt: process.argv.slice(2), listed, results });
  require("node:fs").appendFileSync(process.env.STAND_IN_REPORT, report + "\\n");
  process.stdout.write(report);
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error));
  process.exit(3);
});
`,
);

interface StandInReport {
  configPath: string;
  prompt: string[];
  listed: string[];
  results: Array<{ name: string; text: string; isError: boolean }>;
}

function registry(ran: string[]) {
  const reg = newRegistry();
  for (const name of JAIRA_TOOL_NAMES) {
    const tool: Tool = {
      description: name,
      inputSchema: { type: "object" },
      readOnly: name === "read_file",
      run: async (input) => {
        ran.push(`${name} ${JSON.stringify(input)}`);
        return `${name} done`;
      },
    };
    reg.tools.set(name, tool);
  }
  return reg;
}

let runs = 0;

async function runHeld(answer: "allow" | "deny") {
  const reportFile = join(dir, `report-${(runs += 1)}.jsonl`);
  const agent: JairaGenericCliAgent = {
    name: "stand-in",
    command: process.execPath,
    args: [STAND_IN],
    env: {
      SDK_CLIENT: require.resolve("@modelcontextprotocol/sdk/client/index.js"),
      SDK_HTTP: require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      STAND_IN_REPORT: reportFile,
      STAND_IN_CALLS: JSON.stringify([
        { name: "read_file", arguments: { path: "README.md" } },
        { name: "write_file", arguments: { path: "notes.md", content: "hi" } },
        { name: "shell", arguments: { command: "rm -rf ." } },
      ]),
    },
    mcp: {
      env: { STAND_IN_CONFIG: "{mcpConfig}" },
      config: { mcp: { dai: { type: "remote", url: "{mcpUrl}" } } },
      configName: "opencode.json",
      builtinsOff: true,
    },
  };
  const lowered = lowerPermissionSet(parsePermissionSet({ read_file: "allow", write_file: "ask", other: "deny" }).permissionSet);
  const states = {
    notes: {
      label: "notes",
      operation: { kind: "prompt", prompt: "write the notes", model: "stand-in/default" },
      environment: { tools: lowered.tools, permissions: lowered.permissions },
    },
  };
  const ran: string[] = [];
  const asked: string[] = [];
  const approve: Approver = (request) => {
    asked.push(request.tool);
    return { decision: answer, scope: "once" };
  };
  const result = await executeWorkflow({
    bundle: loadBundle(states, "notes"),
    inputs: {},
    registry: registry(ran),
    prompt: buildPromptExecutor({ routes: agentPromptRoutes({ genericCli: [agent] }, { startBridge: host.start }), tree: { kind: "agent", agent: "stand-in" } }),
    policy: compilePolicy({}),
    approve,
  });
  if (!existsSync(reportFile)) throw new Error(`the stand-in did not answer: ${JSON.stringify(result)}`);
  const reports = readFileSync(reportFile, "utf8").trim().split("\n");
  // One run of the binary per state: a second would mean the run was retried around the bridge.
  expect(reports).toHaveLength(1);
  return { result, ran, asked, report: JSON.parse(reports[0]!) as StandInReport };
}

describe("a generic CLI with its own tools off is served over MCP and gated at the bridge", () => {
  it("an allowed call runs, an asked call runs on a yes, and what the map does not hold is not there", async () => {
    const { ran, asked, report } = await runHeld("allow");
    expect(report.prompt).toEqual(["--", "write the notes"]);
    expect(report.listed).toEqual(["read_file", "write_file"]);
    expect(asked).toEqual(["write_file"]);
    expect(ran).toEqual(['read_file {"path":"README.md"}', 'write_file {"path":"notes.md","content":"hi"}']);
    expect(report.results.map((call) => [call.name, call.isError])).toEqual([
      ["read_file", false],
      ["write_file", false],
      ["shell", true],
    ]);
    // The file that held the bridge's address went with the run.
    expect(report.configPath).toMatch(/opencode\.json$/);
    expect(existsSync(report.configPath)).toBe(false);
  });

  it("a person's no refuses the call at the bridge — the tool never runs, and the agent reads why", async () => {
    const { ran, asked, report } = await runHeld("deny");
    expect(asked).toEqual(["write_file"]);
    expect(ran).toEqual(['read_file {"path":"README.md"}']);
    const refused = report.results.find((call) => call.name === "write_file")!;
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not approved/);
  });
});
