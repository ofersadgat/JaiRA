---
id: engineering/units/description-sync
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/keep-process-and-description-in-step, product/review-changes-before-they-land, ux/patterns/unsaved-proposal, ux/patterns/per-change-review, ui/components/workflow-sync-panel]
layer: service
owns_contracts: [engineering/contracts/sync-record, engineering/contracts/workflow-sync-channels]
requires: [engineering/units/changesets, engineering/units/workflow-browser, engineering/units/task-lifecycle, engineering/units/project-sessions, engineering/units/host-tools, engineering/units/task-worktrees, engineering/units/board-projection, engineering/units/drafts, engineering/units/app-log]
implemented_by: [packages/persistence/src/descriptions.ts, packages/persistence/src/workflowSync.ts, packages/persistence/src/digest.ts, packages/runtime/src/conformanceWorkflow.ts, packages/runtime/src/syncWorkflow.ts, packages/app/src/main/service.ts, packages/app/src/main/session.ts, packages/app/src/renderer/syncState.ts, packages/app/src/renderer/store.ts]
verified_by: [packages/persistence/test/descriptions.test.ts, packages/persistence/test/workflowSync.test.ts, packages/persistence/test/digest.test.ts, packages/runtime/test/syncWorkflow.test.ts, packages/app/test/workflowSync.test.ts, packages/app/test/reviewSync.test.ts, packages/app/test/reviewChanges.test.ts, packages/app/test/syncState.test.ts, packages/cli/test/workflowCheck.test.ts]
siblings: [engineering/units/workflow-authoring, engineering/units/workflow-browser, engineering/units/changesets, engineering/units/drafts]
---

# Description sync

## The unit keeps a workflow description and the states it owns in step, from ownership and baseline to the check, the sync runs and their review

In `@jaira/persistence`, pure over files:

- `descriptions.ts`: `listDescriptions` finds every markdown file under a layer's `workflows/`. `ownershipOf(document, descriptions, states)` gives each state to the nearest description at or above it, with `workflows/workflow.md` owning what nothing nearer claims, and names the description's direct `delegates`.
- `workflowSync.ts`: `hashText` hashes text with CRLF folded to LF and trailing whitespace at the end dropped. `stateHashes` hashes `.json`, `.jsonc`, `.yaml` and `.yml` files. `syncDrift` says which side moved since the baseline and suggests the side to rewrite only when exactly one did. `readSyncRecord` and `commitSync` read and write [sync-record](../contracts/sync-record.md).
- `digest.ts`: `digestSource` and `workflowDigest` render a layer's workflows as one markdown document. Each state gets a `resolved:` line and its authored file clipped at `maxStateChars`; an unloadable root is rendered from its files under a `DOES NOT LOAD` heading; a delegated state is rendered as its contract with the owning description's prose. `files` lists the authored-layer state files covered, minus delegated ones.

In `@jaira/runtime`, the workflows:

- `conformanceWorkflow.ts`: `workflow/conformance` runs the prompt states `requirements` then `assessment`. `conformanceReportOf` parses a report and throws on a malformed one; `verdictOfFindings` recomputes the verdict from its `findings`.
- `syncWorkflow.ts`: `workflow/sync/document` mounts both check states and then `revision`, which returns the rewritten description as a plain string. `workflow/sync/states` mounts them and then `edits`, which returns whole files under `workflows/` or `prompts/`. Every state inherits the lowered form of the permission set map `SYNC_PERMISSION_SET`, `{read_file, glob, grep: "allow", other: "deny"}`: `tools: ["read_file", "glob", "grep"]` and a `permissions` block that allows those three, sets `other` to `deny` and carries the marks of a lowered map, so a run reads it as a map and not as the legacy list; it carries no profile. `syncOutcomeOf` parses a run's outputs, `syncRespondPrompt(spec)` is the review loop's respond prompt with `{{` in the description widened to `{ {`, and `syncRules` and `conformanceRules` script fake runs by matching prompt sentences.

In `AppService`:

