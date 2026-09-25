/**
 * The events task, through the service (decision 0010 §4).
 *
 * One task of `system/events` per project, kept by the supervisor: made when the workflow has an
 * automation and not before, resumed across a restart, restarted on a new version, stopped at zero.
 * And end to end: a push delivered to the project's hub fires a line, whose first step starts a task
 * of the target workflow with inputs read off `.event` and records where it came from, and whose second
 * step — reading the event through the first step's output — posts a notice while the started task is
 * still running (a start is never waited out).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_WORKFLOW, flattenInstances, initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import { automationStateIdOf, automationStateOf, jairaBasePaths, type AutomationStep, type JairaEvent, type PushMessage, type TaskSummary } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { SUSPENDED_WAITING } from "../src/main/session";

vi.setConfig({ testTimeout: 60_000 });

/**
 * One automation, as the Automations editor writes it: a named line handing the event to ONE async
 * child, whose state `system/events/<name>` runs two calls in order — start a task, then tell me.
 */
function automation(name: string, filter: string, workflow: string, options: { topLevel?: boolean } = {}): { name: string; line: Record<string, JsonValue>; children: Record<string, JsonValue>; state: Record<string, unknown> } {
  const steps: AutomationStep[] = [
    { kind: "start", workflow, inputs: { issue: { event: "payload.commits[0].message" }, ask_below: { literal: 0.8 } }, ...(options.topLevel === true ? { topLevel: true } : {}) },
    { kind: "notify", text: `started ${workflow}` },
  ];
  return {
    name,
    line: { name, when: `on_event('git.push', ${filter})`, to: name, inputs: { event: ".event" } },
    children: { [name]: { async: true } },
    state: automationStateOf(name, steps),
  };
}

