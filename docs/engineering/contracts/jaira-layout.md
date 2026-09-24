---
id: engineering/contracts/jaira-layout
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/project-layout, engineering/units/project-store]
consumers: ["@jaira/persistence project.ts and every store it opens", "@jaira/app main service.ts and diagnostics.ts", "@jaira/runtime artifactPath.ts and secrets.ts", "@jaira/cli", "the renderer's Files view, through hiddenPaths.ts", "people and git working in a checkout or the shared root"]
since: 2026-07-17
siblings: [engineering/contracts/task-file, engineering/contracts/workflow-snapshot, engineering/contracts/settings-json, engineering/contracts/storage-files]
---

# JaiRA layout

The JaiRA layout is where a project's `.jaira/` and the shared root keep what a person authors and what JaiRA generates, which of those git ignores, and where a task's worktree goes.

## A caller reaches for the layout to locate a file, and always through the path builders

**Use when.** Locating anything JaiRA reads or writes in a project, in the shared root or beside a project for its worktrees. Deciding what a repository commits. Code gets every path from `jairaPaths`, `jairaBasePaths` or `baseAsProjectPaths` in [project-layout](../units/project-layout.md).

**Do not use when.** Reading what a file holds: each row links the contract that owns its content. Resolving a bare state id or a `$/` fragment to a file: [workflow-browser](../units/workflow-browser.md).

## The shape is two roots of one shape, a line drawn by system/, and worktrees outside both

### The roots are the project's .jaira and the shared root, searched in that order

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `<project>/.jaira/` | directory | yes | the project's layer; a directory without it is not a project |
| shared root | directory | yes | `--home <dir>`, then `JAIRA_HOME`, then `baseDir` in the shared root's `user-settings.json` as the app reads it, then `~/.jaira`; the CLI does not read the saved `baseDir` |
| built-in layer | directory | no | what JaiRA ships, `$SYSTEM` in a reference: `workflows/`, `prompts/`, `functions/` and `permission-sets/`, read-only, with no `system/` and no settings. Found by `defaultBuiltInDir`: [project-layout](../units/project-layout.md). Absent reads as empty |
| layer roots | ordered list | yes | `[<project>/.jaira, <shared root>, <built-in layer>]`, deduplicated; the shared root opened as a project has itself and then the built-in layer |
| state search path | ordered list | yes | `<root>/workflows` then `<root>/functions` for each layer root in order; `workflows.path` replaces every entry but the built-in layer's two, which stay last |

The shared root has no `.jaira/` inside it, and the built-in layer is not a root a person owns: nothing below is ever written into it. Every path below is relative to a layer root, so `system/` is `<project>/.jaira/system/` in a project and `<shared root>/system/` in the shared root.

### Beside system/ is what a person authors

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `settings.json` | JSON file | no | how runs execute, layered project over shared: [settings-json](settings-json.md); `init` writes the project's |
| `workflows/**/*.json`, `*.yaml`, `*.yml` | state files | no | state documents; the path under `workflows/` without its suffix is the state id |
| `workflows/**/*.md` | markdown | no | descriptions: `workflows/<root>.md` describes a root and `workflows/workflow.md` the whole layer: [description-sync](../units/description-sync.md) |
| `functions/` | directory | no | operation documents and JavaScript or TypeScript modules; searched after `workflows/`; created only in the shared root |
| `prompts/` | directory | no | prompt fragments referenced as `$/prompts/<name>.md`; never created |
| `skills/` | directory | no | skills; created in both roots |
| `.env`, `.env.local` | dotenv files | no | links of the secret chain: [secret-sources](secret-sources.md) |
| `user-settings.json` | JSON file | no | the window's own state (panes, folds, read marks, the log policy), in the shared root only: [user-settings-json](user-settings-json.md) |
| `personal-settings.json` | JSON file | no | the fourth settings layer, "Just you": `settings.json`'s schema, read after the project's, in the shared root only: [settings-json](settings-json.md) |
| `.gitignore` | text file | yes | written when absent, by `initProject` in a project and by `initBase` at every open in the shared root; patterns below |

