---
id: engineering/units/git-cli
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/parallel-work-without-collisions, product/review-changes-before-they-land, product/work-inside-wsl]
layer: core
owns_contracts: []
requires: [engineering/units/process-exec]
implemented_by: [packages/runtime/src/git.ts]
verified_by: [packages/runtime/test/git.test.ts, packages/runtime/test/changesets.test.ts]
siblings: [engineering/units/task-worktrees, engineering/units/changesets, engineering/units/process-exec, engineering/units/uri-and-artifact-reads]
---

# Git CLI

## Git CLI runs git subcommands over the exec seam and parses what they print, and decides nothing about where or when

`Git` in `git.ts` is the only git backend and implements both `GitRead` and `GitLifecycle`. Every call runs `git` in `repoDir` with the options from `opts()`: the project's `execEnv`, `timeoutMs`, and `GIT_TERMINAL_PROMPT=0` with `GCM_INTERACTIVE=never`, with any `extra` options spread last.

- `run(args)` returns trimmed stdout or throws `ExecError`. `tryRun(args)` answers `undefined` for an `ExecError` and rethrows anything else.
- Repository facts: `isRepo`, `root`, `head`, `currentBranch`, which is undefined when detached, `branchExists`, `identity` from `config --get user.name` and `user.email`, `isClean` from `status --porcelain`, and `treeHash`, which is the tree of `stash create` when the tree is dirty and `HEAD^{tree}` when it is clean.
- `GitLifecycle`: `addWorktree(path, branch, startPoint?)` runs `worktree add <path> <branch>` for an existing branch and `worktree add -b <branch> <path> [startPoint]` otherwise; `removeWorktree(path, {force})`; `pruneWorktrees`; `listWorktrees`, which parses `worktree list --porcelain` into `WorktreeEntry` and answers empty on failure.
- `GitRead`: `revParse` through `rev-parse --verify --quiet <rev>^{object}`; `show(rev, path)` and `catFile(oid)` with stdout untrimmed; `lsTree(rev, dir?)` over `ls-tree -z`, prefixing entries with `dir`; `status` over `status --porcelain -z -uall`; `diff(base)` over `diff --raw -z --find-renames <base> --`, plus every untracked `??` entry as a `create` with modes `000000` to `100644`.
- `parseRawDiff(raw)` maps `A` to `create`, `D` to `delete`, `R` to `rename` with `oldPath`, `C` to `create` at the second path, and anything else to `update`, or to `chmod` when the modes differ and the two object ids are equal and not all zeros.
- `path(windowsPath)` returns the distro's view under WSL.

It deliberately does not own:

- Where a worktree lives, when it is made, pruned or removed, which branch a new one starts from, and the report of uncommitted work: [task-worktrees](task-worktrees.md), whose `gitFor` builds a `Git` from project settings.
- Turning a diff into a changeset and applying decisions to it: [changesets](changesets.md). `git:` URI reads: [uri-and-artifact-reads](uri-and-artifact-reads.md). `jaira worktree list` and `jaira changeset review`: [cli](cli.md).
- Spawning, the WSL wrapper and the timeout kill: [process-exec](process-exec.md).

## Git CLI sits in the core layer on the Windows and WSL boundary, and calls only the exec seam

- Layer `core`, package `@jaira/runtime`. It calls `execOk` and `Exec.run` from `exec.ts` and `toWslPath` from `paths.ts`. No upstream engine seam reaches it.
- Boundary: Windows and WSL. A WSL project runs the distro's git through `wsl.exe --cd`, and worktree paths go through `Git.path`, so Windows git never runs against a `\\wsl.localhost` share.
- Callers: `gitFor` for `ensureWorkspace`, `removeWorktree`, the fan-out host's `isRepo`, `reviewChanges`, `git:` reads and the git identity; the CLI's `worktree list` and `changeset review`; and `new Git({ repoDir: homedir() })` for the global identity.

## Git CLI caches nothing, and the repository is the truth for every answer

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| Refs, the index, objects and worktree administrative records | read and written by git per call | the repository | people and their own git tools; task-worktrees records the path in `task_runtime.worktree_path` |
| `WorktreeEntry`, `TreeEntry`, `DiffEntry`, `StatusEntry` | returned per call and never kept | git's output at call time | changesets and the CLI |
| Commit identity | read by `identity` | git's config chain: repository, global, system | review notes signed with it |

