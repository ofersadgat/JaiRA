/**
 * ADOPT into a fan-out — the plan and the written rows (decision 0005, "Adopted into a fan-out",
 * 2026-09-22). The engine runs are in the app's `taskAdoptFanOut.test.ts`; here is what is decided and
 * written: which batches take an element and which refuse, where a drop that stopped part-way
 * through adopting into one leaves it, and what the load hands the engine for each kind.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import type { TaskAdoptResult, TaskConnectResult } from "@jaira/shared";
import { ADOPTED_BATCH_PREFIX, ADOPTED_STATE_PREFIX } from "../src/adopt";
import { adoptTaskIn, connectTask, type ConnectHost } from "../src/connect";
import { openConnectIntent } from "../src/hostRows";
import { beginTaskRun, createTask, finishTaskRun } from "../src/lifecycle";
import { buildTaskLoad } from "../src/load";
import { initProject, openProject, type Project } from "../src/project";
import { loadSnapshot } from "../src/snapshots";

const ITEM = { type: "object", required: ["id"], properties: { id: { type: "string" } } };

const leaf = (label: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>): Record<string, unknown> => ({
  label,
  inputs: Object.fromEntries(Object.entries(inputs).map(([name, schema]) => [name, { schema }])),
  outputs: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema, binding: `.operation.output.${name}` }])),
  operation: { kind: "prompt", prompt: `do ${label}`, model: "anthropic/claude-sonnet-5", output: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema }])) },
});

const fanned = (each: "inline" | "task"): Record<string, unknown> => ({
  label: `Fan (${each})`,
  inputs: { items: { schema: { type: "array", items: ITEM } } },
  children: {
    work: { state: "fan/work", inputs: { item: { $expr: ".inputs.items", each } } },
    gather: { state: "fan/gather", inputs: { docs: ".children.work.output.doc" } },
  },
  sequence: ["work", "gather"],
});

const FILES: Record<string, unknown> = {
  fan: fanned("inline"),
  tfan: fanned("task"),
  // Two lists at once: every combination of them is an element, and one task is an element of one list.
  pairs: {
    label: "Pairs",
    inputs: { items: { schema: { type: "array", items: ITEM } }, others: { schema: { type: "array", items: ITEM } } },
    children: { work: { state: "fan/pair", inputs: { item: { $expr: ".inputs.items", each: "inline" }, other: { $expr: ".inputs.others", each: "inline" } } } },
    sequence: ["work"],
  },
  "fan/work": leaf("Work", { item: ITEM }, { doc: { type: "string" } }),
  "fan/pair": leaf("Pair", { item: ITEM, other: ITEM }, { doc: { type: "string" } }),
  "fan/gather": leaf("Gather", { docs: { type: "array", items: { type: "string" } } }, { final: { type: "string" } }),
};

let dir: string;
let project: Project;
let clock = 10_000;
const tick = (): number => (clock += 10);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-adopt-fan-"));
  initProject(dir, testHome());
  for (const [id, def] of Object.entries(FILES)) {
    const file = `${join(dir, ".jaira", "workflows", ...id.split("/"))}.json`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
  }
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task that ran `workflow` alone, to the end, with these inputs and outputs. */
async function finished(taskId: string, workflow: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>): Promise<string> {
  createTask(project, { id: taskId, title: taskId, workflow, inputs: inputs as never });
  await beginTaskRun(project, taskId, { nowMs: tick() });
  const recorder = project.events.recorder(taskId);
  recorder.record({ type: "instance.entered", instanceId: `${taskId}-root`, stateId: workflow, inputs } as EngineEvent, tick());
  recorder.record({ type: "instance.terminated", instanceId: `${taskId}-root`, stateId: workflow, outcome: "success" } as EngineEvent, tick());
  finishTaskRun(project, taskId, "completed", { outputs }, tick());
  return taskId;
}

const refusalOf = (result: TaskAdoptResult) => {
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
};
const planOf = (result: TaskAdoptResult) => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.plan;
};
const mirrorsOf = (parent: string, taskId: string): EngineEvent[] =>
  project.events.list(parent).map((row) => row.event).filter((e) => e.type === "instance.entered" && e.instanceId === taskId);
const loadOf = (taskId: string) => buildTaskLoad(project, taskId, loadSnapshot(project.paths.snapshotsDir, project.runtime.get(taskId)!.snapshotHash!).states);

