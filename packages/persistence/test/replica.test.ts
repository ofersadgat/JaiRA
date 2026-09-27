/**
 * Replicas (decision 0013 §6): another machine's tasks copied into this one's database, laid over what
 * was held, and read like any workspace's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { jairaPaths } from "@jaira/shared";
import { dehydrate, hydrate } from "../src/blobStore";
import { openDb, type JairaDb } from "../src/db";
import { createTask } from "../src/lifecycle";
import { pruneHistory } from "../src/prune";
import { initProject, openProject, type Project } from "../src/project";
import { applyPage, exportChanges, missingBlobs, readBlobs, replicaKnown, type ReplicaDirs } from "../src/replica";

let root: string;
let owner: Project;
let here: JairaDb;
let hereHome: string;
const opened: Project[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jaira-replica-"));
  const ownerHome = join(root, "owner-home");
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  initProject(repo, ownerHome);
  owner = openProject(repo, { baseDir: ownerHome });
  hereHome = join(root, "here-home");
  mkdirSync(join(hereHome, "system"), { recursive: true });
  here = openDb(join(hereHome, "system", "jaira.db"));
});

afterEach(() => {
  for (const project of opened.splice(0)) project.close();
  owner.close();
  here.close();
  rmSync(root, { recursive: true, force: true });
});

/** The replica's directory, laid out as a workspace whose id is the owner's. */
function replicaDir(): { dir: string; dirs: ReplicaDirs } {
  const dir = join(hereHome, "remote", "m1", owner.workspace);
  const paths = jairaPaths(dir, hereHome);
  mkdirSync(paths.systemDir, { recursive: true });
  writeFileSync(paths.workspaceIdFile, `${owner.workspace}\n`);
  writeFileSync(paths.settingsFile, "{}\n");
  return { dir, dirs: { tasksDir: paths.tasksDir, snapshotsDir: paths.snapshotsDir } };
}

/** One exchange, as the replicator makes it: the page, then the blobs it lacks. */
function pull(): { changed: string[]; fetched: string[] } {
  const known = replicaKnown(here, owner.workspace);
  const page = exportChanges(owner, known);
  const missing = missingBlobs(here, page);
  return { changed: applyPage(here, page, readBlobs(owner.db, missing), replicaDir().dirs), fetched: missing };
}

function event(taskId: string, type: string): void {
  owner.events.recorder(taskId).record({ type, instanceId: "1" } as never, Date.now());
}

function record(taskId: string, id: string, text: string): void {
  const request = dehydrate(owner.db, { prompt: text } as JsonValue);
  owner.db
    .prepare(`INSERT INTO operation_records (id, task_id, request_json, status, started_at, ended_at) VALUES (?, ?, ?, 'ok', 1, 2)`)
    .run(id, taskId, JSON.stringify(request));
}

function readReplica(): Project {
  const project = openProject(replicaDir().dir, { baseDir: hereHome, replica: true });
  opened.push(project);
  return project;
}

describe("a replica of another machine's workspace", () => {
  it("copies its tasks, journals, records and the blobs they name, and reads them like a workspace", () => {
    const task = createTask(owner, { title: "remote work", workflow: "w" });
    event(task.id, "instance.entered");
    event(task.id, "operation.started");
    const big = "long file contents ".repeat(200);
    record(task.id, "r1", big);

    const first = pull();
    expect(first.changed).toEqual([task.id]);
    expect(first.fetched).toHaveLength(1);

    const replica = readReplica();
    expect(replica.runtime.list().map((r) => r.taskId)).toEqual([task.id]);
    expect(replica.tasks.tryRead(task.id)?.title).toBe("remote work");
    expect(replica.events.list(task.id).map((e) => e.type)).toEqual(["instance.entered", "operation.started"]);
    const stored = replica.db.prepare(`SELECT request_json FROM operation_records WHERE id = 'r1'`).get() as { request_json: string };
    expect(hydrate(replica.db, JSON.parse(stored.request_json) as JsonValue)).toEqual({ prompt: big });
    // Opened to be read: nothing on it is recovered.
    expect(replica.recovered).toEqual([]);

    // Nothing changed, nothing sent.
    expect(pull().changed).toEqual([]);
  });

  it("takes only the journal it lacks, and the whole of it again after a rewind", () => {
    const task = createTask(owner, { title: "t", workflow: "w" });
    event(task.id, "a");
    pull();
    event(task.id, "b");
    const page = exportChanges(owner, replicaKnown(here, owner.workspace));
    expect(page.tasks[0]).toMatchObject({ full: false });
    expect(page.tasks[0]!.events.map((e) => e["type"])).toEqual(["b"]);
    applyPage(here, page, {}, replicaDir().dirs);
    expect(readReplica().events.list(task.id).map((e) => e.type)).toEqual(["a", "b"]);

    // A rewind on the owner takes rows out from under what the replica holds.
    owner.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ? AND type = 'b'`).run(task.id);
    event(task.id, "c");
    const again = exportChanges(owner, replicaKnown(here, owner.workspace));
    expect(again.tasks[0]).toMatchObject({ full: true });
    applyPage(here, again, {}, replicaDir().dirs);
    expect(readReplica().events.list(task.id).map((e) => e.type)).toEqual(["a", "c"]);
  });

  it("keeps a task's history when the owner prunes it, and drops the task when the owner deletes it", () => {
    const kept = createTask(owner, { title: "pruned there", workflow: "w" });
    const gone = createTask(owner, { title: "deleted there", workflow: "w" });
    for (const id of [kept.id, gone.id]) {
      event(id, "a");
      owner.runtime.endTask(id, "success", 10);
      owner.runtime.setStatus(id, "completed", 10);
    }
    pull();
    pruneHistory(owner, { before: Date.now() + 1 });
    // The person deleted the other one on the owner.
    for (const table of ["state_machine_events", "task_runtime", "task_owners"]) owner.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(gone.id);
    owner.tasks.remove(gone.id);

    pull();
    const replica = readReplica();
    expect(replica.runtime.list().map((r) => r.taskId)).toEqual([kept.id]);
    expect(replica.events.list(kept.id).map((e) => e.type)).toEqual(["a"]);
    expect(replica.tasks.tryRead(gone.id)).toBeUndefined();
  });

  it("leaves a task this machine already owns alone", () => {
    const task = createTask(owner, { title: "t", workflow: "w" });
    here.prepare(`INSERT INTO task_owners (task_id, workspace) VALUES (?, 'a-local-clone')`).run(task.id);
    expect(pull().changed).toEqual([]);
  });
});
