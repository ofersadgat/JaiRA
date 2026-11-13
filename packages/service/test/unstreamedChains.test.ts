/**
 * Following a subagent's subagent in its own file — see `UnstreamedChains`. The stream lines are the
 * shapes claude 2.1.287 sent (2026-11-12, a background agent starting a foreground one).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeSessionCwd } from "@declarative-ai/agents-api";
import type { JsonValue } from "@declarative-ai/json";
import { UnstreamedChains, chainEntryOf, unstreamedAgentOf } from "../src/unstreamedChains";

const SID = "17741df1-fccc-4a52-9d66-7abe84d942d7";
const CWD = "C:\\w\\proj";
const started = (depth: number, agent = "a115f99985492761b", call = "toolu_inner"): JsonValue => ({
  kind: "event",
  event: { type: "provider_event", payload: { type: "system", subtype: "task_started", task_id: agent, tool_use_id: call, spawn_depth: depth, is_backgrounded: false, session_id: SID } },
});
const notified = (agent = "a115f99985492761b"): JsonValue => ({
  kind: "event",
  event: { type: "provider_event", payload: { type: "system", subtype: "task_notification", task_id: agent, tool_use_id: "toolu_inner", status: "completed", session_id: SID } },
});
const line = (v: unknown): string => `${JSON.stringify(v)}\n`;
const prompt = { type: "user", isSidechain: true, uuid: "p", message: { role: "user", content: "Run `echo hi`." } };
const call = { type: "assistant", isSidechain: true, uuid: "c", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "echo hi" } }] } };
const result = { type: "user", isSidechain: true, uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "hi" }] } };

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function world(): { chains: UnstreamedChains; file: string; fed: JsonValue[]; feed: (e: JsonValue) => void } {
  root = mkdtempSync(join(tmpdir(), "unstreamed-"));
  const dir = join(root, encodeSessionCwd(CWD), SID, "subagents");
  mkdirSync(dir, { recursive: true });
  const fed: JsonValue[] = [];
  const projects = root;
  return { chains: new UnstreamedChains(() => projects), file: join(dir, "agent-a115f99985492761b.jsonl"), fed, feed: (e) => fed.push(e) };
}

describe("which agents are followed", () => {
  it("one a subagent started (depth 2 and deeper), never one the main thread started, whose turns stream", () => {
    expect(unstreamedAgentOf(started(2))).toEqual({ agentId: "a115f99985492761b", call: "toolu_inner" });
    expect(unstreamedAgentOf(started(3))).toBeDefined();
    expect(unstreamedAgentOf(started(1))).toBeUndefined();
    expect(unstreamedAgentOf(notified())).toBeUndefined();
  });

  it("a file line becomes the entry the stream would have sent, on the spawning call's chain", () => {
    expect(chainEntryOf(call, "toolu_inner")).toEqual({ kind: "message", role: "assistant", content: call.message, parentToolUseId: "toolu_inner" });
    expect(chainEntryOf({ type: "attachment" }, "toolu_inner")).toBeUndefined();
  });
});

describe("following a file", () => {
  it("hands on each finished turn as it is written, skipping the prompt, and a half-written line waits", () => {
    const { chains, file, fed, feed } = world();
    chains.heard("t", started(2), { cwd: CWD }, feed);
    expect(chains.following("t")).toBe(true);
    // Not written yet: nothing, and no failure.
    chains.readNow("t");
    expect(fed).toEqual([]);
    appendFileSync(file, line(prompt) + line(call) + JSON.stringify(result).slice(0, 20));
    chains.readNow("t");
    expect(fed).toEqual([{ kind: "message", role: "assistant", content: call.message, parentToolUseId: "toolu_inner" }]);
    appendFileSync(file, `${JSON.stringify(result).slice(20)}\n`);
    chains.readNow("t");
    expect(fed.map((e) => (e as { role: string }).role)).toEqual(["assistant", "user"]);
    chains.stop("t");
  });

  it("reads to the end and stops at the notification that the agent ended", () => {
    const { chains, file, fed, feed } = world();
    chains.heard("t", started(2), { cwd: CWD }, feed);
    appendFileSync(file, line(prompt) + line(call) + line(result));
    chains.heard("t", notified(), { cwd: CWD }, feed);
    expect(fed).toHaveLength(2);
    expect(chains.following("t")).toBe(false);
  });

  it("follows nothing for an agent the main thread started", () => {
    const { chains, fed, feed } = world();
    chains.heard("t", started(1), { cwd: CWD }, feed);
    expect(chains.following("t")).toBe(false);
    expect(fed).toEqual([]);
  });
});