### Inside system/ is what JaiRA generates

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `system/jaira.db`, `-wal`, `-shm` | SQLite | yes | the database, created at open: [sqlite-schema](sqlite-schema.md) |
| `system/tasks/<taskId>.json` | JSON file | directory yes | one task's metadata: [task-file](task-file.md) |
| `system/snapshots/<hash>/` | directory | directory yes | one pinned workflow: [workflow-snapshot](workflow-snapshot.md) |
| `system/journal/<taskId>/journal.jsonl` | JSONL | when `storage.journal` is file-backed | the task's journal: [journal-events](journal-events.md) |
| `system/conversations/<taskId>/conversations.jsonl` | JSONL | when `storage.conversations` is file-backed | the task's records and positions: [storage-files](storage-files.md) |
| `system/taskRows/<taskId>.jsonl`, `system/artifactRows/<taskId>.jsonl` | JSONL | when `storage.tasks` or `storage.artifacts` is file-backed | runtime rows and the artifact map: [storage-files](storage-files.md) |
| `system/artifacts/<taskId>/` | directory | no | where `$CENTRAL` and `$CENTRAL_FLAT` put artifact bytes, through `$SYSTEM/$ARTIFACT_DIR` with `artifacts.dir` defaulting to `artifacts`: [artifact-destination-template](artifact-destination-template.md) |
| `system/sync.json` | JSON file | no | the last agreed state of each description: [sync-record](sync-record.md) |
| `system/limits.json` | JSON file | shared root only | `{version: 1, accounts: {<account>: LimitState}}`: what the limits board last knew about each account's allowance, so a restart starts from it ([usage-readings](usage-readings.md)) |
| `system/waiting.json` | JSON file | shared root only | `{version: 1, items: WaitingItem[]}`: messages and runs waiting for an account's allowance, re-armed at start |
| `system/logs/jaira-<utc date>.log` | JSONL | no | the app's diagnostics, one entry per line and one file per UTC day, written under the shared root only |
| `system/machine.key` | text file | shared root, once approvals are used | the approval HMAC key as `dpapi:<base64>` or `plain:<hex>`, written with mode `0600` |

### A task's worktree sits beside the project, never inside it

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `<parent of project>/.jaira-worktrees/<project basename>/<taskId>/` | git worktree | for a task bound to a branch | the task's working copy; `task_runtime.worktree_path` records it and wins over the computed path |

### The ignore template names what stays out, and everything else in system/ is committable

The template holds these patterns and comments:

```
system/jaira.db
system/jaira.db-wal
system/jaira.db-shm
system/logs/
system/machine.key
.env.local
```

### The Files tree hides JaiRA's own state, configuration, secrets and build output by default

`DEFAULT_HIDDEN_PATHS` always applies first; each layer's `files.hidden` is appended after it, weakest first — Shared, this project, then the personal layer's — the last match winning, so `!pattern` in a later list puts a default back. Patterns are globs relative to the tree's root and a bare name matches only at that root. The groups are the Files tree section's folds ([settings-json](settings-json.md)).

```
system
.jaira/system
settings.json
.jaira/settings.json
user-settings.json
personal-settings.json
sync.json
personal-settings.json
**/.env
**/.env.*
.git
**/node_modules
**/vendor
**/__pycache__
**/dist
**/out
**/target
**/coverage
```

## Errors come from opening a root, and a missing file is otherwise read as absent

| Condition | Response | Caller does |
| --- | --- | --- |
| A directory has no `.jaira/` | `openProject` refuses `<dir> is not a JaiRA project (no .jaira/ — run 'jaira init')` | run `jaira init` or open another directory |
| A task on the shared root names a branch | `createTask` refuses `a shared task cannot be bound to a branch — the shared root is not a checkout` | create the task without a branch |
| `JAIRA_HOME` is unset under `VITEST` | `defaultBaseDir` throws, naming how to run the suite | run the tests from the repository root |
| `--home` has no value | the CLI exits 2 with `--home needs a directory`; the app ignores the flag | pass a directory |
| A generated directory is missing | `system/tasks/` and `system/snapshots/` are created again at open, and the rest when first written | nothing |

## Moving any path strands the history at the old one, and no path has a deprecation path

- No code moves files between layouts. The move of generated files under `system/` on 2026-08-24 left a root with `jaira.db`, `tasks/` or `snapshots/` at its top opening with no history.
- Renaming `.jaira`, `system` or a file name breaks the `.gitignore` of every existing root, which is written only when absent. The one line back-filled into an existing file is `system/machine.key`.
- Renaming `.jaira-worktrees` leaves existing worktrees in place, because each task's recorded `worktree_path` is used.

## Committable is not the same as listed, and several paths are computed and never used

- Everything under `system/` except the database, logs and machine key is committable, snapshots and artifacts included. A task file that arrives by a pull without its runtime row is not listed: [task-file](task-file.md).
- The `.gitignore` sits inside the layer root, so its `.env.local` line does not cover the checkout's own `.env.local`, which the secret chain also reads.
- The default artifact destination `$DEFAULT` is `$WORKTREE/$RELPATH`, so nothing lands under `system/artifacts/` unless a destination names `$CENTRAL`, `$CENTRAL_FLAT` or `$SYSTEM`.
- A project's `system/logs/` is computed and never written; the app logs under the shared root.
- The shared root opened as a project computes `worktreesDir` as `<shared root>/.jaira-worktrees`, and nothing uses it because its tasks are refused a branch.
- A project's key is its real path lower-cased on Windows, so two spellings of one directory open one project, and on a case-sensitive filesystem two spellings that differ by case are two projects.
- `DEFAULT_HIDDEN_PATHS` names `system` and `.jaira/system` separately because a project's tree is rooted at the checkout and the shared root's tree at the root itself.
