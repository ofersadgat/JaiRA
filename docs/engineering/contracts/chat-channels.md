---
id: engineering/contracts/chat-channels
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/chat-turns, engineering/units/conversation-lookup]
consumers: ["@jaira/app renderer chatPane.tsx", "@jaira/app renderer runViews.tsx", "@jaira/app tests chatMessage, chatConversation, chatDurability, chatCut"]
siblings: [engineering/contracts/task-channels, engineering/contracts/session-live-protocol, engineering/contracts/push-messages, engineering/contracts/ipc-channels]
---

# Chat channels

The five IPC channels through which the renderer asks what a typed message would run under, sends one into a conversation a task's run started, stops typed turns, and reads the conversation back whole.

## A caller reaches for these to continue a conversation, and never to start or stop a run

**Use when.** Showing the composer's settings before a send, continuing a conversation a run started, stopping the typed turns in flight, or reading a task's whole conversation with its edit points and forks.

**Do not use when.** Starting a conversation, which is `task:create` then `task:start` with `overrides`, or stopping a run, including the opening message, which is `task:cancel`: see [task-channels](task-channels.md). Cutting or copying a conversation at a message, which is `task:rewind` or `task:fork` with an edit point's `seq`. Renaming a conversation's task, which is `task:rename` in [ipc-channels](ipc-channels.md). Following a turn while it streams: [session-live-protocol](session-live-protocol.md).

## The shape is five request and response pairs over two shared value types

Every request's `project` is the project directory as a string; it may be omitted only while exactly one project is open.

### `chat:plan` answers what a message to an instance would run under, or null where no conversation is

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task whose run holds the conversation |
| `instanceId` | string | yes | the instance being read; a chat child, or a state whose own operation is not a prompt, resolves to the nearest ancestor that speaks |
| `project` | string | no | the project holding the task |
| `overrides` | `ChatSettings` | no | picks folded over what the host inherits |
| response | `ChatPlanView` or `null` | yes | `null` for a composite, an instance the run's projection lacks, a task that never ran, or a host that made no model call |

### `chat:startPlan` answers the same for a state no conversation has run yet

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `stateId` | string | yes | the state a new conversation would run, read from its live state file |
| `project` | string | no | the project whose workflows are read |
| `overrides` | `ChatSettings` | no | picks folded over the state file |
| response | `ChatPlanView` | yes | never `null`; a state that is not installed gives every origin `unset`, and `live` is always `idle` |

### `chat:send` runs one message, or joins a call in flight

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `instanceId` | string | yes | as for `chat:plan` |
| `message` | string | yes | the prompt; refused when blank after trimming |
| `project` | string | no | the project holding the task |
| `overrides` | `ChatSettings` | no | applied to this message only; never stored |
| `branchAt` | string | no | an edit point's `at` from `chat:thread`; the message replaces the one at that position on a new branch and is never steered |
| `fake` | fake rules | no | not in the declared type; main reads it to script the turn's prompt answers |
| response `instanceId` | string | yes | `chat:<hostInstanceId>` for a turn; the host's own id for a steered message |
| response `index` | number | yes | the turn's index on the chat instance; for a steered message, the index the next turn will take |
| response `sessionRef` | string | no | `<sessionId>@<seq>`, where the conversation now ends |
| response `failure` | string | no | why the turn did not answer, a stop included |
| response `steered` | `true` | no | the message joined a call in flight and has no record or journal event of its own |
| response `value` | resolved value | no | not in the declared type; what the turn returned |

### `chat:cancel` stops every typed turn in flight for a task

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `project` | string | no | the project holding the task |
| response `canceled` | boolean | yes | `false` when no typed turn was registered |

### `chat:thread` reads a task's conversation whole, forks walked

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `project` | string | no | the project holding the task |
| response | `ChatThreadView` or `null` | yes | `null` when the task has no session history outside chat instances, or no state on the host's path speaks |
| `taskId` | string | yes | the task |
| `instanceId` | string | yes | the host: the first instance in the task's session history that is not a chat instance; what `chat:send` and `chat:plan` address |
| `session` | `SessionView` | yes | every record on the chain's turns concatenated; the view and its fold are [conversation-lookup](../units/conversation-lookup.md)'s |
| `points` | array of `{turn, at, seq}` | yes | one per record after the first: `turn` is the thread index of its first turn, `at` is an opaque position for `branchAt`, and `seq` is the journal position its turn starts at, absent where the journal names none |
| `forks` | array of `{turn, left}` | no | `turn` is the index of the first turn past a split, every turn before it being common; `left` lists each branch not shown as `{sessionId, turns}` |
| `origin` | `TaskOrigin` | no | where a forked or fan-out-made task came from, as in [task-view-models](task-view-models.md) |

### `ChatSettings` carries the composer's picks, each one optional

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `model` | string | no | `route/model` or a bare model id |
| `reasoning` | `{effort, budgetTokens}` | no | `effort` is `low`, `medium`, `high` or `xhigh`; `budgetTokens` a number; both optional |
| `tools` | string array | no | the whole list; `[]` means none; absent keeps the state's own |
| `permissions` | `{profile, default, tools, other, scopes}` | no | all optional; modes are `allow`, `deny` or `ask`, and a permission set line may name a function (`{ "function": "smart" }`), which lowers as `ask` with its reference in `functions`; `tools` maps a tool name to a mode; `other` covers a tool outside the vocabulary; `scopes` is a `Scope` array |
| `implementations` | record of tool name to `app` or `native` | no | whose code runs a tool; never inherited |

