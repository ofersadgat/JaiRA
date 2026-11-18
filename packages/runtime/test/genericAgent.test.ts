/**
 * The `generic-cli` agent runtime (DESIGN §8.1, §16).
 *
 * Two things are worth pinning here. The mechanical one: how a prompt reaches a
 * binary that knows nothing about Claude's protocol. The important one: that this
 * runtime declares `policyEnforcement: "none"`, so §8.2's gate refuses it under a
 * policy that can escalate — DESIGN §16's "generic-cli runners start policy-weak by
 * design" made enforceable rather than aspirational.
 */
import { describe, expect, it } from "vitest";
import type { JairaGenericCliAgent } from "@jaira/shared";
import type { Exec, ExecOptions, ExecResult } from "../src/exec";
import { gateCapabilities } from "../src/agents";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { InjectedTool } from "@declarative-ai/agents-api";
import type { McpBridgeSpec, StartMcpBridge } from "@declarative-ai/agents-cli";
import { lowerStatePermissionSets } from "@jaira/shared";
import {
  AGENT_GENERIC_CLI,
  GENERIC_BRIDGED_CAPS,
  GENERIC_CLI_CAPS,
  createGenericCliQuery,
  genericCliRefusal,
  registerGenericAgents,
} from "../src/genericAgent";
import { loadBundle } from "@declarative-ai/hw";
import { agentPromptRoutes } from "../src/modelRoutes";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

interface Call {
  command: string;
  args: string[];
  options: ExecOptions;
}

