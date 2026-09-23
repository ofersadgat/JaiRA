/**
 * A connect that stops part-way, and the retry that finishes it (decision 0005, "A connect that stops
 * part-way", 2026-09-22).
 *
 * The person's ruling: before a real connect writes anything, ONE durable record of its intent — the
 * task and target, the resolution chosen, the supplied inputs, the steps — is written on the dragged
 * task's journal; each step marks itself done there; a retry (and the next open after a crash) reads
 * it and runs only what is not done, so the drop finishes as first intended and is never re-resolved.
 *
 * Driven through `connectTask` with the CLI's shape of host — `adoptTaskIn` for real, and a move that
 * journals what the app's does (a held move) — over real state files, because what is being checked
 * is what gets WRITTEN: one document, one version, one parent task, one adoption, one move, however
 * many times the drop is made.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { CONNECT_EVENT, MOVE_HELD_EVENT, type ConnectEvent, type TaskConnectResult, type TaskMoveRequest } from "@jaira/shared";
import { adoptTaskIn, connectTask, type ConnectHost } from "../src/connect";
import { listDocuments } from "../src/documents";
import { openConnectIntent, recordHostRow } from "../src/hostRows";
import { beginTaskRun, createTask, finishTaskRun } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";

const STRING = { type: "string" };

/** A prompt leaf that lints clean: every output declared on the call and bound from it. */
const leaf = (label: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>): Record<string, unknown> => ({
  label,
  inputs: Object.fromEntries(Object.entries(inputs).map(([name, schema]) => [name, { schema }])),
  outputs: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema, binding: `.operation.output.${name}` }])),
  operation: {
    kind: "prompt",
    prompt: `do ${label}`,
    model: "anthropic/claude-sonnet-5",
    output: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema }])),
  },
});

const FILES: Record<string, unknown> = {
  "chat/standin": leaf("Conversation", {}, { said: STRING }),
  "lib/product": leaf("Product", { idea: STRING }, { brief: STRING }),
  "lib/review": leaf("Review", { brief: STRING }, { verdict: STRING }),
};

let dir: string;
let project: Project;
let clock = 10_000;
const tick = (): number => (clock += 10);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-intent-"));
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

/** A task that ran `lib/product` alone, to the end. */
async function finishedProduct(taskId = "t-product"): Promise<string> {
  createTask(project, { id: taskId, title: "Product", workflow: "lib/product", inputs: { idea: "a board game" } });
  await beginTaskRun(project, taskId, { nowMs: tick() });
  const recorder = project.events.recorder(taskId);
  recorder.record({ type: "instance.entered", instanceId: `${taskId}-root`, stateId: "lib/product", inputs: { idea: "a board game" } } as EngineEvent, tick());
  recorder.record({ type: "instance.terminated", instanceId: `${taskId}-root`, stateId: "lib/product", outcome: "success" } as EngineEvent, tick());
  finishTaskRun(project, taskId, "completed", { outputs: { brief: "a brief" } }, tick());
  return taskId;
}

/** The host a drop is made through; `failAt` stops the connect at that step, once. */
function hostFor(moves: TaskMoveRequest[], failAt?: { kind: string; how: "throw" | "refuse" }): ConnectHost {
  let failed = false;
  return {
    conversation: "chat/standin",
    adopt: async (request) => {
      if (failAt?.kind === "adopt" && failAt.how === "refuse" && !failed) {
        failed = true;
        return { ok: false, dryRun: false, refusal: { code: "parent-state", message: "the parent is busy" } };
      }
      return adoptTaskIn(project, request);
    },
    // What the app's move leaves in a journal the moment it is handed over: a held move.
    move: async (request) => {
      moves.push(request);
      recordHostRow(project, request.taskId, { type: MOVE_HELD_EVENT, to: request.toState, by: request.by ?? "person" });
      return { taskId: request.taskId, status: "held" };
    },
    onStep: (step) => {
      if (failAt?.kind === step.kind && failAt.how === "throw" && !failed) {
        failed = true;
        throw new Error(`the process fell over during ${step.kind}`);
      }
    },
  };
}

const ok = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: true }> => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result;
};

const connectRows = (taskId: string): ConnectEvent[] =>
  project.events
    .list(taskId)
    .map((row) => row.event as unknown as ConnectEvent)
    .filter((e) => (e as { type: string }).type === CONNECT_EVENT);

