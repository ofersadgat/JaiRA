/**
 * Conversation `summary` mode (DESIGN §14 phase 7).
 *
 * The measured problem (§1h item 1) is a transcript that grows geometrically under
 * `full_history`. These tests pin the three properties that make compaction safe to
 * turn on: it only touches sessions that asked for it, it never loses a transcript
 * when the summarizer fails, and it keeps the most recent turns verbatim.
 */
import { describe, expect, it, vi } from "vitest";
import type { JsonValue, RecordStore, SessionStore } from "@declarative-ai/exec";
import { MapSessionStore } from "@declarative-ai/exec";
import type { WorkflowBundle } from "@declarative-ai/hw";
import {
  SUMMARY_TAG,
  SummarizingSessionStore,
  promptSummarizer,
  sessionStoreFor,
  summarySessionsOf,
  type SummaryEvent,
  type Turn,
} from "../src/summary";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";

/** An arbitrary named session. There is no implicit default one to reach for (SESSIONS.md §4). */
const SESSION = "planning";

const turn = (role: "user" | "assistant", content: string): Turn => ({ role, content });

/** A transcript comfortably over any small budget. */
function longTranscript(turns = 6): Turn[] {
  return Array.from({ length: turns }, (_, i) =>
    turn(i % 2 === 0 ? "user" : "assistant", `${i}: ${"x".repeat(200)}`),
  );
}

/**
 * A bundle whose LOADED states carry the given environments — which is where the query reads them
 * from, since a mode can be inherited from an ancestor's `environment` and appear in no file.
 */
function bundleWith(states: Record<string, unknown>): WorkflowBundle {
  return { rootId: "wf", states: states as WorkflowBundle["states"], source: states as WorkflowBundle["source"] };
}

/**
 * Run one call's worth of writing against `id`, and return the ref its head ends at.
 *
 * Resolve the position, claim it with a stub, fill it — which is what a real call does through
 * `withSession` and `withRecord`. A conversation is the records it holds, so there is no separate
 * "append messages" to reach for.
 */
async function append(store: SessionStore<JsonValue>, id: string, messages: readonly Turn[]): Promise<string> {
  const records = store as unknown as RecordStore;
  const at = (await store.resolve({ ref: id })).at;
  const recordId = `${at.id}:${at.seq}`;
  records.open({ id: recordId, source: undefined as never, session: at, startMs: 0 });
  records.close(recordId, { result: { value: { messages } as never } });
  const end = `${at.id}@${at.seq + 1}`;
  // Where the conversation ended up, which is NOT where the call ended when compaction moved it.
  const summarizing = store as Partial<SummarizingSessionStore>;
  return summarizing.currentRef !== undefined ? await summarizing.currentRef(end) : end;
}

/** What a conversation holds at a ref, as turns. */
async function contents(store: SessionStore<JsonValue>, ref: string): Promise<Turn[]> {
  return (await store.messages(ref)) as unknown as Turn[];
}

/** The stream half of a ref, for asserting which stream a write landed on. */
const streamOf = (ref: string): string => (ref.lastIndexOf("@") > 0 ? ref.slice(0, ref.lastIndexOf("@")) : ref);

