---
id: engineering/contracts/workflow-sync-channels
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/description-sync]
consumers: ["@jaira/app renderer store.ts sync slice actions syncStatus, runSync and cancelSync", "@jaira/app renderer store.ts reviewChanges and reviewSyncChangeset", "@jaira/app main index.ts handler table", "@jaira/app tests workflowSync.test.ts, reviewSync.test.ts and reviewChanges.test.ts"]
siblings: [engineering/contracts/task-channels, engineering/contracts/inbox-channels, engineering/contracts/ipc-channels, engineering/contracts/sync-record, engineering/contracts/refusal-errors]
---

# Workflow sync channels

The IPC request channels that report whether a workflow description and its states have drifted, run a sync that proposes the edits to bring one side back in step, cancel it, and open a changeset review of a sync's proposal or of a task's worktree.

## A caller reaches for these to compare, propose and review, and never to write a file

**Use when.** Drawing the sync panel for a description, running either sync direction, cancelling one in flight, or putting a sync's changeset or a branch-bound task's uncommitted edits in front of the reviewer.

**Do not use when.** Saving an accepted proposal, which goes through the file and workflow write channels in [ipc-channels](ipc-channels.md) and settles the proposal as a side effect. Answering the review gate once it parks: [inbox-channels](inbox-channels.md), with the result shape in [gate-components](gate-components.md). Checking a description from a terminal: `jaira workflow check` in [jaira-cli](jaira-cli.md). The baseline file itself: [sync-record](sync-record.md). How a call is invoked and how its failure travels: [preload-bridge](preload-bridge.md).

## The shape is one request per channel, and `project` only names whose layer files a call reads

### `workflow:syncStatus` answers the drift of one description

The request is `{layer, path, text?, project?}`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `layer` | `"project"` or `"base"` | yes | the layer root the description lives in; `base` is the shared root |
| `path` | string | yes | the description's path relative to the layer root, such as `workflows/workflow.md` |
| `text` | string | no | the description as the editor holds it; absent reads the file |
| `project` | `ProjectRef` | no | the project whose layer files are read, for `layer: "project"` |

The answer is `WorkflowSyncStatus`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `layer` | `"project"` or `"base"` | yes | echoed |
| `project` | `ProjectRef` | no | declared and never set |
| `path` | string | yes | echoed |
| `exists` | boolean | yes | the description file exists; false when no project is open or `path` escapes the root |
| `synced` | boolean | yes | a baseline record exists for this description |
| `at` | number, epoch ms | no | when the baseline was accepted |
| `lastDirection` | `"document"` or `"states"` | no | which side that sync rewrote |
| `documentChanged` | boolean | yes | the description's hash differs from the baseline; false with no baseline |
| `statesChanged` | boolean | yes | any owned state file was added, edited or removed since the baseline |
| `changedStates` | `{path, change}[]` | yes | each changed file relative to the layer's `workflows/`, `change` one of `added`, `edited`, `removed`, sorted by path |
| `suggested` | `"document"`, `"states"` or null | yes | the side to rewrite when exactly one side moved; otherwise null |
| `blocked` | string | no | why a sync cannot run, listed below |
| `pending` | `"document"` or `"states"` | no | a proposal from this process with files still unsaved |
| `delegated` | `{document, root, states}[]` | no | subtrees a nearer description owns: its path, the state it takes over at, and how many states sit under it |

`blocked` carries one of:

| `blocked` | When |
| --- | --- |
| `open a project to sync its workflows` | a project-layer description with no user project open |
| the containment refusal `'<path>' is not inside the <layer> root` | `path` escapes the layer root |
| `'<root>' names no workflow here. This project has: <ids>`, or `… has none yet` | the description names a root the layer does not have |
| `this description is empty — write what the workflows should do, then sync` | the text is blank |
| `every state here is described by <documents>` | every owned state is delegated |
| `<this project or the shared root> has no workflows to sync against` | `workflows/workflow.md` in a layer with no state files |
| `'<root>' resolves entirely from the shared root, so this project has no files to sync` | a project description whose root has no project-layer files |

### `workflow:sync` runs a sync and answers when it has settled

