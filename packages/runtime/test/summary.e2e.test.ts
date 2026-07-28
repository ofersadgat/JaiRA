/**
 * Conversation `summary` mode driven through a real run.
 *
 * The unit tests pin the store's policy; this one pins the thing that actually
 * matters — that the *engine* reads the compacted transcript. The seam is
 * `ctx.services.sessions`, which the engine documents as "an app store wins", so
 * this test is what proves JaiRA's decorator is on the path a state's preamble
 * takes rather than sitting beside it.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";
import { executeWorkflow } from "../src/wiring";
import { newRegistry } from "../src/wiring";
import { SUMMARY_TAG, sessionStoreFor } from "../src/summary";

/** Two prompt states in one session; `second` chooses how it carries history. */
function twoStepFiles(mode: "summary" | "full_history"): Record<string, unknown> {
  return {
    chain: {
      label: "Chain",
      inputs: { topic: { schema: { type: "string" } } },
      outputs: { answer: { schema: { type: "string" }, binding: { child: "second", output: "answer" } } },
      children: {
        first: { state: "chain/first", inputs: { topic: { input: "topic" } } },
        second: { state: "chain/second", inputs: { draft: { child: "first", output: "draft" } } },
      },
      sequence: ["first", "second"],
      transitions: [{ to: "terminate.success", when: "children.second.outcome === 'success'" }],
    },
    "chain/first": {
      inputs: { topic: { schema: { type: "string" } } },
      outputs: { draft: { schema: { type: "string" } } },
      environment: { conversation: { mode: "fresh" } },
      operation: { kind: "prompt", prompt: { template: "Draft something about {{inputs.topic}}." }, config: { model: "m" } },
    },
    "chain/second": {
      inputs: { draft: { schema: { type: "string" } } },
      outputs: { answer: { schema: { type: "string" } } },
      environment: { conversation: { mode } },
      operation: { kind: "prompt", prompt: { template: "Refine the draft." }, config: { model: "m" } },
    },
  };
}

/** A first-state answer long enough to blow any small budget. */
const LONG_DRAFT = `DRAFT-MARKER ${"y".repeat(2_000)}`;

async function run(mode: "summary" | "full_history"): Promise<{ prompts: string[]; ok: boolean; reason?: string }> {
  const bundle = loadBundle(twoStepFiles(mode), "chain");
  const fake = new ScriptedFakeExecutor([
    { promptIncludes: "Draft something", output: { draft: LONG_DRAFT } },
    { promptIncludes: "Refine the draft", output: { answer: "refined" } },
  ]);
  const { store } = sessionStoreFor(bundle, async () => "SUMMARY-MARKER: they drafted something long.", {
    budgetChars: 500,
    keepRecentTurns: 0,
  });
  const result = await executeWorkflow({
    bundle,
    inputs: { topic: "widgets" },
    registry: newRegistry(),
    prompt: fake,
    ...(store !== undefined ? { sessions: store } : {}),
  });
  return {
    prompts: fake.calls.map((op) => op.user ?? ""),
    ok: !("error" in result && result.error !== undefined),
    ...("error" in result ? { reason: result.error?.reason } : {}),
  };
}

describe("summary mode end to end", () => {
  it("hands the second state a summary instead of the first state's full output", async () => {
    const { prompts, ok, reason } = await run("summary");
    expect(reason).toBeUndefined();
    expect(ok).toBe(true);
    const second = prompts.find((p) => p.includes("Refine the draft"))!;
    expect(second).toContain("SUMMARY-MARKER");
    // The measured problem (§1h): under full_history this prompt carries the whole
    // previous turn, and it compounds every iteration.
    expect(second).not.toContain("DRAFT-MARKER");
  });

  it("still sends the whole transcript when the state asked for full history", async () => {
    const { prompts, ok } = await run("full_history");
    expect(ok).toBe(true);
    const second = prompts.find((p) => p.includes("Refine the draft"))!;
    expect(second).toContain("DRAFT-MARKER");
    expect(second).not.toContain("SUMMARY-MARKER");
  });
});
