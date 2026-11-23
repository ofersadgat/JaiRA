import { describe, expect, it } from "vitest";
import { SCALE_MAX, SCALE_MIN, choiceOf, clampScale, defaultScale, dragScale, fitScale, openingScale, percentOf, stepScale } from "../src/components/pictureSize";

/** A screenshot, 1568×981, in a 704-wide column. */
const shot = { width: 1568, height: 981 };
const room = 704;

describe("a picture's size", () => {
  it("is drawn as before until someone sizes it: the column's width, 420 tall at most, never above 1:1", () => {
    // 420 / 981 is tighter than 704 / 1568.
    expect(defaultScale(shot, room)).toBeCloseTo(420 / 981);
    expect(defaultScale({ width: 200, height: 100 }, room)).toBe(1);
  });

  it("fits the column exactly, even above 1:1", () => {
    expect(fitScale(shot, room)).toBeCloseTo(704 / 1568);
    expect(fitScale({ width: 200, height: 100 }, room)).toBe(SCALE_MAX);
  });

  it("steps to the next tenth", () => {
    expect(stepScale(0.26, 1)).toBeCloseTo(0.3);
    expect(stepScale(0.26, -1)).toBeCloseTo(0.2);
    expect(stepScale(0.3, 1)).toBeCloseTo(0.4);
    expect(stepScale(0.3, -1)).toBeCloseTo(0.2);
    expect(stepScale(SCALE_MIN, -1)).toBe(SCALE_MIN);
    expect(stepScale(SCALE_MAX, 1)).toBe(SCALE_MAX);
  });

  it("follows a dragged corner, held at Fit and 1:1 within 8 px", () => {
    expect(dragScale(400, 100, shot, room)).toBeCloseTo(500 / 1568);
    expect(dragScale(400, 300, shot, room)).toBeCloseTo(704 / 1568);
    expect(dragScale(1500, 63, shot, room)).toBe(1);
    expect(dragScale(400, -1000, shot, room)).toBe(SCALE_MIN);
  });

  it("is said as a whole percent, within 10% and 200%", () => {
    expect(percentOf(0.428)).toBe("43%");
    expect(clampScale(5)).toBe(SCALE_MAX);
  });
});

describe("how big a picture opens (2026-11-22)", () => {
  const wide = { width: 2000, height: 1000 };
  const small = { width: 200, height: 100 };

  it("opens at Fit when it stands on its own, and at rest in the conversation", () => {
    expect(openingScale(wide, 500, null, undefined, true)).toBeCloseTo(0.25);
    expect(openingScale(small, 500, null, undefined, true)).toBeCloseTo(2);
    expect(openingScale(wide, 500, null, undefined, false)).toBeCloseTo(defaultScale(wide, 500));
  });

  it("opens at the choice carried from the set, fitted to THIS picture, unless it was given a size here", () => {
    expect(openingScale(small, 500, null, "fit", false)).toBeCloseTo(2);
    expect(openingScale(wide, 500, null, "actual", true)).toBe(1);
    expect(openingScale(wide, 500, null, 0.4, true)).toBeCloseTo(0.4);
    expect(openingScale(wide, 500, 0.7, "fit", true)).toBeCloseTo(0.7);
  });

  it("names Fit and 1:1 as words, anything else as its number", () => {
    expect(choiceOf(fitScale(wide, 500), wide, 500)).toBe("fit");
    expect(choiceOf(1, wide, 500)).toBe("actual");
    expect(choiceOf(0.4, wide, 500)).toBe(0.4);
  });
});
