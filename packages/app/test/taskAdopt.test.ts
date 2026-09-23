/**
 * ADOPT and input provenance, end to end (decision 0005, steps 2 and 3).
 *
 * A task that ran one phase alone is taken up by a NEW task of the workflow that mounts that phase:
 * mirror rows in the parent's journal whose instance id is the adopted task's, its outputs on the
 * row, the parent standing past that child — and nothing copied. Around that, the rules: parent
 * inputs inferred backwards through plain-path wires, schema fit and holes refused by name, the split
 * shape, a task adopted while it still runs, a rewind that un-adopts, a back-transition that runs the
 * child in the parent as occurrence 1, and the dry run that says all of it without doing any of it.
 *
 * Every model is scripted (`fake`), and how often a model was reached is the assertion that matters:
 * an adopted child is one whose model the parent never called.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskLoad, forkTask, initProject, loadSnapshot, openProject, sessionStoreFor, SqliteEventLog, ADOPTED_STATE_PREFIX } from "@jaira/persistence";
import { writeWorkflowFiles, type FakeRule } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage, TaskAdoptResult } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const str = (extra: Record<string, JsonValue> = {}): { schema: JsonValue } => ({ schema: { type: "string", ...extra } });
const ITEM = { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } };

/** A prompt leaf: one model, one output bound off the operation. */
const leaf = (label: string, model: string, inputs: Record<string, JsonValue>, output: string, schema: JsonValue = { type: "string" }): JsonValue => ({
  label,
  inputs,
  outputs: { [output]: { schema, binding: `.operation.output.${output}` } },
  operation: { model, prompt: `${label}.`, output: { [output]: { schema } } },
});

function files(productBrief: JsonValue = { type: "string" }): Record<string, JsonValue> {
  return {
    // product → ux → build, each reading the one before; the root reads `build` and nothing earlier.
    feat: {
      label: "Feature",
      environment: { kind: "prompt", model: "nobody" },
      inputs: { issue: str({ minLength: 1 }), audience: str() },
      outputs: { shipped: { schema: { type: "string" }, binding: ".children.build.output.shipped", optional: true } },
      children: {
        product: { state: "feat/product", inputs: { issue: ".inputs.issue" } },
        ux: { state: "feat/ux", inputs: { brief: ".children.product.output.brief", audience: ".inputs.audience" } },
        build: { state: "feat/build", inputs: { plan: ".children.ux.output.plan" } },
      },
      sequence: ["product", "ux", "build"],
    },
    "feat/product": leaf("Product", "product", { issue: str() }, "brief", productBrief),
    "feat/ux": leaf("UX", "ux", { brief: { schema: {} }, audience: str() }, "plan"),
    "feat/build": leaf("Build", "build", { plan: str() }, "shipped"),
    // The same phases under a root that READS product at its end — so skipping product leaves a hole.
    reads: {
      label: "Reads product",
      environment: { kind: "prompt", model: "nobody" },
      inputs: { issue: str(), audience: str() },
      outputs: { brief: { schema: {}, binding: ".children.product.output.brief", optional: true } },
      children: {
        product: { state: "feat/product", inputs: { issue: ".inputs.issue" } },
        ux: { state: "feat/ux", inputs: { brief: ".children.product.output.brief", audience: ".inputs.audience" } },
      },
      sequence: ["product", "ux"],
    },
    // A list split into tasks, then a join-less tail per element.
    batch: {
      label: "Batch",
      environment: { kind: "prompt", model: "nobody" },
      inputs: { items: { schema: { type: "array", items: ITEM } } },
      outputs: { final: { schema: { type: "string" }, binding: ".children.finish.output.final", optional: true } },
      children: {
        work: { state: "batch/work", inputs: { item: { $expr: ".inputs.items", each: "split", title: "title" } } },
        finish: { state: "batch/finish", inputs: { doc: ".children.work.output.doc" } },
      },
      sequence: ["work", "finish"],
    },
    "batch/work": leaf("Work", "worker", { item: { schema: ITEM } }, "doc"),
    "batch/finish": leaf("Finish", "finisher", { doc: { schema: {} } }, "final"),
    // A phase that is a GATE — unmistakably running until the test says otherwise — and its parent.
    gated: {
      label: "Gated",
      environment: { kind: "prompt", model: "nobody" },
      children: { ask: { state: "gated/ask" }, after: { state: "gated/after", inputs: { confirmed: ".children.ask.output.confirmed" } } },
      sequence: ["ask", "after"],
      outputs: { done: { schema: { type: "string" }, binding: ".children.after.output.done", optional: true } },
    },
    "gated/ask": {
      label: "Ask",
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "go?" } },
    },
    "gated/after": leaf("After", "after", { confirmed: { schema: { type: "boolean" } } }, "done"),
    // Two gates in a row, the first taking a note — what a person's move can hand it.
    loop: {
      label: "Loop",
      inputs: { note: { schema: { type: "string" }, optional: true } },
      children: { a: { state: "loop/a", inputs: { note: ".inputs.note" } }, b: { state: "loop/b" } },
      sequence: ["a", "b"],
    },
    "loop/a": {
      label: "A",
      inputs: { note: { schema: { type: "string" }, optional: true } },
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "a?" } },
    },
    "loop/b": {
      label: "B",
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "b?" } },
    },
    // NAMED SESSIONS across an adoption. Product keeps a `notes` conversation scoped GLOBAL (the run's
    // root, whichever that is) and a `loop` one scoped to itself; ux, run by the parent, joins `notes`.
    sess: {
      label: "Sessions",
      environment: { kind: "prompt", model: "nobody" },
      children: { product: { state: "sess/product" }, ux: { state: "sess/ux", inputs: { brief: ".children.product.output.brief" } } },
      sequence: ["product", "ux"],
      outputs: { plan: { schema: { type: "string" }, binding: ".children.ux.output.plan", optional: true } },
    },
    "sess/product": {
      label: "Product",
      outputs: { brief: { schema: { type: "string" }, binding: ".children.draft.output.brief" } },
      children: { note: { state: "sess/product/note" }, draft: { state: "sess/product/draft" } },
      sequence: ["note", "draft"],
    },
    "sess/product/note": { ...(leaf("Note", "noter", {}, "note") as Record<string, JsonValue>), environment: { session: { $ref: "notes", $in: "global" } } },
    "sess/product/draft": { ...(leaf("Draft", "drafter", {}, "brief") as Record<string, JsonValue>), environment: { session: { $ref: "loop", $in: "sess/product" } } },
    "sess/ux": { ...(leaf("UX", "uxer", { brief: str() }, "plan") as Record<string, JsonValue>), environment: { session: { $ref: "notes", $in: "global" } } },
  };
}

