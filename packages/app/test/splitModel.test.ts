import { describe, expect, it } from "vitest";
import { EMPTY_STACK, pop, push, type PanelEntry } from "../src/renderer/panelStack";
import {
  NO_SPLIT,
  artifactEntryOf,
  closeSplit,
  focusOn,
  focusRuleOf,
  historyOf,
  leaveRight,
  leftEntryOf,
  leftMoved,
  onRight,
  openInSplit,
  placeMoveOf,
  placesOffered,
  rightWidthOf,
  routeOpen,
  showTab,
  shownPlacesOf,
  splitFits,
  swapRight,
  taskPaneEntryOf,
  walkTo,
} from "../src/renderer/splitModel";
import type { PublishedRef } from "../src/renderer/transcriptRows";

const ref = (id: string, version = 1): PublishedRef => ({ taskId: "t-1", id, url: `artifact://t-1/@${id}`, version, kind: "page", entry: "index.html", title: `Page ${id}` });
const task = (taskId: string): PanelEntry => taskPaneEntryOf(taskId);
const state: PanelEntry = { kind: "state", key: "state::wf/a", stateId: "wf/a", project: null, tab: "run" };

describe("the right pane's path", () => {
  it("opens split, focused, and pushes on the path after", () => {
    const one = openInSplit(NO_SPLIT, task("a"));
    expect(one.right?.entries.map((e) => e.key)).toEqual(["task:a"]);
    expect(one.focus).toBe("right");
    const two = openInSplit({ ...one, focus: "left" }, task("b"));
    expect(two.right?.entries.map((e) => e.key)).toEqual(["task:a", "task:b"]);
    expect(two.focus).toBe("right");
  });

  it("goes back and forward, and a path emptied closes the pane", () => {
    let split = openInSplit(openInSplit(NO_SPLIT, task("a")), task("b"));
    split = onRight(split, pop);
    expect(split.right?.ahead.map((e) => e.key)).toEqual(["task:b"]);
    split = onRight(split, (s) => ({ ...s, entries: [] }));
    expect(split).toEqual(NO_SPLIT);
  });

  it("lists the path newest first, what is ahead above where it stands", () => {
    let stack = push(push(push({ ...EMPTY_STACK, entries: [task("a")] }, task("b")), task("c")), task("d"));
    stack = pop(pop(stack));
    const lines = historyOf(stack);
    expect(lines.map((l) => [l.entry.key, l.offset])).toEqual([
      ["task:d", 2],
      ["task:c", 1],
      ["task:b", 0],
      ["task:a", -1],
    ]);
    expect(walkTo(stack, 2).entries.map((e) => e.key)).toEqual(["task:a", "task:b", "task:c", "task:d"]);
    expect(walkTo(stack, -1).entries.map((e) => e.key)).toEqual(["task:a"]);
    expect(walkTo(stack, 0)).toBe(stack);
  });

  it("leaving the right pane goes back a level, or closes it at its root", () => {
    const split = openInSplit(openInSplit(NO_SPLIT, task("a")), task("b"));
    expect(leaveRight(split).right?.entries.map((e) => e.key)).toEqual(["task:a"]);
    expect(leaveRight(openInSplit(NO_SPLIT, task("a")))).toEqual(NO_SPLIT);
  });
});

describe("focus", () => {
  it("is only ever the left with no split", () => {
    expect(focusOn(NO_SPLIT, "right")).toBe(NO_SPLIT);
  });

  it("sends a sidebar press to the right pane only while it is focused, never on a phone", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(routeOpen(split, task("b"))?.right?.entries.map((e) => e.key)).toEqual(["task:a", "task:b"]);
    expect(routeOpen(focusOn(split, "left"), task("b"))).toBeNull();
    expect(routeOpen(split, task("b"), true)).toBeNull();
    expect(routeOpen(NO_SPLIT, task("b"))).toBeNull();
  });

  it("puts the side panel on the right pane's task while it is focused", () => {
    const split = openInSplit(NO_SPLIT, { ...task("a"), project: "p" } as PanelEntry);
    expect(focusRuleOf(split)).toEqual({ kind: "convo", key: "convo:a", taskId: "a", project: "p", tab: "steps" });
    expect(focusRuleOf(focusOn(split, "left"))).toBeNull();
    expect(focusRuleOf(openInSplit(NO_SPLIT, artifactEntryOf(ref("x"))))).toBeNull();
    expect(focusRuleOf(openInSplit(NO_SPLIT, state))).toBeNull();
  });
});

describe("the narrow window's tabs", () => {
  it("fits two panes from 726 wide", () => {
    expect(splitFits(725)).toBe(false);
    expect(splitFits(726)).toBe(true);
  });

  it("marks the hidden tab when its pane moves, and clears it once shown", () => {
    let split = showTab(openInSplit(NO_SPLIT, task("a")), "left");
    split = onRight(split, (s) => push(s, task("b")));
    expect(split.changed).toBe("right");
    split = showTab(split, "right");
    expect(split.changed).toBeNull();
    split = leftMoved(split);
    expect(split.changed).toBe("left");
    expect(leftMoved(NO_SPLIT)).toBe(NO_SPLIT);
  });

  it("keeps the left pane above its floor however wide the right was left", () => {
    expect(rightWidthOf(900, 1000)).toBe(1000 - 360 - 6);
    expect(rightWidthOf(100, 1000)).toBe(360);
    expect(rightWidthOf(500, 1200)).toBe(500);
  });
});

describe("the place buttons", () => {
  it("reads every place an artifact is in, by id", () => {
    const entry = artifactEntryOf(ref("x", 2));
    expect(shownPlacesOf("x", { main: ref("x"), split: entry, panel: undefined })).toEqual(["main", "split"]);
    expect(shownPlacesOf("y", { main: ref("x"), split: entry, panel: entry })).toEqual([]);
  });

  it("moves: opens at the place pressed and closes every other", () => {
    expect(placeMoveOf(["panel"], "split")).toEqual({ open: "split", close: ["panel"] });
    expect(placeMoveOf([], "main")).toEqual({ open: "main", close: [] });
    expect(placeMoveOf(["main", "panel"], "main")).toEqual({ open: "main", close: ["panel"] });
  });

  it("has no split on a phone: split opens over the main view", () => {
    expect(placesOffered(true)).toEqual(["main", "panel"]);
    expect(placeMoveOf(["panel"], "split", true)).toEqual({ open: "main", close: ["panel"] });
  });
});

describe("the pane menu", () => {
  it("names what the left pane stands on in each room", () => {
    const at = { chatTaskId: "c", chatProject: "p", selected: "s", selectedProject: "q", stateId: "wf/a", docStateId: "wf/a", project: "p" };
    expect(leftEntryOf("chat", at)?.key).toBe("task:c");
    expect(leftEntryOf("tasks", at)?.key).toBe("task:s");
    expect(leftEntryOf("files", at)?.key).toBe("state:p:wf/a");
    expect(leftEntryOf("files", { ...at, docStateId: undefined })).toBeNull();
  });

  it("swaps: the right pane holds what the left did, or closes when the left held nothing", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(swapRight(split, task("b")).right?.entries.map((e) => e.key)).toEqual(["task:b"]);
    expect(swapRight(split, null)).toEqual(closeSplit());
  });
});
