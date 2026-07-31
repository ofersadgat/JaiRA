/**
 * Durable conversation streams (SESSIONS.md §2, §9).
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
import { openDb, type JairaDb } from "../src/db";
import {
  SessionPositionConflict,
  SessionStreams,
  UnknownSession,
  formatSessionRef,
  parseSessionRef,
  shortSessionLabel,
  type SessionEntry,
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

/** A message shaped like a real one — parts and providerOptions, not `content: string`. */
const say = (role: string, text: string): SessionEntry => ({
  message: { role, content: [{ type: "text", text }] },
});

const texts = (entries: ReadonlyArray<{ message: unknown }>): string[] => readTexts(entries.map((e) => e.message));

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
    streams.append(root.id, 0, [{ message, providerRef: "msg_01", operationId: "op-7" }]);

    const [stored] = streams.materialize(root.id);
    expect(stored!.message).toEqual(message);
    expect(stored!.providerRef).toBe("msg_01");
    expect(stored!.operationId).toBe("op-7");
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

    const owned = db.prepare(`SELECT COUNT(*) n FROM session_messages WHERE session_id = ?`).get(branch.id) as {
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
    expect(() => streams.append(root.id, 0, [say("user", "a"), { message: circular as never }])).toThrow();
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
  it("keys by (session, provider), so two adapters cache independently", () => {
    const root = streams.createRoot({ seed: "planning" });
    streams.setProviderHandle(root.id, "claude-cli", "sess-abc");
    streams.setProviderHandle(root.id, "managed-agents", "sesn_123");
    expect(streams.providerHandle(root.id, "claude-cli")).toBe("sess-abc");
    expect(streams.providerHandle(root.id, "managed-agents")).toBe("sesn_123");
    expect(streams.providerHandle(root.id, "messages-api")).toBeUndefined();
  });

  it("a fork does not inherit its parent's handle", () => {
    // Two branches writing into one remote session is the failure this prevents.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    streams.setProviderHandle(root.id, "claude-cli", "sess-abc");
    const branch = streams.fork(root.id, 1, { seed: "v" });
    expect(streams.providerHandle(branch.id, "claude-cli")).toBeUndefined();
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

describe("the executor-facing contract", () => {
  /** The one call's-eye view the executor stack consumes, over the same durable lineage store. */
  const exec = () => streams.asExecStore({ taskId: "t-1", runId: 1 });

  it("reserves, folds what the executor reported, and returns the END position", async () => {
    const store = exec();
    const lease = await store.begin({ ref: "planning" });
    expect(lease.session.mode).toBe("append");
    const end = await lease.release({ messages: [say("user", "a"), say("assistant", "b")] });
    // The end, not the start: "append after me" and "fork after me" both mean after.
    expect(end).toMatch(/@2$/);
    expect(readTexts(store.read!(end))).toEqual(["a", "b"]);
  });

  it("creates a root for a bare NAME nobody has used, seeded so a replay lands on the same stream", async () => {
    const first = await (await exec().begin({ ref: "planning" })).release({ messages: [say("user", "a")] });
    const second = await (await exec().begin({ ref: "planning" })).release({ messages: [say("user", "b")] });
    // One stream, two appends — not two streams that merely share a name.
    expect(second.split("@")[0]).toBe(first.split("@")[0]);
    expect(readTexts(exec().read!(second))).toEqual(["a", "b"]);
  });

  it("FORKS a position that has already been appended past, leaving the origin alone", async () => {
    const store = exec();
    const start = await (await store.begin({ ref: "planning" })).release({ messages: [say("user", "a")] });
    const [branch] = start.split("@");
    const again = await store.begin({ ref: `${branch}@0` });
    expect(again.session.mode).toBe("fork");
    const end = await again.release({ messages: [say("user", "different")] });
    expect(readTexts(store.read!(end))).toEqual(["different"]);
    expect(readTexts(store.read!(start))).toEqual(["a"]);
  });

  it("FORKS a position another call is holding, without either clobbering the other", async () => {
    // The TOCTOU case: both saw the same head. Reserving rather than peeking is what makes the second
    // one fork instead of overwriting the first.
    const store = exec();
    const root = streams.createRoot({ seed: "planning" });
    const first = await store.begin({ ref: formatSessionRef(root.id, 0) });
    const second = await store.begin({ ref: formatSessionRef(root.id, 0) });
    expect(first.session.mode).toBe("append");
    expect(second.session.mode).toBe("fork");
    await first.release({ messages: [say("assistant", "first")] });
    const forked = await second.release({ messages: [say("assistant", "second")] });
    expect(readTexts(store.read!(formatSessionRef(root.id, 1)))).toEqual(["first"]);
    expect(readTexts(store.read!(forked))).toEqual(["second"]);
  });

  it("`fork: true` branches even at a free head", async () => {
    const store = exec();
    const start = await (await store.begin({ ref: "planning" })).release({ messages: [say("user", "a")] });
    const lease = await store.begin({ ref: start, fork: true });
    expect(lease.session.mode).toBe("fork");
  });

  it("releases idempotently, so a `finally` after the happy path folds nothing twice", async () => {
    const store = exec();
    const lease = await store.begin({ ref: "planning" });
    const delta = { messages: [say("user", "a")] };
    const first = await lease.release(delta);
    expect(await lease.release(delta)).toBe(first);
    expect(readTexts(store.read!(first))).toEqual(["a"]);
  });

  it("an EMPTY delta appends nothing and frees the reservation", async () => {
    // A call that failed before the provider saw anything has a real, empty delta.
    const store = exec();
    const lease = await store.begin({ ref: "planning" });
    const end = await lease.release({ messages: [] });
    expect(end).toMatch(/@0$/);
    // ...and the position is free again, so the next call appends rather than forking.
    expect((await store.begin({ ref: end })).session.mode).toBe("append");
  });

  it("hands back the provider handle on an APPEND and never on a fork", async () => {
    const store = exec();
    const lease = await store.begin({ ref: "planning", provider: "claude-cli" });
    const end = await lease.release({ messages: [say("user", "a")], providerSessionId: "sess-abc" });
    expect((await store.begin({ ref: end, provider: "claude-cli" })).session.providerSessionId).toBe("sess-abc");
    // A fork must never inherit it, or two branches write into one remote session.
    expect((await store.begin({ ref: end, fork: true, provider: "claude-cli" })).session.providerSessionId).toBeUndefined();
  });

  it("compacts into a new stream, leaving the origin readable at its own positions", async () => {
    const store = exec();
    const end = await (await store.begin({ ref: "planning" })).release({
      messages: [say("user", "a"), say("assistant", "b"), say("user", "c")],
    });
    const compacted = await store.compact!(end, [say("user", "<summary>"), say("user", "c")]);
    expect(readTexts(store.read!(compacted))).toEqual(["<summary>", "c"]);
    expect(readTexts(store.read!(end))).toEqual(["a", "b", "c"]);
    expect(streams.branch(compacted.split("@")[0]!)?.edge).toBe("compaction");
  });

  it("exposes only `id` on the session it hands the executor", async () => {
    const lease = await exec().begin({ ref: "planning" });
    expect(Object.keys(lease.session)).toEqual(["id"]);
    expect(lease.session.mode).toBe("append");
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

  it("enforces the lineage foreign keys — a message cannot outlive its branch", () => {
    // Step 9's problem stated as a constraint: deleting a branch that others descend
    // from is refused by the database, not left to a caller to remember.
    const root = streams.createRoot({ seed: "planning" });
    streams.append(root.id, 0, [say("user", "a")]);
    streams.fork(root.id, 1, { seed: "v" });
    expect(() => db.prepare(`DELETE FROM sessions WHERE id = ?`).run(root.id)).toThrow(/FOREIGN KEY/i);
    expect(() =>
      db
        .prepare(`INSERT INTO session_messages (session_id, seq, message_json) VALUES (?, ?, ?)`)
        .run("ses_missing", 0, "{}"),
    ).toThrow(/FOREIGN KEY/i);
  });
});
