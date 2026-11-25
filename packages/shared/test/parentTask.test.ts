/**
 * Which task a task is a CHILD of (`parentTaskOf`), which children are drawn only inside their parent
 * (`drawnInsideParent`), and each task's ancestors (`ancestorsOf`) — what a parent's state is rolled up
 * over (the person, 2026-11-23: "a parent task should not count as stopped when it has a non terminal child").
 */
import { describe, expect, it } from "vitest";
import { ancestorsOf, drawnInsideParent, parentTaskOf } from "../src/task";

describe("a task's parent", () => {
  it("is what made it — a mount, an adoption, a start — or what it was spawned for; never what a fork was cut from", () => {
    expect(parentTaskOf({ origin: { kind: "started", taskId: "chat" } })).toBe("chat");
    expect(parentTaskOf({ origin: { kind: "task", taskId: "feature" } })).toBe("feature");
    expect(parentTaskOf({ origin: { kind: "adopt", taskId: "feature" } })).toBe("feature");
    expect(parentTaskOf({ parentTaskId: "sync" })).toBe("sync");
    expect(parentTaskOf({ origin: { kind: "fork", taskId: "src" }, parentTaskId: "src" })).toBeUndefined();
    expect(parentTaskOf({ origin: { taskId: "src" }, parentTaskId: "src" })).toBeUndefined();
    expect(parentTaskOf({})).toBeUndefined();
  });

  it("draws a mount's element and a started task inside the parent that holds it, and an adopted one on its own", () => {
    const present = (id: string) => id === "chat";
    expect(drawnInsideParent({ origin: { kind: "started", taskId: "chat" } }, present)).toBe(true);
    expect(drawnInsideParent({ origin: { kind: "started", taskId: "gone" } }, present)).toBe(false);
    expect(drawnInsideParent({ origin: { kind: "task", taskId: "gone" } }, present)).toBe(true);
    expect(drawnInsideParent({ origin: { kind: "adopt", taskId: "chat" } }, present)).toBe(false);
  });

  it("walks up to every ancestor present, nearest first, and stops at a cycle", () => {
    const tasks = [
      { taskId: "chat" },
      { taskId: "review", origin: { kind: "started", taskId: "chat" } },
      { taskId: "lesson", origin: { kind: "started", taskId: "review" } },
      { taskId: "orphan", origin: { kind: "started", taskId: "elsewhere" } },
      { taskId: "a", parentTaskId: "b" },
      { taskId: "b", parentTaskId: "a" },
    ];
    const up = ancestorsOf(tasks);
    expect(up.get("lesson")).toEqual(["review", "chat"]);
    expect(up.get("review")).toEqual(["chat"]);
    expect(up.has("chat")).toBe(false);
    expect(up.has("orphan")).toBe(false);
    expect(up.get("a")).toEqual(["b"]);
  });
});
