/**
 * The chat list's column head (the sidebar mockups, board 24): sorted by when or by name, either way
 * round, and cut into groups in a fixed order — the day, how it stands, or where it runs.
 */
import { describe, expect, it } from "vitest";
import { CHAT_WHENS, arrangeConversations, dayOf, pinnedOf, shownConversations, whenOf, withPinned, type ChatRow } from "../src/renderer/chatListModel";

const NOW = new Date(2026, 10, 12, 15, 0).getTime();
const HOUR = 3_600_000;
const row = (taskId: string, title: string, ago: number, project = "/a"): ChatRow => ({ taskId, title, updatedAt: NOW - ago, project }) as unknown as ChatRow;
const rows = [row("t1", "beta", 1 * HOUR), row("t2", "Alpha", 30 * HOUR, "/b"), row("t3", "gamma", 5 * 24 * HOUR), row("t4", "delta", 40 * 24 * HOUR, "/b")];
const facts = { seen: { t1: NOW, t3: NOW, t4: NOW }, producing: { t3: 1 }, placeOf: (r: ChatRow) => (r.project === "/b" ? "JaiRA-2" : undefined), home: "JaiRA", now: NOW };
const shape = (sections: ReturnType<typeof arrangeConversations>): Array<[string, string[]]> => sections.map((s) => [s.label, s.rows.map((r) => r.taskId)]);

describe("sorting", () => {
  it("is newest first by default, oldest first turned round, and by name either way", () => {
    expect(shape(arrangeConversations(rows, { group: "none", sort: "when-desc" }, facts))).toEqual([["", ["t1", "t2", "t3", "t4"]]]);
    expect(shape(arrangeConversations(rows, { group: "none", sort: "when-asc" }, facts))).toEqual([["", ["t4", "t3", "t2", "t1"]]]);
    expect(shape(arrangeConversations(rows, { group: "none", sort: "name-asc" }, facts))).toEqual([["", ["t2", "t1", "t4", "t3"]]]);
    expect(shape(arrangeConversations(rows, { group: "none", sort: "name-desc" }, facts))).toEqual([["", ["t3", "t4", "t1", "t2"]]]);
  });
});

describe("the When column", () => {
  // Made long ago, in this order; spoken in the opposite order, t4 a moment ago, t1 never.
  const DAY = 24 * HOUR;
  const made = (r: ChatRow, ago: number, lastAgo?: number): ChatRow =>
    ({ ...r, createdAt: new Date(NOW - ago).toISOString(), ...(lastAgo !== undefined ? { lastMessageAt: NOW - lastAgo } : {}) }) as ChatRow;
  const spoken = [made(rows[0]!, DAY), made(rows[1]!, 3 * DAY, 3 * HOUR), made(rows[2]!, 10 * DAY, 2 * HOUR), made(rows[3]!, 50 * DAY, HOUR / 2)];

  it("says the last message by default, and when it was made when chosen", () => {
    expect(whenOf(spoken[3]!, "message")).toBe(NOW - HOUR / 2);
    expect(whenOf(spoken[3]!, "created")).toBe(NOW - 50 * DAY);
    // Nothing said yet (still being placed): its making.
    expect(whenOf(spoken[0]!, "message")).toBe(NOW - DAY);
    expect(CHAT_WHENS[0]).toBe("message");
  });

  it("sorts and groups by the chosen moment", () => {
    expect(shape(arrangeConversations(spoken, { group: "none", sort: "when-desc" }, facts))).toEqual([["", ["t4", "t3", "t2", "t1"]]]);
    expect(shape(arrangeConversations(spoken, { group: "none", sort: "when-desc", when: "created" }, facts))).toEqual([["", ["t1", "t2", "t3", "t4"]]]);
    expect(shape(arrangeConversations(spoken, { group: "day", sort: "when-desc", when: "message" }, facts))).toEqual([
      ["Today", ["t4", "t3", "t2"]],
      ["Yesterday", ["t1"]],
    ]);
  });

  it("orders the plain list by the last message", () => {
    expect(shownConversations(spoken, "").map((r) => r.taskId)).toEqual(["t4", "t3", "t2", "t1"]);
  });
});

describe("pinned conversations", () => {
  it("stand first in a section of their own, whatever the grouping, the rest under Recent", () => {
    const pinned = new Set(["t3"]);
    expect(shape(arrangeConversations(rows, { group: "none", sort: "when-desc" }, { ...facts, pinned }))).toEqual([
      ["Pinned", ["t3"]],
      ["Recent", ["t1", "t2", "t4"]],
    ]);
    expect(shape(arrangeConversations(rows, { group: "day", sort: "when-desc" }, { ...facts, pinned }))[0]).toEqual(["Pinned", ["t3"]]);
  });

  it("are kept as a list of ids, added and taken away", () => {
    expect(withPinned(withPinned(undefined, "a", true), "b", true)).toBe("a,b");
    expect(withPinned("a,b", "a", false)).toBe("b");
    expect([...pinnedOf("a,,b")]).toEqual(["a", "b"]);
  });
});

describe("grouping", () => {
  it("by day, newest day first whatever the sort", () => {
    expect(dayOf(NOW - HOUR, NOW)).toBe("Today");
    expect(shape(arrangeConversations(rows, { group: "day", sort: "when-asc" }, facts))).toEqual([
      ["Today", ["t1"]],
      ["Yesterday", ["t2"]],
      ["This week", ["t3"]],
      ["Older", ["t4"]],
    ]);
  });

  it("by status: answering, then unread, then read", () => {
    expect(shape(arrangeConversations(rows, { group: "status", sort: "when-desc" }, facts))).toEqual([
      ["Answering", ["t3"]],
      ["Unread", ["t2"]],
      ["Read", ["t1", "t4"]],
    ]);
  });

  it("by workspace: the project's own first", () => {
    expect(shape(arrangeConversations(rows, { group: "workspace", sort: "when-desc" }, facts))).toEqual([
      ["JaiRA", ["t1", "t3"]],
      ["JaiRA-2", ["t2", "t4"]],
    ]);
  });
});
