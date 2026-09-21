---
id: engineering/units/workflow-snapshots
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/work-runs-the-process-it-started-with]
layer: data
owns_contracts: [engineering/contracts/workflow-snapshot]
requires: []
implemented_by: [packages/persistence/src/snapshots.ts, packages/persistence/src/documents.ts, packages/persistence/src/dynamicWorkflow.ts, packages/persistence/src/dynamicDocuments.ts]
verified_by: [packages/persistence/test/snapshots.test.ts, packages/persistence/test/workflowRefs.test.ts, packages/persistence/test/builtInLayer.test.ts, packages/persistence/test/documents.test.ts, packages/persistence/test/dynamicWorkflow.test.ts, packages/app/test/dynamicDocument.test.ts]
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

### A frozen document is the one snapshot-backed thing that changes, by gaining versions

A snapshot stays immutable. `documents.ts` adds a document: an identity outside any task, and an ordered list of versions, each an ordinary snapshot directory ([decision 0005](../decisions/0005-connect.md) §3).

- `createDocument` and `appendVersion` write `system/snapshots/_documents/<id>.json` whole, through a staging file and a rename. `appendVersion` takes the version the caller generated from and refuses a document that has moved past it; a version whose snapshot is the latest one's is not appended.
- `currentPin(project, row)` is the one place "a task picks up the latest version" is decided: the document's latest version for a task with `task_runtime.document_id`, else the snapshot the task pinned. `beginTaskRun` pins what it returns, and `loadPinnedBundle` is what `resumeTask`, `resumable`, `moveTask` and the CLI's resume fold the journal against.
- `recordVersionPickUp` writes the `workflow.version` row ([journal-events](../contracts/journal-events.md)) when the version a task loads under differs from the one it last ran under. `pinAt`, `versionAt` and `bundleAt` read it back: the version a given journal row ran under.
- `rewindTask` puts a task back under the version current at its cut, and behind the row that moved it into a document, back under the snapshot it had before, in no document. `forkTask` starts the copy under the same answer, in the same document.

### The generator writes a dynamic workflow from schemas, and the host freezes it as a version

`generateDynamicWorkflow` in `dynamicWorkflow.ts` is pure. Given the producers (children of the document that ended well for the task being moved, nearest first), a target state's declared inputs and the values a caller supplied, it returns the authored root, what it added, and what it could not settle.

- A target input is wired to a producer output whose declared schema fits it (`isSubschema`, kinds agreeing). Whole fits come before element fits, the nearest producer that has any decides, and within it the only fit, or the only fit that holds both ways, is taken. Anything else is returned `ambiguous` with its candidates; an input nothing fits is returned `no-fit` with its schema. No slot is read by name.
- A list output whose item schema fits makes the mount `{ "$expr": …, "each": "split", "start": "manual" }`. A target that takes the list fits it whole and is a plain mount. One mount splits on one list; an element of a second list is returned `second-list`.
- A supplied value is stored as `{ "json": …, "provenance": … }` and wins over a wire. While a required input is open nothing is generated.
- Every rule is `{ "when": "on_user_event('task_move', { to_state: '<key>' })", "to": "<key>", "standing": true }`.
- A new document is the conversation state's authored document with `children`, `sequence: []` and the rules; what already ran is mounted first, with the inputs its task recorded as `recorded` literals. An existing document is appended to, and no child or rule already in it is rewritten. A target the document already mounts and offers adds nothing.

`generateDocumentVersion` in `dynamicDocuments.ts` is the host half, with these resolutions:

| Resolution | When | What is written |
| --- | --- | --- |
| `new` | the task is in no document and finished well, or `mode: "new"` | a `dynamic` document whose version 1 mounts the task's root state and the target. The task is not touched; joining it to the document is adoption's |
| `augmented` | the task names a document | the next version of that document, for every task standing in it |
| `cloned` | the task is in no document and stands inside its workflow, or `mode: "clone"` | a `diverged` document whose version 1 is the task's frozen copy with the mount and the rule grafted onto its root, and `task_runtime.document_id` on the task |
| `existing`, `unsettled` | the document already offers the move; a required input is open | nothing |

A version's bundle is built by `loadWorkflowBundle` over the live layers plus the authored root, and then every state the previous version held, or the task's own snapshot for a new document, is put back as it was frozen; only the root differs. A diverged root is a resolved state and cannot be loaded again, so its additions are lowered by the loader in a scaffold root mounting the same child keys, and the lowered mount and rules are moved onto the frozen root with `fanOut` recomputed. The result is validated with `validateBundle` strict and refused as a generator bug on any error, then frozen by `snapshotWithModules`.

