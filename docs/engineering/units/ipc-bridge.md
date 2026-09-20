---
id: engineering/units/ipc-bridge
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/surfaces/error-notice, ux/patterns/refuse-with-the-reason-and-the-fix]
layer: service
owns_contracts: [engineering/contracts/preload-bridge, engineering/contracts/ipc-channels, engineering/contracts/push-messages]
requires: [engineering/units/project-sessions, engineering/units/view-addressing, engineering/units/task-lifecycle, engineering/units/rewind-and-fork, engineering/units/module-approvals, engineering/units/chat-turns, engineering/units/conversation-lookup, engineering/units/live-turns, engineering/units/interaction-gateway, engineering/units/workflow-authoring, engineering/units/description-sync, engineering/units/changesets, engineering/units/schema-check, engineering/units/ts-language-service, engineering/units/uri-and-artifact-reads, engineering/units/history-pruning, engineering/units/user-settings, engineering/units/project-config, engineering/units/agent-executors, engineering/units/model-routing, engineering/units/secret-chain, engineering/units/process-claims, engineering/units/app-log, engineering/units/app-shell]
implemented_by: [packages/app/src/main/preload.ts, packages/app/src/main/index.ts, packages/shared/src/ipc.ts]
verified_by: [packages/app/test/runViews.test.ts, packages/app/test/service.test.ts]
siblings: [engineering/units/app-shell, engineering/units/view-addressing, engineering/units/renderer-store, engineering/units/interaction-gateway]
---

# IPC bridge

## The bridge carries each listed channel to one service method and each push to the window, and decides nothing about what either means

The bridge is three pieces that must agree:

- `IpcContract`, `IPC_CHANNELS`, `PushMessage`, `PUSH_CHANNEL` and `JairaBridge` in `@jaira/shared` `ipc.ts`: the typed list of 96 request channels and the push union. `IPC_CHANNELS` is checked against `IpcContract` in both directions at compile time.
- `preload.ts`: the `window.jaira` object, whose `invoke` admits only channels in `IPC_CHANNELS` and whose `subscribe` guards each listener. Its shape and failures are [preload-bridge](../contracts/preload-bridge.md).
- `index.ts`: the `handlers` table, a record keyed by every `IpcChannel` whose entry casts the request and calls one `AppService` method, and `registerIpc`, which registers one `ipcMain.handle` per listed channel. A handler that throws is passed to `AppService.recordIpcFailure` and rethrown. After `settings:write` it repaints the title bar. The `publish` option `index.ts` gives `AppService` sends each push to the window only while `rendererAlive` is true, and turns a failed send into a `push` crash entry.

Every channel's request and response is [ipc-channels](../contracts/ipc-channels.md), and every push is [push-messages](../contracts/push-messages.md).

It deliberately does not own:

- What a channel does. Each family's unit owns its method, and [ipc-channels](../contracts/ipc-channels.md) names where each family is described.
- The four OS verbs whose handlers live in `index.ts`, `saveFile`, `download`, `copyImageAt` and `edit`, and the window, its lifecycle and `rendererAlive`: [app-shell](app-shell.md).
- Which project a request reads: [view-addressing](view-addressing.md) and [project-sessions](project-sessions.md).
- Logging a refusal where it is decided, and the log itself: [refusal-errors](../contracts/refusal-errors.md) and [app-log](app-log.md).
- The helpers that share `ipc.ts`: `choicesOfQuestions` is [component-contracts](component-contracts.md), and `foldWriting`, `isStreamBookkeeping` and `startsThinking` are [live-turns](live-turns.md). The view models in `view.ts` are [task-view-models](../contracts/task-view-models.md).
- What the renderer does with an answer or a push: [renderer-store](renderer-store.md).

## The bridge is the renderer and main boundary itself, and calls only AppService

- Layer `service`. The preload and the handler table are main-process code in `packages/app/src/main`; the types are in `@jaira/shared` so the renderer compiles against the same declaration.
- Boundary: renderer and main. The renderer has no Node integration and runs with `contextIsolation`, so `window.jaira` is its only capability, and the hubs a human answer reaches are behind these handlers alone.
- It may call `AppService` methods and, for the four OS verbs, the functions `index.ts` defines beside the table. It calls no persistence or runtime module directly.
- Upstream seam: none.

## The bridge stores nothing, and its one runtime list is derived from the contract

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `IPC_CHANNELS` | read by the preload into its `allowed` set, and by `registerIpc` | `IpcContract` in `ipc.ts`, which the compiler holds it to | none |
| `handlers` | read on every call | `index.ts` | the `AppService` method each entry names |
| `window` and `rendererAlive` | read by the `publish` guard before every send | `index.ts` memory | [app-shell](app-shell.md) sets both |
| `ipc` log entries | one written per non-refusal handler failure | the app log | [app-log](app-log.md) stores and serves them |

## The invariants keep every declared channel reachable and every failure visible exactly once

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | No channel is listed twice in `IPC_CHANNELS` | `runViews.test.ts` "has no duplicates, since it becomes a Set the bridge trusts" |
| 2 | `task:resume` and `task:resumable` are listed, so the preload admits them and main registers their handlers | `runViews.test.ts` "carries the resume channels" |
| 3 | Every channel `IpcContract` declares is listed and has a handler, and nothing else is listed | unasserted |
| 4 | A channel outside `IPC_CHANNELS` never reaches `ipcMain` | unasserted |
| 5 | A request that cannot be cloned reaches the caller as a rejection, never as a synchronous throw | unasserted |
| 6 | A handler failure that is not a `Refusal` is filed once, at `error`, source `ipc`, message `<channel>: <message>` | `service.test.ts` "records a failed IPC call by channel, and still rejects to the renderer" |
| 7 | A `Refusal` adds no entry at the boundary, having been logged at `warn` where it was decided | `service.test.ts` `"leaves a REFUSAL alone — its own site already logged it, and knew what it was"`, "logs a refusal where it is decided, and marks it so the boundary will not re-file it" |
| 8 | A handler failure still rejects to the renderer after it is filed | unasserted |
| 9 | A push that cannot be delivered never throws into the code that published it | unasserted |
| 10 | A push listener that throws does not stop the other listeners | unasserted |

## Every failure reaches the caller as a rejection or reaches nobody, and the bridge retries nothing

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two calls arrive together | each handler runs to its first `await` in arrival order; a synchronous handler such as `settings:write` or `config:write` runs whole, so the later call's document is the one on disk | none needed | the later change shows |
| A caller retries a call whose first attempt succeeded | the handler runs again with no idempotency key; `task:create` and `task:rerun` each make another task | delete the extra task | a second task appears |
| The process is killed while a handler writes | the bridge writes nothing durable; what survives is the handler unit's | the unit's own recovery | the window is gone |
| The renderer reloads or dies while a call is in flight | the handler finishes and its reply reaches no frame; every push while `rendererAlive` is false is dropped | the reloaded page reads everything again | stale until the reload lands |
| A handler never settles | the renderer's promise never resolves; the bridge has no timeout | none | the action stays busy |
| A handler's answer cannot be cloned | Electron rejects the call after the handler returned, so `recordIpcFailure` never sees it | none | the caller's error shows Electron's clone message |
| A push cannot be sent | caught in `publish`; filed as a `crash` entry `push: '<type>' could not be delivered: <message>` | the renderer refetches on its next invalidation | that update is missing until the next one |

## The bridge casts requests instead of validating them

- A request is cast to its channel's type in `handlers`, and no schema checks it on either side; both ends compile against one `IpcContract` in one build, and the trust-boundary check that exists is main's re-validation of gate answers in [interaction-gateway](interaction-gateway.md).
