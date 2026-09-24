---
id: engineering/units/project-layout
type: engineering-unit
status: shipped
updated: 2026-09-21
implements: [product/share-processes-across-projects, product/all-projects-in-one-place, ui/components/file-tree, ui/surfaces/settings-files]
layer: data
owns_contracts: [engineering/contracts/jaira-layout]
requires: [engineering/units/tool-policy]
implemented_by: [packages/shared/src/paths.ts, packages/shared/src/hiddenPaths.ts, packages/shared/src/json.ts, packages/shared/src/jsonFile.ts]
verified_by: [packages/shared/test/shared.test.ts, packages/shared/test/hiddenPaths.test.ts, packages/cli/test/home.test.ts, packages/app/test/service.test.ts, packages/persistence/test/systemProject.test.ts, packages/persistence/test/worktrees.test.ts, packages/persistence/test/builtInLayer.test.ts, packages/app/test/builtInLayer.test.ts, packages/app/test/builtInStates.test.ts]
siblings: [engineering/units/project-store, engineering/units/project-config, engineering/units/user-settings, engineering/units/files-view-models]
---

# Project layout

## The layout computes every path a root holds and the key a project opens under, and creates nothing

`jairaPaths(projectDir, baseDir?, builtInDir?)` in `paths.ts` returns a project's `JairaPaths`: its `.jaira/` directory, `settings.json`, `workflows/` and `skills/`, the generated children of `.jaira/system/`, the shared root's layout as `base`, the built-in layer's as `builtIn`, the ordered layer `roots`, and `worktreesDir` outside the checkout. `jairaBasePaths(baseDir?)` returns the shared root's `JairaBasePaths`, which adds `user-settings.json`, `functions/`, `.env`, `.env.local` and `system/machine.key`. `baseAsProjectPaths(baseDir?, builtInDir?)` maps the shared root onto the project shape so it can be opened as a project. Each path, what it holds and whether git ignores it are [jaira-layout](../contracts/jaira-layout.md).

### There are three layers, and the third is what ships

`roots` is three directories in search order: the project's `.jaira/`, the shared root, and the built-in layer, which a reference names `$SYSTEM` ([decision 0006](../decisions/0006-built-in-layer.md)). `jairaBuiltInPaths(builtInDir?)` returns its `JairaBuiltInPaths`: `dir`, `workflows/`, `functions/`, `prompts/` and `permission-sets/`. It has no `system/`, no settings and no database, because nothing is generated into it.

- It is last. `layerRoots` in `paths.ts` appends it after the other roots, and `searchPathFor` in `workflowRefs.ts` appends its `workflows/` and `functions/` after whatever `workflows.path` configured, lifting out an entry that named them earlier. `prepareUserModules` does the same for the module require path.
- It is read-only. `isWritableLayer` in `view.ts` is the rule, and `AppService.writable` refuses the `system` layer on every surface that takes a layer and changes a file. Copying a state out of it is allowed, because that copy is the override.
- It is trusted. `trustingBuiltIn` in `userModules.ts` answers the approval gate for a module under the layer with the file's current hash: [module-approvals](module-approvals.md). A person's copy at another path is gated as before.
- The source of truth is `packages/shared/builtin/`. `packages/cli/build.mjs` and `packages/app/build.mjs` copy it to `dist/builtin/` beside their bundles. `defaultBuiltInDir()` answers the first of these that exists: `<process.resourcesPath>/builtin` for a packaged Electron app, `builtin/` beside the running module for a bundle, and `../builtin` from `paths.ts` for source under tsx and vitest. When none exists it answers the second, and an absent directory reads as an empty layer.
- `$SYSTEM/…` names the shipped copy of a document: a prompt, an operation document, a permission set. It does not pin a state. A state reference that lands under any search directory folds back to its bare id, as `$BASE/workflows/…` always has, so `$SYSTEM/workflows/chat/hello` is the state `chat/hello` and a person's copy shadows it.
- `setBuiltInDir(dir)` names the directory for the process. No environment variable and no settings key does, because a file under the layer skips the approval gate, so whatever can name the directory can run code unasked.
- `$SYSTEM` means something else in an artifact destination, where it is a root's generated `system/` directory: [artifact-destination-template](../contracts/artifact-destination-template.md). A destination template is not a reference, so the two never meet. `JairaPaths` calls the layer `builtIn` and the generated directory `systemDir`.
- The layer ships `chat/assistant`, `chat/agent` and the three `debug/hello_world` states under `workflows/`, beside its `README.md`. Nothing installs them anywhere: the Chat view and the self-test name the ids and the search path finds the files. A copy of one in the shared root or a project wins, as any override does.
- Under vitest the layer is an absent directory, registered by `test/setup.ts`, so a test's listings hold only what it wrote. `shippedLayer()` in `test/testing.ts` gives one test the real files.

