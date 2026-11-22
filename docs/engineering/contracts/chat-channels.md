---
id: engineering/contracts/chat-channels
type: engineering-contract
status: shipped
updated: 2026-11-22
visibility: internal
kind: api
owned_by: [engineering/units/chat-turns, engineering/units/conversation-lookup]
consumers: ["@jaira/app renderer chatThreadModel.ts", "@jaira/universal ChatStart.tsx and RunConversation.tsx", "@jaira/app tests chatMessage, chatConversation, chatDurability, chatCut"]
siblings: [engineering/contracts/task-channels, engineering/contracts/session-live-protocol, engineering/contracts/push-messages, engineering/contracts/ipc-channels]
---

# Chat channels

The six IPC channels through which the renderer asks what a message would run under, sends one into a conversation as the answer to its program's `input()`, stops the reply in flight, ends the conversation, and reads it back whole.

## A caller reaches for these to continue a conversation, and never to start or stop a run

**Use when.** Showing the composer's settings before a send, continuing a conversation a run started, stopping the reply in flight, ending a conversation, or reading a task's whole conversation with its edit points and forks.

**Do not use when.** Starting a conversation, which is `task:create` then `task:start` with `overrides`, or stopping the program itself, which is `task:cancel`: see [task-channels](task-channels.md). Cutting or copying a conversation at a message, which is `task:rewind` or `task:fork` with an edit point's `seq`. Renaming a conversation's task, which is `task:rename` in [ipc-channels](ipc-channels.md). Following a turn while it streams: [session-live-protocol](session-live-protocol.md).

## The shape is six request and response pairs over two shared value types

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

### `chat:send` answers a program conversation's `input()`, or joins a call in flight

Only a conversation that is a PROGRAM takes a message (decision 0029 §2, 2026-11-19): the message is the
answer to its `input()` — a wait answered now, one the app closed on answered with its run started again,
a call in flight steered where its transport can take it and otherwise the next `input()` seeded, an ended
conversation rewound to the wait it ended at. A conversation whose workflow is not a program — one
recorded as a single prompt state before the switch, or a workflow of one call — rejects `this
conversation takes no more messages: it is not a program that waits for them — start a new conversation`.
There is no other way a message runs: no turn outside a run, no `chat:<host>` child made.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `instanceId` | string | yes | as for `chat:plan` |
| `message` | string | yes | the prompt; refused when blank after trimming |
| `project` | string | no | the project holding the task |
| `overrides` | `ChatSettings` | no | folded over the conversation's kept settings and handed to the program in the answer; settings that name tools or a permission set are also kept on the task and reach the run's calls |
| `branchAt` | string | no | an edit point's `at` from `chat:thread`; the task is rewound to that point and the message answers the `input()` that asked there; never steered |
| `now` | `true` | no | "Send now": join the call in flight where its transport can take a message, rather than queue (decision 0033 §9) |
| `fake` | fake rules | no | not in the declared type; main hands it to the resume a rewind makes, for an edit or an ended conversation |
| response `instanceId` | string | yes | as sent |
| response `index` | number | yes | `0` |
| response `program` | `true` | no | the message went to the program's `input()`: the run's next call is the reply, streamed and landing as a run's calls do |
| response `steered` | `true` | no | the message joined a call in flight (`now`): the call's record holds it, and the journal a `jaira.steered` row |
| response `queued` | `QueuedMessageView` | no | sent while a call ran and not `now`: kept for the program's next `input()`, the oldest first, shown by `chat:queue` |

### `chat:queue` and `chat:queueAct`: the messages waiting for the next `input()`

`chat:queue` (`{ taskId, project? }`) answers the conversation's queued messages oldest first, and
`steerable`: whether a call in flight can take a message now, which is when Send now is offered.
`chat:queueAct` (`{ id, action: "drop" | "sendNow" }`) deletes one, or sends it now: removed from the queue
and steered into the call in flight (`chat:send` with `now`); one that could not be sent goes back at the
head. The queue is kept in `~/.jaira/system/queued.json`; `queued:changed` publishes it; a program parking
at `input()` is answered with the head, after the park's own row is written.

### `task:interrupt` interrupts the calls a target reaches

`{ taskId, target, reason?, project? }` → `{ interrupted }`. The target is a state's instance id (the call
it is making) or an `interruptSignal()` id (every call made under it, read off `config.interrupt` and taken
out before a model sees it). Each call fails canceled, its reason `interrupted: <reason>` and
`interrupted: { reason? }` on its error; a program may catch it, and a run that does not ends stopped.

