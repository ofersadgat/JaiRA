/**
 * A run a conversation started (the chat-started workflow mockups, 2026-10-25): which runs are the
 * conversation's children, whether the conversation itself is answering, what it all waits on, how a
 * wait reads from where you stand, and how many words a row of pills can afford.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, PendingApproval, PendingInteraction, PendingQuestion } from "@jaira/shared/browser";
import {
  childRunFor,
  childRunsOf,
  conversationAnswering,
  fitPills,
  keysTo,
  openingRunAnswering,
  pillWidth,
  runningStepOf,
  scopedWaits,
  secondLine,
  stepsIn,
  waitCountsByLevel,
  waitsOf,
  type RunWait,
} from "../src/renderer/childRunModel";

const T = 1_000_000;
function node(id: string, stateId: string, status: InstanceNode["status"], children: InstanceNode[] = [], extra: Partial<InstanceNode> = {}): InstanceNode {
  return { instanceId: id, stateId, childKey: stateId.split("/").pop()!, status, index: 0, superseded: false, startedAt: T, children, ...extra } as InstanceNode;
}
const done = (id: string, stateId: string): InstanceNode => node(id, stateId, "completed", [], { endedAt: T + 1, operation: { kind: "prompt", status: "completed" } });

/** The person's task as it stood: a chat whose `start_task` entered `feature`, parked on `answer`. */
const answer = node("answer", "feature/product/answer", "waiting_for_user", [], { operation: { kind: "function", status: "running" }, startedAt: T + 500 });
const feature = node("feature", "feature", "running", [node("product", "feature/product", "running", [done("context", "feature/product/context"), done("draft", "feature/product/draft"), answer])]);
const root = node("root", "chat/session", "running", [feature], { operation: { kind: "prompt", status: "completed" } });
const instances = [root];

const gate = { requestId: "g", taskId: "t", project: "p", component: "choose_option", inputs: {}, config: { component: "choose_option", questions: [{}, {}, {}, {}, {}] } } as unknown as PendingInteraction;

describe("the runs a conversation started", () => {
  it("are its root's children that are not its own states", () => {
    expect(childRunsOf(instances).map((n) => n.instanceId)).toEqual(["feature"]);
    expect(childRunsOf([node("r", "feature", "running", [feature])])).toEqual([]);
    expect(childRunsOf(undefined)).toEqual([]);
  });
  it("are found from the outcome a workflow tool left", () => {
    expect(childRunFor(instances, { verb: "entered", standsAt: "feature" })?.instanceId).toBe("feature");
    expect(childRunFor(instances, { verb: "entered", standsAt: "feature/product" })?.instanceId).toBe("feature");
    expect(childRunFor(instances, { verb: "entered", standsAt: "sync" })).toBeUndefined();
  });
});

describe("whether the conversation itself is answering", () => {
  it("is not, while only a run it started holds the task — nor the record its gate keeps open", () => {
    expect(conversationAnswering(instances, true, 0)).toBe(false);
    expect(conversationAnswering(instances, true, 1)).toBe(false);
  });
  it("is, while one of its turns is, or its opening run is", () => {
    const turn = node("chat:root", "chat/session", "running", [], { operation: { kind: "prompt", status: "running" } });
    expect(conversationAnswering([{ ...root, children: [turn, feature] }], true, 1)).toBe(true);
    const between = node("chat:root", "chat/session", "completed", [], { endedAt: T + 2, operation: { kind: "prompt", status: "completed" } });
    expect(conversationAnswering([{ ...root, children: [between, feature] }], true, 1)).toBe(false);
    const opening = [{ ...root, operation: { kind: "prompt" as const, status: "running" as const } }];
    expect(conversationAnswering(opening, true, 0)).toBe(true);
    expect(conversationAnswering([node("r", "chat/session", "running")], true, 0)).toBe(true);
    expect(conversationAnswering(instances, false, 0)).toBe(false);
  });
  it("takes the index's open record as its own once the run it started has ended", () => {
    const ended = { ...feature, status: "completed" as const, endedAt: T + 3 };
    expect(conversationAnswering([{ ...root, status: "completed" as const, children: [ended] }], false, 1)).toBe(true);
  });
  it("stops the opening run only while that run, not a run it started, holds the task", () => {
    expect(openingRunAnswering(instances, true)).toBe(false);
    expect(openingRunAnswering([{ ...root, operation: { kind: "prompt" as const, status: "running" as const } }], true)).toBe(true);
    expect(openingRunAnswering([node("r", "chat/session", "running")], true)).toBe(true);
  });
});

