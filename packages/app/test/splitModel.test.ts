import { describe, expect, it } from "vitest";
import { setItemEntryOf, shownEntryOf, shownSetOf, type PanelEntry } from "../src/renderer/panelStack";
import {
  NO_SPLIT,
  ROOM,
  artifactEntryOf,
  bodyKeyOf,
  subagentEntryOf,
  walkOfEntry,
  followedSplit,
  litPlacesOf,
  closePane,
  dropZonesOf,
  focusOn,
  followOf,
  focusRuleOf,
  historyOf,
  isSplit,
  leavePane,
  onPane,
  onlyPane,
  openHereLine,
  openInPane,
  openInSplit,
  paneBack,
  paneForward,
  parentOf,
  placeMoveOf,
  placesOffered,
  pushPath,
  rightWidthOf,
  roomEntryOf,
  roomMoved,
  roomPaneOf,
  routeOpen,
  setOfEntry,
  setPlacesOf,
  showTab,
  shownPlacesOf,
  splitFits,
  swapPanes,
  taskPaneEntryOf,
  trailOf,
  walkTo,
  zoneAt,
  type PaneEntry,
  type PanePath,
  type SplitState,
} from "../src/renderer/splitModel";
import type { PublishedRef } from "../src/renderer/transcriptRows";

const ref = (id: string, version = 1): PublishedRef => ({ taskId: "t-1", id, url: `artifact://t-1/@${id}`, version, kind: "page", entry: "index.html", title: `Page ${id}` });
const task = (taskId: string): PanelEntry => taskPaneEntryOf(taskId);
const keys = (entries: readonly PaneEntry[] | undefined): string[] => (entries ?? []).map((e) => e.key);
const paths = (split: SplitState): string[][] => split.panes.map((p) => keys(p.entries));
const path = (...entries: PaneEntry[]): PanePath => ({ entries, ahead: [] });
const publishedOfTop = (p: PanePath): PublishedRef | undefined => {
  const top = p.entries.at(-1);
  return top?.kind === "preview" ? top.preview.published?.ref : undefined;
};

