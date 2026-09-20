---
id: engineering/units/host-tools
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/read-what-work-produced, product/agents-act-only-where-allowed, product/hand-work-to-agents]
layer: core
owns_contracts: [engineering/contracts/host-tool-vocabulary]
requires: [engineering/units/tool-policy, engineering/units/artifact-placement, engineering/units/process-exec]
implemented_by: [packages/runtime/src/tools.ts, packages/runtime/src/fileTools.ts, packages/runtime/src/searchTools.ts, packages/runtime/src/webTools.ts]
verified_by: [packages/runtime/test/tools.test.ts, packages/runtime/test/fileTools.test.ts, packages/runtime/test/artifactAgent.test.ts, packages/runtime/test/searchTools.test.ts, packages/runtime/test/scopeWalkAndCommand.test.ts, packages/runtime/test/webTools.test.ts, packages/runtime/test/webSearch.test.ts, packages/runtime/test/agentToolPlan.test.ts]
siblings: [engineering/units/tool-policy, engineering/units/artifact-placement, engineering/units/agent-executors, engineering/units/process-exec]
---

# Host tools

## The unit implements the tools JaiRA hands a model, and leaves deciding and placing to its neighbours

Each tool is an upstream `Tool` with a description, an `inputSchema`, a `readOnly` flag and `run(input, ctx)`. Every refusal is returned as `{error}` rather than thrown. The names, arguments and results are [host-tool-vocabulary](../contracts/host-tool-vocabulary.md).

- `tools.ts`: `createBashTool` and `registerTools`, which registers `bash`. `bash` runs one command line through `interpreterFor(execEnv)` in `ctx.workspace.root`, else `options.cwd`, refuses a relative `cwd` containing `..` or `.jaira`, and returns a non-zero exit as a result. `registerAllTools` registers every family in one call and is used by tests; production callers call the four registration functions separately. `claudeReplacements()` maps each tool to the Claude built-in it displaces when injected, derived from `TOOL_SPECS`.
- `fileTools.ts`: `write_file`, `read_file`, `edit` and `show_artifact`, registered by `registerFileTools`. A path is normalized to a logical key, refused when empty or under `.jaira/`, placed through `resolveDestination`, and recorded in the `ArtifactStore`. A read consults the store first and falls through to the workspace through `withinWorkspace`. `edit` replaces exact text that must occur once unless `all` is set. `show_artifact` places under `$CENTRAL`, or nowhere when the destination is `virtual:`, records the media type and the `interactive` claim, and returns an `artifact://<taskId>/<logical>` reference; without `content` it shows what is already at the path and records nothing.
- `searchTools.ts`: `glob` and `grep`, registered by `registerSearchTools`. Both walk from the workspace root or a contained `path`, never enter `.git`, `.jaira`, `node_modules` and the other skipped directory names, and drop every path `ctx.policy.scopeOf` denies without saying so.
- `webTools.ts`: `web_fetch`, which reads an http or https URL and reduces HTML to text with `textOfHtml`, and `web_search`, which queries a `WebSearchConfig` endpoint or, with none, scrapes DuckDuckGo's HTML through `duckDuckGoResults`, after checking the endpoint against `ctx.policy.scopeOf`. Registered by `registerWebTools`.

It deliberately does not own:

- Whether a call may run, the tool table, profiles, scopes and `run_command`: [tool-policy](tool-policy.md).
- The destination template, the artifact map's table and the post-run placement of returned blobs: [artifact-placement](artifact-placement.md). Serving an artifact to a frame: [uri-and-artifact-reads](uri-and-artifact-reads.md).
- Spawning, path mapping and tree kill for `bash`: [process-exec](process-exec.md).
- Injecting the tools into a delegated agent over MCP: upstream `@declarative-ai/agents-api` and `@declarative-ai/agents-cli`, driven by [agent-executors](agent-executors.md).

## The tools are core code on the registry's tools facet, and each call reads its workspace and narrowing from its services

