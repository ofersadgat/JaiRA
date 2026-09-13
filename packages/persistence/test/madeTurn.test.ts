/**
 * The runs a fan-out MADE of its elements (decision 0003) are one `made` line at the mount in the
 * conversation of EVERY task in the batch — the task that split wrote the `fanout.made` row before
 * cutting the copies, so each carries it — and each reads it from where it stands: its own run is
 * `self`, a run its `dependsOn` names is one it `waitsFor`. A mirrored row (the engine's record of a
 * `task` element) is not an entry and draws no line of its own; the join is the child's provenance,
 * not the shape of its id, so a task id in a journal whose task did not make it stays an entry.
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

const madeOf = (parent: string, beta: string): EngineEvent => ({
  type: "fanout.made",
  instanceId: "i-root",
  stateId: "w",
  childKey: "work",
  occurrence: 0,
  kind: "split",
  runs: [
    { element: 0, id: "a", runId: parent, title: "Alpha" },
    { element: 1, id: "b", runId: beta, title: "Beta" },
  ],
});

describe("the runs a fan-out made, in each task's conversation", () => {
  it("is one `made` line at the mount listing every run, read from where this task stands", () => {
    const parent = createTask(project, { title: "Alpha", workflow: "w" }).id;
    const beta = createTask(project, { title: "Beta", workflow: "w", origin: { kind: "split", taskId: parent, key: "work", index: 1, item: "b" }, dependsOn: [parent] }).id;
    const events: EngineEvent[] = [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      madeOf(parent, beta),
      { type: "instance.entered", instanceId: "i-work", stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 0, inputs: {} },
    ];
    record(parent, events);
    const mine = conversationView(project, parent).turns;
    expect(mine.map((t) => [t.kind, t.path])).toEqual([
      ["entered", ""],
      ["made", "work"],
      ["entered", "work[0]"],
    ]);
    expect(mine[1]!.made).toEqual({
      kind: "split",
      runs: [
        { taskId: parent, element: 0, id: "a", title: "Alpha", status: "queued", holding: 0, self: true, waitsFor: false },
        { taskId: beta, element: 1, id: "b", title: "Beta", status: "queued", holding: 1, self: false, waitsFor: false },
      ],
    });
    // The copy carries the same row and reads it from ITS side: Beta is self, and it waits for Alpha.
    record(beta, events);
    const theirs = conversationView(project, beta).turns;
    expect(theirs[1]!.made?.runs.map((run) => [run.taskId, run.self, run.waitsFor])).toEqual([
      [parent, false, true],
      [beta, true, false],
    ]);
  });

  it("says how each run stands now, off its row", () => {
    const parent = createTask(project, { title: "Alpha", workflow: "w" }).id;
    const beta = createTask(project, { title: "Beta", workflow: "w", origin: { kind: "split", taskId: parent, key: "work", index: 1 } }).id;
    record(parent, [{ type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} }, madeOf(parent, beta)]);
    project.runtime.beginTask(beta, "hash", now);
    project.runtime.setStatus(beta, "running", now + 10);
    expect(conversationView(project, parent).turns[1]!.made?.runs[1]?.status).toBe("running");
    project.runtime.setStatus(beta, "completed", now + 20);
    expect(conversationView(project, parent).turns[1]!.made?.runs[1]?.status).toBe("completed");
  });

  it("draws no entry for a mirrored row — the line already says what was made", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const alpha = createTask(project, { title: "Alpha", workflow: "w", origin: { kind: "task", taskId: parent, key: "work", index: 0 } }).id;
    record(parent, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "fanout.made", instanceId: "i-root", stateId: "w", childKey: "work", occurrence: 0, kind: "task", runs: [{ element: 0, runId: alpha, title: "Alpha" }] },
      { type: "instance.entered", instanceId: alpha, stateId: "w/work", childKey: "work", parentInstanceId: "i-root", element: 0, inputs: {} },
      { type: "instance.terminated", instanceId: alpha, stateId: "w/work", outcome: "success" },
    ]);
    const turns = conversationView(project, parent).turns;
    expect(turns.map((t) => t.kind)).toEqual(["entered", "made"]);
    // A task mount's parent made every element: nothing in the list is itself.
    expect(turns[1]!.made?.runs.map((run) => run.self)).toEqual([false]);
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

  it("marks a mirrored element's node as made, so no panel is drawn for it", () => {
    const parent = createTask(project, { title: "the issue", workflow: "w" }).id;
    const alpha = createTask(project, { title: "Alpha", workflow: "w", origin: { kind: "task", taskId: parent, key: "work", index: 0 } }).id;
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
      ["work", { taskId: alpha, kind: "task" }],
    ]);
  });
});
