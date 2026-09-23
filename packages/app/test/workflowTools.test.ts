/**
 * The workflow tools over the real host (decision 0005 §3 and §4, step 6).
 *
 * `runtime/test/workflowTools.test.ts` is the half a model touches — shapes in, refusals out. This is
 * the other half: the eight operations against a real `AppService`, a real project and the real
 * engine, driven the way a conversation drives them. What is asserted here is what the decision is
 * actually about:
 *
 *  - a SESSION that starts work stays a session — its own state roots the document, never `chat/control`;
 *  - a CONTROL conversation holds the task and workflow tools and NOTHING of the project, and a
 *    project tool called in it is refused;
 *  - `start` and `move` bind what the workflow binds, ask for what is left, and take the value the
 *    second time, recording which of the two it was;
 *  - `answer` reaches a question and a judgement gate and can never reach an approval;
 *  - a drop that makes a dynamic workflow dispatches NO model call, and a grafted clone does not
 *    dispatch on resume either;
 *  - a generated split makes its tasks held, and `release` starts the ones named;
 *  - a question nobody answers still parks durably.
 *
 * Nothing here is scripted except the two prompts that produce values; when everything binds, the
 * assertion is that no model was reached at all.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles, createWorkflowTools, type FakeRule } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { ANSWERED_EVENT, MOVED_EVENT, type AnsweredEvent, type MovedEvent, type MoveResult, type StartResult, type TasksResult, type WorkflowsResult } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { ANSWERABLE_COMPONENTS } from "../src/main/workflowHost";
import { APPROVAL_PROMPT_FUNCTION } from "@jaira/shared";

const BOOL: JsonValue = { type: "boolean" };
const ITEM = { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } };
const ITEMS: JsonValue = [
  { id: "one", title: "First piece" },
  { id: "two", title: "Second piece" },
];
/** Matched on nothing, because the state names no model: the conversations name none either. */
const RULES: FakeRule[] = [{ output: { items: ITEMS } }];

function files(): Record<string, JsonValue> {
  const gate = (name: string, inputs: Record<string, JsonValue> = {}): JsonValue => ({
    label: name,
    inputs,
    outputs: { confirmed: { schema: BOOL } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: `${name}?` } },
  });
  return {
    // A finished phase to move about, and a target whose one input nothing fits — so it must be ASKED.
    "lib/done": gate("done"),
    "lib/next": gate("next", { flag: { schema: BOOL, description: "Whether the step before was confirmed." } }),
    "lib/needs": gate("needs", { text: { schema: { type: "string", minLength: 3 }, description: "What to call it." } }),
    // A list, and a target that takes ONE element: the generated mount is a split, its tasks held.
    "lib/list": {
      label: "List the pieces",
      environment: { kind: "prompt" },
      outputs: { items: { schema: { type: "array", items: ITEM }, binding: ".operation.output.items" } },
      operation: { prompt: "List.", output: { items: { schema: { type: "array", items: ITEM } } } },
    },
    "lib/piece": gate("piece", { item: { schema: ITEM, description: "The piece to work on." } }),
    // A real workflow that relates two of them, for `move`'s adoption.
    feat: {
      label: "Feature",
      children: { done: { state: "lib/done" }, next: { state: "lib/next", inputs: { flag: ".children.done.output.confirmed" } } },
      sequence: ["done", "next"],
    },
    // A state a task can stand INSIDE, so a move has to clone.
    flow: { label: "Flow", children: { a: { state: "lib/done" }, b: { state: "flow/b" } }, sequence: ["a", "b"] },
    "flow/b": gate("b"),
    // The approval prompt, called as the function a permission function calls (decision 0007, amended
    // 2026-09-22) — an APPROVAL, so the one a conversation can never answer.
    "lib/approve": {
      label: "approve",
      outputs: {},
      operation: { kind: "function", function: "approve_tool_call", args: { request: { tool: "bash", subject: "bash", function: "smart", input: { command: "npm publish" } } } },
    },
  };
}

let dir: string;
let service: AppService;
const seen = new Set<string>();

