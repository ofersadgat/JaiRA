---
id: engineering/units/project-config
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/share-processes-across-projects, product/bring-your-own-models-and-agents, product/read-comfortably, ux/patterns/inherited-unless-set-here, ux/patterns/refuse-with-the-reason-and-the-fix, ui/components/settings-header, ui/surfaces/settings-view, ui/surfaces/settings-appearance]
layer: data
owns_contracts: [engineering/contracts/settings-json]
requires: [engineering/units/project-store, engineering/units/project-layout, engineering/units/project-sessions, engineering/units/executor-tree, engineering/units/model-routing]
implemented_by: [packages/shared/src/config.ts, packages/shared/src/configSchema.ts, packages/shared/src/configLayers.ts, packages/shared/src/appearanceConfig.ts, packages/app/src/main/service.ts]
verified_by: [packages/shared/test/configLayering.test.ts, packages/shared/test/configLayers.test.ts, packages/shared/test/shared.test.ts, packages/shared/test/configScopes.test.ts, packages/shared/test/executorTree.test.ts, packages/runtime/test/modelRoutes.test.ts, packages/app/test/settings.test.ts, packages/app/test/appearance.test.ts, packages/app/test/editorLook.test.ts, packages/app/test/fileTypes.test.ts, packages/persistence/test/userSettingsMigration.test.ts]
siblings: [engineering/units/user-settings, engineering/units/secret-chain, engineering/units/executor-tree, engineering/units/project-store]
---

# Project config

## Project config parses, layers and edits settings.json, and leaves what each setting does to the units that read it

`config.ts` in `@jaira/shared` holds the document and its rules:

- `JairaConfig`, `defaultConfig()` and `defaultStorage()`.
- `parseConfig(raw)`, strict per block: a refused or malformed field throws an `Error` whose message starts `config.<path>` and usually names the fix. The executor tree overlay, its `steps` and its `scopes` are parsed here too, with steps checked against the `EXECUTOR_STEPS` schemas.
- `mergeConfigDocuments(under, over)`, which lays one document over another before anything is parsed, and `mergeConfigLayers(docs)`, which applies it across the four layers, weakest first: built in (`$SYSTEM/settings.json`), Shared (`<base>/settings.json`), This project (`<project>/.jaira/settings.json`) and Just you (`<base>/personal-settings.json`).

`appearanceConfig.ts` holds the `appearance` block, how the app looks: `JairaAppearanceConfig`, `defaultAppearanceConfig()` and `parseAppearanceConfig`, strict like every other block and written in the look vocabulary `settings.ts` holds. `configLayers.ts` holds what a Settings row asks of the layers: `inheritedDoc`, `statingLayer` and `inheritedValue`.

`configSchema.ts` holds `CONFIG_SECTIONS`, the schemas the Settings form draws the artifacts, exec environment, storage, memo and workflow lookup sections from, beside `ARTIFACT_DESTINATIONS` and `ARTIFACT_VARIABLES`.

`AppService` in `service.ts` edits the shared, project and personal layers through `config:read` and `config:write`:

- `readConfig(project?)` returns `ConfigView`: each layer as authored — `system` (the built-in layer, read-only), `base`, `project` and `you` — the files `baseFile`, `projectFile` and `youFile`, the shared root `baseDir`, and `effective`, the four merged and parsed.
- `writeConfig({layer, project?, config})` parses the new document merged with every other layer, the built-in one included, before writing. A write to the shared or the personal layer is parsed again with each open project's layer laid in, and a failure names that project's file. It then writes the authored document whole, `layer: "you"` to `<base>/personal-settings.json`, re-layers every open session's `Project.config`, publishes `store:invalidate` for `config` and then `workflows`, and starts an availability pass when the service probes on start.
- `effectiveConfig()` answers for the one open user project, or merges the built-in, shared and personal layers when none or several are open.
- `windowAppearance()` answers the look the window's frame is painted in: the `appearance` of the built-in, shared and personal layers, never a project's, because a window holds several; the defaults when a layer cannot be read.

