/**
 * Delegated agent runtimes (DESIGN §8, §8.1) and capability gating (§8.2).
 *
 * The adapters are driven through a fake `AgentQuery`, which is the seam upstream
 * exposes for exactly this: the registration, the workspace/policy/approve
 * plumbing, and the gating are all exercised with no SDK, no `claude` binary, and
 * no network.
 */
import { describe, expect, it } from "vitest";
import type { AgentQueryOptions, AgentStreamMessage } from "@declarative-ai/agents-api";
import type { ExecServices, RuntimeCapabilities } from "@declarative-ai/exec";
import { AGENT_CLI, AGENT_CODEX, AGENT_SDK, agentSpawn, gateCapabilities, registerAgentRuntimes } from "../src/agents";
import { resolveInvocation } from "../src/exec";
import { newRegistry } from "../src/wiring";

/**
 * A query that records what it was asked and replies with fixed text. The adapter
 * only reads the terminal `result` message, whose payload lives under `result`.
 */
function fakeQuery(reply = "done", record: AgentQueryOptions[] = []) {
  const query = (opts: AgentQueryOptions): AsyncIterable<AgentStreamMessage> => {
    record.push(opts);
    return (async function* () {
      yield { type: "assistant" } as AgentStreamMessage;
      yield { type: "result", result: { text: reply, costUsd: 0.02 } } as AgentStreamMessage;
    })();
  };
  return { query, record };
}

const ctx = (over: Partial<ExecServices> = {}): ExecServices => ({ ...over }) as ExecServices;

describe("registerAgentRuntimes", () => {
  it("registers all three adapters as runtime entries", () => {
    const registry = registerAgentRuntimes(newRegistry(), { query: fakeQuery().query });
    for (const name of [AGENT_SDK, AGENT_CLI, AGENT_CODEX]) {
      const entry = registry.functions.get(name);
      expect(entry, name).toBeDefined();
      expect(entry!.kind).toBe("runtime");
    }
  });

  it("registers codex with the capabilities that let it run under a real policy", () => {
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["codex"] });
    const caps = (registry.functions.get(AGENT_CODEX) as { capabilities: RuntimeCapabilities }).capabilities;
    // NOT `generic-cli`: that declares `none` and §8.2 refuses it under any policy that can ask a
    // human. Codex has a real up-front channel — its sandbox — so `config` is both true and usable.
    expect(caps.policyEnforcement).toBe("config");
    expect(caps.sessionResume).toBe(true);
    expect(caps.sessionFork).toBe(false);
  });

  it("registers only what was asked for", () => {
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: fakeQuery().query });
    expect(registry.functions.has(AGENT_SDK)).toBe(true);
    expect(registry.functions.has(AGENT_CLI)).toBe(false);
    expect(registry.functions.has(AGENT_CODEX)).toBe(false);
  });

  it("passes the codex binary and sandbox from project config down to the argv", async () => {
    // Driven through a fake PROCESS rather than a fake query, so the real argv building is what runs
    // — that is the half of a CLI adapter worth testing.
    const spawned: string[][] = [];
    const registry = registerAgentRuntimes(newRegistry(), {
      adapters: ["codex"],
      codexCommand: "/opt/codex",
      codexSandbox: "read-only",
      spawn: (argv) => {
        spawned.push(argv);
        return {
          lines: (async function* () {
            yield JSON.stringify({ type: "item.completed", item: { item_type: "assistant_message", text: "ok" } });
          })(),
          kill: () => {},
          exit: Promise.resolve(0),
        };
      },
    });
    const entry = registry.functions.get(AGENT_CODEX)! as { impl: (i: unknown, c: unknown) => Promise<{ value?: unknown }> };
    const result = await entry.impl({ prompt: "review", config: {} }, ctx());
    expect(result.value).toBe("ok");
    expect(spawned[0]![0]).toBe("/opt/codex");
    // As a config override: `codex exec resume` accepts no `--sandbox` flag, so one argv shape has
    // to serve both forms.
    expect(spawned[0]!).toContain('sandbox_mode="read-only"');
  });
});