describe("the panes", () => {
  it("opens on one pane whose path is where the room stands", () => {
    expect(paths(NO_SPLIT)).toEqual([["room"]]);
    expect(isSplit(NO_SPLIT)).toBe(false);
  });

  it("splits: the second pane's path is what was opened in it, focused", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(paths(split)).toEqual([["room"], ["task:a"]]);
    expect(split.focus).toBe(1);
    expect(paths(openInSplit(split, task("b")))).toEqual([["room"], ["task:a", "task:b"]]);
  });

  it("puts anything on either pane's path the same way, the room one of them", () => {
    const split = openInPane(openInSplit(NO_SPLIT, task("a")), 0, task("b"));
    expect(paths(split)).toEqual([["room", "task:b"], ["task:a"]]);
    expect(split.focus).toBe(0);
    // The room is one view: put on the other pane, it leaves the first.
    expect(paths(openInPane(split, 1, ROOM))).toEqual([["task:b"], ["task:a", "room"]]);
  });

  it("walks a history: ‹ to the first and no further, › again, the history menu", () => {
    let p = pushPath(pushPath(pushPath(path(task("a")), task("b")), task("c")), task("d"));
    p = walkTo(p, -2);
    expect(keys(p.entries)).toEqual(["task:a", "task:b"]);
    expect(keys(p.ahead)).toEqual(["task:c", "task:d"]);
    expect(historyOf(p).map((l) => [l.entry.key, l.offset])).toEqual([
      ["task:d", 2],
      ["task:c", 1],
      ["task:b", 0],
      ["task:a", -1],
    ]);
    expect(keys(walkTo(p, 2).entries)).toEqual(["task:a", "task:b", "task:c", "task:d"]);
    expect(keys(paneForward(p).entries)).toEqual(["task:a", "task:b", "task:c"]);
    const root = paneBack(paneBack(p));
    expect(keys(root.entries)).toEqual(["task:a"]);
    expect(paneBack(root)).toBe(root);
    // Somewhere it has been is a new step, not a walk back: what was ahead goes.
    expect(keys(pushPath(p, task("a")).entries)).toEqual(["task:a", "task:b", "task:a"]);
    expect(keys(pushPath(p, task("a")).ahead)).toEqual([]);
    // What › would go to is going forward.
    expect(keys(pushPath(p, task("c")).ahead)).toEqual(["task:d"]);
  });

  it("says where an entry stands as its crumbs, whatever way the pane came to it", () => {
    expect(keys(trailOf(task("a")))).toEqual(["task:a"]);
    expect(keys(trailOf(artifactEntryOf(ref("x"), "p")))).toEqual(["task:t-1", "artifact:x"]);
    expect(trailOf(artifactEntryOf(ref("x"), "p"))[0]).toEqual(taskPaneEntryOf("t-1", "p"));
    expect(keys(trailOf({ kind: "rerun", key: "rerun:a", taskId: "a" }))).toEqual(["task:a", "rerun:a"]);
    expect(keys(trailOf(ROOM))).toEqual(["room"]);
    expect(parentOf({ kind: "state", key: "state:p:wf/a", stateId: "wf/a", project: "p", tab: "run" })).toBeUndefined();
  });

  it("stands a subagent under the one that started it, the first under its task", () => {
    const at = { instanceId: "i-1", stateId: "chat" };
    const nested = subagentEntryOf("a", "p", at, [
      { call: "c1", name: "Explore" },
      { call: "c2", name: "Port the pipeline" },
    ]);
    expect(nested.key).toBe("subagent:i-1:c2");
    expect(keys(trailOf(nested))).toEqual(["task:a", "subagent:i-1:c1", "subagent:i-1:c2"]);
    // The same key as the side panel gives one opened from a run's page, which has no walk of its own.
    const bare: PanelEntry = { kind: "subagent", key: "subagent:i-1:c2", taskId: "a", step: { instanceId: "i-1", stateId: "chat", sidechain: "c2", name: "Port" } };
    expect(keys(trailOf(bare))).toEqual(["task:a", "subagent:i-1:c2"]);
  });

  it("draws a subagent as its conversation walked into it: the walk it stands for, keyed by its task", () => {
    const entry = subagentEntryOf("a", undefined, { instanceId: "i-1", stateId: "chat" }, [{ call: "c1", name: "Explore" }]);
    expect(walkOfEntry(entry)).toEqual([{ call: "c1", name: "Explore" }]);
    // One without a walk: its call alone, under the instance it was opened on (the thread reads a host
    // that is no run it started as its own).
    expect(walkOfEntry({ kind: "subagent", key: "subagent:r-1:c9", taskId: "a", step: { instanceId: "r-1", stateId: "wf/run", sidechain: "c9", name: "Fix" } })).toEqual([{ call: "c9", name: "Fix", host: "r-1" }]);
    expect(walkOfEntry(task("a"))).toBeUndefined();
    // The task and its subagents are one body: walking in and out redraws one thread, not a new one.
    expect(bodyKeyOf(entry)).toBe(bodyKeyOf(task("a")));
    expect(bodyKeyOf(artifactEntryOf(ref("x")))).toBe("artifact:x");
    // Walking in from the conversation, then out by its crumb: steps on the pane's path, ‹ coming back.
    const walked = pushPath(path(task("a")), entry);
    expect(keys(walked.entries)).toEqual(["task:a", "subagent:i-1:c1"]);
    expect(keys(paneBack(walked).entries)).toEqual(["task:a"]);
  });
});

describe("closing", () => {
  const split = openInPane(openInPane(openInSplit(NO_SPLIT, task("a")), 1, task("b")), 0, task("c"));

  it("closes either pane the same way: the other is the only view, its path kept", () => {
    const closeFirst = closePane(split, 0);
    expect(paths(closeFirst)).toEqual([["task:a", "task:b"]]);
    expect(isSplit(closeFirst)).toBe(false);
    const closeSecond = closePane(split, 1);
    expect(paths(closeSecond)).toEqual([["room", "task:c"]]);
    expect(onlyPane(split, 1)).toEqual(closeFirst);
    expect(onlyPane(split, 0)).toEqual(closeSecond);
  });

  it("does not close the only pane; one whose path runs out stands on the room", () => {
    expect(closePane(NO_SPLIT, 0)).toBe(NO_SPLIT);
    const alone = closePane(split, 0);
    expect(leavePane(leavePane(alone, 0), 0)).toEqual(NO_SPLIT);
    expect(paths(onPane(split, 1, () => ({ entries: [], ahead: [] })))).toEqual([["room", "task:c"]]);
  });

  it("leaves what a pane gave away ahead of it, as ‹ does: › walks to it again", () => {
    const split = openInPane(openInSplit(NO_SPLIT, task("a")), 1, task("b"));
    const left = leavePane(split, 1);
    expect(paths(left)).toEqual([["room"], ["task:a"]]);
    expect(keys(left.panes[1]!.ahead)).toEqual(["task:b"]);
  });

  it("swaps the panes, each with its path, focus going with its pane", () => {
    const swapped = swapPanes(split);
    expect(paths(swapped)).toEqual([["task:a", "task:b"], ["room", "task:c"]]);
    expect(swapped.focus).toBe(1);
    expect(swapPanes(NO_SPLIT)).toBe(NO_SPLIT);
  });
});

