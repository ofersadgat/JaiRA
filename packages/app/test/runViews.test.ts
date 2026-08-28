/**
 * Reading a composite's instance tree: which pass am I looking at, and what ran under it.
 *
 * These two decide whether a loop is legible. A board column used to hold one card per TASK, so a
 * state that ran three times showed one card and there was no way to reach the other two passes.
 */
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, type InstanceNode, type ResumePlan } from "@jaira/shared/browser";
import { instanceOf, runsByChild, stoppedAction } from "../src/renderer/runViews";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
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

/**
 * Which verb the activity strip offers, and why there are two.
 *
 * Both do the same thing to the engine; the words report how the run ENDED, which is not a
 * preference. A button that says "Resume" about a run with nothing live to pick up is the kind of
 * small lie this table exists to prevent — the same standard the pre-resume verbs were held to.
 */
describe("stoppedAction", () => {
  const plan = (over: Partial<ResumePlan>): ResumePlan => ({
    taskId: "t",
    kind: "none",
    replayed: 0,
    frontier: [],
    ...over,
  });

  it("says Resume where instances were still live", () => {
    const action = stoppedAction({
      status: "interrupted",
      resume: plan({ kind: "continue", replayed: 4, frontier: [{ stateId: "feature/build", stopped: "mid-operation" }] }),
    })!;
    expect(action.verb).toBe("Resume");
    expect(action.resume).toBe(true);
    // The hint names WHERE and HOW MUCH, because "resumes the run" is a claim anyone would believe
    // and neither number is one they could work out.
    expect(action.hint).toContain("build");
    expect(action.hint).toContain("4 operations");
  });

  it("says Retry where the run ended and nothing is live", () => {
    const action = stoppedAction({ status: "failed", resume: plan({ kind: "retry", replayed: 1 }) })!;
    expect(action.verb).toBe("Retry");
    expect(action.hint).toContain("state that failed");
    // Singular reads as singular. A hint that says "1 operations" is a hint nobody wrote.
    expect(action.hint).toContain("1 operation ");
  });

  it("falls back to the restart verbs when there is nothing to resume", () => {
    expect(stoppedAction({ status: "failed" })).toMatchObject({ verb: "Try again", resume: false });
    expect(stoppedAction({ status: "interrupted" })).toMatchObject({ verb: "Start again", resume: false });
    // Canceled never resumes: it ended on purpose, and its lifecycle is over either way.
    expect(stoppedAction({ status: "canceled" })).toMatchObject({ verb: "Run again", resume: false });
    expect(stoppedAction({ status: "queued" })).toMatchObject({ verb: "Start", resume: false });
  });

  it("says nothing at all for a run that finished or is still going", () => {
    expect(stoppedAction({ status: "completed" })).toBeUndefined();
    expect(stoppedAction({ status: "running" })).toBeUndefined();
  });

  it("explains a record it cannot read, rather than silently dropping the button", () => {
    // The person deciding what to do next is owed the reason: a task whose history has a hole in it
    // can still be started over, and that is a different decision from "resume is just missing".
    const action = stoppedAction({ status: "failed", resume: plan({ blocked: "no record for design's operation" }) })!;
    expect(action.verb).toBe("Try again");
    expect(action.hint).toContain("resuming is unavailable: no record for design's operation");
  });
});

/**
 * The bridge carries every channel the contract declares.
 *
 * `IPC_CHANNELS` is a second statement of `IpcContract` — the preload whitelist and the handler
 * registration both need values, and a type is not one — so the two can disagree, and did:
 * `task:resume` shipped in the contract and not in the list, which meant no handler was registered
 * and the preload refused the call as "not part of the IPC contract". The compiler catches that
 * now; this catches it in the form a reader recognises, and names the channels that were missed.
 */
describe("the IPC channel list", () => {
  it("carries the resume channels", () => {
    for (const channel of ["task:resume", "task:resumable"] as const) {
      expect(IPC_CHANNELS).toContain(channel);
    }
  });

  it("has no duplicates, since it becomes a Set the bridge trusts", () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  });
});
