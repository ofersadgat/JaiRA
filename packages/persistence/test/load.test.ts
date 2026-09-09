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
import {
  artifactContentOf,
  buildTaskLoad,
  initProject,
  openProject,
  rehydrateArtifactInputs,
  releaseRevivedFailures,
  releaseUnconsumedFailures,
  type Project,
} from "../src/index";

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

function journal(instanceId: string | undefined, payload: Record<string, unknown>): void {
  project.db
    .prepare(
      `INSERT INTO state_machine_events (task_id, instance_id, type, payload_json, created_at)
       VALUES ('t', ?, ?, ?, ?)`,
    )
    .run(instanceId ?? null, payload.type, JSON.stringify(payload), at++);
}

function entered(id: string, stateId: string, childKey?: string, parent?: string): void {
  journal(id, { type: "instance.entered", instanceId: id, stateId, childKey, parentInstanceId: parent, inputs: {} });
}

/** An element of a fanned-out mount entered — `element` is what tells it from a loop's pass. */
function element(id: string, stateId: string, childKey: string, parent: string, element: number): void {
  journal(id, { type: "instance.entered", instanceId: id, stateId, childKey, parentInstanceId: parent, inputs: {}, element });
}

function started(id: string, stateId: string): void {
  journal(id, { type: "operation.started", instanceId: id, stateId, op: "function" });
}

function completed(id: string, stateId: string, operationId: string): void {
  journal(id, { type: "operation.completed", instanceId: id, stateId, op: "function", operationId });
}

function opFailed(id: string, stateId: string, classification = "permanent"): void {
  journal(id, { type: "operation.failed", instanceId: id, stateId, op: "function", failure: { classification, reason: "boom" } });
}

function terminated(id: string, stateId: string, outcome: string): void {
  journal(id, { type: "instance.terminated", instanceId: id, stateId, outcome });
}

function transition(id: string, stateId: string, to: string, index: number, iteration = 0): void {
  journal(id, { type: "transition.taken", instanceId: id, stateId, to, index, iteration });
}

/** A settled record row. Omit `value` to leave the hole the safety guard exists for. */
function record(operationId: string, value?: unknown, request?: unknown): void {
  project.db
    .prepare(
      `INSERT INTO operation_records (id, task_id, status, request_json, result_json, started_at, ended_at)
       VALUES (?, 't', 'completed', ?, ?, 1000, 1000)`,
    )
    .run(operationId, request === undefined ? null : JSON.stringify(request), value === undefined ? null : JSON.stringify({ value }));
}

/** The machine starts executing — what `beginTaskRun` stamps on the one row. */
function begin(): void {
  project.runtime.beginTask("t", "h", 1000);
}

const SHAPE = { root: { sequence: ["a", "b", "c"] } };

describe("the load description of a half-done run", () => {
  it("loads what completed, presents what was cut, and points at the frontier", () => {
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    completed("i-a", "root/a", "op-a");
    record("op-a", { ok: true });
    terminated("i-a", "root/a", "success");
    entered("i-b", "root/b", "b", "i-root"); // the process died in here

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
    // Where the continuing run's own work begins, in tree order — the address a reader walks to it by.
    expect(load.frontier.map((f) => f.address)).toEqual([[{ childKey: "b", occurrence: 0 }]]);
    expect(load.loadedOps).toBe(1);
  });

  it("refuses a description with a hole in it, rather than quietly re-dispatching", () => {
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    completed("i-a", "root/a", "op-a");
    record("op-a"); // the journal says completed; the store has no readable value
    terminated("i-a", "root/a", "success");

    const load = buildTaskLoad(project, "t", SHAPE);
    // `a`'s outputs cannot be recomputed and re-entering it would re-do side effects that already
    // landed — the exact double-apply this report exists to prevent.
    expect(load.unreadable.map((u) => u.stateId)).toEqual(["root/a"]);
  });

  it("seeds the round a stopped run still owed", () => {
    // `a` finished and the process died before any evaluation acted on it: no transition, no later
    // child. The loaded round must answer exactly that.
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    completed("i-a", "root/a", "op-a");
    record("op-a", { ok: true });
    terminated("i-a", "root/a", "success");

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.unanswered).toEqual(["a"]);
  });
});