const RULES: FakeRule[] = [
  { model: "product", output: { brief: "the brief" } },
  { model: "ux", output: { plan: "the plan" } },
  { model: "build", output: { shipped: "shipped" } },
  { model: "worker", output: { doc: "worked" } },
  { model: "finisher", output: { final: "done" } },
  { model: "after", output: { done: "after the gate" } },
  { model: "noter", output: { note: "noted" } },
  { model: "drafter", output: { brief: "drafted" } },
  { model: "uxer", output: { plan: "planned" } },
];

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-adopt-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
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
const metaOf = (taskId: string) => read((p) => p.tasks.read(taskId));
const journal = (taskId: string) => read((p) => new SqliteEventLog(p.db).list(taskId));
const events = (taskId: string): EngineEvent[] => journal(taskId).map((row) => row.event);
/** The child keys this task's machine entered, in order — a mirror row counts, as the entry it is. */
const entered = (taskId: string): string[] =>
  events(taskId).flatMap((e) => (e.type === "instance.entered" && e.childKey !== undefined ? [e.childKey] : []));
/** How many times this task's own run dispatched an operation — an adopted child dispatches none. */
const dispatched = (taskId: string): number => events(taskId).filter((e) => e.type === "operation.started").length;

/** Run one phase alone, to completion. */
async function ran(workflow: string, inputs: Record<string, JsonValue>, title = workflow): Promise<string> {
  const { taskId } = service.createTask({ title, workflow, inputs });
  await service.startTask({ taskId, fake: RULES as unknown as JsonValue });
  await until(() => statusOf(taskId) === "completed", `${workflow} to complete`);
  return taskId;
}

const plan = (result: TaskAdoptResult) => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.plan;
};
const refusal = (result: TaskAdoptResult) => {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
};

