---
id: engineering/units/user-settings
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/read-comfortably, product/all-projects-in-one-place, product/see-what-changed-since-you-looked, ux/patterns/the-window-remembers-its-arrangement, ui/surfaces/settings-appearance, ui/surfaces/settings-conversation]
layer: data
owns_contracts: [engineering/contracts/user-settings-json]
requires: [engineering/units/project-layout, engineering/units/app-log]
implemented_by: [packages/shared/src/settings.ts, packages/app/src/main/service.ts]
verified_by: [packages/app/test/settings.test.ts, packages/app/test/appearance.test.ts, packages/app/test/editorLook.test.ts, packages/app/test/fileTypes.test.ts, packages/app/test/service.test.ts, packages/app/test/diagnostics.test.ts]
siblings: [engineering/units/project-config, engineering/units/ui-layout-state, engineering/units/renderer-store]
---

# User settings

## User settings reads one person's preferences forgivingly and writes a patch merged one level deep

`settings.ts` in `@jaira/shared` holds the document and its reading:

- `JairaSettings`, `defaultSettings()` and the per-field defaults: `defaultUiState`, `defaultAppearance`, `defaultEditors`, `defaultLogPolicy`, `defaultConversationLook`, `defaultRendererChoice`.
- `parseSettings(raw)`, which never throws: a value of the wrong shape is dropped, clamped or snapped per entry, and anything that is not an object reads as `defaultSettings()`. `parseLogPolicy` does the same for `logging`.
- The bounds it reads against: `SIZE_LIMITS`, `TAB_SIZES`, `LINE_HEIGHT`, `EDITOR_KNOBS` and the 4000 px pane cap.
- `SETTINGS_FILE_NAME` and `USER_SETTINGS_FILE_NAME`.

`AppService` in `service.ts` owns the file:

- `readSettings()` reads `<base>/user-settings.json` through `readSettingsFile`, which answers `defaultSettings()` for an absent or unparsable file.
- `writeSettings(patch)` writes `{...readSettings(), ...patch}` whole and returns that object. A patch carrying `logging` re-installs the log policy at once through `applyLogPolicy`.
- `settingsBaseDir()` picks the shared root when the service is given none: `JAIRA_HOME`, then the `baseDir` saved in `~/.jaira/user-settings.json`, then `~/.jaira`. A `--home` flag reaches the service as `baseDir` and beats all three.

It deliberately does not own:

- The layout ids, the debounced `ui` writes and the rule that the window owns `ui` after hydration: [ui-layout-state](ui-layout-state.md) and [renderer-store](renderer-store.md).
- Opening the remembered projects and forgetting the missing ones, which call `writeSettings` with `projects`: [project-sessions](project-sessions.md).
- What a log policy keeps: [app-log](app-log.md). Which renderer a choice resolves to and how hidden rules compile: [files-view-models](files-view-models.md).
- Anything a run depends on: [project-config](project-config.md).

## The reader is browser-safe shared code, and only the main process touches the file

- Layer `data`. `settings.ts` is exported through `@jaira/shared/browser`, so the renderer uses the same types and defaults.
- The file is read and written only by `AppService`, behind `settings:read` and `settings:write`; the channels are in [ipc-channels](../contracts/ipc-channels.md). `index.ts` also reads the theme to paint the window and repaints the title bar after every `settings:write`.
- Boundary: derived and committed. The file lives in the shared root, never in a checkout, so no preference arrives through a pull request.
- No upstream seam.

## The file is the truth, except for the layout the renderer holds between writes

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `<base>/user-settings.json` | read on every `readSettings`; written whole on every `writeSettings` | the file | hand edits |
| `ui` | written whole by the renderer's debounced write | the renderer's copy after hydration, the file before it | [ui-layout-state](ui-layout-state.md) |
| `projects` | written by `remember` on open and by `restore` when it forgets a directory | the file | [project-sessions](project-sessions.md) |
| `baseDir` | read once at construction, from `~/.jaira/user-settings.json` only | that file | nothing in the app writes it |
| the installed log policy | set from `logging` at construction and after a write that carries it | the file | [app-log](app-log.md) |

