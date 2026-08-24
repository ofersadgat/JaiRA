import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginTaskRun,
  cancelTask,
  createTask,
  deleteTask,
  finishTaskRun,
  initProject,
  isProject,
  openProject,
  type Project,
} from "../src/index";
import { writeFileSync, mkdirSync } from "node:fs";

const WORKFLOW: Record<string, unknown> = {
  label: "Wf",
  inputs: { x: { schema: { type: "string" } } },
  outputs: { y: { schema: { type: "string" } } },
  operation: { kind: "prompt", prompt: "do {{.inputs.x}}", model: "p" },
};

let dir: string;
let project: Project | undefined;

function open(): Project {
  project = openProject(dir);
  return project;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-life-"));
  const paths = initProject(dir);
  writeFileSync(join(paths.workflowsDir, "wf.json"), JSON.stringify(WORKFLOW), "utf8");
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("project", () => {
  it("initProject creates the .jaira layout with a default config, idempotently", async () => {
    const paths = initProject(dir);
    for (const p of [paths.workflowsDir, paths.snapshotsDir, paths.tasksDir, paths.skillsDir, paths.settingsFile]) {
      expect(existsSync(p)).toBe(true);
    }
    expect(isProject(dir)).toBe(true);
    expect(isProject(join(dir, "elsewhere"))).toBe(false);
    expect(() => openProject(join(dir, "elsewhere"))).toThrow(/not a JaiRA project/);
  });
});

describe("task lifecycle", () => {
  it("create → start → finish, snapshotting the workflow at start", async () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
    expect(p.tasks.read(meta.id).inputs).toEqual({ x: "hello" });

    const started = await beginTaskRun(p, meta.id);
    expect(started.pinned).toBe(false);
    expect(p.runtime.get(meta.id)?.status).toBe("running");
    expect(p.runtime.get(meta.id)?.snapshotHash).toBe(started.snapshotHash);
    expect(existsSync(join(p.paths.snapshotsDir, started.snapshotHash, "wf.json"))).toBe(true);

    finishTaskRun(p, meta.id, started.runId, "completed", { outputs: { y: "done" } });
    expect(p.runtime.get(meta.id)?.status).toBe("completed");
    const run = p.runtime.listRuns(meta.id)[0];
    expect(run).toMatchObject({ outcome: "success", outputsJson: '{"y":"done"}' });
    // Terminal task cannot start again.
    await expect(() => beginTaskRun(p, meta.id)).rejects.toThrow(/completed/);
  });

  it("starts despite an unrelated half-saved state file", async () => {
    // Regression: `readWorkflowFiles` threw on the first unparsable file, so one
    // scratch file the workflow never references blocked EVERY task start. Only the
    // root's transitive closure matters.
    const p = open();
    writeFileSync(join(p.paths.workflowsDir, "scratch.json"), "{ half-written", "utf8");
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });

    const started = await beginTaskRun(p, meta.id);

    expect(p.runtime.get(meta.id)?.status).toBe("running");
    // The broken file is not in the snapshot either — it was never part of the bundle.
    expect(existsSync(join(p.paths.snapshotsDir, started.snapshotHash, "scratch.json"))).toBe(false);
  });

  it("names the unreadable files when the workflow itself will not load", async () => {
    const p = open();
    writeFileSync(join(p.paths.workflowsDir, "wf.json"), "{ broken", "utf8");
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    // "unknown state 'wf'" alone would hide the real cause, so the parse error rides
    // along with it.
    await expect(() => beginTaskRun(p, meta.id)).rejects.toThrow(/unreadable files/);
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
  });

  it("enforces validation at task start and leaves the task queued on failure", async () => {
    const p = open();
    const badDir = join(p.paths.workflowsDir);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "bad.json"),
      JSON.stringify({ ...WORKFLOW, transitions: [{ to: "nowhere" }] }),
      "utf8",
    );
    const meta = createTask(p, { title: "B", workflow: "bad" });
    await expect(() => beginTaskRun(p, meta.id)).rejects.toThrow(/validation failed/);
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
    expect(p.runtime.listRuns(meta.id)).toHaveLength(0);
  });

  it("re-runs an interrupted task from the pinned snapshot, even after workflow edits", async () => {
    let p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    const started = await beginTaskRun(p, meta.id);
    const firstHash = started.snapshotHash;
    p.close(); // crash: never finished
    project = undefined;

    // Edit the live workflow after the crash — the pinned snapshot must win.
    writeFileSync(join(openPaths().workflowsDir, "wf.json"), JSON.stringify({ ...WORKFLOW, label: "Edited" }), "utf8");

    p = open();
    expect(p.recovered).toEqual([meta.id]);
    expect(p.runtime.get(meta.id)?.status).toBe("interrupted");
    expect(p.runtime.listRuns(meta.id)[0]?.outcome).toBe("interrupted");

    const rerun = await beginTaskRun(p, meta.id);
    expect(rerun.pinned).toBe(true);
    expect(rerun.snapshotHash).toBe(firstHash);
    expect(rerun.bundle.states["wf"]?.label).toBe("Wf"); // pinned content, not the edit
    finishTaskRun(p, meta.id, rerun.runId, "completed");
    expect(p.runtime.get(meta.id)?.status).toBe("completed");
    expect(p.runtime.listRuns(meta.id)).toHaveLength(2);
  });

  it("cancel is terminal and closes dangling runs", async () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf" });
    await beginTaskRun(p, meta.id);
    cancelTask(p, meta.id);
    expect(p.runtime.get(meta.id)?.status).toBe("canceled");
    expect(p.runtime.listRuns(meta.id)[0]?.outcome).toBe("canceled");
    expect(() => cancelTask(p, meta.id)).toThrow(/already canceled/);
    await expect(() => beginTaskRun(p, meta.id)).rejects.toThrow(/canceled/);
  });

  it("deletes a finished task: rows, journal, jobs, artifacts, and the JSON file", async () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hi" } });
    const started = await beginTaskRun(p, meta.id);
    // One row in everything that hangs off a task, so the cascade is actually exercised.
    p.events.recorder(meta.id, started.runId).record({ type: "instance.entered", instanceId: 1, stateId: "wf", inputs: {} }, Date.now());
    p.commands.record({ taskId: meta.id, runId: started.runId, tool: "bash", command: "ls", decision: "allowed", decidedBy: "policy" });
    const jobId = p.jobs.claimRun({ taskId: meta.id, runId: started.runId, ownerToken: "tok", nowMs: Date.now() });
    p.db
      .prepare(`INSERT INTO job_output (job_id, stream, seq, chunk, created_at) VALUES (?, 'stdout', 0, 'hi', ?)`)
      .run(jobId, Date.now());
    p.db
      .prepare(`INSERT INTO artifacts (task_id, run_id, logical_path, hash, bytes, created_at) VALUES (?, ?, 'out.txt', 'h', 2, ?)`)
      .run(meta.id, started.runId, Date.now());
    finishTaskRun(p, meta.id, started.runId, "completed");

    deleteTask(p, meta.id);

    expect(p.runtime.get(meta.id)).toBeUndefined();
    expect(p.tasks.tryRead(meta.id)).toBeUndefined();
    for (const table of ["runs", "state_machine_events", "command_log", "jobs", "job_output", "artifacts"]) {
      const n = (p.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
      expect({ table, n }).toEqual({ table, n: 0 });
    }
    expect(p.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses to delete a running task, and leaves it intact", async () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf" });
    await beginTaskRun(p, meta.id);
    expect(() => deleteTask(p, meta.id)).toThrow(/running/);
    expect(p.runtime.get(meta.id)?.status).toBe("running");
    expect(p.tasks.tryRead(meta.id)).toBeDefined();
  });

  it("deletes an interrupted task — pruning protects it, deleting is the user declining to resume", async () => {
    let p = open();
    const meta = createTask(p, { title: "T", workflow: "wf" });
    await beginTaskRun(p, meta.id);
    p.close(); // crash: never finished
    project = undefined;
    p = open();
    expect(p.runtime.get(meta.id)?.status).toBe("interrupted");

    deleteTask(p, meta.id);
    expect(p.runtime.get(meta.id)).toBeUndefined();
    expect(p.runtime.listRuns(meta.id)).toHaveLength(0);
  });

  it("delete is an error for an unknown task", async () => {
    const p = open();
    expect(() => deleteTask(p, "t-nowhere000")).toThrow(/unknown task/);
  });

  it("rejects duplicate ids and unknown workflows", async () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", id: "t-fixed00000" });
    expect(() => createTask(p, { title: "T2", workflow: "wf", id: meta.id })).toThrow(/already exists/);
    const missing = createTask(p, { title: "M", workflow: "does/not/exist" });
    await expect(() => beginTaskRun(p, missing.id)).rejects.toThrow(/not found/);
  });
});

function openPaths(): { workflowsDir: string } {
  return { workflowsDir: join(dir, ".jaira", "workflows") };
}