`saveDocumentAsWorkflow` writes a dynamic document's latest authored root to `<layer>/workflows/<as>.json`. It refuses the `system` layer through `isWritableLayer`, an id with an unsafe segment or under `dynamic/`, an existing file without `overwrite`, and a diverged document, which has no authored root.

It deliberately does not own:

- Deciding that a move needs a document, settling inputs with a person, adopting a task into a document, and publishing the `task_move`: `connect` ([decision 0005](../decisions/0005-connect.md) steps 3, 5 and 6).
- Grafting the control operation onto a diverged root. A loaded instance whose state has an operation it never ran dispatches it, so the document records `conversation` and the root keeps what it had until the conversation states ship.
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
| `system/snapshots/_documents/<id>.json` | written by `createDocument` and `appendVersion`; read by `readDocument` | the file | `task_runtime.document_id` names it |
| `task_runtime.document_id` | written by `createTask`, by `generateDocumentVersion` on a clone, and by `rewindTask` and `forkTask` through `setPin` and `stampFork` | the row | read by `currentPin` |
| `workflow.version` journal rows | written by `beginTaskRun` | the journal | read by `pinAt`; dropped by a cut like any row |

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
| 11 | A generated document validates with no error: new, augmented, cloned, with a split, with a literal | `documents.test.ts` "makes a conversation with children, wired by schema fit, that lints clean and is frozen as version 1", "generates `each: split`, held, when the target takes one element of a list the source produced", "clones the task's frozen copy: diverged, the child and the rule grafted on, everything that was there as it was" |
| 12 | A saved document lints as an authored workflow does, through the workflow browser | `documents.test.ts` "writes the latest version into a layer's workflows/, where it lints exactly as an authored workflow does" |
| 13 | Every generated rule is a standing `task_move` | `dynamicWorkflow.test.ts` "writes every rule as a standing task_move, and nothing else" |
| 14 | A new version rewrites no child and no rule already there, and carries every state that was frozen as it was frozen | `documents.test.ts` "augments: a new version appended after what has run, the children that were there untouched", "carries the state that RAN into the document as it was frozen, whatever the live file says now" |
| 15 | A task loads under its document's latest version, its journal says where, and the same holds for every task in the document | `documents.test.ts` "a task picks up the latest version the next time it loads, and its journal says where", "changes the document for EVERY task standing in it"; `dynamicDocument.test.ts` |
| 16 | A row reads against the version it ran under after the document moved on | `documents.test.ts` "keeps history valid: a row reads against the version it ran under after the document moved on" |
| 17 | A rewound task stands under the version current at its cut, a fork's copy likewise, and a cut behind a divergence un-diverges | `documents.test.ts` "rewinds the task back under the version that was current at the cut; the next load picks the latest up again", "forks a copy into the same document, under the version current at ITS cut", "is picked up on the next load, and a rewind behind the divergence un-diverges" |
| 18 | An input nothing fits is returned with its schema and nothing is written | `documents.test.ts` "returns what it cannot settle, with the schema, and writes nothing — then takes the value as a literal with provenance" |

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
| Two modifications of one document race | the second `appendVersion` finds a later version than it generated from and refuses | generate it again | the move is refused with the reason |
| A required input of the target fits nothing and nobody supplied it | `resolution: "unsettled"`, nothing written | supply the value and generate again | what `connect` refuses or asks with |
| A task's document file is missing | `currentPin` refuses, so start, resume and move refuse | restore the file | the start fails with the reason |

## Old snapshots keep their identity, and a change to the hash is the one thing that breaks them

- `moduleDigest` is left out of the hashed document when a workflow reaches no module, so every snapshot taken before modules existed keeps its hash.
- A snapshot stores the loader's output, so a change to what the loader lowers to gives new pins a new hash while old snapshots still load, since loading runs no loader.
- A change to upstream `snapshotHash` itself makes every existing snapshot load as corrupt. Nothing migrates, and no rollback exists.

## Budgets are the rename retries

- A refused rename is retried after 20, 40, 80 and 160 ms: `COMMIT_BACKOFF_MS` in `snapshots.ts`.
- Removing a staging directory retries 5 times, 20 ms apart: `discardStaging` in `snapshots.ts`.
