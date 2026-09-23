/**
 * MOVING a task (decision 0005, the rulings of 2026-09-22), end to end through the app service:
 *
 *  1. **The move table** — every cell: where the target is from where the task stands (ahead through
 *     the transitions the workflow defines, behind, unreachable, in another workflow, and a task with
 *     nothing defined ahead of it) against what the task is doing (working, waiting for the person,
 *     waiting for a user event). The same cells through `move_task`, the conversation's tool.
 *  2. **The input question** — a legal move lacking a required input parks a question in the task's
 *     OWN conversation: durable across a restart, answered through the gate channel, the value
 *     recorded `asked`, and the move taken.
 *  3. **The next-transition chips** — computed in main from the pinned workflow's defined transitions
 *     and the waits the process holds; the right set per state, none for a finished task, each legal.
 *
 * Every state is a gate, as in `taskConnect.test.ts`: a parked gate is a state unmistakably entered.
 * "Working" cannot be made of gates, so where the table's working column is the point the service is
 * told so (`pretend`) — what is being tested is the table's answer and what the host does with it,
 * not how the hubs are read, which `activityOf` does and the other columns exercise for real.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { createWorkflowTools, writeWorkflowFiles } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import type { BoardCard, TaskActivity, TaskConnectResult } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const BOOLEAN = { type: "boolean" };

function files(): Record<string, JsonValue> {
  const gate = (name: string, inputs: Record<string, JsonValue> = {}): JsonValue => ({
    label: name,
    inputs,
    outputs: { confirmed: { schema: BOOLEAN } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } },
  });
  const flag = { flag: { schema: BOOLEAN, description: "Whether the step before was confirmed." } };
  return {
    flow: { label: "Flow", children: { a: { state: "flow/a" }, b: { state: "flow/b" }, c: { state: "flow/c" }, d: { state: "flow/d" } }, sequence: ["a", "b", "c", "d"] },
    "flow/a": gate("a"),
    "flow/b": gate("b"),
    "flow/c": gate("c"),
    "flow/d": gate("d"),
    // A DECISION: confirmed at `decide` goes to `right`, anything else walks on to `left`.
    fork: {
      label: "Fork",
      children: {
        decide: { state: "fork/decide", transitions: [{ when: ".children.decide.output.confirmed", to: "right" }] },
        left: { state: "fork/left" },
        right: { state: "fork/right", transitions: [{ to: "end" }] },
        end: { state: "fork/end" },
      },
      sequence: ["decide", "left", "end"],
    },
    "fork/decide": gate("decide"),
    "fork/left": gate("left"),
    "fork/right": gate("right"),
    "fork/end": gate("end"),
    // A rule WAITING on the person's move once `a` is done: nothing is asked, the task waits on an event.
    evt: {
      label: "Event",
      children: {
        a: { state: "evt/a", transitions: [{ to: "c", when: "on_user_event('task_move', { to_state: 'c' })" }] },
        b: { state: "evt/b" },
        c: { state: "evt/c" },
      },
      sequence: ["a", "b", "c"],
    },
    "evt/a": gate("a"),
    "evt/b": gate("b"),
    "evt/c": gate("c"),
    // Another workflow that mounts `feat/product`, and whose `ship` reads a state a skip steps over.
    feat: {
      label: "Feature",
      children: {
        product: { state: "feat/product" },
        ux: { state: "feat/ux", inputs: { flag: ".children.product.output.confirmed" } },
        ship: { state: "feat/ship", inputs: { flag: ".children.ux.output.confirmed" } },
      },
      sequence: ["product", "ux", "ship"],
    },
    "feat/product": gate("product"),
    "feat/ux": gate("ux", flag),
    "feat/ship": gate("ship", flag),
    "conv/standin": {
      label: "Talk",
      inputs: { opening: { schema: { type: "string" }, description: "What the person did, in a sentence." } },
      operation: { kind: "prompt", prompt: "{{.inputs.opening}}" },
    },
    "lib/second": gate("second", flag),
    "lib/needs": gate("needs", { text: { schema: { type: "string", minLength: 3 }, description: "What to call it." } }),
    // One of each kind of step the question UI makes of an input the task produced nothing for: an
    // enum, a bounded number and a list — the last two answered in the question's own-answer box. (A
    // boolean is `flag` below: here the task's own `confirmed` would fill it by schema.)
    "lib/many": gate("many", {
      mode: { schema: { type: "string", enum: ["fast", "slow"] }, description: "How to run it." },
      limit: { schema: { type: "integer", minimum: 1 }, description: "How many at most." },
      tags: { schema: { type: "array", items: { type: "string" } }, description: "Labels to put on it." },
    }),
  };
}

let dir: string;
let service: AppService;
const seen = new Set<string>();

const open = async (): Promise<void> => {
  service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
  await service.open(dir);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-move-rules-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  seen.clear();
  await open();
});

afterEach(async () => {
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

/** The next gate a STATE parked — a move's own question is not one. */
const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId) && p.moves !== true);

