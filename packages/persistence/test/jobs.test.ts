/**
 * Process claims and liveness (DESIGN §4.2a).
 *
 * The behaviour that motivated the table: recovery used to *assume* no other
 * process existed, so opening a project while a run was live falsely interrupted
 * it. These tests pin the fix, plus the two things the table bought on the way —
 * child-process visibility and cross-process cancel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, type Project } from "../src/project";
import { DEFAULT_STALE_MS, JobStore, newOwnerToken } from "../src/jobs";
import { RunOwner } from "../src/jobOwner";

let dir: string;
let project: Project;

const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-jobs-"));
  initProject(dir);
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task with an open run, as a live process would leave it. */
function runningTask(taskId = "t-1"): number {
  project.runtime.insert(taskId, NOW);
  const runId = project.runtime.beginRun(taskId, "hash", NOW);
  project.runtime.setStatus(taskId, "running", NOW);
  return runId;
}

describe("liveness", () => {
  it("reports a claim as live while it keeps beating", () => {
    const jobs = new JobStore(project.db);
    const token = newOwnerToken();
    jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: token, nowMs: NOW });

    expect(jobs.liveRunJob("t-1", NOW)).toMatchObject({ ownerToken: token, kind: "run" });
    // One beat short of the window: still live.
    expect(jobs.liveRunJob("t-1", NOW + DEFAULT_STALE_MS - 1)).toBeDefined();
    // Past it: the owner is presumed gone.
    expect(jobs.liveRunJob("t-1", NOW + DEFAULT_STALE_MS + 1)).toBeUndefined();

    jobs.heartbeat(token, NOW + DEFAULT_STALE_MS);
    expect(jobs.liveRunJob("t-1", NOW + DEFAULT_STALE_MS + 1)).toBeDefined();
  });

  it("identifies an owner by token, not pid", () => {
    // A pid is not an identity — after a reboot, 1234 is some other program.
    const jobs = new JobStore(project.db);
    const mine = newOwnerToken();
    jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: mine, pid: 1234, nowMs: NOW });

    expect(jobs.isClaimedElsewhere("t-1", mine, NOW)).toBe(false);
    expect(jobs.isClaimedElsewhere("t-1", newOwnerToken(), NOW)).toBe(true);
  });

  it("treats a released claim as gone even within the window", () => {
    const jobs = new JobStore(project.db);
    const token = newOwnerToken();
    const jobId = jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: token, nowMs: NOW });
    jobs.end(jobId, "released", NOW + 10);
    expect(jobs.liveRunJob("t-1", NOW + 20)).toBeUndefined();
  });
});

describe("recovery", () => {
  it("does NOT interrupt a task another live process is driving", () => {
    // This is the whole point. Before §4.2a the second open took the task away from
    // a process that was still running it.
    runningTask();
    project.jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: newOwnerToken(), nowMs: Date.now() });
    project.close();

    project = openProject(dir);

    expect(project.recovered).toEqual([]);
    expect(project.runtime.get("t-1")?.status).toBe("running");
  });

  it("interrupts a task whose owner stopped breathing", () => {
    runningTask();
    // A claim from long ago: the process that made it is gone.
    project.jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: newOwnerToken(), nowMs: Date.now() - 10 * 60_000 });
    project.close();

    project = openProject(dir);

    expect(project.recovered).toEqual(["t-1"]);
    expect(project.runtime.get("t-1")?.status).toBe("interrupted");
  });

  it("interrupts a task with no claim at all — the pre-jobs case still works", () => {
    runningTask();
    project.close();

    project = openProject(dir);

    expect(project.recovered).toEqual(["t-1"]);
  });
});

describe("child processes", () => {
  it("records a spawn against the run that owns it, and closes it on exit", () => {
    const owner = new RunOwner({ jobs: project.jobs, taskId: "t-1", runId: 1, now: () => NOW });
    const observer = owner.observer();

    const token = observer.onSpawn({ command: "git", argv: ["status"], pid: 42 });
    expect(token).toBeDefined();
    const spawned = project.jobs.list("t-1").find((j) => j.kind === "process")!;
    expect(spawned).toMatchObject({ command: "git status", pid: 42, parentJobId: owner.jobId });
    expect(spawned.endedAt).toBeUndefined();

    observer.onExit(token, { code: 0, signal: null });
    expect(project.jobs.list("t-1").find((j) => j.kind === "process")!.outcome).toBe("exit:0");
    owner.release();
  });

  it("surfaces a child abandoned by a dead owner as an orphan", () => {
    // The case this exists for: the app dies and its `claude` keeps running, keeps
    // billing, and nothing records that it ever existed.
    const stale = Date.now() - 10 * 60_000;
    const token = newOwnerToken();
    project.jobs.claimRun({ taskId: "t-1", runId: 1, ownerToken: token, nowMs: stale });
    project.jobs.spawned({ ownerToken: token, taskId: "t-1", command: "claude -p", pid: 999, nowMs: stale });
    project.close();

    project = openProject(dir);

    expect(project.orphans).toHaveLength(1);
    expect(project.orphans[0]).toMatchObject({ command: "claude -p", pid: 999 });
    // Reported, then reaped — but never killed: a pid alone is not identity.
    expect(project.jobs.orphans(Date.now())).toEqual([]);
  });

  it("releasing an owner closes children it never saw exit", () => {
    const owner = new RunOwner({ jobs: project.jobs, taskId: "t-1", runId: 1 });
    owner.observer().onSpawn({ command: "bash", argv: ["-lc", "sleep 100"], pid: 7 });

    owner.release("run finished");

    const open = project.jobs.list("t-1").filter((j) => j.endedAt === undefined);
    expect(open).toEqual([]);
  });
});

describe("cross-process cancel", () => {
  it("is a flag the owner polls — no socket needed", () => {
    let canceled = false;
    const owner = new RunOwner({
      jobs: project.jobs,
      taskId: "t-1",
      runId: 1,
      onCancelRequested: () => (canceled = true),
    });

    // Another process asks.
    expect(project.jobs.requestCancel("t-1", Date.now())).toBe(true);
    // The owner notices on its next beat.
    owner.beat();

    expect(canceled).toBe(true);
    owner.release();
  });

  it("reports that there was nothing to cancel", () => {
    expect(project.jobs.requestCancel("t-nope", Date.now())).toBe(false);
  });
});
