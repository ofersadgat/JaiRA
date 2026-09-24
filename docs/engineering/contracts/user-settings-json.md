---
id: engineering/contracts/user-settings-json
type: engineering-contract
status: shipped
updated: 2026-09-23
visibility: internal
kind: format
owned_by: [engineering/units/user-settings]
consumers: ["@jaira/app main service.ts readSettings, writeSettings, remember, restore and applyLogPolicy", "@jaira/persistence userSettingsMigration.ts migrateUserSettings, which moved the look out", "the renderer store and layout state, through settings:read and settings:write", "people editing user-settings.json by hand"]
since: 2026-08-04
siblings: [engineering/contracts/settings-json, engineering/contracts/ipc-channels]
---

# user-settings.json

`user-settings.json` is the window's own state on one machine — where its panes were left, what is folded, which conversations have been read, how loudly the log talks, which projects were open — kept in the shared root beside `settings.json` and never in a checkout.

## A caller reaches for user-settings.json when a value is a gesture the window remembers, and never for a setting

**Use when.** Remembering where the window was left: pane sizes and folds, read marks, the open projects, the log policy, a relocated shared root, the forge sign-in marks. Reading goes through `settings:read`; changing goes through `settings:write` with a patch.

**Do not use when.** The value is a setting — anything a project or the shared root may also have an opinion about, including how the app LOOKS: that is [settings-json](settings-json.md), whose personal layer, `personal-settings.json` ("Just you"), holds one person's own answers and is read after every other layer. Holding a credential: [secret-sources](secret-sources.md).

## The shape is five fields and the sign-in marks, each read forgivingly with its own default

### The document lives at the shared root and holds these top-level fields

The file is `<base>/user-settings.json`, UTF-8 JSON written with two-space indentation and a trailing newline. `<base>` is `--home`, else `JAIRA_HOME`, else the `baseDir` saved in `~/.jaira/user-settings.json`, else `~/.jaira`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ui` | object | no | layout memory and read marks, see below |
| `projects` | string array | no, default `[]` | the projects open at quit, oldest first; trimmed, blanks and non-strings dropped, de-duplicated |
| `logging` | object | no, default `{minLevel: "info", overrides: []}` | what the app log keeps, see below |
| `baseDir` | non-empty string | no | a relocated shared root; read only from `~/.jaira/user-settings.json` |
| `forgeSignIns` | object keyed by secret name | no, absent when empty | the forge tokens a sign-in through the browser stored: `{provider: "github" \| "gitlab", host, source: SecretSource, at, expiresAt?, refreshCredential?}` — where the token was written, when, when it dies and the secret its refresh token is under. Written and removed by main only ([forge-integrations](../units/forge-integrations.md)); an entry missing `provider`, `host`, `source` or `at` is dropped on read. A check reports `via: "oauth"` only while the chain still finds the token at `source` |

### The layout block is six maps keyed by ids the renderer owns

Every map defaults to `{}`, and an absent id means that control's own default. The ids are [ui-layout-state](../units/ui-layout-state.md)'s.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ui.panes.<id>` | finite number greater than 0 | no | a pane size in px, capped at 4000 on read |
| `ui.open.<id>` | boolean | no | a disclosure, `true` open |
| `ui.modes.<id>` | string | no | the position of a control with more than two positions |
| `ui.shut.<treeId>` | string array | no | row keys folded in a tree that defaults to expanded; de-duplicated |
| `ui.unfolded.<treeId>` | string array | no | row keys opened in a tree that defaults to collapsed; de-duplicated |
| `ui.seen.<taskId>` | finite number greater than 0 | no | the `updatedAt` epoch ms of the newest turn the person has had on screen |

### The log policy is a floor and a list of overrides

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `logging.minLevel` | `"debug"`, `"info"`, `"warn"` or `"error"` | no, default `"info"` | the floor where no override matches |
| `logging.overrides[i].match` | `"scope"` or `"tag"` | yes | what `key` is compared with |
| `logging.overrides[i].key` | non-blank string | yes | the scope or tag, trimmed |
| `logging.overrides[i].minLevel` | level | yes | the floor for matching records |
| `logging.overrides[i].samplingRate` | number from 0 to 1 | no | the fraction of matching non-error records kept; `1` and out-of-range values are dropped |

An override with an unknown `match` or `minLevel`, or a blank `key`, is dropped. Of two overrides with the same `match` and `key`, the later is kept.

### The look moved out, once

The file used to hold the look too: `theme`, `appearance`, `editors`, `renderers`, `conversation` and a personal `filesHidden`. On 2026-09-23 they became settings — the `appearance` block and `files.hidden` of [settings-json](settings-json.md) — and `migrateUserSettings` (`@jaira/persistence` `userSettingsMigration.ts`) moves them into `personal-settings.json`: as the app's service is constructed, before anything paints, and at every project open, so the CLI's first open moves them too. It reads them the way this file used to be read — forgivingly, a size clamped, an unreadable value dropped — writes only what differs from the default, keeps what the personal layer already states, appends the patterns to its `files.hidden`, and then removes the six fields from this file, leaving every other field as it was. A file with none of them is not touched; a personal layer that cannot be read leaves both files alone. The reader of the old fields is gone: after the move nothing reads them.

## Nothing is refused on read, and a write fails only when the disk does

| Condition | Response | Caller does |
| --- | --- | --- |
| The file is absent, not JSON or not an object | `readSettings` answers `defaultSettings()` | nothing |
| A field or entry has the wrong shape | dropped or capped as each table says | nothing |
| `settings:write` is sent any patch | written without validation and returned as sent | read again for the parsed value |
| The directory cannot be created or the file written | `writeSettings` throws the filesystem error | the renderer shows it, except its layout write, which ignores it; `remember` logs a warning |

## A renamed field silently resets that preference unless the file is migrated first

- The file is never validated, so a renamed or retyped field raises nothing: every file holding the old form reads with the default.
- The path is to migrate the file to the new form and then read only that form; no reader keeps the old form alive — the move of the look above is the example.
- A `ui` id that is retired and later reused inherits whatever value a file still holds for it.

## A write rewrites the whole file, and a nested patch replaces the whole block

- `settings:write` merges one level deep. A patch carrying `ui` or `logging` replaces that entire block, so every caller sends the block whole.
- Every write is `{...readSettings(), ...patch}`. Fields the parser does not know are dropped from the file, and a corrupt file followed by any write persists the defaults plus that patch.
- A write is not atomic and takes no lock. Two app processes on one shared root overwrite each other's changes — which is why the personal settings layer is a file of its own rather than a field here.
- `baseDir` is read only from `~/.jaira/user-settings.json`. The same field in a relocated root's file is kept and never read, and no code writes it.
- Corruption resets every field with no message.
