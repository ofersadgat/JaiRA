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
    // A spine whose root DECLARES outputs — what a finished task has on its row, and a reopening clears.
    done: {
      label: "Done",
      outputs: { a_ok: { schema: BOOLEAN, binding: ".children.a.output.confirmed" }, b_ok: { schema: BOOLEAN, binding: ".children.b.output.confirmed" } },
      children: { a: { state: "flow/a" }, b: { state: "flow/b" } },
      sequence: ["a", "b"],
    },
    deep: { label: "Deep", children: { one: { state: "deep/one" }, two: { state: "deep/two" } }, sequence: ["one", "two"] },
    "deep/one": gate("one"),
    "deep/two": { label: "Two", children: { x: { state: "deep/two/x" }, y: { state: "deep/two/y" }, z: { state: "deep/two/z" } }, sequence: ["x", "y", "z"] },
    "deep/two/x": gate("x"),
    "deep/two/y": gate("y"),
    "deep/two/z": gate("z"),
    // The same, with a composite on the way down that ASKS before its children run: its own operation
    // runs first, so a move through it waits there — the place a process can die part-way down.
    held: { label: "Held", children: { one: { state: "deep/one" }, two: { state: "held/two" } }, sequence: ["one", "two"] },
    "held/two": {
      label: "Two, asking first",
      outputs: { confirmed: { schema: BOOLEAN } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "two?" } },
      children: { x: { state: "deep/two/x" }, y: { state: "deep/two/y" }, z: { state: "deep/two/z" } },
      sequence: ["x", "y", "z"],
    },
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
  it("goes BACK as the workflow's own machinery does — at once, from a task waiting on the person, with no question asked", async () => {
    const taskId = await standingIn("flow", 2); // parked at c: waiting for the person's input
    const dry = ok(await service.connectTask({ taskId, target: "flow/a", dryRun: true }));
    expect(dry.plan).toMatchObject({
      resolution: "move",
      workflow: "flow",
      standsAt: { path: ["a"], stateId: "flow/a" },
      move: { direction: "backward", to: "a", passes: [] },
      judgement: { where: "behind", activity: "waiting-input", way: "back" },
    });
    expect(dry.plan.judgement?.confirm).toBeUndefined();

    const done = ok(await service.connectTask({ taskId, target: "flow/a" }));
    // Taken NOW — the gate it waited on is not the person's to answer first — and `a` is entered
    // again as the next occurrence, what the task did since kept in its history.
    expect(done.moved).toBe("taking");
    expect((await parked()).state).toBe("a");
    expect(journal(taskId).filter((e) => e.type === "transition.taken")).toMatchObject([{ to: "a", by: "person" }]);
    expect(ended(taskId)).toContainEqual(["c", "skipped"]);
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

describe("the way down survives a restart (decision 0005, the descent)", () => {
  it("a move to a nested target is journaled with its path, and a restart part-way down still reaches the target", async () => {
    const taskId = await standingIn("held", 0); // parked at one
    ok(await service.connectTask({ taskId, target: "deep/two/y", skip: true }));
    // The root took its step: `two` is entered, and asks before the next step can be taken.
    expect((await parked()).state).toBe("two");
    const steps = journal(taskId).filter((e): e is Extract<EngineEvent, { type: "transition.taken" }> => e.type === "transition.taken");
    expect(steps).toMatchObject([{ to: "two", by: "person", skip: true, descent: { path: ["y"] } }]);

    // The process goes away here. Nothing in memory carries the rest of the way down any more.
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
    await service.open(dir);
    seen.clear();
    // The resumed run asks `two`'s question again, and once it is answered goes straight to `y` —
    // not to `x`, which is where `two`'s own spine would have started.
    expect(await answer()).toBe("two");
    expect((await parked()).state).toBe("y");
    expect(ended(taskId)).toEqual([
      ["one", "skipped"],
      ["x", "skipped"],
    ]);
    const after = journal(taskId).filter((e): e is Extract<EngineEvent, { type: "transition.taken" }> => e.type === "transition.taken");
    expect(after.map((e) => [e.stateId, e.to])).toEqual([
      ["held", "two"],
      ["held/two", "y"],
    ]);
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
    expect(done.undo).toEqual({ kind: "adopt", parentTaskId: parent, adoptedTaskId: product, made: true, mark: expect.any(String) });
    // Started, it runs only what is left, with the wire reading the adopted task's output.
    await service.resumeTask({ taskId: parent });
    const ux = await parked();
    expect(ux).toMatchObject({ state: "ux", inputs: { flag: true } });
  });

  it("reaches a target past the next state only by skip, and ASKS for an input whose binding reads what was skipped", async () => {
    const product = await ran("feat/product", 1);
    // Without skip it is a fast-forward — the plan says so, and runs `ux` on the way.
    const over = ok(await service.connectTask({ taskId: product, target: "feat/build", dryRun: true }));
    expect(over.plan).toMatchObject({ resolution: "adopt", forward: "fast-forward", move: { direction: "forward", to: "build", passes: ["ux"] } });

    // `ship` reads `ux`, which a skip steps over: the input would not bind, so the move ASKS for it in
    // the task's own conversation — the dry run says which, with its schema — rather than refusing.
    const unbound = ok(await service.connectTask({ taskId: product, target: "feat/ship", skip: true, dryRun: true }));
    expect(unbound.plan.question).toEqual([
      { state: "feat/ship", name: "flag", schema: BOOLEAN, description: "Whether the step before was confirmed.", reason: "its binding reads 'ux', which has not run" },
    ]);
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
    const back = await service.undoConnect({ taskId: parent });
    expect(back).toEqual({ taskId: product, removed: parent });
    expect(metaOf(parent)).toBeUndefined();
    const freed = metaOf(product)!;
    expect(freed.origin).toBeUndefined();
    expect(freed.parentTaskId).toBeUndefined();
    expect(statusOf(product)).toBe("completed");
    // …and can be connected again.
    expect(ok(await service.connectTask({ taskId: product, target: "feat", dryRun: true })).plan.resolution).toBe("adopt");
  });

  it("UNDO while the parent runs where it landed stops that run — the drop's own — and takes it all back", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "feat" }));
    const parent = done.taskId!;
    expect(await parked()).toMatchObject({ state: "ux" }); // the landing, running: the drop's effect
    expect(service.listTasks().find((t) => t.taskId === parent)?.undoable).toBe(true);
    const back = await service.undoConnect({ taskId: parent });
    expect(back).toEqual({ taskId: product, removed: parent });
    expect(metaOf(parent)).toBeUndefined();
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(service.pendingInteractions()).toEqual([]);
  });

  it("UNDO is over once the parent has done work of its own — the landing settled — and a stale one is refused", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "feat" }));
    const parent = done.taskId!;
    expect(await answer()).toBe("ux"); // the state it landed in settles…
    await parked(); // …and build is entered
    expect(service.listTasks().find((t) => t.taskId === parent)?.undoable).toBeUndefined();
    await expect(service.undoConnect({ taskId: parent })).rejects.toThrow(/has moved on since the drop \(the state the drop landed in has settled\), so it can no longer be undone — rewind it/);
    // Refused plainly, and dropped: the card does not offer it again.
    expect(metaOf(parent)?.connectUndo).toBeUndefined();
    expect(metaOf(product)?.origin).toMatchObject({ kind: "adopt", taskId: parent });
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

  it("NEW is undone by un-adopting: the source is its own again, and the task the drop made goes, run and all", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "lib/second" }));
    const parent = done.taskId!;
    await parked(); // `second`, where the drop landed: what it ran is the drop's own
    const back = await service.undoConnect({ taskId: parent });
    expect(back).toEqual({ taskId: product, removed: parent });
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(metaOf(parent)).toBeUndefined();
  });

  it("a STOP is a decision: the Undo it would have taken is over", async () => {
    const product = await ran("feat/product", 1);
    const parent = ok(await service.connectTask({ taskId: product, target: "lib/second" })).taskId!;
    await parked();
    expect(metaOf(parent)?.connectUndo).toBeDefined();
    service.cancelTask(parent);
    await until(() => statusOf(parent) === "canceled", "the document's task to stop");
    expect(metaOf(parent)?.connectUndo).toBeUndefined();
    expect(service.listTasks().find((t) => t.taskId === parent)?.undoable).toBeUndefined();
    await expect(service.undoConnect({ taskId: parent })).rejects.toThrow(/has no connect to take back/);
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
    const taskId = await standingIn("flow", 1); // a confirmed, parked at b: waiting for the person
    const pinned = read((p) => p.runtime.get(taskId)!);
    expect(pinned.documentId).toBeUndefined();

    // A new transition (the move table's last row): a task only WAITING is moved without a question.
    const dry = ok(await service.connectTask({ taskId, target: "lib/second", dryRun: true }));
    expect(dry.plan).toMatchObject({
      resolution: "modify",
      modification: "cloned",
      workflow: "flow",
      inputs: [{ name: "flag", via: "wire", from: "a.confirmed" }],
      judgement: { where: "elsewhere", activity: "waiting-input", way: "move" },
    });
    expect(dry.plan.judgement?.confirm).toBeUndefined();
    expect(documents()).toEqual([]);

    // Its engine runs the version it loaded, so the move PAUSES it first — the stop a person used to
    // be told to make — and then takes the new transition.
    const done = ok(await service.connectTask({ taskId, target: "lib/second" }));
    expect(done.taskId).toBe(taskId);
    expect(done.undo).toMatchObject({ kind: "move", taskId, pin: { snapshotHash: pinned.snapshotHash } });
    expect(await parked()).toMatchObject({ state: "second", inputs: { flag: true } });
    expect(read((p) => p.runtime.get(taskId)!.documentId)).toBeDefined();

    // Still parked where it landed: Undo stops that run itself, and takes it back.
    await service.undoConnect({ taskId });
    const back = read((p) => p.runtime.get(taskId)!);
    expect(back.documentId).toBeUndefined();
    expect(back.snapshotHash).toBe(pinned.snapshotHash);
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
  });

  it("ASKS for a target's required input nothing fits — in the task's own conversation, with its schema — and moves nothing yet", async () => {
    const product = await ran("feat/product", 1);
    const before = { tasks: taskIds(), documents: documents() };
    const TEXT = { state: "lib/needs", name: "text", schema: { type: "string", minLength: 3 }, description: "What to call it.", reason: "nothing the task produced fits it" };
    const dry = ok(await service.connectTask({ taskId: product, target: "lib/needs", dryRun: true }));
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "new", question: [TEXT] });
    const asked = ok(await service.connectTask({ taskId: product, target: "lib/needs" }));
    expect(asked.asked).toMatchObject({ taskId: product, missing: [TEXT] });
    expect(asked.moved).toBeUndefined();
    expect(asked.undo).toBeUndefined();
    // Nothing moved: no document, no task, the source its own — only the question, in ITS conversation.
    expect({ tasks: taskIds(), documents: documents() }).toEqual(before);
    expect(metaOf(product)?.origin).toBeUndefined();
    expect(service.pendingInteractions()).toMatchObject([{ requestId: asked.asked!.requestId, taskId: product, component: "choose_option", moves: true }]);
    expect(no(await service.connectTask({ taskId: product, target: "lib/nowhere" })).refusal).toMatchObject({ code: "unknown-target", message: "no state 'lib/nowhere' was found on the workflow path" });
  });
});

