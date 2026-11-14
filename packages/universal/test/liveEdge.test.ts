import { describe, expect, it } from "vitest";
import { DRIVE_TAIL, EDGE_START, PRESS_WINDOW, dragging, pressed, readerUp, repin, resized, scrolled, settled, type EdgeState } from "../src/components/chat/liveEdge";

/** A thread 1,000 tall in a 400 viewport, standing at its end. */
const atTheEnd = (): EdgeState => scrolled({ ...EDGE_START, laid: 1000 }, { y: 600, content: 1000, viewport: 400 }, 0);

describe("the live edge", () => {
  it("follows a sent message whose own scroll is reported after it grew the thread", () => {
    let s = atTheEnd();
    // The send pins and scrolls to the end; the message then lays out 120 taller …
    s = repin(s);
    const grew = resized(s, 1120, 10);
    expect(grew.follow).toBe(true);
    s = grew.state;
    // … and the scroll to the old end is reported only now, short of the new one: still pinned.
    s = scrolled(s, { y: 600, content: 1120, viewport: 400 }, 20);
    expect(s.pinned).toBe(true);
    expect(resized(s, 1300, 30).follow).toBe(true);
  });

  it("keeps following a reply that streams in long after the thread opened", () => {
    let s = atTheEnd();
    for (let i = 1; i <= 20; i++) {
      const r = resized(s, 1000 + i * 50, 5000 + i * 100);
      expect(r.follow).toBe(true);
      s = scrolled(r.state, { y: 600 + i * 50, content: 1000 + i * 50, viewport: 400 }, 5000 + i * 100 + 5);
    }
    expect(s.pinned).toBe(true);
  });

  it("is not let go by the page moving it: content shrinking above, or the viewport growing", () => {
    let s = atTheEnd();
    s = scrolled(s, { y: 520, content: 1000, viewport: 480 }, 10);
    expect(s.pinned).toBe(true);
    s = scrolled(s, { y: 300, content: 700, viewport: 480 }, 20);
    expect(s.pinned).toBe(true);
    // Not at the end, moved up, but the content changed with it: scroll anchoring, not the reader.
    s = scrolled(s, { y: 200, content: 900, viewport: 480 }, 30);
    expect(s.pinned).toBe(true);
  });

  it("lets go on the reader's own move up", () => {
    // Nothing else changed: only the reader moves it.
    expect(scrolled(atTheEnd(), { y: 500, content: 1000, viewport: 400 }, 10).pinned).toBe(false);
    // A wheel or key upward.
    expect(readerUp(atTheEnd()).pinned).toBe(false);
    // A drag up while the thread grows under it.
    let s = dragging(atTheEnd(), true, 10);
    s = scrolled(s, { y: 450, content: 1100, viewport: 400 }, 20);
    expect(s.pinned).toBe(false);
    expect(resized(s, 1200, 30).follow).toBe(false);
  });

  it("counts a fling's tail as the reader's until it settles", () => {
    let s = dragging(atTheEnd(), true, 0);
    s = dragging(s, false, 100);
    expect(scrolled(s, { y: 500, content: 1100, viewport: 400 }, 100 + DRIVE_TAIL - 1).pinned).toBe(false);
    s = settled(s);
    expect(scrolled(s, { y: 500, content: 1100, viewport: 400 }, 200).pinned).toBe(true);
  });

  it("pins again anywhere near the end, and then follows what grows", () => {
    let s = scrolled(atTheEnd(), { y: 100, content: 1000, viewport: 400 }, 10);
    expect(s.pinned).toBe(false);
    expect(resized(s, 1050, 20).follow).toBe(false);
    s = resized(s, 1050, 20).state;
    s = scrolled(s, { y: 630, content: 1050, viewport: 400 }, 30);
    expect(s.pinned).toBe(true);
    expect(resized(s, 1400, 9000).follow).toBe(true);
  });

  it("does not chase a row the reader opened, and lets go", () => {
    const s = pressed(atTheEnd(), 100);
    const r = resized(s, 1300, 100 + PRESS_WINDOW - 1);
    expect(r.follow).toBe(false);
    expect(r.state.pinned).toBe(false);
  });

  it("follows what grows after a press that folded something away (an approval answered)", () => {
    let s = pressed(atTheEnd(), 100);
    const shrank = resized(s, 900, 150);
    expect(shrank.follow).toBe(true);
    s = shrank.state;
    expect(resized(s, 1200, 200).follow).toBe(true);
  });

  it("forgets a press nothing answered in time", () => {
    const s = pressed(atTheEnd(), 100);
    expect(resized(s, 1300, 100 + PRESS_WINDOW + 1).follow).toBe(true);
  });
});