The request is `WorkflowSyncRequest`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `layer` | `"project"` or `"base"` | yes | as above |
| `path` | string | yes | as above |
| `direction` | `"document"` or `"states"` | yes | the side to rewrite: `document` rewrites the description, `states` proposes files |
| `text` | string | no | the description as the editor holds it; absent reads the file |
| `review` | boolean | no | for `states`, open the changeset review as soon as there is a changeset |
| `interactions` | `Record<string, JsonValue[]>` | no | scripted gate answers for the auto-opened review: [interactions-script-format](interactions-script-format.md) |
| `fake` | `JsonValue` | no | scripted prompt rules for the sync and the review: [fake-rules-format](fake-rules-format.md) |
| `project` | `ProjectRef` | no | as above |

The answer is `WorkflowSyncResult`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the sync's task in the system project; pass it back as `parentTaskId` |
| `direction` | `"document"` or `"states"` | yes | echoed |
| `workflows` | string[] | yes | the workflow roots the digest covered |
| `verdict` | `"conforms"`, `"gaps"` or `"diverges"` | yes | recomputed from `findings` |
| `requirements` | `{id, requirement, category, quote}[]` | yes | the requirements extracted from the description |
| `findings` | `{id, requirement, status, states, detail}[]` | yes | one per requirement; `status` one of `satisfied`, `partial`, `missing`, `contradicted` |
| `extras` | `{states, detail}[]` | yes | behaviour the description does not mention |
| `document` | `{text, changes: {summary, requirements}[]}` | for `document` | the rewritten description and what changed in it |
| `edits` | `WorkflowSyncEdit[]` | for `states` | every placed proposal, applicable or blocked; identical files are left out |
| `changeset` | `Changeset` | no | the applicable edits lowered against the tree, with a `file:` source pinned by hash |
| `reviewTaskId` | string | no | the auto-opened review's task |
| `notes` | string[] | yes | the run's notes, clipped states, identical files, a review that could not open, and `the workflows already run what the description asks for` or `the description already describes what the workflows do` |
| `costUsd` | number | no | the run's spend, summed from its journal |

`WorkflowSyncEdit`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `stateId` | string | no | the state id, for a file under `workflows/` |
| `layer` | `"project"` or `"base"` | yes | the request's layer |
| `project` | `ProjectRef` | no | declared and never set |
| `path` | string | yes | relative to the layer root, such as `workflows/x.json` or `prompts/review/critique.md` |
| `action` | `"create"` or `"update"` | yes | taken from whether the file exists, not from the model |
| `text` | string | yes | the complete file |
| `reason` | string | yes | what in the description it closes |
| `requirements` | string[] | yes | the requirement ids it answers |
| `applicable` | boolean | yes | false when it is reported but not offered |
| `blocked` | string | no | why it is not offered |

### `workflow:syncCancel` stops whatever sync is running

The request is empty. The answer is `{canceled: boolean}`: true when a running sync's task was cancelled on some holder, false when nothing was running.

### `changeset:review` and `changeset:reviewSync` start a review and answer once it runs

`changeset:review` reviews a branch-bound task's uncommitted work.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | a task with a worktree |
| `base` | string | no | the commit to diff against, default `HEAD` |
| `loop` | boolean | no | run `changeset/review-loop`, which sends comments to a model, instead of `changeset/review` |
| `project` | `ProjectRef` | no | the project the task is in |
| `interactions` | `Record<string, JsonValue[]>` | no | scripted gate answers |
| `fake` | `JsonValue` | no | scripted prompt rules for the loop's respond state |

`changeset:reviewSync` reviews a sync's proposal with `changeset/review-loop` against the layer root.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `layer` | `"project"` or `"base"` | yes | the layer root the changes apply to |
| `path` | string | yes | the description the sync ran for; the baseline key |
| `changeset` | `Changeset` | yes | the `changeset` a `workflow:sync` answered |
| `parentTaskId` | string | no | the sync task it came from |
| `project` | `ProjectRef` | no | as above |
| `interactions` | `Record<string, JsonValue[]>` | no | scripted gate answers |
| `fake` | `JsonValue` | no | scripted prompt rules |

Both answer `ReviewChangesResult`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `reviewTaskId` | string | yes | the review's task in the system project |
| `changes` | number | yes | how many changes the changeset carries |

## Every error arrives as a refusal message, and a failed sync leaves the baseline where it was

