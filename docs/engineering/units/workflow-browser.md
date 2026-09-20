---
id: engineering/units/workflow-browser
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/catch-process-mistakes-before-running, product/share-processes-across-projects, product/work-runs-the-process-it-started-with, product/only-approved-code-runs, ux/patterns/problems-marked-where-they-are, ux/patterns/refuse-with-the-reason-and-the-fix]
layer: data
owns_contracts: [engineering/contracts/task-view-models]
requires: [engineering/units/project-layout, engineering/units/module-approvals, engineering/units/component-contracts, engineering/units/interaction-hub, engineering/units/workflow-snapshots, engineering/units/board-projection]
implemented_by: [packages/persistence/src/workflowRefs.ts, packages/persistence/src/workflows.ts, packages/persistence/src/vfs.ts]
verified_by: [packages/persistence/test/baseRoot.test.ts, packages/persistence/test/workflowRefs.test.ts, packages/persistence/test/workflows.test.ts, packages/persistence/test/fileLint.test.ts, packages/persistence/test/moduleApproval.test.ts, packages/persistence/test/runLabel.test.ts]
siblings: [engineering/units/workflow-snapshots, engineering/units/module-approvals, engineering/units/files-view-models, engineering/units/description-sync]
---

# Workflow browser

## The browser owns how JaiRA loads a workflow and what lint reports about the layers, and none of the rules it checks against

`workflowLoadOptions(paths, options)` in `workflowRefs.ts` builds the one `LoadBundleOptions` every JaiRA `loadBundle` call with a project uses:

- `defaultRoot` is the search path, with the project's `workflows/` forced first and every configured `$JAIRA`, `$PROJECT` and `$BASE` entry expanded; with no `workflows.path` configured it is `workflowSearchPath(paths.roots)`.
- `rootPath` is the layer roots a bare `$` searches, and `roots` names `JAIRA`, `PROJECT` and `BASE`.
- `loadState` reads a state the files map does not hold, root by root, first match winning.
- `shadowing: "override"`, so a project state replacing a base one is not a warning.
- `functions` is `hostCalleeSignatures()`, the callees JaiRA ships, consulted where the search path finds no file.
- `symbols` and `userFunctions` come from the process's module pair when it exists; a per-load `watch` swaps in a symbol index that records what the approval gate withheld.

`standaloneLoadOptions(workflowsDir)` is the bare form for a directory with no project: no search path, no roots, no host callees and no modules. `nodeVfs()` in `vfs.ts` is the filesystem adapter, which caches directory listings for one load and matches names case-sensitively.

`workflows.ts` owns the browse. `projectSource` and `baseSource` name a `LayerSource`; `browseSource`, `browseWorkflows` and `browseBaseWorkflows` read each layer's `workflows/` tolerantly, derive the roots, load and lint each root, and return a `WorkflowBrowser`; `lintErrors` flattens it to the errors that block. The shape is in [task-view-models](../contracts/task-view-models.md).

It deliberately does not own:

- The validation rules and reference resolution. `loadBundle`, `validateBundle` and `resolveStateRef` are upstream `@declarative-ai/hw`.
- What a component's config must hold: `componentConfigIssues` in [component-contracts](component-contracts.md).
- The approvals, the symbol index and the refusal wording: [module-approvals](module-approvals.md).
- Reading a pinned workflow and reading the project's files for a start: [workflow-snapshots](workflow-snapshots.md).
- Colouring the file tree by lint: [files-view-models](files-view-models.md).

## The browser is a pure data-layer read over the engine's loader seam, and lint and execution share its options

- Layer `data`, package `@jaira/persistence`. It calls `node:fs`, `workflowSearchPath` and `baseAsProjectPaths` from [project-layout](project-layout.md), `isStateFile` from `snapshots.ts`, `checkLabel` from `runLabel.ts`, the module pair, `componentConfigIssues`, and `hostCalleeSignatures` from `@jaira/runtime` `userEvents.ts`.
- Upstream seam: `LoadBundleOptions` and `Vfs` from `@declarative-ai/hw`, with `loadBundle`, `validateBundle`, `resolveStateRef`, `stateIdFromPath`, `stateFilePath`, `parseReferencedFile` and `snapshotHash`.
- Boundary: workflow and run. `beginTaskRun` in `lifecycle.ts`, `bundleFor` in `views.ts`, `digest.ts` and `jaira run` load through `workflowLoadOptions`, so a workflow lints against the same resolution it executes. `jaira run --workflows <dir>` alone uses `standaloneLoadOptions`.
- Callers of the browse: the app's `workflow:browse`, Files tree, state view, boards and description sync in `service.ts`; `digest.ts`; `jaira workflow list` and `jaira workflow lint`.
- Nothing is written. A browse is safe to run on every file-watch event.

## The browser stores nothing, and the state files on disk are the truth for every answer

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| State files under each layer's `workflows/` | read whole by `readWorkflowsTolerantly` per browse; read one id at a time by `loadState` | the files | written by [workflow-authoring](workflow-authoring.md); the project's are read for a start by `readWorkflowFiles` |
| `WorkflowBrowser` | computed per call | the files, the module pair and the task index | the app's views, the description digest, `jaira workflow list --json` |
| Task index: each task's `workflow` and pinned hash | read by `tasksOf` from `project.runtime.list()` and `project.tasks.tryRead` | `task_runtime` and the task file | [task-lifecycle](task-lifecycle.md) writes both |
| Module pair | read by `userModules()` on every load | process memory | built by `prepareUserModules` in [module-approvals](module-approvals.md) |
| `workflows.path` | read from the project's config | `settings.json` | [project-config](project-config.md) |

