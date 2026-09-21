/**
 * Versioned frozen documents and the dynamic workflow's host half (decision 0005 §3, step 4) —
 * `documents.ts`, `dynamicDocuments.ts`, and the three places a version reaches: `beginTaskRun`
 * (pick-up on load), `rewindTask` and `forkTask` (the version current at the cut).
 *
 * Over a real project with state files on disk, because every claim here is about what gets FROZEN:
 * that a generated document lints as an authored one does, that a child which ran is carried into
 * the next version as it was frozen whatever the live file says now, and that a journal row can
 * still be read against the version it ran under after the document has moved on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotHash, validateBundle, type EngineEvent, type WorkflowBundle } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { forkTask, rewindTask } from "../src/cut";
import {
  bundleAt,
  currentPin,
  isWorkflowVersionEvent,
  latestVersion,
  listDocuments,
  loadPinnedBundle,
  readDocument,
  versionAt,
  WORKFLOW_VERSION_EVENT,
  type WorkflowVersionEvent,
} from "../src/documents";
import { generateDocumentVersion, saveDocumentAsWorkflow } from "../src/dynamicDocuments";
import { isStandingMoveRule } from "../src/dynamicWorkflow";
import { beginTaskRun, createTask, finishTaskRun, hasJournalHistory } from "../src/lifecycle";
import { buildTaskLoad } from "../src/load";
import { initProject, openProject, type Project } from "../src/project";
import { loadSnapshot } from "../src/snapshots";
import { browseWorkflows } from "../src/workflows";

const STRING = { type: "string" };
const FEATURE = { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id"] };
const FEATURES = { type: "array", items: FEATURE };

/** A prompt leaf that lints clean: every output declared on the call and bound from it. */
const leaf = (label: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  label,
  inputs: Object.fromEntries(Object.entries(inputs).map(([name, schema]) => [name, { schema }])),
  outputs: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema, binding: `.operation.output.${name}` }])),
  operation: {
    kind: "prompt",
    prompt: `do ${label}`,
    model: "anthropic/claude-sonnet-5",
    output: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema }])),
  },
  ...extra,
});

const FILES: Record<string, unknown> = {
  // The stand-in for `chat/control` / `chat/session`, which ship in a later step: any state with an operation.
  "chat/standin": leaf("Conversation", {}, { said: STRING }),
  "lib/product": leaf("Product", { idea: STRING }, { brief: STRING, features: FEATURES }),
  "lib/ux": leaf("UX", { feature: FEATURE }, { design: STRING }),
  "lib/plan_all": leaf("Plan all", { features: FEATURES }, { plan: STRING }),
  "lib/costed": leaf("Costed", { brief: STRING, budget: { type: "number" } }, { quote: STRING }),
  // A real workflow: two states on a spine, the second wired from the first.
  flow: {
    label: "Flow",
    inputs: { idea: { schema: STRING } },
    outputs: { plan: { schema: STRING, binding: ".children.plan.output.plan" } },
    children: {
      product: { state: "lib/product", inputs: { idea: ".inputs.idea" } },
      plan: { state: "lib/plan_all", inputs: { features: ".children.product.output.features" } },
    },
    sequence: ["product", "plan"],
  },
};

let dir: string;
const open: Project[] = [];

function write(stateId: string, def: unknown): void {
  const file = `${join(dir, ".jaira", "workflows", ...stateId.split("/"))}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-docs-"));
  initProject(dir, testHome());
  for (const [id, def] of Object.entries(FILES)) write(id, def);
});

afterEach(() => {
  for (const p of open.splice(0)) p.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(): Project {
  const p = openProject(dir, { baseDir: testHome() });
  open.push(p);
  return p;
}

let clock = 10_000;
const tick = (): number => (clock += 10);

const lint = (bundle: WorkflowBundle): string[] =>
  validateBundle(bundle, { strict: true }).errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`);

