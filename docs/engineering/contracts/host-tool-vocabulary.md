---
id: engineering/contracts/host-tool-vocabulary
type: engineering-contract
status: shipped
updated: 2026-09-22
visibility: public
kind: api
owned_by: [engineering/units/host-tools]
consumers: ["workflow authors, through a state's environment.tools (a toolset, or the older list with permissions.tools) and permissions.scopes", "toolset files, toolsets/<bucket>/<name>.json under each layer root, whose tool subjects are these names", "@jaira/shared toolsets.ts, which tells a tool subject from a command subject by this table", "@declarative-ai/hw, which resolves environment.tools against registry.tools", "delegated agents, which receive the tools over the upstream MCP bridge", "@jaira/runtime tools.ts gateTools and planAgentTools, and policy.ts compilePolicy", "@jaira/shared toolVocabulary.ts TOOL_SPECS, whose pathArgs and urlArgs name these arguments", "@jaira/app renderer composer tools menu, through chat:plan available.tools", "@jaira/cli buildRunEnvironment"]
siblings: [engineering/contracts/artifact-destination-template, engineering/contracts/exec-observer, engineering/contracts/settings-json]
---

# Host tool vocabulary

The tools JaiRA registers on `registry.tools` for a model to call, and the `run_command` host function a state can run directly, each with its arguments, its result and the errors it returns as data.

## A state grants these tools to reach the workspace, a shell or the web under JaiRA's policy

**Use when.** Giving a prompt or agent state governed access to files, search, a shell or the network by offering tools in `environment.tools`, as a toolset (a map from a tool name to `allow`, `ask`, `deny` or `smart`, or a reference such as `$/toolsets/chat/read-only`) or as the older list with modes in `permissions.tools`; narrowing where they act with scope tables; running one command as a state with `function: "run_command"`; reading a tool result in a prompt or a transcript.

**Do not use when.** Expecting an agent to keep a built-in the toolset does not hold. Under a toolset map on a claude transport a held tool is served by JaiRA's implementation and displaces the built-in, a `native` choice leaves the built-in running under an ask rule, and the built-in of every standard tool the map does not hold is removed. The older list is the legacy reading and keeps the built-ins it does not mention: see [tool-policy](../units/tool-policy.md). Deciding where an artifact's bytes go: [artifact-destination-template](artifact-destination-template.md).

## The shape is eighteen names, each with its arguments and the result it returns

### A toolset's subjects are these names, plus three kinds that are not tools

| Subject | Example | What it is | Enforced |
| --- | --- | --- | --- |
| a tool name from the table below | `read_file` | offered with that mode; absent means not offered | yes |
| `other` | `"other": "deny"` | everything no entry names, which is where a tool nothing here registers answers | yes, as `permissions.other` |
| a command | `git commit`, `git` | a program and its subcommand, or every command of a program | no: carried as `permissions.subjects` until a shell line is taken apart into requests ([0007](../decisions/0007-toolsets.md) §4) |
| `script` | `"script": "ask"` | running a file | no: carried the same way |

A single lowercase word that is not a tool name reads as a program (`git`, `terraform`). A word that looks like a tool name and is not in the table (`reed_file`, `Glob`, `mcp__x__y`) is a lint warning: nothing is offered under it and a call by that name answers to `other`. An entry may be `{ "mode", "implementation" }`, where `implementation` is `app` or `native`.

### Every name has a registration and a place argument, and an agent executor says which of its built-ins it is

The `readOnly` column is the upstream `Tool.readOnly` of the tool as registered. JaiRA's vocabulary no longer restates it and nothing in JaiRA decides by it: what a state may do is what its toolset says, by name. The last column is what the claude executor declares in `CLAUDE_TOOLS` (`packages/runtime/src/agentTools.ts`); `TOOL_SPECS` holds no agent's names.

