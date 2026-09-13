/**
 * Decision 0003's persistence half: holding is derived from `dependsOn` and the dependencies' rows,
 * a start is refused while anything is held for, a dependent's branch starts from the last finished
 * dependency's head, and a copy can be cut `queued` from a live parent with its own binding.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { forkTask } from "../src/cut";
import { beginTaskRun, createTask, finishTaskRun, holdingOf } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { dependencyBaseOf } from "../src/worktrees";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-holding-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("holdingOf", () => {
  it("names every dependency that has not completed, with its standing, and skips one that is gone", () => {
    const a = createTask(project, { title: "Alpha", workflow: "w" });
    const b = createTask(project, { title: "Beta", workflow: "w" });
    const c = createTask(project, { title: "Gamma", workflow: "w", dependsOn: [a.id, b.id, "t-gone000000"] });
    expect(holdingOf(project, c)).toEqual([
      { taskId: a.id, title: "Alpha", status: "queued" },
      { taskId: b.id, title: "Beta", status: "queued" },
    ]);
    project.runtime.setStatus(a.id, "completed", Date.now());
    expect(holdingOf(project, c)).toEqual([{ taskId: b.id, title: "Beta", status: "queued" }]);
    project.runtime.setStatus(b.id, "failed", Date.now());
    // Failed is not completed: a dependency that ended badly still holds its dependents.
    expect(holdingOf(project, c)).toEqual([{ taskId: b.id, title: "Beta", status: "failed" }]);
  });

  it("is what beginTaskRun refuses on, with the names", async () => {
    const a = createTask(project, { title: "Alpha", workflow: "w" });
    const c = createTask(project, { title: "Gamma", workflow: "w", dependsOn: [a.id] });
    await expect(beginTaskRun(project, c.id)).rejects.toThrow(/waiting for 'Alpha' \(queued\) to complete/);
  });
});

describe("dependencyBaseOf", () => {
  it("is the branch of the completed dependency that ended last, ignoring unfinished and unbound ones", () => {
    const early = createTask(project, { title: "Early", workflow: "w", branch: "early" });
    const late = createTask(project, { title: "Late", workflow: "w", branch: "late" });
    const open = createTask(project, { title: "Open", workflow: "w", branch: "open" });
    const unbound = createTask(project, { title: "Unbound", workflow: "w" });
    const dependent = createTask(project, { title: "Dependent", workflow: "w", branch: "dep", dependsOn: [early.id, late.id, open.id, unbound.id] });
    finishTaskRun(project, early.id, "completed", {}, 1000);
    finishTaskRun(project, late.id, "completed", {}, 2000);
    finishTaskRun(project, unbound.id, "completed", {}, 3000);
    expect(dependencyBaseOf(project, dependent)).toBe("late");
    expect(dependencyBaseOf(project, { dependsOn: [open.id] })).toBeUndefined();
    expect(dependencyBaseOf(project, {})).toBeUndefined();
  });
});

describe("a queued copy of a live task", () => {
  const event = (event: EngineEvent): void => project.events.recorder(parent).record(event, Date.now());
  let parent: string;

  beforeEach(async () => {
    parent = createTask(project, { title: "Parent", workflow: "w", branch: "main-work" }).id;
    // A parent that is RUNNING and has entered its root and one child — the point a split cuts at.
    project.runtime.setStatus(parent, "running", Date.now());
    project.runtime.setSnapshot(parent, "abc123", Date.now());
    event({ type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} });
    event({ type: "instance.entered", instanceId: "i-decide", stateId: "w/decide", childKey: "decide", parentInstanceId: "i-root", inputs: {} });
    event({ type: "instance.terminated", instanceId: "i-decide", stateId: "w/decide", outcome: "success" });
  });

  it("refuses a live parent unless the caller says the cut is at a parked point", () => {
    expect(() => forkTask(project, parent, 4, { standing: "queued" })).toThrow(/stop it before cutting/);
  });

  it("keeps everything so far, stands queued with no start and no end, and takes its own binding and provenance", () => {
    const fork = forkTask(project, parent, 4, {
      standing: "queued",
      ofLiveTask: true,
      title: "Alpha",
      branch: "main-work/alpha",
      origin: { kind: "split", taskId: parent, key: "work", index: 0, item: "a" },
      split: [{ expr: ".children.decide.output.items", index: 0 }],
      dependsOn: [],
    });
    const row = project.runtime.get(fork.taskId)!;
    expect(row.status).toBe("queued");
    expect(row.startedAt).toBeUndefined();
    expect(row.endedAt).toBeUndefined();
    expect(row.outcome).toBeUndefined();
    expect(row.snapshotHash).toBe("abc123");
    expect(row.branch).toBe("main-work/alpha");
    expect(project.events.list(fork.taskId).map((e) => e.type)).toEqual(["instance.entered", "instance.entered", "instance.terminated"]);
    const meta = project.tasks.read(fork.taskId);
    expect(meta).toMatchObject({ title: "Alpha", branch: "main-work/alpha", parentTaskId: parent, origin: { kind: "split", key: "work", index: 0, item: "a" } });
    expect(meta.split).toEqual([{ expr: ".children.decide.output.items", index: 0 }]);
    expect(meta.dependsOn).toBeUndefined();
    // The root's id was re-minted, and the map says what it became.
    expect(fork.instanceIds.get("i-root")).toBeDefined();
    expect(fork.instanceIds.get("i-root")).not.toBe("i-root");
  });

  it("unbinds the copy when asked, rather than copying the parent's branch", () => {
    const fork = forkTask(project, parent, 4, { standing: "queued", ofLiveTask: true, branch: null });
    expect(project.runtime.get(fork.taskId)!.branch).toBeUndefined();
    expect(project.tasks.read(fork.taskId).branch).toBeUndefined();
  });
});
