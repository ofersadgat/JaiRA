/**
 * The record-close capture of the agent's own session file.
 *
 * The reader is faked — it is the same injected seam the executors use for their transports — so
 * what is under test is the decorator's own claims: which closes capture, which shapes carry the
 * lines, and that a failed or empty capture leaves the record exactly as it was.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToolResult } from "@declarative-ai/llm";
import type { RecordStore } from "@declarative-ai/exec";
import { withNativeCapture } from "../src/nativeCapture";

type Settled = Parameters<RecordStore["close"]>[1];

/** An inner store that remembers what reached it. */
function recorder(withBySession = false): { store: RecordStore; closes: Array<{ id: string; settled: Settled }> } {
  const closes: Array<{ id: string; settled: Settled }> = [];
  const store: RecordStore = {
    open: () => undefined,
    close: (id, settled) => {
      closes.push({ id, settled });
    },
    ...(withBySession ? { bySession: () => [] } : {}),
  };
  return { store, closes };
}

const FILE = [
  { cwd: "C:/w", version: "2.1.142", type: "user", uuid: "u1", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "prompt" } },
  { cwd: "C:/w", version: "2.1.142", type: "attachment", uuid: "a1", timestamp: new Date(2000).toISOString(), attachment: { type: "skill_listing" } },
  { cwd: "C:/w", version: "2.1.142", type: "assistant", uuid: "s1", timestamp: new Date(3000).toISOString(), message: { role: "assistant", content: "hi" } },
];

const SID = "f8f054dc-0000-4ac7-8a14-c9a19a36209a";

