/**
 * ADOPT into a fan-out, end to end (decision 0005, "Adopted into a fan-out", 2026-09-22).
 *
 * The person's ruling: "why is it refused? as long as the workflow you adopt it into supports that
 * data type it should be fine, no?" A task that ran the state a parent mounts by `each` becomes ONE
 * ELEMENT of that batch, if what it ran with fits the list's element type. A batch the adoption makes
 * is the task alone, or the task at its place in a list that holds more — the parent runs the rest; a
 * parent that already has the batch, run by itself or adopted, gets the task appended. A later fan-in
 * reads the batch — so the assertion that matters is what the fan-in state was HANDED, and that no
 * model was called again for an element that was adopted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADOPTED_STATE_PREFIX, buildTaskLoad, initProject, loadSnapshot, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles, type FakeRule } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import type { TaskAdoptResult } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ITEM = { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } };
/** A stricter element than the mounted state takes: the list's own `items` is what an element must fit. */
const OWNED = { ...ITEM, required: ["id", "title", "owner"], properties: { ...ITEM.properties, owner: { type: "string" } } };

/** A prompt leaf: one model, one output bound off the operation. */
const leaf = (label: string, model: string, inputs: Record<string, JsonValue>, output: string, schema: JsonValue = { type: "string" }, prompt = `${label}.`): JsonValue => ({
  label,
  inputs,
  outputs: { [output]: { schema, binding: `.operation.output.${output}` } },
  operation: { model, prompt, output: { [output]: { schema } } },
});

/** `work` once per item — `each` of the given kind — then `gather`, which reads every element's doc. */
const fanned = (each: "inline" | "task", items: JsonValue = { type: "array", items: ITEM }): JsonValue => ({
  label: `Fan (${each})`,
  environment: { kind: "prompt", model: "nobody" },
  inputs: { items: { schema: items } },
  outputs: { final: { schema: { type: "string" }, binding: ".children.gather.output.final", optional: true } },
  children: {
    work: { state: "fan/work", inputs: { item: { $expr: ".inputs.items", each, ...(each === "task" ? { title: "title" } : {}) } } },
    gather: { state: "fan/gather", inputs: { docs: ".children.work.output.doc" } },
  },
  sequence: ["work", "gather"],
});

const FILES: Record<string, JsonValue> = {
  fan: fanned("inline"),
  tfan: fanned("task"),
  strict: fanned("inline", { type: "array", items: OWNED }),
  "fan/work": leaf("Work", "worker", { item: { schema: ITEM } }, "doc", { type: "string" }, "Work on {{.inputs.item.title}}."),
  "fan/gather": leaf("Gather", "gatherer", { docs: { schema: { type: "array", items: { type: "string" } } } }, "final"),
};

const RULES: FakeRule[] = [
  { model: "worker", output: { doc: "worked" } },
  { model: "gatherer", output: { final: "gathered" } },
];
/** A worker that says which element it was — so the fan-in can be read for what it was handed. */
const worker = (doc: string): FakeRule[] => [{ model: "worker", output: { doc } }, ...RULES];

const ALPHA = { id: "a", title: "Alpha" };
const BETA = { id: "b", title: "Beta" };
const GAMMA = { id: "c", title: "Gamma" };
/** A worker that answers per element, by the title its prompt names. */
const per = (docs: Record<string, string>, fails: string[] = []): FakeRule[] => [
  ...fails.map((title): FakeRule => ({ model: "worker", promptIncludes: `Work on ${title}`, error: `${title} broke` })),
  ...Object.entries(docs).map(([title, doc]): FakeRule => ({ model: "worker", promptIncludes: `Work on ${title}`, output: { doc } })),
  ...RULES,
];

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-adopt-fan-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, FILES);
  service = new AppService({ baseDir: testHome(), publish: () => undefined });
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

const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);
const outputsOf = (taskId: string): unknown => read((p) => JSON.parse(p.runtime.get(taskId)!.outputsJson ?? "null") as unknown);
const metaOf = (taskId: string) => read((p) => p.tasks.tryRead(taskId));
const journal = (taskId: string) => read((p) => new SqliteEventLog(p.db).list(taskId));
const events = (taskId: string): EngineEvent[] => journal(taskId).map((row) => row.event);
const dispatched = (taskId: string): number => events(taskId).filter((e) => e.type === "operation.started").length;
/** What the fan-in state was handed, the last time it was entered. */
const gathered = (taskId: string): unknown => (events(taskId).filter((e) => e.type === "instance.entered" && e.childKey === "gather").at(-1) as { inputs?: { docs?: unknown } } | undefined)?.inputs?.docs;
/** The mirror rows of the batch under `work`: which task each is, and at which element. */
const batchOf = (taskId: string): Array<[string, number | undefined]> =>
  events(taskId).flatMap((e) => (e.type === "instance.entered" && e.childKey === "work" ? [[e.instanceId, e.element] as [string, number | undefined]] : []));
