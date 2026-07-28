/**
 * Process claims through a real run (DESIGN §4.2a).
 *
 * The unit tests drive the store directly. These check the wiring nobody would
 * notice was missing: that a run actually claims itself, that the claim is released
 * when it ends, and that a second process is refused rather than quietly taking the
 * task over.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openProject, newOwnerToken } from "@jaira/persistence";
import { runCli, type CliIo } from "../src/cli";
import { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(args, io);
  return { code, out, err };
}

async function createTask(): Promise<string> {
  const res = await cli(["task", "create", "--title", "Plan", "--workflow", "feature/plan", "--inputs", '{"issue":"x"}']);
  return (JSON.parse(res.out) as { taskId: string }).taskId;
}

const gate = JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] });

describe("a run claims itself", () => {
  it("records a run job and releases it when the run ends", async () => {
    const taskId = await createTask();
    await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);

    const project = openProject(dir);
    try {
      const jobs = project.jobs.list(taskId);
      const runJob = jobs.find((j) => j.kind === "run")!;
      expect(runJob).toBeDefined();
      expect(runJob.pid).toBe(process.pid);
      // Released: nothing is left claiming the task, so the next open is free to
      // recover or re-run it.
      expect(runJob.endedAt).toBeDefined();
      expect(project.jobs.liveRunJob(taskId, Date.now())).toBeUndefined();
    } finally {
      project.close();
    }
  });

  it("leaves no phantom orphans behind a clean run", async () => {
    const taskId = await createTask();
    await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);

    const project = openProject(dir);
    try {
      expect(project.orphans).toEqual([]);
    } finally {
      project.close();
    }
  });

  it("releases the claim even when the run fails", async () => {
    const taskId = await createTask();
    // No scripted gate answer: the human-review state fails.
    const res = await cli(["task", "start", taskId, "--fake", JSON.stringify(blockedRules())]);
    expect(res.code).toBe(1);

    const project = openProject(dir);
    try {
      expect(project.jobs.liveRunJob(taskId, Date.now())).toBeUndefined();
    } finally {
      project.close();
    }
  });
});

describe("a second process", () => {
  it("is refused rather than taking the task over", async () => {
    const taskId = await createTask();
    // Simulate a live owner elsewhere.
    const project = openProject(dir);
    project.runtime.beginRun(taskId, "hash", Date.now());
    project.jobs.claimRun({ taskId, runId: 1, ownerToken: newOwnerToken(), pid: 999, nowMs: Date.now() });
    project.close();

    const res = await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/already running in another process/);
  });

  it("requests a cancel instead of writing a terminal status", async () => {
    const taskId = await createTask();
    const project = openProject(dir);
    project.runtime.beginRun(taskId, "hash", Date.now());
    project.runtime.setStatus(taskId, "running", Date.now());
    project.jobs.claimRun({ taskId, runId: 1, ownerToken: newOwnerToken(), nowMs: Date.now() });
    project.close();

    const res = await cli(["task", "cancel", taskId]);

    expect(JSON.parse(res.out)).toMatchObject({ status: "cancel_requested" });
    const after = openProject(dir);
    try {
      // The owning process records the terminal status itself; this one must not
      // reach in and do it.
      expect(after.runtime.get(taskId)?.status).toBe("running");
      expect(after.jobs.list(taskId).find((j) => j.kind === "run")?.cancelRequestedAt).toBeDefined();
    } finally {
      after.close();
    }
  });
});

describe("orphan reporting", () => {
  it("warns about a process a dead session left running", async () => {
    const project = openProject(dir);
    const stale = Date.now() - 10 * 60_000;
    const token = newOwnerToken();
    project.jobs.claimRun({ taskId: "t-old", runId: 1, ownerToken: token, nowMs: stale });
    project.jobs.spawned({ ownerToken: token, taskId: "t-old", command: "claude -p", pid: 4321, nowMs: stale });
    project.close();

    const res = await cli(["task", "list"]);

    // Loud, because an abandoned agent is still billing.
    expect(res.err).toMatch(/process left running by a previous session: claude -p \(pid 4321\)/);
  });
});