Beside the path builders it owns:

- `defaultBaseDir(env)`, which answers `JAIRA_HOME` when it is set, throws under `VITEST` when it is not, and otherwise answers `~/.jaira`; and `takeHomeFlag(argv)`, which lifts `--home <dir>` out of a command line.
- `workflowSearchPath(roots)`, which is `<root>/workflows` then `<root>/functions` for each root in order, and `worktreePathFor(paths, taskId)`.
- `sessionKey(dir)`, the identity of an open project: the resolved path, its real path when it exists, lower-cased on Windows only.
- In `hiddenPaths.ts`, the names `JAIRA_DIR_NAME` and `SYSTEM_DIR_NAME`, `DEFAULT_HIDDEN_PATHS`, and the ordered rules the Files tree filters by: `hiddenRules`, `compileHidden` and `isHiddenPath`.
- `stripBom` and `parseJsonText` in `json.ts`, and `readJsonFile` in `jsonFile.ts`, which task files, snapshots, workflow files, project config and CLI JSON arguments are read through.

It deliberately does not own:

- Creating any directory and writing the `.gitignore` template: [project-store](project-store.md).
- What a file holds. `settings.json` and its `files.hidden` block are [project-config](project-config.md); `user-settings.json` with its `filesHidden` and `baseDir` is [user-settings](user-settings.md).
- Walking a root and building the tree the rules filter: [files-view-models](files-view-models.md).
- Which projects are open under which key: [project-sessions](project-sessions.md).
- The secret chain's file list, which `secrets.ts` builds from `JAIRA_DIR_NAME` rather than from a `JairaPaths` field: [secret-chain](secret-chain.md).

## The layout is shared data-layer code that every package and both hosts read paths through

- Layer `data`, package `@jaira/shared`. `paths.ts` and `jsonFile.ts` import `node:fs` and are exported from `@jaira/shared` only. `hiddenPaths.ts` and `json.ts` are browser-safe and are also exported from `@jaira/shared/browser`; that is why `JAIRA_DIR_NAME` and `SYSTEM_DIR_NAME` are defined in `hiddenPaths.ts` and `SHARED_SESSION` in `ipc.ts`, each re-exported by `paths.ts`.
- It may call `node:fs`, `node:os`, `node:path`, the file-name constants in `settings.ts`, and `globToRegExp` and `normalizePath` in `scopes.ts`.
- No upstream seam.
- Boundaries: derived and committed, drawn by `system/`, with what a person authors beside it and what JaiRA generates inside it; project and worktree, where `worktreesDir` is `<parent of project>/.jaira-worktrees/<project basename>`.
- The shared root is chosen in one order by both hosts: `--home`, then `JAIRA_HOME`, then the `baseDir` saved in `~/.jaira/user-settings.json`, then `~/.jaira`. The app passes the flag as `AppService` `baseDir` and reads the rest in `settingsBaseDir` in `service.ts`. The CLI sets `JAIRA_HOME` from the flag for one dispatch in `runCli` and restores it afterwards, and never reads the saved `baseDir`.