It deliberately does not own:

- Reading the layers at open and writing the initial project document: [project-store](project-store.md) `loadLayeredConfig` and `initProject`.
- Resolving the overlay into a tree and enforcing function rules: [executor-tree](executor-tree.md). Probing routes and the availability snapshot: [model-routing](model-routing.md).
- Compiling `policy`, which it passes through unchecked: [tool-policy](tool-policy.md). Checking `artifacts.destination`: [artifact-placement](artifact-placement.md).
- Credential values, which a document only names: [secret-chain](secret-chain.md). The window's own state — layout, read marks, open projects, the log policy: [user-settings](user-settings.md), whose `migrateUserSettings` moved the look out of it into the personal layer.
- Painting the look: the renderer through `lookOf` and `writeLook` ([renderer-store](renderer-store.md)), the frame through `windowAppearance` ([app-shell](app-shell.md)).
- What a storage mode does: [storage-policy](storage-policy.md). Where the files live: [project-layout](project-layout.md).

## The parser is pure shared code that main, the CLI and the persistence package call, and only main writes a layer

- Layer `data`. `config.ts` imports no Node module. The renderer reaches `CONFIG_SECTIONS` through `@jaira/shared/browser` and never calls `parseConfig`.
- The editing half runs in `@jaira/app` main because a write has to reach every open session. It calls `sessionOf`, `loadLayeredConfig`, `initBase` and the availability refresh.
- Boundary: renderer and main. `config:write` is validated in main before a byte is written; a form's own checks are a convenience.
- Boundary: derived and committed. The shared and project files are authored, and the project's is committed; the personal layer lives in the shared root and is never in a checkout; the built-in layer ships with JaiRA. A credential field holds a secret's name, never its value.
- No upstream seam. The parsed values reach `@declarative-ai/*` only through the units that read them.

## The layer files are the truth, and each open session holds a parsed copy

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `$SYSTEM/settings.json` | read by `readConfig`, `effectiveConfig` and `windowAppearance`; never written | the shipped file | every merge reads it first |
| `<base>/settings.json` | read by `readConfig`, `effectiveConfig` and `windowAppearance`; written whole by `writeConfig` with `layer: "base"` | the file | `loadLayeredConfig` at every open; hand edits |
| `<project>/.jaira/settings.json` | read by `readConfig`; written whole by `writeConfig` with `layer: "project"` | the file | `initProject` writes `defaultConfig()` once; hand edits |
| `<base>/personal-settings.json` | read by `readConfig`, `effectiveConfig` and `windowAppearance`; written whole by `writeConfig` with `layer: "you"` | the file | `loadLayeredConfig` and `openSharedProject` at every open; `migrateUserSettings` writes the look into it once; hand edits |
| `Project.config` per open session | replaced after every write | derived from the layer files | runs, executor listing and probes read it |
| `ConfigView.effective` | computed on each read | derived | the Settings screen; the renderer paints its `appearance` through `lookOf` |

