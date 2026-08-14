/**
 * The record-close capture of the agent's own session file.
 *
 * The reader is faked — it is the same injected seam the executors use for their transports — so
 * what is under test is the decorator's own claims: which closes capture, which shapes carry the
 * lines, and that a failed or empty capture leaves the record exactly as it was.
 */
import { describe, expect, it, vi } from "vitest";
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
  { type: "user", uuid: "u1", timestamp: new Date(1000).toISOString(), message: { role: "user", content: "prompt" } },
  { type: "attachment", uuid: "a1", timestamp: new Date(2000).toISOString(), attachment: { type: "skill_listing" } },
  { type: "assistant", uuid: "s1", timestamp: new Date(3000).toISOString(), message: { role: "assistant", content: "hi" } },
];

const SID = "f8f054dc-0000-4ac7-8a14-c9a19a36209a";

describe("withNativeCapture", () => {
  it("folds the captured lines into a prompt-op payload, beside what the stream carried", async () => {
    const { store, closes } = recorder();
    const read = vi.fn(async () => FILE);
    const wrapped = withNativeCapture(store, { cwd: "C:\\work\\proj", read });
    await wrapped.close("r1", {
      result: { value: { messages: [{ role: "assistant", content: "hi" }], finishReason: "stop" } as never },
      metrics: { startMs: 500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    // The reader is addressed by the session AND the workspace it ran in — the file is per-cwd.
    expect(read).toHaveBeenCalledWith(SID, "C:\\work\\proj");
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    expect(value["finishReason"]).toBe("stop");
    const native = value["nativeLines"] as Array<{ index: number; line: { type?: string } }>;
    expect(native.map((n) => n.line.type)).toEqual(["user", "attachment", "assistant"]);
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
      result: { value: { messages: [], finishReason: "stop" } as never },
      metrics: { startMs: 2500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    const native = value["nativeLines"] as Array<{ line: { type?: string } }>;
    expect(native.map((n) => n.line.type)).toEqual(["assistant"]);
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

  it("captures each subagent's own file, keyed by the spawning tool call like `sidechains` is", async () => {
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
      result: { value: { messages: [], finishReason: "stop" } as never },
      metrics: { startMs: 500, durationMs: 10 },
      sessionOutcome: { providerSessionId: SID },
    });
    const value = (closes[0]!.settled.result as { value: Record<string, unknown> }).value;
    const chains = value["nativeSidechains"] as Record<string, { agentId: string; meta?: unknown; lines: unknown[] }>;
    expect(Object.keys(chains)).toEqual(["toolu_01X"]);
    expect(chains["toolu_01X"]).toMatchObject({ agentId: "abc123", meta: { agentType: "Explore" } });
    expect(chains["toolu_01X"]!.lines).toHaveLength(2);
  });

  it("mirrors the inner store's `bySession` presence — absent MEANS the store cannot read", () => {
    expect(withNativeCapture(recorder(false).store, { cwd: "C:\\w", read: async () => [] }).bySession).toBeUndefined();
    expect(withNativeCapture(recorder(true).store, { cwd: "C:\\w", read: async () => [] }).bySession).toBeDefined();
  });
});
