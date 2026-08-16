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
        VALUES ('t1/3/old', 0, 'r0', 't1', 3, '${JSON.stringify({ value: { messages: [{ role: "assistant", content: "kept" }] } }).replace(/'/g, "''")}', 'prov-9', 1, 2);
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
    const info = db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, status, started_at) VALUES (?, 't3', ?, ?, 5)`,
      )
      .run(recordId, runId, status);
    const cut = recordId.lastIndexOf(":");
    db.prepare(`INSERT INTO session_positions (session_id, seq, operation_record_id) VALUES (?, ?, ?)`).run(
      recordId.slice(0, cut),
      Number(recordId.slice(cut + 1)),
      info.lastInsertRowid,
    );
  };

  it("recovers the in-flight call from its own record, and says it was interrupted", () => {
    const runId = crashedRun();
    started(runId, 7, "wf/thinking", 20);
    record(runId, "chat:3");
    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 7, stateId: "wf/thinking", sessionId: "chat", seq: 3, at: 20, outcome: "interrupted" },
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
    record(runId, "chat:1", "completed"); // the settled one — excluded by status
    record(runId, "chat:2");
    expect(stateSessions({ db } as never, "t3")).toEqual([
      { runId, instanceId: 7, stateId: "wf/done", sessionId: "chat", seq: 0, at: 22, outcome: "success" },
      { runId, instanceId: 8, stateId: "wf/dying", sessionId: "chat", seq: 2, at: 23, outcome: "interrupted" },
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
  const partial = (texts: string[]) => ({ value: { messages: texts.map(turn) } }) as never;

  it("streams into the open row, visible with its status — and out of materialized history", async () => {
    const s = store();
    await append(s, "chat", "r1", "settled");
    const at = await s.resolve({ ref: "chat" });
    await s.open({ id: "r2", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("chat", at.at.seq, partial(["half", "written"]), "prov-3");
    // The provider handle lands EARLY — what makes an interrupted call resumable at all.
    expect(db.prepare(`SELECT provider_session_id FROM operation_records WHERE record_id = 'r2'`).get()).toEqual({
      provider_session_id: "prov-3",
    });

    // The knowing readers see it, labelled: the viewer's channel.
    const rows = s.transcript("chat");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: "open", value: { value: { messages: [turn("half"), turn("written")] } } });
    // History must not: a half-written turn replayed into a provider is a conversation that never
    // happened. Value presence would say yes here; the state field says no.
    expect(await s.messages("chat")).toEqual([turn("settled")]);
    expect((s.bySession("chat") as Array<{ result?: unknown }>)[1]!.result).toBeUndefined();
  });

  it("lets the settle replace the partial, and refuses a late flush after it", async () => {
    const s = store();
    const at = await s.resolve({ ref: "conv" });
    await s.open({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("conv", 0, partial(["early"]));
    await s.close("r1", { sessionOutcome: { messages: [turn("the whole answer")] } });
    // A debounce timer firing after the record settled matches no open row — the status guard.
    s.streamPartial("conv", 0, partial(["stale"]));

    expect(await s.messages("conv")).toEqual([turn("the whole answer")]);
    expect(s.transcript("conv")[0]).toMatchObject({ status: "completed" });
  });

  it("keeps the partial when an ERRORED settle brings nothing better", async () => {
    const s = store();
    const at = await s.resolve({ ref: "err" });
    await s.open({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("err", 0, partial(["what got said"]));
    // An agent's error settle: `{error, value:{finishReason}}` — no messages, no session outcome.
    await s.close("r1", { result: { error: { classification: "permanent", reason: "boom" }, value: { finishReason: "error" } } as never });

    // The turns really were exchanged; a failed record keeping them is how errored calls already
    // represent turns that "may exist remotely". They now count as history too — settled, not open.
    expect(s.transcript("err")[0]).toMatchObject({ status: "failed", value: { value: { messages: [turn("what got said")] } } });
    expect(await s.messages("err")).toEqual([turn("what got said")]);
  });

  it("lets an errored settle that DOES carry the conversation win over the partial", async () => {
    const s = store();
    const at = await s.resolve({ ref: "err2" });
    await s.open({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("err2", 0, partial(["early copy"]));
    await s.close("r1", {
      result: { error: { classification: "permanent", reason: "boom" } } as never,
      sessionOutcome: { messages: [turn("authoritative")] },
    });
    expect(await s.messages("err2")).toEqual([turn("authoritative")]);
  });

  it("writes nothing where no open row claims the position", () => {
    const s = store();
    expect(() => s.streamPartial("nowhere", 3, partial(["x"]))).not.toThrow();
    expect(s.transcript("nowhere")).toEqual([]);
  });

  /**
   * The clocks survive a SUCCESSFUL settle — the one field the settle cannot reproduce.
   *
   * A provider result carries no wall clock per message, so the per-turn times exist exactly once:
   * in the stream that measured them. Overwriting the row with the settled result used to drop them,
   * which is why a finished run's thinking rows had no "thought for 12 s" and a live one did.
   */
  const timed = (texts: string[], times: Array<Record<string, number>>) =>
    ({ value: { messages: texts.map(turn), messageTimes: times } }) as never;

  it("carries the streamed per-turn times onto a successful settle, aligned as a suffix", async () => {
    const s = store();
    const at = await s.resolve({ ref: "timed" });
    await s.open({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("timed", 0, timed(["thought about it", "answered"], [{ at: 200, thoughtMs: 90 }, { at: 300 }]));
    // The settle holds the message the call was made WITH as well, so the stamps line up with the
    // TAIL of its list — padded at the front, never shifted onto the wrong turn.
    await s.close("r1", {
      result: { value: { messages: [{ role: "user", content: "go" }, turn("thought about it"), turn("answered")] } } as never,
    });

    const row = s.transcript("timed")[0] as { value?: { value?: { messageTimes?: unknown; messages?: unknown[] } } };
    expect(row.value?.value?.messages).toHaveLength(3);
    expect(row.value?.value?.messageTimes).toEqual([{}, { at: 200, thoughtMs: 90 }, { at: 300 }]);
  });

  it("drops the times rather than mislabel a turn when the roles do not line up", async () => {
    const s = store();
    const at = await s.resolve({ ref: "askew" });
    await s.open({ id: "r1", source: undefined as never, session: at.at, startMs: 1 });
    s.streamPartial("askew", 0, timed(["one", "two"], [{ at: 1 }, { at: 2 }]));
    await s.close("r1", {
      result: { value: { messages: [turn("one"), { role: "user", content: "not two" }] } } as never,
    });
    const row = s.transcript("askew")[0] as { value?: { value?: { messageTimes?: unknown } } };
    expect(row.value?.value?.messageTimes).toBeUndefined();
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
    const info = db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, status, provider_session_id, result_json, started_at)
         VALUES ('s:0', 't1', 1, ?, ?, ?, 900)`,
      )
      .run(over.status ?? "failed", over.handle === undefined ? "prov-1" : over.handle, over.result ?? null);
    return Number(info.lastInsertRowid);
  };

  it("offers the handle and the start time — the cut that keeps a resumed session's earlier lines out", () => {
    crashed();
    expect(scoped().recoverable("t1")).toEqual([{ id: expect.any(Number), providerSessionId: "prov-1", startedAt: 900 }]);
  });

  it("passes over a row with no handle, a live row, and one already captured", () => {
    crashed({ handle: null }); // nothing to find the file with
    crashed({ status: "open" }); // still running — a live process owns it
    crashed({ result: JSON.stringify({ value: { nativeLines: [{ index: 0, line: {} }] } }) }); // done already
    expect(scoped().recoverable("t1")).toEqual([]);
  });

  it("folds a recovered capture into the payload, beside what the crash had already saved", () => {
    const id = crashed({ result: JSON.stringify({ value: { messages: [turn("streamed")] } }) });
    const s = scoped();
    s.foldNativeCapture(id, { nativeLines: [{ index: 0, line: { type: "attachment" } }] } as never);

    const row = db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(id) as { result_json: string };
    // The partial the flush saved survives; the fuller capture joins it where the reader looks.
    expect(JSON.parse(row.result_json)).toEqual({
      value: { messages: [turn("streamed")], nativeLines: [{ index: 0, line: { type: "attachment" } }] },
    });
    // …and it is no longer offered: a second open re-reads no files.
    expect(s.recoverable("t1")).toEqual([]);
  });

  it("leaves a payload it cannot honestly extend alone", () => {
    // A scripted value or a bare string has nowhere to put lines — wrapping it in a shape nothing
    // reads would corrupt the record to add an annotation.
    const id = crashed({ result: JSON.stringify({ value: "just text" }) });
    scoped().foldNativeCapture(id, { nativeLines: [{ index: 0, line: {} }] } as never);
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
