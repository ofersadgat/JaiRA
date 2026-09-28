/**
 * One database for every workspace (decision 0013 §4): what each clone sees of it, what an open does
 * to the others, and the once-only merge of the database a clone used to keep.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { jairaPaths } from "@jaira/shared";
import { openDb } from "../src/db";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, openSharedProject, type Project } from "../src/project";
import { RuntimeStore } from "../src/runtime";
import { ownerOf } from "../src/workspace";

let root: string;
let home: string;
const open: Project[] = [];

function clone(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  initProject(dir, home);
  return dir;
}

function openAt(dir: string): Project {
  const project = openProject(dir, { baseDir: home });
  open.push(project);
  return project;
}

function close(project: Project): void {
  project.close();
  open.splice(open.indexOf(project), 1);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jaira-workspaces-"));
  home = testHome();
});

afterEach(() => {
  for (const project of open.splice(0)) project.close();
  rmSync(root, { recursive: true, force: true });
});

describe("one database, many workspaces", () => {
  it("keeps the database in the shared root, and nothing in the clone", () => {
    const a = openAt(clone("a"));
    expect(a.paths.dbFile).toBe(join(home, "system", "jaira.db"));
    expect(existsSync(join(a.paths.systemDir, "jaira.db"))).toBe(false);
    expect(a.workspace).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists, reads and acts on only the tasks its own workspace made", () => {
    const a = openAt(clone("a"));
    const b = openAt(clone("b"));
    const task = createTask(a, { title: "in a", workflow: "w" });
    createTask(b, { title: "in b", workflow: "w" });

    expect(a.runtime.list().map((r) => r.taskId)).toEqual([task.id]);
    expect(b.runtime.list().map((r) => r.taskId)).not.toContain(task.id);
    expect(b.runtime.get(task.id)).toBeUndefined();
    expect(ownerOf(a.db, task.id)).toBe(a.workspace);
    // A pulled task file names a task the other clone owns: it is not this one's to make again,
    // and the refusal leaves no file behind.
    expect(() => createTask(b, { id: task.id, title: "the same", workflow: "w" })).toThrow(/another workspace/);
    expect(b.tasks.tryRead(task.id)).toBeUndefined();
    expect(() => b.runtime.setStatus(task.id, "canceled", 5)).toThrow();
    expect(a.runtime.get(task.id)?.status).toBe("queued");
  });

  it("recovers only its own tasks when it opens", () => {
    const a = openAt(clone("a"));
    const task = createTask(a, { title: "running in a", workflow: "w" });
    a.runtime.setStatus(task.id, "running", 1);
    // Another workspace opening while a's run is live must not call it interrupted — nor settle
    // a turn a's conversation is still streaming.
    a.db
      .prepare(
        `INSERT INTO operation_records (id, task_id, request_json, status, started_at) VALUES ('r1', ?, '{}', 'open', 1)`,
      )
      .run(task.id);
    const b = openAt(clone("b"));
    expect(b.recovered).toEqual([]);
    expect(b.recoveredCalls).toEqual([]);
    expect(a.runtime.get(task.id)?.status).toBe("running");
    expect((a.db.prepare(`SELECT status FROM operation_records WHERE id = 'r1'`).get() as { status: string }).status).toBe("open");
  });

  it("keeps its history when the clone moves on disk", () => {
    const dir = clone("a");
    const a = openAt(dir);
    const task = createTask(a, { title: "made before the move", workflow: "w" });
    close(a);
    const moved = join(root, "moved");
    renameSync(dir, moved);
    const again = openAt(moved);
    expect(again.runtime.get(task.id)?.taskId).toBe(task.id);
  });
});

describe("a workspace whose records are files", () => {
  it("rebuilds its own index in the shared database and leaves every other workspace's alone", () => {
    const a = openAt(clone("a"));
    const inA = createTask(a, { title: "in a", workflow: "w" });
    a.events.recorder(inA.id).record({ type: "instance.entered", instanceId: "1" } as never, 1);

    const dir = clone("b");
    writeFileSync(join(dir, ".jaira", "settings.json"), JSON.stringify({ storage: { journal: "both" } }), "utf8");
    const b = openAt(dir);
    const inB = createTask(b, { title: "in b", workflow: "w" });
    b.events.recorder(inB.id).record({ type: "instance.entered", instanceId: "1" } as never, 2);
    close(b);
    // Reopened with its journal on disk: replayed, and written back as the persisted index.
    const again = openAt(dir);
    expect(again.storage.replayed).toEqual({ journal: 1 });
    expect(again.events.list(inB.id).map((e) => e.type)).toEqual(["instance.entered"]);
    expect(a.events.list(inA.id).map((e) => e.type)).toEqual(["instance.entered"]);
    const inMain = (id: string): number =>
      (a.db.prepare(`SELECT COUNT(*) AS n FROM main.state_machine_events WHERE task_id = ?`).get(id) as { n: number }).n;
    expect(inMain(inA.id)).toBe(1);
    expect(inMain(inB.id)).toBe(1);
  });
});
