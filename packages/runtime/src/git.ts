/**
 * The git surface JaiRA needs (DESIGN §9.2), over the Exec seam.
 *
 * Everything runs through {@link Exec}, so a WSL project uses the *distro's* git
 * against distro-side paths — DESIGN §9.1's reason for the seam: running Windows
 * git against `\\wsl$` is slow and permission-fragile, so it is avoided entirely
 * rather than worked around.
 *
 * Only what the worktree lifecycle actually needs is here. Anything richer belongs
 * with the feature that needs it.
 */
import { execOk, ExecError, type Exec, type ExecOptions } from "./exec";
import { isWslEnv, toWslPath, type ExecEnv } from "./paths";

export interface GitOptions {
  exec: Exec;
  /** Repository root, as WINDOWS sees it — translated per environment on use. */
  repoDir: string;
  execEnv?: ExecEnv;
  /** Guard against a hung git (a credential prompt, a slow network remote). */
  timeoutMs?: number;
}

/** Worktree entry as reported by `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Path as git reported it (distro-side for a WSL project). */
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class Git {
  constructor(private readonly options: GitOptions) {}

  private get env(): ExecEnv {
    return this.options.execEnv ?? "windows";
  }

  /** A path as the git process will see it. */
  path(windowsPath: string): string {
    return isWslEnv(this.env) ? toWslPath(windowsPath, this.env.wsl) : windowsPath;
  }

  private opts(extra?: ExecOptions): ExecOptions {
    return {
      cwd: this.options.repoDir,
      execEnv: this.env,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: {
        // Never let git stop for a credential prompt: inside a headless run that
        // would hang the task instead of failing it.
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
      ...extra,
    };
  }

  /** Run a git subcommand, returning trimmed stdout (throws `ExecError` on failure). */
  async run(args: readonly string[], extra?: ExecOptions): Promise<string> {
    return execOk(this.options.exec, "git", args, this.opts(extra));
  }

  /** Run a git subcommand, returning `undefined` instead of throwing on failure. */
  async tryRun(args: readonly string[], extra?: ExecOptions): Promise<string | undefined> {
    try {
      return await this.run(args, extra);
    } catch (e) {
      if (e instanceof ExecError) return undefined;
      throw e;
    }
  }

  /** True when `repoDir` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    return (await this.tryRun(["rev-parse", "--is-inside-work-tree"])) === "true";
  }

  /** The repository root git itself reports (its own path view). */
  async root(): Promise<string | undefined> {
    return this.tryRun(["rev-parse", "--show-toplevel"]);
  }

  /** Current commit, or undefined on an unborn branch (a fresh repo with no commits). */
  async head(): Promise<string | undefined> {
    return this.tryRun(["rev-parse", "HEAD"]);
  }

  /** Current branch name, or undefined when detached. */
  async currentBranch(): Promise<string | undefined> {
    const name = await this.tryRun(["rev-parse", "--abbrev-ref", "HEAD"]);
    return name === undefined || name === "HEAD" ? undefined : name;
  }

  async branchExists(branch: string): Promise<boolean> {
    return (await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== undefined;
  }

  /**
   * Add a worktree for `branch` at `worktreePath` (a Windows path; translated for
   * the environment). Creates the branch from `startPoint` when it does not exist —
   * `git worktree add -b`, which is atomic in git rather than a create-then-checkout
   * dance that can half-fail.
   */
  async addWorktree(worktreePath: string, branch: string, startPoint?: string): Promise<void> {
    const target = this.path(worktreePath);
    const args = (await this.branchExists(branch))
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, ...(startPoint !== undefined ? [startPoint] : [])];
    await this.run(args);
  }

  /**
   * Remove a worktree. `force` also discards uncommitted changes inside it, so it
   * is opt-in: the default refuses and lets the caller decide.
   */
  async removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void> {
    await this.run(["worktree", "remove", ...(options?.force ? ["--force"] : []), this.path(worktreePath)]);
  }

  /** Drop administrative records for worktrees whose directories are gone. */
  async pruneWorktrees(): Promise<void> {
    await this.run(["worktree", "prune"]);
  }

  async listWorktrees(): Promise<WorktreeEntry[]> {
    const out = await this.tryRun(["worktree", "list", "--porcelain"]);
    if (out === undefined) return [];
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length), detached: false, locked: false, prunable: false };
        entries.push(current);
      } else if (!current) {
        continue;
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        current.detached = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        current.locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        current.prunable = true;
      }
    }
    return entries;
  }

  /**
   * Tree hash of the working directory — the `Workspace.treeHash` a workspace-
   * mutating op must be memoized under (declarative-ai DESIGN §3.4). Uses
   * `stash create`, which snapshots tracked modifications without touching the
   * index or the working tree; on a clean tree it prints nothing, so HEAD's tree
   * is the answer.
   */
  async treeHash(): Promise<string | undefined> {
    const stash = await this.tryRun(["stash", "create"]);
    if (stash) return this.tryRun(["rev-parse", `${stash}^{tree}`]);
    return this.tryRun(["rev-parse", "HEAD^{tree}"]);
  }

  /** True when nothing is modified, staged, or untracked. */
  async isClean(): Promise<boolean> {
    return (await this.tryRun(["status", "--porcelain"])) === "";
  }
}
