import { describe, expect, it } from "vitest";
import { EMPTY_STACK, push, type PanelEntry } from "../src/renderer/panelStack";
import {
  NO_SPLIT,
  artifactEntryOf,
  closeSplit,
  crumbTo,
  dropZonesOf,
  focusOn,
  focusRuleOf,
  historyOf,
  leavePane,
  leftMoved,
  leftWalked,
  onPane,
  onlyPane,
  openHereLine,
  openInPane,
  openInSplit,
  paneBack,
  paneForward,
  paneShows,
  placeMoveOf,
  placesOffered,
  rightWidthOf,
  roomEntryOf,
  routeOpen,
  showTab,
  shownPlacesOf,
  splitFits,
  swapPanes,
  taskPaneEntryOf,
  walkTo,
  zoneAt,
} from "../src/renderer/splitModel";
import type { PublishedRef } from "../src/renderer/transcriptRows";

const ref = (id: string, version = 1): PublishedRef => ({ taskId: "t-1", id, url: `artifact://t-1/@${id}`, version, kind: "page", entry: "index.html", title: `Page ${id}` });
const task = (taskId: string): PanelEntry => taskPaneEntryOf(taskId);
const keys = (entries: readonly PanelEntry[] | undefined): string[] => (entries ?? []).map((e) => e.key);
const state: PanelEntry = { kind: "state", key: "state::wf/a", stateId: "wf/a", project: null, tab: "run" };

describe("each pane's path", () => {
  it("opens the right pane split, focused, and pushes on its path after", () => {
    const one = openInSplit(NO_SPLIT, task("a"));
    expect(keys(one.right?.entries)).toEqual(["task:a"]);
    expect(one.focus).toBe("right");
    const two = openInSplit({ ...one, focus: "left" }, task("b"));
    expect(keys(two.right?.entries)).toEqual(["task:a", "task:b"]);
    expect(two.focus).toBe("right");
  });

  it("puts a drop on the left on top of the room, and ‹ returns to the room", () => {
    const split = openInPane(openInSplit(NO_SPLIT, task("a")), "left", task("b"));
    expect(keys(split.left.entries)).toEqual(["task:b"]);
    expect(split.focus).toBe("left");
    const back = onPane(split, "left", (s) => paneBack(s, "left"));
    expect(back.left.entries).toEqual([]);
    expect(keys(back.left.ahead)).toEqual(["task:b"]);
    expect(leftWalked(back)).toBe(true);
    expect(keys(onPane(back, "left", paneForward).left.entries)).toEqual(["task:b"]);
  });

  it("keeps the right pane's root: ‹ goes no further, an emptied path closes it", () => {
    const split = openInSplit(openInSplit(NO_SPLIT, task("a")), task("b"));
    const back = onPane(split, "right", (s) => paneBack(s, "right"));
    expect(keys(back.right?.entries)).toEqual(["task:a"]);
    expect(onPane(back, "right", (s) => paneBack(s, "right"))).toBe(back);
    expect(onPane(back, "right", (s) => ({ ...s, entries: [] })).right).toBeNull();
  });

  it("walks back to a crumb, what it passes kept ahead; the left's crumb -1 is the room", () => {
    const stack = push(push({ ...EMPTY_STACK, entries: [task("a")] }, task("b")), task("c"));
    const to = crumbTo(stack, 0);
    expect(keys(to.entries)).toEqual(["task:a"]);
    expect(keys(to.ahead)).toEqual(["task:b", "task:c"]);
    expect(crumbTo(stack, -1).entries).toEqual([]);
    expect(crumbTo(stack, 2)).toBe(stack);
  });

  it("lists the path newest first, what is ahead above where it stands, the left ending at the room", () => {
    let stack = push(push(push({ ...EMPTY_STACK, entries: [task("a")] }, task("b")), task("c")), task("d"));
    stack = crumbTo(stack, 1);
    expect(historyOf(stack, "right").map((l) => [l.entry?.key ?? null, l.offset])).toEqual([
      ["task:d", 2],
      ["task:c", 1],
      ["task:b", 0],
      ["task:a", -1],
    ]);
    expect(historyOf(stack, "left").at(-1)).toEqual({ entry: null, offset: -2 });
    expect(keys(walkTo(stack, 2).entries)).toEqual(["task:a", "task:b", "task:c", "task:d"]);
    expect(keys(walkTo(stack, -1).entries)).toEqual(["task:a"]);
    expect(walkTo(stack, -2).entries).toEqual([]);
    expect(walkTo(stack, 0)).toBe(stack);
  });

  it("drops what was on the room when the room moves", () => {
    const split = openInPane(openInSplit(NO_SPLIT, task("a")), "left", task("b"));
    expect(leftMoved(split).left).toEqual(EMPTY_STACK);
    expect(leftMoved(NO_SPLIT)).toBe(NO_SPLIT);
  });

  it("takes the top off a pane that gave it away", () => {
    const split = openInSplit(openInSplit(NO_SPLIT, task("a")), task("b"));
    expect(keys(leavePane(split, "right").right?.entries)).toEqual(["task:a"]);
    expect(leavePane(openInSplit(NO_SPLIT, task("a")), "right").right).toBeNull();
    expect(leavePane(openInPane(split, "left", task("c")), "left").left.entries).toEqual([]);
  });
});