- Layer `core`, package `@jaira/runtime`. It calls [artifact-placement](artifact-placement.md) for `parseDestination`, `resolveDestination`, `withinWorkspace` and `MemoryArtifactStore`, [tool-policy](tool-policy.md) for `isDeniedPath` and the shared `globToRegExp`, and [process-exec](process-exec.md) for `NodeExec` and `interpreterFor`.
- Upstream seams: `registry.tools` of `@declarative-ai/exec`, which the engine resolves a state's `environment.tools` against, and `ExecServices`, from which a tool reads `workspace.root`, `abortSignal` and `policy.scopeOf`.
- Boundaries: Windows and WSL, because `bash` runs inside the distro for a WSL project; derived and committed, because no tool reads or writes under `.jaira/`.
- Callers: app `startRun` registers `bash` unless the caller supplies `capabilities`, and registers the file, search and web tools for every run after it; app `runChatMessage` registers all of them for a turn; CLI `buildRunEnvironment` registers `bash`, search and web tools, and file tools only for a task run.

## The filesystem holds the bytes and the artifact map holds where each logical path went

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| Workspace files under `ctx.workspace.root`, else `options.cwd` | read by `read_file`, `edit`, `glob`, `grep` and a content-less `show_artifact`; written by `write_file` and `edit` when the destination is the workspace | the filesystem | agents' own built-ins, git, the person |
| Artifact bytes at a resolved destination | written by `write_file`, `edit` and `show_artifact` | the filesystem | artifact-placement resolves the path; uri-and-artifact-reads serves them |
| `artifacts` rows | `put` after every write, every edit and every `show_artifact` given `content`; `get` before every read | `SqliteArtifactStore` in the project database, or its row files when `storage.artifacts` is file-backed | artifact-placement owns the store and places returned blobs |
| Pages and search results | fetched | the remote host | none |

## The invariants keep a logical path round-tripping and a tool inside its workspace

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | `bash` is never read-only, never runs an empty command or a `cwd` that climbs out, and reports a failing command as a result | `tools.test.ts` "declares readOnly: false, which is what plan/read-only profiles gate on", "refuses an empty command and a cwd that escapes the workspace", "reports a non-zero exit rather than throwing" |
| 2 | A write of a logical path followed by a read of it returns the content under every destination, and the agent is never told where the bytes went | `fileTools.test.ts` `"write(P) then read(P) returns the content — ${destination}"`; `artifactAgent.test.ts` "cannot tell that its file moved", `"gets the same answers whatever the destination — so a workflow is portable"` |
| 3 | A path under `.jaira/` is refused on the logical path before any destination applies, and `virtual:` writes nothing to disk | `fileTools.test.ts` "refuses .jaira/ on the LOGICAL path, before any destination is applied", "writes nothing to disk under virtual:" |
| 4 | A file larger than the inline limit is recorded without an inline copy | `fileTools.test.ts` "drops the inline copy for a large file, so the journal does not carry it" |
| 5 | `edit` never picks among several matches, never writes when the text is absent or unchanged, and edits the placed copy | `fileTools.test.ts` "refuses an ambiguous match rather than picking one", "refuses text that is not there, and an edit that would change nothing", "edits an artifact wherever it was PLACED, not where the agent thinks it is" |
| 6 | `show_artifact` never writes outside the task's artifact directory, and a record is `interactive` only when the call claimed it | `fileTools.test.ts` `"cannot overwrite source — the property that makes it read-only"`, "refuses a path that climbs out of the artifact directory", "keeps the interactive claim on the RECORD, and only when it was made" |
| 7 | `glob` and `grep` never walk skipped directories or outside the workspace | `searchTools.test.ts` "never walks into vendored or engine-owned directories", "scopes to a subdirectory when asked, and refuses one outside the workspace", "finds files by pattern, sorted, workspace-relative" |
| 8 | A listing never includes a path its policy's `scopeOf` denies | `scopeWalkAndCommand.test.ts` "drops denied paths from a glob, and says nothing about having done so", "drops denied files from a grep, so no content leaks", "changes nothing when no table is in force" |
| 9 | An unusable `grep` expression is returned as an error | `searchTools.test.ts` "reports an unusable expression instead of throwing it" |
| 10 | `web_fetch` never fetches a scheme other than http and https, and never returns a page past its cap | `webTools.test.ts` "refuses a scheme that is not http(s)", "truncates a large page rather than returning all of it" |
| 11 | `web_search` works unconfigured and never queries an endpoint the scopes deny | `webSearch.test.ts` "searches with no configuration at all", "refuses when the scope table denies searching" |
| 12 | Each registered tool's `readOnly` equals its vocabulary entry, and each displaces the built-in the table names | `tools.test.ts` "restates every registered tool's `readOnly` exactly"; `agentToolPlan.test.ts` "maps each tool onto the built-in it stands in for" |