/** Journal one state's whole life under `parent` — entered, ended well. */
function ranChild(p: Project, taskId: string, parent: string, key: string, stateId: string): void {
  const recorder = p.events.recorder(taskId);
  const id = `${taskId}-${key}`;
  recorder.record({ type: "instance.entered", instanceId: id, stateId, childKey: key, parentInstanceId: parent, inputs: {} } as EngineEvent, tick());
  recorder.record({ type: "instance.terminated", instanceId: id, stateId, outcome: "success" } as EngineEvent, tick());
}

/** A task that ran `lib/product` alone, to the end — the "one phase" of the decision's context. */
async function finishedProduct(p: Project, taskId = "t-product"): Promise<string> {
  createTask(p, { id: taskId, title: "Product", workflow: "lib/product", inputs: { idea: "a board game" } });
  const started = await beginTaskRun(p, taskId, { nowMs: tick() });
  const recorder = p.events.recorder(taskId);
  recorder.record({ type: "instance.entered", instanceId: `${taskId}-root`, stateId: "lib/product", inputs: { idea: "a board game" } } as EngineEvent, tick());
  recorder.record({ type: "instance.terminated", instanceId: `${taskId}-root`, stateId: "lib/product", outcome: "success" } as EngineEvent, tick());
  finishTaskRun(p, taskId, "completed", { outputs: { brief: "a brief", features: [{ id: "f1" }, { id: "f2" }] } }, tick());
  return started.snapshotHash;
}

const markersOf = (p: Project, taskId: string): WorkflowVersionEvent[] =>
  p.events
    .list(taskId)
    .map((row) => row.event as unknown)
    .filter(isWorkflowVersionEvent);

