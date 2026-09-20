---
id: engineering/contracts/inbox-channels
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/interaction-gateway]
consumers: ["@jaira/app renderer store.ts, for the inbox strip, gate surfaces, command approvals, agent questions and board drags", "@jaira/app main index.ts handler table"]
siblings: [engineering/contracts/gate-components, engineering/contracts/push-messages, engineering/contracts/ipc-channels, engineering/contracts/preload-bridge]
---

# Inbox channels

The eight IPC channels through which the renderer lists what runs are waiting on a person for, across every open project, and answers one by its request id.

## A caller uses these channels to answer something a run already waits on, and never to start or steer work

**Use when.** Listing the gates, command approvals, agent questions and board-gesture waits pending in every open project, and answering one. The `*:requested` and `*:resolved` pushes that keep those lists current carry the same pending shapes and are [push-messages](push-messages.md).

**Do not use when.** The decision is one a workflow could compute, which [gate-components](gate-components.md) rules out. Approving js/ts modules before a start: `functions:pending` and `functions:approve` in [task-channels](task-channels.md). Sending another message to a working agent: [chat-channels](chat-channels.md).

## The shape is one list channel and one answer channel per kind of request

### Every channel takes one request object and resolves one response

| Channel | Request | Response |
| --- | --- | --- |
| `interaction:pending` | none | `PendingInteraction[]` |
| `interaction:submit` | `SubmitInteractionRequest` | `{requestId: string}` |
| `approval:pending` | none | `PendingApproval[]` |
| `approval:submit` | `SubmitApprovalRequest` | `{requestId: string}` |
| `question:pending` | none | `PendingQuestion[]` |
| `question:submit` | `SubmitQuestionRequest` | `{requestId: string}` |
| `userEvent:pending` | none | `PendingUserEvent[]` |
| `userEvent:deliver` | `{requestId: string}` | `{requestId: string; delivered: boolean}` |

Each list spans every open project session, session by session in the order requests parked; `interaction:pending` then appends the stored gates of tasks not running in this process. A request id is `ui-<n>`, `approval-<n>`, `question-<n>` or `event-<n>`, unique among the requests of one app process. All types are in `@jaira/shared` `ipc.ts` and `userEvents.ts`.

### A pending gate carries its parsed contract and says whether answering it resumes the task

`PendingInteraction`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the id to answer |
| `taskId` | string | yes | the task whose run parked; `""` when the request named none, and such a request is never stored |
| `project` | `ProjectRef`, a string | yes | the project session the request parked in, as the directory was opened |
| `about` | string | no | for a `review_artifacts` gate parked by a changeset review task, the task under review |
| `subjectProject` | string | no | the project that `$WORKTREE`, `$JAIRA` and `$PROJECT` resolve against for this gate's file reads, when it is not `project` |
| `component` | string | yes | the registered function name |
| `inputs` | `Record<string, JsonValue>` | yes | what the function received: `operation.args` merged with the state's resolved inputs; a follow-up round adds `questions`, `prior_questions`, `prior_answers` and `follow_up_round` |
| `config` | `ComponentConfig` | no | the contract parsed in main, for a built-in component whose config parses |
| `configError` | string | no | the parse error, set instead of `config` |
| `resumes` | `true` | no | an earlier process stored this gate and no run waits on it; answering resumes the task |

`SubmitInteractionRequest`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the gate being answered |
| `value` | `JsonValue` | yes | the component's result as [gate-components](gate-components.md) shapes it; a multi-part `choose_option` sends `{answers}` for the round on screen only |

### An approval carries the command a person judges, and its answer says how long it lasts

`PendingApproval`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the id to answer |
| `tool` | string | yes | the logical tool name, such as `bash` or `write_file` |
| `command` | string | no | the tool input's `command` field |
| `reason` | string | no | the policy's reason for escalating that command |
| `input` | `Record<string, JsonValue>` | yes | the tool input as the model produced it |
| `taskId` | string | no | the task whose run or chat turn asked |
| `project` | `ProjectRef` | yes | the project session it parked in |
| `at` | number, epoch ms | yes | when it parked |

`SubmitApprovalRequest`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the approval being answered |
| `decision` | `"allow"` or `"deny"` | yes | the answer |
| `scope` | `ApprovalScope`: `"once"`, `"session"`, `"workflow-run"` or `"always"` | no | how long upstream's `PermissionLedger` applies the answer; `once` when absent |

