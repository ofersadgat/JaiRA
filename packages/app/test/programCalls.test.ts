/**
 * Decision 0033: one registry draws a call by (function, role), and a program's calls are woven among
 * its conversation's messages — the person's message once, the reply as the thread, every other call a
 * row its role shows, folds or hides per view. The tree and records are shaped as a Session's are
 * (`session`, `session/call_0`, `session/input`, `session/call_1`, …).
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, OperationRecordView } from "@jaira/shared/browser";
import { ANY, CALL_RENDERERS, functionNameOf, lookup, registryOf, roleOf, visibilityOf, withOverrides } from "../src/renderer/callRenderers";
import { programCallInstance, programCallsOf, weaveProgramCalls } from "../src/renderer/programCalls";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";

describe("the registry", () => {
  const registry = registryOf({
    entries: [
      [ANY, ANY, { renderer: "tool" }],
      ["llm", ANY, { renderer: "conversation" }],
      [ANY, "aside", { renderer: "tool", options: { compact: true } }],
      ["llm", "aside", { renderer: "told" }],
    ],
  });

  it("looks up (function, role), then (*, role), then (function, *), then (*, *)", () => {
    expect(lookup(registry, "llm", "aside").renderer).toBe("told");
    expect(lookup(registry, "conversation_digest", "aside")).toEqual({ renderer: "tool", options: { compact: true } });
    expect(lookup(registry, "llm", "reply").renderer).toBe("conversation");
    expect(lookup(registry, "conversation_digest", "reply").renderer).toBe("tool");
    expect(lookup(registry, "llm").renderer).toBe("conversation");
  });

  it("puts role before function: a role's renderer beats a function's own", () => {
    const roleFirst = registryOf({ entries: [["llm", ANY, { renderer: "conversation" }], [ANY, "quiet", { renderer: "none" }]] });
    expect(lookup(roleFirst, "llm", "quiet").renderer).toBe("none");
  });

  it("lets a scope override an entry and keeps the rest", () => {
    const scoped = withOverrides(CALL_RENDERERS, { entries: [["start_task", ANY, { renderer: "tool" }]] });
    expect(lookup(scoped, "start_task").renderer).toBe("tool");
    expect(lookup(scoped, "input").renderer).toBe("message");
    expect(lookup(CALL_RENDERERS, "start_task").renderer).toBe("child-run");
  });

  it("decides visibility by role and view, apart from the renderer", () => {
    expect(visibilityOf(CALL_RENDERERS, "hidden", "chat")).toBe("hidden");
    expect(visibilityOf(CALL_RENDERERS, "hidden", "task")).toBe("folded");
    expect(visibilityOf(CALL_RENDERERS, "aside", "chat")).toBe("folded");
    expect(visibilityOf(CALL_RENDERERS, "never-heard-of-it", "chat")).toBe("shown");
    expect(roleOf(CALL_RENDERERS, "now")).toBe("hidden");
    expect(roleOf(CALL_RENDERERS, "now", "aside")).toBe("aside");
    expect(roleOf(CALL_RENDERERS, "conversation_digest")).toBe(ANY);
  });

  it("names a call by the function it calls, whatever its transport or reference calls it", () => {
    expect(functionNameOf("mcp__jaira__start_task")).toBe("start_task");
    expect(functionNameOf("user:C:/x/confidence.ts#score")).toBe("score");
    expect(functionNameOf(undefined, "prompt")).toBe("llm");
    expect(functionNameOf("input")).toBe("input");
  });
});

// --- a Session's run --------------------------------------------------------------------------------

const T = 1_795_295_765_000;
let seq = 0;
const records: Record<string, OperationRecordView> = {};

function state(key: string, at: number, record: Omit<OperationRecordView, "recordId">, extra: Partial<InstanceNode> = {}): InstanceNode {
  const id = `op-${++seq}`;
  records[id] = { recordId: id, ...record };
  const kind = (record.request as { kind?: string }).kind === "prompt" ? "prompt" : "function";
  return { instanceId: `i-${seq}`, stateId: `session/${key}`, childKey: key, status: "completed", index: 0, superseded: false, startedAt: at, endedAt: at + 500, calls: [{ operationId: id, kind }, { operationId: `tail-${seq}`, kind: "function" }], children: [], ...extra } as InstanceNode;
}

const reply = (text: string, at: number): InstanceNode =>
  state("call_0", at, { status: "completed", request: { kind: "prompt", user: text, system: "You are a working conversation", input: {} }, result: { value: { value: "ok", entries: [] } } });
const input = (text: string, at: number): InstanceNode =>
  state("input", at, { status: "completed", request: { kind: "function", functionRef: "input", input: { prompt: { kind: "text", binding: { text: "Your next message" } } } }, result: { value: { text } } });
const digest = (at: number): InstanceNode =>
  state("call_1", at, { status: "completed", request: { kind: "function", functionRef: "conversation_digest", input: { last: { kind: "json", binding: { json: 4 } } } }, result: { value: { messages: [] } } });
const notice = (at: number): InstanceNode =>
  state("call_2", at, { status: "completed", request: { kind: "prompt", user: "The person's message: two", system: "You check ONE message", input: {} }, result: { value: { value: { verdict: "none", lesson: "", quote: "" } } } }, { label: "notice" });
const lesson = (at: number): InstanceNode =>
  state("call_3", at, { status: "completed", request: { kind: "function", functionRef: "start_task", input: { workflow: { kind: "text", binding: { text: "improve/lesson" } } } }, result: { value: { ok: true, key: "improve/lesson", workflow: "improve/lesson" } } });
const clock = (at: number): InstanceNode => state("call_4", at, { status: "completed", request: { kind: "function", functionRef: "now", input: {} }, result: { value: at } });

const root = {
  instanceId: "i-root",
  stateId: "session",
  status: "running",
  index: 0,
  superseded: false,
  startedAt: T,
  children: [reply("one", T + 10), input("two", T + 1000), reply("two", T + 2000), digest(T + 3000), notice(T + 3100), lesson(T + 3200), clock(T + 3300), input("three", T + 4000)],
} as unknown as InstanceNode;

/** The thread chat reads: the person's messages and the replies, as the session holds them. */
const thread: TranscriptEntry[] = [
  { kind: "message", role: "user", text: "one", at: T + 20 },
  { kind: "message", role: "assistant", text: "one", at: T + 400 },
  { kind: "message", role: "user", text: "two", at: T + 2010 },
  { kind: "message", role: "assistant", text: "two", at: T + 2400 },
];

