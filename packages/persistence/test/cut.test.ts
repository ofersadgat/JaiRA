/**
 * A cut in a task's journal — rewind and fork (see `cut.ts`).
 *
 * Three layers, each claimed on its own. The PARTITION is pure and decides both verbs, so it is
 * pinned first: what a cut keeps of an instance that was already running, and what it takes of the
 * machine's motion past the point. The STORE's cut is the conversation half — rows go, branches go
 * with them, and the remote is offered as a copy cut at the last kept message rather than as a
 * resume target. Then the two verbs over a real, file-backed project: a rewind that survives a
 * reopen because the file says what is gone, and a fork whose copy shares no id with its parent and
 * outlives the parent's deletion.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { forkTask, partitionAt, rewindTask } from "../src/cut";
import type { StoredEvent } from "../src/eventLog";
import { journalFileFor, readJournalFile } from "../src/journalFile";
import { createTask, deleteTask } from "../src/lifecycle";
import { initProject, openProject, sessionStoreFor, type Project } from "../src/project";
import { SqliteSessionStore } from "../src/sessionStore";
import { openDb, type JairaDb } from "../src/db";

// --- the partition ---------------------------------------------------------------------------

const stored = (seq: number, type: string, instanceId?: string, extra: Record<string, unknown> = {}): StoredEvent =>
  ({
    seq,
    taskId: "t",
    ...(instanceId !== undefined ? { instanceId } : {}),
    type: type as EngineEvent["type"],
    event: { type, ...(instanceId !== undefined ? { instanceId } : {}), ...extra } as unknown as EngineEvent,
    createdAt: seq,
    ...(typeof extra["operationId"] === "string" ? { operationId: extra["operationId"] } : {}),
  }) as StoredEvent;

/** root → plan (a call) → transition → review (a question, answered) → transition → implement. */
function journal(): StoredEvent[] {
  return [
    stored(1, "instance.entered", "root"),
    stored(2, "instance.entered", "plan", { parentInstanceId: "root", childKey: "plan" }),
    stored(3, "operation.started", "plan"),
    stored(4, "operation.dispatched", "plan", { operationId: "r-plan" }),
    stored(5, "operation.completed", "plan", { operationId: "r-plan" }),
    stored(6, "instance.terminated", "plan", { outcome: "success" }),
    stored(7, "transition.taken", "root", { to: "review" }),
    stored(8, "instance.entered", "review", { parentInstanceId: "root", childKey: "review" }),
    stored(9, "operation.started", "review"),
    stored(10, "operation.dispatched", "review", { operationId: "r-review" }),
    stored(11, "operation.completed", "review", { operationId: "r-review" }),
    stored(12, "instance.terminated", "review", { outcome: "success" }),
    stored(13, "transition.taken", "root", { to: "implement" }),
    stored(14, "instance.entered", "implement", { parentInstanceId: "root", childKey: "implement" }),
    stored(15, "operation.started", "implement"),
    stored(16, "operation.dispatched", "implement", { operationId: "r-implement" }),
    stored(17, "operation.completed", "implement", { operationId: "r-implement" }),
    stored(18, "instance.terminated", "implement", { outcome: "success" }),
    stored(19, "instance.terminated", "root", { outcome: "success" }),
  ];
}

