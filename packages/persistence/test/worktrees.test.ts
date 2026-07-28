/**
 * Branch binding and the worktree lifecycle (DESIGN §9.2) against a real git
 * repository: a bound task gets its own worktree, an unbound one runs in the
 * project directory, and removal protects uncommitted work.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git, NodeExec, writeWorkflowFiles, specPlanningFiles } from "@jaira/runtime";
import { worktreePathFor } from "@jaira/shared";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { ensureWorkspace, removeWorktree } from "../src/worktrees";

const exec = new NodeExec();
let root: string;
let projectDir: string;
let project: Project;

beforeEach(async () => {
  // A parent directory, because worktrees live OUTSIDE the project (DESIGN §3).
  root = mkdtempSync(join(tmpdir(), "jaira-wt-"));
  projectDir = join(root, "myproject");
  const paths = initProject(projectDir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());

  const git = new Git({ exec, repoDir: projectDir });
  await git.run(["init", "--initial-branch=main"]);
  await git.run(["config", "user.email", "test@example.com"]);
  await git.run(["config", "user.name", "JaiRA Test"]);
  writeFileSync(join(projectDir, "README.md"), "# project\n", "utf8");
  await git.run(["add", "."]);
  await git.run(["commit", "-m", "initial"]);

  project = openProject(projectDir);
});

afterEach(() => {
  project.close();
  rmSync(root, { recursive: true, force: true });
});

const newTask = (over: { branch?: string } = {}): string =>
  createTask(project, {
    title: "T",
    workflow: "feature/plan",
    inputs: { issue: "x" },
    ...(over.branch !== undefined ? { branch: over.branch } : {}),
  }).id;

describe("ensureWorkspace", () => {
  it("runs an unbound task in the project directory, with a tree hash", async () => {
    const workspace = await ensureWorkspace(project, newTask());
    expect(workspace).toMatchObject({ root: project.paths.projectDir, isWorktree: false });
    expect(workspace.branch).toBeUndefined();
    // Still a git repo, so a workspace-mutating op has an identity to memo under.
    expect(workspace.treeHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("creates a worktree outside the project for a bound task and records it", async () => {
    const taskId = newTask({ branch: "feature/login" });
    const workspace = await ensureWorkspace(project, taskId);

    const expected = worktreePathFor(project.paths, taskId);
    expect(workspace).toMatchObject({ root: expected, isWorktree: true, branch: "feature/login" });
    // Outside the project directory (DESIGN §3), so the engine's own working copy
    // is never what an agent is pointed at.
    expect(expected.startsWith(project.paths.projectDir)).toBe(false);
    expect(existsSync(join(expected, "README.md"))).toBe(true);
    // The mapping is durable.
    expect(project.runtime.get(taskId)?.worktreePath).toBe(expected);

    const git = new Git({ exec, repoDir: projectDir });
    expect(await git.branchExists("feature/login")).toBe(true);
  });

  it("carries whatever the branch tracks — including .jaira/ when it is committed", async () => {
    // A worktree is a checkout of the branch, so if `.jaira/` is committed (and
    // `workflows/` is *meant* to be), it appears in the worktree. DESIGN §10.1's
    // aside that `.jaira/**` is "outside the worktree anyway" is therefore wrong:
    // denying agents that path is a POLICY job (phase 6), not a layout accident.
    const taskId = newTask({ branch: "feature/tracked" });
    const workspace = await ensureWorkspace(project, taskId);
    expect(existsSync(join(workspace.root, ".jaira", "workflows"))).toBe(true);
    // The derived state is not carried, because init gitignores it.
    expect(existsSync(join(workspace.root, ".jaira", "jaira.db"))).toBe(false);
    expect(existsSync(join(workspace.root, ".jaira", "snapshots"))).toBe(false);
  });

  it("is idempotent — a re-run reuses the existing worktree", async () => {
    const taskId = newTask({ branch: "feature/again" });
    const first = await ensureWorkspace(project, taskId);
    writeFileSync(join(first.root, "work.txt"), "in progress\n", "utf8");

    const second = await ensureWorkspace(project, taskId);
    expect(second.root).toBe(first.root);
    // Work in the worktree survives a re-run (this is why `add` isn't retried blindly).
    expect(readFileSync(join(second.root, "work.txt"), "utf8")).toBe("in progress\n");
  });

  it("recreates a worktree whose directory was deleted behind git's back", async () => {
    const taskId = newTask({ branch: "feature/vanished" });
    const first = await ensureWorkspace(project, taskId);
    rmSync(first.root, { recursive: true, force: true });

    // Git still holds an administrative record; `worktree add` would refuse until
    // pruned, so ensureWorkspace prunes first.
    const again = await ensureWorkspace(project, taskId);
    expect(again.root).toBe(first.root);
    expect(existsSync(join(again.root, "README.md"))).toBe(true);
  });

  it("reuses an existing branch rather than failing", async () => {
    const git = new Git({ exec, repoDir: projectDir });
    await git.run(["branch", "preexisting"]);
    const workspace = await ensureWorkspace(project, newTask({ branch: "preexisting" }));
    expect(workspace.branch).toBe("preexisting");
  });

  it("refuses a bound task when the project is not a git repository", async () => {
    const plainDir = join(root, "plain");
    initProject(plainDir);
    const plain = openProject(plainDir);
    try {
      const taskId = createTask(plain, { title: "T", workflow: "feature/plan", branch: "x" }).id;
      await expect(ensureWorkspace(plain, taskId)).rejects.toThrow(/not a git repository/);
    } finally {
      plain.close();
    }
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree and forgets the mapping", async () => {
    const taskId = newTask({ branch: "feature/done" });
    const workspace = await ensureWorkspace(project, taskId);

    expect(await removeWorktree(project, taskId)).toEqual({ removed: true });
    expect(existsSync(workspace.root)).toBe(false);
    expect(project.runtime.get(taskId)?.worktreePath).toBeUndefined();
    // The branch survives — the work is still there to merge.
    expect(await new Git({ exec, repoDir: projectDir }).branchExists("feature/done")).toBe(true);
  });

  it("refuses to destroy uncommitted work, and reports why instead of throwing", async () => {
    const taskId = newTask({ branch: "feature/dirty" });
    const workspace = await ensureWorkspace(project, taskId);
    writeFileSync(join(workspace.root, "README.md"), "# uncommitted\n", "utf8");

    const refused = await removeWorktree(project, taskId);
    expect(refused.removed).toBe(false);
    expect(refused.reason).toMatch(/modified or untracked|not empty/i);
    expect(existsSync(workspace.root)).toBe(true);
    // Still mapped, so the UI can offer the choice again.
    expect(project.runtime.get(taskId)?.worktreePath).toBe(workspace.root);

    expect(await removeWorktree(project, taskId, { force: true })).toEqual({ removed: true });
    expect(existsSync(workspace.root)).toBe(false);
  });

  it("cleans up a mapping whose directory is already gone", async () => {
    const taskId = newTask({ branch: "feature/manual" });
    const workspace = await ensureWorkspace(project, taskId);
    rmSync(workspace.root, { recursive: true, force: true });

    expect(await removeWorktree(project, taskId)).toEqual({ removed: true });
    expect(project.runtime.get(taskId)?.worktreePath).toBeUndefined();
  });

  it("says so when a task never had a worktree", async () => {
    const result = await removeWorktree(project, newTask());
    expect(result).toMatchObject({ removed: false });
    expect(result.reason).toMatch(/no worktree/);
  });
});
