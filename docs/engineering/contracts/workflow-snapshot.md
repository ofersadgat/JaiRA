---
id: engineering/contracts/workflow-snapshot
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: format
owned_by: [engineering/units/workflow-snapshots]
consumers: ["@jaira/persistence lifecycle.ts beginTaskRun", "@jaira/persistence views.ts bundleFor and stateViews.ts", "@jaira/app main service.ts resumeTask and resumable", "@jaira/cli task start", "git, where a project commits its snapshots"]
since: 2026-07-17
siblings: [engineering/contracts/task-file, engineering/contracts/jaira-layout, engineering/contracts/journal-events]
---

# Workflow snapshot

A snapshot is the directory holding the resolved workflow a task was pinned to at its first start, named by the hash of what it holds.

## A caller reads the snapshot for what a task runs, and the live files only before one is pinned

**Use when.** Executing, resuming or displaying a task that has a `task_runtime.snapshot_hash`, or reading a state as a given task ran it.

**Do not use when.** Reading or editing a workflow as authored: the live `workflows/` layers, through [workflow-browser](../units/workflow-browser.md). Deciding when a task pins a snapshot: [task-lifecycle](../units/task-lifecycle.md).

## The shape is a directory of resolved states and one metadata file

### The directory is named by the hash and holds one file per state

The directory is `.jaira/system/snapshots/<hash>/` in a project and `system/snapshots/<hash>/` under the shared root. Every JSON file is indented two spaces and ended by a newline.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `<hash>/` | directory | yes | one resolved workflow; `<hash>` is `snapshotHash` of the bundle |
| `<stateId>.json` | JSON object | one per state whose id is a bare path | the resolved `LoadedState` without its `id`; each `/` in the id is a subdirectory |
| `_external/<16 hex>.json` | JSON object | one per state whose id is not a bare path | the same, named by the first 16 hex digits of the SHA-256 of the state id |
| `_modules/<16 hex>.cjs` | UTF-8 text | when the workflow reaches js/ts modules | one module's transpiled CommonJS, named by the first 16 hex digits of the SHA-256 of its source path |
| `.meta.json` | JSON object | yes | the metadata below |

### `.meta.json` names the root and maps back what a file name cannot hold

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `rootId` | string | yes | the root state id |
| `hash` | string | yes | the directory's name |
| `ids` | object of snapshot-relative path without `.json` to state id | no | present only for ids whose file path is not the id |
| `moduleDigest` | string | no | the digest of every frozen module; present only when the workflow reaches one |
| `modules` | object of source path to file name in `_modules` | no | present only when modules were frozen |

### The hash covers the root, the states and the module digest, and nothing else

`snapshotHash` in `@declarative-ai/hw` `loader.ts` is the SHA-256 hex of the canonical JSON of the root id, each state's canonical hash without its `id` sorted by state id, and `moduleDigest` under `modules` when present. The file layout, `ids`, the `modules` map and the `.cjs` files are outside it.

### A snapshot being written stands beside the others under a staging name

`ensureSnapshot` writes into `snapshots/.staging-<hash>-<pid>/` and renames it to `<hash>/`, retrying a refused rename after 20, 40, 80 and 160 ms and stopping as soon as `<hash>/` exists.

## Errors refuse the start or the resume that needed the snapshot

| Condition | Response | Caller does |
| --- | --- | --- |
| `<hash>/.meta.json` does not exist | `loadSnapshot` refuses `snapshot '<hash>' not found under <dir>` | rerun the task as a new task |
| The files hash to something else | `snapshot '<hash>' is corrupt: contents hash to <actual>` | restore the directory from version control, or rerun as a new task |
| A file is not JSON | `<path>: invalid JSON: <parser message>` | restore the file |
| A bare state id has an empty, `.` or `..` segment | `ensureSnapshot` refuses `state id '<id>' is not a safe relative path` | rename the state |
| The rename is still refused after the last retry | the rename's own error, with the staging directory removed | start again |

## A change to the hash or the layout strands every pinned task, and there is no deprecation path

- Changing what `snapshotHash` covers or how it canonicalizes makes every existing directory fail its load as corrupt, so no pinned task can start or resume. `moduleDigest` was added by leaving the key out when absent, which kept every older hash.
- Renaming `.meta.json` or `_external`, or changing how a state id maps to its file, breaks loading every existing snapshot.
- The directory has no version field.

## The snapshot fixes meaning, not every byte beside it, and a missing one fails loudly in some places only

- The `.cjs` files are not what a pinned run executes. `snapshotModules` has no caller, and a run resolves its module functions from the files on disk through `resolveUserFunctions`. An edited `.cjs` changes nothing and fails no check.
- `ensureSnapshot` trusts an existing `<hash>/` without reading it, so a damaged directory is pinned by new tasks and fails only when one of them is loaded from disk.
- `bundleFor` in `views.ts` catches a missing or corrupt snapshot and draws from the live files. `resumable` does not catch, so `task:detail` for a startable task with history throws.
- Identical resolved workflows share one directory across tasks, and nothing deletes a snapshot: task deletion and pruning leave it.
- A staging directory left by a killed process stays until a process with the same pid writes the same hash again.
- An out-of-tree state id is an absolute path, so a snapshot holding one names a path on the machine that pinned it, in `ids` and in its hash.
