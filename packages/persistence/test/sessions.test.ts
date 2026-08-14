/**
 * Durable conversation streams (DESIGN.md §7.3).
 *
 * The properties under test are the ones the whole model rests on, not the CRUD:
 *
 *  - a fork's prefix is BYTE-IDENTICAL to its origin's, which is what `[0:14]` asserts;
 *  - the origin is never mutated, which is what makes a ref a durable commitment;
 *  - compaction and resync are NOT forks — they share no prefix and take no cursor;
 *  - an append is CONDITIONAL, so two writers racing one position cannot both win.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { PositionTaken as ExecPositionTaken } from "@declarative-ai/exec";
import { openDb, type JairaDb } from "../src/db";
import {
  SessionPositionConflict,
  SessionStreams,
  UnknownSession,
  formatSessionRef,
  parseSessionRef,
  shortSessionLabel,
  messagesOf,
  type SessionRecord,
} from "../src/sessions";

let db: JairaDb;
let streams: SessionStreams;

beforeEach(() => {
  db = openDb(":memory:");
  streams = new SessionStreams(db);
});

afterEach(() => {
  db.close();
});

/**
 * One record carrying one message, shaped like a real one — parts and providerOptions, not
 * `content: string`. A record IS the unit of position, so `say(...)` advances a conversation by one
 * however many messages it carries.
 */
const say = (role: string, text: string): SessionRecord => rec(msg(role, text));

/** A message shaped like a real one. */
const msg = (role: string, text: string): JsonValue => ({ role, content: [{ type: "text", text }] });

/** A record whose payload is these messages — the shape a call produces. */
let recordSeq = 0;
const rec = (...messages: JsonValue[]): SessionRecord => ({ id: `r${++recordSeq}`, result: { value: { messages } } });

const texts = (records: ReadonlyArray<{ result?: JsonValue }>): string[] =>
  readTexts(records.flatMap((r) => messagesOf(r.result)));

/**
 * The same, for the exec-facing store, which hands back bare messages rather than stored entries.
 *
 * The parameter is deliberately loose: the contract's `read` may be sync or async so a durable store
 * fits behind it, and this one is sync — asserting on it should not require a cast at every call.
 */
const readTexts = (messages: unknown): string[] =>
  ((messages ?? []) as readonly unknown[]).map((message) => (message as { content: Array<{ text: string }> }).content[0]!.text);

describe("roots and appends", () => {
  it("starts empty and grows one position per entry", () => {
    const root = streams.createRoot({ seed: "planning" });
    expect(streams.head(root.id)).toBe(0);
    expect(root.label).toBe("planning");
    expect(root.edge).toBe("root");

    expect(streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")])).toBe(2);
    expect(streams.head(root.id)).toBe(2);
    expect(texts(streams.materialize(root.id))).toEqual(["a", "b"]);
  });

  it("stores a message verbatim, including provider-specific parts", () => {
    const root = streams.createRoot({ seed: "planning" });
    // The signature on a reasoning part is load-bearing on return — it must come back
    // byte-identical, which is why nothing round-trips through a lossier shape.
    const message: JsonValue = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { anthropic: { signature: "sig-abc" } } },
        { type: "text", text: "answer" },
      ],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    streams.append(root.id, 0, [
      { id: "op-7", source: { kind: "prompt" }, result: { value: { messages: [message] } }, externalId: "sess-abc" },
    ]);

    const [stored] = streams.materialize(root.id);
    expect(messagesOf(stored!.result)).toEqual([message]);
    // The operation and the provider handle ride the same record — a session is what its records say.
    expect(stored!.source).toEqual({ kind: "prompt" });
    expect(stored!.externalId).toBe("sess-abc");
    expect(streams.providerHandle(root.id)).toBe("sess-abc");
  });

  it("treats an empty delta as a legal no-op", () => {
    // An operation that failed before the provider saw anything has a real, empty
    // delta — folding it must not be an error.
    const root = streams.createRoot({ seed: "planning" });
    expect(streams.append(root.id, 0, [])).toBe(0);
    expect(streams.head(root.id)).toBe(0);
  });

  it("is idempotent for the same seed — a replayed run reuses its root", () => {
    const first = streams.createRoot({ seed: "planning" });
    streams.append(first.id, 0, [say("user", "a")]);
    const again = streams.createRoot({ seed: "planning" });
    expect(again.id).toBe(first.id);
    expect(streams.head(again.id)).toBe(1);
  });
});