describe("the room", () => {
  it("moved, the pane holding it goes back to it", () => {
    const split = openInPane(openInSplit(NO_SPLIT, task("a")), 0, task("b"));
    expect(paths(roomMoved(split, ROOM))).toEqual([["room"], ["task:a"]]);
    expect(roomMoved(NO_SPLIT, ROOM)).toBe(NO_SPLIT);
  });

  it("standing on a conversation that moved to another workspace, its pane draws it where it is now", () => {
    const there = roomMoved(NO_SPLIT, taskPaneEntryOf("c", "/src/a"));
    const moved = roomMoved(there, taskPaneEntryOf("c", "/src/b"));
    expect(moved.panes[0]!.entries).toEqual([taskPaneEntryOf("c", "/src/b")]);
    expect(moved.here).toEqual(taskPaneEntryOf("c", "/src/b"));
  });

  it("standing on a conversation, its pane's path is that conversation's own entry — the same as any pane's", () => {
    const onChat = roomMoved(NO_SPLIT, task("c"));
    expect(paths(onChat)).toEqual([["task:c"]]);
    const both = openInSplit(onChat, task("c"));
    expect(paths(both)).toEqual([["task:c"], ["task:c"]]);
    // Another conversation: the focused pane, which holds the room's too, goes on to it; the other keeps its own.
    expect(paths(roomMoved(both, task("d")))).toEqual([["task:c"], ["task:d"]]);
    expect(paths(roomMoved(focusOn(both, 0), task("d")))).toEqual([["task:d"], ["task:c"]]);
    // Back to the room's own view (another room).
    expect(paths(roomMoved(onChat, ROOM))).toEqual([["room"]]);
  });

  it("moved with no pane holding it, it goes on the focused pane's path", () => {
    const lost = closePane(openInSplit(NO_SPLIT, task("a")), 0);
    expect(roomPaneOf(lost)).toBeNull();
    expect(paths(roomMoved(lost, ROOM))).toEqual([["task:a", "room"]]);
  });

  it("is where a sidebar press goes while the focused pane stands on it; else the pane goes on", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(paths(routeOpen(split, task("b"))!)).toEqual([["room"], ["task:a", "task:b"]]);
    expect(routeOpen(focusOn(split, 0), task("b"))).toBeNull();
    expect(routeOpen(split, task("b"), true)).toBeNull();
    expect(routeOpen(NO_SPLIT, task("b"))).toBeNull();
    expect(routeOpen(roomMoved(NO_SPLIT, task("c")), task("b"))).toBeNull();
  });

  it("follows the focused pane's conversation: the room goes there, and no path moves", () => {
    const onChat = roomMoved(NO_SPLIT, task("a"));
    const split = openInSplit(onChat, task("b"));
    expect(followOf(split)?.key).toBe("task:b");
    const followed = roomMoved(split, task("b"));
    expect(paths(followed)).toEqual([["task:a"], ["task:b"]]);
    expect(followed.here.key).toBe("task:b");
    expect(followOf(followed)).toBeNull();
    // Back in the first pane: the room goes back to its conversation.
    const back = focusOn(followed, 0);
    expect(followOf(back)?.key).toBe("task:a");
    expect(paths(roomMoved(back, task("a")))).toEqual([["task:a"], ["task:b"]]);
    // A sidebar press then lands in the focused pane, which is the room's now.
    expect(routeOpen(followed, task("c"))).toBeNull();
    expect(paths(roomMoved(followed, task("c")))).toEqual([["task:a"], ["task:c"]]);
    // On the start page, the room goes to it; on an artifact, it stays where it is.
    const start = openInPane(onChat, 1, ROOM);
    expect(followOf(start)).toBe(ROOM);
    expect(paths(roomMoved(start, ROOM))).toEqual([["task:a"], ["room"]]);
    expect(followOf(openInSplit(onChat, artifactEntryOf(ref("x"))))).toBeNull();
  });

  it("moving within the room goes on the pane's path, so each pane's ‹ and › walk its own history", () => {
    const onChat = roomMoved(NO_SPLIT, task("a"));
    // Come to the room: what was on top is dropped. Moved within it: a step on the pane's path.
    expect(paths(roomMoved(onChat, task("b")))).toEqual([["task:b"]]);
    const split = roomMoved(openInSplit(onChat, task("b")), task("b"));
    const stepped = roomMoved(split, task("c"), undefined, true);
    expect(paths(stepped)).toEqual([["task:a"], ["task:b", "task:c"]]);
    // ‹ in the second pane: back to b, c ahead; the room follows it there, the path kept.
    const back = onPane(stepped, 1, paneBack);
    expect(followOf(back)?.key).toBe("task:b");
    const followed = roomMoved(back, task("b"), undefined, true);
    expect(paths(followed)).toEqual([["task:a"], ["task:b"]]);
    expect(keys(followed.panes[1]!.ahead)).toEqual(["task:c"]);
    // The first pane's history is its own: a step there leaves the second's alone.
    const inFirst = roomMoved(focusOn(followed, 0), task("a"), undefined, true);
    expect(paths(inFirst)).toEqual(paths(followed));
    const first = roomMoved(inFirst, task("d"), undefined, true);
    expect(paths(first)).toEqual([["task:a", "task:d"], ["task:b"]]);
    expect(keys(first.panes[1]!.ahead)).toEqual(["task:c"]);
    // The start page is a step too; what is opened from it takes its place. The board's own move
    // under one key still shows the board.
    const start = roomMoved(onChat, ROOM, undefined, true);
    expect(paths(start)).toEqual([["task:a", "room"]]);
    expect(paths(roomMoved(start, task("e"), undefined, true))).toEqual([["task:a", "task:e"]]);
    expect(paths(roomMoved(roomMoved(NO_SPLIT, ROOM), task("e"), undefined, true))).toEqual([["task:e"]]);
    const board = openInPane(NO_SPLIT, 0, task("x"));
    expect(paths(roomMoved(board, ROOM, "y", true))).toEqual([["room"]]);
  });

  it("follows the focused pane's task by selecting it, the board staying where it is", () => {
    const split = openInSplit(NO_SPLIT, task("a"));
    expect(followOf(split, null)?.key).toBe("task:a");
    expect(followOf(split, "a")).toBeNull();
    expect(roomMoved(split, ROOM, "a")).toBe(split);
    // The first pane, the board under a task on its path: the same, its path kept.
    const mainOn = openInPane(split, 0, task("b"));
    expect(followOf(mainOn, "a")?.key).toBe("task:b");
    expect(roomMoved(mainOn, ROOM, "b")).toBe(mainOn);
    // On the board, nothing to follow; another task selected there moves the board as it did.
    const board = focusOn(openInSplit(NO_SPLIT, task("a")), 0);
    expect(followOf(board, "z")).toBeNull();
    expect(paths(roomMoved(board, ROOM, "z"))).toEqual([["room"], ["task:a"]]);
  });

  it("names what the room stands on, for the side panel", () => {
    const at = { chatTaskId: "c", chatProject: "p", selected: "s", selectedProject: "q", stateId: "wf/a", docStateId: "wf/a", project: "p" };
    expect(roomEntryOf("chat", at)?.key).toBe("task:c");
    expect(roomEntryOf("tasks", at)?.key).toBe("task:s");
    expect(roomEntryOf("files", at)?.key).toBe("state:p:wf/a");
    expect(roomEntryOf("files", { ...at, docStateId: undefined })).toBeNull();
  });
});

