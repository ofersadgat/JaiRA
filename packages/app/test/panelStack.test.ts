import { describe, expect, it } from "vitest";
import {
  EMPTY_STACK,
  acceptOffer,
  close,
  pin,
  pop,
  popTo,
  push,
  reconcile,
  selectStep,
  setTab,
  type PanelEntry,
  type PanelStack,
} from "../src/renderer/panelStack";
import { labelPlan } from "../src/renderer/panelTabs";

const task = (taskId: string, tab: "conversation" | "steps" = "conversation"): PanelEntry => ({ kind: "task", key: `task:${taskId}`, taskId, tab });
const state = (stateId: string): PanelEntry => ({ kind: "state", key: `state:${stateId}`, stateId, project: null, tab: "run" });
const config = (stateId: string): PanelEntry => ({ kind: "config", key: `config:${stateId}`, stateId });

const on = (stack: PanelStack, rule: PanelEntry | null): PanelStack => reconcile(stack, rule);

describe("the panel stack", () => {
  it("opens on the room's root and replaces it when the room stands on something else", () => {
    const a = on(EMPTY_STACK, task("t1"));
    expect(a.entries.map((e) => e.key)).toEqual(["task:t1"]);
    const b = on(push(a, config("plan/critique")), task("t2"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t2"]);
    expect(b.motion).toBe("replace");
  });

  it("keeps the person's tab and the pushed entries while the root is the same", () => {
    const a = setTab(on(EMPTY_STACK, task("t1")), "steps");
    const b = push(a, config("plan/critique"));
    const c = on(b, task("t1"));
    expect(c).toBe(b);
    expect(c.entries[0]).toMatchObject({ tab: "steps" });
  });

  it("lets the rule force a tab — a gate arriving takes the task to its conversation", () => {
    const a = push(setTab(on(EMPTY_STACK, task("t1")), "steps"), config("x"));
    const b = reconcile(a, task("t1"), { tab: "conversation" });
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ tab: "conversation" });
    expect(b.motion).toBe("tab");
  });

  it("pinned, a new root waits on the offer and the stack stays", () => {
    const a = pin(push(on(EMPTY_STACK, task("t1")), config("x")), true);
    const b = on(a, task("t2"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t1", "config:x"]);
    expect(b.offer?.key).toBe("task:t2");
    const c = acceptOffer(b);
    expect(c.entries.map((e) => e.key)).toEqual(["task:t2"]);
    expect(c.pinned).toBe(false);
  });

  it("pinned, the stack survives the room having nothing to show", () => {
    const a = pin(on(EMPTY_STACK, task("t1")), true);
    expect(on(a, null).entries).toHaveLength(1);
    expect(on(on(EMPTY_STACK, task("t1")), null).entries).toHaveLength(0);
  });

  it("pops one level, or back to a crumb, and never pops the root", () => {
    const a = push(push(on(EMPTY_STACK, task("t1")), state("plan")), config("plan"));
    expect(pop(a).entries.map((e) => e.key)).toEqual(["task:t1", "state:plan"]);
    expect(popTo(a, 0).entries.map((e) => e.key)).toEqual(["task:t1"]);
    expect(pop(pop(pop(a))).entries).toHaveLength(1);
    expect(pop(a).motion).toBe("pop");
  });

  it("pushing something already lower down pops back to it instead of looping", () => {
    const a = push(push(on(EMPTY_STACK, task("t1")), state("plan")), config("plan"));
    const b = push(a, state("plan"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t1", "state:plan"]);
  });

  it("a tab chosen on a root the stack has moved past pops back to it", () => {
    const a = push(on(EMPTY_STACK, task("t1")), config("x"));
    const b = setTab(a, "steps");
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ tab: "steps" });
    expect(b.motion).toBe("pop");
  });

  it("selecting a step opens Steps with that step, and closing it keeps Steps", () => {
    const a = selectStep(on(EMPTY_STACK, task("t1")), "i-critique");
    expect(a.entries[0]).toMatchObject({ tab: "steps", step: "i-critique" });
    const b = selectStep(a, undefined);
    expect(b.entries[0]).toMatchObject({ tab: "steps" });
    expect("step" in b.entries[0]!).toBe(false);
  });

  it("closed stays closed on the same root, and reopens for a new one", () => {
    const a = close(on(EMPTY_STACK, task("t1")));
    expect(on(a, task("t1")).entries).toHaveLength(0);
    expect(on(a, task("t2")).entries).toHaveLength(1);
  });
});

describe("tab labels", () => {
  const tabs = [
    { bare: 40, label: 90 },
    { bare: 36, label: 40 },
    { bare: 36, label: 60 },
    { bare: 36, label: 55 },
    { bare: 30, label: 100 },
  ];
  it("labels the open tab first, then from the left, while they fit", () => {
    expect(labelPlan(tabs, 2, 178 + 60)).toEqual([false, false, true, false, false]);
    expect(labelPlan(tabs, 2, 178 + 60 + 90)).toEqual([true, false, true, false, false]);
    expect(labelPlan(tabs, 2, 178 + 60 + 90 + 40)).toEqual([true, true, true, false, false]);
  });
  it("stops at the first label that does not fit rather than skipping to a shorter one", () => {
    const three = [
      { bare: 10, label: 10 },
      { bare: 10, label: 50 },
      { bare: 10, label: 5 },
    ];
    expect(labelPlan(three, 0, 30 + 10 + 20)).toEqual([true, false, false]);
  });
  it("labels nothing when even the open tab's label does not fit", () => {
    expect(labelPlan(tabs, 4, 178 + 50)).toEqual([false, false, false, false, false]);
  });
});
