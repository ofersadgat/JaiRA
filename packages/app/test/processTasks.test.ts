/**
 * A process is a task (decision 0032, "The view"): each process the engine keeps is a task of the
 * built-in `Process` workflow in every list a window reads — `task:list`, `task:all`, `sync:since`,
 * the board's root listing and the workflow opened — under the task that started it, and nowhere on disk.
 * Deleting or archiving one stops it; nothing else about a task can be asked of one.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, writeWorkflowFiles, type SessionProcessSummary } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { AppService, serviceHandlers } from "@jaira/service";
import { PROCESS_WORKFLOW, sessionKey, type BoardView, type ProcessListAnswer, type ProcessSummary, type ProjectTask, type SyncPage, type TaskDetail, type TaskSummary } from "@jaira/shared";

let dir: string;
let service: AppService;
let handlers: Record<string, (request: unknown) => unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-process-tasks-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, specPlanningFiles());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(dir);
  handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await service.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows sometimes holds a fresh temp folder a moment longer (as in taskHome.test.ts); it is a temp folder.
  }
});

const ask = async <T,>(channel: string, request?: unknown): Promise<T> => (await handlers[channel]!(request)) as T;

/** A task, and a background process of its session as its `SessionProcesses` would report it. */
function withProcess(over: Partial<SessionProcessSummary> = {}): { parent: string; stops: string[]; text: { value: string } } {
  const parent = service.createTask({ title: "Dev server and the gutter", workflow: "feature/plan", inputs: { issue: "x" }, project: dir }).taskId;
  const stops: string[] = [];
  const text = { value: "" };
  const sp = {
    byKey: () => undefined,
    stopKey: (_pid: number, _startedAt: number, how?: string) => {
      stops.push(how ?? "stop");
      return undefined;
    },
    peek: (pid: number, startedAt: number, since = 0) => ({ summary: { pid, startedAt } as SessionProcessSummary, output: text.value.slice(since), offset: text.value.length }),
  };
  const summary: SessionProcessSummary = { pid: 84456, startedAt: Date.now(), command: "npx one dev --port 8145", how: "background", running: true, output: "spawned", callId: "toolu_1", ...over };
  service.processes.fromSession(parent, { dir, key: sessionKey(dir) }, summary, sp);
  return { parent, stops, text };
}

const processTaskOf = (tasks: ReadonlyArray<TaskSummary>): TaskSummary => tasks.find((t) => t.type === "process")!;

