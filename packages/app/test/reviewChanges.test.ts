/**
 * `changeset:review` (CHANGESETS.md's flagship flow): a task's worktree edits become a changeset,
 * the built-in review workflow runs over them with the worktree as its workspace, and the gate is
 * answered either by script or through the ordinary interaction flow — the same channel every other
 * component uses, which is the §4.1 guarantee doing its job.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { NodeExec, Git, USER_APPROVE_CHANGESET } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-review-"));
  initProject(dir);
  const git = new Git({ exec: new NodeExec(), repoDir: dir });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "t@example.com"]);
  await git.run(["config", "user.name", "T"]);
  writeFileSync(join(dir, "notes.md"), "committed line\n", "utf8");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "base"]);

  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A task whose "worktree" is the project checkout itself — the shape, without materializing one. */
function worktreeTask(): string {
  const taskId = service.createTask({ title: "Do the work", workflow: "feature/plan", inputs: { issue: "x" } }).taskId;
  const db = new Database(join(dir, ".jaira", "jaira.db"));
  try {
    db.prepare(`UPDATE task_runtime SET worktree_path = ? WHERE task_id = ?`).run(dir, taskId);
  } finally {
    db.close();
  }
  return taskId;
}

const reviewFinished = (reviewTaskId: string): boolean =>
  pushes.some((m) => m.type === "run:finished" && m.taskId === reviewTaskId);

describe("changeset:review", () => {
  it("reviews the worktree's uncommitted edits and applies the decisions there", async () => {
    const taskId = worktreeTask();
    // The agent's work: one modified file, one new one.
    writeFileSync(join(dir, "notes.md"), "the agent's version\n", "utf8");
    writeFileSync(join(dir, "extra.md"), "new file\n", "utf8");

    const result = await service.reviewChanges({
      taskId,
      interactions: {
        [USER_APPROVE_CHANGESET]: [
          { decisions: [
            { id: "c1", decision: "reverted" },
            { id: "c2", decision: "merged" },
          ] } as JsonValue,
        ],
      },
    });
    expect(result.changes).toBe(2);
    await until(() => reviewFinished(result.reviewTaskId), "the review run to finish");

    // c1 (notes.md, update) reverted to the base; c2 (extra.md, create) merged — kept as proposed.
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("committed line\n");
    expect(readFileSync(join(dir, "extra.md"), "utf8")).toBe("new file\n");
    // Recorded as JaiRA's own operation, labelled with the task it was about (§5.3's record).
    const review = service.listSystemTasks().find((t) => t.taskId === result.reviewTaskId);
    expect(review?.status).toBe("completed");
  });

  it("parks the gate for the UI when nothing scripted it, and validates the answer against the changeset", async () => {
    const taskId = worktreeTask();
    writeFileSync(join(dir, "notes.md"), "the agent's version\n", "utf8");

    const result = await service.reviewChanges({ taskId });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;
    expect(pending.component).toBe(USER_APPROVE_CHANGESET);
    expect(pending.config).toMatchObject({ component: USER_APPROVE_CHANGESET, tree: "proposal" });
    expect(JSON.stringify(pending.inputs)).toContain("notes.md");
    // The join that lets the reviewed task's CONVERSATION host this gate (§8.1's default host):
    // the request parked under the review task, but it is ABOUT the task whose worktree it reviews.
    expect(pending.taskId).toBe(result.reviewTaskId);
    expect(pending.about).toBe(taskId);
    // And the other half of that join: the review is RECORDED in JaiRA's own project and is ABOUT
    // this one, so the gate carries the project its addresses resolve against — without it the
    // reviewer read `$WORKTREE` and `$PROJECT` against whatever happened to be focused, which is
    // another project's files when one is open and nothing at all when none is.
    expect(pending.subjectProject).toBe(service.current()!.dir);
    // And that it is a DIFFERENT project from the one the request parked in — the distinction the
    // two fields exist to keep, and what makes the inbox strip resolvable (SHELL.md §2.4).
    expect(pending.project).not.toBe(pending.subjectProject);
    const worktree = await service.readUri({ uri: "$WORKTREE/notes.md", taskId, project: pending.subjectProject });
    expect(worktree.text).toBe("the agent's version\n");

    // The main-process re-validation: an answer about a change never proposed is refused (§4.1).
    expect(() =>
      service.submitInteraction(pending.requestId, { decisions: [{ id: "ghost", decision: "merged" }] } as JsonValue),
    ).toThrow(/ghost/);

    service.submitInteraction(pending.requestId, { decisions: [{ id: "c1", decision: "merged" }] } as JsonValue);
    await until(() => reviewFinished(result.reviewTaskId), "the review run to finish");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("the agent's version\n");
  });

  it("refuses a task without a worktree, and an empty diff, in plain words", async () => {
    const bare = service.createTask({ title: "No worktree", workflow: "feature/plan", inputs: { issue: "x" } }).taskId;
    await expect(service.reviewChanges({ taskId: bare })).rejects.toThrow(/no worktree/);

    const clean = worktreeTask();
    await expect(service.reviewChanges({ taskId: clean })).rejects.toThrow(/nothing to review/);
  });
});
