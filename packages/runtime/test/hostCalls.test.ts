/**
 * Calls a tool made — `approve_tool_call` — as ordinary calls in the conversation's record.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue, RecordStore } from "@declarative-ai/exec";
import { messagesOfRecord } from "@jaira/persistence";
import { approvalCallEntries, approvalResultEntries, callingCallOf, checkCallEntries, checkResultEntries, endedCallsOf, mergeHostCalls, questionResultEntries, rememberedAnswersOf, unansweredAsksOf, withHostCalls } from "../src/hostCalls";
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
  const call = approvalCallEntries("approve_1", "t1", { tool: "shell", command: LINE, reason: "command substitution" }, 1000).record;
  const result = approvalResultEntries("approve_1", "t1", answer, 63_000).record;

  it("goes right after the call that made it, call then result, and leaves another record's for that one", () => {
    const entries = [bashCall("t1", LINE), bashResult("t1")];
    const other = approvalCallEntries("approve_2", "t9", { tool: "shell" }, 5).record;
    const merged = mergeHostCalls(entries, [call, result, other]);
    expect(merged.entries.map((e) => (e as { calledBy?: string; role: string }).calledBy ?? (e as { role: string }).role)).toEqual(["assistant", "t1", "t1", "user"]);
    expect(merged.left).toEqual([other]);
  });

  it("is a call with a result: named approve_tool_call, answered with the answer as its data", () => {
    expect(call).toMatchObject({ kind: "message", role: "assistant", calledBy: "t1", content: [{ type: "tool_use", id: "approve_1", name: "approve_tool_call", input: { tool: "shell", command: LINE } }], timing: { at: 1000 } });
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
    let waiting: JsonValue[] = [call, result, approvalCallEntries("approve_2", "t9", { tool: "shell" }, 5).record];
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
      { tool: "shell", subject: "git push", function: "smart", input: { command: "git push origin main" }, line: "git push origin main" },
      { taskId: "t1", prompt: "smart is unsure — allow this?" },
    );
    expect(asked).toEqual([expect.objectContaining({ asker: "smart", command: "git push origin main", reason: "smart is unsure — allow this?" })]);
    hub.decide(hub.list()[0]!.requestId, "allow");
    expect(await pending).toBe("allow");
    // Nobody answered this one: the app closed under it, and the record says so.
    const later = hub.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: "ls" } }, { taskId: "t1" });
    hub.denyAll();
    expect(await later).toBe("deny");
    expect(answered).toEqual(["allow by person", "deny by closed"]);
  });

  it("is let go of as abandoned when the call that asked ends without it — and only once", async () => {
    const answered: string[] = [];
    const hub = new ApprovalHub({ onRequest: () => undefined, onResolved: (_id, decision, by) => answered.push(`${decision.decision} by ${by}`) });
    const pending = hub.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: "Get-Content a.jsonl" } }, { taskId: "t1", prompt: "smart is unsure" });
    const { requestId } = hub.list()[0]!;
    expect(hub.abandon(requestId)).toBe(true);
    expect(await pending).toBe("deny");
    expect(hub.list()).toEqual([]);
    expect(hub.abandon(requestId)).toBe(false);
    expect(answered).toEqual(["deny by abandoned"]);
    const words = approvalResultEntries("approve_1", "t1", { decision: "deny", scope: "once", by: "abandoned", waitedMs: 288_000 }, 2).record;
    expect(words).toMatchObject({ content: [{ content: "not answered: the call ended without it", data: { by: "abandoned" } }] });
  });
});

describe("a permission function asked about the call — `check_permission` (option B, 2026-10-24)", () => {
  it("is a call the call made, with what the function came to as its result's data — and never replayed to a model", () => {
    const call = checkCallEntries("check_1", "t1", { function: "smart", tool: "shell", subject: "shell", command: LINE, part: "git fetch origin --quiet" }, 1000);
    const unsure = checkResultEntries("check_1", "t1", { verdict: "unsure", reason: "pushes are irreversible", tookMs: 11_000 }, 12_000);
    expect(call.record).toMatchObject({ role: "assistant", calledBy: "t1", content: [{ type: "tool_use", id: "check_1", name: "check_permission", input: { function: "smart", tool: "shell", part: "git fetch origin --quiet" } }] });
    expect(unsure.record).toMatchObject({ role: "user", calledBy: "t1", content: [{ type: "tool_result", tool_use_id: "check_1", content: "unsure: put to the person", data: { verdict: "unsure", reason: "pushes are irreversible", tookMs: 11_000 } }] });
    expect(checkResultEntries("c", "t1", { verdict: "failed", reason: "the judge failed", tookMs: 1 }, 2).record).toMatchObject({ content: [{ content: "could not decide: the judge failed" }] });
    // Folded in right after the call it is about, before the approval it led to, and asked of nobody again.
    const approval = approvalCallEntries("approve_1", "t1", { tool: "shell", command: LINE, asker: "smart" }, 12_500).record;
    const merged = mergeHostCalls([bashCall("t1", LINE), bashResult("t1")], [call.record, unsure.record, approval]);
    expect(merged.entries.map((e) => (e as { content: Array<{ id?: string; tool_use_id?: string }> }).content[0]!.id ?? (e as { content: Array<{ tool_use_id?: string }> }).content[0]!.tool_use_id)).toEqual(["t1", "check_1", "check_1", "approve_1", "t1"]);
    expect(unansweredAsksOf([bashCall("t1", LINE), call.record])).toEqual([]);
    expect(messagesOfRecord({ value: { entries: merged.entries } } as JsonValue)).toHaveLength(2);
  });
});

describe("the calls an entry ends", () => {
  it("are the ids its tool results answer, streamed or recorded — and none for a call or a text", () => {
    const streamedResult = { kind: "message", role: "user", content: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "MCP server \"dai\" tool \"shell\" sent no response or progress for 300s; aborting." }] } } as JsonValue;
    expect(endedCallsOf(streamedResult)).toEqual(["t1"]);
    expect(endedCallsOf(bashResult("t2"))).toEqual(["t2"]);
    expect(endedCallsOf(bashCall("t3", "ls"))).toEqual([]);
    expect(endedCallsOf({ kind: "message", role: "assistant", content: "done" } as JsonValue)).toEqual([]);
    expect(endedCallsOf(undefined)).toEqual([]);
  });
});

describe("a question a cut record was left asking", () => {
  const caller = bashCall("t1", LINE);
  const call = approvalCallEntries("approve_1", "t1", { tool: "shell", command: LINE, parts: { line: LINE } as never }, 1000).record;

  it("is an approve_tool_call with no result, matched again by the input of the call that asked", () => {
    const [ask] = unansweredAsksOf([caller, call]);
    expect(ask).toMatchObject({ kind: "approval", callId: "approve_1", calledBy: "t1", request: { tool: "shell", command: LINE }, toolInput: { command: LINE }, at: 1000 });
  });

  it("is not one once it has a result — any result, a stop's included", () => {
    const stopped = approvalResultEntries("approve_1", "t1", { decision: "deny", scope: "once", by: "stopped", waitedMs: 5 }, 2000).record;
    expect(unansweredAsksOf([caller, call, stopped])).toEqual([]);
  });

  it("carries the tool's own input when the call that asked is not in the record beside it", () => {
    const alone = approvalCallEntries("approve_2", undefined, { tool: "write_file", input: { path: "a.txt" } }, 5).record;
    expect(unansweredAsksOf([alone])).toMatchObject([{ kind: "approval", callId: "approve_2", toolInput: { path: "a.txt" } }]);
  });

  it("is the agent's own AskUserQuestion with no result — of the main conversation, not a subagent's", () => {
    const asked = (id: string, sidechain?: object): JsonValue =>
      ({ kind: "message", role: "assistant", ...(sidechain ? { sidechain } : {}), content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [] }] } }] }) as JsonValue;
    const asks = unansweredAsksOf([asked("q1"), asked("q2", { id: "c", parentToolUseId: "c" })]);
    expect(asks).toEqual([{ kind: "question", toolUseId: "q1", input: { questions: [{ question: "Which?", options: [] }] } }]);
    const answered = questionResultEntries("q1", { answers: { "Which?": "this" } }, 3).record;
    expect(unansweredAsksOf([asked("q1"), answered])).toEqual([]);
    expect(answered).toMatchObject({ role: "user", provider: "jaira", content: [{ type: "tool_result", tool_use_id: "q1", content: "The person answered:\nWhich? → this", data: { by: "person" } }] });
  });

  it("is answered as stopped right after the agent's call when the run stops — a result the host gave the model's own call", () => {
    const asked = { kind: "message", role: "assistant", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] } as JsonValue;
    const stopped = questionResultEntries("q1", { stopped: true }, 9).record;
    const merged = mergeHostCalls([asked, bashCall("t2", "ls")], [stopped]);
    expect(merged.entries).toEqual([asked, stopped, bashCall("t2", "ls")]);
    expect(merged.left).toEqual([]);
  });
});

describe("what the person answered for this run, read back from the record", () => {
  it("is each answer the person gave with widths to remember, with the parts its call carried", () => {
    const parts = { line: "git push", parts: [] } as never;
    const call = approvalCallEntries("approve_1", "t1", { tool: "shell", command: "git push", parts }, 1).record;
    const remembered = approvalResultEntries("approve_1", "t1", { decision: "allow", scope: "workflow-run", remember: ["git"], by: "person", waitedMs: 1 }, 2).record;
    const once = approvalCallEntries("approve_2", "t2", { tool: "shell", command: "ls", parts }, 3).record;
    const onceAnswer = approvalResultEntries("approve_2", "t2", { decision: "allow", scope: "once", by: "person", waitedMs: 1 }, 4).record;
    expect(rememberedAnswersOf([call, remembered, once, onceAnswer])).toEqual([{ parts, decision: "allow", remember: ["git"] }]);
  });
});