## The invariants keep work on disk and every parse faithful to git

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A worktree on a new branch is created, listed and removed, and removing it keeps the branch | `git.test.ts` "creates a worktree on a new branch, lists it, and removes it" |
| 2 | An existing branch is checked out rather than created again | `git.test.ts` "checks out an existing branch instead of recreating it" |
| 3 | A worktree with uncommitted work is never removed unless forced | `git.test.ts` "refuses to remove a dirty worktree unless forced" |
| 4 | Prune drops the record of a worktree whose directory is gone, and adding at an occupied path fails | `git.test.ts` "prunes records for a worktree whose directory vanished", "fails loudly when a worktree path is already occupied" |
| 5 | A modified tracked file moves the tree hash | `git.test.ts` "tracks cleanliness and a tree hash that moves with the content" |
| 6 | A blob is read at the commit named whatever the working tree holds, with its bytes untrimmed | `git.test.ts` `"resolves revisions, reads blobs at a pin, and lists a tree"`, "lists a subdirectory of a tree, entries prefixed with it" |
| 7 | A diff against a base reports updates, deletes, renames and untracked files, and a mode flip carries both modes | `git.test.ts` "diffs the working tree against a base: update, delete, rename and untracked create", "reports a staged rename as one", "parses status including untracked files"; `changesets.test.ts` `"carries a mode flip as a change with modes — the applicable chmod (§1.1)"` |
| 8 | A failing subcommand throws with git's own message, and `tryRun` answers `undefined` for it | `git.test.ts` "throws ExecError with git's own message for a bad subcommand", "tryRun swallows the failure and returns undefined" |
| 9 | Outside a repository `isRepo` is false and `identity` still answers, and a repository's own name wins | `git.test.ts` "reports a non-repo directory as such rather than throwing", `"answers rather than throws outside a repository — an unsigned note beats a refused one"`, "reads the name and email git would attribute a commit to", "lets a repo-local name win, which is git's own precedence" |
| 10 | `parseRawDiff` reports a mode flip with an unchanged blob as `chmod` and never as `update` | unasserted |

## Git's refusals surface as its own messages, and a few answers are quietly wrong

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| git is not on the PATH | the spawn rejects with `failed to run 'git …'`, which is not an `ExecError`, so `tryRun`, `isRepo` and every read throw it rather than answering | install git | the start or review fails naming the command |
| A subcommand hangs | `ExecError` `timed out` after the timeout | retry | the step fails with `timed out` |
| git refuses a subcommand | `run` throws an `ExecError` whose message carries git's stderr, and `tryRun` answers `undefined` | the caller reads git's message | refusal carrying git's message |
| Two calls create one new branch at once | `addWorktree` checks `branchExists` and then runs `add -b`, so the second fails with git's message that the branch exists | retry, which takes the existing-branch path | refusal carrying git's message |
| Two processes run git on one repository | git serializes what it locks, and a command that finds a lock held fails as an `ExecError` | retry | refusal carrying git's message |
| The first `status` entry begins with a space, as a modified unstaged file does | `status` reads through `execOk`, which trims, so that entry loses its status column and the first character of its path | none; `diff` reads only `??` entries, which never begin with a space | none |
| A working tree gains only untracked files | `stash create` ignores untracked files, so `treeHash` does not move | none | none; a memoized workspace operation keys on the old hash |
| A caller passes `extra.env` | it replaces the no-prompt variables rather than adding to them | pass them again | none |
| A WSL project runs git | the no-prompt variables are set on `wsl.exe` and never reach the distro's git; no built-in subcommand contacts a remote | none | none |
| The process dies mid-command, or a call is retried | this class writes nothing itself, so what remains is git's own state; a retried `addWorktree` finds the path occupied | the caller checks first, as `ensureWorkspace` does | none |

## The budget is one timeout per git command

- 120 000 ms per subcommand: `DEFAULT_TIMEOUT_MS` in `git.ts`, overridable by `GitOptions.timeoutMs`.
