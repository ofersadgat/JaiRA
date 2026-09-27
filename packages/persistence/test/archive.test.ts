/**
 * Archived tasks (the person, 2026-09-27): a finished task put away, remembering how it finished, and
 * the rule that puts finished work away by itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { DEFAULT_ARCHIVE } from "@jaira/shared";
import { autoArchive } from "../src/archive";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { taskSummaries } from "../src/views";

const DAY = 86_400_000;
const NOW = 100 * DAY;

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-archive-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task that finished `status` some days before NOW. */
function finished(title: string, status: "completed" | "failed" | "canceled", daysAgo: number, workflow = "w"): string {
  const task = createTask(project, { title, workflow });
  project.runtime.setStatus(task.id, status, NOW - daysAgo * DAY);
  project.runtime.endTask(task.id, status === "completed" ? "success" : status === "failed" ? "error" : "canceled", NOW - daysAgo * DAY);
  return task.id;
}

describe("archiving a task", () => {
  it("puts away only a finished task, and remembers how it finished", () => {
    const done = finished("done", "failed", 1);
    const going = createTask(project, { title: "going", workflow: "w" }).id;
    project.runtime.setStatus(going, "running", 1);

    expect(project.runtime.archive(going, NOW)).toBe(false);
    expect(project.runtime.archive(done, NOW)).toBe(true);
    expect(project.runtime.get(done)).toMatchObject({ status: "archived", archivedFrom: "failed", archivedAt: NOW });
    expect(taskSummaries(project).find((t) => t.taskId === done)?.archived).toEqual({ from: "failed", at: NOW });

    expect(project.runtime.unarchive(done, NOW + 1)).toBe(true);
    expect(project.runtime.get(done)).toMatchObject({ status: "failed" });
    expect(project.runtime.get(done)?.archivedFrom).toBeUndefined();
  });
});

describe("the archive rule", () => {
  it("keeps the latest finished, then archives failures after two days and successes after one", () => {
    // Newest first: five kept whatever their age.
    const kept = [0.1, 0.2, 0.3, 0.4, 0.5].map((d, i) => finished(`kept ${i}`, "completed", d));
    const freshFailure = finished("failed yesterday", "failed", 1.5);
    const oldFailure = finished("failed three days ago", "failed", 3);
    const freshSuccess = finished("succeeded 20 hours ago", "completed", 0.8);
    const oldSuccess = finished("succeeded two days ago", "completed", 2);
    const oldCancel = finished("canceled three days ago", "canceled", 3);

    expect(autoArchive(project, DEFAULT_ARCHIVE, NOW).sort()).toEqual([oldFailure, oldSuccess, oldCancel].sort());
    for (const id of [...kept, freshFailure, freshSuccess]) expect(project.runtime.get(id)?.status).not.toBe("archived");
  });

  it("leaves conversations alone, and does nothing when switched off", () => {
    const chat = finished("a chat", "completed", 10, "chat/session");
    const old = finished("old work", "completed", 10);
    expect(autoArchive(project, { ...DEFAULT_ARCHIVE, keepLatest: 0, auto: false }, NOW)).toEqual([]);
    expect(autoArchive(project, { ...DEFAULT_ARCHIVE, keepLatest: 0 }, NOW)).toEqual([old]);
    expect(project.runtime.get(chat)?.status).toBe("completed");
  });
});
