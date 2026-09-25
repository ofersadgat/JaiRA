---
id: engineering/contracts/ipc-channels
type: engineering-contract
status: shipped
updated: 2026-09-23
visibility: internal
kind: api
owned_by: [engineering/units/ipc-bridge]
consumers: ["@jaira/app renderer store.ts and the modules that call its invoke", "@jaira/app main preload.ts, whose whitelist is IPC_CHANNELS", "@jaira/app main index.ts handler table", "@jaira/app tests that drive AppService methods directly"]
since: 2026-07-24
siblings: [engineering/contracts/preload-bridge, engineering/contracts/push-messages, engineering/contracts/task-channels, engineering/contracts/chat-channels, engineering/contracts/inbox-channels, engineering/contracts/session-live-protocol, engineering/contracts/schema-check-channels, engineering/contracts/workflow-sync-channels, engineering/contracts/uri-read, engineering/contracts/task-view-models]
---

# IPC channels

The IPC channels are the 120 request and response pairs in `IpcContract` in `@jaira/shared` `ipc.ts` that the renderer invokes on the main process, one handler each in `index.ts`, grouped here by family.

## A caller finds its channel here, and follows the link when its family has a contract of its own

**Use when.** The renderer needs a read or a write that main holds: projects, tasks, views, records, logs, workflow and file authoring, type checks, artifacts, OS verbs, history, settings, configuration, executors and secrets.

**Do not use when.** Calling a channel from the renderer, and how its failure travels: [preload-bridge](preload-bridge.md). Hearing about a change without asking: [push-messages](push-messages.md). Anything an agent process could reach: no agent reaches these channels.

## The shape is one request and one response per channel, grouped into families

Types are from `ipc.ts` unless a table says otherwise; view types are from `view.ts`. `void` means the channel takes no request.

### Every request that names a project names it the same way

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `project` | `ProjectRef`, a string | no | a project directory as opened, or `"shared"` for the base root; absent resolves only while exactly one user project is open. The rule and the reads that fall back instead of refusing are [view-addressing](../units/view-addressing.md) |

### Eight families have contracts of their own, and their shapes are there

| Family | Channels | Contract |
| --- | --- | --- |
| Task actions and module approval | `task:create`, `task:start`, `task:cancel`, `task:rerun`, `task:resume`, `task:resumable`, `task:move`, `task:adopt`, `task:connect`, `task:connectUndo`, `task:inputSources`, `task:rewind`, `task:fork`, `task:delete`, `task:rename`, `functions:pending`, `functions:approve` | [task-channels](task-channels.md) |
| Typed conversation | `chat:plan`, `chat:startPlan`, `chat:send`, `chat:cancel`, `chat:thread` | [chat-channels](chat-channels.md) |
| Inbox | `interaction:pending`, `interaction:submit`, `approval:pending`, `approval:submit`, `question:pending`, `question:submit`, `userEvent:pending`, `userEvent:deliver` | [inbox-channels](inbox-channels.md) |
| Live turn snapshot | `session:live` | [session-live-protocol](session-live-protocol.md) |
| Schema checks | `schema:validate`, `schema:check`, `schema:detect` | [schema-check-channels](schema-check-channels.md) |
| Description sync and changeset review | `workflow:syncStatus`, `workflow:sync`, `workflow:syncCancel`, `changeset:review`, `changeset:reviewSync` | [workflow-sync-channels](workflow-sync-channels.md) |
| Reads by URI | `uri:read` | [uri-read](uri-read.md) |
| Pushes from main | the `jaira:push` messages, which are not request channels | [push-messages](push-messages.md) |

### Project channels open, set up, inspect and list the projects of this process

| Channel | Request | Response |
| --- | --- | --- |
| `project:open` | `{dir: string}`, resolved in `index.ts` | `{dir: string; recovered: string[]}`: the project directory, and the task ids recovery marked interrupted; `recovered` is `[]` when the project was already open |
| `project:init` | `{dir: string}` | the same as `project:open`, after laying out `.jaira/` and keeping an existing `settings.json` |
| `project:choose` | `{mode: "open" \| "init"}` or `void`, `"open"` when absent | `{dir: string}`, or `null` when the dialog was dismissed or there is no dialog |
| `project:inspect` | `{dir: string}` | `{dir; exists: boolean; project: boolean; open: boolean}`; `project` is whether `<dir>/.jaira` exists |
| `project:current` | `void` | `{dir: string}` of the user project opened last, or `null` |
| `project:list` | `void` | `ProjectSummary[]` |

Opening, closing and restoring are [project-sessions](../units/project-sessions.md).

### Task read channels answer summaries, a detail and a timeline

