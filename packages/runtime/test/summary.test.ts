/**
 * Conversation `summary` mode (DESIGN §14 phase 7).
 *
 * The measured problem (§1h item 1) is a conversation that grows geometrically under
 * `full_history`. These tests pin the properties that make compaction safe to turn
 * on: it only touches sessions that asked for it, it never loses a conversation when
 * the summarizer fails, it keeps the most recent turns verbatim — and, since a
 * session became a POSITION, that it MINTS a compacted conversation rather than
 * rewriting one, so every existing ref keeps meaning what it meant.
 */
import { describe, expect, it, vi } from "vitest";
import { MapSessionStore } from "@declarative-ai/exec";
import type { WorkflowBundle } from "@declarative-ai/hw";
import {
  DEFAULT_SESSION,
  SUMMARY_TAG,
  SummarizingSessionStore,
  promptSummarizer,
  sessionNameOf,
  sessionServicesFor,
  summarySessionsOf,
  type Turn,
} from "../src/summary";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";

const turn = (role: "user" | "assistant", content: string): Turn => ({ role, content });

/** A conversation comfortably over any small budget. */
function longTranscript(turns = 6): Turn[] {
  return Array.from({ length: turns }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", `${i}: ${"x".repeat(200)}`),
  );
}

/**
 * Put a conversation into a store the way a call would: one claimed position holding
 * one record, whose payload IS the messages. Returns the ref pointing just past it.
 *
 * Going through `open`/`close` rather than reaching into the store keeps these tests
 * honest about the contract — a conversation's messages ARE its records.
 */
function seed(store: MapSessionStore, id: string, turns: readonly Turn[]): string {
  store.open({ id: `${id}:0`, session: { id, seq: 0 } });
  store.close(`${id}:0`, { result: { value: { messages: turns } } });
  return `${id}@1`;
}

/** Resolve one ref through the store and read what the call would actually see. */
async function through(store: SummarizingSessionStore, ref: string): Promise<{ ref: string; messages: Turn[] }> {
  const resolved = await store.resolve({ ref });
  return { ref: resolved.id, messages: (await resolved.messages()) as unknown as Turn[] };
}

/**
 * A bundle whose LOADED states carry the given environments — which is where the query reads them
 * from, since a mode can be inherited from an ancestor's `environment` and appear in no file.
 */
function bundleWith(states: Record<string, unknown>): WorkflowBundle {
  return { rootId: "wf", states: states as WorkflowBundle["states"], source: states as WorkflowBundle["source"] };
}