describe("agentSpawn — an agent is a child process like any other (DESIGN §9.1)", () => {
  /**
   * REGRESSION. The WSL invocation used to be expressed on the adapter as
   * `command: "wsl.exe"` + `args: ["-d", distro, "--", "claude"]`. An adapter builds
   * `[command, ...its own flags, ...args]`, so `wsl.exe` was handed the AGENT's flags before its own
   * arguments — and `--cd` was never passed, so the agent ran in whatever directory the app was
   * started from. Mapping the finished argv through the one Exec mapper is what fixes it.
   */
  it("maps a WSL project's agent command through the one Exec mapper", () => {
    // `agentSpawn` launches a real process, so the mapping it delegates to is what is assertable —
    // and the mapping is where the bug was.
    const { file, argv, cwd } = resolveInvocation("codex", ["exec", "--json"], {
      execEnv: { wsl: "Ubuntu-22.04" },
      cwd: "C:\\repo\\work",
    });
    expect(file).toBe("wsl.exe");
    // The distro's own options come FIRST; the agent's command follows the separator.
    expect(argv.slice(0, 2)).toEqual(["-d", "Ubuntu-22.04"]);
    expect(argv).toContain("--cd");
    expect(argv.slice(-3)).toEqual(["--", "codex", "exec", "--json"].slice(1));
    // wsl.exe runs on Windows and gets no Windows cwd of its own.
    expect(cwd).toBeUndefined();
  });

  it("writes a prompt to the agent's stdin and streams its stdout back", async () => {
    // The codex adapter passes its prompt on stdin — a replayed conversation is far too big for argv
    // on Windows — so a spawn that ignored stdin would leave the agent waiting with no instruction.
    const spawn = agentSpawn();
    const child = spawn([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], { stdin: "line one\nline two\n" });
    const lines: string[] = [];
    for await (const line of child.lines) lines.push(line);
    expect(await child.exit).toBe(0);
    expect(lines).toEqual(["line one", "line two"]);
  });

  it("runs an agent, passing the workspace through as its cwd", async () => {
    const { query, record } = fakeQuery("all done");
    const registry = registerAgentRuntimes(newRegistry(), { query });
    const entry = registry.functions.get(AGENT_SDK)!;

    const result = await (entry as { impl: (i: unknown, c: unknown) => Promise<{ value?: unknown; metrics?: { costUsd?: number } }> }).impl(
      { prompt: "summarize the repo", config: {} },
      ctx({ workspace: { root: "C:\\repo" } }),
    );

    expect(result.value).toBe("all done");
    // The agent bills inside its own loop, and that spend reaches the metrics.
    expect(result.metrics?.costUsd).toBeCloseTo(0.02);
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ prompt: "summarize the repo", cwd: "C:\\repo" });
  });

  it("reports an agent failure as data, not a rejection", async () => {
    const failing = (): AsyncIterable<AgentStreamMessage> =>
      (async function* () {
        yield { type: "assistant" } as AgentStreamMessage;
        throw new Error("agent exploded");
      })();
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: failing });
    const entry = registry.functions.get(AGENT_SDK)!;
    const result = await (entry as { impl: (i: unknown, c: unknown) => Promise<{ error?: { reason: string } }> }).impl(
      { prompt: "go", config: {} },
      ctx(),
    );
    // §4.2: errors resolve as classified data so the workflow can branch on them.
    expect(result.error?.reason).toMatch(/agent exploded/);
  });
});

describe("gateCapabilities (DESIGN §8.2)", () => {
  const states = {
    "wf/agent": { operation: { kind: "function", functionRef: AGENT_SDK } },
    "wf/gate": { operation: { kind: "function", functionRef: "choose_option" } },
    "wf/prompt": { operation: { kind: "prompt" } },
  };

  it("passes when the runtime can enforce the policy", () => {
    const registry = registerAgentRuntimes(newRegistry(), { query: fakeQuery().query });
    expect(gateCapabilities(registry, states, { policyNeedsApproval: true })).toEqual([]);
  });

  it("blocks a policy that can ask against a runtime that enforces nothing", () => {
    const registry = registerAgentRuntimes(newRegistry(), {
      adapters: ["sdk"],
      query: fakeQuery().query,
      // A variant that admits it enforces no policy.
      sdk: {
        capabilities: {
          interactive: false,
          readOnly: false,
          memoizable: false,
          structuredOutput: false,
          mutatesWorkspace: true,
          policyEnforcement: "none",
          sessionResume: false,
          streaming: false,
          runtime: "node",
        },
      },
    });
    const issues = gateCapabilities(registry, states, { policyNeedsApproval: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stateId: "wf/agent", functionRef: AGENT_SDK });
    // The point of §8.2: refuse loudly instead of degrading silently.
    expect(issues[0]!.message).toMatch(/refusing rather than running it unguarded/);
  });

  it("reads the AUTHORED `function` field as well as the loaded `functionRef`", () => {
    // Regression: callers pass `bundle.source` (it is what a snapshot stores), where
    // the field is spelled `function`. Reading only `functionRef` made this gate a
    // silent no-op on every real call site — worse than no check, because a gate
    // that never fires reads as one that passed.
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: fakeQuery().query });
    const authored = { "wf/agent": { operation: { kind: "function", function: AGENT_SDK } } };
    const issues = gateCapabilities(registry, authored, { policyNeedsApproval: true, unattended: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stateId: "wf/agent", functionRef: AGENT_SDK });
  });

  it("warns when an escalating runtime has no one to ask", () => {
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: fakeQuery().query });
    const issues = gateCapabilities(registry, states, { policyNeedsApproval: true, unattended: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/no interactive surface/);
  });

  it("ignores host functions, prompt states and unregistered refs", () => {
    const registry = registerAgentRuntimes(newRegistry(), { query: fakeQuery().query });
    const other = {
      "wf/gate": { operation: { kind: "function", functionRef: "choose_option" } },
      "wf/prompt": { operation: { kind: "prompt" } },
      "wf/none": {},
    };
    expect(gateCapabilities(registry, other, { policyNeedsApproval: true })).toEqual([]);
  });

  it("says nothing when the policy cannot escalate", () => {
    // With no approval-capable policy there is nothing for a runtime to enforce.
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: fakeQuery().query });
    expect(gateCapabilities(registry, states, {})).toEqual([]);
  });
});

