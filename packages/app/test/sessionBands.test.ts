/**
 * The conversation grouped by SESSION rather than by state.
 *
 * The bug this closes: a composite with no operation of its own showed a transcript above its
 * children anyway, because `sessionView` falls back to the last conversation in the whole task when
 * asked about an instance that never spoke. A state with no operation is exactly that instance, so
 * the panel opened with an unrelated run's words. Nothing here can produce that any more — a piece
 * exists because an operation ran, and a composite that only orchestrates contributes none.
 *
 * The rest is the layout rule: vertical space is time. Overlapping calls share a band; a session
 * that appears in two bands was interrupted, and its halves carry the pause and resume marks.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, SessionRef } from "@jaira/shared/browser";
import { bandsOf, instancesOf, piecesOf } from "../src/renderer/sessionBands";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  iteration: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

/** A session row: `ref(instance, session, from, to)`. */
const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ runId: 1, instanceId, stateId: `s${instanceId}`, sessionId, seq: 0, startedAt, at }) as SessionRef;

/** A composite parent over leaves that ran between the given times. */
const tree = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: 1,
    stateId: "plan",
    startedAt: 0,
    children: kids.map((kid) =>
      node({ instanceId: kid.id, stateId: `s${kid.id}`, childKey: `k${kid.id}`, startedAt: kid.from, endedAt: kid.to }),
    ),
  });

/** `[["A", 2], ...]` — one entry per segment of each band, in order. */
const shape = (bands: ReturnType<typeof bandsOf>): Array<Array<[string, number]>> =>
  bands.map((band) => band.segments.map((s) => [s.sessionId ?? s.key, s.pieces.length] as [string, number]));

describe("piecesOf", () => {
  it("gives a composite with no operation nothing of its own — the bug", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const pieces = piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1);
    expect(pieces.map((p) => p.node.instanceId)).toEqual([2, 3]);
    expect(pieces.some((p) => p.node.instanceId === 1)).toBe(false);
  });

  it("includes the run's OWN operation when it has one", () => {
    const parent = tree([{ id: 2, from: 5, to: 10 }]);
    const pieces = piecesOf(parent, [ref(1, "A", 0, 20), ref(2, "B", 5, 10)], 1);
    expect(pieces.map((p) => [p.node.instanceId, p.sessionId])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("flattens the whole subtree, so a grandchild lands in the session it continued", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({
          instanceId: 2,
          stateId: "plan/mid",
          startedAt: 0,
          endedAt: 30,
          children: [node({ instanceId: 3, stateId: "plan/mid/leaf", startedAt: 5, endedAt: 25 })],
        }),
      ],
    });
    const pieces = piecesOf(parent, [ref(3, "A", 5, 25)], 1);
    expect(pieces.map((p) => p.node.instanceId)).toEqual([3]);
  });

  it("keeps a leaf that ran no model call — it happened, and a function op has no session", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const [piece] = piecesOf(parent, [], 1);
    expect(piece?.node.instanceId).toBe(2);
    expect(piece?.sessionId).toBeUndefined();
  });

  it("scopes the join to one run — instance ids restart, so #2 names one per run", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const older = { ...ref(2, "OLD", 0, 10), runId: 0 } as SessionRef;
    const pieces = piecesOf(parent, [older, ref(2, "A", 0, 10)], 1);
    expect(pieces.map((p) => p.sessionId)).toEqual(["A"]);
  });

  it("drops a pass a sequence reset disowned", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "s2", startedAt: 0, endedAt: 10, superseded: true }),
        node({ instanceId: 3, stateId: "s3", startedAt: 11, endedAt: 20 }),
      ],
    });
    expect(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1).map((p) => p.node.instanceId)).toEqual([3]);
  });

  it("prefers the operation's start over the instance's — they differ by a whole subtree", () => {
    const parent = tree([{ id: 2, from: 0, to: 100 }]);
    const [piece] = piecesOf(parent, [ref(2, "A", 90, 100)], 1);
    expect(piece?.startedAt).toBe(90);
  });
});

describe("bandsOf", () => {
  it("keeps a run of states in one session as ONE panel, with no pause invented", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20), ref(4, "A", 21, 30)], 1));
    expect(shape(bands)).toEqual([[["A", 3]]]);
    expect(bands[0]!.segments[0]!.paused).toBe(false);
    expect(bands[0]!.segments[0]!.resumed).toBe(false);
  });

  it("cuts a session in two when another one runs in the gap, and marks both edges", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30)], 1));
    expect(shape(bands)).toEqual([[["A", 1]], [["B", 1]], [["A", 1]]]);
    expect(bands[0]!.segments[0]).toMatchObject({ paused: true, resumed: false });
    expect(bands[1]!.segments[0]).toMatchObject({ paused: false, resumed: false });
    expect(bands[2]!.segments[0]).toMatchObject({ paused: false, resumed: true });
  });

  it("puts overlapping calls in one band, across rather than down", () => {
    const parent = tree([
      { id: 2, from: 0, to: 20 },
      { id: 3, from: 5, to: 25 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 20), ref(3, "B", 5, 25)], 1));
    expect(shape(bands)).toEqual([
      [
        ["A", 1],
        ["B", 1],
      ],
    ]);
  });

  it("does not call a concurrent session paused — it never stopped", () => {
    const parent = tree([
      { id: 2, from: 0, to: 30 },
      { id: 3, from: 5, to: 10 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 30), ref(3, "B", 5, 10)], 1));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments.every((s) => !s.paused && !s.resumed)).toBe(true);
  });

  it("treats a handoff at the same millisecond as sequential, not concurrent", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 10, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 10, 20)], 1));
    expect(shape(bands)).toEqual([[["A", 1]], [["B", 1]]]);
  });

  it("marks every cut of a session that is interrupted twice", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
      { id: 5, from: 31, to: 40 },
      { id: 6, from: 41, to: 50 },
    ]);
    const bands = bandsOf(
      piecesOf(
        parent,
        [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30), ref(5, "C", 31, 40), ref(6, "A", 41, 50)],
        1,
      ),
    );
    const a = bands.flatMap((b) => b.segments).filter((s) => s.sessionId === "A");
    expect(a.map((s) => [s.resumed, s.paused])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
  });

  it("never marks a piece that ran in no conversation — there is nothing to interrupt", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    // #2 and #4 are function ops. They are separate threads, not one session split around #3.
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 11, 20)], 1));
    expect(bands.flatMap((b) => b.segments).every((s) => !s.paused && !s.resumed)).toBe(true);
    expect(shape(bands)).toEqual([[["#2", 1]], [["B", 1]], [["#4", 1]]]);
  });

  it("lets a call still running overlap whatever starts after it", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "s2", startedAt: 0, status: "running" }),
        node({ instanceId: 3, stateId: "s3", startedAt: 5, endedAt: 9 }),
      ],
    });
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 5, 9)], 1));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments).toHaveLength(2);
  });
});

describe("instancesOf", () => {
  it("names every transcript the panels will need, once each", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1));
    expect(instancesOf(bands).sort()).toEqual([2, 3]);
  });
});
