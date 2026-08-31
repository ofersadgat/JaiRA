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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A project whose journal is where the caller says. */
function project(journal: "file" | "db" | "both"): Project {
  writeFileSync(
    join(dir, "repo", ".jaira", "settings.json"),
    JSON.stringify({ storage: { journal } }),
    "utf8",
  );
  return track(openProject(join(dir, "repo"), { baseDir }));
}

const event = (type: string, instanceId?: string): EngineEvent =>
  ({ type, ...(instanceId !== undefined ? { instanceId } : {}) }) as EngineEvent;

/**
 * One run's worth of events, through the ordinary `Persistence` port the engine calls.
 *
 * The `runs` row is inserted first because `state_machine_events.run_id` references it — and only in
 * the DATABASE, since a shadow drops foreign keys (a temp child cannot resolve a main parent). The
 * asymmetry is real and worth writing into the helper rather than discovering per test: a file-backed
 * journal accepts a row the table-backed one refuses.
 */
function record(p: Project, taskId: string, runId: number, types: string[]): void {
  p.db
    .prepare(`INSERT OR IGNORE INTO main.runs (id, task_id, snapshot_hash, started_at) VALUES (?, ?, 'h', 1)`)
    .run(runId, taskId);
  const recorder = p.events.recorder(taskId, runId);
  types.forEach((type, i) => recorder.record(event(type, String(i + 1)), 1_000 + i));
}

describe("the round trip — the file is the truth", () => {
  it("survives the database being thrown away, which is what 'truth' means", () => {
    const first = project("file");
    createTask(first, { id: "t-1", title: "one", workflow: "w" });
    record(first, "t-1", 1, ["instance.entered", "operation.started", "operation.completed"]);
    first.close();
    open.pop();

    // The whole database, deleted. Nothing but the files is left.
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db"), { force: true });
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db-wal"), { force: true });
    rmSync(join(dir, "repo", ".jaira", "system", "jaira.db-shm"), { force: true });

    const second = project("file");
    expect(second.events.list("t-1").map((e) => e.type)).toEqual([
      "instance.entered",
      "operation.started",
      "operation.completed",
    ]);
    // Read back whole, not merely counted: the event, its instance, and the time it happened.
    expect(second.events.list("t-1")[1]).toMatchObject({ runId: 1, instanceId: "2", createdAt: 1_001 });
  });

  it("writes one file per run, which is what makes two people's appends not conflict", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", 1, ["a"]);
    record(p, "t-1", 2, ["b"]);

    const journal = join(dir, "repo", ".jaira", "system", "journal");
    expect(existsSync(journalFileFor(journal, "t-1", 1))).toBe(true);
    expect(existsSync(journalFileFor(journal, "t-1", 2))).toBe(true);
    // One JSON object per line, and legible — a person who greps a Claude session file can grep this.
    const line = JSON.parse(readFileSync(journalFileFor(journal, "t-1", 1), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: "a", taskId: "t-1", runId: 1, timestamp: "1970-01-01T00:00:01.000Z" });
    // NOT `seq`: it is assigned by whichever database holds the rows, and a file outlives databases.
    expect(line).not.toHaveProperty("seq");
  });

  it("writes nothing to disk when the journal is a table, which is the default", () => {
    const p = project("db");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", 1, ["a"]);

    expect(existsSync(join(dir, "repo", ".jaira", "system", "journal"))).toBe(false);
    expect(p.events.list("t-1")).toHaveLength(1);
  });
});

describe("switching a concern on", () => {
  it("seeds from the database the first time, so the history does not read as deleted", () => {
    // The flip path. A project that has been running with `journal: db` has its history in the
    // database and no files at all; the first open after the change has to start from those rows.
    const before = project("db");
    createTask(before, { id: "t-1", title: "one", workflow: "w" });
    record(before, "t-1", 1, ["a", "b"]);
    before.close();
    open.pop();

    const after = project("file");
    expect(after.storage.shadowed).toEqual(["state_machine_events"]);
    expect(after.storage.seeded).toEqual({ state_machine_events: 2 });
    expect(after.events.list("t-1").map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("prefers the files once there are any, because that is what truth means", () => {
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", 1, ["from-the-file"]);
    p.close();
    open.pop();

    // A row only `main` has — the state a flip leaves behind, and exactly what must NOT win.
    const stale = project("file");
    stale.db
      .prepare(
        `INSERT INTO main.state_machine_events (task_id, run_id, type, payload_json, created_at)
         VALUES ('t-1', 1, 'from-the-database', '{}', 1)`,
      )
      .run();
    stale.close();
    open.pop();

    const reopened = project("file");
    expect(reopened.storage.replayed).toEqual({ journal: 1 });
    expect(reopened.storage.seeded).toEqual({});
    expect(reopened.events.list("t-1").map((e) => e.type)).toEqual(["from-the-file"]);
  });
});

describe("what a file can arrive looking like", () => {
  it("drops a line it cannot parse and keeps the rest — a merge left one in the middle", () => {
    // Two appends to one run, merged badly. Refusing to open would make one unmergeable line cost
    // the whole history; dropping it costs one event and leaves everything either side readable.
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", 1, ["before", "after"]);
    p.close();
    open.pop();

    const file = journalFileFor(join(dir, "repo", ".jaira", "system", "journal"), "t-1", 1);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, [lines[0], "<<<<<<< HEAD", lines[1], '{"type":"truncated"'].join("\n") + "\n", "utf8");

    expect(readJournalFile(file).map((l) => l.type)).toEqual(["before", "after"]);
    expect(project("file").events.list("t-1").map((e) => e.type)).toEqual(["before", "after"]);
  });

  it("orders a task's runs by run, so a re-minted seq still means something", () => {
    // `seq` is not in the file, so replay re-mints it. Files are read task then run, which keeps a
    // run's own events in sequence and runs of one task in the order they happened.
    const p = project("file");
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    record(p, "t-1", 2, ["second-run"]);
    record(p, "t-1", 1, ["first-run"]);
    p.close();
    open.pop();

    expect(project("file").events.list("t-1").map((e) => e.type)).toEqual(["first-run", "second-run"]);
  });
});