/** The model calls `work` made in a task's journal, by the element each was. */
const workCalls = (taskId: string): Array<number | undefined> => {
  const entered = new Map(batchOf(taskId));
  return events(taskId).flatMap((e) => (e.type === "operation.started" && entered.has(e.instanceId) ? [entered.get(e.instanceId)] : []));
};

async function ran(workflow: string, inputs: Record<string, JsonValue>, title: string, rules: FakeRule[] = RULES): Promise<string> {
  const { taskId } = service.createTask({ title, workflow, inputs });
  await service.startTask({ taskId, fake: rules as unknown as JsonValue });
  await until(() => statusOf(taskId) === "completed", `${title} to complete`);
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
const parentOf = (result: TaskAdoptResult): string => (result as { taskId: string }).taskId;

describe("an inline fan-out", () => {
  it("in a NEW parent: the batch is the task alone — the list is [its element], and the fan-in reads its doc", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));

    const result = await service.adoptTask({ taskId: alpha, workflow: "fan", fake: RULES as unknown as JsonValue });
    expect(plan(result)).toMatchObject({
      cursor: "work",
      next: "gather",
      adopted: [{ taskId: alpha, childKey: "work", shape: "element", each: "inline", index: 0 }],
      inputs: { items: [ALPHA] },
      provenance: { items: { via: "bound", from: { taskId: alpha, input: "item" } } },
      asks: [],
    });
    const parent = parentOf(result);
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    // The mirror row is element 0 of the batch, and the adopted task's id is the instance's.
    expect(batchOf(parent)).toEqual([[alpha, 0]]);
    expect(events(parent).find((e) => e.type === "instance.entered" && e.instanceId === alpha)).toMatchObject({ adopted: true, element: 0, inputs: { item: ALPHA } });
    // The fan-in was handed the batch's gathered output — Alpha's doc — and only gather ran here.
    expect(gathered(parent)).toEqual(["alpha doc"]);
    expect(dispatched(parent)).toBe(1);
    expect(outputsOf(parent)).toEqual({ final: "gathered" });
    expect(metaOf(alpha)).toMatchObject({ parentTaskId: parent, origin: { kind: "adopt", taskId: parent, key: "work", index: 0 } });
  });

  it("appends to a batch the parent HAS: element 1 shares the batch, and the fan-in reads both", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    const beta = await ran("fan/work", { item: BETA }, "Beta", worker("beta doc"));
    const parent = parentOf(await service.adoptTask({ taskId: alpha, workflow: "fan", start: false }));
    expect(statusOf(parent)).toBe("queued");

    const result = await service.adoptTask({ taskId: beta, parentTaskId: parent, fake: RULES as unknown as JsonValue });
    expect(plan(result).adopted).toEqual([expect.objectContaining({ taskId: beta, shape: "element", each: "inline", index: 1, appended: true })]);
    // The list the parent recorded is history, and is not rewritten; the batch is what grew.
    expect(metaOf(parent)?.inputs).toEqual({ items: [ALPHA] });
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    expect(batchOf(parent)).toEqual([[alpha, 0], [beta, 1]]);
    expect(gathered(parent)).toEqual(["alpha doc", "beta doc"]);
    expect(dispatched(parent)).toBe(1);
    expect(metaOf(beta)?.origin).toMatchObject({ kind: "adopt", taskId: parent, key: "work", index: 1 });
  });

  it("loads each adopted element as its own history row under the stand-in, one batch by occurrence", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    const beta = await ran("fan/work", { item: BETA }, "Beta", worker("beta doc"));
    const parent = parentOf(await service.adoptTask({ taskId: alpha, workflow: "fan", start: false }));
    await service.adoptTask({ taskId: beta, parentTaskId: parent, start: false });

    const load = read((p) => buildTaskLoad(p, parent, loadSnapshot(p.paths.snapshotsDir, p.runtime.get(parent)!.snapshotHash!).states));
    expect(load.blocked).toBeUndefined();
    const row = (id: string, element: number, doc: string) =>
      expect.objectContaining({ id, stateId: `${ADOPTED_STATE_PREFIX}fan/work`, childKey: "work", occurrence: 0, element, live: false, outcome: "success", operation: { value: { doc } } });
    expect(load.loaded?.children).toEqual([row(alpha, 0, "alpha doc"), row(beta, 1, "beta doc")]);
    expect(load.loaded).toMatchObject({ unanswered: ["work"] });
  });

  it("refuses a task whose element does not fit the list's element type, naming the type and what the task has", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha");
    const result = await service.adoptTask({ taskId: alpha, workflow: "strict", dryRun: true });
    expect(refusal(result)).toMatchObject({ code: "element-misfit" });
    expect(refusal(result).message).toContain(`'Alpha' does not fit as an element of .inputs.items in 'strict': an element there is ${JSON.stringify(OWNED)}, and 'Alpha' has item = ${JSON.stringify(ALPHA)}`);
    expect(refusal(result).message).toMatch(/owner/);
    expect(metaOf(alpha)?.origin).toBeUndefined();
  });

  it("places the task in a supplied list that holds more: it loads as done, the parent runs the rest, and the fan-in reads them all", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    // Alpha is element 1 of [Beta, Alpha, Gamma]: elements 0 and 2 are the parent's to run.
    const result = await service.adoptTask({ taskId: alpha, workflow: "fan", inputs: { items: [BETA, ALPHA, GAMMA] }, fake: per({ Beta: "beta doc", Gamma: "gamma doc" }) as unknown as JsonValue });
    expect(plan(result)).toMatchObject({
      adopted: [{ taskId: alpha, shape: "element", each: "inline", index: 1 }],
      inputs: { items: [BETA, ALPHA, GAMMA] },
      provenance: { items: { via: "asked" } },
    });
    const parent = parentOf(result);
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    // The adopted element was never run again; the parent ran elements 0 and 2, at their own positions.
    expect(workCalls(parent)).toEqual([0, 2]);
    expect(dispatched(alpha)).toBe(1);
    expect(batchOf(parent).map(([id, element]) => [id === alpha, element])).toEqual([
      [true, 1],
      [false, 0],
      [false, 2],
    ]);
    expect(gathered(parent)).toEqual(["beta doc", "alpha doc", "gamma doc"]);
    expect(outputsOf(parent)).toEqual({ final: "gathered" });
    expect(metaOf(alpha)?.origin).toMatchObject({ kind: "adopt", taskId: parent, key: "work", index: 1 });
  });

  it("joins a batch the parent ran ITSELF: appended past its list, the element it owes retried, and the fan-in reads all three", async () => {
    // The parent ran [Alpha, Beta] inline and Beta failed: the batch is the last thing it entered.
    const { taskId: parent } = service.createTask({ title: "Parent", workflow: "fan", inputs: { items: [ALPHA, BETA] } });
    await service.startTask({ taskId: parent, fake: per({ Alpha: "alpha doc" }, ["Beta"]) as unknown as JsonValue });
    await until(() => statusOf(parent) === "failed", "the parent to fail on Beta");
    expect(workCalls(parent)).toEqual([0, 1]);
    const gamma = await ran("fan/work", { item: GAMMA }, "Gamma", worker("gamma doc"));

    const result = await service.adoptTask({ taskId: gamma, parentTaskId: parent, fake: per({ Beta: "beta doc" }) as unknown as JsonValue });
    expect(plan(result).adopted).toEqual([expect.objectContaining({ taskId: gamma, shape: "element", each: "inline", index: 2, appended: true })]);
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    // Alpha was not run again, Beta was retried where it stood, and Gamma loaded as done.
    expect(workCalls(parent)).toEqual([0, 1, 1]);
    expect(dispatched(gamma)).toBe(1);
    expect(gathered(parent)).toEqual(["alpha doc", "beta doc", "gamma doc"]);
    expect(metaOf(parent)?.inputs).toEqual({ items: [ALPHA, BETA] });
    expect(metaOf(gamma)?.origin).toMatchObject({ kind: "adopt", taskId: parent, key: "work", index: 2 });

    // Taken back: a rewind past Gamma's mirror row takes it out, and the fan-in reads what the parent ran.
    const mirror = journal(parent).find((row) => row.event.type === "instance.entered" && row.event.instanceId === gamma)!;
    await service.rewindTask({ taskId: parent, at: mirror.seq, fake: per({ Beta: "beta doc" }) as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the rewound parent to complete");
    expect(metaOf(gamma)?.origin).toBeUndefined();
    expect(gathered(parent)).toEqual(["alpha doc", "beta doc"]);
  }, 30_000);
});