### `chat:cancel` stops the reply a program conversation is making

Every call in flight for the task is ended early where its transport can end a turn, and canceled
otherwise; the task's pending approvals are denied, its questions stopped and its live tail written down
first. The program goes on to wait for the next message.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `project` | string | no | the project holding the task |
| response `canceled` | boolean | yes | `false` when no call was in flight |

### `chat:end` ends a conversation that is a program

Its `input()` returns `null` (decision 0029 §2), and the program does what it does at its end: `session`
reviews the conversation for lessons. Waiting now: the wait is answered. A reply in flight: the wait after
it is. A conversation the app closed on while it waited: its run starts again with the answer in hand.
A message sent to it afterwards takes it up again where it ended (a rewind to that wait, the message its
answer). The Chat list offers it for a row whose `TaskSummary.waitsForMessage` is set.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task |
| `project` | string | no | the project holding the task |
| response `ended` | boolean | yes | `false` for a conversation that is not a program, or one already ended |

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
| `permissions` | `{profile, default, tools, other, scopes}` | no | all optional; modes are `allow`, `deny` or `ask`, and a permission set line may name a function (`"smart"`, any string that is no mode word), which lowers as `ask` with its reference in `functions`; `tools` maps a tool name to a mode; `other` covers a tool outside the vocabulary; `scopes` is a `Scope` array |
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
| The task's pinned snapshot is gone | `chat:plan` and `chat:thread` reject `the snapshot for task <taskId> is missing` | nothing from the composer; the project's snapshots are damaged |
| No conversation is at the instance | `chat:plan` and `chat:thread` answer `null` | disable the composer |
| `chat:send` to a task whose run is not a program: one recorded as a single prompt, a workflow of one call, a task that never ran or whose snapshot is gone | rejects `this conversation takes no more messages: it is not a program that waits for them — start a new conversation` | start a new conversation |
| `branchAt` names no edit point of the thread with a journal position | rejects `'<branchAt>' is not a message in this conversation that can be edited` | read the thread again |
| A blank `message` | rejects `a message cannot be empty` | keep the composer open |
| The pinned workflow names a model no configured route serves | rejects with the executor tree's start-time refusal | make a route that serves it available |
| The reply's call fails, or is stopped | `chat:send` has already resolved; the call's `operation.failed` is journaled as any call of the run is | read the thread |
| `chat:cancel` with no call in flight | `{canceled: false}` | nothing |

## A change to any field breaks the composer and the thread together, and nothing is versioned

- Main and the renderer are built together and no request carries a version, so a renamed field or channel breaks at once rather than degrading.
- The renderer reads `failure` and `waiting` from a `chat:send` response, and the rejection's message. Main sets `waiting` when the message's account is known to be spent and the message is held until the reset; it never sets `failure`, since a reply's failure is journaled. The tests match refusal wording, so rewording a refusal breaks them.
- `points[].at` is the session store's spelling and is parsed by nothing in the renderer; changing that spelling breaks every edit point a thread already returned.
- There is no deprecation path.

## Sends wait, steer and refuse in ways the channel names do not show

- `chat:send` resolves once the message is delivered — answered at the wait, queued for the next `input()` while a call runs, or steered into the call in flight when sent `now` — never when the reply lands; the reply is the run's next call. To a conversation that ended it first rewinds the task to the last `input()` it asked, cutting what came after.
- `live` is read at plan time and is stale by send time; `chat:send` with `now` decides steering again, and queues when the call can no longer take the message.
- A steered message appears in the thread only once the call it joined writes its record, which folds it in.
- `chat:cancel` stops every call in flight for the task, the opening message's reply and a call a message was steered into included, and never the program: stopping the program is `task:cancel`. A message already queued for the next `input()` is not withdrawn, so it answers that `input()` at once.
- A message is sent under the conversation's kept settings (`TaskMeta.chatSettings`, which `chat:settings` writes) with its own `overrides` over them, all of it handed to the program inside the answer, `{text, settings}`. Settings that name tools or a permission set are also kept on the task and handed to the run's calls (`changeChatSettings`); the model and the reasoning are the program's to use or not.
- `branchAt` must name an edit point the thread shows now: an edit is a rewind of the task to that point's journal position, and the message is the answer to the `input()` that asked there.
- `chat:thread`'s host is the first speaking instance in the task's history, so a task with several conversations exposes only the first through this channel.
