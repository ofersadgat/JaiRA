/**
 * How the desktop's columns give way in a narrow window (the person's pick, 2026-10-25: "A + E"): the
 * room between them keeps 460, the sidebar folding first, then the side panel, and a column the person
 * opened stays open while the other gives way.
 */
import { describe, expect, it } from "vitest";
import { ROOM_FLOOR, columnOfFold, columnsFitOf, keptAfter } from "../src/renderer/shellFit";
import { FOLD } from "../src/renderer/uiState";

const both = (width: number, kept?: "sidebar" | "panel") => columnsFitOf({ width, sidebar: { open: true, width: 250 }, panel: { open: true, width: 400 }, kept });

describe("the columns in a narrow window", () => {
  it("stand open while the room keeps its floor", () => {
    expect(both(1200)).toEqual({ sidebar: true, panel: true });
    expect(both(250 + 6 + ROOM_FLOOR + 400 + 6)).toEqual({ sidebar: true, panel: true });
  });
  it("fold the sidebar first, then the panel", () => {
    expect(both(1000)).toEqual({ sidebar: false, panel: true });
    expect(both(820)).toEqual({ sidebar: false, panel: false });
    expect(both(640)).toEqual({ sidebar: false, panel: false });
  });
  it("keep open the column the person opened, folding the other", () => {
    expect(both(820, "sidebar")).toEqual({ sidebar: true, panel: false });
    expect(both(820, "panel")).toEqual({ sidebar: false, panel: true });
    // Kept even where the room loses its floor: the person asked for it.
    expect(both(700, "panel")).toEqual({ sidebar: false, panel: true });
  });
  it("leave the person's own folds as they are", () => {
    expect(columnsFitOf({ width: 1600, sidebar: { open: false, width: 250 }, panel: { open: true, width: 400 } })).toEqual({ sidebar: false, panel: true });
    expect(columnsFitOf({ width: 1000, sidebar: { open: true, width: 250 }, panel: { open: false, width: 400 } })).toEqual({ sidebar: true, panel: false });
  });
  it("fold only the sidebar where the room has no panel", () => {
    expect(columnsFitOf({ width: 760, sidebar: { open: true, width: 250 }, panel: { open: true, width: 0 } })).toEqual({ sidebar: true, panel: true });
    expect(columnsFitOf({ width: 700, sidebar: { open: true, width: 250 }, panel: { open: true, width: 0 } })).toEqual({ sidebar: false, panel: true });
  });
});

describe("the column kept open", () => {
  it("is the one last opened, and forgotten when it is folded", () => {
    expect(columnOfFold(FOLD.shellSidebar)).toBe("sidebar");
    expect(columnOfFold(FOLD.panelChat)).toBe("panel");
    expect(columnOfFold("files.tree")).toBeUndefined();
    expect(keptAfter(undefined, FOLD.panelTasks, true)).toBe("panel");
    expect(keptAfter("panel", FOLD.shellSidebar, true)).toBe("sidebar");
    expect(keptAfter("sidebar", FOLD.shellSidebar, false)).toBeUndefined();
    expect(keptAfter("panel", FOLD.shellSidebar, false)).toBe("panel");
    expect(keptAfter("panel", "files.tree", true)).toBe("panel");
  });
});
