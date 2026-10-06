/**
 * The engine's side of decision 0018: `sync:since` and the `sync:changed` it pushes when its change
 * log moves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import type { PushMessage, SyncPage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService, serviceHandlers } from "@jaira/service";

let a: string;
let b: string;
let service: AppService;
let pushes: PushMessage[];
let handlers: Record<string, (request: unknown) => unknown>;

beforeEach(async () => {
  a = mkdtempSync(join(tmpdir(), "jaira-sync-a-"));
  b = mkdtempSync(join(tmpdir(), "jaira-sync-b-"));
  for (const dir of [a, b]) writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, specPlanningFiles());
  pushes = [];
  service = new AppService({ baseDir: testHome(), watchWorkflows: false, publish: (m) => pushes.push(m) });
  await service.open(a);
  await service.open(b);
  handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
});

afterEach(async () => {
  await service.close();
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

const made = (project: string, title = "Plan the feature"): string =>
  service.createTask({ title, workflow: "feature/plan", inputs: { issue: "the issue" }, project }).taskId;
const since = async (cursor: number): Promise<SyncPage> => (await handlers["sync:since"]!({ since: cursor })) as SyncPage;
const synced = (): Array<Extract<PushMessage, { type: "sync:changed" }>> => pushes.filter((m): m is Extract<PushMessage, { type: "sync:changed" }> => m.type === "sync:changed");

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("sync:since", () => {
  it("is everything from a cursor of 0, every project's tasks stamped with their project", async () => {
    const one = made(a);
    const two = made(b);
    const page = await since(0);
    expect(page.whole).toBe(true);
    expect(page.at).toBeGreaterThan(0);
    expect(Object.fromEntries(page.tasks.map((t) => [t.taskId, t.project]))).toMatchObject({ [one]: a, [two]: b });
  });

  it("is what changed from a cursor, inclusively, and nothing from one after it", async () => {
    const first = made(a);
    const cursor = (await since(0)).at;
    service.renameTask({ taskId: first, title: "Renamed", project: a });
    const page = await since(cursor);
    expect(page.whole).toBe(false);
    expect(page.tasks.map((t) => [t.taskId, t.title])).toEqual([[first, "Renamed"]]);
    expect(page.changes.some((c) => c.taskId === first)).toBe(true);
    expect((await since(page.at + 1)).tasks).toEqual([]);
  });

  it("is everything again once a project opens after the cursor — its tasks did not change, but the index did", async () => {
    const third = mkdtempSync(join(tmpdir(), "jaira-sync-c-"));
    writeWorkflowFiles(initProject(third, testHome()).workflowsDir, specPlanningFiles());
    const other = new AppService({ baseDir: testHome(), watchWorkflows: false });
    await other.open(third);
    const theirs = other.createTask({ title: "made before it was open here", workflow: "feature/plan", inputs: { issue: "i" }, project: third }).taskId;
    await other.close();
    try {
      const cursor = (await since(0)).at;
      await service.open(third);
      const page = await since(cursor);
      expect(page.whole).toBe(true);
      expect(page.tasks.map((t) => t.taskId)).toContain(theirs);
    } finally {
      rmSync(third, { recursive: true, force: true });
    }
  });

  it("names a deleted task among the gone", async () => {
    const doomed = made(a);
    const cursor = (await since(0)).at;
    await handlers["task:delete"]!({ taskId: doomed });
    const page = await since(cursor);
    expect(page.gone).toEqual([doomed]);
    expect(page.tasks.map((t) => t.taskId)).not.toContain(doomed);
  });
});

describe("sync:changed", () => {
  it("is pushed when the log moves, carrying what changed and the cursor before it", async () => {
    // The watcher's first look only takes its bearings.
    await new Promise((r) => setTimeout(r, 400));
    const before = synced().length;
    const id = made(b, "Survey the untested handlers");
    await until(() => synced().slice(before).some((m) => m.page.tasks.some((t) => t.taskId === id)), "a push naming the new task");
    const push = synced().slice(before).find((m) => m.page.tasks.some((t) => t.taskId === id))!;
    expect(push.page.tasks.find((t) => t.taskId === id)).toMatchObject({ title: "Survey the untested handlers", project: b });
    expect(push.prev).toBeLessThanOrEqual(push.page.at);
  });

  it("chains: each push's prev is the cursor the one before it left", async () => {
    await new Promise((r) => setTimeout(r, 400));
    const before = synced().length;
    made(a);
    await until(() => synced().length > before, "a first push");
    made(a);
    await until(() => synced().length > before + 1, "a second push");
    const [one, two] = synced().slice(before);
    expect(two!.prev).toBe(one!.page.at);
  });
});
