/**
 * A work summary phase's chips as a row that scrolls sideways (the chip carousel mockups, 2026-10-24,
 * design C): the "+N" counts on each side, where a press on one takes the row, and the mouse wheel.
 */
import { describe, expect, it } from "vitest";
import { outOfView, pageTo, PAGE_WHEEL_HOLD_MS, wheelOver, type Spot } from "../src/renderer/sidewaysRow";

// Five chips, 60 wide with 4 between: 0–60, 64–124, 128–188, 192–252, 256–316.
const spots: Spot[] = [0, 64, 128, 192, 256].map((x) => ({ x, w: 60 }));
const MAX = 316 - 150;

describe("the counts", () => {
  it("count a chip cut at an edge as out of view, and a row not yet measured as hiding none", () => {
    expect(outOfView(spots, { x: 0, width: 150 })).toEqual({ before: 0, after: 3 });
    // 100–250 in view: 64–124 is cut on the left, 192–252 on the right.
    expect(outOfView(spots, { x: 100, width: 150 })).toEqual({ before: 2, after: 2 });
    expect(outOfView(spots, { x: MAX, width: 150 })).toEqual({ before: 3, after: 0 });
    expect(outOfView(spots, { x: 0, width: 0 })).toEqual({ before: 0, after: 0 });
  });

  it("page the row: the first chip cut on that side comes to the other edge, clear of the fade", () => {
    // From the start, the chip at 128 is cut: it comes to the left edge, 22 in.
    expect(pageTo(spots, { x: 0, width: 150, max: MAX }, 1, 22)).toBe(128 - 22);
    // From the end, the chip at 128 is cut on the left: its right edge comes to the right edge, 22 in.
    expect(pageTo(spots, { x: MAX, width: 150, max: MAX }, -1, 22)).toBe(128 + 60 - 150 + 22);
    // Never past either end.
    expect(pageTo(spots, { x: 150, width: 150, max: MAX }, 1, 22)).toBe(MAX);
    expect(pageTo(spots, { x: 20, width: 150, max: MAX }, -1, 22)).toBe(0);
  });

  it("move along by a view, less the fades, past a chip wider than the view", () => {
    const wide: Spot[] = [{ x: 0, w: 400 }];
    expect(pageTo(wide, { x: 0, width: 150, max: 250 }, 1, 22)).toBe(150 - 44);
  });
});

describe("the mouse wheel over the row", () => {
  const at = (x: number) => ({ x, width: 150, max: MAX });
  const down = { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false };
  const up = { ...down, deltaY: -100 };

  it("moves the chips until they reach that end, then leaves the turn to the page", () => {
    expect(wheelOver(down, at(0), Infinity)).toEqual({ to: "row", by: 100 });
    expect(wheelOver(down, at(MAX), Infinity)).toEqual({ to: "page" });
    expect(wheelOver(up, at(MAX), Infinity)).toEqual({ to: "row", by: -100 });
    expect(wheelOver(up, at(0), Infinity)).toEqual({ to: "page" });
  });

  it("leaves a turn to the page while the page is scrolling, and over a row with nothing hidden", () => {
    expect(wheelOver(down, at(0), PAGE_WHEEL_HOLD_MS - 1)).toEqual({ to: "page" });
    expect(wheelOver(down, at(0), PAGE_WHEEL_HOLD_MS)).toEqual({ to: "row", by: 100 });
    expect(wheelOver(down, { x: 0, width: 150, max: 0 }, Infinity)).toEqual({ to: "page" });
  });

  it("leaves a sideways turn, and Shift and the wheel, to the row's own scrolling", () => {
    expect(wheelOver({ ...down, deltaX: 120 }, at(0), Infinity)).toEqual({ to: "own" });
    expect(wheelOver({ ...down, shiftKey: true }, at(0), Infinity)).toEqual({ to: "own" });
  });

  it("turns lines and pages into pixels", () => {
    expect(wheelOver({ ...down, deltaY: 3, deltaMode: 1 }, at(0), Infinity)).toEqual({ to: "row", by: 48 });
    expect(wheelOver({ ...down, deltaY: 1, deltaMode: 2 }, at(0), Infinity)).toEqual({ to: "row", by: 150 });
  });
});
