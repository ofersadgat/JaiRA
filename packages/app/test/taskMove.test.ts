/**
 * `task_move`, end to end (decision 0005, step 1): a person moves a task to a state, and the task
 * goes there — whatever it was doing, and whether or not it was doing anything.
 *
 * One publication (`AppService.moveTask`, the `task:move` channel) and the ways it lands, each with
 * the journal rows that make it durable:
 *
 *  - a RUNNING task takes it as a directed transition — HELD until the state it is in ends, or at
 *    once with `skip`, which interrupts that state and records it and everything stepped over
 *    `skipped`;
 *  - a transition already WAITING on exactly this move (`on_user_event('task_move', …)` on a
 *    `standing` rule) gets its answer instead, and the workflow's own rule moves the task;
 *  - a task that is NOT running — finished included — is REOPENED to take it;
 *  - a process that dies mid-skip loads with the skip intact, and makes the entry it still owed.
 *
 * Every state is a gate, because a parked gate is a state that is unmistakably RUNNING and will stay
 * so until the test says otherwise — and because counting which gates were offered is the assertion
 * that matters: a state stepped over is one whose gate nobody was ever shown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { MOVE_DROPPED_EVENT, MOVE_HELD_EVENT, type PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ROOT = "move";
const STANDING = "standing";

function files(): Record<string, JsonValue> {
  const gate = (name: string): JsonValue => ({
    label: name,
    outputs: { confirmed: { schema: { type: "boolean" } } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } },
  });
  const children = { a: { state: `${ROOT}/a` }, b: { state: `${ROOT}/b` }, c: { state: `${ROOT}/c` }, d: { state: `${ROOT}/d` } };
  const leaves = { [`${ROOT}/a`]: gate("a"), [`${ROOT}/b`]: gate("b"), [`${ROOT}/c`]: gate("c"), [`${ROOT}/d`]: gate("d") };
  return {
    [ROOT]: {
      label: "Move fixture",
      // How each child ended, AS AN EXPRESSION READS IT — `skipped` is an outcome, not an absence.
      outputs: Object.fromEntries(["a", "b", "c", "d"].map((k) => [`${k}_outcome`, { schema: {}, optional: true, binding: `.children.${k}.outcome` }])),
      children,
      sequence: ["a", "b", "c", "d"],
    },
    ...leaves,
    // The same spine, with the rule a host GENERATES for "this task may be sent to d".
    [STANDING]: {
      label: "Standing fixture",
      children,
      sequence: ["a", "b", "c", "d"],
      transitions: [{ to: "d", when: ".run.cursor !== 'd' && on_user_event('task_move', { to_state: 'd' })", standing: true }],
    },
  };
}

let dir: string;
let service: AppService;
let pushes: PushMessage[];
let abandoned: AppService[];
/** The prompts of the gates that were OFFERED, in order — which states a person was actually shown. */
let offered: string[];
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-move-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  pushes = [];
  abandoned = [];
  offered = [];
  seen.clear();
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  for (const dead of abandoned) await dead.close().catch(() => undefined);
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

const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId));

/** Wait for the next gate, note which state's it is, and leave it parked. */
async function parked(): Promise<string> {
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  const name = String((gate.inputs as { prompt?: string }).prompt ?? "").replace("?", "");
  offered.push(name);
  return gate.requestId;
}

/** Wait for the next gate and answer it; returns the state it belonged to. */
async function answer(): Promise<string> {
  const requestId = await parked();
  service.submitInteraction(requestId, { confirmed: true });
  return offered.at(-1)!;
}

async function start(workflow = ROOT): Promise<string> {
  const { taskId } = service.createTask({ title: "Move", workflow });
  await service.startTask({ taskId });
  return taskId;
}

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): string => read((p) => p.runtime.get(taskId)!.status);
const outputsOf = (taskId: string): unknown => read((p) => JSON.parse(p.runtime.get(taskId)!.outputsJson ?? "null") as unknown);
const journal = (taskId: string): EngineEvent[] => read((p) => new SqliteEventLog(p.db).list(taskId).map((row) => row.event));

