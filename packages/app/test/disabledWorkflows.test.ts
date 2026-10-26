/**
 * Disabled workflows over the real service and engine (decision 0021).
 *
 * `persistence/test/disabled.test.ts` pins which file decides and the refusals a start and a move
 * make. This is what only a running app shows: a run that ENTERS a state switched off after it
 * started fails at that entry with the refusal's words (the person, 2026-10-26: "if a running state
 * is supposed to transition to a state/workflow which is disabled, it errors"), a task already
 * running carries on while nothing it enters is off, and a conversation's tools neither list nor
 * start a disabled workflow.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, runCauses } from "@jaira/persistence";
import { writeWorkflowFiles, createWorkflowTools } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { StartResult, WorkflowsResult } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

const BOOL: JsonValue = { type: "boolean" };
const gate = (name: string): JsonValue => ({
  label: name,
  outputs: { confirmed: { schema: BOOL } },
  operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } },
});

let dir: string;
let workflowsDir: string;
let service: AppService;

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-disabled-run-"));
  workflowsDir = initProject(dir, testHome()).workflowsDir;
  writeWorkflowFiles(workflowsDir, {
    flow: { label: "Flow", children: { a: { state: "flow/a" }, b: { state: "flow/b" } }, sequence: ["a", "b"] },
    "flow/a": gate("a"),
    "flow/b": gate("b"),
    notes: gate("notes"),
  });
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

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);

/** Switch a state off the way the app does: the field in its own file. */
function disable(stateId: string): void {
  const file = join(workflowsDir, `${stateId}.json`);
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), disabled: true }, null, 2), "utf8");
}

async function answer(prompt: string): Promise<void> {
  await until(() => service.pendingInteractions().some((p) => (p.inputs as { prompt?: string }).prompt === prompt), `the '${prompt}' gate`);
  const pending = service.pendingInteractions().find((p) => (p.inputs as { prompt?: string }).prompt === prompt)!;
  service.submitInteraction(pending.requestId, { confirmed: true });
}

describe("a running workflow", () => {
  it("fails at the entry of a state switched off after it started, with the refusal's words", async () => {
    const { taskId } = service.createTask({ title: "Run the flow", workflow: "flow" });
    await service.startTask({ taskId });
    await until(() => service.pendingInteractions().length > 0, "the first gate");
    // Switched off while `a` waits — the entry into `b` asks the files as they stand THEN.
    disable("flow/b");
    await answer("a?");
    await until(() => statusOf(taskId) === "failed", "the run to fail at b");
    expect(read((p) => runCauses(p, taskId))).toContainEqual({ stateId: "flow/b", reason: "Not run: 'flow/b' is disabled." });
    expect(service.pendingInteractions().some((p) => (p.inputs as { prompt?: string }).prompt === "b?")).toBe(false);
  });

  it("carries on while nothing it enters is switched off", async () => {
    const { taskId } = service.createTask({ title: "Run the flow", workflow: "flow" });
    await service.startTask({ taskId });
    disable("notes");
    await answer("a?");
    await answer("b?");
    await until(() => statusOf(taskId) === "completed", "the run to complete");
  });
});

describe("a start", () => {
  it("of a disabled workflow is refused and leaves the task queued", async () => {
    disable("notes");
    const { taskId } = service.createTask({ title: "Write notes", workflow: "notes" });
    await expect(service.startTask({ taskId })).rejects.toThrow("Not run: 'notes' is disabled.");
    expect(statusOf(taskId)).toBe("queued");
  });
});

describe("switching one off and on (workflow:setDisabled)", () => {
  const offHere = (stateId: string): boolean => service.browseWorkflows(dir).disabled?.includes(stateId) === true;

  it("writes the field into a project's own file, and takes it out again", () => {
    const before = readFileSync(join(workflowsDir, "notes.json"), "utf8");
    service.setWorkflowDisabled({ stateId: "notes", layer: "project", project: dir, disabled: true });
    expect(offHere("notes")).toBe(true);
    expect(JSON.parse(readFileSync(join(workflowsDir, "notes.json"), "utf8"))).toMatchObject({ disabled: true });
    service.setWorkflowDisabled({ stateId: "notes", layer: "project", project: dir, disabled: false });
    expect(offHere("notes")).toBe(false);
    expect(readFileSync(join(workflowsDir, "notes.json"), "utf8")).toBe(before);
  });

  it("switches a built-in off in this project with a file that follows it, and Enable deletes that file", () => {
    const written = service.setWorkflowDisabled({ stateId: "chat/session", layer: "project", project: dir, disabled: true });
    expect(JSON.parse(written.text)).toEqual({ $ref: "$SYSTEM/workflows/chat/session", disabled: true });
    expect(offHere("chat/session")).toBe(true);
    const enabled = service.setWorkflowDisabled({ stateId: "chat/session", layer: "project", project: dir, disabled: false });
    expect(enabled.exists).toBe(false);
    expect(offHere("chat/session")).toBe(false);
  });

  it("switches one off in Shared for every project, and back on in this project only", () => {
    service.setWorkflowDisabled({ stateId: "chat/session", layer: "base", disabled: true });
    expect(offHere("chat/session")).toBe(true);
    const here = service.setWorkflowDisabled({ stateId: "chat/session", layer: "project", project: dir, disabled: false });
    // Taking a field out of a file that has none would change nothing: this project says `false`.
    expect(JSON.parse(here.text)).toEqual({ $ref: "$BASE/workflows/chat/session", disabled: false });
    expect(offHere("chat/session")).toBe(false);
    // Both files only follow: the conversation still loads as what ships, its permission set included.
    const session = service.browseWorkflows(dir).workflows.find((w) => w.rootId === "chat/session");
    expect(session?.loadError).toBeUndefined();
    expect(session?.conversationInput).toBe("message");
    service.setWorkflowDisabled({ stateId: "chat/session", layer: "base", disabled: false });
  });

  it("refuses the layer that ships", () => {
    expect(() => service.setWorkflowDisabled({ stateId: "chat/session", layer: "system", disabled: true })).toThrow(/read-only/);
  });
});

