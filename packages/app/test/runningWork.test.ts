/**
 * What the quit dialog lists (`AppService.runningWork`): each task with work in flight, named, and
 * whether it is parked. A run parked on a gate is listed as waiting on the person — a quit suspends it
 * and the next open asks again — so "wait, then quit" does not wait for it (`main/quitGuard.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

const ROOT = "gated";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-running-work-"));
  const { workflowsDir } = initProject(dir, testHome());
  writeWorkflowFiles(workflowsDir, {
    [ROOT]: {
      label: "Gated",
      outputs: { decision: { schema: { type: "string" } } },
      operation: { kind: "function", function: "choose_option", args: { prompt: "which way?", options: ["left", "right"] } },
    },
  });
  service = new AppService({ baseDir: testHome(), publish: () => undefined });
  await service.open(dir);
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("runningWork", () => {
  it("is nothing with nothing going", () => {
    expect(service.runningWork()).toEqual([]);
  });

  it("lists a run parked on a gate, named, as waiting on the person — and activeWork does not count it", async () => {
    const { taskId } = service.createTask({ title: "Pick a way", workflow: ROOT });
    await service.startTask({ taskId });
    await until(() => service.pendingInteractions().some((p) => p.taskId === taskId), "the gate");
    expect(service.runningWork()).toEqual([{ taskId, project: expect.any(String), title: "Pick a way", kind: "run", waiting: "person" }]);
    expect(service.activeWork()).toEqual({ runs: 0, turns: 0 });
  });
});