async function parked(): Promise<{ state: string; inputs: Record<string, unknown>; requestId: string }> {
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  return { state: String((gate.inputs as { prompt?: string }).prompt ?? "").replace("?", ""), inputs: gate.inputs as Record<string, unknown>, requestId: gate.requestId };
}

async function answer(confirmed = true): Promise<string> {
  const gate = await parked();
  service.submitInteraction(gate.requestId, { confirmed });
  return gate.state;
}

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);
const metaOf = (taskId: string) => read((p) => p.tasks.tryRead(taskId));
const journal = (taskId: string): EngineEvent[] => read((p) => new SqliteEventLog(p.db).list(taskId).map((row) => row.event));
const hostRows = (taskId: string, type: string): Array<Record<string, unknown>> =>
  journal(taskId).filter((e) => (e as { type: string }).type === type) as unknown as Array<Record<string, unknown>>;
const taskIds = (): string[] => read((p) => p.tasks.list().map((t) => t.id).sort());
const documents = (): string[] => {
  const at = join(dir, ".jaira", "system", "snapshots", "_documents");
  return existsSync(at) ? readdirSync(at).sort() : [];
};

function ended(taskId: string): Array<[string, string]> {
  const events = journal(taskId);
  const keyOf = new Map<string, string>();
  for (const e of events) if (e.type === "instance.entered") keyOf.set(e.instanceId, e.childKey ?? "(root)");
  return events.filter((e): e is Extract<EngineEvent, { type: "instance.terminated" }> => e.type === "instance.terminated").map((e) => [keyOf.get(e.instanceId) ?? "?", e.outcome]);
}

async function ran(workflow: string, answers: boolean[]): Promise<string> {
  const { taskId } = service.createTask({ title: `Ran ${workflow}`, workflow });
  await service.startTask({ taskId });
  for (const confirmed of answers) await answer(confirmed);
  await until(() => statusOf(taskId) === "completed", `${workflow} to complete`);
  return taskId;
}

/** A task parked in `workflow` after answering `answers` — so waiting for the person at the next gate. */
async function standingIn(workflow: string, answers: boolean[]): Promise<string> {
  const { taskId } = service.createTask({ title: `In ${workflow}`, workflow });
  await service.startTask({ taskId });
  for (const confirmed of answers) await answer(confirmed);
  await parked();
  return taskId;
}

/** Tell the service a task is doing something gates cannot stage — see the header. */
function pretend(taskId: string, activity: TaskActivity): void {
  const target = service as unknown as { activityOf: (open: unknown, id: string) => TaskActivity };
  const real = target.activityOf.bind(service);
  target.activityOf = (session, id) => (id === taskId ? activity : real(session, id));
}

const ok = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: true }> => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result;
};
const no = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: false }> => {
  if (result.ok) throw new Error("expected a refusal");
  return result;
};

// ---------------------------------------------------------------------------------------------------