describe("focus", () => {
  it("is only ever the left with no split", () => {
    expect(focusOn(NO_SPLIT, "right")).toBe(NO_SPLIT);
  });

  it("sends a sidebar press to the right pane only while it is focused, never on a phone", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(keys(routeOpen(split, task("b"))?.right?.entries)).toEqual(["task:a", "task:b"]);
    expect(routeOpen(focusOn(split, "left"), task("b"))).toBeNull();
    expect(routeOpen(split, task("b"), true)).toBeNull();
    expect(routeOpen(NO_SPLIT, task("b"))).toBeNull();
  });

  it("puts the side panel on the focused pane's own task", () => {
    const split = openInSplit(NO_SPLIT, { ...task("a"), project: "p" } as PanelEntry);
    expect(focusRuleOf(split)).toEqual({ kind: "convo", key: "convo:a", taskId: "a", project: "p", tab: "steps" });
    expect(focusRuleOf(focusOn(split, "left"))).toBeNull();
    expect(focusRuleOf(openInPane(split, "left", task("b")))?.key).toBe("convo:b");
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
    split = onPane(split, "right", (s) => push(s, task("b")));
    expect(split.changed).toBe("right");
    split = showTab(split, "right");
    expect(split.changed).toBeNull();
    split = leftMoved(split);
    expect(split.changed).toBe("left");
  });

  it("keeps the left pane above its floor however wide the right was left", () => {
    expect(rightWidthOf(900, 1000)).toBe(1000 - 360 - 6);
    expect(rightWidthOf(100, 1000)).toBe(360);
    expect(rightWidthOf(500, 1200)).toBe(500);
  });
});

describe("the place buttons", () => {
  it("reads every place an artifact is in, by id, the left pane's top as the main view", () => {
    const entry = artifactEntryOf(ref("x", 2));
    expect(shownPlacesOf("x", { main: ref("x"), split: entry, panel: undefined })).toEqual(["main", "split"]);
    expect(shownPlacesOf("x", { main: null, left: entry, split: undefined, panel: undefined })).toEqual(["main"]);
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

describe("the drop zones", () => {
  const main = { left: 100, top: 40, width: 600, height: 500 };
  const panel = { left: 706, top: 40, width: 400, height: 500 };
  const split = { left: 400, top: 40, width: 300, height: 500 };

  it("cuts a room with no split and no panel into three bands", () => {
    expect(dropZonesOf({ main }).map((z) => [z.place, z.rect.left, z.rect.width])).toEqual([
      ["main", 100, 200],
      ["split", 300, 200],
      ["panel", 500, 200],
    ]);
  });

  it("halves the middle beside an open panel, the panel its own zone", () => {
    expect(dropZonesOf({ main, panel }).map((z) => [z.place, z.rect.left, z.rect.width])).toEqual([
      ["main", 100, 300],
      ["split", 400, 300],
      ["panel", 706, 400],
    ]);
  });

  it("takes each pane as it stands once split; a row is offered the panes alone", () => {
    const zones = dropZonesOf({ main: { ...main, width: 294 }, split, panel });
    expect(zones.map((z) => z.place)).toEqual(["main", "split", "panel"]);
    expect(dropZonesOf({ main: { ...main, width: 294 }, split, panel }, true).map((z) => z.place)).toEqual(["main", "split"]);
    expect(zoneAt(zones, 450, 100)?.place).toBe("split");
    expect(zoneAt(zones, 150, 100)?.place).toBe("main");
    expect(zoneAt(zones, 50, 100)).toBeUndefined();
    expect(dropZonesOf({})).toEqual([]);
  });

  it("says where the pane goes and what ‹ returns to", () => {
    expect(openHereLine("Fix the quit dialog", "the Pricing page")).toBe("This pane goes on to Fix the quit dialog; ‹ Back returns to the Pricing page");
    expect(openHereLine("Fix the quit dialog", null)).toBe("This pane goes on to Fix the quit dialog");
  });
});

describe("the pane menu", () => {
  const at = { chatTaskId: "c", chatProject: "p", selected: "s", selectedProject: "q", stateId: "wf/a", docStateId: "wf/a", project: "p" };

  it("names what the room under the left pane stands on", () => {
    expect(roomEntryOf("chat", at)?.key).toBe("task:c");
    expect(roomEntryOf("tasks", at)?.key).toBe("task:s");
    expect(roomEntryOf("files", at)?.key).toBe("state:p:wf/a");
    expect(roomEntryOf("files", { ...at, docStateId: undefined })).toBeNull();
  });

  it("swaps: the left goes on to the right's, the right holds what the left showed", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    const swapped = swapPanes(split, task("room"));
    expect(keys(swapped.left.entries)).toEqual(["task:a"]);
    expect(keys(swapped.right?.entries)).toEqual(["task:room"]);
    // Swapped again: the left's top is replaced, not stacked.
    const again = swapPanes(swapped, task("room"));
    expect(keys(again.left.entries)).toEqual(["task:room"]);
    expect(keys(again.right?.entries)).toEqual(["task:a"]);
    expect(paneShows(again, "left", task("room"))?.key).toBe("task:room");
    expect(swapPanes(split, null).right).toBeNull();
  });

  it("keeps only one pane: the right's content becomes the main view on the left's path", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    const only = onlyPane(split, "right");
    expect(only.right).toBeNull();
    expect(keys(only.left.entries)).toEqual(["task:a"]);
    expect(onlyPane(split, "left").right).toBeNull();
    expect(closeSplit(openInPane(split, "left", task("b"))).left.entries.length).toBe(1);
  });
});
