/**
 * Folding a task's runs into one replay index — and the guard that decides whether it is safe to use.
 *
 * `buildTaskReplay` spans every run because a replayed operation writes no record: a resumed run's
 * own store holds only what it actually dispatched, so reading the last run alone would lose
 * everything the original answered. The subtlety this file exists for is that the SAFETY REPORT has
 * to span the same runs. It did not, and the mismatch quietly defeated the one check standing
 * between a resume and re-running something that had already happened.
 *
 * Built by writing rows rather than by driving a run: the shape under test is a hole in the record —
 * an operation the journal says completed and the store cannot produce a value for — which is what a
 * partial write or a pruned payload leaves behind and not something a healthy run will do on request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskReplay, initProject, openProject, taskRun, type Project } from "../src/index";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-replayfold-"));
  initProject(dir);
  project = openProject(dir);
  project.runtime.insert("t", 1000);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Journal an instance entering under `childKey`, and its operation settling. */
function entered(runId: number, instanceId: number, stateId: string, childKey?: string, parent?: number): void {
  project.db
    .prepare(
      `INSERT INTO state_machine_events (task_id, run_id, instance_id, type, payload_json, created_at)
       VALUES ('t', ?, ?, 'instance.entered', ?, 1000)`,
    )
    .run(runId, instanceId, JSON.stringify({ type: "instance.entered", instanceId, stateId, childKey, parentInstanceId: parent, inputs: {} }));
}

function completed(runId: number, instanceId: number, stateId: string, operationId: string): void {
  project.db
    .prepare(
      `INSERT INTO state_machine_events (task_id, run_id, instance_id, type, payload_json, created_at)
       VALUES ('t', ?, ?, 'operation.completed', ?, 1000)`,
    )
    .run(runId, instanceId, JSON.stringify({ type: "operation.completed", instanceId, stateId, op: "function", operationId }));
}

/** A settled record for a content id. Omit `value` to leave the hole this file is about. */
function record(runId: number, operationId: string, value?: unknown): void {
  project.db
    .prepare(
      `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, result_json, started_at, ended_at)
       VALUES (?, 't', ?, 1, 'completed', ?, 1000, 1000)`,
    )
    .run(operationId, runId, value === undefined ? null : JSON.stringify({ value }));
}

describe("the replay index over a task's whole history", () => {
  it("reports a hole from ANY run, not just the last one", () => {
    // Run 1 does two states. `a` records properly; `b`'s record has no readable value, so its answer
    // is missing and re-entering `b` would run it again — after its side effects already landed.
    const first = project.runtime.beginRun("t", "h", 1000);
    entered(first, 1, "root");
    entered(first, 2, "root/a", "a", 1);
    completed(first, 2, "root/a", "op-a");
    record(first, "op-a", { ok: true });
    entered(first, 3, "root/b", "b", 1);
    completed(first, 3, "root/b", "op-b");
    record(first, "op-b"); // the hole
    project.runtime.endRun(first, "interrupted", 2000);

    // Run 2 is a plain re-run that stopped before it ever reached `b`, so it has nothing to say
    // about it — which is exactly why taking the report from the last run alone was wrong.
    const second = project.runtime.beginRun("t", "h", 3000);
    entered(second, 1, "root");
    entered(second, 2, "root/a", "a", 1);
    completed(second, 2, "root/a", "op-a2");
    record(second, "op-a2", { ok: true });

    const replay = buildTaskReplay(project, "t");
    expect([...replay.answers.keys()].sort()).toEqual(["a#0"]);
    // The hole survives the fold, so `resumeTask` refuses rather than silently re-dispatching `b`.
    expect(replay.unreadable.map((u) => u.stateId)).toEqual(["root/b"]);
  });

  it("forgets a hole a later run actually repaired", () => {
    // The other direction, and the reason the filter is by ANSWER rather than a plain concatenation:
    // a re-run that dispatched the address and recorded it properly has fixed the problem, and
    // reporting it forever would refuse a resume that is now perfectly safe.
    const first = project.runtime.beginRun("t", "h", 1000);
    entered(first, 1, "root");
    entered(first, 2, "root/a", "a", 1);
    completed(first, 2, "root/a", "op-a");
    record(first, "op-a"); // the hole
    project.runtime.endRun(first, "interrupted", 2000);

    const second = project.runtime.beginRun("t", "h", 3000);
    entered(second, 1, "root");
    entered(second, 2, "root/a", "a", 1);
    completed(second, 2, "root/a", "op-a2");
    record(second, "op-a2", { ok: true });

    const replay = buildTaskReplay(project, "t");
    expect(replay.answers.get("a#0")?.value).toEqual({ ok: true });
    expect(replay.unreadable).toEqual([]);
  });
});