describe("which batches take an element", () => {
  it("refuses a mount over two lists at once", async () => {
    await finished("t-pair", "fan/pair", { item: { id: "a" }, other: { id: "b" } }, { doc: "d" });
    const refusal = refusalOf(await adoptTaskIn(project, { taskId: "t-pair", workflow: "pairs", dryRun: true }));
    expect(refusal).toMatchObject({ code: "unsupported-mount" });
    expect(refusal.message).toContain("fans out over 2 lists at once ('item', 'other')");
  });

  it("refuses a task that has no value on the axis — nothing says which element it is", async () => {
    await finished("t-none", "fan/work", {}, { doc: "d" });
    expect(refusalOf(await adoptTaskIn(project, { taskId: "t-none", workflow: "fan", dryRun: true }))).toMatchObject({ code: "element-misfit", path: "inputs.item" });
  });

  it("refuses an inline batch the parent ran ITSELF, and a batch it has entered something after", async () => {
    await finished("t-beta", "fan/work", { item: { id: "b" } }, { doc: "beta" });
    // A parent that ran element 0 of `work` inline and stopped there.
    createTask(project, { id: "t-parent", title: "Parent", workflow: "fan", inputs: { items: [{ id: "a" }] } as never });
    await beginTaskRun(project, "t-parent", { nowMs: tick() });
    const recorder = project.events.recorder("t-parent");
    recorder.record({ type: "instance.entered", instanceId: "p-root", stateId: "fan", inputs: { items: [{ id: "a" }] } } as EngineEvent, tick());
    recorder.record({ type: "instance.entered", instanceId: "p-a", stateId: "fan/work", childKey: "work", parentInstanceId: "p-root", element: 0, inputs: { item: { id: "a" } } } as EngineEvent, tick());
    recorder.record({ type: "instance.terminated", instanceId: "p-a", stateId: "fan/work", outcome: "success" } as EngineEvent, tick());
    finishTaskRun(project, "t-parent", "canceled", undefined, tick());

    const ran = refusalOf(await adoptTaskIn(project, { taskId: "t-beta", parentTaskId: "t-parent", dryRun: true }));
    expect(ran).toMatchObject({ code: "unsupported-mount" });
    expect(ran.message).toContain(`'Parent' ran the elements of 'work' itself (each: "inline")`);

    recorder.record({ type: "instance.entered", instanceId: "p-gather", stateId: "fan/gather", childKey: "gather", parentInstanceId: "p-root", inputs: { docs: ["a"] } } as EngineEvent, tick());
    const since = refusalOf(await adoptTaskIn(project, { taskId: "t-beta", parentTaskId: "t-parent", dryRun: true }));
    expect(since).toMatchObject({ code: "parent-state" });
    expect(since.message).toContain("has entered 'gather' since its batch of 'work'");
  });
});

describe("what the load hands the engine", () => {
  it("an inline batch of adopted elements is ONE row with the outputs gathered; a task batch keeps its rows for the host", async () => {
    await finished("t-alpha", "fan/work", { item: { id: "a" } }, { doc: "alpha" });
    await finished("t-beta", "fan/work", { item: { id: "b" } }, { doc: "beta" });
    const inline = await adoptTaskIn(project, { taskId: "t-alpha", workflow: "fan" });
    const parent = (inline as { taskId: string }).taskId;
    expect(planOf(await adoptTaskIn(project, { taskId: "t-beta", parentTaskId: parent }))).toMatchObject({ adopted: [{ index: 1, appended: true }] });
    expect(mirrorsOf(parent, "t-beta")).toEqual([expect.objectContaining({ element: 1, adopted: true, childKey: "work" })]);
    expect(loadOf(parent).loaded?.children).toEqual([
      expect.objectContaining({ id: "t-alpha", stateId: `${ADOPTED_BATCH_PREFIX}fan/work`, occurrence: 0, operation: { value: { doc: ["alpha", "beta"] } } }),
    ]);

    await finished("t-gamma", "fan/work", { item: { id: "c" } }, { doc: "gamma" });
    const task = await adoptTaskIn(project, { taskId: "t-gamma", workflow: "tfan" });
    const tparent = (task as { taskId: string }).taskId;
    expect(loadOf(tparent).loaded?.children).toEqual([
      expect.objectContaining({ id: "t-gamma", stateId: `${ADOPTED_STATE_PREFIX}fan/work`, element: 0, occurrence: 0, live: false, outcome: "success" }),
    ]);
  });
});

describe("a drop that stops part-way through adopting into a fan-out", () => {
  it("is finished by the retry: one parent, one element — never appended a second time", async () => {
    await finished("t-alpha", "fan/work", { item: { id: "a" } }, { doc: "alpha" });
    const DROP = { taskId: "t-alpha", target: "fan/gather", workflow: "fan" } as const;
    // The adoption is WRITTEN, and the process falls over before its step is marked done.
    let fail = true;
    const host: ConnectHost = {
      adopt: async (request) => {
        const result = await adoptTaskIn(project, request);
        if (request.dryRun !== true && fail) {
          fail = false;
          throw new Error("the process fell over mid-adoption");
        }
        return result;
      },
      move: async () => {
        throw new Error("a drop onto what comes next moves nothing");
      },
    };
    await expect(connectTask(project, DROP, host)).rejects.toThrow("the process fell over mid-adoption");
    expect(openConnectIntent(project, "t-alpha")?.stopped).toMatchObject({ reason: "the process fell over mid-adoption" });
    const parent = project.tasks.read("t-alpha").origin!.taskId;

    const result: TaskConnectResult = await connectTask(project, DROP, host);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(result.taskId).toBe(parent);
    expect(result.plan).toMatchObject({ resolution: "adopt", adoptedAs: "work", standsAt: { path: ["gather"] }, adopt: { adopted: [{ shape: "element", each: "inline", index: 0 }] } });
    expect(openConnectIntent(project, "t-alpha")).toBeUndefined();
    // One parent task besides the adopted one, and ONE element in its batch.
    expect(project.tasks.list().map((meta) => meta.id).sort()).toEqual([parent, "t-alpha"].sort());
    expect(mirrorsOf(parent, "t-alpha")).toEqual([expect.objectContaining({ element: 0 })]);
    expect(project.tasks.read(parent).inputs).toEqual({ items: [{ id: "a" }] });
  });
});
