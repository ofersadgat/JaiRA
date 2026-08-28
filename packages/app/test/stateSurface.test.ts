/**
 * What a state IS, and how loudly its header says so — see `stateSurface.tsx`.
 *
 * Both answers are LOOKUPS against fields the projection already writes, and that is the whole point
 * of testing them together: the kind and the tone are read off the same node, so a change that makes
 * one of them guess would have to make the other disagree with it.
 *
 * `projection.ts` sets `node.operation` on `operation.started` and on nothing else. So an instance
 * that dispatched always has one, an instance that did not never does, and every claim below is a
 * fact rather than an inference from an absence.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode } from "@jaira/shared/browser";
import { advanceTargetOf, failureWordOf, headerToneOf, surfaceKindOf } from "../src/renderer/stateSurface";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

describe("what a state is", () => {
  it("calls a prompt operation a conversation", () => {
    const said = node({ instanceId: 3, stateId: "product/context", operation: { kind: "prompt", status: "completed" } });
    expect(surfaceKindOf(said)).toBe("conversation");
  });

  it("calls a state with no operation at all `computed`", () => {
    // `explore/verdict` and `product/confidence` in the feature workflow: every output is an
    // expression over values the state was handed, so there is no model and no host function.
    expect(surfaceKindOf(node({ instanceId: 9, stateId: "explore/verdict" }))).toBe("computed");
  });

  it("calls a function operation `asked`", () => {
    // `product/gate` — a component was mounted and a person was asked. It is the case that read
    // worst under the old sentence: twenty-seven seconds of somebody's attention, reported as
    // silence.
    const gate = node({ instanceId: 25, stateId: "product/gate", operation: { kind: "function", status: "running" } });
    expect(surfaceKindOf(gate)).toBe("asked");
  });

  it("still calls it `asked` when the call failed or was canceled", () => {
    // What a state IS does not change with how it ended. The outcome belongs to the TONE, which is
    // the other half of this file.
    const canceled = node({
      instanceId: 25,
      stateId: "product/gate",
      status: "canceled",
      operation: { kind: "function", status: "failed", reason: "the operation was canceled" },
    });
    expect(surfaceKindOf(canceled)).toBe("asked");
  });

  it("leaves a composite alone even when it ALSO ran an operation of its own", () => {
    // A state can both delegate and speak. Its children are what make it a composite, so the children
    // are what the check reads first — testing the operation first would take a composite whose own
    // op was a function and hide its whole subtree behind one heading.
    const both = node({
      instanceId: 2,
      stateId: "feature/product",
      operation: { kind: "function", status: "completed" },
      children: [node({ instanceId: 3, stateId: "feature/product/context" })],
    });
    expect(surfaceKindOf(both)).toBeUndefined();
  });

  it("never answers `waiting`, because a parked transition is not an instance", () => {
    // `projection.ts` sets `waiting_for_user` for an interactive operation AND for a guard's
    // `call.waiting`, so the two are indistinguishable once projected. Reading it here would make an
    // asked state and a parked transition the same thing; the wait is named by a `UserEventRequest`.
    const parked = node({
      instanceId: 2,
      stateId: "feature/product",
      status: "waiting_for_user",
      operation: { kind: "prompt", status: "running" },
    });
    expect(surfaceKindOf(parked)).toBe("conversation");
  });
});

/**
 * How loud the header is — the title block, which is a STATE and never a preference.
 *
 * An earlier revision made this an Appearance setting. A preference that can switch a settled
 * computation into the loud form is a preference for lying about the run, so it is derived: running,
 * asked, waiting or broken, and back to a letterhead the moment the state settles.
 */
