/**
 * The load description over REAL runs: what a stopped run hands the one that continues it.
 *
 * The property that matters is SELF-CONSISTENCY. A run's own description, built back from its
 * journal and records, must answer every operation that run completed — because a loaded machine
 * reads exactly that. An operation missing its value is one the continuing run would DISPATCH, and
 * for anything with side effects that is a double-apply nobody asked for.
 *
 * The workflow here is deliberately not the components tour, which is flat. It nests (root → loop →
 * tick) and it loops, so occurrence and depth are both exercised. `confirm_action` is the operation
 * because it is deterministic and free: the test decides every answer, so the recorded values are
 * known rather than observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressKey, buildTaskLoad, initProject, loadSnapshot, openProject, type TaskLoad } from "@jaira/persistence";
import type { LoadedInstance } from "@declarative-ai/hw";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ROOT = "load";

/**
 * Root → `loop` → `tick`, where `loop` re-enters `tick` for as long as it keeps saying yes.
 *
 * Re-entering a SEQUENCE member supersedes it (SPEC §3.3), so the second and third ticks are
 * separate instances under the same child key — which is the case the occurrence index exists for.
 */
function loadFiles(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Load fixture",
      outputs: { last: { schema: { type: "boolean" }, binding: ".children.loop.output.last" } },
      children: { loop: { state: `${ROOT}/loop` } },
      sequence: ["loop"],
    },
    [`${ROOT}/loop`]: {
      label: "Ask until told to stop",
      outputs: { last: { schema: { type: "boolean" }, binding: ".children.tick.output.confirmed" } },
      children: { tick: { state: `${ROOT}/loop/tick` } },
      sequence: ["tick"],
      transitions: [
        {
          to: "tick",
          when: ".run.cursor === 'tick' && .children.tick.output.confirmed === true && .run.iteration < .limits.max_iterations",
        },
        { to: "terminate.success", when: ".run.cursor === 'tick' && .children.tick.output.confirmed === false" },
      ],
      limits: { max_iterations: 5 },
    },
    [`${ROOT}/loop/tick`]: {
      label: "Again?",
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "Again?" } },
    },
  };
}

let dir: string;
let workflowsDir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-load-"));
  workflowsDir = initProject(dir, testHome()).workflowsDir;
  writeWorkflowFiles(workflowsDir, loadFiles());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Wait for the NEXT gate and answer it, returning the request it answered.
 *
 * `after` is the previous round's request id, and skipping it is what makes this reliable: the gate
 * list is not emptied synchronously by a submit, so "wait for a pending interaction" can match the
 * one just answered and read the database a round early.
 */
async function tick(confirmed: boolean, after?: string): Promise<string> {
  const fresh = (): string | undefined =>
    service.pendingInteractions().find((p) => p.component === "confirm_action" && p.requestId !== after)?.requestId;
  await until(() => fresh() !== undefined, "the next gate");
  const requestId = fresh()!;
  service.submitInteraction(requestId, { confirmed });
  return requestId;
}

/** Wait for the round after `after` to be offered, without answering it. */
async function parked(after?: string): Promise<void> {
  await until(
    () => service.pendingInteractions().some((p) => p.component === "confirm_action" && p.requestId !== after),
    "the next gate",
  );
}

/** The description for this task, read exactly the way `resumeTask` reads it. */
function loadOf(taskId: string): TaskLoad {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    const hash = project.runtime.get(taskId)!.snapshotHash!;
    return buildTaskLoad(project, taskId, loadSnapshot(project.paths.snapshotsDir, hash).states);
  } finally {
    project.close();
  }
}

async function start(): Promise<string> {
  const { taskId } = service.createTask({ title: "Load", workflow: ROOT });
  await service.startTask({ taskId });
  return taskId;
}

/** Every emitted instance, depth-first — the walk assertions address into. */
function flat(node: LoadedInstance | undefined): LoadedInstance[] {
  if (node === undefined) return [];
  return [node, ...(node.children ?? []).flatMap((child) => flat(child))];
}

