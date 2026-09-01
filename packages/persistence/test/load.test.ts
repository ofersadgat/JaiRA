/**
 * Folding a task's journal and records into the LOAD description (Identity and Resume §04) — and
 * the guards that decide whether it is safe to hand to the engine.
 *
 * Built by writing rows rather than by driving a run, because the shapes under test are the ones a
 * healthy run will not produce on request: a crash that left the spine live, a stop that canceled
 * it, a failure nothing handled, a hole in the record where the journal says an operation
 * completed and the store cannot produce its value.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOperation, scopedOperationId } from "@declarative-ai/exec";
import { testHome } from "@jaira/testing";
import { buildTaskLoad, initProject, openProject, releaseUnconsumedFailures, type Project } from "../src/index";

let dir: string;
let project: Project;
let at = 1000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-loadfold-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
  project.runtime.insert("t", 1000);
  at = 1000;
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function journal(runId: number, instanceId: string | undefined, payload: Record<string, unknown>): void {
  project.db
    .prepare(
      `INSERT INTO state_machine_events (task_id, run_id, instance_id, type, payload_json, created_at)
       VALUES ('t', ?, ?, ?, ?, ?)`,
    )
    .run(runId, instanceId ?? null, payload.type, JSON.stringify(payload), at++);
}

function entered(runId: number, id: string, stateId: string, childKey?: string, parent?: string): void {
  journal(runId, id, { type: "instance.entered", instanceId: id, stateId, childKey, parentInstanceId: parent, inputs: {} });
}

function started(runId: number, id: string, stateId: string): void {
  journal(runId, id, { type: "operation.started", instanceId: id, stateId, op: "function" });
}

function completed(runId: number, id: string, stateId: string, operationId: string): void {
  journal(runId, id, { type: "operation.completed", instanceId: id, stateId, op: "function", operationId });
}

function opFailed(runId: number, id: string, stateId: string, classification = "permanent"): void {
  journal(runId, id, { type: "operation.failed", instanceId: id, stateId, op: "function", failure: { classification, reason: "boom" } });
}

function terminated(runId: number, id: string, stateId: string, outcome: string): void {
  journal(runId, id, { type: "instance.terminated", instanceId: id, stateId, outcome });
}

function transition(runId: number, id: string, stateId: string, to: string, index: number, iteration = 0): void {
  journal(runId, id, { type: "transition.taken", instanceId: id, stateId, to, index, iteration });
}

/** A settled record row. Omit `value` to leave the hole the safety guard exists for. */
function record(runId: number, operationId: string, value?: unknown, request?: unknown): void {
  project.db
    .prepare(
      `INSERT INTO operation_records (id, task_id, run_id, status, request_json, result_json, started_at, ended_at)
       VALUES (?, 't', ?, 'completed', ?, ?, 1000, 1000)`,
    )
    .run(operationId, runId, request === undefined ? null : JSON.stringify(request), value === undefined ? null : JSON.stringify({ value }));
}

const SHAPE = { root: { sequence: ["a", "b", "c"] } };

describe("the load description of a half-done run", () => {
  it("loads what completed, presents what was cut, and points at the frontier", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    completed(run, "i-a", "root/a", "op-a");
    record(run, "op-a", { ok: true });
    terminated(run, "i-a", "root/a", "success");
    entered(run, "i-b", "root/b", "b", "i-root"); // the process died in here

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.blocked).toBeUndefined();
    expect(load.unreadable).toEqual([]);
    const root = load.loaded!;
    expect(root.id).toBe("i-root");
    expect(root.live).toBe(true);
    // The cursor stands on the last entered sequence member — `b`, index 1 in the declared sequence.
    expect(root.cursor).toBe(1);
    const [a, b] = root.children!;
    expect(a).toMatchObject({ id: "i-a", live: false, outcome: "success", occurrence: 0 });
    // The recorded value, unwrapped from the `{ value }` envelope — what `finish` recomputes from.
    expect(a!.operation?.value).toEqual({ ok: true });
    // Entered and never terminated: the leaf that CONTINUES, with no operation to take — it re-asks.
    expect(b).toMatchObject({ id: "i-b", live: true });
    expect(b!.operation).toBeUndefined();
    expect(load.frontier.map((f) => [f.stateId, f.cause])).toEqual([["root/b", "interrupted"]]);
    // Where the continuing run's own work begins — known now, not reconstructed afterwards.
    expect(load.forkedAt).toEqual([{ childKey: "b", occurrence: 0 }]);
    expect(load.loadedOps).toBe(1);
  });

  it("refuses a description with a hole in it, rather than quietly re-dispatching", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    completed(run, "i-a", "root/a", "op-a");
    record(run, "op-a"); // the journal says completed; the store has no readable value
    terminated(run, "i-a", "root/a", "success");

    const load = buildTaskLoad(project, "t", SHAPE);
    // `a`'s outputs cannot be recomputed and re-entering it would re-do side effects that already
    // landed — the exact double-apply this report exists to prevent.
    expect(load.unreadable.map((u) => u.stateId)).toEqual(["root/a"]);
  });

  it("seeds the round a stopped run still owed", () => {
    // `a` finished and the process died before any evaluation acted on it: no transition, no later
    // child. The loaded round must answer exactly that.
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    completed(run, "i-a", "root/a", "op-a");
    record(run, "op-a", { ok: true });
    terminated(run, "i-a", "root/a", "success");

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.unanswered).toEqual(["a"]);
  });
});

