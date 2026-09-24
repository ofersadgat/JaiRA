/**
 * A codex run of a state HELD TO A PERMISSION_SET, end to end, with a scripted double for the `codex` binary.
 *
 * Everything but the binary is real: the engine resolves the state's lowered map, JaiRA's route wraps
 * the codex executor (`withAgentPermissionSet`), upstream's codex transport builds its argv and stands up the
 * bridge — the production one, `createMcpBridgeHost`, one listener on a worker thread — and the gate is
 * the one the engine builds over the state's block. The double does what `codex exec` 0.147.0 was
 * measured doing with that argv: it reads the `-c mcp_servers.dai={…}` override, connects to the URL as
 * a streamable-HTTP MCP client (initialize, then `tools/list`, before any model turn — the server is
 * `required`), calls tools with `tools/call`, and answers with the last agent message as JSONL.
 *
 * What is proven: a held tool reaches codex over MCP, every call is put to the gate at the bridge
 * before it runs (an `allow` runs, an `ask` goes to the approver and runs only on a yes), and a tool the
 * map does not hold is not there to call.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@declarative-ai/exec";
import type { Approver } from "@declarative-ai/permissions";
import { loadBundle } from "@declarative-ai/hw";
import type { AgentProcess, SpawnProcess } from "@declarative-ai/agents-cli";
import { lowerPermissionSet, parsePermissionSet } from "@jaira/shared";
import { AGENT_CODEX, createMcpBridgeHost, registerAgentRuntimes } from "../src/agents";
import { agentPromptRoutes } from "../src/modelRoutes";
import { compilePolicy } from "../src/policy";
import { grantAlwaysGrantedTools, JAIRA_TOOL_NAMES } from "../src/tools";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

vi.setConfig({ testTimeout: 60_000 });

const host = createMcpBridgeHost();
afterAll(() => host.close());

/** The `url` codex is pointed at, read off its argv the way codex parses `-c mcp_servers.dai={…}`. */
function bridgeUrlOf(argv: readonly string[]): string {
  const override = argv.find((arg) => arg.startsWith("mcp_servers.dai="));
  const url = override === undefined ? undefined : /url="([^"]+)"/.exec(override)?.[1];
  if (url === undefined) throw new Error(`codex was not pointed at a bridge: ${argv.join(" ")}`);
  return url;
}

/** A scripted `codex exec`: connect, list, call each of `calls` in turn, answer with what came back. */
function codexDouble(calls: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>) {
  const seen: { argv?: string[]; listed?: string[]; results: Array<{ name: string; text: string; isError: boolean }> } = { results: [] };
  const spawn: SpawnProcess = (argv) => {
    seen.argv = [...argv];
    let exit: (code: number) => void = () => undefined;
    const proc: AgentProcess = {
      lines: (async function* () {
        const client = new Client({ name: "codex-double", version: "0.147.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrlOf(argv))));
        seen.listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
        yield JSON.stringify({ type: "thread.started", thread_id: "th-double" });
        for (const call of calls) {
          const result = (await client.callTool(call)) as { content?: Array<{ text?: string }>; isError?: boolean };
          seen.results.push({ name: call.name, text: result.content?.[0]?.text ?? "", isError: result.isError === true });
        }
        await client.close();
        const report = seen.results.map((result) => `${result.name}=${result.text}`).join("; ");
        yield JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify({ report }) } });
        exit(0);
      })(),
      kill: () => exit(143),
      exit: new Promise<number>((resolve) => {
        exit = resolve;
      }),
    };
    return proc;
  };
  return { spawn, seen };
}

function registry(ran: string[]) {
  const reg = newRegistry();
  for (const name of JAIRA_TOOL_NAMES) {
    const tool: Tool = {
      description: name,
      inputSchema: { type: "object" },
      readOnly: false,
      run: async (input) => {
        ran.push(`${name} ${JSON.stringify(input)}`);
        return `${name} done`;
      },
    };
    reg.tools.set(name, tool);
  }
  return reg;
}

async function runHeld(via: "route" | "function", answer: "allow" | "deny") {
  const lowered = lowerPermissionSet(parsePermissionSet({ read_file: "allow", write_file: "ask", other: "deny" }).permissionSet);
  const operation =
    via === "route"
      ? { kind: "prompt", prompt: "write the notes", model: `${AGENT_CODEX}/default` }
      : { kind: "function", function: AGENT_CODEX, args: { prompt: "write the notes" } };
  const states: Record<string, unknown> = {
    notes: {
      label: "notes",
      outputs: via === "route" ? { report: { kind: "text", schema: { type: "string" } } } : {},
      operation,
      environment: { tools: lowered.tools, permissions: lowered.permissions },
    },
  };
  grantAlwaysGrantedTools(states);
  const ran: string[] = [];
  const asked: string[] = [];
  const approve: Approver = (request) => {
    asked.push(request.tool);
    return { decision: answer, scope: "once" };
  };
  const { spawn, seen } = codexDouble([
    { name: "read_file", arguments: { path: "README.md" } },
    { name: "write_file", arguments: { path: "notes.md", content: "hi" } },
    { name: "bash", arguments: { command: "rm -rf ." } },
  ]);
  const reg = registry(ran);
  if (via === "function") registerAgentRuntimes(reg, { spawn, startBridge: host.start, adapters: ["codex"] });
  const result = await executeWorkflow({
    bundle: loadBundle(states, "notes"),
    inputs: {},
    registry: reg,
    prompt: buildPromptExecutor({ routes: agentPromptRoutes({}, { spawn, startBridge: host.start }), tree: { kind: "agent", agent: AGENT_CODEX } }),
    policy: compilePolicy({}),
    approve,
  });
  return { result, ran, asked, seen };
}

describe("codex runs a state held to a permission set: served over MCP, gated at the bridge", () => {
  it.each(["route", "function"] as const)("%s: an allowed call runs, an asked call runs on a yes, and what the map does not hold is not there", async (via) => {
    const { result, ran, asked, seen } = await runHeld(via, "allow");
    expect((result as { failure?: unknown }).failure).toBeUndefined();
    // Codex was pointed at the bridge, approved our tools on its side, and required the handshake.
    const override = seen.argv!.find((arg) => arg.startsWith("mcp_servers.dai="))!;
    expect(override).toContain("required=true");
    expect(override).toContain('"write_file"={approval_mode="approve"}');
    // What codex listed is the map's grant — no shell — and the sandbox is shut, ours doing the writing.
    expect(seen.listed).toEqual(via === "route" ? ["read_file", "show_artifact", "write_file"] : ["read_file", "write_file"]);
    expect(seen.argv).toContain('sandbox_mode="read-only"');
    // `read_file: allow` ran unasked; `write_file: ask` went to the approver and ran on the yes.
    expect(asked).toEqual(["write_file"]);
    expect(ran).toEqual(['read_file {"path":"README.md"}', 'write_file {"path":"notes.md","content":"hi"}']);
    expect(seen.results.map((call) => [call.name, call.isError])).toEqual([
      ["read_file", false],
      ["write_file", false],
      ["bash", true],
    ]);
  });

  it.each(["route", "function"] as const)("%s: a person's no refuses the call at the bridge — the tool never runs, and codex reads why", async (via) => {
    const { ran, asked, seen } = await runHeld(via, "deny");
    expect(asked).toEqual(["write_file"]);
    expect(ran).toEqual(['read_file {"path":"README.md"}']);
    const refused = seen.results.find((call) => call.name === "write_file")!;
    expect(JSON.parse(refused.text)).toMatchObject({ denied: true, tool: "write_file" });
  });
});