describe("forking", () => {
  it("shares a byte-identical prefix and leaves the origin untouched", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b"), say("user", "c")]);

    const branch = streams.fork(root.id, 2, { seed: "variant-1" });
    expect(texts(streams.materialize(branch.id))).toEqual(["a", "b"]);

    streams.append(branch.id, 2, [say("assistant", "different")]);

    // The claim `[0:2]` makes: the first two entries are the same on both sides.
    expect(texts(streams.materialize(branch.id))).toEqual(["a", "b", "different"]);
    expect(texts(streams.materialize(root.id))).toEqual(["a", "b", "c"]);
    expect(streams.head(root.id)).toBe(3);
  });

  it("continues seq from the cursor, so a position is one integer across the lineage", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });

    expect(streams.head(branch.id)).toBe(2);
    streams.append(branch.id, 2, [say("user", "c")]);
    expect(streams.materialize(branch.id).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("copies nothing — a branch stores only what it appended", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });
    streams.append(branch.id, 2, [say("user", "c")]);

    const owned = db.prepare(`SELECT COUNT(*) n FROM operation_records WHERE session_id = ?`).get(branch.id) as {
      n: number;
    };
    expect(owned.n).toBe(1);
  });

  it("labels a fork with the cursor it took, and numbers siblings", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    expect(streams.fork(root.id, 2, { seed: "one" }).label).toBe("planning[0:2]/b");
    expect(streams.fork(root.id, 2, { seed: "two" }).label).toBe("planning[0:2]/c");
  });

  it("nests, and a fork of a fork still materializes the whole chain", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const first = streams.fork(root.id, 2, { seed: "one" });
    streams.append(first.id, 2, [say("user", "c")]);
    const second = streams.fork(first.id, 3, { seed: "two" });
    streams.append(second.id, 3, [say("assistant", "d")]);

    expect(texts(streams.materialize(second.id))).toEqual(["a", "b", "c", "d"]);
    expect(second.label).toBe("planning[0:2]/b[0:3]/b");
    expect(streams.lineage(second.id).map((b) => b.edge)).toEqual(["fork", "fork", "root"]);
  });

  it("refuses a cursor past the parent's head", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    expect(() => streams.fork(root.id, 5, { seed: "v" })).toThrow(/head is 1/);
  });

  it("returns the same branch for the same seed, so a fan-out must vary it", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    expect(streams.fork(root.id, 1, { seed: "same" }).id).toBe(streams.fork(root.id, 1, { seed: "same" }).id);
    expect(streams.fork(root.id, 1, { seed: "a" }).id).not.toBe(streams.fork(root.id, 1, { seed: "b" }).id);
  });
});

describe("compaction and resync are not forks", () => {
  it("shares no prefix, takes no cursor, and leaves the origin intact", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b"), say("user", "c")]);

    const compacted = streams.compact(root.id, { seed: "c1", entries: [say("user", "<summary>"), say("user", "c")] });

    expect(compacted.edge).toBe("compaction");
    expect(compacted.parentCursor).toBeUndefined();
    expect(compacted.label).toBe("planning~compact1");
    // Its first message appears nowhere in the origin — which is exactly why calling
    // it a fork would make the notation lie.
    expect(texts(streams.materialize(compacted.id))).toEqual(["<summary>", "c"]);
    expect(texts(streams.materialize(root.id))).toEqual(["a", "b", "c"]);
    expect(streams.materialize(compacted.id).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("records the origin for provenance without inheriting its content", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    const compacted = streams.compact(root.id, { seed: "c1", entries: [say("user", "<summary>")] });
    expect(compacted.parentId).toBe(root.id);
    expect(streams.lineage(compacted.id).map((b) => b.id)).toEqual([compacted.id, root.id]);
  });

  it("numbers repeated compactions and spells resync distinctly", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    expect(streams.compact(root.id, { seed: "c1", entries: [say("user", "s")] }).label).toBe("planning~compact1");
    expect(streams.compact(root.id, { seed: "c2", entries: [say("user", "s")] }).label).toBe("planning~compact2");
    expect(streams.resync(root.id, { seed: "r1", entries: [say("user", "s")] }).label).toBe("planning~resync1");
  });

  it("starts a resync EMPTY when the adapter has no read API, visibly on the edge", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    const fresh = streams.resync(root.id, { seed: "r1", entries: [] });
    expect(fresh.edge).toBe("resync");
    expect(streams.materialize(fresh.id)).toEqual([]);
    expect(streams.head(fresh.id)).toBe(0);
  });
});

