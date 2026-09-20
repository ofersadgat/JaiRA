/**
 * A project on a forge, with no forge and no network: what the remote tests stand on.
 *
 * Two halves, and the seam between them is the point. The GIT half is real — a bare repository on
 * disk that `origin` pushes to and fetches from. The FORGE half is the fixture replay. The project is
 * on gitlab.com as far as its configured url says, and `url.<bare>.insteadOf` sends every byte to
 * the bare repository instead, which is exactly the distinction `remote.ts` reads the raw url for.
 *
 * So a test can push, open, comment and merge end to end, and the only things that ever leave the
 * process are writes into a temp directory.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteHandlePatch, RemoteHandlePort, RemoteHandleRow } from "@jaira/shared";

export const FORGE_URL = "https://gitlab.com/gitlab-org/gitlab-runner.git";

export interface Rig {
  root: string;
  /** The "forge's" repository: bare, on disk. */
  bare: string;
  /** The task's worktree — a clone-like repo whose `origin` is {@link FORGE_URL}. */
  work: string;
  git(dir: string, ...args: string[]): string;
  /** A second checkout, for playing the reviewer who pushes or merges "on the forge". */
  reviewer(): string;
  dispose(): void;
}

export function buildRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "jaira-remote-"));
  const bare = join(root, "forge.git");
  const work = join(root, "work");
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  const identify = (dir: string, name: string): void => {
    git(dir, "config", "user.name", name);
    git(dir, "config", "user.email", `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`);
    git(dir, "config", "commit.gpgsign", "false");
    // Every byte meant for the forge goes to the bare repository on disk.
    git(dir, "config", `url.${bare.replace(/\\/g, "/")}.insteadOf`, FORGE_URL);
  };

  mkdirSync(bare);
  git(bare, "init", "--bare", "-b", "main");
  mkdirSync(work);
  git(work, "init", "-b", "main");
  identify(work, "Test Author");
  writeFileSync(join(work, "README.md"), "# project\n");
  writeFileSync(join(work, "app.txt"), "one\ntwo\nthree\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "the start");
  git(work, "remote", "add", "origin", FORGE_URL);
  git(work, "push", "origin", "main");
  // The task's own branch, with work on it that nobody has committed yet.
  git(work, "checkout", "-b", "task/t-1");
  writeFileSync(join(work, "app.txt"), "one\ntwo, revised\nthree\n");

  let reviewers = 0;
  return {
    root,
    bare,
    work,
    git,
    reviewer: () => {
      const dir = join(root, `reviewer-${++reviewers}`);
      git(root, "clone", bare, dir);
      identify(dir, "Mara Reviewer");
      return dir;
    },
    dispose: () => {
      // Windows can hold a repository a moment after git exits. A temp directory left behind is litter;
      // a test failed by its own cleanup is a lie about the code.
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* left for the OS to collect */
      }
    },
  };
}

/** The store, in memory — `@jaira/persistence` implements the same port over SQLite. */
export class MemoryHandles implements RemoteHandlePort {
  readonly rows = new Map<string, RemoteHandleRow>();
  private clock = 1;
  private id(taskId: string, key: string): string {
    return JSON.stringify([taskId, key]);
  }
  get(taskId: string, key: string): RemoteHandleRow | undefined {
    const row = this.rows.get(this.id(taskId, key));
    return row === undefined ? undefined : structuredClone(row);
  }
  forTask(taskId: string): RemoteHandleRow[] {
    return [...this.rows.values()].filter((row) => row.taskId === taskId).map((row) => structuredClone(row));
  }
  awaiting(): RemoteHandleRow[] {
    return [...this.rows.values()].filter((row) => row.awaiting && row.number !== undefined).map((row) => structuredClone(row));
  }
  ensure(identity: Pick<RemoteHandleRow, "taskId" | "key" | "provider" | "host" | "project" | "remote" | "branch" | "target">): RemoteHandleRow {
    const id = this.id(identity.taskId, identity.key);
    if (!this.rows.has(id)) {
      const at = this.clock++;
      this.rows.set(id, { ...identity, cursor: {}, seen: [], awaiting: false, createdAt: at, updatedAt: at });
    }
    return this.get(identity.taskId, identity.key)!;
  }
  update(taskId: string, key: string, patch: RemoteHandlePatch): RemoteHandleRow | undefined {
    const row = this.rows.get(this.id(taskId, key));
    if (row === undefined) return undefined;
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete (row as unknown as Record<string, unknown>)[field];
      else if (value !== undefined) (row as unknown as Record<string, unknown>)[field] = value;
    }
    row.updatedAt = this.clock++;
    return this.get(taskId, key);
  }
  byRequest(requestId: string): RemoteHandleRow | undefined {
    const row = [...this.rows.values()].find((r) => r.requestId === requestId);
    return row === undefined ? undefined : structuredClone(row);
  }
  stopAwaiting(taskId: string): void {
    for (const row of this.rows.values()) {
      if (row.taskId !== taskId) continue;
      row.awaiting = false;
      delete row.requestId;
    }
  }
}
