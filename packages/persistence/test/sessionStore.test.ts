/**
 * Conversations that survive the process (SESSIONS.md §9).
 *
 * Every run has always built one of these and thrown it away: `sessionServicesFor` constructs a
 * `MapSessionStore`, the engine writes every model call into it complete, and the process exits. The
 * seam for keeping it — that function's `inner` parameter — existed the whole time and had never been
 * passed anything.
 *
 * The shared block runs against BOTH stores, and `MapSessionStore` is the ORACLE: the durable one is
 * only useful if it means exactly what the in-memory one means, and a store that got claiming or
 * forking subtly wrong would produce transcripts that look right and are not.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MapSessionStore, PositionTaken, type RecordStore, type SessionStore } from "@declarative-ai/exec";
import { openDb, type JairaDb } from "../src/db";
import { SqliteSessionStore } from "../src/sessionStore";
import { parseSessionRef, stateSessions } from "../src/views";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sessions-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Store = SessionStore<never> & RecordStore;

/** One turn, in the shape `defaultMessagesOf` reads: a record's `result.value.messages`. */
const turn = (text: string) => ({ role: "assistant", content: text });
/** One ENTRY — the only shape a record's conversation has. `turn` above is what a reader derives
 *  from it: the wire history, a projection rather than a second copy stored beside it. */
const said = (text: string, role = "assistant", extra: Record<string, unknown> = {}) => ({
  kind: "message",
  role,
  content: text,
  provider: "unknown",
  ...extra,
});

/** Claim a position and settle it — what one model call does through `withRecord`. */
async function write(store: Store, at: { id: string; seq: number }, id: string, text: string): Promise<void> {
  const ref = await store.append({ id, source: undefined as never, session: at, startMs: Date.now() });
  await store.finish(ref, { sessionOutcome: { messages: [turn(text)] } });
}

/** Append one turn to a conversation at its head, which is the ordinary case. */
async function append(store: Store, session: string, id: string, text: string): Promise<void> {
  await write(store, (await store.resolve({ ref: session })).at, id, text);
}

// Constructed per test rather than per suite: the database does not exist until `beforeEach`.
const BUILDERS: Array<[string, () => Store]> = [
  ["MapSessionStore", () => new MapSessionStore() as unknown as Store],
  ["SqliteSessionStore", () => new SqliteSessionStore(db) as unknown as Store],
];