describe("conditional append", () => {
  it("refuses a position that is no longer the head", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    // Both writers saw head == 0; the second must not clobber the first.
    expect(() => streams.append(root.id, 0, [say("user", "b")])).toThrow(SessionPositionConflict);
    expect(texts(streams.materialize(root.id))).toEqual(["a"]);
  });

  it("reports the expected and actual positions so the caller can fork from the right place", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    try {
      streams.append(root.id, 0, [say("user", "c")]);
      expect.unreachable("should have conflicted");
    } catch (e) {
      const conflict = e as SessionPositionConflict;
      expect(conflict.expected).toBe(0);
      expect(conflict.actual).toBe(2);
    }
  });

  it("writes nothing at all when a mid-batch entry fails", () => {
    const root = streams.createRoot({ seed: "planning" });
    // A circular message cannot be canonicalized for the digest; the whole batch must
    // roll back rather than leave a half-appended stream.
    const circular: Record<string, unknown> = { role: "user" };
    circular.self = circular;
    expect(() => streams.append(root.id, 0, [say("user", "a"), { id: "bad", result: circular as never }])).toThrow();
    expect(streams.head(root.id)).toBe(0);
    expect(streams.materialize(root.id)).toEqual([]);
  });
});

describe("digests", () => {
  it("commits to content — same messages, same digest; one byte different, different digest", () => {
    const a = streams.createRoot({ seed: "a" });
    const b = streams.createRoot({ seed: "b" });
    streams.append(a.id, 0, [say("user", "hello"), say("assistant", "hi")]);
    streams.append(b.id, 0, [say("user", "hello"), say("assistant", "hi")]);
    expect(streams.branch(a.id)!.digest).toBe(streams.branch(b.id)!.digest);

    const c = streams.createRoot({ seed: "c" });
    streams.append(c.id, 0, [say("user", "hello"), say("assistant", "hi!")]);
    expect(streams.branch(c.id)!.digest).not.toBe(streams.branch(a.id)!.digest);
  });

  it("orders matter — the same messages transposed commit differently", () => {
    const a = streams.createRoot({ seed: "a" });
    const b = streams.createRoot({ seed: "b" });
    streams.append(a.id, 0, [say("user", "x"), say("user", "y")]);
    streams.append(b.id, 0, [say("user", "y"), say("user", "x")]);
    expect(streams.branch(a.id)!.digest).not.toBe(streams.branch(b.id)!.digest);
  });

  it("a fork inherits the origin's digest AT THE CURSOR", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const atTwo = streams.branch(root.id)!.digest;
    streams.append(root.id, 2, [say("user", "c")]);

    const branch = streams.fork(root.id, 2, { seed: "v" });
    expect(branch.digest).toBe(atTwo);
    expect(streams.digestAt(root.id, 2)).toBe(atTwo);
  });

  it("rolls forward across a fork boundary exactly as an unforked stream would", () => {
    const straight = streams.createRoot({ seed: "straight" });
    streams.append(straight.id, 0, [say("user", "a"), say("assistant", "b"), say("user", "c")]);

    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });
    streams.append(branch.id, 2, [say("user", "c")]);

    // Identical content ⇒ identical commitment, whatever the branch topology.
    expect(streams.branch(branch.id)!.digest).toBe(streams.branch(straight.id)!.digest);
  });
});

