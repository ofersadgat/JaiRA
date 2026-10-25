/**
 * A call a RULE refused — the permission set, the built-in rules, the scopes — is a step under the call
 * in its conversation, the way auto's verdict and the person's answer are (the person, 2026-10-24: "a
 * recorded step for the permission set's own refusals"). Without it the call's row could not say who
 * refused it: the agent's own refusals and a tool that broke reach the record in the same error shape.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { JsonValue } from "@declarative-ai/json";
import type { RuleRefusal } from "@jaira/runtime";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";
import { entriesOf, type ToolEntry } from "../src/renderer/transcript";

let dir: string;
let service: AppService;

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-rule-refusal-"));
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
const sessionOf = (): Session => [...(service as never as { sessions: Map<string, Session> }).sessions.values()][0]!;
const record = (session: Session, taskId: string, refused: RuleRefusal): void =>
  (service as never as { recordRuleRefusal(s: Session, t: string, r: RuleRefusal): void }).recordRuleRefusal(session, taskId, refused);

const LINE = "git commit -m wip && git rm a.txt";
const call = { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dai__shell", input: { command: LINE } }] } };

describe("a call a rule refused", () => {
  it("gets a step under it that has come to deny, named for the rule — and the call reads as denied by it", () => {
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    const session = sessionOf();
    session.liveTurns.apply(taskId, { session: { id: "s1", seq: 1 }, entry: call, at: Date.now() });
    record(session, taskId, { tool: "shell", input: { command: LINE }, by: { kind: "rule", rule: "permission set", reason: "git rm a.txt" } });

    // Read as the conversation reads a live turn: paired, and each call marked by the steps under it.
    const entries = entriesOf(null, [], { text: "", entries: session.liveTurns.snapshot(taskId)!.entries });
    const step = entries.find((e) => e.kind === "tool" && e.name === "check_permission") as ToolEntry;
    expect(step).toMatchObject({ calledBy: "t1", args: { function: "the permission set", rule: true, tool: "shell", command: LINE } });
    expect(step.detail).toMatchObject({ verdict: "deny", reason: "git rm a.txt", tookMs: 0 });
    const refused = entries.find((e) => e.kind === "tool" && e.callId === "t1") as ToolEntry;
    expect(refused.refused).toEqual({ kind: "denied", by: "the permission set" });
  });
});
