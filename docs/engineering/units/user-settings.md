---
id: engineering/units/user-settings
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/all-projects-in-one-place, product/see-what-changed-since-you-looked, ux/patterns/the-window-remembers-its-arrangement]
layer: data
owns_contracts: [engineering/contracts/user-settings-json]
requires: [engineering/units/project-layout, engineering/units/app-log]
implemented_by: [packages/shared/src/settings.ts, packages/app/src/main/service.ts, packages/persistence/src/userSettingsMigration.ts]
verified_by: [packages/app/test/settings.test.ts, packages/app/test/service.test.ts, packages/app/test/diagnostics.test.ts, packages/persistence/test/userSettingsMigration.test.ts]
siblings: [engineering/units/project-config, engineering/units/ui-layout-state, engineering/units/renderer-store]
---

# User settings

## User settings reads the window's own state forgivingly and writes a patch merged one level deep

`user-settings.json` is the window's own state on one machine: where its panes were left, what is folded, which conversations have been read, how loudly the log talks, which projects were open. How the app looks is not in it; that is a setting, the `appearance` block of the settings layers ([project-config](project-config.md)).

`settings.ts` in `@jaira/shared` holds the document and its reading:

- `JairaSettings` — `ui`, `projects`, `logging`, `baseDir` and `forgeSignIns` — with `defaultSettings()` and the per-field defaults `defaultUiState` and `defaultLogPolicy`.
- `parseSettings(raw)`, which never throws: a value of the wrong shape is dropped or capped per entry, a forge sign-in mark is kept only whole, and anything that is not an object reads as `defaultSettings()`. `parseLogPolicy` does the same for `logging`.
- The 4000 px pane cap it reads `ui.panes` against.
- `SETTINGS_FILE_NAME`, `USER_SETTINGS_FILE_NAME` and `PERSONAL_SETTINGS_FILE_NAME`.

`settings.ts` also holds the vocabulary of the look — `Appearance`, `EditorLook`, `RendererChoice`, `ConversationLook`, the palettes, their defaults and the bounds `SIZE_LIMITS`, `TAB_SIZES`, `LINE_HEIGHT` and `EDITOR_KNOBS` — because `appearanceConfig.ts` is written in it. None of it is read from this file.

`AppService` in `service.ts` owns the file:

- `readSettings()` reads `<base>/user-settings.json` through `readSettingsFile`, which answers `defaultSettings()` for an absent or unparsable file.
- `writeSettings(patch)` writes `{...readSettings(), ...patch}` whole and returns that object. A patch carrying `logging` re-installs the log policy at once through `applyLogPolicy`.
- `settingsBaseDir()` picks the shared root when the service is given none: `JAIRA_HOME`, then the `baseDir` saved in `~/.jaira/user-settings.json`, then `~/.jaira`. A `--home` flag reaches the service as `baseDir` and beats all three.

`migrateUserSettings` in `@jaira/persistence` `userSettingsMigration.ts` moves out the fields the file used to hold, `MOVED_USER_SETTINGS`: `theme`, `appearance`, `conversation`, `editors`, `renderers` and `filesHidden`. They go into the personal layer, `<base>/personal-settings.json`: `theme` as `appearance.mode`, the rest of the look under `appearance`, and `filesHidden` appended to `files.hidden`. `AppService`'s constructor runs it before anything paints, and `openProject` and `openSharedProject` run it at every open, so the CLI's first open moves them too. It reads the old fields the way this file used to read them, writes only what differs from the default, keeps what the personal layer already states, writes that file before it removes the six fields, and leaves every other field as it was.

It deliberately does not own:

- The layout ids, the debounced `ui` writes and the rule that the window owns `ui` after hydration: [ui-layout-state](ui-layout-state.md) and [renderer-store](renderer-store.md).
- Opening the remembered projects and forgetting the missing ones, which call `writeSettings` with `projects`: [project-sessions](project-sessions.md).
- What a log policy keeps: [app-log](app-log.md).
- How the app looks, the Files tree's hidden rules and anything a run depends on: [project-config](project-config.md), in the shape [settings-json](../contracts/settings-json.md) gives.

## The reader is browser-safe shared code, and only the main process touches the file

- Layer `data`. `settings.ts` is exported through `@jaira/shared/browser`, so the renderer uses the same types and defaults.
- The file is read and written only by `AppService`, behind `settings:read` and `settings:write`; the channels are in [ipc-channels](../contracts/ipc-channels.md). The one other writer is `migrateUserSettings`, which only removes the six retired fields.
- Nothing here paints. The window's frame and title bar are painted from the settings layers through `AppService.windowAppearance`: [app-shell](app-shell.md).
- Boundary: derived and committed. The file lives in the shared root, never in a checkout, so nothing in it arrives through a pull request.
- No upstream seam.