- `syncStatus` answers a description's `WorkflowSyncStatus`: a blocked reason, drift over the files it owns, delegated subtrees and a pending proposal.
- `runSync` refuses a second sync on the same holder, digests the description's scope, creates a task in the system project, runs it with the target layer's configuration, waits for it, and answers the report and a proposal. It writes nothing to the layer.
- `placeEdits` drops a proposed file identical to the one on disk, takes its action from disk, and blocks one outside `workflows/` and `prompts/`, outside the layer root, owned by another description, or JSON over a YAML state. `editsChangeset` lowers the applicable edits, and `reviewSyncChangeset` reviews them when asked.
- `beginPendingSync`, `noteSyncWrite` and `commitSyncRecord` remember a proposal as the `layer:path` keys it touches. Saving the last one through `writeFile` or `writeWorkflow` commits the baseline, re-reading both sides from disk.
- `reviewSyncChangeset` runs `changeset/review-loop` over the layer root with `tree: "base"`, and a continuation commits the baseline when the run succeeds with `applied` and every final decision `merged`. `reviewChanges` runs `changeset/review`, or the loop, over a branch-bound task's worktree with `tree: "proposal"`. Both answer once the run starts. `cancelSync` cancels the running sync task on every holder.

In the renderer:

- `syncState.ts`: `driftOf(status, dirty)` counts unsaved edits as a change to the description and recomputes `suggested`; `syncSentence`, `SYNC_LABEL`, `SYNC_HINT` and `agoOf` word the panel.
- The `sync` slice and its actions in `store.ts`. `runSync` sends the editor's text, asks a states sync to open its review, and turns the returned description and every applicable edit into drafts.

It deliberately does not own:

- Changesets, applying them and the review workflows: [changesets](changesets.md).
- Creating, starting, waiting on and cancelling a task: [task-lifecycle](task-lifecycle.md). `jaira workflow check`, which runs the conformance workflow over `workflowDigest`: [cli](cli.md).
- Writing files and the containment checks `layerFile` and `workflowFile` rest on: [workflow-authoring](workflow-authoring.md). Holding drafts: [drafts](drafts.md).
- Drawing the panel, which is renderer code of the workflow sync panel component.

## The unit is service code that spans four packages, and every run it makes is recorded in the system project

- Layer `service`: pure file logic in `@jaira/persistence`, workflow files in `@jaira/runtime`, the host in `packages/app/src/main`, and drift wording and state in the renderer.
- Boundary: renderer and main, over [workflow-sync-channels](../contracts/workflow-sync-channels.md). A proposal crosses as data and reaches disk only through a save or a merged review.
- Boundary: derived and committed. The baseline is a committed file in each layer root; sync and review runs are journaled in the system project, never in the project they are about.
- It calls `browseSource`, `readWorkflowsTolerantly` and `workflowLoadOptions` from [workflow-browser](workflow-browser.md), `createTask`, `startRun` and `cancelTaskIn` from [task-lifecycle](task-lifecycle.md), `createReadFileTool` from [host-tools](host-tools.md), `gitFor` from [task-worktrees](task-worktrees.md), `runCauses` and `runCostUsd` from [board-projection](board-projection.md), the session holders of [project-sessions](project-sessions.md), and `withDraft` from [drafts](drafts.md).
- `startRun` registers its own file, search and web tools after `syncCapabilities`, so the registry a sync runs with holds more than `read_file`. What bounds a sync state is its permission set: the `tools` list and the modes beside it.
- Upstream seams: `@declarative-ai/hw` `loadBundle` loads each workflow map; the engine runs it through `startRun`; the engine wraps or gates the held tools, and `withAgentPermissionSet` in [tool-policy](tool-policy.md) holds each agent transport to the permission set.

## The baseline file is the one durable fact, and a proposal lives only in memory

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `system/sync.json` in each layer root, one record per description | read by `syncStatus`; read, modified and rewritten by `commitSync`, unlocked and not atomic | the file, committed with the layer | teammates, through git |
| Descriptions and state files under a layer's `workflows/` | hashed and digested; never written by a sync | disk | [workflow-authoring](workflow-authoring.md) writes them and calls `noteSyncWrite` |
| `SyncHolder.syncTask` and `pendingSync {direction, document, layer, project?, remaining}` | set by `runSync` and `beginPendingSync`; cleared in a `finally`, by the last matching save, or when the session closes | memory, on the session the layer resolves to, or on `detachedSync` | none |
| Sync and review tasks labelled `jaira, sync, <direction>, <layer>`, `jaira, sync-review, <layer>` or `jaira, changeset-review, <taskId>` | created and run | the system project's task files and journal | [interaction-gateway](interaction-gateway.md) reads the `changeset-review` label to set a gate's `about` |
| The renderer's `sync` slice `{status, result, running, error, progress}` | patched by the actions and by `engine:event` pushes | renderer memory | [renderer-store](renderer-store.md) |

