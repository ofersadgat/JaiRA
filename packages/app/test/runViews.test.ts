/**
 * Reading a composite's instance tree: which pass am I looking at, and what ran under it.
 *
 * These two decide whether a loop is legible. A board column used to hold one card per TASK, so a
 * state that ran three times showed one card and there was no way to reach the other two passes.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode } from "@jaira/shared/browser";
import { instanceOf, runsByChild } from "../src/renderer/runViews";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  iteration: 0,
  superseded: false,
  startedAt: patch.instanceId * 10,
  children: [],
  ...patch,
});

describe("instanceOf", () => {
  const tree = [
    node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "plan/draft", childKey: "draft" }),
        node({ instanceId: 3, stateId: "plan/draft", childKey: "draft" }),
      ],
    }),
  ];

  it("finds a state anywhere in the tree, not only at the root", () => {
    expect(instanceOf(tree, "plan/draft")?.instanceId).toBe(3);
  });

  it("resolves a re-entered state to its LATEST pass, whose children are the ones on screen", () => {
    const looped = [node({ instanceId: 1, stateId: "plan", startedAt: 5 }), node({ instanceId: 4, stateId: "plan", startedAt: 90 })];
    expect(instanceOf(looped, "plan")?.instanceId).toBe(4);
  });

  it("skips a superseded pass — a sequence reset disowned its children", () => {
    const reset = [
      node({ instanceId: 1, stateId: "plan", startedAt: 5 }),
      node({ instanceId: 4, stateId: "plan", startedAt: 90, superseded: true }),
    ];
    expect(instanceOf(reset, "plan")?.instanceId).toBe(1);
  });

  it("answers nothing for a state this run never entered", () => {
    expect(instanceOf(tree, "plan/nowhere")).toBeUndefined();
  });
});

describe("runsByChild", () => {
  const parent = node({
    instanceId: 1,
    stateId: "plan",
    children: [
      node({ instanceId: 4, stateId: "plan/draft", childKey: "draft", startedAt: 40 }),
      node({ instanceId: 2, stateId: "plan/goals", childKey: "goals", startedAt: 20 }),
      node({ instanceId: 3, stateId: "plan/draft", childKey: "draft", startedAt: 30 }),
    ],
  });

  it("gives a column every execution of that child, not just the last", () => {
    // The whole of item 4: three passes are three things that happened, and one card cannot be
    // clicked into three different transcripts.
    expect(runsByChild(parent).get("draft")?.map((n) => n.instanceId)).toEqual([3, 4]);
  });

  it("orders a column oldest first, so a retry reads downward as the story it is", () => {
    expect(runsByChild(parent).get("draft")?.map((n) => n.startedAt)).toEqual([30, 40]);
  });

  it("keys by the child KEY, since one state can be mounted under several", () => {
    const twice = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "plan/review", childKey: "first" }),
        node({ instanceId: 3, stateId: "plan/review", childKey: "second" }),
      ],
    });
    expect([...runsByChild(twice).keys()]).toEqual(["first", "second"]);
  });

  it("is empty for a run that has entered nothing yet", () => {
    expect(runsByChild(undefined).size).toBe(0);
  });
});