/** Journal an instance terminating. Absent for an instance the process died inside. */
function terminated(runId: number, instanceId: number, stateId: string, outcome: string): void {
  project.db
    .prepare(
      `INSERT INTO state_machine_events (task_id, run_id, instance_id, type, payload_json, created_at)
       VALUES ('t', ?, ?, 'instance.terminated', ?, 1000)`,
    )
    .run(runId, instanceId, JSON.stringify({ type: "instance.terminated", instanceId, stateId, outcome }));
}

/**
 * A task that got FAR, then a resume that failed SHORT of where it had got to.
 *
 * Run 1 walks `a` → `b` and dies inside `c`, so the task's edge is `c`. Run 2 replays `a`, fails in
 * `b`, and terminates every instance on the way out — the shape a failed run always has. Reading the
 * last run alone then says the task has no frontier and nothing past `b`, which is how ten hours of
 * work stopped being visible the moment a resume failed early.
 */
function farThenShort(): void {
  const first = project.runtime.beginRun("t", "h", 1000);
  entered(first, 1, "root");
  entered(first, 2, "root/a", "a", 1);
  completed(first, 2, "root/a", "op-a");
  record(first, "op-a", { ok: true });
  terminated(first, 2, "root/a", "success");
  entered(first, 3, "root/b", "b", 1);
  completed(first, 3, "root/b", "op-b");
  record(first, "op-b", { ok: true });
  terminated(first, 3, "root/b", "success");
  entered(first, 4, "root/c", "c", 1); // never terminated — the process died here
  project.runtime.endRun(first, "interrupted", 2000);

  const second = project.runtime.beginRun("t", "h", 3000);
  entered(second, 1, "root");
  entered(second, 2, "root/a", "a", 1);
  terminated(second, 2, "root/a", "success");
  entered(second, 3, "root/b", "b", 1);
  terminated(second, 3, "root/b", "error");
  terminated(second, 1, "root", "error");
  project.runtime.endRun(second, "error", 4000);
}

describe("the task's frontier across runs", () => {
  it("keeps the edge an earlier run reached when a later one fails short of it", () => {
    farThenShort();
    const replay = buildTaskReplay(project, "t");
    // `c` is where this task stopped, and a resume that died in `b` does not change that.
    expect(replay.frontier.map((f) => f.stateId)).toEqual(["root/c"]);
    expect(replay.frontier[0]!.address).toEqual([{ childKey: "c", occurrence: 0 }]);
  });

  it("folds the runs into one tree instead of drawing the last one over the rest", () => {
    farThenShort();
    const run = taskRun(project, "t");
    const root = run.instances[0]!;
    // Every child the task ever reached, not just the two the failed resume got to.
    expect(root.children.map((c) => c.childKey)).toEqual(["a", "b", "c"]);
    // The newest attempt is the truth where it reached; the tail is still the run that got there.
    expect(root.children.map((c) => [c.childKey, c.status, c.runId])).toEqual([
      ["a", "completed", 2],
      ["b", "failed", 2],
      ["c", "running", 1],
    ]);
  });

  it("reports no frontier for a task whose runs all ended", () => {
    const only = project.runtime.beginRun("t", "h", 1000);
    entered(only, 1, "root");
    terminated(only, 1, "root", "success");
    project.runtime.endRun(only, "success", 2000);
    expect(buildTaskReplay(project, "t").frontier).toEqual([]);
  });
});
