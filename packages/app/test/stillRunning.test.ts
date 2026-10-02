/**
 * "Still running" is said only of what IS still running (the person, 2026-09-25: "it is very important
 * that 'still running' is accurate everywhere it appears").
 *
 * A call with no answer is one of two facts: still running (the record is still being written and the
 * call is in its last stretch), or never answered (the record went on, or ended, without one). A chat
 * whose last turn ended on an unanswered `bash` call pulsed "Running git fetch…" for good — so every
 * place the transcript says something is live now asks the same question, and only the caller (a
 * chat's task status) or the record's own status can answer it.
 *
 * The rule is `stillRunning.ts`'s, with the two readings made over it: a call's row (`toolLineOf`) and
 * the status bar (`liveStatusOf`). The components that draw them hold none of it.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, SessionView } from "@jaira/shared/browser";
import { stepTookOf } from "../src/renderer/panelViewsModel";
import { inLastStretch, openBlockOf, partHoldsEnd, sidechainWorkingOf, thoughtLiveOf, writingOf } from "../src/renderer/stillRunning";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";
import { blocksOf, entriesOfPart, liveStatusOf } from "../src/renderer/transcript";
import { toolLineOf } from "../src/renderer/transcriptRows";

const t0 = Date.parse("2026-09-25T17:42:08Z");
const unanswered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git fetch origin", args: { command: "git fetch origin" }, at: t0 };
const answered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git status", args: { command: "git status" }, at: t0 - 1000, ok: true, result: "clean" };
const ask: TranscriptEntry = { kind: "message", role: "user", text: "check the branches" };
const reply: TranscriptEntry = { kind: "message", role: "assistant", text: "Done." };

/**
 * The call's row, as `toolLineOf` says it. `open` is the transcript's to say — the call's stretch is
 * the last thing in a record still being written — and the row's words follow from it: `running` is
 * the "still running" under the row, and the mark `cut` is the dash that reads "No result was recorded".
 */
const rowOf = (entry: TranscriptEntry, open: boolean) => toolLineOf(entry as ToolEntry, open, false);

/** Whether the block an entry stands in is the one in progress, as the transcript asks it of each block. */
const openAt = (entries: TranscriptEntry[], entry: TranscriptEntry, writing: boolean): boolean => {
  const blocks = blocksOf(entries);
  const at = blocks.findIndex((block) => block.kind === "work" && block.entries.includes(entry as never));
  return openBlockOf(writing, at, blocks.length);
};

describe("a call with no answer", () => {
  it("is marked as never answered when the record is not being written", () => {
    expect(rowOf(unanswered, false)).toMatchObject({ unanswered: true, running: false, mark: "cut" });
    expect(openAt([ask, unanswered], unanswered, writingOf(undefined, null))).toBe(false);
  });

  it("is still running while the record is being written and it is in the last stretch", () => {
    expect(openAt([ask, unanswered], unanswered, writingOf(true, null))).toBe(true);
    expect(rowOf(unanswered, true)).toMatchObject({ unanswered: true, running: true, mark: "waiting" });
    // A call that answered is neither, wherever its stretch is.
    expect(rowOf(answered, true)).toMatchObject({ unanswered: false, running: false, mark: "ok" });
    expect(rowOf(answered, false)).toMatchObject({ unanswered: false, running: false, mark: "ok" });
  });

  it("is never answered once a message has come after it, even while the record is being written", () => {
    // The turn went on: a later message means this call's stretch is over, answered or not.
    const entries = [ask, unanswered, reply, ask];
    expect(openAt(entries, unanswered, true)).toBe(false);
    expect(inLastStretch(entries, 1)).toBe(false);
    expect(inLastStretch([ask, unanswered], 1)).toBe(true);
    // An answer being written after it ends its stretch too.
    expect(inLastStretch([ask, unanswered, { kind: "live", text: "Half an ans" }], 1)).toBe(false);
  });

  it("reads the record's own status when the caller says nothing", () => {
    expect(writingOf(undefined, { status: "running" })).toBe(true);
    expect(writingOf(undefined, { status: "success" })).toBe(false);
    expect(writingOf(undefined, { status: "interrupted" })).toBe(false);
    // A record that says nothing about itself is not being written.
    expect(writingOf(undefined, {})).toBe(false);
    expect(writingOf(undefined, null)).toBe(false);
    // What the caller says wins: a chat's finished turn in a record whose status is stale, and the reverse.
    expect(writingOf(false, { status: "running" })).toBe(false);
    expect(writingOf(true, { status: "success" })).toBe(true);
  });
});