describe("what a cut keeps", () => {
  it("at a state's entry: the state and everything after it go, the parent's motion past it goes too", () => {
    const part = partitionAt(journal(), 8);
    expect(part.kept.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...part.doomed].sort()).toEqual(["implement", "review"]);
    expect([...part.droppedRecords].sort()).toEqual(["r-implement", "r-review"]);
  });

  it("at a transition: the rule is what goes, the state that took it stays entered", () => {
    const part = partitionAt(journal(), 7);
    expect(part.kept.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // The root's own end is past the cut and goes with it: it ended because of what came after.
    expect(part.dropped.some((e) => e.seq === 19)).toBe(true);
    expect(part.doomed.has("root")).toBe(false);
  });

  it("keeps the settle of a call that was already running when the cut landed", () => {
    // A sibling entered before the cut, whose call finished after it.
    const events = [
      stored(1, "instance.entered", "root"),
      stored(2, "instance.entered", "a", { parentInstanceId: "root" }),
      stored(3, "operation.started", "a"),
      stored(4, "instance.entered", "b", { parentInstanceId: "root" }),
      stored(5, "operation.started", "b"),
      stored(6, "operation.dispatched", "a", { operationId: "r-a" }),
      stored(7, "operation.completed", "a", { operationId: "r-a" }),
      stored(8, "instance.terminated", "a", { outcome: "success" }),
      stored(9, "operation.dispatched", "b", { operationId: "r-b" }),
      stored(10, "operation.completed", "b", { operationId: "r-b" }),
    ];
    const part = partitionAt(events, 4);
    expect(part.kept.map((e) => e.seq)).toEqual([1, 2, 3, 6, 7, 8]);
    expect([...part.droppedRecords]).toEqual(["r-b"]);
  });

  it("cuts a chat thread at a turn: the turns before stay, the turn and everything typed after go", () => {
    // One chat instance, entered once, then one transition per message.
    const events = [
      stored(1, "instance.entered", "host"),
      stored(2, "operation.started", "host"),
      stored(3, "operation.completed", "host", { operationId: "r-host" }),
      stored(4, "instance.entered", "chat:host"),
      stored(5, "operation.started", "chat:host"),
      stored(6, "operation.completed", "chat:host", { operationId: "r-m0" }),
      stored(7, "instance.terminated", "chat:host", { outcome: "success" }),
      stored(8, "transition.taken", "chat:host", { index: 1 }),
      stored(9, "operation.started", "chat:host"),
      stored(10, "operation.completed", "chat:host", { operationId: "r-m1" }),
      stored(11, "instance.terminated", "chat:host", { outcome: "success" }),
      stored(12, "transition.taken", "chat:host", { index: 2 }),
      stored(13, "operation.started", "chat:host"),
      stored(14, "operation.completed", "chat:host", { operationId: "r-m2" }),
    ];
    const part = partitionAt(events, 8);
    expect(part.kept.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([...part.droppedRecords].sort()).toEqual(["r-m1", "r-m2"]);
  });
});

// --- the store's cut -------------------------------------------------------------------------

let dbDir: string;
let db: JairaDb;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "jaira-cut-db-"));
  db = openDb(join(dbDir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

/** One settled turn: a seat, a handle, and entries stamped with the provider's own message ids. */
async function turn(store: SqliteSessionStore, id: string, session: string, seq: number, uuid: string, handle = "h1"): Promise<void> {
  const ref = await store.append({ id, source: { kind: "prompt", text: id } as never, scope: { instanceId: "i", sequence: seq + 1 }, session: { id: session, seq }, startMs: seq });
  await store.finish(ref, {
    result: { value: { entries: [{ kind: "message", role: "assistant", content: id, uuid }] } } as never,
    sessionOutcome: { providerSessionId: handle, provider: "claude-cli" } as never,
  });
}

describe("cutting a conversation", () => {
  it("deletes the tail, and offers the remote as a copy cut at the last kept message", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t" });
    const resolved = store.resolve({ ref: undefined as never, seed: "s" });
    const session = resolved.at.id;
    await turn(store, "r0", session, 0, "u0");
    await turn(store, "r1", session, 1, "u1");
    await turn(store, "r2", session, 2, "u2");
    expect(store.transcript(session).map((row) => row.recordId)).toEqual(["r0", "r1", "r2"]);

    expect(store.cutSession(session, 2).sort()).toEqual(["r2"]);
    expect(store.transcript(session).map((row) => row.recordId)).toEqual(["r0", "r1"]);

    // The next call claims seat 2 again — and must not RESUME a remote that still holds turn 2.
    const next = store.resolve({ ref: session });
    expect(next.at.seq).toBe(2);
    expect(next.providerSessionId).toBeUndefined();
    expect(next.forkFrom).toEqual({ handle: "h1", provider: "claude-cli", at: "u1" });

    // The copy's own handle, reported at head, is the conversation's remote from here on.
    await turn(store, "r2b", session, 2, "u2b", "h2");
    const after = store.resolve({ ref: session });
    expect(after.providerSessionId).toBe("h2");
    expect(after.forkFrom).toBeUndefined();
    expect(store.transcript(session).map((row) => row.recordId)).toEqual(["r0", "r1", "r2b"]);
  });

  it("takes every branch that left the tail with it, and leaves branches above the cut alone", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t" });
    const session = store.resolve({ ref: undefined as never, seed: "s" }).at.id;
    await turn(store, "r0", session, 0, "u0");
    await turn(store, "r1", session, 1, "u1");
    await turn(store, "r2", session, 2, "u2");
    // An edit at 1 (above the cut) and an edit at 2 (at the cut).
    // `fork` answers a POSITION; the branch's own id is the part before the last `@`.
    const idOf = (ref: string): string => ref.slice(0, ref.lastIndexOf("@"));
    const above = idOf(store.fork(`${session}@1`, "above"));
    await turn(store, "r1e", above, 1, "u1e");
    const below = idOf(store.fork(`${session}@2`, "below"));
    await turn(store, "r2e", below, 2, "u2e");

    expect(store.cutSession(session, 2).sort()).toEqual(["r2", "r2e"]);
    expect(store.transcript(above).map((row) => row.recordId)).toEqual(["r0", "r1e"]);
    expect(store.lineageOf(below)).toBeUndefined();
  });

  it("drops the handle when the kept rows carry no message id to cut at", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t" });
    const session = store.resolve({ ref: undefined as never, seed: "s" }).at.id;
    const ref = await store.append({ id: "r0", source: { kind: "prompt", text: "r0" } as never, session: { id: session, seq: 0 }, startMs: 0 });
    await store.finish(ref, { sessionOutcome: { providerSessionId: "h1", provider: "claude-cli", messages: [{ role: "assistant", content: "x" }] } as never });
    await turn(store, "r1", session, 1, "u1");
    store.cutSession(session, 1);
    const next = store.resolve({ ref: session });
    expect(next.providerSessionId).toBeUndefined();
    expect(next.forkFrom).toBeUndefined();
    expect((await next.messages()).length).toBe(1);
  });
});

