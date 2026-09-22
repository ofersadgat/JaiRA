/**
 * `connect(task, target)`, end to end (decision 0005 §1, step 5): a task is sent to a state, and the
 * host finds — or makes — the workflow that relates the two.
 *
 * One operation (`AppService.connectTask`, the `task:connect` channel), three resolutions, each
 * pinned here with the journal rows that make it real:
 *
 *  1. **move** — the target is in the task's own workflow: backward, to the very next state, forward
 *     by fast-forward or with `skip` (the fast-forward itself is `fastForward.test.ts`'s), and DOWN
 *     into a nested composite;
 *  2. **adopt** — a real workflow holds both: a new task of it adopts the task, and stands where the
 *     target is; two such workflows are returned as candidates, never chosen between;
 *  3. **modify** — nothing relates them: a finished task is wrapped in a NEW document and adopted
 *     into it, a task already in a document has it AUGMENTED, a task inside a real workflow has its
 *     copy CLONED.
 *
 * Around them: the DRY RUN that says all of it and changes nothing, every refusal with its message,
 * and UNDO for each kind.
 *
 * Every state is a gate, as in `taskMove.test.ts`: a parked gate is a state unmistakably entered, its
 * inputs are on the request, and which gates were offered is the assertion that matters — a state
 * stepped over is one whose gate nobody was shown.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { createWorkflowTools, writeWorkflowFiles } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import type { TaskConnectResult } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
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
    // Rule 1: a spine of four, and a composite nested in a spine.
    flow: { label: "Flow", children: { a: { state: "flow/a" }, b: { state: "flow/b" }, c: { state: "flow/c" }, d: { state: "flow/d" } }, sequence: ["a", "b", "c", "d"] },
    "flow/a": gate("a"),
    "flow/b": gate("b"),
    "flow/c": gate("c"),
    "flow/d": gate("d"),
    deep: { label: "Deep", children: { one: { state: "deep/one" }, two: { state: "deep/two" } }, sequence: ["one", "two"] },
    "deep/one": gate("one"),
    "deep/two": { label: "Two", children: { x: { state: "deep/two/x" }, y: { state: "deep/two/y" }, z: { state: "deep/two/z" } }, sequence: ["x", "y", "z"] },
    "deep/two/x": gate("x"),
    "deep/two/y": gate("y"),
    "deep/two/z": gate("z"),
    // Rule 2: a workflow that mounts a phase somebody ran alone. `build` reads `product`, so it can
    // be reached past `ux`; `ship` reads `ux`, so it cannot.
    feat: {
      label: "Feature",
      children: {
        product: { state: "feat/product" },
        ux: { state: "feat/ux", inputs: { flag: ".children.product.output.confirmed" } },
        build: { state: "feat/build", inputs: { flag: ".children.product.output.confirmed" } },
        ship: { state: "feat/ship", inputs: { flag: ".children.ux.output.confirmed" } },
      },
      sequence: ["product", "ux", "build", "ship"],
    },
    "feat/product": gate("product"),
    "feat/ux": gate("ux", flag),
    "feat/build": gate("build", flag),
    "feat/ship": gate("ship", flag),
    // A SECOND workflow holding `product` and `ux`: a target of `feat/ux` is ambiguous.
    other: { label: "Other", children: { product: { state: "feat/product" }, ux: { state: "feat/ux", inputs: { flag: ".children.product.output.confirmed" } } }, sequence: ["product", "ux"] },
    // Rule 3: states no workflow relates to anything.
    // The conversation a move makes. A PROMPT with a required opening line and no outputs, which is
    // the shape `chat/control` ships as — and the shape the idle rule is about (decision 0005 step 6):
    // a root loaded with an operation it never ran would otherwise dispatch it, and a drop would
    // spend a model call on a message nobody sent.
    "conv/standin": {
      label: "Talk",
      inputs: { opening: { schema: { type: "string" }, description: "What the person did, in a sentence." } },
      // No model, as the shipped conversations declare none: the machine it runs on answers.
      operation: { kind: "prompt", prompt: "{{.inputs.opening}}" },
    },
    "lib/second": gate("second", flag),
    "lib/third": gate("third", flag),
    "lib/needs": gate("needs", { text: { schema: { type: "string", minLength: 3 }, description: "What to call it." } }),
  };
}

let dir: string;
let service: AppService;
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-connect-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  seen.clear();
  service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
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

const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId));

/** Wait for the next gate and leave it parked; says which state's it is and what that state was handed. */
async function parked(): Promise<{ state: string; inputs: Record<string, unknown>; requestId: string }> {
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  return { state: String((gate.inputs as { prompt?: string }).prompt ?? "").replace("?", ""), inputs: gate.inputs as Record<string, unknown>, requestId: gate.requestId };
}