describe("a program's calls", () => {
  it("reads every call of the program, in order, by the function it calls", () => {
    const calls = programCallsOf(root, records);
    expect(calls.map((c) => c.fn)).toEqual(["llm", "input", "llm", "conversation_digest", "llm", "start_task", "now", "input"]);
    expect(calls[4]!.label).toBe("notice");
    expect(calls[4]!.args).toEqual({ prompt: "The person's message: two", system: "You check ONE message" });
    expect(calls[4]!.result).toEqual({ verdict: "none", lesson: "", quote: "" });
    expect(calls[3]!.label).toBe("conversation_digest");
    expect(calls[3]!.args).toEqual({ last: 4 });
  });

  it("reads each call a phase's code made, named and drawn by what the script said at its site (the coarser modes)", () => {
    const at = (id: string, ms: number, request: Record<string, unknown>, value: unknown) => {
      records[id] = { recordId: id, status: "completed", request: request as never, result: { value } as never, startedAt: T + ms, endedAt: T + ms + 10 };
    };
    at("p-1", 5000, { kind: "prompt", user: "look", input: {} }, { value: "seen" });
    at("p-2", 5100, { kind: "function", functionRef: "conversation_digest", input: {} }, { messages: [] });
    const phase = {
      instanceId: "i-phase",
      stateId: "session/check",
      childKey: "check",
      label: "Check",
      status: "completed",
      index: 0,
      superseded: false,
      startedAt: T + 4990,
      calls: [{ operationId: "p-1", kind: "prompt", site: "h1#0" }, { operationId: "p-2", kind: "function", site: "h2#0" }],
      scriptCalls: { "h1#0": { label: "look", present: { role: "aside", title: "Looking" } }, "h2#0": { label: "conversation_digest" } },
      children: [],
    } as unknown as InstanceNode;
    const calls = programCallsOf({ ...root, children: [phase] } as InstanceNode, records);
    expect(calls.map((c) => [c.label, c.operationId, c.at - T, c.present])).toEqual([
      ["Looking", "p-1", 5000, { role: "aside", title: "Looking" }],
      ["conversation_digest", "p-2", 5100, undefined],
    ]);
    // Two rows of one state, told apart, and each interrupts the state that made it.
    const rows = weaveProgramCalls([], calls, "task").filter((e): e is ToolEntry => e.kind === "tool");
    expect(new Set(rows.map((r) => r.callId)).size).toBe(2);
    expect(rows.map((r) => programCallInstance(r.callId))).toEqual(["i-phase", "i-phase"]);
  });

  it("is nothing for a run that is not a program", () => {
    expect(programCallsOf(undefined, records)).toEqual([]);
    expect(programCallsOf({ ...root, children: [] } as InstanceNode, records)).toEqual([]);
  });
});