describe("folding a continuation by durable id", () => {
  it("merges a re-stated spine into one tree instead of growing a second one", () => {
    // Run 1 does `a` and dies. Run 2 is a LOAD continuation: it re-states the root under the SAME
    // id — the whole point of durable ids — then does `b` and dies too.
    const first = project.runtime.beginRun("t", "h", 1000);
    entered(first, "i-root", "root");
    entered(first, "i-a", "root/a", "a", "i-root");
    completed(first, "i-a", "root/a", "op-a");
    record(first, "op-a", { ok: true });
    terminated(first, "i-a", "root/a", "success");
    project.runtime.endRun(first, "interrupted", 2000);

    const second = project.runtime.beginRun("t", "h", 3000);
    entered(second, "i-root", "root");
    entered(second, "i-b", "root/b", "b", "i-root");
    completed(second, "i-b", "root/b", "op-b");
    record(second, "op-b", { ok: 2 });
    terminated(second, "i-b", "root/b", "success");

    const load = buildTaskLoad(project, "t", SHAPE);
    const root = load.loaded!;
    expect(root.id).toBe("i-root");
    expect(root.children!.map((c) => [c.id, c.live])).toEqual([
      ["i-a", false],
      ["i-b", false],
    ]);
    // Run 2's entry of `b` ANSWERED `a`; `b`'s own finish is the one still owed.
    expect(root.unanswered).toEqual(["b"]);
    expect(load.loadedOps).toBe(2);
  });

  it("takes the last run's root when the runs are separate attempts", () => {
    // Two roots with different ids is the OLD shape — a re-run in place, each attempt its own tree.
    // The machine is the newest attempt; the older tree is history it does not stand on.
    const first = project.runtime.beginRun("t", "h", 1000);
    entered(first, "i-old", "root");
    entered(first, "i-old-a", "root/a", "a", "i-old");
    project.runtime.endRun(first, "interrupted", 2000);

    const second = project.runtime.beginRun("t", "h", 3000);
    entered(second, "i-new", "root");

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.id).toBe("i-new");
    expect(load.loaded!.children).toBeUndefined();
    expect(load.frontier.map((f) => f.instanceId)).toEqual(["i-new"]);
  });
});

describe("revival: what counts as still-to-do", () => {
  it("presents an unhandled failure live again — a retry with its history intact", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    started(run, "i-a", "root/a");
    opFailed(run, "i-a", "root/a");
    terminated(run, "i-a", "root/a", "error");
    terminated(run, "i-root", "root", "error");
    project.runtime.endRun(run, "error", 2000);

    const load = buildTaskLoad(project, "t", SHAPE);
    const root = load.loaded!;
    expect(root.live).toBe(true);
    const a = root.children![0]!;
    // Live with no operation: the engine re-enters it and dispatches the call again.
    expect(a.live).toBe(true);
    expect(a.operation).toBeUndefined();
    expect(load.frontier.map((f) => [f.stateId, f.cause, f.stopped])).toEqual([["root/a", "failed", "between-children"]]);
  });

  it("leaves a failure a transition handled as history", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    terminated(run, "i-a", "root/a", "error");
    // The parent ACTED on it — an authored recovery — so the failure is answered, not owed.
    transition(run, "i-root", "root", "b", 1);
    entered(run, "i-b", "root/b", "b", "i-root");

    const load = buildTaskLoad(project, "t", SHAPE);
    const [a, b] = load.loaded!.children!;
    expect(a).toMatchObject({ id: "i-a", live: false, outcome: "error" });
    expect(b).toMatchObject({ id: "i-b", live: true });
    expect(load.frontier.map((f) => f.stateId)).toEqual(["root/b"]);
  });

  it("revives what a stop unwound, and reads a cut call as mid-operation", () => {
    // A stop terminates everything on the way out (`canceled`) and the cut call settles
    // `interrupted` — neither is an answer, so both come back live.
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a", "root/a", "a", "i-root");
    started(run, "i-a", "root/a");
    opFailed(run, "i-a", "root/a", "interrupted");
    terminated(run, "i-a", "root/a", "canceled");
    terminated(run, "i-root", "root", "canceled");
    project.runtime.endRun(run, "canceled", 2000);

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.live).toBe(true);
    expect(load.loaded!.children![0]!.live).toBe(true);
    expect(load.frontier.map((f) => [f.cause, f.stopped])).toEqual([["interrupted", "mid-operation"]]);
  });

  it("skips a superseded instance and still counts its entry", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    entered(run, "i-a1", "root/a", "a", "i-root");
    terminated(run, "i-a1", "root/a", "success");
    journal(run, "i-root", { type: "child.superseded", instanceId: "i-root", stateId: "root", childKey: "a" });
    transition(run, "i-root", "root", "a", 1, 1);
    entered(run, "i-a2", "root/a", "a", "i-root");

    const load = buildTaskLoad(project, "t", SHAPE);
    const kids = load.loaded!.children!;
    // One child emitted — the re-entry — under occurrence 1, because the cleared first entry still
    // happened and renumbering it would move every later address.
    expect(kids.map((c) => [c.id, c.occurrence])).toEqual([["i-a2", 1]]);
    expect(load.frontier[0]!.address).toEqual([{ childKey: "a", occurrence: 1 }]);
  });
});