async function answer(): Promise<string> {
  const gate = await parked();
  service.submitInteraction(gate.requestId, { confirmed: true });
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
const taskIds = (): string[] => read((p) => p.tasks.list().map((t) => t.id).sort());
const documents = (): string[] => {
  const at = join(dir, ".jaira", "system", "snapshots", "_documents");
  return existsSync(at) ? readdirSync(at).sort() : [];
};

/** `[child key, outcome]` for every ended instance, in journal order. */
function ended(taskId: string): Array<[string, string]> {
  const events = journal(taskId);
  const keyOf = new Map<string, string>();
  for (const e of events) if (e.type === "instance.entered") keyOf.set(e.instanceId, e.childKey ?? "(root)");
  return events.filter((e): e is Extract<EngineEvent, { type: "instance.terminated" }> => e.type === "instance.terminated").map((e) => [keyOf.get(e.instanceId) ?? "?", e.outcome]);
}

/** A task that ran `workflow` alone and finished, every gate confirmed. */
async function ran(workflow: string, gates: number): Promise<string> {
  const { taskId } = service.createTask({ title: `Ran ${workflow}`, workflow });
  await service.startTask({ taskId });
  for (let i = 0; i < gates; i += 1) await answer();
  await until(() => statusOf(taskId) === "completed", `${workflow} to complete`);
  return taskId;
}

/** A task parked in `flow`, having confirmed `through` gates. */
async function standingIn(workflow: string, through: number): Promise<string> {
  const { taskId } = service.createTask({ title: `In ${workflow}`, workflow });
  await service.startTask({ taskId });
  for (let i = 0; i < through; i += 1) await answer();
  await parked();
  return taskId;
}

const ok = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: true }> => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result;
};
const no = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: false }> => {
  if (result.ok) throw new Error("expected a refusal");
  return result;
};