describe("refs", () => {
  it("round-trips, and refuses anything it did not spell", () => {
    const ref = formatSessionRef("ses_abc", 14);
    expect(parseSessionRef(ref)).toEqual({ branchId: "ses_abc", position: 14 });
    expect(parseSessionRef("ses_abc")).toBeUndefined();
    expect(parseSessionRef("ses_abc@-1")).toBeUndefined();
    expect(parseSessionRef("ses_abc@x")).toBeUndefined();
    expect(parseSessionRef("@3")).toBeUndefined();
  });

  it("resolves to a branch and a position, and materializes at THAT position", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const pinned = streams.headRef(root.id);
    streams.append(root.id, 2, [say("user", "c")]);

    // The ref committed to two messages; the stream has since grown. It still means two.
    expect(texts(streams.messagesAt(pinned.id))).toEqual(["a", "b"]);
    expect(streams.resolve(pinned.id).position).toBe(2);
  });

  it("carries only `id` when serialized, so the journal sees nothing else", () => {
    const root = streams.createRoot({ seed: "planning" });
    expect(Object.keys(streams.headRef(root.id))).toEqual(["id"]);
    expect(JSON.parse(JSON.stringify(streams.headRef(root.id)))).toEqual({ id: `${root.id}@0` });
  });

  it("errors on an unresolvable ref rather than silently creating one", () => {
    // A typo must not turn into a plausible-looking isolated conversation.
    expect(() => streams.resolve("ses_nope@0")).toThrow(UnknownSession);
    expect(() => streams.resolve("not-a-ref")).toThrow(UnknownSession);
    const root = streams.createRoot({ seed: "planning" });
    expect(() => streams.resolve(formatSessionRef(root.id, 9))).toThrow(UnknownSession);
  });
});

describe("provider handles", () => {
  const withHandle = (text: string, handle: string): SessionRecord => ({ ...say("assistant", text), externalId: handle });

  it("is read off the LATEST record, not a separate map", () => {
    // A conversation is LOCKED to the provider it was used with — using it with another is a fork,
    // not a replay — so the handle is a property of what happened here, and there is no
    // (session, provider) table because that many-to-many cannot occur.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [withHandle("a", "sess-abc")]);
    expect(streams.providerHandle(root.id)).toBe("sess-abc");
  });

  it("follows the remote when it issues a new one — which is how divergence shows up", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [withHandle("a", "sess-abc")]);
    streams.append(root.id, 1, [withHandle("b", "sess-def")]);
    expect(streams.providerHandle(root.id)).toBe("sess-def");
    // ...and reading at an earlier position still reports what was true THEN.
    expect(streams.providerHandle(root.id, 1)).toBe("sess-abc");
  });

  it("reports nothing for a conversation no provider has claimed", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    expect(streams.providerHandle(root.id)).toBeUndefined();
  });

  it("a fork INHERITS the handle of the prefix it took, and diverges once it writes", () => {
    // The prefix really is that conversation, handle included — that is what `[0:n]` asserts. What
    // must not happen is two branches writing into ONE remote session, which the first append fixes:
    // a native fork issues a new handle and records it here.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [withHandle("a", "sess-abc")]);
    const branch = streams.fork(root.id, 1, { seed: "v" });
    expect(streams.providerHandle(branch.id)).toBe("sess-abc");
    streams.append(branch.id, 1, [withHandle("different", "sess-forked")]);
    expect(streams.providerHandle(branch.id)).toBe("sess-forked");
    expect(streams.providerHandle(root.id)).toBe("sess-abc");
  });
});

