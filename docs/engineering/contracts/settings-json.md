---
id: engineering/contracts/settings-json
type: engineering-contract
status: shipped
updated: 2026-09-21
visibility: public
kind: format
owned_by: [engineering/units/project-config]
consumers: ["@jaira/persistence project.ts loadLayeredConfig, openSharedProject and initProject", "@jaira/persistence workflowRefs.ts, workflows.ts and lifecycle.ts through workflows.path", "@jaira/app main service.ts config:read, config:write and every run it starts", "@jaira/runtime modelRoutes.ts, executors.ts, agents.ts and policy.ts", "@jaira/cli runs and task commands", "the renderer Settings panes, through config:read and config:write", "people editing settings.json by hand"]
since: 2026-07-17
siblings: [engineering/contracts/user-settings-json, engineering/contracts/secret-sources, engineering/contracts/jaira-layout, engineering/contracts/artifact-destination-template]
---

# settings.json

`settings.json` is the committed JSON document that says how a project's runs are routed, executed, stored and constrained, written once in the shared root and optionally again in a project, where it is laid over the shared one.

## A caller reaches for settings.json when a choice should travel with the project, and never for a secret or a preference

**Use when.** Configuring model routes and presets, the default executor tree, agent runtimes, the command policy, artifact placement, storage modes, the exec environment, the workflow search path or the Files tree's shared hidden list. Reading the configuration a run will use: parse the merged document with `parseConfig(mergeConfigDocuments(base, project))`, or read `Project.config`.

**Do not use when.** Storing a credential value: name it in a `credential` field and store it through [secret-sources](secret-sources.md). Recording one person's layout, theme or reading preferences: [user-settings-json](user-settings-json.md). Deciding where the files live: [jaira-layout](jaira-layout.md).

## The shape is one object per layer, merged before it is parsed

### The two layers merge key by key, and only the merge is validated

The shared layer is `<base>/settings.json`. The project layer is `<project>/.jaira/settings.json`. Either may be absent; with both absent the configuration is `defaultConfig()`. The shared root opened as a project parses its own file alone.

`mergeConfigDocuments(base, project)`:

- A plain object in both layers merges key by key, recursively.
- An array, a scalar or `null` in the project replaces the base's value.
- `agents.genericCli` merges by entry `name`, an absent name counting as `generic-cli`: a project entry with a base entry's name merges into it in the base's position, and a new name is appended.
- A layer that is not a plain object yields the other layer.

### The top-level keys are twelve blocks, and an unknown top-level key is ignored

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `models` | object | no | how each route prefix is reached, and named presets |
| `executors` | object of operation nodes | no | sparse overlays over derived executor trees; only `executors.default` is used |
| `artifacts` | object | no | where artifact bytes land and when a producer asks first |
| `storage` | object | no | whether each concern's truth is a file, the database or both |
| `memo` | object | no | `{enabled?: boolean}`, default `false`; parsed and read by nothing |
| `execEnvironment` | `"windows"` or `{wsl: non-empty string}` | no, default `"windows"` | where commands, git and agents run; keys beside `wsl` are ignored |
| `policy` | object | no, default `{}` | the command and tool policy, passed through without checking |
| `agents` | object | no | the agent runtimes this project registers |
| `workflows` | `{path?: string[]}` | no | the search path a bare workflow reference walks |
| `files` | `{hidden?: string[]}` | no | the Files tree's shared hidden globs |
| `autopilot` | `{askBelow?: number}` | no, default `{askBelow: 0.2}` | how sure a fast-forward's controlling conversation must be before its answer stands in for the person's ([decision 0005](../decisions/0005-connect.md) §6); `0`–`1`, `1` never answers for you and `0` always. It is no workflow's threshold and names no workflow input. Left out of the file `initProject` writes, because it is a person's setting and belongs in the shared root |

### A route block's allowed fields follow from its key

