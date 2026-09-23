---
id: engineering/contracts/task-file
type: engineering-contract
status: shipped
updated: 2026-09-22
visibility: public
kind: format
owned_by: [engineering/units/task-lifecycle]
consumers: ["@jaira/persistence lifecycle.ts, views.ts, conversation.ts, workflows.ts, worktrees.ts, cut.ts", "@jaira/app main service.ts and fanOut.ts", "@jaira/cli task list and task status", "people editing a task by hand"]
since: 2026-07-17
siblings: [engineering/contracts/workflow-snapshot, engineering/contracts/jaira-layout, engineering/contracts/sqlite-schema, engineering/contracts/storage-files]
---

# Task file

A task's metadata file holds what the task is: its name, the workflow it runs, the inputs it runs with, its branch, and where it came from.

## A caller reads the file for what a task is, and the runtime row for how it stands

**Use when.** Reading or editing a task's title, workflow, inputs, branch or provenance; finding the tasks a fan-out made or a task depends on.

**Do not use when.** Reading status, the pinned snapshot, the worktree, timing, outputs or failure. Those are the `task_runtime` row, in [sqlite-schema](sqlite-schema.md), which is also the index of which tasks exist.

## The shape is one JSON object per task, named by its id

The file is `.jaira/system/tasks/<taskId>.json` in a project and `system/tasks/<taskId>.json` under the shared root. It is UTF-8 JSON, indented two spaces, ended by a newline, written without a byte order mark and read with or without one.

### The four required fields are the only ones a reader checks

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | the task's id, equal to the file name without `.json`; minted as `t-` and ten characters of `a-z0-9` |
| `title` | non-empty string | yes | the task's name; `task:rename` rewrites it, and a split rewrites it to its element's title |
| `workflow` | non-empty string | yes | the root state id the task runs |
| `createdAt` | string, ISO 8601 | yes | when the task was created |
| `description` | string | no | free text |
| `labels` | string array | no | free labels; `jaira run` writes `["adhoc"]` |
| `inputs` | object of JSON values | no | the root inputs, fixed at creation and bound as the run's inputs; an input owed by a source task is absent until the task starts |
| `inputProvenance` | object of `{via, confidence?, from?}` | no | per input name, how it was settled: `via` is `bound`, `inferred` or `asked`; `confidence` is a conversation's; `from` is `{taskId, output?, input?}`, the task a bound value came from |
| `branch` | string | no | the branch a worktree is cut for; refused at creation on the shared root |
| `parentTaskId` | string | no | the task this one reran, was forked from, was made by in a fan-out, or was adopted by |
| `origin` | object | no | how a fan-out made the task, or which task adopted it |
| `split` | array of `{expr: string, index: number}` | no | one entry per `each: "split"` list the task is split on: the wire's expression verbatim and this task's element index; omitted when empty |
| `dependsOn` | string array | no | ids of tasks that must complete before this one starts; omitted when empty |
| `connectUndo` | `{undo: ConnectUndo, landing: string[]}` | no | the Undo of the connect that last made or moved this task, kept so it survives a restart, and meaning only "take back what I just did". Every place in a journal it is measured from is a ROW, named by `undo.mark` — the connect's own `jaira.connect` rows ([journal-events](journal-events.md)): its `intent` row on the dragged task (where a move's Undo cuts; for an adoption, the ADOPTED task's place at the drop) and its `done` row on the watched journal (the moved task's, or the parent's), which closes the drop's own writes. Not a count of rows, which drifted when a retry deleted a row from before the drop, and not a seq, which a file-backed journal's replay re-mints. `landing` is `ConnectPlan.standsAt.path`. Written by `task:connect` (replacing an earlier one); removed by the next decision about the task — a connect or adoption of it, a rewind, fork or split, a stop, a re-run — and by `task:connectUndo`. Judged against the journal on every read, so a token the task has moved on from is neither offered nor used ([task-channels](task-channels.md)) |

### `origin` records the mount and element a fan-out made the task from

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `origin.kind` | `"split"`, `"task"` or `"adopt"` | yes | `split`: a copy of the parent standing at the mount; `task`: a fresh task rooted at the mounted state; `adopt`: a task that ran alone and was taken up afterwards ([adoption](../units/adoption.md)) |
| `origin.taskId` | string | yes | the task whose list made this one, or the task that adopted it |
| `origin.key` | string | yes | the mount's child key in that task |
| `origin.occurrence` | number | no | which entry of the mount made the batch; absent reads as 0 |
| `origin.index` | number | yes | the element's position in the list |
| `origin.item` | string | no | the element's own id, when the wire named an id field |
| `origin.start` | `"manual"` or `"when_ready"` | no | for a split, who starts the task once its dependencies complete; absent reads as `when_ready` |
| `origin.formerParentTaskId` | string | no | for an adoption, the `parentTaskId` the task had before, put back when it is un-adopted |

## Errors are thrown by every reader, and a list stops at the first bad file

| Condition | Response | Caller does |
| --- | --- | --- |
| The file does not exist | `tryRead` answers nothing, and a summary shows `(missing task file)`; `read` refuses `no task file for '<id>' in <dir>` | recreate the file or delete the task |
| The text is not JSON | `<path>: invalid JSON: <parser message>` | repair the file |
| The value is not an object | `task metadata must be a JSON object` | repair the file |
| `id`, `title` or `workflow` is missing, empty or not a string, or `createdAt` is not a string | `task metadata missing 'id'`, `'title'`, `'workflow' (root state id)` or `'createdAt'` | add the field |
| `id` differs from the file name | `task metadata id '<id>' does not match file name '<name>'` | make them agree |

## Adding an optional field is safe, and renaming a required one breaks every task

- A new optional field needs no migration: `parseTaskMeta` passes unknown fields through, and `task:rename` writes back the parsed object with only `title` changed, so an older build keeps a field it does not know.
- Renaming or retyping `id`, `title`, `workflow` or `createdAt` makes every existing file fail to parse, and with it every task list in the project.
- Changing `origin`, `split` or `dependsOn` breaks, for existing tasks, the fan-out host finding a task it already made, holding, board filing and the narrowing of a split task's later mounts.
- The file has no version field, so no change has a deprecation path.

## Only four fields are checked, and the file is not the index of tasks

- `description`, `labels`, `inputs`, `branch`, `parentTaskId`, `origin`, `split` and `dependsOn` are trusted as written. A wrong type from a hand edit fails where the field is used, not where the file is read.
- A file with no `task_runtime` row is never listed, because task lists walk rows. `releaseDependents` does walk the files, so one unparseable file makes any run that completes in that project record `failed`.
- The file is written in place with `writeFileSync`. A process killed mid-write leaves truncated JSON that fails every list in the project.
- The file is written in every storage mode. `storage.tasks` moves only the `task_runtime` rows into files.
- `parentTaskId` is copied onto `task_runtime.parent_task_id` at creation only, and a fork's origin label reads the row, so editing the file does not move the label.
- A `dependsOn` id with no row is not waited for.
- A summary's `createdAt` comes from the file, while `task:list` order comes from the row's `created_at`.
- A task that splits rewrites its own `split`, `title` and `dependsOn` once per list, while it runs.
- An adoption rewrites the adopted task's `parentTaskId` and `origin`, and a rewind of the parent past the mirror row removes them again. `worktrees.ts` reads `origin.kind: "task"` alone, so an adopted task keeps its own workspace.
- `inputProvenance` is written at creation and when an owed input is read. A file without it projects a fan-out-made task's inputs as `bound` and any other's as `asked`.
