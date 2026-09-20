---
id: engineering/units/project-layout
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/share-processes-across-projects, product/all-projects-in-one-place, ui/components/file-tree, ui/surfaces/settings-files]
layer: data
owns_contracts: [engineering/contracts/jaira-layout]
requires: [engineering/units/tool-policy]
implemented_by: [packages/shared/src/paths.ts, packages/shared/src/hiddenPaths.ts, packages/shared/src/json.ts, packages/shared/src/jsonFile.ts]
verified_by: [packages/shared/test/shared.test.ts, packages/shared/test/hiddenPaths.test.ts, packages/cli/test/home.test.ts, packages/app/test/service.test.ts, packages/persistence/test/systemProject.test.ts, packages/persistence/test/worktrees.test.ts]
siblings: [engineering/units/project-store, engineering/units/project-config, engineering/units/user-settings, engineering/units/files-view-models]
---

# Project layout

## The layout computes every path a root holds and the key a project opens under, and creates nothing

`jairaPaths(projectDir, baseDir?)` in `paths.ts` returns a project's `JairaPaths`: its `.jaira/` directory, `settings.json`, `workflows/` and `skills/`, the generated children of `.jaira/system/`, the shared root's layout as `base`, the ordered layer `roots`, and `worktreesDir` outside the checkout. `jairaBasePaths(baseDir?)` returns the shared root's `JairaBasePaths`, which adds `user-settings.json`, `functions/`, `.env`, `.env.local`, `system/machine.key` and the legacy `system/approvals.local.json`. `baseAsProjectPaths(baseDir?)` maps the shared root onto the project shape so it can be opened as a project. Each path, what it holds and whether git ignores it are [jaira-layout](../contracts/jaira-layout.md).

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
| The shared root's location | `JAIRA_HOME` read by `defaultBaseDir`; `--home` lifted by `takeHomeFlag` | the flag, the environment, `user-settings.json` `baseDir`, then `~/.jaira` | `AppService` and `settingsBaseDir` in `service.ts`; `runCli` in `cli.ts` |
| A project's key | computed by `sessionKey` | the directory's real path | `AppService.sessions` keys every open project by it |
| Hidden rules | compiled by `compileHidden(hiddenRules(shared, personal))` | `settings.json` `files.hidden`, or `DEFAULT_HIDDEN_PATHS` when absent, followed by `user-settings.json` `filesHidden` | `hiddenRulesFor` in `service.ts` compiles them; `fileTree` and `baseFileTree` in `stateViews.ts` filter by them |

## The invariants keep generated files under system/, one key per directory, and the last hiding rule in charge

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | No generated path of a root lies outside its `system/`, and no authored directory lies inside it | `service.test.ts` "keeps everything it generates under the root's system/ directory"; `systemProject.test.ts` "puts everything it generates under system/, and nothing else there" |
| 2 | The shared root opened as a project has itself as its only root | `systemProject.test.ts` `"searches only itself — there is no layer behind the layer"` |
| 3 | A project's `roots` lead with its own `.jaira/` and never name one directory twice | unasserted |
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
| `JAIRA_HOME` names a project's own `.jaira/` | `roots` collapses to that one directory | point `JAIRA_HOME` at the shared root | the project shows no shared layer |
| A suite runs without the repository's vitest setup, so `JAIRA_HOME` is unset | `defaultBaseDir` throws, naming how to run the tests | run from the repository root | the test fails with that message |
| `--home` has no value, or the next token is a flag | the CLI exits 2 with `--home needs a directory` and the usage; the app ignores the flag | pass a directory | a usage error in the terminal; the app opens its usual root |
| `user-settings.json` does not parse | `settingsBaseDir` reads the defaults, so a saved `baseDir` is not used | fix the file | the app opens on `~/.jaira` |
| Two paths differ only by case on a case-sensitive filesystem | two keys | none needed: they are two directories there | two projects |
| A JSON file is truncated or not JSON | `parseJsonText` throws `<file>: invalid JSON: <message>` | repair the file | the caller's error names the file |
| Two writers, a process killed mid-write, a retry that duplicates | cannot occur: the unit computes paths and reads, and writes nothing | none needed | none |

## No path carries a version, and a moved path strands what was at the old one

- Nothing migrates files between layouts. Generated files moved under `system/` on 2026-08-24, and a root still holding `jaira.db`, `tasks/` or `snapshots/` at its top opens with no history, because every store reads the new paths.
- `approvalsFile` stays in `JairaBasePaths` only so [module-approvals](module-approvals.md) can import a legacy file into an empty approvals table; nothing writes it.

## Hidden rules layer by concatenation and show what no rule names, unlike configuration arrays and scopes

- A later list extends the earlier one and the last match wins, where every other configuration array replaces, so a personal list can narrow or reveal what the shared list hides.
- A path no rule matches is visible, where a scope table refuses what it does not name, because the rules filter a directory a person already has open.