describe.each(BUILDERS)("%s — the shared session semantics", (_name, build) => {
  it("appends, and reads the conversation back in order", async () => {
    const store = build();
    await append(store, "chat", "r1", "one");
    const second = await store.resolve({ ref: "chat" });
    await write(store, second.at, "r2", "two");

    expect(second.at.seq).toBe(1);
    expect(await store.messages("chat")).toEqual([turn("one"), turn("two")]);
  });

  it("refuses a second claim on one position, rather than silently taking the next", async () => {
    const store = build();
    const at = await store.resolve({ ref: "taken" });
    await write(store, at.at, "a", "first");

    // The store's job is only to refuse, by the right class: the correct answer is to FORK, and
    // appending at the next slot instead would continue a conversation containing a turn this call
    // never saw. `PositionTaken` is what the session layer watches for.
    let thrown: unknown;
    try {
      await store.append({ id: "b", source: undefined as never, session: at.at, startMs: 0 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PositionTaken);
  });

  it("forks by lineage — the branch shares the prefix and diverges after it", async () => {
    const store = build();
    await append(store, "base", "b1", "shared");
    await append(store, "base", "b2", "on the trunk");

    // Forked AT position 1, so the branch inherits only what came before it.
    const forkedRef = await store.fork("base@1");
    const branch = forkedRef.slice(0, forkedRef.lastIndexOf("@"));
    await append(store, forkedRef, "f1", "on the branch");

    expect(await store.messages(branch)).toEqual([turn("shared"), turn("on the branch")]);
    // …and the trunk is untouched, which is the whole claim a position makes.
    expect(await store.messages("base")).toEqual([turn("shared"), turn("on the trunk")]);
  });

  it("reads a conversation AT a position, not merely at its head", async () => {
    const store = build();
    await append(store, "history", "h1", "one");
    await append(store, "history", "h2", "two");

    expect(await store.messages("history@1")).toEqual([turn("one")]);
  });

  it("spells the ref for a position — including the one AFTER a call, which is what a state publishes", async () => {
    const store = build();
    const first = await store.resolve({ ref: "published" });
    await write(store, first.at, "p1", "one");

    // What the engine publishes as `operation.output.session`: the slot after the turn just written,
    // built by the store because the spelling is the store's, not the caller's. A store missing this
    // does not fail a type check against a stale upstream build — it throws mid-run, at the end of
    // the first call that completes, and takes the conversation with it.
    const next = store.refAt({ id: first.at.id, seq: first.at.seq + 1 });

    // It has to name the position the next append really lands on. If it named the one just taken,
    // every hand-off would resolve to a claimed slot and fork.
    const second = await store.resolve({ ref: next });
    expect(second.mode).toBe("append");
    expect(second.at).toEqual({ id: first.at.id, seq: 1 });
    expect(await store.messages(next)).toEqual([turn("one")]);
  });

  it("resumes the provider's handle on an append, and withholds it from a deliberate fork", async () => {
    const store = build();
    const at = await store.resolve({ ref: "handled" });
    const p1 = await store.append({ id: "p1", source: undefined as never, session: at.at, startMs: 0 });
    await store.finish(p1, { sessionOutcome: { messages: [turn("hi")], providerSessionId: "prov-1" } });

    // An append resumes the handle the conversation currently sits on…
    expect((await store.resolve({ ref: "handled" })).providerSessionId).toBe("prov-1");
    // …and a resolve that BRANCHES gets none, because two branches sharing one remote session would
    // be two conversations writing into the same place.
    expect((await store.resolve({ ref: "handled", fork: true })).providerSessionId).toBeUndefined();
  });

  /**
   * A handle names a conversation AT THE POINT IT HAS REACHED, not the conversation.
   *
   * Resolving an earlier position and handing back the head's handle offers a resume that would
   * continue from the remote's tip rather than from where the caller asked — a turn the caller never
   * saw, silently in front of its prompt. The position claim catches the collision afterwards and the
   * divergence check catches remote drift after the call, but nothing refused the handle itself.
   */
  it("withholds the handle at a position the conversation has moved past", async () => {
    const store = build();
    const first = await store.resolve({ ref: "moved" });
    const r1 = await store.append({ id: "m1", source: undefined as never, session: first.at, startMs: 0 });
    await store.finish(r1, { sessionOutcome: { messages: [turn("one")], providerSessionId: "prov-1" } });
    const second = await store.resolve({ ref: "moved" });
    const r2 = await store.append({ id: "m2", source: undefined as never, session: second.at, startMs: 0 });
    await store.finish(r2, { sessionOutcome: { messages: [turn("two")], providerSessionId: "prov-1" } });

    // At the head, resuming is legal.
    expect((await store.resolve({ ref: "moved" })).providerSessionId).toBe("prov-1");
    // One position back, it is not: the remote holds a turn this caller has not seen.
    expect((await store.resolve({ ref: "moved@1" })).providerSessionId).toBeUndefined();
  });

  /**
   * The branch `fork()` mints is a NEW conversation with no remote of its own.
   *
   * Its records begin at the cursor and it has written nothing, so walking the lineage for "the latest
   * handle" finds the PARENT's — and handing that back as `providerSessionId` on an append points two
   * local branches at one remote session. That is the case `resolve` withholds the handle to prevent
   * when the fork is deliberate; an automatic one reached it by the back door, because `fork()` then
   * `resolve()` reports `append`.
   */
  it("gives a freshly forked branch no handle of its own", async () => {
    const store = build();
    const at = await store.resolve({ ref: "branched" });
    const r1 = await store.append({ id: "b1", source: undefined as never, session: at.at, startMs: 0 });
    await store.finish(r1, { sessionOutcome: { messages: [turn("one")], providerSessionId: "prov-1" } });

    const forked = await store.fork("branched");
    const branch = await store.resolve({ ref: forked });
    // Nothing to RESUME — the branch has no remote of its own…
    expect(branch.providerSessionId).toBeUndefined();
    // …but the parent's handle is offered as what to branch FROM, on its own field, so an adapter that
    // can copy a session server-side gets the free move and one that cannot never sees it.
    expect(branch.forkFrom).toEqual({ handle: "prov-1" });
    // The prefix still reads through — a branch is its parent's records up to the cursor.
    expect(await store.messages(forked)).toEqual([turn("one")]);
  });

  /**
   * A branch point BEHIND the parent's tip cannot be reached by a native fork.
   *
   * The provider primitive is `--resume <id> --fork-session`, and it copies the remote AS IT NOW
   * STANDS — there is no "fork at turn 3" anywhere. So a branch whose cursor is behind the parent's
   * head would come back holding turns it never had: the interloper's, in the automatic-fork case,
   * which is precisely the position that was taken out from under it.
   *
   * The store is what knows, so the store is what withholds. `forkFrom` is offered only when copying
   * the remote would produce this branch's prefix and nothing else; every other branch falls through
   * to replay, which can reproduce any prefix.
   */
  it("names the CUT for a branch point the parent has moved past, when the entries can name one", async () => {
    const store = build();
    // Entries carrying the provider's own ids — what the native session capture stamps on a record.
    const withIds = (uuid: string) => ({ value: { entries: [{ kind: "message", role: "assistant", content: "x", provider: "test", uuid }] } }) as never;
    const first = await store.resolve({ ref: "cut" });
    const r1 = await store.append({ id: "k1", source: undefined as never, session: first.at, startMs: 0 });
    await store.finish(r1, { result: withIds("msg-1"), sessionOutcome: { providerSessionId: "prov-1" } });
    const second = await store.resolve({ ref: "cut" });
    const r2 = await store.append({ id: "k2", source: undefined as never, session: second.at, startMs: 0 });
    await store.finish(r2, { result: withIds("msg-2"), sessionOutcome: { providerSessionId: "prov-1" } });

    // At the tip: a plain copy reproduces the branch, so there is nothing to cut.
    expect(await store.resolve({ ref: await store.fork("cut") })).toMatchObject({ forkFrom: { handle: "prov-1" } });
    // Behind it: the copy has to stop at the last message the branch inherits.
    expect(await store.resolve({ ref: await store.fork("cut@1") })).toMatchObject({ forkFrom: { handle: "prov-1", at: "msg-1" } });
  });

  it("offers no fork source behind the tip when nothing can name the cut", async () => {
    const store = build();
    const first = await store.resolve({ ref: "raced" });
    const r1 = await store.append({ id: "x1", source: undefined as never, session: first.at, startMs: 0 });
    await store.finish(r1, { sessionOutcome: { messages: [turn("one")], providerSessionId: "prov-1" } });
    const second = await store.resolve({ ref: "raced" });
    const r2 = await store.append({ id: "x2", source: undefined as never, session: second.at, startMs: 0 });
    await store.finish(r2, { sessionOutcome: { messages: [turn("two")], providerSessionId: "prov-1" } });

    // Branching at the TIP: copying the remote gives exactly this branch's prefix, uncut.
    const atTip = await store.resolve({ ref: await store.fork("raced") });
    expect(atTip.forkFrom).toEqual({ handle: "prov-1" });

    // Branching one back: the remote holds a turn this branch does not, so there is nothing to copy.
    const behind = await store.resolve({ ref: await store.fork("raced@1") });
    expect(behind.forkFrom).toBeUndefined();
    expect(await store.messages(store.refAt(behind.at))).toEqual([turn("one")]);
  });

  it("compacts into a NEW conversation, leaving every existing ref meaning what it meant", async () => {
    const store = build();
    await append(store, "long", "l1", "one");
    await append(store, "long", "l2", "two");

    const compacted = await store.compact!("long", [turn("summary of one and two")] as never);

    expect(await store.messages(compacted)).toEqual([turn("summary of one and two")]);
    expect(await store.messages("long")).toEqual([turn("one"), turn("two")]);
  });
});

describe("SqliteSessionStore — what only a durable one can promise", () => {
  it("reads a transcript back after the process that wrote it is gone", async () => {
    const file = join(dir, "reopen.db");
    const first = openDb(file);
    const writer = new SqliteSessionStore(first, { taskId: "t1", runId: 3 }) as unknown as Store;
    await append(writer, "kept", "k1", "still here");
    first.close();

    const second = openDb(file);
    try {
      // Read under the SAME scope. A session id is instance-scoped (`#i2`) and instance ids restart on
      // every run, so the run is part of the key — otherwise a second run of one workflow would
      // continue the first run's conversation and read its whole transcript back as a preamble.
      const reader = new SqliteSessionStore(second, { taskId: "t1", runId: 3 }) as unknown as Store;
      // The claim the whole phase rests on: every transcript JaiRA ever produced used to be computed
      // and dropped, and `conversation.ts` said "there is no separate transcript to show" because of it.
      expect(await reader.messages("kept")).toEqual([turn("still here")]);

      // …and another run's store, asking for the same id, sees nothing of it.
      const other = new SqliteSessionStore(second, { taskId: "t1", runId: 4 }) as unknown as Store;
      expect(await other.messages("kept")).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("keeps the record whole, so an agent's own turns survive rather than a summary of them", async () => {
    const store = new SqliteSessionStore(db) as unknown as Store;
    const at = await store.resolve({ ref: "agent" });
    const a1 = await store.append({ id: "a1", source: undefined as never, session: at.at, startMs: 0 });
    await store.finish(a1, {
      sessionOutcome: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "tool-call", toolName: "read_file", args: { path: "x" } }] },
          { role: "assistant", content: "done" },
        ] as never,
      },
    });

    // A delegated agent hands back every turn, tool call and result on the same wire. Storing the
    // record verbatim is what keeps them; a message table would have had to decide which parts matter.
    const messages = await store.messages("agent");
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages)).toContain("read_file");
  });

  it("says where a branch came from, which is the other direction from `forks`", async () => {
    const durable = new SqliteSessionStore(db, { taskId: "t7", runId: 1 });
    const store = durable as unknown as Store;
    await append(store, "base", "b1", "shared");
    await append(store, "base", "b2", "on the trunk");
    const forkedRef = await store.fork("base@1");
    const branch = forkedRef.slice(0, forkedRef.lastIndexOf("@"));

    // `forks` answers "walking down to here, what did the path not take" — a thread's question. A
    // RUN holds the branches themselves, each drawn as its own panel, and asks the reverse: whose
    // continuation is this one, and from where.
    expect(durable.lineageOf(branch)).toEqual({ parent: "base", at: 1 });
    // The position is the one both sides SHARE, which is what pairs a branch back up with the record
    // it left behind: `base`'s own row at seq 1 is the other side of this fork.
    expect(durable.at("base", 1)).toBeDefined();
    // A root is most sessions, and says so by saying nothing.
    expect(durable.lineageOf("base")).toBeUndefined();
  });

  /**
   * Reading a run's calls back — what a derivation resolves its impure bindings against.
   *
   * The pair of claims worth pinning: a list is one row per record (the LATEST attempt, so a retried
   * call is one call), and the read is scoped to the run that wrote it.
   */
  it("lists a run's calls once each, latest attempt, oldest first", () => {
    const at = (recordId: string, attempt: number, started: number, status: string, result: unknown): void => {
      db.prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, request_json, result_json, started_at)
         VALUES (?, 'tr', 9, ?, ?, ?, ?, ?)`,
      ).run(recordId, attempt, status, JSON.stringify({ functionRef: recordId }), JSON.stringify(result), started);
    };
    at("a", 1, 10, "failed", { error: { reason: "first try" } });
    // A retry writes a SECOND row with the same content id — the call is the same call, so a list
    // that returned both would show one call twice with different answers, which reads as two.
    at("a", 2, 30, "completed", { value: "second try" });
    at("b", 1, 20, "completed", { value: 1 });

    const store = new SqliteSessionStore(db, { taskId: "tr", runId: 9 });
    const calls = store.records();
    expect(calls.map((c) => c.recordId)).toEqual(["b", "a"]);
    expect(calls.find((c) => c.recordId === "a")).toMatchObject({ status: "completed", result: { value: "second try" } });
  });

  it("keeps a run's calls out of another run's list", () => {
    db.prepare(
      `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, started_at)
       VALUES ('x', 'tr2', 1, 1, 'completed', 1)`,
    ).run();
    expect(new SqliteSessionStore(db, { taskId: "tr2", runId: 1 }).records().map((c) => c.recordId)).toEqual(["x"]);
    expect(new SqliteSessionStore(db, { taskId: "tr2", runId: 2 }).records()).toEqual([]);
  });

  it("hands back status separately from the error, because a killed call has neither", () => {
    // A run killed mid-flight leaves `failed` with no payload. A reader that inferred failure from a
    // missing result would report a call still in flight as one that went wrong.
    db.prepare(
      `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, started_at)
       VALUES ('k', 'tr3', 1, 1, 'failed', 5)`,
    ).run();
    const [call] = new SqliteSessionStore(db, { taskId: "tr3", runId: 1 }).records();
    expect(call).toMatchObject({ status: "failed" });
    expect(call?.error).toBeUndefined();
    expect(call?.result).toBeUndefined();
  });

  it("scopes records to the run that wrote them, so a transcript is findable from a task", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t9", runId: 2 }) as unknown as Store;
    await store.append({ id: "s1", source: undefined as never, session: { id: "scoped", seq: 0 }, startMs: 0 });

    const row = db.prepare(`SELECT task_id, run_id FROM operation_records WHERE record_id = 's1'`).get() as {
      task_id: string;
      run_id: number;
    };
    expect(row).toEqual({ task_id: "t9", run_id: 2 });
  });
  /**
   * Two records sharing an id and OPEN at once — which `close` cannot tell apart.
   *
   * A record with no position is keyed by `contentIdOf(op)`, so two identical operations dispatched in
   * one run share an id. `close` resolves that id to "the newest open row", which is right for a RETRY
   * — the previous attempt has settled, so only one row is open — and wrong here: both are open, so
   * the first settle lands on the second call's row and the second lands on the first's. The results
   * come back SWAPPED, silently, and every reader after them believes it.
   *
   * The id is not the problem; `close` taking one is. The database already enforces the key that would
   * disambiguate — `UNIQUE (task_id, run_id, record_id, attempt)` — and `open` is the only thing that
   * knows which attempt it just wrote, which is why it has to hand one back.
   */
  it("settles the record that closed, not merely the newest one sharing its id", () => {
    const store = new SqliteSessionStore(db, { taskId: "t-dup", runId: 1 });
    const stub = { id: "same-content", source: undefined as never, startMs: 1 };
    const first = store.append(stub); // attempt 1
    const second = store.append(stub); // attempt 2 — a second dispatch of an identical operation, still open
    expect([first.attempt, second.attempt]).toEqual([1, 2]);

    store.finish(first, { sessionOutcome: { messages: [turn("first")] } });
    store.finish(second, { sessionOutcome: { messages: [turn("second")] } });

    const settled = db
      .prepare(
        `SELECT attempt, session_outcome_json FROM operation_records
          WHERE record_id = 'same-content' ORDER BY attempt`,
      )
      .all() as Array<{ attempt: number; session_outcome_json: string | null }>;
    expect(settled.map((r) => r.attempt)).toEqual([1, 2]);
    expect(settled[0]!.session_outcome_json).toContain("first");
    expect(settled[1]!.session_outcome_json).toContain("second");
  });

});

/**
 * A derived conversation says where it came from.
 *
 * `compact` and `resync` mint a conversation whose first record is supplied rather than produced by a
 * call, and that record used to be the only one in the store with a null `request_json`. Nothing broke
 * — `openingMessage` finds no `user` and splices no turn — but a lineage that changed shape had only
 * the shape to explain itself, which is the one thing provenance is for.
 */
describe("what a derived conversation records about itself", () => {
  it("writes the request that produced the seed, not just its contents", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t-prov", runId: 1 }) as unknown as Store;
    await append(store, "origin", "o1", "one");
    const compacted = await store.compact!("origin", [turn("the summary")] as never);

    // The conversation reads as its seed…
    expect(await store.messages(compacted)).toEqual([turn("the summary")]);
    // …and the record behind it says what made it.
    const row = db
      .prepare(`SELECT request_json FROM operation_records WHERE record_id LIKE '%~compact%' ORDER BY id DESC LIMIT 1`)
      .get() as { request_json: string | null } | undefined;
    expect(JSON.parse(row!.request_json!)).toEqual({ kind: "derive", word: "compact", from: "origin" });
  });
});

/**
 * The store ASSUMES an append and lets the call correct it.
 *
 * `resolve` offers the handle a conversation currently sits on. Whether that handle is usable is not
 * a fact the store has — a different provider, a remote that compacted itself, an adapter that
 * branched — so it assumes the ordinary case rather than guarding against ones it cannot see. What
 * comes back says whether the assumption held: a call that reports a DIFFERENT remote than the one it
 * was handed did not run in the conversation this record was claimed in.
 *
 * The correction is the record moving to a branch of that position, so the trunk keeps meaning what
 * every existing ref into it meant and the branch carries the remote the call actually used. Applied
 * from `update` as well as `finish`, because the handle rides nearly every envelope and a crashed
 * call should already be on the right branch.
 */
describe("assume the append, correct from what comes back", () => {
  it("moves a record to a branch when the call reports a remote it was not given", () => {
    const s = new SqliteSessionStore(db, { taskId: "t-div", runId: 1 });
    const first = s.resolve({ ref: "chat" });
    s.finish(s.append({ id: "c1", source: undefined as never, session: first.at, startMs: 1 }), {
      sessionOutcome: { messages: [turn("one")] as never, providerSessionId: "P1" },
    });

    const second = s.resolve({ ref: "chat" });
    expect(second.providerSessionId).toBe("P1"); // the assumption the store hands over
    s.finish(s.append({ id: "c2", source: undefined as never, session: second.at, startMs: 2 }), {
      sessionOutcome: { messages: [turn("two")] as never, providerSessionId: "P2" },
    });

    // The trunk keeps only the turn that really happened in P1…
    expect(s.messages("chat")).toEqual([turn("one")]);
    // …and the other is on a branch of it, cut at the position it was claimed at.
    const branch = db.prepare(`SELECT parent, cursor FROM sessions WHERE parent IS NOT NULL`).get() as
      | { parent: string; cursor: number }
      | undefined;
    expect(branch).toMatchObject({ cursor: 1 });
  });

  it("leaves the lineage alone when the call reports the remote it was given", () => {
    const s = new SqliteSessionStore(db, { taskId: "t-same", runId: 1 });
    const first = s.resolve({ ref: "steady" });
    s.finish(s.append({ id: "s1", source: undefined as never, session: first.at, startMs: 1 }), {
      sessionOutcome: { messages: [turn("one")] as never, providerSessionId: "P1" },
    });
    const second = s.resolve({ ref: "steady" });
    s.finish(s.append({ id: "s2", source: undefined as never, session: second.at, startMs: 2 }), {
      sessionOutcome: { messages: [turn("two")] as never, providerSessionId: "P1" },
    });

    expect(s.messages("steady")).toEqual([turn("one"), turn("two")]);
    expect(db.prepare(`SELECT COUNT(*) n FROM sessions WHERE parent IS NOT NULL`).get()).toEqual({ n: 0 });
  });
});

describe("the migration runner", () => {
  it("brings an existing database forward rather than silently skipping the change", () => {
    // `CREATE TABLE IF NOT EXISTS` handles a new TABLE and no column at all, so without a runner the
    // constraint is "we may only ever add tables" — which gets violated by accident, and shows up as a
    // query that works on a new machine and fails on the one running longest.
    expect(Number(db.pragma("user_version", { simple: true }))).toBeGreaterThanOrEqual(2);
    // The generated column exists and reads NULL for an event that carried no position — which is what
    // every journal written before this migration looks like.
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t', 'queued', 1, 1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES ('t', 'h', 1)`).run();
    db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t', 1, 'operation.completed', ?, 1)`,
    ).run(JSON.stringify({ type: "operation.completed", instanceId: 1, stateId: "s", op: "prompt" }));
    db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t', 1, 'operation.completed', ?, 2)`,
    ).run(JSON.stringify({ type: "operation.completed", instanceId: 2, stateId: "s2", op: "prompt", metrics: { sessionRef: "review@3" } }));

    const refs = db.prepare(`SELECT session_ref FROM state_machine_events ORDER BY seq`).all() as Array<{
      session_ref: string | null;
    }>;
    expect(refs.map((r) => r.session_ref)).toEqual([null, "review@3"]);
  });

  it("normalises an old turn store into records plus positions, keeping every conversation readable", async () => {
    // A database as migration 3 left it: the conversation-turn `operation_records` under the name
    // DESIGN §4.2 had promised to the per-attempt record. Written BY HAND at version 3 — openDb would
    // migrate it — then brought forward, and the assertion is made through the ordinary store: the
    // migration is correct exactly when a conversation written before it reads identically after.
    const file = join(dir, "legacy.db");
    const legacy = new Database(file);
    legacy.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, parent TEXT REFERENCES sessions(id),
        cursor INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE operation_records (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, record_id TEXT NOT NULL,
        task_id TEXT, run_id INTEGER, result_json TEXT, metrics_json TEXT, external_id TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (session_id, seq));
      CREATE TABLE task_runtime (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, snapshot_hash TEXT,
        branch TEXT, worktree_path TEXT, root_instance_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, outputs_json TEXT, failure_json TEXT);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER NOT NULL,
        instance_id INTEGER, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        session_ref TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.metrics.sessionRef')) VIRTUAL);
      CREATE TABLE command_log (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER NOT NULL,
        tool TEXT NOT NULL, command TEXT, parsed_json TEXT, decision TEXT NOT NULL, decided_by TEXT NOT NULL,
        reason TEXT, scope TEXT, session_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT, run_id INTEGER,
        parent_job_id INTEGER, owner_token TEXT NOT NULL, pid INTEGER, command TEXT, started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL, cancel_requested_at INTEGER, ended_at INTEGER, outcome TEXT, cwd TEXT);
      CREATE TABLE job_output (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, stream TEXT NOT NULL,
        seq INTEGER NOT NULL, chunk TEXT NOT NULL, dropped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
        logical_path TEXT NOT NULL, physical_path TEXT, content TEXT, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
        format TEXT, instance_id INTEGER, state_id TEXT, slot TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE call_memo (key TEXT PRIMARY KEY, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('t1/3/old', NULL, 0, 1);
      INSERT INTO operation_records (session_id, seq, record_id, task_id, run_id, result_json, external_id, started_at, ended_at)
        VALUES ('t1/3/old', 0, 'r0', 't1', 3, '${JSON.stringify({ value: { entries: [said("kept")] } }).replace(/'/g, "''")}', 'prov-9', 1, 2);
    `);
    legacy.close();

    const migrated = openDb(file);
    try {
      const reader = new SqliteSessionStore(migrated, { taskId: "t1", runId: 3 }) as unknown as Store;
      expect(await reader.messages("old")).toEqual([turn("kept")]);
      // The provider handle rode `external_id`; the migration carries it into its own column, which
      // is what `handleAt` resumes from.
      expect((await reader.resolve({ ref: "old" })).providerSessionId).toBe("prov-9");
      // The turn row became a record plus a position pointing at it.
      expect(migrated.prepare(`SELECT COUNT(*) AS n FROM session_positions`).get()).toEqual({ n: 1 });
      expect(
        migrated.prepare(`SELECT status, provider_session_id FROM operation_records WHERE record_id = 'r0'`).get(),
      ).toEqual({ status: "completed", provider_session_id: "prov-9" });
    } finally {
      migrated.close();
    }
  });

it("moves a position onto the record's own key, and renumbers attempts so that key is one", async () => {
    // The point of migration 8, and the reason it exists ahead of DESIGN §4.4: a position pointed at
    // `operation_records.id`, which the database mints — so a store rebuilt from files re-mints every
    // one of them and every position silently names the wrong record.
    //
    // Rewound rather than hand-written, like the repair test above: the current schema, with the
    // position table put back into its pre-8 shape and two records of one id both claiming the first
    // attempt, which is exactly what `derive` used to write.
    const file = join(dir, "positions.db");
    const before = openDb(file);
    const row = (text: string): string => JSON.stringify({ value: { entries: [said(text)] } }).replace(/'/g, "''");
    before.exec(`
      DROP INDEX IF EXISTS operation_records_natural;
      DROP TABLE session_positions;
      CREATE TABLE session_positions (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        operation_record_id INTEGER NOT NULL REFERENCES operation_records(id),
        PRIMARY KEY (session_id, seq));
      INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('t1/1/conv', NULL, 0, 1);
      INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, result_json, started_at)
        VALUES ('conv:0', 't1', 1, 1, 'completed', '${row("first")}', 1);
      INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, result_json, started_at)
        VALUES ('conv:0', 't1', 1, 1, 'completed', '${row("second")}', 2);
      INSERT INTO session_positions (session_id, seq, operation_record_id)
        SELECT 't1/1/conv', 0, MIN(id) FROM operation_records;
      PRAGMA user_version = 7;
    `);
    before.close();

    const after = openDb(file);
    try {
      // The duplicate is gone, in insertion order — which is attempt order, and what `insertRecord`
      // would have computed had `derive` asked it.
      expect(after.prepare(`SELECT attempt FROM operation_records ORDER BY id`).all()).toEqual([
        { attempt: 1 },
        { attempt: 2 },
      ]);
      // The position carries the record's own key now, scope included.
      expect(after.prepare(`SELECT * FROM session_positions`).all()).toEqual([
        { session_id: "t1/1/conv", seq: 0, task_id: "t1", run_id: 1, record_id: "conv:0", attempt: 1 },
      ]);
      // And it still finds its record — the assertion the rowid used to carry, now carried by the
      // four columns and made unambiguous by `operation_records_natural`.
      const reader = new SqliteSessionStore(after, { taskId: "t1", runId: 1 }) as unknown as Store;
      expect(await reader.messages("conv")).toEqual([turn("first")]);
    } finally {
      after.close();
    }
  });

  it("refuses a second record claiming an attempt another already holds", () => {
    // The invariant the join rests on. Nothing wrote a duplicate before — `insertRecord` counts — but
    // nothing stopped one either, and a position row matching two records fans out into a transcript
    // with a turn in it twice.
    const insert = (attempt: number): void =>
      void db
        .prepare(
          `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, started_at)
           VALUES ('dup:0', 't9', 1, ?, 'open', 1)`,
        )
        .run(attempt);
    insert(1);
    expect(() => insert(1)).toThrow(/UNIQUE/);
    insert(2); // a genuine retry is not a duplicate
  });

});

/**
 * The journal → transcript join, which needed nothing new recorded.
 *
 * `withSessionPosition` reports the position a call ENDED at on `ExecMetrics.sessionRef` — its
 * documented contract — and hw puts those metrics on `operation.completed`. So the link has been in
 * the journal all along; it was only unqueryable without reading every payload.
 */
describe("parseSessionRef", () => {
  it("splits a plain ref", () => {
    expect(parseSessionRef("review@3")).toEqual({ id: "review", seq: 3 });
  });

  it("splits on the LAST `@`, because a session id may contain one", () => {
    // A compaction mints `planning~compact1`, and a position into it reads `…@7`. Splitting on the
    // first `@` would name a conversation that does not exist.
    expect(parseSessionRef("planning~compact1@7@8")).toEqual({ id: "planning~compact1@7", seq: 8 });
  });

  it("refuses anything that is not one", () => {
    expect(parseSessionRef("no-position")).toBeUndefined();
    expect(parseSessionRef("@4")).toBeUndefined();
    expect(parseSessionRef("x@notanumber")).toBeUndefined();
  });
});

describe("stateSessions", () => {
  it("reads one row per operation that ran in a conversation, one position back from where it ended", () => {
    // Written through the real journal so the GENERATED column is what the query reads — the point of
    // migration 1 is that the link is derived from the payload and so cannot drift from it.
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t1','queued',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES ('t1','h',1)`).run();
    const add = db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t1', 1, ?, ?, ?)`,
    );
    add.run(
      "operation.completed",
      JSON.stringify({ instanceId: 2, stateId: "wf/first", op: "prompt", metrics: { sessionRef: "chat@1" } }),
      10,
    );
    // No position: a function op runs in no conversation, and is simply not a row here.
    add.run("operation.completed", JSON.stringify({ instanceId: 3, stateId: "wf/gate", op: "function" }), 11);
    add.run(
      "operation.completed",
      JSON.stringify({ instanceId: 4, stateId: "wf/second", op: "prompt", metrics: { sessionRef: "chat@2" } }),
      12,
    );

    expect(stateSessions({ db } as never, "t1")).toEqual([
      // seq is one BACK from the reported end: the record was written at the position the call started
      // from, and the layer reports the end because that is what a caller cannot otherwise learn — a
      // call that had to fork ended somewhere it did not begin.
      { runId: 1, instanceId: 2, stateId: "wf/first", sessionId: "chat", seq: 0, at: 10, outcome: "success" },
      { runId: 1, instanceId: 4, stateId: "wf/second", sessionId: "chat", seq: 1, at: 12, outcome: "success" },
    ]);
  });

  it("lists a FAILED call too — it ran, it said things, and its transcript is in the store", () => {
    // Reading only completions is why an errored state's conversation was unreachable from the panel
    // that lists them. It is listable at all because `operation.failed` now carries the metrics a
    // post-dispatch failure has, and `session_ref` is derived from them.
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t2','failed',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES ('t2','h',1)`).run();
    const add = db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t2', ?, ?, ?, ?)`,
    );
    const runId = (db.prepare(`SELECT id FROM runs WHERE task_id = 't2'`).get() as { id: number }).id;
    add.run(runId, "operation.failed", JSON.stringify({ instanceId: 2, stateId: "wf/x", metrics: { sessionRef: "chat@1" } }), 10);
    // A failure that never dispatched carries no metrics, so no position — nothing ran to show.
    add.run(runId, "operation.failed", JSON.stringify({ instanceId: 3, stateId: "wf/y", failure: { reason: "no inputs" } }), 11);

    expect(stateSessions({ db } as never, "t2")).toEqual([
      { runId, instanceId: 2, stateId: "wf/x", sessionId: "chat", seq: 0, at: 10, outcome: "error" },
    ]);
  });
});

