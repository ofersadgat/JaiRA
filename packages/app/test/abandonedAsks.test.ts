/**
 * A permission request whose call ENDED without an answer is let go of, in the record and on the hub
 * (2026-10-24: four `smart is unsure` asks in one chat turn, each cut by the claude CLI after 300 s of
 * hearing nothing from the bridge — and each left parked, so the turn read "Waiting for you to approve"
 * while the model worked, and the chat offered the oldest dead ask instead of the live one).
 *
 * A scripted agent streams nothing and asks nothing, so the live turn is written the way the stream
 * writes it — the call, then (later) its result — and the ask is parked the way `smart` parks one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-abandoned-asks-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Session {
  closing: boolean;
  liveTurns: { apply(taskId: string, delta: object): unknown; snapshot(taskId: string): { entries: JsonValue[] } | null };
  approvals: { askFor(request: object, context: object): Promise<string> };
}
const sessionOf = (): Session => [...(service as never as { sessions: Map<string, Session> }).sessions.values()][0]!;
/** What the stream callback does with an entry once the live turn holds it. */
const streamed = (session: Session, taskId: string, entry: object): void => {
  session.liveTurns.apply(taskId, { session: { id: "s1", seq: 1 }, entry, at: Date.now() });
  (service as never as { abandonEndedAsks(s: Session, t: string, e: object): void }).abandonEndedAsks(session, taskId, entry);
};

const LINE = "Get-Content a.jsonl -TotalCount 1";
const call = { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dai__shell", input: { command: LINE } }] } };
const cut = {
  kind: "message",
  role: "user",
  content: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: 'MCP server "dai" tool "shell" sent no response or progress for 300s; aborting.' }] },
};
/** `smart`, unsure, putting the call to the person. */
const askSmart = (session: Session, taskId: string): Promise<string> =>
  session.approvals.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: LINE }, line: LINE }, { taskId, prompt: "smart is unsure — reads session files" });

const answerOf = (session: Session, taskId: string): Record<string, unknown> | undefined => {
  for (const entry of session.liveTurns.snapshot(taskId)?.entries ?? []) {
    const parts = (entry as { content?: { content?: Array<{ type?: string; tool_use_id?: string; data?: Record<string, unknown> }> } }).content?.content ?? [];
    for (const part of parts) if (part.type === "tool_result" && part.tool_use_id?.startsWith("approve_") === true) return part.data;
  }
  return undefined;
};

describe("a permission request whose call ended without an answer", () => {
  it("is let go of as abandoned — off the hub, and answered so in the conversation", async () => {
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    const session = sessionOf();
    streamed(session, taskId, call);
    const asked = askSmart(session, taskId);
    expect(service.pendingApprovals()).toHaveLength(1);

    // The agent gives up on the call: its result arrives, and nobody waits on the answer any more.
    streamed(session, taskId, cut);
    expect(await asked).toBe("deny");
    expect(service.pendingApprovals()).toEqual([]);
    expect(pushes.some((m) => m.type === "approval:resolved")).toBe(true);
    expect(answerOf(session, taskId)).toMatchObject({ decision: "deny", by: "abandoned" });
  });

  it("is kept while the call is still going — another call's result is not its end", async () => {
    const { taskId } = service.createTask({ title: titleOf("two"), workflow: CHAT_SESSION, inputs: { message: "two" } });
    const session = sessionOf();
    streamed(session, taskId, call);
    void askSmart(session, taskId);
    streamed(session, taskId, { kind: "message", role: "user", content: { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] } });
    expect(service.pendingApprovals()).toHaveLength(1);
    expect(answerOf(session, taskId)).toBeUndefined();
  });

  it("is kept when the app is closing — a call a quit cut is a question the next open asks again", async () => {
    const { taskId } = service.createTask({ title: titleOf("three"), workflow: CHAT_SESSION, inputs: { message: "three" } });
    const session = sessionOf();
    streamed(session, taskId, call);
    void askSmart(session, taskId);
    session.closing = true;
    streamed(session, taskId, cut);
    session.closing = false;
    expect(service.pendingApprovals()).toHaveLength(1);
    expect(answerOf(session, taskId)).toBeUndefined();
  });
});