describe("rule 1 — the target is in the task's workflow", () => {
  it("moves BACKWARD as the workflow's own machinery does, and needs no skip", async () => {
    const taskId = await standingIn("flow", 2); // parked at c
    const dry = ok(await service.connectTask({ taskId, target: "flow/a", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "move", workflow: "flow", standsAt: { path: ["a"], stateId: "flow/a" }, move: { direction: "backward", to: "a", passes: [] } });

    const done = ok(await service.connectTask({ taskId, target: "flow/a" }));
    expect(done.moved).toBe("held");
    // Held until the state it stands in ends; then `a` again, as the next occurrence.
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    expect((await parked()).state).toBe("a");
    expect(journal(taskId).filter((e) => e.type === "transition.taken")).toMatchObject([{ to: "a", by: "person" }]);
  });

  it("goes to the very NEXT state without skip, FAST-FORWARDS over states by default, and steps over them with skip", async () => {
    const taskId = await standingIn("flow", 0); // parked at a
    expect(ok(await service.connectTask({ taskId, target: "flow/b", dryRun: true })).plan.move).toMatchObject({ direction: "next", passes: [] });

    // Forward past states is a FAST-FORWARD (decision 0005 §4, step 7). This task is RUNNING and
    // nothing speaks at its root: there is no conversation to answer on the way, and a running engine
    // cannot pick one up. The dry run says so — a hover must not promise a drop that will be refused —
    // and the real thing is refused the same way, having done nothing.
    const message = "'In flow' is running and has no conversation to answer what comes up on the way — pause it, then move it, or say skip to go there directly";
    const dry = no(await service.connectTask({ taskId, target: "flow/d", dryRun: true }));
    expect(dry.refusal).toEqual({ code: "fast-forward", message });
    expect(dry.plan).toMatchObject({ resolution: "move", forward: "fast-forward", move: { direction: "forward", passes: ["b", "c"] } });
    expect(no(await service.connectTask({ taskId, target: "flow/d" })).refusal).toEqual({ code: "fast-forward", message });
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
    expect(documents()).toEqual([]);

    const done = ok(await service.connectTask({ taskId, target: "flow/d", forward: "skip" }));
    expect(done.moved).toBe("taking");
    expect((await parked()).state).toBe("d");
    expect(ended(taskId)).toEqual([
      ["a", "skipped"],
      ["b", "skipped"],
      ["c", "skipped"],
    ]);
  });

  it("enters the ANCESTORS of a nested target on the way down, and goes straight to it", async () => {
    const taskId = await standingIn("deep", 0); // parked at one
    // Running with no conversation, it cannot be fast-forwarded — but the plan still says the way down.
    const dry = no(await service.connectTask({ taskId, target: "deep/two/y", dryRun: true }));
    // `x` comes before `y` inside the composite: stepping over it is a skip like any other.
    expect(dry.plan?.move).toMatchObject({ direction: "forward", to: "two", path: ["y"], passes: ["two/x"] });

    ok(await service.connectTask({ taskId, target: "deep/two/y", skip: true }));
    expect((await parked()).state).toBe("y");
    expect(ended(taskId)).toEqual([
      ["one", "skipped"],
      ["x", "skipped"],
    ]);
    // Standing IN the composite now, a sibling of it is a move of the composite's own instance.
    const within = ok(await service.connectTask({ taskId, target: "deep/two/x", dryRun: true }));
    expect(within.plan.move).toMatchObject({ direction: "backward", to: "x", path: [] });
    expect(within.plan.move?.instanceId).toBeDefined();
  });

  it("refuses a task that has never run, a task already there, and an unknown task — each saying so", async () => {
    const { taskId } = service.createTask({ title: "Queued", workflow: "flow" });
    expect(no(await service.connectTask({ taskId, target: "flow/b" })).refusal).toMatchObject({ code: "never-run", message: "'Queued' has never run, so it stands nowhere to be moved from — start it instead" });
    expect(no(await service.connectTask({ taskId, target: "flow" })).refusal).toMatchObject({ code: "already-there", message: "'Queued' already runs 'flow'" });
    expect(no(await service.connectTask({ taskId: "t-nope", target: "flow" })).refusal).toMatchObject({ code: "unknown-task", message: "unknown task 't-nope'" });
  });
});

describe("rule 2 — a real workflow holds both", () => {
  it("adopts into the workflow a card was dropped ON, standing at what comes next — and the dry run changes nothing", async () => {
    const product = await ran("feat/product", 1);
    const before = taskIds();
    const dry = ok(await service.connectTask({ taskId: product, target: "feat", dryRun: true }));
    expect(dry.plan).toMatchObject({
      resolution: "adopt",
      workflow: "feat",
      workflowLabel: "Feature",
      adoptedAs: "product",
      standsAt: { path: ["ux"], stateId: "feat/ux" },
      inputs: [{ name: "flag", via: "wire", from: "product" }],
      asks: [],
    });
    expect(dry.plan.move).toBeUndefined();
    expect(dry.taskId).toBeUndefined();
    expect(taskIds()).toEqual(before);
    expect(metaOf(product)?.origin).toBeUndefined();

    // The drop: `start: false` leaves the new task queued, standing past the child it adopted.
    const done = ok(await service.connectTask({ taskId: product, target: "feat", start: false }));
    const parent = done.taskId!;
    expect(statusOf(parent)).toBe("queued");
    expect(metaOf(product)?.origin).toMatchObject({ kind: "adopt", taskId: parent, key: "product" });
    expect(done.undo).toEqual({ kind: "adopt", parentTaskId: parent, adoptedTaskId: product, made: true });
    // Started, it runs only what is left, with the wire reading the adopted task's output.
    await service.resumeTask({ taskId: parent });
    const ux = await parked();
    expect(ux).toMatchObject({ state: "ux", inputs: { flag: true } });
  });

  it("reaches a target past the next state only by skip, and refuses one whose binding reads what was skipped", async () => {
    const product = await ran("feat/product", 1);
    // Without skip it is a fast-forward — the plan says so, and runs `ux` on the way.
    const over = ok(await service.connectTask({ taskId: product, target: "feat/build", dryRun: true }));
    expect(over.plan).toMatchObject({ resolution: "adopt", forward: "fast-forward", move: { direction: "forward", to: "build", passes: ["ux"] } });

    // `ship` reads `ux`, which a skip steps over: the input would not bind, and the refusal says which, with its schema.
    const unbound = no(await service.connectTask({ taskId: product, target: "feat/ship", skip: true }));
    expect(unbound.refusal.code).toBe("inputs-missing");
    expect(unbound.refusal.missing).toEqual([
      { state: "feat/ship", name: "flag", schema: BOOLEAN, description: "Whether the step before was confirmed.", reason: "its binding reads 'ux', which has not run" },
    ]);
    expect(unbound.refusal.message).toBe(
      `adopting 'Ran feat/product' into 'feat' leaves required inputs unbound: 'flag' of 'feat/ship' ({"type":"boolean"}) — its binding reads 'ux', which has not run`,
    );
    expect(metaOf(product)?.origin).toBeUndefined();

    const done = ok(await service.connectTask({ taskId: product, target: "feat/build", skip: true }));
    expect(done.moved).toBe("reopened");
    const build = await parked();
    expect(build).toMatchObject({ state: "build", inputs: { flag: true } });
    expect(ended(done.taskId!)).toContainEqual(["ux", "skipped"]);
  });

  it("returns the CANDIDATES when more than one workflow holds both, and takes the one then named", async () => {
    const product = await ran("feat/product", 1);
    const ambiguous = no(await service.connectTask({ taskId: product, target: "feat/ux", dryRun: true }));
    expect(ambiguous.refusal.code).toBe("ambiguous-workflow");
    expect(ambiguous.refusal.message).toBe("'feat' and 'other' each hold both 'feat/product' and 'feat/ux' — say which workflow 'Ran feat/product' joins");
    expect(ambiguous.refusal.candidates).toEqual([
      { workflow: "feat", label: "Feature", childKey: "product", targetKey: "ux" },
      { workflow: "other", label: "Other", childKey: "product", targetKey: "ux" },
    ]);
    // Nothing is guessed by the real thing either.
    expect(no(await service.connectTask({ taskId: product, target: "feat/ux" })).refusal.code).toBe("ambiguous-workflow");

    const named = ok(await service.connectTask({ taskId: product, target: "feat/ux", workflow: "other", start: false }));
    expect(named.plan).toMatchObject({ resolution: "adopt", workflow: "other", standsAt: { path: ["ux"] } });
    expect(metaOf(named.taskId!)?.workflow).toBe("other");
  });

  it("UNDO un-adopts and removes the task the connect made; the adopted task is its own again", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "feat", start: false }));
    const parent = done.taskId!;
    const back = await service.undoConnect({ undo: done.undo! });
    expect(back).toEqual({ taskId: product, removed: parent });
    expect(metaOf(parent)).toBeUndefined();
    const freed = metaOf(product)!;
    expect(freed.origin).toBeUndefined();
    expect(freed.parentTaskId).toBeUndefined();
    expect(statusOf(product)).toBe("completed");
    // …and can be connected again.
    expect(ok(await service.connectTask({ taskId: product, target: "feat", dryRun: true })).plan.resolution).toBe("adopt");
  });

  it("UNDO keeps a parent that has run something of its own, and only un-adopts", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "feat" }));
    const parent = done.taskId!;
    expect(await answer()).toBe("ux");
    await parked(); // build
    // Running: refused, with the reason.
    await expect(service.undoConnect({ undo: done.undo! })).rejects.toThrow(/is running — stop it before taking the move back/);
    await service.cancelTask(parent);
    await until(() => statusOf(parent) === "canceled", "the parent to stop");
    const back = await service.undoConnect({ undo: done.undo! });
    expect(back).toEqual({ taskId: product });
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(metaOf(parent)).toBeDefined();
    expect(journal(parent).some((e) => e.type === "instance.entered" && e.instanceId === product)).toBe(false);
  });
});

