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

/** Claim a position and settle it — what one model call does through `withRecord`. */
async function write(store: Store, at: { id: string; seq: number }, id: string, text: string): Promise<void> {
  await store.open({ id, source: undefined as never, session: at, startMs: Date.now() });
  await store.close(id, { sessionOutcome: { messages: [turn(text)] } });
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
      await store.open({ id: "b", source: undefined as never, session: at.at, startMs: 0 });
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

  it("resumes the provider's handle on an append, and withholds it from a deliberate fork", async () => {
    const store = build();
    const at = await store.resolve({ ref: "handled" });
    await store.open({ id: "p1", source: undefined as never, session: at.at, startMs: 0 });
    await store.close("p1", { sessionOutcome: { messages: [turn("hi")], providerSessionId: "prov-1" } });

    // An append resumes the handle the conversation currently sits on…
    expect((await store.resolve({ ref: "handled" })).providerSessionId).toBe("prov-1");
    // …and a resolve that BRANCHES gets none, because two branches sharing one remote session would
    // be two conversations writing into the same place.
    expect((await store.resolve({ ref: "handled", fork: true })).providerSessionId).toBeUndefined();
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
    await store.open({ id: "a1", source: undefined as never, session: at.at, startMs: 0 });
    await store.close("a1", {
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

  it("scopes records to the run that wrote them, so a transcript is findable from a task", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t9", runId: 2 }) as unknown as Store;
    await store.open({ id: "s1", source: undefined as never, session: { id: "scoped", seq: 0 }, startMs: 0 });

    const row = db.prepare(`SELECT task_id, run_id FROM operation_records WHERE record_id = 's1'`).get() as {
      task_id: string;
      run_id: number;
    };
    expect(row).toEqual({ task_id: "t9", run_id: 2 });
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
      `INSERT INTO events (task_id, run_id, type, payload_json, created_at) VALUES ('t', 1, 'operation.completed', ?, 1)`,
    ).run(JSON.stringify({ type: "operation.completed", instanceId: 1, stateId: "s", op: "prompt" }));
    db.prepare(
      `INSERT INTO events (task_id, run_id, type, payload_json, created_at) VALUES ('t', 1, 'operation.completed', ?, 2)`,
    ).run(JSON.stringify({ type: "operation.completed", instanceId: 2, stateId: "s2", op: "prompt", metrics: { sessionRef: "review@3" } }));

    const refs = db.prepare(`SELECT session_ref FROM events ORDER BY seq`).all() as Array<{ session_ref: string | null }>;
    expect(refs.map((r) => r.session_ref)).toEqual([null, "review@3"]);
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
      `INSERT INTO events (task_id, run_id, type, payload_json, created_at) VALUES ('t1', 1, ?, ?, ?)`,
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
      { runId: 1, instanceId: 2, stateId: "wf/first", sessionId: "chat", seq: 0, at: 10 },
      { runId: 1, instanceId: 4, stateId: "wf/second", sessionId: "chat", seq: 1, at: 12 },
    ]);
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
          AND id NOT IN (SELECT DISTINCT session_id FROM operation_records)
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
          AND id NOT IN (SELECT DISTINCT session_id FROM operation_records)
          AND id NOT IN (SELECT parent FROM sessions WHERE parent IS NOT NULL)`,
    );
    drop.run(100);
    // Younger than the cutoff means it belongs to work that is still going on.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'fresh'`).get()).toEqual({ n: 1 });
  });
});
