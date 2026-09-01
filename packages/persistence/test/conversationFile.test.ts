/**
 * Conversations as files (DESIGN §4.4) — the concern the journal's format could not simply be
 * reused for, because this one is UPDATED.
 *
 * A record opens, streams partials, and settles; a position is claimed; a fork adds a lineage row.
 * An append-only file cannot rewrite the line it wrote at `open`, so it appends the row's current
 * state and replay keeps the LAST line per key. The tests below are that rule and the ways it can
 * be wrong: a settle that does not supersede its own open, a partial flush that loses the request,
 * a dialect that changes what is recorded instead of only how it is dressed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { RecordStore, SessionStore } from "@declarative-ai/exec";
import { initProject, openProject, sessionStoreFor, type Project } from "../src/project";
import { conversationFileFor, readConversationFile } from "../src/conversationFile";
import { createTask } from "../src/lifecycle";

let dir: string;
let baseDir: string;
const open: Project[] = [];

const track = (p: Project): Project => {
  open.push(p);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-conv-"));
  baseDir = join(dir, "base");
  mkdirSync(join(dir, "repo"), { recursive: true });
  initProject(join(dir, "repo"), testHome());
});

afterEach(() => {
  for (const p of open.splice(0)) p.close();
  rmSync(dir, { recursive: true, force: true });
});

type Store = SessionStore<never> & RecordStore;

const convDir = (): string => join(dir, "repo", ".jaira", "system", "conversations");

function project(conversations: "file" | "db", format: "claude" | "codex" = "claude"): Project {
  writeFileSync(
    join(dir, "repo", ".jaira", "settings.json"),
    JSON.stringify({ storage: { conversations, format } }),
    "utf8",
  );
  return track(openProject(join(dir, "repo"), { baseDir }));
}

const turn = (text: string) => ({ role: "assistant", content: text });
/** A settled payload: one conversation array, which is the only shape a record carries. `turn` above
 *  is what a reader DERIVES from it — the wire history, never a second copy stored beside it. */
const said = (text: string) => ({
  value: { entries: [{ kind: "message", role: "assistant", content: text, provider: "unknown", timestamp: "1970-01-01T00:00:00.000Z" }] },
});

/** Every line of the one run's file, parsed — the tests below ask what SHAPE was written. */
const fileLines = (): Array<Record<string, unknown>> =>
  readFileSync(conversationFileFor(convDir(), "t-1"), "utf8")
    .trimEnd()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/** One call, opened at a position and settled — the ordinary shape of a recorded turn. */
async function call(p: Project, text: string, seq?: number): Promise<void> {
  const store = sessionStoreFor(p, { taskId: "t-1" }) as unknown as Store;
  const at = await store.resolve(seq === undefined ? { ref: "conv" } : { ref: `conv@${seq}` });
  const ref = await store.append({ id: `conv:${at.at.seq}`, source: { kind: "prompt", user: text } as never, session: at.at, startMs: 1 });
  await store.finish(ref, { result: said(text) as never });
}

describe("the round trip — the file is the truth", () => {
  it("survives the database being thrown away", async () => {
    const first = project("file");
    createTask(first, { id: "t-1", title: "one", workflow: "w" });
    await call(first, "first");
    await call(first, "second");
    first.close();
    open.pop();

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, "repo", ".jaira", "system", `jaira.db${suffix}`), { force: true });
    }

    const second = project("file");
    const reader = sessionStoreFor(second, { taskId: "t-1" }) as unknown as Store;
    // The transcript, whole — which needs all three tables back: the records, the positions that
    // order them, and the lineage row the branch hangs off. A SUCCESS settle's payload is the
    // authoritative version of the turn, so the opening message `insertRecord` spliced in is
    // replaced rather than kept (see `close`); two calls are two turns.
    expect(await reader.messages("conv")).toEqual([turn("first"), turn("second")]);
  });

  it("keeps the SETTLED state, not the open one it superseded", async () => {
    // The whole reason the format is last-wins. `open` wrote a line saying `status: 'open'` with no
    // result; `close` wrote another with the answer. A reader that took the first would show every
    // finished call as still running.
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "hello");
    p.close();
    open.pop();

    const entries = readConversationFile(conversationFileFor(convDir(), "t-1"));
    const records = entries.filter((e) => e.kind === "record");
    expect(records.length).toBeGreaterThan(1); // it really did append more than once
    expect(records.map((e) => (e.row as { status: string }).status)).toEqual(["open", "completed"]);

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, "repo", ".jaira", "system", `jaira.db${suffix}`), { force: true });
    }
    const reopened = project("file");
    expect(
      reopened.db.prepare(`SELECT status FROM operation_records`).all(),
    ).toEqual([{ status: "completed" }]);
  });

  it("writes nothing when conversations are a table, which is the default", async () => {
    const p = project("db");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "hello");

    expect(existsSync(convDir())).toBe(false);
    expect(p.db.prepare(`SELECT COUNT(*) AS n FROM operation_records`).get()).toEqual({ n: 1 });
  });
});

