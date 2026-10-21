/**
 * A cut call, continued from its own record rather than made again (`withContinuation`).
 *
 * What it changes about a re-dispatch, and only that: the message it is made with (the note), the
 * provider conversation it resumes (the cut call's own), and the history a transport that replays is
 * handed (the conversation before the call, the call's own turns, and a result for every call in them
 * that never got one). A dispatch that is not a continuation passes through untouched.
 */
import { describe, expect, it } from "vitest";
import { resolveSessionRef, type ExecServices, type Executor, type InlineFamily, type Operation, type ResolvedSession } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { CONTINUE_NOTE, approvalNote, answersNote, closeDanglingCalls, withContinuation, type ContinuationPorts } from "../src/continuation";

/** An executor that only remembers what it was asked. */
function recorder(): { executor: Executor<ExecServices, WorkflowMetrics>; seen: Array<{ op: Operation<InlineFamily>; session?: ResolvedSession<JsonValue> }> } {
  const seen: Array<{ op: Operation<InlineFamily>; session?: ResolvedSession<JsonValue> }> = [];
  const executor = {
    capabilities: {},
    metrics: {},
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      seen.push({ op, ...(ctx.session !== undefined ? { session: ctx.session as ResolvedSession<JsonValue> } : {}) });
      return { events: (async function* () {})(), result: Promise.resolve({ value: "ok", metrics: { durationMs: 0 } }), cancel: async () => {} };
    },
  } as unknown as Executor<ExecServices, WorkflowMetrics>;
  return { executor, seen };
}

const position = (providerSessionId?: string): ResolvedSession<JsonValue> =>
  resolveSessionRef<JsonValue>("s1@3", {
    mode: "append",
    at: { id: "s1", seq: 3 },
    ...(providerSessionId !== undefined ? { providerSessionId, provider: "claude-cli" } : {}),
    seed: "state:s1",
    messages: async () => [{ role: "user", content: "earlier" }] as JsonValue[],
  });

const op = { kind: "prompt", user: "do the thing", output: { name: "output", kind: "text" } } as unknown as Operation<InlineFamily>;

describe("a dispatch that continues nothing", () => {
  it("passes through untouched", () => {
    const { executor, seen } = recorder();
    const ports: ContinuationPorts = { continuationAt: () => undefined, noteContinuation: () => undefined };
    const session = position("H");
    void withContinuation(executor, ports).start(op, { session } as ExecServices);
    expect(seen[0]!.op).toBe(op);
    expect(seen[0]!.session).toBe(session);
  });
});

describe("a dispatch that continues a cut call", () => {
  const cut = {
    recordId: "r1",
    entries: [] as JsonValue[],
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dai__shell", input: { command: "git push" } }] },
    ] as JsonValue[],
    providerSessionId: "OWN",
  };

  it("is made with the note, written into its record, and resumes the call's own provider conversation", async () => {
    const { executor, seen } = recorder();
    const noted: Array<[string, string]> = [];
    const ports: ContinuationPorts = {
      continuationAt: (at) => (at.id === "s1" && at.seq === 3 ? cut : undefined),
      noteContinuation: (recordId, text) => noted.push([recordId, text]),
      noteFor: (recordId) => (recordId === "r1" ? "they allowed it" : undefined),
    };
    void withContinuation(executor, ports).start(op, { session: position("BEFORE") } as ExecServices);
    expect((seen[0]!.op as { user: string }).user).toBe("they allowed it");
    expect(noted).toEqual([["r1", "they allowed it"]]);
    const session = seen[0]!.session!;
    expect(session.id).toBe("s1@3");
    expect(session.at).toEqual({ id: "s1", seq: 3 });
    expect(session.mode).toBe("append");
    expect(session.providerSessionId).toBe("OWN");
    // The position's provider named the position's own handle — not this one.
    expect(session.provider).toBeUndefined();
    // Replayed: the conversation before the call, the call's own turns, and a result for the call cut off.
    const replayed = await session.messages();
    expect(replayed).toEqual([
      { role: "user", content: "earlier" },
      ...cut.messages,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: expect.stringContaining("the app was closed") as never, is_error: true }] },
    ]);
  });

  it("carries on with the plain note when the person was asked nothing since, and keeps the position's handle when it is the call's", () => {
    const { executor, seen } = recorder();
    const ports: ContinuationPorts = { continuationAt: () => ({ ...cut, providerSessionId: "H" }), noteContinuation: () => undefined };
    void withContinuation(executor, ports).start(op, { session: position("H") } as ExecServices);
    expect((seen[0]!.op as { user: string }).user).toBe(CONTINUE_NOTE);
    expect(seen[0]!.session!.providerSessionId).toBe("H");
    expect(seen[0]!.session!.provider).toBe("claude-cli");
  });

  it("leaves an op that is not a prompt to be dispatched as it was", () => {
    const { executor, seen } = recorder();
    const noted: string[] = [];
    const ports: ContinuationPorts = { continuationAt: () => cut, noteContinuation: (id) => noted.push(id) };
    const fn = { kind: "function", function: "run_command", args: {} } as unknown as Operation<InlineFamily>;
    void withContinuation(executor, ports).start(fn, { session: position("H") } as ExecServices);
    expect(seen[0]!.op).toBe(fn);
    expect(noted).toEqual([]);
  });
});

describe("a replayed conversation", () => {
  it("answers every call left without a result, in the shape its message was made in", () => {
    const sdk = { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "shell", input: {} }] } as JsonValue;
    const answered = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "y", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "done" }] },
    ] as JsonValue[];
    const closed = closeDanglingCalls([...answered, sdk]);
    expect(closed).toHaveLength(5);
    expect(closed[1]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: true }] });
    expect(closed[4]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "shell", output: { type: "error-text" } }] });
  });
});

describe("the note", () => {
  it("tells the model what the person answered since, and what to do about it", () => {
    expect(approvalNote("shell", "git push", "allow")).toMatch(/waited for the person's permission, so it did not run\. They have since allowed it: make the same call again/);
    expect(approvalNote("shell", "git push", "deny")).toMatch(/They have since denied it: do not make it/);
    expect(answersNote({ "Which?": ["a", "b"] })).toMatch(/They have since answered:\n- Which\? → a, b/);
    expect(answersNote(undefined)).toMatch(/left it to you/);
  });
});