## The invariants keep an unloadable document off disk and every refusal named

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Objects merge key by key at every depth, arrays replace, `agents.genericCli` merges by `name` defaulting to `generic-cli` in the base's order, and an absent layer passes the other through | `configLayering.test.ts` "merges objects key by key, so a project keeps what it did not mention", "merges nested objects too", "REPLACES arrays rather than concatenating them", "merges agents.genericCli BY NAME, keeping the base's order", "treats an unnamed generic entry as 'generic-cli', its registry name", "passes a layer straight through when the other is absent" |
| 2 | A write whose merge with the other layer fails to parse leaves the file untouched | `settings.test.ts` "refuses an invalid document and leaves the file untouched", "validates the project layer AS MERGED, not on its own" |
| 3 | A project layer write stores the authored document, never the merge | `settings.test.ts` "writes the project layer without copying the base's values into it" |
| 4 | A project layer write naming no open project is refused; the base layer reads and writes with no project open | `settings.test.ts` "still refuses to write the project layer with no project named", "reads both layers with NO project open, so the shared one is editable on an empty window", "writes and lists the shared layer with no project open", "writes the base layer, creating the shared root if needed" |
| 5 | `readConfig` returns each layer as authored beside their parsed merge, and after a write the service answers from the new document without a reopen | `settings.test.ts` "reports both layers and the merged result", "reflects a disabled executor as soon as config says so", "finds a credential named by a config write, without a reopen" |
| 6 | A credential holding whitespace, a `credential` on `claudeCli`, a `command` on `claudeCode` and an unknown field in an agent or route block are refused | `configLayering.test.ts` "refuses a credential that looks like a value rather than a name", "refuses a key for the CLI, which signs itself in, and a command for the in-process SDK", "refuses model limits on an agent, which is the route's business now"; `modelRoutes.test.ts` "refuses a setting placed under a route that has no such setting", "refuses a credential that looks like the secret itself" |
| 7 | `models.default` is refused with the path it moved to, and an empty document parses to `defaultConfig()` | `shared.test.ts` "defaults artifacts.dir, and refuses the retired models.default", "points a config still carrying models.default at where those settings moved" |
| 8 | Storage defaults every concern to `db`, refuses `jobs` and `job_output` with the reason, points `events`, `sessions` and `snapshots` elsewhere, and refuses an unknown concern, mode or format | `configLayering.test.ts` "defaults to the database, which is what the engine actually does today", "refuses the two tables that cannot be file-backed, by name and with the reason", "points a plausible-but-wrong concern at the one that covers it", "refuses a concern it has never heard of, and lists the ones it knows", "refuses a mode and a format that are not modes or formats" |
| 9 | An executor name or route key never contains `/`, a model never repeats its node's prefix, and a node's unknown field, kind or step setting is refused | `executorTree.test.ts` "refuses a slash in a name or a route key", "refuses a model that repeats its own node's prefix, and says what it meant", "refuses a field a level does not have, naming the ones it does", "refuses a kind that is not one of the levels", "validates a node's steps against the same schemas the form renders from" |
| 10 | A scope names exactly one of `path` and `url`, says something, and a refusal names its index | `configScopes.test.ts` "refuses a scope naming both a path and a url", "refuses a scope that says nothing about anything", "names WHICH entry is wrong, so a long table is fixable" |
| 11 | A search path entry is rooted or absolute; `files.hidden` concatenates across the layers, and a blank entry is refused | `configLayering.test.ts` "accepts a $BASE-rooted path entry", "still refuses a bare path entry, naming why", "appends a project's hidden list to the base's rather than replacing it", "refuses a hidden entry that is not a usable pattern, rather than dropping it" |
| 12 | The layers merge weakest first — built in, shared, project, you — the strongest stating a key wins it, and the personal layer is laid over the shared root opened as a project too | `configLayers.test.ts` "merges three documents so the strongest stating a key wins it, key by key", "skips an absent layer, and says nothing when every layer is absent"; `userSettingsMigration.test.ts` "is read after the shared root and the project", "is laid over the shared root opened as a project, which has no project layer between"; `settings.test.ts` "wins over the project and the shared root, key by key" |
| 13 | A personal write lands in `personal-settings.json` alone, and one that breaks an open project is refused with nothing written | `settings.test.ts` "keeps the JSON editor's wrap preference there, and defaults it off", "refuses a document that is valid alone but breaks an open project" |
| 14 | The window's frame is painted from the shared root and the personal layer, never a project, while the renderer's effective look includes the project | `settings.test.ts` "paints the window's frame from the shared root and the personal layer, never a project" |
| 15 | The `appearance` block fills in every default, and refuses by name a size outside its range, a family named twice, a value of the wrong kind, an unknown key, a tab width or line spacing its control does not offer and a knob its surface lacks | `appearance.test.ts` "defaults to the shipped sizes and no chosen families", "refuses a size outside what its control offers, naming the key", "refuses a family named twice, because a repeat can never be reached", "refuses a value of the wrong kind, and a key the block does not have", "reads the nested blocks a layer states partly, with every default filled in"; `editorLook.test.ts` "fills in what the layer does not state, knob by knob and surface by surface", "refuses a knob of the wrong kind, naming it", "refuses a tab width the control does not offer", "refuses line spacing outside what the control offers", "refuses a knob the surface does not have" |
| 16 | A renderer line that says nothing is dropped, a key that is not a renderer key is refused, and a renderer id this build lacks is kept | `fileTypes.test.ts` "keeps a choice, and refuses what is not one", "drops a line that says nothing at all", "keeps a key for a renderer this build no longer has" |