describe("lineage queries", () => {
  it("lists children, which is what makes a branch un-prunable on its own", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    const one = streams.fork(root.id, 1, { seed: "one" });
    const compacted = streams.compact(root.id, { seed: "c", entries: [say("user", "s")] });
    expect(streams.children(root.id).map((b) => b.id).sort()).toEqual([one.id, compacted.id].sort());
    expect(streams.children(one.id)).toEqual([]);
  });

  it("elides the middle of a deep label, keeping both ends", () => {
    const deep = "planning[0:14]/b[0:31]/c[0:52]/d[0:77]/e";
    expect(shortSessionLabel(deep, 20)).toContain("…");
    expect(shortSessionLabel(deep, 20).startsWith("planning")).toBe(true);
    expect(shortSessionLabel(deep, 20).endsWith("/e")).toBe(true);
    expect(shortSessionLabel("planning", 20)).toBe("planning");
  });
});

/**
 * The two interfaces the executor stack consumes: conversation lineage, and the two-phase record
 * write. A session is not a separate store — it IS the records sharing a session id — so these are
 * two views of one thing, and the tests exercise them together as a caller would.
 */
describe("the executor-facing contract", () => {
  const exec = () => streams.asExecStore({ taskId: "t-1", runId: 1 });

  /** One call: claim the position, then fill it with what the provider produced. */
  const call = (store: ReturnType<typeof exec>, at: { id: string; seq: number }, ...text: string[]): void => {
    const id = `${at.id}:${at.seq}`;
    store.open({ id, source: undefined as never, session: at, startMs: 0 });
    store.close(id, { result: { value: { messages: text.map((t) => msg("user", t)) } as never } });
  };

  it("resolves a position, records what the call produced, and reads it back", async () => {
    const store = exec();
    const at = await store.resolve({ ref: "planning" });
    expect(at.mode).toBe("append");
    call(store, at.at, "a", "b");
    expect(readTexts(await store.messages(formatSessionRef(at.at.id, at.at.seq + 1)))).toEqual(["a", "b"]);
  });

  it("creates a root for a bare NAME nobody has used, seeded so a replay lands on the same one", async () => {
    const store = exec();
    const first = await store.resolve({ ref: "planning" });
    call(store, first.at, "a");
    const second = await store.resolve({ ref: "planning" });
    // One conversation, two records — not two conversations that merely share a name.
    expect(second.at.id).toBe(first.at.id);
    expect(second.at.seq).toBe(1);
    call(store, second.at, "b");
    expect(readTexts(await store.messages(formatSessionRef(second.at.id, 2)))).toEqual(["a", "b"]);
  });

  it("REFUSES a position that is already claimed — which is what makes the caller fork", () => {
    // The TOCTOU case, closed by the position rather than by a lock: both callers resolved the same
    // slot, and only one can occupy it.
    const store = exec();
    const root = streams.createRoot({ seed: "planning" });
    call(store, { id: root.id, seq: 0 }, "first");
    expect(() => call(store, { id: root.id, seq: 0 }, "second")).toThrow(ExecPositionTaken);
    // Read through the exec view, which unwraps a RECORD into the messages it carries. The lineage
    // store below it sees one entry, because a position counts operations.
    expect(readTexts(store.messages(formatSessionRef(root.id, 1)))).toEqual(["first"]);
    expect(streams.materialize(root.id)).toHaveLength(1);
  });

  it("forks on request, leaving the origin alone", async () => {
    const store = exec();
    const first = await store.resolve({ ref: "planning" });
    call(store, first.at, "a");
    const forked = await store.resolve({ ref: formatSessionRef(first.at.id, 1), fork: true, seed: "v" });
    expect(forked.mode).toBe("fork");
    call(store, forked.at, "different");
    expect(readTexts(await store.messages(formatSessionRef(forked.at.id, forked.at.seq + 1)))).toEqual(["a", "different"]);
    expect(readTexts(await store.messages(formatSessionRef(first.at.id, 1)))).toEqual(["a"]);
  });

  it("forks a taken position by ref, which is the caller's answer to a refusal", async () => {
    const store = exec();
    const first = await store.resolve({ ref: "planning" });
    call(store, first.at, "a");
    const forkedRef = await store.fork(formatSessionRef(first.at.id, 0), "retry");
    const at = await store.resolve({ ref: forkedRef });
    call(store, at.at, "instead");
    // Branched from BEFORE the first call, so it does not inherit the turn it is replacing.
    expect(readTexts(await store.messages(formatSessionRef(at.at.id, at.at.seq + 1)))).toEqual(["instead"]);
    expect(readTexts(await store.messages(formatSessionRef(first.at.id, 1)))).toEqual(["a"]);
  });

  it("records a call that produced NOTHING, and frees its position", async () => {
    // A call that failed before the provider saw anything has a real, empty delta.
    const store = exec();
    const at = await store.resolve({ ref: "planning" });
    call(store, at.at);
    expect(await store.messages(formatSessionRef(at.at.id, 0))).toEqual([]);
    // ...and the position is free, so the next call appends rather than colliding.
    expect((await store.resolve({ ref: formatSessionRef(at.at.id, 0) })).at.seq).toBe(0);
  });

  it("compacts into a new conversation, leaving the origin readable at its own positions", async () => {
    const store = exec();
    const at = await store.resolve({ ref: "planning" });
    call(store, at.at, "a", "b", "c");
    const end = formatSessionRef(at.at.id, 1);
    const compacted = await store.compact!(end, [msg("user", "<summary>"), msg("user", "c")]);
    expect(readTexts(await store.messages(compacted))).toEqual(["<summary>", "c"]);
    expect(readTexts(await store.messages(end))).toEqual(["a", "b", "c"]);
    expect(streams.branch(compacted.split("@")[0]!)?.edge).toBe("compaction");
  });

  it("resyncs into a new conversation, and starts EMPTY when the provider offers nothing to read", async () => {
    const store = exec();
    const at = await store.resolve({ ref: "planning" });
    call(store, at.at, "a");
    const fresh = await store.resync!(formatSessionRef(at.at.id, 1), []);
    expect(await store.messages(fresh)).toEqual([]);
    expect(streams.branch(fresh.split("@")[0]!)?.edge).toBe("resync");
  });

  it("records what a DELEGATED agent reported — its turns AND the handle it ended in", async () => {
    // An agent answers with text and keeps its transcript server-side, so it cannot report a payload
    // that is already a conversation. What it must report is the session id the run ended in: a
    // native fork returns a NEW one, and losing it puts two branches into a single remote session.
    const store = exec();
    const at = await store.resolve({ ref: "planning" });
    const id = `${at.at.id}:${at.at.seq}`;
    store.open({ id, source: undefined as never, session: at.at, startMs: 0 });
    store.close(id, {
      result: { value: "the agent's answer" as never },
      sessionOutcome: { providerSessionId: "sess-forked", messages: [msg("assistant", "the agent's answer")] },
    });

    expect(readTexts(await store.messages(formatSessionRef(at.at.id, 1)))).toEqual(["the agent's answer"]);
    expect(streams.providerHandle(at.at.id)).toBe("sess-forked");
  });

  it("exposes only `id` on the session it hands the executor", async () => {
    const at = await exec().resolve({ ref: "planning" });
    expect(Object.keys(at)).toEqual(["id"]);
    // The rest is reachable but non-enumerable, so the journal and inputs_json see `{ id }` alone.
    expect(at.mode).toBe("append");
    expect(at.at).toBeDefined();
  });
});