`models` holds `routes`, `presets` and nothing else that is read; another key is ignored, except `default`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `models.default` | any | refused | throws `config.models.default has moved`, naming `executors.default.prompt.defaults.model` |
| `models.presets.<name>` | object of JSON values | no | a prompt configuration a state selects with `operation.configRef` |
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
| `scopes[i].tools` | object of `allow`, `deny`, `ask` or `smart` by tool name | one of `tools` and `default` | per-tool modes in that place |
| `scopes[i].default` | `allow`, `deny`, `ask` or `smart` | one of `tools` and `default` | the mode for a tool with no entry |

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
| `files.hidden` | array of non-empty strings | no | glob rules, trimmed, order kept, last match wins; absent means the defaults and `[]` hides nothing |

### The policy block is read by the runtime as JairaPolicy

`parseConfig` requires only that `policy` is an object. `compilePolicy` in `@jaira/runtime` `policy.ts` reads these fields without checking them.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `policy.rules` | array of `{match, action, reason?}` | no | ordered command rules, first match wins, evaluated before the built-ins |
| `policy.rules[i].match` | `{program?, subcommand?, flags?: string[], anyFlag?: string[], argIncludes?: string}` | yes | a matcher over the parsed command; every `flags` entry must be present, any `anyFlag` entry is enough |
| `policy.rules[i].action` | `"allow"`, `"deny"` or `"require_approval"` | yes | the verdict |
| `policy.rules[i].reason` | string | no | shown when the rule prompts or refuses |
| `policy.default` | action | no, default `"allow"` | the verdict when no rule and no built-in matches |
| `policy.builtins` | boolean | no | `false` turns off the built-in destructive-git denies and risky-command approvals |
| `policy.tools` | object of `allow`, `deny`, `ask` or `smart` by tool name | no | modes for tools; command tools are `smart` unless named here |
| `policy.toolDefault` | mode | no | the mode for a tool with no entry |

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
| `artifacts.destination` is not a valid template | the document saves and opens; `parseDestination` throws when a run is wired, see [artifact-placement](../units/artifact-placement.md) | fix the template and start again |

## A renamed or retyped field breaks every committed document, and the path is a named refusal

- Nothing migrates a document at open. Renaming a field breaks every checkout that carries the old name until its documents are migrated.
- The deprecation path is to migrate the documents and then refuse the old name with the new place in the message, as `models.default` does. The old name is not kept readable.
- Loosening a strict block to ignore unknown fields hides the misspelling it used to report. Tightening a lenient block refuses documents that open today.
- Changing a merge rule changes the effective configuration of every project that has both layers.

## Several blocks ignore what they do not know, and some fields do less than their names say

- An unknown key is ignored at the top level and inside `models`, `agents`, `artifacts`, `memo`, `workflows`, `files`, `execEnvironment`, `local.serve` and a `weights` entry. Only routes, executor nodes, steps, scopes, storage and the four agent blocks refuse one.
- `MODEL_ROUTE_KEYS` lists `openai`, but `models.routes.openai` is refused as an unknown route by a message that lists `openai` as expected.
- `vendor` on a provider or agent node is refused as not a setting, although the node types declare it.
- `memo.enabled` is parsed and read by nothing.
- A `local` route with no `baseURL` parses.
- Arrays replace. A project that sets `files.hidden` to one entry shows `system/`, `settings.json` and every `.env` file the defaults hid, and a project `workflows.path` replaces the generated path entirely, though the project's own `workflows` directory is still searched first.
- A `null` in the project layer replaces the base's block and then fails parse.
- An `execEnvironment` object in one layer and `"windows"` in the other resolves to whichever the project layer holds.
- A project created by `initProject` holds every default, so it overrides the shared layer's `storage`, `memo`, `artifacts` and `execEnvironment` until those keys are deleted.
- `STORAGE_CONCERN_TABLES.conversations` reads `operation_records + session_positions`, and the comment on `both` says it has no staleness check. The concern is `operation_records`, `sessions` and `session_names`, and `both` replays when the file's fingerprint moves.