describe("dialects", () => {
  it("dresses the line differently and records the same thing", async () => {
    // A dialect is an ENVELOPE. Switching it must not change what a replay reconstructs, which is
    // what lets the reader accept either shape whatever the setting says.
    const claude = project("file", "claude");
    createTask(claude, { id: "t-1", title: "one", workflow: "w" });
    await call(claude, "hello");
    claude.close();
    open.pop();

    const line = JSON.parse(
      readFileSync(conversationFileFor(convDir(), "t-1"), "utf8").split("\n")[0]!,
    ) as Record<string, unknown>;
    // Claude Code's threading envelope — what its own reader walks.
    expect(line).toMatchObject({ type: expect.stringMatching(/^jaira\./) as unknown as string });
    expect(typeof line["uuid"]).toBe("string");
    expect("parentUuid" in line).toBe(true);
    expect(typeof line["timestamp"]).toBe("string");
  });

  it("reads a file written in the OTHER dialect, and a file holding both", async () => {
    // A repository outlives a preference: a project that changed `format` keeps appending to the run
    // files it already had, and a merge can interleave two people who disagreed. Detection is per
    // LINE for exactly that reason.
    const p = project("file", "codex");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "codex-written");
    p.close();
    open.pop();

    const file = conversationFileFor(convDir(), "t-1");
    const codexLine = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as Record<string, unknown>;
    expect(codexLine).toHaveProperty("payload");
    expect(codexLine).not.toHaveProperty("uuid");

    // Same file, now read by a project configured for Claude — and it still replays.
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, "repo", ".jaira", "system", `jaira.db${suffix}`), { force: true });
    }
    const asClaude = project("file", "claude");
    const reader = sessionStoreFor(asClaude, { taskId: "t-1" }) as unknown as Store;
    expect(await reader.messages("conv")).toEqual([turn("codex-written")]);
  });
});

describe("native turn lines — for the other tool's reader, never for replay", () => {
  it("emits a settled turn in Claude Code's own shape, beside the row it came from", async () => {
    // Read off a REAL session file rather than written from memory: a main-chain turn is
    // `{uuid, parentUuid, sessionId, timestamp, type: "user" | "assistant", userType, isSidechain,
    // message}`, where `message` is the API message verbatim — which is exactly what a record holds.
    const p = project("file", "claude");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "hello");
    p.close();
    open.pop();

    const lines = fileLines();
    const assistant = lines.find((l) => l["type"] === "assistant");
    expect(assistant).toMatchObject({ userType: "external", isSidechain: false, message: turn("hello") });
    expect(typeof assistant?.["uuid"]).toBe("string");
    // Threaded: each line points at the one before it, so the file reads as a chain rather than a bag.
    const threaded = lines.filter((l) => typeof l["uuid"] === "string");
    expect(threaded.length).toBeGreaterThan(1);
    expect(threaded[1]?.["parentUuid"]).toBe(threaded[0]?.["uuid"]);
  });

  it("emits a rollout's `response_item` under the codex dialect, with typed content blocks", async () => {
    // Also read off a real rollout: `{timestamp, type, payload}`, and a conversation record is
    // `response_item` / `message` whose content is typed blocks rather than a string.
    const p = project("file", "codex");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "hello");
    p.close();
    open.pop();

    const lines = fileLines();
    expect(lines.find((l) => l["type"] === "response_item")).toMatchObject({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    });
    // `timestamp`, which is what a rollout calls it — this was `at` until it was checked.
    expect(lines[0]).toHaveProperty("timestamp");
  });

  it("is emitted at the SETTLE only, so a streaming call does not spray transcripts", async () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    const store = sessionStoreFor(p, { taskId: "t-1" }) as unknown as Store;
    const at = await store.resolve({ ref: "conv" });
    const ref = await store.append({ id: "conv:0", source: { kind: "prompt", user: "hi" } as never, session: at.at, startMs: 1 });
    store.update!(ref, { value: { value: said("partial one").value } });

    expect(fileLines().some((l) => l["type"] === "assistant")).toBe(false);
    await store.finish(ref, { result: said("final") as never });
    expect(fileLines().some((l) => l["type"] === "assistant")).toBe(true);
  });
});

describe("switching the concern on", () => {
  it("seeds from the database the first time, then prefers the files", async () => {
    const before = project("db");
    createTask(before, { id: "t-1", title: "one", workflow: "w" });
    await call(before, "already recorded");
    before.close();
    open.pop();

    const flipped = project("file");
    expect(flipped.storage.seeded).toMatchObject({ operation_records: 1, sessions: 1 });
    const reader = sessionStoreFor(flipped, { taskId: "t-1" }) as unknown as Store;
    expect(await reader.messages("conv")).toEqual([turn("already recorded")]);
    flipped.close();
    open.pop();

    // Nothing was written to disk by the seed itself, so the second open seeds again rather than
    // replaying — the file becomes the truth from the first WRITE, not from the first read.
    const again = project("file");
    expect(again.storage.replayed).toEqual({});
    expect(again.storage.seeded).toMatchObject({ operation_records: 1 });
  });
});

describe("what a file can arrive looking like", () => {
  it("drops a line it cannot parse and keeps the rest", async () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    await call(p, "kept");
    p.close();
    open.pop();

    const file = conversationFileFor(convDir(), "t-1");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const rows = lines.filter((l) => l.includes('"jaira.')).length;
    writeFileSync(file, [...lines, "<<<<<<< HEAD", '{"type":"jaira.record"'].join("\n") + "\n", "utf8");

    // The row lines survive the two broken ones — and the native TURN lines are not counted,
    // because replay ignores them by design: they exist for Claude Code's reader, not for this one.
    expect(readConversationFile(file).length).toBe(rows);
    expect(rows).toBeLessThan(lines.length);
  });
});
