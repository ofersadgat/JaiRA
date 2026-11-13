/**
 * When a conversation last said something (`TaskSummary.lastMessageAt`, the Chat list's When): read
 * from its records in one statement, not from the task row's clock, which a typed turn never moves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { lastMessageTimes, taskSummaries } from "../src/views";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-last-message-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const record = (id: string, taskId: string, status: string, startedAt: number, endedAt?: number): void =>
  void project.db
    .prepare(`INSERT INTO operation_records (id, task_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, taskId, status, startedAt, endedAt ?? null);

it("is absent before any call, then the newest reply, or the message a call still answers", () => {
  const task = createTask(project, { title: "talk", workflow: "chat/session" });
  const last = (): number | undefined => taskSummaries(project).find((t) => t.taskId === task.id)?.lastMessageAt;
  expect(last()).toBeUndefined();
  record("r1", task.id, "completed", 100, 150);
  expect(last()).toBe(150);
  // The person writes again: their message is the newest thing said while the reply is coming.
  record("r2", task.id, "open", 200);
  expect(last()).toBe(200);
  project.db.prepare(`UPDATE operation_records SET status = 'completed', ended_at = 260 WHERE id = 'r2'`).run();
  expect(last()).toBe(260);
  // A call that failed said nothing back: its message, not when it gave up, is the last one.
  record("r3", task.id, "failed", 300, 900);
  expect(last()).toBe(300);
});

it("is each listed task's own, in one read, and leaves the others alone", () => {
  const a = createTask(project, { title: "a", workflow: "chat/session" });
  const b = createTask(project, { title: "b", workflow: "chat/session" });
  record("ra", a.id, "completed", 10, 20);
  record("rb", b.id, "completed", 30, 40);
  record("rx", "someone-else", "completed", 50, 60);
  expect(Object.fromEntries(lastMessageTimes(project, [a.id, b.id]))).toEqual({ [a.id]: 20, [b.id]: 40 });
  expect(Object.fromEntries(lastMessageTimes(project, [b.id]))).toEqual({ [b.id]: 40 });
  expect(lastMessageTimes(project, []).size).toBe(0);
  // A summary read for one task (a reader syncing what changed) carries it too.
  expect(taskSummaries(project, new Set([a.id]))[0]?.lastMessageAt).toBe(20);
});