| Name | readOnly | Registered by | Argument a scope judges | Claude built-ins that are this tool |
| --- | --- | --- | --- | --- |
| `bash` | false | `registerTools` | `cwd`, and the paths inside `command` | `Bash` |
| `read_file` | true | `registerFileTools` | `path` | `Read` |
| `write_file` | false | `registerFileTools` | `path` | `Write` |
| `edit` | false | `registerFileTools` | `path` | `Edit`, `MultiEdit`, `NotebookEdit` |
| `show_artifact` | true, and granted to every prompt state whether listed or not | `registerFileTools` | `path` | none |
| `glob` | true | `registerSearchTools` | `path` | `Glob` |
| `grep` | true | `registerSearchTools` | `path` | `Grep` |
| `web_fetch` | true | `registerWebTools` | `url` | `WebFetch` |
| `web_search` | true | `registerWebTools` | none; the tool checks its endpoint itself | `WebSearch` |
| `run_command` | false, a host function on `registry.functions` | `registerCommandFunction` | none | none |
| `list_workflows` | true | `registerWorkflowTools` | none | none |
| `start_task` | false | `registerWorkflowTools` | none | none |
| `move_task` | false | `registerWorkflowTools` | none | none |
| `list_tasks` | true | `registerWorkflowTools` | none | none |
| `answer_question` | false | `registerWorkflowTools` | none | none |
| `hold_task`, `release_task`, `stop_task` | false | `registerWorkflowTools` | none | none |

The last eight are the **workflow tools** ([0005](../decisions/0005-connect.md) §3), and they are the tools of a
CONVERSATION rather than of a workspace: none of them names a place, so no scope table narrows one, and no
agent has a built-in that is one. `chat/control` holds these and nothing else; `chat/session` holds them
beside the rest. Where nothing serves them — the CLI, a test registry — the names still resolve and every
call answers that it cannot be served there, so a state that holds one still loads and runs.

Claude's `Task`, `Agent` and `SlashCommand` are declared with no standard tool and answer to `other`. Codex declares `shell` as `bash` and `apply_patch` as `edit`, and one switch, its `workspace-write` sandbox, which `write_file`, `edit` or `bash` turns on. A generic CLI declares nothing.

### `bash` runs one command line in the workspace and reports its exit

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| in `command` | string | yes | the line, run by `bash -lc` in WSL, `powershell.exe -NoProfile -NonInteractive -Command` on a Windows host, `/bin/sh -c` elsewhere |
| in `cwd` | string | no | a directory joined under the workspace root |
| out `exitCode` | number or null | yes | the exit code; null when the process was killed |
| out `stdout`, `stderr` | string | yes | each clamped to 20000 characters with a `…[truncated N chars]` tail |
| out `timedOut` | `true` | no | present when the 120000 ms timeout killed it |

### `run_command` runs one command as a state's whole operation

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| in `config.command` | string | one of the two | the command, from the state's `args`; wins over `command` |
| in `command` | string | one of the two | the command, as a bound input |
| value | the `bash` result | on success | `exitCode`, `stdout`, `stderr`, `timedOut` |
| capabilities | `{interactive: false, readOnly: false, memoizable: false}` | yes | never memoized |

### The file tools address a logical path and never say where the bytes went

A path has its backslashes turned into `/` and a leading `./` and leading slashes stripped, so `/src/a.ts` names `src/a.ts` in the workspace.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `read_file` in `path` | string | yes | the logical path |
| `read_file` out `path`, `content` | string | yes | the path as named, and the whole text |
| `write_file` in `path`, `content` | string | yes | the logical path and the full contents |
| `write_file` out `path`, `bytes` | string, number | yes | the path as named, and the UTF-8 size |
| `edit` in `path`, `old`, `new` | string | yes | the text to replace and its replacement; `new` may be empty |
| `edit` in `all` | boolean | no | replace every occurrence rather than requiring exactly one |
| `edit` out `path`, `replaced`, `bytes` | string, number, number | yes | the path, how many occurrences changed, and the new size |
| `show_artifact` in `path` | string | yes | the logical path; its extension gives the media type |
| `show_artifact` in `content` | string | no | the contents to create; absent shows what is already at `path` |
| `show_artifact` in `mediaType` | string | no | overrides the type the extension implies |
| `show_artifact` in `interactive` | boolean | no | the page needs its own scripts; recorded on the artifact |
| `show_artifact` out `path`, `mediaType`, `bytes`, `uri` | string, string, number, string | yes | `uri` is `artifact://<taskId>/<logical path>` |
| `show_artifact` out `interactive` | `true` | no | present when claimed and `content` was given |
| `show_artifact` out `content` | string | no | present when the size is at or under `artifacts.inlineMaxBytes` |

