---
id: engineering/units/files-view-models
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/catch-process-mistakes-before-running, product/share-processes-across-projects, product/try-one-step-on-its-own, product/keep-track-of-everything, ux/patterns/problems-marked-where-they-are, ux/patterns/pick-from-what-exists, ui/surfaces/files-view, ui/components/file-tree, ui/components/state-inspector, ui/components/slot-table, ui/components/issue-mark]
layer: data
owns_contracts: [engineering/contracts/task-view-models]
requires: [engineering/units/board-projection, engineering/units/workflow-browser, engineering/units/project-layout, engineering/units/workflow-snapshots, engineering/units/document-types]
implemented_by: [packages/persistence/src/stateViews.ts]
verified_by: [packages/persistence/test/stateViews.test.ts, packages/persistence/test/fileLint.test.ts, packages/persistence/test/builtInLayer.test.ts, packages/app/test/service.test.ts, packages/app/test/builtInStates.test.ts, packages/app/test/eachHosted.test.ts]
siblings: [engineering/units/board-projection, engineering/units/workflow-browser, engineering/units/project-layout, engineering/units/view-addressing]
---

# Files view models

## The unit owns what the Files view reads about roots, files and one state, and none of the rules those readings apply

`stateViews.ts` holds:

- `fileTree(project, browser?, hidden?)`: the project root walked from the checkout with its layer prefix measured, then every later layer root, each filtered by the compiled hidden rules. A state file gets its `stateId`, a file a layer ahead of it overrides is marked `shadowed`, a project or shared file whose id the built-in layer also supplies is marked `overridesBuiltIn`, an unparsable file carries `error`, and lint counts are joined from the browser and rolled into directories. The last root is the built-in layer, with `layer: "system"` and the label `Built in` ([decision 0006](../decisions/0006-built-in-layer.md)); `builtInRoot(browser?, hidden?)` builds it. `baseFileTree(baseDir, browser?, hidden?)` is the shared root followed by that root.
- `stateView(project, stateId, browser, options)`: children, the state's board, `tasksHere` and the eight most recent `tasksRecent`, transitions with loops marked, the executor and whether it is available, the owning root's issues for the state, `referencedBy` and drifted tasks. `baseStateView(baseDir, stateId, options, browser?)` reads a shared state from its file alone and says so with `fileOnly: true`.
- `stateSlots(roots, stateIds)` and `workflowRoots(project)`: the inputs and outputs each state declares, with `optional`, and its raw `session` declaration.
- `rootContaining(browser, stateId)`, `boardForState(project, stateId, browser, options)` and `rootsBoard(project, browser, options)`: the board of any state from the workflow that contains it, and one column per workflow root.
- `effectiveState(project, stateId, browser, {snapshotHash})`: the state's file on disk, and `from: "pinned" | "moved" | "disk"` saying whether a named run's snapshot is still the workflow as it stands.

The board, tree and state shapes are [task-view-models](../contracts/task-view-models.md).

It deliberately does not own:

- Placing cards, headings and the fold of a task's journal: `projectBoard`, `taskRun` and `bundleFor` in [board-projection](board-projection.md).
- Lint issues, roots and drift, which arrive in the `WorkflowBrowser` it is handed: [workflow-browser](workflow-browser.md).
- The hidden-path rules and their layering: [project-layout](project-layout.md).
- Which session answers, the executor sets passed in as `StateViewOptions`, and the recorded values `state:effective` adds: [view-addressing](view-addressing.md).
- Writing a state, file or folder: [workflow-authoring](workflow-authoring.md).

## The unit is a data-layer read that the app's Files and board channels call with a browser in hand

- Layer `data`, package `@jaira/persistence`. It calls `node:fs`, the projection functions, `isStateFile`, `compileHidden`, `hiddenRules`, `isHiddenPath`, `mimeOfPath`, and `parseReferencedFile` and `stateFilePath` from `@declarative-ai/hw`.
- No upstream seam beyond those two readers.
- Boundary: derived and committed. The tree draws what a person authors and hides `system/` by default, and the project root is the checkout, so files outside `.jaira/` are listed as `other`.
- Callers: `AppService` in `service.ts` for `files:tree`, `state:view`, `state:slots`, `state:effective`, `board:roots`, and `board:view` with a level; the referrer check before a state is moved or deleted reads `stateView(...).referencedBy`.

## The unit stores nothing, and the files on disk are the truth for every node it draws

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| Directory entries under each root | read by `walkDir` per call | the filesystem | [workflow-authoring](workflow-authoring.md) writes them |
| State documents | read by `stateSlots` across `<root>/workflows` with `.json`, `.yaml`, `.yml`; by `baseStateView` as `<id>.json`; by `effectiveState` as the browser's winning file | the files | authoring, the person's editor |
| `WorkflowBrowser` | read, never built here | the files, through [workflow-browser](workflow-browser.md) | the caller builds it once per request |
| Task summaries and journals | read through `taskSummaries`, `taskRun` and `bundleFor` | `task_runtime`, the task files and the journal | [board-projection](board-projection.md) |
| Hidden rules | read as `HiddenRules`, defaulting to `DEFAULT_HIDDEN_PATHS` | `DEFAULT_HIDDEN_PATHS`, then `files.hidden` of each layer: the shared root's, the project's, then the personal layer's `personal-settings.json` | compiled by `hiddenRulesFor` in `service.ts` |

