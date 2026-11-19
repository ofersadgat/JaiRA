/**
 * A permission request, or an agent's question, that the app closed under is still there when it opens
 * again — found in the conversation's record — and answering it continues the conversation (the person,
 * 2026-10-21: "permissions and permission requests should persist across restarts … the data should
 * already support this as it should be in the record").
 *
 * The conversation is a PROGRAM (decision 0029 §2): the shipped `session`, a loop over `input()`, whose
 * reply to a message is a call of its run. The cut is made the way a quit leaves one: the app closes
 * while that reply is in flight, the run unwinds, and the reply's record is cut. Its record is then
 * given what the agent had streamed — the call that needed permission and the `approve_tool_call` it
 * made, or its own question — and no answer. A scripted agent cannot ask for permission itself, so the
 * record is written as the stream would have written it; everything from the reopen on is the real
 * service. A resumed run answers from the script it was started with, so that script carries the calls
 * a continuation makes too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

const open = async (): Promise<void> => {
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
};

beforeEach(async () => {
  // The shipped `session` is the program these conversations run.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-recovered-asks-"));
  initProject(dir, testHome());
  await open();
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

type Db = { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };

/** The open project, as the service holds it. */
function session(): {
  project: { db: Db };
  hub: { list(): Array<{ component: string; taskId?: string }> };
  liveCalls: { ofTask(taskId: string): unknown[] };
  questions: { asker(context: object): (request: object) => Promise<unknown> };
} {
  const sessions = (service as never as { sessions: Map<string, never> }).sessions;
  return [...sessions.values()][0]!;
}

/** Waiting at its `input()` for the next message. */
const parked = (taskId: string): boolean => session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);
/** A reply being made. */
const inFlight = (taskId: string): boolean => session().liveCalls.ofTask(taskId).length > 0;
const finished = (taskId: string): boolean => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