describe("the load description", () => {
  it("answers every operation a completed run made, and re-enters nothing", async () => {
    const taskId = await start();
    const first = await tick(true);
    const second = await tick(true, first);
    await tick(false, second);
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    const load = loadOf(taskId);
    expect(load.unreadable).toEqual([]);
    const root = load.loaded!;
    // The run ENDED on its own terms: nothing is live, and there is nowhere to pick up.
    expect(root.live).toBe(false);
    expect(root.outcome).toBe("success");
    expect(load.frontier).toEqual([]);

    // Occurrence and depth, both: the first two ticks were superseded by the re-entry, so only the
    // third is loaded — under its own occurrence, because the cleared entries still happened.
    const loop = root.children![0]!;
    expect(loop.childKey).toBe("loop");
    expect(loop.children!.map((c) => [c.childKey, c.occurrence])).toEqual([["tick", 2]]);
    // The recorded answer, unwrapped from the record's `{ value }` envelope — what the loaded
    // machine recomputes the state's outputs from.
    expect(loop.children![0]!.operation?.value).toEqual({ confirmed: false });
  }, 30000);

  it("names the live leaf a stopped run would re-enter", async () => {
    // Parked on the first gate: the operation was dispatched and never settled, which is exactly the
    // shape a crash leaves behind — an `open` record with no answer in it.
    const taskId = await start();
    await parked();

    const load = loadOf(taskId);
    expect(load.loadedOps).toBe(0);
    expect(load.frontier).toHaveLength(1);
    expect(load.frontier[0]).toMatchObject({
      address: [
        { childKey: "loop", occurrence: 0 },
        { childKey: "tick", occurrence: 0 },
      ],
      stateId: `${ROOT}/loop/tick`,
      stopped: "mid-operation",
      cause: "interrupted",
    });
    expect(addressKey(load.frontier[0]!.address)).toBe("loop#0/tick#0");
    // The leaf itself is presented LIVE with no operation to take: the engine re-dispatches it, and
    // the same scoped id reopens the record the cut ask left behind.
    const leaf = flat(load.loaded).find((n) => n.id === load.frontier[0]!.instanceId)!;
    expect(leaf.live).toBe(true);
    expect(leaf.operation).toBeUndefined();
  }, 30000);

  it("moves the frontier on, keeping what the earlier round answered", async () => {
    const taskId = await start();
    await parked(await tick(true));

    const load = loadOf(taskId);
    // The first tick was SUPERSEDED by the re-entry, so it is not loaded — its answer already did
    // its work when the transition that consumed it was journaled, and `.children.tick` reads the
    // newest entry. The second tick is where spending resumes, under its own occurrence.
    const ticks = flat(load.loaded).filter((n) => n.childKey === "tick");
    expect(ticks.map((n) => [n.occurrence, n.live])).toEqual([[1, true]]);
    expect(load.frontier.map((f) => addressKey(f.address))).toEqual(["loop#0/tick#1"]);
  }, 30000);

  it("addresses the root as the empty address", async () => {
    const taskId = await start();
    await parked();
    // The root is live and has a live child, so it is not itself a frontier entry — but its address
    // is the prefix every other one is built on, and it is the empty string.
    expect(addressKey([])).toBe("");
    expect(loadOf(taskId).frontier.every((f) => f.address.length === 2)).toBe(true);
  }, 30000);

  /**
   * A FUNCTION op is never unwrapped, whatever its value happens to contain.
   *
   * Only the prompt executor family reports a record payload, so only a prompt row can be holding
   * one. Detecting on `finishReason` alone would make a function that returned a field by that name
   * lose its answer — hence the kind is half the test, and this pins it.
   */
  it("does not unwrap a function op whose value carries a finishReason of its own", async () => {
    const taskId = await start();
    const first = await tick(true);
    await tick(false, first);
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    const value = { confirmed: true, finishReason: "stop" };
    rewriteRecords(taskId, value);

    const load = loadOf(taskId);
    expect(load.unreadable).toEqual([]);
    const ticks = flat(load.loaded).filter((n) => n.childKey === "tick");
    expect(ticks.at(-1)!.operation?.value).toEqual(value);
  }, 30000);
});

/**
 * A conversation's calls — records that took a SEAT, not just gates that never did.
 *
 * The settled event's `operationId` is the scoped record id, computed independently by the journal
 * and the store from the same parts, so the description joins the two directly — placed and
 * unplaced alike. These fixtures pin that the join actually reads back what a model call recorded.
 */
const PROMPTED = "prompted";

function promptFiles(): Record<string, JsonValue> {
  const leaf = (name: string): JsonValue => ({
    label: name,
    outputs: { text: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: `say ${name}`, config: { model: "fake/model" } },
  });
  return {
    [PROMPTED]: {
      label: "Two calls in one conversation",
      // Declared, so both children take a seat in the SAME transcript — the arrangement any real
      // workflow uses.
      environment: { session: "main" },
      outputs: { last: { schema: { type: "string" }, binding: ".children.b.output.text" } },
      children: { a: { state: `${PROMPTED}/a` }, b: { state: `${PROMPTED}/b` } },
      sequence: ["a", "b"],
    },
    [`${PROMPTED}/a`]: leaf("a"),
    [`${PROMPTED}/b`]: leaf("b"),
  };
}

/** The loaded value of the state mounted under `childKey`, out of the description's tree. */
function valueUnder(load: TaskLoad, childKey: string): unknown {
  return flat(load.loaded).find((n) => n.childKey === childKey)?.operation?.value;
}

