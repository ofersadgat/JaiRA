/**
 * A restricted state's contract survives delegation — through the REAL wiring, end to end.
 *
 * This pins the failure the sync run exposed (system task t-0da5ilgdqj): a state authored
 * `{"kind": "prompt", "tools": ["read_file"]}` with "must not touch disk" in the prose, was routed to
 * the CLI agent, and the agent used its own `Bash`, `Glob` and `Read` — none of them JaiRA's tool,
 * none of them held to anything. Every seam in the chain existed and none were connected: the engine
 * hard-coded prompt ops as composed, never published the gate on that path, and the production
 * executor never populated `EngineConfig.permissions` at all, so the enforcement machinery was
 * configured, displayed, and ignored.
 *
 * The chain under test: `executeWorkflow` → engine (delegation decided by the tree's
 * `capabilitiesFor`, gate built off the services seam) → `withAgentPermissionSet` (the state's permission set →
 * up-front deny of every built-in it does not hold) → `AgentCliExecutor` → the query options a real
 * `claude` would be spawned with. A fake QUERY stands in for the binary alone.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { AgentQuery, AgentQueryOptions } from "@declarative-ai/agents-api";
import { lowerPermissionSet, parsePermissionSet } from "@jaira/shared";
import { agentPromptRoutes } from "../src/modelRoutes";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

/** The sync shape: one prompt state, a read-only permission set holding one tool, lowered as the loader lowers it. */
const files: Record<string, unknown> = {
  digest: {
    label: "Read and report",
    outputs: { report: { kind: "text", schema: { type: "string" } } },
    operation: {
      kind: "prompt",
      prompt: "Summarize the workflows.",
      model: "claude-cli/default",
    },
    environment: lowerPermissionSet(parsePermissionSet({ read_file: "allow", other: "deny" }).permissionSet),
  },
};

function capturingQuery(): { seen: AgentQueryOptions[]; query: AgentQuery } {
  const seen: AgentQueryOptions[] = [];
  const query: AgentQuery = async function* (opts) {
    seen.push(opts);
    yield { type: "result", result: { text: "Read them.", structured: { report: "all quiet" } } };
  };
  return { seen, query };
}

describe("a read-only prompt state reaches the CLI agent restricted", () => {
  it("denies the write-capable built-ins up front and serves the declared tool over the bridge", async () => {
    const { seen, query } = capturingQuery();
    const registry = newRegistry();
    registry.tools.set("read_file", {
      description: "read a file",
      inputSchema: { type: "object" },
      readOnly: true,
      run: async () => "contents",
    });

    const result = await executeWorkflow({
      bundle: loadBundle(files, "digest"),
      inputs: {},
      registry,
      prompt: buildPromptExecutor({
        routes: agentPromptRoutes({}, { query }),
        tree: { kind: "agent", agent: "claude-cli" },
      }),
      // The approver rides the services seam, exactly as `startRun` wires it — the engine must build
      // the gate from there, because nothing on this path sets `EngineConfig.permissions`.
      approve: () => ({ decision: "deny", scope: "once" }),
    });

    expect(result.value).toMatchObject({ report: "all quiet" });
    expect(seen).toHaveLength(1);
    const opts = seen[0]!;
    // The fence, as configuration: what the observed run used freely is not even offered.
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Task"]));
    // The grant: the one declared tool is served over the bridge and pre-approved by its authored
    // `allow`, so a read costs no human click.
    expect(Object.keys(opts.mcpTools ?? {})).toEqual(["read_file"]);
    expect(opts.allowedTools).toContain("read_file");
    // `read-only` maps to no claude permission mode — `plan` would be a different instruction.
    expect(opts.permissionMode).toBeUndefined();
    // The mid-run floor is armed: everything the deny list cannot name goes through the callback.
    expect(opts.canUseTool).toBeDefined();
  });

  it("routes AskUserQuestion to the askUser seam and carries the answers back — never to the approver", async () => {
    // The same real chain, one seam further: `executeWorkflow`'s `askUser` must reach the adapter's
    // native callback, or the question falls to the gate as an unclassifiable tool — a human asked to
    // APPROVE being asked, and an allow that resolves the question with "." and no answers.
    const { seen, query } = capturingQuery();
    const approved: string[] = [];
    const registry = newRegistry();
    registry.tools.set("read_file", {
      description: "read a file",
      inputSchema: { type: "object" },
      readOnly: true,
      run: async () => "contents",
    });
    const result = await executeWorkflow({
      bundle: loadBundle(files, "digest"),
      inputs: {},
      registry,
      prompt: buildPromptExecutor({
        routes: agentPromptRoutes({}, { query }),
        tree: { kind: "agent", agent: "claude-cli" },
      }),
      approve: (req) => {
        approved.push(req.tool);
        return { decision: "deny", scope: "once" };
      },
      askUser: async (req) => ({ [req.questions[0]!.question]: "luxon" }),
    });
    expect(result.value).toMatchObject({ report: "all quiet" });

    const input = {
      questions: [
        { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "batteries" }] },
      ],
    };
    const decision = await seen[0]!.canUseTool!(
      { toolName: "AskUserQuestion", input: input as never },
      { signal: new AbortController().signal },
    );
    expect(decision).toEqual({ allow: true, updatedInput: { ...input, answers: { "Which library?": "luxon" } } });
    // The approval path never saw it: the question was answered, not authorized.
    expect(approved).toEqual([]);
  });
});