/** `[child key, outcome]` for every ended instance, in journal order. */
function ended(taskId: string): Array<[string, string]> {
  const events = journal(taskId);
  const keyOf = new Map<string, string>();
  for (const e of events) if (e.type === "instance.entered") keyOf.set(e.instanceId, e.childKey ?? "(root)");
  return events
    .filter((e): e is Extract<EngineEvent, { type: "instance.terminated" }> => e.type === "instance.terminated")
    .map((e) => [keyOf.get(e.instanceId) ?? "?", e.outcome]);
}

const taken = (taskId: string) => journal(taskId).filter((e): e is Extract<EngineEvent, { type: "transition.taken" }> => e.type === "transition.taken");

describe("a move published to a RUNNING task", () => {
  it("is held while the state it is in runs, taken when that state ends, and journaled with who asked", async () => {
    const taskId = await start();
    const gateA = await parked();

    expect(await service.moveTask({ taskId, toState: "c" })).toEqual({ taskId, status: "held" });
    // Held: nothing has moved, and `a` is still being asked.
    expect(taken(taskId)).toEqual([]);
    expect(service.pendingInteractions().map((p) => p.requestId)).toEqual([gateA]);

    service.submitInteraction(gateA, { confirmed: true });
    expect(await answer()).toBe("c");
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");

    // `b` was never shown to anyone.
    expect(offered).toEqual(["a", "c", "d"]);
    expect(taken(taskId)).toMatchObject([{ to: "c", by: "person", index: 1, iteration: 0 }]);
    expect(ended(taskId)).toEqual([["a", "success"], ["b", "skipped"], ["c", "success"], ["d", "success"], ["(root)", "success"]]);
    expect(outputsOf(taskId)).toMatchObject({ a_outcome: "success", b_outcome: "skipped", c_outcome: "success" });
  });

  it("with SKIP, interrupts the running state: its gate is withdrawn, and it and what was stepped over end skipped", async () => {
    const taskId = await start();
    const gateA = await parked();

    expect(await service.moveTask({ taskId, toState: "c", skip: true, by: "control" })).toEqual({ taskId, status: "taking" });
    expect(await answer()).toBe("c");
    // The question `a` was asking is over — not left on the inbox for a state nobody is in.
    expect(service.pendingInteractions().some((p) => p.requestId === gateA)).toBe(false);
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");

    expect(taken(taskId)).toMatchObject([{ to: "c", by: "control", skip: true }]);
    expect(ended(taskId)).toEqual([["a", "skipped"], ["b", "skipped"], ["c", "success"], ["d", "success"], ["(root)", "success"]]);
    expect(outputsOf(taskId)).toMatchObject({ a_outcome: "skipped", b_outcome: "skipped" });
    // The tree a person looks at says the same.
    const detail = service.taskDetail(taskId);
    const root = detail.instances[0]!;
    expect(root.children.map((c) => [c.childKey, c.status])).toEqual([["a", "skipped"], ["b", "skipped"], ["c", "completed"], ["d", "completed"]]);
  });

  it("answers the transition that was waiting on exactly this move, and the workflow's own rule moves the task", async () => {
    const taskId = await start(STANDING);
    expect(await answer()).toBe("a");
    // `a` ended, its round registered the offer, and `b` is running — the rule parked nothing.
    const gateB = await parked();
    await until(() => service.pendingUserEvents().length === 1, "the standing offer");
    expect(service.pendingUserEvents()[0]).toMatchObject({ event: "task_move", taskId, options: { to_state: "d" } });

    expect(await service.moveTask({ taskId, toState: "d" })).toEqual({ taskId, status: "answered" });
    // Answered while `b` still runs: held by the engine until `b` ends.
    await new Promise((r) => setTimeout(r, 30));
    expect(taken(taskId)).toEqual([]);

    service.submitInteraction(gateB, { confirmed: true });
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    expect(offered).toEqual(["a", "b", "d"]);
    // A RULE fired — the workflow moved the task, and nobody is named as having directed it.
    expect(taken(taskId).map((t) => [t.to, t.by])).toEqual([["d", undefined]]);
  });

  it("a standing rule nobody answers changes nothing: the task runs as written and finishes", async () => {
    const taskId = await start(STANDING);
    for (const expected of ["a", "b", "c", "d"]) expect(await answer()).toBe(expected);
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    expect(taken(taskId)).toEqual([]);
    expect(service.pendingUserEvents()).toEqual([]);
  });

  it("refuses a move to a state that is not there, and a move of a task that does not exist", async () => {
    const taskId = await start();
    await parked();
    await expect(service.moveTask({ taskId, toState: "nowhere" })).rejects.toThrow(/'nowhere' is not a declared child of 'move'/);
    await expect(service.moveTask({ taskId: "t-missing", toState: "c" })).rejects.toThrow(/unknown task/);
  });
});

