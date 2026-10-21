/**
 * A permission request, or an agent's question, that the app closed under is still there when it opens
 * again — found in the conversation's record — and answering it continues the conversation (the person,
 * 2026-10-21: "permissions and permission requests should persist across restarts … the data should
 * already support this as it should be in the record").
 *
 * The cut turn is made the way a quit leaves one: a chat turn that ended `interrupted`, its record
 * holding what the agent had streamed — the call that needed permission and the `approve_tool_call` it
 * made — and no answer. A scripted agent cannot ask for permission itself, so the record is written as
 * the stream would have written it; everything from the reopen on is the real service.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { parseFakeRules, type FakeRule } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

const open = async (): Promise<void> => {
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
};

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-recovered-asks-"));
  initProject(dir, testHome());
  await open();
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

/** The open project, as the service holds it. */
function session(): { project: { db: { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } } }; fakeRules: Map<string, FakeRule[]>; approvals: { seed: unknown } } {
  const sessions = (service as never as { sessions: Map<string, never> }).sessions;
  return [...sessions.values()][0]!;
}

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

/**
 * A conversation whose second turn the app closed under while it waited on `asked`: the turn ran and
 * was cut, and its record holds what the agent had streamed, as a quit leaves it.
 */
async function cutWhileAsking(asked: object, overrides?: object): Promise<{ taskId: string; recordId: string }> {
  const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
  await service.startTask({ taskId, fake: [{ output: "first answer" }] });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
  const thread = service.chatThread({ taskId })!;
  await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "push it", ...(overrides !== undefined ? { overrides } : {}), fake: [{ error: "the app was closed", classification: "interrupted" }] });
  const db = session().project.db;
  const { id } = db.prepare(`SELECT id FROM operation_records WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) as { id: string };
  const opening = { kind: "message", role: "user", content: "push it", provider: "unknown" };
  db.prepare(`UPDATE operation_records SET result_json = ?, provider_session_id = 'OWN' WHERE id = ?`).run(
    JSON.stringify({ error: { classification: "interrupted" }, value: { finishReason: "error", entries: [opening, shell, asked] } }),
    id,
  );
  return { taskId, recordId: id };
}

/** Close the app and open it again — what the person did. */
async function restart(): Promise<void> {
  await service.close();
  await open();
}

const entriesOf = (recordId: string): Array<{ role: string; by?: string; content: unknown; calledBy?: string }> => {
  const row = session().project.db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(recordId) as { result_json: string };
  const held = JSON.parse(row.result_json) as { value?: { entries?: never[] }; messages?: never[] };
  return held.value?.entries ?? held.messages ?? [];
};

describe("a permission request the app closed under", () => {
  it("is asked again when the app opens, from the record — and answering it continues the turn", async () => {
    // The message was sent with the composer's own choices, which the continuation must keep.
    const overrides = { model: "fake/chosen" };
    const { taskId, recordId } = await cutWhileAsking(approval, overrides);
    await restart();
    await until(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    const [pending] = service.pendingApprovals();
    expect(pending).toMatchObject({ requestId: CALL, tool: "shell", command: "git push", reason: "pushes publish work", input: { command: "git push" }, taskId, recovered: true, at: 1_000 });
    expect(pushes.some((m) => m.type === "approval:requested" && (m as { pending: { requestId: string } }).pending.requestId === CALL)).toBe(true);

    // The continuation is made with the note — matched here, or the scripted agent answers nothing.
    session().fakeRules.set(taskId, parseFakeRules([{ promptIncludes: "They have since allowed it: make the same call again", output: "pushed" }]));
    service.submitApproval(CALL, "allow", "once");
    expect(service.pendingApprovals()).toEqual([]);
    // The answer is in the record beside the question at once.
    const answered = entriesOf(recordId);
    const at = answered.findIndex((e) => Array.isArray(e.content) && (e.content as Array<{ id?: string }>).some((p) => p.id === CALL));
    expect(answered[at + 1]).toMatchObject({ role: "user", calledBy: "t1", content: [{ type: "tool_result", tool_use_id: CALL, content: "allowed", data: { decision: "allow", scope: "once", by: "person" } }] });

    await until(() => (session().project.db.prepare(`SELECT status FROM operation_records WHERE id = ?`).get(recordId) as { status: string }).status === "completed", "the turn to be continued");
    // With the settings the cut message was sent with, not the conversation's defaults.
    const request = session().project.db.prepare(`SELECT request_json FROM operation_records WHERE id = ?`).get(recordId) as { request_json: string };
    expect(JSON.parse(request.request_json)).toMatchObject({ chatSettings: overrides });
    // ONE record: the cut turn went on in its own, rather than a second one beside it.
    const { n } = session().project.db.prepare(`SELECT COUNT(*) AS n FROM operation_records WHERE task_id = ?`).get(taskId) as { n: number };
    expect(n).toBe(2);
    // What it said before the cut, the note it was continued with, and what it said after. (A scripted
    // agent REPORTS its turns rather than carrying them, so the settle stores them as messages.)
    expect(entriesOf(recordId).map((e) => e.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const thread = service.chatThread({ taskId })!.session.turns.map((t) => `${t.role}: ${t.text ?? ""}`);
    expect(thread[0]).toBe("user: one");
    expect(thread).toContain("user: push it");
    expect(thread.at(-1)).toBe("assistant: pushed");
    expect(thread.some((line) => line.includes("They have since allowed it"))).toBe(true);
  }, 30_000);

  it("reads as waiting on you, not as ended, in the project's counts", async () => {
    const { taskId } = await cutWhileAsking(approval);
    await restart();
    await until(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    const summary = service.listProjects().find((p) => p.project === dir || p.project.toLowerCase() === dir.toLowerCase())!;
    expect(summary.waiting).toBe(1);
    expect(summary.ended.map((t) => t.taskId)).not.toContain(taskId);
  }, 30_000);

  it("is overtaken by a new message, and is not asked again", async () => {
    const { taskId } = await cutWhileAsking(approval);
    await restart();
    await until(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "never mind", fake: [{ output: "ok" }] });
    expect(service.pendingApprovals()).toEqual([]);
    await restart();
    await new Promise((r) => setTimeout(r, 200));
    expect(service.pendingApprovals()).toEqual([]);
  }, 30_000);

  it("is answered as stopped when the person stops the task, and is not asked again", async () => {
    const { taskId, recordId } = await cutWhileAsking(approval);
    await restart();
    await until(() => service.pendingApprovals().length === 1, "the request to be found in the record");
    service.cancelTask(taskId);
    expect(service.pendingApprovals()).toEqual([]);
    expect(entriesOf(recordId).some((e) => Array.isArray(e.content) && (e.content as Array<{ data?: { by?: string } }>).some((p) => p.data?.by === "stopped"))).toBe(true);
    await restart();
    await new Promise((r) => setTimeout(r, 200));
    expect(service.pendingApprovals()).toEqual([]);
  }, 30_000);
});

describe("an agent's question the app closed under", () => {
  it("is asked again from the record, and the answers continue the turn", async () => {
    const { taskId, recordId } = await cutWhileAsking(question);
    await restart();
    await until(() => service.pendingQuestions().length === 1, "the question to be found in the record");
    const [pending] = service.pendingQuestions();
    expect(pending).toMatchObject({ requestId: "ask_q1", toolCallId: "q1", taskId, recovered: true, questions: [{ question: "Which remote?" }] });

    session().fakeRules.set(taskId, parseFakeRules([{ promptIncludes: "Which remote? → fork", output: "pushed to the fork" }]));
    service.submitQuestion("ask_q1", { "Which remote?": "fork" });
    await until(() => (session().project.db.prepare(`SELECT status FROM operation_records WHERE id = ?`).get(recordId) as { status: string }).status === "completed", "the turn to be continued");
    const thread = service.chatThread({ taskId })!.session.turns.map((t) => `${t.role}: ${t.text ?? ""}`);
    expect(thread.at(-1)).toBe("assistant: pushed to the fork");
  }, 30_000);
});