// --- the verbs, over a project -----------------------------------------------------------------

let dir: string;
let baseDir: string;
const open: Project[] = [];

const track = (p: Project): Project => {
  open.push(p);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-cut-"));
  baseDir = join(dir, "base");
  mkdirSync(join(dir, "repo"), { recursive: true });
  initProject(join(dir, "repo"), testHome());
  writeFileSync(
    join(dir, "repo", ".jaira", "settings.json"),
    JSON.stringify({ storage: { journal: "file", conversations: "file" } }),
    "utf8",
  );
});

afterEach(() => {
  for (const p of open.splice(0)) p.close();
  rmSync(dir, { recursive: true, force: true });
});

const project = (): Project => track(openProject(join(dir, "repo"), { baseDir }));

/** A finished run: root → plan (spoke, seat 0) → review (spoke, seat 1) — one session, two records. */
async function ran(p: Project, taskId: string): Promise<{ session: string; seqs: number[] }> {
  createTask(p, { id: taskId, title: "cut me", workflow: "w" });
  p.runtime.beginTask(taskId, "snap", 1_000);
  const store = sessionStoreFor(p, { taskId });
  const session = store.resolve({ ref: undefined as never, seed: "#iroot" }).at.id;
  const recorder = p.events.recorder(taskId);
  const ev = (event: Record<string, unknown>, at: number): void => recorder.record(event as unknown as EngineEvent, at);
  ev({ type: "instance.entered", instanceId: "root", stateId: "w", inputs: {} }, 1_001);
  ev({ type: "instance.entered", instanceId: "plan", stateId: "w/plan", parentInstanceId: "root", childKey: "plan", inputs: {} }, 1_002);
  ev({ type: "operation.started", instanceId: "plan", stateId: "w/plan", op: "prompt" }, 1_003);
  await turn(store, "r-plan", session, 0, "u-plan");
  ev({ type: "operation.dispatched", instanceId: "plan", stateId: "w/plan", op: "prompt", operationId: "r-plan" }, 1_004);
  ev({ type: "operation.completed", instanceId: "plan", stateId: "w/plan", op: "prompt", metrics: { durationMs: 1, sessionRef: `${session}@1` }, operationId: "r-plan" }, 1_005);
  ev({ type: "instance.terminated", instanceId: "plan", stateId: "w/plan", outcome: "success" }, 1_006);
  ev({ type: "transition.taken", instanceId: "root", stateId: "w", to: "review", index: 1, iteration: 0 }, 1_007);
  ev({ type: "instance.entered", instanceId: "review", stateId: "w/review", parentInstanceId: "root", childKey: "review", inputs: {} }, 1_008);
  ev({ type: "operation.started", instanceId: "review", stateId: "w/review", op: "prompt" }, 1_009);
  await turn(store, "r-review", session, 1, "u-review");
  ev({ type: "operation.dispatched", instanceId: "review", stateId: "w/review", op: "prompt", operationId: "r-review" }, 1_010);
  ev({ type: "operation.completed", instanceId: "review", stateId: "w/review", op: "prompt", metrics: { durationMs: 1, sessionRef: `${session}@2` }, operationId: "r-review" }, 1_011);
  ev({ type: "instance.terminated", instanceId: "review", stateId: "w/review", outcome: "success" }, 1_012);
  ev({ type: "instance.terminated", instanceId: "root", stateId: "w", outcome: "success" }, 1_013);
  p.runtime.endTask(taskId, "success", 1_014);
  p.runtime.setStatus(taskId, "completed", 1_014);
  return { session, seqs: p.events.list(taskId).map((e) => e.seq) };
}

