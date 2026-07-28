/**
 * Conversation `summary` mode (DESIGN §14 phase 7).
 *
 * The measured problem (§1h item 1) is a transcript that grows geometrically under
 * `full_history`. These tests pin the three properties that make compaction safe to
 * turn on: it only touches sessions that asked for it, it never loses a transcript
 * when the summarizer fails, and it keeps the most recent turns verbatim.
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkflowBundle } from "@declarative-ai/hw";
import {
  DEFAULT_SESSION,
  SUMMARY_TAG,
  SummarizingSessionStore,
  promptSummarizer,
  sessionStoreFor,
  summarySessionsOf,
  type Turn,
} from "../src/summary";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";

const turn = (role: "user" | "assistant", content: string): Turn => ({ role, content });

/** A transcript comfortably over any small budget. */
function longTranscript(turns = 6): Turn[] {
  return Array.from({ length: turns }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", `${i}: ${"x".repeat(200)}`),
  );
}

/** A bundle whose `source` declares the given environments. */
function bundleWith(states: Record<string, unknown>): WorkflowBundle {
  return { rootId: "wf", states: {}, source: states as WorkflowBundle["source"] };
}

describe("SummarizingSessionStore", () => {
  it("compacts a transcript over budget into a summary plus the recent turns", async () => {
    const summarize = vi.fn(async (turns: readonly Turn[]) => `the gist of ${turns.length} turns`);
    const store = new SummarizingSessionStore({ summarize, budgetChars: 500, keepRecentTurns: 2 });

    await store.put(DEFAULT_SESSION, { messages: longTranscript(6) as never });
    const state = await store.get(DEFAULT_SESSION);
    const messages = state!.messages as unknown as Turn[];

    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toContain(SUMMARY_TAG);
    expect(messages[0]!.content).toContain("the gist of 4 turns");
    // The last exchange is what the next call responds to — it stays verbatim.
    expect(messages[1]!.content.startsWith("4: ")).toBe(true);
    expect(messages[2]!.content.startsWith("5: ")).toBe(true);
    // Four turns were folded, not six — the tail stayed verbatim.
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("leaves a transcript under budget alone", async () => {
    const summarize = vi.fn(async () => "unused");
    const store = new SummarizingSessionStore({ summarize, budgetChars: 100_000 });
    const messages = longTranscript(4);

    await store.put("s", { messages: messages as never });

    expect((await store.get("s"))!.messages).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("only compacts the sessions that asked for it", async () => {
    const summarize = vi.fn(async () => "the gist");
    const store = new SummarizingSessionStore({
      summarize,
      budgetChars: 500,
      sessions: new Set(["cheap"]),
    });

    await store.put("cheap", { messages: longTranscript() as never });
    await store.put("verbose", { messages: longTranscript() as never });

    // A state declaring `full_history` means it; summarizing under it would lie.
    expect((await store.get("cheap"))!.messages).toHaveLength(3);
    expect((await store.get("verbose"))!.messages).toHaveLength(6);
  });

  it("keeps the full transcript when summarization fails", async () => {
    const onError = vi.fn();
    const store = new SummarizingSessionStore({
      summarize: async () => {
        throw new Error("provider exploded");
      },
      budgetChars: 500,
      onError,
    });
    const messages = longTranscript();

    await store.put("s", { messages: messages as never });

    // An expensive run beats a run that forgot what it was doing.
    expect((await store.get("s"))!.messages).toEqual(messages);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]).toEqual(["s", expect.objectContaining({ message: "provider exploded" })]);
  });

  it("keeps the transcript when the summarizer returns nothing usable", async () => {
    const store = new SummarizingSessionStore({ summarize: async () => "   ", budgetChars: 500 });
    const messages = longTranscript();
    await store.put("s", { messages: messages as never });
    expect((await store.get("s"))!.messages).toEqual(messages);
  });

  it("serializes concurrent writes so two summarizations cannot race", async () => {
    let inFlight = 0;
    let overlapped = false;
    const store = new SummarizingSessionStore({
      summarize: async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "the gist";
      },
      budgetChars: 500,
    });

    await Promise.all([
      store.put("s", { messages: longTranscript() as never }),
      store.put("s", { messages: longTranscript(8) as never }),
    ]);

    expect(overlapped).toBe(false);
    expect((await store.get("s"))!.messages).toHaveLength(3);
  });

  it("reports what it saved", async () => {
    const events: Array<{ before: number; after: number; compacted: number }> = [];
    const store = new SummarizingSessionStore({
      summarize: async () => "short",
      budgetChars: 500,
      onSummarize: (e) => events.push(e),
    });
    await store.put("s", { messages: longTranscript() as never });
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toBeLessThan(events[0]!.before);
    expect(events[0]!.compacted).toBe(4);
  });

  it("passes through a transcript it does not recognize", async () => {
    // A `withSession` writer may store richer message parts; mangling them would be
    // worse than declining to compact.
    const store = new SummarizingSessionStore({ summarize: async () => "x", budgetChars: 1 });
    const messages = [{ role: "tool", parts: ["something"] }] as never;
    await store.put("s", { messages });
    expect((await store.get("s"))!.messages).toEqual(messages);
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
    // One session has one transcript, so the two states cannot both be honoured.
    expect(modes.conflicts).toEqual([{ session: "default", stateIds: ["critique", "plan"] }]);
  });

  it("finds nothing in a workflow that never mentions conversations", () => {
    expect(summarySessionsOf(bundleWith({ a: {}, b: { operation: { kind: "prompt" } } }))).toEqual({
      sessions: new Set(),
      conflicts: [],
    });
  });
});

describe("sessionStoreFor", () => {
  it("installs no store when nothing asked for summarization", () => {
    const { store } = sessionStoreFor(bundleWith({ a: {} }), async () => "x");
    // A workflow that didn't ask should not have its transcripts routed through
    // code that could compact them.
    expect(store).toBeUndefined();
  });

  it("installs one scoped to the summary sessions", async () => {
    const { store, modes } = sessionStoreFor(
      bundleWith({ a: { environment: { session: "s1", conversation: { mode: "summary" } } } }),
      async () => "the gist",
      { budgetChars: 500 },
    );
    expect(modes.sessions).toEqual(new Set(["s1"]));
    await store!.put("s1", { messages: longTranscript() as never });
    await store!.put("other", { messages: longTranscript() as never });
    expect((await store!.get("s1"))!.messages).toHaveLength(3);
    expect((await store!.get("other"))!.messages).toHaveLength(6);
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

  it("rejects when the call fails, so the store keeps the transcript", async () => {
    const fake = new ScriptedFakeExecutor([{ promptIncludes: "never matches", output: "x" }]);
    await expect(promptSummarizer(fake)([turn("user", "hello")])).rejects.toThrow(/summarization failed/);
  });
});
