/**
 * Decision 0003, end to end through the service: what `each: "split"` and `each: "task"` make of a
 * fan-out's elements, driven headlessly with scripted prompts.
 *
 * A split's parent ends at the mount and leaves one QUEUED copy per element standing at it, with the
 * parent's history and the element as its own, holding for what it requires. A mount's parent waits
 * for the tasks it made and reads their outputs back gathered. Both kinds file where the decision
 * says: a split copy beside its parent at the top level, a mount task in its parent's column and
 * nowhere at the top.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { writeWorkflowFiles, type FakeRule } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

const str = () => ({ schema: { type: "string" } });
const ITEM = { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" }, requires: { type: "array", items: { type: "string" } } } };

/** decide (a list) → work (fanned out, `each` as given) → finish (reads work's doc). */
function files(root: string, each: "split" | "task", start?: "when_ready"): Record<string, unknown> {
  return {
    [root]: {
      label: "Root",
      environment: { kind: "prompt", model: "decider" },
      inputs: { issue: str() },
      outputs: {
        made: { schema: {}, binding: ".children.work.output.doc", optional: true },
        final: { schema: { type: "string" }, binding: ".children.finish.output.final", optional: true },
      },
      children: {
        decide: { inputs: { issue: ".inputs.issue" } },
        work: { inputs: { item: { expr: ".children.decide.output.items", each, title: "title", ...(start !== undefined ? { start } : {}) } } },
        finish: { inputs: { doc: ".children.work.output.doc" } },
      },
      sequence: ["decide", "work", "finish"],
    },
    [`${root}/decide`]: {
      label: "Decide",
      inputs: { issue: str() },
      outputs: { items: { schema: { type: "array", items: ITEM }, binding: ".operation.output.items" } },
      operation: { prompt: "Decide {{.inputs.issue}}.", output: { items: { schema: { type: "array", items: ITEM } } } },
    },
    [`${root}/work`]: {
      label: "Work",
      inputs: { item: { schema: ITEM } },
      outputs: { doc: { ...str(), binding: ".operation.output.doc" } },
      operation: { model: "worker", prompt: "Work on {{.inputs.item.title}}.", output: { doc: str() } },
    },
    [`${root}/finish`]: {
      label: "Finish",
      inputs: { doc: { schema: {} } },
      outputs: { final: { ...str(), binding: ".operation.output.final" } },
      operation: { model: "finisher", prompt: "Finish {{.inputs.doc}}.", output: { final: str() } },
    },
  };
}

