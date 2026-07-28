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
import type { ExecServices } from "@declarative-ai/exec";
import { AGENT_CLI, AGENT_SDK, gateCapabilities, registerAgentRuntimes } from "../src/agents";
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
  it("registers both adapters as runtime entries", () => {
    const registry = registerAgentRuntimes(newRegistry(), { query: fakeQuery().query });
    for (const name of [AGENT_SDK, AGENT_CLI]) {
      const entry = registry.functions.get(name);
      expect(entry, name).toBeDefined();
      expect(entry!.kind).toBe("runtime");
    }
  });

  it("registers only what was asked for", () => {
    const registry = registerAgentRuntimes(newRegistry(), { adapters: ["sdk"], query: fakeQuery().query });
    expect(registry.functions.has(AGENT_SDK)).toBe(true);
    expect(registry.functions.has(AGENT_CLI)).toBe(false);
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
