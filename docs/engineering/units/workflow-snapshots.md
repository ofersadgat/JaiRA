---
id: engineering/units/workflow-snapshots
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/work-runs-the-process-it-started-with]
layer: data
owns_contracts: [engineering/contracts/workflow-snapshot]
requires: []
implemented_by: [packages/persistence/src/snapshots.ts]
verified_by: [packages/persistence/test/snapshots.test.ts, packages/persistence/test/workflowRefs.test.ts, packages/persistence/test/builtInLayer.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/module-approvals, engineering/units/workflow-browser, engineering/units/board-projection]
---

# Workflow snapshots

## Snapshots store the resolved workflow a task runs under its content hash, and leave what goes in and when to others

`snapshots.ts` owns one directory per workflow version under `system/snapshots/`:

- `ensureSnapshot(snapshotsDir, bundle, {modules})` names the directory with upstream `snapshotHash(bundle)` and returns `{created: false}` when it already exists. Otherwise it stages the snapshot in `.staging-<hash>-<pid>`: each resolved state without its `id` as `<stateId>.json`, a state whose id is not bare under `_external/<16 hex>.json`, each frozen module's emitted CommonJS under `_modules/<16 hex>.cjs`, and `.meta.json` with `rootId`, `hash` and, when present, `ids`, `moduleDigest` and `modules`. It then renames the staging directory into place, retrying a refused rename.
- `loadSnapshot(snapshotsDir, hash)` reads `.meta.json`, reads every `.json` file except the meta file and the root `_modules/`, restores each state's canonical id, puts `moduleDigest` back on the bundle, and refuses the snapshot unless it hashes to its own name.
- `snapshotModules(snapshotsDir, hash)` returns the frozen emit by source path. Nothing calls it, so no run executes the stored emit.
- `readWorkflowFiles(workflowsDir, {onError})`, `readStateDocument`, `isStateFile` and `STATE_SUFFIXES` read authored `.json`, `.yaml` and `.yml` state files through upstream `parseReferencedFile`, skipping dotfiles, for the loads that build a bundle from `workflows/`.

The directory layout and meta fields are [workflow-snapshot](../contracts/workflow-snapshot.md).

### A snapshot's closure spans all three layers, and records none of them

A bundle is resolved along the project's `.jaira/`, the shared root and the built-in layer `$SYSTEM` ([project-layout](project-layout.md), [decision 0006](../decisions/0006-built-in-layer.md)), and a snapshot stores the result: each resolved state, with every document it transcluded already spliced in, and each frozen module's emit. Which layer supplied a file is not stored, because nothing reads a layer again once a task is pinned. So a state, a prompt or a `.ts` function that came from the built-in layer is copied like any other, and an app upgrade that changes or removes the shipped file does not change a task that already started. A module under the built-in layer is frozen without an approval: [module-approvals](module-approvals.md).

It deliberately does not own:

- When a task is pinned and to which bundle: `beginTaskRun` in [task-lifecycle](task-lifecycle.md), which loads the pinned snapshot for a task that has one and snapshots a freshly loaded bundle otherwise.
- Producing the resolved bundle: upstream `loadBundle` with the load options from [workflow-browser](workflow-browser.md).
- Approving and freezing js/ts modules and computing `moduleDigest`: [module-approvals](module-approvals.md).
- Falling back to live files when a snapshot will not load: `bundleFor` in [board-projection](board-projection.md).

## Snapshots sit in the data layer on the workflow and run boundary, and call only upstream's hash

- Layer `data`, package `@jaira/persistence`. It calls `node:fs` and upstream `snapshotHash`, `isBareStateId` and `parseReferencedFile` from `@declarative-ai/hw`.
- Upstream seam: `WorkflowBundle` and `snapshotHash`. The hash covers `rootId` and every resolved state, plus `moduleDigest` only when the bundle has one.
- Boundary: workflow and run. A pinned task's bundle is read from its snapshot by `beginTaskRun`, by the app's resume and resume plan in `service.ts`, and by `jaira` resume in `cli.ts`, never from `workflows/`.
- Boundary: derived and committed. The `.gitignore` JaiRA writes does not ignore `system/snapshots/`, so a snapshot can be committed, and identical content yields an identical directory on any machine.