## The invariants keep the app opening whatever the file holds

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An absent or corrupt file reads as the defaults and never throws | `settings.test.ts` "defaults to the light theme, with no project open", "falls back to defaults rather than throwing on a corrupt file" |
| 2 | A write reads back, and a patch leaves every field it omits as it was | `settings.test.ts` "persists a change and reads it back", "keeps the layout out of the way of the other preferences", "leaves the rest of the preferences alone" |
| 3 | A patch carrying `ui` replaces all six maps rather than merging into them | `settings.test.ts` "remembers the window layout, and writes it whole" |
| 4 | A layout entry of the wrong shape costs only itself; a pane size is capped at 4000, a read mark must be finite and positive, and fold lists are de-duplicated | `settings.test.ts` "drops layout entries of the wrong shape rather than the whole layout" |
| 5 | A file that states only a theme reads every other field as its default, and the JSON editor's wrap defaults off | `settings.test.ts` "reads a settings file that states only a theme", "keeps the JSON editor's wrap preference, and defaults it off" |
| 6 | The project list keeps strings only, trimmed and de-duplicated in order | `settings.test.ts` "reads a hand-edited project list without throwing any of it away" |
| 7 | A size outside `SIZE_LIMITS` is clamped, a size that is not a number keeps the default, and a family list is de-duplicated | `appearance.test.ts` "clamps a size rather than dropping it", "ignores a size that is not a number at all, keeping the default", "de-duplicates a family list, because a repeat can never be reached", "keeps the readable fields of a half-broken document" |
| 8 | A tab width snaps to 2, 4 or 8, a line height is clamped, and a knob a surface lacks is ignored | `editorLook.test.ts` "snaps a tab width to one the control offers, rather than clamping it", "clamps line spacing instead of dropping it", "ignores a knob the surface does not have, however the file spells it", "keeps the readable knobs of a half-broken document" |
| 9 | A renderer key without `:` or a choice saying nothing is dropped, and an unknown renderer id is kept | `fileTypes.test.ts` "keeps a choice, and drops what is not one", "drops a line that says nothing at all", "keeps a key for a renderer this build no longer has" |
| 10 | A `logging` write governs the very next log entry without a restart | `service.test.ts` "traces a run's MIDDLE, not just that it started and stopped"; `diagnostics.test.ts` "changes what is kept without a restart, which is the whole point of the control" |
| 11 | A log override with an unknown match or level, a blank key or a sampling rate outside 0 to 1 is dropped, and one override is kept per match and key | unasserted |
| 12 | `JAIRA_HOME` wins over a saved `baseDir` | unasserted |

## Every failure resets preferences to defaults rather than stopping the app

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed mid-write | the write is not atomic; the truncated file reads as defaults, and the next write persists the defaults plus its patch | none | theme, layout, remembered projects and read marks are reset |
| A read meets a file another process is writing | that read answers defaults, and a write that follows it persists them | none | the same reset |
| Two writers in one process: the renderer's `ui` write and main's `projects` write | each is a synchronous read, merge and write on the main thread, so they never interleave | none needed | none |
| Two app processes share one shared root | no lock and no single-instance lock; each write replaces the whole file from what that process last read | none | the other window's changes since that read are lost |
| A retry sends the same patch | the same document is written again; `remember` skips a project already listed | none needed | none |
| The file cannot be written | `writeSettings` throws; `remember` logs a warning and the project still opens; the renderer's layout write swallows the error | fix the directory's permissions | the preference is not kept across a restart |
| A patch holds values of the wrong shape | written as sent and returned unparsed; the next read parses them away | none needed | the value reverts at the next read |
| The file holds a field the parser does not know | any write rewrites the file from the parsed document, so the field is dropped | none needed | none |
| `baseDir` is saved in a relocated root's file | `settingsBaseDir` reads only `~/.jaira/user-settings.json`, so it is ignored | save it in `~/.jaira/user-settings.json` or set `JAIRA_HOME` | the app opens the default root |

## A file missing a field reads with its default, and the next write rewrites it in the current shape

- A file written before any field existed reads with that field's default.

## The preferences file is forgiving where settings.json is strict

- `parseSettings` never refuses, because an unreadable preferences file must not stop the app opening, while an authoring error in `settings.json` is worth failing a project open.
