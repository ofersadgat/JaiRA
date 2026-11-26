/**
 * A conversation's subagents, drawn the way a run it started is (`subagentModel.ts`): which there are,
 * nested ones too; whether each still runs and on what; whose an approval is; and how the waits read
 * from inside one. The shape is t-wdxyhs1w6w's: a background agent that started the agent doing the work.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import type { RunWait } from "../src/renderer/childRunModel";
import { secondLine } from "../src/renderer/childRunModel";
import { subagentLineOf, chainScopedWaits, chainWaitCounts, endedAgentsOf, liveChainOfApproval, namesOf, subagentOfApproval, subagentOfCall, subagentsOf, withSubagentWaits } from "../src/renderer/subagentModel";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";

const tool = (callId: string, name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ kind: "tool", name, summary: "", callId, ...extra }) as ToolEntry;
const LAUNCHED = [{ type: "text", text: "Async agent launched successfully." }] as unknown as JsonValue;

const outer = tool("c_outer", "Agent", { sidechain: "c_outer", args: { description: "Quit dialog for running work", subagent_type: "claude" }, result: LAUNCHED, ok: true, at: 1000 });
const inner = tool("c_inner", "Agent", { sidechain: "c_inner", args: { description: "Build quit-with-running-work dialog", subagent_type: "general-purpose" }, at: 2000 });
const chains: Record<string, TranscriptEntry[]> = {
  c_outer: [tool("c_ts", "ToolSearch", { result: "ok", ok: true, at: 1500 }), inner],
  c_inner: [
    tool("c_grep", "mcp__dai__grep", { result: "found", ok: true, at: 3000 }),
    tool("c_shell", "mcp__dai__shell", { args: { command: "git grep -n quit" }, at: 4000 }),
    tool("approve_x_req1", "approve_tool_call", { calledBy: "c_shell", at: 4001 }),
  ],
};
const read = (call: string): TranscriptEntry[] => chains[call] ?? [];
const live = (answering: boolean, ended: string[] = []) =>
  subagentsOf({ entries: [outer], chainOf: read, streaming: new Set(["c_outer", "c_inner"]), ended: new Set(ended), answering });

describe("a conversation's subagents", () => {
  it("finds each, nested ones too, named by what their starter called them, with the chain down to it", () => {
    const subs = live(true);
    expect([...subs.keys()]).toEqual(["c_outer", "c_inner"]);
    expect(subs.get("c_inner")).toMatchObject({ chain: ["c_outer", "c_inner"], name: "Build quit-with-running-work dialog", kind: "general-purpose", startedAt: 2000, lastAt: 4001 });
    expect(namesOf(subs, ["c_outer", "c_inner"])).toEqual(["Quit dialog for running work", "Build quit-with-running-work dialog"]);
  });

  it("lasts until the last word of the subagents it started, as one waiting on its own subagent did", () => {
    expect(live(true).get("c_outer")!.lastAt).toBe(4001);
  });

  it("counts the calls made, and those of the subagents started, never an approval or a check", () => {
    const subs = live(true);
    expect(subs.get("c_inner")!.steps).toBe(2);
    expect(subs.get("c_outer")!.steps).toBe(2 + 2);
  });

  it("runs while the conversation is written, though a background agent's call was answered at once — and says on what, the deepest", () => {
    const subs = live(true);
    expect(subs.get("c_outer")!.running).toBe(true);
    expect(subs.get("c_outer")!.step).toMatchObject({ path: ["Build quit-with-running-work dialog"], call: "c_shell" });
    expect(subs.get("c_inner")!.step).toMatchObject({ path: [], call: "c_shell" });
  });

  it("has stopped once the stream says it ended, or when nothing is being written", () => {
    expect(live(true, ["c_outer"]).get("c_outer")!.running).toBe(false);
    expect(live(false).get("c_inner")!.running).toBe(false);
  });

  it("reads the ends off the live turn's task notifications", () => {
    const note = { kind: "event", event: { type: "provider_event", payload: { type: "system", subtype: "task_notification", tool_use_id: "c_inner", status: "completed" } } } as JsonValue;
    expect([...endedAgentsOf([note])]).toEqual(["c_inner"]);
  });
});

describe("a subagent's approval", () => {
  const subs = live(true);
  const own: RunWait = { instanceId: "root", path: [], step: "git grep", verb: "approve", kind: "approve", own: true, since: 4001 };

  it("is the deepest subagent's whose conversation holds the call", () => {
    expect(subagentOfApproval(subs, "req1")?.call).toBe("c_inner");
    expect(subagentOfApproval(subs, "other")).toBeUndefined();
  });

  it("is that subagent's wait, no longer the conversation's own, with the names down to it", () => {
    const [wait] = withSubagentWaits([own], subagentOfApproval(subs, "req1"), subs);
    expect(wait).toMatchObject({ path: ["Quit dialog for running work", "Build quit-with-running-work dialog"], chain: ["c_outer", "c_inner"] });
    expect(wait!.own).toBeUndefined();
  });

  it("is seen from inside the subagents it is in, its path from there, and not from inside another", () => {
    const waits = withSubagentWaits([own], subagentOfApproval(subs, "req1"), subs);
    expect(chainScopedWaits(waits, ["c_outer"])[0]!.path).toEqual(["Build quit-with-running-work dialog"]);
    expect(chainScopedWaits(waits, ["c_outer", "c_inner"])[0]!.path).toEqual([]);
    expect(chainScopedWaits(waits, ["c_other"])).toEqual([]);
    expect(chainWaitCounts(waits, ["c_outer", "c_inner"])).toEqual([1, 1, 1]);
    // Inside the one that asks it is here: the second line says what it holds, not "in this conversation".
    expect(secondLine({ ...chainScopedWaits(waits, ["c_outer", "c_inner"])[0]!, note: "a shell command" }, 4, () => "11:22 PM")).toBe("a shell command · 11:22 PM");
    // The conversation's own wait is outside every subagent.
    expect(chainScopedWaits([own], ["c_outer"])).toEqual([]);
  });

  it("a gate one of its tool calls asked is its wait too, found by the call", () => {
    const gateWait: RunWait = { instanceId: "", path: [], step: "Push main to GitHub?", kind: "ask", own: true, callId: "c_shell" };
    expect(subagentOfCall(subs, "c_shell")?.call).toBe("c_inner");
    expect(subagentOfCall(subs, "toolu_elsewhere")).toBeUndefined();
    const [wait, approve] = withSubagentWaits([gateWait, own], undefined, subs, subagentOfCall(subs, "c_shell"));
    expect(wait).toMatchObject({ path: ["Quit dialog for running work", "Build quit-with-running-work dialog"], chain: ["c_outer", "c_inner"], callId: "c_shell" });
    expect(wait!.own).toBeUndefined();
    // The approval stays the conversation's: no approval asker was named.
    expect(approve).toEqual(own);
  });

  it("is found from the live turn alone, followed out to the conversation, for the title bar", () => {
    const msg = (ids: string[]) => ({ kind: "message", role: "assistant", content: { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "x", input: {} })) } }) as JsonValue;
    const sidechains = { c_outer: [msg(["c_inner"])], c_inner: [msg(["c_shell"]), msg(["approve_x_req1"])] };
    expect(liveChainOfApproval(sidechains, "req1")).toEqual(["c_outer", "c_inner"]);
    expect(liveChainOfApproval(sidechains, "nope")).toBeUndefined();
  });
});

describe("a subagent read from its entries alone (a run's page, the Tasks view)", () => {
  const ask = tool("approve_x_req9", "approve_tool_call", { calledBy: "c_shell", args: { tool: "shell", command: "git grep -n quit" }, at: 4001 });
  const innerEntries: TranscriptEntry[] = [chains["c_inner"]![0]!, chains["c_inner"]![1]!, ask];
  const outerEntries = chains["c_outer"]!;
  const chainOf = (call: string): TranscriptEntry[] => (call === "c_inner" ? innerEntries : []);

  it("is named, counted and timed as the Chat view does, the subagents it started included", () => {
    const read = subagentLineOf(outer, outerEntries, chainOf, false)!;
    expect(read.sub).toMatchObject({ name: "Quit dialog for running work", kind: "claude", steps: 4, startedAt: 1000, lastAt: 4001, running: false });
    expect(read.waits).toEqual([]);
  });

  it("while it runs, waits for the approval a subagent it started asks, with the names down to it", () => {
    const read = subagentLineOf(outer, outerEntries, chainOf, true)!;
    expect(read.waits).toMatchObject([{ step: "git grep", verb: "approve", path: ["Build quit-with-running-work dialog"], note: "a shell command", since: 4001 }]);
    expect(read.sub.step).toMatchObject({ call: "c_shell", path: ["Build quit-with-running-work dialog"] });
  });

  it("is nothing for a call that started no subagent", () => {
    expect(subagentLineOf(tool("c_x", "Read"), [], undefined, false)).toBeUndefined();
  });
});