## A failed write leaves the file as it was, and a failed re-layer leaves a file written that the save reported as failed

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The merged document fails `parseConfig` | `writeConfig` throws the parser's plain `Error`, which the IPC boundary logs at `error`; nothing is written | fix the named field and save again | the error names `config.<path>` |
| A base write parses over the named project, or alone, but not over another open project | the file is written, then `loadLayeredConfig` throws for that project; later sessions keep their old copy and no invalidate is published | fix the base document | the save reports an error although it landed; that project fails at its next open |
| Two writers: two app processes, or a hand edit and a save | each write replaces the whole file with no lock and no version check | none | the earlier edit is gone |
| The process is killed mid-write | `writeFileSync` is not atomic and a truncated file stays on disk | repair the file by hand | the project does not open and `config:read` fails |
| A read meets a half-written or malformed file | `readJsonIfPresent` and `readJsonFile` throw the JSON error | repair the file by hand | the project does not open; Settings cannot read any layer |
| The shared or personal layer does not parse when the frame is painted | `windowAppearance` answers the default look rather than throwing | repair the file | the frame and window controls are drawn in the default palette |
| A retry sends the same document again | the whole document is rewritten with the same bytes | none needed | none |
| A key is misspelled at the top level or inside `agents`, `models`, `artifacts`, `memo`, `workflows`, `files`, `execEnvironment`, `serve` or a `weights` entry | ignored; only routes, executor nodes, steps, scopes, storage, `integrations`, `functions`, `mcp`, `appearance` and agent entries refuse unknown fields | fix the spelling | the setting is silently not in force |
| `models.routes.openai` is written | refused as an unknown route by a message that lists `openai` among the expected routes, because `ROUTE_FIELDS` has no `openai` entry | none | the save is refused with a contradictory message |
| `vendor` is written on a provider or agent node | refused as not a setting, although `JairaProviderNode` and `JairaAgentNode` declare it | none | the save is refused naming `vendor` |
| A layer sets a block to `null` | the null replaces the base's block; every block then fails parse | remove the key | the error names the block |
| Two or more user projects are open | `effectiveConfig()` answers from the built-in, shared and personal layers alone, so executor listing, probes and the availability pass ignore every project layer | close all but one project | Settings shows those layers' executors and routes |
| A project was created by `initProject` | its document holds every default, which overrides the base; see [project-store](project-store.md) | delete the keys from the project document | shared values silently never apply |

## Migrations at open move the old forms, and a retired field is refused by name

- At every open, before the layers are read, the persistence migrations rewrite what an older form left behind; the three that touch settings are `migrateSettingsLayers`, `migrateHiddenLists` and `migrateUserSettings`, which moves the look out of `user-settings.json` into the personal layer. What each moves is in [settings-json](../contracts/settings-json.md). A layer with nothing to move is not touched.
- Otherwise the code never rewrites a document. A retired field is refused rather than dropped: `models.default` with the path it moved to, a `models` field on an agent block as not a setting, and `storage.sessions`, `events` and `snapshots` with the concern that covers them.
- Nothing rolls back. The settings and hidden-list migrations keep a copy of each file they change in place under the layer's `system/logs/`; `migrateUserSettings` keeps none.

## Step schemas are checked by a small local reader instead of the validator every run uses

- `checkAgainstSchema` reads only `type` of object, number, boolean or string and `required`, because `@declarative-ai/validate` is Node-only and `config.ts` stays free of Node imports. A step schema that gains `enum`, `minimum` or any other keyword is not enforced on save until this reader learns it.