describe("recorded call sites and answers", () => {
  const callOp = { kind: "function", functionRef: "check", input: { flag: { kind: "json", binding: { json: true } } } };

  it("rebuilds an instance's sites and answers repeats by scoped identity", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    const key = hashOperation(callOp as never);
    const sid = scopedOperationId(key, { instanceId: "i-root", sequence: 1 });
    record(run, sid, "yes", { ...callOp, scope: { instanceId: "i-root", sequence: 1 } });

    const load = buildTaskLoad(project, "t", SHAPE);
    // The site: content key → the recorded sequence, so a re-evaluated guard recomputes the same
    // scoped id — and the answers seam serves what the stopped run already paid for.
    expect(load.loaded!.sites).toEqual([[key, 1]]);
    expect(load.loaded!.nextSite).toBe(2);
    expect(load.answers(sid)).toEqual({ value: "yes" });
  });

  it("never answers a deferred call — an event is not a memo", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "i-root", "root");
    const key = hashOperation(callOp as never);
    const sid = scopedOperationId(key, { instanceId: "i-root", sequence: 1 });
    record(run, sid, { moved: true }, { ...callOp, scope: { instanceId: "i-root", sequence: 1 } });
    journal(run, "i-root", { type: "call.waiting", instanceId: "i-root", stateId: "root", call: "on_user_event", operationId: sid });

    const load = buildTaskLoad(project, "t", SHAPE);
    // Serving "did the user drag this card" into a resumed run would replay a person's decision.
    // The site is not loaded either, so the re-ask mints a fresh one and registers a fresh wait —
    // but the burned sequence stays burned.
    expect(load.answers(sid)).toBeUndefined();
    expect(load.loaded!.sites).toBeUndefined();
    expect(load.loaded!.nextSite).toBe(2);
  });
});

describe("what cannot be loaded", () => {
  it("refuses history that predates durable ids", () => {
    const run = project.runtime.beginRun("t", "h", 1000);
    entered(run, "7", "root");
    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded).toBeUndefined();
    expect(load.blocked).toMatch(/durable instance ids/);
  });

  it("describes nothing when nothing was recorded", () => {
    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded).toBeUndefined();
    expect(load.blocked).toBeUndefined();
  });
});

describe("freeing what never happened remotely (§05)", () => {
  it("deletes failed records with no provider handle, and keeps every witness", () => {
    const insert = project.db.prepare(
      `INSERT INTO operation_records (id, task_id, run_id, status, provider_session_id, started_at)
       VALUES (?, 't', 1, ?, ?, 1000)`,
    );
    insert.run("r-error", "failed", null); // nothing landed remotely — free the identity
    insert.run("r-witness", "failed", "prov-1"); // its turns exist in the remote stream — keep
    insert.run("r-cut", "interrupted", null); // a cut call reopens its own record — keep
    insert.run("r-done", "completed", null);

    expect(releaseUnconsumedFailures(project, "t")).toBe(1);
    const left = project.db.prepare(`SELECT id FROM operation_records ORDER BY id`).all() as Array<{ id: string }>;
    expect(left.map((row) => row.id)).toEqual(["r-cut", "r-done", "r-witness"]);
  });
});
