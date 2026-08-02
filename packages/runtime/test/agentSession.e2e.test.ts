/**
 * A delegated agent's CONVERSATION, driven through a real run.
 *
 * The gap this pins was silent in the worst way. A state's prompt op goes straight to the injected
 * prompt executor, while a state's FUNCTION op — every delegated agent — goes through the operation
 * dispatcher. The session layer was composed around the prompt executor alone, so `hw` stated an
 * agent's session request and nothing answered it: `ctx.session` was undefined on every agent call,
 * the adapter's resume path was unreachable, and each call silently started a NEW provider
 * conversation while the workflow read as though `session: "review"` had joined them up. Nothing
 * failed. The agent just never remembered.
 *
 * So this asserts through the seam an adapter actually reads.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import { runtimeFunction, RUNTIME_CAPABILITIES, type ExecServices, type ResolvedSession } from "@declarative-ai/exec";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";
import { executeWorkflow, newRegistry } from "../src/wiring";
import { sessionServicesFor } from "../src/summary";

/** Two agent states naming one conversation, plus a third that names none. */
const files: Record<string, unknown> = {
  review: {
    label: "Review",
    inputs: { change: { schema: { type: "string" } } },
    outputs: { report: { schema: { type: "string" }, binding: ".children.second.outputs.report" } },
    children: {
      first: { state: "review/first", inputs: { change: ".inputs.change" } },
      second: { state: "review/second", inputs: { change: ".inputs.change" } },
      alone: { state: "review/alone", inputs: { change: ".inputs.change" } },
    },
    sequence: ["first", "second", "alone"],
    transitions: [{ to: "terminate.success", when: ".children.alone.outcome === 'success'" }],
  },
  "review/first": {
    inputs: { change: { schema: { type: "string" } } },
    outputs: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    environment: { session: "review" },
    operation: { kind: "function", function: "agent", input: { prompt: { kind: "text", binding: ".inputs.change" } }, output: { name: "report", kind: "blob" } },
  },
  "review/second": {
    inputs: { change: { schema: { type: "string" } } },
    outputs: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    environment: { session: "review" },
    operation: { kind: "function", function: "agent", input: { prompt: { kind: "text", binding: ".inputs.change" } }, output: { name: "report", kind: "blob" } },
  },
  "review/alone": {
    inputs: { change: { schema: { type: "string" } } },
    outputs: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    operation: { kind: "function", function: "agent", input: { prompt: { kind: "text", binding: ".inputs.change" } }, output: { name: "report", kind: "blob" } },
  },
};

/** A delegated runtime that records the session it was given and reports one back. */
function recordingAgent() {
  const seen: Array<ResolvedSession | undefined> = [];
  let call = 0;
  const impl = async (_inputs: unknown, ctx: ExecServices) => {
    seen.push(ctx.session);
    call += 1;
    return {
      value: `report ${call}`,
      metrics: { startMs: 0, durationMs: 1, costUsd: 0 },
      // What a delegated agent contributes to a transcript: its answer, plus the provider handle the
      // run ended in — which is the thing a later resume needs.
      session: { providerSessionId: `prov-${call}`, messages: [{ role: "assistant", content: `report ${call}` }] },
    };
  };
  return { seen, impl };
}

async function run() {
  const bundle = loadBundle(files, "review");
  const agent = recordingAgent();
  const registry = newRegistry();
  registry.functions.set(
    "agent",
    runtimeFunction(agent.impl as never, { ...RUNTIME_CAPABILITIES, policyEnforcement: "config", sessionResume: true }) as never,
  );
  const session = sessionServicesFor(bundle, async () => "");
  const result = await executeWorkflow({
    bundle,
    inputs: { change: "the diff" },
    registry,
    prompt: new ScriptedFakeExecutor([]) as never,
    session: { sessions: session.sessions, records: session.records },
  });
  return { result, seen: agent.seen };
}

describe("a delegated agent's conversation, end to end", () => {
  it("hands the agent a RESOLVED position, not just a request", async () => {
    const { result, seen } = await run();
    expect("error" in result ? result.error : undefined).toBeUndefined();
    expect(seen).toHaveLength(3);
    expect(seen[0]?.mode).toBe("append");
    expect(seen[0]?.at).toBeDefined();
  });

  it("puts two states that name one conversation into one conversation, in order", async () => {
    const { seen } = await run();
    expect(seen[1]?.at.id).toBe(seen[0]?.at.id);
    expect(seen[1]!.at.seq).toBeGreaterThan(seen[0]!.at.seq);
    // …and the second call can resume what the first ended in, which is the whole point of recording
    // the provider handle.
    expect(seen[1]?.providerSessionId).toBe("prov-1");
  });

  it("gives a state that declares no session its own conversation", async () => {
    const { seen } = await run();
    // An undeclared conversation is private to the instance — never an implicit shared transcript.
    expect(seen[2]?.at.id).not.toBe(seen[0]?.at.id);
    expect(seen[2]?.providerSessionId).toBeUndefined();
  });
});
