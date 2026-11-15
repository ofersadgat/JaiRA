/**
 * A conversation's agents as lanes (`agentRail.ts`): which wait and which run in the background, where a
 * background agent crosses over (the conversation waits for it) or comes back (its notification), and
 * which gutter column each left lane takes.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { agentIdOf, agentRailOf, gutterOf, leftLaneXOf, notifiedCallOf, trunkXOf, waitedAgentOf } from "../src/renderer/agentRail";
import type { EventEntry, MessageEntry, ToolEntry, TranscriptEntry } from "../src/renderer/transcript";

const tool = (callId: string, name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ kind: "tool", name, summary: "", callId, ...extra }) as ToolEntry;
const said = (text: string): MessageEntry => ({ kind: "message", role: "assistant", text }) as MessageEntry;
const launched = (id: string): JsonValue => [{ type: "text", text: `Async agent launched successfully.\nagentId: ${id} (internal ID - do not mention to user.)` }] as unknown as JsonValue;
const agent = (call: string, extra: Partial<ToolEntry> = {}): ToolEntry => tool(call, "Agent", { sidechain: call, args: { description: call }, ...extra });
const notified = (call: string): EventEntry => ({ kind: "event", tone: "plain", text: "system: task_notification", detail: { type: "system", subtype: "task_notification", tool_use_id: call, status: "completed" } });
const waits = (id: string, extra: Record<string, unknown> = {}): ToolEntry => tool(`w_${id}`, "TaskOutput", { args: { task_id: id, block: true, timeout: 600000, ...extra } });

describe("reading the record", () => {
  it("finds the agent id a background call's note names", () => {
    expect(agentIdOf(launched("a3fb691e81b1a7512"))).toBe("a3fb691e81b1a7512");
    expect(agentIdOf("the agent's report")).toBeUndefined();
  });
  it("takes a blocking TaskOutput as waiting, and a non-blocking one as not", () => {
    expect(waitedAgentOf(waits("a1"))).toBe("a1");
    expect(waitedAgentOf(waits("a1", { block: false }))).toBeUndefined();
    expect(waitedAgentOf(tool("x", "TaskOutput", { args: { task_id: "a1" } }))).toBe("a1");
  });
  it("reads the call a task_notification reports", () => {
    expect(notifiedCallOf(notified("c1"))).toBe("c1");
    expect(notifiedCallOf(said("hello"))).toBeUndefined();
  });
});

describe("an agent's lane", () => {
  it("is waited for when its call answered with the agent's report", () => {
    const rail = agentRailOf([said("handing it over"), agent("c1", { result: "done", ok: true })]);
    expect(rail.lanes).toEqual([{ call: "c1", background: false, fork: 1, column: 0 }]);
    expect(rail.columns).toBe(0);
  });

  it("runs in the background from the launch note to its notification", () => {
    const entries: TranscriptEntry[] = [agent("c1", { result: launched("a1") }), said("meanwhile"), notified("c1"), said("it is back")];
    const rail = agentRailOf(entries);
    expect(rail.lanes[0]).toMatchObject({ call: "c1", agentId: "a1", background: true, fork: 0, back: 2, column: 1 });
    expect(rail.marks.get(entries[2]!)).toMatchObject({ mark: "back" });
    expect(rail.columns).toBe(1);
  });

  it("crosses over where the conversation waits for it, and then has no return of its own", () => {
    const entries: TranscriptEntry[] = [agent("c1", { result: launched("a1") }), said("meanwhile"), waits("a1"), notified("c1")];
    const lane = agentRailOf(entries).lanes[0]!;
    expect(lane.cross).toBe(2);
    expect(lane.back).toBeUndefined();
  });

  it("counts a call that asked for the background as background before any answer", () => {
    expect(agentRailOf([agent("c1", { args: { description: "x", run_in_background: true } })], new Set(["c1"])).lanes[0]).toMatchObject({ background: true, column: 1 });
  });

  it("draws no left lane for a background agent the record never saw end, unless it still runs", () => {
    const entries = [agent("c1", { result: launched("a1") }), said("then nothing")];
    expect(agentRailOf(entries).lanes[0]!.column).toBe(0);
    expect(agentRailOf(entries, new Set(["c1"])).lanes[0]!.column).toBe(1);
  });

  it("leaves out the calls a tool made (an approval's own call)", () => {
    expect(agentRailOf([tool("approve_x", "approve_tool_call", { sidechain: "s", calledBy: "c" })]).lanes).toEqual([]);
  });
});

describe("left columns", () => {
  it("gives two agents running at once two columns, and reuses a column once its lane ended", () => {
    const entries: TranscriptEntry[] = [
      agent("c1", { result: launched("a1") }),
      agent("c2", { result: launched("a2") }),
      notified("c1"),
      agent("c3", { result: launched("a3") }),
      notified("c2"),
      notified("c3"),
    ];
    const rail = agentRailOf(entries);
    expect(rail.lanes.map((lane) => lane.column)).toEqual([1, 2, 1]);
    expect(rail.columns).toBe(2);
  });

  it("puts the trunk past the left columns, each column 18 out from it", () => {
    expect(gutterOf(0)).toBe(20);
    expect(gutterOf(2)).toBe(56);
    expect(trunkXOf(2)).toBe(45);
    expect(leftLaneXOf(2, 1)).toBe(27);
    expect(leftLaneXOf(2, 2)).toBe(9);
  });
});
