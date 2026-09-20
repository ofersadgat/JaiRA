---
id: engineering/units/task-worktrees
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/parallel-work-without-collisions, product/large-work-splits-into-independent-pieces, product/work-inside-wsl]
layer: service
owns_contracts: []
requires: [engineering/units/git-cli, engineering/units/process-exec, engineering/units/task-lifecycle, engineering/units/project-layout]
implemented_by: [packages/persistence/src/worktrees.ts]
verified_by: [packages/persistence/test/worktrees.test.ts, packages/persistence/test/holding.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/fan-out-host, engineering/units/git-cli, engineering/units/project-layout]
---

# Task worktrees

## Task worktrees decide the directory a task runs in, make a bound task's worktree once, and remove it only when git agrees

`ensureWorkspace(project, taskId, options?)` in `worktrees.ts` returns a `TaskWorkspace` of `root`, `treeHash`, `branch` and `isWorktree`:

1. A task a mount made, with `origin.kind: "task"`, runs in its parent's workspace. A bound parent lends its recorded `worktree_path`, and a missing directory is refused with `task '<id>' runs in its parent's worktree, and '<parent>' has none materialized`. An unbound parent lends the project directory.
2. An unbound task runs in the project directory, with a tree hash when that directory is a repository.
3. A bound task whose project is not a repository is refused with `task '<id>' is bound to branch '<branch>' but <dir> is not a git repository`.
4. A bound task's path is its recorded `worktree_path`, else `worktreePathFor(paths, taskId)`, which is `<project-parent>/.jaira-worktrees/<projectName>/<taskId>`. When that directory is missing it runs `git worktree prune` if a path was recorded, creates `worktreesDir`, and calls `addWorktree(path, branch, dependencyBaseOf(project, meta))`. It records the path whenever it differs from the recorded one, then hashes the worktree's tree.

`dependencyBaseOf(project, meta)` is the `task_runtime.branch` of the `completed` dependency with the latest `ended_at`, skipping unfinished and unbound ones. Git ignores it for a branch that already exists.

`removeWorktree(project, taskId, { force? })` answers `{ removed, reason? }` and never throws a git refusal. A task with no recorded path answers `task '<id>' has no worktree`. A recorded path whose directory is gone is pruned and its mapping cleared. Otherwise it runs `git worktree remove`, clears the mapping on success, and returns git's message on refusal. It never deletes the branch.

`gitFor(project, dir, options?)` builds a `Git` over an unobserved `NodeExec` in the project's `execEnvironment`.

It deliberately does not own:

- Running git, the WSL wrapper and parsing git's output: [git-cli](git-cli.md) and [process-exec](process-exec.md).
- Where a start calls `ensureWorkspace`, and what a later refusal leaves behind: [task-lifecycle](task-lifecycle.md).
- The branch a split copy is bound to: [fan-out-host](fan-out-host.md).
- The worktree location as a layout rule: [jaira-layout](../contracts/jaira-layout.md). The task file's `branch`: [task-file](../contracts/task-file.md).

## Task worktrees are service code on the project and worktree boundary, and hand the engine a root and a hash

- Layer `service`, in `@jaira/persistence`. It reads the task store and the runtime row and calls `Git` and `NodeExec` from `@jaira/runtime`.
- Boundary: project and worktree. A worktree lives beside the project rather than inside it, so removing one never touches the project.
- Boundary: Windows and WSL. Paths reach git through `Git.path`, and `root` is always the host path Node's `fs` reads.
- Upstream seam: the result reaches `executeWorkflow` as `workspace: { root, treeHash }`, which `@declarative-ai/hw` uses as the workspace and the memo identity.
- Callers: the app's `startRun` unless the caller supplies a workspace, and the CLI's `runTaskNow`. The app's `deleteTask` calls `removeWorktree` with `force: true`; the CLI's `worktree remove` forces only with `--force`. The app offers no other removal.

## The runtime row holds the mapping, the task file holds the binding, and git holds the worktree

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `task_runtime.worktree_path` | written by `setWorktree` once the directory exists; cleared by `clearWorktree` | the table, or the `taskRows` file when `storage.tasks` is file-backed | `reviewChanges`, `$WORKTREE` reads, file checks in a worktree, `jaira worktree list`, a made task's workspace |
| `TaskMeta.branch` | read by `ensureWorkspace` | the task file | `createTask` refuses one on the shared root; a fork and a rerun copy the parent's; the fan-out host names a split copy's |
| `task_runtime.branch` | read by `dependencyBaseOf` | the row, copied from the task file when the task is created | none |
| The worktree directory and git's record of it | made by `git worktree add`; removed by `git worktree remove` or dropped by `prune` | the repository | agents and people working in it |
| `TaskWorkspace` | computed on every call | the filesystem and git at call time | the engine; artifact placement |

## The invariants keep a task in its own checkout and never discard work without force

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An unbound task runs in the project directory, with a tree hash when it is a repository | `worktrees.test.ts` "runs an unbound task in the project directory, with a tree hash" |
| 2 | A bound task gets a worktree outside the project on its branch, and the path is recorded | `worktrees.test.ts` "creates a worktree outside the project for a bound task and records it" |
| 3 | A second call reuses the worktree and the work in it | `worktrees.test.ts` `"is idempotent — a re-run reuses the existing worktree"` |
| 4 | A recorded worktree whose directory was deleted comes back at the same path, and an existing branch is checked out rather than refused | `worktrees.test.ts` "recreates a worktree whose directory was deleted behind git's back", "reuses an existing branch rather than failing" |
| 5 | A bound task is refused when the project is not a repository | `worktrees.test.ts` "refuses a bound task when the project is not a git repository" |
| 6 | Removal without force never discards uncommitted work, reports git's reason, and keeps the mapping | `worktrees.test.ts` "refuses to destroy uncommitted work, and reports why instead of throwing" |
| 7 | A removal deletes the directory, clears the mapping and keeps the branch; a mapping whose directory is gone is cleared; a task without a worktree says so | `worktrees.test.ts` "removes a clean worktree and forgets the mapping", "cleans up a mapping whose directory is already gone", "says so when a task never had a worktree" |
| 8 | A dependent task's new branch starts from the completed dependency that ended last | `holding.test.ts` "is the branch of the completed dependency that ended last, ignoring unfinished and unbound ones" |
| 9 | A task made under a bound parent never runs anywhere but the parent's worktree | unasserted |

## Every failure leaves the worktree in place, and several refusals carry git's own words

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process dies between `git worktree add` and `setWorktree` | the worktree exists unrecorded at the default path, and the next call finds the directory and records it | start again | none |
| A task is bound to a branch another worktree has checked out, as a rerun or a fork of a bound task is while the original keeps its worktree | git refuses with `'<branch>' is already used by worktree at '<path>'`, and the start throws before `beginTaskRun` | delete the original task, or run `jaira worktree remove` on it | the start is refused with git's message |
| A split copy is bound to `<parent branch>/<segment>` | under git's default ref storage the parent's branch blocks the nested name: `cannot lock ref 'refs/heads/<parent>/<segment>': 'refs/heads/<parent>' exists` | none | the copy's start is refused with git's message |
| git is not on the PATH of a native project | `isRepo` throws `failed to run 'git …'` rather than answering false, so unbound tasks fail to start as well | install git | every start is refused naming git |
| The default path holds a directory git did not make | the directory exists, so it is recorded and the task runs there without asking git | remove the directory and start again | the task runs outside its branch |
| A person deletes a worktree directory by hand | the next start prunes git's record and checks the branch out again, so uncommitted work is gone and committed work returns | none | the worktree reappears at its last commit |
| The CLI starts a task another process drives | `runTaskNow` calls `ensureWorkspace` before its `liveRunJob` check, so the worktree is made or recorded before the refusal | none needed | refusal naming the other process |
| Two starts of one bound task race | both reach `addWorktree`, and the second fails on the occupied path or the branch the first created | start again, which finds the directory | refusal carrying git's message |
| `removeWorktree` meets uncommitted work | it answers `removed: false` with git's message and keeps the mapping | `jaira worktree remove --force` | the CLI prints `the worktree has uncommitted work; re-run with --force to discard it` and exits 1 |
| A task is deleted in the app | its worktree is removed with force, and a refusal throws `could not remove the task's worktree: <reason>` with the task left whole | fix the cause and delete again | the delete is refused with the reason |

## Deleting a task forces the removal that the unit otherwise refuses

- The app's `deleteTask` removes the worktree with `force: true`, discarding uncommitted work, because the renderer has already confirmed the delete with the person.