describe("a drop that stopped part-way is finished as it was meant (its written intent)", () => {
  it("is finished by the NEXT OPEN when the process was cut off in the middle of it — one document, one task, one move", { timeout: 20_000 }, async () => {
    const product = await ran("feat/product", 1);
    // The move step dies with the process: nothing writes that it stopped.
    const real = service.moveTask.bind(service);
    (service as unknown as { moveTask: unknown }).moveTask = () => Promise.reject(new Error("the process went away"));
    await expect(service.connectTask({ taskId: product, target: "lib/second" })).rejects.toThrow("the process went away");
    (service as unknown as { moveTask: unknown }).moveTask = real;
    read((p) => p.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND type = 'jaira.connect' AND payload_json LIKE '%"stopped"%'`).run(product));
    const made = taskIds().filter((id) => id !== product);
    expect(made).toHaveLength(1);
    expect(documents()).toHaveLength(1);

    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
    await service.open(dir);
    await (service as unknown as { session(): { resuming: Promise<void> } }).session().resuming;
    // A new process numbers its requests from the start again.
    seen.clear();
    // The parent the first attempt made stands at the target, asking its question — and nothing was made twice.
    expect((await parked()).state).toBe("second");
    expect(taskIds().filter((id) => id !== product)).toEqual(made);
    expect(documents()).toHaveLength(1);
    const rows = journal(product).filter((e) => (e as unknown as { type: string }).type === "jaira.connect").map((e) => (e as unknown as { at: string }).at);
    expect(rows[0]).toBe("intent");
    expect(rows.at(-1)).toBe("done");
    expect(metaOf(made[0]!)?.connectUndo?.undo).toMatchObject({ kind: "adopt", parentTaskId: made[0], adoptedTaskId: product });
  });

  it("is NOT finished unasked when it stopped on a refusal — dropping it again is the retry", { timeout: 20_000 }, async () => {
    const product = await ran("feat/product", 1);
    const real = service.moveTask.bind(service);
    (service as unknown as { moveTask: unknown }).moveTask = () => Promise.reject(new Error("refused: busy"));
    await expect(service.connectTask({ taskId: product, target: "lib/second" })).rejects.toThrow("refused: busy");
    (service as unknown as { moveTask: unknown }).moveTask = real;
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
    await service.open(dir);
    await (service as unknown as { session(): { resuming: Promise<void> } }).session().resuming;
    // A new process numbers its requests from the start again.
    seen.clear();
    expect(service.pendingInteractions()).toEqual([]);
    // The person drops it again: the same document and task, now moved.
    const again = ok(await service.connectTask({ taskId: product, target: "lib/second" }));
    expect((await parked()).state).toBe("second");
    expect(taskIds().filter((id) => id !== product)).toEqual([again.taskId]);
    expect(documents()).toHaveLength(1);
  });
});

describe("UNDO outlives the process that handed it out", () => {
  const outputsOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.outputsJson);

  it("is kept on the task and survives a restart; undoing a move of a FINISHED task gives back the outputs its reopening cleared", async () => {
    const taskId = await ran("done", 2);
    const finished = outputsOf(taskId);
    expect(JSON.parse(finished!)).toEqual({ a_ok: true, b_ok: true });

    // Backward, into a task that had finished: it is reopened to take the move, and its row is cleared.
    const done = ok(await service.connectTask({ taskId, target: "flow/a" }));
    expect(done.moved).toBe("reopened");
    expect(metaOf(taskId)?.connectUndo?.undo).toEqual(done.undo);
    expect(service.listTasks().find((t) => t.taskId === taskId)?.undoable).toBe(true);
    expect((await parked()).state).toBe("a");
    expect(outputsOf(taskId)).toBeUndefined();

    // A restart while it stands where it landed: a close is not a decision, so nothing in this
    // process was handed the token, the run is resumed to its gate, and the card still offers it.
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
    await service.open(dir);
    seen.clear();
    expect((await parked()).state).toBe("a");
    const card = service
      .boardRoots()
      .columns.flatMap((column) => column.cards)
      .find((c) => c.taskId === taskId);
    expect(card).toMatchObject({ taskId, undoable: true });

    // Pressed while the landing runs: that run is the drop's, so Undo stops it and takes it all back.
    expect(await service.undoConnect({ taskId })).toEqual({ taskId });
    // Finished again, with the outputs it had — not a finished task with none.
    expect(statusOf(taskId)).toBe("completed");
    expect(outputsOf(taskId)).toBe(finished);
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
    expect(ended(taskId).filter(([key]) => key === "(root)")).toEqual([["(root)", "success"]]);
    // Used, so no longer offered — and asking again has nothing to take back.
    expect(metaOf(taskId)?.connectUndo).toBeUndefined();
    expect(service.listTasks().find((t) => t.taskId === taskId)?.undoable).toBeUndefined();
    await expect(service.undoConnect({ taskId })).rejects.toThrow(/has no connect to take back/);
  });

  it("an adoption's Undo survives a restart too", async () => {
    const product = await ran("feat/product", 1);
    const done = ok(await service.connectTask({ taskId: product, target: "feat", start: false }));
    const parent = done.taskId!;
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
    await service.open(dir);
    expect(await service.undoConnect({ taskId: parent })).toEqual({ taskId: product, removed: parent });
    expect(metaOf(product)?.origin).toBeUndefined();
  });

});

describe("UNDO means only 'take back what I just did'", () => {
  const undoable = (taskId: string): boolean | undefined => service.listTasks().find((t) => t.taskId === taskId)?.undoable;
  const hostRows = (taskId: string, type: string): number => journal(taskId).filter((e) => (e as { type: string }).type === type).length;

  it("a held move is the drop's until the state it waits for FINISHES — that is the task's own work, and Undo is over", async () => {
    const taskId = await standingIn("flow", 2); // parked at c
    // The state that comes next anyway is taken when the one the task stands in ends: held.
    const done = ok(await service.connectTask({ taskId, target: "flow/d" }));
    expect(done.moved).toBe("held");
    expect(undoable(taskId)).toBe(true);
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true }); // c finishes
    expect((await parked()).state).toBe("d");
    expect(undoable(taskId)).toBeUndefined();
    await expect(service.undoConnect({ taskId })).rejects.toThrow(/has moved on since the drop \('c' finished after the drop\)/);
    expect(metaOf(taskId)?.connectUndo).toBeUndefined();
  });

  it("taken back while held: the run is stopped, the move goes, and the task stands where it stood", async () => {
    const taskId = await standingIn("flow", 2); // parked at c
    ok(await service.connectTask({ taskId, target: "flow/d" }));
    expect(hostRows(taskId, "jaira.moveHeld")).toBe(1);
    expect(await service.undoConnect({ taskId })).toEqual({ taskId });
    seen.clear();
    expect((await parked()).state).toBe("c");
    expect(hostRows(taskId, "jaira.moveHeld")).toBe(0);
    expect(journal(taskId).some((e) => e.type === "transition.taken")).toBe(false);
    expect(metaOf(taskId)?.connectUndo).toBeUndefined();
  });

  it("the task progressing past where it landed ends it — not offered, and a stale undoConnect is refused plainly", async () => {
    const taskId = await ran("flow", 4);
    ok(await service.connectTask({ taskId, target: "flow/b" }));
    expect((await parked()).state).toBe("b"); // landed, running: still the drop's
    expect(undoable(taskId)).toBe(true);
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { confirmed: true });
    expect((await parked()).state).toBe("c");
    expect(undoable(taskId)).toBeUndefined();
    expect(
      service
        .boardRoots()
        .columns.flatMap((column) => column.cards)
        .find((c) => c.taskId === taskId)?.undoable,
    ).toBeUndefined();
    // The token is still on the file until something acts on it — and acting on it refuses.
    expect(metaOf(taskId)?.connectUndo).toBeDefined();
    await expect(service.undoConnect({ taskId })).rejects.toThrow(/has moved on since the drop \(the state the drop landed in has settled\)/);
    expect(metaOf(taskId)?.connectUndo).toBeUndefined();
    // Nothing was cut.
    expect(journal(taskId).filter((e) => e.type === "transition.taken")).toMatchObject([{ to: "b", by: "person" }]);
  });

  it("a second connect REPLACES the token: only the new one is kept, and Undo takes back only it", async () => {
    const taskId = await ran("flow", 4);
    ok(await service.connectTask({ taskId, target: "flow/b" }));
    expect((await parked()).state).toBe("b");
    const second = ok(await service.connectTask({ taskId, target: "flow/c" }));
    expect(second.moved).toBe("held");
    expect(metaOf(taskId)?.connectUndo?.undo).toEqual(second.undo);
    expect(undoable(taskId)).toBe(true);
    expect(await service.undoConnect({ taskId })).toEqual({ taskId });
    // Back to before the SECOND drop: standing at b, where the first one put it.
    seen.clear();
    expect((await parked()).state).toBe("b");
    expect(hostRows(taskId, "jaira.moveHeld")).toBe(0);
    expect(journal(taskId).filter((e) => e.type === "transition.taken")).toMatchObject([{ to: "b", by: "person" }]);
    expect(metaOf(taskId)?.connectUndo).toBeUndefined();
  });

  it("a plain MOVE of the task (task_move) is the next decision about it, held or taken", async () => {
    const taskId = await ran("flow", 4);
    ok(await service.connectTask({ taskId, target: "flow/b" }));
    expect((await parked()).state).toBe("b");
    expect(undoable(taskId)).toBe(true);
    const moved = await service.moveTask({ taskId, toState: "a" });
    expect(moved.status).toBe("held");
    expect(undoable(taskId)).toBeUndefined();
    await expect(service.undoConnect({ taskId })).rejects.toThrow(/has moved on since the drop \(the task was moved again\)/);
  });

  it("a rewind, or a fork, of the task is the next decision about it", async () => {
    const rewound = await ran("feat/product", 1);
    const p1 = ok(await service.connectTask({ taskId: rewound, target: "feat", start: false })).taskId!;
    expect(undoable(p1)).toBe(true);
    // The last row the MACHINE wrote — the drop's own `jaira.connect` rows come after it.
    const last1 = read((p) => new SqliteEventLog(p.db).list(p1).filter((row) => !(row.type as string).startsWith("jaira.")).at(-1)!.seq);
    await service.rewindTask({ taskId: p1, at: last1 });
    expect(metaOf(p1)?.connectUndo).toBeUndefined();
    expect(undoable(p1)).toBeUndefined();

    const forked = await ran("feat/product", 1);
    const p2 = ok(await service.connectTask({ taskId: forked, target: "feat", start: false })).taskId!;
    expect(undoable(p2)).toBe(true);
    // Forked before the mirror row: the copy is the workflow's own walk, with nothing adopted.
    const mirror2 = read((p) => new SqliteEventLog(p.db).list(p2).find((row) => row.type === "instance.entered" && row.instanceId === forked)!.seq);
    const copy = await service.forkTask({ taskId: p2, at: mirror2 });
    expect(metaOf(p2)?.connectUndo).toBeUndefined();
    expect(metaOf(copy.taskId)?.connectUndo).toBeUndefined();
    expect(undoable(p2)).toBeUndefined();
  });

  it("a re-run of the task is a decision about it too", async () => {
    const product = await ran("feat/product", 1);
    const parent = ok(await service.connectTask({ taskId: product, target: "feat", start: false })).taskId!;
    expect(undoable(parent)).toBe(true);
    const again = await service.rerunTask({ taskId: parent });
    expect(metaOf(parent)?.connectUndo).toBeUndefined();
    expect(metaOf(again.taskId)?.connectUndo).toBeUndefined();
  });
});
