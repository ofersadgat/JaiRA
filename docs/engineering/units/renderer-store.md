---
id: engineering/units/renderer-store
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/surfaces/app-window, ui/surfaces/error-notice, ui/surfaces/inbox-strip, ux/patterns/waiting-requests-gathered, product/keep-track-of-everything, product/all-projects-in-one-place]
layer: ui
owns_contracts: []
requires: [engineering/units/ipc-bridge, engineering/units/live-turns, engineering/units/drafts, engineering/units/ui-layout-state, engineering/units/address-trail, engineering/units/user-settings]
implemented_by: [packages/app/src/renderer/store.ts, packages/app/src/renderer/sessionCache.ts, packages/app/src/renderer/main.tsx]
verified_by: [packages/app/test/runForm.test.ts, packages/app/test/sessionCache.test.ts]
siblings: [engineering/units/live-turns, engineering/units/drafts, engineering/units/ui-layout-state, engineering/units/address-trail, engineering/units/ipc-bridge]
---

# Renderer store

## The store holds the window's copy of everything main serves, and refetches it when a push says it changed

`store.ts` exports one hook, `useApp()`, called once in `App.tsx`, which passes `state` and `actions` down as props. It is neither a context nor a state library:

- One `useState<AppState>` with a ref mirror written inside `patch`, so an action that patches and refreshes in the same tick reads its own patch.
- Every action is built once in a `useMemo` and reached through `actionsRef`.
- `invoke(channel, request)` and `subscribe(listener)` wrap `window.jaira`; `invoke` throws `the JaiRA bridge is unavailable (preload did not run)` when the preload is absent.
- `AppState` holds the address in `view`, `at`, `selected`, `selectedProject`, `stateId` and `trail`; a local copy of each projection main serves, the inbox lists, the selected task's `sessions` cache and `liveTurn`, `producing` per task, `settings`, `drafts`, `logs` and `error`.
- `sessionCache.ts` keys the session cache by the durable instance id through `sessionKey`, and `withoutSession` drops one entry.
- `main.tsx` mounts `App` inside `CrashBoundary`, with `LooseErrorBanner` outside it.

It deliberately does not own:

- The channels and push types: [preload-bridge](../contracts/preload-bridge.md), [ipc-channels](../contracts/ipc-channels.md) and [push-messages](../contracts/push-messages.md).
- Folding a live turn and the merge rules with its snapshot: [live-turns](live-turns.md).
- The rules for unsaved edits, remembered layout and the run path: [drafts](drafts.md), [ui-layout-state](ui-layout-state.md), [address-trail](address-trail.md).
- Validating a person's answer, which main does again: [interaction-gateway](interaction-gateway.md).
- Every call made outside it. `chatPane.tsx`, `runViews.tsx`, `components.tsx`, `fileSurfaces.tsx`, `valueView.tsx`, `schemaForm/check.ts`, `reviewNotes.tsx` and `pointerMenu.tsx` call `invoke` directly, chat sends and cancels among them, and `pointerMenu.tsx` subscribes to `frame:contextMenu` itself.
- The board's multi-select set and the run view's mode and focus, which `App.tsx` holds.

## The store is the renderer's side of the one trust boundary, and reaches main only through the bridge

- Layer `ui`. It imports `@jaira/shared/browser` types and the renderer's pure modules.
- Boundary: renderer and main. Nothing the store holds is trusted by main; a gate answer it sends is re-validated there.
- No upstream seam.
- `refreshAll` runs at mount: settings, tree, config, availability, projects, shared tasks and workflows always, and only when `project:current` answers a project, tasks, board, the four inbox lists, history, detail, state and every conversation.