| Condition | Response | Caller does |
| --- | --- | --- |
| A project-layer call names no open project, or names none with several open | `project '<ref>' is not open`, or `several projects are open, so this call must name one` | name the project |
| `path` escapes the layer root | `'<path>' is not inside the <layer> root` | fix the path |
| A sync is already running on the holder | `a sync is already running` | wait, or call `workflow:syncCancel` |
| The description is blank | `<path> is empty; there is nothing to sync` | write the description |
| The description names an unknown root | `unknown workflow '<root>' — this project has: <ids>` | rename the description |
| The layer has no workflows | `this project has no workflows to sync against`, or `the shared root …` | add a workflow |
| The shared root could not be opened | `the shared root could not be opened, so a sync cannot be recorded: <reason>`, or `… a review cannot be recorded: <reason>` | fix the shared root and reopen |
| The run's start is refused | the start refusal, as for a task: [refusal-errors](refusal-errors.md) | fix the cause |
| The sync run fails or is cancelled | each operation's `<state>: <reason>` joined by `; `, else the failure's reason, else `the sync did not finish` | read the reason, then run again |
| The run's outputs do not parse | `the sync returned no document to put in the editor`, `the sync returned an edit with no path or no file (edits[<i>])`, `the sync returned a malformed proposal`, or `the check returned …` | run again |
| `changeset:review` names a project that is not open, or names none while zero or several are open | `no project is open` | name the project |
| `changeset:review` of a task without a worktree | `task '<id>' has no worktree — only a branch-bound task's edits can be reviewed` | pick a branch-bound task |
| `changeset:review` with a `base` that does not resolve | `'<base>' does not resolve in this repository` | pass a commit that exists |
| `changeset:review` finds no edits | `the worktree matches <base> — there is nothing to review` | nothing to do |
| `changeset:reviewSync` with an empty or malformed changeset | `the proposal has no changes to review`, or the `changesetOf` message such as `changes[<i>].id '<id>' is not unique — decisions anchor to it` | send the changeset `workflow:sync` answered |

Every refusal is logged at `warn` with the source `sync` or `review`, and crosses to the renderer as its message alone.

## A change to a channel breaks the renderer in the same build, and there is no deprecation path

- Channel names live in `IPC_CHANNELS`, from which the preload whitelist is built. Renderer and main ship together, so no older caller exists.
- `WorkflowSyncReport` restates the runtime's `ConformanceReport`, so a change to the conformance workflow's outputs breaks `syncOutcomeOf`, this answer and `jaira workflow check --json` together.
- Review tasks are labelled `jaira, changeset-review, <taskId>` and `jaira, sync-review, <layer>`, and sync tasks `jaira, sync, <direction>, <layer>`. The interaction gateway reads the entry after `changeset-review` as the gate's `about`, so changing that label breaks where a worktree review's gate is drawn for recorded tasks.
- The workflow ids `workflow/sync/document`, `workflow/sync/states`, `workflow/conformance`, `changeset/review` and `changeset/review-loop` are recorded on those tasks and in their snapshots.

## The channels resolve at different moments, and `project` reaches less than it appears to

- `workflow:sync` resolves only after the run settles, which can take many minutes. `changeset:review` and `changeset:reviewSync` resolve as soon as the run starts, and the reviewer arrives later as a pending interaction.
- A sync writes nothing. The renderer turns `document` and every applicable edit into drafts, and a states sync with `review: true` also parks a review that writes merged files into the layer root itself.
- The baseline moves when every applicable edit's file is saved through a write channel, when a sync finds nothing to change, or when a `changeset:reviewSync` run succeeds with every final decision `merged`. A review started by hand or by the sync both do this; one that finishes after the app restarts does not.
- `project` names whose layer files are read and written. The run's configuration, credentials and pending-proposal holder come from the only open user project, and with several open the configuration falls back to the shared root's settings. The review a sync opens is never given `project`, so with several projects open it cannot open and a note says so.
- The renderer sends no `project` on `workflow:sync` or `changeset:reviewSync`, so with several projects open a project-layer call refuses. It sends none of `text` on `workflow:syncStatus`, and layers unsaved edits onto the answer itself.
- `syncStatus` is not guaranteed to answer rather than throw: an unopened or ambiguous project refuses, and the store's action then sets the status to `null`, which reads as checking.
- `changeset:review` answers `no project is open` both when none is open and when several are.
- `workflow:syncCancel` takes no layer or path and cancels every running sync. A cancelled sync makes its `workflow:sync` call reject.
- `edits[].path` is relative to the layer root, while a project-layer file write addresses paths relative to the checkout.
- A proposed path that starts with `prompts/` and climbs out of it, such as `prompts/../settings.json`, is placed as applicable anywhere inside the layer root.
- `verdict` may differ from the verdict the model reported; the model's own is not returned.