describe("SummarizingSessionStore", () => {
  it("compacts a conversation over budget into a summary plus the recent turns", async () => {
    const summarize = vi.fn(async (turns: readonly Turn[]) => `the gist of ${turns.length} turns`);
    const inner = new MapSessionStore();
    const ref = seed(inner, DEFAULT_SESSION, longTranscript(6));
    const store = new SummarizingSessionStore({ summarize, budgetChars: 500, keepRecentTurns: 2, inner });

    const { messages } = await through(store, ref);

    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toContain(SUMMARY_TAG);
    expect(messages[0]!.content).toContain("the gist of 4 turns");
    // The last exchange is what the next call responds to — it stays verbatim.
    expect(messages[1]!.content.startsWith("4: ")).toBe(true);
    expect(messages[2]!.content.startsWith("5: ")).toBe(true);
    // Four turns were folded, not six — the tail stayed verbatim.
    expect(summarize).toHaveBeenCalledOnce();
  });

  /**
   * The property the position model added, and the one most worth pinning.
   *
   * Rewriting in place would silently change what every existing ref refers to, and
   * would invalidate the provider's prompt cache — a strict prefix match — on every
   * compaction. So the origin must still read back in full.
   */
  it("mints a new conversation and leaves the origin intact", async () => {
    const inner = new MapSessionStore();
    const ref = seed(inner, "default", longTranscript(6));
    const store = new SummarizingSessionStore({ summarize: async () => "the gist", budgetChars: 500, inner });

    const compacted = await through(store, ref);

    expect(compacted.ref).not.toBe(ref);
    expect(compacted.messages).toHaveLength(3);
    // The origin is untouched: a ref into it means exactly what it always meant.
    expect(await inner.messages(ref)).toHaveLength(6);
  });

  it("leaves a conversation under budget alone", async () => {
    const summarize = vi.fn(async () => "unused");
    const inner = new MapSessionStore();
    const ref = seed(inner, "s", longTranscript(4));
    const store = new SummarizingSessionStore({ summarize, budgetChars: 100_000, inner });

    const result = await through(store, ref);

    expect(result.ref).toBe(ref);
    expect(result.messages).toHaveLength(4);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("only compacts the sessions that asked for it", async () => {
    const summarize = vi.fn(async () => "the gist");
    const inner = new MapSessionStore();
    const cheap = seed(inner, "cheap", longTranscript());
    const verbose = seed(inner, "verbose", longTranscript());
    const store = new SummarizingSessionStore({ summarize, budgetChars: 500, sessions: new Set(["cheap"]), inner });

    // A state declaring `full_history` means it; summarizing under it would lie.
    expect((await through(store, cheap)).messages).toHaveLength(3);
    expect((await through(store, verbose)).messages).toHaveLength(6);
  });

  /**
   * The opt-in set holds AUTHORED names while this store only ever sees positions, so
   * a compacted conversation has to still read as the session it descends from.
   * Without that, a conversation would be compacted exactly once, ever.
   */
  it("keeps compacting a conversation it has already compacted", async () => {
    const summarize = vi.fn(async () => "the gist");
    const inner = new MapSessionStore();
    const store = new SummarizingSessionStore({
      summarize,
      budgetChars: 500,
      keepRecentTurns: 2,
      sessions: new Set(["planning"]),
      inner,
    });

    const first = await through(store, seed(inner, "planning", longTranscript(6)));
    expect(sessionNameOf(first.ref)).toBe("planning");

    // Grow the compacted conversation past the budget again, as a further call would.
    const id = first.ref.split("@")[0]!;
    inner.open({ id: `${id}:1`, session: { id, seq: 1 } });
    inner.close(`${id}:1`, { result: { value: { messages: longTranscript(6) } } });

    const second = await through(store, `${id}@2`);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(second.ref).not.toBe(first.ref);
  });

  it("keeps the full conversation when summarization fails", async () => {
    const onError = vi.fn();
    const inner = new MapSessionStore();
    const ref = seed(inner, "s", longTranscript());
    const store = new SummarizingSessionStore({
      summarize: async () => {
        throw new Error("provider exploded");
      },
      budgetChars: 500,
      onError,
      inner,
    });

    const result = await through(store, ref);

    // An expensive run beats a run that forgot what it was doing.
    expect(result.ref).toBe(ref);
    expect(result.messages).toHaveLength(6);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]).toEqual([ref, expect.objectContaining({ message: "provider exploded" })]);
  });

  it("keeps the conversation when the summarizer returns nothing usable", async () => {
    const inner = new MapSessionStore();
    const ref = seed(inner, "s", longTranscript());
    const store = new SummarizingSessionStore({ summarize: async () => "   ", budgetChars: 500, inner });
    const result = await through(store, ref);
    expect(result.ref).toBe(ref);
    expect(result.messages).toHaveLength(6);
  });

  it("serializes concurrent resolves so two summarizations cannot race", async () => {
    let inFlight = 0;
    let overlapped = false;
    const inner = new MapSessionStore();
    const ref = seed(inner, "s", longTranscript());
    const store = new SummarizingSessionStore({
      summarize: async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "the gist";
      },
      budgetChars: 500,
      inner,
    });

    const [a, b] = await Promise.all([through(store, ref), through(store, ref)]);

    expect(overlapped).toBe(false);
    // Both calls land on ONE compacted conversation. Two would mean one silently won.
    expect(a.ref).toBe(b.ref);
    expect(a.messages).toHaveLength(3);
  });

  it("reports what it saved", async () => {
    const events: Array<{ before: number; after: number; compacted: number; compactedTo: string }> = [];
    const inner = new MapSessionStore();
    const ref = seed(inner, "s", longTranscript());
    const store = new SummarizingSessionStore({
      summarize: async () => "short",
      budgetChars: 500,
      onSummarize: (e) => events.push(e),
      inner,
    });
    const result = await through(store, ref);
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toBeLessThan(events[0]!.before);
    expect(events[0]!.compacted).toBe(4);
    expect(events[0]!.compactedTo).toBe(result.ref);
  });

  it("passes through a conversation it does not recognize", async () => {
    // A `withSession` writer may store richer message parts; mangling them would be
    // worse than declining to compact.
    const inner = new MapSessionStore();
    const messages = [{ role: "tool", parts: ["something"] }];
    inner.open({ id: "s:0", session: { id: "s", seq: 0 } });
    inner.close("s:0", { result: { value: { messages } } });
    const store = new SummarizingSessionStore({ summarize: async () => "x", budgetChars: 1, inner });
    const result = await store.resolve({ ref: "s@1" });
    expect(result.id).toBe("s@1");
    expect(await result.messages()).toEqual(messages);
  });

  it("refuses a store that cannot compact, rather than silently never compacting", () => {
    const cannot = { resolve: () => ({}) as never, fork: () => "x", messages: () => [] };
    expect(() => new SummarizingSessionStore({ summarize: async () => "x", inner: cannot })).toThrow(/can compact/);
  });
});

