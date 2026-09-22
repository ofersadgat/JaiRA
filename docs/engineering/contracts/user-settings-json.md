---
id: engineering/contracts/user-settings-json
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: format
owned_by: [engineering/units/user-settings]
consumers: ["@jaira/app main service.ts readSettings, writeSettings, remember, restore, hiddenRulesFor and applyLogPolicy", "@jaira/app main index.ts, for the window background and title bar colours", "the renderer store and layout state, through settings:read and settings:write", "people editing user-settings.json by hand"]
since: 2026-08-04
siblings: [engineering/contracts/settings-json, engineering/contracts/ipc-channels]
---

# user-settings.json

`user-settings.json` is one person's app preferences on one machine, kept in the shared root beside `settings.json` and never in a checkout.

## A caller reaches for user-settings.json when a value belongs to the person at the machine, and never when a run depends on it

**Use when.** Remembering how the app looks and where it was left: theme, typography, editor looks, renderer choices, pane sizes and folds, read marks, the open projects, the log policy, a personal hidden list, the conversation layout. Reading goes through `settings:read`; changing goes through `settings:write` with a patch.

**Do not use when.** The value changes what a run does or should be shared with everyone on the project: [settings-json](settings-json.md). Holding a credential: [secret-sources](secret-sources.md).

## The shape is ten fields, each read forgivingly with its own default

### The document lives at the shared root and holds these top-level fields

The file is `<base>/user-settings.json`, UTF-8 JSON written with two-space indentation and a trailing newline. `<base>` is `--home`, else `JAIRA_HOME`, else the `baseDir` saved in `~/.jaira/user-settings.json`, else `~/.jaira`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `theme` | `"light"` or `"dark"` | no, default `"light"` | the window palette; any other value reads as `"light"` |
| `ui` | object | no | layout memory and read marks, see below |
| `projects` | string array | no, default `[]` | the projects open at quit, oldest first; trimmed, blanks and non-strings dropped, de-duplicated |
| `logging` | object | no, default `{minLevel: "info", overrides: []}` | what the app log keeps, see below |
| `baseDir` | non-empty string | no | a relocated shared root; read only from `~/.jaira/user-settings.json` |
| `editors` | object | no | how each editing surface looks, see below |
| `renderers` | object | no, default `{}` | renderer choices that disagree with the app's defaults, see below |
| `appearance` | object | no | typefaces, sizes and the editor palette, see below |
| `filesHidden` | string array | no, default `[]` | personal Files tree globs applied after `files.hidden`, last match wins; trimmed, blanks and a lone `!` dropped, de-duplicated |
| `conversation` | `{sequentialBatches: "stacked" or "band"}` | no, default `"stacked"` | whether a fan-out batch whose elements ran one after another is drawn down the page or as a band |

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

### Each editor surface answers only the knobs it has

`editors` has four keys, `code`, `markdown`, `json` and `diff`, each an object of the knobs below. A knob not listed for a surface is ignored, and a knob of the wrong type keeps its default.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `lineNumbers` | boolean | no; default true, false for `markdown` and `json` | a numbered gutter; `code`, `diff`, `markdown` |
| `wrap` | boolean | no; default false, true for `markdown` | wrap long lines; every surface |
| `minimap` | boolean | no, default false | `code`, `diff` |
| `indentGuides` | boolean | no, default true | `code`, `diff` |
| `currentLine` | boolean | no, default false | mark the caret's line; `code`, `diff`, `markdown` |
| `whitespace` | boolean | no, default false | draw spaces and tabs; `code`, `diff` |
| `brackets` | boolean | no, default false | tint matching brackets; `code`, `diff` |
| `tabSize` | 2, 4 or 8 | no, default 2 | any other number keeps the default; every surface |
| `lineHeight` | number | no; default 1.5, 1.6 for `markdown`, 1.55 for `json` | clamped to 1.1 through 2.2; every surface |

### A renderer choice is keyed by type or family and states up to four things

A key is `"<mime>:<kind>"` for one type or `"family:<family>:<kind>"` for a family, and a key without `:` is dropped. Neither the key nor the renderer ids are checked against what the app registers.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `renderers.<key>` | object | no | a value that is not an object is dropped |
| `….read` | non-empty string or `null` | no, default `null` | the renderer for the view that cannot be typed into; `null` is the app's own |
| `….write` | non-empty string or `null` | no, default `null` | the renderer for the editable view |
| `….off` | string array | no, default `[]` | renderers taken off this type's menu; de-duplicated |
| `….theme.read`, `….theme.write` | non-empty string or `null` | no, default `null` | the palette each view is painted in |

A choice whose four statements are all at their defaults is dropped.

### Appearance holds two voices, the editor size and the editor palette

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `appearance.appFamily` | string array | no, default `[]` | families tried before the app voice's default stack; trimmed, blanks dropped, de-duplicated |
| `appearance.dataFamily` | string array | no, default `[]` | the same for the data voice |
| `appearance.sizeApp` | number | no, default 12.5 | px, clamped to 11 through 17 |
| `appearance.sizeData` | number | no, default 12 | px, clamped to 10 through 16 |
| `appearance.sizeEditor` | number | no, default 13 | px, clamped to 10 through 20; used only when `advanced` is true |
| `appearance.advanced` | boolean | no, default false | separates the editor size from the data voice; only `true` counts |
| `appearance.smoothing` | boolean | no, default false | grayscale antialiasing; only `true` counts |
| `appearance.editorTheme` | non-empty string | no, default `"monokai-light"` | a palette id or `app`; an unknown id is kept and the renderer falls back |

## Nothing is refused on read, and a write fails only when the disk does

| Condition | Response | Caller does |
| --- | --- | --- |
| The file is absent, not JSON or not an object | `readSettings` answers `defaultSettings()` | nothing |
| A field or entry has the wrong shape | dropped, clamped or snapped as each table says | nothing |
| `settings:write` is sent any patch | written without validation and returned as sent | read again for the parsed value |
| The directory cannot be created or the file written | `writeSettings` throws the filesystem error | the renderer shows it, except its layout write, which ignores it; `remember` logs a warning |

## A renamed field silently resets that preference unless the file is migrated first

- The file is never validated, so a renamed or retyped field raises nothing: every file holding the old form reads with the default.
- The path is to migrate the file to the new form and then read only that form; no reader keeps the old form alive.
- A `ui` id that is retired and later reused inherits whatever value a file still holds for it.
- Narrowing a bound such as `SIZE_LIMITS` changes what existing files read as.

## A write rewrites the whole file, and a nested patch replaces the whole block

- `settings:write` merges one level deep. A patch carrying `ui`, `appearance`, `editors`, `logging`, `renderers` or `conversation` replaces that entire block, so every caller sends the block whole.
- Every write is `{...readSettings(), ...patch}`. Fields the parser does not know are dropped from the file, and a corrupt file followed by any write persists the defaults plus that patch.
- A write is not atomic and takes no lock. Two app processes on one shared root overwrite each other's changes.
- `baseDir` is read only from `~/.jaira/user-settings.json`. The same field in a relocated root's file is kept and never read, and no code writes it.
- Corruption resets every preference with no message.