| Channel | Request | Response |
| --- | --- | --- |
| `task:list` | `{project?}` or `void` | `TaskSummary[]` of one project |
| `task:all` | `{workflows?: string[]}` or `void` | `ProjectTask[]`, every open session's tasks stamped with `project`, newest `updatedAt` first, narrowed to those workflow roots when given |
| `task:detail` | `{taskId: string; project?}` | `TaskDetail`, with `resume` only for a startable task |
| `task:changes` | `{taskId: string; base?: string; project?}` | `{changeset?: Changeset; reason?: string}` — the worktree's edits against `base` (HEAD), read only; `reason` says why there is none. The side panel's Changes tab ([0008](../decisions/0008-side-panels.md)) |
| `task:conversation` | `{taskId: string; project?}` | `ConversationView` |
| `task:system` | `void` | `TaskSummary[]` of the shared root, `[]` when it cannot open |

`ProjectSummary`, `TaskSummary`, `ProjectTask`, `TaskDetail` and `ConversationView` are [task-view-models](task-view-models.md).

### View channels answer boards, the file tree and one state

| Channel | Request | Response |
| --- | --- | --- |
| `board:view` | `{level?: string; project?}` or `void` | `BoardView`; `level` is any state id |
| `board:roots` | `{project?}` or `void` | `BoardView` with one column per workflow root; empty when no session resolves |
| `files:tree` | `{project?}` or `void` | `FileTree` |
| `files:hiddenReport` | `HiddenReportRequest`: `{project?; extra?: string; layer?: ConfigLayer}` | `HiddenReport` |
| `files:whyHidden` | `{project?; path: string}` | `HiddenVerdict` |
| `state:view` | `{stateId: string; project?}` | `StateView` |
| `state:slots` | `{stateIds: string[]; project?}` | `Record<string, StateSlots>`, keyed by state id, omitting an id that names no state |
| `state:effective` | `{stateId: string; taskId?: string; instanceId?: string; project?}` | `EffectiveState` |

`BoardView`, `FileTree`, `StateView` and `StateSlots` are [task-view-models](task-view-models.md). `EffectiveState`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `stateId` | string | yes | the state asked about |
| `from` | `"pinned"`, `"moved"` or `"disk"` | yes | `pinned` when the task's snapshot is the workflow as it stands, `moved` when the workflow has changed since and the file shown is today's, `disk` when no task was named |
| `snapshotHash` | string | no | the task's pinned snapshot |
| `rootId` | string | no | the workflow root whose closure holds the state |
| `source` | `WorkflowSource` | no | the state's file; absent when the bundle has no such state |
| `values` | `EffectiveStateValues` | no | present only when `taskId` was named and an execution of the state is in its journal |
| `values.instanceId` | string | yes | the named execution, else the last one |
| `values.inputs` | `Record<string, JsonValue>` | no | the inputs on that execution's `instance.entered` |
| `values.output` | `JsonValue` | no | the record's value at the execution's conversation position |
| `values.children` | record of child key to input record | no | each child's entered inputs, the latest pass per key |

`files:hiddenReport` and `files:whyHidden` answer about ONE root: the named user project's checkout, or the shared root when the call names the shared root or none resolves. The rules are `layeredHiddenRules` (`@jaira/shared` `hiddenPaths.ts`): the built-in defaults, then each layer's `files.hidden` as its document holds it — `base`, `project`, and `you`, the person's own list. The report is ONE breadth-first walk (`packages/app/src/main/hiddenReport.ts`) with a budget of 1.5 s and 60,000 entries. Each path the walk reaches goes to the rule that decides it, the last to match; a hidden folder counts once and is not entered. After the visible tree, with what is left, it looks inside the folders JaiRA's own group hides. `HiddenReport`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `root` | string | yes | the directory walked |
| `rules` | `HiddenRuleReport[]` | yes | every effective rule, in the order applied |
| `extra` | `HiddenRuleReport` | no | the request's `extra`, appended after every other rule and reported here alone; its `layer` is the request's `layer`, else `project` with a project and `base` without |
| `capped` | boolean | yes | the budget ran out in the visible tree, so every count is at least |

`HiddenRuleReport`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `pattern` | string | yes | the rule as written, `!` included |
| `layer` | `"built in"`, `"base"`, `"project"` or `"you"` | yes | who states it |
| `hides` | `{files: number; folders: number}` | yes | the top-most paths it decides; for a `!` rule, the ones it puts back that an earlier rule hid |
| `samples` | string[] | yes | at most three of those paths, relative, shallowest first |
| `inside` | `{folders: string[]; count: number}` | no | its matches inside a folder JaiRA's own group hides, which the tree never shows |

`HiddenVerdict`, answered top-down the way the walk decides — the first hidden ancestor, not the path's own last match:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `hidden` | boolean | yes | whether the tree shows the path |
| `rule` | string | no | the rule that hid it or the folder it is in; for a shown path, the `!` rule that put it back |
| `layer` | as `HiddenRuleReport.layer` | no | who states `rule` |
| `via` | string | no | the ancestor folder that matched, when the path is inside it |