describe("sessionNameOf", () => {
  it("strips the position and any derivation suffix", () => {
    expect(sessionNameOf("planning")).toBe("planning");
    expect(sessionNameOf("planning@7")).toBe("planning");
    expect(sessionNameOf("planning~compact1@7")).toBe("planning");
    expect(sessionNameOf("planning~resync2@0")).toBe("planning");
  });
});

describe("summarySessionsOf", () => {
  it("finds the sessions whose states declare summary mode", () => {
    const modes = summarySessionsOf(
      bundleWith({
        a: { environment: { conversation: { mode: "summary" } } },
        b: { environment: { session: "review", conversation: { mode: "summary" } } },
        c: { environment: { conversation: { mode: "fresh" } } },
      }),
    );
    // `a` declares no session, so it belongs to the run's default one.
    expect([...modes.sessions].sort()).toEqual(["default", "review"]);
    expect(modes.conflicts).toEqual([]);
  });

  it("reports a session that declares both summary and full_history", () => {
    const modes = summarySessionsOf(
      bundleWith({
        plan: { environment: { conversation: { mode: "summary" } } },
        critique: { environment: { conversation: { mode: "full_history" } } },
      }),
    );
    // One session has one conversation, so the two states cannot both be honoured.
    expect(modes.conflicts).toEqual([{ session: "default", stateIds: ["critique", "plan"] }]);
  });

  it("finds nothing in a workflow that never mentions conversations", () => {
    expect(summarySessionsOf(bundleWith({ a: {}, b: { operation: { kind: "prompt" } } }))).toEqual({
      sessions: new Set(),
      conflicts: [],
    });
  });
});

describe("sessionServicesFor", () => {
  it("installs no DECORATOR when nothing asked for summarization", () => {
    const { sessions } = sessionServicesFor(bundleWith({ a: {} }), async () => "x");
    // A workflow that didn't ask should not have its conversations routed through
    // code that could compact them — but it still needs a store, or it has no
    // conversations at all.
    expect(sessions).toBeInstanceOf(MapSessionStore);
  });

  it("installs one scoped to the summary sessions", async () => {
    const inner = new MapSessionStore();
    const { sessions: store, modes } = sessionServicesFor(
      bundleWith({ a: { environment: { session: "s1", conversation: { mode: "summary" } } } }),
      async () => "the gist",
      { budgetChars: 500, inner },
    );
    expect(modes.sessions).toEqual(new Set(["s1"]));
    const s1 = await store.resolve({ ref: seed(inner, "s1", longTranscript()) });
    const other = await store.resolve({ ref: seed(inner, "other", longTranscript()) });
    expect(await s1.messages()).toHaveLength(3);
    expect(await other.messages()).toHaveLength(6);
  });
});

describe("promptSummarizer", () => {
  it("summarizes through the run's own prompt executor", async () => {
    // A scripted run stays scripted: the fake executor answers, so no provider or
    // key is involved.
    const fake = new ScriptedFakeExecutor([{ promptIncludes: "Summarize the following", output: "a tight summary" }]);
    const summarize = promptSummarizer(fake);
    await expect(summarize([turn("user", "hello"), turn("assistant", "hi")])).resolves.toBe("a tight summary");
  });

  it("rejects when the call fails, so the store keeps the conversation", async () => {
    const fake = new ScriptedFakeExecutor([{ promptIncludes: "never matches", output: "x" }]);
    await expect(promptSummarizer(fake)([turn("user", "hello")])).rejects.toThrow(/summarization failed/);
  });
});