/** Everything the drop could have made twice. */
function made(source: string): { documents: number; versions: number; parents: string[]; mirrors: number } {
  const documents = listDocuments(project.paths.snapshotsDir).filter((doc) => doc.kind === "dynamic");
  const parents = project.tasks.list().filter((meta) => meta.id !== source && project.runtime.get(meta.id)?.documentId !== undefined).map((meta) => meta.id);
  const mirrors = parents.flatMap((id) => project.events.list(id)).filter((row) => row.type === "instance.entered" && row.instanceId === source).length;
  return { documents: documents.length, versions: documents.reduce((n, doc) => n + doc.versions.length, 0), parents, mirrors };
}

const DROP = { taskId: "t-product", target: "lib/review" } as const;

describe("the intent is written before anything else, and closed when every step is done", () => {
  it("journals the resolution and its steps, each step done, then done — on the dragged task", async () => {
    await finishedProduct();
    const moves: TaskMoveRequest[] = [];
    const result = ok(await connectTask(project, DROP, hostFor(moves)));
    expect(result.plan).toMatchObject({ resolution: "modify", modification: "new" });
    const rows = connectRows("t-product");
    expect(rows.map((row) => row.at)).toEqual(["intent", "step", "step", "step", "step", "done"]);
    const intent = rows[0] as Extract<ConnectEvent, { at: "intent" }>;
    expect(intent.intent.request).toEqual(DROP);
    expect(intent.intent.plan).toMatchObject({ resolution: "modify", modification: "new" });
    expect(intent.intent.steps.map((step) => step.kind)).toEqual(["document", "parent", "adopt", "move"]);
    // The Undo is measured from these rows: its mark is the intent's.
    expect(result.undo).toMatchObject({ kind: "adopt", adoptedTaskId: "t-product", parentTaskId: result.taskId, made: true, mark: intent.mark });
    // …and the parent's journal closes the drop's own writes too.
    expect(connectRows(result.taskId!).map((row) => row.at)).toEqual(["done"]);
    expect(openConnectIntent(project, "t-product")).toBeUndefined();
    expect(made("t-product")).toMatchObject({ documents: 1, versions: 1, parents: [result.taskId], mirrors: 1 });
    expect(moves).toHaveLength(1);
  });
});