## The layout stores nothing, and each path's truth is the directory it was computed from

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `JairaPaths`, `JairaBasePaths` | computed on every call, never cached | the project and base directories passed in | every store, the app service, the runtime's artifact anchors, the CLI |
| The built-in layer's location | found once per process by `defaultBuiltInDir` and remembered; replaced by `setBuiltInDir` | `packages/shared/builtin/`, copied to `dist/builtin/` by both builds | `workflowLoadOptions`, `prepareUserModules`, `projectSource` and `baseSource`, `workflowRoots`, and the `system` branch of `AppService`'s path helpers read it; nothing writes it |
| The shared root's location | `JAIRA_HOME` read by `defaultBaseDir`; `--home` lifted by `takeHomeFlag` | the flag, the environment, `user-settings.json` `baseDir`, then `~/.jaira` | `AppService` and `settingsBaseDir` in `service.ts`; `runCli` in `cli.ts` |
| A project's key | computed by `sessionKey` | the directory's real path | `AppService.sessions` keys every open project by it |
| Hidden rules | compiled by `compileHidden(hiddenRules(shared, personal))` | `settings.json` `files.hidden`, or `DEFAULT_HIDDEN_PATHS` when absent, followed by `user-settings.json` `filesHidden` | `hiddenRulesFor` in `service.ts` compiles them; `fileTree` and `baseFileTree` in `stateViews.ts` filter by them |

## The invariants keep generated files under system/, one key per directory, and the last hiding rule in charge

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | No generated path of a root lies outside its `system/`, and no authored directory lies inside it | `service.test.ts` "keeps everything it generates under the root's system/ directory"; `systemProject.test.ts` "puts everything it generates under system/, and nothing else there" |
| 2 | The shared root opened as a project searches itself and then the built-in layer, and no other root | `systemProject.test.ts` `"searches itself and then what ships — no PERSON's layer is behind the layer"` |
| 3 | A project's `roots` lead with its own `.jaira/`, end with the built-in layer, and never name one directory twice | `builtInLayer.test.ts` "puts the built-in layer last, behind the project and the shared root"; the deduplication is unasserted |
| 3a | A bare id, a `$/…` reference and a module symbol resolve project first, shared second, built-in last, and `$SYSTEM/…` names the shipped copy whatever shadows it | `builtInLayer.test.ts` "lets the shared root shadow the built-in copy, and the project shadow both", "searches `$/…` along all three, first match winning", "names the shipped copy with `$SYSTEM/…`, whatever shadows it" |
| 3b | `workflows.path` can neither drop the built-in layer nor move it ahead of another root | `builtInLayer.test.ts` "keeps the layer on the end of a configured path that left it out", "moves the layer to the end of a configured path that put it first" |
| 3c | An absent built-in directory is an empty layer | `builtInLayer.test.ts` "treats a missing built-in directory as an empty layer" |
| 3d | No write surface that takes a layer writes into the built-in layer or, refused, into the project instead; a copy out of it is allowed | `app/test/builtInLayer.test.ts` "refuses every write surface that takes a layer", "leaves the layer byte-for-byte as it was, and writes nothing into the project instead", "allows the override: a COPY out of the layer, into the project or the shared root" |
| 3f | The chat states and the self-test resolve and run with no state file in the project or the shared root, with and without a project open, and running one writes none | `builtInStates.test.ts` "starts a conversation in an empty project over an empty shared root, and writes no state file", "starts one with NO project open, in a shared root that does not exist yet", "runs the self-test from what ships, with the scripted replies matching the shipped prompts" |
| 3g | Only a shared-root copy whose value equals a shipped version is offered for deletion; listing deletes nothing, and cleanup deletes only named copies that still match | `builtInStates.test.ts` "lists a re-indented copy and an old version, and not an edited file", `"never lists a PROJECT's copy, identical or not"`, "deletes nothing by listing, and only what was asked for by cleaning up", "leaves a copy alone when it was edited between the offer and the yes" |
| 3e | A module under the built-in layer needs no approval, and a person's copy of one does | `builtInLayer.test.ts` "runs a shipped `.ts` function nobody approved, and freezes it into the snapshot", "gates a person's copy that shadows the shipped function, exactly as before" |
| 4 | A task's worktree path never lies inside the project directory | `worktrees.test.ts` "creates a worktree outside the project for a bound task and records it" |
| 5 | Two spellings of one directory never give two keys, and two directories never share one | `shared.test.ts` "collapses spellings of the same directory to one key", "keeps genuinely different directories apart", "ignores case on Windows, where one path is one directory" |
| 6 | Case is never folded off Windows, and a directory that does not exist still has a key | `shared.test.ts` "keeps case elsewhere, where two spellings are two directories", "answers for a directory that does not exist yet, which is what `init` hands it" |
| 7 | The defaults hide all of `system/` and nothing a person authors | `hiddenPaths.test.ts` "hides the whole of JaiRA's own directory and nothing a person authors" |
| 8 | An absent shared list means the defaults, and an empty one hides nothing | `hiddenPaths.test.ts` "takes the defaults when the shared list says nothing", "treats an explicitly empty list as a statement, not as silence" |
| 9 | The personal list applies after the shared one, and the last matching rule decides | `hiddenPaths.test.ts` "applies the personal list after the shared one", "lets a personal `!system` reveal what the shared list hid", "lets a later pattern hide again what an earlier one revealed" |
| 10 | A blank entry or a bare `!` never becomes a rule | `hiddenPaths.test.ts` "drops blank entries and a bare `!`, which would otherwise read as a rule" |
| 11 | A single `*` never crosses a `/`, and a match never depends on case or separator spelling | `hiddenPaths.test.ts` "does not let a single star cross a directory boundary", "ignores case, because the filesystems this runs on disagree about it", "matches a path however the caller spelled it" |
| 12 | `--home` is lifted wherever it sits, and a flag with no value consumes only itself | `home.test.ts` "lifts the flag out of the arguments wherever it sits, and resolves the path", "reports a flag with nothing after it, and one followed by another flag" |
| 13 | A UTF-8 byte order mark never fails a JSON read | `shared.test.ts` "tolerates a UTF-8 BOM (PowerShell-written files)" |
| 14 | Under a test run with no `JAIRA_HOME`, the shared root never resolves to the real home directory | unasserted |