describe("schema", () => {
  it("persists across a reopen — the store is durable, not run-scoped", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jaira-sessions-")), "jaira.db");
    const first = openDb(file);
    const written = new SessionStreams(first);
    const root = written.createRoot({ seed: "planning", taskId: "t-1", runId: 3 });
    written.append(root.id, 0, [say("user", "a")]);
    first.close();

    const second = openDb(file);
    const read = new SessionStreams(second);
    expect(texts(read.materialize(root.id))).toEqual(["a"]);
    expect(read.branch(root.id)?.taskId).toBe("t-1");
    expect(read.branch(root.id)?.runId).toBe(3);
    second.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it("enforces the lineage foreign keys — a record cannot outlive its conversation", () => {
    // Step 9's problem stated as a constraint: deleting a branch that others descend
    // from is refused by the database, not left to a caller to remember.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    streams.fork(root.id, 1, { seed: "v" });
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run(root.id)).toThrow(/FOREIGN KEY/i);
    expect(() =>
      db
        .prepare(`INSERT INTO operation_records (session_id, seq, id, created_at) VALUES (?, ?, ?, ?)`)
        .run("ses_missing", 0, "r", 0),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("admits a record with NO conversation — the table is every record, not just session ones", () => {
    // A session is a VIEW over the records that have a session id. A plain memoized call has none,
    // and must still be recordable.
    expect(() =>
      db.prepare(`INSERT INTO operation_records (session_id, seq, id, created_at) VALUES (NULL, NULL, ?, ?)`).run("r-loose", 0),
    ).not.toThrow();
  });
});

/**
 * Lineage-aware pruning (DESIGN §7.3).
 *
 * The stakes are higher here than for other pruned history: a session id is a capability — hold one
 * and you may use it — so pruning is the ONLY thing that can make a held id unresolvable.
 */
describe("pruning", () => {
  it("takes a whole lineage, so no fork is left with an orphaned prefix", () => {
    const root = streams.createRoot({ seed: "planning", taskId: "t-1" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });
    streams.append(branch.id, 2, [say("user", "c")]);
    const compacted = streams.compact(root.id, { seed: "c", entries: [say("user", "<summary>")] });

    expect(streams.prune(root.id)).toEqual({ branches: 3, messages: 4 });
    expect(streams.branch(root.id)).toBeUndefined();
    expect(streams.branch(branch.id)).toBeUndefined();
    expect(streams.branch(compacted.id)).toBeUndefined();
  });

  it("REFUSES to prune from the middle, which is exactly the orphaning case", () => {
    // Deleting a fork's parent takes the first two messages of a conversation that still exists.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });
    streams.append(branch.id, 2, [say("user", "c")]);

    expect(() => streams.prune(branch.id)).toThrow(/prune from the root/);
    expect(streams.branch(branch.id)).toBeDefined();
  });

  it("leaves unrelated lineages alone", () => {
    const keep = streams.createRoot({ seed: "keep" });
    streams.append(keep.id, 0, [say("user", "a")]);
    const drop = streams.createRoot({ seed: "drop" });
    streams.append(drop.id, 0, [say("user", "b")]);

    streams.prune(drop.id);
    expect(texts(streams.materialize(keep.id))).toEqual(["a"]);
  });

  it("takes the records with it — a handle cannot outlive the conversation it named", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [{ ...say("user", "a"), externalId: "sess-abc" }]);
    streams.prune(root.id);
    expect(db.prepare(`SELECT COUNT(*) n FROM operation_records`).get()).toEqual({ n: 0 });
  });

  it("is all-or-nothing — a refused prune deletes nothing at all", () => {
    // A half-pruned lineage is the worst outcome available: the trunk gone, a fork left pointing at
    // messages that no longer exist, and no error to say so.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a"), say("assistant", "b")]);
    const branch = streams.fork(root.id, 2, { seed: "v" });
    streams.append(branch.id, 2, [say("user", "c")]);
    const before = streams.size();

    expect(() => streams.prune(branch.id)).toThrow();
    expect(streams.size()).toEqual(before);
    expect(texts(streams.materialize(branch.id))).toEqual(["a", "b", "c"]);
  });

  it("refuses an unknown lineage rather than reporting a successful no-op", () => {
    expect(() => streams.prune("ses_nope")).toThrow(UnknownSession);
  });

  it("reports a task's lineage ROOTS, which are the units prune accepts", () => {
    const root = streams.createRoot({ seed: "planning", taskId: "t-1" });
    streams.append(root.id, 0, [say("user", "a")]);
    streams.fork(root.id, 1, { seed: "v" });
    streams.createRoot({ seed: "other", taskId: "t-1" });
    streams.createRoot({ seed: "elsewhere", taskId: "t-2" });

    // The fork is NOT a root: pruning it would reach outside its own lineage.
    expect(streams.rootsFor("t-1").map((b) => b.label).sort()).toEqual(["other", "planning"]);
    expect(streams.rootsFor("t-2").map((b) => b.label)).toEqual(["elsewhere"]);
  });
});