## The file is the truth, except for the layout the renderer holds between writes

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `<base>/user-settings.json` | read on every `readSettings`; written whole on every `writeSettings` | the file | hand edits |
| `ui` | written whole by the renderer's debounced write | the renderer's copy after hydration, the file before it | [ui-layout-state](ui-layout-state.md) |
| `projects` | written by `remember` on open and by `restore` when it forgets a directory | the file | [project-sessions](project-sessions.md) |
| `baseDir` | read once at construction, from `~/.jaira/user-settings.json` only | that file | nothing in the app writes it |
| the installed log policy | set from `logging` at construction and after a write that carries it | the file | [app-log](app-log.md) |
| `theme`, `appearance`, `conversation`, `editors`, `renderers`, `filesHidden` in a file written before 2026-09-23 | read and removed once by `migrateUserSettings`, after it has written them into `<base>/personal-settings.json` | the old file until the move, the personal layer after it | [project-config](project-config.md) reads the personal layer |

## The invariants keep the app opening whatever the file holds

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An absent or corrupt file reads as the defaults and never throws | `settings.test.ts` "defaults to an empty layout, with no project open", "falls back to defaults rather than throwing on a corrupt file" |
| 2 | A write reads back, and a patch leaves every field it omits as it was | `settings.test.ts` "persists a change and reads it back", "keeps the layout out of the way of the other preferences", "leaves the rest of the preferences alone" |
| 3 | A patch carrying `ui` replaces all six maps rather than merging into them | `settings.test.ts` "remembers the window layout, and writes it whole" |
| 4 | A layout entry of the wrong shape costs only itself; a pane size is capped at 4000, a read mark must be finite and positive, and fold lists are de-duplicated | `settings.test.ts` "drops layout entries of the wrong shape rather than the whole layout" |
| 5 | The look moves out once: only what differs from the default is written, cleaned so the strict layer accepts it; what the personal layer already states is kept and its patterns are appended to; every other field stays; a second run, a look of defaults, an unreadable personal layer and an absent file write nothing more | `userSettingsMigration.test.ts` "writes only what differs from the default, cleaned so the strict layer accepts it", "keeps what the personal layer already says, and appends to its patterns", "runs once: a second run finds nothing to move and touches nothing", "takes a look that was all defaults out without writing a personal layer for it", "leaves both files alone when the personal layer cannot be read", "has nothing to do without a preferences file"; `settings.test.ts` "moves the look out of user-settings.json when the app starts, once" |
| 6 | The project list keeps strings only, trimmed and de-duplicated in order | `settings.test.ts` "reads a hand-edited project list without throwing any of it away" |
| 7 | A `logging` write governs the very next log entry without a restart | `service.test.ts` "traces a run's MIDDLE, not just that it started and stopped"; `diagnostics.test.ts` "changes what is kept without a restart, which is the whole point of the control" |
| 8 | A log override with an unknown match or level, a blank key or a sampling rate outside 0 to 1 is dropped, and one override is kept per match and key | unasserted |
| 9 | `JAIRA_HOME` wins over a saved `baseDir` | unasserted |

## Every failure resets the window's state to defaults rather than stopping the app

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed mid-write | the write is not atomic; the truncated file reads as defaults, and the next write persists the defaults plus its patch | none | layout, remembered projects, read marks and the log policy are reset |
| A read meets a file another process is writing | that read answers defaults, and a write that follows it persists them | none | the same reset |
| Two writers in one process: the renderer's `ui` write and main's `projects` write | each is a synchronous read, merge and write on the main thread, so they never interleave | none needed | none |
| Two app processes share one shared root | no lock and no single-instance lock; each write replaces the whole file from what that process last read | none | the other window's changes since that read are lost |
| A retry sends the same patch | the same document is written again; `remember` skips a project already listed | none needed | none |
| The file cannot be written | `writeSettings` throws; `remember` logs a warning and the project still opens; the renderer's layout write swallows the error | fix the directory's permissions | the change is not kept across a restart |
| A patch holds values of the wrong shape | written as sent and returned unparsed; the next read parses them away | none needed | the value reverts at the next read |
| The file holds a field the parser does not know | any write rewrites the file from the parsed document, so the field is dropped | none needed | none |
| `baseDir` is saved in a relocated root's file | `settingsBaseDir` reads only `~/.jaira/user-settings.json`, so it is ignored | save it in `~/.jaira/user-settings.json` or set `JAIRA_HOME` | the app opens the default root |
| `personal-settings.json` does not parse when the migration runs | it moves nothing and leaves both files as they were; it runs again at the next start and every open | fix `personal-settings.json` | the look the old file held is not shown until it moves |
| The process stops between the migration's two writes | the personal layer was written first, so the next run finds the fields still here and moves them again, keeping what the personal layer now states: the same answer | none needed | none |
| The migration throws in `AppService`'s constructor | swallowed; the app starts, and the old file keeps its fields until the next start or open moves them | fix the shared root's permissions | the look is what the settings layers state without them |

## A file missing a field reads with its default, and a retired field is moved out and then never read

- A file written before any field existed reads with that field's default.
- A retired field is migrated out and its reader deleted: after `migrateUserSettings` nothing reads the six look fields. The module and its calls go once every machine has started once.

## The window's state file is forgiving where settings.json is strict

- `parseSettings` never refuses, because an unreadable file of window state must not stop the app opening, while an authoring error in `settings.json` is worth failing a project open.
- The look was read the same forgiving way while it lived here. As a setting it is strict, and the forgiving readers survive only inside the migration, which cleans what it moves so the strict layer accepts it.
