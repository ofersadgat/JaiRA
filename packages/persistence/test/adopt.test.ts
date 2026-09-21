/**
 * Adoption's bookkeeping (decision 0005 §2), below the service: what the plan READS out of a lowered
 * definition — a plain-path wire, the children a reference reads — what it checks recorded outputs
 * against, and the workspace hand-over against a real git repository. The end-to-end behaviour (the
 * engine reading the mirror rows, resume, rewind, the split shape) is `app/test/taskAdopt.test.ts`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { Git, NodeExec, writeWorkflowFiles } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { childrenReadBy, fitOutputs, missingInputs, plainInputOf, planAdoption, releaseUnmirroredAdoptions, settleAdoptions, writeAdoption } from "../src/adopt";
import { createTask, finishTaskRun, holdingOf, pinWorkflow } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { ensureWorkspace } from "../src/worktrees";

const str = { schema: { type: "string" } };
const FILES: Record<string, JsonValue> = {
  flow: {
    label: "Flow",
    inputs: { issue: str, depth: { schema: { type: "number" }, optional: true }, tone: { schema: { type: "string" }, default: "plain" } },
    outputs: { out: { schema: {}, binding: ".children.second.output.done", optional: true } },
    children: {
      first: { state: "flow/first", inputs: { issue: ".inputs.issue", depth: { $expr: ".inputs.depth + 1" } } },
      second: { state: "flow/second", inputs: { brief: ".children.first.output.brief", tone: ".inputs.tone" } },
    },
    sequence: ["first", "second"],
    transitions: [{ when: ".children.second.outcome == 'error'", to: "first" }],
  },
  "flow/first": {
    inputs: { issue: str, depth: { schema: { type: "number" }, optional: true } },
    outputs: { brief: { schema: { type: "object", required: ["steps"], properties: { steps: { type: "array", items: { type: "string" } } } } }, note: { schema: { type: "string" }, optional: true } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: "first?" } },
  },
  "flow/second": {
    inputs: { brief: { schema: {} }, tone: str },
    outputs: { done: { schema: { type: "boolean" } } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: "second?" } },
  },
};

const exec = new NodeExec();
let root: string;
let project: Project;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jaira-adopt-p-"));
  const projectDir = join(root, "proj");
  writeWorkflowFiles(initProject(projectDir, testHome()).workflowsDir, FILES);
  const git = new Git({ exec, repoDir: projectDir });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "JaiRA Test"]);
  writeFileSync(join(projectDir, "README.md"), "# project\n", "utf8");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "initial"]);
  project = openProject(projectDir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(root, { recursive: true, force: true });
});

/** A task that ran `flow/first` alone and completed with these outputs — recorded, not run. */
function finished(outputs: Record<string, JsonValue>, over: { branch?: string; inputs?: Record<string, JsonValue> } = {}): string {
  const meta = createTask(project, { title: "First", workflow: "flow/first", inputs: over.inputs ?? { issue: "the issue", depth: 3 }, ...(over.branch !== undefined ? { branch: over.branch } : {}) });
  finishTaskRun(project, meta.id, "completed", { outputs });
  return meta.id;
}

describe("reading a lowered definition", () => {
  it("finds the parent input a wire reads by a plain path, and nothing for an expression over one", async () => {
    const { bundle } = await pinWorkflow(project, "flow");
    const wires = bundle.states["flow"]!.children!["first"]!.inputs!;
    expect(plainInputOf(wires["issue"])).toBe("issue");
    expect(plainInputOf(wires["depth"])).toBeUndefined();
    expect(plainInputOf(bundle.states["flow"]!.children!["second"]!.inputs!["brief"])).toBeUndefined();
  });

  it("finds the children a wire, an output binding and a guard read", async () => {
    const { bundle } = await pinWorkflow(project, "flow");
    const def = bundle.states["flow"]!;
    expect([...childrenReadBy(def.children!["second"]!.inputs)]).toEqual(["first"]);
    expect([...childrenReadBy(def.outputs!["out"]!.binding)]).toEqual(["second"]);
    expect([...childrenReadBy(def.transitions)]).toEqual(["second"]);
    expect([...childrenReadBy(def.children!["first"]!.inputs)]).toEqual([]);
  });
});

describe("schema fit", () => {
  it("names the path that fails, skips what is optional, and asks the host's validator for shapes", async () => {
    const { bundle } = await pinWorkflow(project, "flow");
    const def = bundle.states["flow/first"]!;
    expect(fitOutputs(def, {})).toEqual({ path: "outputs.brief", message: "is required, and the task did not produce it" });
    expect(fitOutputs(def, { brief: { steps: [] } })).toBeUndefined();
    const check = (schema: JsonValue, value: JsonValue) => ((schema as { type?: string }).type === "object" && Array.isArray(value) ? { path: "/steps/0", message: "must be string" } : undefined);
    expect(fitOutputs(def, { brief: [] as JsonValue }, check)).toEqual({ path: "outputs.brief/steps/0", message: "must be string" });
  });
});

