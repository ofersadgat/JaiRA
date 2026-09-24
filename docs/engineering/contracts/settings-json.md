---
id: engineering/contracts/settings-json
type: engineering-contract
status: shipped
updated: 2026-09-23
visibility: public
kind: format
owned_by: [engineering/units/project-config]
consumers: ["@jaira/persistence project.ts loadLayeredConfig, openSharedProject and initProject", "@jaira/app main service.ts files:hiddenReport and files:whyHidden, from each layer's files.hidden", "@jaira/persistence hiddenMigration.ts migrateHiddenLists, at every open", "@jaira/runtime presetModels.ts withPresetModels, and wiring.ts defaultExecutorTree's start-time check", "@jaira/persistence settingsMigration.ts migrateSettingsLayers, at every open", "@jaira/persistence userSettingsMigration.ts migrateUserSettings, at every open and as the app's service starts", "@jaira/app main index.ts, the window frame through AppService.windowAppearance", "@jaira/persistence workflowRefs.ts, workflows.ts and lifecycle.ts through workflows.path", "@jaira/app main service.ts config:read, config:write and every run it starts", "@jaira/runtime modelRoutes.ts, executors.ts, agents.ts and policy.ts", "@jaira/cli runs and task commands", "the renderer Settings panes, through config:read and config:write", "people editing settings.json by hand"]
since: 2026-07-17
siblings: [engineering/contracts/user-settings-json, engineering/contracts/secret-sources, engineering/contracts/jaira-layout, engineering/contracts/artifact-destination-template]
---

# settings.json

`settings.json` is the committed JSON document that says how a project's runs are routed, executed, stored and constrained, and how the app looks, shipped once in the built-in layer, written once in the shared root and optionally again in a project, each laid over the one below — and a last time, with the same schema, as the person's own `personal-settings.json` ("Just you"), laid over all of them.

## A caller reaches for settings.json when a choice should travel with the project, and never for a secret or a preference

**Use when.** Configuring model routes and presets, the default executor tree, agent runtimes, the defaults of the functions JaiRA ships, artifact placement, storage modes, the exec environment, the workflow search path, the Files tree's hidden list, the MCP servers agents are handed, or how the app looks (`appearance`). Reading the configuration a run will use: parse the merged document with `parseConfig(mergeConfigLayers([builtIn, base, project, you]))`, or read `Project.config`.

**Do not use when.** Storing a credential value: name it in a `credential` field and store it through [secret-sources](secret-sources.md). Recording the window's own state — pane sizes, folds, read marks, the log policy, the open projects: [user-settings-json](user-settings-json.md). Deciding where the files live: [jaira-layout](jaira-layout.md). Saying what a command may run: that is a line under the `bash` tool of a permission set ([tool-policy](../units/tool-policy.md)).

## The shape is one object per layer, merged before it is parsed

### The four layers merge key by key, weakest first, and only the merge is validated

| Layer | File | Whose |
| --- | --- | --- |
| Built in (`system`) | `$SYSTEM/settings.json` | what JaiRA ships; read-only |
| Shared (`base`) | `<base>/settings.json` | every project on this machine reads it |
| This project (`project`) | `<project>/.jaira/settings.json` | committed with the checkout |
| Just you (`you`) | `<base>/personal-settings.json` | this person on this machine; never in a checkout, and read after every other layer |

The built-in layer is `$SYSTEM/settings.json`: `packages/shared/builtin/settings.json`, copied to `dist/builtin/` by both bundlers and found by `jairaBuiltInPaths().settingsFile` ([decision 0006](../decisions/0006-built-in-layer.md)). It is read-only: nothing writes it, no `ConfigLayer` names it, and editing a value it holds writes that value into the layer being edited. The shared layer is `<base>/settings.json`. The project layer is `<project>/.jaira/settings.json`. Any may be absent; with all absent the configuration is `defaultConfig()`. `loadLayeredConfig` merges built in, then shared, then project, then the personal layer; the shared root opened as a project merges built in, its own file and the personal one, with no project layer between. `config:read` returns the built-in document as `ConfigView.system` and the personal one as `ConfigView.you` beside `base` and `project`, and `config:write` validates a layer merged with all the others. The personal layer is a file of its own rather than a key of `user-settings.json` because that file has its own whole-file writer, and two writers of one file overwrite each other.