describe("adopting a finished task", () => {
  it("mirrors it into a new parent that stands past it, infers the parent's input backwards, and runs only what is left", async () => {
    const product = await ran("feat/product", { issue: "pause and stop" }, "Pause and stop");

    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "devs" }, fake: RULES as unknown as JsonValue });
    const made = plan(result);
    expect(result).toMatchObject({ ok: true, dryRun: false, started: true });
    const parent = (result as { taskId: string }).taskId;
    expect(made).toMatchObject({
      workflow: "feat",
      title: "Pause and stop",
      cursor: "product",
      next: "ux",
      adopted: [{ taskId: product, childKey: "product", stateId: "feat/product", shape: "child", pending: false, stateChanged: false }],
      // `issue` is what product actually ran with; `audience` is what the form was asked for.
      inputs: { issue: "pause and stop", audience: "devs" },
      provenance: { issue: { via: "bound", from: { taskId: product, input: "issue" } }, audience: { via: "asked" } },
      waitsFor: [],
    });
    expect(made.asks).toEqual([]);

    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(outputsOf(parent)).toEqual({ shipped: "shipped" });
    // The parent ran ux and build — two dispatches — and never product.
    expect(entered(parent)).toEqual(["product", "ux", "build"]);
    expect(dispatched(parent)).toBe(2);

    // The mirror rows: the adopted task's id IS the instance's, and its outputs are on the row.
    const rows = events(parent);
    expect(rows[0]).toMatchObject({ type: "instance.entered", stateId: "feat", inputs: { issue: "pause and stop", audience: "devs" } });
    expect(rows[1]).toMatchObject({ type: "instance.entered", instanceId: product, childKey: "product", stateId: "feat/product", adopted: true, inputs: { issue: "pause and stop" } });
    expect(rows[2]).toMatchObject({ type: "instance.terminated", instanceId: product, outcome: "success", outputs: { brief: "the brief" } });

    // ux read what the ADOPTED task produced, through the parent's own wiring.
    const detail = service.taskDetail(parent);
    const [mirror, ux] = detail.instances[0]!.children;
    expect(ux!.inputs).toEqual({ brief: "the brief", audience: "devs" });
    expect(mirror!.made).toEqual({ taskId: product, kind: "adopt" });

    // Nothing was copied: the adopted task keeps its journal, and only where it files changed.
    expect(metaOf(product)).toMatchObject({ parentTaskId: parent, origin: { kind: "adopt", taskId: parent, key: "product", index: 0 } });
    expect(dispatched(product)).toBe(1);
    expect(service.listTasks().find((t) => t.taskId === product)?.origin).toMatchObject({ kind: "adopt", taskId: parent, label: "as product" });
    // One line in the parent's conversation, at the child it stands for.
    const line = service.conversation(parent).turns.filter((t) => t.kind === "made");
    expect(line.map((t) => [t.path, t.made?.kind, t.made?.runs[0]?.taskId, t.made?.runs[0]?.status])).toEqual([["product", "adopt", product, "completed"]]);

    // Provenance, as the inputs view reads it: the root's from the task's file, a child's bound.
    expect(detail.instances[0]!.inputProvenance).toEqual({ issue: { via: "bound", from: { taskId: product, input: "issue" } }, audience: { via: "asked" } });
    expect(ux!.inputProvenance).toEqual({ brief: { via: "bound" }, audience: { via: "bound" } });
  });

  it("files the adopted task under its parent: beneath its card on the roots board, in the child's column of the parent's", async () => {
    const product = await ran("feat/product", { issue: "x" });
    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "devs" }, fake: RULES as unknown as JsonValue });
    const parent = (result as { taskId: string }).taskId;
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    const roots = service.boardRoots();
    // In the PARENT's column — the workflow it now belongs to — and marked as filing beneath it
    // (decision 0005 step 5: the board draws it indented under the parent's card).
    const feat = roots.columns.find((c) => c.key === "feat")!;
    expect(feat.cards.map((card) => [card.taskId, card.under])).toEqual(expect.arrayContaining([[parent, undefined], [product, parent]]));
    expect(roots.columns.flatMap((c) => c.cards).filter((card) => card.taskId === product)).toHaveLength(1);
    const board = service.board({ level: "feat" });
    expect(board.columns.find((c) => c.key === "product")?.cards.map((card) => card.taskId)).toEqual([product]);
  });

  it("loads as history under a stand-in state, with the child still owed its answer", async () => {
    const product = await ran("feat/product", { issue: "x" });
    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "devs" }, start: false });
    const parent = (result as { taskId: string }).taskId;
    expect(result).toMatchObject({ ok: true, started: false });
    expect(statusOf(parent)).toBe("queued");

    const load = read((p) => {
      const built = buildTaskLoad(p, parent, loadSnapshot(p.paths.snapshotsDir, p.runtime.get(parent)!.snapshotHash!).states);
      return { loaded: built.loaded, frontier: built.frontier, blocked: built.blocked };
    });
    expect(load.blocked).toBeUndefined();
    expect(load.loaded).toMatchObject({
      stateId: "feat",
      live: true,
      cursor: 0,
      unanswered: ["product"],
      children: [{ id: product, stateId: `${ADOPTED_STATE_PREFIX}feat/product`, childKey: "product", live: false, outcome: "success", operation: { value: { brief: "the brief" } } }],
    });
    expect(load.frontier.map((f) => f.stateId)).toEqual(["feat"]);

    // And a plain Start is a resume: the task has a journal.
    await service.resumeTask({ taskId: parent, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(outputsOf(parent)).toEqual({ shipped: "shipped" });
  });
});