describe("rule 3 — the workflow is modified", () => {
  it("NEW: wraps a finished task in a document, adopts it as the first child, and takes the move — the wire made by schema fit", async () => {
    const product = await ran("feat/product", 1);
    const before = { tasks: taskIds(), documents: documents() };
    const dry = ok(await service.connectTask({ taskId: product, target: "lib/second", dryRun: true }));
    expect(dry.plan).toMatchObject({
      resolution: "modify",
      modification: "new",
      adoptedAs: "product",
      mount: "plain",
      standsAt: { path: ["second"], stateId: "lib/second" },
      inputs: [{ name: "flag", via: "wire", from: "product.confirmed" }],
    });
    expect({ tasks: taskIds(), documents: documents() }).toEqual(before);

    const done = ok(await service.connectTask({ taskId: product, target: "lib/second" }));
    const parent = done.taskId!;
    expect(parent).not.toBe(product);
    expect(documents()).toHaveLength(1);
    expect(metaOf(product)?.origin).toMatchObject({ kind: "adopt", taskId: parent, key: "product" });
    expect(done.plan.adopt?.adopted).toMatchObject([{ taskId: product, childKey: "product" }]);
    // The conversation that controls it STARTS IDLE (step 6): the drop dispatches no model call at
    // all, and the run goes straight to the state the person asked for.
    expect(await parked()).toMatchObject({ state: "second", inputs: { flag: true } });
    expect(journal(parent).filter((e) => e.type === "operation.started" && e.op === "prompt")).toEqual([]);
    expect(journal(parent).filter((e) => e.type === "transition.taken")).toMatchObject([{ to: "second", by: "person" }]);

    // AUGMENTED: the task already stands in a document, which gains a child — never a wrapper.
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    await until(() => statusOf(parent) === "completed", "the document's task to complete");
    const dryMore = ok(await service.connectTask({ taskId: parent, target: "lib/third", dryRun: true }));
    expect(dryMore.plan).toMatchObject({ resolution: "modify", modification: "augmented", standsAt: { path: ["third"] }, inputs: [{ name: "flag", via: "wire", from: "second.confirmed" }] });
    expect(documents()).toHaveLength(1);
    const more = ok(await service.connectTask({ taskId: parent, target: "lib/third" }));
    expect(more.taskId).toBe(parent);
    expect(await parked()).toMatchObject({ state: "third", inputs: { flag: true } });
    expect(documents()).toHaveLength(1);
    // …and a state the document already mounts is rule 1's: a move within it.
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    await until(() => statusOf(parent) === "completed", "the document's task to complete again");
    expect(ok(await service.connectTask({ taskId: parent, target: "lib/second", dryRun: true })).plan).toMatchObject({ resolution: "move", move: { direction: "aside", to: "second" } });
  });

  it("NEW is undone by un-adopting: the source is its own again, and a made task that ran something is kept", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/second" }));
    const parent = done.taskId!;
    await parked();
    await service.cancelTask(parent);
    await until(() => statusOf(parent) === "canceled", "the document's task to stop");
    const back = await service.undoConnect({ undo: done.undo! });
    // It ran `second` itself, so it is kept — only the adoption is taken back.
    expect(back).toEqual({ taskId: product });
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(metaOf(parent)).toBeDefined();
  });

  it("roots a new document in the SHIPPED conversation, opened with what happened — an input filled by schema, never by name", async () => {
    shippedLayer();
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined });
    await service.open(dir);
    const product = await ran("feat/product", 1);
    expect(ok(await service.connectTask({ taskId: product, target: "lib/second", dryRun: true })).plan.modification).toBe("new");

    const done = ok(await service.connectTask({ taskId: product, target: "lib/second" }));
    const parent = metaOf(done.taskId!)!;
    expect(read((p) => p.runtime.get(parent.id)!.documentId)).toBeDefined();
    // `chat/control` declares one required input that takes a string. It was given the sentence.
    expect(Object.values(parent.inputs ?? {})).toEqual([`"Ran feat/product" was moved to lib/second.`]);
    expect(Object.values(parent.inputProvenance ?? {})).toEqual([{ via: "bound" }]);
    // And says nothing: no model route was even configured here, which a dispatched turn would need.
    expect(await parked()).toMatchObject({ state: "second", inputs: { flag: true } });
    expect(journal(done.taskId!).filter((e) => e.type === "operation.started" && e.op === "prompt")).toEqual([]);
  });

  it("CLONED: a task standing inside a real workflow has its copy diverge — and UNDO puts it back under its pin", async () => {
    const taskId = await standingIn("flow", 1); // a confirmed, parked at b
    // Running: a new transition is picked up at the next load, so it is refused until it is paused.
    const running = no(await service.connectTask({ taskId, target: "lib/second" }));
    expect(running.refusal).toMatchObject({
      code: "running",
      message: "'In flow' is running, and no workflow relates 'flow' to 'lib/second': the move is a new transition, which a task picks up the next time it loads. Pause it, then move it",
    });
    await service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the task to stop");
    const pinned = read((p) => p.runtime.get(taskId)!);
    expect(pinned.documentId).toBeUndefined();

    const dry = ok(await service.connectTask({ taskId, target: "lib/second", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "cloned", workflow: "flow", inputs: [{ name: "flag", via: "wire", from: "a.confirmed" }] });
    expect(documents()).toEqual([]);

    const done = ok(await service.connectTask({ taskId, target: "lib/second" }));
    expect(done.taskId).toBe(taskId);
    expect(done.undo).toMatchObject({ kind: "move", taskId, pin: { snapshotHash: pinned.snapshotHash } });
    expect(await parked()).toMatchObject({ state: "second", inputs: { flag: true } });
    expect(read((p) => p.runtime.get(taskId)!.documentId)).toBeDefined();

    await service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the diverged task to stop");
    await service.undoConnect({ undo: done.undo! });
    const back = read((p) => p.runtime.get(taskId)!);
    expect(back.documentId).toBeUndefined();
    expect(back.snapshotHash).toBe(pinned.snapshotHash);
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
  });

  it("refuses a target whose required input nothing fits — saying which, with its schema — and writes nothing", async () => {
    const product = await ran("feat/product", 1);
    const before = { tasks: taskIds(), documents: documents() };
    for (const dryRun of [true, false]) {
      const refusal = no(await service.connectTask({ taskId: product, target: "lib/needs", dryRun }));
      expect(refusal.refusal.code).toBe("inputs-missing");
      expect(refusal.refusal.missing).toEqual([
        { state: "lib/needs", name: "text", schema: { type: "string", minLength: 3 }, description: "What to call it.", reason: "nothing the task produced fits it" },
      ]);
      expect(refusal.refusal.message).toBe(
        `a move of 'Ran feat/product' to 'lib/needs' leaves required inputs unbound: 'text' of 'lib/needs' ({"type":"string","minLength":3}) — nothing the task produced fits it`,
      );
      expect(refusal.plan).toMatchObject({ resolution: "modify", modification: "new" });
    }
    expect({ tasks: taskIds(), documents: documents() }).toEqual(before);
    expect(no(await service.connectTask({ taskId: product, target: "lib/nowhere" })).refusal).toMatchObject({ code: "unknown-target", message: "no state 'lib/nowhere' was found on the workflow path" });
  });
});

