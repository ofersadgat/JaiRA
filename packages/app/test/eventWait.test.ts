/**
 * A workflow that waits for an event, end to end through the service (decision 0010 §3).
 *
 * A guard parks on `on_event`; an event the service is handed for the project — what the repository
 * watcher's `onEvent` does, or another task ending — carries it on. And the app closing while it
 * waits SUSPENDS it: the next start resumes it, and an event that arrives before the resumed run has
 * re-armed is still its.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { JairaEvent, PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { SUSPENDED_WAITING } from "@jaira/service/session";

vi.setConfig({ testTimeout: 60_000 });

const noop = { kind: "function", function: "changeset-review-status", input: { decisions: { binding: { json: [] } } } };

/** A root that holds, then waits on `guard`, then deploys. */
const waiting = (root: string, guard: string): Record<string, JsonValue> => ({
  [root]: {
    label: root,
    children: { hold: { state: `${root}/hold` }, deploy: { state: `${root}/deploy` } },
    sequence: ["hold"],
    transitions: [
      { to: "deploy", when: `.run.cursor === 'hold' && .children.hold.outcome === 'success' && ${guard}` },
      { to: "terminate.success", when: ".children.deploy.outcome === 'success'" },
    ],
  },
  [`${root}/hold`]: { label: "Hold", outputs: { settled: { schema: { type: "boolean" } } }, operation: noop },
  [`${root}/deploy`]: { label: "Deploy", outputs: { settled: { schema: { type: "boolean" } } }, operation: noop },
});

const push = (branch: string, after: string): JairaEvent => ({
  name: "git.pushed",
  payload: { remote: "origin", connection: "github", host: "github.com", repository: "acme/app", branch, before: "a", after, commits: [] },
});

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-events-"));
  const { workflowsDir } = initProject(dir, testHome());
  writeWorkflowFiles(workflowsDir, {
    ...waiting("deploy_on_push", "on_event('git.pushed', { branch: 'main' }).payload.after === 'abc'"),
    ...waiting("after_other", "on_event('task.finished').payload.title === 'First'"),
    ...waiting("quick", "true"),
  });
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false });
  await service.open(dir);
  service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), events: { "git.pushed": { enabled: true }, "task.finished": { enabled: true } } } as JsonValue });
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 45_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const statusOf = (taskId: string): string | undefined => {
  try {
    return service.taskDetail(taskId).status;
  } catch {
    return undefined;
  }
};

const entered = (taskId: string, stateId: string): boolean => {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return project.events.list(taskId).some((e) => e.type === "instance.entered" && (e.event as { stateId?: string }).stateId === stateId);
  } finally {
    project.close();
  }
};

describe("a workflow that waits for an event", () => {
  it("parks on on_event, and an event for its project carries it down the rule — only the one its filter takes", async () => {
    const { taskId } = await service.createTask({ title: "Deploy", workflow: "deploy_on_push" });
    await service.startTask({ taskId });
    await until(() => service.eventWaits().find((w) => w.taskId === taskId && w.waiter === "guard"), "the guard to wait");
    expect(service.eventWaits()).toMatchObject([{ taskId, name: "git.pushed", filter: { branch: "main" } }]);

    // Another branch's push is not this rule's; another project's is not this task's.
    expect(service.deliverEvent(dir, push("release/2.0", "abc"))).toBe(1);
    expect(service.deliverEvent(join(dir, "elsewhere"), push("main", "abc"))).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(statusOf(taskId)).toBe("running");

    service.deliverEvent(dir, push("main", "abc"));
    await until(() => statusOf(taskId) === "completed", "the run to complete");
    expect(service.eventWaits()).toEqual([]);
    await service.close();
    expect(entered(taskId, "deploy_on_push/deploy")).toBe(true);
  });

  it("hears another task of the project finish — task.finished, from the service", async () => {
    const waiter = await service.createTask({ title: "Second", workflow: "after_other" });
    await service.startTask({ taskId: waiter.taskId });
    await until(() => service.eventWaits().find((w) => w.taskId === waiter.taskId), "the second task to wait");
    const first = await service.createTask({ title: "First", workflow: "quick" });
    await service.startTask({ taskId: first.taskId });
    await until(() => statusOf(first.taskId) === "completed", "the first task to finish");
    await until(() => statusOf(waiter.taskId) === "completed", "the waiting task to hear it");
  });

  it("is suspended when the app closes while it waits, resumed on the next start, and keeps an event that lands before it re-arms", async () => {
    const { taskId } = await service.createTask({ title: "Deploy", workflow: "deploy_on_push" });
    await service.startTask({ taskId });
    await until(() => service.eventWaits().find((w) => w.taskId === taskId), "the guard to wait");
    await service.close();

    const project = openProject(dir, { baseDir: testHome() });
    try {
      const row = project.runtime.get(taskId)!;
      expect(row.status).toBe("canceled");
      expect(JSON.parse(row.failureJson!)).toMatchObject({ reason: SUSPENDED_WAITING });
      // When its guard began waiting is kept, so the resume counts from then.
      expect(project.eventWaits.since(taskId, "git.pushed")).toBeGreaterThan(0);
    } finally {
      project.close();
    }

    pushes = [];
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false });
    await service.open(dir);
    // What the watcher's first look after the start would deliver — before the resumed run re-arms.
    service.deliverEvent(dir, push("main", "abc"));
    await until(() => statusOf(taskId) === "completed", "the resumed run to take the event and complete");
    await service.close();
    expect(entered(taskId, "deploy_on_push/deploy")).toBe(true);
    // Done for good: its wait starts are gone.
    const after = openProject(dir, { baseDir: testHome() });
    try {
      expect(after.eventWaits.since(taskId, "git.pushed")).toBeUndefined();
    } finally {
      after.close();
    }
  });
});