describe("a task fan-out (each: \"task\")", () => {
  it("makes the adopted task one of the batch's tasks: the host reads it as it reads any, and makes no other", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    const before = service.listTasks().length;

    const result = await service.adoptTask({ taskId: alpha, workflow: "tfan", fake: RULES as unknown as JsonValue });
    expect(plan(result).adopted).toEqual([expect.objectContaining({ shape: "element", each: "task", index: 0 })]);
    const parent = parentOf(result);
    await until(() => statusOf(parent) === "completed", "the parent to complete");

    expect(gathered(parent)).toEqual(["alpha doc"]);
    // One task more — the parent — and the element was never run again, by the host or anyone.
    expect(service.listTasks()).toHaveLength(before + 1);
    expect(dispatched(parent)).toBe(1);
    expect(dispatched(alpha)).toBe(1);
    // The load hands the host the adopted row as an element, not folded: the host answers for tasks.
    expect(batchOf(parent)).toEqual([[alpha, 0]]);
  });

  it("appends to its batch, and a list that holds more than the task places it — the host makes the rest", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    const beta = await ran("fan/work", { item: BETA }, "Beta", worker("beta doc"));
    const parent = parentOf(await service.adoptTask({ taskId: alpha, workflow: "tfan", start: false }));
    const appended = await service.adoptTask({ taskId: beta, parentTaskId: parent, fake: RULES as unknown as JsonValue });
    expect(plan(appended).adopted).toEqual([expect.objectContaining({ each: "task", index: 1, appended: true })]);
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(gathered(parent)).toEqual(["alpha doc", "beta doc"]);
    expect(dispatched(parent)).toBe(1);

    // Beta at index 1 of a supplied list: element 0 is made as a task by the host, as any would be.
    const gamma = await ran("fan/work", { item: BETA }, "Beta again", worker("beta doc"));
    const placed = await service.adoptTask({ taskId: gamma, workflow: "tfan", inputs: { items: [ALPHA, BETA] }, fake: worker("made doc") as unknown as JsonValue });
    expect(plan(placed).adopted).toEqual([expect.objectContaining({ each: "task", index: 1 })]);
    const other = parentOf(placed);
    await until(() => statusOf(other) === "completed", "the second parent to complete");
    expect(gathered(other)).toEqual(["made doc", "beta doc"]);
    expect(batchOf(other).map(([id, element]) => [id === gamma, element])).toEqual([[true, 1], [false, 0]]);
  });
});