describe("focus", () => {
  it("is only ever the first pane with no split", () => {
    expect(focusOn(NO_SPLIT, 1)).toBe(NO_SPLIT);
  });

  it("puts the side panel on the focused pane's own task, either pane", () => {
    const split = openInSplit(NO_SPLIT, { ...task("a"), project: "p" } as PanelEntry);
    expect(focusRuleOf(split)).toEqual({ kind: "convo", key: "convo:a", taskId: "a", project: "p", tab: "steps" });
    expect(focusRuleOf(focusOn(split, 0))).toBeNull();
    // On what the room stands on, the room's own rule.
    expect(focusRuleOf(roomMoved(NO_SPLIT, task("c")))).toBeNull();
    expect(focusRuleOf(openInPane(split, 0, task("b")))?.key).toBe("convo:b");
    expect(focusRuleOf(openInSplit(NO_SPLIT, artifactEntryOf(ref("x"))))).toBeNull();
  });
});

describe("the narrow window's tabs", () => {
  it("fits two panes from 726 wide", () => {
    expect(splitFits(725)).toBe(false);
    expect(splitFits(726)).toBe(true);
  });

  it("marks the hidden tab when its pane moves, and clears it once shown", () => {
    let split = showTab(openInSplit(NO_SPLIT, task("a")), 0);
    split = onPane(split, 1, (p) => pushPath(p, task("b")));
    expect(split.changed).toBe(1);
    split = showTab(split, 1);
    expect(split.changed).toBeNull();
  });

  it("keeps the first pane above its floor however wide the second was left", () => {
    expect(rightWidthOf(900, 1000)).toBe(1000 - 360 - 6);
    expect(rightWidthOf(100, 1000)).toBe(360);
    expect(rightWidthOf(500, 1200)).toBe(500);
  });
});