describe("generating a new document", () => {
  it("makes a conversation with children, wired by schema fit, that lints clean and is frozen as version 1", async () => {
    const p = project();
    await finishedProduct(p);
    const result = await generateDocumentVersion(p, { taskId: "t-product", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });

    expect(result.resolution).toBe("new");
    const document = result.document!;
    expect(document).toMatchObject({ kind: "dynamic", conversation: "chat/standin", rootId: `dynamic/${document.id}` });
    expect(document.versions.map((v) => v.version)).toEqual([1]);
    // It lives where workflows are frozen — and NOT under `workflows/`.
    expect(existsSync(join(p.paths.snapshotsDir, "_documents", `${document.id}.json`))).toBe(true);
    expect(existsSync(join(p.paths.workflowsDir, "dynamic"))).toBe(false);

    const authored = result.version!.authored!;
    expect(authored["operation"]).toEqual((FILES["chat/standin"] as { operation: unknown }).operation);
    expect(authored["children"]).toEqual({
      product: { state: "lib/product", inputs: { idea: { json: "a board game", provenance: { via: "recorded", by: "t-product" } } } },
      // Takes the LIST: a plain mount — the join.
      plan_all: { state: "lib/plan_all", inputs: { features: ".children.product.output.features" } },
    });
    expect((authored["transitions"] as unknown[]).length).toBe(2);
    expect((authored["transitions"] as unknown[]).every((rule) => isStandingMoveRule(rule))).toBe(true);

    // The version IS an ordinary snapshot: it loads, hashes to its name, and lints as any workflow does.
    const bundle = loadSnapshot(p.paths.snapshotsDir, result.version!.snapshotHash);
    expect(bundle.rootId).toBe(document.rootId);
    expect(Object.keys(bundle.states).sort()).toEqual([document.rootId, "lib/plan_all", "lib/product"].sort());
    expect(lint(bundle)).toEqual([]);
    expect(bundle.states[document.rootId]!.transitions!.every((t) => t.standing === true)).toBe(true);
    // The task itself is untouched: joining it to the document is adoption's.
    expect(p.runtime.get("t-product")!.documentId).toBeUndefined();
  });

  it("generates `each: split`, held, when the target takes one element of a list the source produced", async () => {
    const p = project();
    await finishedProduct(p);
    const result = await generateDocumentVersion(p, { taskId: "t-product", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    expect(result.generated.mount).toBe("split");
    expect((result.version!.authored!["children"] as Record<string, unknown>)["ux"]).toEqual({
      state: "lib/ux",
      inputs: { feature: { $expr: ".children.product.output.features", each: "split", start: "manual" } },
    });
    const bundle = loadSnapshot(p.paths.snapshotsDir, result.version!.snapshotHash);
    expect(lint(bundle)).toEqual([]);
    const mount = bundle.states[bundle.rootId]!.children!["ux"]!;
    expect(mount.eachKind).toBe("split");
    expect(mount.spawn?.start).toBe("manual");
  });

  it("returns what it cannot settle, with the schema, and writes nothing — then takes the value as a literal with provenance", async () => {
    const p = project();
    await finishedProduct(p);
    const open = await generateDocumentVersion(p, { taskId: "t-product", target: "lib/costed", conversation: "chat/standin", nowMs: tick() });
    expect(open.resolution).toBe("unsettled");
    expect(open.generated.unsettled).toEqual([{ input: "budget", schema: { type: "number" }, kind: "json", required: true, reason: "no-fit" }]);
    expect(open.document).toBeUndefined();
    expect(listDocuments(p.paths.snapshotsDir)).toEqual([]);

    const settled = await generateDocumentVersion(p, {
      taskId: "t-product",
      target: "lib/costed",
      conversation: "chat/standin",
      supplied: { budget: { value: 40, provenance: { via: "asked", by: "person" } } },
      nowMs: tick(),
    });
    expect(settled.resolution).toBe("new");
    expect((settled.version!.authored!["children"] as Record<string, { inputs?: unknown }>)["costed"]!.inputs).toEqual({
      brief: ".children.product.output.brief",
      budget: { json: 40, provenance: { via: "asked", by: "person" } },
    });
    expect(lint(loadSnapshot(p.paths.snapshotsDir, settled.version!.snapshotHash))).toEqual([]);
  });

  it("carries the state that RAN into the document as it was frozen, whatever the live file says now", async () => {
    const p = project();
    const pinned = await finishedProduct(p);
    write("lib/product", leaf("Product, rewritten since", { idea: STRING }, { brief: STRING, features: FEATURES }));
    const result = await generateDocumentVersion(p, { taskId: "t-product", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });
    const bundle = loadSnapshot(p.paths.snapshotsDir, result.version!.snapshotHash);
    expect(bundle.states["lib/product"]).toEqual(loadSnapshot(p.paths.snapshotsDir, pinned).states["lib/product"]);
    expect(bundle.states["lib/product"]!.label).toBe("Product");
  });

  it("refuses a conversation state that has no operation, and one that is not there", async () => {
    const p = project();
    await finishedProduct(p);
    await expect(generateDocumentVersion(p, { taskId: "t-product", target: "lib/ux", conversation: "flow" })).rejects.toThrow(/has no operation/);
    await expect(generateDocumentVersion(p, { taskId: "t-product", target: "lib/ux", conversation: "chat/nowhere" })).rejects.toThrow(/was not found/);
  });
});

/** A document with one task standing in it that has run `product` there. */
async function documentWithTask(p: Project): Promise<{ documentId: string; rootId: string; v1: string }> {
  await finishedProduct(p);
  const made = await generateDocumentVersion(p, { taskId: "t-product", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
  const { id, rootId } = made.document!;
  createTask(p, { id: "t-dyn", title: "In the document", workflow: rootId, documentId: id });
  const started = await beginTaskRun(p, "t-dyn", { nowMs: tick() });
  expect(started.snapshotHash).toBe(made.version!.snapshotHash);
  const recorder = p.events.recorder("t-dyn");
  recorder.record({ type: "instance.entered", instanceId: "t-dyn-root", stateId: rootId, inputs: {} } as EngineEvent, tick());
  ranChild(p, "t-dyn", "t-dyn-root", "product", "lib/product");
  finishTaskRun(p, "t-dyn", "completed", {}, tick());
  return { documentId: id, rootId, v1: made.version!.snapshotHash };
}

describe("versions", () => {
  it("augments: a new version appended after what has run, the children that were there untouched", async () => {
    const p = project();
    const { documentId, v1 } = await documentWithTask(p);
    const before = readDocument(p.paths.snapshotsDir, documentId);

    const result = await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });
    expect(result.resolution).toBe("augmented");
    expect(result.document!.id).toBe(documentId);
    expect(result.document!.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(result.document!.versions[0]).toEqual(before.versions[0]);

    const was = before.versions[0]!.authored!;
    const now = result.version!.authored!;
    expect(Object.keys(now["children"] as object)).toEqual(["product", "ux", "plan_all"]);
    for (const key of ["product", "ux"]) expect((now["children"] as Record<string, unknown>)[key]).toEqual((was["children"] as Record<string, unknown>)[key]);
    expect((now["transitions"] as unknown[]).slice(0, 2)).toEqual(was["transitions"]);
    expect((now["transitions"] as unknown[]).every((rule) => isStandingMoveRule(rule))).toBe(true);

    // Version 1 is still there, byte for byte — no modification invalidates history.
    const first = loadSnapshot(p.paths.snapshotsDir, v1);
    const second = loadSnapshot(p.paths.snapshotsDir, result.version!.snapshotHash);
    expect(snapshotHash(first)).toBe(v1);
    expect(lint(second)).toEqual([]);
    for (const id of Object.keys(first.states)) if (id !== first.rootId) expect(second.states[id]).toEqual(first.states[id]);
    // A move the document already offers writes nothing.
    const again = await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });
    expect(again.resolution).toBe("existing");
    expect(readDocument(p.paths.snapshotsDir, documentId).versions).toHaveLength(2);
  });

  it("a task picks up the latest version the next time it loads, and its journal says where", async () => {
    const p = project();
    const { documentId, v1 } = await documentWithTask(p);
    expect(markersOf(p, "t-dyn")).toEqual([{ type: WORKFLOW_VERSION_EVENT, documentId, version: 1, snapshotHash: v1 }]);
    // The note about what it is ABOUT to run under is not the machine having said anything.
    createTask(p, { id: "t-fresh", title: "Never ran", workflow: "x", documentId });
    p.events.recorder("t-fresh").record({ type: WORKFLOW_VERSION_EVENT } as unknown as EngineEvent, tick());
    expect(hasJournalHistory(p, "t-fresh")).toBe(false);

    const v2 = (await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() })).version!.snapshotHash;
    // Until it loads, the task still says what it last RAN under; what it will load is the latest.
    expect(p.runtime.get("t-dyn")!.snapshotHash).toBe(v1);
    expect(currentPin(p, p.runtime.get("t-dyn")!)).toEqual({ snapshotHash: v2, documentId, version: 2 });
    expect(snapshotHash(loadPinnedBundle(p, p.runtime.get("t-dyn")!))).toBe(v2);

    // The fold that prepares the load reads the journal — pick-up rows included — against version 2.
    const load = buildTaskLoad(p, "t-dyn", loadPinnedBundle(p, p.runtime.get("t-dyn")!).states);
    expect(load.blocked).toBeUndefined();
    expect(load.loaded?.stateId).toBe(`dynamic/${documentId}`);

    const resumed = await beginTaskRun(p, "t-dyn", { continues: true, reopen: true, nowMs: tick() });
    expect(resumed.snapshotHash).toBe(v2);
    expect(Object.keys(resumed.bundle.states[resumed.bundle.rootId]!.children!)).toEqual(["product", "ux", "plan_all"]);
    expect(p.runtime.get("t-dyn")!.snapshotHash).toBe(v2);
    expect(markersOf(p, "t-dyn").map((m) => [m.version, m.previous?.version])).toEqual([
      [1, undefined],
      [2, 1],
    ]);
    // Loading again under the same version says nothing new.
    finishTaskRun(p, "t-dyn", "completed", {}, tick());
    await beginTaskRun(p, "t-dyn", { continues: true, reopen: true, nowMs: tick() });
    expect(markersOf(p, "t-dyn")).toHaveLength(2);
  });

  it("changes the document for EVERY task standing in it", async () => {
    const p = project();
    const { documentId, rootId } = await documentWithTask(p);
    createTask(p, { id: "t-other", title: "Another item", workflow: rootId, documentId });
    const v2 = (await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() })).version!.snapshotHash;
    expect((await beginTaskRun(p, "t-other", { nowMs: tick() })).snapshotHash).toBe(v2);
    expect(markersOf(p, "t-other").map((m) => m.version)).toEqual([2]);
  });

  it("keeps history valid: a row reads against the version it ran under after the document moved on", async () => {
    const p = project();
    const { v1 } = await documentWithTask(p);
    const v2 = (await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() })).version!.snapshotHash;
    await beginTaskRun(p, "t-dyn", { continues: true, reopen: true, nowMs: tick() });
    ranChild(p, "t-dyn", "t-dyn-root", "plan_all", "lib/plan_all");

    const rows = p.events.list("t-dyn");
    const productRow = rows.find((row) => row.type === "instance.entered" && row.instanceId === "t-dyn-product")!;
    const planRow = rows.find((row) => row.type === "instance.entered" && row.instanceId === "t-dyn-plan_all")!;
    expect(versionAt(p, "t-dyn", productRow.seq + 1)).toMatchObject({ version: 1, snapshotHash: v1 });
    expect(versionAt(p, "t-dyn", planRow.seq + 1)).toMatchObject({ version: 2, snapshotHash: v2 });
    expect(versionAt(p, "t-dyn")).toMatchObject({ version: 2 });
    // Version 1 never heard of `plan_all`; the row that ran it is read against the version that did.
    expect(bundleAt(p, "t-dyn", productRow.seq + 1)!.states["lib/plan_all"]).toBeUndefined();
    expect(bundleAt(p, "t-dyn", planRow.seq + 1)!.states["lib/plan_all"]).toBeDefined();
  });

  it("refuses a modification made against a version the document has moved past", async () => {
    const p = project();
    const { documentId } = await documentWithTask(p);
    await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });
    const { appendVersion } = await import("../src/documents");
    expect(() => appendVersion(p.paths.snapshotsDir, documentId, 1, { snapshotHash: "x", createdAt: "now" })).toThrow(/is at version 2, not 1/);
  });
});

