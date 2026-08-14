/**
 * The git surface JaiRA needs (DESIGN §9.2, CHANGESETS.md §6), over the Exec seam.
 *
 * Everything runs through {@link Exec}, so a WSL project uses the *distro's* git
 * against distro-side paths — DESIGN §9.1's reason for the seam: running Windows
 * git against `\\wsl$` is slow and permission-fragile, so it is avoided entirely
 * rather than worked around. That is also why backend selection is per PROJECT
 * ENVIRONMENT, not a machine-wide probe (§6.3): "no git on Windows" must not
 * demote a WSL project to a JS backend reading over `\\wsl$`, because for that
 * project the answer to "which git can reach this repository" is git-cli through
 * `wsl`.
 *
 * Two interfaces, not one (§6.2):
 *
 *  - {@link GitRead} — everything the changeset machinery needs: `diff`, `show`,
 *    `status`, `catFile`, `lsTree`, `revParse`. A future non-CLI backend
 *    (libgit2, isomorphic-git) would implement exactly this and nothing more.
 *  - {@link GitLifecycle} — the worktree lifecycle the task model needs. CLI-only
 *    by design: a project on a machine without git simply cannot use
 *    worktree-backed tasks, which is honest and far better than a backend that
 *    half-implements them.
 *
 * Build order per §6.2: the interfaces are the load-bearing part; {@link Git} is
 * the git-cli backend and the only one implemented. A fallback nobody has needed
 * yet is maintenance paid in advance.
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

/** One entry of `git ls-tree` over a pinned tree — what `git:` reference resolution lists. */
export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  /** Path relative to the repository root, forward slashes, exactly as git printed it. */
  path: string;
}

/** One file the working tree differs from a base commit in — the raw material of a changeset. */
export interface DiffEntry {
  /** The changeset action vocabulary (CHANGESETS.md §1.1). `chmod` is a mode flip with the blob unchanged. */
  action: "create" | "update" | "delete" | "rename" | "chmod";
  /** Path after the change (the only path, except for a rename). */
  path: string;
  /** A rename's source. */
  oldPath?: string;
  /** Old/new file modes as git reported them (`000000` for absent). */
  modes: { before: string; after: string };
}

/** One line of `git status --porcelain` — X/Y as git prints them. */
export interface StatusEntry {
  path: string;
  x: string;
  y: string;
  renamedFrom?: string;
}

/**
 * The read-only surface (CHANGESETS.md §6.1) — everything the changeset machinery needs, and the
 * whole contract a non-CLI backend would have to meet. Worktree lifecycle is deliberately NOT here.
 */
export interface GitRead {
  /** Resolve a revision to a full object id, or undefined when it does not resolve. */
  revParse(rev: string): Promise<string | undefined>;
  /** A blob's content by `<rev>:<path>`, or undefined when there is no such blob. */
  show(rev: string, path: string): Promise<string | undefined>;
  /** A blob's content by object id. */
  catFile(oid: string): Promise<string | undefined>;
  /** The entries of a tree, optionally under one directory (non-recursive — a listing, not a walk). */
  lsTree(rev: string, dir?: string): Promise<TreeEntry[]>;
  /** Working tree (tracked AND untracked) against a base commit — see {@link Git.diff}. */
  diff(base: string): Promise<DiffEntry[]>;
  /** `status --porcelain`, parsed. */
  status(): Promise<StatusEntry[]>;
}

/**
 * The worktree lifecycle (CHANGESETS.md §6.1) — git-cli only, and staying that way: `addWorktree`
 * touches the filesystem in ways only real git is trusted to.
 */
export interface GitLifecycle {
  addWorktree(worktreePath: string, branch: string, startPoint?: string): Promise<void>;
  removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void>;
  pruneWorktrees(): Promise<void>;
  listWorktrees(): Promise<WorktreeEntry[]>;
}

/** The git-cli backend — implements BOTH interfaces, and is the only backend (§6.2's build order). */
export class Git implements GitRead, GitLifecycle {
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