/** An Exec that records the invocation and returns a scripted result. */
function fakeExec(result: Partial<ExecResult> = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = {
    run: async (command, args, options = {}) => {
      calls.push({ command, args: [...args], options });
      return {
        code: 0,
        signal: null,
        stdout: "the agent's answer\n",
        stderr: "",
        command: `${command} ${args.join(" ")}`,
        timedOut: false,
        aborted: false,
        ...result,
      };
    },
  };
  return { exec, calls };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const spec = (extra: Partial<JairaGenericCliAgent> = {}): JairaGenericCliAgent => ({ command: "opencode", ...extra });

describe("createGenericCliQuery", () => {
  it("appends the prompt after `--` when no placeholder is given", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ args: ["run", "--quiet"] }), { exec });

    const messages = await collect(query({ prompt: "fix the bug", cwd: "C:\\work" }));

    // `--` first: an instruction starting with `-` must not be read as a flag.
    expect(calls[0]!.args).toEqual(["run", "--quiet", "--", "fix the bug"]);
    expect(messages).toEqual([{ type: "result", result: { text: "the agent's answer" } }]);
  });

  it("substitutes a {prompt} placeholder where the CLI wants it", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ args: ["--task", "{prompt}", "--yes"] }), { exec });
    await collect(query({ prompt: "refactor" }));
    expect(calls[0]!.args).toEqual(["--task", "refactor", "--yes"]);
  });

  it("pipes the prompt on stdin when asked to", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ args: ["-"], prompt: "stdin" }), { exec });
    await collect(query({ prompt: "a long instruction" }));
    expect(calls[0]!.args).toEqual(["-"]);
    expect(calls[0]!.options.stdin).toBe("a long instruction");
  });

  it("runs in the task's workspace, translated for a WSL project", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec(), { exec, execEnv: { wsl: "Ubuntu" } });
    await collect(query({ prompt: "go", cwd: "C:\\work\\repo" }));
    // The agent runs inside the distro, so it needs the distro's view of the path.
    expect(calls[0]!.options.cwd).toBe("/mnt/c/work/repo");
    expect(calls[0]!.options.execEnv).toEqual({ wsl: "Ubuntu" });
  });

  it("forwards the abort signal and reports cancellation", async () => {
    const { exec, calls } = fakeExec({ aborted: true, code: null });
    const controller = new AbortController();
    const query = createGenericCliQuery(spec(), { exec });
    const messages = await collect(query({ prompt: "go", abortSignal: controller.signal }));
    expect(calls[0]!.options.abortSignal).toBe(controller.signal);
    expect(messages).toEqual([{ type: "other", error: "'opencode' was canceled" }]);
  });

  it("reports a non-zero exit with the binary's own complaint", async () => {
    const { exec } = fakeExec({ code: 2, stdout: "", stderr: "no such flag: --quiet" });
    const messages = await collect(createGenericCliQuery(spec(), { exec })({ prompt: "go" }));
    expect(messages).toEqual([{ type: "other", error: "'opencode' exited 2: no such flag: --quiet" }]);
  });

  it("reports a timeout distinctly from a failure", async () => {
    const { exec } = fakeExec({ timedOut: true, code: null });
    const messages = await collect(createGenericCliQuery(spec(), { exec, timeoutMs: 5 })({ prompt: "go" }));
    expect(messages).toEqual([{ type: "other", error: "'opencode' timed out" }]);
  });

  it("reports a missing binary as a start failure, not a crash", async () => {
    const exec: Exec = {
      run: async () => {
        throw new Error("failed to run 'opencode': spawn ENOENT");
      },
    };
    const messages = await collect(createGenericCliQuery(spec(), { exec })({ prompt: "go" }));
    expect(messages).toEqual([
      { type: "other", error: "'opencode' could not be started: failed to run 'opencode': spawn ENOENT" },
    ]);
  });

  it("reports no cost, because a generic CLI does not tell us what it spent", async () => {
    const { exec } = fakeExec();
    const [message] = (await collect(createGenericCliQuery(spec(), { exec })({ prompt: "go" }))) as Array<{
      result?: { costUsd?: number };
    }>;
    // Inventing a number would corrupt the run's roll-up.
    expect(message!.result!.costUsd).toBeUndefined();
  });

  it("refuses a state's declared tools rather than dropping them — the binary has no bridge to serve them", async () => {
    const { exec, calls } = fakeExec();
    const messages = (await collect(
      createGenericCliQuery(spec(), { exec })({
        prompt: "go",
        mcpTools: { read_file: { description: "read", inputSchema: { type: "object" }, run: async () => null } },
      }),
    )) as Array<{ error?: string }>;
    expect(calls).toHaveLength(0); // refused BEFORE the binary ran, not after it worked unrestricted
    expect(messages[0]!.error).toMatch(/read_file.*cannot reach it/s);
  });

  it("refuses a deny-list and a permission mode by the same rule", async () => {
    const { exec, calls } = fakeExec();
    const messages = (await collect(
      createGenericCliQuery(spec(), { exec })({ prompt: "go", disallowedTools: ["Bash"], permissionMode: "plan" }),
    )) as Array<{ error?: string }>;
    expect(calls).toHaveLength(0);
    expect(messages[0]!.error).toMatch(/deny-list.*'plan' permission mode/s);
  });
});

describe("registerGenericAgents", () => {
  it("registers nothing when the project configured nothing", () => {
    const registry = newRegistry();
    registerGenericAgents(registry);
    // A state naming `generic-cli` then fails as an unregistered function — honest —
    // rather than silently running some default binary.
    expect(registry.functions.has(AGENT_GENERIC_CLI)).toBe(false);
  });

  it("registers each configured agent under its name", () => {
    const registry = newRegistry();
    registerGenericAgents(registry, {
      exec: fakeExec().exec,
      agents: [{ command: "opencode" }, { name: "codex", command: "codex" }],
    });
    expect(registry.functions.has(AGENT_GENERIC_CLI)).toBe(true);
    expect(registry.functions.has("codex")).toBe(true);
  });

  it("declares that it enforces no policy, so §8.2 refuses it under an escalating policy", () => {
    // The honest declaration is the whole point: nothing JaiRA does can gate the
    // commands a generic binary runs, so claiming `callback` or `config` would let a
    // state run unguarded while the engine skipped its own wrapping.
    expect(GENERIC_CLI_CAPS.policyEnforcement).toBe("none");
    expect(GENERIC_CLI_CAPS.interactive).toBe(false);

    const registry = newRegistry();
    registerGenericAgents(registry, { exec: fakeExec().exec, agents: [{ command: "opencode" }] });
    const issues = gateCapabilities(
      registry,
      { build: { operation: { kind: "function", functionRef: AGENT_GENERIC_CLI } } },
      { policyNeedsApproval: true },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/enforces no policy/);

    // With a policy that never escalates, the same state is allowed.
    expect(
      gateCapabilities(
        registry,
        { build: { operation: { kind: "function", functionRef: AGENT_GENERIC_CLI } } },
        { policyNeedsApproval: false },
      ),
    ).toEqual([]);
  });
});

