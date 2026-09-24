---
id: engineering/contracts/push-messages
type: engineering-contract
status: shipped
updated: 2026-09-23
visibility: internal
kind: event
owned_by: [engineering/units/ipc-bridge]
consumers: ["@jaira/app renderer store.ts push handler", "@jaira/app renderer pointerMenu.tsx", "@jaira/app tests that record an AppService publish callback"]
since: 2026-07-24
siblings: [engineering/contracts/session-live-protocol, engineering/contracts/journal-events, engineering/contracts/preload-bridge, engineering/contracts/ipc-channels, engineering/contracts/inbox-channels]
---

# Push messages

Every message main sends the renderer unasked, on the one `jaira:push` channel, each a tagged object whose `type` names what changed and whose content is news for the renderer to refetch on, never state to keep.

## A caller pushes news the renderer did not ask for, and never state it must be able to read again

**Use when.** Main has something to tell every window without being asked: a run moved or ended, a store changed, a person is being asked something or an ask ended, a log line was kept, a call is streaming, or a right-click happened inside an artifact frame.

**Do not use when.** The renderer needs a value it can read again. A push is lossy and is not replayed, so every consumer refetches through [ipc-channels](ipc-channels.md); a stream is re-read through `session:live` in [session-live-protocol](session-live-protocol.md). Answering a request is a channel's response, never a push. Each producing unit owns what its messages mean; this contract owns the envelope, the set of types and the stamping.

## The shape is one tagged union, grouped here by what each message reports

Main sends with `webContents.send(PUSH_CHANNEL, message)` through the `publish` option `index.ts` gives `AppService`. The renderer receives through `window.jaira.subscribe(listener)`, which returns an unsubscribe function. `PushMessage` in `@jaira/shared` `ipc.ts` is the union.

### Run and store news carry a top-level project stamp when they are about one project

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `engine:event` `taskId` | string | yes | the task whose journal recorded the event |
| `engine:event` `seq` | number | yes | this push's order within one run or one typed turn, from 1; not the journal's `seq` |
| `engine:event` `at` | epoch ms | yes | the time handed to the journal's `record` |
| `engine:event` `event` | JSON | yes | the journaled event verbatim, per [journal-events](journal-events.md), or `{type: "artifact.failed", name, reason}` when a returned artifact could not be placed after a run |
| `engine:event` `project` | string | no | the project directory, set for journaled events |
| `store:invalidate` `scope` | `tasks`, `board`, `task`, `workflows`, `config` or `availability` | yes | which reads to refetch |
| `store:invalidate` `taskId` | string | no | set with scope `task` |
| `store:invalidate` `project` | string | no | the project directory; absent means machine-wide |
| `run:finished` `taskId` | string | yes | the task whose run settled |
| `run:finished` `status` | `completed`, `failed` or `canceled` | yes | how it settled; a crash of the run loop is `failed` |
| `run:finished` `project` | string | no | the project directory |

### Each store invalidation scope has a fixed set of publishers

| Scope | Published when |
| --- | --- |
| `tasks` | a project opens having recovered tasks; a native-session recovery folds something; a task is created, renamed, rerun, deleted, rewound or forked; a run starts or ends; a fan-out host makes or changes tasks; a cancel sets a live run `stopping` or ends a task that is not running; history is pruned |
| `board` | a run journals any event, once per event; a task is renamed or deleted; history is pruned |
| `task` | a run ends; a typed turn ends; history is pruned, once per pruned task |
| `workflows` | the workflows watcher fires, after a 150 ms debounce; configuration is written; executors are probed; a workflow is written, moved or deleted; a file is written, created, renamed or deleted; a description sync's changeset review run completes |
| `config` | configuration is written |
| `availability` | an availability pass lands |

### Inbox news says a request parked or ended, and carries its project inside the request

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `interaction:requested` `pending` | `PendingInteraction` | yes | a gate parked, or was parked again for a follow-up round |
| `interaction:resolved` `requestId` | string | yes | a gate was answered, held for a follow-up round, abandoned at close, or a recovered gate was answered |
| `approval:requested` `pending` | `PendingApproval` | yes | policy escalated a tool call to a person |
| `approval:resolved` `requestId`, `decision` | string, `allow` or `deny` | yes | an approval was decided, including the denials a stop or a project close makes |
| `question:requested` `pending` | `PendingQuestion` | yes | an agent asked a question |
| `question:resolved` `requestId` | string | yes | a question was answered or dismissed, including by a stop, a rewind or a close |
| `userEvent:requested` `request` | `UserEventRequest` | yes | a transition started waiting on a board gesture |
| `userEvent:resolved` `requestId` | string | yes | the wait ended, however it ended |

