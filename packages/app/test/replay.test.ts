/**
 * The replay index: what a stopped run can hand a resumed one, and where it says the run stopped.
 *
 * The property that matters is SELF-CONSISTENCY. A run's own index, replayed against the run that
 * produced it, must answer every operation that run made — because that is exactly what a resumed
 * walk asks it. If an operation is missing from the index, the resumed run DISPATCHES it, and for
 * anything with side effects that is a double-apply nobody asked for.
 *
 * The workflow here is deliberately not the components tour, which is flat. It nests (root → loop →
 * tick) and it loops, so the two things an address has to carry — depth and occurrence — are both
 * exercised. `confirm_action` is the operation because it is deterministic and free: the test decides
 * every answer, so the recorded values are known rather than observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressKey, buildRunReplay, initProject, openProject, type RunReplay } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

const ROOT = "replay";

/**
 * Root → `loop` → `tick`, where `loop` re-enters `tick` for as long as it keeps saying yes.
 *
 * Re-entering a SEQUENCE member supersedes it (SPEC §3.3), so the second and third ticks are
 * separate instances under the same child key — which is the case the occurrence index exists for.
 */
function replayFiles(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Replay fixture",
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
  dir = mkdtempSync(join(tmpdir(), "jaira-replay-"));
  workflowsDir = initProject(dir).workflowsDir;
  writeWorkflowFiles(workflowsDir, replayFiles());
  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m) });
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

/** The index for this task's only run, read the way a resume would. */
function replayOf(taskId: string): RunReplay {
  const project = openProject(dir);
  try {
    const runId = project.runtime.listRuns(taskId)[0]!.id;
    return buildRunReplay(project, taskId, runId);
  } finally {
    project.close();
  }
}

async function start(): Promise<string> {
  const { taskId } = service.createTask({ title: "Replay", workflow: ROOT });
  await service.startTask({ taskId });
  return taskId;
}

/** Answer keys, in the tree order the index was built in. */
function keys(replay: RunReplay): string[] {
  return [...replay.answers.keys()];
}

describe("the replay index", () => {
  it("answers every operation a completed run made, addressed by position", async () => {
    const taskId = await start();
    const first = await tick(true);
    const second = await tick(true, first);
    await tick(false, second);
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    const replay = replayOf(taskId);

    // Depth and occurrence, both. `loop` was entered once; `tick` three times under it, and the
    // first two were superseded by the re-entry without losing their place in the address.
    expect(keys(replay).sort()).toEqual(["loop#0/tick#0", "loop#0/tick#1", "loop#0/tick#2"]);
    expect(replay.answers.get("loop#0/tick#0")?.value).toEqual({ confirmed: true });
    expect(replay.answers.get("loop#0/tick#1")?.value).toEqual({ confirmed: true });
    expect(replay.answers.get("loop#0/tick#2")?.value).toEqual({ confirmed: false });
    expect(replay.answers.get("loop#0/tick#2")?.stateId).toBe(`${ROOT}/loop/tick`);

    // Nothing left to re-enter, and nothing the index could not read. An `unreadable` entry would
    // mean an operation the resume would dispatch for real — the failure this index exists to avoid.
    expect(replay.frontier).toEqual([]);
    expect(replay.unreadable).toEqual([]);
  }, 30000);

  it("names the live leaf a stopped run would re-enter", async () => {
    // Parked on the first gate: the operation was dispatched and never settled, which is exactly the
    // shape a crash leaves behind — an `open` record with no answer in it.
    const taskId = await start();
    await parked();

    const replay = replayOf(taskId);
    expect(replay.answers.size).toBe(0);
    expect(replay.frontier).toEqual([
      {
        address: [
          { childKey: "loop", occurrence: 0 },
          { childKey: "tick", occurrence: 0 },
        ],
        stateId: `${ROOT}/loop/tick`,
        instanceId: 3,
        stopped: "mid-operation",
      },
    ]);
    expect(addressKey(replay.frontier[0]!.address)).toBe("loop#0/tick#0");
  }, 30000);

  it("moves the frontier on, keeping what the earlier round answered", async () => {
    const taskId = await start();
    await parked(await tick(true));

    const replay = replayOf(taskId);
    // The first tick is an ANSWER now; the second is where spending resumes.
    expect(keys(replay)).toEqual(["loop#0/tick#0"]);
    expect(replay.answers.get("loop#0/tick#0")?.value).toEqual({ confirmed: true });
    expect(replay.frontier.map((f) => addressKey(f.address))).toEqual(["loop#0/tick#1"]);
  }, 30000);

  it("addresses the root as the empty address", async () => {
    const taskId = await start();
    await parked();
    // The root is live and has a live child, so it is not itself a frontier entry — but its address
    // is the prefix every other one is built on, and it is the empty string.
    expect(addressKey([])).toBe("");
    expect(replayOf(taskId).frontier.every((f) => f.address.length === 2)).toBe(true);
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

    const replay = replayOf(taskId);
    expect(replay.unreadable).toEqual([]);
    expect(replay.answers.get("loop#0/tick#0")?.value).toEqual(value);
  }, 30000);
});