describe("a model a generic CLI has nowhere to put", () => {
  const fakeExec = (seen: { args?: string[] }) => ({
    run: async (_cmd: string, args: string[]) => {
      seen.args = args;
      return { code: 0, stdout: "done", stderr: "", timedOut: false };
    },
  });

  it("REFUSES rather than running the binary's default under another name", async () => {
    // Silently dropping it would run a different model than the one asked for, which is wrong and
    // expensive — the same rule the deny-list follows.
    const query = createGenericCliQuery({ name: "mycli", command: "mycli" }, { exec: fakeExec({}) as never });
    const messages = [];
    for await (const m of query({ prompt: "go", model: "big" })) messages.push(m);
    expect(messages[0]?.error).toMatch(/no \{model\} placeholder/);
  });

  it("substitutes it into the argv template when there IS a placeholder", async () => {
    const seen: { args?: string[] } = {};
    const query = createGenericCliQuery(
      { name: "mycli", command: "mycli", args: ["-m", "{model}", "--json"] },
      { exec: fakeExec(seen) as never },
    );
    for await (const _ of query({ prompt: "go", model: "big" })) void _;
    expect(seen.args).toEqual(["-m", "big", "--json", "--", "go"]);
  });

  it("runs normally when no model was asked for, placeholder or not", async () => {
    const seen: { args?: string[] } = {};
    const query = createGenericCliQuery({ name: "mycli", command: "mycli" }, { exec: fakeExec(seen) as never });
    for await (const _ of query({ prompt: "go" })) void _;
    expect(seen.args).toEqual(["--", "go"]);
  });
});