describe("the move table — AHEAD, through the transitions the workflow defines", () => {
  it("working: fast-forward from where it is (the next state is simply taken when this one ends)", async () => {
    const taskId = await standingIn("flow", []); // at a
    pretend(taskId, "working");
    expect(ok(await service.connectTask({ taskId, target: "flow/b", dryRun: true })).plan.judgement).toEqual({ where: "ahead", activity: "working", way: "next" });
    const far = await service.connectTask({ taskId, target: "flow/d", dryRun: true });
    expect(far.plan?.judgement).toEqual({ where: "ahead", activity: "working", way: "fast-forward" });
    expect(far.plan?.forward).toBe("fast-forward");
  });

  it("waiting for input: fast-forward — and nothing is asked first", async () => {
    const taskId = await standingIn("flow", []); // at a, its gate parked
    const far = await service.connectTask({ taskId, target: "flow/c", dryRun: true });
    expect(far.plan?.judgement).toEqual({ where: "ahead", activity: "waiting-input", way: "fast-forward" });
    expect(far.plan?.move).toMatchObject({ direction: "forward", passes: ["b"] });
  });

  it("waiting for a user event: the move IS the event where it leads there; elsewhere ahead it fast-forwards", async () => {
    const { taskId } = service.createTask({ title: "Waits", workflow: "evt" });
    await service.startTask({ taskId });
    expect(await answer()).toBe("a");
    await until(() => service.pendingUserEvents().some((w) => w.taskId === taskId), "the rule to wait on the move");
    const toC = ok(await service.connectTask({ taskId, target: "evt/c", dryRun: true }));
    expect(toC.plan.judgement).toEqual({ where: "ahead", activity: "waiting-event", way: "event" });
    expect(toC.plan.move?.answersRule).toBe(true);
    const toB = await service.connectTask({ taskId, target: "evt/b", dryRun: true });
    expect(toB.plan?.judgement).toEqual({ where: "ahead", activity: "waiting-event", way: "next" });

    expect(ok(await service.connectTask({ taskId, target: "evt/c" })).moved).toBe("answered");
    expect((await parked()).state).toBe("c");
    expect(ended(taskId)).not.toContainEqual(["b", "success"]);
  });

  it("a target off the spine that only a DECISION enters is run to — never jumped to past the decision", async () => {
    const taskId = await standingIn("fork", []); // at decide
    const right = no(await service.connectTask({ taskId, target: "fork/right", dryRun: true }));
    // Ahead (the decision can go there), so it is a fast-forward — which this running task, with no
    // conversation to answer the decision, cannot take. Refused for THAT, and the plan says why it was run.
    expect(right.plan).toMatchObject({ judgement: { where: "ahead", way: "fast-forward" }, forward: "fast-forward", move: { direction: "aside" } });
    expect(right.refusal.code).toBe("fast-forward");
  });
});

describe("the move table — BEHIND, already entered", () => {
  it("working: ASKS 'stop and rewind?' — a dry run carries the question, the move without a yes is refused with it, and with one is taken", async () => {
    const taskId = await standingIn("flow", [true, true]); // at c
    pretend(taskId, "working");
    const dry = ok(await service.connectTask({ taskId, target: "flow/a", dryRun: true }));
    expect(dry.plan.judgement).toMatchObject({ where: "behind", activity: "working", way: "back", confirm: "stop-and-rewind" });
    expect(dry.plan.judgement?.sentence).toBe("'In flow' is working. Stop it and go back to 'a'? It is entered again as its next pass; what the task did since stays in its history.");

    const unasked = no(await service.connectTask({ taskId, target: "flow/a" }));
    expect(unasked.refusal).toEqual({ code: "confirm", message: dry.plan.judgement!.sentence });
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);

    const done = ok(await service.connectTask({ taskId, target: "flow/a", confirmed: true }));
    expect(done.moved).toBe("taking");
    expect((await parked()).state).toBe("a");
    expect(ended(taskId)).toContainEqual(["c", "skipped"]);
  });

  it("waiting for input: goes back at once, no question", async () => {
    const taskId = await standingIn("flow", [true]); // at b
    const done = ok(await service.connectTask({ taskId, target: "flow/a" }));
    expect(done.plan.judgement).toEqual({ where: "behind", activity: "waiting-input", way: "back" });
    expect(done.moved).toBe("taking");
    expect((await parked()).state).toBe("a");
  });

  it("waiting for a user event: goes back at once, no question", async () => {
    const { taskId } = service.createTask({ title: "Waits", workflow: "evt" });
    await service.startTask({ taskId });
    await answer();
    await until(() => service.pendingUserEvents().some((w) => w.taskId === taskId), "the rule to wait on the move");
    const done = ok(await service.connectTask({ taskId, target: "evt/a" }));
    expect(done.plan.judgement).toEqual({ where: "behind", activity: "waiting-event", way: "back" });
    expect((await parked()).state).toBe("a");
  });
});

