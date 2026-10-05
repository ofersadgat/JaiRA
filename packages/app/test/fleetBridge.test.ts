/**
 * A phone's window onto every machine it is paired with (decision 0015, amended 2026-10-04): machines
 * of one fleet answer through one of them, machines of different fleets are each asked, their lists
 * merged and every other request sent where what it names is.
 */
import { describe, expect, it } from "vitest";
import type { JairaBridge, PushMessage } from "@jaira/shared/browser";
import { answeringOf, fleetBridge, fleetsOf, mergeLists, type FleetMember } from "../../client/bridges/fleetBridge";

/** A machine's engine that answers from a table, and records what it was asked. */
function engine(answers: Record<string, unknown>): JairaBridge & { asked: string[]; push: (m: PushMessage) => void } {
  const listeners = new Set<(m: PushMessage) => void>();
  const asked: string[] = [];
  return {
    asked,
    invoke: (async (channel: string) => {
      asked.push(channel);
      if (!(channel in answers)) throw new Error(`${channel}: not here`);
      return answers[channel];
    }) as JairaBridge["invoke"],
    subscribe: (on) => {
      listeners.add(on);
      return () => void listeners.delete(on);
    },
    push: (m) => listeners.forEach((on) => on(m)),
  };
}
const member = (id: string, bridge: JairaBridge, connected = true, fleet?: string[]): FleetMember => ({ id, bridge, connected, ...(fleet !== undefined ? { fleet: new Set(fleet) } : {}) });

describe("fleets", () => {
  const b = engine({});
  it("are machines whose fleets share a machine", () => {
    const groups = fleetsOf([member("a", b, true, ["a", "b"]), member("c", b, true, ["c"]), member("b", b, true, ["b", "a"])]);
    expect(groups.map((g) => g.map((m) => m.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("join when a later machine's fleet bridges two", () => {
    const groups = fleetsOf([member("a", b, true, ["a"]), member("c", b, true, ["c"]), member("x", b, true, ["x", "a", "c"])]);
    expect(groups.map((g) => g.map((m) => m.id).sort())).toEqual([["a", "c", "x"]]);
  });
  it("answer through their first connected machine", () => {
    const answering = answeringOf([member("a", b, false, ["a", "b"]), member("b", b, true, ["a", "b"]), member("c", b, false, ["c"])]);
    expect(answering.map((m) => m.id)).toEqual(["b"]);
  });
  it("merge their lists, the shared root kept once", () => {
    expect(mergeLists("project:list", [[{ project: "shared" }, { project: "/a" }], [{ project: "shared" }, { project: "/c" }]])).toEqual([{ project: "shared" }, { project: "/a" }, { project: "/c" }]);
    expect(mergeLists("project:list", [[{ project: "/base-a", kind: "shared" }], [{ project: "/base-c", kind: "shared" }, { project: "/c", kind: "user" }]])).toEqual([{ project: "/base-a", kind: "shared" }, { project: "/c", kind: "user" }]);
    expect(mergeLists("interaction:pending", [[{ requestId: "1" }], [{ requestId: "2" }]])).toEqual([{ requestId: "1" }, { requestId: "2" }]);
  });
});

describe("the fleet bridge", () => {
  it("goes straight to the one fleet there is", async () => {
    const a = engine({ "project:list": [{ project: "/a" }], "board:view": { columns: [] } });
    const f = fleetBridge();
    f.setMembers([member("a", a)]);
    expect(await f.bridge.invoke("project:list", undefined as never)).toEqual([{ project: "/a" }]);
    expect(await f.bridge.invoke("board:view", { project: "/x" } as never)).toEqual({ columns: [] });
  });
  it("merges two fleets' lists and routes by what a request names", async () => {
    const a = engine({ "project:list": [{ project: "shared" }, { project: "/a" }], "interaction:pending": [{ requestId: "ra" }], "board:view": "a's board", "interaction:submit": "a answered" });
    const c = engine({ "project:list": [{ project: "shared" }, { project: "/c" }], "interaction:pending": [{ requestId: "rc" }], "board:view": "c's board", "interaction:submit": "c answered", "project:open": { dir: "/c" }, "settings:read": "c's settings" });
    const f = fleetBridge();
    f.setMembers([member("a", a, true, ["a"]), member("c", c, true, ["c"])]);
    expect(await f.bridge.invoke("project:list", undefined as never)).toEqual([{ project: "shared" }, { project: "/a" }, { project: "/c" }]);
    expect(await f.bridge.invoke("interaction:pending", undefined as never)).toEqual([{ requestId: "ra" }, { requestId: "rc" }]);
    expect(await f.bridge.invoke("board:view", { project: "/c" } as never)).toBe("c's board");
    expect(await f.bridge.invoke("board:view", { project: "/a" } as never)).toBe("a's board");
    expect(await f.bridge.invoke("interaction:submit", { requestId: "rc", value: 1 } as never)).toBe("c answered");
    // Opening a project makes its fleet the one a request naming nothing goes to.
    await f.bridge.invoke("project:open", { dir: "/c" } as never);
    expect(await f.bridge.invoke("settings:read", undefined as never)).toBe("c's settings");
  });
  it("uses one machine of a fleet, and the other when the first is gone", async () => {
    const a = engine({ "project:list": [{ project: "/a" }] });
    const b = engine({ "project:list": [{ project: "/a" }, { project: "/b" }] });
    const f = fleetBridge();
    f.setMembers([member("a", a, true, ["a", "b"]), member("b", b, true, ["a", "b"])]);
    expect(await f.bridge.invoke("project:list", undefined as never)).toEqual([{ project: "/a" }]);
    f.setMembers([member("a", a, false, ["a", "b"]), member("b", b, true, ["a", "b"])]);
    expect(await f.bridge.invoke("project:list", undefined as never)).toEqual([{ project: "/a" }, { project: "/b" }]);
  });
  it("holds what is asked while no machine answers, and asks once one does", async () => {
    const a = engine({ "project:list": [{ project: "/a" }] });
    const f = fleetBridge();
    const asked = f.bridge.invoke("project:list", undefined as never);
    f.setMembers([member("a", a, false)]);
    expect(a.asked).toEqual([]);
    f.setMembers([member("a", a, true)]);
    expect(await asked).toEqual([{ project: "/a" }]);
  });
  it("passes every answering machine's pushes on, and says to read again when the fleets change", () => {
    const a = engine({});
    const c = engine({});
    const f = fleetBridge();
    const heard: PushMessage[] = [];
    f.bridge.subscribe((m) => heard.push(m));
    f.setMembers([member("a", a, true, ["a"])]);
    const resyncs = heard.length;
    expect(resyncs).toBeGreaterThan(0);
    a.push({ type: "store:invalidate", scope: "tasks" } as PushMessage);
    c.push({ type: "store:invalidate", scope: "board" } as PushMessage);
    expect(heard.length).toBe(resyncs + 1);
    f.setMembers([member("a", a, true, ["a"]), member("c", c, true, ["c"])]);
    c.push({ type: "store:invalidate", scope: "board" } as PushMessage);
    expect(heard.length).toBeGreaterThan(resyncs + 2);
  });
});