describe("rewind", () => {
  it("deletes everything from the state's entry on, in the table, the store and the file", async () => {
    const p = project();
    const { session, seqs } = await ran(p, "t-1");
    const entered = p.events.list("t-1").find((e) => e.type === "instance.entered" && e.instanceId === "review")!;

    const result = rewindTask(p, "t-1", entered.seq, 2_000);
    expect(result).toEqual({ taskId: "t-1", events: 6, records: 1 });
    expect(p.events.list("t-1").map((e) => e.type)).toEqual([
      "instance.entered",
      "instance.entered",
      "operation.started",
      "operation.dispatched",
      "operation.completed",
      "instance.terminated",
      "transition.taken",
    ]);
    const store = sessionStoreFor(p, { taskId: "t-1" });
    expect(store.transcript(session).map((row) => row.recordId)).toEqual(["r-plan"]);
    // The next call at seat 1 copies the remote cut at plan's last message rather than resuming it.
    const next = store.resolve({ ref: session });
    expect(next.at.seq).toBe(1);
    expect(next.forkFrom).toMatchObject({ handle: "h1", at: "u-plan" });
    // Startable again, and honestly so.
    expect(p.runtime.get("t-1")?.status).toBe("interrupted");

    // The file says so: one more line, naming the ordinals of what is gone.
    const lines = readJournalFile(journalFileFor(p.paths.journalDir, "t-1"));
    expect(lines.length).toBe(seqs.length + 1);
    expect(lines.at(-1)?.type).toBe("jaira.rewound");
  });

  it("survives a reopen — the file, replayed, holds what the table held", async () => {
    const first = project();
    const { session } = await ran(first, "t-1");
    const entered = first.events.list("t-1").find((e) => e.type === "instance.entered" && e.instanceId === "review")!;
    rewindTask(first, "t-1", entered.seq, 2_000);
    const before = first.events.list("t-1").map((e) => e.type);
    first.close();
    open.pop();
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db"), { force: true });
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db-wal"), { force: true });
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db-shm"), { force: true });

    const second = project();
    expect(second.events.list("t-1").map((e) => e.type)).toEqual(before);
    const store = sessionStoreFor(second, { taskId: "t-1" });
    expect(store.transcript(session).map((row) => row.recordId)).toEqual(["r-plan"]);
    expect(store.resolve({ ref: session }).forkFrom).toMatchObject({ at: "u-plan" });
  });

  it("refuses a running task and a point the journal does not have", async () => {
    const p = project();
    const { seqs } = await ran(p, "t-1");
    expect(() => rewindTask(p, "t-1", seqs[seqs.length - 1]! + 1)).toThrow(/no journal event/);
    p.runtime.setStatus("t-1", "running", 3_000);
    expect(() => rewindTask(p, "t-1", seqs[1]!)).toThrow(/running/);
  });
});