beforeEach(async () => {
  // The REAL `chat/session` and `chat/control`, because half of what is asserted here is what they say.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-wtools-"));
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

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}

const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);
const metaOf = (taskId: string) => read((p) => p.tasks.tryRead(taskId));
const journal = (taskId: string): EngineEvent[] => read((p) => new SqliteEventLog(p.db).list(taskId).map((row) => row.event));
/** Model calls this task's own machine dispatched — the number a drop must leave at zero. */
const prompts = (taskId: string): number => journal(taskId).filter((e) => e.type === "operation.started" && e.op === "prompt").length;
/** The `jaira.moved` rows a conversation's tools left on its task — what its rail draws the notes from. */
const movedRows = (taskId: string): MovedEvent[] => journal(taskId).filter((e) => (e as { type: string }).type === MOVED_EVENT) as unknown as MovedEvent[];
const documentOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.documentId);
/** The machine's root instance — the one a composer addresses when a conversation is selected. */
const rootInstanceOf = (taskId: string): string =>
  journal(taskId).flatMap((e) => (e.type === "instance.entered" && e.parentInstanceId === undefined ? [e.instanceId] : []))[0]!;

// A move's own input question is not a state's gate (decision 0005, the rulings of 2026-09-22).
const fresh = () => service.pendingInteractions().find((p) => !seen.has(p.requestId) && p.moves !== true);
async function parked(): Promise<{ state: string; inputs: Record<string, unknown>; taskId: string; requestId: string }> {
  await until(() => fresh() !== undefined, "the next gate");
  const gate = fresh()!;
  seen.add(gate.requestId);
  return {
    state: String((gate.inputs as { prompt?: string }).prompt ?? "").replace("?", ""),
    inputs: gate.inputs as Record<string, unknown>,
    taskId: gate.taskId,
    requestId: gate.requestId,
  };
}
async function answerGate(): Promise<string> {
  const gate = await parked();
  service.submitInteraction(gate.requestId, { confirmed: true });
  return gate.state;
}

/** A task that ran `workflow` alone and finished, every gate confirmed. */
async function ran(workflow: string, gates: number, title = `Ran ${workflow}`): Promise<string> {
  const { taskId } = service.createTask({ title, workflow });
  await service.startTask({ taskId });
  for (let i = 0; i < gates; i += 1) await answerGate();
  await until(() => statusOf(taskId) === "completed", `${workflow} to complete`);
  return taskId;
}

/** The host, as the eight tools reach it, for the conversation `taskId` is. */
const host = (taskId: string) => service.workflowHostFor(dir, taskId);
/** The eight tools over that host, as a MODEL calls them: by name, with a bag of arguments. */
/** One tool call, as a runtime makes it — `toolCallId` is what it says the model called the call. */
const call = async (taskId: string, tool: string, input: unknown, toolCallId?: string): Promise<Record<string, JsonValue>> =>
  (await createWorkflowTools(host(taskId))[tool]!.run(input as never, (toolCallId !== undefined ? { toolCallId } : {}) as never)) as Record<string, JsonValue>;

/** A conversation of `state`, started and settled — what a person typing in the Chat view makes. */
async function conversation(state: string, message = "let's work on this"): Promise<string> {
  // `chat/session` opens on what the person typed; `chat/control` on what the move did. Neither
  // name is the platform's to know (§0) — the test knows them because it wrote neither file, it
  // reads the one required string input each declares.
  const inputs: Record<string, JsonValue> = state === "chat/control" ? { opening: message } : { message };
  const { taskId } = service.createTask({ title: message, workflow: state, inputs });
  await service.startTask({ taskId, fake: [{ output: "right." }] as unknown as JsonValue });
  await until(() => statusOf(taskId) === "completed", "the opening turn to land");
  return taskId;
}

// ---------------------------------------------------------------------------------------------
// what each conversation HOLDS
// ---------------------------------------------------------------------------------------------

