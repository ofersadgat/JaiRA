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

const at = (id: string, seq: number) => ({ session: { id, seq } });

describe("LiveTurnLog", () => {
  it("accumulates text, thinking and items for one position", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), stateId: "plan", thinking: "hm " });
    log.apply("t1", { ...at("s", 1), text: "Hel" });
    log.apply("t1", { ...at("s", 1), text: "lo" });
    log.apply("t1", { ...at("s", 1), item: { kind: "event", event: { type: "x" } } });
    expect(log.snapshot("t1")).toMatchObject({
      sessionId: "s",
      seq: 1,
      stateId: "plan",
      n: 4,
      text: "Hello",
      thinking: "hm ",
      items: [{ kind: "event", event: { type: "x" } }],
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

  it("stamps items with times: completion on every item, start + thought duration on a finished turn", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, thinking: "hm" });
    log.apply("t1", { ...at("s", 1), at: 250, text: "Hel" });
    const { item } = log.apply("t1", { ...at("s", 1), at: 400, item: { kind: "message", role: "assistant", content: {} } });
    // startedAt = first delta of the turn (the thinking), thoughtMs = thinking start → answer start.
    expect(item).toMatchObject({ at: 400, startedAt: 100, thoughtMs: 150 });
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

  it("sniffs the provider session id off the stream's envelopes", () => {
    const log = new LiveTurnLog();
    log.apply("t1", {
      ...at("s", 1),
      item: { kind: "event", event: { type: "provider_event", payload: { type: "system", subtype: "init", session_id: "prov-7" } } },
    });
    expect(log.snapshot("t1")).toMatchObject({ providerSessionId: "prov-7" });
  });

  it("routes a subagent's items to its chain and restarts the tails on a finished assistant turn", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), text: "partial" });
    log.apply("t1", { ...at("s", 1), item: { kind: "message", role: "assistant", content: {}, parentToolUseId: "call1" } });
    log.apply("t1", { ...at("s", 1), item: { kind: "message", role: "assistant", content: {} } });
    const snap = log.snapshot("t1")!;
    expect(snap.sidechains["call1"]).toHaveLength(1);
    expect(snap.items).toHaveLength(1);
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
    log.apply("t1", { ...at("s", 1), item: { kind: "event", event: { type: "x" } } });
    const snap = log.snapshot("t1")!;
    log.apply("t1", { ...at("s", 1), item: { kind: "event", event: { type: "y" } } });
    expect(snap.items).toHaveLength(1);
  });
});

describe("partialRecordValue — the snapshot as a record's partial value", () => {
  const message = (text: string, parent?: string) => ({
    kind: "message",
    role: "assistant",
    content: { role: "assistant", content: text },
    ...(parent !== undefined ? { parentToolUseId: parent } : {}),
  });

  it("projects finished turns into the record shape — times in a PARALLEL array, sidechains apart", () => {
    // Timestamps ride beside the messages, never inside them: `messages` is the provider's log
    // verbatim, and a replay must send back exactly the bytes the provider produced.
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, item: message("main") });
    log.apply("t1", { ...at("s", 1), at: 150, item: message("sub", "call1") });
    expect(partialRecordValue(log.snapshot("t1")!)).toEqual({
      value: {
        messages: [{ role: "assistant", content: "main" }],
        messageTimes: [{ at: 100 }],
        sidechains: { call1: [{ role: "assistant", content: "sub" }] },
      },
    });
  });

  it("carries the tails in their own labeled field — a fragment is not a message", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, thinking: "was thinking" });
    log.apply("t1", { ...at("s", 1), at: 200, text: "half a sent" });
    log.apply("t1", { ...at("s", 1), at: 250, item: { kind: "event", event: { type: "x" } } });
    // The event item is not a turn; the tails persist under `partial`, clocks included — this is
    // exactly what a crash was holding, "still thinking/writing" state and all.
    expect(partialRecordValue(log.snapshot("t1")!)).toEqual({
      value: {
        messages: [],
        partial: { text: "half a sent", thinking: "was thinking", textStartedAt: 200, thinkingStartedAt: 100 },
      },
    });
  });

  it("stays null with nothing recordable at all", () => {
    const log = new LiveTurnLog();
    log.apply("t1", { ...at("s", 1), at: 100, item: { kind: "event", event: { type: "x" } } });
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
