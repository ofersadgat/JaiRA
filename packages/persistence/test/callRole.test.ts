/**
 * A call a script drew aside (`renderUI`'s `role: "aside"`) is no news of its conversation: its record
 * carries the role (`callRole.ts`), and neither the conversation's clock (`lastMessageAt`) nor the clock
 * of what it started (`childAt`) moves for it. The person, 2026-11-27: "this is the third time that the
 * same bug has happened where I restart the client and every task is marked as unseen" — a conversation
 * idle four hours started its review, and that `start_task` lit it unread.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { snapshotHash, type WorkflowBundle } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, sessionStoreFor, type Project } from "../src/project";
import { taskSummaries } from "../src/views";
import { callRoleOf } from "../src/callRole";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-call-role-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A program pinned as a snapshot: its reply drawn as the conversation, its check and its review aside. */
function pinProgram(): string {
  const states = {
    talk: { id: "talk", label: "talk" },
    "talk/call_0": { id: "talk/call_0", label: "reply" },
    "talk/call_1": { id: "talk/call_1", label: "notice", present: { role: "aside", title: "Checking for a correction" } },
    "talk/call_2": { id: "talk/call_2", label: "start_task", present: { role: "aside", title: "Reviewing the conversation" } },
  };
  const bundle = { rootId: "talk", states } as unknown as WorkflowBundle;
  const hash = snapshotHash(bundle);
  const at = join(project.paths.snapshotsDir, hash);
  for (const [id, state] of Object.entries(states)) {
    const { id: _id, ...stored } = state;
    const file = join(at, `${id}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(stored));
  }
  writeFileSync(join(at, ".meta.json"), JSON.stringify({ rootId: "talk", hash }));
  return hash;
}

let seq = 0;
const event = (taskId: string, payload: Record<string, unknown>): void =>
  void project.db
    .prepare(`INSERT INTO state_machine_events (task_id, instance_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(taskId, (payload["instanceId"] as string | undefined) ?? null, payload["type"] as string, JSON.stringify(payload), ++seq);

/** A conversation pinned to the program, with one call of each kind entered and its record opened by the store. */
function conversation(): { taskId: string; hash: string } {
  const hash = pinProgram();
  const task = createTask(project, { title: "talk", workflow: "talk" });
  project.db.prepare(`UPDATE task_runtime SET snapshot_hash = ? WHERE task_id = ?`).run(hash, task.id);
  return { taskId: task.id, hash };
}

/** Enter `stateId` as `instanceId` and open its record through the store a run is given. */
function call(taskId: string, instanceId: string, stateId: string, startMs: number, source: Record<string, unknown> = { kind: "prompt", user: instanceId }): void {
  event(taskId, { type: "instance.entered", instanceId, stateId });
  sessionStoreFor(project, { taskId }).append({ id: `r-${instanceId}`, source: source as never, scope: { instanceId, sequence: 0 }, startMs });
}

const roleOn = (recordId: string): unknown =>
  (project.db.prepare(`SELECT json_extract(request_json, '$.present.role') AS role FROM operation_records WHERE id = ?`).get(recordId) as { role: unknown }).role;

it("stamps a call's record with the role its state was drawn in, and nothing on a call drawn as the conversation", () => {
  const { taskId } = conversation();
  call(taskId, "i-reply", "talk/call_0", 100);
  call(taskId, "i-check", "talk/call_1", 200);
  expect(roleOn("r-i-reply")).toBeNull();
  expect(roleOn("r-i-check")).toBe("aside");
});

it("reads a call of a version the run took from that version's snapshot", () => {
  const { taskId, hash } = conversation();
  // The conversation took a newer version at its wait: its calls are entered under the versioned id.
  event(taskId, { type: "version.adopted", instanceId: "i-root", stateId: "talk", version: "talk@vabc", at: "call_1", from: "talk", snapshot: hash });
  call(taskId, "i-later", "talk@vabc/call_1", 300);
  expect(roleOn("r-i-later")).toBe("aside");
  expect(callRoleOf(project.db, project.paths.snapshotsDir, taskId, "i-unknown")).toBeUndefined();
});

it("does not move a conversation's clock for a call made aside", () => {
  const { taskId } = conversation();
  const last = (): number | undefined => taskSummaries(project).find((t) => t.taskId === taskId)?.lastMessageAt;
  call(taskId, "i-reply", "talk/call_0", 100);
  expect(last()).toBe(100);
  // The check on the message, and four idle hours later the review it starts: neither is the conversation.
  call(taskId, "i-check", "talk/call_1", 200);
  call(taskId, "i-review", "talk/call_2", 14_400_000, { kind: "function", functionRef: "start_task" });
  expect(last()).toBe(100);
});

it("does not move a conversation's childAt for a task it started aside, nor anything under that task", () => {
  const { taskId } = conversation();
  call(taskId, "i-review", "talk/call_2", 500, { kind: "function", functionRef: "start_task" });
  const review = createTask(project, { title: "review", workflow: "improve/conversation", origin: { kind: "started", taskId, key: "call_2", index: 0 } });
  project.db.prepare(`UPDATE operation_records SET status = 'completed', ended_at = 510, result_json = ? WHERE id = 'r-i-review'`).run(JSON.stringify({ value: { task_id: review.id } }));
  const lesson = createTask(project, { title: "lesson", workflow: "improve/lesson", origin: { kind: "started", taskId: review.id, key: "call_3", index: 0 } });
  const later = Date.now() + 60_000;
  project.db.prepare(`INSERT INTO operation_records (id, task_id, status, started_at, ended_at) VALUES ('r-lesson', ?, 'completed', ?, ?)`).run(lesson.id, later, later + 5);
  const summary = (id: string) => taskSummaries(project).find((t) => t.taskId === id);
  expect(summary(taskId)?.childAt).toBeUndefined();
  // The review's own clock still follows what is under it: it is only no news of the conversation.
  expect(summary(review.id)?.childAt).toBe(later + 5);
});

it("still moves a conversation's childAt for a task it started as the conversation", () => {
  const { taskId } = conversation();
  call(taskId, "i-start", "talk/call_0", 500, { kind: "function", functionRef: "start_task" });
  const work = createTask(project, { title: "work", workflow: "feature", origin: { kind: "started", taskId, key: "call_0", index: 0 } });
  project.db.prepare(`UPDATE operation_records SET status = 'completed', ended_at = 510, result_json = ? WHERE id = 'r-i-start'`).run(JSON.stringify({ value: { task_id: work.id } }));
  const later = Date.now() + 60_000;
  project.db.prepare(`INSERT INTO operation_records (id, task_id, status, started_at, ended_at) VALUES ('r-work', ?, 'completed', ?, ?)`).run(work.id, later, later + 5);
  expect(taskSummaries(project).find((t) => t.taskId === taskId)?.childAt).toBe(later + 5);
});