What ships in it:

```json
{
  "models": { "presets": {
    "simple":  { "model": { "candidates": ["claude-haiku-4-5", "gpt-5.6-luna"], "choose": "first-available" } },
    "coder":   { "model": { "candidates": ["claude-opus-5-5", "gpt-5.6-terra"], "choose": "first-available" }, "reasoning": { "effort": "high" } },
    "planner": { "model": { "candidates": ["claude-fable-5-1", "gpt-5.6-sol"], "choose": "first-available" }, "reasoning": { "effort": "high" } }
  } },
  "functions": { "smart": { "model": "simple" } }
}
```

No default model: `executors.default.prompt.defaults.model` stays unset.

`mergeConfigLayers(docs)` folds `mergeConfigDocuments(under, over)` from the weakest layer up, an absent (`undefined` or `null`) layer counting as empty. Each step:

- A plain object in both layers merges key by key, recursively.
- An array, a scalar or `null` in the project replaces the base's value, except `files.hidden`.
- `files.hidden` in both layers CONCATENATES, the base's rules first. It is a list of rules applied in order, last match wins, so a layer's list is what it adds and a layer takes a rule back with `!pattern`.
- `agents.genericCli` merges by entry `name`, an absent name counting as `generic-cli`: a project entry with a base entry's name merges into it in the base's position, and a new name is appended.
- A layer that is not a plain object yields the other layer.

`inheritedDoc(view, layer)` is the merge of the layers weaker than `layer`; `statingLayer(view, path, below?)` is the strongest layer (below a given one) whose document states a dotted path, or `"built in"`; `inheritedValue` pairs the two, and is what a Settings row's "instead of … from …" line reads.

### The top-level keys are thirteen blocks, an unknown top-level key is ignored, and `policy` and `smart` are refused

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `models` | object | no | how each route prefix is reached, and named presets |
| `executors` | object of operation nodes | no | sparse overlays over derived executor trees; only `executors.default` is used |
| `artifacts` | object | no | where artifact bytes land and when a producer asks first |
| `storage` | object | no | whether each concern's truth is a file, the database or both |
| `memo` | object | no | `{enabled?: boolean}`, default `false`; parsed and read by nothing |
| `execEnvironment` | `"windows"` or `{wsl: non-empty string}` | no, default `"windows"` | where commands, git and agents run; keys beside `wsl` are ignored |
| `agents` | object | no | the agent runtimes this project registers |
| `workflows` | `{path?: string[]}` | no | the search path a bare workflow reference walks |
| `files` | `{hidden?: string[]}` | no | the Files tree's shared hidden globs |
| `integrations` | `{forges?: object, oauth?: object}` | no | connections to forges, one per host ([decision 0004](../decisions/0004-remote-review.md)), and the OAuth apps a forge sign-in uses, see below; `integrations.review` is refused, naming `functions.review_artifacts.settleAfter`; left out of the file `initProject` writes, so the shared root's connections are not shadowed |
| `autopilot` | `{askBelow?: number}` | no, default `{askBelow: 0.2}` | how sure a fast-forward's controlling conversation must be before its answer stands in for the person's ([decision 0005](../decisions/0005-connect.md) §6); `0`–`1`, `1` never answers for you and `0` always. It is no workflow's threshold and names no workflow input. Left out of the file `initProject` writes, because it is a person's setting and belongs in the shared root |
| `functions` | object | no, every default | each shipped function's defaults, by the function's name; below. Left out of the file `initProject` writes, for the reason `autopilot` is |
| `mcp` | `{servers?: object}` | no, default `{servers: {}}` | the MCP servers every agent run is handed, by the name their tools are called under; below ([mcp-servers](../units/mcp-servers.md)) |
| `appearance` | object | no, every default | how the app looks — mode, palette, board options, typography, the conversation's layout, the editors and the renderer choices; below. Usually stated in the personal layer, and left out of the file `initProject` writes |
| `policy` | any | refused | throws `config.policy is dissolved: …`, naming where each of its parts went; a document still carrying it is migrated at open |
| `smart` | any | refused | throws `config.smart has moved to functions.smart`; a document still carrying it is migrated at open |

