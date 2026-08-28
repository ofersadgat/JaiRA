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
import { testHome } from "@jaira/testing";
import { buildTaskReplay, initProject, openProject, taskRun, type Project } from "../src/index";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-replayfold-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
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

describe("where a resumed run's own work begins", () => {
  /**
   * Two leaves under a root. `a` completed and recorded; `b` did not.
   *
   * Which is both kinds of resume at once, and the point of the single rule: whether `b` FAILED or
   * the process died inside it, its operation never completed, so it has no answer — and the same
   * walk lands on it either way.
   */
  const halfDone = (): number => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, 1, "root");
    entered(run, 2, "root/a", "a", 1);
    completed(run, 2, "root/a", "op-a");
    record(run, "op-a", { ok: true });
    entered(run, 3, "root/b", "b", 1);
    project.runtime.endRun(run, "error", 2000);
    return run;
  };

  it("is the first address the record cannot answer", () => {
    halfDone();
    // `a` will be served from the record; `b` is where spending starts again. That boundary is the
    // whole content of a run-scale fork: above it is shared, below it belongs to the new run.
    expect(buildTaskReplay(project, "t").forkPoint).toEqual([{ childKey: "b", occurrence: 0 }]);
  });

  it("says nothing when the record answers everything it can see", () => {
    // A run that resumes past the end of what was recorded diverges from nothing anybody can see, so
    // there is no place to draw. Distinct from the EMPTY address, which is the root and means the
    // opposite: a run that shares nothing at all.
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, 1, "root");
    entered(run, 2, "root/a", "a", 1);
    completed(run, 2, "root/a", "op-a");
    record(run, "op-a", { ok: true });
    project.runtime.endRun(run, "success", 2000);
    expect(buildTaskReplay(project, "t").forkPoint).toBeUndefined();
  });

  it("survives the round trip to the run row, as structure rather than a string", () => {
    // `addressKey` is a map key, and it joins with characters a child key may legally contain. What
    // is stored is the steps, so a key holding a `/` or a `#` reads back as what it was.
    halfDone();
    const point = buildTaskReplay(project, "t").forkPoint;
    const resumed = project.runtime.beginRun("t", "h", 3000, point);
    expect(project.runtime.listRuns("t").find((r) => r.id === resumed)?.forkedAt).toEqual([
      { childKey: "b", occurrence: 0 },
    ]);
  });

  it("reads a run started from the top as sharing nothing", () => {
    // No fork point recorded is the ROOT, and that is the reading every run already on disk gets.
    // It under-claims on purpose: it can never say a prefix was carried over when it was not.
    halfDone();
    const fresh = project.runtime.beginRun("t", "h", 3000);
    expect(project.runtime.listRuns("t").find((r) => r.id === fresh)?.forkedAt).toBeUndefined();
  });
});
