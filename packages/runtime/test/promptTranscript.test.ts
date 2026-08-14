/**
 * A prompt state's CONVERSATION reaches the store (DESIGN §7.3).
 *
 * The bug: every prompt leaf ran in the executor's default VALUE mode, which projects the `LlmOutput`
 * down to the op's output value inside the call. `withRecord` then wrote that projection into the
 * position the session layer had reserved — so the row held `{"greeting":"Hello, world!"}` and no
 * messages at all, `defaultMessagesOf` read `record.result.value.messages` and found nothing, and the
 * viewer reported "this state ran no model call" about a run that had made two.
 *
 * The point of driving this through `executeWorkflow` and a real `SqliteSessionStore` rather than
 * unit-testing the wrapper is that the failure was entirely a WIRING failure: every piece worked, and
 * what was wrong was which mode the leaf ran in and therefore what the layer above it stored.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { SpawnProcess } from "@declarative-ai/agents-cli";
import { SqliteSessionStore, messagesOfRecord, openDb, type JairaDb } from "@jaira/persistence";
import { agentPromptRoutes } from "../src/modelRoutes";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

/** One prompt state, answered by an agent route — the shape the hello-world self-test runs in. */
const files: Record<string, unknown> = {
  say: {
    label: "Say hello",
    outputs: { greeting: { kind: "text", schema: { type: "string" } } },
    operation: {
      kind: "prompt",
      prompt: "Reply with exactly this and nothing else: Hello, world!",
      model: "claude-cli/default",
    },
  },
};

/**
 * A fake `claude` process: the real argv building and the real stream parsing, a scripted answer.
 *
 * The assistant turn and the terminal `result` are separate messages on purpose — the transcript is
 * built from the turns the agent narrates, not from the final answer, so a fake that emitted only the
 * result would pass a test that a real binary would fail.
 */
function claudeSpawn(): SpawnProcess {
  return () => ({
    lines: (async function* () {
      yield JSON.stringify({
        type: "assistant",
        session_id: "sess-abc",
        message: { role: "assistant", content: [{ type: "text", text: "Hello, world!" }] },
      });
      // The structured value comes back on `structured_output`, not on `result` — `result` stays a
      // prose summary of the work. Getting that wrong is how the fake would answer nothing at all.
      yield JSON.stringify({
        type: "result",
        session_id: "sess-abc",
        result: "Said hello.",
        structured_output: { greeting: "Hello, world!" },
        total_cost_usd: 0.01,
      });
    })(),
    kill: () => {},
    exit: Promise.resolve(0),
  });
}

describe("a prompt state's conversation is stored, not projected away", () => {
  let dir: string;
  let db: JairaDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jaira-transcript-"));
    db = openDb(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the messages the call produced, and still answers with the op's output value", async () => {
    const records = new SqliteSessionStore(db, { taskId: "t-1", runId: 1 });
    const prompt = buildPromptExecutor({
      routes: agentPromptRoutes({}, { spawn: claudeSpawn() }),
      tree: { kind: "agent", agent: "claude-cli" },
    });

    const result = await executeWorkflow({
      bundle: loadBundle(files, "say"),
      inputs: {},
      registry: newRegistry(),
      prompt,
      session: { sessions: records, records },
    });

    // The workflow still sees the VALUE. Record mode is invisible above the leaf, and a transcript
    // bought by breaking the output would be no fix at all.
    expect(result.value).toMatchObject({ greeting: "Hello, world!" });

    // …and the conversation is in the record the session position points at.
    const record = records.at("#i1", 0);
    expect(record).toBeDefined();
    const messages = messagesOfRecord(record?.value) as Array<{ role?: string }>;
    expect(messages.length).toBeGreaterThan(0);
    // BOTH halves of the exchange: the request turn the executor sent, and what the agent said back.
    expect(messages.map((m) => m.role)).toContain("user");
    expect(messages.map((m) => m.role)).toContain("assistant");
    expect(JSON.stringify(messages)).toContain("Hello, world!");
  });

  it("stores the provider's own session handle, so a later call can resume it", async () => {
    // The other half of the same report, and the reason it travels with the messages: with no handle
    // stored, `external_id` was null on every row, nothing could be resumed by handle, and the
    // divergence check — which compares the handle we resumed against the one the call ended in —
    // had nothing to compare.
    const records = new SqliteSessionStore(db, { taskId: "t-2", runId: 1 });
    const prompt = buildPromptExecutor({
      routes: agentPromptRoutes({}, { spawn: claudeSpawn() }),
      tree: { kind: "agent", agent: "claude-cli" },
    });

    await executeWorkflow({
      bundle: loadBundle(files, "say"),
      inputs: {},
      registry: newRegistry(),
      prompt,
      session: { sessions: records, records },
    });

    expect(records.at("#i1", 0)?.externalId).toBe("sess-abc");
  });
});