## The invariants keep one owner per state, and move the baseline only when a person accepted the proposal

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Every state has exactly one owning description; a nearer description takes its subtree; a description names only its direct delegates | `descriptions.test.ts` "gives every state exactly one owner", "stops a description at the nearest one below it", "names only its DIRECT delegates, not every description beneath it" |
| 2 | A difference only in line endings or trailing blank lines is not drift, and any other edit is | `persistence/test/workflowSync.test.ts` "treats a line-ending difference as the same file", "treats a real edit as a different file" |
| 3 | No side is suggested before a first sync, when both sides moved, or when unsaved edits make it two-sided | `persistence/test/workflowSync.test.ts` "recommends nothing when the two have never been synced", "refuses to choose when both sides have moved"; `syncState.test.ts` "drops the recommendation when the draft makes it a two-sided disagreement", "recommends nothing at all with no baseline, however dirty the editor is" |
| 4 | Unsaved edits count as a change to the description | `syncState.test.ts` "counts unsaved typing as a change to the description"; `app/test/workflowSync.test.ts` "answers about the text the editor has, not the file on disk" |
| 5 | An absent, corrupt or other-document record reads as no baseline, a legacy single-record file still reads, and settling one description never erases another's record | `persistence/test/workflowSync.test.ts` "treats an absent or corrupt record as no record", "ignores a record taken against a different document"; `app/test/workflowSync.test.ts` "reads a baseline written in the older single-record shape", "keeps a baseline per description, so settling one does not erase another's" |
| 6 | A sync writes nothing to the layer | `app/test/workflowSync.test.ts` "returns the rewritten description and writes nothing", "places a proposed file, and writes nothing" |
| 7 | The baseline moves only when every proposed file is saved, a review's final round merged everything, or there was nothing to change | `app/test/workflowSync.test.ts` "records the baseline only when the proposal is saved", "records the baseline when every proposed file has been saved", "records the baseline immediately when there was nothing to change"; `reviewSync.test.ts` "applies merged proposals into the layer root and moves the baseline when all merged", "a partially-accepted proposal applies what was merged and leaves the drift standing" |
| 8 | No proposal is offered outside `workflows/` and `prompts/`, outside the layer root, for a state another description owns, or as JSON over a YAML state, and one identical to its file is dropped | `app/test/workflowSync.test.ts` "refuses a proposal outside workflows/ and prompts/, naming the rule", "refuses a prompt path that escapes the layer root", "refuses a state id that points outside the workflows directory", "refuses a proposed edit to a state another description owns", "reports rather than applies a JSON proposal for a YAML state", "drops a proposal that is identical to the file it would replace" |
| 9 | A proposal's action is what disk says, and a bare state id is filed under `workflows/` | `app/test/workflowSync.test.ts` "calls an edit to an existing state an update, whatever the model called it", "places a proposal that names the state id rather than the path under it" |
| 10 | A verdict its own `findings` contradict is never reported | `app/test/workflowSync.test.ts` `"reports the findings behind the rewrite, and overrules a verdict its own findings contradict"`; `workflowCheck.test.ts` `"believes the findings over a verdict that contradicts them"` |
| 11 | Every sync state's permission set is a lowered map that holds `read_file`, `glob` and `grep` as `allow` and nothing else, answers `deny` for `other`, and carries no profile | `syncWorkflow.test.ts` "authors the read-only contract as the permission set, on every state, and hands the engine no profile" |
| 12 | A baseline covers only the files its description owns: a delegated state or another workflow changing is not drift | `app/test/workflowSync.test.ts` "does not move the parent's baseline when a delegated state changes", "does not report drift when a workflow it is not about changes"; `digest.test.ts` "leaves a bounded state out of the files a baseline would cover" |
| 13 | A shared-root description is judged against and recorded in the shared root, and no sync leaves a task in a user project | `app/test/workflowSync.test.ts` "judges a shared-root description against the shared root, not against the open project", "records its baseline in the shared root, where it means the same thing in every window", "records the run in JaiRA's project and nothing in the user's" |
| 14 | A malformed model answer fails the sync rather than proposing nothing | `syncWorkflow.test.ts` "refuses an empty rewrite rather than proposing nothing at all", "refuses an edit with no file in it", "refuses a report that is not one" |
| 15 | A workflow that does not load is shown to the sync from its files, and every clipped or unparsable state is named | `app/test/workflowSync.test.ts` "runs against workflows that do not load, rather than refusing over them"; `digest.test.ts` "is still rendered, from its files on disk", "names any state it had to clip", "reports a file that will not parse instead of dropping it" |
| 16 | Two syncs never run at once on one holder | unasserted |