/** The project's own copy of the events workflow — the built-in's, with these automations — and their states. */
function eventsCopy(...autos: Array<ReturnType<typeof automation>>): Record<string, JsonValue> {
  return {
    [EVENTS_WORKFLOW]: {
      $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`,
      transitions: autos.map((a) => a.line),
      children: Object.assign({}, ...autos.map((a) => a.children)) as JsonValue,
    },
    ...Object.fromEntries(autos.map((a) => [automationStateIdOf(a.name), a.state as JsonValue])),
  };
}

/** The workflow a line starts: it takes the inputs, then listens for something that never comes — it never finishes here. */
const review: Record<string, JsonValue> = {
  "feature/review": {
    label: "Review",
    inputs: { issue: { schema: { type: "string" } }, ask_below: { schema: { type: "number" } } },
    transitions: [{ when: "on_event('git.merge_request.opened')", to: "terminate.success" }],
  },
};

const push = (branch: string, after: string, message: string): JairaEvent => ({
  name: "git.push",
  payload: {
    remote: "origin",
    connection: "github",
    host: "github.com",
    repository: "acme/app",
    branch,
    before: "0000000",
    after,
    commits: [{ sha: after, message, author: "ofer" }],
  },
});

let dir: string;
let workflowsDir: string;
let service: AppService;
let pushes: PushMessage[];

async function start(): Promise<void> {
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false, eventsRestartDelayMs: 50 });
  await service.open(dir);
}

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-events-task-"));
  workflowsDir = initProject(dir, testHome()).workflowsDir;
  writeWorkflowFiles(workflowsDir, review);
  await start();
  service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), events: { "git.push": { enabled: true } } } as JsonValue });
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  await removeDir(dir);
});

/**
 * Gone, allowing for the process the repository watcher ran in the project a moment before the close:
 * on Windows its working directory keeps the folder busy for a beat after the service let go.
 */
async function removeDir(at: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      rmSync(at, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || tries > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 45_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      // What the service said is what explains a wait that never ended — a refused start, a failed load.
      const said = service.readLogs({}).entries.filter((e) => e.level !== "info").slice(0, 10).map((e) => `${e.source}: ${e.message}`);
      throw new Error(`timed out waiting for ${label}${said.length > 0 ? `\n  ${said.join("\n  ")}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const eventsTasks = (): TaskSummary[] => service.listTasks().filter((t) => t.system === "events");
const theEventsTask = (): TaskSummary | undefined => {
  const all = eventsTasks();
  return all.length === 1 ? all[0] : undefined;
};
/** The events task, listening: its guards armed on the hub. */
const listening = (): TaskSummary | undefined => {
  const task = theEventsTask();
  return task !== undefined && task.status === "running" && service.eventWaits().some((w) => w.taskId === task.taskId && w.waiter === "guard") ? task : undefined;
};

describe("the events task's supervisor", () => {
  it("makes no events task while the workflow has no automations — the built-in has none", async () => {
    await service.superviseEventsTasks();
    expect(eventsTasks()).toEqual([]);
  });

  it("makes ONE, titled `events`, when there is an automation, and starts it listening", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    await service.superviseEventsTasks();
    const task = await until(listening, "the events task to listen");
    expect(task).toMatchObject({ title: "events", workflow: EVENTS_WORKFLOW, system: "events" });
    expect(service.eventWaits()).toMatchObject([{ taskId: task.taskId, name: "git.push", filter: { branch: "main" } }]);
  });

  it("is resumed after a restart — suspended by the close, or interrupted — keeping its id", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const { taskId } = await until(listening, "the events task to listen");
    await service.close();
    const project = openProject(dir, { baseDir: testHome() });
    try {
      expect(JSON.parse(project.runtime.get(taskId)!.failureJson!)).toMatchObject({ reason: SUSPENDED_WAITING });
    } finally {
      project.close();
    }

    await start();
    expect((await until(listening, "the resumed events task to listen")).taskId).toBe(taskId);
    await service.close();

    // A crash rather than a close: the row says interrupted, and the supervisor resumes it.
    const crashed = openProject(dir, { baseDir: testHome() });
    try {
      crashed.runtime.setStatus(taskId, "interrupted", Date.now());
    } finally {
      crashed.close();
    }
    await start();
    expect((await until(listening, "the interrupted events task to listen again")).taskId).toBe(taskId);
  });

  it("restarts on a new version when its workflow is written — a new task, the old one gone", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const first = await until(listening, "the events task to listen");

    // Through the write surface, so the kick that every workflow write makes is what restarts it — the
    // new line's state first, as the editor writes them, then the root that names it.
    const both = eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review"), automation("push_release", "{ branch: 'release/*' }", "feature/review"));
    service.writeWorkflow({ stateId: automationStateIdOf("push_release"), layer: "project", project: dir, text: JSON.stringify(both[automationStateIdOf("push_release")]) });
    service.writeWorkflow({ stateId: EVENTS_WORKFLOW, layer: "project", project: dir, text: JSON.stringify(both[EVENTS_WORKFLOW]) });
    const second = await until(() => {
      const task = listening();
      return task !== undefined && task.taskId !== first.taskId && service.eventWaits().filter((w) => w.taskId === task.taskId).length === 2 ? task : undefined;
    }, "the events task to restart on the new version");
    expect(eventsTasks().map((t) => t.taskId)).toEqual([second.taskId]);
    expect(second.snapshotHash).not.toBe(first.snapshotHash);

    // Nothing changed: nothing moves.
    await service.superviseEventsTasks();
    expect(listening()?.taskId).toBe(second.taskId);
  });

  it("stops it when the last automation is taken out", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const { taskId } = await until(listening, "the events task to listen");
    writeWorkflowFiles(workflowsDir, eventsCopy());
    await service.superviseEventsTasks();
    await until(() => theEventsTask()?.status === "canceled", "the events task to stop");
    expect(theEventsTask()?.taskId).toBe(taskId);
    expect(service.eventWaits()).toEqual([]);
  });

  it("Shared's copy runs in Shared AND in every project that keeps no copy of its own — one events task each", async () => {
    writeWorkflowFiles(jairaBasePaths(testHome()).workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const inProject = await until(listening, "the project's events task to listen");
    const inShared = await until(() => {
      const found = service.listSystemTasks().filter((t) => t.system === "events");
      return found.length === 1 && found[0]!.status === "running" ? found[0] : undefined;
    }, "Shared's events task to run");
    expect(inShared.taskId).not.toBe(inProject.taskId);
  });

  it("replaces a task that ended on its own with a fresh one", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const { taskId } = await until(listening, "the events task to listen");
    await service.close();
    const project = openProject(dir, { baseDir: testHome() });
    try {
      project.runtime.setStatus(taskId, "failed", Date.now());
    } finally {
      project.close();
    }
    await start();
    const fresh = await until(() => {
      const task = listening();
      return task !== undefined && task.taskId !== taskId ? task : undefined;
    }, "a fresh events task");
    expect(eventsTasks().map((t) => t.taskId)).toEqual([fresh.taskId]);
  });
});

describe("an events task that fails on its own", () => {
  it("is started again, as a new task, after a pause — a step's failure does not end the automations for good", async () => {
    // A start naming no workflow: `start_task` refuses it, the automation's operation list fails, nothing
    // handles the child's failure, and the events task fails with it.
    const broken = automation("push_main", "{ branch: 'main' }", "");
    writeWorkflowFiles(workflowsDir, eventsCopy(broken));
    await service.superviseEventsTasks();
    const first = await until(listening, "the events task to listen");
    service.deliverEvent(dir, push("main", "a1b2c3d4e5f6", "anything"));
    const second = await until(() => {
      const task = listening();
      return task !== undefined && task.taskId !== first.taskId ? task : undefined;
    }, "a new events task after the failure");
    expect(eventsTasks().map((t) => t.taskId)).toEqual([second.taskId]);
    expect(service.readLogs({}).entries.some((e) => e.source === "events" && /the events task failed/.test(e.message))).toBe(true);
  });
});

describe("an automation, end to end", () => {
  const readMeta = (taskId: string) => {
    const project = openProject(dir, { baseDir: testHome() });
    try {
      return project.tasks.read(taskId);
    } finally {
      project.close();
    }
  };

  it("a push fires the line: call 1 starts the task as the automation's CHILD, call 2 tells me — one state, two calls in order", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const events = await until(listening, "the events task to listen");

    // Another branch's push is not this line's.
    service.deliverEvent(dir, push("release/2.0", "ffffffffff", "not this"));
    service.deliverEvent(dir, push("main", "a1b2c3d4e5f6", "Paginate the merge request list"));

    const started = await until(() => service.listTasks().find((t) => t.origin?.kind === "started"), "a task started by the events task");
    // Its provenance: the events task, the automation that called (from the engine's dispatch site, read
    // off the events task's journal), the first firing, call 0 of the list — and the event, in a line.
    expect(started).toMatchObject({
      workflow: "feature/review",
      title: "feature/review",
      origin: { kind: "started", taskId: events.taskId, key: "push_main", index: 0, event: "git.push a1b2c3d on main", stateId: automationStateIdOf("push_main"), label: "started by events · push_main · git.push a1b2c3d on main" },
    });
    expect(started.startedBy).toBeUndefined();
    const meta = readMeta(started.taskId);
    expect(meta.inputs).toEqual({ issue: "Paginate the merge request list", ask_below: 0.8 });
    expect(meta.origin).toEqual({
      kind: "started",
      taskId: events.taskId,
      key: "push_main",
      index: 0,
      event: { name: "git.push", summary: "git.push a1b2c3d on main" },
      state: { stateId: automationStateIdOf("push_main"), path: "push_main" },
    });

    // Call 2 ran — the notice names the event its state was entered with — while the started task still runs.
    const notice = await until(() => service.notices()[0], "the notice");
    expect(notice).toMatchObject({ project: dir, taskId: events.taskId, text: "started feature/review", event: "git.push", summary: "git.push a1b2c3d on main" });
    expect(pushes.some((m) => m.type === "notice:posted")).toBe(true);
    await until(() => service.listTasks().find((t) => t.taskId === started.taskId)?.status === "running", "the started task to be running");

    // The events task lists it as a CHILD of the automation, as a fan-out's task is listed: in its Steps …
    const detail = service.taskDetail(events.taskId);
    const firing = flattenInstances(detail.instances).find((node) => node.childKey === "push_main")!;
    expect(firing.operationCalls?.map((call) => call.status)).toEqual(["completed", "completed"]);
    expect(firing.children.map((node) => [node.instanceId, node.made])).toEqual([[started.taskId, { taskId: started.taskId, kind: "started" }]]);
    // … and in its conversation, a line at the automation that opens the task.
    const line = service.conversation(events.taskId).turns.find((turn) => turn.kind === "made");
    expect(line).toMatchObject({ path: "push_main", instanceId: firing.instanceId, made: { kind: "started", runs: [{ taskId: started.taskId, title: "feature/review", status: "running", self: false }] } });

    // On a board it is drawn as a fan-out's task is: in the automation's column of the events task's board,
    // not among the roots.
    expect(service.boardRoots({ project: dir }).columns.flatMap((c) => c.cards).some((c) => c.taskId === started.taskId)).toBe(false);
    const card = service.board({ project: dir, level: EVENTS_WORKFLOW }).columns.find((c) => c.key === "push_main")?.cards.find((c) => c.taskId === started.taskId);
    expect(card?.origin).toMatchObject({ kind: "started", key: "push_main", event: "git.push a1b2c3d on main", stateId: automationStateIdOf("push_main") });

    // And the events task is listening again, for the next one — a second firing is occurrence 1.
    await until(() => (listening() !== undefined && service.eventWaits().some((w) => w.taskId === events.taskId) ? true : undefined), "the line to re-arm");
    expect(service.listTasks().filter((t) => t.origin?.kind === "started")).toHaveLength(1);
    service.deliverEvent(dir, push("main", "b2c3d4e5f6a7", "Second"));
    const second = await until(() => service.listTasks().find((t) => t.origin?.kind === "started" && t.taskId !== started.taskId), "the second started task");
    expect(readMeta(second.taskId).origin).toMatchObject({ key: "push_main", occurrence: 1, index: 0 });

    // A child that ends writes the end of its mirror, as a fan-out's element does.
    service.cancelTask(started.taskId, dir);
    await until(() => {
      const node = flattenInstances(service.taskDetail(events.taskId).instances).find((n) => n.instanceId === started.taskId);
      return node !== undefined && node.status !== "running" ? node : undefined;
    }, "the mirror to end");
  });

  it("resumes across a restart with its started children mirrored in its journal — they are not part of its machine", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    await service.superviseEventsTasks();
    const events = await until(listening, "the events task to listen");
    service.deliverEvent(dir, push("main", "a1b2c3d4e5f6", "First"));
    const first = await until(() => service.listTasks().find((t) => t.origin?.kind === "started"), "the first started task");
    await until(() => (listening() !== undefined && service.eventWaits().some((w) => w.taskId === events.taskId) ? true : undefined), "the line to re-arm");
    await service.close();

    await start();
    expect((await until(listening, "the resumed events task to listen")).taskId).toBe(events.taskId);
    service.deliverEvent(dir, push("main", "b2c3d4e5f6a7", "Second"));
    const second = await until(() => service.listTasks().find((t) => t.origin?.kind === "started" && t.taskId !== first.taskId), "a task started after the resume");
    expect(readMeta(second.taskId).origin).toMatchObject({ taskId: events.taskId, key: "push_main", occurrence: 1 });
    const children = flattenInstances(service.taskDetail(events.taskId).instances).filter((n) => n.made?.kind === "started").map((n) => n.instanceId);
    expect(children.sort()).toEqual([first.taskId, second.taskId].sort());
  });

  it("`top_level: true` starts it ON ITS OWN: nothing mirrored, and `startedBy` names the task, the automation and the event", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review", { topLevel: true })));
    await service.superviseEventsTasks();
    const events = await until(listening, "the events task to listen");
    service.deliverEvent(dir, push("main", "a1b2c3d4e5f6", "Paginate the merge request list"));

    const started = await until(() => service.listTasks().find((t) => t.startedBy !== undefined), "a task started on its own");
    expect(started.origin).toBeUndefined();
    expect(started.startedBy).toEqual({
      by: "events",
      fromTask: events.taskId,
      state: { key: "push_main", path: "push_main", stateId: automationStateIdOf("push_main"), occurrence: 0, call: 0 },
      event: "git.push",
      summary: "git.push a1b2c3d on main",
    });
    await until(() => service.notices()[0], "the notice");
    // Not the events task's child: nothing in its journal, and its card is among the roots with the line.
    expect(flattenInstances(service.taskDetail(events.taskId).instances).some((n) => n.instanceId === started.taskId)).toBe(false);
    const card = service.boardRoots({ project: dir }).columns.flatMap((c) => c.cards).find((c) => c.taskId === started.taskId);
    expect(card?.startedBy?.state?.stateId).toBe(automationStateIdOf("push_main"));
  });

  it("the lint says when a line's event is switched off in Settings", async () => {
    writeWorkflowFiles(workflowsDir, eventsCopy(automation("push_main", "{ branch: 'main' }", "feature/review")));
    const issuesOf = () => service.browseWorkflows(dir).workflows.find((w) => w.rootId === EVENTS_WORKFLOW)?.issues ?? [];
    expect(issuesOf().filter((i) => /switched off/.test(i.message))).toEqual([]);
    service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), events: {} } as JsonValue });
    expect(issuesOf()).toContainEqual(
      expect.objectContaining({ stateId: EVENTS_WORKFLOW, path: "transitions.0.when", severity: "warning", message: "git.push is switched off in Settings → Tools → Events, so this never fires" }),
    );
  });
});