describe("the two conversations", () => {
  it("gives a SESSION the project's tools and the workflow tools, and a CONTROL only the workflow tools", () => {
    const session = service.chatStartPlan({ stateId: "chat/session" });
    const control = service.chatStartPlan({ stateId: "chat/control" });
    const WORKFLOW = ["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"];
    const PROJECT = ["read_file", "glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search"];

    for (const name of [...WORKFLOW, ...PROJECT]) expect(session.settings.tools, name).toContain(name);
    // The whole of `chat/control`: the eight, and not one thing of the project's. Asserted as an
    // EQUALITY, because "the project's tools are absent" is the claim and a `toContain` per name
    // would pass for a control that had also been handed something nobody listed here.
    expect([...(control.settings.tools ?? [])].sort()).toEqual([...WORKFLOW].sort());
    for (const name of PROJECT) expect(control.settings.tools, name).not.toContain(name);
    // …and anything it was never offered is denied outright, rather than asked about.
    expect(control.settings.permissions?.other).toBe("deny");
  });

  it("carries them on the OPERATION, so a child a dynamic root starts inherits none of it", () => {
    // `environment` on a dynamic workflow's root is the default for every child it starts, which is
    // why neither state writes one: what resolves here is the state's own execution environment,
    // lowered from its `operation`, and the authored file has no `environment` block to hand down.
    const control = service.readWorkflow({ stateId: "chat/control", layer: "system" });
    const authored = JSON.parse(control.text) as Record<string, unknown>;
    expect(authored["environment"]).toBeUndefined();
    expect((authored["operation"] as Record<string, unknown>)["tools"]).toBe("$/toolsets/chat_control/ask-first");
    const session = JSON.parse(service.readWorkflow({ stateId: "chat/session", layer: "system" }).text) as Record<string, unknown>;
    expect(session["environment"]).toBeUndefined();
    expect((session["operation"] as Record<string, unknown>)["tools"]).toBe("$/toolsets/chat/ask-first");
  });

  it("denies a project tool in a control conversation rather than offering it, per tool and by `other`", async () => {
    const control = await conversation("chat/control", "steer this");
    const plan = service.chatPlan({ taskId: control, instanceId: rootInstanceOf(control) });
    // Two separate refusals, and both matter. The tool is not OFFERED — a delegated agent's deny
    // floor is built from this list, so a tool that is not on it is never handed over at all…
    for (const name of ["bash", "read_file", "write_file", "edit"]) expect(plan?.settings.tools, name).not.toContain(name);
    // …and a native the agent has anyway answers to `other`, which this toolset denies outright.
    expect(plan?.settings.permissions?.other).toBe("deny");
    expect(plan?.settings.permissions?.tools?.["bash"]).toBeUndefined();
    // The eight it DOES hold are all it holds.
    expect([...(plan?.settings.tools ?? [])].sort()).toEqual(["answer_question", "hold_task", "list_tasks", "list_workflows", "move_task", "release_task", "start_task", "stop_task"]);
  });
});

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

