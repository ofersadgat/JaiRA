import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginTaskRun,
  cancelTask,
  createTask,
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
  operation: { kind: "prompt", prompt: { template: "do {{inputs.x}}" }, config: { model: "p" } },
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
  it("initProject creates the .jaira layout with a default config, idempotently", () => {
    const paths = initProject(dir);
    for (const p of [paths.workflowsDir, paths.snapshotsDir, paths.tasksDir, paths.skillsDir, paths.configFile]) {
      expect(existsSync(p)).toBe(true);
    }
    expect(isProject(dir)).toBe(true);
    expect(isProject(join(dir, "elsewhere"))).toBe(false);
    expect(() => openProject(join(dir, "elsewhere"))).toThrow(/not a JaiRA project/);
  });
});

describe("task lifecycle", () => {
  it("create → start → finish, snapshotting the workflow at start", () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
    expect(p.tasks.read(meta.id).inputs).toEqual({ x: "hello" });

    const started = beginTaskRun(p, meta.id);
    expect(started.pinned).toBe(false);
    expect(p.runtime.get(meta.id)?.status).toBe("running");
    expect(p.runtime.get(meta.id)?.snapshotHash).toBe(started.snapshotHash);
    expect(existsSync(join(p.paths.snapshotsDir, started.snapshotHash, "wf.json"))).toBe(true);

    finishTaskRun(p, meta.id, started.runId, "completed", { outputs: { y: "done" } });
    expect(p.runtime.get(meta.id)?.status).toBe("completed");
    const run = p.runtime.listRuns(meta.id)[0];
    expect(run).toMatchObject({ outcome: "success", outputsJson: '{"y":"done"}' });
    // Terminal task cannot start again.
    expect(() => beginTaskRun(p, meta.id)).toThrow(/completed/);
  });

  it("starts despite an unrelated half-saved state file", () => {
    // Regression: `readWorkflowFiles` threw on the first unparsable file, so one
    // scratch file the workflow never references blocked EVERY task start. Only the
    // root's transitive closure matters.
    const p = open();
    writeFileSync(join(p.paths.workflowsDir, "scratch.json"), "{ half-written", "utf8");
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });

    const started = beginTaskRun(p, meta.id);

    expect(p.runtime.get(meta.id)?.status).toBe("running");
    // The broken file is not in the snapshot either — it was never part of the bundle.
    expect(existsSync(join(p.paths.snapshotsDir, started.snapshotHash, "scratch.json"))).toBe(false);
  });

  it("names the unreadable files when the workflow itself will not load", () => {
    const p = open();
    writeFileSync(join(p.paths.workflowsDir, "wf.json"), "{ broken", "utf8");
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    // "unknown state 'wf'" alone would hide the real cause, so the parse error rides
    // along with it.
    expect(() => beginTaskRun(p, meta.id)).toThrow(/unreadable files/);
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
  });

  it("enforces validation at task start and leaves the task queued on failure", () => {
    const p = open();
    const badDir = join(p.paths.workflowsDir);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "bad.json"),
      JSON.stringify({ ...WORKFLOW, transitions: [{ to: "nowhere" }] }),
      "utf8",
    );
    const meta = createTask(p, { title: "B", workflow: "bad" });
    expect(() => beginTaskRun(p, meta.id)).toThrow(/validation failed/);
    expect(p.runtime.get(meta.id)?.status).toBe("queued");
    expect(p.runtime.listRuns(meta.id)).toHaveLength(0);
  });

  it("re-runs an interrupted task from the pinned snapshot, even after workflow edits", () => {
    let p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", inputs: { x: "hello" } });
    const started = beginTaskRun(p, meta.id);
    const firstHash = started.snapshotHash;
    p.close(); // crash: never finished
    project = undefined;

    // Edit the live workflow after the crash — the pinned snapshot must win.
    writeFileSync(join(openPaths().workflowsDir, "wf.json"), JSON.stringify({ ...WORKFLOW, label: "Edited" }), "utf8");

    p = open();
    expect(p.recovered).toEqual([meta.id]);
    expect(p.runtime.get(meta.id)?.status).toBe("interrupted");
    expect(p.runtime.listRuns(meta.id)[0]?.outcome).toBe("interrupted");

    const rerun = beginTaskRun(p, meta.id);
    expect(rerun.pinned).toBe(true);
    expect(rerun.snapshotHash).toBe(firstHash);
    expect(rerun.bundle.states["wf"]?.label).toBe("Wf"); // pinned content, not the edit
    finishTaskRun(p, meta.id, rerun.runId, "completed");
    expect(p.runtime.get(meta.id)?.status).toBe("completed");
    expect(p.runtime.listRuns(meta.id)).toHaveLength(2);
  });

  it("cancel is terminal and closes dangling runs", () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf" });
    beginTaskRun(p, meta.id);
    cancelTask(p, meta.id);
    expect(p.runtime.get(meta.id)?.status).toBe("canceled");
    expect(p.runtime.listRuns(meta.id)[0]?.outcome).toBe("canceled");
    expect(() => cancelTask(p, meta.id)).toThrow(/already canceled/);
    expect(() => beginTaskRun(p, meta.id)).toThrow(/canceled/);
  });

  it("rejects duplicate ids and unknown workflows", () => {
    const p = open();
    const meta = createTask(p, { title: "T", workflow: "wf", id: "t-fixed00000" });
    expect(() => createTask(p, { title: "T2", workflow: "wf", id: meta.id })).toThrow(/already exists/);
    const missing = createTask(p, { title: "M", workflow: "does/not/exist" });
    expect(() => beginTaskRun(p, missing.id)).toThrow(/not found/);
  });
});

function openPaths(): { workflowsDir: string } {
  return { workflowsDir: join(dir, ".jaira", "workflows") };
}