const RULES: FakeRule[] = [
  { model: "decider", output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", requires: ["a"] }] } },
  { model: "worker", output: { doc: "worked" } },
  { model: "finisher", output: { final: "done" } },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-each-"));
  const paths = initProject(dir, testHome());
  writeWorkflowFiles(paths.workflowsDir, { ...files("split/root", "split"), ...files("tasks/root", "task"), ...files("auto/root", "split", "when_ready") });
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

const finished = (taskId: string): boolean => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

describe("each: \"split\" — one task per element, standing at the mount", () => {
  it("ends the parent at the mount and leaves a queued copy per element, holding for what it requires", async () => {
    const parent = service.createTask({ title: "the issue", workflow: "split/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to end");

    const detail = service.taskDetail(parent);
    expect(detail.status).toBe("completed");
    // The parent stopped at the mount: `finish` never ran here.
    const keys = detail.instances[0]!.children.map((c) => c.childKey);
    expect(keys).toContain("decide");
    expect(keys).not.toContain("finish");
    // The mount's elements are places in the parent's rail — mirrored, one per copy.
    expect(detail.instances[0]!.children.filter((c) => c.childKey === "work").map((c) => c.element)).toEqual([0, 1]);

    const tasks = service.listTasks();
    const copies = tasks.filter((t) => t.taskId !== parent).sort((a, b) => a.title.localeCompare(b.title));
    expect(copies.map((t) => [t.title, t.status, t.workflow])).toEqual([
      ["Alpha", "queued", "split/root"],
      ["Beta", "queued", "split/root"],
    ]);
    expect(copies.map((t) => t.origin?.kind)).toEqual(["split", "split"]);
    expect(copies[0]!.origin).toMatchObject({ taskId: parent, key: "work", index: 0, title: "the issue" });
    // Beta requires Alpha, so it holds for Alpha; Alpha holds for nothing.
    expect(copies[0]!.waitingFor).toBeUndefined();
    expect(copies[1]!.waitingFor).toMatchObject([{ taskId: copies[0]!.taskId, title: "Alpha", status: "queued" }]);
    // The mirrored element's instance id IS the copy's id, and the node says it was made.
    const elements = detail.instances[0]!.children.filter((c) => c.childKey === "work");
    expect(elements.map((c) => c.instanceId)).toEqual(copies.map((t) => t.taskId));
    expect(elements.map((c) => c.made?.kind)).toEqual(["split", "split"]);
    // In the parent's conversation the elements are lines saying what was made — not entries, and
    // not terminations — carrying the copies' titles and standing.
    const made = service.conversation(parent).turns.filter((t) => t.kind === "made");
    expect(made.map((t) => [t.path, t.made?.title, t.made?.status, t.made?.holding])).toEqual([
      ["work[0]", "Alpha", "queued", 0],
      ["work[1]", "Beta", "queued", 1],
    ]);
    expect(service.conversation(parent).turns.some((t) => t.kind === "terminated" && t.path?.startsWith("work["))).toBe(false);
    // A split copy's line knows the copy's seam, so a nested view can start past it.
    expect(made[0]!.made?.boundary).toBeGreaterThan(0);

    // Each copy stands AT the mount: on the parent's board it is in the `work` column, holding.
    const board = service.board("split/root");
    const work = board.columns.find((c) => c.key === "work")!;
    expect(work.cards.map((c) => c.taskId).sort()).toEqual([parent, ...copies.map((t) => t.taskId)].sort());
    expect(work.cards.find((c) => c.taskId === copies[1]!.taskId)?.waitingFor).toHaveLength(1);
    // And at the top level both copies are features beside their parent, not inside it.
    const roots = service.boardRoots();
    expect(roots.columns.find((c) => c.key === "split/root")?.cards.map((c) => c.taskId).sort()).toEqual([parent, ...copies.map((t) => t.taskId)].sort());
  });

  it("refuses to start a holding copy, resumes a released one from the mount with the parent's history, then releases the dependent", async () => {
    const parent = service.createTask({ title: "the issue", workflow: "split/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to end");
    const [alpha, beta] = service
      .listTasks()
      .filter((t) => t.taskId !== parent)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((t) => t.taskId) as [string, string];

    await expect(service.resumeTask({ taskId: beta, fake: RULES })).rejects.toThrow(/waiting for 'Alpha' \(queued\)/);
    // A fresh start would run the parent's history again; the lifecycle refuses it for any task with history.
    await expect(service.startTask({ taskId: alpha, fake: RULES })).rejects.toThrow(/already has history/);

    // The copy's own plan: continue at the mount, nothing replayed twice.
    expect(service.resumable(alpha).kind).toBe("continue");
    await service.resumeTask({ taskId: alpha, fake: RULES });
    await until(() => finished(alpha), "Alpha to finish");
    const done = service.taskDetail(alpha);
    expect(done.status).toBe("completed");
    // Product's decision is in the copy's history, the mount ran ONCE with its own element, and the
    // mount read as an ordinary mount: `finish` was handed the doc, not a one-element array of it.
    const children = done.instances[0]!.children;
    expect(children.map((c) => c.childKey)).toEqual(["decide", "work", "finish"]);
    expect(children[1]!.inputs).toMatchObject({ item: { id: "a", title: "Alpha" } });
    expect(done.runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    expect(done.origin).toMatchObject({ kind: "split", taskId: parent });

    // Alpha completing releases Beta.
    expect(service.listTasks().find((t) => t.taskId === beta)?.waitingFor).toBeUndefined();
    await service.resumeTask({ taskId: beta, fake: RULES });
    await until(() => finished(beta), "Beta to finish");
    expect(service.taskDetail(beta).status).toBe("completed");
  });
});

describe("each: \"split\" with start: \"when_ready\"", () => {
  it("starts what holds for nothing as soon as it is made, and each dependent the moment its dependencies complete", async () => {
    const parent = service.createTask({ title: "the issue", workflow: "auto/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to end");
    const [alpha, beta] = service
      .listTasks()
      .filter((t) => t.taskId !== parent)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((t) => t.taskId) as [string, string];
    // Nobody presses Start: Alpha was started by the split, and Beta by Alpha completing.
    await until(() => finished(alpha), "Alpha to finish on its own", 12000);
    await until(() => finished(beta), "Beta to finish once Alpha had", 12000);
    expect(service.taskDetail(alpha)).toMatchObject({ status: "completed", origin: { kind: "split" } });
    expect(service.taskDetail(beta)).toMatchObject({ status: "completed" });
    expect(service.taskDetail(beta).runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    const ends = pushes.filter((m) => m.type === "run:finished").map((m) => (m as { taskId: string }).taskId);
    expect(ends.indexOf(alpha)).toBeLessThan(ends.indexOf(beta));
  });
});

describe("each: \"task\" — one task per element, under the parent", () => {
  it("makes a task per element, waits for them in order, and reads their outputs back gathered", async () => {
    const parent = service.createTask({ title: "the issue", workflow: "tasks/root", inputs: { issue: "fan me out" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to finish", 12000);

    const detail = service.taskDetail(parent);
    expect(detail.status).toBe("completed");
    // Gathered, as an inline batch's outputs are — and `finish` ran here, after them.
    expect(detail.runs[0]!.outputs).toMatchObject({ made: ["worked", "worked"], final: "done" });
    expect(detail.instances[0]!.children.map((c) => c.childKey)).toEqual(["decide", "work", "work", "finish"]);

    const made = service
      .listTasks()
      .filter((t) => t.taskId !== parent)
      .sort((a, b) => a.title.localeCompare(b.title));
    expect(made.map((t) => [t.title, t.status, t.workflow, t.origin?.kind])).toEqual([
      ["Alpha", "completed", "tasks/root/work", "task"],
      ["Beta", "completed", "tasks/root/work", "task"],
    ]);
    // Alpha was made and finished before Beta was made: the batch is sequential.
    const finishes = pushes.filter((m) => m.type === "run:finished").map((m) => (m as { taskId: string }).taskId);
    expect(finishes.indexOf(made[0]!.taskId)).toBeLessThan(finishes.indexOf(made[1]!.taskId));
    // The mirrored elements carry the tasks' ids and their ends.
    const elements = detail.instances[0]!.children.filter((c) => c.childKey === "work");
    expect(elements.map((c) => c.instanceId)).toEqual(made.map((t) => t.taskId));
    expect(elements.every((c) => c.status === "completed")).toBe(true);

    // Filed in the parent's `work` column on the parent's board — the parent itself came to rest in
    // `finish`, where its run ended — and NOT at the top level.
    const board = service.board("tasks/root");
    const work = board.columns.find((c) => c.key === "work")!;
    expect(work.cards.map((c) => c.taskId).sort()).toEqual(made.map((t) => t.taskId).sort());
    expect(board.columns.find((c) => c.key === "finish")!.cards.map((c) => c.taskId)).toEqual([parent]);
    const roots = service.boardRoots();
    expect(roots.columns.find((c) => c.key === "tasks/root")?.cards.map((c) => c.taskId)).toEqual([parent]);
    expect(roots.columns.some((c) => c.key === "tasks/root/work")).toBe(false);
  });
});
