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

  it("count a chip under a side's count as hidden, and let no count take itself away", () => {
    const cover = { left: 30, right: 30 };
    // At the start there is no count on the left, so 0–60 is in view; 64–124 runs under the right count (120–150).
    expect(outOfView(spots, { x: 0, width: 150 }, cover)).toEqual({ before: 0, after: 4 });
    // 90–240, a count over 90–120 and 210–240: 64–124 is under the left one, 128–188 is clear, 192–252 is under the right one.
    expect(outOfView(spots, { x: 90, width: 150 }, cover)).toEqual({ before: 2, after: 2 });
    // At the end (166–316) there is no count on the right, so the last chip is in view; 192–252 starts under the left count (166–196).
    expect(outOfView(spots, { x: MAX, width: 150 }, cover)).toEqual({ before: 4, after: 0 });
  });

  it("page the row: the first chip cut on that side comes to the other edge, clear of what lies over it", () => {
    const inset = { left: 40, right: 40 };
    // From the start, 64–124 runs under the right inset (110–150): it comes to the left edge, 40 in.
    expect(pageTo(spots, { x: 0, width: 150, max: MAX }, 1, inset)).toBe(64 - 40);
    // From the end (166–316), 192–252 starts under the left inset (166–206): its right edge comes to the right edge, 40 in.
    expect(pageTo(spots, { x: MAX, width: 150, max: MAX }, -1, inset)).toBe(192 + 60 - 150 + 40);
    // Never past either end.
    expect(pageTo(spots, { x: 150, width: 150, max: MAX }, 1, inset)).toBe(MAX);
    expect(pageTo(spots, { x: 20, width: 150, max: MAX }, -1, inset)).toBe(0);
  });

  it("pass over a chip already at the edge, where the clear stretch is narrower than a chip", () => {
    // A side panel's row, measured in the app: 103 wide, a count and its fade over 44 of each side.
    const narrow: Spot[] = [
      { x: 0, w: 47 },
      { x: 51, w: 63 },
      { x: 118, w: 65 },
      { x: 187, w: 76 },
      { x: 267, w: 110 },
    ];
    const inset = { left: 44, right: 44 };
    // The chip at 51 stands at the clear edge (7 + 44) and is still cut: the next press brings the one at 118.
    expect(pageTo(narrow, { x: 7, width: 103, max: 274 }, 1, inset)).toBe(118 - 44);
    // Back from there, the chip at 51 comes in, not the one at 118 again.
    expect(pageTo(narrow, { x: 74, width: 103, max: 274 }, -1, inset)).toBe(51 + 63 - 103 + 44);
    // A lone chip wider than the view: the row goes to its end.
    expect(pageTo([{ x: 0, w: 400 }], { x: 0, width: 150, max: 250 }, 1, { left: 22, right: 30 })).toBe(250);
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
