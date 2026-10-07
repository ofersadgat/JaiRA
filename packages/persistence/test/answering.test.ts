/**
 * A task with a call in flight says so in its summary (decision 0018): an open record, read from the
 * database — not a count a window keeps of the events it happened to hear.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { taskSummaries } from "../src/views";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-answering-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

it("is set while a record of the task is open, and not before or after", () => {
  const task = createTask(project, { title: "talk", workflow: "w" });
  const answering = (): boolean => taskSummaries(project).find((t) => t.taskId === task.id)?.answering === true;
  expect(answering()).toBe(false);
  project.db.prepare(`INSERT INTO operation_records (id, task_id, status, started_at) VALUES ('r1', ?, 'open', 1)`).run(task.id);
  expect(answering()).toBe(true);
  project.db.prepare(`UPDATE operation_records SET status = 'completed', ended_at = 2 WHERE id = 'r1'`).run();
  expect(answering()).toBe(false);
});
