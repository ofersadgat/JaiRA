/**
 * Calls a tool made — `approve_tool_call` — as ordinary calls in the conversation's record.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, RecordStore } from "@declarative-ai/exec";
import { messagesOfRecord } from "@jaira/persistence";
import { approvalCallEntries, approvalResultEntries, callingCallOf, mergeHostCalls, withHostCalls } from "../src/hostCalls";
import { ApprovalHub } from "../src/approval";

const LINE = 'git fetch origin --quiet && echo "master=$(git rev-parse origin/master)"';
const bashCall = (id: string, command: string): JsonValue => ({ kind: "message", role: "assistant", content: [{ type: "tool_use", id, name: "mcp__dai__bash", input: { command } }] });
const bashResult = (id: string): JsonValue => ({ kind: "message", role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "master=490fb08" }] });
const answer = { decision: "allow" as const, scope: "once", by: "person" as const, waitedMs: 62_000 };

describe("the call that needs permission", () => {
  it("is the newest call whose input is the one the request carries — whatever the key order", () => {
    const streamed = [
      { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "mcp__dai__bash", input: { command: LINE } }] } },
      { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dai__bash", input: { cwd: "/r", command: LINE } }] } },
    ] as JsonValue[];
    expect(callingCallOf(streamed, { command: LINE, cwd: "/r" })).toBe("t1");
    expect(callingCallOf(streamed, { command: LINE })).toBe("t0");
    expect(callingCallOf(streamed, { command: "ls" })).toBeUndefined();
  });
});

describe("in the record", () => {
  const call = approvalCallEntries("approve_1", "t1", { tool: "bash", command: LINE, reason: "command substitution" }, 1000).record;
  const result = approvalResultEntries("approve_1", "t1", answer, 63_000).record;

  it("goes right after the call that made it, call then result, and leaves another record's for that one", () => {
    const entries = [bashCall("t1", LINE), bashResult("t1")];
    const other = approvalCallEntries("approve_2", "t9", { tool: "bash" }, 5).record;
    const merged = mergeHostCalls(entries, [call, result, other]);
    expect(merged.entries.map((e) => (e as { calledBy?: string; role: string }).calledBy ?? (e as { role: string }).role)).toEqual(["assistant", "t1", "t1", "user"]);
    expect(merged.left).toEqual([other]);
  });

  it("is a call with a result: named approve_tool_call, answered with the answer as its data", () => {
    expect(call).toMatchObject({ kind: "message", role: "assistant", calledBy: "t1", content: [{ type: "tool_use", id: "approve_1", name: "approve_tool_call", input: { tool: "bash", command: LINE } }], timing: { at: 1000 } });
    expect(result).toMatchObject({ role: "user", calledBy: "t1", content: [{ type: "tool_result", tool_use_id: "approve_1", content: "allowed", data: answer }] });
    const closed = approvalResultEntries("approve_1", "t1", { ...answer, decision: "deny", by: "closed" }, 2).record;
    expect(closed).toMatchObject({ content: [{ content: "not answered: the app closed" }] });
  });

  it("is never replayed to a model — the model made no such call", () => {
    const value = { value: { entries: mergeHostCalls([bashCall("t1", LINE), bashResult("t1")], [call, result]).entries } } as JsonValue;
    expect(messagesOfRecord(value)).toHaveLength(2);
  });

  it("is folded in when the record settles, and what it could not place is kept for the next", async () => {
    const finished: unknown[] = [];
    const inner = { append: (s: { id: string }) => ({ id: s.id }), finish: (_ref: unknown, settled: unknown) => void finished.push(settled) } as unknown as RecordStore;
    let waiting: JsonValue[] = [call, result, approvalCallEntries("approve_2", "t9", { tool: "bash" }, 5).record];
    const store = withHostCalls(
      inner,
      () => {
        const out = waiting;
        waiting = [];
        return out;
      },
      (left) => (waiting = [...left, ...waiting]),
    );
    await store.finish({ id: "r" }, { result: { value: { entries: [bashCall("t1", LINE), bashResult("t1")] } } } as never);
    const settled = finished[0] as { result: { value: { entries: JsonValue[] } } };
    expect(settled.result.value.entries).toHaveLength(4);
    expect(waiting).toHaveLength(1);
  });
});

describe("the one approval prompt, asked by a function", () => {
  it("parks on the same hub the policy does, says who asked, and answers the word", async () => {
    const asked: Array<{ asker?: string; command?: string; reason?: string }> = [];
    const answered: string[] = [];
    const hub = new ApprovalHub({ onRequest: (r) => asked.push(r), onResolved: (_id, decision, by) => answered.push(`${decision.decision} by ${by}`) });
    const pending = hub.askFor(
      { tool: "bash", subject: "git push", function: "smart", input: { command: "git push origin main" }, line: "git push origin main" },
      { taskId: "t1", prompt: "smart is unsure — allow this?" },
    );
    expect(asked).toEqual([expect.objectContaining({ asker: "smart", command: "git push origin main", reason: "smart is unsure — allow this?" })]);
    hub.decide(hub.list()[0]!.requestId, "allow");
    expect(await pending).toBe("allow");
    // Nobody answered this one: the app closed under it, and the record says so.
    const later = hub.askFor({ tool: "bash", subject: "bash", function: "smart", input: { command: "ls" } }, { taskId: "t1" });
    hub.denyAll();
    expect(await later).toBe("deny");
    expect(answered).toEqual(["allow by person", "deny by closed"]);
  });
});
