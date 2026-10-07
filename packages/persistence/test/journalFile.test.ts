/**
 * The journal as files — the write half of DESIGN §4.4, for the first concern to get one.
 *
 * The claim under test is the inversion the whole design rests on: **the file is the truth and the
 * table is an index replayed from it.** So the test that matters is the round trip — write through
 * the ordinary recorder, close the connection, open again, and find the history there because the
 * file had it, not because the database did. Everything else here is a way that round trip can be
 * quietly wrong: a merge conflict marker in the middle of a file, a process killed mid-append, a
 * concern switched on for the first time with its history still in the database.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { journalFileFor, readJournalFile } from "../src/journalFile";
import { createTask } from "../src/lifecycle";

let dir: string;
let baseDir: string;
const open: Project[] = [];

const track = (project: Project): Project => {
  open.push(project);
  return project;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-journal-"));
  baseDir = join(dir, "base");
  mkdirSync(join(dir, "repo"), { recursive: true });
  initProject(join(dir, "repo"), testHome());
});

afterEach(() => {
  for (const project of open.splice(0)) project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Where a project keeps its journal files. */
const journalDir = (): string => join(dir, "repo", ".jaira", "system", "journal");

/** A project whose journal is where the caller says. */
function project(journal: "file" | "db"): Project {
  writeFileSync(
    join(dir, "repo", ".jaira", "settings.json"),
    JSON.stringify({ storage: { journal } }),
    "utf8",
  );
  return track(openProject(join(dir, "repo"), { baseDir }));
}

const event = (type: string, instanceId?: string): EngineEvent =>
  ({ type, ...(instanceId !== undefined ? { instanceId } : {}) }) as EngineEvent;

/** One task's worth of events, through the ordinary `Persistence` port the engine calls. */
function record(p: Project, taskId: string, types: string[]): void {
  const recorder = p.events.recorder(taskId);
  types.forEach((type, i) => recorder.record(event(type, String(i + 1)), 1_000 + i));
}

describe("the round trip — the file is the truth", () => {
  it("survives the database being thrown away, which is what 'truth' means", () => {
    const first = project("file");
    createTask(first, { id: "t-1", title: "one", workflow: "w" });
    record(first, "t-1", ["instance.entered", "operation.started", "operation.completed"]);
    first.close();
    open.pop();

    // The whole database, deleted. Nothing but the files is left.
    rmSync(join(baseDir, "system", "jaira.db"), { force: true });
    rmSync(join(baseDir, "system", "jaira.db-wal"), { force: true });
    rmSync(join(baseDir, "system", "jaira.db-shm"), { force: true });

    const second = project("file");
    expect(second.events.list("t-1").map((e) => e.type)).toEqual([
      "instance.entered",
      "operation.started",
      "operation.completed",
    ]);
    // Read back whole, not merely counted: the event, its instance, and the time it happened.
    expect(second.events.list("t-1")[1]).toMatchObject({ instanceId: "2", createdAt: 1_001 });
  });

  it("writes one file per task, which is what makes two people's appends not conflict", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    createTask(p, { id: "t-2", title: "two", workflow: "w" });
    record(p, "t-1", ["a"]);
    record(p, "t-2", ["b"]);

    const journal = join(dir, "repo", ".jaira", "system", "journal");
    expect(existsSync(journalFileFor(journal, "t-1"))).toBe(true);
    expect(existsSync(journalFileFor(journal, "t-2"))).toBe(true);
    // One JSON object per line, and legible — a person who greps a Claude session file can grep this.
    const line = JSON.parse(readFileSync(journalFileFor(journal, "t-1"), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: "a", taskId: "t-1", timestamp: "1970-01-01T00:00:01.000Z" });
    // NOT `seq`: it is assigned by whichever database holds the rows, and a file outlives databases.
    expect(line).not.toHaveProperty("seq");
  });

  it("writes nothing to disk when the journal is a table, which is the default", () => {
    const p = project("db");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", ["a"]);

    expect(existsSync(join(dir, "repo", ".jaira", "system", "journal"))).toBe(false);
    expect(p.events.list("t-1")).toHaveLength(1);
  });
});

