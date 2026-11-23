import { describe, expect, it } from "vitest";
import {
  EMPTY_STACK,
  acceptOffer,
  close,
  forward,
  pin,
  pop,
  popTo,
  push,
  reconcile,
  routeChange,
  selectStep,
  shownStack,
  setTab,
  crumbOf,
  openInSet,
  setKey,
  setPlaceOf,
  shownSetOf,
  stepInSet,
  topOf,
  type PanelEntry,
  type PanelStack,
} from "../src/renderer/panelStack";
import { labelPlan } from "../src/renderer/panelTabs";
import type { PublishedRef } from "../src/renderer/transcriptRows";

const task = (taskId: string, tab: "conversation" | "steps" = "conversation"): PanelEntry => ({ kind: "task", key: `task:${taskId}`, taskId, tab });
const state = (stateId: string): PanelEntry => ({ kind: "state", key: `state:${stateId}`, stateId, project: null, tab: "run" });
const config = (stateId: string): PanelEntry => ({ kind: "config", key: `config:${stateId}`, stateId });

const on = (stack: PanelStack, rule: PanelEntry | null): PanelStack => reconcile(stack, rule);

describe("the panel stack", () => {
  it("opens on the room's root and replaces it when the room stands on something else", () => {
    const a = on(EMPTY_STACK, task("t1"));
    expect(a.entries.map((e) => e.key)).toEqual(["task:t1"]);
    const b = on(push(a, config("plan/critique")), task("t2"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t2"]);
    expect(b.motion).toBe("replace");
  });

  it("keeps the person's tab and the pushed entries while the root is the same", () => {
    const a = setTab(on(EMPTY_STACK, task("t1")), "steps");
    const b = push(a, config("plan/critique"));
    const c = on(b, task("t1"));
    expect(c).toBe(b);
    expect(c.entries[0]).toMatchObject({ tab: "steps" });
  });

  it("lets the rule force a tab — a gate arriving takes the task to its conversation", () => {
    const a = push(setTab(on(EMPTY_STACK, task("t1")), "steps"), config("x"));
    const b = reconcile(a, task("t1"), { tab: "conversation" });
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ tab: "conversation" });
    expect(b.motion).toBe("tab");
  });

  it("pinned, a new root waits on the offer and the stack stays", () => {
    const a = pin(push(on(EMPTY_STACK, task("t1")), config("x")), true);
    const b = on(a, task("t2"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t1", "config:x"]);
    expect(b.offer?.key).toBe("task:t2");
    const c = acceptOffer(b);
    expect(c.entries.map((e) => e.key)).toEqual(["task:t2"]);
    expect(c.pinned).toBe(false);
  });

  it("pinned, the stack survives the room having nothing to show", () => {
    const a = pin(on(EMPTY_STACK, task("t1")), true);
    expect(on(a, null).entries).toHaveLength(1);
    expect(on(on(EMPTY_STACK, task("t1")), null).entries).toHaveLength(0);
  });

  it("pops one level, or back to a crumb, and never pops the root", () => {
    const a = push(push(on(EMPTY_STACK, task("t1")), state("plan")), config("plan"));
    expect(pop(a).entries.map((e) => e.key)).toEqual(["task:t1", "state:plan"]);
    expect(popTo(a, 0).entries.map((e) => e.key)).toEqual(["task:t1"]);
    expect(pop(pop(pop(a))).entries).toHaveLength(1);
    expect(pop(a).motion).toBe("pop");
  });

  it("pushing something already lower down pops back to it instead of looping", () => {
    const a = push(push(on(EMPTY_STACK, task("t1")), state("plan")), config("plan"));
    const b = push(a, state("plan"));
    expect(b.entries.map((e) => e.key)).toEqual(["task:t1", "state:plan"]);
  });

  it("a tab chosen on a root the stack has moved past pops back to it", () => {
    const a = push(on(EMPTY_STACK, task("t1")), config("x"));
    const b = setTab(a, "steps");
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ tab: "steps" });
    expect(b.motion).toBe("pop");
  });

  it("selecting a step opens Steps with that step, and closing it keeps Steps", () => {
    const a = selectStep(on(EMPTY_STACK, task("t1")), "i-critique");
    expect(a.entries[0]).toMatchObject({ tab: "steps", step: "i-critique" });
    const b = selectStep(a, undefined);
    expect(b.entries[0]).toMatchObject({ tab: "steps" });
    expect("step" in b.entries[0]!).toBe(false);
  });

  it("closed stays closed on the same root, and reopens for a new one", () => {
    const a = close(on(EMPTY_STACK, task("t1")));
    expect(on(a, task("t1")).entries).toHaveLength(0);
    expect(on(a, task("t2")).entries).toHaveLength(1);
  });
});

