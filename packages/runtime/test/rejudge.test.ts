/**
 * A parked call decided again when the permissions change while it waits (decision 0023, 2026-11-03):
 * allowed or refused by the new stack without anybody, or still a question with its rows redrawn — and
 * an answer given "for this run" deciding the task's other parked calls.
 */
import { describe, expect, it } from "vitest";
import { parsePermissionSet, type PermissionSet } from "@jaira/shared";
import { ApprovalHub, type ApprovalAnsweredBy, type ApprovalRequest } from "../src/approval";
import { compilePolicy } from "../src/policy";
import { gateTools } from "../src/tools";
import { newRegistry } from "../src/wiring";

function rig(first: Record<string, unknown>) {
  let set: PermissionSet = parsePermissionSet(first).permissionSet;
  const requests: ApprovalRequest[] = [];
  const updated: ApprovalRequest[] = [];
  const resolved: Array<{ requestId: string; decision: string; by: ApprovalAnsweredBy }> = [];
  const hub = new ApprovalHub({
    onRequest: (request) => requests.push(request),
    onUpdated: (request) => updated.push(request),
    onResolved: (requestId, decision, by) => resolved.push({ requestId, decision: decision.decision, by }),
  });
  const policy = compilePolicy({}, { permissionSet: set, grants: hub.grants("t") });
  const { gate, authored } = gateTools({ registry: newRegistry(), names: [], sessionId: "s1", policy, approve: hub.approver({ taskId: "t" }), permissionSet: () => set });
  hub.judgeWith("t", () => ({ policy, block: authored() }));
  const call = (command: string) => gate.check({ name: "shell" }, { command });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { hub, requests, updated, resolved, call, settle, swap: (next: Record<string, unknown>) => (set = parsePermissionSet(next).permissionSet) };
}

const rows = (request: ApprovalRequest | undefined) => request?.parts?.parts.map((part) => `${part.subject}:${part.verdict}`);

describe("rejudge", () => {
  it("allows a parked call the new stack allows, answered by the permissions", async () => {
    const r = rig({ shell: "ask", "frob build": "ask", other: "deny" });
    const waiting = r.call("frob build");
    await r.settle();
    expect(rows(r.requests[0])).toEqual(["frob build:asks"]);
    r.swap({ shell: "ask", "frob build": "allow", other: "deny" });
    await r.hub.rejudge("t");
    expect((await waiting).allow).toBe(true);
    expect(r.resolved).toEqual([{ requestId: r.requests[0]!.requestId, decision: "allow", by: "permissions" }]);
    expect(r.hub.list()).toEqual([]);
  });

  it("refuses one the new stack denies, and the agent is told it was the permission set", async () => {
    const r = rig({ shell: "ask", "frob build": "ask", other: "deny" });
    const waiting = r.call("frob build");
    await r.settle();
    r.swap({ shell: "ask", "frob build": "deny", other: "deny" });
    await r.hub.rejudge("t");
    const verdict = await waiting;
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false ? verdict.reason : "").toContain("permission set denies");
    expect(r.resolved[0]).toMatchObject({ decision: "deny", by: "permissions" });
  });

  it("keeps a call that still asks, its rows as the new stack judges them", async () => {
    const r = rig({ shell: "ask", "frob build": "ask", "frob test": "ask", other: "deny" });
    const waiting = r.call("frob build && frob test");
    await r.settle();
    expect(rows(r.requests[0])).toEqual(["frob build:asks", "frob test:asks"]);
    r.swap({ shell: "ask", "frob build": "allow", "frob test": "ask", other: "deny" });
    await r.hub.rejudge("t");
    expect(r.resolved).toEqual([]);
    expect(r.updated.map((each) => each.requestId)).toEqual([r.requests[0]!.requestId]);
    expect(rows(r.hub.list()[0])).toEqual(["frob build:allowed", "frob test:asks"]);
    // Unchanged when decided again under the same stack: nothing is drawn again.
    await r.hub.rejudge("t");
    expect(r.updated).toHaveLength(1);
    r.hub.decide(r.requests[0]!.requestId, "allow");
    expect((await waiting).allow).toBe(true);
  });

  it("decides the task's other parked calls when one is answered for this run", async () => {
    const r = rig({ shell: "ask", "frob build": "ask", other: "deny" });
    const first = r.call("frob build");
    const second = r.call("frob build");
    await r.settle();
    expect(r.requests).toHaveLength(2);
    r.hub.decide(r.requests[0]!.requestId, "allow", "once", []);
    await r.settle();
    expect((await first).allow).toBe(true);
    expect((await second).allow).toBe(true);
    expect(r.resolved.map((each) => each.by)).toEqual(["person", "permissions"]);
  });

  it("leaves a call no judge speaks for as it was", async () => {
    const r = rig({ shell: "ask", "frob build": "ask", other: "deny" });
    void r.call("frob build");
    await r.settle();
    r.swap({ shell: "ask", "frob build": "allow", other: "deny" });
    await r.hub.rejudge("another task");
    expect(r.hub.list()).toHaveLength(1);
  });
});