describe("the place buttons", () => {
  it("reads every place an artifact is in, by id", () => {
    const entry = artifactEntryOf(ref("x", 2));
    expect(shownPlacesOf("x", { main: ref("x"), second: entry, panel: undefined })).toEqual(["main", "split"]);
    expect(shownPlacesOf("x", { main: null, first: entry, panel: undefined })).toEqual(["main"]);
    expect(shownPlacesOf("y", { main: ref("x"), second: entry, panel: entry })).toEqual([]);
  });

  it("lights only where this artifact stands at this version; a call's card, where it was opened from that call", () => {
    const v2 = artifactEntryOf(ref("x", 2));
    expect(litPlacesOf({ id: "x", version: 2 }, { main: null, second: v2, panel: undefined })).toEqual(["split"]);
    expect(litPlacesOf({ id: "x", version: 3 }, { main: null, second: v2, panel: undefined })).toEqual([]);
    expect(litPlacesOf({ id: "y", version: 2 }, { main: null, second: v2, panel: v2 })).toEqual([]);
    // Opened from call v2, the person's edits after it shown on both: still the same place.
    const fromCall = artifactEntryOf(ref("x", 4), undefined, 2);
    expect(litPlacesOf({ id: "x", version: 5, follows: 2 }, { main: null, second: fromCall, panel: undefined })).toEqual(["split"]);
    expect(litPlacesOf({ id: "x", version: 5, follows: 3 }, { main: null, second: fromCall, panel: undefined })).toEqual([]);
  });

  it("keys an artifact by its id: two of one title are two places, two versions of one are one", () => {
    const a = artifactEntryOf(ref("a"));
    const b = artifactEntryOf({ ...ref("b"), title: "Page a" });
    expect(a.key).not.toBe(b.key);
    const p = pushPath(path(task("t-1"), a), artifactEntryOf(ref("a", 2)));
    expect(keys(p.entries)).toEqual(["task:t-1", "artifact:a"]);
    expect(publishedOfTop(p)?.version).toBe(2);
    expect(pushPath(p, artifactEntryOf(ref("a", 2)))).toBe(p);
  });

  it("opens an artifact in a pane as a step in its history; its crumbs say it stands under its conversation", () => {
    const split = openInSplit(NO_SPLIT, task("b"));
    const opened = openInPane(split, 1, artifactEntryOf(ref("x", 3), "p"));
    expect(paths(opened)).toEqual([["room"], ["task:b", "artifact:x"]]);
    expect(opened.focus).toBe(1);
    expect(paths(openInSplit(NO_SPLIT, artifactEntryOf(ref("x"))))).toEqual([["room"], ["artifact:x"]]);
    expect(keys(trailOf(artifactEntryOf(ref("x", 3), "p")))).toEqual(["task:t-1", "artifact:x"]);
  });

  it("moved away, closes a pane opened for it alone; any other goes back a step", () => {
    const own = openInSplit(NO_SPLIT, artifactEntryOf(ref("x")));
    expect(paths(leavePane(own, 1))).toEqual([["room"]]);
    const walked = openInPane(openInSplit(NO_SPLIT, task("b")), 1, artifactEntryOf(ref("x")));
    expect(paths(leavePane(walked, 1))).toEqual([["room"], ["task:b"]]);
  });

  it("goes on to a later publish in the run from the call it was opened from, and only then", () => {
    const later = ref("x", 5);
    const successors = new Map([["artifact://t-1/@x@2", later]]);
    const followed = openInPane(openInSplit(NO_SPLIT, task("t-1")), 1, artifactEntryOf(ref("x", 2), undefined, 2));
    const moved = followedSplit(followed, successors);
    expect(paths(moved)).toEqual([["room"], ["task:t-1", "artifact:x"]]);
    expect(publishedOfTop(moved.panes[1]!)?.version).toBe(5);
    // Now it follows v5's call, which nothing replaced.
    expect(followedSplit(moved, successors)).toBe(moved);
    // Opened at a version picked on purpose: it stays.
    const pinned = openInSplit(NO_SPLIT, artifactEntryOf(ref("x", 2)));
    expect(followedSplit(pinned, successors)).toBe(pinned);
  });

  it("moves: opens at the place pressed and closes every other", () => {
    expect(placeMoveOf(["panel"], "split")).toEqual({ open: "split", close: ["panel"] });
    expect(placeMoveOf(["main", "panel"], "main")).toEqual({ open: "main", close: ["panel"] });
  });

  it("has no split on a phone: split opens over the main view", () => {
    expect(placesOffered(true)).toEqual(["main", "panel"]);
    expect(placeMoveOf(["panel"], "split", true)).toEqual({ open: "main", close: ["panel"] });
  });

  it("lights a shown set where the set, or one of its items opened within it, is on top; a picture of it alone is not the set", () => {
    const set = shownSetOf([ref("a"), ref("b"), ref("c")], { noun: "pages" });
    const item = setItemEntryOf(set, 1);
    expect(setOfEntry(item)?.key).toBe(set.key);
    expect(setOfEntry(shownEntryOf(set))?.key).toBe(set.key);
    expect(setOfEntry(artifactEntryOf(ref("b")))).toBeUndefined();
    expect(setPlacesOf(set.key, { main: null, first: item, second: artifactEntryOf(ref("c")), panel: shownEntryOf(set) })).toEqual(["main", "panel"]);
    expect(setPlacesOf(set.key, { main: ref("a"), first: ROOM, panel: undefined })).toEqual([]);
    // The item in a pane is still that artifact: its own buttons light there too.
    expect(shownPlacesOf("b", { main: null, second: item, panel: undefined })).toEqual(["split"]);
    const other = shownSetOf([ref("a"), ref("d")]);
    expect(setPlacesOf(other.key, { main: null, first: item, panel: undefined })).toEqual([]);
  });
});

describe("the drop zones", () => {
  const main = { left: 100, top: 40, width: 600, height: 500 };
  const panel = { left: 706, top: 40, width: 400, height: 500 };
  const split = { left: 400, top: 40, width: 300, height: 500 };

  it("cuts a room with no split and no panel into three bands, and halves it beside an open panel", () => {
    expect(dropZonesOf({ main }).map((z) => [z.place, z.rect.left, z.rect.width])).toEqual([
      ["main", 100, 200],
      ["split", 300, 200],
      ["panel", 500, 200],
    ]);
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
    expect(zoneAt(zones, 50, 100)).toBeUndefined();
  });

  it("says where the pane goes and what ‹ returns to", () => {
    expect(openHereLine("Fix the quit dialog", "the Pricing page")).toBe("This pane goes on to Fix the quit dialog; ‹ Back returns to the Pricing page");
    expect(openHereLine("Fix the quit dialog", null)).toBe("This pane goes on to Fix the quit dialog");
  });
});
