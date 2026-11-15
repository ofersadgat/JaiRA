/**
 * The ring round a project's tile and a conversation's row (`ringModel.ts`): a segment per thing,
 * as long as it is old on a thirty-minute ring, and in the middle the oldest wait the person owes —
 * or, where nothing is owed, how long the work has run.
 */
import { describe, expect, it } from "vitest";
import { ageText, askedAtOf, chatRingItems, elapsedText, projectRingItems, ringLabel, ringOf, RING_SPAN_MS } from "../src/renderer/ringModel";

const MIN = 60_000;
const now = 10_000_000;

describe("ringOf", () => {
  it("is empty with nothing on it", () => {
    expect(ringOf([], now)).toEqual({ segments: [], center: null, also: null, done: false, live: false });
  });

  it("makes a segment as long as its age on a thirty-minute ring", () => {
    const ring = ringOf([{ kind: "error", since: now - 15 * MIN }], now);
    expect(ring.segments).toEqual([{ kind: "error", start: 0, length: 50 }]);
  });

  it("keeps a thing that began a moment ago visible", () => {
    expect(ringOf([{ kind: "running", since: now - 1000 }], now).segments[0]!.length).toBe(8);
  });

  it("orders failed, asking, stopped, working, done — and the older first within a kind", () => {
    const ring = ringOf(
      [
        { kind: "success", since: now - MIN },
        { kind: "running", since: now - 2 * MIN },
        { kind: "waiting", since: now - 4 * MIN },
        { kind: "error", since: now - 12 * MIN },
        { kind: "running", since: now - 5 * MIN },
      ],
      now,
    );
    expect(ring.segments.map((s) => s.kind)).toEqual(["error", "waiting", "running", "running", "success"]);
    expect(ring.segments[2]!.length).toBeGreaterThan(ring.segments[3]!.length);
  });

  it("shrinks every segment alike when the ages add up to more than the ring, leaving its gaps", () => {
    const ring = ringOf(
      [
        { kind: "error", since: now - RING_SPAN_MS },
        { kind: "waiting", since: now - RING_SPAN_MS },
      ],
      now,
    );
    const [a, b] = ring.segments;
    expect(a!.length).toBeCloseTo(b!.length);
    expect(b!.start + b!.length + 1.5).toBeCloseTo(100);
  });

  it("says the oldest wait the person owes in the middle, before any work", () => {
    const ring = ringOf(
      [
        { kind: "running", since: now - 20 * MIN },
        { kind: "waiting", since: now - 4 * MIN },
        { kind: "error", since: now - 12 * MIN },
      ],
      now,
    );
    expect(ring.center).toEqual({ kind: "error", text: "12m" });
    expect(ring.live).toBe(true);
  });

  it("says how long the longest work has run when nothing is owed", () => {
    expect(ringOf([{ kind: "running", since: now - (6 * MIN + 10_000) }, { kind: "running", since: now - MIN }], now).center).toEqual({ kind: "running", text: "6:10" });
  });

  it("says nothing in the middle for what only finished, and that it is done", () => {
    const ring = ringOf([{ kind: "success", since: now - MIN }], now);
    expect(ring.center).toBeNull();
    expect(ring.done).toBe(true);
  });

  it("keeps the work's clock beside a wait the middle tells", () => {
    const ring = ringOf([{ kind: "waiting", since: now - 4 * MIN }, { kind: "running", since: now - 90_000 }], now);
    expect(ring.center).toEqual({ kind: "waiting", text: "4m" });
    expect(ring.also).toEqual({ kind: "running", text: "1:30" });
    expect(ringOf([{ kind: "running", since: now - 90_000 }], now).also).toBeNull();
  });
});

describe("the words", () => {
  it("ages a wait by the minute, hour and day", () => {
    expect([ageText(30_000), ageText(4 * MIN), ageText(125 * MIN), ageText(50 * 60 * MIN)]).toEqual(["now", "4m", "2h", "2d"]);
  });

  it("clocks work by the second, then in hours", () => {
    expect([elapsedText(42_000), elapsedText(6 * MIN + 10_000), elapsedText(65 * MIN)]).toEqual(["0:42", "6:10", "1h05"]);
  });

  it("names everything on a ring for a screen reader", () => {
    expect(ringLabel([{ kind: "running", since: now - 134_000 }, { kind: "error", since: now - 12 * MIN }], now)).toBe("failed 12m, working 2:14");
  });
});

describe("what a project's ring holds", () => {
  it("is its live tasks and what stopped since the person looked", () => {
    const items = projectRingItems(
      {
        live: [
          { taskId: "a", kind: "running", since: 1 },
          { taskId: "b", kind: "waiting", since: 2 },
        ],
        ended: [
          { taskId: "c", status: "failed", updatedAt: 3 },
          { taskId: "d", status: "completed", updatedAt: 4 },
          { taskId: "e", status: "queued", updatedAt: 5 },
        ],
      },
      { d: 4 },
    );
    expect(items).toEqual([
      { kind: "running", since: 1 },
      { kind: "waiting", since: 2 },
      { kind: "error", since: 3 },
    ]);
  });

  it("draws a conversation answering a typed turn once, as live, though its row says it ended", () => {
    const items = projectRingItems({ live: [{ taskId: "a", kind: "running", since: 7 }], ended: [{ taskId: "a", status: "completed", updatedAt: 3 }] });
    expect(items).toEqual([{ kind: "running", since: 7 }]);
  });

  it("holds only what stopped from an engine that sends no live tasks", () => {
    expect(projectRingItems({ ended: [{ taskId: "c", status: "failed", updatedAt: 3 }] })).toEqual([{ kind: "error", since: 3 }]);
  });
});

describe("what a conversation's ring holds", () => {
  const task = { taskId: "t", status: "completed" as const, updatedAt: 500, lastMessageAt: 400 };

  it("is asking and answering together, the answer counted from its message", () => {
    expect(chatRingItems(task, { seen: {}, producing: { t: 1 }, askedAt: 450 })).toEqual([
      { kind: "waiting", since: 450 },
      { kind: "running", since: 400 },
    ]);
  });

  it("is how it stopped while that is unread, and nothing once read", () => {
    expect(chatRingItems({ ...task, status: "failed" }, { seen: {}, producing: {} })).toEqual([{ kind: "error", since: 500 }]);
    expect(chatRingItems(task, { seen: { t: 500 }, producing: {} })).toEqual([]);
  });

  it("dates an ask by the oldest open request", () => {
    expect(askedAtOf([{ taskId: "t", at: 9 }, { taskId: "t", at: 4 }, { at: 1 }])).toEqual({ t: 4 });
  });
});