describe("the load description over a conversation", () => {
  it("reads back a call that took a seat, not just one that never did", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Prompted", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    const load = loadOf(taskId);
    // Both calls, with their values — and nothing the description could not read. An `unreadable`
    // entry here makes `resumable` answer `none`, which makes the strip fall back to "Start again"
    // on a task that could perfectly well be resumed.
    expect(load.unreadable).toEqual([]);
    expect(valueUnder(load, "a")).toMatchObject({ text: "hi" });
    expect(valueUnder(load, "b")).toMatchObject({ text: "hi" });
    expect(load.frontier).toEqual([]);
  }, 30000);

  /**
   * A record does not store its big strings any more, and the description has to know that.
   *
   * Since RECORDS.md §8 a string over `BLOB_THRESHOLD` is written once into `blobs` and the record
   * keeps `{"$blob": "<sha>"}` where it was. Every other reader of `result_json` hydrates; a loaded
   * answer that did not would hand the engine the REFERENCE — and a state whose output is
   * `kind: "blob"` refuses an object with one reserved key, so the resume died on the first state
   * that had produced a document. 1 KB is why that shipped green once: every fixture answers "hi",
   * so the test has to cross the threshold deliberately.
   */
  it("hydrates a value the record stored by reference, rather than loading the reference", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Big", workflow: PROMPTED });
    const document = `# Feature\n\n${"a document long enough to be worth storing once. ".repeat(60)}`;
    expect(document.length).toBeGreaterThan(1024);
    await service.startTask({ taskId, fake: [{ output: { text: document } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    // The row really does hold a reference — otherwise this test proves nothing about hydration.
    const project = openProject(dir, { baseDir: testHome() });
    try {
      const rows = project.db
        .prepare("SELECT result_json FROM operation_records WHERE task_id = ?")
        .all(taskId) as Array<{ result_json: string }>;
      expect(rows.some((r) => r.result_json.includes('"$blob"'))).toBe(true);
    } finally {
      project.close();
    }

    const load = loadOf(taskId);
    expect(load.unreadable).toEqual([]);
    expect(valueUnder(load, "a")).toMatchObject({ text: document });
  }, 30000);
});

/**
 * The shape a REAL prompt call records — which no faked run in this file produces.
 *
 * `withRecord` stores `result.record` when the executor reports one, and the prompt executor reports
 * the whole `LlmOutput`: the op's value, plus the reasoning and tool trace that the projection drops.
 * The scripted executor reports no payload at all, so every test above records the already-projected
 * value and the extra level never appears. So the row is rewritten into the payload shape after a
 * faked run, and the description is asked to read the run back. Nothing else changes: the journal
 * and the record ids are the ones the run actually produced.
 */
function rewriteRecords(taskId: string, payload: JsonValue): void {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    const rows = project.db
      .prepare("SELECT id FROM operation_records WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{ id: string }>;
    for (const row of rows) {
      project.db.prepare("UPDATE operation_records SET result_json = ? WHERE id = ?").run(JSON.stringify({ value: payload }), row.id);
    }
  } finally {
    project.close();
  }
}

/** The payload a real prompt call records around `value` — `finishReason` is its one REQUIRED field. */
function llmPayload(value: JsonValue): JsonValue {
  return { value, thinking: [], toolCalls: [], toolResults: [], messages: [], finishReason: "stop" };
}

describe("the load description over a real prompt payload", () => {
  it("projects the recorded LlmOutput, so a bound output still resolves", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Payload", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    // What a real prompt executor would have written for the same two calls.
    rewriteRecords(taskId, llmPayload({ text: "hi" }));

    const load = loadOf(taskId);
    // The op's value, NOT the envelope around it. Handing back the envelope is what made
    // `.operation.output.text` resolve to nothing and the state fail "required output 'text' was not
    // produced" — on a call that had already answered.
    expect(load.unreadable).toEqual([]);
    expect(valueUnder(load, "a")).toEqual({ text: "hi" });
    expect(valueUnder(load, "b")).toEqual({ text: "hi" });
  }, 30000);

  /**
   * The other half of the discriminator, and the reason it is not the op kind alone: a SCRIPTED
   * prompt executor reports no payload, so "this row came from a prompt op" does not tell you which
   * shape is in it. Unwrapping on the kind would corrupt every faked run instead of the real ones.
   */
  it("leaves a prompt row that already holds the projected value alone", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Flat", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    // Exactly what the scripted executor records today — no envelope to strip.
    rewriteRecords(taskId, { text: "hi" });

    const load = loadOf(taskId);
    expect(load.unreadable).toEqual([]);
    expect(valueUnder(load, "a")).toEqual({ text: "hi" });
  }, 30000);

  /**
   * A payload whose call produced no value is UNREADABLE, not silently `undefined`.
   *
   * It is also the shape that cannot be told apart from a flat value carrying a `finishReason` field
   * of its own, so refusing is the only honest answer for both: `resumeTask` names the operation and
   * declines rather than dispatching one whose effects may already have landed.
   */
  it("refuses a payload that carries no value rather than guessing one", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Valueless", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    rewriteRecords(taskId, { thinking: [], messages: [], finishReason: "stop" });

    const load = loadOf(taskId);
    expect(load.loadedOps).toBe(0);
    expect(load.unreadable.map((u) => u.reason)).toEqual([
      "the record holds no readable value",
      "the record holds no readable value",
    ]);
  }, 30000);
});