/**
 * The call a CRASH left with no terminal event at all.
 *
 * Neither half of the system can answer alone: the journal has the instance and state but no
 * completion, and the record has the position but knows nothing about which state ran it. Pairing
 * them in START order is sound because both lists are in start order — and a mismatch means no rows
 * rather than a guess, because a conversation attributed to the wrong state is worse than a missing
 * one.
 */
describe("stateSessions — a run the process died inside", () => {
  const crashedRun = (): number => {
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t3','interrupted',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at, ended_at, outcome) VALUES ('t3','h',1,9,'interrupted')`).run();
    return (db.prepare(`SELECT id FROM runs WHERE task_id = 't3'`).get() as { id: number }).id;
  };
  const started = (runId: number, instanceId: number, stateId: string, at: number): void => {
    db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t3', ?, 'operation.started', ?, ?)`,
    ).run(runId, JSON.stringify({ instanceId, stateId, op: "prompt" }), at);
  };
  const record = (runId: number, recordId: string, status = "failed"): void => {
    db.prepare(
      `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, started_at)
       VALUES (?, 't3', ?, 1, ?, 5)`,
    ).run(recordId, runId, status);
    // The position points at the record's own KEY, not at a rowid — migration 8. Written out here
    // rather than through the store because these rows stand in for a process that died mid-run.
    //
    // SCOPED, as `SqliteSessionStore` writes it. This fixture used to store the bare id, which no
    // store ever does, and the difference stayed invisible while the recovery view read the position
    // out of the record id instead of out of this table.
    const cut = recordId.lastIndexOf(":");
    db.prepare(
      `INSERT INTO session_positions (session_id, seq, task_id, run_id, record_id, attempt)
       VALUES (?, ?, 't3', ?, ?, 1)`,
    ).run(`t3/${runId}/${recordId.slice(0, cut)}`, Number(recordId.slice(cut + 1)), runId, recordId);
  };

  it("recovers the in-flight call from its own record, and says it was interrupted", () => {
    const runId = crashedRun();
    started(runId, 7, "wf/thinking", 20);
    record(runId, "chat:3");
    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 7, stateId: "wf/thinking", sessionId: "chat", seq: 3, at: 20, outcome: "interrupted" },
    ]);
  });

  /**
   * The case that is not a crash, a failure or a stop: the call is STILL TALKING.
   *
   * It leaves the journal in exactly the shape a crash does — a start with no terminal event, since
   * the terminal event is what ending writes — so it arrives in this pass beside the dead ones, and
   * for a while it was labelled with their verdict. Every state a person watched while a run was
   * going therefore read `interrupted`: the panel beside it said "stopped" and the transcript ended
   * with "the process ended before this call finished", under an answer that was still growing.
   *
   * The record row is what tells them apart, and it always could: `open` means a live process is
   * streaming into it, which is the whole reason that status exists.
   */
  it("calls a live run's in-flight conversation running rather than interrupted", () => {
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t3','running',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES ('t3','h',1)`).run();
    const runId = (db.prepare(`SELECT id FROM runs WHERE task_id = 't3'`).get() as { id: number }).id;
    started(runId, 4, "wf/critique", 20);
    record(runId, "#i4:0", "open");

    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 4, stateId: "wf/critique", sessionId: "#i4", seq: 0, at: 20, outcome: "running" },
    ]);
  });

  /**
   * …but only while the run is still going. An `open` row under a run that ENDED is a crash nothing
   * has recovered yet — `recoverInterrupted` settles those to `failed` at project open, and until it
   * runs the honest reading of a row nobody is writing to is the interruption it is.
   */
  it("still calls an open record interrupted once the run it belongs to has ended", () => {
    const runId = crashedRun();
    started(runId, 4, "wf/critique", 20);
    record(runId, "#i4:0", "open");

    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 4, stateId: "wf/critique", sessionId: "#i4", seq: 0, at: 20, outcome: "interrupted" },
    ]);
  });

  it("pairs several in-flight calls in start order, which both lists share", () => {
    const runId = crashedRun();
    started(runId, 7, "wf/a", 20);
    started(runId, 8, "wf/b", 21);
    record(runId, "chat:0");
    record(runId, "other:0");
    expect(stateSessions({ db } as never, "t3").map((s) => [s.instanceId, s.sessionId])).toEqual([
      [7, "chat"],
      [8, "other"],
    ]);
  });

  it("says nothing rather than guessing when the two lists disagree", () => {
    const runId = crashedRun();
    started(runId, 7, "wf/a", 20);
    started(runId, 8, "wf/b", 21);
    record(runId, "chat:0"); // one record, two in-flight calls — which is which?
    expect(stateSessions({ db } as never, "t3")).toEqual([]);
  });

  it("leaves a settled call out of the in-flight set", () => {
    const runId = crashedRun();
    started(runId, 7, "wf/done", 20);
    db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t3', ?, 'operation.completed', ?, ?)`,
    ).run(runId, JSON.stringify({ instanceId: 7, stateId: "wf/done", metrics: { sessionRef: "chat@1" } }), 22);
    started(runId, 8, "wf/dying", 23);
    // The settled one, at the position its event reports the call ending one past (`chat@1`) — which
    // is how it is excluded: the journal already names it, whatever its status says.
    record(runId, "chat:0", "completed");
    record(runId, "chat:2");
    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 7, stateId: "wf/done", sessionId: "chat", seq: 0, at: 22, outcome: "success" },
      { runId, instanceId: 8, stateId: "wf/dying", sessionId: "chat", seq: 2, at: 23, outcome: "interrupted" },
    ]);
  });

  /**
   * The case that is NOT a dead process: the engine threw after the call returned, so the record is
   * settled and whole and the terminal event carrying it was never written. It happened — a session
   * store missing a method the contract had gained — and the chat it took down was a finished answer
   * sitting in the database that nothing could reach, on a run marked `error` rather than
   * `interrupted`. Listed, and listed as the success it was.
   */
  it("lists a call that SETTLED and then lost its event, on a run the engine died in", () => {
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t3','failed',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at, ended_at, outcome) VALUES ('t3','h',1,9,'error')`).run();
    const runId = (db.prepare(`SELECT id FROM runs WHERE task_id = 't3'`).get() as { id: number }).id;
    started(runId, 1, "chat/agent", 20);
    record(runId, "#i1:0", "completed");

    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 1, stateId: "chat/agent", sessionId: "#i1", seq: 0, at: 20, outcome: "success" },
    ]);
  });

  /**
   * The case that is not a crash at all: somebody pressed stop.
   *
   * Cancelling ends the instance (`instance.terminated`, outcome `canceled`) and settles the record
   * where it stood — `failed`, holding everything the call had streamed — but writes no
   * `operation.completed` and no `operation.failed`, so the journal query finds nothing and this
   * pass is the only one that can. The run filter named `interrupted` and `error` and not
   * `canceled`, which meant a stopped conversation had no session row, so its chat had no host, no
   * position and no thread: minutes of answer in the database, and "this conversation has not said
   * anything yet" on the screen.
   */
  it("recovers the call somebody STOPPED, on a run whose outcome is canceled", () => {
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t3','canceled',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at, ended_at, outcome) VALUES ('t3','h',1,9,'canceled')`).run();
    const runId = (db.prepare(`SELECT id FROM runs WHERE task_id = 't3'`).get() as { id: number }).id;
    started(runId, 1, "chat/agent", 20);
    // Cancellation settles the row rather than leaving it open, so the EXISTS arm of the run filter
    // does not catch this one either — the outcome is the only thing that admits it.
    record(runId, "#i1:0", "failed");

    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 1, stateId: "chat/agent", sessionId: "#i1", seq: 0, at: 20, outcome: "interrupted" },
    ]);
  });

  it("still says nothing about a run that ended in an ordinary error, every call accounted for", () => {
    db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t3','failed',1,1)`).run();
    db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at, ended_at, outcome) VALUES ('t3','h',1,9,'error')`).run();
    const runId = (db.prepare(`SELECT id FROM runs WHERE task_id = 't3'`).get() as { id: number }).id;
    started(runId, 1, "wf/a", 20);
    db.prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at) VALUES ('t3', ?, 'operation.failed', ?, ?)`,
    ).run(runId, JSON.stringify({ instanceId: 1, stateId: "wf/a", metrics: { sessionRef: "chat@1" } }), 21);
    record(runId, "chat:0", "failed");

    // One row, from the journal — the recovery path adds nothing, because nothing is unaccounted for.
    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 1, stateId: "wf/a", sessionId: "chat", seq: 0, at: 21, outcome: "error" },
    ]);
  });
});