describe("an artifact on the stack", () => {
  it("pushed at another version, stands where it stood at that version", () => {
    const at = (version: number): PanelEntry => ({ kind: "preview", key: "artifact:x", preview: { title: "X", published: { ref: { taskId: "t", id: "x", url: "artifact://t/@x", version, kind: "page", entry: "index.html" } } } });
    const one = push(EMPTY_STACK, at(1));
    const two = push(one, at(2));
    expect(two.entries).toHaveLength(1);
    expect(two.entries[0]).toEqual(at(2));
    expect(push(two, at(2))).toBe(two);
  });
});

describe("tab labels", () => {
  const tabs = [
    { bare: 40, label: 90 },
    { bare: 36, label: 40 },
    { bare: 36, label: 60 },
    { bare: 36, label: 55 },
    { bare: 30, label: 100 },
  ];
  it("labels the open tab first, then from the left, while they fit", () => {
    expect(labelPlan(tabs, 2, 178 + 60)).toEqual([false, false, true, false, false]);
    expect(labelPlan(tabs, 2, 178 + 60 + 90)).toEqual([true, false, true, false, false]);
    expect(labelPlan(tabs, 2, 178 + 60 + 90 + 40)).toEqual([true, true, true, false, false]);
  });
  it("stops at the first label that does not fit rather than skipping to a shorter one", () => {
    const three = [
      { bare: 10, label: 10 },
      { bare: 10, label: 50 },
      { bare: 10, label: 5 },
    ];
    expect(labelPlan(three, 0, 30 + 10 + 20)).toEqual([true, false, false]);
  });
  it("labels nothing when even the open tab's label does not fit", () => {
    expect(labelPlan(tabs, 4, 178 + 50)).toEqual([false, false, false, false, false]);
  });
});

describe("the pinned panel is the window's", () => {
  const room = on(EMPTY_STACK, task("t1"));

  it("pinning takes the stack out of the room; the room keeps following its own", () => {
    const routed = routeChange(null, room, pin(push(room, config("x")), true));
    expect(routed.pinned?.entries.map((e) => e.key)).toEqual(["task:t1", "config:x"]);
    expect(routed.room).toBeUndefined();
  });

  it("is immune to the room: the room moving on only OFFERS its new root", () => {
    const pinned = pin(room, true);
    const moved = on(room, task("t2"));
    const shown = shownStack(pinned, moved, null);
    expect(shown.entries.map((e) => e.key)).toEqual(["task:t1"]);
    expect(shown.offer?.key).toBe("task:t2");
    // Standing on the pinned task itself offers nothing.
    expect(shownStack(pinned, room, null).offer).toBeNull();
  });

  it("pushes, pops and tabs on the pinned stack as on any stack", () => {
    const pinned = pin(room, true);
    const shown = shownStack(pinned, room, null);
    const routed = routeChange(pinned, shown, push(shown, config("x")));
    expect(routed.pinned?.entries.map((e) => e.key)).toEqual(["task:t1", "config:x"]);
    expect(routed.room).toBeUndefined();
  });

  it("remembers an offer waved away, so it is not offered again", () => {
    const pinned = pin(room, true);
    const shown = shownStack(pinned, on(room, task("t2")), null);
    const routed = routeChange(pinned, shown, { ...shown, offer: null });
    expect(routed.dismissed).toBe("task:t2");
    expect(shownStack(routed.pinned, on(room, task("t2")), "task:t2").offer).toBeNull();
  });

  it("unpinning, or taking the offer, hands the column back to the room", () => {
    const pinned = pin(room, true);
    const shown = shownStack(pinned, on(room, task("t2")), null);
    const taken = routeChange(pinned, shown, acceptOffer(shown));
    expect(taken.pinned).toBeNull();
    expect(taken.room?.entries.map((e) => e.key)).toEqual(["task:t2"]);
    const unpinned = routeChange(pinned, shown, pin(shown, false));
    expect(unpinned.pinned).toBeNull();
    expect(unpinned.room?.entries.map((e) => e.key)).toEqual(["task:t1"]);
  });
});

