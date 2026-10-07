/**
 * A task is found by its id, whatever project a request names.
 *
 * Seen 2026-10-06: two conversations made in JaiRA's checkout, then a window that came back from a
 * crash standing on mist-server. Every click on them asked mist-server, the engine answered "unknown
 * task 't-…' in C:\UbuntuCode\mist-server", and the window drew them empty — while their records,
 * transcripts and agents were all where they had been. All projects share one database, and
 * `task_owners` says which workspace made each task: the engine asks it rather than the window.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { AppService, serviceHandlers } from "@jaira/service";

let jaira: string;
let mist: string;
let service: AppService;
let handlers: Record<string, (request: unknown) => unknown>;

beforeEach(async () => {
  jaira = mkdtempSync(join(tmpdir(), "jaira-home-a-"));
  mist = mkdtempSync(join(tmpdir(), "jaira-home-b-"));
  for (const dir of [jaira, mist]) writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, specPlanningFiles());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(jaira);
  await service.open(mist);
  handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
});

afterEach(async () => {
  await service.close();
  rmSync(jaira, { recursive: true, force: true });
  rmSync(mist, { recursive: true, force: true });
});

const made = (project: string): string =>
  service.createTask({ title: "Fix permission mode switching bug", workflow: "feature/plan", inputs: { issue: "the issue" }, project }).taskId;

describe("a request about a task", () => {
  it("is answered from the project that owns the task, not the one it named", async () => {
    const taskId = made(jaira);
    // The window's guess, wrong: the project it was standing on.
    const detail = (await handlers["task:detail"]!({ taskId, project: mist })) as { taskId: string };
    expect(detail.taskId).toBe(taskId);
    const conversation = (await handlers["task:conversation"]!({ taskId, project: mist })) as unknown;
    expect(conversation).toBeTruthy();
  });

  it("needs no project at all, with several open", async () => {
    const taskId = made(mist);
    // Unnamed, with two open, used to be "several projects are open, so this call must name one".
    expect(((await handlers["task:detail"]!({ taskId })) as { taskId: string }).taskId).toBe(taskId);
  });

  it("acts where the task is too", async () => {
    const taskId = made(jaira);
    await handlers["task:rename"]!({ taskId, title: "Renamed", project: mist });
    expect(service.listTasks(jaira).find((t) => t.taskId === taskId)?.title).toBe("Renamed");
  });

  it("still refuses an id no project has, naming where it looked", async () => {
    await expect(Promise.resolve().then(() => handlers["task:detail"]!({ taskId: "t-nowhere", project: mist }))).rejects.toThrow(/unknown task 't-nowhere'/);
  });

  it("knows where each task lives", () => {
    const a = made(jaira);
    const b = made(mist);
    expect(service.homeOf(a)).toBe(service.listAllTasks().find((t) => t.taskId === a)?.project);
    expect(service.homeOf(b)).toBe(service.listAllTasks().find((t) => t.taskId === b)?.project);
    expect(service.homeOf("t-nowhere")).toBeUndefined();
  });
});