/**
 * The optional peer this repo is not optional about.
 *
 * `@declarative-ai/agents-cli` declares `@modelcontextprotocol/sdk` as an OPTIONAL peer, because an
 * agent run with no approver and no host tools needs no bridge. JaiRA is never that caller: its
 * workflows declare tools (the sync gives its states `read_file`), and a declared tool reaches a CLI
 * agent only through an MCP server the bridge stands up. Missing, the bridge refuses before spawning
 * and every such state fails — which is how "propose workflow changes" died on a machine that had
 * `claude` installed and working.
 *
 * Checked as an import rather than as a line in `package.json`, because what breaks is resolution:
 * the bridge reaches these three subpaths, and a version that moved one of them would install
 * cleanly and fail at the first tool call.
 */
describe("the CLI agent's permission/tool bridge", () => {
  it("can load the MCP SDK entry points it imports", async () => {
    const [server, types, http] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/types.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    ]);
    expect(server.Server).toBeTypeOf("function");
    expect(types.CallToolRequestSchema).toBeDefined();
    expect(http.StreamableHTTPServerTransport).toBeTypeOf("function");
  });
});

/**
 * `agentSpawn`'s stderr — piped now, and therefore drained.
 *
 * It was `"ignore"`d, so an agent that failed printed why into `/dev/null` and JaiRA reported an exit
 * code. Piping it is the fix; draining it is the PRICE. An unread pipe fills at ~64 KB and the child
 * blocks forever on write — stdout stops, `exit` never settles — which is exactly why the stream was
 * ignored to begin with, and exactly the regression this guards.
 */
describe("agentSpawn — the child's diagnostics", () => {
  const node = process.execPath;

  it("forwards stderr to the observer", async () => {
    const seen: string[] = [];
    const spawn = agentSpawn({

      observer: { onSpawn: () => 1, onExit: () => undefined, onOutput: (_t, e) => seen.push(`${e.stream}:${e.chunk}`) },
    });

    const proc = spawn([node, "-e", "process.stderr.write('boom');console.log('{}')"], {});
    for await (const _line of proc.lines) void _line;
    await proc.exit;

    expect(seen.join("")).toContain("stderr:boom");
  });

  it("still exits when the child writes more to stderr than a pipe holds", async () => {
    // 512 KB, eight times the blocking buffer. With no drain this hangs; the test fails by TIMING OUT
    // rather than by asserting, which is the honest shape for a deadlock.
    const script = "process.stderr.write('x'.repeat(512*1024));console.log(JSON.stringify({ok:1}))";
    const spawn = agentSpawn({});

    const proc = spawn([node, "-e", script], {});
    const lines: string[] = [];
    for await (const line of proc.lines) lines.push(line);

    // stdout survived, which is the half a blocked child loses.
    expect(await proc.exit).toBe(0);
    expect(lines.join("")).toContain('{"ok":1}');
  }, 30_000);

  it("drains even with NO observer attached, because the deadlock does not care why nobody read", async () => {
    const spawn = agentSpawn({});
    const proc = spawn([node, "-e", "process.stderr.write('y'.repeat(256*1024));console.log('{}')"], {});
    for await (const _line of proc.lines) void _line;
    expect(await proc.exit).toBe(0);
  }, 30_000);
});