## Every failure is a wrong input read plainly, because the layout writes nothing

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| `JAIRA_HOME` names a project's own `.jaira/` | `roots` collapses to that directory and the built-in layer | point `JAIRA_HOME` at the shared root | the project shows no shared layer |
| The built-in directory is missing, as in a build that copied nothing | every listing of it is empty and every search moves on | rebuild, so `dist/builtin/` is copied | a state only the layer supplied is an unknown state; everything else runs |
| A write names the `system` layer | `AppService.writable` refuses it before any path is resolved; `syncStatus` answers a `blocked` line instead | copy the file into the shared root or the project | the refusal `what ships with JaiRA is read-only` |
| A packager wraps `dist/` in an asar | worker threads and the TypeScript compiler host cannot read the layer there | ship the directory as an extra resource at `<resources>/builtin`, which `defaultBuiltInDir` looks for first | none today: nothing packages the app yet |
| A suite runs without the repository's vitest setup, so `JAIRA_HOME` is unset | `defaultBaseDir` throws, naming how to run the tests | run from the repository root | the test fails with that message |
| `--home` has no value, or the next token is a flag | the CLI exits 2 with `--home needs a directory` and the usage; the app ignores the flag | pass a directory | a usage error in the terminal; the app opens its usual root |
| `user-settings.json` does not parse | `settingsBaseDir` reads the defaults, so a saved `baseDir` is not used | fix the file | the app opens on `~/.jaira` |
| Two paths differ only by case on a case-sensitive filesystem | two keys | none needed: they are two directories there | two projects |
| A JSON file is truncated or not JSON | `parseJsonText` throws `<file>: invalid JSON: <message>` | repair the file | the caller's error names the file |
| Two writers, a process killed mid-write, a retry that duplicates | cannot occur: the unit computes paths and reads, and writes nothing | none needed | none |

## No path carries a version, and a moved path strands what was at the old one

- Nothing migrates files between layouts. Generated files moved under `system/` on 2026-08-24, and a root still holding `jaira.db`, `tasks/` or `snapshots/` at its top opens with no history, because every store reads the new paths.

## Hidden rules layer by concatenation and show what no rule names, unlike configuration arrays and scopes

- A later list extends the earlier one and the last match wins, where every other configuration array replaces, so a personal list can narrow or reveal what the shared list hides.
- A path no rule matches is visible, where a scope table refuses what it does not name, because the rules filter a directory a person already has open.