### `ChatPlanView` says what was declared, where it came from, and what will actually run

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `settings` | `ChatSettings` | yes | inherited values with overrides folded in |
| `origin` | record over the five `ChatSettings` keys of `inherited`, `override` or `unset` | yes | where each value came from; `implementations` is never `inherited` |
| `from` | string | no | the state id that supplied the inherited half |
| `unresolved` | array of `{field, expr}` | yes | inherited `model`, `reasoning`, `tools` or `permissions` written as an expression, which have no value outside a run |
| `live` | `idle`, `steerable` or `busy` | yes | `idle` when no call is registered on the conversation's session, `steerable` when the call can take a message, `busy` otherwise |
| `effective.model` | string | no | the setting, else the model that answered the last turn, else the router's pinned default, else `<route>/default` for the route that answers unnamed models |
| `effective.reasoning` | string | yes | the effort, or `the model's default` |
| `effective.permissions` | string | yes | the label of the preset the per-tool map matches, `custom` for any other map, or with no map the default mode's preset label or `<mode> by default`; prefixed `<profile> · ` when a profile other than `full` is in force |
| `available.routes` | string array | yes | the prompt router's routes and the configured agent routes, sorted |
| `available.tools` | array of `{name, readOnly}` | yes | JaiRA's gateable tools |
| `available.models` | array of `{id, input, output}` | yes | the known models and their input and output modalities |

## Planning answers null where sending refuses, and every refusal names its reason

| Condition | Response | Caller does |
| --- | --- | --- |
| `project` names a project that is not open, or is absent while several are open | rejects: `project '<ref>' is not open`, `several projects are open, so this call must name one` or `no project is open` | name an open project |
| The task's pinned snapshot is gone | `chat:plan`, `chat:send` and `chat:thread` reject `the snapshot for task <taskId> is missing` | nothing from the composer; the project's snapshots are damaged |
| No conversation is at the instance | `chat:plan` and `chat:thread` answer `null` | disable the composer |
| `chat:send` to a task that never ran | rejects `task '<taskId>' has never run` | show the text |
| `chat:send` to an instance the projection lacks | rejects `task <taskId> has no instance <instanceId>` | refresh and send again |
| `chat:send` where no state on the path runs a prompt | rejects with a message beginning `instance <instanceId> is not part of any conversation` | address a speaking instance |
| `chat:send` to a host that made no model call | rejects `instance <hostId> ran no model call, so there is no conversation to continue` | show the text |
| `branchAt` names nothing in the task's record store | rejects `'<ref>' is not a message in this conversation` | read the thread again |
| A blank `message` | rejects `a message cannot be empty` | keep the composer open |
| `overrides.tools` names a tool nothing registered | rejects `tool '<name>' is not registered` | pick from `available.tools` |
| The pinned workflow names a model no configured route serves | rejects with the executor tree's start-time refusal | make a route that serves it available |
| The model or transport fails, or the turn is stopped | resolves with `failure` | show `failure` |
| `chat:cancel` with no typed turn in flight | `{canceled: false}` | nothing |

## A change to any field breaks the composer and the thread together, and nothing is versioned

- Main and the renderer are built together and no request carries a version, so a renamed field or channel breaks at once rather than degrading.
- The renderer reads only `failure` from a `chat:send` response and the rejection's message; the tests match refusal wording, so rewording a refusal breaks them.
- `points[].at` and `sessionRef` are the session store's spelling and are parsed by nothing in the renderer; changing that spelling breaks every edit point a thread already returned.
- There is no deprecation path.

## Sends wait, steer and refuse in ways the channel names do not show

- `chat:send` may wait up to 240 s before its turn starts: 120 s for the send ahead of it, then 120 s for a call registered on the same session. Past either bound it goes ahead, and an occupied position forks onto a branch the thread may not show.
- `live` is read at plan time and is stale by send time; `chat:send` decides steering again.
- A steered message returns the host's id and no `sessionRef`, and it appears in the thread only once the call it joined writes its record.
- `chat:cancel` reaches only typed turns that have started. A message waiting behind the stopped turn still runs, and a message steered into a run's call, or the opening run itself, stops only through `task:cancel`.
- Overrides are not stored anywhere: every send must carry them again, or the message runs under the host's settings.
- `chat:send` checks every model the pinned workflow names, not only the host's, so one unservable model anywhere in the snapshot refuses every send, while `chat:plan` builds its router without that check and shows the plan.
- `branchAt` is checked only as a record existing at that position in the task's store, not as a position on the chain the thread shows.
- `chat:thread`'s host is the first speaking instance in the task's history, so a task with several conversations exposes only the first through this channel.
- A `NoConversationHere` rejection from `chat:send` is logged at `error` by the IPC boundary, while the other refusals are logged at `warn` where they are decided.
