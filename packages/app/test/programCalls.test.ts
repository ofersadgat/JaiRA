/**
 * Decision 0033: one registry draws a call by (function, role), and a program's calls are woven among
 * its conversation's messages — the person's message once, the reply as the thread, every other call a
 * row its role shows, folds or hides per view. The tree and records are shaped as a Session's are
 * (`session`, `session/call_0`, `session/input`, `session/call_1`, …).
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, OperationRecordView } from "@jaira/shared/browser";
import { ANY, CALL_RENDERERS, functionNameOf, lookup, registryOf, roleOf, visibilityOf, withOverrides } from "../src/renderer/callRenderers";
import { STEP_SLACK_MS, programCallInstance, programCallsOf, stepBlockOf, stepOf, stepsAt, weaveProgramCalls } from "../src/renderer/programCalls";
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

  it("has no answer for a call still going, though its record already holds what it has said so far", () => {
    records["r-1"] = { recordId: "r-1", status: "open", request: { kind: "prompt", user: "The person's message: x", input: {} } as never, result: { entries: [{ kind: "message", role: "user", content: "The person's message: x" }] } as never };
    const going = { ...root, children: [{ ...root.children[4]!, instanceId: "i-going", endedAt: undefined, calls: [{ operationId: "r-1", kind: "prompt" }] }] } as unknown as InstanceNode;
    const [call] = programCallsOf(going, records);
    expect(call!.result).toBeUndefined();
    const [row] = weaveProgramCalls([], [call!], "task");
    // No answer and no mark: the row is running, which is what offers its own Interrupt.
    expect(row).toMatchObject({ kind: "tool", name: "notice" });
    expect((row as ToolEntry).ok).toBeUndefined();
    expect((row as ToolEntry).result).toBeUndefined();
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
    // A wait is a row, but no call to interrupt.
    const waits = weaveProgramCalls(thread, calls, "task", undefined, true).filter((e): e is ToolEntry => e.kind === "tool" && e.name === "input");
    expect(waits.every((w) => programCallInstance(w.callId) === undefined)).toBe(true);
    // The messages are still the thread's, said once each.
    expect(every.filter((e) => e.startsWith("user:"))).toEqual(["user:one", "user:two", "user:three"]);
  });

  it("keeps a live answer after everything recorded", () => {
    const live: TranscriptEntry[] = [...thread, { kind: "live", text: "thr" }];
    expect(weaveProgramCalls(live, calls, "chat").at(-1)!.kind).toBe("live");
  });
});

describe("a step picked in the Steps index, found in the thread by time", () => {
  // The blocks the thread draws: the first message, its reply, the second message, the work after it.
  const spans = [
    { from: T + 20, to: T + 20 },
    { from: T + 400, to: T + 400 },
    { from: T + 2010, to: T + 2010 },
    { from: T + 3000, to: T + 3300 },
  ];

  it("lands on the work a call is a row of", () => {
    expect(stepBlockOf(spans, T + 3100)).toBe(3);
    expect(stepBlockOf(spans, T + 3300)).toBe(3);
  });

  it("lands on the work a call falls in, though the message before it ended a moment earlier", () => {
    const quick = [{ from: T + 2010, to: T + 2010 }, { from: T + 2012, to: T + 2020 }];
    expect(stepBlockOf(quick, T + 2015)).toBe(1);
  });

  it("lands a reply on the message it answers, entered a moment after it", () => {
    expect(stepBlockOf(spans, T + 2000 + STEP_SLACK_MS - 10)).toBe(2);
  });

  it("lands a wait on the message that answered it", () => {
    expect(stepBlockOf(spans, T + 1000)).toBe(2);
  });

  it("lands past every block on the last, and nowhere with none", () => {
    expect(stepBlockOf(spans, T + 9000)).toBe(3);
    expect(stepBlockOf([], T)).toBe(-1);
  });

  it("finds a step by its id, the root included", () => {
    expect(stepOf(root, "i-root")).toBe(root);
    expect(stepOf(root, root.children[3]!.instanceId)).toBe(root.children[3]);
    expect(stepOf(root, "nope")).toBeUndefined();
  });

  it("tells which step the reader is at, and the steps on screen", () => {
    const at = stepsAt(root, T + 2700, { from: T + 2010, to: T + 3300 });
    expect(at.current).toBe(root.children[2]!.instanceId);
    expect(stepsAt(root, T + 3300).current).toBe(root.children[6]!.instanceId);
    expect([...at.onScreen].sort()).toEqual([root.children[2], root.children[3], root.children[4], root.children[5], root.children[6]].map((n) => n!.instanceId).sort());
    expect(stepsAt(root, T - STEP_SLACK_MS - 100).current).toBe("i-root");
  });
});

describe("a thread whose record keeps no times", () => {
  const calls = programCallsOf(root, records);
  const untimed: TranscriptEntry[] = [
    { kind: "message", role: "user", text: "one" },
    { kind: "message", role: "assistant", text: "one" },
    { kind: "message", role: "user", text: "two" },
    { kind: "message", role: "assistant", text: "two" },
    { kind: "message", role: "user", text: "three" },
  ];

  it("dates each message by the program's own calls, so its calls are woven where they happened", () => {
    const woven = weaveProgramCalls(untimed, calls, "task");
    const times = woven.map((e) => (e.kind === "message" ? `${e.role}:${e.text}@${(e.at ?? NaN) - T}` : e.kind === "tool" ? `tool:${e.name}@${(e.at ?? NaN) - T}` : e.kind));
    // The first message as its reply starts, each reply as it ends, a later message as the wait for it ends.
    expect(times).toEqual(["user:one@10", "assistant:one@510", "user:two@1500", "assistant:two@2500", "tool:conversation_digest@3000", "tool:notice@3100", "tool:start_task@3200", "tool:now@3300", "user:three@4500"]);
  });

  it("keeps a time a message already has", () => {
    const woven = weaveProgramCalls([{ kind: "message", role: "user", text: "one", at: T + 7 }], calls, "task");
    expect(woven.find((e) => e.kind === "message")!.at).toBe(T + 7);
  });
});
