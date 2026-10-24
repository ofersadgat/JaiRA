/**
 * A permission function asked about a call is a step of that call in the conversation (the person,
 * 2026-10-24, option B): `check_permission`, called by the call, open while the function decides, then
 * answered with what it came to — so the turn can say "auto is checking it" instead of calling the wait
 * the tool running, and say afterwards what auto decided.
 *
 * A scripted agent streams nothing and asks no function, so the live turn is written the way the stream
 * writes it — the call — and the service is told what the approver tells it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { initProject } from "@jaira/persistence";
import type { PermissionFunctionRequest } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-permission-checks-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), publish: () => undefined });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Session {
  liveTurns: { apply(taskId: string, delta: object): unknown; snapshot(taskId: string): { entries: JsonValue[] } | null };
}
interface Recording {
  recordCheckCall(s: Session, taskId: string, request: PermissionFunctionRequest): void;
  recordCheckResult(s: Session, taskId: string, request: PermissionFunctionRequest, verdict: string, reason?: string): void;
}
const sessionOf = (): Session => [...(service as never as { sessions: Map<string, Session> }).sessions.values()][0]!;
const recording = (): Recording => service as never as Recording;

const URL = "https://example.com";
const call = { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "f1", name: "mcp__dai__web_fetch", input: { url: URL } }] } };
const request: PermissionFunctionRequest = { tool: "web_fetch", subject: "web_fetch", function: "smart", input: { url: URL }, task: "t" };

/** The host calls on the live turn, as `{ by, part }`. */
const hostCallsOf = (session: Session, taskId: string): Array<{ by: unknown; part: Record<string, unknown> }> =>
  (session.liveTurns.snapshot(taskId)?.entries ?? []).flatMap((entry) => {
    const e = entry as { calledBy?: unknown; content?: { content?: Array<Record<string, unknown>> } };
    return e.calledBy === undefined ? [] : (e.content?.content ?? []).map((part) => ({ by: e.calledBy, part }));
  });

describe("a permission function asked about a call", () => {
  it("is a step of the call — open while it decides, then answered with what it came to, once", async () => {
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    const session = sessionOf();
    session.liveTurns.apply(taskId, { session: { id: "s1", seq: 1 }, entry: call, at: Date.now() });

    recording().recordCheckCall(session, taskId, request);
    const asking = hostCallsOf(session, taskId);
    expect(asking).toHaveLength(1);
    expect(asking[0]).toMatchObject({ by: "f1", part: { type: "tool_use", name: "check_permission", input: { function: "smart", tool: "web_fetch", subject: "web_fetch" } } });
    const id = asking[0]!.part["id"];

    // The judge's word arrives — about the same request, handed back through the engine as a copy.
    recording().recordCheckResult(session, taskId, JSON.parse(JSON.stringify(request)) as PermissionFunctionRequest, "unsure", "an outside fetch the task did not ask for");
    const answered = hostCallsOf(session, taskId);
    expect(answered).toHaveLength(2);
    expect(answered[1]).toMatchObject({ by: "f1", part: { type: "tool_result", tool_use_id: id, content: "unsure: put to the person", data: { verdict: "unsure", reason: "an outside fetch the task did not ask for" } } });

    // The approver's own word after the person answered is about a check already closed: no news.
    recording().recordCheckResult(session, taskId, request, "allow");
    expect(hostCallsOf(session, taskId)).toHaveLength(2);
  });

  it("keeps two parts of one line apart — each part is its own check", async () => {
    const { taskId } = service.createTask({ title: titleOf("two"), workflow: CHAT_SESSION, inputs: { message: "two" } });
    const session = sessionOf();
    const line = "cargo check && tsc --noEmit";
    const shell = { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "mcp__dai__shell", input: { command: line } }] } };
    session.liveTurns.apply(taskId, { session: { id: "s1", seq: 1 }, entry: shell, at: Date.now() });
    const part = (text: string): PermissionFunctionRequest => ({ tool: "shell", subject: "shell", function: "smart", input: { command: line }, line, part: { text, kind: "command", subject: "shell", span: { start: 0, end: text.length } } });
    recording().recordCheckCall(session, taskId, part("cargo check"));
    recording().recordCheckCall(session, taskId, part("tsc --noEmit"));
    recording().recordCheckResult(session, taskId, part("tsc --noEmit"), "allow");
    const calls = hostCallsOf(session, taskId);
    const [first, second, result] = calls;
    expect(first!.part).toMatchObject({ input: { part: "cargo check", command: line } });
    expect(second!.part).toMatchObject({ input: { part: "tsc --noEmit" } });
    // The second part's answer closes the second part's check, not the first's.
    expect(result!.part).toMatchObject({ tool_use_id: second!.part["id"], data: { verdict: "allow" } });
  });
});