describe("a cut across a version boundary", () => {
  it("rewinds the task back under the version that was current at the cut; the next load picks the latest up again", async () => {
    const p = project();
    const { documentId, v1 } = await documentWithTask(p);
    const v2 = (await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() })).version!.snapshotHash;
    await beginTaskRun(p, "t-dyn", { continues: true, reopen: true, nowMs: tick() });
    ranChild(p, "t-dyn", "t-dyn-root", "plan_all", "lib/plan_all");
    finishTaskRun(p, "t-dyn", "completed", {}, tick());
    expect(p.runtime.get("t-dyn")!.snapshotHash).toBe(v2);

    // Cut AT the row that picked version 2 up: it, and everything that ran under it, goes.
    const cut = p.events.list("t-dyn").find((row) => isWorkflowVersionEvent(row.event as unknown) && (row.event as unknown as WorkflowVersionEvent).version === 2)!;
    rewindTask(p, "t-dyn", cut.seq, tick());
    expect(p.runtime.get("t-dyn")).toMatchObject({ snapshotHash: v1, documentId, status: "interrupted" });
    expect(markersOf(p, "t-dyn").map((m) => m.version)).toEqual([1]);

    const resumed = await beginTaskRun(p, "t-dyn", { continues: true, nowMs: tick() });
    expect(resumed.snapshotHash).toBe(v2);
    expect(markersOf(p, "t-dyn").map((m) => [m.version, m.previous?.version])).toEqual([
      [1, undefined],
      [2, 1],
    ]);
  });

  it("forks a copy into the same document, under the version current at ITS cut", async () => {
    const p = project();
    const { documentId, v1 } = await documentWithTask(p);
    await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });
    await beginTaskRun(p, "t-dyn", { continues: true, reopen: true, nowMs: tick() });
    finishTaskRun(p, "t-dyn", "completed", {}, tick());

    const cut = p.events.list("t-dyn").find((row) => isWorkflowVersionEvent(row.event as unknown) && (row.event as unknown as WorkflowVersionEvent).version === 2)!;
    const fork = forkTask(p, "t-dyn", cut.seq, { standing: "startable", nowMs: tick() });
    expect(p.runtime.get(fork.taskId)).toMatchObject({ snapshotHash: v1, documentId });
    // …and, being in the document, it loads the latest like everything else standing there.
    expect(currentPin(p, p.runtime.get(fork.taskId)!)!.version).toBe(2);
  });
});