`files:whyHidden` takes a path relative to the root or absolute inside it; one outside it is a `Refusal` "'<path>' is not inside <root>".

### Record channels read what a task's calls said

| Channel | Request | Response |
| --- | --- | --- |
| `session:history` | `{taskId: string; project?}` | `SessionRef[]`, one per call that ran in a conversation, in time order |
| `run:records` | `{taskId: string; project?}` | `OperationRecordView[]`, every record of the task |
| `session:view` | `{taskId: string; instanceId?: string; project?}` | `SessionView` of the last history row for that instance, or of the last row when none is named |

The readers are [conversation-lookup](../units/conversation-lookup.md). The shapes, from `view.ts`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `SessionRef.instanceId`, `stateId`, `sessionId` | string | yes | the call's instance, its state and its conversation |
| `SessionRef.seq`, `at` | number | yes | the record's position in the conversation, and when the call ended |
| `SessionRef.branch` | `{parent: string; at: number}` | no | the conversation this one forked from and the position they share |
| `SessionRef.startedAt` | number | no | when `operation.started` was journaled |
| `SessionRef.status` | `"success"`, `"error"`, `"interrupted"` or `"running"` | no | how the call ended, or that its record is still open |
| `SessionRef.costUsd` | number | no | the call's cost |
| `SessionRef.metrics` | `RunMetrics` | no | the call's usage |
| `SessionRef.address` | `AddressStep` array | no | the instance's position from the root, as in [task-view-models](task-view-models.md) |
| `RunMetrics.costSource` | `"provider"`, `"table"` or `"unknown"` | no | where the cost figure came from |
| `RunMetrics.inputTokens`, `outputTokens`, `noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `durationMs` | number | no | billed input including cache, output, uncached input, cache reads, cache writes, reasoning output within output, wall clock |
| `OperationRecordView.recordId`, `status` | string | yes | the record's id and status |
| `OperationRecordView.request`, `result`, `error` | `JsonValue` | no | as stored |
| `OperationRecordView.startedAt`, `endedAt` | number | no | epoch ms |
| `SessionView.taskId`, `instanceId`, `stateId`, `sessionId` | string | yes | what was read |
| `SessionView.seq` | number | yes | the record's position |
| `SessionView.providerSessionId` | string | no | the agent's own session handle |
| `SessionView.status`, `costUsd` | as on `SessionRef` | no | as on `SessionRef` |
| `SessionView.turns` | `SessionTurn[]` | yes | the conversation in order |
| `SessionView.sidechains` | record of spawning call id to `SessionTurn[]` | no | subagent conversations |
| `SessionView.providerEvents` | `{index: number; event: JsonValue}[]` | no | provider events pinned among the messages, `index` counting the turns before each |
| `SessionView.native` | `{index: number; line: JsonValue}[]` | no | lines of the agent's own session file captured at close |
| `SessionView.outputs` | `SessionOutput[]` | no | turns that are the operation's structured output |
| `SessionView.empty` | string | no | why the state ran in no conversation |
| `SessionTurn.role` | string | yes | the speaker |
| `SessionTurn.text` | string | no | the turn's text |
| `SessionTurn.parts` | `JsonValue` | no | tool calls and results |
| `SessionTurn.at`, `startedAt`, `thoughtMs` | number | no | arrival, first fragment, and thinking time before the answer began |
| `SessionOutput.turn` or `callId` | number or string | one of the two | the turn whose text is the value, or the tool call whose arguments are |
| `SessionOutput.value` | `JsonValue` | yes | the value the record bound |
| `SessionOutput.schema`, `name` | `JsonValue`, string | no | the output slot's schema and name |

### Log and job channels page the app's log and read child processes

| Channel | Request | Response |
| --- | --- | --- |
| `log:list` | `LogQuery` or `void` | `LogPage` |
| `job:list` | `{project?: string; taskId?: string}` or `void` | `JobRow[]`: the task's jobs, or without `taskId` the open jobs with a fresh heartbeat; `[]` when no session resolves |
| `job:output` | `{project?: string; jobId: number; stream?: "stdout" \| "stderr"; limit?: number}` | `JobOutputChunk[]`, whole, with no cursor; `[]` when no session resolves |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `LogQuery.before` | string | no | a page's `cursor`; absent starts at the newest entry |
| `LogQuery.limit` | number | no | clamped to 1 through 1000; 200 when absent |
| `LogQuery.level` | `"debug"`, `"info"`, `"warn"` or `"error"` | no | that level and worse |
| `LogQuery.source` | string | no | a source, or a dot-path ancestor of one |
| `LogQuery.project` | string | no | equal to `LogEntry.project` |
| `LogQuery.text` | string | no | a case-blind substring of the message, the source or the detail |
| `LogPage.entries` | `LogEntry[]` | yes | newest first |
| `LogPage.cursor` | string | no | where the next older page starts; absent when nothing older is left |
| `LogEntry.id`, `at` | number | yes | an identity, not an order, and epoch ms |
| `LogEntry.level`, `source`, `message` | level, string, string | yes | what was said and by what |
| `LogEntry.project` | string | no | the session key of the project concerned |
| `LogEntry.taskId`, `instanceId` | string | no | pointers to a task and a state in it |
| `LogEntry.jobId` | number | no | a pointer to a job's output |
| `LogEntry.detail` | `JsonValue` | no | a stack, an argv, anything the message cannot hold |
| `JobRow.id`, `kind`, `ownerToken`, `startedAt`, `heartbeatAt` | number, `"run"` or `"process"`, string, number, number | yes | the job and its liveness |
| `JobRow.taskId`, `parentJobId`, `pid`, `command`, `cwd`, `cancelRequestedAt`, `endedAt`, `outcome` | string, number, number, string, string, number, number, string | no | what it ran for and how it ended |
| `JobOutputChunk.id`, `jobId`, `seq`, `createdAt` | number | yes | the chunk's row |
| `JobOutputChunk.stream`, `chunk` | `"stdout"` or `"stderr"`, string | yes | the text |
| `JobOutputChunk.dropped` | number | yes | bytes elided just before this chunk |

The log is [app-log](../units/app-log.md), and the job rows are [process-claims](../units/process-claims.md).

### Workflow authoring channels read and change state files by state id

| Channel | Request | Response |
| --- | --- | --- |
| `workflow:browse` | `{project?}` or `void` | `WorkflowBrowser`, in [task-view-models](task-view-models.md) |
| `workflow:read` | `{stateId: string; layer: "project" \| "base"; project?}` | `WorkflowSource` |
| `workflow:write` | `{stateId; layer; project?; text: string}`; `text` must parse as JSON | `WorkflowSource` |
| `workflow:move` | `{stateId; layer; project?; to: string; toLayer; copy?: boolean; force?: boolean}` | `WorkflowMutationResult` |
| `workflow:delete` | `{stateId; layer; force?: boolean; project?}` | `WorkflowMutationResult` |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `WorkflowSource.stateId`, `layer` | string, layer | yes | the address |
| `WorkflowSource.project` | string | no | declared, and never set by these channels |
| `WorkflowSource.file` | string | yes | the absolute file |
| `WorkflowSource.text` | string | yes | the file, or `""` when it does not exist |
| `WorkflowSource.exists` | boolean | yes | whether the file exists |
| `WorkflowMutationResult.stateId`, `layer` | string, layer | yes | the destination when applied, the source when refused |
| `WorkflowMutationResult.project` | string | no | declared, and never set |
| `WorkflowMutationResult.applied` | boolean | yes | `false` when states still reference the one renamed or deleted and `force` was not set |
| `WorkflowMutationResult.referencedBy` | string array | yes | the states that declare it as a child |

Authoring is [workflow-authoring](../units/workflow-authoring.md).

### File channels read and change any file under a root by path

| Channel | Request | Response |
| --- | --- | --- |
| `file:read` | `{layer; project?; path: string}` | `FileSource`; refuses a type that is not text and a directory |
| `file:write` | `{layer; project?; path: string; text: string}` | `FileSource`; unparsed, and refuses a state file |
| `file:create` | `{layer; project?; path: string; kind: "file" \| "directory"; text?: string}` | `{file: string}`, the absolute path; refuses an existing path |
| `file:rename` | `{layer; project?; path: string; to: string; force?: boolean}` | `FileMutationResult` |
| `file:delete` | `{layer; project?; path: string; force?: boolean}` | `FileMutationResult`; a directory goes with everything in it |
| `file:find` | `{query: string; project?; limit?: number}` | `{paths: string[]; truncated: boolean}`: project files whose path holds `query` as a case-blind subsequence |

`path` is relative with forward slashes, from the checkout for the `project` layer and from the base root for `base`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `FileSource.layer`, `path` | layer, string | yes | the address as asked |
| `FileSource.project` | string | no | echoed by `file:read` only |
| `FileSource.file` | string | yes | the absolute file |
| `FileSource.mime` | string | yes | from `mimeOfPath` on the path as the layer spells it |
| `FileSource.text`, `exists` | string, boolean | yes | the file, or `""` and `false` |
| `FileSource.stateId` | string | no | the state the file defines, when it is under `workflows/` with a `.json`, `.yaml` or `.yml` name |
| `FileMutationResult.path`, `layer` | string, layer | yes | the destination when applied, the source when refused |
| `FileMutationResult.project` | string | no | declared, and never set |
| `FileMutationResult.applied` | boolean | yes | `false` when states outside the affected set reference states inside it and `force` was not set |
| `FileMutationResult.referencedBy` | string array | yes | those referring states |
| `FileMutationResult.states` | string array | yes | the state ids the path covered |

### Type-check channels ask the TypeScript program a file belongs to

| Channel | Request | Response |
| --- | --- | --- |
| `file:check` | `CheckFileRequest` | `FileCheck` |
| `file:definition` | `DefineFileRequest` | `{definitions: FileLocation[]; checked: boolean}` |
| `file:references` | `DefineFileRequest` | `{references: FileLocation[]; checked: boolean; truncated?: boolean}`, at most `REFERENCE_FILE_LIMIT`, 60, files |
| `file:hover` | `DefineFileRequest` | `{checked: boolean; info?: FileSpan & {signature: string; documentation?: string}}` |
| `file:source` | `SourceFileRequest` | `{text?: string}`, present only for a file the program holds |
| `file:release` | `CheckTarget` | `void`; the checker forgets that file's buffer |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `CheckTarget.layer`, `path`, `project` | layer, string, string | `project` no | addressed as the file channels are |
| `CheckTarget.taskId` | string | no | resolve `path` in that task's worktree instead; refused when the task has none |
| `CheckFileRequest.text` | string | no | the editor's buffer; absent checks the file on disk |
| `CheckFileRequest.baseline` | `BaselineFile[]` | no | check against the tree with these files put back: `{path: string; text: string \| null}`, `null` meaning the file was absent |
| `DefineFileRequest.line`, `column` | number | yes | the caret, 1-based |
| `SourceFileRequest.file` | string | yes | an absolute path as a `FileLocation` reported it |
| `SourceFileRequest.baseline` | `BaselineFile[]` | no | the tree the question was asked in |
| `FileCheck.checked` | boolean | yes | `false` when no `tsconfig.json` covers the file, or the check failed |
| `FileCheck.reason`, `config` | string | no | why not; the `tsconfig.json` answered from |
| `FileCheck.baseline` | boolean | no | the answer is about the baseline |
| `FileCheck.diagnostics` | `FileDiagnostic[]` | yes | empty when unchecked |
| `FileSpan.startLine`, `startColumn`, `endLine`, `endColumn` | number | yes | 1-based |
| `FileDiagnostic` | `FileSpan` plus `severity: "error" \| "warning" \| "info"`, `code: number`, `message: string`, `file?: string`, `related?: (FileSpan & {file; message})[]` | yes | one compiler diagnostic |
| `FileLocation` | `FileSpan` plus `file: string`, `at?: {layer; project?; path}`, `name?: string` | yes | `at` is absent for a file outside the root and for any answer about a worktree |

The checker is [ts-language-service](../units/ts-language-service.md).

### Artifact and git channels grant a frame, list a task's artifacts and name the committer

| Channel | Request | Response |
| --- | --- | --- |
| `artifact:serve` | `{taskId: string; path: string; project?; mediaType?: string}` | `ServedArtifact` |
| `artifact:list` | `{taskId: string; project?}` | `ArtifactSummary[]`, oldest first |
| `git:identity` | `{project?}` | `{name?: string; email?: string}` from the project's repository, falling back to the machine's git config, `{}` when there is none |

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ServedArtifact.url` | string | yes | `jaira-artifact://frame/<uuid>`, meaningful only to this window |
| `ServedArtifact.mediaType` | string | yes | the request's, else the record's, else from the path |
| `ServedArtifact.bytes` | number | yes | UTF-8 byte length of the body |
| `ServedArtifact.interactive` | boolean | yes | whether the record claimed it may run |
| `ArtifactSummary.path`, `mediaType` | string | yes | the logical path, and the record's type or the path's |
| `ArtifactSummary.bytes`, `createdAt` | number | yes | size and creation time |
| `ArtifactSummary.interactive` | boolean | yes | as above |
| `ArtifactSummary.stateId`, `slot` | string | no | the state and output slot that produced it |

