/**
 * A dynamic workflow under the REAL engine (decision 0005 §3, step 4).
 *
 * `persistence/test/documents.test.ts` pins what is generated and frozen. This pins that it RUNS:
 * that a generated document starts like any workflow, that its standing `task_move` rules take a
 * task to a child only when somebody sends it there, that a wire made by schema fit actually carries
 * the value, and — the claim the whole step rests on — that a task which has already run under
 * version 1 LOADS under version 2 and walks into a child version 1 never had.
 *
 * Every state is a gate, as in `taskMove.test.ts`: a parked gate is a state unmistakably entered,
 * and its inputs are on the request for the test to read. The conversation state is a stand-in (a
 * gate too): `chat/control` and `chat/session` ship in a later step, and the generator takes any
 * state with an operation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, generateDocumentVersion, initProject, isWorkflowVersionEvent, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const BOOLEAN = { type: "boolean" };

function files(): Record<string, JsonValue> {
  const gate = (name: string, inputs: Record<string, JsonValue> = {}): JsonValue => ({
    label: name,
    inputs,
    outputs: { confirmed: { schema: BOOLEAN } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } },
  });
  return {
    "conv/standin": gate("talk"),
    "lib/first": gate("first"),
    "lib/second": gate("second", { flag: { schema: BOOLEAN } }),
    "lib/third": gate("third", { flag: { schema: BOOLEAN } }),
  };
}

let dir: string;
let service: AppService;
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-dynamic-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  seen.clear();
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

/** Wait for the next gate, answer it, and say which state's it was and what that state was handed. */
async function answer(): Promise<{ state: string; inputs: Record<string, unknown> }> {
  const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId));
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  service.submitInteraction(gate.requestId, { confirmed: true });
  return { state: String((gate.inputs as { prompt?: string }).prompt ?? "").replace("?", ""), inputs: gate.inputs as Record<string, unknown> };
}

async function withProject<T>(fn: (project: ReturnType<typeof openProject>) => T | Promise<T>): Promise<T> {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return await fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): Promise<string> => withProject((p) => p.runtime.get(taskId)!.status);
const completed = async (taskId: string): Promise<void> => {
  let status = "";
  await until(() => {
    void statusOf(taskId).then((s) => (status = s));
    return status === "completed";
  }, `${taskId} to complete`);
};

/** `[child key, the inputs it was entered with]`, in journal order. */
const entries = (taskId: string): Promise<Array<[string, unknown]>> =>
  withProject((p) =>
    new SqliteEventLog(p.db)
      .list(taskId)
      .flatMap((row) => (row.event.type === "instance.entered" && row.event.childKey !== undefined ? [[row.event.childKey, row.event.inputs] as [string, unknown]] : [])),
  );

describe("a generated document, run", () => {
  it("starts like any workflow, moves only when sent, carries a wire made by schema fit — and picks a new version up mid-life", async () => {
    // One phase, run alone, to the end.
    const source = service.createTask({ title: "First, alone", workflow: "lib/first" }).taskId;
    await service.startTask({ taskId: source });
    expect((await answer()).state).toBe("first");
    await completed(source);

    // The document the move needs: the conversation, what ran, and the target wired from it.
    const made = await withProject((p) => generateDocumentVersion(p, { taskId: source, target: "lib/second", conversation: "conv/standin" }));
    expect(made.resolution).toBe("new");
    expect(made.generated.wires).toEqual([{ input: "flag", from: { child: "first", output: "confirmed" } }]);
    const { id: documentId, rootId } = made.document!;

    // A task IN the document. Its root is the conversation; nothing is on a spine, so with nobody
    // sending it anywhere it has its turn and finishes — the standing rules hold nothing open.
    const taskId = await withProject((p) => createTask(p, { title: "In the document", workflow: rootId, documentId }).id);
    await service.startTask({ taskId });
    expect((await answer()).state).toBe("talk");
    await completed(taskId);
    expect(await entries(taskId)).toEqual([]);

    // Sent to `first`, then to `second`: the wire carries what `first` produced.
    expect(await service.moveTask({ taskId, toState: "first" })).toEqual({ taskId, status: "reopened" });
    expect((await answer()).state).toBe("first");
    await completed(taskId);
    expect(await service.moveTask({ taskId, toState: "second" })).toEqual({ taskId, status: "reopened" });
    expect((await answer()).state).toBe("second");
    await completed(taskId);
    expect(await entries(taskId)).toEqual([
      ["first", {}],
      ["second", { flag: true }],
    ]);

    // The document is modified — for every task standing in it. This one ran under version 1…
    const v1 = made.version!.snapshotHash;
    expect(await withProject((p) => p.runtime.get(taskId)!.snapshotHash)).toBe(v1);
    await expect(service.moveTask({ taskId, toState: "third" })).rejects.toThrow(/third/);
    const next = await withProject((p) => generateDocumentVersion(p, { taskId, target: "lib/third", conversation: "conv/standin" }));
    expect(next.resolution).toBe("augmented");
    // …nearest first: `third` is fed by `second`, the state the task last stood in.
    expect(next.generated.wires).toEqual([{ input: "flag", from: { child: "second", output: "confirmed" } }]);

    // …and LOADS under version 2: the machine it recorded, handed a root with another child in it.
    expect(await service.moveTask({ taskId, toState: "third" })).toEqual({ taskId, status: "reopened" });
    expect((await answer()).state).toBe("third");
    await completed(taskId);
    expect((await entries(taskId)).at(-1)).toEqual(["third", { flag: true }]);
    expect(await withProject((p) => p.runtime.get(taskId)!.snapshotHash)).toBe(next.version!.snapshotHash);
    const versions = await withProject((p) =>
      new SqliteEventLog(p.db)
        .list(taskId)
        .map((row) => row.event as unknown)
        .filter(isWorkflowVersionEvent)
        .map((event) => event.version),
    );
    expect(versions).toEqual([1, 2]);
    // Nothing that ran under version 1 was asked again on the way.
    expect(await entries(taskId)).toHaveLength(3);
  });
});