describe("forward (the person, 2026-09-26)", () => {
  const keys = (stack: PanelStack): string[] => stack.entries.map((e) => e.key);
  const deep = push(push(on(EMPTY_STACK, task("t1")), config("a")), state("b"));

  it("goes forward again to where back came from, one level at a time", () => {
    const back = pop(pop(deep));
    expect(keys(back)).toEqual(["task:t1"]);
    expect(back.ahead.map((e) => e.key)).toEqual(["config:a", "state:b"]);
    expect(keys(forward(back))).toEqual(["task:t1", "config:a"]);
    expect(keys(forward(forward(back)))).toEqual(["task:t1", "config:a", "state:b"]);
    expect(forward(forward(back)).ahead).toEqual([]);
  });

  it("keeps what a crumb passes, and forgets the way ahead when somewhere new is opened", () => {
    const back = popTo(deep, 0);
    expect(back.ahead.map((e) => e.key)).toEqual(["config:a", "state:b"]);
    expect(push(back, config("a")).ahead.map((e) => e.key)).toEqual(["state:b"]);
    expect(push(back, config("elsewhere")).ahead).toEqual([]);
    expect(on(back, task("t2")).ahead).toEqual([]);
  });

  it("does nothing with nowhere to go", () => {
    expect(forward(deep)).toBe(deep);
  });
});

describe("a shown set in the panel (2026-11-22)", () => {
  const ref = (id: string): PublishedRef => ({ taskId: "t1", id, url: `artifact://t1/@${id}`, version: 1, kind: "file", entry: `${id}.png` });
  const set = shownSetOf([ref("a"), ref("b"), ref("c")], { caption: "Three screens", noun: "pictures" });
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
  const opened = openInSet(on(EMPTY_STACK, task("t1")), set, 1);

  it("opens an item on the path conversation › the set › it", () => {
    expect(opened.entries.map((e) => e.key)).toEqual(["task:t1", set.key, "artifact:b"]);
    expect(crumbOf(opened.entries[1]!)).toBe("3 pictures");
    expect(setPlaceOf(opened)?.index).toBe(1);
  });

  it("steps sideways in place of the item, without wrapping", () => {
    const next = stepInSet(opened, 2);
    expect(next.entries.map((e) => e.key)).toEqual(["task:t1", set.key, "artifact:c"]);
    expect(stepInSet(next, 3)).toBe(next);
    expect(stepInSet(next, -1)).toBe(next);
    // ‹ still goes up to the set, not back to the item stepped from.
    expect(topOf(pop(next))?.key).toBe(set.key);
  });

  it("opening another item of the same set from the set's level does not stack the set twice", () => {
    const up = pop(opened);
    expect(openInSet(up, set, 0).entries.map((e) => e.key)).toEqual(["task:t1", set.key, "artifact:a"]);
  });

  it("names a set of mixed kinds artifacts", () => {
    expect(shownSetOf([ref("a"), ref("b")]).label).toBe("2 artifacts");
  });

  it("an item of another call's set replaces the set the panel is in, rather than nesting under it", () => {
    const other = shownSetOf([ref("x"), ref("y")], { noun: "pages" });
    expect(openInSet(stepInSet(opened, 2), other, 1).entries.map((e) => e.key)).toEqual(["task:t1", other.key, "artifact:y"]);
  });

  it("takes ← → Home End and Escape only on an item of a set, and leaves Alt+← to the history", () => {
    const right = setKey(key("ArrowRight"), opened);
    expect(right === undefined ? undefined : topOf(right(opened))?.key).toBe("artifact:c");
    const home = setKey(key("Home"), opened);
    expect(home === undefined ? undefined : topOf(home(opened))?.key).toBe("artifact:a");
    const end = setKey(key("End"), stepInSet(opened, 2));
    expect(end).toBeUndefined();
    const escape = setKey(key("Escape"), opened);
    expect(escape === undefined ? undefined : topOf(escape(opened))?.key).toBe(set.key);
    expect(setKey(key("ArrowLeft", { altKey: true }), opened)).toBeUndefined();
    expect(setKey(key("ArrowRight"), pop(opened))).toBeUndefined();
  });
});