What the scheme serves for a grant is [artifact-frame-protocol](artifact-frame-protocol.md), and grants are [uri-and-artifact-reads](../units/uri-and-artifact-reads.md).

### Shell channels are the OS verbs the window performs

| Channel | Request | Response |
| --- | --- | --- |
| `shell:reveal` | `{file: string}` | `{file: string}`, echoed |
| `shell:saveFile` | `{name: string; data: string}`, `data` base64 | `{file: string \| null}`, `null` when the dialog was dismissed |
| `shell:download` | `{url: string}` | `{started: boolean}`, `false` for no window, an unparsable URL, or a scheme other than `data:`, `blob:`, `file:`, `http:`, `https:` and `jaira-artifact:` |
| `shell:copyImageAt` | `{x: number; y: number}`, window coordinates | `{copied: boolean}`: the request was made, not that an image was there |
| `shell:edit` | `{verb: "cut" \| "copy" \| "paste" \| "selectAll"}` | `{verb: string}` |

These are [app-shell](../units/app-shell.md).

### History channels size and prune stored history

| Channel | Request | Response |
| --- | --- | --- |
| `history:size` | `{project?}` or `void` | `HistorySize` |
| `history:prune` | `{olderThanDays?: number; apply?: boolean}`; no `project` | `PruneResult` with `remaining: HistorySize`; without `apply: true` it is a plan and deletes nothing |