describe("how loudly a header speaks", () => {
  it("is quiet for anything that has settled", () => {
    const done = node({
      instanceId: 3,
      stateId: "s",
      endedAt: 10,
      operation: { kind: "prompt", status: "completed" },
    });
    expect(headerToneOf(done, "conversation")).toBeUndefined();
  });

  it("goes red when the call failed, whichever way it failed", () => {
    const threw = node({
      instanceId: 3,
      stateId: "s",
      status: "failed",
      endedAt: 10,
      operation: { kind: "function", status: "failed", reason: "Cannot read properties of undefined" },
    });
    expect(headerToneOf(threw, "asked")).toBe("red");
    expect(failureWordOf(threw)).toBe("function threw");

    const errored = node({
      instanceId: 3,
      stateId: "s",
      endedAt: 10,
      operation: { kind: "prompt", status: "failed", reason: "no API key" },
    });
    expect(headerToneOf(errored, "conversation")).toBe("red");
    expect(failureWordOf(errored)).toBe("call failed");
  });

  it("stays quiet for a CANCELLATION, which is somebody pressing Stop", () => {
    // Nothing went wrong. A red bar over it would be the run accusing the person who stopped it.
    const stopped = node({ instanceId: 3, stateId: "s", status: "canceled", endedAt: 10, operation: { kind: "prompt", status: "running" } });
    expect(headerToneOf(stopped, "conversation")).toBeUndefined();
  });

  it("reads the INSTANCE before the operation, which is what run 11 needs", () => {
    // Run 11's gate dispatched and was then canceled with the run: `operation.status` is still
    // `running` because no completion ever landed, while the instance is `canceled`. Reading the
    // operation first would draw that as a live question somebody could still answer.
    const gate = node({
      instanceId: 25,
      stateId: "product/gate",
      status: "canceled",
      endedAt: 27_200,
      operation: { kind: "function", status: "running" },
    });
    expect(headerToneOf(gate, "asked")).toBeUndefined();
  });

  it("is accent while a state is still asking, or still writing", () => {
    const asking = node({ instanceId: 25, stateId: "gate", status: "waiting_for_user", operation: { kind: "function", status: "running" } });
    expect(headerToneOf(asking, "asked")).toBe("accent");

    const writing = node({ instanceId: 3, stateId: "s", status: "running", operation: { kind: "prompt", status: "running" } });
    expect(headerToneOf(writing, "conversation")).toBe("accent");
  });

  it("is quiet for a computation, however recently it ran", () => {
    // The one that makes the loud form mean something. A computation is a fact about the run, not a
    // demand on the reader — and a 5 ms state that shouted would make the tint noise.
    const computed = node({ instanceId: 24, stateId: "confidence", endedAt: 5 });
    expect(headerToneOf(computed, "computed")).toBeUndefined();
  });
});

/**
 * A transition parked on a gesture — the case that was rendered nowhere.
 *
 * It is tested HERE rather than beside the panels because the claim is about where the fact comes
 * from, not about the drawing: a wait is not an instance, so nothing on the tree can answer it and
 * the hub's request has to.
 */
describe("what a wait is read from", () => {
  it("cannot be read off the instance, because two different things set the same status", () => {
    // `projection.ts` sets `waiting_for_user` for an interactive OPERATION and for a guard's
    // `call.waiting`. A state holding a question out to you and a transition parked on a drag are
    // the same value once projected — so the surface kind stays what the operation says it is, and
    // the wait is named by a `UserEventRequest` instead.
    const asking = node({
      instanceId: 25,
      stateId: "product/gate",
      status: "waiting_for_user",
      operation: { kind: "function", status: "running" },
    });
    const parked = node({
      instanceId: 2,
      stateId: "feature/product",
      status: "waiting_for_user",
      operation: { kind: "prompt", status: "running" },
    });
    // Indistinguishable by status; told apart by what they ran.
    expect(asking.status).toBe(parked.status);
    expect(surfaceKindOf(asking)).toBe("asked");
    expect(surfaceKindOf(parked)).toBe("conversation");
  });
});

/**
 * Where a wait says the task should go.
 *
 * The one real rule in the waiting surface, and it is a read rather than a derivation: the hub fills
 * `to_state` in from the rule's own `to` when the author left it out, so the request already knows.
 */
describe("what a wait offers", () => {
  it("takes the destination from the request, not from the workflow file", () => {
    expect(advanceTargetOf({ options: { to_state: "ux" } })).toBe("ux");
  });

  it("offers nothing when no gesture could satisfy the rule", () => {
    // A rule going to a `terminate.*` pseudo-state ends the run rather than moving the task, so the
    // hub declines to name a column (`optionsOf` in `userEvents.ts`). A button offered anyway would
    // promise a move nothing can make.
    expect(advanceTargetOf({ options: {} })).toBeUndefined();
    expect(advanceTargetOf({ options: { to_state: "" } })).toBeUndefined();
    expect(advanceTargetOf({ options: { to_state: 3 } })).toBeUndefined();
  });
});