describe("the move table — UNREACHABLE is illegal, in every column", () => {
  const DECIDED = "'right' is reached only by the decision at 'decide', which 'In fork' has already made — a move cannot take the other branch. Move it back to that state to decide again.";

  for (const activity of ["working", "waiting-input", "waiting-event"] as const) {
    it(`${activity}: a branch whose decision was already taken is refused with why — the dry run too`, async () => {
      const taskId = await standingIn("fork", [false]); // decided "not right": at left
      if (activity !== "waiting-input") pretend(taskId, activity);
      for (const dryRun of [true, false]) {
        const refused = no(await service.connectTask({ taskId, target: "fork/right", dryRun }));
        expect(refused.refusal).toEqual({ code: "illegal", message: DECIDED });
        expect(refused.plan?.judgement).toMatchObject({ where: "unreachable", activity, way: "illegal" });
      }
      expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
    });
  }

  it("a sideways jump — a state no transition leads to from here — is refused, and skip does not make it legal", async () => {
    const taskId = await standingIn("fork", [true]); // decided "right": at right
    const message = "'left' cannot be reached from where 'In fork' stands ('right'): no transition the workflow defines leads there, so moving it would skip what the workflow decides on the way.";
    expect(no(await service.connectTask({ taskId, target: "fork/left" })).refusal).toEqual({ code: "illegal", message });
    expect(no(await service.connectTask({ taskId, target: "fork/left", skip: true })).refusal).toEqual({ code: "illegal", message });
  });
});