`HistorySize` and `PruneResult` are [task-view-models](task-view-models.md); the rule is [history-pruning](../units/history-pruning.md).

### Settings, configuration, executor and secret channels

| Channel | Request | Response |
| --- | --- | --- |
| `settings:read` | `void` | `JairaSettings` |
| `settings:write` | a partial `JairaSettings`, merged one level deep | the whole `JairaSettings` written |
| `config:read` | `{project?}` or `void` | `ConfigView`: the three layers and their merge; with no project, the shared root and the personal layer |
| `config:write` | `{layer: "you" \| "project" \| "base"; project?; config: JsonValue}`; `project` names where a project write lands, and for the other two which project's view is read back | `ConfigView` after the write |
| `executor:list` | `void` | `ExecutorInfo[]` |
| `executor:probe` | `{name?: string}` or `void` | `ProbeResult[]`, every executor when `name` is absent |
| `model:probe` | `void` | `ProbeResult[]` for the configured routes; no model is called |
| `model:probeLocal` | `{baseURL?: string}` or `void`; `baseURL` compares with the field as typed instead of the configured `local.baseURL` | `LocalServerDiscovery`: Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000` and Jan `:1337`, each asked `GET {base}/v1/models` in parallel with an 800 ms deadline, `inUse` on the row the `local` route names, and a `Configured` row when it names none of them; on demand only |
| `model:checkWeights` | `{weights?: Record<string, {modelPath: string}>}` or `void`; absent checks the configured `embedded.weights` | `EmbeddedWeightsReport`: one `WeightsFileCheck` per model (`exists`, `sizeBytes`, a split model's `parts` summed, `error`) and whether `node-llama-cpp` resolves — the rows the `embedded` route's probe is decided from |
| `mcp:detect` | `void` | `McpDetectedSource[]`: where other tools on this machine keep MCP servers — Claude Code's `~/.claude.json` (its own list and this project's entry), the project's `.mcp.json`, Claude Desktop's config, Cursor's (`~/.cursor` and the project's), VS Code's `.vscode/mcp.json` — each `found`, `none listed` or `not found` with its servers converted to ours, and Figma Dev Mode's `127.0.0.1:3845/mcp` asked for its tools within 1.5 s. READ only: nothing a source lists is started ([mcp-servers](../units/mcp-servers.md)) |
| `mcp:tools` | `{recheck?: boolean}` or `void` | `McpToolsReport`: each configured server `ready` with its tools (name, description, `readOnlyHint`, `destructiveHint`, title), `failed` with the reason and a fix, or `not started` (off, or a secret it names is stored nowhere), with the transport, its command or address, and each secret it names with where the chain found it — never the value. The probe STARTS those servers, 10 s each, side by side, so main caches it by the servers' block, the project and the execution environment and probes again only when one changed or `recheck` is set |
| `forge:signIn` | `{connection: string}` | `ForgeSignInStart`: `{ok: true, pending: ForgeSignInPending}` once the forge hands out a code (the page is opened in the browser, polling continues in main), or `{ok: false, reason, fix?}` — a self-hosted connection with no `oauthClientId`, the connection is off, or the forge refused the app; an unknown connection rejects. A second call while one waits answers with the one waiting. How it ends is the `forge:signInFinished` push ([forge-integrations](../units/forge-integrations.md)) |
| `forge:cancelSignIn` | `{connection: string}` | `void`; the waiting sign-in ends `canceled`, and nothing waiting is not an error |
| `forge:signIns` | `void` | `ForgeSignInPending[]`, the sign-ins waiting on the person now |
| `forge:signOut` | `{connection: string}` | `ForgeSignOutOutcome`: the token removed from where the chain finds it, with its OAuth mark and refresh token, then a re-check; `{ok: false, reason}` naming the place when it is one JaiRA does not write |
| `availability:read` | `void` | `AvailabilitySnapshot`, as last observed |
| `availability:refresh` | `void` | `AvailabilitySnapshot` from a pass that starts after the call |
| `limits:read` | `void` | `LimitsView`: every account the limits board knows (`LimitAccountView`: the reading, when it arrived, who is signed in, the plan, whether a refresh is offered, and why the last refresh learned nothing) and which account each route spends ([usage-readings](usage-readings.md)). Changes arrive as `limits:changed` |
| `limits:refresh` | `{account: string}` | `LimitsView` after that account's refresh lands — claude asked with `get_usage` on a process started for nothing else, codex read from its newest session file; one that learns nothing leaves the reading as it was |
| `limits:watch` | `{watching: boolean}` | `void`; a meter came on screen or went away. While at least one watches, the board refreshes a reading older than 30 minutes, or whose reset has passed, by itself — never an account asked within the last 30 minutes |
| `waiting:list` | `{project?, taskId?}` or `void` | `WaitingItem[]`: messages and runs waiting for an account's allowance, oldest first — `waiting` (sent while the account had none left, sent by itself at `until`) or `refused` (tried again at `until` only while `retry` is on) |
| `waiting:act` | `{id, action: "sendNow" \| "drop" \| "retry", retry?}` | `WaitingItem[]` after the act: Send now anyway sends it straight away, `drop` deletes it (a waiting message's only cancel), `retry` sets the "Try again at …" box |
| `secret:capabilities` | `void` | `{keychain: boolean; keychainReason?: string}` |
| `secret:set` | `{name: string; value: string; target: "keychain" \| "project-env-local" \| "base-env-local"; project?}`; an empty `value` removes | `{name: string; target}` |

`JairaSettings` is [user-settings-json](user-settings-json.md); a layer's document is [settings-json](settings-json.md); `SecretOrigin` and the targets' files are [secret-sources](secret-sources.md).

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ConfigView.base`, `project`, `you` | `JsonValue` or `null` | yes | each layer's document as authored — the shared root's `settings.json`, the project's, and `personal-settings.json` — `null` when it has no file |
| `ConfigView.effective` | `JsonValue` | yes | base, then project, then you, merged and parsed with defaults — what a run uses, and the `appearance` the window paints |
| `ConfigView.baseFile`, `projectFile`, `youFile`, `baseDir` | string | yes | the files and the base root; `projectFile` is `""` when no session resolves |
| `ExecutorInfo.name`, `kind` | string, `"sdk"`, `"cli"`, `"codex"` or `"generic"` | yes | the registry name and runtime |
| `ExecutorInfo.enabled` | boolean | yes | `false` when configuration turned it off |
| `ExecutorInfo.credentialUse` | `"required"`, `"optional"` or `"none"` | yes | whether the runtime uses a key |
| `ExecutorInfo.policyEnforcement` | `"callback"`, `"config"` or `"none"` | yes | what of the policy it can enforce |
| `ExecutorInfo.command`, `credential`, `sandbox` | string | no | its binary, its secret's name, its sandbox setting |
| `ProbeResult.name`, `detail` | string | yes | what was checked and what was found |
| `ProbeResult.status` | `"ok"`, `"failed"`, `"disabled"` or `"not-checked"` | yes | the verdict; `not-checked` is not `ok` |
| `ProbeResult.version` | string | no | the binary's version output |
| `ProbeResult.credential` | `SecretOrigin` | no | where the credential resolved, never its value |
| `ProbeResult.credentialMissing`, `fix` | string | no | the named credential nothing supplies; one line saying what would fix a failure |
| `AvailabilitySnapshot.routes`, `executors` | `ProbeResult[]` | yes | routes in `MODEL_ROUTE_KEYS` order, executors in inventory order |
| `AvailabilitySnapshot.tree` | `JairaOperationNode` | no | the default executor resolved from the checks, as [executor-tree](../units/executor-tree.md) builds it |
| `AvailabilitySnapshot.forges` | `ForgeCheck[]` | no | each forge connection, checked by asking its host who the token is; `ForgeCheck.via` is `"oauth"` for a token a browser sign-in stored and the chain still finds there, `"token"` otherwise |
| `AvailabilitySnapshot.checkedAt` | number | yes | epoch ms, `0` before any pass |

