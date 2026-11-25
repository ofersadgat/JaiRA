/**
 * A conversation's row and the rail's All chats, as the person asked on 2026-11-24: "the date for a chat
 * currently shows '2 tasks' if there are multiple tasks within the chat, thats wrong: it should show the
 * timestamp of the latest message/turn within a chats hierarchy", and "the pip in the chat menu should be
 * segmented like the project level ring".
 */
import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@jaira/shared/browser";
import { arrangeConversations, controlsOf, whenOf } from "../src/renderer/chatListModel";
import { chatRingItems, chatsRingItems, workedAtOf } from "../src/renderer/ringModel";

const chat = (patch: Partial<TaskSummary> & Pick<TaskSummary, "taskId">): TaskSummary =>
  ({ title: patch.taskId, status: "completed", workflow: "session", createdAt: new Date(1_000).toISOString(), updatedAt: 2_000, ...patch }) as TaskSummary;

describe("a chat's When", () => {
  it("is its newest turn anywhere under it, when a task it started moved last", () => {
    expect(whenOf(chat({ taskId: "c", lastMessageAt: 5_000, childAt: 9_000 }), "message")).toBe(9_000);
  });

  it("is its own last message when that is newer than anything under it", () => {
    expect(whenOf(chat({ taskId: "c", lastMessageAt: 5_000, childAt: 3_000 }), "message")).toBe(5_000);
    expect(whenOf(chat({ taskId: "c", lastMessageAt: 5_000 }), "message")).toBe(5_000);
  });

  it("still says when it was made, when that is the column asked for", () => {
    expect(whenOf(chat({ taskId: "c", lastMessageAt: 5_000, childAt: 9_000 }), "created")).toBe(1_000);
  });

  it("orders the list, so a chat whose task just moved comes first", () => {
    const quiet = chat({ taskId: "quiet", lastMessageAt: 7_000 });
    const busy = chat({ taskId: "busy", lastMessageAt: 5_000, childAt: 9_000 });
    const sections = arrangeConversations([quiet, busy], { group: "none", sort: "when-desc", when: "message" }, { seen: {}, producing: {}, placeOf: () => undefined, home: "", now: 10_000 });
    expect(sections.flatMap((s) => s.rows.map((r) => r.taskId))).toEqual(["busy", "quiet"]);
  });

  it("names the tasks under it only in its tooltip", () => {
    expect(controlsOf({ controls: 2 })).toBe("2 tasks under it");
    expect(controlsOf({ controls: 1 })).toBe("1 task under it");
    expect(controlsOf({})).toBeUndefined();
  });
});

describe("All chats' ring", () => {
  it("holds every conversation's own ring: a segment for each that asks, works, or finished unread", () => {
    const items = chatsRingItems(
      [
        chat({ taskId: "asks", status: "running", updatedAt: 3_000 }),
        chat({ taskId: "works", status: "running", updatedAt: 4_000, lastMessageAt: 4_500 }),
        chat({ taskId: "done", status: "completed", updatedAt: 6_000 }),
        chat({ taskId: "read", status: "completed", updatedAt: 1_500 }),
      ],
      { seen: { read: 2_000 }, producing: {}, asked: { asks: 3_100 }, live: {} },
    );
    expect(items).toEqual([
      { kind: "waiting", since: 3_100 },
      { kind: "running", since: 4_500 },
      { kind: "success", since: 6_000 },
    ]);
  });

  it("is empty when nothing is going on and everything is read", () => {
    expect(chatsRingItems([chat({ taskId: "read", updatedAt: 1_500 })], { seen: { read: 2_000 }, producing: {}, asked: {}, live: {} })).toEqual([]);
  });
});

// The person, 2026-11-24: "answering the question should have at least reset the time", then "the
// conversation ring should work the same way" as the project's.
describe("a conversation's ring, while it works", () => {
  const facts = { seen: {}, producing: {} };

  it("counts from the newest turn in its tree: its own message, or what moved under it", () => {
    expect(chatRingItems(chat({ taskId: "c", status: "running", updatedAt: 1_000, lastMessageAt: 2_000 }), facts)).toEqual([{ kind: "running", since: 2_000 }]);
    expect(chatRingItems(chat({ taskId: "c", status: "running", updatedAt: 1_000, lastMessageAt: 2_000, childAt: 5_000 }), facts)).toEqual([{ kind: "running", since: 5_000 }]);
  });

  it("counts from the person's answer, which only the engine knows of", () => {
    const projects = [{ live: [{ taskId: "c", kind: "running" as const, since: 7_000 }, { taskId: "w", kind: "waiting" as const, since: 3_000 }] }];
    expect(workedAtOf(projects)).toEqual({ c: 7_000 });
    const task = chat({ taskId: "c", status: "running", updatedAt: 1_000, lastMessageAt: 2_000 });
    expect(chatRingItems(task, { ...facts, live: "running", workedAt: workedAtOf(projects).c })).toEqual([{ kind: "running", since: 7_000 }]);
    expect(chatsRingItems([task], { ...facts, asked: {}, live: { c: "running" }, worked: workedAtOf(projects) })).toEqual([{ kind: "running", since: 7_000 }]);
  });

  it("keeps a newer message this window heard before the engine's next summary", () => {
    expect(chatRingItems(chat({ taskId: "c", status: "running", lastMessageAt: 9_000 }), { ...facts, workedAt: 7_000 })).toEqual([{ kind: "running", since: 9_000 }]);
  });
});
