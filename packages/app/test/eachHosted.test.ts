/**
 * Decision 0003, end to end through the service: what `each: "split"` and `each: "task"` make of a
 * fan-out's elements, driven headlessly with scripted prompts.
 *
 * A split's task keeps element 0 and continues with it — retitled by it, split on the list at it —
 * and leaves one copy per OTHER element standing at the mount, with the task's history and the
 * element as its own, holding for what it requires and started the moment it holds for nothing —
 * or standing QUEUED for a person, where the wire says so. Every task in the batch carries the same
 * record at the mount and draws it from where it stands. A split over one element is no split at
 * all: the task runs the element itself and goes on. A mount's parent waits
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
function files(root: string, each: "split" | "task", start?: "manual" | "when_ready"): Record<string, unknown> {
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
        work: { inputs: { item: { $expr: ".children.decide.output.items", each, title: "title", ...(start !== undefined ? { start } : {}) } } },
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
  writeWorkflowFiles(paths.workflowsDir, { ...files("split/root", "split", "manual"), ...files("tasks/root", "task"), ...files("auto/root", "split") });
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

describe("each: \"split\" — element 0 stays in the task that split, the rest become copies", () => {
  it("continues here with element 0, retitled by it, and leaves a queued copy per other element sharing one record at the mount", async () => {
    const parent = service.createTask({ title: "the issue", workflow: "split/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to finish");

    const detail = service.taskDetail(parent);
    expect(detail.status).toBe("completed");
    // Alpha ran HERE: the mount, then `finish`, with the element as the mount's own — no task made of it.
    const children = detail.instances[0]!.children;
    expect(children.map((c) => c.childKey)).toEqual(["decide", "work", "finish"]);
    expect(children[1]!.inputs).toMatchObject({ item: { id: "a", title: "Alpha" } });
    expect(children[1]!.made).toBeUndefined();
    expect(detail.runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    // The task IS Alpha now: its element's title.
    expect(detail.title).toBe("Alpha");

    const tasks = service.listTasks();
    expect(tasks).toHaveLength(2);
    const beta = tasks.find((t) => t.taskId !== parent)!;
    expect([beta.title, beta.status, beta.workflow, beta.origin?.kind]).toEqual(["Beta", "queued", "split/root", "split"]);
    expect(beta.origin).toMatchObject({ taskId: parent, key: "work", index: 1, title: "Alpha" });

    // ONE line at the mount, in both conversations, from the same record — each reading it from
    // where it stands: the parent is itself in its own, Beta is itself in Beta's, and Beta waits for
    // the parent. Neither has a terminated turn for an element, and the parent's rail goes on inline.
    const mine = service.conversation(parent).turns.filter((t) => t.kind === "made");
    expect(mine.map((t) => t.path)).toEqual(["work"]);
    expect(mine[0]!.made).toMatchObject({
      kind: "split",
      runs: [
        { taskId: parent, element: 0, id: "a", title: "Alpha", self: true, waitsFor: false, status: "completed" },
        { taskId: beta.taskId, element: 1, id: "b", title: "Beta", self: false, waitsFor: false, status: "queued" },
      ],
    });
    const theirs = service.conversation(beta.taskId).turns.filter((t) => t.kind === "made");
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.made?.runs.map((run) => [run.taskId, run.self, run.waitsFor])).toEqual([
      [parent, false, true],
      [beta.taskId, true, false],
    ]);
    // The only element that ended HERE is the parent's own; Beta's end is Beta's.
    expect(service.conversation(parent).turns.filter((t) => t.kind === "terminated" && t.path?.startsWith("work[")).map((t) => t.path)).toEqual(["work[0]"]);
    expect(service.conversation(parent).turns.map((t) => [t.kind, t.path]).slice(0, 4)).toEqual([
      ["entered", ""],
      ["entered", "decide"],
      ["started", "decide"],
      ["output", "decide"],
    ]);

    // Beta stands at the mount on the parent's board, and beside the parent at the top level; the
    // parent itself came to rest where its run ended. Manual: nobody started Beta.
    const board = service.board("split/root");
    expect(board.columns.find((c) => c.key === "work")!.cards.map((c) => c.taskId)).toEqual([beta.taskId]);
    expect(board.columns.find((c) => c.key === "finish")!.cards.map((c) => c.taskId)).toEqual([parent]);
    const roots = service.boardRoots();
    expect(roots.columns.find((c) => c.key === "split/root")?.cards.map((c) => c.taskId).sort()).toEqual([parent, beta.taskId].sort());
  });

  it("refuses to start a copy while it holds, and resumes a released one from the mount with the parent's history", async () => {
    // Beta requires Gamma; Gamma requires nothing. Manual, so Gamma stands until somebody starts it.
    const THREE: FakeRule[] = [
      { model: "decider", output: { items: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", requires: ["c"] }, { id: "c", title: "Gamma" }] } },
      ...RULES.slice(1),
    ];
    const parent = service.createTask({ title: "the issue", workflow: "split/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: THREE });
    await until(() => finished(parent), "the parent to finish");
    const byTitle = new Map(service.listTasks().map((t) => [t.title, t]));
    const beta = byTitle.get("Beta")!;
    const gamma = byTitle.get("Gamma")!;
    expect(beta.waitingFor).toMatchObject([{ taskId: gamma.taskId, title: "Gamma", status: "queued" }]);

    await expect(service.resumeTask({ taskId: beta.taskId, fake: THREE })).rejects.toThrow(/waiting for 'Gamma' \(queued\)/);
    // A fresh start would run the parent's history again; the lifecycle refuses it for any task with history.
    await expect(service.startTask({ taskId: gamma.taskId, fake: THREE })).rejects.toThrow(/already has history/);

    // The copy's own plan: continue at the mount, nothing replayed twice.
    expect(service.resumable(gamma.taskId).kind).toBe("continue");
    await service.resumeTask({ taskId: gamma.taskId, fake: THREE });
    await until(() => finished(gamma.taskId), "Gamma to finish");
    const done = service.taskDetail(gamma.taskId);
    expect(done.status).toBe("completed");
    // Product's decision is in the copy's history, the mount ran ONCE with its own element, and the
    // mount read as an ordinary mount: `finish` was handed the doc, not a one-element array of it.
    const children = done.instances[0]!.children;
    expect(children.map((c) => c.childKey)).toEqual(["decide", "work", "finish"]);
    expect(children[1]!.inputs).toMatchObject({ item: { id: "c", title: "Gamma" } });
    expect(done.runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    expect(done.origin).toMatchObject({ kind: "split", taskId: parent });

    // Gamma completing releases Beta — which, manual, still waits for a person.
    expect(service.listTasks().find((t) => t.taskId === beta.taskId)?.waitingFor).toBeUndefined();
    expect(service.listTasks().find((t) => t.taskId === beta.taskId)?.status).toBe("queued");
    await service.resumeTask({ taskId: beta.taskId, fake: THREE });
    await until(() => finished(beta.taskId), "Beta to finish");
    expect(service.taskDetail(beta.taskId).status).toBe("completed");
  });
});

describe("each: \"split\" — a copy starts itself the moment it holds for nothing (the default)", () => {
  it("starts a copy that holds for nothing at once, and a dependent the moment its dependency completes", async () => {
    // Beta requires Alpha, which is the task that split: Beta starts when it completes.
    const parent = service.createTask({ title: "the issue", workflow: "auto/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: RULES });
    await until(() => finished(parent), "the parent to finish");
    const beta = service.listTasks().find((t) => t.taskId !== parent)!.taskId;
    await until(() => finished(beta), "Beta to finish once Alpha had", 12000);
    expect(service.taskDetail(beta)).toMatchObject({ status: "completed", origin: { kind: "split" } });
    expect(service.taskDetail(beta).runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    const ends = pushes.filter((m) => m.type === "run:finished").map((m) => (m as { taskId: string }).taskId);
    expect(ends.indexOf(parent)).toBeLessThan(ends.indexOf(beta));
  });

  it("holds the task that split when ITS element requires another, and goes on once that copy completes", async () => {
    const HELD: FakeRule[] = [{ model: "decider", output: { items: [{ id: "a", title: "Alpha", requires: ["b"] }, { id: "b", title: "Beta" }] } }, ...RULES.slice(1)];
    const parent = service.createTask({ title: "the issue", workflow: "auto/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: HELD });
    await until(() => finished(parent), "the parent to finish", 12000);
    const beta = service.listTasks().find((t) => t.taskId !== parent)!.taskId;
    // Beta was started by the split and finished FIRST; the parent waited for it at the mount, then
    // went on with Alpha — and the record, read from the parent, says Beta is what it waited for.
    const ends = pushes.filter((m) => m.type === "run:finished").map((m) => (m as { taskId: string }).taskId);
    expect(ends.indexOf(beta)).toBeLessThan(ends.indexOf(parent));
    expect(service.taskDetail(parent)).toMatchObject({ status: "completed", title: "Alpha" });
    expect(service.taskDetail(parent).runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    const line = service.conversation(parent).turns.find((t) => t.kind === "made")!;
    expect(line.made?.runs).toMatchObject([
      { taskId: parent, self: true, waitsFor: false },
      { taskId: beta, self: false, waitsFor: true, status: "completed" },
    ]);
  });
});

describe("each: \"split\" over one element", () => {
  it("is no split: the parent runs the element itself, continues past the mount, and makes no task", async () => {
    const ONE: FakeRule[] = [{ model: "decider", output: { items: [{ id: "a", title: "Alpha" }] } }, ...RULES.slice(1)];
    const parent = service.createTask({ title: "the issue", workflow: "auto/root", inputs: { issue: "split me" } }).taskId;
    await service.startTask({ taskId: parent, fake: ONE });
    await until(() => finished(parent), "the parent to finish");

    const detail = service.taskDetail(parent);
    expect(detail.status).toBe("completed");
    // The whole sequence ran here — `finish` included — with the one element as the mount's own, and
    // the mount read as an ordinary mount: `finish` was handed the doc, not a one-element array.
    const children = detail.instances[0]!.children;
    expect(children.map((c) => c.childKey)).toEqual(["decide", "work", "finish"]);
    expect(children[1]!.inputs).toMatchObject({ item: { id: "a", title: "Alpha" } });
    expect(children[1]!.made).toBeUndefined();
    expect(detail.runs[0]!.outputs).toMatchObject({ made: "worked", final: "done" });
    // Nothing was put beside the parent, and its conversation says nothing was made.
    expect(service.listTasks().map((t) => t.taskId)).toEqual([parent]);
    expect(service.conversation(parent).turns.some((t) => t.kind === "made")).toBe(false);
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
    // One line at the mount lists both — the parent made every element, so neither is itself.
    const line = service.conversation(parent).turns.filter((t) => t.kind === "made");
    expect(line.map((t) => t.path)).toEqual(["work"]);
    expect(line[0]!.made).toMatchObject({
      kind: "task",
      runs: [
        { taskId: made[0]!.taskId, element: 0, title: "Alpha", self: false, status: "completed" },
        { taskId: made[1]!.taskId, element: 1, title: "Beta", self: false, status: "completed" },
      ],
    });

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