describe("a conversation", () => {
  it("is one because the Chat view started it, whatever workflow it runs", () => {
    // What the Chat view sends (`conversation: true`); the workflow it runs says nothing about it.
    const made = service.createTask({ title: "talk it through", workflow: "flow", conversation: true });
    const plain = service.createTask({ title: "a plain run", workflow: "flow" });
    expect(made.startedBy).toEqual({ by: "chat" });
    const all = service.listAllTasks();
    expect(all.find((t) => t.taskId === made.taskId)?.startedBy).toEqual({ by: "chat" });
    expect(all.find((t) => t.taskId === plain.taskId)?.startedBy).toBeUndefined();
  });

  it("runs what the settings name, chat/session unless a layer says otherwise", () => {
    expect(service.chatStartPlan({ project: dir }).settings).toBeDefined();
    const effective = service.readConfig(dir).effective as { conversations: { workflow: string; moved: string } };
    expect(effective.conversations).toEqual({ workflow: "chat/session", moved: "chat/control" });
  });
});

describe("a move that makes a dynamic workflow", () => {
  it("asks which workflow steers the task when the one the settings name is disabled", async () => {
    const { taskId } = service.createTask({ title: "Write notes", workflow: "notes" });
    await service.startTask({ taskId });
    await answer("notes?");
    await until(() => statusOf(taskId) === "completed", "notes to complete");
    // No workflow relates `notes` to `flow/b`, so the move makes one — steered by `chat/control`.
    service.setWorkflowDisabled({ stateId: "chat/control", layer: "project", project: dir, disabled: true });
    const dry = await service.connectTask({ taskId, target: "flow/b", dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.ok ? dry.plan.chooseConversation : undefined).toEqual({ disabled: "chat/control", choices: expect.arrayContaining([expect.objectContaining({ stateId: "chat/session" })]) });
    // Not one of the choices, and the drop came back without a pick: refused, and nothing moved.
    expect(dry.ok ? dry.plan.chooseConversation?.choices.some((c) => c.stateId === "chat/control") : true).toBe(false);
    const real = await service.connectTask({ taskId, target: "flow/b" });
    expect(real.ok ? undefined : real.refusal.code).toBe("conversation");
    const picked = await service.connectTask({ taskId, target: "flow/b", conversation: "chat/control", dryRun: true });
    expect(picked.ok ? undefined : picked.refusal).toEqual({ code: "disabled", message: "Not moved: 'chat/control' is disabled." });
  });
});

describe("a conversation's tools", () => {
  it("leave a disabled workflow out of list_workflows and refuse to start it", async () => {
    const { taskId } = service.createTask({ title: "talk", workflow: "chat/session", inputs: { message: "hello" } });
    await service.startTask({ taskId, fake: [{ output: "hi." }] as unknown as JsonValue });
    await until(() => statusOf(taskId) === "completed", "the opening turn");
    const tools = createWorkflowTools(service.workflowHostFor(dir, taskId));
    const listed = async (): Promise<string[]> => {
      const result = (await tools["list_workflows"]!.run({} as never, {} as never)) as unknown as WorkflowsResult;
      return "workflows" in result ? result.workflows.map((w) => w.id) : [];
    };
    expect(await listed()).toContain("notes");
    disable("notes");
    expect(await listed()).not.toContain("notes");
    const detail = (await tools["list_workflows"]!.run({ state: "notes" } as never, {} as never)) as unknown as WorkflowsResult;
    expect(detail).toEqual({ error: "'notes' is disabled: no run starts there" });
    const started = (await tools["start_task"]!.run({ state: "notes" } as never, {} as never)) as unknown as StartResult;
    expect(started).toEqual({ ok: false, code: "disabled", reason: "Not run: 'notes' is disabled." });
  });
});