const CALL = "approve_m1_approval-x-1";
const shell = { kind: "message", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dai__shell", input: { command: "git push" } }], provider: "unknown" };
const approval = {
  kind: "message",
  role: "assistant",
  calledBy: "t1",
  content: [{ type: "tool_use", id: CALL, name: "approve_tool_call", input: { tool: "shell", command: "git push", reason: "pushes publish work" } }],
  provider: "jaira",
  timing: { at: 1_000 },
};
const question = {
  kind: "message",
  role: "assistant",
  content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which remote?", header: "Remote", options: [{ label: "origin" }, { label: "fork" }], multiSelect: false }] } }],
  provider: "unknown",
};

/** Every call these conversations make. First match wins. */
const SCRIPT: FakeRule[] = [
  { promptIncludes: "hello there", output: "hi" },
  // The reply the app closes under: held in flight until the close stops it.
  { promptIncludes: "push it", output: "never said", hold: "cancel" },
  // The continuations, made with the note saying what the person answered since.
  { promptIncludes: "They have since allowed it: make the same call again", output: "pushed" },
  { promptIncludes: "Which remote? → fork", output: "pushed to the fork" },
  { promptIncludes: "never mind", output: "ok" },
];

/** A program conversation that has answered its opening message and waits for the next. */
async function talking(): Promise<string> {
  const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
  await service.startTask({ taskId, fake: SCRIPT });
  await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
  return taskId;
}

/**
 * A conversation the app closed under while its reply to "push it" waited on `asked`: the reply was in
 * flight when the app closed, and its record holds what the agent had streamed, as a quit leaves it.
 * Open again afterwards, with the record written — what the person finds.
 */
async function cutWhileAsking(asked: object, overrides?: object): Promise<{ taskId: string; recordId: string }> {
  const taskId = await talking();
  await service.sendChatMessage({ taskId, instanceId: "", message: "push it", ...(overrides !== undefined ? { overrides } : {}) });
  await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
  await service.close();
  await open();
  const db = session().project.db;
  const { id } = db.prepare(`SELECT id FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) as { id: string };
  const opening = { kind: "message", role: "user", content: "push it", provider: "unknown" };
  db.prepare(`UPDATE operation_records SET result_json = ?, provider_session_id = 'OWN' WHERE id = ?`).run(
    JSON.stringify({ error: { classification: "canceled" }, value: { finishReason: "error", entries: [opening, shell, asked] } }),
    id,
  );
  await restart();
  return { taskId, recordId: id };
}

/** Close the app and open it again — what the person did. */
async function restart(): Promise<void> {
  await service.close();
  await open();
}

const statusOf = (recordId: string): string => (session().project.db.prepare(`SELECT status FROM operation_records WHERE id = ?`).get(recordId) as { status: string }).status;

const entriesOf = (recordId: string): Array<{ role: string; by?: string; content: unknown; calledBy?: string }> => {
  const row = session().project.db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(recordId) as { result_json: string };
  const held = JSON.parse(row.result_json) as { value?: { entries?: never[] }; messages?: never[] };
  return held.value?.entries ?? held.messages ?? [];
};

const said = (taskId: string): string[] => service.chatThread({ taskId })!.session.turns.map((t) => `${t.role}: ${t.text ?? ""}`);

describe("a permission request the app closed under", { timeout: 60_000 }, () => {
  it("is asked again when the app opens, from the record — and answering it continues the reply, and the conversation waits for the next message", async () => {
    // The message was sent with the composer's own choices, which the continuation must keep.
    const { taskId, recordId } = await cutWhileAsking(approval, { model: "fake/chosen" });
    await eventually(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    const [pending] = service.pendingApprovals();
    expect(pending).toMatchObject({ requestId: CALL, tool: "shell", command: "git push", reason: "pushes publish work", input: { command: "git push" }, taskId, recovered: true, at: 1_000 });
    expect(pushes.some((m) => m.type === "approval:requested" && (m as { pending: { requestId: string } }).pending.requestId === CALL)).toBe(true);

    service.submitApproval(CALL, "allow", "once");
    expect(service.pendingApprovals()).toEqual([]);
    // The answer is in the record beside the question at once.
    const answered = entriesOf(recordId);
    const at = answered.findIndex((e) => Array.isArray(e.content) && (e.content as Array<{ id?: string }>).some((p) => p.id === CALL));
    expect(answered[at + 1]).toMatchObject({ role: "user", calledBy: "t1", content: [{ type: "tool_result", tool_use_id: CALL, content: "allowed", data: { decision: "allow", scope: "once", by: "person" } }] });

    await eventually(() => statusOf(recordId) === "completed" && parked(taskId), "the reply to be continued, and the conversation to wait again", 20_000);
    // On the model the cut message was sent with, not the conversation's default.
    const request = session().project.db.prepare(`SELECT request_json FROM operation_records WHERE id = ?`).get(recordId) as { request_json: string };
    expect(JSON.parse(request.request_json)).toMatchObject({ config: { model: "fake/chosen" } });
    // ONE reply to the message: the cut call went on in its own record, rather than a second one beside it.
    const replies = (session().project.db.prepare(`SELECT request_json FROM operation_records WHERE task_id = ?`).all(taskId) as Array<{ request_json: string }>).filter(
      (row) => (JSON.parse(row.request_json) as { kind?: string }).kind === "prompt",
    );
    expect(replies).toHaveLength(2);
    // What it said before the cut, the note it was continued with, and what it said after. (A scripted
    // agent REPORTS its turns rather than carrying them, so the settle stores them as messages.)
    expect(entriesOf(recordId).map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const thread = said(taskId);
    expect(thread.slice(0, 2)).toEqual(["user: hello there", "assistant: hi"]);
    expect(thread).toContain("user: push it");
    expect(thread.at(-1)).toBe("assistant: pushed");
    expect(thread.some((line) => line.includes("They have since allowed it"))).toBe(true);
  });

  it("reads as waiting on you, not as ended, in the project's counts", async () => {
    const { taskId } = await cutWhileAsking(approval);
    await eventually(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    const summary = service.listProjects().find((p) => p.project === dir || p.project.toLowerCase() === dir.toLowerCase())!;
    expect(summary.waiting).toBe(1);
    expect(summary.ended.map((t) => t.taskId)).not.toContain(taskId);
  });

  it("is overtaken by a new message, and is not asked again", async () => {
    const { taskId } = await cutWhileAsking(approval);
    await eventually(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    await service.sendChatMessage({ taskId, instanceId: "", message: "never mind" });
    expect(service.pendingApprovals()).toEqual([]);
    await eventually(() => said(taskId).at(-1) === "assistant: ok" && parked(taskId), "the new message's reply", 20_000);
    await restart();
    await new Promise((r) => setTimeout(r, 200));
    expect(service.pendingApprovals()).toEqual([]);
  });

  it("is answered as stopped when the person stops the task, and is not asked again", async () => {
    const { taskId, recordId } = await cutWhileAsking(approval);
    await eventually(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    service.cancelTask(taskId);
    expect(service.pendingApprovals()).toEqual([]);
    expect(entriesOf(recordId).some((e) => Array.isArray(e.content) && (e.content as Array<{ data?: { by?: string } }>).some((p) => p.data?.by === "stopped"))).toBe(true);
    await restart();
    await new Promise((r) => setTimeout(r, 200));
    expect(service.pendingApprovals()).toEqual([]);
  });
});

describe("an agent's question the app closed under", { timeout: 60_000 }, () => {
  it("is asked again from the record, and the answers continue the reply", async () => {
    const { taskId, recordId } = await cutWhileAsking(question);
    await eventually(() => service.pendingQuestions().length === 1, "the question to be found in the record");
    const [pending] = service.pendingQuestions();
    expect(pending).toMatchObject({ requestId: "ask_q1", toolCallId: "q1", taskId, recovered: true, questions: [{ question: "Which remote?" }] });

    service.submitQuestion("ask_q1", { "Which remote?": "fork" });
    expect(service.pendingQuestions()).toEqual([]);
    await eventually(() => statusOf(recordId) === "completed" && parked(taskId), "the reply to be continued, and the conversation to wait again", 20_000);
    expect(said(taskId).at(-1)).toBe("assistant: pushed to the fork");
  });
});

describe("deleting a task that waits on you", { timeout: 60_000 }, () => {
  it("takes the question the app closed under off the strip", async () => {
    const { taskId } = await cutWhileAsking(question);
    await eventually(() => service.pendingQuestions().length === 1, "the question to be found in the record");
    await service.deleteTask(taskId);
    expect(service.pendingQuestions()).toEqual([]);
    expect(pushes).toContainEqual({ type: "question:resolved", requestId: "ask_q1" });
    expect(() => service.submitQuestion("ask_q1", { "Which remote?": "fork" })).toThrow(/no pending question/);
  });

  it("takes the permission request the app closed under off the strip", async () => {
    const { taskId } = await cutWhileAsking(approval);
    await eventually(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    await service.deleteTask(taskId);
    expect(service.pendingApprovals()).toEqual([]);
    expect(pushes.some((m) => m.type === "approval:resolved" && m.requestId === CALL)).toBe(true);
  });

  it("stops the conversation that is asking and waits it out, before the task goes — and the question is answered as stopped", async () => {
    const taskId = await talking();
    await service.sendChatMessage({ taskId, instanceId: "", message: "push it" });
    await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
    // A scripted agent asks nothing, so its reply asks the way an agent's question reaches the person.
    const asked = session().questions.asker({ taskId })({ questions: [{ question: "Which?", options: [] }], sessionId: "s", toolCallId: "t1" });
    expect(service.pendingQuestions()).toHaveLength(1);

    // Deleted from the Chat list as it is — running, and asking: nothing stops it first.
    await service.deleteTask(taskId);
    expect(() => service.taskDetail(taskId)).toThrow(/unknown task/);
    expect(service.pendingQuestions()).toEqual([]);
    expect(pushes.some((m) => m.type === "question:resolved")).toBe(true);
    expect(await asked).toBeUndefined();
    // Answered as stopped, it is not asked again either.
    await restart();
    await new Promise((r) => setTimeout(r, 200));
    expect(service.pendingQuestions()).toEqual([]);
  });
});
