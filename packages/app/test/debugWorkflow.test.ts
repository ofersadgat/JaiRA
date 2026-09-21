/**
 * The Debug view's self-test workflow, run headlessly.
 *
 * The pane's whole claim is that a green result means the wiring works, so the workflow behind it
 * has to be checked by something other than the pane. This runs it through the real `AppService`
 * with the scripted executor: it lints on start (a task start runs the same validation
 * `workflow lint` does), the sequence advances, and — the part that matters — `check` is judged
 * against what `say` actually produced rather than against nothing.
 *
 * Nothing is written before it runs. The three states ship in the built-in layer (decision 0006), so
 * an empty project over an EMPTY shared root resolves them; the install step this file used to
 * imitate is gone. That also makes this the test that the scripted replies in `debugWorkflow.ts`
 * still match the prompts in the shipped files — they are matched by text, in two places.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { verdictOf } from "../src/renderer/debugPane";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestScript } from "../src/renderer/debugWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-debug-"));
  initProject(dir, testHome());
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

describe("the Debug view's self-test workflow", () => {
  it("finds all three states in what ships, and installs nothing to find them", () => {
    for (const stateId of SELF_TEST_STATES) {
      expect(service.readWorkflow({ stateId, layer: "system" }).exists).toBe(true);
      expect(service.readWorkflow({ stateId, layer: "base" }).exists).toBe(false);
      expect(service.readWorkflow({ stateId, layer: "project" }).exists).toBe(false);
    }
    // The layout `init` makes is there; no state file is in it.
    const shared = join(testHome(), "workflows");
    expect(existsSync(shared) ? readdirSync(shared) : []).toEqual([]);
  });

  it("projects a board of the two stages, in order", () => {
    service.createTask({ title: "Self-test", workflow: SELF_TEST_ROOT });
    const board = service.board();
    expect(board.level).toBe(SELF_TEST_ROOT);
    expect(board.columns.map((c) => c.key)).toEqual(["say", "check"]);
  });

  it("runs both stages and publishes the verdict as the run's outputs", async () => {
    const { taskId } = service.createTask({ title: "Self-test", workflow: SELF_TEST_ROOT });
    await service.startTask({ taskId, fake: selfTestScript() });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");

    const detail = service.taskDetail(taskId);
    const run = detail.runs[detail.runs.length - 1]!;
    expect(run.outcome).toBe("success");
    expect(run.outputs).toMatchObject({ greeting: "Hello, world!", passed: true });

    // Both stages ran, in the declared order — the sequence, not just the leaf.
    const stages = detail.instances[0]?.children.map((c) => c.childKey) ?? [];
    expect(stages).toEqual(["say", "check"]);
  });

  it("carries the first stage's output into the second stage's prompt", async () => {
    const { taskId } = service.createTask({ title: "Self-test", workflow: SELF_TEST_ROOT });
    await service.startTask({ taskId, fake: selfTestScript() });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");

    // The claim the whole self-test rests on: the judging state was shown the greeting, not a hole.
    // Read off the stored transcript rather than off the executor, because the transcript is what
    // the pane shows — if the prompt reaching the model had an empty hole in it, so would this.
    const judging = service
      .sessionHistory({ taskId })
      .find((ref) => ref.stateId === `${SELF_TEST_ROOT}/check`);
    expect(judging).toBeDefined();
    const session = service.sessionView({ taskId, instanceId: judging!.instanceId });
    expect(JSON.stringify(session.turns)).toContain("Hello, world!");
  });
});

/**
 * The pane calls a pass a pass only when the run said so in as many words.
 *
 * Worth its own test because the value comes off a MODEL: everything else here is engine output with
 * a schema behind it, and this is the one place where a truthiness check would turn "the run never
 * got there" into a green banner.
 */
describe("the Debug view's verdict", () => {
  it("is a pass only for a literal true", () => {
    expect(verdictOf({ passed: true }).passed).toBe(true);
    expect(verdictOf({ passed: false }).passed).toBe(false);
  });

  it("is no verdict at all for anything else", () => {
    for (const outputs of [null, undefined, {}, [], "passed", { passed: "true" }, { passed: 1 }]) {
      expect(verdictOf(outputs).passed).toBeNull();
    }
  });

  it("carries the greeting and the judgement when they are strings", () => {
    expect(verdictOf({ passed: true, greeting: "Hello, world!", verdict: "it did" })).toEqual({
      passed: true,
      greeting: "Hello, world!",
      verdict: "it did",
    });
    // A non-string is dropped rather than rendered — the pane shows these as text.
    expect(verdictOf({ passed: true, greeting: 7 })).toEqual({ passed: true });
  });
});