describe("the move table — ELSEWHERE: another workflow, or a new transition", () => {
  it("working: ASKS 'pause and move?'; with a yes the task is paused, then moved along the new transition", async () => {
    const taskId = await standingIn("flow", [true]); // at b
    pretend(taskId, "working");
    const dry = ok(await service.connectTask({ taskId, target: "lib/second", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "cloned", judgement: { where: "elsewhere", activity: "working", way: "move", confirm: "pause-and-move" } });
    expect(dry.plan.judgement?.sentence).toBe("'In flow' is working. Pause it and move it to 'lib/second'?");
    expect(no(await service.connectTask({ taskId, target: "lib/second" })).refusal.code).toBe("confirm");
    expect(documents()).toEqual([]);

    const done = ok(await service.connectTask({ taskId, target: "lib/second", confirmed: true }));
    expect(done.plan.modification).toBe("cloned");
    expect(await parked()).toMatchObject({ state: "second", inputs: { flag: true } });
    // Paused first: the state it stood in was unwound, then stepped past by the new transition.
    expect(ended(taskId)).toContainEqual(["b", "skipped"]);
  });

  it("waiting for a user event: moved without a question — paused first, as its engine cannot see a new transition", async () => {
    const { taskId } = service.createTask({ title: "Waits", workflow: "evt" });
    await service.startTask({ taskId });
    await answer();
    await until(() => service.pendingUserEvents().some((w) => w.taskId === taskId), "the rule to wait on the move");
    const done = ok(await service.connectTask({ taskId, target: "lib/second" }));
    expect(done.plan.judgement).toEqual({ where: "elsewhere", activity: "waiting-event", way: "move" });
    expect(await parked()).toMatchObject({ state: "second" });
  });

  it("an ADOPTION of a working task asks the same, and the adopted task goes on as the child it now is", async () => {
    const taskId = await standingIn("feat/product", []); // its only gate parked
    pretend(taskId, "working");
    const dry = ok(await service.connectTask({ taskId, target: "feat", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "adopt", judgement: { where: "elsewhere", activity: "working", confirm: "pause-and-move" } });
    expect(no(await service.connectTask({ taskId, target: "feat", start: false })).refusal.code).toBe("confirm");
    const done = ok(await service.connectTask({ taskId, target: "feat", start: false, confirmed: true }));
    expect(metaOf(taskId)?.origin).toMatchObject({ kind: "adopt", taskId: done.taskId });
    // Resumed as the child: its gate is asked again, and answering it finishes it.
    seen.clear();
    expect(await answer()).toBe("product");
    await until(() => statusOf(taskId) === "completed", "the adopted task to finish");
    // …which releases the parent holding for it: it goes on past the child, to `ux`.
    expect(await parked()).toMatchObject({ state: "ux", inputs: { flag: true } });
  });

  it("a task with NO transitions ahead (finished) takes a move to a state it never entered as a new transition", async () => {
    const taskId = await ran("fork", [false, true, true]); // decide → left → end
    const dry = ok(await service.connectTask({ taskId, target: "fork/right", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "new", judgement: { where: "elsewhere", activity: "finished", way: "move" } });
    // …and a state it DID enter is behind: it goes back there.
    expect(ok(await service.connectTask({ taskId, target: "fork/left", dryRun: true })).plan.judgement).toEqual({ where: "behind", activity: "finished", way: "back" });
  });
});

describe("move_task obeys the same table", () => {
  const moveTool = (conversation: string) => createWorkflowTools(service.workflowHostFor(dir, conversation))["move_task"]!;
  const call = async (conversation: string, args: Record<string, JsonValue>) => (await moveTool(conversation).run(args as never, {} as never)) as Record<string, JsonValue>;

  it("refuses the illegal cell, and answers an ASK cell with its question until the person's yes is passed on", async () => {
    const forked = await standingIn("fork", [false]);
    expect(await call(forked, { to: "fork/right" })).toMatchObject({ ok: false, code: "illegal" });

    const flow = await standingIn("flow", [true, true]);
    pretend(flow, "working");
    expect(await call(flow, { to: "flow/a" })).toEqual({
      ok: false,
      code: "confirm",
      reason: "'In flow' is working. Stop it and go back to 'a'? It is entered again as its next pass; what the task did since stays in its history.",
    });
    expect(await call(flow, { to: "flow/a", confirm: true })).toMatchObject({ ok: true, resolution: "move", moved: "taking" });
  });

  it("does not hand missing inputs back to the model: the PERSON is asked in the moved task's conversation", async () => {
    const product = await ran("feat/product", [true]);
    const answered = await call(product, { to: "lib/needs" });
    expect(answered).toMatchObject({ ok: true, task: product, asked: { inputs: [{ name: "text", state: "lib/needs" }] } });
    const request = (answered["asked"] as { request: string }).request;
    expect(service.pendingInteractions().find((p) => p.requestId === request)).toMatchObject({ taskId: product, moves: true });
    // No `jaira.moved` row: nothing has moved yet.
    expect(hostRows(product, "jaira.moved")).toEqual([]);
  });
});

describe("the input question — asked in the task's own conversation", () => {
  const TEXT = { state: "lib/needs", name: "text", schema: { type: "string", minLength: 3 }, description: "What to call it.", reason: "nothing the task produced fits it" };

  it("is parked durable, survives a restart, refuses an answer its schema refuses, and — answered — takes the move with the value recorded ASKED", async () => {
    const product = await ran("feat/product", [true]);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/needs" }));
    const requestId = done.asked!.requestId;
    expect(requestId.startsWith("move:")).toBe(true);
    // In the task's conversation, where the move asked it.
    const turn = service.conversation(product).turns.find((t) => t.kind === "asked");
    expect(turn?.asked).toMatchObject({ requestId, target: "lib/needs", missing: [TEXT] });
    expect(hostRows(product, "jaira.moveAsked")).toMatchObject([{ requestId, move: { target: "lib/needs", by: "person" }, missing: [TEXT] }]);

    // A restart: the question is still being asked — the same question, drawn by the question UI.
    await service.close();
    await open();
    seen.clear(); // a new hub mints request ids afresh
    const pending = service.pendingInteractions().find((p) => p.requestId === requestId);
    expect(pending).toMatchObject({
      taskId: product,
      component: "choose_option",
      moves: true,
      config: {
        component: "choose_option",
        prompt: "Moving 'Ran feat/product' to needs needs an input.",
        questions: [{ name: "text", header: "text", question: "What to call it.", custom: true, options: [], schema: { type: "string", minLength: 3 } }],
      },
    });
    expect(pending?.resumes).toBeUndefined();

    // The input's own schema is enforced in main: two letters is not three — and the question stays.
    await expect(Promise.resolve().then(() => service.submitInteraction(requestId, { answers: { text: "ab" } }))).rejects.toThrow(/invalid answer: text/);
    expect(service.pendingInteractions().some((p) => p.requestId === requestId)).toBe(true);

    await service.submitInteraction(requestId, { answers: { text: "Widget" } });
    expect(service.pendingInteractions().some((p) => p.requestId === requestId)).toBe(false);
    expect(documents()).toHaveLength(1);
    const parent = metaOf(product)!.origin!.taskId;
    expect(await parked()).toMatchObject({ state: "needs", inputs: { text: "Widget" } });
    expect(hostRows(parent, "jaira.supplied")).toMatchObject([{ provenance: { text: { via: "asked" } } }]);
    expect(hostRows(product, "jaira.moveAnswered")).toMatchObject([{ requestId, outcome: "moved", answered: { text: "Widget" } }]);
    expect(service.conversation(product).turns.find((t) => t.kind === "asked")?.asked).toMatchObject({ outcome: "moved", answered: { text: "Widget" } });
  });

  it("asks within the task's own workflow too — a skip past what an input reads — and answered, the move is taken with it", async () => {
    const taskId = await standingIn("feat", []); // at product
    const done = ok(await service.connectTask({ taskId, target: "feat/ship", skip: true }));
    expect(done.asked?.missing).toMatchObject([{ state: "feat/ship", name: "flag" }]);
    // A boolean is asked as two answers, Yes and No — a value of its schema, not a word.
    expect(service.pendingInteractions().find((p) => p.requestId === done.asked!.requestId)?.config).toMatchObject({
      component: "choose_option",
      questions: [{ name: "flag", header: "flag", question: "Whether the step before was confirmed.", options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }], schema: BOOLEAN }],
    });
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
    await service.submitInteraction(done.asked!.requestId, { answers: { flag: true } });
    expect(await parked()).toMatchObject({ state: "ship", inputs: { flag: true } });
    expect(hostRows(taskId, "jaira.supplied")).toMatchObject([{ to: "ship", provenance: { flag: { via: "asked" } } }]);
    expect(ended(taskId)).toContainEqual(["ux", "skipped"]);
  });

  it("is one step of the question UI per missing input: an enum's values as options, anything else in the own-answer box", async () => {
    const product = await ran("feat/product", [true]);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/many" }));
    const requestId = done.asked!.requestId;
    const pending = service.pendingInteractions().find((p) => p.requestId === requestId)!;
    expect(pending.component).toBe("choose_option");
    const config = pending.config as Extract<typeof pending.config, { component: "choose_option" }>;
    expect(config.questions!.map((q) => q.name).sort()).toEqual(["limit", "mode", "tags"]);
    const step = (name: string) => config.questions!.find((q) => q.name === name)!;
    // The chip is the input's name; the question is its declared description.
    expect(step("mode")).toMatchObject({ header: "mode", question: "How to run it.", options: [{ value: "fast" }, { value: "slow" }] });
    expect(step("mode").custom).toBeUndefined();
    expect(step("limit")).toMatchObject({ question: "How many at most.", custom: true, options: [], schema: { type: "integer", minimum: 1 } });
    expect(step("tags")).toMatchObject({ custom: true, options: [], schema: { type: "array", items: { type: "string" } } });

    // An answer the options do not hold is refused by the contract; a typed one its schema refuses, by
    // the run's validator. Either way the question is still asked.
    const answers = { mode: "fast", limit: 3, tags: ["x", "y"] };
    const submit = (value: Record<string, JsonValue>) => Promise.resolve().then(() => service.submitInteraction(requestId, { answers: value }));
    await expect(submit({ ...answers, mode: "medium" })).rejects.toThrow(/invalid choose_option response: result.answers.mode/);
    await expect(submit({ ...answers, limit: 0 })).rejects.toThrow(/invalid answer: limit/);
    await expect(submit({ ...answers, tags: "x, y" })).rejects.toThrow(/invalid answer: tags/);
    expect(service.pendingInteractions().some((p) => p.requestId === requestId)).toBe(true);

    // Answered: the move is taken with every value as its own type.
    await submit(answers);
    expect(await parked()).toMatchObject({ state: "many", inputs: answers });
    expect(hostRows(product, "jaira.moveAnswered")).toMatchObject([{ requestId, outcome: "moved", answered: answers }]);
  });

  it("the dry run says what will be asked, and writes nothing", async () => {
    const product = await ran("feat/product", [true]);
    const before = { tasks: taskIds(), documents: documents() };
    const dry = ok(await service.connectTask({ taskId: product, target: "lib/needs", dryRun: true }));
    expect(dry.plan.question).toEqual([TEXT]);
    expect(dry.asked).toBeUndefined();
    expect({ tasks: taskIds(), documents: documents() }).toEqual(before);
    expect(service.pendingInteractions()).toEqual([]);
  });
});

describe("next-transition chips", () => {
  const cardOf = (taskId: string, level: string): BoardCard | undefined =>
    service
      .board({ level })
      .columns.flatMap((column) => column.cards)
      .find((card) => card.taskId === taskId);

  it("offer the defined transitions out of where the task stands — the next state, and a decision's branch", async () => {
    const flow = await standingIn("flow", []); // at a
    expect(cardOf(flow, "flow")?.next).toEqual([{ target: "flow/b", path: ["b"], label: "b", way: "next" }]);

    const forked = await standingIn("fork", []); // at decide
    const next = cardOf(forked, "fork")?.next ?? [];
    expect(next.map((move) => [move.path.join("/"), move.way])).toEqual(
      expect.arrayContaining([
        ["left", "next"],
        ["right", "fast-forward"],
      ]),
    );
    expect(next).toHaveLength(2);
    // Running with no conversation to answer the decision, the branch cannot be run to now — and says why.
    expect(next.find((move) => move.path[0] === "right")?.blocked).toMatch(/no conversation to answer/);
  });

  it("include the move a rule of the workflow is waiting for, marked as the event", async () => {
    const { taskId } = service.createTask({ title: "Waits", workflow: "evt" });
    await service.startTask({ taskId });
    await answer();
    await until(() => service.pendingUserEvents().some((w) => w.taskId === taskId), "the rule to wait on the move");
    const next = cardOf(taskId, "evt")?.next ?? [];
    expect(next.find((move) => move.path[0] === "c")).toMatchObject({ target: "evt/c", way: "event", event: true });
    expect(next.find((move) => move.path[0] === "b")).toMatchObject({ target: "evt/b", way: "next" });
  });

  it("a finished task gets none", async () => {
    const taskId = await ran("flow", [true, true, true, true]);
    expect(cardOf(taskId, "flow")?.next).toBeUndefined();
  });

  it("every chip is a legal move: its own path, asked of connect, is never illegal — and pressing one takes it", async () => {
    for (const [workflow, answers] of [
      ["flow", [true]],
      ["fork", []],
      ["fork", [false]],
    ] as const) {
      const taskId = await standingIn(workflow, [...answers]);
      for (const move of cardOf(taskId, workflow)?.next ?? []) {
        const result = await service.connectTask({ taskId, target: move.target, path: move.path, dryRun: true });
        expect(result.plan?.judgement?.way, `${workflow} → ${move.path.join("/")}`).toBe(move.way);
        if (!result.ok) expect(result.refusal.code).toBe("fast-forward");
      }
    }
    const taskId = await standingIn("flow", []);
    const chip = cardOf(taskId, "flow")!.next![0]!;
    expect(ok(await service.connectTask({ taskId, target: chip.target, path: chip.path })).moved).toBe("held");
  });
});