/**
 * Streamed partials — the live turn's durable copy (the crash-survival half of the live view).
 *
 * The row's `status` is THE state signal now, not the presence of a value: an open row may carry a
 * streamed partial, and every reader that answers "did this turn happen?" must ask the column. The
 * suite pins both directions — a partial is readable where the reader knowingly wants it
 * (`transcript`/`at`, status exposed) and invisible where it must never leak (materialized history,
 * `bySession`), and a settle can neither be clobbered by a late flush nor clobber a partial it
 * cannot better.
 */
describe("streamed partials on open records", () => {
  const store = () => new SqliteSessionStore(db) as unknown as Store & SqliteSessionStore;
  const partial = (texts: string[]) => ({ value: { entries: texts.map((t) => said(t)) } }) as never;

  it("streams into the open row, visible with its status — and out of materialized history", async () => {
    const s = store();
    await append(s, "chat", "r1", "settled");
    const at = await s.resolve({ ref: "chat" });
    const r2 = await s.append({ id: "r2", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r2, { value: partial(["half", "written"]), providerSessionId: "prov-3" });
    // The provider handle lands EARLY — what makes an interrupted call resumable at all.
    expect(db.prepare(`SELECT provider_session_id FROM operation_records WHERE record_id = 'r2'`).get()).toEqual({
      provider_session_id: "prov-3",
    });

    // The knowing readers see it, labelled: the viewer's channel.
    const rows = s.transcript("chat");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "open", value: { value: { entries: [said("half"), said("written")] } } });
    // History must not: a half-written turn replayed into a provider is a conversation that never
    // happened. Value presence would say yes here; the state field says no.
    expect(await s.messages("chat")).toEqual([turn("settled")]);
    expect((s.bySession("chat") as Array<{ result?: unknown }>)[1]!.result).toBeUndefined();
  });

  it("lets the settle replace the partial, and refuses a late flush after it", async () => {
    const s = store();
    const at = await s.resolve({ ref: "conv" });
    const r1 = await s.append({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r1, { value: partial(["early"]) });
    await s.finish(r1, { sessionOutcome: { messages: [turn("the whole answer")] } });
    // A debounce timer firing after the record settled matches no open row — the status guard.
    s.update(r1, { value: partial(["stale"]) });

    expect(await s.messages("conv")).toEqual([turn("the whole answer")]);
    expect(s.transcript("conv")[0]).toMatchObject({ status: "completed" });
  });

  it("keeps the partial when an ERRORED settle brings nothing better", async () => {
    const s = store();
    const at = await s.resolve({ ref: "err" });
    const r1 = await s.append({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r1, { value: partial(["what got said"]) });
    // An agent's error settle: `{error, value:{finishReason}}` — no messages, no session outcome.
    await s.finish(r1, { result: { error: { classification: "permanent", reason: "boom" }, value: { finishReason: "error" } } as never });

    // The turns really were exchanged; a failed record keeping them is how errored calls already
    // represent turns that "may exist remotely". They now count as history too — settled, not open.
    expect(s.transcript("err")[0]).toMatchObject({ status: "failed", value: { value: { entries: [said("what got said")] } } });
    expect(await s.messages("err")).toEqual([turn("what got said")]);
  });

  it("lets an errored settle that DOES carry the conversation win over the partial", async () => {
    const s = store();
    const at = await s.resolve({ ref: "err2" });
    const r1 = await s.append({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r1, { value: partial(["early copy"]) });
    await s.finish(r1, {
      result: { error: { classification: "permanent", reason: "boom" } } as never,
      sessionOutcome: { messages: [turn("authoritative")] },
    });
    expect(await s.messages("err2")).toEqual([turn("authoritative")]);
  });

  it("writes nothing where no open row claims the position", () => {
    const s = store();
    expect(() => s.update({ id: "nowhere", attempt: 1 }, { value: partial(["x"]) })).not.toThrow();
    expect(s.transcript("nowhere")).toEqual([]);
  });

  /**
   * A record holds the message it was CALLED with, at every instant of its life.
   *
   * `LlmOutput.messages` is "the messages this call appended", and for a settled call that delta
   * opens with the question because the provider echoes it back. Nothing echoed it to a call that
   * was stopped, so the record held only what the transport streamed — the model's own output — and
   * the question, sitting in `request_json` two columns over, reached no reader at all. The
   * transcript patched it back at display time and got it wrong for an agent (a tool RESULT is a
   * user-role message, so "is there a user turn here" answered yes); provider replay did not patch
   * it and handed the model an answer with no question in front of it.
   *
   * So it is written once, by whoever touches the row: born with it, kept in front of every flush,
   * and carried through the settle. These four tests are the four moments.
   */
  describe("the message the call was made with", () => {
    const asked = { kind: "prompt", user: "what is in this repository?" } as never;
    const question = { role: "user", content: "what is in this repository?" };
    /** The same turn as the entry the record actually carries — what `withOpening` splices in. */
    const askedEntry = said("what is in this repository?", "user");

    it("is on the record from birth, before anything has streamed", async () => {
      const s = store();
      const at = await s.resolve({ ref: "ask" });
      const r1 = await s.append({ id: "r1", source: asked, session: at.at, startMs: 1 });
      // The case that made this the record's birth rather than its first flush: a process killed
      // here reaches no later write, and the row is all anybody will ever have.
      expect(s.transcript("ask")[0]).toMatchObject({ status: "open", value: { value: { entries: [askedEntry] } } });
    });

    it("stays in front of the turns a flush writes over it", async () => {
      const s = store();
      const at = await s.resolve({ ref: "ask" });
      const r1 = await s.append({ id: "r1", source: asked, session: at.at, startMs: 1 });
      s.update(r1, { value: partial(["it has two tables"]) });
      expect(s.transcript("ask")[0]!.value).toMatchObject({ value: { entries: [askedEntry, said("it has two tables")] } });
    });

    it("survives the settle of a call that was stopped, and reaches REPLAY as well as the screen", async () => {
      const s = store();
      const at = await s.resolve({ ref: "ask" });
      const r1 = await s.append({ id: "r1", source: asked, session: at.at, startMs: 1 });
      s.update(r1, { value: partial(["it has two tables"]) });
      await s.finish(r1, { result: { error: { classification: "canceled", reason: "stopped" } } as never });

      // Replay is the half that had no workaround: the next call is sent this, and an assistant turn
      // with nothing in front of it is a conversation that never happened.
      expect(await s.messages("ask")).toEqual([question, turn("it has two tables")]);
    });

    it("is not doubled by a settle that carries the question itself", async () => {
      const s = store();
      const at = await s.resolve({ ref: "ask" });
      const r1 = await s.append({ id: "r1", source: asked, session: at.at, startMs: 1 });
      s.update(r1, { value: partial(["half an answer"]) });
      // A call that finished: the provider's delta is authoritative and already opens with the
      // question, so the splice must stand down rather than print it twice.
      await s.finish(r1, { result: { value: { entries: [askedEntry, said("the whole answer")] } } as never });
      expect(await s.messages("ask")).toEqual([question, turn("the whole answer")]);
    });

    it("pads the per-turn clocks it moves, so no turn wears its neighbour's duration", async () => {
      const s = store();
      const at = await s.resolve({ ref: "ask" });
      const r1 = await s.append({ id: "r1", source: asked, session: at.at, startMs: 1 });
      s.update(r1, { value: timed(["thought about it", "answered"], [{ at: 200, thoughtMs: 90 }, { at: 300 }]) });
      // The clocks are ON the turns they measure, so the spliced question simply has none —
      // there is no parallel array left to shift onto the wrong turn.
      expect(s.transcript("ask")[0]!.value).toMatchObject({
        value: {
          entries: [
            askedEntry,
            said("thought about it", "assistant", { timing: { at: 200, thoughtMs: 90 } }),
            said("answered", "assistant", { timing: { at: 300 } }),
          ],
        },
      });
    });

    it("says nothing for an operation that is not a prompt", async () => {
      const s = store();
      const at = await s.resolve({ ref: "fn" });
      // A function op, a gate, a pre-dispatch failure: no `user`, so nothing to splice and no record
      // invented to hold it.
      const r1 = await s.append({ id: "r1", source: { kind: "function", name: "review" } as never, session: at.at, startMs: 1 });
      expect(s.transcript("fn")[0]!.value).toBeUndefined();
    });
  });

  /**
   * The clocks survive a SUCCESSFUL settle — the one field the settle cannot reproduce.
   *
   * A provider result carries no wall clock per message, so the per-turn times exist exactly once:
   * in the stream that measured them. Overwriting the row with the settled result used to drop them,
   * which is why a finished run's thinking rows had no "thought for 12 s" and a live one did.
   */
  const timed = (texts: string[], times: Array<Record<string, number>>) =>
    ({ value: { entries: texts.map((t, i) => said(t, "assistant", { timing: times[i] })) } }) as never;

  it("carries the streamed per-turn times onto a successful settle, aligned as a suffix", async () => {
    const s = store();
    const at = await s.resolve({ ref: "timed" });
    const r1 = await s.append({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r1, { value: timed(["thought about it", "answered"], [{ at: 200, thoughtMs: 90 }, { at: 300 }]) });
    // The settle holds the message the call was made WITH as well, so the stamps line up with the
    // TAIL of its list — padded at the front, never shifted onto the wrong turn.
    await s.finish(r1, {
      result: { value: { entries: [said("go", "user"), said("thought about it"), said("answered")] } } as never,
    });

    const row = s.transcript("timed")[0] as { value?: { value?: { entries?: Array<{ timing?: unknown }> } } };
    const entries = row.value?.value?.entries;
    expect(entries).toHaveLength(3);
    // Merged onto the turns they measure — the question the call was made with keeps none.
    expect(entries?.map((e) => e.timing)).toEqual([undefined, { at: 200, thoughtMs: 90 }, { at: 300 }]);
  });

  it("drops the times rather than mislabel a turn when the roles do not line up", async () => {
    const s = store();
    const at = await s.resolve({ ref: "askew" });
    const r1 = await s.append({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.update(r1, { value: timed(["one", "two"], [{ at: 1 }, { at: 2 }]) });
    await s.finish(r1, {
      result: { value: { entries: [said("one"), said("not two", "user")] } } as never,
    });
    const row = s.transcript("askew")[0] as { value?: { value?: { entries?: Array<{ timing?: unknown }> } } };
    expect(row.value?.value?.entries?.map((e) => e.timing)).toEqual([undefined, undefined]);
  });
});

/**
 * What a crash leaves recoverable — the handle plus the cut, which is all a native capture needs.
 *
 * The handle is on the row only because it is streamed there while the call runs: a call that died
 * before its close would otherwise have none, and a session file cannot be found without one.
 */
describe("recovering an interrupted call's own transcript", () => {
  const scoped = () => new SqliteSessionStore(db, { taskId: "t1", runId: 1 });

  const crashed = (over: { status?: string; handle?: string | null; result?: string | null } = {}): number => {
    // Each call is a distinct ATTEMPT of the same record id, and says so — the natural key
    // (`operation_records_natural`, migration 8) is what makes a position row's join unambiguous, so
    // three rows all claiming attempt 1 is now the contradiction it always was.
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM operation_records WHERE record_id = 's:0' AND task_id = 't1' AND run_id = 1`)
      .get() as { n: number };
    const info = db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, provider_session_id, result_json, started_at)
         VALUES ('s:0', 't1', 1, ?, ?, ?, ?, 900)`,
      )
      .run(n + 1, over.status ?? "failed", over.handle === undefined ? "prov-1" : over.handle, over.result ?? null);
    return Number(info.lastInsertRowid);
  };

  it("offers the handle and the start time — the cut that keeps a resumed session's earlier lines out", () => {
    crashed();
    expect(scoped().recoverable("t1")).toEqual([{ id: expect.any(Number), providerSessionId: "prov-1", startedAt: 900 }]);
  });

  it("passes over a row with no handle, a live row, and one already captured", () => {
    crashed({ handle: null }); // nothing to find the file with
    crashed({ status: "open" }); // still running — a live process owns it
    crashed({ result: JSON.stringify({ value: { capturedAt: "2026-08-27T00:00:00.000Z" } }) }); // done already
    expect(scoped().recoverable("t1")).toEqual([]);
  });

  it("folds a recovered capture into the payload, beside what the crash had already saved", () => {
    const id = crashed({ result: JSON.stringify({ value: { entries: [turn("streamed")] } }) });
    const s = scoped();
    // The FOLD is the caller's rule — this package hands over the value and takes back the result,
    // because merging a captured file into entries belongs to the runtime and cannot be imported here.
    s.foldNativeCapture(id, (value) => ({ ...value, capturedAt: "2026-08-27T00:00:00.000Z" }));

    const row = db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(id) as { result_json: string };
    // The partial the flush saved survives; the fold's answer is what the record now holds.
    expect(JSON.parse(row.result_json)).toEqual({
      value: { entries: [turn("streamed")], capturedAt: "2026-08-27T00:00:00.000Z" },
    });
    // …and it is no longer offered: a second open re-reads no files.
    expect(s.recoverable("t1")).toEqual([]);
  });

  it("leaves a payload it cannot honestly extend alone", () => {
    // A scripted value or a bare string has nowhere to put lines — wrapping it in a shape nothing
    // reads would corrupt the record to add an annotation.
    const id = crashed({ result: JSON.stringify({ value: "just text" }) });
    scoped().foldNativeCapture(id, (value) => ({ ...value, capturedAt: "x" }));
    expect(JSON.parse((db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(id) as { result_json: string }).result_json)).toEqual({
      value: "just text",
    });
  });
});

describe("pruning conversations", () => {
  it("leaves a recordless branch that something still points at, rather than aborting on its FK", () => {
    // A fork in flight: `branchFrom` writes the lineage row before the branch's first record exists,
    // so BOTH rows are recordless — which is what a naive "delete sessions with no records" hits.
    db.prepare(`INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('trunk', NULL, 0, 1)`).run();
    db.prepare(`INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('branch', 'trunk', 0, 1)`).run();

    const drop = db.prepare(
      `DELETE FROM sessions
        WHERE created_at < ?
          AND id NOT IN (SELECT DISTINCT session_id FROM session_positions)
          AND id NOT IN (SELECT parent FROM sessions WHERE parent IS NOT NULL)`,
    );
    // The parent is spared because a child points at it; without that clause this throws
    // `FOREIGN KEY constraint failed` and rolls back everything the prune had already done.
    expect(() => drop.run(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'trunk'`).get()).toEqual({ n: 1 });
  });

  it("leaves a conversation younger than the prune window alone", () => {
    db.prepare(`INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('fresh', NULL, 0, 9999)`).run();
    const drop = db.prepare(
      `DELETE FROM sessions
        WHERE created_at < ?
          AND id NOT IN (SELECT DISTINCT session_id FROM session_positions)
          AND id NOT IN (SELECT parent FROM sessions WHERE parent IS NOT NULL)`,
    );
    drop.run(100);
    // Younger than the cutoff means it belongs to work that is still going on.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'fresh'`).get()).toEqual({ n: 1 });
  });
});