/** A task standing INSIDE the real workflow `flow`: `product` done, `plan` not yet entered. */
async function midFlow(p: Project): Promise<string> {
  createTask(p, { id: "t-flow", title: "Flow", workflow: "flow", inputs: { idea: "x" } });
  const started = await beginTaskRun(p, "t-flow", { nowMs: tick() });
  p.events.recorder("t-flow").record({ type: "instance.entered", instanceId: "t-flow-root", stateId: "flow", inputs: { idea: "x" } } as EngineEvent, tick());
  ranChild(p, "t-flow", "t-flow-root", "product", "lib/product");
  p.runtime.setStatus("t-flow", "interrupted", tick());
  return started.snapshotHash;
}

describe("a move a real workflow does not support", () => {
  it("clones the task's frozen copy: diverged, the child and the rule grafted on, everything that was there as it was", async () => {
    const p = project();
    const pinned = await midFlow(p);
    const frozen = loadSnapshot(p.paths.snapshotsDir, pinned);

    const result = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    expect(result.resolution).toBe("cloned");
    expect(result.document).toMatchObject({ kind: "diverged", rootId: "flow", conversation: "chat/standin", divergedFrom: { workflow: "flow", snapshotHash: pinned } });
    expect(result.generated.additions).toEqual({
      children: { ux: { state: "lib/ux", inputs: { feature: { $expr: ".children.product.output.features", each: "split", start: "manual" } } } },
      transitions: [{ when: "on_user_event('task_move', { to_state: 'ux' })", to: "ux", standing: true }],
    });

    const bundle = loadSnapshot(p.paths.snapshotsDir, result.version!.snapshotHash);
    expect(lint(bundle)).toEqual([]);
    const root = bundle.states["flow"]!;
    const was = frozen.states["flow"]!;
    expect(Object.keys(root.children!)).toEqual(["product", "plan", "ux"]);
    expect(root.children!["product"]).toEqual(was.children!["product"]);
    expect(root.children!["plan"]).toEqual(was.children!["plan"]);
    expect(root.sequence).toEqual(was.sequence);
    expect(root.outputs).toEqual(was.outputs);
    expect(root.transitions!.map((t) => [t.to, t.standing])).toEqual([["ux", true]]);
    expect(root.children!["ux"]!.eachKind).toBe("split");
    for (const id of ["lib/product", "lib/plan_all"]) expect(bundle.states[id]).toEqual(frozen.states[id]);

    // The task names the document; what it last ran under is still true until it loads.
    expect(p.runtime.get("t-flow")).toMatchObject({ documentId: result.document!.id, snapshotHash: pinned });
    // The original snapshot is untouched, so every other task pinned to it follows the real workflow still.
    expect(snapshotHash(loadSnapshot(p.paths.snapshotsDir, pinned))).toBe(pinned);
  });

  it("is picked up on the next load, and a rewind behind the divergence un-diverges", async () => {
    const p = project();
    const pinned = await midFlow(p);
    const cloned = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    const resumed = await beginTaskRun(p, "t-flow", { continues: true, nowMs: tick() });
    expect(resumed.snapshotHash).toBe(cloned.version!.snapshotHash);
    expect(markersOf(p, "t-flow")).toEqual([
      { type: WORKFLOW_VERSION_EVENT, documentId: cloned.document!.id, version: 1, snapshotHash: cloned.version!.snapshotHash, previous: { snapshotHash: pinned } },
    ]);
    ranChild(p, "t-flow", "t-flow-root", "ux", "lib/ux");
    finishTaskRun(p, "t-flow", "completed", {}, tick());

    // A diverged document is augmented like any other — a graft onto its latest version.
    const again = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/costed", conversation: "chat/standin", supplied: { budget: { value: 3, provenance: { via: "asked" } } }, nowMs: tick() });
    expect(again.resolution).toBe("augmented");
    const second = loadSnapshot(p.paths.snapshotsDir, again.version!.snapshotHash);
    expect(lint(second)).toEqual([]);
    expect(Object.keys(second.states["flow"]!.children!)).toEqual(["product", "plan", "ux", "costed"]);

    const productEnd = p.events.list("t-flow").find((row) => row.type === "instance.terminated" && row.instanceId === "t-flow-product")!;
    rewindTask(p, "t-flow", productEnd.seq + 1, tick());
    const row = p.runtime.get("t-flow")!;
    expect(row.snapshotHash).toBe(pinned);
    expect(row.documentId).toBeUndefined();
  });

  it("writes nothing for a target the workflow itself mounts and already offers", async () => {
    const p = project();
    await midFlow(p);
    const first = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    const again = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    expect(again.resolution).toBe("existing");
    expect(readDocument(p.paths.snapshotsDir, first.document!.id).versions).toHaveLength(1);
  });
});