describe("a split fan-out", () => {
  it("refuses a parent that has already split: its elements are tasks on the list it recorded", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha");
    const beta = await ran("fan/work", { item: BETA }, "Beta");
    writeWorkflowFiles(read((p) => p.paths.workflowsDir), {
      ...FILES,
      sfan: {
        label: "Split",
        environment: { kind: "prompt", model: "nobody" },
        inputs: { items: { schema: { type: "array", items: ITEM } } },
        children: { work: { state: "fan/work", inputs: { item: { $expr: ".inputs.items", each: "split" } } } },
        sequence: ["work"],
      },
    });
    const parent = parentOf(await service.adoptTask({ taskId: alpha, workflow: "sfan", start: false }));
    expect(metaOf(parent)).toMatchObject({ inputs: { items: [ALPHA] }, split: [{ expr: ".inputs.items", index: 0 }] });
    const result = await service.adoptTask({ taskId: beta, parentTaskId: parent, dryRun: true });
    expect(refusal(result)).toMatchObject({ code: "parent-state" });
    expect(refusal(result).message).toContain("has already split over .inputs.items");
  });
});

describe("taking it back", () => {
  it("Undo of a drop that adopted into a fan-out removes the parent and its batch, and the task is its own again", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha");
    const dropped = await service.connectTask({ taskId: alpha, target: "fan/gather", workflow: "fan", start: false });
    if (!dropped.ok) throw new Error(dropped.refusal.message);
    expect(dropped.plan).toMatchObject({ resolution: "adopt", adoptedAs: "work", adopt: { adopted: [{ shape: "element", each: "inline", index: 0 }] } });
    const parent = dropped.taskId!;
    expect(batchOf(parent)).toEqual([[alpha, 0]]);

    expect(await service.undoConnect({ taskId: parent })).toEqual({ taskId: alpha, removed: parent });
    expect(statusOf(parent)).toBeUndefined();
    expect(metaOf(alpha)?.origin).toBeUndefined();
    expect(metaOf(alpha)?.parentTaskId).toBeUndefined();
  });

  it("a rewind past an APPENDED element's mirror row takes that element out of the batch, and the fan-in reads the rest", async () => {
    const alpha = await ran("fan/work", { item: ALPHA }, "Alpha", worker("alpha doc"));
    const beta = await ran("fan/work", { item: BETA }, "Beta", worker("beta doc"));
    const parent = parentOf(await service.adoptTask({ taskId: alpha, workflow: "fan", start: false }));
    await service.adoptTask({ taskId: beta, parentTaskId: parent, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the parent to complete");
    expect(gathered(parent)).toEqual(["alpha doc", "beta doc"]);

    const mirror = journal(parent).find((row) => row.event.type === "instance.entered" && row.event.instanceId === beta)!;
    await service.rewindTask({ taskId: parent, at: mirror.seq, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(parent) === "completed", "the rewound parent to complete");
    expect(metaOf(beta)?.origin).toBeUndefined();
    expect(metaOf(alpha)?.origin).toMatchObject({ kind: "adopt", taskId: parent, index: 0 });
    expect(batchOf(parent)).toEqual([[alpha, 0]]);
    expect(gathered(parent)).toEqual(["alpha doc"]);
  });
});