describe("the dry run", () => {
  it("says what an adoption would do — and what it would still ask — and changes nothing", async () => {
    const product = await ran("feat/product", { issue: "x" }, "X");
    const before = service.listTasks().length;
    const result = await service.adoptTask({ taskId: product, workflow: "feat", dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect((result as { taskId?: string }).taskId).toBeUndefined();
    const would = plan(result);
    expect(would).toMatchObject({ cursor: "product", next: "ux", inputs: { issue: "x" }, adopted: [{ taskId: product, childKey: "product" }] });
    // Only what the adopted task does not determine, derived from the declared slot.
    expect(would.asks).toEqual([{ name: "audience", required: true, schema: { type: "string" } }]);
    expect(service.listTasks()).toHaveLength(before);
    expect(metaOf(product).origin).toBeUndefined();

    // The same request for real is refused for exactly that input — and still changes nothing.
    const real = await service.adoptTask({ taskId: product, workflow: "feat" });
    expect(refusal(real)).toMatchObject({ code: "inputs-missing" });
    expect(refusal(real).message).toContain("'audience'");
    expect(service.listTasks()).toHaveLength(before);
  });

  it("refuses a task whose state the workflow does not mount, and a task already somebody's", async () => {
    const work = await ran("batch/work", { item: { id: "a", title: "Alpha" } });
    expect(refusal(await service.adoptTask({ taskId: work, workflow: "feat", dryRun: true }))).toMatchObject({ code: "not-mounted" });
    expect(refusal(await service.adoptTask({ taskId: "t-missing000", workflow: "feat", dryRun: true }))).toMatchObject({ code: "unknown-task" });

    const product = await ran("feat/product", { issue: "x" });
    await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "a" }, start: false });
    expect(refusal(await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "a" }, dryRun: true }))).toMatchObject({ code: "already-adopted" });
  });
});

describe("eligibility", () => {
  it("refuses a task whose recorded outputs no longer fit the state, naming the path that failed", async () => {
    const product = await ran("feat/product", { issue: "x" });
    // The state changes after the task was pinned: `brief` is a number now.
    writeWorkflowFiles(read((p) => p.paths.workflowsDir), files({ type: "number" }));
    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "a" } });
    expect(refusal(result)).toMatchObject({ code: "schema-misfit", path: "outputs.brief" });
    expect(refusal(result).message).toMatch(/outputs\.brief must be number/);
    expect(service.listTasks()).toHaveLength(1);
  });

  it("adopts across a change the recorded outputs still fit, and says the state changed", async () => {
    const product = await ran("feat/product", { issue: "x" });
    writeWorkflowFiles(read((p) => p.paths.workflowsDir), files({ type: "string", maxLength: 80 }));
    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "a" }, fake: RULES as unknown as JsonValue });
    expect(plan(result).adopted[0]).toMatchObject({ stateChanged: true });
    const parent = (result as { taskId: string }).taskId;
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(outputsOf(parent)).toEqual({ shipped: "shipped" });
  });

  it("refuses a HOLE — a child before the cursor that something later reads — naming the reference", async () => {
    const ux = await ran("feat/ux", { brief: "b", audience: "devs" });
    const result = await service.adoptTask({ taskId: ux, workflow: "reads", inputs: { issue: "x" }, dryRun: true });
    expect(refusal(result)).toMatchObject({ code: "hole", reference: "outputs.brief → children.product" });

    // Unread by anything later is no hole: `feat` reads `build` alone, so ux may stand without product.
    expect(plan(await service.adoptTask({ taskId: ux, workflow: "feat", inputs: { issue: "x" }, dryRun: true }))).toMatchObject({ cursor: "ux", next: "build", inputs: { audience: "devs", issue: "x" } });

    // And adopted is no hole either: product and ux together.
    const product = await ran("feat/product", { issue: "x" });
    const both = await service.adoptTask({ taskId: ux, workflow: "reads", also: [{ taskId: product }], fake: RULES as unknown as JsonValue });
    expect(plan(both)).toMatchObject({ cursor: "ux", inputs: { issue: "x", audience: "devs" } });
    expect(plan(both).next).toBeUndefined();
    const parent = (both as { taskId: string }).taskId;
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    // Nothing was left to run; the root's own output read the adopted product.
    expect(dispatched(parent)).toBe(0);
    expect(outputsOf(parent)).toEqual({ brief: "the brief" });
  });
});

