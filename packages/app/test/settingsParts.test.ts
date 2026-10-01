/**
 * The Settings page's sections: which one is being read, and what becomes of a section asked for from
 * outside the page (`settingsParts.ts`). The page that keeps the list and scrolls is the universal
 * tree's (`components/settings/parts.ts`).
 */
import { describe, expect, it } from "vitest";
import { PART_MARGIN, READING_LINE, WANT_SETTLE_MS, WANT_WAIT_MS, readingPartOf, wantedStep, type WantedPart } from "../src/renderer/settingsParts";

describe("which section is being read", () => {
  const box = { top: 0, height: 600, contentHeight: 2400 };

  it("is the last whose heading has reached the reading line", () => {
    expect(readingPartOf([{ id: "a", top: 0 }, { id: "b", top: 400 }], box)).toBe("a");
    expect(readingPartOf([{ id: "a", top: -400 }, { id: "b", top: READING_LINE }, { id: "c", top: 500 }], { ...box, top: 400 })).toBe("b");
  });

  it("is the last section at the very bottom of the page, which may never get that far up", () => {
    expect(readingPartOf([{ id: "a", top: -1700 }, { id: "b", top: 300 }], { ...box, top: 1800 })).toBe("b");
  });

  it("is none on a page with no sections", () => {
    expect(readingPartOf([], box)).toBeNull();
  });
});

describe("a section asked for from outside the page", () => {
  const asked: WantedPart = { id: "events", asked: 1_000, arrived: null, height: 0 };

  it("waits while the page has not drawn it, and is gone to once it has", () => {
    expect(wantedStep(asked, 1_050, { top: null, contentHeight: 0, holding: false })).toBe("wait");
    expect(wantedStep(asked, 1_200, { top: 320, contentHeight: 900, holding: false })).toBe("go");
  });

  it("is forgotten when the page never draws it, so a later visit is not scrolled by an old request", () => {
    expect(wantedStep(asked, 1_000 + WANT_WAIT_MS, { top: null, contentHeight: 900, holding: false })).toBe("wait");
    expect(wantedStep(asked, 1_001 + WANT_WAIT_MS, { top: null, contentHeight: 900, holding: false })).toBe("drop");
    expect(wantedStep(asked, 1_001 + WANT_WAIT_MS, { top: 320, contentHeight: 900, holding: false })).toBe("drop");
  });

  const arrived: WantedPart = { ...asked, arrived: 1_200, height: 900 };

  it("is left alone while the scroll to it runs, and where it was put", () => {
    expect(wantedStep(arrived, 1_400, { top: 200, contentHeight: 900, holding: true })).toBe("wait");
    expect(wantedStep(arrived, 2_200, { top: PART_MARGIN, contentHeight: 900, holding: false })).toBe("wait");
  });

  it("is gone to again when the page grew under it — a section above it took its data", () => {
    expect(wantedStep(arrived, 2_200, { top: 3_400, contentHeight: 4_800, holding: false })).toBe("go");
    // Still moving from the first scroll: once that has ended.
    expect(wantedStep(arrived, 1_600, { top: 3_400, contentHeight: 4_800, holding: true })).toBe("wait");
    // The page grew BELOW it: it is where it was put, and stays.
    expect(wantedStep(arrived, 2_200, { top: PART_MARGIN + 1, contentHeight: 4_800, holding: false })).toBe("wait");
  });

  it("leaves a person who scrolled away by hand where they went: the page did not change", () => {
    expect(wantedStep(arrived, 2_200, { top: -700, contentHeight: 900, holding: false })).toBe("wait");
  });

  it("is done with once the page has had its moment to settle", () => {
    expect(wantedStep(arrived, 1_200 + WANT_SETTLE_MS, { top: 3_400, contentHeight: 4_800, holding: false })).toBe("go");
    expect(wantedStep(arrived, 1_201 + WANT_SETTLE_MS, { top: 3_400, contentHeight: 4_800, holding: false })).toBe("drop");
  });
});