describe("a generic CLI's key", () => {
  // A stored key, by the name the binary reads it from — what Settings' key box files it under.
  const store = (keys: Record<string, string>) => (name: string) => keys[name];

  it("is handed to the binary under its own name, from the chain the probe reads", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ command: "gemini", credential: "GEMINI_API_KEY" }), { exec, secret: store({ GEMINI_API_KEY: "k-123" }) });
    const messages = await collect(query({ prompt: "go" }));
    expect(calls[0]!.options.env).toEqual({ GEMINI_API_KEY: "k-123" });
    expect(messages).toEqual([{ type: "result", result: { text: "the agent's answer" } }]);
  });

  it("is looked up as each run starts, so a key stored after the agent was registered is found", async () => {
    const { exec, calls } = fakeExec();
    const keys: Record<string, string> = {};
    const query = createGenericCliQuery(spec({ command: "muse", credential: "META_API_KEY" }), { exec, secret: store(keys) });
    expect(await collect(query({ prompt: "go" }))).toMatchObject([{ type: "other" }]);
    keys["META_API_KEY"] = "m-456";
    await collect(query({ prompt: "go" }));
    expect(calls.map((call) => call.options.env)).toEqual([{ META_API_KEY: "m-456" }]);
  });

  it("refuses the run when the key it names is nowhere — rather than letting the binary bill some other sign-in", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ command: "gemini", credential: "GEMINI_API_KEY" }), { exec, secret: store({}) });
    expect(await collect(query({ prompt: "go" }))).toEqual([
      {
        type: "other",
        error: "'gemini' is set to use the key 'GEMINI_API_KEY', but no value was found for it — store one (Settings → Connections → Agents), or clear the key so the binary signs itself in",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("gives way to a variable config states itself, and sits beside the rest of `env`", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ credential: "OPENAI_API_KEY", env: { OPENAI_API_KEY: "from-config", OPENCODE_DEBUG: "1" } }), { exec, secret: store({ OPENAI_API_KEY: "stored" }) });
    await collect(query({ prompt: "go" }));
    expect(calls[0]!.options.env).toEqual({ OPENAI_API_KEY: "from-config", OPENCODE_DEBUG: "1" });
  });

  it("is left to the inherited environment when nothing looks keys up — as it always was", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ credential: "GEMINI_API_KEY" }), { exec });
    await collect(query({ prompt: "go" }));
    expect(calls[0]!.options.env).toBeUndefined();
  });

  it("crosses into a WSL distro: each variable is listed in WSLENV, after what it lists already", async () => {
    const { exec, calls } = fakeExec();
    const query = createGenericCliQuery(spec({ command: "gemini", credential: "GEMINI_API_KEY", env: { WSLENV: "USERPROFILE/p", NO_COLOR: "1" } }), {
      exec,
      execEnv: { wsl: "Ubuntu" },
      secret: store({ GEMINI_API_KEY: "k-123" }),
    });
    await collect(query({ prompt: "go" }));
    expect(calls[0]!.options.env).toEqual({ GEMINI_API_KEY: "k-123", NO_COLOR: "1", WSLENV: "USERPROFILE/p:GEMINI_API_KEY/u:NO_COLOR/u" });
  });

  it("reaches the binary through a model prefix too — the route a workflow's `gemini-cli/default` takes", async () => {
    const { exec, calls } = fakeExec();
    const routes = agentPromptRoutes({ genericCli: [{ name: "gemini-cli", command: "gemini", args: ["-p", "{prompt}"], credential: "GEMINI_API_KEY" }] }, { exec, secret: store({ GEMINI_API_KEY: "k-route" }) });
    const result = await executeWorkflow({
      bundle: loadBundle({ ask: { label: "Ask", operation: { kind: "prompt", prompt: "Say hi.", model: "gemini-cli/default" } } }, "ask"),
      inputs: {},
      registry: newRegistry(),
      prompt: buildPromptExecutor({ routes, tree: { kind: "agent", agent: "gemini-cli" } }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("gemini");
    expect(calls[0]!.options.env).toEqual({ GEMINI_API_KEY: "k-route" });
    expect(JSON.stringify(result)).not.toMatch(/no value was found/);
  });
});

/** A bridge that serves nothing, recording what it was asked to serve and whether it was closed. */
function fakeBridge(): { startBridge: StartMcpBridge; specs: McpBridgeSpec[]; closed: () => number } {
  const specs: McpBridgeSpec[] = [];
  let closed = 0;
  return {
    specs,
    closed: () => closed,
    startBridge: async (spec) => {
      specs.push(spec);
      return {
        url: "http://127.0.0.1:4321/secret-path/mcp",
        close: async () => {
          closed += 1;
        },
      };
    },
  };
}

const readTool: InjectedTool = { description: "read", inputSchema: { type: "object" }, run: async () => "read" };

/** opencode, pointed at the bridge by a config file it finds through a variable — the shape the shipped entry has. */
const bridged = (extra: Partial<JairaGenericCliAgent["mcp"]> = {}): JairaGenericCliAgent =>
  spec({
    args: ["run"],
    mcp: { env: { OPENCODE_CONFIG: "{mcpConfig}" }, config: { mcp: { dai: { type: "remote", url: "{mcpUrl}" } } }, configName: "opencode.json", builtinsOff: true, ...extra },
  });

describe("a generic CLI pointed at the tool bridge (`mcp`)", () => {
  it("serves the state's tools there and tells the binary where, through the file it writes and the variable naming it", async () => {
    let seenConfig: unknown;
    let seenMode = 0;
    const { exec, calls } = fakeExec();
    const recording: typeof exec = {
      run: async (command, args, options) => {
        const path = options?.env?.["OPENCODE_CONFIG"];
        if (path !== undefined) {
          seenConfig = JSON.parse(readFileSync(path, "utf8"));
          seenMode = statSync(path).mode & 0o777;
        }
        return exec.run(command, args, options);
      },
    };
    const { startBridge, specs, closed } = fakeBridge();
    const messages = await collect(createGenericCliQuery(bridged(), { exec: recording, startBridge })({ prompt: "fix it", mcpTools: { read_file: readTool }, allowedTools: ["read_file"] }));

    expect(messages).toEqual([{ type: "result", result: { text: "the agent's answer" } }]);
    expect(Object.keys(specs[0]!.tools ?? {})).toEqual(["read_file"]);
    expect(calls[0]!.args).toEqual(["run", "--", "fix it"]);
    const path = calls[0]!.options.env!["OPENCODE_CONFIG"]!;
    expect(path).toMatch(/opencode\.json$/);
    // The file held the bridge's URL while the binary ran, readable by this user alone — and is gone after.
    expect(seenConfig).toEqual({ mcp: { dai: { type: "remote", url: "http://127.0.0.1:4321/secret-path/mcp" } } });
    if (process.platform !== "win32") expect(seenMode).toBe(0o600);
    expect(existsSync(path)).toBe(false);
    expect(closed()).toBe(1);
  });

  it("fills `{mcpUrl}` inside an argument, before an appended prompt and after a placed one", async () => {
    const { startBridge } = fakeBridge();
    const appended = fakeExec();
    await collect(
      createGenericCliQuery(spec({ args: ["exec"], mcp: { args: ["-c", 'mcp_servers.dai={url="{mcpUrl}"}'] } }), { exec: appended.exec, startBridge })({
        prompt: "go",
        mcpTools: { read_file: readTool },
      }),
    );
    expect(appended.calls[0]!.args).toEqual(["exec", "-c", 'mcp_servers.dai={url="http://127.0.0.1:4321/secret-path/mcp"}', "--", "go"]);
    const placed = fakeExec();
    await collect(
      createGenericCliQuery(spec({ args: ["-p", "{prompt}"], mcp: { args: ["--mcp", "{mcpUrl}"] } }), { exec: placed.exec, startBridge })({ prompt: "go", mcpTools: { read_file: readTool } }),
    );
    expect(placed.calls[0]!.args).toEqual(["-p", "go", "--mcp", "http://127.0.0.1:4321/secret-path/mcp"]);
  });

  it("with its own tools off, is started that way even when there is nothing to serve", async () => {
    const { exec, calls } = fakeExec();
    const { startBridge, specs } = fakeBridge();
    await collect(createGenericCliQuery(bridged(), { exec, startBridge })({ prompt: "go" }));
    expect(specs).toHaveLength(1);
    expect(calls[0]!.options.env!["OPENCODE_CONFIG"]).toMatch(/opencode\.json$/);
  });

  it("with its own tools kept, stands no bridge up when there is nothing to serve, and runs as it always did", async () => {
    const { exec, calls } = fakeExec();
    const { startBridge, specs } = fakeBridge();
    await collect(createGenericCliQuery(bridged({ builtinsOff: false }), { exec, startBridge })({ prompt: "go" }));
    expect(specs).toHaveLength(0);
    expect(calls[0]!.options.env).toBeUndefined();
  });

  it("does not run the binary when the bridge cannot start", async () => {
    const { exec, calls } = fakeExec();
    const startBridge: StartMcpBridge = async () => {
      throw new Error("no sdk");
    };
    const messages = (await collect(createGenericCliQuery(bridged(), { exec, startBridge })({ prompt: "go", mcpTools: { read_file: readTool } }))) as Array<{ error?: string }>;
    expect(calls).toHaveLength(0);
    expect(messages[0]!.error).toMatch(/tool bridge could not start: no sdk/);
  });

  it("closes the bridge and removes the file when the binary fails", async () => {
    const { exec, calls } = fakeExec({ code: 2, stderr: "boom" });
    const { startBridge, closed } = fakeBridge();
    const messages = (await collect(createGenericCliQuery(bridged(), { exec, startBridge })({ prompt: "go" }))) as Array<{ error?: string }>;
    expect(messages[0]!.error).toMatch(/exited 2: boom/);
    expect(existsSync(calls[0]!.options.env!["OPENCODE_CONFIG"]!)).toBe(false);
    expect(closed()).toBe(1);
  });
});

describe("what a generic CLI refuses, by what its registration says", () => {
  const served = { mcpTools: { read_file: readTool } };

  it("with no `mcp`: its tools, any pre-approval, a deny-list and a mode, as it always did", () => {
    expect(genericCliRefusal(spec(), { prompt: "go", ...served })).toMatch(/no tool bridge.*give its registration an mcp block/s);
    expect(genericCliRefusal(spec(), { prompt: "go" })).toBeUndefined();
  });

  it("with `mcp` and its own tools kept: what is served and its pre-approval travel; a deny-list cannot", () => {
    const kept = bridged({ builtinsOff: false });
    expect(genericCliRefusal(kept, { prompt: "go", ...served, allowedTools: ["read_file"] })).toBeUndefined();
    expect(genericCliRefusal(kept, { prompt: "go", ...served, allowedTools: ["Bash"] })).toMatch(/pre-approval of \[Bash\].*mcp\.builtinsOff/s);
    expect(genericCliRefusal(kept, { prompt: "go", disallowedTools: ["Bash"] })).toMatch(/deny-list \[Bash\]/);
    expect(genericCliRefusal(kept, { prompt: "go", permissionMode: "plan" })).toMatch(/'plan' permission mode/);
  });

  it("with its own tools off: a denied name is honoured by its absence, and `plan` by the gate", () => {
    const off = bridged();
    expect(genericCliRefusal(off, { prompt: "go", ...served, disallowedTools: ["Bash", "AskUserQuestion"], permissionMode: "plan" })).toBeUndefined();
    expect(genericCliRefusal(off, { prompt: "go", permissionMode: "bypassPermissions" })).toMatch(/'bypassPermissions' permission mode/);
  });
});

describe("a generic CLI with its own tools off, reached as a function", () => {
  it("declares `config`, so §8.2 lets it run under a policy that can ask", () => {
    expect(GENERIC_BRIDGED_CAPS.policyEnforcement).toBe("config");
    const registry = newRegistry();
    registerGenericAgents(registry, { exec: fakeExec().exec, agents: [bridged()] });
    expect(gateCapabilities(registry, { build: { operation: { kind: "function", functionRef: AGENT_GENERIC_CLI } } }, { policyNeedsApproval: true })).toEqual([]);
  });

  it("runs a permission set that refuses things, serving what it holds over the bridge — gated there", async () => {
    const { exec, calls } = fakeExec();
    const { startBridge, specs } = fakeBridge();
    const registry = newRegistry();
    const ran: string[] = [];
    for (const name of ["read_file", "edit", "write_file", "shell"]) {
      registry.tools.set(name, { description: name, inputSchema: { type: "object" }, readOnly: name === "read_file", run: async () => (ran.push(name), "ok") });
    }
    registerGenericAgents(registry, { exec, startBridge, agents: [{ ...bridged(), name: "opencode" }] });
    const lowered = lowerStatePermissionSets(
      "delegate",
      { label: "Delegate", outputs: {}, operation: { kind: "function", function: "opencode", args: { prompt: "go" } }, environment: { tools: { read_file: "allow", write_file: "ask", other: "deny" } } },
      () => {
        throw new Error("no reference expected");
      },
    );
    const result = await executeWorkflow({
      bundle: loadBundle({ delegate: lowered.def }, "delegate"),
      inputs: {},
      registry,
      prompt: buildPromptExecutor({ routes: agentPromptRoutes({}, {}), tree: { kind: "agent", agent: "claude-cli" } }),
      approve: () => ({ decision: "deny", scope: "once" }),
    });
    expect(JSON.stringify(result)).not.toMatch(/enforces nothing/);
    expect(calls).toHaveLength(1);
    const tools = specs[0]!.tools!;
    expect(Object.keys(tools).sort()).toEqual(["read_file", "write_file"]);
    // An `allow` runs; an `ask` goes to the approver, who said no.
    expect(await tools["read_file"]!.run({ path: "a" })).toBe("ok");
    expect(await tools["write_file"]!.run({ path: "a", content: "x" })).toMatchObject({ denied: true });
    expect(ran).toEqual(["read_file"]);
  });
});

describe("a tool every state is granted, on a binary that cannot be served it", () => {
  const artifact: InjectedTool = { description: "show", inputSchema: { type: "object" }, run: async () => "shown" };

  it("is left out of a plain run rather than refusing it — the engine grants it to every state", async () => {
    const { exec, calls } = fakeExec();
    const messages = await collect(createGenericCliQuery(spec(), { exec })({ prompt: "go", mcpTools: { show_artifact: artifact }, allowedTools: ["show_artifact"] }));
    expect(calls).toHaveLength(1);
    expect(messages).toEqual([{ type: "result", result: { text: "the agent's answer" } }]);
  });

  it("does not excuse a tool the state declared itself", async () => {
    const { exec, calls } = fakeExec();
    const messages = (await collect(createGenericCliQuery(spec(), { exec })({ prompt: "go", mcpTools: { show_artifact: artifact, read_file: readTool } }))) as Array<{ error?: string }>;
    expect(calls).toHaveLength(0);
    expect(messages[0]!.error).toMatch(/\[read_file\]/);
  });
});

describe("a bridged registration, on a call no permission set holds", () => {
  const states = (operation: Record<string, unknown>) => ({ a: { label: "a", outputs: {}, operation } });

  it("runs the binary as it always ran, with its own tools: no bridge, nothing turned off", async () => {
    const { exec, calls } = fakeExec();
    const { startBridge, specs } = fakeBridge();
    const routes = agentPromptRoutes({ genericCli: [{ ...bridged(), name: "opencode" }] }, { exec, startBridge });
    await executeWorkflow({
      bundle: loadBundle(states({ kind: "prompt", prompt: "go", model: "opencode/default" }), "a"),
      inputs: {},
      registry: newRegistry(),
      prompt: buildPromptExecutor({ routes, tree: { kind: "agent", agent: "opencode" } }),
    });
    expect(specs).toHaveLength(0);
    expect(calls[0]!.args).toEqual(["run", "--", "go"]);
    expect(calls[0]!.options.env).toBeUndefined();
  });

  it("as a function, is refused where the policy would not let an unchecked shell run — what §8.2's check stood for", async () => {
    const { exec, calls } = fakeExec();
    const registry = newRegistry();
    registerGenericAgents(registry, { exec, startBridge: fakeBridge().startBridge, agents: [{ ...bridged(), name: "opencode" }] });
    const run = (approve?: () => { decision: "allow"; scope: "once" }) =>
      executeWorkflow({
        bundle: loadBundle(states({ kind: "function", function: "opencode", args: { prompt: "go" } }), "a"),
        inputs: {},
        registry,
        prompt: buildPromptExecutor({ routes: agentPromptRoutes({}, {}), tree: { kind: "agent", agent: "claude-cli" } }),
        ...(approve !== undefined ? { approve } : {}),
      });
    expect(JSON.stringify(await run(() => ({ decision: "allow", scope: "once" })))).toMatch(/declares no permission set.*its own shell/);
    expect(calls).toHaveLength(0);
    // With no gate at all (`jaira run` with no approver) there is no policy to keep, and it runs as it always did.
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.env).toBeUndefined();
  });
});
