/**
 * The task a `start_task` call made of its own (decision 0029 §2) — what the Chat view nests under the
 * call (`StartedTaskLine`). The person, 2026-11-24: "I thought we made it so that sub tasks appear in the
 * parent tasks using the rail expand collapse thing".
 */
import { describe, expect, it } from "vitest";
import { startedTaskOf } from "../src/workflowTools";

describe("the task a start_task call made", () => {
  it("is the program call's task_id, or the model tool's task, read from our object or its JSON text", () => {
    expect(startedTaskOf("start_task", { task_id: "t-child" })).toBe("t-child");
    expect(startedTaskOf("mcp__jaira__start_task", { ok: true, task: "t-child", key: "improve/lesson" })).toBe("t-child");
    expect(startedTaskOf("start_task", JSON.stringify({ ok: true, task: "t-child" }))).toBe("t-child");
  });

  it("is none for a failed start, another tool, or a run on the caller's own task", () => {
    expect(startedTaskOf("start_task", { ok: false, task: "t-child" })).toBeUndefined();
    expect(startedTaskOf("start_task", { task_id: "t-child", error: "could not start" })).toBeUndefined();
    expect(startedTaskOf("start_task", { task_id: "" })).toBeUndefined();
    expect(startedTaskOf("move_task", { ok: true, task: "t-child" })).toBeUndefined();
    expect(startedTaskOf("start_task", { ok: true, task: "t-self" }, "t-self")).toBeUndefined();
    expect(startedTaskOf("start_task", "not json")).toBeUndefined();
  });
});