### A route block's allowed fields follow from its key

`models` holds `routes`, `presets` and nothing else that is read; another key is ignored, except `default`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `models.default` | any | refused | throws `config.models.default has moved`, naming `executors.default.prompt.defaults.model` |
| `models.presets.<name>` | object of JSON values | no | a model and a prompt configuration a state selects with `operation.configRef`, merged under the state's own config and over the default executor's defaults BEFORE the call is routed (`withPresetModels`); a `configRef` naming no preset fails the call, listing the presets there are. `<name>` matches `^[A-Za-z][A-Za-z0-9_]*$`, is not `default`, and is no word a model family claims (`o3`, `gpt5`); anything else is refused, naming the preset (`presetNameRefusal`) |
| `models.presets.<name>.model` | non-empty model id, or `{candidates, choose}` | no | the model a state picking the preset runs on. An id is used as a state's own `model` is. `candidates` is a non-empty list of model ids, none of them a preset's name. `choose` is required and is `"first-available"`, the only rule: when a session is created the first candidate available here answers, and the session keeps it; a resumed session keeps the candidate its record names; with none available the call fails, naming each candidate and why. Available means the id resolves to a configured route and the last check does not say that route failed or needs a sign-in (the CLI takes no check, so configured is its whole test). An unknown field, or any other `choose`, is refused |
| `models.routes.<key>` | object | no | one route; `<key>` is `anthropic`, `openrouter`, `local` or `embedded`, and a field not listed for that key is refused |
| `….enabled` | boolean | no, default on | `false` makes the route unusable without deleting it; all four keys |
| `….credential` | non-empty string with no whitespace | no | the secret NAME the key is resolved under; `anthropic`, `openrouter` and `local`. Absent on a remote route means the chain is asked for `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` |
| `local.baseURL` | non-empty string | no | the OpenAI-compatible base URL, version path included |
| `local.headers` | object of strings | no | extra request headers |
| `local.supportsStructuredOutputs` | boolean | no, default true | a ceiling on sending `json_schema` response formats |
| `local.serve` | object | no | how to start the server when nothing answers; absent means attach only |
| `local.serve.command` | non-empty string | yes | the server executable |
| `local.serve.args` | string array | no | its arguments |
| `local.serve.env` | object of strings | no | extra environment |
| `local.serve.readyUrl` | string | no | polled until it answers; defaults to `${baseURL}/models` |
| `local.serve.readyTimeoutMs` | number | no | how long to poll |
| `embedded.weights.<modelId>` | object | no | the weights loaded for a provider-native model id |
| `….modelPath` | non-empty string | yes | the GGUF path, or a split model's first part |
| `….contextSize`, `….sequences` | number | no | dropped silently when not a number |
| `….gpuLayers` | number, `"auto"` or `"max"` | no | carried through unchecked |

### An executor is a tree of nodes, strict about every field that is present

Resolving an overlay into a tree and what each level does belong to [executor-tree](../units/executor-tree.md). Every node below may also carry `steps` and `scopes`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `executors.<name>` | operation node | no | `<name>` may not contain `/`, because it is a model prefix |
| operation `kind` | `"operation"` | no | any other value is refused |
| operation `description` | non-empty string | no | one line for the Settings screen |
| operation `function` | function node | no | the function half |
| operation `prompt` | prompt node | no | the prompt half; with no `kind` it is a router |
| function `kind` | `"function"` | no | |
| function `rules` | non-empty array of rules | no | ordered, last match wins: `everything` or `*`, `nothing`, `+name`, `-name`, and a bare name meaning `+name`; absent means everything |
| router `kind` | `"router"` | no at the top of `prompt` or `fallback`, where it is the default | |
| router `defaults` | object of JSON values | no | call settings applied before dispatch |
| router `routes.<prefix>` | prompt node | no | `<prefix>` may not contain `/`; a node here with no `kind` is a leaf whose prefix names it |
| router `fallback` | prompt node | no | where an id whose prefix names no route goes |
| provider `kind` | `"provider"` | yes for a stated provider | |
| provider `provider` | non-empty string | no | the route prefix |
| agent `kind` | `"agent"` | yes for a stated agent | |
| agent `agent` | non-empty string | no | the registry name |
| leaf `provider`, `agent` | non-empty string | no | either may name a leaf under `routes` |
| provider, agent or leaf `model` | non-empty string | no | the model as the route knows it; a value starting with the node's own name and `/` is refused |
| provider, agent or leaf `allow` | non-empty array of non-empty strings | no | patterns a requested model must match |
| provider, agent or leaf `defaults` | object of JSON values | no | call settings merged under a state's own |

