/**
 * "Do a code review with both Claude Code and codex", as one authored workflow.
 *
 * This is the case the pieces were built for, so it is worth having one test that runs all of them
 * together rather than only their halves:
 *
 *  - ONE review state, mounted TWICE under two different runtimes via `children[].environment`
 *    (declarative-ai's per-mount defaults). The state itself names no `function` — it leaves that to
 *    the chain, which is what makes it mountable under either agent.
 *  - Two DIFFERENT CLI protocols behind the same normalized seam: `claude` answers with a `result`
 *    message, codex with a `thread`/`item` event stream, and neither adapter knows about the other.
 *  - A dataflow join: `synthesize` wires both reports, so it waits for both without a join construct
 *    (SPEC §10.4).
 *
 * Both agents are driven through a fake PROCESS rather than a fake query, so the argv and the stream
 * parsing are the real ones — the halves most likely to be wrong against a real binary.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { SpawnProcess } from "@declarative-ai/agents-cli";
import { registerAgentRuntimes } from "../src/agents";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";
import { executeWorkflow, newRegistry } from "../src/wiring";

const files: Record<string, unknown> = {
  review: {
    label: "Review the change",
    inputs: { change: { schema: { type: "string" } } },
    outputs: { report: { schema: { type: "string" }, binding: ".children.synthesize.outputs.report" } },
    children: {
      // The SAME state, twice, under two agents. Two near-duplicate state files before this existed.
      claude_review: {
        state: "review/agent_review",
        async: true,
        environment: { kind: "function", function: "claude-cli" },
        inputs: { change: ".inputs.change" },
      },
      codex_review: {
        state: "review/agent_review",
        async: true,
        environment: { kind: "function", function: "codex-cli" },
        inputs: { change: ".inputs.change" },
      },
      synthesize: {
        state: "review/synthesize",
        inputs: {
          review_a: ".children.claude_review.outputs.report",
          review_b: ".children.codex_review.outputs.report",
        },
      },
    },
    sequence: ["claude_review", "codex_review", "synthesize"],
    transitions: [{ to: "terminate.success", when: ".children.synthesize.outcome === 'success'" }],
  },
  "review/agent_review": {
    inputs: { change: { schema: { type: "string" } } },
    // A delegated agent answers with ONE string, so the slot it fills is blob-kind. A json output
    // would be read as a record of named outputs and fail as "did not produce required output".
    outputs: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    operation: {
      // No `function`: the mount supplies it. THIS is what makes the state reusable across agents.
      kind: "function",
      input: { prompt: { kind: "text", binding: ".inputs.change" } },
      output: { name: "report", kind: "blob" },
    },
  },
  "review/synthesize": {
    inputs: { review_a: { schema: { type: "string" } }, review_b: { schema: { type: "string" } } },
    outputs: { report: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "Merge these two reviews:\n{{.inputs.review_a}}\n{{.inputs.review_b}}", model: "m" },
  },
};

/** One fake process serving BOTH protocols, chosen by the binary it was asked to run. */
function twoAgentSpawn(): { spawn: SpawnProcess; launches: Array<{ argv: string[]; stdin?: string; cwd?: string }> } {
  const launches: Array<{ argv: string[]; stdin?: string; cwd?: string }> = [];
  const spawn: SpawnProcess = (argv, opts) => {
    launches.push({
      argv,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const lines =
      argv[0] === "codex"
        ? [
            JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
            JSON.stringify({ type: "item.completed", item: { item_type: "assistant_message", text: "CODEX: unchecked index on line 3" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } }),
          ]
        : [JSON.stringify({ type: "result", result: "CLAUDE: the error path is unhandled", total_cost_usd: 0.01 })];
    return {
      lines: (async function* () {
        for (const line of lines) yield line;
      })(),
      kill: () => {},
      exit: Promise.resolve(0),
    };
  };
  return { spawn, launches };
}

async function run() {
  const bundle = loadBundle(files, "review");
  const { spawn, launches } = twoAgentSpawn();
  const registry = registerAgentRuntimes(newRegistry(), { adapters: ["cli", "codex"], spawn });
  const prompt = new ScriptedFakeExecutor([
    { promptIncludes: "Merge these two reviews", output: { report: "merged: two findings" } },
  ]);
  const result = await executeWorkflow({
    bundle,
    inputs: { change: "diff --git a/x b/x" },
    registry,
    prompt: prompt as never,
    workspace: { root: "/repo" },
  });
  return { result, launches };
}

describe("a code review by two different agents", () => {
  it("runs both agents and merges their reports", async () => {
    const { result, launches } = await run();
    expect("error" in result ? result.error : undefined).toBeUndefined();
    expect((result as { value?: { report?: string } }).value?.report).toBe("merged: two findings");
    expect(launches.map((l) => l.argv[0]).sort()).toEqual(["claude", "codex"]);
  });

  it("drives each agent in ITS OWN protocol, from one authored state", async () => {
    const { launches } = await run();
    const claude = launches.find((l) => l.argv[0] === "claude")!;
    const codex = launches.find((l) => l.argv[0] === "codex")!;

    // Claude: the prompt is a positional after `--`, and the run is `-p --output-format stream-json`.
    expect(claude.argv).toContain("--output-format");
    expect(claude.argv.at(-1)).toBe("diff --git a/x b/x");
    expect(claude.stdin).toBeUndefined();

    // Codex: `exec --json`, an explicit sandbox, and the prompt on STDIN.
    expect(codex.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(codex.argv).toContain('sandbox_mode="workspace-write"');
    expect(codex.stdin).toBe("diff --git a/x b/x");
    expect(codex.argv.slice(-2)).toEqual(["--", "-"]);
  });

  it("passes the workspace to both as their working directory", async () => {
    const { launches } = await run();
    // Through the SPAWN, not through a flag: only the spawn seam knows how to translate a directory
    // for the environment it launches into, which is what makes a WSL project's agents work.
    expect(launches.map((l) => l.cwd)).toEqual(["/repo", "/repo"]);
    expect(launches.find((l) => l.argv[0] === "codex")!.argv).not.toContain("-C");
  });
});
