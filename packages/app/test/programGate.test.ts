/**
 * A program's gate (decision 0033): `choose_option` called by a script runs as a call state (`call_6`)
 * whose function the shape cannot name before it runs, so the projection marks it a plain call. The
 * person, 2026-11-24: "I see the choose option tool, but no UI". With the task's gate pending, that open
 * call is where the gate is drawn.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode } from "@jaira/shared";
import { askingInstanceOf, hasAsking, isAsking } from "../src/renderer/stateSurfaceModel";

const node = (instanceId: string, extra: Partial<InstanceNode> = {}): InstanceNode =>
  ({ instanceId, stateId: `improve/lesson/${instanceId}`, status: "running", index: 0, superseded: false, startedAt: 1, children: [], ...extra }) as InstanceNode;

const done = node("call_5", { status: "completed", operation: { kind: "function", status: "completed" }, plainCall: true } as Partial<InstanceNode>);
const open = node("call_6", { operation: { kind: "function", status: "running" }, plainCall: true } as Partial<InstanceNode>);
const root = node("root", { operation: { kind: "function", status: "completed" }, plainCall: true, children: [done, open] } as Partial<InstanceNode>);

describe("a program's open call", () => {
  it("is not asking anyone on its own — the shape says it is a call", () => {
    expect(isAsking(open)).toBe(false);
    expect(askingInstanceOf([root])).toBeUndefined();
  });

  it("is where the gate is drawn once the task's gate is pending", () => {
    expect(isAsking(open, true)).toBe(true);
    expect(isAsking(done, true)).toBe(false);
    expect(hasAsking(root, true)).toBe(true);
    expect(askingInstanceOf([root], true)).toBe("call_6");
  });

  it("leaves a gate the shape knows as it was", () => {
    const gate = node("gate", { operation: { kind: "function", status: "running" } } as Partial<InstanceNode>);
    expect(isAsking(gate)).toBe(true);
    expect(isAsking(gate, true)).toBe(true);
  });
});

describe("a run drawn as rows (the person, 2026-11-24: \"the task view should try to mirror the conversation view\")", () => {
  it("is any script's — a conversation that waits on input(), or a workflow whose call states carry their site", async () => {
    const { isProgramRun } = await import("../src/renderer/programCalls");
    const call = (key: string, site?: string): InstanceNode =>
      ({ ...node(key), stateId: `improve/lesson/${key}`, calls: [{ operationId: `op-${key}`, kind: "function", ...(site !== undefined ? { site } : {}) }] }) as InstanceNode;
    const script = { ...node("root"), stateId: "improve/lesson", children: [call("call_0", "abc#0")] } as InstanceNode;
    const classic = { ...node("root"), stateId: "feature", children: [{ ...call("ui"), stateId: "feature/ui" } as InstanceNode] } as InstanceNode;
    expect(isProgramRun({ instances: [script] })).toBe(true);
    expect(isProgramRun({ instances: [classic] })).toBe(false);
    expect(isProgramRun({ program: true, instances: [classic] })).toBe(true);
    expect(isProgramRun({ instances: [] })).toBe(false);
  });
});

describe("the row a program's gate is asked at", () => {
  // The person, 2026-11-24: "ok, now its rendering 6 times" — every start of the app asked the parked
  // question again on the same state, leaving a record each; only the newest is asking.
  it("is the asking state's newest call, never an earlier attempt at it", async () => {
    const { askingCallIdOf } = await import("../src/renderer/programCalls");
    const asked = node("call_10", {
      operation: { kind: "function", status: "running" },
      plainCall: true,
      calls: [
        { operationId: "first", kind: "function" },
        { operationId: "again", kind: "function" },
        { operationId: "newest", kind: "function" },
      ],
    } as Partial<InstanceNode>);
    const run = node("root", { operation: { kind: "function", status: "completed" }, plainCall: true, children: [done, asked] } as Partial<InstanceNode>);
    expect(askingCallIdOf([run])).toBe("program:call_10#newest");
    expect(askingCallIdOf([done])).toBeUndefined();
  });
});