### Steps and scopes are checked against fixed vocabularies

`steps` is an object whose keys are step names. An unknown step, an unknown field, a string that is empty and a number that is not finite are refused.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `steps.memoize` | `{namespace?: string, strictCacheWrites?: boolean}` | no | outermost; remember answers |
| `steps.retry` | `{transient?, baseBackoffMs?, maxBackoffMs?: number, validation?: {turns?: number, feedback?: boolean}}` | no | re-attempt retriable failures and schema repairs |
| `steps.rateLimit` | `{maxConcurrency?, initialConcurrency?, minConcurrency?, increaseEvery?, rpm?, inputTpm?, outputTpm?: number}` | no | admission and backoff |
| `steps.deadline` | `{maxDurationMs: number, safetyMarginMs?, floorMs?: number}` | no | innermost; `maxDurationMs` is required |
| `scopes` | array | no | where anything under the node may act; enforcement belongs to [tool-policy](../units/tool-policy.md) |
| `scopes[i].path` | non-empty glob | exactly one of `path` and `url` | a filesystem place |
| `scopes[i].url` | non-empty glob | exactly one of `path` and `url` | a network place |
| `scopes[i].tools` | object of `allow`, `deny` or `ask` by tool name (a function is a permission set's, never a place's) | one of `tools` and `default` | per-tool modes in that place |
| `scopes[i].default` | `allow`, `deny` or `ask` | one of `tools` and `default` | the mode for a tool with no entry |

### Artifacts, storage, workflows and files each have fixed fields and defaults

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `artifacts.destination` | non-empty string | no, default `"$DEFAULT"` | the template in [artifact-destination-template](artifact-destination-template.md), checked only when a run is wired |
| `artifacts.dir` | non-empty string | no, default `"artifacts"` | what `$ARTIFACT_DIR` expands to |
| `artifacts.inlineMaxBytes` | non-negative integer | no, default `65536` | content below this is kept inline as well as placed; not a size limit |
| `artifacts.askAboveBytes` | non-negative integer | no, default `4194304` | producing more than this asks a person; `0` never asks |
| `storage.journal`, `storage.conversations`, `storage.tasks`, `storage.artifacts` | `"file"`, `"db"` or `"both"` | no, default `"db"` | where that concern's truth is; the modes are [storage-policy](../units/storage-policy.md) |
| `storage.format` | `"claude"` or `"codex"` | no, default `"claude"` | the line shape a file-backed conversation is written in |
| `workflows.path` | non-empty array of non-empty strings | no | each entry starts with `$` or is absolute; absent means the layer roots' `workflows` and `functions` in order |
| `files.hidden` | array of non-empty strings | no | glob rules this layer ADDS, trimmed, order kept; the effective list is the built-in defaults, then the shared layer's, the project's and the person's, and the last rule to match a path decides; absent and `[]` both add nothing |

### What the Files tree hides by default, in the groups the Files tree section draws

`DEFAULT_HIDDEN_PATHS` in `@jaira/shared` `hiddenPaths.ts`, the flattening of `HIDDEN_PATH_GROUPS`. They come first in the effective list, before any layer's `files.hidden`. A pattern is a glob matched against the path relative to the tree's root, case-insensitively, and a folder that matches takes its contents with it.

