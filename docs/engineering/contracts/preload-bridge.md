---
id: engineering/contracts/preload-bridge
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/ipc-bridge]
consumers: ["@jaira/app renderer store.ts, whose exported invoke and subscribe wrap the bridge", "@jaira/app renderer modules that import invoke from store.ts: App.tsx, chatPane.tsx, components.tsx, fileSurfaces.tsx, pointerMenu.tsx, reviewNotes.tsx, runViews.tsx, schemaForm/check.ts, valueView.tsx", "@jaira/app renderer pointerMenu.tsx, through subscribe"]
siblings: [engineering/contracts/ipc-channels, engineering/contracts/push-messages, engineering/contracts/refusal-errors]
---

# Preload bridge

The preload bridge is the `window.jaira` object `preload.ts` exposes through `contextBridge`: one function that sends a request on a listed channel and resolves the main process's answer, and one that subscribes to main's pushes.

## A renderer module reaches main only through this bridge, and never for Node, the engine or a database

**Use when.** Renderer code needs anything the main process holds: a read, a write, a person's answer, an OS verb, or news main pushes. Call it through `invoke` and `subscribe` in `store.ts`, not through `window.jaira` directly.

**Do not use when.** Looking for a channel's request and response: [ipc-channels](ipc-channels.md). Looking for what a push carries: [push-messages](push-messages.md). The renderer has no Node, engine or database handle by design, and no other path to main exists.

## The shape is two functions on `window.jaira`, typed by the channel contract

`JairaBridge` in `@jaira/shared` `ipc.ts`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `invoke` | `(channel, request) => Promise`, generic over `IpcChannel`, request typed `IpcRequest` and answer `IpcResponse` of that channel | yes | one round trip to the handler registered for `channel` |
| `subscribe` | `(listener: (message: PushMessage) => void) => () => void` | yes | calls `listener` with every message main sends on `PUSH_CHANNEL`, `"jaira:push"`; the returned function removes the listener |

The call path:

1. `invoke` in `preload.ts` rejects a channel that is not in `IPC_CHANNELS`, then calls `ipcRenderer.invoke(channel, request)`.
2. `registerIpc` in `index.ts` has one `ipcMain.handle` per listed channel. It awaits the handler from the `handlers` table, repaints the title bar after `settings:write`, and returns the answer.
3. A handler that throws goes to `AppService.recordIpcFailure(channel, error)` and is rethrown.

`store.ts` wraps both functions. Its `invoke` is async, and its `subscribe` is not.

## Every failure arrives as a rejection whose message is the only thing that survives

| Condition | Response | Caller does |
| --- | --- | --- |
| `window.jaira` is absent because the preload did not run | `store.ts` `invoke` rejects, and `subscribe` throws, `the JaiRA bridge is unavailable (preload did not run)` | nothing at runtime; the window was built without its preload |
| The channel is not in `IPC_CHANNELS` | rejects `channel '<c>' is not part of the IPC contract` | nothing at runtime; `IpcChannel` makes this a type error |
| The request cannot be structured-cloned | the synchronous throw from `ipcRenderer.invoke` is turned into a rejection | send JSON values only |
| The handler throws a `Refusal` | rejects; nothing more is logged, because the site that decided logged it at `warn` | show the message |
| The handler throws `ApprovalRequired` | rejects with its message; `pending` does not cross | call `functions:pending` for the list, as [task-channels](task-channels.md) describes |
| The handler throws any other error | rejects; one `error` entry with source `ipc`, message `<channel>: <message>` and the stack in `detail` | show the message |
| The handler's answer cannot be structured-cloned | rejects with Electron's clone error; `recordIpcFailure` never sees it | none; the handler returns something that is not JSON |
| A push listener throws | `console.error("[jaira] a push listener threw", type, error)` in the renderer; that push is dropped for that listener, and other listeners still get it | nothing |

Refusal and log routing are [refusal-errors](refusal-errors.md).

## A change to either function breaks every renderer caller in the same build, and there is no deprecation path

- Adding a channel takes an `IpcContract` entry, an `IPC_CHANNELS` entry and a `handlers` entry. The compiler refuses the build until all three agree: `satisfies` refuses a listed name the contract lacks, `_everyChannelIsListed` names a declared channel the list omits, and the `handlers` table, a record keyed by every `IpcChannel`, refuses a missing handler.
- Renaming `invoke`, `subscribe`, the `jaira` global or `PUSH_CHANNEL` breaks `store.ts` and `pointerMenu.tsx` at once.
- Main, preload and renderer are bundled and shipped together, so no older caller exists and nothing is versioned.

## Rejections carry less than the thrown error, and requests are never checked at runtime

- The renderer sees `Error invoking remote method '<channel>': Error: <message>`. Electron builds that string from the error's `toString()`, and the renderer shows it as it arrives; nothing strips the prefix.
- Every own property of a thrown error is lost, including `ApprovalRequired.pending` and any `cause`.
- Neither side validates a request's shape. Each handler casts the request to its channel's type, so a malformed request reaches `AppService` as sent. Only `interaction:submit` re-validates what it is given, as [inbox-channels](inbox-channels.md) describes.
- A push is lossy: when main drops one and why is [push-messages](push-messages.md).