describe("what it waits on", () => {
  it("is each run's asking step, with its path, the gate's questions and since when", () => {
    expect(waitsOf({ instances, gate })).toEqual([{ instanceId: "answer", path: ["feature", "product"], step: "answer", kind: "ask", note: "5 questions", since: T + 500 }]);
  });
  it("places an agent's approval in the run its instance is in, else in the conversation", () => {
    const inRun = { requestId: "a", tool: "shell", command: "git push origin x", instanceId: "draft", at: T + 9 } as unknown as PendingApproval;
    const own = { requestId: "b", tool: "web_fetch", instanceId: "chat:root", at: T + 7 } as unknown as PendingApproval;
    expect(waitsOf({ instances, approval: inRun }).find((w) => w.instanceId === "draft")).toEqual({ instanceId: "draft", path: ["feature", "product", "draft"], step: "git push", verb: "approve", kind: "approve", note: "a shell command", since: T + 9 });
    expect(waitsOf({ instances, approval: own }).find((w) => w.instanceId === "chat:root")).toMatchObject({ path: [], step: "web_fetch", verb: "approve" });
  });
  it("counts an agent's questions", () => {
    const q = { requestId: "q", questions: [{}], instanceId: "chat:root", at: T } as unknown as PendingQuestion;
    expect(waitsOf({ instances, question: q }).find((w) => w.instanceId === "chat:root")).toMatchObject({ path: [], step: "answer", note: "1 question" });
  });
});

const waits: RunWait[] = [
  { instanceId: "answer", path: ["feature", "product"], step: "answer", kind: "ask", note: "5 questions", since: T },
  { instanceId: "impl", path: ["feature", "implementation"], step: "git push", verb: "approve", kind: "approve", note: "a shell command", since: T },
  { instanceId: "chat", path: [], step: "shell", verb: "approve", kind: "approve", since: T },
];

describe("from where you stand", () => {
  it("in the conversation, every wait", () => {
    expect(scopedWaits(waits, [])).toEqual(waits);
  });
  it("walked into a run, only its own, their paths from inside it", () => {
    expect(scopedWaits(waits, ["feature"]).map((w) => [w.step, w.path])).toEqual([
      ["answer", ["product"]],
      ["git push", ["implementation"]],
    ]);
  });
  it("counts each crumb's level the way the sidebar does, a level including what is inside it", () => {
    expect(waitCountsByLevel(waits, ["feature"])).toEqual([3, 2]);
    expect(waitCountsByLevel(waits, [])).toEqual([3]);
  });
});

describe("a pill's second line", () => {
  const clock = (): string => "9:37 PM";
  it("says less as the level drops", () => {
    expect(secondLine(waits[0]!, 4, clock)).toBe("in feature › product · 5 questions · 9:37 PM");
    expect(secondLine(waits[0]!, 3, clock)).toBe("in product · 5 questions");
    expect(secondLine(waits[0]!, 2, clock)).toBe("5 questions");
    expect(secondLine(waits[0]!, 1, clock)).toBe("");
  });
  it("names the conversation for its own wait", () => {
    expect(secondLine(waits[2]!, 3, clock)).toBe("in this conversation");
  });
});

describe("fitting the pills", () => {
  it("keeps every word when there is room, and drops them together as the room shrinks", () => {
    const wide = fitPills(waits, 2000);
    expect(wide).toEqual({ level: 4, shown: 3 });
    const levels = [900, 700, 500, 300].map((room) => fitPills(waits, room).level);
    expect([...levels].sort((a, b) => b - a)).toEqual(levels);
    expect(pillWidth(waits[0]!, 1)).toBeLessThan(pillWidth(waits[0]!, 4));
  });
  it("shows what fits at the least and counts the rest", () => {
    const tight = fitPills(waits, 260);
    expect(tight.level).toBe(0);
    expect(tight.shown).toBeLessThan(3);
    expect(fitPills(waits, 0).shown).toBe(0);
  });
});

describe("the run's own words", () => {
  it("name the step it is working on, and count its steps", () => {
    const working = node("f", "feature", "running", [node("p", "feature/product", "running", [done("c", "feature/product/context"), node("x", "feature/product/explore", "running", [node("cand", "feature/product/explore/candidates", "running", [], { startedAt: T + 3 })])])]);
    expect(runningStepOf(working)).toEqual({ instanceId: "cand", path: ["feature", "product", "explore"], step: "candidates", since: T + 3 });
    expect(runningStepOf(feature)).toBeUndefined();
    expect(stepsIn(feature)).toBe(3);
    expect(keysTo(instances, "answer")).toEqual(["session", "feature", "product", "answer"]);
  });
});