describe("a move published to a task that is NOT running", () => {
  it("reopens a FINISHED task to take it, under its own id — and a plain resume of it is still refused", async () => {
    const taskId = await start();
    for (const expected of ["a", "b", "c", "d"]) expect(await answer()).toBe(expected);
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    await until(() => !service.pendingInteractions().length, "the inbox to clear");
    await expect(service.resumeTask({ taskId })).rejects.toThrow(/cannot be resumed/);

    expect(await service.moveTask({ taskId, toState: "c" })).toEqual({ taskId, status: "reopened" });
    expect(statusOf(taskId)).toBe("running");
    // Backward: `c` is re-entered as its next occurrence, and the tail after it runs again.
    expect(await answer()).toBe("c");
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the reopened task to complete");

    expect(offered).toEqual(["a", "b", "c", "d", "c", "d"]);
    expect(taken(taskId)).toMatchObject([{ to: "c", by: "person", iteration: 1 }]);
    // One journal, one machine: the root ended, was reopened by the transition, and ended again.
    expect(ended(taskId).filter(([key]) => key === "(root)")).toEqual([["(root)", "success"], ["(root)", "success"]]);
    await expect(service.moveTask({ taskId, toState: "nowhere" })).rejects.toThrow(/not a state of 'move'/);
  });

  it("reopens a STOPPED task past the state it stopped in, without asking that state's question again", async () => {
    const taskId = await start();
    expect(await answer()).toBe("a");
    await parked(); // b
    service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the stop to settle");

    expect(await service.moveTask({ taskId, toState: "d" })).toEqual({ taskId, status: "reopened" });
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    // `b` was asked once — by the run that was stopped — and never again.
    expect(offered).toEqual(["a", "b", "d"]);
    expect(outputsOf(taskId)).toMatchObject({ a_outcome: "success", b_outcome: "skipped", c_outcome: "skipped", d_outcome: "success" });
  });
});

