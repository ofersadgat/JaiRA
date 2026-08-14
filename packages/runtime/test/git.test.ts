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

describe("GitRead (CHANGESETS.md §6.1)", () => {
  it("resolves revisions, reads blobs at a pin, and lists a tree", async () => {
    const head = await git.head();
    const resolved = await git.revParse("HEAD");
    expect(resolved).toBe(head);
    expect(await git.revParse("no-such-rev")).toBeUndefined();

    // A blob at a PINNED commit reads the committed content, whatever the worktree now says —
    // the property §1.2 ("the source is a version, not a location") rests on.
    writeFileSync(join(dir, "repo", "README.md"), "# drifted\n", "utf8");
    // UNTRIMMED: blob content is bytes, and a stripped trailing newline would read as a change
    // nobody made the moment a changeset diffed against it.
    expect(await git.show(head!, "README.md")).toBe("# repo\n");
    expect(await git.show(head!, "missing.md")).toBeUndefined();

    const listing = await git.lsTree(head!);
    expect(listing.map((e) => e.path)).toEqual(["README.md"]);
    expect(listing[0]?.type).toBe("blob");
    // …and the blob is readable by the oid the listing named.
    expect(await git.catFile(listing[0]!.oid)).toBe("# repo\n");
  });

  it("lists a subdirectory of a tree, entries prefixed with it", async () => {
    mkdirSync(join(dir, "repo", "workflows"), { recursive: true });
    writeFileSync(join(dir, "repo", "workflows", "plan.json"), "{}\n", "utf8");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "add workflows"]);
    const head = await git.head();

    const listing = await git.lsTree(head!, "workflows");
    expect(listing.map((e) => e.path)).toEqual(["workflows/plan.json"]);
  });

  it("diffs the working tree against a base: update, delete, rename and untracked create", async () => {
    const base = (await git.head())!;
    // An update, a delete, a rename and an untracked new file — the worktree as an agent leaves it,
    // nothing staged except the rename (git cannot see an unstaged rename as one).
    writeFileSync(join(dir, "repo", "README.md"), "# changed\n", "utf8");
    mkdirSync(join(dir, "repo", "src"), { recursive: true });
    writeFileSync(join(dir, "repo", "src", "new.ts"), "export {};\n", "utf8");
    writeFileSync(join(dir, "repo", "doomed.md"), "bye\n", "utf8");
    await git.run(["add", "doomed.md"]);
    await git.run(["commit", "-m", "add doomed"]);
    const base2 = (await git.head())!;
    rmSync(join(dir, "repo", "doomed.md"));

    const entries = await git.diff(base2);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.action]));
    expect(byPath["README.md"]).toBe("update");
    expect(byPath["doomed.md"]).toBe("delete");
    expect(byPath["src/new.ts"]).toBe("create");
    // …and against the FIRST commit the same tree reads differently, because the base is part of
    // the question.
    const earlier = await git.diff(base);
    expect(Object.fromEntries(earlier.map((e) => [e.path, e.action]))["doomed.md"]).toBeUndefined();
  });

  it("reports a staged rename as one", async () => {
    writeFileSync(join(dir, "repo", "renamed.md"), "# repo\n", "utf8");
    await git.run(["add", "renamed.md"]);
    await git.run(["rm", "-q", "README.md"]);
    const entries = await git.diff((await git.head())!);
    const rename = entries.find((e) => e.action === "rename");
    expect(rename).toMatchObject({ path: "renamed.md", oldPath: "README.md" });
  });

  it("parses status including untracked files", async () => {
    writeFileSync(join(dir, "repo", "untracked.txt"), "x\n", "utf8");
    const entries = await git.status();
    expect(entries).toEqual([{ path: "untracked.txt", x: "?", y: "?" }]);
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