## Main is the truth for every projection, and the store is the truth only for where the window stands

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| Projections: `tasks`, `boards`, `detail`, `conversation`, `session`, `state`, `tree`, `config`, inbox lists | replaced wholesale by each refresh | main | none |
| Address: `view`, `at`, `selected`, `selectedProject`, `stateId`, `inspect` | written by navigation actions | the renderer | [address-trail](address-trail.md) |
| `sessions` | filled per instance on demand; cleared on selection change, task delete and `run:finished` for the selected task; one entry dropped when its operation settles | main's session view | none |
| `producing` | depth per task from `operation.started` and its settle, deleted on `run:finished` | the journal's push stream | the conversation list's spinner |
| `settings` | patched locally then written through `settings:write`; the response keeps the window's `ui` | `<base>/user-settings.json`, except `ui` after hydration | [user-settings](user-settings.md), [ui-layout-state](ui-layout-state.md) |
| `stream`, `logs`, `sync.progress` | appended from pushes and capped | main's journal and log | none |
| `error` | set by `fail(e)` with the raw message; cleared by the next action or a click | the renderer | the error notice |

## The invariants route every read to the right project and never re-render for nothing

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A shared-root state runs and reads its history in the shared root's own project, with or without a checkout open | `runForm.test.ts` "sends a shared-root state to the root's own project, not JaiRA's", "sends it there with no project open at all — that is the point", "reads a shared state's runs from the shared project, checkout or not" |
| 2 | A project state reads from the open checkout, and has nowhere to run with nothing open | `runForm.test.ts` "reads a checkout's runs from the checkout, by naming nothing", "has nowhere to send a project state with nothing open" |
| 3 | A cached session is filed under its durable instance id, dropped by that id, and dropping an absent entry returns the same map | `sessionCache.test.ts` "is the durable instance id — unique for the task's whole life", "drops the entry filed under the instance", "returns the same object when it held nothing, so nothing re-renders" |
| 4 | An invalidation stamped with another project is ignored, except that `tasks` refreshes the project list, shared tasks and conversations, `board` refreshes the project list while the Tasks view shows, and `task` refreshes the selected task of that project | unasserted |
| 5 | `producing` never goes below zero | unasserted |
| 6 | A settled operation drops that instance's cached session and the live tail | unasserted |
| 7 | `ref.current` equals the latest patch within the same tick | unasserted |

## Races resolve to the last response, and most read failures show an empty panel rather than an error

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two reads of one slice overlap, as after a quick change of selection | the last response wins; `refreshDetail` and `refreshConversation` do not re-check the selection after their await | the next invalidate or selection | the previous task's detail or transcript under the new selection |
| Two `settings:write` calls on different blocks overlap | each response replaces every block but `ui` | the later response lands | a control flickers |
| A preference write fails | the local patch stays and the error is shown | none | the change holds until restart, with the error notice |
| A read fails | most refreshes swallow it and set the slice to empty or null | the next push or navigation | an empty panel |
| A batch delete, rerun or cancel fails part way | the loop stops at the failure with earlier items applied and no refresh on that path | pushes from main | the error notice; lists catch up as pushes arrive |
| A failed batch rerun is retried | every task rerun before the failure is rerun again | delete the extra tasks | duplicate reruns |
| The renderer is killed | memory only; drafts, run form values and layout within the write delay are lost | none | a fresh window loads everything |
| No project is open at startup | inbox lists and conversations are not read, although shared-root runs can park gates | a push or a navigation | a parked gate stays unseen until then |
| A write naming no project reaches main with two or more projects open | main refuses with `several projects are open, so this call must name one`; `createTask`, `runState` without a project, `planPrune`, `applyPrune` and `runSync` send none | none | the error notice |
| A push is missed | no push is replayed | the next push or navigation refetches | stale lists until then |

## Every budget is a constant at the top of `store.ts`

- `STREAM_LIMIT` 300 engine lines, `LOG_LIMIT` 5000 log entries, `LOG_PAGE` 200 entries per page, `SYNC_PROGRESS_LIMIT` 60 sync lines.
- `UI_WRITE_DELAY` 400 ms between a layout gesture and its write.
- `sessions` has no cap.

## The store departs from a keyed request client in three ways

- Pushes carry no data and every refetch is whole, so a missed push costs freshness and never correctness of what is later fetched.
- There are no request sequence numbers. Specific actions guard late answers themselves: `seedTrail`, `openTask` and `loadSessions` re-check the selection, `loadOlderLogs` checks `logsLoading`, and the live tail uses `alreadyFolded` and `tailIsAhead`.
- A `board` invalidation rebuilds every project's board only while the Tasks view is on screen, because it fires once per journal entry and costs a fetch per project.