## Writes are last-wins and reads trust the map, so an outside change or a moved artifact reads stale

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two calls write one logical path in one process | `writeFileSync` then `store.put` with no await between, so they cannot interleave; the last wins on disk and in the map | none needed | the latest content |
| The process is killed during `write_file` or `edit` | the file write is not atomic and the record is put after it | re-run the step | a later read returns the previous inline copy, or the partial file |
| A file at or under the inline limit changes outside the tools after a tool wrote it | `read_file`, `edit` and a content-less `show_artifact` return the map's inline copy, and `edit` writes that stale text plus its change over the file | `write_file` the path again | the agent reads and writes back old content |
| A caller builds the file tools without a `store` | each tool keeps its own `MemoryArtifactStore` and `edit` makes one per call, so no tool finds another's write | pass `store`, as every production caller does | under `virtual:` a read misses what was written |
| `edit` or `write_file` names a path `show_artifact` already produced | the read comes from the artifact and the write goes through the configured destination, which under `$DEFAULT` overwrites the workspace file of that name | none | a workspace file replaced by the artifact's text |
| `read_file` opens a very large file | the whole file is returned | none | the model's context fills |
| `grep` gets a `glob` argument that does not compile | `globToRegExp` throws outside the tool's `try`, so the call rejects instead of returning `{error}` | none | the call fails without a tool error message |
| A walk is large or a `grep` expression backtracks badly | the walk and the matching are synchronous, in the app's main process | none | the window stalls |
| `web_fetch` is redirected | the fetch follows it; the gate judged only the URL named | none | a page from a host the url scopes deny |
| A caller passes `capabilities` to `startRun`, as a description sync and a changeset review do | `bash`, `run_command` and the agent runtimes are left out, but the file, search and web tools are registered after the caller's, replacing a sync's own `read_file` | none | a sync's states can also call `show_artifact` |
| The CLI runs a workflow without a task, as `jaira run --workflows <dir>` does | no file tools are registered, and no CLI run adds `show_artifact` to its states | run it inside a project, which mints a task | a state declaring `read_file` fails as not registered |
| A tool call is retried | `write_file` converges on the same bytes and record; an `edit` whose old text is gone refuses; `bash` runs the command again | none | a repeated command's effects |

## The tools cap their own time, output and walks

- `bash`: 120000 ms and 20000 characters per stream, `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_OUTPUT` in `tools.ts`.
- File tools: an inline copy up to `artifacts.inlineMaxBytes`, and 65536 bytes when a caller passes none, `DEFAULT_INLINE_MAX` in `fileTools.ts`.
- `glob` and `grep`: 20000 walked entries, 200 matches, files over 2000000 bytes and files containing NUL skipped, 400 characters per matched line, `MAX_VISIT`, `MAX_MATCHES` and `MAX_GREP_BYTES` in `searchTools.ts`.
- Web tools: 30000 ms, 100000 characters of text, 20 search results, in `webTools.ts`.

## Two tools depart from the usual shape, each for a stated reason

- `bash` names its interpreter and passes the line as one argument, where every other `Exec` caller passes argv, so that the dialect the policy judged is the dialect that runs.
- Reads consult the artifact map before the disk, so a workflow reads its own writes wherever the destination put them, at the cost of stale reads after an outside change.