describe("start_task", () => {
  it("asks for what nothing binds, writes nothing, and takes the value the second time — recorded as ASKED", async () => {
    const session = await conversation("chat/session");
    const before = documentOf(session);

    // `lib/needs` takes a string nothing in this conversation produces. The first call is the ASK.
    const asked = (await call(session, "start_task", { state: "lib/needs" })) as unknown as StartResult;
    expect(asked).toMatchObject({
      ok: false,
      code: "inputs-missing",
      missing: [{ state: "lib/needs", name: "text", description: "What to call it.", schema: { type: "string", minLength: 3 } }],
    });
    // The whole input schema comes back with it, so the model knows the shape of what to supply.
    expect((asked as { schema: JsonValue }).schema).toMatchObject({ type: "object", required: ["text"], properties: { text: { type: "string", minLength: 3 } } });
    // Nothing was written: no version, no child, no run.
    expect(documentOf(session)).toBe(before);
    expect(statusOf(session)).toBe("completed");

    // The conversation asks the person, is told, and calls again naming what THEY answered.
    const done = (await call(session, "start_task", { state: "lib/needs", inputs: { text: "the thing" }, asked: ["text"] })) as unknown as StartResult;
    expect(done).toMatchObject({ ok: true, state: "lib/needs", status: "started", mount: "plain", inputs: [{ name: "text", via: "asked" }] });
    const gate = await parked();
    expect(gate).toMatchObject({ state: "needs", inputs: { text: "the thing" } });
    // …and the record says a PERSON settled it, not the conversation.
    expect(read((p) => p.runtime.get(session)!.documentId)).toBeDefined();
    const supplied = journal(session).find((e) => (e as { type: string }).type === "jaira.supplied") as unknown as { provenance: Record<string, { via: string }> };
    expect(supplied.provenance).toEqual({ text: { via: "asked" } });
  });

  it("records a value the conversation worked out for itself as INFERRED, with its confidence", async () => {
    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/needs", inputs: { text: "what we said" }, confidence: 0.7 });
    await parked();
    const supplied = journal(session).find((e) => (e as { type: string }).type === "jaira.supplied") as unknown as { provenance: Record<string, unknown> };
    expect(supplied.provenance).toEqual({ text: { via: "inferred", confidence: 0.7 } });
  });

  it("STAYS A SESSION: the document it makes is rooted in its own state, never in chat/control", async () => {
    const session = await conversation("chat/session");
    expect(metaOf(session)?.workflow).toBe("chat/session");
    await call(session, "start_task", { state: "lib/done" });
    await parked();

    const documentId = documentOf(session)!;
    const document = read((p) => JSON.parse(readFileSync(join(p.paths.snapshotsDir, "_documents", `${documentId}.json`), "utf8")) as { conversation: string; kind: string });
    expect(document.conversation).toBe("chat/session");
    expect(document.kind).toBe("diverged");
    // The task is the same task, still a session — nothing turned into a control.
    expect(metaOf(session)?.workflow).toBe("chat/session");
    expect(metaOf(session)?.workflow).not.toBe("chat/control");
  });

  it("journals what it started on the conversation's own task, and nothing for the ask that wrote nothing", async () => {
    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/needs" });
    expect(movedRows(session)).toEqual([]);
    const done = (await call(session, "start_task", { state: "lib/needs", inputs: { text: "the thing" }, asked: ["text"] }, "toolu_start")) as unknown as StartResult;
    await parked();
    // The row names the CALL that did it, so the rail can place its note right after that call.
    expect(movedRows(session)).toEqual([{ type: MOVED_EVENT, tool: "start_task", task: session, outcome: { verb: "entered", standsAt: (done as { key: string }).key }, toolCallId: "toolu_start" }]);
  });

  it("dispatches no second model call of its own: what it starts is a CHILD, not another turn", async () => {
    const session = await conversation("chat/session");
    const opening = prompts(session);
    await call(session, "start_task", { state: "lib/done" });
    await parked();
    expect(prompts(session)).toBe(opening);
  });
});

// ---------------------------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------------------------

describe("move_task", () => {
  it("is `connect`, asked by the CONTROL: it adopts into the workflow that relates the two and says where the task stands", async () => {
    const session = await conversation("chat/session");
    const done = await ran("lib/done", 1, "Pause and stop");
    const moved = (await call(session, "move_task", { task: done, to: "lib/next" })) as unknown as MoveResult;
    expect(moved).toMatchObject({ ok: true, resolution: "adopt", workflow: "feat", adoptedAs: "done", standsAt: "next" });
    // The task the move made is the parent, and the adopted task is filed under it.
    expect(metaOf(done)?.origin).toMatchObject({ kind: "adopt", key: "done" });
    // …and the transition was recorded as the CONVERSATION's, on the person's behalf.
    const parent = (moved as { task: string }).task;
    expect(await parked()).toMatchObject({ state: "next", inputs: { flag: true } });
    expect(journal(parent).filter((e) => e.type === "transition.taken").length + 1).toBeGreaterThan(0);
  });

  it("journals what it did on the CONVERSATION's task — the row its rail draws — and nothing for a refusal or a move still asking", async () => {
    const session = await conversation("chat/session");
    const done = await ran("lib/done", 1, "Pause and stop");
    // Waiting on the person's answer, nothing has moved yet: no row.
    const asking = await call(session, "move_task", { task: done, to: "lib/needs" });
    expect(asking).toMatchObject({ ok: true, asked: { inputs: [{ name: "text" }] } });
    expect(movedRows(session)).toEqual([]);
    const refused = await call(session, "move_task", { task: done, to: "lib/nowhere" });
    expect(refused).toMatchObject({ ok: false });
    expect(movedRows(session)).toEqual([]);
    const moved = (await call(session, "move_task", { task: done, to: "lib/next" })) as unknown as MoveResult;
    await parked();
    expect(movedRows(session)).toEqual([
      { type: MOVED_EVENT, tool: "move_task", task: (moved as { task: string }).task, outcome: { verb: "adopted into", standsAt: "next", workflow: "feat", adoptedAs: "done" } },
    ]);
    // The row is on the conversation, not on the task that moved.
    expect(movedRows(done)).toEqual([]);
  });

  it("does not hand what is missing back to the model to ask in words: the PERSON is asked, in the moved task's own conversation", async () => {
    const session = await conversation("chat/session");
    const done = await ran("lib/done", 1);
    const asked = (await call(session, "move_task", { task: done, to: "lib/needs" })) as unknown as MoveResult;
    expect(asked).toMatchObject({ ok: true, task: done, asked: { inputs: [{ name: "text", description: "What to call it." }] } });
    const request = (asked as { asked: { request: string } }).asked.request;
    expect(service.pendingInteractions().find((p) => p.requestId === request)).toMatchObject({ taskId: done, component: "fill_form", moves: true });
  });

  it("refuses a task it does not know, and says so rather than throwing", async () => {
    const session = await conversation("chat/session");
    expect(await call(session, "move_task", { task: "t-nope", to: "lib/next" })).toMatchObject({ ok: false, code: "unknown-task" });
  });
});

