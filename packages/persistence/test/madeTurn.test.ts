/**
 * A fan-out element that became a TASK (decision 0003) is a `made` turn in its parent's conversation
 * — the machine made something, it did not enter it — and a `made` mark on its instance node. The
 * join is the child's provenance, not the shape of its id: a task id in a journal whose task did not
 * make it stays an ordinary entry.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { conversationView } from "../src/conversation";
import { createTask } from "../src/lifecycle";
import { taskRun } from "../src/views";

let dir: string;
let project: Project;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-made-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(taskId: string, events: EngineEvent[]): void {
  project.runtime.beginTask(taskId, "hash", now);
  const recorder = project.events.recorder(taskId);
  events.forEach((event, i) => recorder.record(event, now + i));
}

describe("a made task in its parent's conversation", () => {
  it("is one `made` turn carrying the task, with no terminated turn after it", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const alpha = createTask(project, { title: "Alpha", workflow: "w", origin: { kind: "split", taskId: parent, key: "work", index: 0, item: "a" } }).id;
    const beta = createTask(project, { title: "Beta", workflow: "w", origin: { kind: "task", taskId: parent, key: "work", index: 1 }, dependsOn: [alpha] }).id;
    record(parent, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: alpha, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 0, inputs: {} },
      { type: "instance.terminated", instanceId: alpha, stateId: "w/work", outcome: "success" },
      { type: "instance.entered", instanceId: beta, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 1, inputs: {} },
    ]);
    const turns = conversationView(project, parent).turns;
    expect(turns.map((t) => [t.kind, t.path])).toEqual([
      ["entered", ""],
      ["made", "work[0]"],
      ["made", "work[1]"],
    ]);
    expect(turns[1]!.made).toEqual({ taskId: alpha, title: "Alpha", kind: "split", status: "queued", holding: 0 });
    expect(turns[2]!.made).toEqual({ taskId: beta, title: "Beta", kind: "task", status: "queued", holding: 1 });
  });

  it("says how the task stands now, off its row", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const alpha = createTask(project, { title: "Alpha", workflow: "w", origin: { kind: "task", taskId: parent, key: "work", index: 0 } }).id;
    record(parent, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: alpha, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 0, inputs: {} },
    ]);
    project.runtime.setStatus(alpha, "running", now + 10);
    expect(conversationView(project, parent).turns[1]!.made?.status).toBe("running");
    project.runtime.setStatus(alpha, "completed", now + 20);
    expect(conversationView(project, parent).turns[1]!.made?.status).toBe("completed");
  });

  it("is not claimed by a task that did not make it, even when the id is a task's", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const stranger = createTask(project, { title: "Stranger", workflow: "w" }).id;
    record(parent, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: stranger, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", inputs: {} },
      { type: "instance.terminated", instanceId: stranger, stateId: "w/work", outcome: "success" },
    ]);
    const turns = conversationView(project, parent).turns;
    expect(turns.map((t) => t.kind)).toEqual(["entered", "entered", "terminated"]);
  });

  it("marks the element's node as made, so no panel is drawn for it", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const alpha = createTask(project, { title: "Alpha", workflow: "w", origin: { kind: "split", taskId: parent, key: "work", index: 0 } }).id;
    record(parent, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: "i-decide", stateId: "w/decide", childKey: "decide", parentInstanceId: "i-root", inputs: {} },
      { type: "instance.terminated", instanceId: "i-decide", stateId: "w/decide", outcome: "success" },
      { type: "instance.entered", instanceId: alpha, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 0, inputs: {} },
    ]);
    const run = taskRun(project, parent);
    const children = run.instances[0]!.children;
    expect(children.map((c) => [c.childKey, c.made])).toEqual([
      ["decide", undefined],
      ["work", { taskId: alpha, kind: "split" }],
    ]);
  });
});