## Errors are rejections carrying a message, and a few channels answer an empty or refused result instead

| Condition | Response | Caller does |
| --- | --- | --- |
| `project` names a project that is not open, or is absent while none or several are open | rejects `project '<ref>' is not open`, `no project is open` or `several projects are open, so this call must name one`; the browse reads that fall back instead are in [view-addressing](../units/view-addressing.md) | name an open project |
| `project:open` of a directory without `.jaira/` | rejects `<dir> is not a JaiRA project (no .jaira/ — run 'jaira init')` | call `project:inspect`, then offer `project:init` |
| A task read names an unknown task | rejects `unknown task '<id>' in <projectDir>` | read from the project that holds it |
| A state id or path resolves outside its root | rejects `'<stateId>' does not name a state inside the <layer> workflows directory` or `'<path>' is not inside the <layer> root` | fix the address |
| `workflow:write` with text that is not JSON | rejects `not valid JSON: <message>`; nothing is written | fix the text |
| A move, rename, create or delete meets the wrong file state | rejects `'<id>' does not exist in the <layer> layer`, `'<path>' does not exist in the <layer> root`, `the source and destination are the same file` or `path`, `'<to>' already exists`, `'<to>' already exists in the <toLayer> layer`, or `'<to>' is inside '<path>'` | refresh the tree |
| A rename or delete would break referring states and `force` is not set | resolves with `applied: false` and `referencedBy`; nothing changes | show the referrers, then send again with `force: true` |
| `file:read` or `file:write` of a type that is not text, `file:read` of a directory, `file:write` of a state file | rejects `'<path>' is <mime>, which is not text`, `'<path>' is a directory`, or `'<path>' is a state file — write it through workflow:write` | use the right channel or none |
| A check names a task with no worktree | rejects `task '<taskId>' has no worktree to check '<path>' in` | check the checkout instead |
| No `tsconfig.json` covers a checked file, or the check throws inside the program | resolves `checked: false` with `reason` | draw nothing |
| The type checker is closing | rejects `the type checker is shutting down` | nothing |
| `artifact:serve` or `artifact:list` resolves no session, or names an artifact that is gone | rejects `no project is open`, `no artifact at '<path>' for task <taskId>`, or `the bytes for '<path>' are no longer where they were placed` | name the project, or say the artifact is gone |
| `config:write` to the project layer with no session, or a document whose merge does not parse | rejects `no project was named, so there is no project config to write`, `project '<ref>' is not open`, or the parse error naming the field — for the shared or the personal layer, also merged with each open project, the error then ending `(with <file> as the project layer)`; nothing is written | name the project, or fix the field |
| `executor:probe` names no configured executor | rejects `unknown executor '<name>'` | pick from `executor:list` |
| `secret:set` with a bad name, or the keychain target where none is available | rejects `'<name>' is not a usable secret name`, or `keychainReason`, else `no encrypted store is available here` | choose a name matching `[A-Za-z_][A-Za-z0-9_.-]*`, or a file target |
| `history:prune` with a negative or non-finite age | rejects `olderThanDays must be a non-negative number` | send a number of days |
| `job:list`, `job:output` or `task:system` with nothing to answer from | resolves `[]` | nothing |

