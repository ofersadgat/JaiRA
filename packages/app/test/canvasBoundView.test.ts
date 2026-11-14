import { describe, expect, it } from "vitest";
import { boundView, wheelView } from "../src/renderer/canvasBoard";

// A box 1000 × 800: the margin is 120 px either way.
const box = { w: 1000, h: 800 };
const wide = { x: 0, y: 0, w: 2000, h: 1000 };
const small = { x: 0, y: 0, w: 200, h: 100 };

describe("boundView", () => {
  it("stops a pan where content wider than the box ends, a margin clear", () => {
    expect(boundView({ x: 5000, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, wide, box).x).toBe(120);
    expect(boundView({ x: -9000, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, wide, box).x).toBe(-1120);
    expect(boundView({ x: 0, y: -9000, z: 1 }, { x: 0, y: 0, z: 1 }, wide, box).y).toBe(-320);
  });

  it("keeps content smaller than the box wholly in it", () => {
    expect(boundView({ x: -500, y: 0, z: 1 }, null, small, box).x).toBe(120);
    expect(boundView({ x: 5000, y: 0, z: 1 }, null, small, box).x).toBe(680);
    expect(boundView({ x: 300, y: 300, z: 1 }, null, small, box)).toEqual({ x: 300, y: 300, z: 1 });
  });

  it("counts the extent's own place on the board", () => {
    const placed = { x: 500, y: 500, w: 200, h: 100 };
    expect(boundView({ x: 0, y: 0, z: 1 }, null, placed, box).x).toBe(0);
    expect(boundView({ x: -1000, y: 0, z: 1 }, null, placed, box).x).toBe(120 - 500);
  });

  it("does not snap back a view already past the bound, only stops it going further", () => {
    const was = { x: -1500, y: 0, z: 1 };
    expect(boundView({ x: -1600, y: 0, z: 1 }, was, wide, box).x).toBe(-1500);
    expect(boundView({ x: -1400, y: 0, z: 1 }, was, wide, box).x).toBe(-1400);
  });

  it("keeps a zoom about the pointer on the canvas", () => {
    const was = { x: -1000, y: -200, z: 1 };
    const zoomed = boundView(wheelView(was, 0, 0, 0, 2000, true), was, wide, box);
    // Zoomed out, the content fits: it stays in the box, the margin clear.
    expect(zoomed.x + wide.x * zoomed.z).toBeGreaterThanOrEqual(120);
    expect(zoomed.x + (wide.x + wide.w) * zoomed.z).toBeLessThanOrEqual(880);
  });
});