describe("the other things that say they are live", () => {
  it("counts a thought up only while the record is being written", () => {
    const thinking = { kind: "thought", text: "", live: true, startedAt: t0 } as const;
    expect(thoughtLiveOf(thinking, false)).toBe(false);
    expect(thoughtLiveOf(thinking, true)).toBe(true);
    // A status line saying it elsewhere takes the counter off the row.
    expect(thoughtLiveOf(thinking, true, true)).toBe(false);
    // A thought that ended is never live.
    expect(thoughtLiveOf({ live: false }, true)).toBe(false);
    expect(thoughtLiveOf({}, true)).toBe(false);
  });

  it("says a call being written, and an answer being written, only of the block in progress", () => {
    const writing: TranscriptEntry = { kind: "writing", name: "Write", path: "page.html", chars: 2048 };
    // "writing 2 KB" while open; "stopped while being written" otherwise (`WorkRows.tsx` draws either by this).
    expect(openAt([ask, writing], writing, false)).toBe(false);
    expect(openAt([ask, writing], writing, true)).toBe(true);
    // Only the LAST block is ever open.
    expect(openBlockOf(true, 0, 2)).toBe(false);
    expect(openBlockOf(true, 1, 2)).toBe(true);
    expect(openBlockOf(false, 1, 2)).toBe(false);
  });
});

describe("a record drawn in parts", () => {
  // A note cut the turn at the call `c2`: the transcript through it, a band, then the rest.
  const call = (id: string, done: boolean): TranscriptEntry => ({ kind: "tool", name: "Bash", summary: id, callId: id, at: t0, ...(done ? { ok: true, result: "ok" } : {}) });
  const entries = [ask, call("c1", true), call("c2", true), call("c3", false)];

  it("is in progress only in the part that reaches the record's end", () => {
    const first = { through: "c2" };
    const rest = { after: "c2" };
    expect(entriesOfPart(entries, first)).toHaveLength(3);
    expect(entriesOfPart(entries, rest)).toHaveLength(1);
    // The first part's work is over, whatever the record's status: its last block was drawn "working".
    expect(partHoldsEnd(entries, first)).toBe(false);
    expect(partHoldsEnd(entries, rest)).toBe(true);
    // A record in one piece holds its own end.
    expect(partHoldsEnd(entries, undefined)).toBe(true);
  });

  it("is the first part's while the cut's call is the last thing the record holds", () => {
    // The call that moved the run is still waiting on where it went: nothing was drawn after it.
    const waiting = [ask, call("c1", true), call("c2", false)];
    expect(partHoldsEnd(waiting, { through: "c2" })).toBe(true);
    // And while the record does not hold the cut's call yet, the part runs to the end (as `entriesOfPart` takes it).
    expect(partHoldsEnd([ask, call("c1", false)], { through: "c2" })).toBe(true);
  });
});

