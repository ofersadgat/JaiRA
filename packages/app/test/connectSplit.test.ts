/**
 * A GENERATED `each: "split"` under the real engine and the fan-out host (decision 0005 §3, "one
 * output, many inputs") — the test step 4 could not make, because nothing composed a generated
 * document with a task standing in it until `connect` did.
 *
 * A source task produces a LIST. The target takes ONE element. No workflow relates the two, so the
 * connect wraps the source in a new document whose mount of the target is a split over the list with
 * `start: "manual"`: the tasks are made HELD — one per element, none started, nothing confirmed —
 * and releasing one starts it with its element.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles, type FakeRule } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ITEM = { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } };
const ITEMS: JsonValue = [
  { id: "one", title: "First piece" },
  { id: "two", title: "Second piece" },
  { id: "three", title: "Third piece" },
];
const RULES: FakeRule[] = [{ model: "lister", output: { items: ITEMS } }];

function files(): Record<string, JsonValue> {
  return {
    // Produces a list.
    "lib/list": {
      label: "List the pieces",
      environment: { kind: "prompt", model: "lister" },
      outputs: { items: { schema: { type: "array", items: ITEM }, binding: ".operation.output.items" } },
      operation: { prompt: "List.", output: { items: { schema: { type: "array", items: ITEM } } } },
    },
    // Takes ONE element — a gate, so an entered element is unmistakable and its input is on the request.
    "lib/piece": {
      label: "Work one piece",
      inputs: { item: { schema: ITEM, description: "The piece to work on." } },
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "piece?" } },
    },
    "conv/standin": {
      label: "talk",
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "talk?" } },
    },
  };
}

let dir: string;
let service: AppService;
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-connect-split-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  seen.clear();
  service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
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

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);
const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId));
async function parked(): Promise<{ prompt: string; inputs: Record<string, unknown>; taskId: string; requestId: string }> {
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  return { prompt: String((gate.inputs as { prompt?: string }).prompt), inputs: gate.inputs as Record<string, unknown>, taskId: gate.taskId, requestId: gate.requestId };
}

describe("a generated split, run", () => {
  it("makes one HELD task per element, starts none, and a released one starts with its element", async () => {
    const source = service.createTask({ title: "Pieces", workflow: "lib/list" }).taskId;
    await service.startTask({ taskId: source, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(source) === "completed", "the list to be produced");

    // The hover says it: the mount is a split, the wire takes one element of the list.
    const dry = await service.connectTask({ taskId: source, target: "lib/piece", dryRun: true });
    expect(dry).toMatchObject({ ok: true, plan: { resolution: "modify", modification: "new", mount: "split", inputs: [{ name: "item", via: "wire", from: "list.items", each: "split" }] } });

    const done = await service.connectTask({ taskId: source, target: "lib/piece", fake: RULES as unknown as JsonValue });
    if (!done.ok) throw new Error(done.refusal.message);
    const parent = done.taskId!;
    // The conversation has its turn; then the move is taken, and the mount splits.
    const talk = await parked();
    expect(talk.prompt).toBe("talk?");
    service.submitInteraction(talk.requestId, { confirmed: true });

    const made = (): Array<{ id: string; title: string; status: string; index: number | undefined }> =>
      read((p) =>
        p.tasks
          .list()
          .filter((meta) => meta.origin?.kind === "split" && meta.origin.taskId === parent)
          .map((meta) => ({ id: meta.id, title: meta.title, status: p.runtime.get(meta.id)!.status, index: meta.origin?.index }))
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
      );
    await until(() => made().length === 2, "the copies to be made");
    // HELD: made, queued, and nobody started them — `start: "manual"`.
    expect(made()).toMatchObject([
      { title: "Second piece", status: "queued", index: 1 },
      { title: "Third piece", status: "queued", index: 2 },
    ]);
    // The task that was moved is element 0 of its own split, and stands at the target with it.
    const own = await parked();
    expect(own).toMatchObject({ prompt: "piece?", taskId: parent, inputs: { item: { id: "one", title: "First piece" } } });
    expect(read((p) => p.tasks.read(parent).split)).toMatchObject([{ index: 0 }]);
    // Nothing else is asking anything: no copy ran.
    await new Promise((r) => setTimeout(r, 150));
    expect(service.pendingInteractions().filter((p) => !seen.has(p.requestId))).toEqual([]);
    expect(made().map((t) => t.status)).toEqual(["queued", "queued"]);

    // RELEASED: the person starts the one that is wanted, and it starts with ITS element.
    const third = made()[1]!;
    await service.resumeTask({ taskId: third.id, fake: RULES as unknown as JsonValue });
    const released = await parked();
    expect(released).toMatchObject({ prompt: "piece?", taskId: third.id, inputs: { item: { id: "three", title: "Third piece" } } });
    expect(made().map((t) => t.status)).toEqual(["queued", "running"]);
    // It never re-ran the conversation or the list: its journal is the parent's prefix, then its element.
    const entered = read((p) => new SqliteEventLog(p.db).list(third.id).flatMap((row) => (row.event.type === "instance.entered" && row.event.childKey !== undefined ? [row.event.childKey] : [])));
    expect(entered).toEqual(["list", "piece"]);
  });
});
