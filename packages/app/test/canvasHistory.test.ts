import { describe, expect, it } from "vitest";
import { CanvasHistory, changedPaths, type CanvasState } from "../src/renderer/canvasHistory";

type S = CanvasState<{ boards: Record<string, { x: number }> }>;
const state = (x: number, text = "a"): S => ({ index: { boards: { "A.dc.html": { x } } }, sources: { "project/A.dc.html": text } });
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("CanvasHistory", () => {
  it("undoes and redoes step by step", async () => {
    const h = new CanvasHistory<S>();
    h.record(state(0));
    await turn();
    h.record(state(1));
    await turn();
    expect(h.undo(state(2))).toEqual(state(1));
    expect(h.undo(state(1))).toEqual(state(0));
    expect(h.undo(state(0))).toBeUndefined();
    expect(h.redo(state(0))).toEqual(state(1));
    expect(h.redo(state(1))).toEqual(state(2));
    expect(h.redo(state(2))).toBeUndefined();
  });

  it("keeps what one turn did as one step", async () => {
    const h = new CanvasHistory<S>();
    h.record(state(0));
    h.record(state(1));
    await turn();
    expect(h.undo(state(2))).toEqual(state(0));
    expect(h.canUndo).toBe(false);
  });

  it("forgets the redos once a new edit is made", async () => {
    const h = new CanvasHistory<S>();
    h.record(state(0));
    await turn();
    h.undo(state(1));
    expect(h.canRedo).toBe(true);
    h.record(state(0));
    await turn();
    expect(h.canRedo).toBe(false);
  });

  it("keeps no more than its limit", async () => {
    const h = new CanvasHistory<S>(2);
    for (const x of [0, 1, 2]) {
      h.record(state(x));
      await turn();
    }
    expect(h.undo(state(3))).toEqual(state(2));
    expect(h.undo(state(2))).toEqual(state(1));
    expect(h.undo(state(1))).toBeUndefined();
  });
});

describe("changedPaths", () => {
  it("names canvas.json and each artboard that differ", () => {
    expect(changedPaths(state(0), state(0))).toEqual([]);
    expect(changedPaths(state(0), state(1))).toEqual(["project/canvas.json"]);
    expect(changedPaths(state(0, "a"), state(0, "b"))).toEqual(["project/A.dc.html"]);
    expect(changedPaths(state(0), { ...state(0), sources: {} })).toEqual(["project/A.dc.html"]);
  });
});