  /**
   * Like {@link tryRun} but with stdout UNTRIMMED. Blob content is bytes, and `execOk`'s trim —
   * right for every porcelain answer — silently strips a file's trailing newline, which a changeset
   * would then report as a change nobody made.
   */
  private async tryRunRaw(args: readonly string[], extra?: ExecOptions): Promise<string | undefined> {
    const result = await this.options.exec.run("git", args, this.opts(extra));
    return result.code === 0 ? result.stdout : undefined;
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

  // --- GitRead (CHANGESETS.md §6.1) -------------------------------------------

  async revParse(rev: string): Promise<string | undefined> {
    return this.tryRun(["rev-parse", "--verify", "--quiet", `${rev}^{object}`]);
  }

  async show(rev: string, path: string): Promise<string | undefined> {
    // `:./<path>` would resolve relative to cwd; the changeset vocabulary is repo-root-relative,
    // which is what a bare `<rev>:<path>` means to git. Untrimmed — this is content, not porcelain.
    return this.tryRunRaw(["show", `${rev}:${path.replace(/\\/g, "/")}`]);
  }

  async catFile(oid: string): Promise<string | undefined> {
    return this.tryRunRaw(["cat-file", "blob", oid]);
  }

  async lsTree(rev: string, dir?: string): Promise<TreeEntry[]> {
    // `<rev>:<dir>` names the subtree directly, so entries come back relative to it and are
    // re-prefixed below — `ls-tree <rev> -- <dir>/` would depend on cwd being the repo root,
    // which a worktree-scoped Git cannot promise.
    const spec = dir === undefined || dir === "" ? rev : `${rev}:${dir.replace(/\\/g, "/").replace(/\/+$/, "")}`;
    const out = await this.tryRun(["ls-tree", "-z", spec]);
    if (out === undefined) return [];
    const entries: TreeEntry[] = [];
    for (const line of out.split("\0")) {
      if (line.length === 0) continue;
      // `<mode> <type> <oid>\t<name>`
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, oid] = line.slice(0, tab).split(/\s+/);
      const name = line.slice(tab + 1);
      if (mode === undefined || type === undefined || oid === undefined) continue;
      if (type !== "blob" && type !== "tree" && type !== "commit") continue;
      entries.push({ mode, type, oid, path: dir === undefined || dir === "" ? name : `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/${name}` });
    }
    return entries;
  }

  /**
   * The working tree against a base commit — tracked changes AND untracked files, because an
   * agent's `write_file` does not stage anything and a diff that missed new files would review a
   * subset while claiming the whole (CHANGESETS.md §1.1's "every git action is representable").
   *
   * `--raw` rather than `--name-status`: the raw format carries both MODES, which is what tells a
   * chmod (mode flip, blob unchanged) from an update — `--name-status` folds both into `M`.
   */
  async diff(base: string): Promise<DiffEntry[]> {
    const raw = await this.run(["diff", "--raw", "-z", "--find-renames", base, "--"]);
    const entries = parseRawDiff(raw);
    // Untracked files are invisible to `diff <commit>`; status is where they are.
    for (const entry of await this.status()) {
      if (entry.x === "?" && entry.y === "?") {
        entries.push({ action: "create", path: entry.path, modes: { before: "000000", after: "100644" } });
      }
    }
    return entries;
  }

  async status(): Promise<StatusEntry[]> {
    // `-uall` lists untracked FILES rather than collapsing a new directory to one `?? dir/` row —
    // a changeset is per file, and a collapsed row would hide every file but the directory name.
    const out = await this.tryRun(["status", "--porcelain", "-z", "-uall"]);
    if (out === undefined || out === "") return [];
    const entries: StatusEntry[] = [];
    const fields = out.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (field.length < 4) continue;
      const x = field[0]!;
      const y = field[1]!;
      const path = field.slice(3);
      const entry: StatusEntry = { path, x, y };
      // A rename's ORIGINAL path arrives as the next NUL-separated field.
      if (x === "R" || y === "R") entry.renamedFrom = fields[++i];
      entries.push(entry);
    }
    return entries;
  }
}

/**
 * Parse `git diff --raw -z` output into {@link DiffEntry} rows.
 *
 * The -z raw format per record: `:<old mode> <new mode> <old oid> <new oid> <letter>[score]` NUL
 * `<path>` NUL, with a rename/copy carrying a second path field.
 */
export function parseRawDiff(raw: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i]!;
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldOid, newOid, letters] = meta.slice(1).split(/\s+/);
    const letter = letters?.[0];
    const first = fields[++i];
    if (oldMode === undefined || newMode === undefined || letter === undefined || first === undefined) continue;
    const modes = { before: oldMode, after: newMode };
    switch (letter) {
      case "A":
        entries.push({ action: "create", path: first, modes });
        break;
      case "D":
        entries.push({ action: "delete", path: first, modes });
        break;
      case "R":
      case "C": {
        const second = fields[++i];
        if (second === undefined) break;
        entries.push({ action: letter === "R" ? "rename" : "create", path: second, oldPath: first, modes });
        break;
      }
      default:
        // A mode flip with the blob unchanged is a chmod (CHANGESETS.md §1.1); git reports it as M,
        // so the oid pair is the discriminator. A worktree-side diff prints an all-zero oid for a
        // file it has not hashed — that is CONTENT unknown, never a bare chmod.
        entries.push({
          action:
            oldMode !== newMode && oldOid === newOid && oldOid !== undefined && !/^0+$/.test(oldOid) && newOid !== undefined
              ? "chmod"
              : "update",
          path: first,
          modes,
        });
        break;
    }
  }
  return entries;
}