### An agent's question batch is answered by question text, and no answers dismisses it

`PendingQuestion`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the id to answer |
| `questions` | `AgentQuestion[]` | yes | each is `question`, an optional `header`, `options` of `{label, description?}`, and an optional `multiSelect` |
| `taskId` | string | no | the task whose agent asked |
| `project` | `ProjectRef` | yes | the project session it parked in |
| `at` | number, epoch ms | yes | when it parked |

`SubmitQuestionRequest`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the batch being answered |
| `answers` | an object whose every value is a `string` or a `string[]` | no | question text to the chosen label, the chosen labels of a multi-select, or free text; absent dismisses the batch and the agent continues on its own judgment |

### A user event is a wait that a board gesture answers

`PendingUserEvent` is `UserEventRequest` with a project:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `requestId` | string | yes | the id to deliver |
| `event` | string | yes | the event type, the guard's first argument; `task_drag` is the one the board answers |
| `options` | `Record<string, JsonValue>` | yes | the call's options; for `task_drag`, `to_state` is the child key a drop must land on, filled from the rule's `to` unless that starts with `terminate.`, and `timeout` is the seconds before the wait answers `false` |
| `taskId` | string | no | the task whose run waits |
| `at` | number, epoch ms | yes | when it parked |
| `project` | `ProjectRef` | yes | the project session it parked in |

`userEvent:deliver` answers `delivered: true` when the wait was held and now resolves `true`.

## A refused answer is thrown with its reason, and a missed drop is only reported

| Condition | Response | Caller does |
| --- | --- | --- |
| A gate answer does not satisfy its component's contract | refusal `invalid <component> response: <errors>`; the gate stays parked | correct the answer and submit again |
| A gate id is unknown, already answered, or held while its follow-up round is decided | refusal `no pending interaction '<id>'` | refetch `interaction:pending` |
| An approval id is unknown or already answered | refusal `no pending approval '<id>'` | refetch `approval:pending` |
| A question id is unknown or already answered | refusal `no pending question '<id>'` | refetch `question:pending` |
| A user-event id is not held | `delivered: false`, no refusal | nothing: the run moved on |
| A stored gate, `resumes: true`, is answered | accepted: the row closes, `interaction:resolved` is pushed and the task resumes with the answer seeded; a resume that then refuses is logged at `error` and the answer is lost | watch the task, and answer again if the gate comes back |

A refusal reaches the renderer as a rejected call carrying its message only, as [preload-bridge](preload-bridge.md) describes.

## A change to a channel or a pending shape breaks main and the renderer together, and there is no deprecation path

- Renaming a channel breaks `IPC_CHANNELS`, the handler table in `index.ts` and `store.ts` at once.
- Changing a pending shape breaks the pushes that carry it and every renderer surface that draws it.
- Changing the follow-up keys in `inputs` breaks every stored `pending_interactions` row that holds a later round.
- Answer shapes are [gate-components](gate-components.md)'s, and approval scope names are upstream `PermissionScope`'s.
- The renderer and main ship together, so no channel keeps an old shape alive.

## Only gate answers are checked, and a list can show what no one here can answer

- Only `interaction:submit` is checked in main. `approval:submit` hands `decision` and `scope` to the hub unchecked, and `question:submit` answers are not matched against the offered options or question texts.
- A gate whose config does not parse, or whose component is not built in, is not checked either.
- The check does not rewrite the answer: the engine receives `value` exactly as sent, fields the check ignores included.
- Request ids restart in every process. A stored gate from an earlier process can share an id with a live one; the live one is listed, and an answer to that id reaches it.
- `interaction:pending` lists a gate that another process has parked as a stored gate with `resumes: true`. Answering it here closes its row, and the resume is refused because the task is running.
- A round being decided by the follow-up model call is on no list and has no row.
- Approvals, questions and waits are not stored. Closing a project denies its approvals, dismisses its questions and declines its waits; a resumed run asks again where it reaches them.
- `scope: "always"` is stored nowhere in JaiRA; it lasts as long as the upstream ledger that asked.
- `PendingApproval.command` comes from the tool input's `command` field alone. A tool that puts its command line under another key arrives with no `command` and no `reason`.