The pending shapes are [inbox-channels](inbox-channels.md).

### Streaming, diagnostics and frame news

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `session:turn` | see [session-live-protocol](session-live-protocol.md) | yes | one delta of a call in flight |
| `log:entry` `entry` | `{id, at, level, source, message, project, taskId, instanceId, jobId, detail}`, the last five optional | yes | every diagnostics entry the log policy keeps |
| `frame:contextMenu` `menu` | `{x, y, selectionText, linkURL, srcURL, mediaType, isEditable, editFlags}` | yes | a right-click inside a sandboxed artifact frame, in window coordinates; `mediaType` is `none`, `image`, `audio`, `video`, `canvas`, `file` or `plugin`; `editFlags` is `{canCut, canCopy, canPaste, canSelectAll}` |
| `limits:changed` `view` | `LimitsView` | yes | the limits board changed — a reading arrived from a call, a refresh started or ended — coalesced to one push per 100 ms. Published bare, machine-wide ([usage-readings](usage-readings.md)) |
| `waiting:changed` `items` | `WaitingItem[]` | yes | a message or a run waiting for an account's allowance was added, sent, deleted, rescheduled to a later reset, or had its "Try again at …" box changed. Published bare, machine-wide |
| `forge:signInFinished` `outcome` | `ForgeSignInOutcome`: `{ok: true, connection, login?}` or `{ok: false, connection, code: "denied" \| "expired" \| "canceled" \| "failed", reason}` | yes | a sign-in `forge:signIn` started has ended; on success it is sent after the token is stored and the availability pass that checks it has landed, so `login` is the account that pass saw ([forge-integrations](../units/forge-integrations.md)). Published bare, machine-wide |

## No error reaches the publisher, and an undeliverable push is recorded and dropped

| Condition | Response | Caller does |
| --- | --- | --- |
| No window, a destroyed window, or a renderer that has not finished loading or is gone | the push is dropped without a trace | nothing; the renderer loads everything when it starts |
| `webContents.send` throws | caught; recorded as a `crash` log entry `push: '<type>' could not be delivered: <message>` | nothing |
| Forwarding a frame right-click throws | caught; recorded as `push: context menu could not be forwarded: <message>` | nothing |
| A renderer listener throws | the preload catches it, writes `[jaira] a push listener threw` to the renderer console, and drops that push for that listener only | nothing |
| A push is sent before a window subscribes | lost; pushes are never replayed | the window's initial load reads current state |

## A change to a type or field breaks the renderer's handlers at once, and no deprecation path exists

- Adding a `type` is additive: the store's `switch` ignores what it does not name, and `pointerMenu.tsx` ignores everything but `frame:contextMenu`.
- Renaming or reshaping a type breaks `store.ts` and `pointerMenu.tsx` in the same build, since main and the renderer ship together and no push carries a version.
- Dropping or changing the top-level `project` stamp breaks the store's rule that ignores another project's invalidations.
- A change to `session:turn` or its `n` is a change to [session-live-protocol](session-live-protocol.md) and breaks both folds.

## The project stamp, the task filter and the sequence numbers are narrower than they look

- Only `engine:event`, `store:invalidate` and `run:finished` carry a top-level `project`, and only when published through `publishFor`. The watcher, `config`, `availability` and every authoring `workflows` invalidation are published bare and read as machine-wide, and so is `artifact.failed`.
- Inbox pushes carry the project inside `pending`, and `userEvent:requested` carries none. `session:turn` is published bare, and the store filters it by `taskId` alone.
- The store drops a `store:invalidate` whose `project` differs from the window's, except that `tasks` still refreshes the project list, shared tasks and every conversation, `board` refreshes the project list while the Tasks view is showing, and `task` refreshes the selected task when its project is the one stamped. `engine:event` and `run:finished` are applied whatever their project.
- A `task` invalidation is handled without reading `taskId`: the store refreshes whichever task is selected.
- `board` fires once per journaled event of a run, so a consumer that refetches on it pays per event. A typed turn publishes no `board`.
- `engine:event.seq` restarts at 1 for every run and every typed turn; order across them is not comparable.
- The fan-out host's journal rows are recorded without the tee and are never pushed.
- `frame:contextMenu` is sent straight from `index.ts`, without the check that the renderer has loaded.
- `interaction:resolved` fires when a gate is abandoned at close, although its durable row survives and the next open asks it again.