## The directory is the truth, and a task row only names it

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `system/snapshots/<hash>/` state files and `.meta.json` | written once by `ensureSnapshot`; read by `loadSnapshot` | the directory | `task_runtime.snapshot_hash` names it; `forkTask` gives the copy the parent's hash |
| `system/snapshots/<hash>/_modules/*.cjs` | written once by `ensureSnapshot` | the directory | read by nothing |
| `system/snapshots/.staging-<hash>-<pid>/` | created, then renamed or removed, by `ensureSnapshot` | none | left behind by a write the process died in |

## The invariants keep a pinned task's workflow exactly what it started with

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A loaded snapshot hashes to its directory name | `snapshots.test.ts` "writes a content-addressed snapshot and loads it back to the same hash" |
| 2 | A snapshot whose files changed after the write is refused as corrupt, and an unknown hash as not found | `snapshots.test.ts` "detects a corrupted snapshot on load" |
| 3 | Identical workflow versions share one directory | `snapshots.test.ts` "deduplicates identical workflow versions across tasks" |
| 4 | An authored `id` equal to its key is stripped on write and does not change the hash | `snapshots.test.ts` "an authored matching id does not change the hash and is stripped on write" |
| 5 | The final directory name never holds a partial snapshot | unasserted |
| 6 | A refused rename is retried, a concurrent writer's identical snapshot ends the wait, and a final failure reports the rename's own error | `snapshots.test.ts` "retries, and the snapshot lands once the handle closes", "stops as soon as a concurrent writer's identical snapshot appears", "gives up with the rename's own error, not a cleanup failure" |
| 7 | An out-of-tree state round-trips under its canonical id | `workflowRefs.test.ts` "round-trips an out-of-tree state through a snapshot" |
| 8 | Editing a referenced document after a task started does not change what it runs, and a different document gives a different hash | `workflowRefs.test.ts` "pins the referenced file, so editing it cannot change a started task", "gives a different hash when a referenced file differs" |
| 8a | What the built-in layer supplied is copied like any other layer's, so a pinned task keeps it when the shipped file changes, disappears, or the whole layer does | `builtInLayer.test.ts` "copies what the layer supplied into the snapshot — state, child and fragment", "survives the layer vanishing altogether", "runs a shipped `.ts` function nobody approved, and freezes it into the snapshot" |
| 9 | A state id with an empty, `.` or `..` segment is never written as a path | unasserted |
| 10 | The workflow walk reads nested state files and skips dotfiles | `snapshots.test.ts` "readWorkflowFiles walks nested state files and skips dotfiles" |

## A snapshot either lands whole or not at all, and one that will not load stops the task rather than running something else

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed mid-write | the content-addressed name never exists half-written; `.staging-<hash>-<pid>` is left, and only a later write of the same hash by the same pid clears it | delete the staging directory by hand | none |
| Windows keeps a handle open inside the staging directory past the last retry | the staging directory is removed and the rename's error is thrown | start again | the task start fails with the rename error |
| Two processes write the same snapshot at once | the loser's rename fails, it finds the directory and discards its staging | none needed | none |
| The same snapshot is ensured again, as by a second task on an unchanged workflow | `created: false`, nothing is written | none needed | none |
| A reader loads a snapshot while it is being written | the directory is either absent or whole, because it appears by rename | none needed | none |
| A snapshot is missing or its files were edited | `loadSnapshot` refuses with `snapshot '<hash>' not found under <dir>` or `snapshot '<hash>' is corrupt: contents hash to <actual>`; `bundleFor` swallows it and draws from live `workflows/` | re-run the work as a new task | start and resume are refused; the board is drawn from the current workflow |
| A `_modules/*.cjs` file is edited after pinning | nothing detects it, because the hash covers `moduleDigest` and not the emit, and nothing reads the emit | none needed | none |
| `readWorkflowFiles` meets an unreadable state file | with `onError` the file is skipped and reported to it; without, the read throws | fix the file | depends on the caller; `beginTaskRun` lists unreadable files only when the load then fails |

## Old snapshots keep their identity, and a change to the hash is the one thing that breaks them

- `moduleDigest` is left out of the hashed document when a workflow reaches no module, so every snapshot taken before modules existed keeps its hash.
- A snapshot stores the loader's output, so a change to what the loader lowers to gives new pins a new hash while old snapshots still load, since loading runs no loader.
- A change to upstream `snapshotHash` itself makes every existing snapshot load as corrupt. Nothing migrates, and no rollback exists.

## Budgets are the rename retries

- A refused rename is retried after 20, 40, 80 and 160 ms: `COMMIT_BACKOFF_MS` in `snapshots.ts`.
- Removing a staging directory retries 5 times, 20 ms apart: `discardStaging` in `snapshots.ts`.