describe("the plan", () => {
  it("infers only plain-path inputs, applies literal defaults to the recorded entry, and asks for the rest", async () => {
    const first = finished({ brief: { steps: ["a"] } });
    const { bundle } = await pinWorkflow(project, "flow");
    const outcome = planAdoption(project, bundle, { workflow: "flow", targets: [{ taskId: first }] });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    const { plan, entered } = outcome.planned;
    // `depth` reaches the child through an expression, so what the child ran with says nothing of it.
    expect(plan.inputs).toEqual({ issue: "the issue" });
    expect(plan.provenance).toEqual({ issue: { via: "bound", from: { taskId: first, input: "issue" } } });
    expect(plan.asks.map((ask) => [ask.name, ask.required])).toEqual([["depth", false], ["tone", false]]);
    expect(missingInputs(plan)).toBeUndefined();
    expect(entered).toEqual({ issue: "the issue", tone: "plain" });
  });

  it("records a conversation's values as inferred, and never lets a form value override what the child ran with", async () => {
    const first = finished({ brief: { steps: [] } });
    const { bundle } = await pinWorkflow(project, "flow");
    const outcome = planAdoption(project, bundle, { workflow: "flow", targets: [{ taskId: first }], inputs: { issue: "something else", depth: 2 }, suppliedVia: "inferred" });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.planned.plan.inputs).toEqual({ issue: "the issue", depth: 2 });
    expect(outcome.planned.plan.provenance["depth"]).toEqual({ via: "inferred" });
  });
});

describe("the workspace comes along", () => {
  it("binds the parent to the adopted task's branch and worktree, so the next state reads what it wrote", async () => {
    const first = finished({ brief: { steps: [] } }, { branch: "feature/first" });
    const own = await ensureWorkspace(project, first);
    writeFileSync(join(own.root, "written-by-first.txt"), "here\n", "utf8");

    const pin = await pinWorkflow(project, "flow");
    const outcome = planAdoption(project, pin.bundle, { workflow: "flow", targets: [{ taskId: first }] });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.planned.plan.branch).toBe("feature/first");
    const parent = writeAdoption(project, pin, outcome.planned);

    expect(parent.branch).toBe("feature/first");
    expect(project.runtime.get(parent.id)).toMatchObject({ status: "queued", snapshotHash: pin.hash, worktreePath: own.root });
    const workspace = await ensureWorkspace(project, parent.id);
    expect(workspace).toMatchObject({ root: own.root, isWorktree: true, branch: "feature/first" });
    expect(existsSync(join(workspace.root, "written-by-first.txt"))).toBe(true);
    // The adopted task keeps its own binding: nothing was moved, the parent took it up.
    expect(project.tasks.read(first).branch).toBe("feature/first");
  });

  it("refuses two adopted tasks standing on different branches", async () => {
    const first = finished({ brief: { steps: [] } }, { branch: "one" });
    const second = createTask(project, { title: "Second", workflow: "flow/second", inputs: { brief: {}, tone: "x" }, branch: "two" }).id;
    finishTaskRun(project, second, "completed", { outputs: { done: true } });
    const { bundle } = await pinWorkflow(project, "flow");
    const outcome = planAdoption(project, bundle, { workflow: "flow", targets: [{ taskId: first }, { taskId: second }] });
    expect(outcome).toMatchObject({ ok: false, refusal: { code: "workspace" } });
  });
});

describe("a mirror left open", () => {
  it("is ended once the adopted task completes, releasing the parent — and un-adopted when the row is gone", async () => {
    const meta = createTask(project, { title: "First", workflow: "flow/first", inputs: { issue: "x" } });
    const pin = await pinWorkflow(project, "flow");
    const outcome = planAdoption(project, pin.bundle, { workflow: "flow", targets: [{ taskId: meta.id }] });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.planned.plan.waitsFor).toEqual([meta.id]);
    const parent = writeAdoption(project, pin, outcome.planned);
    expect(holdingOf(project, project.tasks.read(parent.id)).map((h) => h.taskId)).toEqual([meta.id]);
    expect(settleAdoptions(project, parent.id)).toEqual({ settled: [], misfits: [] });

    // It completes with something the pinned slots refuse: the mirror stays open, and the reason is returned.
    finishTaskRun(project, meta.id, "completed", { outputs: {} });
    expect(settleAdoptions(project, parent.id)).toEqual({ settled: [], misfits: [{ taskId: meta.id, reason: "outputs.brief is required, and the task did not produce it" }] });
    finishTaskRun(project, meta.id, "completed", { outputs: { brief: { steps: [] } } });
    expect(settleAdoptions(project, parent.id)).toEqual({ settled: [meta.id], misfits: [] });
    expect(project.events.list(parent.id).map((row) => row.type)).toEqual(["instance.entered", "instance.entered", "instance.terminated"]);
    expect(holdingOf(project, project.tasks.read(parent.id))).toEqual([]);

    // Still mirrored: nothing to release. With the rows gone, the task is its own again.
    expect(releaseUnmirroredAdoptions(project, parent.id)).toEqual([]);
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ?`).run(parent.id);
    expect(releaseUnmirroredAdoptions(project, parent.id)).toEqual([meta.id]);
    expect(project.tasks.read(meta.id).origin).toBeUndefined();
    expect(project.tasks.read(meta.id).parentTaskId).toBeUndefined();
    expect(project.tasks.read(parent.id).dependsOn).toBeUndefined();
  });
});