describe("folding a continuation by durable id", () => {
  it("merges a re-stated spine into one tree instead of growing a second one", () => {
    // Run 1 does `a` and dies. Run 2 is a LOAD continuation: it re-states the root under the SAME
    // id — the whole point of durable ids — then does `b` and dies too.
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    completed("i-a", "root/a", "op-a");
    record("op-a", { ok: true });
    terminated("i-a", "root/a", "success");
    project.runtime.endTask("t", "interrupted", 2000);

    begin();
    entered("i-root", "root");
    entered("i-b", "root/b", "b", "i-root");
    completed("i-b", "root/b", "op-b");
    record("op-b", { ok: 2 });
    terminated("i-b", "root/b", "success");

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

  it("takes the newest root when history grew several trees", () => {
    // Two roots with different ids is an in-place restart's shape — each attempt its own tree. The
    // machine is the newest attempt; the older tree is history it does not stand on.
    begin();
    entered("i-old", "root");
    entered("i-old-a", "root/a", "a", "i-old");
    project.runtime.endTask("t", "interrupted", 2000);
    entered("i-new", "root");

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.id).toBe("i-new");
    expect(load.loaded!.children).toBeUndefined();
    expect(load.frontier.map((f) => f.instanceId)).toEqual(["i-new"]);
  });
});

describe("revival: what counts as still-to-do", () => {
  it("presents an unhandled failure live again — a retry with its history intact", () => {
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    started("i-a", "root/a");
    opFailed("i-a", "root/a");
    terminated("i-a", "root/a", "error");
    terminated("i-root", "root", "error");
    project.runtime.endTask("t", "error", 2000);

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
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    terminated("i-a", "root/a", "error");
    // The parent ACTED on it — an authored recovery — so the failure is answered, not owed.
    transition("i-root", "root", "b", 1);
    entered("i-b", "root/b", "b", "i-root");

    const load = buildTaskLoad(project, "t", SHAPE);
    const [a, b] = load.loaded!.children!;
    expect(a).toMatchObject({ id: "i-a", live: false, outcome: "error" });
    expect(b).toMatchObject({ id: "i-b", live: true });
    expect(load.frontier.map((f) => f.stateId)).toEqual(["root/b"]);
  });

  it("revives what a stop unwound, and reads a cut call as mid-operation", () => {
    // A stop terminates everything on the way out (`canceled`) and the cut call settles
    // `interrupted` — neither is an answer, so both come back live.
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    started("i-a", "root/a");
    opFailed("i-a", "root/a", "interrupted");
    terminated("i-a", "root/a", "canceled");
    terminated("i-root", "root", "canceled");
    project.runtime.endTask("t", "canceled", 2000);

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.loaded!.live).toBe(true);
    expect(load.loaded!.children![0]!.live).toBe(true);
    expect(load.frontier.map((f) => [f.cause, f.stopped])).toEqual([["interrupted", "mid-operation"]]);
  });

  it("skips a superseded instance and still counts its entry", () => {
    begin();
    entered("i-root", "root");
    entered("i-a1", "root/a", "a", "i-root");
    terminated("i-a1", "root/a", "success");
    journal("i-root", { type: "child.superseded", instanceId: "i-root", stateId: "root", childKey: "a" });
    transition("i-root", "root", "a", 1, 1);
    entered("i-a2", "root/a", "a", "i-root");

    const load = buildTaskLoad(project, "t", SHAPE);
    const kids = load.loaded!.children!;
    // One child emitted — the re-entry — under occurrence 1, because the cleared first entry still
    // happened and renumbering it would move every later address.
    expect(kids.map((c) => [c.id, c.occurrence])).toEqual([["i-a2", 1]]);
    expect(load.frontier[0]!.address).toEqual([{ childKey: "a", occurrence: 1 }]);
  });
});