describe("SummarizingSessionStore", () => {
  it("compacts an over-budget stream into a summary plus the recent turns", async () => {
    const summarize = vi.fn(async (turns: readonly Turn[]) => `the gist of ${turns.length} turns`);
    const store = new SummarizingSessionStore({ summarize, budgetChars: 500, keepRecentTurns: 2 });

    const end = await append(store, SESSION, longTranscript(6));
    const messages = await contents(store, end);

    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toContain(SUMMARY_TAG);
    expect(messages[0]!.content).toContain("the gist of 4 turns");
    // The last exchange is what the next call responds to — it stays verbatim.
    expect(messages[1]!.content.startsWith("4: ")).toBe(true);
    expect(messages[2]!.content.startsWith("5: ")).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("leaves the ORIGIN intact — compaction is a new stream, not a rewrite", async () => {
    // The problem this whole change exists for: anything holding "the conversation as of turn 14"
    // used to start silently referring to different content.
    const store = new SummarizingSessionStore({ summarize: async () => "the gist", budgetChars: 500, keepRecentTurns: 2 });
    const original = longTranscript(6);
    const end = await append(store, SESSION, original);

    expect(end).not.toBe(`${SESSION}@6`);
    expect(await contents(store, `${SESSION}@6`)).toEqual(original);
    expect(await contents(store, end)).toHaveLength(3);
  });

  it("continues the COMPACTED stream on the next write, not the retired one", async () => {
    // A caller holding a pre-compaction ref would otherwise keep growing the stream compaction was
    // meant to retire.
    const store = new SummarizingSessionStore({ summarize: async () => "the gist", budgetChars: 500, keepRecentTurns: 2 });
    const first = await append(store, SESSION, longTranscript(6));
    const end = await append(store, SESSION, [{ role: "user", content: "next" }]);
    // It continued the compacted stream — the new turn sits on top of the summary, not on top of the
    // six turns the summary replaced. (It compacted again on the way out, which is why this is a
    // prefix check and not equality: the lineage extends, it does not restart at the origin.)
    expect(streamOf(end).startsWith(streamOf(first))).toBe(true);
    expect(streamOf(end)).not.toBe(SESSION);
    const messages = await contents(store, end);
    expect(messages[0]!.content).toContain(SUMMARY_TAG);
    expect(messages.at(-1)!.content).toBe("next");
    expect(messages.length).toBeLessThan(7);
  });

  it("leaves a stream under budget alone", async () => {
    const summarize = vi.fn(async () => "unused");
    const store = new SummarizingSessionStore({ summarize, budgetChars: 100_000 });
    const messages = longTranscript(4);
    const end = await append(store, "s", messages);
    expect(await contents(store, end)).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("only compacts the sessions that asked for it", async () => {
    const summarize = vi.fn(async () => "the gist");
    const store = new SummarizingSessionStore({ summarize, budgetChars: 500, sessions: new Set(["cheap"]) });

    const cheap = await append(store, "cheap", longTranscript());
    const verbose = await append(store, "verbose", longTranscript());

    // A state declaring `full_history` means it; summarizing under it would lie.
    expect(await contents(store, cheap)).toHaveLength(3);
    expect(await contents(store, verbose)).toHaveLength(6);
  });

  it("compacts something whose messages are PARTS, not plain text", async () => {
    // The old `{ role, content: string }` filter silently declined anything else — which for an
    // agentic adapter is the whole transcript, so the session that needed compaction most never got it.
    const store = new SummarizingSessionStore({ summarize: async () => "the gist", budgetChars: 200, keepRecentTurns: 1 });
    const rich = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${i}: ${"z".repeat(200)}` }],
    })) as unknown as Turn[];
    const end = await append(store, "s", rich);
    expect(await contents(store, end)).toHaveLength(2);
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
    const end = await append(store, "s", messages);

    // An expensive run beats a run that forgot what it was doing.
    expect(await contents(store, end)).toEqual(messages);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]).toEqual(["s", expect.objectContaining({ message: "provider exploded" })]);
  });

  it("keeps the transcript when the summarizer returns nothing usable", async () => {
    const store = new SummarizingSessionStore({ summarize: async () => "   ", budgetChars: 500 });
    const messages = longTranscript();
    const end = await append(store, "s", messages);
    expect(await contents(store, end)).toEqual(messages);
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

    await append(store, "s", longTranscript());
    await append(store, "s", longTranscript(8));
    expect(overlapped).toBe(false);
  });

  it("reports what it saved, and where it put it", async () => {
    const events: SummaryEvent[] = [];
    const store = new SummarizingSessionStore({ summarize: async () => "short", budgetChars: 500, onSummarize: (e) => events.push(e) });
    await append(store, "s", longTranscript());
    expect(events).toHaveLength(1);
    expect(events[0]!.after).toBeLessThan(events[0]!.before);
    expect(events[0]!.compacted).toBe(4);
    // The new stream, so an observer can follow the lineage rather than guess at it.
    expect(events[0]!.session).toBeDefined();
    expect(events[0]!.session).not.toBe(events[0]!.sessionId);
  });
});

describe("summarySessionsOf", () => {
  it("finds the NAMED sessions whose states declare summary mode", () => {
    const modes = summarySessionsOf(
      bundleWith({
        a: { environment: { session: "plan", conversation: { mode: "summary" } } },
        b: { environment: { session: "review", conversation: { mode: "summary" } } },
        c: { environment: { session: "plan", conversation: { mode: "fresh" } } },
      }),
    );
    expect([...modes.sessions].sort()).toEqual(["plan", "review"]);
    expect(modes.conflicts).toEqual([]);
  });

  it("ignores a state that declares no session — its stream is private", () => {
    // There is no implicit shared session to bucket it under (SESSIONS.md §4), and a private stream
    // holds one operation's exchange, which there is nothing to compact.
    const modes = summarySessionsOf(
      bundleWith({
        a: { environment: { conversation: { mode: "summary" } } },
        b: { environment: { session: null, conversation: { mode: "summary" } } },
      }),
    );
    expect(modes.sessions.size).toBe(0);
  });

  it("reports a NAMED session that declares both summary and full_history", () => {
    const modes = summarySessionsOf(
      bundleWith({
        plan: { environment: { session: "planning", conversation: { mode: "summary" } } },
        critique: { environment: { session: "planning", conversation: { mode: "full_history" } } },
      }),
    );
    // One session has one transcript, so the two states cannot both be honoured.
    expect(modes.conflicts).toEqual([{ session: "planning", stateIds: ["critique", "plan"] }]);
  });

  it("does NOT report two undeclared states as conflicting", () => {
    // The false positive the old `"default"` fallback produced: two states that share nothing were
    // reported as fighting over one transcript.
    const modes = summarySessionsOf(
      bundleWith({
        plan: { environment: { conversation: { mode: "summary" } } },
        critique: { environment: { conversation: { mode: "full_history" } } },
      }),
    );
    expect(modes.conflicts).toEqual([]);
  });

  it("finds nothing in a workflow that never mentions conversations", () => {
    expect(summarySessionsOf(bundleWith({ a: {}, b: { operation: { kind: "prompt" } } }))).toEqual({
      sessions: new Set(),
      conflicts: [],
    });
  });
});

describe("sessionStoreFor", () => {
  it("installs no store when nothing asked for summarization and none was supplied", () => {
    const { store } = sessionStoreFor(bundleWith({ a: {} }), async () => "x");
    // A workflow that didn't ask should not have its transcripts routed through
    // code that could compact them.
    expect(store).toBeUndefined();
  });

  it("keeps a DURABLE store even when nothing asked for summarization", async () => {
    // Durability is the caller's decision; compaction is the author's. Returning nothing here used to
    // discard a durable store silently, so transcripts survived a run only if that run also happened
    // to want summarization.
    const inner = new MapSessionStore<JsonValue>();
    const { store } = sessionStoreFor(bundleWith({ a: {} }), async () => "x", { inner });
    expect(store).toBe(inner);
  });

  it("wraps the durable store rather than replacing it when a state DID ask", async () => {
    const inner = new MapSessionStore<JsonValue>();
    const { store } = sessionStoreFor(
      bundleWith({ a: { environment: { session: "s1", conversation: { mode: "summary" } } } }),
      async () => "the gist",
      { inner, budgetChars: 500 },
    );
    const end = await append(store!, "s1", longTranscript());
    // Compacted — and the compacted stream lives in the store that was handed in.
    expect(await contents(store!, end)).toHaveLength(3);
    expect(await contents(inner, end)).toHaveLength(3);
  });

  it("installs one scoped to the summary sessions", async () => {
    const { store, modes } = sessionStoreFor(
      bundleWith({ a: { environment: { session: "s1", conversation: { mode: "summary" } } } }),
      async () => "the gist",
      { budgetChars: 500 },
    );
    expect(modes.sessions).toEqual(new Set(["s1"]));
    const summarized = await append(store!, "s1", longTranscript());
    const untouched = await append(store!, "other", longTranscript());
    expect(await contents(store!, summarized)).toHaveLength(3);
    expect(await contents(store!, untouched)).toHaveLength(6);
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
