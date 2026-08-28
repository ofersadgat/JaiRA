/**
 * Main's live-turn log — the fix for a watched conversation going blank on navigation.
 *
 * The record lands only when the operation settles, so while a call streams, the delta stream is
 * the only holder of its conversation. The renderer used to be the only accumulator and wiped its
 * copy on every navigation; this log is the same accumulation held in main, so `session:live` can
 * hand a returning viewer everything it missed. The semantics under test are exactly the
 * renderer's: replace on a position change, sidechains apart, text tails restarting on a finished
 * assistant turn — plus the `n` protocol that makes seed-then-push merging exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTurnFlusher, LiveTurnLog, partialRecordValue } from "../src/main/liveTurns";
import type { JsonValue } from "@declarative-ai/json";

const at = (id: string, seq: number) => ({ session: { id, seq } });

describe("LiveTurnLog", () => {
  it("accumulates text, thinking and entries for one position", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), stateId: "plan", thinking: "hm " });
    log.apply("t1", { ...at("s", 1), text: "Hel" });
    log.apply("t1", { ...at("s", 1), text: "lo" });
    log.apply("t1", { ...at("s", 1), entry: { kind: "event", event: { type: "x" } } });
    expect(log.snapshot("t1")).toMatchObject({
      sessionId: "s",
      seq: 1,
      stateId: "plan",
      n: 4,
      text: "Hello",
      thinking: "hm ",
      entries: [{ kind: "event", event: { type: "x" } }],
    });
  });

  it("replaces the tail when a different position speaks — never concatenates two states", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), text: "first" });
    log.apply("t1", { ...at("s", 2), text: "second" });
    expect(log.snapshot("t1")).toMatchObject({ seq: 2, text: "second", n: 2 });
  });

  it("keeps `n` monotone across replacements, so stale pushes stay skippable", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), text: "a" });
    log.apply("t1", { ...at("s", 2), text: "b" });
    log.clear("t1");
    expect(log.apply("t1", { ...at("s", 3), text: "c" })).toMatchObject({ n: 3 });
  });

  it("stamps entries with times: completion on every entry, start + thought duration on a finished turn", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, thinking: "hm" });
    log.apply("t1", { ...at("s", 1), at: 250, text: "Hel" });
    const { entry } = log.apply("t1", { ...at("s", 1), at: 400, entry: { kind: "message", role: "assistant", content: {} } });
    // startedAt = first delta of the turn (the thinking), thoughtMs = thinking start → answer start.
    expect(entry).toMatchObject({ at: 400, startedAt: 100, thoughtMs: 150 });
    // The tails and their clocks restart with the finished turn.
    expect(log.snapshot("t1")).toMatchObject({ text: "", thinking: "" });
    expect(log.snapshot("t1")!.thinkingStartedAt).toBeUndefined();
  });

  it("exposes the tail clocks — thinkingStartedAt with an empty text tail IS the 'thinking' state", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, thinking: "let me see" });
    expect(log.snapshot("t1")).toMatchObject({ thinking: "let me see", thinkingStartedAt: 100 });
    expect(log.snapshot("t1")!.textStartedAt).toBeUndefined();
  });

  it("starts the thinking clock off BOOKKEEPING, for a think whose text the provider withholds", () => {
    // No `thinking` delta ever arrives for a withheld think — the transports drop the empty ones —
    // so the block opening is the only notice. Without this the clock never started, no tail was
    // published, and a four-minute think was a blank panel.
    const log = new LiveTurnLog();
    const blockStart = {
      kind: "event",
      event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } } },
    };
    log.apply("t1", { ...at("s", 1), at: 100, entry: blockStart });
    expect(log.snapshot("t1")).toMatchObject({ thinking: "", thinkingStartedAt: 100 });
  });

  it("takes a thinking or signature delta as the same notice, so a dropped block start costs nothing", () => {
    const log = new LiveTurnLog();
    const sig = {
      kind: "event",
      event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } } },
    };
    log.apply("t1", { ...at("s", 1), at: 250, entry: sig });
    expect(log.snapshot("t1")!.thinkingStartedAt).toBe(250);
  });

  it("times a withheld think end to end: clock from the block, duration onto the finished turn", () => {
    const log = new LiveTurnLog();
    const blockStart = {
      kind: "event",
      event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } } },
    };
    log.apply("t1", { ...at("s", 1), at: 1000, entry: blockStart });
    log.apply("t1", { ...at("s", 1), at: 4000, text: "Here" });
    const { entry } = log.apply("t1", { ...at("s", 1), at: 4200, entry: { kind: "message", role: "assistant", content: {} } });
    // The number the settled row will state — the wait a person actually sat through.
    expect(entry).toMatchObject({ startedAt: 1000, thoughtMs: 3000 });
  });

  it("ignores stream bookkeeping that is not a thinking block, and does not restart a running clock", () => {
    const log = new LiveTurnLog();
    const textBlock = {
      kind: "event",
      event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } },
    };
    log.apply("t1", { ...at("s", 1), at: 100, entry: textBlock });
    expect(log.snapshot("t1")!.thinkingStartedAt).toBeUndefined();
    const thinkBlock = {
      kind: "event",
      event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } } },
    };
    log.apply("t1", { ...at("s", 1), at: 200, entry: thinkBlock });
    log.apply("t1", { ...at("s", 1), at: 300, entry: thinkBlock });
    // The FIRST notice is when thinking began; a later one is the same block still going.
    expect(log.snapshot("t1")!.thinkingStartedAt).toBe(200);
  });

  it("persists the started clock as the partial, so a crash mid-think is not a blank", () => {
    const log = new LiveTurnLog();
    log.apply("t1", {
      ...at("s", 1),
      at: 700,
      entry: { kind: "event", event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } } } },
    });
    // "Still thinking, nothing said yet" is an ENTRY with no content and a start — not a field
    // beside the conversation saying the same thing in a second shape.
    const value = partialRecordValue(log.snapshot("t1")!) as { value: { entries: Array<Record<string, unknown>> } };
    expect(value.value.entries).toEqual([
      { kind: "message", role: "assistant", content: [], partial: true, provider: "unknown", timing: { startedAt: 700 } },
    ]);
  });

  it("holds the call being written, and drops the bookkeeping it read it from", () => {
    // The gap this closes: a model producing a large argument leaves nothing else on the stream, and
    // hundreds of these fragments would push the conversation itself out of a bounded entry list.
    const log = new LiveTurnLog();
    const stream = (event: JsonValue): JsonValue => ({ kind: "event", event: { type: "provider_event", payload: { type: "stream_event", event } } });
    log.apply("t1", { ...at("s", 1), at: 100, entry: stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "show_artifact" } }) });
    log.apply("t1", { ...at("s", 1), at: 200, entry: stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "mocks/07.html", "content": "<!DOC' } }) });
    const snapshot = log.snapshot("t1")!;
    expect(snapshot.writing).toMatchObject({ name: "show_artifact", chars: 43 });
    expect(snapshot.entries).toEqual([]);
  });

  it("lets go of the half-written call once the turn carrying it lands", () => {
    const log = new LiveTurnLog();
    const stream = (event: JsonValue): JsonValue => ({ kind: "event", event: { type: "provider_event", payload: { type: "stream_event", event } } });
    log.apply("t1", { ...at("s", 1), at: 100, entry: stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "show_artifact" } }) });
    log.apply("t1", { ...at("s", 1), at: 300, entry: { kind: "message", role: "assistant", content: {} } });
    // The call is on that turn now, assembled, with a row of its own — two rows for one call is
    // exactly what the drop prevents.
    expect(log.snapshot("t1")!.writing).toBeUndefined();
  });

  it("sniffs the provider session id off the stream's envelopes", () => {
    const log = new LiveTurnLog();
    log.apply("t1", {
      ...at("s", 1),
      entry: { kind: "event", event: { type: "provider_event", payload: { type: "system", subtype: "init", session_id: "prov-7" } } },
    });
    expect(log.snapshot("t1")).toMatchObject({ providerSessionId: "prov-7" });
  });

  it("routes a subagent's entries to its chain and restarts the tails on a finished assistant turn", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), text: "partial" });
    log.apply("t1", { ...at("s", 1), entry: { kind: "message", role: "assistant", content: {}, parentToolUseId: "call1" } });
    log.apply("t1", { ...at("s", 1), entry: { kind: "message", role: "assistant", content: {} } });
    const snap = log.snapshot("t1")!;
    expect(snap.sidechains["call1"]).toHaveLength(1);
    expect(snap.entries).toHaveLength(1);
    // The finished turn carries what the deltas streamed — the tail restarts.
    expect(snap.text).toBe("");
  });

  it("tracks tasks independently and answers null where nothing streams", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), text: "x" });
    expect(log.snapshot("t2")).toBeNull();
    log.clear("t1");
    expect(log.snapshot("t1")).toBeNull();
  });

  it("hands out copies — a mutating log must not reach into a snapshot already served", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), entry: { kind: "event", event: { type: "x" } } });
    const snap = log.snapshot("t1")!;
    log.apply("t1", { ...at("s", 1), entry: { kind: "event", event: { type: "y" } } });
    expect(snap.entries).toHaveLength(1);
  });
});

describe("partialRecordValue — the snapshot as a record's partial value", () => {
  const message = (text: string, parent?: string) => ({
    kind: "message",
    role: "assistant",
    content: { role: "assistant", content: text },
    ...(parent !== undefined ? { parentToolUseId: parent } : {}),
  });

  it("projects finished turns into ONE array, clocks on the turns and subagents in place", () => {
    // One encoding, not three. The clocks ride ON each entry rather than in an index-aligned array
    // beside it, and a subagent's turn sits where it arrived carrying the call that spawned it —
    // the two key spaces the entry format exists to remove.
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, entry: message("main") });
    log.apply("t1", { ...at("s", 1), at: 150, entry: message("sub", "call1") });
    expect(partialRecordValue(log.snapshot("t1")!)).toEqual({
      value: {
        entries: [
          {
            kind: "message",
            role: "assistant",
            content: "main",
            timestamp: new Date(100).toISOString(),
            provider: "unknown",
            timing: { at: 100 },
          },
          {
            kind: "message",
            role: "assistant",
            content: "sub",
            timestamp: new Date(150).toISOString(),
            provider: "unknown",
            timing: { at: 150 },
            sidechain: { id: "call1", parentToolUseId: "call1" },
          },
        ],
      },
    });
  });

  it("carries the turn in flight as an entry marked partial — a fragment is not a finished turn", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, thinking: "was thinking" });
    log.apply("t1", { ...at("s", 1), at: 200, text: "half a sent" });
    log.apply("t1", { ...at("s", 1), at: 250, entry: { kind: "event", event: { type: "x" } } });
    // The event entry is not a turn. The tails are one entry in the same array, flagged so a reader
    // can tell it from something the model finished saying — `startedAt` and `thoughtMs` recover
    // both stamps the old `partial` object spelled out (thinking at 100, answer at 100 + 100).
    expect(partialRecordValue(log.snapshot("t1")!)).toEqual({
      value: {
        entries: [
          {
            kind: "message",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "was thinking" },
              { type: "text", text: "half a sent" },
            ],
            partial: true,
            provider: "unknown",
            timing: { startedAt: 100, thoughtMs: 100 },
          },
        ],
      },
    });
  });

  it("stays null with nothing recordable at all", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, entry: { kind: "event", event: { type: "x" } } });
    expect(partialRecordValue(log.snapshot("t1")!)).toBeNull();
  });
});

describe("LiveTurnFlusher — at most one write per interval, however chatty the stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one flush, and a later burst into a second", () => {
    let flushed = 0;
    const flusher = new LiveTurnFlusher(() => void (flushed += 1), 400);
    flusher.note();
    flusher.note();
    flusher.note();
    expect(flushed).toBe(0); // nothing yet — durability is throttled, not per-delta
    vi.advanceTimersByTime(400);
    expect(flushed).toBe(1);
    flusher.note();
    vi.advanceTimersByTime(400);
    expect(flushed).toBe(2);
  });

  it("keeps flushing under a stream that never goes quiet — throttle, not trailing debounce", () => {
    let flushed = 0;
    const flusher = new LiveTurnFlusher(() => void (flushed += 1), 400);
    // A delta every 100ms for two seconds; a trailing debounce would starve and flush ZERO times.
    for (let ms = 0; ms < 2000; ms += 100) {
      flusher.note();
      vi.advanceTimersByTime(100);
    }
    expect(flushed).toBe(5);
  });

  it("survives a flush that throws, and goes quiet after dispose", () => {
    let calls = 0;
    const flusher = new LiveTurnFlusher(() => {
      calls += 1;
      throw new Error("db closed");
    }, 400);
    flusher.note();
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
    expect(calls).toBe(1);
    flusher.note();
    flusher.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(1);
  });
});