describe("a restart mid-skip", () => {
  /** Abandon the service the way a dying process does, stale its claim, and open again. */
  async function crashAndReopen(taskId: string, mutate?: (project: ReturnType<typeof openProject>) => void): Promise<void> {
    abandoned.push(service);
    const project = openProject(dir, { baseDir: testHome() });
    try {
      project.db.prepare(`UPDATE jobs SET heartbeat_at = 0 WHERE task_id = ? AND ended_at IS NULL`).run(taskId);
      mutate?.(project);
    } finally {
      project.close();
    }
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    const { recovered } = await service.open(dir);
    expect(recovered).toEqual([taskId]);
    seen.clear();
  }

  it("resumes in the state the skip went to, with what it stepped over still skipped", async () => {
    const taskId = await start();
    expect(await answer()).toBe("a");
    await parked(); // b
    await service.moveTask({ taskId, toState: "d", skip: true });
    await parked(); // d — and the process dies here
    await crashAndReopen(taskId);

    await service.resumeTask({ taskId });
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the resumed task to complete");
    // `b` and `c` are not revived: a skip is an answer, not an interruption.
    expect(offered).toEqual(["a", "b", "d", "d"]);
    expect(outputsOf(taskId)).toMatchObject({ b_outcome: "skipped", c_outcome: "skipped", d_outcome: "success" });
    expect(taken(taskId)).toHaveLength(1);
  });

  it("makes the entry the skip still OWED when the process died before the target entered", async () => {
    const taskId = await start();
    expect(await answer()).toBe("a");
    await parked(); // b
    await service.moveTask({ taskId, toState: "d", skip: true, inputs: {} });
    await parked(); // d
    // Cut the journal where a process killed between the skip's rows and the target's entry would
    // have left it: the transition and the skipped rows are there, `d` never entered.
    await crashAndReopen(taskId, (project) => {
      const rows = new SqliteEventLog(project.db).list(taskId);
      const entry = rows.find((row) => row.event.type === "instance.entered" && row.event.childKey === "d");
      expect(entry).toBeDefined();
      project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND seq >= ?`).run(taskId, entry!.seq);
      project.db.prepare(`DELETE FROM pending_interactions WHERE task_id = ?`).run(taskId);
    });
    expect(ended(taskId)).toEqual([["a", "success"], ["b", "skipped"], ["c", "skipped"]]);

    await service.resumeTask({ taskId });
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the resumed task to complete");
    expect(offered).toEqual(["a", "b", "d", "d"]);
    // The owed entry was made, and the transition was not journaled a second time.
    expect(taken(taskId)).toHaveLength(1);
    expect(ended(taskId)).toEqual([["a", "success"], ["b", "skipped"], ["c", "skipped"], ["d", "success"], ["(root)", "success"]]);
  });
});

describe("a HELD move survives the process that held it", () => {
  const hostRows = (taskId: string): string[] =>
    journal(taskId)
      .map((e) => (e as unknown as { type: string }).type)
      .filter((type) => type === MOVE_HELD_EVENT || type === MOVE_DROPPED_EVENT);

  it("is journaled when held, re-queued by the resume after a CRASH, and taken when the state it waited for ends", async () => {
    const taskId = await start();
    await parked(); // a
    expect(await service.moveTask({ taskId, toState: "c" })).toEqual({ taskId, status: "held" });
    expect(hostRows(taskId)).toEqual([MOVE_HELD_EVENT]);

    abandoned.push(service);
    const project = openProject(dir, { baseDir: testHome() });
    try {
      project.db.prepare(`UPDATE jobs SET heartbeat_at = 0 WHERE task_id = ? AND ended_at IS NULL`).run(taskId);
    } finally {
      project.close();
    }
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    expect((await service.open(dir)).recovered).toEqual([taskId]);
    seen.clear();

    await service.resumeTask({ taskId });
    // Still held: `a` is asked again, and nothing has moved while it is.
    expect(await answer()).toBe("a");
    expect(await answer()).toBe("c");
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    expect(offered).toEqual(["a", "a", "c", "d"]);
    expect(taken(taskId)).toMatchObject([{ to: "c", by: "person" }]);
    expect(outputsOf(taskId)).toMatchObject({ a_outcome: "success", b_outcome: "skipped", c_outcome: "success" });
    // Taken, so nothing was left to drop.
    expect(hostRows(taskId)).toEqual([MOVE_HELD_EVENT]);
  });

  it("survives a CLOSE: the next open resumes the task, and the move is taken when the state ends", async () => {
    const taskId = await start();
    await parked(); // a
    expect(await service.moveTask({ taskId, toState: "c" })).toEqual({ taskId, status: "held" });
    await service.close();
    seen.clear();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    await (service as unknown as { session(): { resuming: Promise<void> } }).session().resuming;

    expect(await answer()).toBe("a");
    expect(await answer()).toBe("c");
    expect(await answer()).toBe("d");
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    expect(taken(taskId)).toMatchObject([{ to: "c", by: "person" }]);
    expect(outputsOf(taskId)).toMatchObject({ a_outcome: "success", b_outcome: "skipped", c_outcome: "success" });
  });

  it("is DROPPED by a stop, as the in-memory hold is: a resume after it walks on as written", async () => {
    const taskId = await start();
    await parked(); // a
    await service.moveTask({ taskId, toState: "c" });
    service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the stop");
    expect(hostRows(taskId)).toEqual([MOVE_HELD_EVENT, MOVE_DROPPED_EVENT]);
    seen.clear();

    await service.resumeTask({ taskId });
    expect(await answer()).toBe("a");
    expect(await answer()).toBe("b");
    expect(taken(taskId)).toEqual([]);
  });
});
