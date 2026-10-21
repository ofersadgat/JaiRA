/**
 * A task an open finds `running` under a claim this process does not hold is looked at again when that
 * claim would have gone stale — and recovered then, as the next open would recover it, rather than left
 * `running` with nothing running until the project is opened again (task-lifecycle's "the app reopens
 * inside the claim's stale window after a crash"). A claim whose process is known dead is ended at the
 * open itself (`JobStore.deadOwners`); this covers the ones it cannot judge — another host, no pid.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_STALE_MS, initProject, newOwnerToken, openProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

let dir: string;
let service: AppService | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-claim-recheck-"));
  initProject(dir, testHome());
});

afterEach(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

it("recovers a task whose claim goes stale after the open, without another open", async () => {
  const project = openProject(dir, { baseDir: testHome() });
  project.runtime.insert("t-1", Date.now());
  project.runtime.beginTask("t-1", "hash", Date.now());
  project.runtime.setStatus("t-1", "running", Date.now());
  // Another process's claim, with no pid to judge it by, beating its last a moment before it would go
  // stale: the open must believe it, and must not believe it for long.
  project.jobs.claimRun({ taskId: "t-1", ownerToken: newOwnerToken(), nowMs: Date.now() - DEFAULT_STALE_MS + 600 });
  project.db.prepare(`UPDATE jobs SET process_token = 'another-process'`).run();
  project.close();

  service = new AppService({ baseDir: testHome(), publish: () => undefined });
  await service.open(dir);
  expect(service.taskDetail("t-1", dir).status).toBe("running");

  const deadline = Date.now() + 5_000;
  while (service.taskDetail("t-1", dir).status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  expect(service.taskDetail("t-1", dir).status).toBe("interrupted");
}, 20_000);