describe("a subagent's conversation", () => {
  const turn = (parts: unknown[]) => ({ role: "assistant", parts });
  const spawn = (id: string) => ({ type: "tool_use", id, name: "Task", input: { prompt: "explore" } });
  const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "found it" });
  const host = (turns: unknown[], sidechains: Record<string, unknown[]>, status: SessionView["status"] = "running"): SessionView =>
    ({ taskId: "t", instanceId: "2", stateId: "plan", sessionId: "#i2", seq: 0, status, turns, sidechains }) as unknown as SessionView;
  const said = [{ role: "assistant", text: "looking", parts: [{ type: "text", text: "looking" }] }];

  it("is still being written exactly while the call that spawned it is still running", () => {
    const going = host([turn([spawn("task1")])], { task1: said });
    expect(sidechainWorkingOf(going, "task1", null, true)).toBe(true);
    // The subagent answered and the host went on: the host is still running, the subagent is not.
    const answeredHost = host([turn([spawn("task1")]), { role: "user", parts: [result("task1")] }, turn([{ type: "tool_use", id: "next", name: "Bash", input: { command: "ls" } }])], { task1: said });
    expect(sidechainWorkingOf(answeredHost, "task1", null, true)).toBe(false);
    // The host's record is over: nothing in it is running, answered or not.
    expect(sidechainWorkingOf(host([turn([spawn("task1")])], { task1: said }, "interrupted"), "task1", null, false)).toBe(false);
  });

  it("is not, once the host said something after a call that never answered", () => {
    const wentOn = host([turn([spawn("task1")]), { role: "assistant", text: "Moving on.", parts: [{ type: "text", text: "Moving on." }] }], { task1: said });
    expect(sidechainWorkingOf(wentOn, "task1", null, true)).toBe(false);
  });

  it("follows a nested call through the chain it was made in", () => {
    const nested = host([turn([spawn("outer")])], { outer: [turn([spawn("inner")])], inner: said });
    expect(sidechainWorkingOf(nested, "inner", null, true)).toBe(true);
    // The outer subagent answered: what it spawned is over with it.
    const outerDone = host([turn([spawn("outer")]), { role: "user", parts: [result("outer")] }], { outer: [turn([spawn("inner")])], inner: said });
    expect(sidechainWorkingOf(outerDone, "inner", null, true)).toBe(false);
  });

  it("is, for a call the record does not hold yet, only while its chain is streaming by", () => {
    const streaming = { text: "", sidechains: { live1: [] } };
    expect(sidechainWorkingOf(null, "live1", streaming, true)).toBe(true);
    expect(sidechainWorkingOf(null, "live1", null, true)).toBe(false);
    expect(sidechainWorkingOf(host([], {}), "gone", null, true)).toBe(false);
  });
});

describe("how long a step took", () => {
  const node = (patch: Partial<InstanceNode>): InstanceNode => ({ instanceId: "1", stateId: "plan", status: "completed", index: 0, superseded: false, startedAt: t0, children: [], ...patch }) as InstanceNode;

  it("is its duration once it ended", () => {
    expect(stepTookOf(node({ endedAt: t0 + 192_000 }), t0 + 900_000)).toBe("3m 12s");
  });

  it("is how long so far, only for a step whose status says it is still going", () => {
    expect(stepTookOf(node({ status: "running" }), t0 + 65_000)).toBe("1m 5s so far");
    expect(stepTookOf(node({ status: "waiting_for_user" }), t0 + 65_000)).toBe("1m 5s so far");
  });

  it("does not grow with the clock for a step that ended without its end being written", () => {
    // Stopped, or the app closed: no end was recorded, and nothing is running.
    for (const status of ["interrupted", "failed", "cancelled", "completed"] as const) {
      expect(stepTookOf(node({ status: status as never }), t0 + 65_000)).toBe("not recorded");
      expect(stepTookOf(node({ status: status as never }), t0 + 9_000_000)).toBe("not recorded");
    }
    // A superseded step is not going either, whatever its status still says.
    expect(stepTookOf(node({ status: "running", superseded: true }), t0 + 65_000)).toBe("not recorded");
  });
});

describe("the status bar", () => {
  it("does not name a call from an earlier turn that never answered", () => {
    // Running, a new turn has started and made no call yet: the old unanswered call is not what it is doing.
    expect(liveStatusOf([ask, unanswered, reply, ask], null, true)).toEqual({ kind: "working" });
    // The current turn's own unanswered call is.
    expect(liveStatusOf([ask, unanswered], null, true)).toMatchObject({ kind: "running", summary: "git fetch origin" });
  });
});