## The failure modes lose a baseline or a proposal, never a file

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A second sync starts on a holder while one runs | refused with `a sync is already running`; the check and the claim have no `await` between them | wait for the first | the panel shows the refusal |
| The sync run fails or is cancelled | refused with each operation's `<state>: <reason>`, else the failure's reason, else `the sync did not finish`; nothing is pending and the baseline stays | run it again | the panel shows the reason |
| The run completes but its outputs do not parse | `syncOutcomeOf` throws after the task completed, so the channel rejects while the task row reads completed | run it again | the panel shows the parse refusal |
| The auto-opened review cannot start | the note `the changeset review could not be opened: <reason>` is added and the sync still answers | open the review from the panel | a note under the report |
| The process dies during a sync | `syncTask`, `pendingSync` and the renderer's drafts are memory and gone | run the sync again | no pending proposal |
| The process exits while a sync review is open | the continuation that commits the baseline is gone, so a review finished after a restart applies its files and leaves the baseline | run a sync that finds nothing to change | the panel reports the workflows moved |
| Two processes accept syncs on one layer root, or two branches' `sync.json` merge | the read, modify and rewrite is unlocked, so one record is lost; a merge that no longer parses reads as no record for every description | accept a sync again | the description reads never synced |
| The process is killed while `sync.json` is written | the truncated file reads as no record for every description | the next accepted sync rewrites it | every description reads never synced |
| `syncStatus` reads while another process writes | a partial file reads as no record | ask again | never synced, until the next status |
| The same sync or review is started twice | two system tasks run, and two review gates park; a second baseline commit rewrites the same record | answer or stop the extra review | two review gates wait |
| A document sync of unsaved text finds nothing to change | the baseline records the saved file's hash, not the hash of the text it judged | save, then run the sync again | after saving, the description reads changed |
| A proposed path starts `prompts/` and climbs out, such as `prompts/../settings.json` | it is placed as applicable anywhere inside the layer root, past the folder rule, ownership and the YAML check | deny it in the review | the change appears in the review under that path |
| Any other task emits an engine event while a sync runs | the renderer appends it to `progress`, whatever project it is in | none | unrelated lines in the sync narration |
| Another file is opened while a sync runs | the finished sync's result, and then its document's status, replace the panel state of the file now open | reopen the description | another description's proposal on the panel |

## The legacy baseline file is read as it stands and rewritten by the next accepted sync

- A `sync.json` holding one record at the top level is read as a one-entry map. Nothing migrates it eagerly; the next accepted sync writes the `documents` shape, and there is no rollback to the old shape.
- Document keys are lower-cased on every platform, so a record written on any machine reads on any other.
- `syncEditPath` folds a bare state id, or a path with a state-file suffix, into `workflows/`, so a proposal written against state ids still places.

## Three numbers bound the digest, the narration and the wording

- `maxStateChars`, default 6000, clips each state's authored text, in `digest.ts`.
- `SYNC_PROGRESS_LIMIT`, 60 lines, caps the narration, in `store.ts`.
- `agoOf` switches unit at 90 seconds, 90 minutes and 36 hours, in `syncState.ts`.

## The unit departs from the usual way in five places, each for a stated reason

- A sync proposes and never writes, because one side is prose a person wrote and the other is code that will run.
- Sync and review runs are journaled in the system project rather than the project they are about, so a sync works with no project open and lands on nobody's board.
- A run takes the target layer's configuration and credentials, not those of the system project it is recorded in.
- A workflow that does not load is digested from its files rather than refused, because a broken workflow is the one a sync most needs to see.
- A pending proposal lives only in memory, so a save long after is never credited to a sync nobody remembers.