describe("save as workflow", () => {
  it("writes the latest version into a layer's workflows/, where it lints exactly as an authored workflow does", async () => {
    const p = project();
    const { documentId } = await documentWithTask(p);
    await generateDocumentVersion(p, { taskId: "t-dyn", target: "lib/plan_all", conversation: "chat/standin", nowMs: tick() });

    const saved = saveDocumentAsWorkflow(p, { documentId, layer: "project", as: "saved/discovery" });
    expect(saved).toMatchObject({ stateId: "saved/discovery", layer: "project", version: 2 });
    expect(saved.file).toBe(join(p.paths.workflowsDir, "saved", "discovery.json"));
    expect(JSON.parse(readFileSync(saved.file, "utf8"))).toEqual(latestVersion(readDocument(p.paths.snapshotsDir, documentId)).authored);

    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "saved/discovery")!;
    expect(entry.loadError).toBeUndefined();
    expect(entry.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(entry.states.sort()).toEqual(["lib/plan_all", "lib/product", "lib/ux", "saved/discovery"]);

    expect(() => saveDocumentAsWorkflow(p, { documentId, layer: "project", as: "saved/discovery" })).toThrow(/already exists/);
    saveDocumentAsWorkflow(p, { documentId, layer: "project", as: "saved/discovery", overwrite: true });
    const base = saveDocumentAsWorkflow(p, { documentId, layer: "base", as: "saved/shared" });
    expect(base.file).toBe(join(p.paths.base.workflowsDir, "saved", "shared.json"));
  });

  it("refuses the layer that ships, a name that is no state id, and a diverged copy", async () => {
    const p = project();
    const { documentId } = await documentWithTask(p);
    expect(() => saveDocumentAsWorkflow(p, { documentId, layer: "system", as: "saved/x" })).toThrow(/read-only/);
    expect(() => saveDocumentAsWorkflow(p, { documentId, layer: "project", as: "../x" })).toThrow(/not a state id/);
    expect(() => saveDocumentAsWorkflow(p, { documentId, layer: "project", as: "dynamic/x" })).toThrow(/frozen documents are rooted/);
    await midFlow(p);
    const cloned = await generateDocumentVersion(p, { taskId: "t-flow", target: "lib/ux", conversation: "chat/standin", nowMs: tick() });
    expect(() => saveDocumentAsWorkflow(p, { documentId: cloned.document!.id, layer: "project", as: "saved/y" })).toThrow(/diverged copy of 'flow'/);
  });
});