describe("a fanned-out mount in the description", () => {
  it("gives the elements of one batch one occurrence, and each its element", () => {
    begin();
    entered("i-root", "root");
    element("i-a0", "root/a", "a", "i-root", 0);
    terminated("i-a0", "root/a", "success");
    element("i-a1", "root/a", "a", "i-root", 1);
    terminated("i-a1", "root/a", "success");
    element("i-a2", "root/a", "a", "i-root", 2);

    const load = buildTaskLoad(project, "t", SHAPE);
    const kids = load.loaded!.children!;
    // Three instances under one key, ONE entry: a batch is one occurrence however many it ran, and
    // the engine gathers them back into the one record it keeps per key.
    expect(kids.map((c) => [c.id, c.occurrence, c.element, c.live])).toEqual([
      ["i-a0", 0, 0, false],
      ["i-a1", 0, 1, false],
      ["i-a2", 0, 2, true],
    ]);
    expect(load.frontier[0]!.address).toEqual([{ childKey: "a", occurrence: 0, element: 2 }]);
  });
});

describe("recorded call sites and answers", () => {
  const callOp = { kind: "function", functionRef: "check", input: { flag: { kind: "json", binding: { json: true } } } };

  it("rebuilds an instance's sites and answers repeats by scoped identity", () => {
    begin();
    entered("i-root", "root");
    const key = hashOperation(callOp as never);
    const sid = scopedOperationId(key, { instanceId: "i-root", sequence: 1 });
    record(sid, "yes", { ...callOp, scope: { instanceId: "i-root", sequence: 1 } });

    const load = buildTaskLoad(project, "t", SHAPE);
    // The site: content key → the recorded sequence, so a re-evaluated guard recomputes the same
    // scoped id — and the answers seam serves what the stopped run already paid for.
    expect(load.loaded!.sites).toEqual([[key, 1]]);
    expect(load.loaded!.nextSite).toBe(2);
    expect(load.answers(sid)).toEqual({ value: "yes" });
  });

  it("never answers a deferred call — an event is not a memo", () => {
    begin();
    entered("i-root", "root");
    const key = hashOperation(callOp as never);
    const sid = scopedOperationId(key, { instanceId: "i-root", sequence: 1 });
    record(sid, { moved: true }, { ...callOp, scope: { instanceId: "i-root", sequence: 1 } });
    // The event stamps the CONTENT hash, not the scoped record id — it fires before any scope is
    // claimed, which is exactly what the fold's exclusion has to match against.
    journal("i-root", { type: "call.waiting", instanceId: "i-root", stateId: "root", call: "on_user_event", operationId: key });

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
    begin();
    entered("7", "root");
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
      `INSERT INTO operation_records (id, task_id, status, provider_session_id, started_at)
       VALUES (?, 't', ?, ?, 1000)`,
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

describe("deleting the failure the retry revives (§05)", () => {
  const types = (): string[] =>
    (project.db.prepare(`SELECT type, payload_json FROM state_machine_events WHERE task_id = 't' ORDER BY seq`).all() as Array<{ type: string; payload_json: string }>)
      .map((row) => `${row.type}:${(JSON.parse(row.payload_json) as { instanceId?: string; outcome?: string }).instanceId ?? ""}:${(JSON.parse(row.payload_json) as { outcome?: string }).outcome ?? ""}`);

  it("removes the terminations of the revived chain and the failed call, and keeps handled history", () => {
    begin();
    entered("i-root", "root");
    // `a` failed once, a transition HANDLED it, and `b` ran after: history, and it stays.
    entered("i-a", "root/a", "a", "i-root");
    started("i-a", "root/a");
    opFailed("i-a", "root/a");
    terminated("i-a", "root/a", "error");
    transition("i-root", "root", "b", 1);
    entered("i-b", "root/b", "b", "i-root");
    started("i-b", "root/b");
    completed("i-b", "root/b", "op-3");
    record("op-3", { ok: true });
    terminated("i-b", "root/b", "success");
    // `c` failed and nothing handled it: the root fell with it, and a wait the stop withdrew went too.
    entered("i-c", "root/c", "c", "i-root");
    started("i-c", "root/c");
    opFailed("i-c", "root/c");
    terminated("i-c", "root/c", "error");
    journal("i-root", { type: "call.waiting", instanceId: "i-root", stateId: "root", call: "on_user_event", operationId: "w-1" });
    journal("i-root", { type: "call.settled", instanceId: "i-root", stateId: "root", call: "on_user_event", operationId: "w-1", outcome: "error" });
    terminated("i-root", "root", "canceled");

    const load = buildTaskLoad(project, "t", SHAPE);
    expect(load.frontier.map((f) => [f.instanceId, f.cause])).toEqual([["i-c", "failed"]]);
    expect(releaseRevivedFailures(project, load)).toBe(5);
    expect(types()).toEqual([
      "instance.entered:i-root:",
      "instance.entered:i-a:",
      "operation.started:i-a:",
      "operation.failed:i-a:",
      "instance.terminated:i-a:error",
      "transition.taken:i-root:",
      "instance.entered:i-b:",
      "operation.started:i-b:",
      "operation.completed:i-b:",
      "instance.terminated:i-b:success",
      "instance.entered:i-c:",
      "operation.started:i-c:",
    ]);
    // The description built afterwards still revives the same frontier: nothing about liveness
    // depended on the rows that went.
    const after = buildTaskLoad(project, "t", SHAPE);
    expect(after.frontier.map((f) => f.instanceId)).toEqual(["i-c"]);
    expect(after.loaded?.live).toBe(true);
  });

  it("touches nothing when nothing is live", () => {
    begin();
    entered("i-root", "root");
    entered("i-a", "root/a", "a", "i-root");
    terminated("i-a", "root/a", "success");
    terminated("i-root", "root", "success");
    const load = buildTaskLoad(project, "t", SHAPE);
    expect(releaseRevivedFailures(project, load)).toBe(0);
    expect(types()).toHaveLength(4);
  });
});

describe("the content behind an engine artifact ref", () => {
  const recordFor = (instanceId: string, value: unknown): void => {
    project.db
      .prepare(
        `INSERT INTO operation_records (id, task_id, status, request_json, result_json, started_at, ended_at)
         VALUES (?, 't', 'completed', ?, ?, 1000, 1000)`,
      )
      .run(`op-${instanceId}`, JSON.stringify({ kind: "function", scope: { instanceId, sequence: 0 } }), JSON.stringify({ value }));
  };

  it("reads the slot's string out of the instance's completed record", () => {
    recordFor("i-draft", { feature_docs: "# the docs", features: [] });
    expect(artifactContentOf(project, "t", "feature.product.draft#i-draft.feature_docs")).toBe("# the docs");
  });

  it("answers nothing for a name that does not parse, an unknown instance, or a non-string slot", () => {
    recordFor("i-draft", { feature_docs: ["not", "a", "string"] });
    expect(artifactContentOf(project, "t", "no-hash-here")).toBeUndefined();
    expect(artifactContentOf(project, "t", "x#i-missing.slot")).toBeUndefined();
    expect(artifactContentOf(project, "t", "x#i-draft.feature_docs")).toBeUndefined();
  });

  it("fills in a content-less ref among a gate's inputs and leaves everything else alone", () => {
    recordFor("i-draft", { feature_docs: "# the docs" });
    const inputs = {
      docs: { artifact: true, name: "feature.product.draft#i-draft.feature_docs", format: "text/markdown" },
      whole: { artifact: true, name: "x#i-draft.feature_docs", content: "already here" },
      score: 0.6,
    };
    const out = rehydrateArtifactInputs(project, "t", inputs);
    expect(out["docs"]).toEqual({ artifact: true, name: "feature.product.draft#i-draft.feature_docs", format: "text/markdown", content: "# the docs" });
    expect(out["whole"]).toEqual(inputs.whole);
    expect(out["score"]).toBe(0.6);
    // Identity is kept when there is nothing to do.
    const untouched = { score: 1 };
    expect(rehydrateArtifactInputs(project, "t", untouched)).toBe(untouched);
  });
});