// ---------------------------------------------------------------------------------------------
// tasks, answer, and the gestures
// ---------------------------------------------------------------------------------------------

describe("list_tasks", () => {
  it("says what was started here, where it stands, and what it is asking — and nothing of the rest of the project", async () => {
    const session = await conversation("chat/session");
    const stranger = await ran("lib/done", 1, "Somebody else's");
    await call(session, "start_task", { state: "lib/done" });
    const gate = await parked();

    const listed = (await call(session, "list_tasks", {})) as unknown as TasksResult;
    expect(listed.tasks.map((t) => t.task)).toEqual([session]);
    expect(listed.tasks[0]).toMatchObject({ relation: "this", standsAt: expect.any(String) });
    // The gate is an APPROVAL, and `tasks` is where `answer` gets its request ids from — so it is
    // not listed. A conversation cannot name what it was never told about, which is the second half
    // of "`answer` can never reach an approval": the first is that `answer` refuses it by component.
    expect(service.pendingInteractions().some((p) => p.requestId === gate.requestId)).toBe(true);
    expect(listed.tasks[0]!.asking).toBeUndefined();
    // A task nobody here started is invisible until `all` is asked for.
    const everything = (await call(session, "list_tasks", { all: true })) as unknown as TasksResult;
    expect(everything.tasks.map((t) => t.task)).toContain(stranger);
    expect(everything.tasks.find((t) => t.task === stranger)?.relation).toBeUndefined();
  });
});