| Group | Patterns |
| --- | --- |
| JaiRA's own files | `system`, `.jaira/system`, `settings.json`, `.jaira/settings.json`, `user-settings.json`, `sync.json`, `personal-settings.json` |
| Secrets | `**/.env`, `**/.env.*` |
| Version control | `.git` |
| Dependencies | `**/node_modules`, `**/vendor`, `**/__pycache__` |
| Build output | `**/dist`, `**/out`, `**/target`, `**/coverage` |

`**/build` was a default until 2026-09-23 and is not one now.

### The functions block holds each shipped function's defaults, strict about every field

`functions` is keyed by the name a workflow or a permission set calls the function by ([decision 0007](../decisions/0007-permissionSets.md), amended 2026-09-23). The parsed block always carries every default. An unknown function, an unknown field and a value of the wrong kind are refused, naming the field. Settings draws it through `CONFIG_SECTIONS` (`configSchema.ts`), one sub-form per function.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `functions.smart.model` | string | no | the model the shipped `smart` permission function judges a call with, written as a state's `model` is, or a preset's name (below). The built-in layer sets `"simple"`. Empty or absent is the default executor's |
| `functions.smart.prompt` | string | no | what the judge is told; empty or absent is `DEFAULT_SMART_PROMPT`. The call is appended as JSON |
| `functions.review_artifacts.publish` | `"ask"`, `"allow"` or `"deny"` | no, default `"ask"` | whether a workflow may push and open a merge request from here: once per task, without asking, or never |
| `functions.review_artifacts.settleAfter` | duration string (`"10m"`, `"90s"`, `"2h"`, `"0"`) | no, default `"10m"` | the quiet window after the last comment on the forge; a state's `remote.settle_after` overrides it |
| `functions.bash.builtins` | boolean | no, default `true` | `false` turns off the built-in destructive-git and `rm -r .git` refusals and the push, install, publish, network and credentials-path questions, which otherwise stand above every permission set |

**A model field may name a preset.** In `functions.smart.model`, `executors.default.prompt.defaults.model` and a state's own `model`, a value exactly equal to the name of a preset in the merged `models.presets` means that preset's model: its model alone, not its other settings (`resolveModelField`). Naming a preset that has no model fails the call. The name rule above keeps the two apart: every model id holds a `-`, `/`, `.` or `:`, or is a word a model family claims, and no preset name can. A call outside a session, such as the judge's, chooses afresh each time.

A command rule has no place here. What a command may run is a line under the `bash` tool of a permission set (`"git push --force": "deny"`), and a line no permission set judges answers to the built-ins alone ([tool-policy](../units/tool-policy.md)).

### The integrations block names forges, never holds a token, and refuses what it does not know