/**
 * A conversation's calls — the case the interactive fixtures above cannot reach.
 *
 * Every gate in this file is an UNPLACED call: it takes no seat in a conversation, so its record is
 * keyed by the operation's content hash. A prompt or an agent call is PLACED, and its record is
 * keyed by the seat instead (`<session>:<seq>`). The settled event carries BOTH ids, so an index
 * that reaches for the hash first finds nothing for any call that talked to a model — which is
 * exactly what happened, and it turned the whole feature into "start over" on every real workflow
 * while the tests above stayed green.
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
      // workflow uses, and the one where positions rather than hashes are the record's key.
      environment: { session: "main" },
      outputs: { last: { schema: { type: "string" }, binding: ".children.b.output.text" } },
      children: { a: { state: `${PROMPTED}/a` }, b: { state: `${PROMPTED}/b` } },
      sequence: ["a", "b"],
    },
    [`${PROMPTED}/a`]: leaf("a"),
    [`${PROMPTED}/b`]: leaf("b"),
  };
}

describe("the replay index over a conversation", () => {
  it("reads back a call that took a seat, not just one that never did", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Prompted", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    const replay = replayOf(taskId);
    // Both calls, addressed by position, with their values — and nothing the index could not read.
    // An `unreadable` entry here is the whole bug: it makes `resumable` answer `none`, which makes
    // the strip fall back to "Start again" on a task that could perfectly well be resumed.
    expect(replay.unreadable).toEqual([]);
    expect(keys(replay).sort()).toEqual(["a#0", "b#0"]);
    expect(replay.answers.get("a#0")?.value).toMatchObject({ text: "hi" });
    expect(replay.frontier).toEqual([]);
  }, 30000);
});

/**
 * The shape a REAL prompt call records — which no faked run in this file produces.
 *
 * `withRecord` stores `result.record` when the executor reports one, and the prompt executor reports
 * the whole `LlmOutput`: the op's value, plus the reasoning and tool trace that the projection drops.
 * The scripted executor reports no payload at all (it says so in its own comment), so every test
 * above records the already-projected value and the extra level never appears. That is precisely how
 * a resume that could not read a single real prompt answer shipped green.
 *
 * So the row is rewritten into the payload shape after a faked run, and the index is asked to read
 * the run back. Nothing else changes: the journal, the addresses and the record pairing are the ones
 * the run actually produced.
 */
function rewriteRecords(taskId: string, payload: JsonValue): void {
  const project = openProject(dir);
  try {
    const rows = project.db
      .prepare("SELECT id FROM operation_records WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{ id: number }>;
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

describe("the replay index over a real prompt payload", () => {
  it("projects the recorded LlmOutput, so a bound output still resolves", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Payload", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    // What a real prompt executor would have written for the same two calls.
    rewriteRecords(taskId, llmPayload({ text: "hi" }));

    const replay = replayOf(taskId);
    // The op's value, NOT the envelope around it. Handing back the envelope is what made
    // `.operation.output.text` resolve to nothing and the state fail "required output 'text' was not
    // produced" — on a call that had already answered.
    expect(replay.unreadable).toEqual([]);
    expect(replay.answers.get("a#0")?.value).toEqual({ text: "hi" });
    expect(replay.answers.get("b#0")?.value).toEqual({ text: "hi" });
  }, 30000);

  /**
   * The other half of the discriminator, and the reason it is not the op kind alone.
   *
   * A SCRIPTED prompt executor reports no payload — it returns only the projected value, so
   * `withRecord` stores that — which means "this row came from a prompt op" does not tell you which
   * shape is in it. Unwrapping on the kind would corrupt every faked run instead of the real ones.
   */
  it("leaves a prompt row that already holds the projected value alone", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Flat", workflow: PROMPTED });
    await service.startTask({ taskId, fake: [{ output: { text: "hi" } }] as never });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");

    // Exactly what the scripted executor records today — no envelope to strip.
    rewriteRecords(taskId, { text: "hi" });

    const replay = replayOf(taskId);
    expect(replay.unreadable).toEqual([]);
    expect(replay.answers.get("a#0")?.value).toEqual({ text: "hi" });
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

    const replay = replayOf(taskId);
    expect(replay.answers.size).toBe(0);
    expect(replay.unreadable.map((u) => u.reason)).toEqual([
      "the record holds no readable value",
      "the record holds no readable value",
    ]);
  }, 30000);
});