describe("a rewind past the mirror row", () => {
  it("un-adopts: the task is its own again, and the parent runs the child itself", async () => {
    const product = await ran("feat/product", { issue: "x" });
    const result = await service.adoptTask({ taskId: product, workflow: "feat", inputs: { audience: "a" }, fake: RULES as unknown as JsonValue });
    const parent = (result as { taskId: string }).taskId;
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    const mirror = journal(parent).find((row) => row.event.type === "instance.entered" && row.event.instanceId === product)!;

    // Rewinding to a LATER point keeps the adoption.
    const uxEntry = journal(parent).find((row) => row.event.type === "instance.entered" && row.event.childKey === "ux")!;
    await service.rewindTask({ taskId: parent, at: uxEntry.seq, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the rewound parent to complete");
    expect(metaOf(product).origin?.kind).toBe("adopt");

    await service.rewindTask({ taskId: parent, at: mirror.seq, fake: RULES as unknown as JsonValue });
    const freed = metaOf(product);
    expect(freed.origin).toBeUndefined();
    expect(freed.parentTaskId).toBeUndefined();
    await until(() => statusOf(parent) === "completed", "the un-adopted parent to complete");
    // product, ux and build — all the parent's own this time.
    expect(dispatched(parent)).toBe(3);
    expect(events(parent).some((e) => e.type === "instance.entered" && e.instanceId === product)).toBe(false);
    expect(service.boardRoots().columns.flatMap((c) => c.cards.map((card) => card.taskId)).sort()).toEqual([parent, product].sort());
  });
});

describe("a back-transition into an adopted child", () => {
  /** Answer the gate now parked, and say which state's it was. */
  async function answerGate(): Promise<string> {
    await until(() => service.pendingInteractions().length === 1, "a gate");
    const gate = service.pendingInteractions()[0]!;
    service.submitInteraction(gate.requestId, { confirmed: true });
    await until(() => !service.pendingInteractions().some((p) => p.requestId === gate.requestId), "the gate to clear");
    return String((gate.inputs as { prompt?: string }).prompt);
  }

  it("runs it in the parent as occurrence 1, and leaves the adopted task as occurrence 0's history", async () => {
    const { taskId: a } = service.createTask({ title: "A", workflow: "loop/a" });
    await service.startTask({ taskId: a });
    expect(await answerGate()).toBe("a?");
    await until(() => statusOf(a) === "completed", "a to complete");

    const result = await service.adoptTask({ taskId: a, workflow: "loop" });
    const parent = (result as { taskId: string }).taskId;
    // Past `a`: the parent's first question is b's.
    expect(await answerGate()).toBe("b?");
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    // A person sends the finished parent back to `a`, handing it a note.
    expect(await service.moveTask({ taskId: parent, toState: "a", inputs: { note: "again" } })).toEqual({ taskId: parent, status: "reopened" });
    expect(await answerGate()).toBe("a?");
    expect(await answerGate()).toBe("b?");
    await until(() => statusOf(parent) === "completed", "the reopened parent to complete");

    const again = service.taskDetail(parent).instances[0]!.children.filter((c) => c.childKey === "a");
    expect(again.map((c) => [c.instanceId === a, c.address?.at(-1)?.occurrence])).toEqual([[true, 0], [false, 1]]);
    // What the move handed over was ASKED of a person; the adopted task is untouched.
    expect(again[1]!.inputs).toEqual({ note: "again" });
    expect(again[1]!.inputProvenance).toEqual({ note: { via: "asked" } });
    expect(metaOf(a).origin).toMatchObject({ kind: "adopt", taskId: parent });
    expect(dispatched(a)).toBe(1);
  });
});

describe("adopting INTO a task that exists", () => {
  it("takes a task up into a parent that has not run, under the child key named, and makes no new task", async () => {
    const product = await ran("feat/product", { issue: "x" }, "Product");
    const { taskId: parent } = service.createTask({ title: "The feature", workflow: "feat", inputs: { issue: "x", audience: "devs" } });
    const before = service.listTasks().length;

    const would = plan(await service.adoptTask({ taskId: product, parentTaskId: parent, childKey: "product", dryRun: true }));
    expect(would).toMatchObject({ parentTaskId: parent, workflow: "feat", title: "The feature", cursor: "product", next: "ux", inputs: { issue: "x", audience: "devs" } });
    expect(events(parent)).toEqual([]);

    const result = await service.adoptTask({ taskId: product, parentTaskId: parent, childKey: "product", fake: RULES as unknown as JsonValue });
    expect(result).toMatchObject({ ok: true, taskId: parent, started: true });
    expect(service.listTasks()).toHaveLength(before);
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(entered(parent)).toEqual(["product", "ux", "build"]);
    expect(dispatched(parent)).toBe(2);
    expect(outputsOf(parent)).toEqual({ shipped: "shipped" });
    // What the parent was created with stays as it was settled: typed into a form.
    expect(metaOf(parent).inputProvenance).toEqual({ issue: { via: "asked" }, audience: { via: "asked" } });
    expect(metaOf(product).origin).toMatchObject({ kind: "adopt", taskId: parent, key: "product" });
  });

  it("refuses a parent whose own input disagrees with what the child ran with", async () => {
    const product = await ran("feat/product", { issue: "x" }, "Product");
    const { taskId: parent } = service.createTask({ title: "Another", workflow: "feat", inputs: { issue: "something else", audience: "devs" } });
    const result = await service.adoptTask({ taskId: product, parentTaskId: parent, dryRun: true });
    expect(refusal(result)).toMatchObject({ code: "inputs-conflict" });
    expect(refusal(result).message).toContain("'issue'");
  });

  it("refuses a parent that is running or has entered the child, and takes a later child into one that stopped before it", async () => {
    const a = service.createTask({ title: "A", workflow: "loop/a" }).taskId;
    await service.startTask({ taskId: a });
    await until(() => service.pendingInteractions().length === 1, "a's gate");
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    await until(() => statusOf(a) === "completed", "a to complete");
    const b = service.createTask({ title: "B", workflow: "loop/b" }).taskId;
    await service.startTask({ taskId: b });
    await until(() => service.pendingInteractions().length === 1, "b's gate");
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    await until(() => statusOf(b) === "completed", "b to complete");

    const { taskId: parent } = service.createTask({ title: "Loop", workflow: "loop" });
    await service.startTask({ taskId: parent });
    await until(() => service.pendingInteractions().length === 1, "the parent's first gate");
    expect(refusal(await service.adoptTask({ taskId: b, parentTaskId: parent }))).toMatchObject({ code: "parent-state" });

    service.cancelTask(parent);
    await until(() => statusOf(parent) === "canceled", "the stop to settle");
    const over = refusal(await service.adoptTask({ taskId: a, parentTaskId: parent }));
    expect(over).toMatchObject({ code: "parent-state" });
    expect(over.message).toContain("already entered 'a'");

    // `b` it has not reached: the mirror rows go under the root it already entered, and it carries on past them.
    const result = await service.adoptTask({ taskId: b, parentTaskId: parent });
    expect(result).toMatchObject({ ok: true, taskId: parent, started: true });
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(events(parent).filter((e) => e.type === "instance.entered" && e.parentInstanceId === undefined)).toHaveLength(1);
    expect(entered(parent)).toEqual(["a", "b"]);
    // Nobody was asked b's question a second time.
    expect(service.pendingInteractions()).toEqual([]);
  });
});

describe("a named session across an adoption", () => {
  /** A task's names and the session each is an alias to. */
  const names = (taskId: string): Record<string, string> =>
    Object.fromEntries(read((p) => p.db.prepare(`SELECT name, session_id FROM session_names WHERE task_id = ? AND name NOT LIKE '#%'`).all(taskId) as Array<{ name: string; session_id: string }>).map((row) => [row.name, row.session_id]));
  /** Where a task's records sit: `[session, seat]` in the order they started. */
  const seats = (taskId: string): Array<[string, number]> =>
    read((p) => p.db.prepare(`SELECT COALESCE(landed_session_id, session_id) AS sid, COALESCE(landed_seq, session_seq) AS seat FROM operation_records WHERE task_id = ? ORDER BY started_at, rowid`).all(taskId) as Array<{ sid: string; seat: number }>).map((row) => [row.sid, row.seat]);

  it("stays the named session: global stays global, one scoped to the child moves under it — and the parent CONTINUES the conversation the adopted task began", async () => {
    const product = await ran("sess/product", {}, "Product");
    // Run alone, product is the root: `global` and `sess/product` both anchor at `/`.
    const own = names(product);
    expect(Object.keys(own).sort()).toEqual(["loop#/", "notes#/"]);

    const result = await service.adoptTask({ taskId: product, workflow: "sess", start: false });
    const parent = (result as { taskId: string }).taskId;
    // In the parent the same declarations resolve under its root: `notes` is still the root's, `loop` is the child's.
    expect(names(parent)).toEqual({ "notes#/": own["notes#/"], "loop#product": own["loop#/"] });

    await service.resumeTask({ taskId: parent, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(outputsOf(parent)).toEqual({ plan: "planned" });
    // ux ran in the parent, in the adopted task's `notes` conversation, on the seat after its note.
    const noteSeat = seats(product).find(([sid]) => sid === own["notes#/"])!;
    expect(seats(parent)).toEqual([[own["notes#/"], noteSeat[1] + 1]]);
    // …and a model reading that conversation reads the note first, then what ux said.
    const said = read((p) => sessionStoreFor(p, { taskId: parent }).messages("notes#/")) as Array<{ role: string }>;
    const product_said = read((p) => sessionStoreFor(p, { taskId: product }).messages(`${own["notes#/"]}@${noteSeat[1] + 1}`));
    expect(said.length).toBeGreaterThan(product_said.length);
    expect(said.slice(0, product_said.length)).toEqual(product_said);

    // A FORK of the parent keeps the whole conversation: a branch of the adopted task's, not a copy
    // that would begin at ux with the note missing.
    const end = read((p) => {
      const rows = p.events.list(parent);
      const root = rows.find((row) => row.event.type === "instance.entered" && row.event.parentInstanceId === undefined)!.instanceId;
      return rows.find((row) => row.type === "instance.terminated" && row.instanceId === root)!.seq;
    });
    const copy = read((p) => forkTask(p, parent, end, { standing: "asIs" }).taskId);
    const copied = read((p) => sessionStoreFor(p, { taskId: copy }).messages("notes#/"));
    expect(copied).toEqual(said);
    expect(names(copy)["notes#/"]).not.toBe(own["notes#/"]);
  });

  it("stops being the parent's when the adoption is taken back — a parent that runs the child itself starts it fresh", async () => {
    const product = await ran("sess/product", {}, "Product");
    const own = names(product);
    const result = await service.adoptTask({ taskId: product, workflow: "sess", start: false });
    const parent = (result as { taskId: string }).taskId;
    const mirror = journal(parent).find((row) => row.type === "instance.entered" && row.instanceId === product)!;
    await service.rewindTask({ taskId: parent, at: mirror.seq, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the parent to run product itself");
    const now = names(parent);
    expect(Object.values(now)).not.toContain(own["notes#/"]);
    expect(Object.values(now)).not.toContain(own["loop#/"]);
    // Its own product used its own conversations, under the keys the parent gives them.
    expect(Object.keys(now).sort()).toEqual(["loop#product", "notes#/"]);
  });
});

describe("the split shape", () => {
  it("adopts an element as a task standing past the split, on the list at its element, and makes no copies", async () => {
    const items = [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }];
    const beta = await ran("batch/work", { item: items[1]! }, "Beta");

    const would = plan(await service.adoptTask({ taskId: beta, workflow: "batch", dryRun: true }));
    // The list is the parent's own input, and with nothing else saying what it is, it is the task's
    // own element alone (2026-09-22) — a split over one element is no split.
    expect(would.asks).toEqual([]);
    expect(would.inputs).toEqual({ items: [items[1]] });
    expect(would.provenance).toEqual({ items: { via: "bound", from: { taskId: beta, input: "item" } } });
    expect(would.adopted[0]).toMatchObject({ shape: "split", childKey: "work", index: 0 });

    expect(refusal(await service.adoptTask({ taskId: beta, workflow: "batch", inputs: { items: [items[0]!] }, dryRun: true }))).toMatchObject({ code: "split-element" });

    const result = await service.adoptTask({ taskId: beta, workflow: "batch", inputs: { items }, fake: RULES as unknown as JsonValue });
    expect(plan(result).adopted[0]).toMatchObject({ shape: "split", index: 1 });
    const parent = (result as { taskId: string }).taskId;
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    expect(metaOf(parent).split).toEqual([{ expr: ".inputs.items", index: 1 }]);
    expect(metaOf(beta).origin).toMatchObject({ kind: "adopt", key: "work", index: 1 });
    // `finish` read Beta's doc as an ordinary mount's output, and nothing fanned out.
    expect(entered(parent)).toEqual(["work", "finish"]);
    expect(dispatched(parent)).toBe(1);
    expect(outputsOf(parent)).toEqual({ final: "done" });
    expect(service.listTasks()).toHaveLength(2);
  });
});

describe("adopting a task that is still running", () => {
  it("mirrors its entry now, holds the parent, and writes the end — and starts the parent — when it completes", async () => {
    const { taskId: ask } = service.createTask({ title: "Ask", workflow: "gated/ask" });
    await service.startTask({ taskId: ask, fake: RULES as unknown as JsonValue });
    await until(() => service.pendingInteractions().length === 1, "the gate");

    const result = await service.adoptTask({ taskId: ask, workflow: "gated" });
    expect(result).toMatchObject({ ok: true, started: false });
    expect(plan(result)).toMatchObject({ adopted: [{ taskId: ask, pending: true }], waitsFor: [ask] });
    const parent = (result as { taskId: string }).taskId;

    // Entered, not ended; holding, and refused a start for it.
    expect(events(parent).map((e) => e.type)).toEqual(["instance.entered", "instance.entered"]);
    expect(service.taskDetail(parent).waitingFor?.map((h) => h.taskId)).toEqual([ask]);
    await expect(service.resumeTask({ taskId: parent })).rejects.toThrow(/waiting for|not completed/);
    expect(service.resumable(parent)).toMatchObject({ kind: "none" });

    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    await until(() => statusOf(ask) === "completed", "the adopted task to complete");
    await until(() => statusOf(parent) === "completed", "the released parent to complete");

    expect(events(parent)[2]).toMatchObject({ type: "instance.terminated", instanceId: ask, outcome: "success", outputs: { confirmed: true } });
    expect(outputsOf(parent)).toEqual({ done: "after the gate" });
    // The gate was asked once, by the task that was adopted.
    expect(dispatched(parent)).toBe(1);
  });
});

describe("New task: an input taken from a task", () => {
  it("offers the outputs that fit the slot, resolves the pick at creation, and records where it came from", async () => {
    const product = await ran("feat/product", { issue: "x" }, "Product");
    const sources = service.inputSources({ slots: [{ key: "brief", schema: { type: "string" } }, { key: "count", schema: { type: "number" } }] });
    expect(sources["brief"]).toEqual([{ taskId: product, title: "Product", status: "completed", workflow: "feat/product", output: "brief", preview: "the brief", pending: false }]);
    expect(sources["count"]).toEqual([]);

    const { taskId } = service.createTask({ title: "UX", workflow: "feat/ux", inputs: { audience: "devs" }, sources: { brief: { taskId: product, output: "brief" } } });
    expect(metaOf(taskId)).toMatchObject({
      inputs: { audience: "devs", brief: "the brief" },
      inputProvenance: { audience: { via: "asked" }, brief: { via: "bound", from: { taskId: product, output: "brief" } } },
    });
    expect(metaOf(taskId).dependsOn).toBeUndefined();
    await service.startTask({ taskId, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(taskId) === "completed", "the task to complete");
    expect(service.taskDetail(taskId).instances[0]!.inputProvenance).toMatchObject({ brief: { via: "bound", from: { taskId: product } }, audience: { via: "asked" } });
  });

  it("holds for a source still running, and reads the value when it starts", async () => {
    const { taskId: ask } = service.createTask({ title: "Ask", workflow: "gated/ask" });
    await service.startTask({ taskId: ask, fake: RULES as unknown as JsonValue });
    await until(() => service.pendingInteractions().length === 1, "the gate");

    // Nothing to validate yet, so the DECLARED output is what fits the slot.
    const sources = service.inputSources({ slots: [{ key: "confirmed", schema: { type: "boolean" } }] });
    expect(sources["confirmed"]).toMatchObject([{ taskId: ask, output: "confirmed", pending: true }]);

    const { taskId } = service.createTask({ title: "After", workflow: "gated/after", sources: { confirmed: { taskId: ask, output: "confirmed" } } });
    expect(metaOf(taskId)).toMatchObject({ dependsOn: [ask], inputProvenance: { confirmed: { via: "bound", from: { taskId: ask, output: "confirmed" } } } });
    expect(metaOf(taskId).inputs ?? {}).toEqual({});
    await expect(service.startTask({ taskId })).rejects.toThrow(/waiting for 'Ask'/);

    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    // Released the ordinary way, by its dependency completing.
    await until(() => statusOf(taskId) === "completed", "the held task to complete");
    expect(metaOf(taskId).inputs).toEqual({ confirmed: true });
    expect(outputsOf(taskId)).toEqual({ done: "after the gate" });
  });
});