describe("askAfter — a drop whose target needs what nothing binds (decision 0005 §4 'Inputs')", () => {
  /** The model double: the opening turn is answered with the question, a reply with an acknowledgement. */
  const QUESTION = "What should the thing be called?";
  const fake = [
    { promptIncludes: "Ask the person", output: QUESTION },
    { output: "Thanks — starting it." },
  ] as unknown as JsonValue;
  const TEXT = { state: "lib/needs", name: "text", schema: { type: "string", minLength: 3 }, description: "What to call it.", reason: "nothing the task produced fits it" };
  /** The conversation's turns, as the Chat view reads them. */
  const thread = (taskId: string) => service.chatThread({ taskId })?.session.turns ?? [];
  const chatTurnsSettled = (taskId: string): number => journal(taskId).filter((e) => e.type === "operation.completed" && e.instanceId.startsWith("chat:")).length;

  it("says so in the dry run — no refusal, the inputs it will ask for — and writes nothing", async () => {
    const product = await ran("feat/product", 1);
    const before = { tasks: taskIds(), documents: documents() };
    const dry = ok(await service.connectTask({ taskId: product, target: "lib/needs", dryRun: true, askAfter: true }));
    expect(dry.asking).toEqual([TEXT]);
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "new" });
    expect(dry.plan.move).toBeUndefined();
    expect(dry.taskId).toBeUndefined();
    expect({ tasks: taskIds(), documents: documents() }).toEqual(before);
  });

  it("makes the document and its conversation instead of refusing, and the conversation's FIRST turn asks for exactly those inputs", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/needs", askAfter: true, start: false, fake }));
    const parent = done.taskId!;
    expect(parent).not.toBe(product);
    expect(done.asking).toEqual([TEXT]);
    expect(done.moved).toBeUndefined();
    expect(documents()).toHaveLength(1);
    expect(metaOf(product)?.origin).toMatchObject({ kind: "adopt", taskId: parent });
    // The conversation started idle: nothing of the machine ran, and the target is not mounted.
    expect(statusOf(parent)).toBe("queued");
    expect(journal(parent).some((e) => e.type === "operation.started" && !e.instanceId.startsWith("chat:"))).toBe(false);

    // Its opening turn is the question — a turn of the conversation, not of the machine.
    await until(() => chatTurnsSettled(parent) === 1, "the opening question");
    const [opening, question] = thread(parent);
    expect(question).toMatchObject({ role: "assistant", text: QUESTION });
    // What the model was handed: what happened, and each input by its declared description and
    // schema — the target's own name passed through, nothing the platform named.
    expect(opening?.text).toContain(`"Ran feat/product" was moved to lib/needs.`);
    expect(opening?.text).toContain("`text`: What to call it. — schema {\"type\":\"string\",\"minLength\":3}");
    expect(opening?.text).toContain("call `start_task` with state `lib/needs`");
    expect(service.pendingInteractions()).toEqual([]);
  });

  it("takes the person's answer: the conversation's start_task mounts the target with the value recorded ASKED", async () => {
    const product = await ran("feat/product", 1);
    const parent = ok(await service.connectTask({ taskId: product, target: "lib/needs", askAfter: true, start: false, fake })).taskId!;
    await until(() => chatTurnsSettled(parent) === 1, "the opening question");

    // The person answers in the conversation — the composer's turn, continuing the thread…
    const host = journal(parent).flatMap((e) => (e.type === "instance.entered" && e.parentInstanceId === undefined ? [e.instanceId] : []))[0]!;
    await service.sendChatMessage({ taskId: parent, instanceId: host, message: "Call it Widget.", fake });
    expect(thread(parent).map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // …and the model, having read it, calls its own start_task naming what the person answered.
    const started = (await createWorkflowTools(service.workflowHostFor(dir, parent))["start_task"]!.run({ state: "lib/needs", inputs: { text: "Widget" }, asked: ["text"] } as never, {} as never)) as Record<string, JsonValue>;
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, state: "lib/needs", inputs: [{ name: "text", via: "asked" }] });
    expect(await parked()).toMatchObject({ state: "needs", inputs: { text: "Widget" } });
    const supplied = journal(parent).find((e) => (e as { type: string }).type === "jaira.supplied") as unknown as { provenance: Record<string, { via: string }> };
    expect(supplied.provenance).toEqual({ text: { via: "asked" } });
  });

  it("is undone like any adoption — the task the drop made goes, conversation and all", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/needs", askAfter: true, start: false, fake }));
    const parent = done.taskId!;
    await until(() => chatTurnsSettled(parent) === 1, "the opening question");
    // A turn of its conversation is not work of its own: the task is removed, not kept.
    expect(await service.undoConnect({ undo: done.undo! })).toEqual({ taskId: product, removed: parent });
    expect(metaOf(parent)).toBeUndefined();
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(statusOf(product)).toBe("completed");
  });

  it("CLONED: the copy gains the conversation, which asks; UNDO cuts the turn and puts the pin back without resuming", async () => {
    const taskId = await standingIn("flow", 1);
    await service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the task to stop");
    const pinned = read((p) => p.runtime.get(taskId)!);
    const done = ok(await service.connectTask({ taskId, target: "lib/needs", askAfter: true, fake }));
    expect(done.taskId).toBe(taskId);
    expect(done.asking).toEqual([TEXT]);
    expect(read((p) => p.runtime.get(taskId)!.documentId)).toBeDefined();
    await until(() => chatTurnsSettled(taskId) === 1, "the opening question");
    expect(thread(taskId).at(-1)).toMatchObject({ role: "assistant", text: QUESTION });

    expect(done.undo).toMatchObject({ kind: "move", taskId, asking: true, pin: { snapshotHash: pinned.snapshotHash } });
    await service.undoConnect({ undo: done.undo! });
    const back = read((p) => p.runtime.get(taskId)!);
    expect(back.documentId).toBeUndefined();
    expect(back.status).toBe("canceled");
    expect(chatTurnsSettled(taskId)).toBe(0);
    expect(service.pendingInteractions()).toEqual([]);
  });

  it("leaves every OTHER refusal as it was: an unknown target, a running task, a move within a workflow", async () => {
    const product = await ran("feat/product", 1);
    expect(no(await service.connectTask({ taskId: product, target: "lib/nowhere", askAfter: true })).refusal.code).toBe("unknown-target");
    // Rule 2's missing input is still refused: only a modified workflow asks after.
    expect(no(await service.connectTask({ taskId: product, target: "feat/ship", skip: true, askAfter: true })).refusal.code).toBe("inputs-missing");
    const running = await standingIn("flow", 1);
    expect(no(await service.connectTask({ taskId: running, target: "lib/needs", askAfter: true })).refusal.code).toBe("running");
  });
});