How a rejection reaches the renderer, and what it loses on the way, is [preload-bridge](preload-bridge.md).

## A change to a channel or a shape breaks main and the renderer in one build, and there is no deprecation path

- A channel exists only when it is in `IpcContract`, in `IPC_CHANNELS` and in the `handlers` table; the compiler holds the three to one set.
- Renaming or retyping a channel or a field breaks `store.ts`, the renderer modules that call it and the handler together. They ship together and nothing is versioned, so no alias is kept.
- A change to a view type is also a change to [task-view-models](task-view-models.md), and scripts reading `jaira board --json` or `jaira workflow list --json` see it.
- Adding an optional field is safe for every caller.

## Several channels address, cache or fall back in ways their names do not show

- The path-addressed file channels and the check channels address a `project`-layer path from the checkout, so a state file is `.jaira/workflows/<id>.json` there, while `workflow:*` channels take a state id under `workflows/`.
- On Windows a `path` on another drive, such as `D:/x.txt`, passes the containment check of the file and check channels, because the relative path from the root is absolute and resolves back to itself; `workflow:*` channels refuse it.
- No request is validated at runtime. A field the type requires can be missing and reach the service.
- `executor:list`, `executor:probe`, `model:probe` and `availability:refresh` read the only open user project's configuration and credentials, and with none or several open, the base root's `settings.json` with `personal-settings.json` laid over it.
- `settings:write` merges one level deep, so a partial `ui` or `logging` replaces the whole block. A write carrying `logging` changes what the log keeps from the next entry.
- `config:write` writes the document as sent once its merge parses, re-layers every open session, and pushes `config` and `workflows` invalidations. It is also the channel after which main repaints the OS window controls: the frame is the shared root's and the personal layer's `appearance` (`AppService.windowAppearance`), never a project's. `settings:write` no longer carries anything the frame reads.
- `artifact:serve` and `artifact:list` say `no project is open` for a named project that is not open. `artifact:serve` keeps the 64 newest grants, so an older frame URL stops resolving.
- `git:identity` is cached per project for the life of the process, so a changed `user.name` is not seen until restart.
- `file:find` visits at most 20 000 entries breadth first, skips dot directories and `node_modules`, `dist`, `build`, `out`, `target`, `vendor`, `coverage` and `__pycache__`, clamps `limit` to 1 through 200 with 30 by default, sorts by depth then name, and sets `truncated` whenever directories were left unvisited.
- `workflow:move` with `copy` or an unchanged id never checks referrers.
- `history:prune` takes no project and acts on the only open user project, while `history:size` takes one, so the two can describe different projects.
- `project:list`, `task:all` and `task:system` open the base root's database the first time they are called.
- `job:output` answers the whole kept head and tail on every call, because the capture rewrites its rows as the process runs.
- `LogEntry.project` is the session key, the real path lower-cased on Windows, and `LogQuery.project` must equal it.
- `shell:reveal` echoes its request even where no file manager is wired, and `shell:copyImageAt` answers `copied: true` whether or not an image was under the point.