`parseIntegrations` in `@jaira/shared` `forge.ts`. Every field present is checked, and an unknown one is refused by name. The built-in connections `gitlab` (`gitlab.com`, `GITLAB_TOKEN`) and `github` (`github.com`, `GITHUB_TOKEN`) are laid under what a layer writes, so a layer states only what it changes. What reads it is [forge-integrations](../units/forge-integrations.md).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `integrations.forges.<name>` | object | no | one connection; `<name>` is letters, digits, `-` and `_`, because a host has dots |
| `….provider` | `"gitlab"` or `"github"` | yes, unless a built-in supplies it | which provider's code talks to it |
| `….host` | host as a git remote spells it | yes, unless a built-in supplies it | lower-cased, no scheme; two connections on one host are refused |
| `….credential` | secret name | no | the token's NAME in the secret chain; absent, the connection cannot call the API |
| `….enabled` | boolean | no, default on | `false` turns the connection off without deleting it |
| `….apiUrl` | http(s) URL | no | where the API is when the host's convention does not say; a forge sign-in's web root is this without `/api/v4` or `/api/v3` |
| `integrations.oauth.<provider>` | `{clientId}` | no, default none | the OAuth app a forge sign-in through the browser uses (RFC 8628's device flow); `<provider>` is `github` or `gitlab`, and any other key is refused |
| `integrations.oauth.<provider>.clientId` | one word, no whitespace | yes in an entry | the app's client ID — only the id: a device flow is a public client, so there is no secret to name. On GitHub the app has "Enable Device Flow" ticked; on GitLab it is not confidential and allows `api`. Absent, gitlab.com and github.com sign in through JaiRA's own apps (`BUILTIN_OAUTH_APPS`, `oauthAppFor` in `forge.ts`), and any other host answers `ok: false` saying to set this field; a pasted token still works everywhere. An id named here serves every host of that provider, the public one included |

### The mcp block names servers by the subject their tools are judged by, and never holds a secret

`parseMcp` in `@jaira/shared` `mcp.ts`. Strict: an unknown field, a server that is both a command and a URL (or neither), and a value of the wrong kind are refused naming the field. Merged by server name like every object, so a layer that says `{ "enabled": false }` of a shared server turns it off without restating it. What reads it is [mcp-servers](../units/mcp-servers.md).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `mcp.servers.<name>` | object | no | one server. `<name>` is letters, digits, `-` and `_`, with no `__` and no `_` at either end, because its tools are called `mcp__<name>__<tool>`; `dai`, the bridge every agent run already has, is refused |
| `….command` | non-empty string | one of `command` and `url` | a server JaiRA starts, speaking MCP on stdio |
| `….args` | array of strings | no | its arguments, in order |
| `….env` | object of a string or `{credential}` | no | what it is started with; `{ "credential": "<name>" }` NAMES a secret, looked up when it starts through the chain a provider's `credential` is — a name with whitespace in it is refused |
| `….cwd` | non-empty string | no | where it runs; claude takes none, the tools probe and codex do |
| `….url` | http(s) URL | one of `command` and `url` | a server JaiRA calls: streamable HTTP, SSE for an older one |
| `….headers` | object of a string or `{credential}` | no, `url` only | sent with every request, a secret by name as in `env` |
| `….enabled` | boolean | no, default on | `false` hands the server to no agent and starts it for no probe |
### The appearance block is the look, strict about every field that is present

`parseAppearanceConfig` in `@jaira/shared` `appearanceConfig.ts`; the types and defaults are `settings.ts`'s (`Appearance`, `EditorLook`, `RendererChoice`). The parsed block always carries every default. An unknown key, a value of the wrong kind, a palette this release does not have, a size outside its control's range and an editor knob its surface cannot honour are refused, naming the field. The renderer paints the EFFECTIVE block of the address it stands on; the window frame and the OS window controls are painted from the shared root and the personal layer alone (`AppService.windowAppearance`), because a window holds several projects.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `appearance.mode` | `"light"`, `"dark"` or `"system"` | no, default `"light"` | `system` follows the operating system |
| `appearance.palette` | one of `PALETTES` | no, default `"ink"` | the window's palette |
| `appearance.laneColors`, `appearance.statusWash` | boolean or `null` | no, default `null` | a board option; `null` is the palette's own, and is how a layer takes a weaker layer's choice back |
| `appearance.buckets` | `"box"`, `"line"` or `null` | no, default `null` | columns as a box or a rule |
| `appearance.appFamily`, `appearance.dataFamily` | array of font names | no, default `[]` | families tried before the default stack; trimmed, and a name twice is refused |
| `appearance.sizeApp`, `sizeData`, `sizeEditor` | number within `SIZE_LIMITS` | no, defaults 12.5, 12 and 13 | each voice's base size in px |
| `appearance.advanced` | boolean | no, default `false` | the editors take `sizeEditor` rather than following the data font |
| `appearance.smoothing` | boolean | no, default `false` | grayscale antialiasing |
| `appearance.editorTheme` | non-empty string | no, default `"monokai-light"` | the editors' palette, or `"app"`; an id the renderer does not know draws the default |
| `appearance.conversation.sequentialBatches` | `"stacked"` or `"band"` | no, default `"stacked"` | how a batch whose elements ran in turn is laid out |
| `appearance.editors.<kind>.<knob>` | boolean, a tab size in `TAB_SIZES`, or a line height within `LINE_HEIGHT` | no, the surface's default | `<kind>` is `code`, `markdown`, `json` or `diff`; only the knobs `EDITOR_KNOBS[kind]` lists |
| `appearance.renderers.<key>` | `{read?, write?, off?, theme?: {read?, write?}}` | no | `<key>` is `<mime>:<kind>` or `family:<family>:<kind>`; `read` and `write` a renderer id or `null`, `off` a list of ids. A line that says nothing is dropped |

### An agent block names a runtime and refuses the other runtime's fields

An unknown key inside `agents` is ignored. Inside each block below an unknown field is refused. `enabled: false` leaves the runtime out of the registry, so a state naming it fails as an unregistered function.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `agents.claudeCode.enabled` | boolean | no, default on | the in-process SDK runtime `claude-code` |
| `agents.claudeCode.credential` | secret name | no | the key it uses |
| `agents.claudeCode.command` | any | refused | it has no binary |
| `agents.claudeCli.enabled` | boolean | no, default on | the subprocess runtime `claude-cli` |
| `agents.claudeCli.command` | non-empty string | no, default `claude` | the binary |
| `agents.claudeCli.credential` | any | refused | the binary signs itself in |
| `agents.codex.enabled` | boolean | no, default on | the runtime `codex-cli` |
| `agents.codex.command` | non-empty string | no, default `codex` | the binary |
| `agents.codex.sandbox` | `"read-only"`, `"workspace-write"` or `"danger-full-access"` | no | the sandbox a state that names no permission mode gets |
| `agents.codex.credential` | secret name | no | the key it uses when named |
| `agents.genericCli[i].name` | non-empty string | no, default `generic-cli` | the registry name and model prefix |
| `agents.genericCli[i].command` | non-empty string | yes | the executable |
| `agents.genericCli[i].args` | string array | no | the argv template; a `{prompt}` element is replaced by the instruction, `{model}` by the model, and with no `{prompt}` the instruction follows `--` |
| `agents.genericCli[i].prompt` | `"argument"` or `"stdin"` | no, default `"argument"` | how the instruction reaches the binary |
| `agents.genericCli[i].env` | object of strings | no | extra environment for the child |
| `agents.genericCli[i].enabled` | boolean | no, default on | |
| `agents.genericCli[i].credential` | secret name | no | |

A `credential` anywhere must be a non-empty string with no whitespace.

## Every refusal is an Error naming the field, thrown where the document is parsed

| Condition | Response | Caller does |
| --- | --- | --- |
| `autopilot.askBelow` is not a number from 0 to 1, or `autopilot` is not an object | `parseConfig` throws `config.autopilot.askBelow must be a number between 0 and 1` or `config.autopilot must be an object` | fix the field |
| A field in a checked block has the wrong type, a refused name or a value outside its vocabulary | `parseConfig` throws `Error("config.<path> …")` naming the field and, for a moved or misplaced field, where it belongs | fix the field |
| Either layer is not valid JSON | `readJsonFile` or `JSON.parse` throws | repair the file |
| The merge fails to parse at a project open | the open throws; the project does not open | fix the layer and reopen |
| `config:write` is sent a document whose merge fails to parse | the parser's error is thrown and nothing is written | fix and resend |
| `config:write` names the project layer with no open project | `Refusal` "no project was named, so there is no project config to write" or "project '<ref>' is not open" | name an open project |
| `config:write` to the shared or the personal layer breaks an open project it reaches | the parser's error, suffixed `(with <file> as the project layer)`, and nothing is written | fix the field, or that project's layer |
| `artifacts.destination` is not a valid template | the document saves and opens; `parseDestination` throws when a run is wired, see [artifact-placement](../units/artifact-placement.md) | fix the template and start again |
| A layer still holds `policy`, `smart` or `integrations.review` when it is parsed | `parseConfig` throws, naming where each went; at an open the migration below has already moved them, so this is a layer written since, or one the migration could not read | move the value under `functions`, or reopen |

## A renamed or retyped field breaks every committed document, and the path is a named refusal

- One migration runs at open, before the configuration is read: `migrateSettingsLayers` (`@jaira/persistence` `settingsMigration.ts`), called by `openProject` for the shared root and the project and by `openSharedProject` for the shared root. Per layer it moves `smart` to `functions.smart`, `policy.remote.publish` and `integrations.review.settleAfter` to `functions.review_artifacts`, and `policy.builtins` to `functions.bash.builtins`; writes each `policy.rules` entry as a command line under the `bash` tool of every permission set that layer can name, the layer's own file in place and a lower layer's as an override; carries a stricter `policy.default` onto each `bash` line and a `policy.toolDefault` onto a set with no `other`; and deletes `policy` and `smart`. What a line cannot say exactly is reported, never widened into an allow. The report and a copy of every file changed in place are kept under the layer's `system/logs/settings-migration-<stamp>/`. A layer with none of the three is not touched. The tool-policy unit says what the move preserves and what it cannot.
- A second runs after it: `migrateHiddenLists` (`@jaira/persistence` `hiddenMigration.ts`), for a `files.hidden` written when a layer's list REPLACED the one under it (before 2026-09-23). A list is in that form when it is `[]` or restates at least half of the defaults at its head with none of them behind a `!`. It becomes what it adds: the defaults it restated at its head are dropped, every rule under it that it left out becomes `!rule` (the defaults for the shared layer; the defaults and the shared layer's list for a project's), and the rest is kept in order. The original is kept under the layer's `system/logs/hidden-migration-<stamp>/`. A list already written as additions is left alone, which is what makes it run once. An old list naming fewer than half the defaults is not recognised, and now hides the defaults as well.
- `migrateUserSettings` (`@jaira/persistence` `userSettingsMigration.ts`), run as the app's service is constructed and at every open, moves the look out of `user-settings.json` into the personal layer: `theme` to `appearance.mode`; `appearance`, `conversation`, `editors` and `renderers` into `appearance`; `filesHidden` appended to `files.hidden`. Only what differs from the default is written, cleaned the way the old reader cleaned it, and what the personal layer already states is kept; then the fields are removed from `user-settings.json`. A file with none of them is not touched.
- Apart from those, nothing migrates a document at open. Renaming a field breaks every checkout that carries the old name until its documents are migrated.
- The deprecation path is to migrate the documents and then refuse the old name with the new place in the message, as `models.default` does. The old name is not kept readable.
- Loosening a strict block to ignore unknown fields hides the misspelling it used to report. Tightening a lenient block refuses documents that open today.
- Changing a merge rule changes the effective configuration of every project that has both layers.

## Several blocks ignore what they do not know, and some fields do less than their names say

- An unknown key is ignored at the top level and inside `models`, `agents`, `artifacts`, `memo`, `workflows`, `files`, `execEnvironment`, `local.serve` and a `weights` entry. Only routes, executor nodes, steps, scopes, storage, `integrations`, `functions`, `mcp`, `appearance` and the four agent blocks refuse one.
- `MODEL_ROUTE_KEYS` lists `openai`, but `models.routes.openai` is refused as an unknown route by a message that lists `openai` as expected.
- `vendor` on a provider or agent node is refused as not a setting, although the node types declare it.
- `memo.enabled` is parsed and read by nothing.
- A `local` route with no `baseURL` parses.
- Arrays replace, except `files.hidden`. A project `workflows.path` replaces the generated path entirely, though the project's own `workflows` directory is still searched first.
- Parsed, `files.hidden` is the layers' lists concatenated WITHOUT the defaults; `hiddenRules` in `hiddenPaths.ts` puts the defaults in front, and the person's own list after.
- A `null` in the project layer replaces the base's block and then fails parse.
- An `execEnvironment` object in one layer and `"windows"` in the other resolves to whichever the project layer holds.
- A project created by `initProject` holds every default, so it overrides the shared layer's `storage`, `memo`, `artifacts` and `execEnvironment` until those keys are deleted. The personal layer is laid over it all the same.
- `STORAGE_CONCERN_TABLES.conversations` reads `operation_records + session_positions`, and the comment on `both` says it has no staleness check. The concern is `operation_records`, `sessions` and `session_names`, and `both` replays when the file's fingerprint moves.
