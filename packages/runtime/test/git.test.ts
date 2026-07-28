/**
 * The git wrapper (DESIGN §9.2) against real repositories in temp directories —
 * worktrees are exactly the kind of thing a mock would get wrong.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExec } from "../src/exec";
import { Git } from "../src/git";

const exec = new NodeExec();
let dir: string;
let git: Git;

/** A repo with one commit on `main`. */
async function initRepo(root: string): Promise<void> {
  const g = new Git({ exec, repoDir: root });
  await g.run(["init", "--initial-branch=main"]);
  await g.run(["config", "user.email", "test@example.com"]);
  await g.run(["config", "user.name", "JaiRA Test"]);
  writeFileSync(join(root, "README.md"), "# repo\n", "utf8");
  await g.run(["add", "."]);
  await g.run(["commit", "-m", "initial"]);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-git-"));
  mkdirSync(join(dir, "repo"), { recursive: true });
  await initRepo(join(dir, "repo"));
  git = new Git({ exec, repoDir: join(dir, "repo") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repository basics", () => {
  it("detects a repo, its root, head and branch", async () => {
    expect(await git.isRepo()).toBe(true);
    expect((await git.root())?.toLowerCase()).toContain("repo");
    expect(await git.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.currentBranch()).toBe("main");
  });

  it("reports a non-repo directory as such rather than throwing", async () => {
    const plain = new Git({ exec, repoDir: dir });
    expect(await plain.isRepo()).toBe(false);
  });

  it("knows which branches exist", async () => {
    expect(await git.branchExists("main")).toBe(true);
    expect(await git.branchExists("nope")).toBe(false);
  });

  it("tracks cleanliness and a tree hash that moves with the content", async () => {
    expect(await git.isClean()).toBe(true);
    const clean = await git.treeHash();
    expect(clean).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(dir, "repo", "README.md"), "# changed\n", "utf8");
    expect(await git.isClean()).toBe(false);
    // A modified tracked file must change the workspace identity, or a
    // workspace-mutating op would be memoized under a stale key.
    expect(await git.treeHash()).not.toBe(clean);
  });
});

describe("worktrees", () => {
  it("creates a worktree on a new branch, lists it, and removes it", async () => {
    const path = join(dir, "worktrees", "task-1");
    await git.addWorktree(path, "feature/task-1");

    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(await git.branchExists("feature/task-1")).toBe(true);

    const listed = await git.listWorktrees();
    // The main worktree plus ours.
    expect(listed).toHaveLength(2);
    const entry = listed.find((w) => w.branch === "feature/task-1");
    expect(entry).toBeDefined();
    expect(entry?.detached).toBe(false);
    expect(entry?.path.toLowerCase()).toContain("task-1");

    await git.removeWorktree(path);
    expect(existsSync(path)).toBe(false);
    expect(await git.listWorktrees()).toHaveLength(1);
    // Removing the worktree keeps the branch — the work is still there.
    expect(await git.branchExists("feature/task-1")).toBe(true);
  });

  it("checks out an existing branch instead of recreating it", async () => {
    await git.run(["branch", "existing"]);
    const path = join(dir, "worktrees", "existing");
    await git.addWorktree(path, "existing");
    expect((await git.listWorktrees()).some((w) => w.branch === "existing")).toBe(true);
  });

  it("refuses to remove a dirty worktree unless forced", async () => {
    const path = join(dir, "worktrees", "dirty");
    await git.addWorktree(path, "dirty-branch");
    writeFileSync(join(path, "README.md"), "# uncommitted\n", "utf8");

    // The default protects work in progress…
    await expect(git.removeWorktree(path)).rejects.toThrow(/contains modified or untracked files|not empty/i);
    expect(existsSync(path)).toBe(true);
    // …and forcing is an explicit choice.
    await git.removeWorktree(path, { force: true });
    expect(existsSync(path)).toBe(false);
  });

  it("prunes records for a worktree whose directory vanished", async () => {
    const path = join(dir, "worktrees", "gone");
    await git.addWorktree(path, "gone-branch");
    rmSync(path, { recursive: true, force: true });

    expect((await git.listWorktrees()).some((w) => w.branch === "gone-branch")).toBe(true);
    await git.pruneWorktrees();
    expect((await git.listWorktrees()).some((w) => w.branch === "gone-branch")).toBe(false);
  });

  it("fails loudly when a worktree path is already occupied", async () => {
    const path = join(dir, "worktrees", "twice");
    await git.addWorktree(path, "b1");
    await expect(git.addWorktree(path, "b2")).rejects.toThrow(/already exists|not an empty directory/i);
  });
});

describe("error surfaces", () => {
  it("throws ExecError with git's own message for a bad subcommand", async () => {
    await expect(git.run(["frobnicate"])).rejects.toThrow(/'frobnicate' is not a git command|exited/);
  });

  it("tryRun swallows the failure and returns undefined", async () => {
    expect(await git.tryRun(["frobnicate"])).toBeUndefined();
  });
});