describe("a process task", () => {
  it("is in every list a window reads, under the task that started it", async () => {
    const { parent } = withProcess();
    const listed = processTaskOf(await ask<TaskSummary[]>("task:list", { project: dir }));
    expect(listed).toMatchObject({ type: "process", workflow: PROCESS_WORKFLOW, parentTaskId: parent, title: "one dev", status: "running", process: { pid: 84456, origin: "background", parentTaskId: parent } });

    const all = await ask<ProjectTask[]>("task:all");
    expect(all.find((t) => t.taskId === listed.taskId)).toMatchObject({ project: dir, type: "process" });
    // A list narrowed to other workflows (the Chat view's) leaves it out.
    expect((await ask<ProjectTask[]>("task:all", { workflows: ["feature/plan"] })).some((t) => t.type === "process")).toBe(false);

    const whole = await ask<SyncPage>("sync:since", { since: 0 });
    expect(whole.tasks.find((t) => t.taskId === listed.taskId)).toMatchObject({ type: "process", parentTaskId: parent });

    const roots = await ask<BoardView>("board:roots", { project: dir });
    const column = roots.columns.find((c) => c.key === PROCESS_WORKFLOW)!;
    expect(column.cards.map((c) => c.taskId)).toEqual([listed.taskId]);
    const opened = await ask<BoardView>("board:view", { level: PROCESS_WORKFLOW, project: dir });
    expect(opened.breadcrumb).toEqual([{ stateId: PROCESS_WORKFLOW, label: PROCESS_WORKFLOW }]);
    expect(opened.columns.flatMap((c) => c.cards).map((c) => c.taskId)).toEqual([listed.taskId]);

    const detail = await ask<TaskDetail>("task:detail", { taskId: listed.taskId });
    expect(detail).toMatchObject({ taskId: listed.taskId, workflow: PROCESS_WORKFLOW, type: "process", process: { pid: 84456, taskId: parent } });
    expect(await ask<ProcessSummary>("process:get", { taskId: listed.taskId })).toMatchObject({ key: detail.process!.key });
    expect((await ask<ProcessListAnswer>("process:list", { scope: "session", taskId: parent })).processes.map((p) => p.pid)).toEqual([84456]);
    expect((await ask<ProcessListAnswer>("process:list", { scope: "project", project: dir })).processes).toHaveLength(1);
  });

  it("is written nowhere: no task file, no row; a window's index hears it through the change log alone", async () => {
    const before = await ask<SyncPage>("sync:since", { since: 0 });
    withProcess();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const id = processTaskOf(service.listTasks(dir)).taskId;
    const files = existsSync(join(dir, ".jaira", "tasks")) ? readdirSync(join(dir, ".jaira", "tasks")) : [];
    expect(files.some((f) => f.includes(id))).toBe(false);
    // A page from before it says it is new; deleting it is a `gone`.
    const page = await ask<SyncPage>("sync:since", { since: before.at });
    expect(page.tasks.map((t) => t.taskId)).toContain(id);
    await ask("task:delete", { taskId: id });
    const after = await ask<SyncPage>("sync:since", { since: page.at });
    expect(after.gone).toContain(id);
    expect(service.listTasks(dir).some((t) => t.type === "process")).toBe(false);
  });

  it("is stopped by deleting, archiving or cancelling it, and refuses what a stored task does", async () => {
    const { stops } = withProcess();
    const id = processTaskOf(service.listTasks(dir)).taskId;
    await ask("task:cancel", { taskId: id });
    expect(stops).toEqual(["stop"]);
    await expect(ask("task:rename", { taskId: id, title: "x" })).rejects.toThrow(/is a process task/);
    await expect(ask("task:start", { taskId: id })).rejects.toThrow(/is a process task/);
    await expect(ask("chat:send", { taskId: id, instanceId: "", message: "hi" })).rejects.toThrow(/is a process task/);
    expect(await ask<{ changed: string[] }>("task:archive", { taskIds: [id] })).toEqual({ changed: [id] });
    expect(stops).toEqual(["stop", "stop"]);
    expect(service.listTasks(dir).some((t) => t.type === "process")).toBe(false);
  });

  it("goes with its task when the task is deleted", async () => {
    const { parent } = withProcess();
    await ask("task:delete", { taskId: parent });
    expect(service.listTasks(dir).some((t) => t.type === "process")).toBe(false);
  });

  it("tells its task once when its output matches, as a message the app sends for the person", async () => {
    const send = vi.spyOn(service, "sendChatMessage").mockResolvedValue({} as never);
    const { parent } = withProcess();
    const key = (await ask<ProcessListAnswer>("process:list", { scope: "session", taskId: parent })).processes[0]!.key;
    const armed = await ask<ProcessSummary>("process:tellWhen", { key, pattern: "listening on", flags: "i" });
    expect(armed.tellWhen).toMatchObject({ pattern: "listening on", flags: "i" });
    service.processes.output({ pid: 84456, startedAt: armed.startedAt }, "compiling\nListening on :8145\na\nb\nc\nlistening on :8146\nd\ne\nf\n");
    expect(send).toHaveBeenCalledTimes(1);
    const [request, origin] = send.mock.calls[0]!;
    expect(origin).toEqual({ by: "host" });
    expect(request).toMatchObject({ taskId: parent, project: dir });
    expect(request.message).toContain("Listening on :8145");
    expect(request.message).toContain("compiling");
    expect((await ask<ProcessSummary>("process:get", { key })).tellWhen).toBeUndefined();
  });
});