### The search tools walk the workspace and return paths relative to where they started

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `glob` in `pattern` | glob string | yes | `**` crosses directories and `*` does not |
| `glob`, `grep` in `path` | string | no | the directory to walk from, inside the workspace; the root when absent |
| `glob` out `paths` | string array | yes | at most 200, sorted, relative to the walked directory |
| `glob` out `count` | number | yes | every match, including those past 200 |
| `grep` in `pattern` | JavaScript regular expression | yes | matched line by line |
| `grep` in `glob` | glob string | no | only files whose relative path matches |
| `grep` in `ignoreCase` | boolean | no | match without regard to case |
| `grep` out `matches` | array of `{path, line, text}` | yes | at most 200; `line` is 1-based and `text` is clipped to 400 characters |
| `grep` out `count`, `filesSearched` | number | yes | matches returned, and files read |
| `glob`, `grep` out `truncated` | string | no | says the match cap or the 20000-entry walk limit was hit |

### The workflow tools steer work, and every refusal is part of the answer

Each is the host's own operation, not a second implementation of it: `move_task` is `task:connect`, `start_task` is
the document generator plus a `task_move`, the three gestures are what the board's are. A call that cannot
be made answers `{ok: false, …}` and does nothing; only `list_workflows` answers `{error}`, as the other reading
tools do.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `list_workflows` in `state` | string | no | a state id; absent lists the workflows |
| `list_workflows` out `workflows` | array of `{id, label?, description?}` | one of the three | every workflow root that loads |
| `list_workflows` out `state` | `{id, label?, description?, inputs, outputs, children}` | one of the three | one level: each slot is `{schema, description?, required?}`, each child `{key, state, label?, description?}` |
| `list_workflows` out `error` | string | one of the three | no state of that id is on the workflow path |
| `start_task` in `state` | string | yes | the state to start as a child of this conversation |
| `start_task`, `move_task` in `inputs` | object | no | values for the TARGET state's own declared inputs, by its names |
| `start_task`, `move_task` in `asked` | string array | no | which names in `inputs` a person answered; every other supplied value is `inferred` |
| `start_task`, `move_task` in `confidence` | number 0–1 | no | how sure the conversation is of what it inferred |
| `start_task` out `ok: true` | `{task, key, state, status, mount, inputs}` | on success | `status` is `started`, `queued` (an engine holds the task) or `held`; `mount` is `plain` or `split`; `inputs` is `{name, via, from?}` per input, `via` one of `bound`, `inferred`, `asked`, `default` |
| `move_task` in `task` | string | no | the task to move; absent means this conversation's own |
| `move_task` in `to` | string | yes | the target state id |
| `move_task` in `workflow` | string | no | which workflow the target is meant in, when more than one holds it |
| `move_task` in `skip` | boolean | no | go directly, recording what is stepped over as `skipped` |
| `move_task` in `confirm` | boolean | no | the person agreed to what a `confirm` answer asked — stop the working task and go back, or pause it and move it ([task-channels](task-channels.md), the move table) |
| `move_task` out `ok: true` | `{task, resolution, modification?, workflow, standsAt, adoptedAs?, mount?, moved?, answeredBy?, through?}` | on success | `resolution` is `move`, `adopt` or `modify`; `moved` is how the transition landed, or `fast-forwarding` when the target is ahead and the states between are running — `answeredBy` names the conversation answering them and `through` the states, and the note reads `fast-forwarding to {target} · through {…}` |
| `move_task` out `asked` | `{ok: true, task, asked: {request, inputs}}` | on a required input of the target nothing binds | the PERSON is asked, in the moved task's own conversation: `request` is the move question's gate, `inputs` what it asks for (`{state, name, schema?, description?, reason}` each). Nothing has moved; the move is taken when they answer. No `jaira.moved` row is written |
| `move_task` out `illegal`, `confirm` | `{ok: false, code, reason}` | by the move table | `illegal`: the target cannot be reached from where the task stands, and `reason` says why. `confirm`: the task is working and the move stops or pauses it; `reason` is the question — ask the person, and call again with `confirm: true` only if they agree |
| `start_task`, `move_task` out `inputs-missing` | `{ok: false, code, reason, missing, schema, filled}` | `start_task` on a required input nothing binds; `move_task` only where no question can be asked (an input of an ancestor entered on the way down) | NOTHING was done. `missing` is `{state, name, schema?, description?, reason}` each; `schema` is the target's whole input schema; `filled` is what the host settled itself. Supply the values and call again |
| `move_task` out `candidates` | array of `{workflow, label?, childKey, targetKey?}` | on `ambiguous-workflow` | call again naming one |
| `list_tasks` in `all` | boolean | no | every task of the project, shortly, instead of what was started here |
| `list_tasks` out `tasks` | array | yes | `{task, title, status, workflow, relation?, standsAt?, held?, waitsFor?, asking?, outputs?}`; `asking` holds the `request` ids `answer_question` takes |
| `answer_question` in `request` | string | yes | a `request` id from `list_tasks` |
| `answer_question` in `value` | any | one of the two | a gate's answer, in the shape its component asks for |
| `answer_question` in `answers` | object | one of the two | an agent's questions: question text → the chosen label, or labels |
| `answer_question` in `confidence` | number 0–1 | yes | recorded with the answer; without it nothing is settled |
| `answer_question` out | `{ok: true, request, settled_by: {via: "control", confidence}}` | on success | also journaled on the task that asked, as `jaira.answered` |
| `hold_task`, `release_task`, `stop_task` in `tasks` | string array | yes | task ids, from `list_tasks`; a bare `task` string is read as a list of one |
| `hold_task`, `release_task`, `stop_task` out `results` | array of `{task, ok, did?, reason?}` | yes | one entry per task named, in order |

