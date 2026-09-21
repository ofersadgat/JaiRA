/**
 * `jaira task move <taskId> --to <state>` — `connect(task, target)` from a shell (decision 0005 §1).
 *
 * The resolutions and their rules are pinned in the app's `taskConnect.test.ts`; this pins the VERB:
 * that `--dry-run` answers the plan and changes nothing, that a refusal is exit 1 with the reason,
 * that `--skip` is what steps over states, and that a move which has to be taken is taken by running
 * the task here — reopening one that had finished — with one JSON document on stdout either way.
 *
 * Every state is a prompt answered by a scripted model, and how often a model was reached is the
 * assertion: a state moved back to runs again, a state stepped over never runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";

const TEXT = { type: "string" };
const leaf = (model: string, inputs: Record<string, JsonValue> = {}): JsonValue => ({
  label: model,
  inputs,
  outputs: { text: { schema: TEXT, binding: ".operation.output.text" } },
  operation: { model, prompt: `${model}.`, output: { text: { schema: TEXT } } },
});

function files(): Record<string, JsonValue> {
  return {
    flow: {
      label: "Flow",
      environment: { kind: "prompt", model: "nobody" },
      children: { a: { state: "flow/a" }, b: { state: "flow/b" }, c: { state: "flow/c" }, d: { state: "flow/d" } },
      sequence: ["a", "b", "c", "d"],
    },
    "flow/a": leaf("a"),
    "flow/b": leaf("b"),
    "flow/c": leaf("c"),
    "flow/d": leaf("d"),
    // A phase somebody runs alone, and the workflow that mounts it.
    feat: {
      label: "Feature",
      environment: { kind: "prompt", model: "nobody" },
      children: { product: { state: "feat/product" }, ux: { state: "feat/ux", inputs: { brief: ".children.product.output.text" } } },
      sequence: ["product", "ux"],
    },
    "feat/product": leaf("product"),
    "feat/ux": leaf("ux", { brief: { schema: TEXT } }),
  };
}

const rules = (failing?: string): JsonValue =>
  ["a", "b", "c", "d", "product", "ux"].map((model): JsonValue => (model === failing ? { model, error: `${model} broke` } : { model, output: { text: `${model} said` } }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-cli-move-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string; json: () => Record<string, unknown> }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> };
}

async function ran(workflow: string, failing?: string): Promise<string> {
  const created = await cli(["task", "create", "--title", `Ran ${workflow}`, "--workflow", workflow]);
  const taskId = (created.json() as { taskId: string }).taskId;
  await cli(["task", "start", taskId, "--fake", JSON.stringify(rules(failing))]);
  return taskId;
}

/** `[child key, outcome]` for every ended child, in journal order. */
function ended(taskId: string): Array<[string, string]> {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    const keyOf = new Map<string, string>();
    const out: Array<[string, string]> = [];
    for (const { event } of project.events.list(taskId)) {
      if (event.type === "instance.entered" && event.childKey !== undefined) keyOf.set(event.instanceId, event.childKey);
      if (event.type === "instance.terminated" && keyOf.has(event.instanceId)) out.push([keyOf.get(event.instanceId)!, event.outcome]);
    }
    return out;
  } finally {
    project.close();
  }
}

describe("jaira task move", () => {
  it("--dry-run answers the plan and changes nothing; the move reopens a finished task and runs it from there", async () => {
    const taskId = await ran("flow");
    const before = ended(taskId);
    const dry = await cli(["task", "move", taskId, "--to", "flow/c", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.json()).toMatchObject({ ok: true, dryRun: true, taskId, plan: { resolution: "move", workflow: "flow", standsAt: { path: ["c"], stateId: "flow/c" }, move: { direction: "backward", to: "c" } } });
    expect(ended(taskId)).toEqual(before);

    const moved = await cli(["task", "move", taskId, "--to", "flow/c", "--fake", JSON.stringify(rules())]);
    expect(moved.err).toContain(`connect: move — ${taskId} will stand at 'c' in 'flow'`);
    expect(moved.code).toBe(0);
    // ONE document on stdout: the run's report.
    expect(moved.json()).toMatchObject({ taskId, status: "completed" });
    // `c` and `d` again, as the next pass — `a` and `b` were not asked twice.
    expect(ended(taskId).map(([key]) => key)).toEqual(["a", "b", "c", "d", "c", "d"]);
  });

  it("refuses to step over states without --skip (exit 1, the reason on both streams), and steps over them with it", async () => {
    const taskId = await ran("flow", "b"); // failed in `b`: `c` and `d` never ran
    const refused = await cli(["task", "move", taskId, "--to", "flow/d"]);
    expect(refused.code).toBe(1);
    expect(refused.json()).toMatchObject({ ok: false, refusal: { code: "fast-forward" }, plan: { move: { direction: "forward", passes: ["c"], stepsPast: "b" } } });
    expect(refused.err).toContain("refused: 'd' is ahead of where the task stands, past 'c'.");

    const skipped = await cli(["task", "move", taskId, "--to", "flow/d", "--skip", "--fake", JSON.stringify(rules())]);
    expect(skipped.code).toBe(0);
    expect(skipped.json()).toMatchObject({ taskId, status: "completed" });
    // The state it had stopped in is stepped past too — nothing is running there to wait for — and
    // `c`, which never ran, is recorded as passed over rather than left absent.
    expect(ended(taskId)).toEqual([
      ["a", "success"],
      ["b", "skipped"],
      ["c", "skipped"],
      ["d", "success"],
    ]);
  });

  it("adopts a phase that ran alone into the workflow that mounts it, and runs what is left", async () => {
    const product = await ran("feat/product");
    const dry = await cli(["task", "move", product, "--to", "feat", "--dry-run"]);
    expect(dry.json()).toMatchObject({ ok: true, plan: { resolution: "adopt", workflow: "feat", adoptedAs: "product", standsAt: { path: ["ux"] } } });

    const moved = await cli(["task", "move", product, "--to", "feat/ux", "--workflow", "feat", "--fake", JSON.stringify(rules())]);
    expect(moved.code).toBe(0);
    const report = moved.json() as { taskId: string; status: string };
    expect(report.status).toBe("completed");
    expect(report.taskId).not.toBe(product);
    // The parent ran `ux` and nothing else: `product` is the adopted task's.
    expect(ended(report.taskId).filter(([, outcome]) => outcome === "success").map(([key]) => key)).toEqual(["product", "ux"]);
    const project = openProject(dir, { baseDir: testHome() });
    try {
      expect(project.tasks.read(product).origin).toMatchObject({ kind: "adopt", taskId: report.taskId, key: "product" });
    } finally {
      project.close();
    }
  });

  it("says what it needs", async () => {
    expect((await cli(["task", "move"])).code).not.toBe(0);
    expect((await cli(["task", "move", "t-1"])).err).toContain("task move requires --to <stateId>");
  });
});
