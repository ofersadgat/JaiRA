import { describe, expect, it } from "vitest";
import { EMPTY_STACK, forward, historyButton, historyKey, pop } from "../src/renderer/panelStack";
import { windowTitle } from "../src/renderer/shellModel";
import { clampSplit, splitKey } from "../src/renderer/splitter";

/**
 * What the window does with a key or a mouse button outside any one component — the logic the desktop's
 * page and the universal shell both run (decision 0015), so the two cannot come to answer differently.
 */
describe("a divider's keys", () => {
  it("moves a vertical divider with left and right, four times as far with shift", () => {
    expect(splitKey("ArrowRight", false, 300, false, false)).toBe(312);
    expect(splitKey("ArrowLeft", false, 300, false, false)).toBe(288);
    expect(splitKey("ArrowRight", true, 300, false, false)).toBe(348);
  });

  it("moves a horizontal divider with up and down, and leaves the other pair alone", () => {
    expect(splitKey("ArrowDown", false, 300, true, false)).toBe(312);
    expect(splitKey("ArrowUp", false, 300, true, false)).toBe(288);
    expect(splitKey("ArrowLeft", false, 300, true, false)).toBeUndefined();
    expect(splitKey("ArrowDown", false, 300, false, false)).toBeUndefined();
  });

  it("widens the pane AFTER the divider when the key moves towards the one before", () => {
    expect(splitKey("ArrowLeft", false, 400, false, true)).toBe(412);
    expect(splitKey("ArrowRight", true, 400, false, true)).toBe(352);
  });

  it("takes no other key", () => {
    expect(splitKey("Enter", false, 300, false, false)).toBeUndefined();
    expect(splitKey("Home", false, 300, false, false)).toBeUndefined();
  });

  it("is held to the pane's limits by the clamp its hosts apply", () => {
    expect(clampSplit(splitKey("ArrowLeft", true, 190, false, false)!, 180, 520, undefined, 0)).toBe(180);
    expect(clampSplit(splitKey("ArrowRight", true, 510, false, false)!, 180, 520, undefined, 0)).toBe(520);
  });
});

describe("a panel's history, walked as a browser's is", () => {
  it("goes back on Alt+Left and forward on Alt+Right", () => {
    expect(historyKey({ altKey: true, key: "ArrowLeft" })).toBe(pop);
    expect(historyKey({ altKey: true, key: "ArrowRight" })).toBe(forward);
  });

  it("leaves the arrows alone without Alt, and Alt alone with any other key", () => {
    expect(historyKey({ altKey: false, key: "ArrowLeft" })).toBeUndefined();
    expect(historyKey({ altKey: true, key: "ArrowUp" })).toBeUndefined();
  });

  it("goes back on the mouse's fourth button and forward on its fifth", () => {
    expect(historyButton(3)).toBe(pop);
    expect(historyButton(4)).toBe(forward);
    expect(historyButton(0)).toBeUndefined();
    expect(historyButton(2)).toBeUndefined();
  });

  it("is a step that an empty stack takes as no step", () => {
    expect(historyKey({ altKey: true, key: "ArrowLeft" })!(EMPTY_STACK)).toBe(EMPTY_STACK);
    expect(historyButton(4)!(EMPTY_STACK)).toBe(EMPTY_STACK);
  });
});

describe("the window's name", () => {
  it("names the project and the room", () => {
    expect(windowTitle("C:/work/site", "tasks", null)).toBe("site · Tasks");
    expect(windowTitle("C:/work/site", "logs", null)).toBe("site · Logs");
  });

  it("names the open file in Files, and the room while none is open", () => {
    expect(windowTitle("C:/work/site", "files", "workflows/plan.json")).toBe("site · workflows/plan.json");
    expect(windowTitle("C:/work/site", "files", null)).toBe("site · Files");
  });

  it("says so with no project open, and calls a view that is no room Settings", () => {
    expect(windowTitle(null, "settings", null)).toBe("no project · Settings");
  });
});