## The invariants keep every file in the tree, every fault on its file and every task on one root column

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The roots board has one column per workflow root, and a task spawned by another files under its topmost ancestor's column when this project holds that ancestor | `stateViews.test.ts` "gives one column per workflow root and places each task in its own", "files a task spawned by another under its ancestor's column, not its own workflow's", "leaves a task whose parent this project does not hold where it stands" |
| 2 | A task a mount made is on no column of the roots board | `eachHosted.test.ts` "makes a task per element, waits for them in order, and reads their outputs back gathered" |
| 3 | A state's board comes from the workflow whose closure holds it, and a state no workflow contains has no board rather than an empty one | `stateViews.test.ts` "resolves a state from ITS OWN workflow, not the newest task's", "returns null for a state no workflow contains, rather than an empty board", "finds the root whose closure holds a nested state" |
| 4 | Columns follow the order children run in, and a leaf has no board | `stateViews.test.ts` "projects a state's children as columns, in the order they run", "gives a leaf no board, so the view shows its tasks instead" |
| 5 | An executor that is known and not available is a blocking error, and a function that is not an executor is never judged | `stateViews.test.ts` "reports an unavailable executor as a blocking error", "does not judge a function that is not an executor at all", "judges an unavailable executor from the authored 'function' field" |
| 6 | Every layer root is listed even when absent, state files carry their ids, and what the hidden rules name is left out and nothing else | `stateViews.test.ts` "lists both layer roots, with state ids on the workflow files", `builtInLayer.test.ts` "draws the read-only root LAST in the Files tree, as `system` and never as `base`", "marks the shipped row overridden and the person's row overriding, once a copy shadows it", "lists a root that does not exist on disk, and says it does not", "keeps run state out of the authoring tree", "hides what the setting names, and nothing else", "puts a hidden directory back when a later rule reveals it", "says where the LAYER sits inside each root, which is what the tree's menus ask" |
| 7 | With no project, a shared state is described from its file and a missing one renders instead of throwing | `stateViews.test.ts` "reads a shared state from its file when there is no project", "describes a state that is not there yet rather than throwing", "gives the shared root on its own when there is no project" |
| 8 | An issue marks the file it names, is counted once however many roots reach it, and rolls up into directories | `fileLint.test.ts` "marks the file an error was reported against", "counts warnings apart from errors", "counts an issue once even when two roots reach the state", "rolls totals up into the directories above" |
| 9 | A state no loaded root reaches is `unchecked`, never clean, and `unchecked` never rolls up; a shadowed base copy carries no marks | `fileLint.test.ts` "marks a state no root reaches as unchecked rather than clean", "treats a root that failed to load as unchecked, not as clean", "does not roll `unchecked` up into a directory", "leaves a shadowed base copy unmarked" |
| 10 | Without a browser the tree carries no lint at all | `fileLint.test.ts` `"says nothing at all with no browser — nothing has been linted"` |
| 11 | Slots mark a slot with `optional` or a `default` as optional, take the project's copy over the base's, read YAML, and omit an id that names nothing, a transcluded `inputs` or an unparsable file | `fileLint.test.ts` "reads a state's inputs, marking which must be wired", "lets the project layer shadow the base's, as resolution does", "reads a YAML state as readily as a JSON one", "omits an id that names nothing", "omits a state whose inputs are a transcluded reference", "survives a file that is mid-edit and unparsable" |
| 12 | An effective state is `disk` with no run named, `pinned` while the run's hash is the live one, `moved` after an edit, and has no document for a state nothing defines | `service.test.ts` "hands back the state's own file, and asks no pin question when no run was named", "says the file is the one the run pinned, while it still is", "says the workflow has MOVED once the file has been edited since", "answers with no document rather than throwing for a state nothing defines" |

## Every failure narrows what one view says, except a bad task file, which fails every board

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A state file is mid-edit and does not parse | the tree lists it with `error`; `stateSlots` skips it and returns the base copy's slots when the shared root has one | save the file | the file reads as broken, and a mount may offer the base copy's slots |
| A task file does not parse | `taskSummaries` throws, so `rootsBoard`, `boardForState` and `stateView` throw | repair or delete the file | boards and the inspector error for that project |
| A caller passes no hidden rules | the walk uses the defaults | pass the compiled rules, as `AppService.filesTree` does | a tree built from the wrong rules |
| A state belongs to no loadable workflow | `boardForState` returns null; `stateView` has no `rootId`, board, transitions or lint issues | fix the workflow that should contain it | no board, and no issues on the state |
| One state is mounted under several roots | `rootContaining` picks the first root with tasks, else the first by id, and board, issues and transitions come from that root | none | the state's view reflects one of its workflows |
| A named run's owning root fails to load, or no root holds the state | the owning hash is unknown, so `effectiveState` answers `moved` | fix the workflow | the pinned file reads as changed |
| The shared root is read with no session, and a state there is YAML | `baseStateView` probes `<id>.json` only | author it as JSON | the state reads as missing |
| A task's workflow file is gone | `rootsBoard` gives it a column keyed by its workflow, or by its title when the task file is missing | none | a column with no file behind it |
| Two writers, a process killed mid-write, a retry that duplicates | cannot occur: the unit writes nothing, and a file read mid-write is the mid-edit row above | none needed | none |