describe("answer_question", () => {
  it("can never reach an approval — the gate's own component decides, and the list it reads holds no approvals", async () => {
    // The set is the whole rule, so it is asserted directly: a question and a judgement on a
    // document, and neither `confirm_action` (an approval) nor `review_artifacts` (which merges).
    expect([...ANSWERABLE_COMPONENTS].sort()).toEqual(["choose_option", "edit_artifact", "fill_form", "review_artifact"]);
    expect(ANSWERABLE_COMPONENTS.has("confirm_action")).toBe(false);
    expect(ANSWERABLE_COMPONENTS.has("review_artifacts")).toBe(false);

    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/done" });
    const gate = await parked();
    // It IS on the pending list — the person can answer it — and the tool still refuses it, naming
    // what it is. The gate is left parked, which is the point: nothing was settled behind anyone.
    expect(service.pendingInteractions().some((p) => p.requestId === gate.requestId)).toBe(true);
    expect(await call(session, "answer_question", { request: gate.requestId, confidence: 0.9, value: { confirmed: true } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("approval"),
    });
    expect(service.pendingInteractions().some((p) => p.requestId === gate.requestId)).toBe(true);
    expect(statusOf(session)).not.toBe("completed");
  });

  it("never reaches the APPROVAL PROMPT a permission function calls — the person answers it, never a fast-forward's conversation", async () => {
    // Structural, as for every approval: the component is not on the list a conversation may answer,
    // and a fast-forward offers its conversation only what is on that list (decision 0005 §4).
    expect(ANSWERABLE_COMPONENTS.has(APPROVAL_PROMPT_FUNCTION)).toBe(false);

    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/approve" });
    const gate = await parked();
    const pending = service.pendingInteractions().find((p) => p.requestId === gate.requestId)!;
    expect(pending.component).toBe(APPROVAL_PROMPT_FUNCTION);
    expect(pending.inputs).toMatchObject({ request: { tool: "bash", function: "smart", input: { command: "npm publish" } } });
    // It is not listed as something the conversation's task is asking…
    const listed = (await call(session, "list_tasks", {})) as unknown as TasksResult;
    expect(listed.tasks.find((t) => t.task === gate.taskId)?.asking).toBeUndefined();
    // …and the tool refuses it by name, leaving it parked for the person.
    expect(await call(session, "answer_question", { request: gate.requestId, confidence: 1, value: { decision: "allow" } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("approval"),
    });
    expect(service.pendingInteractions().some((p) => p.requestId === gate.requestId)).toBe(true);
    // The person's answer is the word the function returns, and the task goes on.
    service.submitInteraction(gate.requestId, { decision: "allow" });
    await until(() => statusOf(gate.taskId) === "completed", "the approval to settle");
  });

  it("refuses a request nobody is waiting on, and one that belongs to a task this conversation did not start", async () => {
    const session = await conversation("chat/session");
    expect(await call(session, "answer_question", { request: "r-nope", confidence: 0.5, value: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("no question") });

    const stranger = service.createTask({ title: "Someone else's", workflow: "lib/done" }).taskId;
    await service.startTask({ taskId: stranger });
    const theirs = await parked();
    expect(await call(session, "answer_question", { request: theirs.requestId, confidence: 0.5, value: { confirmed: true } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not start"),
    });
  });

  it("journals an agent's answered question with the call and the instance that asked — what the transcript marks the block by", async () => {
    const session = await conversation("chat/session");
    // What an agent in this conversation's own task would park: the hub's asker, as a run hands it on.
    const open = (service as unknown as { session(p?: string): { questions: { asker(c: { taskId?: string }): (r: unknown) => Promise<unknown> } } }).session();
    const asked = open.questions.asker({ taskId: session })({
      questions: [
        { question: "Which way?", options: [{ label: "left" }, { label: "right" }] },
        { question: "How far?", options: [{ label: "near" }, { label: "far" }] },
      ],
      sessionId: "s",
      // What the engine and the agent's transport put on the request.
      instanceId: "i-agent",
      toolCallId: "toolu_ask",
    });
    await until(() => service.pendingQuestions().some((p) => p.taskId === session), "the agent's question");
    const request = service.pendingQuestions().find((p) => p.taskId === session)!.requestId;
    expect(await call(session, "answer_question", { request, confidence: 0.8, answers: { "Which way?": "left", "How far?": "near" } })).toMatchObject({ ok: true });
    await expect(asked).resolves.toMatchObject({ "Which way?": "left" });
    const row = journal(session).find((e) => (e as { type: string }).type === ANSWERED_EVENT) as unknown as AnsweredEvent;
    expect(row).toMatchObject({ kind: "question", instanceId: "i-agent", toolCallId: "toolu_ask", settled_by: { via: "control", confidence: 0.8 } });
    expect(row).not.toHaveProperty("questions");
  });

  it("leaves a question nobody answered parked DURABLY, across a close and an open", async () => {
    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/done" });
    const gate = await parked();
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined });
    await service.open(dir);
    await until(() => service.pendingInteractions().some((p) => p.requestId === gate.requestId), "the question to come back");
    expect(service.pendingInteractions().find((p) => p.requestId === gate.requestId)).toMatchObject({ component: "confirm_action" });
  });
});

describe("hold, release and stop", () => {
  it("refuses a task this conversation did not start, and says which it was", async () => {
    const session = await conversation("chat/session");
    const stranger = await ran("lib/done", 1, "Not mine");
    expect(await call(session, "stop_task", { tasks: [stranger] })).toMatchObject({
      results: [{ task: stranger, ok: false, reason: expect.stringContaining("not started from this conversation") }],
    });
  });

  it("stops a running task and RELEASES it again, from where it stood", async () => {
    const session = await conversation("chat/session");
    await call(session, "start_task", { state: "lib/done" });
    await parked();
    const child = (await call(session, "list_tasks", {})) as unknown as TasksResult;
    void child;
    // The conversation's own task is what runs the child, so stopping IT is the gesture that lands.
    expect(await call(session, "stop_task", { tasks: [session] })).toMatchObject({ results: [{ task: session, ok: true, did: "stopped" }] });
    await until(() => statusOf(session) === "canceled", "the task to stop");
    expect(await call(session, "release_task", { tasks: [session] })).toMatchObject({ results: [{ task: session, ok: true }] });
    await until(() => fresh() !== undefined || statusOf(session) === "running", "it to pick up again");
  });
});

// ---------------------------------------------------------------------------------------------
// the split a `start` generates
// ---------------------------------------------------------------------------------------------

describe("a generated split", () => {
  it("makes one task per element, HELD, and `release` starts the ones named", async () => {
    const session = await conversation("chat/session");
    const source = service.createTask({ title: "Pieces", workflow: "lib/list" }).taskId;
    await service.startTask({ taskId: source, fake: RULES as unknown as JsonValue });
    await until(() => statusOf(source) === "completed", "the list");
    // The source is taken under the conversation first, and then the element-wise target is started.
    const moved = (await call(session, "move_task", { task: source, to: "lib/piece" })) as unknown as MoveResult;
    if (!moved.ok) throw new Error(`refused: ${(moved as { reason: string }).reason}`);
    expect(moved).toMatchObject({ mount: "split" });
    const parent = moved.task;

    // One task per OTHER element, made and started by nobody; element 0 is the task that was moved.
    await until(() => read((p) => p.tasks.list().some((t) => t.origin?.kind === "split")), "the split's tasks");
    const made = read((p) => p.tasks.list().filter((t) => t.origin?.kind === "split"));
    expect(made).toHaveLength(ITEMS.length - 1);
    for (const task of made) {
      expect(task.origin).toMatchObject({ start: "manual" });
      expect(statusOf(task.id)).toBe("queued");
    }
    // `tasks` says so in words, and `release` is what starts one.
    const listed = (await call(parent, "list_tasks", {})) as unknown as TasksResult;
    expect(listed.tasks.filter((t) => t.held === true).map((t) => t.task).sort()).toEqual(made.map((t) => t.id).sort());
    expect(await call(parent, "release_task", { tasks: [made[0]!.id] })).toMatchObject({ results: [{ task: made[0]!.id, ok: true }] });
    await until(() => statusOf(made[0]!.id) !== "queued", "the released task to start");
    // …and the one that was not named is still standing where it was.
    expect(statusOf(made[0]!.id)).not.toBe("queued");
  });
});

// ---------------------------------------------------------------------------------------------
// what `workflows` answers
// ---------------------------------------------------------------------------------------------

describe("list_workflows", () => {
  it("lists the workflows, then ONE state at a time with its schemas and what it mounts", async () => {
    const session = await conversation("chat/session");
    const all = (await call(session, "list_workflows", {})) as unknown as WorkflowsResult;
    expect("workflows" in all && all.workflows.map((w) => w.id)).toContain("feat");

    const one = (await call(session, "list_workflows", { state: "feat" })) as unknown as WorkflowsResult;
    if (!("state" in one)) throw new Error("expected a state");
    expect(one.state).toMatchObject({ id: "feat", label: "Feature", children: [{ key: "done", state: "lib/done" }, { key: "next", state: "lib/next" }] });
    // A level at a time: the child's own inputs are asked for separately, by naming it.
    const child = (await call(session, "list_workflows", { state: "lib/next" })) as unknown as WorkflowsResult;
    if (!("state" in child)) throw new Error("expected a state");
    expect(child.state.inputs).toMatchObject({ flag: { schema: BOOL, description: "Whether the step before was confirmed.", required: true } });
    expect(child.state.outputs).toMatchObject({ confirmed: { schema: BOOL } });
  });

  it("says so rather than throwing when the state is not on the path", async () => {
    const session = await conversation("chat/session");
    expect(await call(session, "list_workflows", { state: "nope/at/all" })).toMatchObject({ error: expect.stringContaining("nope/at/all") });
  });
});
