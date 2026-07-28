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
import {
  AGENT_GENERIC_CLI,
  GENERIC_CLI_CAPS,
  createGenericCliQuery,
  registerGenericAgents,
} from "../src/genericAgent";
import { newRegistry } from "../src/wiring";

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
