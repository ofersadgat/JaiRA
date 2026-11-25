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

it("does not move for a program's wait for the next message, which a restart opens again", () => {
  const task = createTask(project, { title: "talk", workflow: "chat/session" });
  const last = (): number | undefined => taskSummaries(project).find((t) => t.taskId === task.id)?.lastMessageAt;
  const wait = (id: string, status: string, startedAt: number, endedAt?: number): void =>
    void project.db
      .prepare(`INSERT INTO operation_records (id, task_id, status, request_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, task.id, status, JSON.stringify({ kind: "function", functionRef: "input" }), startedAt, endedAt ?? null);
  record("reply", task.id, "completed", 100, 150);
  // The program listens; the app quits, which fails the wait; the next start listens again.
  wait("w1", "failed", 160, 500);
  wait("w2", "open", 600);
  expect(last()).toBe(150);
  // The person answers: the wait completes, and the call that answers them is what moves the clock.
  project.db.prepare(`UPDATE operation_records SET status = 'completed', ended_at = 700 WHERE id = 'w2'`).run();
  expect(last()).toBe(150);
  record("turn", task.id, "open", 701);
  expect(last()).toBe(701);
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

// The person, 2026-11-23: "if a child task updates, it should also mark the parent as unseen as well (recursively)".
it("holds a parent's clock to the newest move under it, at any depth, and only a task with something under it", () => {
  const talk = createTask(project, { title: "talk", workflow: "chat/session" });
  const review = createTask(project, { title: "review", workflow: "improve/conversation", origin: { kind: "started", taskId: talk.id, key: "call_5", index: 0 } });
  const lesson = createTask(project, { title: "lesson", workflow: "improve/lesson", origin: { kind: "started", taskId: review.id, key: "call_3", index: 0 } });
  const later = Date.now() + 60_000;
  record("rl", lesson.id, "completed", later, later + 5);
  const childAt = (taskId: string): number | undefined => taskSummaries(project).find((t) => t.taskId === taskId)?.childAt;
  expect(childAt(talk.id)).toBe(later + 5);
  expect(childAt(review.id)).toBe(later + 5);
  expect(childAt(lesson.id)).toBeUndefined();
  // A summary read for the parent alone (a reader syncing what changed) carries it too.
  expect(taskSummaries(project, new Set([talk.id]))[0]?.childAt).toBe(later + 5);
});