describe("fork", () => {
  it("copies the kept prefix under new ids, and the copy outlives its parent", async () => {
    const p = project();
    const { session } = await ran(p, "t-1");
    const entered = p.events.list("t-1").find((e) => e.type === "instance.entered" && e.instanceId === "review")!;

    const fork = forkTask(p, "t-1", entered.seq, { standing: "startable", nowMs: 2_000 });
    expect(fork.taskId).not.toBe("t-1");
    const copied = p.events.list(fork.taskId);
    expect(copied.map((e) => e.type)).toEqual([
      "instance.entered",
      "instance.entered",
      "operation.started",
      "operation.dispatched",
      "operation.completed",
      "instance.terminated",
      "transition.taken",
    ]);
    // No id in common: instances re-minted, the record re-scoped, the session renamed.
    const parentIds = new Set(p.events.list("t-1").map((e) => e.instanceId));
    for (const e of copied) expect(parentIds.has(e.instanceId!)).toBe(false);
    const completed = copied.find((e) => e.type === "operation.completed")!;
    expect(completed.operationId).not.toBe("r-plan");
    const newSession = ((completed.event as { metrics?: { sessionRef?: string } }).metrics?.sessionRef ?? "").split("@")[0]!;
    expect(newSession).not.toBe(session);
    const store = sessionStoreFor(p, { taskId: fork.taskId });
    expect(store.transcript(newSession).map((row) => row.recordId)).toEqual([completed.operationId]);
    // The copy's remote is the parent's, cut where the copy's rows end — never resumed.
    const next = store.resolve({ ref: newSession });
    expect(next.providerSessionId).toBeUndefined();
    expect(next.forkFrom).toMatchObject({ handle: "h1", at: "u-plan" });
    // The task row knows where it came from, and stands ready for the resume.
    const row = p.runtime.get(fork.taskId)!;
    expect(row.parentTaskId).toBe("t-1");
    expect(row.forkedAtSeq).toBe(entered.seq);
    expect(row.forkBoundarySeq).toBe(copied.at(-1)!.seq);
    expect(row.snapshotHash).toBe("snap");
    expect(row.status).toBe("interrupted");
    expect(fork.instanceIds.get("root")).toBe(copied[0]!.instanceId);

    // The parent is untouched, and going away does not reach the copy.
    expect(p.events.list("t-1").length).toBe(13);
    expect(sessionStoreFor(p, { taskId: "t-1" }).transcript(session).length).toBe(2);
    deleteTask(p, "t-1");
    expect(p.events.list(fork.taskId).length).toBe(7);
    expect(store.transcript(newSession).length).toBe(1);
    expect(JSON.parse(readFileSync(join(p.paths.tasksDir, `${fork.taskId}.json`), "utf8")).parentTaskId).toBe("t-1");
  });

  it("stands as its parent does when asked to (a chat fork)", async () => {
    const p = project();
    const { seqs } = await ran(p, "t-1");
    const fork = forkTask(p, "t-1", seqs[7]!, { standing: "asIs", nowMs: 2_000 });
    expect(p.runtime.get(fork.taskId)?.status).toBe("completed");
  });
});