describe("withNativeCapture", () => {
  it("MERGES the captured file into the entries rather than storing it beside them", async () => {
    const { store, closes } = recorder();
    const read = vi.fn(async () => FILE);
    const wrapped = withNativeCapture(store, { cwd: "C:\\work\\proj", read });
    await wrapped.close("r1", {
      result: {
        value: {
          entries: [{ kind: "message", role: "assistant", provider: "anthropic", timestamp: "t", content: "hi" }],
          finishReason: "stop",
        } as never,
      },
      metrics: { startMs: 500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    // The reader is addressed by the session AND the workspace it ran in — the file is per-cwd.
    expect(read).toHaveBeenCalledWith(SID, "C:\\work\\proj");
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    expect(value["finishReason"]).toBe("stop");
    // ONE array, and no second encoding beside it.
    expect(value["nativeLines"]).toBeUndefined();
    const entries = value["entries"] as Array<Record<string, unknown>>;
    // The assistant line ANNOTATES the streamed entry — threading and clock, not a second copy.
    expect(entries[0]).toMatchObject({ kind: "message", role: "assistant", uuid: "s1" });
    // The attachment has no message to annotate, so it becomes an event of its own. The prompt
    // `user` line carries no tool result and is input the stream never returned, so it pairs with
    // nothing and adds nothing.
    expect(entries.filter((e) => e["kind"] === "event")).toMatchObject([{ event: { type: "attachment" } }]);
    // The facts that are one value per file live on the record, not on every entry.
    expect(value["session"]).toMatchObject({ cwd: expect.any(String) });
  });

  it("folds them into the session report for a delegated function op, whose payload is bare text", async () => {
    const { store, closes } = recorder();
    const wrapped = withNativeCapture(store, { cwd: "C:\\w", read: async () => FILE });
    const messages = [{ role: "assistant", content: "report" }];
    await wrapped.close("r1", {
      result: { value: "report" as never },
      sessionOutcome: { providerSessionId: SID, messages },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    // The store prefers the session report over a non-conversation payload; the lines ride the
    // shape that is actually kept.
    expect(value["messages"]).toEqual(messages);
    expect(Array.isArray(value["nativeLines"])).toBe(true);
  });

  it("cuts the file at the record's own start — a resumed session's earlier lines belong to earlier records", async () => {
    const { store, closes } = recorder();
    const wrapped = withNativeCapture(store, { cwd: "C:\\w", read: async () => FILE });
    await wrapped.close("r1", {
      result: {
        value: {
          entries: [{ kind: "message", role: "assistant", provider: "anthropic", timestamp: "t", content: "hi" }],
          finishReason: "stop",
        } as never,
      },
      metrics: { startMs: 2500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    // Only the assistant line survives the cut, and it annotates the entry it belongs to.
    const entries = value["entries"] as Array<Record<string, unknown>>;
    expect(entries.filter((e) => e["kind"] === "event")).toEqual([]);
    expect(entries[0]).toMatchObject({ uuid: "s1" });
  });

  it("leaves a close without a provider session untouched, and never reads", async () => {
    const { store, closes } = recorder();
    const read = vi.fn(async () => FILE);
    const wrapped = withNativeCapture(store, { cwd: "C:\\w", read });
    const settled: Settled = { result: { value: "plain" as never } };
    await wrapped.close("r1", settled);
    expect(read).not.toHaveBeenCalled();
    expect(closes[0]!.settled).toBe(settled);
  });

  it("stores an empty capture as NOTHING — a transport with no native file must not stamp records with an empty claim", async () => {
    const { store, closes } = recorder();
    const wrapped = withNativeCapture(store, { cwd: "C:\\w", read: async () => [] });
    await wrapped.close("r1", {
      result: { value: { messages: [], finishReason: "stop" } as never },
      sessionOutcome: { providerSessionId: "codex-conv-id" },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    expect(value["nativeLines"]).toBeUndefined();
  });

  it("tells a failed capture and closes the record exactly as it was — the annotation must not cost the memory", async () => {
    const { store, closes } = recorder();
    const onError = vi.fn();
    const wrapped = withNativeCapture(store, {
      cwd: "C:\\w",
      read: async () => {
        throw new Error("EACCES");
      },
      onError,
    });
    const settled: Settled = {
      result: { value: { messages: [], finishReason: "stop" } as never },
      sessionOutcome: { providerSessionId: SID },
    };
    await wrapped.close("r1", settled);
    expect(onError).toHaveBeenCalledOnce();
    expect(closes[0]!.settled).toBe(settled);
  });

  it("folds each subagent's own file onto the entries the stream tagged with the call that spawned it", async () => {
    const { store, closes } = recorder();
    const wrapped = withNativeCapture(store, {
      cwd: "C:\\w",
      read: async () => FILE,
      readSidechains: async () => [
        {
          agentId: "abc123",
          toolUseId: "toolu_01X",
          meta: { agentType: "Explore" },
          lines: [
            { type: "user", isSidechain: true, timestamp: new Date(2000).toISOString(), message: { role: "user", content: "task" } },
            { type: "attachment", isSidechain: true, timestamp: new Date(2100).toISOString(), attachment: { type: "skill_listing" } },
          ],
        },
        // Spawned by an earlier call of a resumed session: everything predates this record's start,
        // so ITS close captured it and this one stores nothing for it.
        { agentId: "old", toolUseId: "toolu_00", lines: [{ type: "user", isSidechain: true, timestamp: new Date(100).toISOString(), message: {} }] },
      ],
    });
    await wrapped.close("r1", {
      result: {
        value: {
          entries: [
            {
              kind: "message",
              role: "user",
              provider: "anthropic",
              timestamp: "t",
              sidechain: { id: "toolu_01X", parentToolUseId: "toolu_01X" },
              content: "task",
            },
          ],
          finishReason: "stop",
        } as never,
      },
      metrics: { startMs: 500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    // ONE array: no second field, and no second key space either.
    expect(value["nativeSidechains"]).toBeUndefined();
    const entries = value["entries"] as Array<Record<string, unknown>>;
    // §5 closed: the marker now carries the AGENT id and the call that spawned it, which is what
    // the streamed turns and the captured file were keyed by separately.
    expect(entries[0]).toMatchObject({ kind: "message", sidechain: { id: "abc123", parentToolUseId: "toolu_01X" } });
    // The subagent's own attachment is an event OF that chain, and its sidecar rides beside it.
    const events = entries.filter((e) => e["kind"] === "event" && e["sidechain"] !== undefined);
    expect(events).toMatchObject([
      { event: { type: "attachment" }, sidechain: { id: "abc123" } },
      { event: { type: "sidechain", data: { agentId: "abc123", meta: { agentType: "Explore" } } } },
    ]);
    // The chain that predates this record's start was cut, so it contributes nothing at all.
    expect(JSON.stringify(entries)).not.toContain("old");
  });

  it("mirrors the inner store's `bySession` presence — absent MEANS the store cannot read", () => {
    expect(withNativeCapture(recorder(false).store, { cwd: "C:\\w", read: async () => [] }).bySession).toBeUndefined();
    expect(withNativeCapture(recorder(true).store, { cwd: "C:\\w", read: async () => [] }).bySession).toBeDefined();
  });
});

describe("folding a tool result into the entry that asked for it", () => {
  const LINES = ["# Title", "", "Body line", "Another line"];
  const CONTENT = LINES.join("\n");
  /** What the model SAW: the file with `N<tab>` line numbers, exactly as the agent rendered it. */
  const RENDERED = LINES.map((line, i) => `${i + 1}\t${line}`).join("\n");

  const fileRead = (rendered: string) => [
    {
      cwd: "C:/w",
      type: "assistant",
      uuid: "s1",
      timestamp: new Date(1000).toISOString(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    },
    {
      cwd: "C:/w",
      type: "user",
      uuid: "u2",
      timestamp: new Date(2000).toISOString(),
      toolUseResult: { type: "text", file: { filePath: "a.md", content: CONTENT, numLines: 4, startLine: 1, totalLines: 4 } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: rendered }] },
    },
  ];

  const entriesWith = (rendered: string) => [
    { kind: "message", role: "assistant", provider: "anthropic", timestamp: "t", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { kind: "message", role: "user", provider: "anthropic", timestamp: "t", content: [{ type: "tool_result", tool_use_id: "t1", content: rendered }] },
  ];

  async function fold(rendered: string) {
    const { store, closes } = recorder();
    const wrapped = withNativeCapture(store, { cwd: "C:/w", read: async () => fileRead(rendered) as never });
    await wrapped.close("r1", {
      result: { value: { entries: entriesWith(rendered), finishReason: "stop" } as never },
      metrics: { startMs: 500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    const entries = value["entries"] as Array<{ content?: Array<Record<string, unknown>> }>;
    return entries[1]!.content![0]!;
  }

  it("DROPS the rendered text a registered renderer reproduces, and keeps the structure", async () => {
    // The measured case: 82 of 83 file reads in one run round-trip byte for byte, and the rendered
    // half of them was 0.95 MB stored beside a structure that already held it.
    const block = await fold(RENDERED);
    expect(block["content"]).toBeUndefined();
    expect(block["data"]).toMatchObject({ file: { content: CONTENT } });
    // And it comes back exactly, which is the whole licence for dropping it.
    expect(renderToolResult(block["data"] as never)).toBe(RENDERED);
  });

  it("KEEPS text a renderer does not reproduce — an unrecognized rendering costs bytes, never fidelity", async () => {
    const block = await fold("something the renderer would never produce");
    expect(block["content"]).toBe("something the renderer would never produce");
    expect(block["data"]).toBeDefined();
  });
});