**A successful `start_task` or `move_task` is journaled on the CONVERSATION's own task** as
`{type: "jaira.moved", tool, task, outcome, toolCallId?}` — host vocabulary, like `jaira.answered` — where
`outcome` is `WorkflowOutcome` (`verb`, `standsAt`, `workflow?`, `adoptedAs?`, `held?`, `through?`), the one
reading `workflowOutcomeOf` makes of the answer, and `toolCallId` is the model's id for the call that did it
(the tool's `ctx.toolCallId`, handed to the host as `WorkflowToolCall`). `conversationView` projects it as a
`moved` turn at the root, and the run conversation draws it as a note on its rail right after that call and
before the reply (`splitAtNotes` cuts the turn at the call); a row whose runtime did not report the id is placed
after the whole turn. A one-column transcript with no rail draws the same words under the call. A refusal writes
nothing.

**An approval is not reachable through `answer`.** Only a question or a judgement on a document can be
settled by a conversation ([0005](../decisions/0005-connect.md) §4), and that holds in two places at once:
`tasks` does not list an approval among what a task is `asking`, so there is no `request` id to name, and
`answer` refuses one by its component if a caller names it anyway. A tool permission, a publish, a push and
a merge stay the person's.

**Every task named must be one this conversation started** — itself, what it started, what it adopted, what
its fan-out made. `tasks` without `all` is exactly that family, and the three gestures refuse anything
outside it.

### The web tools read a page or a list of results

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `web_fetch` in `url` | string | yes | an http or https URL |
| `web_fetch` in `raw` | boolean | no | return the body as sent rather than HTML reduced to text |
| `web_fetch` out `url`, `status`, `contentType`, `text` | string, number, string, string | yes | the response, `text` clipped to 100000 characters |
| `web_fetch` out `truncated` | `true` | no | present when `text` was clipped |
| `web_search` in `query` | string | yes | what to search for |
| `web_search` out `query`, `count` | string, number | yes | the query and how many results |
| `web_search` out `results` | array of `{title, url, snippet}` | yes | at most 20; a missing field is an empty string |

## Every tool returns its refusals as data, and only a few conditions reject

| Condition | Response | Caller does |
| --- | --- | --- |
| The permission gate refuses the call | upstream `PermissionDenied`, `{denied: true, tool, reason}` | read the reason; the model carries on without the tool |
| `bash` gets an empty command, or a `cwd` containing `..` or `.jaira` | `{error: "no command given"}`, `{error: "cwd '<cwd>' is not allowed"}` | send a command, or a relative directory |
| `bash` cannot start its interpreter | the call rejects with `failed to run '<command>': <message>` | fix the environment |
| A file tool gets an empty path or one under `.jaira/` | `{error: "no path given"}`, `{error: "'<path>' is inside .jaira/, which agents may not write"}`, for reads too | name another path |
| A read resolves outside the workspace or cannot open | `{error: "'<path>' is outside the workspace"}`, `{error: "could not read '<path>': <message>"}` | name a workspace path |
| A write's destination refuses the path or the disk refuses the write | `{error}` with the `DestinationError` message, `{error: "could not write '<path>': <message>"}`, or `could not show` for `show_artifact` | name a path the destination admits |
| `edit` has empty `old`, identical `old` and `new`, absent text, or several matches without `all` | `{error}` naming which, the last with the count | include more context, or set `all` |
| A search has no pattern, no workspace, or a `path` under `.jaira/` or outside the workspace | `{error: "no pattern given"}`, `{error: "this operation has no workspace to search"}`, or a path error | fix the argument |
| A `glob` pattern or `grep` expression does not compile | `{error: "'<pattern>' is not a usable pattern: <message>"}` or `is not a usable regular expression` | fix the pattern |
| `grep` gets a `glob` argument that does not compile | the call rejects with the `SyntaxError` | fix the glob |
| `web_fetch` gets a non-URL, another scheme, or the fetch fails or times out | `{error: "'<url>' is not a URL"}`, a scheme error, or `{error: "could not fetch '<url>': <reason>"}` | fix the URL |
| `web_search` has no query, its endpoint is denied or unusable, or the provider fails | `{error: "no query given"}`, `{error: "searching is not permitted from this workflow"}`, `{error: "the search provider answered <status>"}`, `{error: "the search provider did not answer with JSON"}` | change the query or the scope table |
| `run_command` has no command | permanent failure ``run_command needs a `command` `` | give `args.command` |
| `run_command` is refused | permanent failure `command refused: <reason>` | change the command or the policy |
| A state or turn names a tool nothing registered | the engine fails the state `tool '<name>' is not registered`, and `gateTools` throws the same | register it, or remove it from the list |

## A rename breaks every stored workflow, and no deprecation path exists

- Renaming a tool breaks authored `environment.tools` in both forms, every toolset file that names it (where the old name becomes an unknown-tool warning and the tool stops being offered), `permissions.tools`, scope `tools` maps, the composer's stored `implementations`, the executors' declarations in `agentTools.ts`, the frozen `LEGACY_NON_READ_ONLY_TOOLS` and `READ_ONLY_PRESET_TOOLS` lists, and the parity asserted in `tools.test.ts`. Names resolve exactly and have no aliases.
- Renaming an argument breaks `pathArgs` and `urlArgs`, after which a scope silently says nothing about the call, and the key lists `compilePolicy` reads a command, a path or a payload from.
- Changing `show_artifact`'s result breaks the renderer's reading of the `{path, mediaType, bytes, uri}` envelope.

## Paths, counts and scopes each mean less than their names suggest

- `glob` and `grep` paths are relative to the `path` argument, not the workspace, and `grep`'s `count` stops at 200 while `glob`'s does not.
- A walk skips `.git`, `.jaira`, `node_modules`, `dist`, `build`, `out`, `target`, `vendor`, `coverage`, `__pycache__` and `.venv` wherever they appear, and every symlink, file or directory.
- A listing drops paths the executor floor denies without saying so. A state's own `permissions.scopes` refuses a call whose `path` it denies but does not filter what a walk from an allowed directory lists.
- A scope judges the logical path the model named, never where the destination put the bytes.
- `read_file`, `edit` and a content-less `show_artifact` read the artifact map before the disk, so a small file changed outside the tools after a tool wrote it reads as the old text.
- `show_artifact` places under `$CENTRAL` but records the logical path, so a later `edit` of that path writes the artifact's text through the configured destination, which under `$DEFAULT` overwrites the workspace file of that name.
- `show_artifact` asks like `write_file` by default. The `artifacts.askAboveBytes` question applies only where a project authors `show_artifact: "smart"`.
- `read_file` returns the whole file with no cap.
- `web_fetch` follows redirects without judging the new URL, and returns an error status as a result rather than an error.
- `web_search` scrapes DuckDuckGo's HTML because no configuration reaches `WebSearchConfig`: every caller registers the web tools with `{}`.
- `run_command` is narrowed by no scope table, and an approval wider than once lasts only for the command it was given for.
- No CLI run adds `show_artifact` to its states, and a CLI run without a task registers no file tools.