describe("switching a concern on", () => {
  it("starts its files from the database, so they hold the history the database does", () => {
    // A project that has been running with `journal: db` has its history in the database and no
    // files at all; the first open after the change writes them (decision 0018 §11).
    const before = project("db");
    createTask(before, { id: "t-1", title: "one", workflow: "w" });
    record(before, "t-1", ["a", "b"]);
    before.close();
    open.pop();

    const after = project("file");
    expect(after.storage.exported).toEqual({ journal: 2 });
    expect(readJournalFile(journalFileFor(journalDir(), "t-1")).map((l) => l.type)).toEqual(["a", "b"]);
    expect(after.events.list("t-1").map((e) => e.type)).toEqual(["a", "b"]);
  });
});

describe("the database is the truth while JaiRA runs", () => {
  it("reads nothing from files as JaiRA left them, and what they say when they moved since", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", ["written"]);
    p.close();
    open.pop();

    // A row the files do not have: the database is the truth, so it stands while the files are as left.
    const kept = project("file");
    expect(kept.storage.current).toEqual(["journal"]);
    kept.db.prepare(`INSERT INTO state_machine_events (task_id, type, payload_json, created_at) VALUES ('t-1', 'only-in-the-database', '{}', 2)`).run();
    kept.close();
    open.pop();
    const still = project("file");
    expect(still.storage.current).toEqual(["journal"]);
    expect(still.events.list("t-1").map((e) => e.type)).toEqual(["written", "only-in-the-database"]);
    still.close();
    open.pop();

    // A pull moved the file: what it says of its task is brought in, in place of the task's rows.
    appendFileSync(journalFileFor(journalDir(), "t-1"), JSON.stringify({ type: "pulled", timestamp: "2026-01-01T00:00:00.000Z", taskId: "t-1", event: { type: "pulled" } }) + "\n", "utf8");
    const pulled = project("file");
    expect(pulled.storage.imported).toEqual({ journal: 2 });
    expect(pulled.events.list("t-1").map((e) => e.type)).toEqual(["written", "pulled"]);
  });

  it("reads in at the next open a pull that landed while JaiRA ran — the close does not take it as its own", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", ["mine"]);
    // A pull, mid-session, and JaiRA writing on after it: the file is no longer only what JaiRA wrote.
    appendFileSync(journalFileFor(journalDir(), "t-1"), JSON.stringify({ type: "pulled", timestamp: "2026-01-01T00:00:00.000Z", taskId: "t-1", event: { type: "pulled" } }) + "\n", "utf8");
    record(p, "t-1", ["mine-after"]);
    p.close();
    open.pop();

    const next = project("file");
    expect(next.storage.imported).toEqual({ journal: 3 });
    expect(next.events.list("t-1").map((e) => e.type)).toEqual(["mine", "pulled", "mine-after"]);
  });

  it("writes its files afresh when put in them again, after a spell in the database alone", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", ["while-filed"]);
    p.close();
    open.pop();

    const alone = project("db");
    record(alone, "t-1", ["while-alone"]);
    alone.close();
    open.pop();

    // The files stood still and say nothing of what came after: they are written from the database.
    const again = project("file");
    expect(again.storage.exported).toEqual({ journal: 2 });
    expect(readJournalFile(journalFileFor(journalDir(), "t-1")).map((l) => l.type)).toEqual(["while-filed", "while-alone"]);
    expect(again.events.list("t-1").map((e) => e.type)).toEqual(["while-filed", "while-alone"]);
  });
});

describe("what a file can arrive looking like", () => {
  it("drops a line it cannot parse and keeps the rest — a merge left one in the middle", () => {
    // Two appends to one run, merged badly. Refusing to open would make one unmergeable line cost
    // the whole history; dropping it costs one event and leaves everything either side readable.
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", ["before", "after"]);
    p.close();
    open.pop();

    const file = journalFileFor(join(dir, "repo", ".jaira", "system", "journal"), "t-1");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, [lines[0], "<<<<<<< HEAD", lines[1], '{"type":"truncated"'].join("\n") + "\n", "utf8");

    expect(readJournalFile(file).map((l) => l.type)).toEqual(["before", "after"]);
    expect(project("file").events.list("t-1").map((e) => e.type)).toEqual(["before", "after"]);
  });
});