## The invariants keep one resolution for lint and execution and turn every broken file into a diagnostic

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A workflow only the shared root supplies loads under its bare id and is listed from the base layer | `baseRoot.test.ts` "loads under its BARE id, though no file for it exists in the project", "is listed by the browser, marked as coming from the base layer" |
| 2 | A project state replaces the base state of the same id, both copies are listed with the base one flagged `shadowed`, and the override is never a lint warning | `baseRoot.test.ts` "replaces the base state of the same id, keeping the rest of the base workflow", "lists both copies, flagging the shadowed base one", "does not report the override as a lint warning" |
| 3 | A `$/` fragment comes from the first layer root that has it, and a missing one names the roots tried | `baseRoot.test.ts` "finds a prompt the shared root supplies and the project does not", "lets the project override a shared fragment under the same spelling", "reports a fragment no layer supplies, naming the roots tried" |
| 4 | No configured entry puts the project's `workflows/` behind another, and an unconfigured path is generated from the layer roots | `workflowRefs.test.ts` "keeps the workflows dir first, whatever the config asks for", "generates the layer path when nothing is configured" |
| 5 | A host-shipped callee resolves with no file, and never wins over a project file of the same name | `workflowRefs.test.ts` "resolves `on_user_event` with no file anywhere", "loses to a project file of the same name" |
| 6 | A half-saved file, a dangling child or an unresolvable reference never throws out of a browse | `workflows.test.ts` "reports lint results rather than throwing, and finds none in the shipped workflow", "survives a half-saved file and names it", "reports a dangling child reference as a diagnostic, not an exception"; `workflowRefs.test.ts` "reports an unresolvable reference instead of throwing out of the browser" |
| 7 | A state nested under another state's id, or a child inferred from a directory, is never a root, and a state no root reaches is listed in `unreachable` | `workflows.test.ts` `"keeps an unwired substate out of the roots — nested under a state is nested, referenced or not"`, "does not mistake directory-inferred children for roots", "reports states left unreachable when references form a cycle" |
| 8 | A task pinned to a hash other than the live bundle's is listed as drifted | `workflows.test.ts` "links tasks to their workflow and flags snapshot drift" |
| 9 | An output with no `binding` is an error, except where the state's operation is a function | `fileLint.test.ts` "refuses an output that says nothing about where its value comes from", "allows a produced output where the operation is a function" |
| 10 | A gate component missing the config it needs is an error | `fileLint.test.ts` "reports a gate that declares no options" |
| 11 | A label naming an input the state does not declare is reported | `runLabel.test.ts` "catches a typo against the state's own declaration" |
| 12 | When an unapproved module is why a root failed to load, lint names the file to approve instead of the load error | `moduleApproval.test.ts` "reports the file to approve instead of the parse error it caused", "says nothing about approvals once the file is approved" |
| 13 | A missing `workflows/` or shared root browses empty rather than failing | `workflows.test.ts` "returns an empty browser for a project with no workflows"; `baseRoot.test.ts` "is absent without error when the shared root does not exist yet" |
| 14 | Two roots in one browse never pool the symbols the approval gate withheld | unasserted |

## Every failure is a diagnostic or a load error, except where a start and a browse read the layers differently

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A state file is half-saved or does not parse | the browse keeps it as a `WorkflowFileEntry` with `error`; `jaira workflow lint` exits 1 | save the file | the file reads as broken |
| A root's closure fails to load | the entry carries `loadError` with `states: [rootId]` and no issues, and its other states land in `unreachable` unless another root reaches them | fix the named reference | the workflow shows its load error |
| A state only a later root supplies is YAML, and a task starts | `beginTaskRun` passes only the project's files, and `loadState` probes `<id>.json` alone, so the state is not found; the browse reads every layer's YAML and lints it clean | author it as JSON, or in the project | the start is refused because the state is not found, while lint shows nothing |
| A state file at an earlier root fails to read for a reason other than absence | `loadState` throws instead of falling through to the next root; under `tolerant` it answers nothing | fix the file | a load error, not the base copy |
| No module pair exists, because the app opened no user project or a caller skipped `prepareUserModules` | the load has no `symbols`, so a `.ts` callee is `not a known operation` | open a project | a load error that reads as a typo |
| `jaira run --workflows <dir>` loads a workflow calling `on_user_event` or a `.ts` callee | `standaloneLoadOptions` carries neither, so the call does not resolve | run inside a project | a validation error |
| A workflow lints with JaiRA's own errors, such as an unbound output or a gate without options | `beginTaskRun` runs `validateBundle` alone, so the task starts | fix what lint reports | red in the tree, and the run proceeds |
| Two writers, a process killed mid-write, a retry that duplicates | cannot occur: the unit writes nothing, and a read mid-write is the half-saved row above | none needed | none |

## Lint departs from the pre-run gate in strictness and from the workflow format in what it allows

- Lint runs `validateBundle` with `strict: true` and the start gate does not, so a function reference in a state a run never enters blocks lint and not a start.
- Lint refuses an output with no `binding`, which the workflow format allows, because a produced output that silently does not fire ends a state successfully with nothing.