describe("a retry finishes the drop it stopped — never a second document, adoption or move", () => {
  const whole = async (): Promise<Extract<TaskConnectResult, { ok: true }>> => {
    const moves: TaskMoveRequest[] = [];
    return ok(await connectTask(project, DROP, hostFor(moves)));
  };

  for (const kind of ["document", "parent", "adopt", "move"]) {
    it(`stopped at the ${kind} step, the same drop again carries on from it`, async () => {
      await finishedProduct();
      const moves: TaskMoveRequest[] = [];
      await expect(connectTask(project, DROP, hostFor(moves, { kind, how: "throw" }))).rejects.toThrow(`the process fell over during ${kind}`);
      const open = openConnectIntent(project, "t-product")!;
      expect(open.stopped).toMatchObject({ reason: `the process fell over during ${kind}` });
      expect(open.results.filter((result) => result !== undefined)).toHaveLength(["document", "parent", "adopt", "move"].indexOf(kind));

      // The retry: the same drop, through a host that no longer fails.
      const result = ok(await connectTask(project, DROP, hostFor(moves)));
      const { documents, versions, parents, mirrors } = made("t-product");
      expect({ documents, versions, parents: parents.length, mirrors }).toEqual({ documents: 1, versions: 1, parents: 1, mirrors: 1 });
      expect(result.taskId).toBe(parents[0]);
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ taskId: parents[0] });
      // ONE intent, carried through: its mark is the Undo's, and it is closed.
      const rows = connectRows("t-product");
      expect(rows.filter((row) => row.at === "intent")).toHaveLength(1);
      expect(result.undo).toMatchObject({ kind: "adopt", mark: rows[0]!.mark });
      expect(rows.at(-1)!.at).toBe("done");
      expect(openConnectIntent(project, "t-product")).toBeUndefined();
      // And it answers what an uninterrupted drop answers.
      expect(result.plan).toMatchObject({ resolution: "modify", modification: "new", adoptedAs: expect.any(String), standsAt: { stateId: "lib/review" } });
    });
  }

  it("recognises a step that RAN and was never marked — the process died between the two", async () => {
    await finishedProduct();
    const first = await whole();
    // As if the process died after the move was handed over and before anything said so: the move's
    // `step` row and the `done` rows are gone, the move itself is in the journal.
    const rows = project.events.list("t-product");
    const lastTwo = rows.slice(-2).map((row) => row.seq);
    project.db.prepare(`DELETE FROM state_machine_events WHERE seq IN (${lastTwo.join(",")})`).run();
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND type = ?`).run(first.taskId, CONNECT_EVENT);
    expect(openConnectIntent(project, "t-product")?.results.filter((r) => r !== undefined)).toHaveLength(3);

    const moves: TaskMoveRequest[] = [];
    const again = ok(await connectTask(project, DROP, hostFor(moves)));
    expect(again.taskId).toBe(first.taskId);
    expect(moves).toHaveLength(0);
    expect(made("t-product")).toMatchObject({ documents: 1, versions: 1, parents: [first.taskId], mirrors: 1 });
    expect(openConnectIntent(project, "t-product")).toBeUndefined();
  });

  it("recognises a document and a parent that were made and never marked", async () => {
    await finishedProduct();
    const first = await whole();
    // Back to just after the intent: every later connect row gone, and what the steps made still there.
    const intentSeq = project.events.list("t-product").find((row) => (row.type as string) === CONNECT_EVENT)!.seq;
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = 't-product' AND type = ? AND seq > ?`).run(CONNECT_EVENT, intentSeq);
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND type = ?`).run(first.taskId, CONNECT_EVENT);
    const moves: TaskMoveRequest[] = [];
    const again = ok(await connectTask(project, DROP, hostFor(moves)));
    expect(again.taskId).toBe(first.taskId);
    // The adoption was there, and so was the held move: nothing is done twice.
    expect(moves).toHaveLength(0);
    expect(made("t-product")).toMatchObject({ documents: 1, versions: 1, parents: [first.taskId], mirrors: 1 });
  });

  it("gives the same refusal again while nothing has changed, and writes nothing more", async () => {
    await finishedProduct();
    const moves: TaskMoveRequest[] = [];
    const host = hostFor(moves, { kind: "adopt", how: "refuse" });
    const refused = await connectTask(project, DROP, host);
    expect(refused).toMatchObject({ ok: false, refusal: { code: "adopt" } });
    const message = (refused as { refusal: { message: string } }).refusal.message;
    expect(message).toMatch(/the workflow was made \(d-.*\) and 'Product' \(t-.*\) stands in it, but 'Product' could not be adopted into it: the parent is busy/);
    expect(openConnectIntent(project, "t-product")?.stopped?.reason).toBe(message);
    // The second attempt (the host's own refusal passed) finishes — into the SAME document and task.
    const result = ok(await connectTask(project, DROP, host));
    expect(made("t-product")).toMatchObject({ documents: 1, versions: 1, parents: [result.taskId], mirrors: 1 });
  });

  it("refuses a DIFFERENT drop of the task while one is not finished, and writes nothing", async () => {
    await finishedProduct();
    const moves: TaskMoveRequest[] = [];
    await expect(connectTask(project, DROP, hostFor(moves, { kind: "adopt", how: "throw" }))).rejects.toThrow();
    const before = project.events.list("t-product").length;
    const other = await connectTask(project, { taskId: "t-product", target: "chat/standin" }, hostFor(moves));
    expect(other).toMatchObject({ ok: false, refusal: { code: "connecting" } });
    expect((other as { refusal: { message: string } }).refusal.message).toBe(
      "'Product' is still being moved to 'lib/review' — it stopped at the adoption: the process fell over during adopt. Drop it there again to finish that move first",
    );
    expect(project.events.list("t-product")).toHaveLength(before);
    // A dry run of the SAME drop says what it will finish, and writes nothing either.
    const dry = ok(await connectTask(project, { ...DROP, dryRun: true }, hostFor(moves)));
    expect(dry.plan).toMatchObject({ resolution: "modify", modification: "new" });
    expect(project.events.list("t-product")).toHaveLength(before);
  });
});