describe("woven into the thread", () => {
  const calls = programCallsOf(root, records);
  const shape = (entries: TranscriptEntry[]): string[] => entries.map((e) => (e.kind === "message" ? `${e.role}:${e.text}` : e.kind === "tool" ? `tool:${e.name}` : e.kind === "event" ? `event:${e.text}` : e.kind));

  it("draws the person's message once and the reply as the thread", () => {
    const woven = weaveProgramCalls(thread, calls, "chat");
    expect(woven.filter((e) => e.kind === "message")).toHaveLength(5);
    expect(shape(woven)).toEqual(["user:one", "assistant:one", "user:two", "assistant:two", "tool:conversation_digest", "tool:notice", "tool:start_task", "user:three"]);
  });

  it("draws the person's waiting message when no reply holds it yet", () => {
    const woven = weaveProgramCalls(thread, calls, "chat");
    expect(woven.at(-1)).toMatchObject({ kind: "message", role: "user", text: "three" });
  });

  it("folds a hidden call into the task view and leaves it out of chat", () => {
    expect(shape(weaveProgramCalls(thread, calls, "chat"))).not.toContain("tool:now");
    expect(shape(weaveProgramCalls(thread, calls, "task"))).toContain("tool:now");
  });

  it("gives a check its answer, and a started run its outcome", () => {
    const woven = weaveProgramCalls(thread, calls, "task");
    expect(woven.find((e) => e.kind === "tool" && e.name === "notice")).toMatchObject({ ok: true, result: { verdict: "none", lesson: "", quote: "" } });
    expect(woven.find((e) => e.kind === "tool" && e.name === "start_task")).toMatchObject({ ok: true, result: { ok: true, key: "improve/lesson" } });
  });

  it("follows what a script said: a role, a title, or nothing drawn", () => {
    const hinted = calls.map((c) => (c.fn === "conversation_digest" ? { ...c, present: { role: "hidden" } } : c.fn === "start_task" ? { ...c, present: { renderer: null } } : c));
    const woven = shape(weaveProgramCalls(thread, hinted, "chat"));
    expect(woven).not.toContain("tool:conversation_digest");
    expect(woven).not.toContain("tool:start_task");
    expect(woven).toContain("tool:notice");
  });

  it("reads renderUI's config down the call path, the nearest scope winning and the scopes' renderers adding up", () => {
    const scoped = {
      ...root,
      present: { role: "aside" },
      children: [
        { ...root.children[3]!, present: { title: "Reading the conversation" } },
        {
          ...root,
          instanceId: "i-helper",
          stateId: "session/check",
          childKey: "check",
          present: { role: "aside", title: "Checking", renderers: [["start_task", "*", "tool"], ["llm", "aside", { id: "told" }]] },
          children: [root.children[4]!, { ...root.children[5]!, present: { renderer: null } }],
        },
        root.children[6]!,
      ],
    } as unknown as InstanceNode;
    const calls = programCallsOf(scoped, records);
    expect(calls.map((c) => [c.fn, c.present])).toEqual([
      ["conversation_digest", { role: "aside", title: "Reading the conversation" }],
      ["llm", { role: "aside", title: "Checking", renderers: [["start_task", "*", { renderer: "tool" }], ["llm", "aside", { renderer: "told" }]] }],
      ["start_task", { role: "aside", title: "Checking", renderer: null, renderers: [["start_task", "*", { renderer: "tool" }], ["llm", "aside", { renderer: "told" }]] }],
      ["now", { role: "aside" }],
    ]);
    expect(calls[0]!.label).toBe("Reading the conversation");
    // The helper's registry draws its check as a told line; its start_task draws nothing; the clock's
    // role is the root's `aside`, which chat folds rather than hides.
    const woven = weaveProgramCalls([], calls, "chat");
    expect(woven.map((e) => e.kind)).toEqual(["tool", "tool", "tool"]);
    expect(woven.map((e) => (e.kind === "tool" ? e.name : ""))).toEqual(["Reading the conversation", "Checking", "now"]);
  });

  it("ignores a renderer the app does not have, leaving the registry's own", () => {
    const odd = { ...root, children: [{ ...root.children[3]!, present: { renderer: "sparkles" } }] } as unknown as InstanceNode;
    const [call] = programCallsOf(odd, records);
    expect(call!.present).toEqual({});
    expect(weaveProgramCalls([], [call!], "chat")[0]).toMatchObject({ kind: "tool", name: "conversation_digest" });
  });

  it("draws every step as a row of its own where every step is asked for — the waits, the replies, what a role hides", () => {
    const calls = programCallsOf(root, records);
    const every = shape(weaveProgramCalls(thread, calls, "task", undefined, true));
    expect(every.filter((e) => e.startsWith("tool:"))).toEqual(["tool:llm", "tool:input", "tool:llm", "tool:conversation_digest", "tool:notice", "tool:start_task", "tool:now", "tool:input"]);
    // The messages are still the thread's, said once each.
    expect(every.filter((e) => e.startsWith("user:"))).toEqual(["user:one", "user:two", "user:three"]);
  });

  it("keeps a live answer after everything recorded", () => {
    const live: TranscriptEntry[] = [...thread, { kind: "live", text: "thr" }];
    expect(weaveProgramCalls(live, calls, "chat").at(-1)!.kind).toBe("live");
  });
});
