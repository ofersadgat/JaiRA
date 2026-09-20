---
id: engineering/units/project-sessions
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/all-projects-in-one-place, product/pick-up-where-it-left-off, product/share-processes-across-projects, product/catch-process-mistakes-before-running, ui/components/project-row]
layer: service
owns_contracts: []
requires: [engineering/units/project-store, engineering/units/project-layout, engineering/units/module-approvals, engineering/units/interaction-gateway, engineering/units/interaction-hub, engineering/units/task-lifecycle, engineering/units/native-session-capture, engineering/units/user-settings, engineering/units/agent-executors, engineering/units/app-log]
implemented_by: [packages/app/src/main/service.ts, packages/app/src/main/session.ts]
verified_by: [packages/app/test/service.test.ts, packages/app/test/settings.test.ts, packages/app/test/maintenance.test.ts, packages/app/test/gateDurability.test.ts]
siblings: [engineering/units/view-addressing, engineering/units/project-store, engineering/units/app-shell, engineering/units/interaction-gateway]
---

# Project sessions

## The unit decides which projects are open in this process, in what order they open and close, and what each holds while it is open

`AppService` keeps `sessions`, a map from `sessionKey(dir)` to a `ProjectSession` from `session.ts`. A session is one open project and everything the process holds for it: its `Project` handle, its runs in `live`, its typed turns in `chatTurns`, its calls in `liveCalls`, its tails in `liveTurns`, its four hubs, its gate vocabulary in `interactive`, its request maps `requestTask` and `subjectProject`, its scripted rules in `fakeRules`, its workflow watchers and its sync state. `kind` is `user` for a checkout and `shared` for the base root.

The unit owns:

- `open(dir)`, `init(dir)`, `inspect(dir)`, `chooseProject(mode)`, `current()` and `restore()`, behind `project:open`, `project:init`, `project:inspect`, `project:choose` and `project:current`.
- The shared session, opened by `roleSession("shared")` the first time something needs it.
- `remember(dir)`, which appends an opened directory to `projects` in `user-settings.json` unless its key is already there.
- The workflow watchers, which push `store:invalidate` with scope `workflows` after a change settles.
- The order of `close()`, `closeSession(key)` and `ProjectSession.close()`.

It deliberately does not own:

- Opening a database, recovery at open and migrations, in `openProject`, `openSharedProject` and `initProject`: [project-store](project-store.md).
- Which session a request resolves to, and the reads that fall back to the shared root: [view-addressing](view-addressing.md).
- Building the hubs and what closing does to a parked gate, approval, question or wait: [interaction-gateway](interaction-gateway.md).
- What resuming a suspended task does: [task-lifecycle](task-lifecycle.md). Folding a crashed call's transcript: [native-session-capture](native-session-capture.md).
- Compiling js/ts modules in `prepareUserModules`: [module-approvals](module-approvals.md). The availability checks an open starts: [agent-executors](agent-executors.md).
- The preferences file's format and write rules: [user-settings](user-settings.md).

## The unit is main-process service code that sequences the project stores and the run machinery

- Layer `service`, `packages/app/src/main`. It calls `@jaira/persistence` to open, recover and close projects, `sessionKey` and `jairaBasePaths` from [project-layout](project-layout.md), and the service's own run, hub, capture and availability methods.
- Boundary: renderer and main, through the `project:*` channels in [ipc-channels](../contracts/ipc-channels.md), and the app shell's startup and quit in [app-shell](app-shell.md).
- Upstream seam: none of its own.

An open runs in this order:

1. Return the existing session, with `recovered: []`, when the key is already open.
2. `openProject(dir, {baseDir})`, then `await prepareUserModules(paths, {searchPath})`.
3. Build the session with `hubsFor(key)`, add it to the map, and log `opened <dir>` under source `project`, with the recovered task ids in `detail`.
4. Watch the project's and the base root's `workflows/` directories, unless `watchWorkflows` is `false`.
5. When recovery found interrupted tasks, push `store:invalidate` with scope `tasks` and start `recoverNativeSessions` without awaiting it.
6. Start `resumeSuspended` and keep its promise as `session.resuming`.
7. Start an availability refresh when `probeOnStart` is set, then `remember` the directory.

A close runs in this order:

1. `close()` sets `closed`, hands back the log sink and level policy it still owns, closes every user session in open order, then the shared one, then calls `resetUserModules()` and closes the type-check worker and the MCP bridge host.
2. `closeSession(key)` logs `closing <dir>`, removes the session from the map and its request ids from `requestOwner`, and awaits `resuming`.
3. `ProjectSession.close()` clears the watchers, records in `suspendedAtClose` each live task parked on a gate or a wait, settles the hubs, drops the sync state, aborts typed turns, aborts every live run and awaits each run's `done`, and closes the database.

`restore()` walks `projects` in order. A directory that is not a project is forgotten when its parent exists and kept with the warning `<dir> is not reachable, so it stays in the list rather than being forgotten` when it does not. An open that throws is logged `could not re-open <dir>: <message>` and kept. It logs `restored N project(s)` or `no projects were remembered from the last session`, and rewrites `projects` without the forgotten ones.

## The session map is memory, and the only durable fact the unit writes is the remembered list

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `AppService.sessions`, keyed by `sessionKey`, which is the real path, lower-cased on Windows | added by `open` and `roleSession`, removed by `closeSession` | process memory | every request resolves through it, as [view-addressing](view-addressing.md) describes |
| A session's run state: `live`, `chatTurns`, `chatDone`, `liveCalls`, `liveTurns`, `liveFlush`, `fakeRules` | created empty at open, aborted and dropped at close | process memory | [task-lifecycle](task-lifecycle.md), [chat-turns](chat-turns.md), [live-turns](live-turns.md) |
| A session's hubs, `requestTask`, `subjectProject`, `interactive` | created at open, settled at close | process memory | [interaction-gateway](interaction-gateway.md) |
| `projects` in `user-settings.json` | read by `restore`; appended by `remember`; rewritten by `restore` when it forgets | the file | [user-settings](user-settings.md) |
| Each project's database handle | opened through `openProject` or `openSharedProject`, closed last in `ProjectSession.close` | the database | [project-store](project-store.md) |
| `watchers` and `watchTimer` | created at open for the project's and the base root's `workflows/`, closed at close | process memory | none |
| `suspendedAtClose` and `resuming` | filled at the top of a close; set at open | process memory | the run-end handler in [task-lifecycle](task-lifecycle.md) reads `suspendedAtClose` to write `SUSPENDED_WAITING` |
| `roleError.shared` and `closed` | each set once | process memory | none |

## The invariants keep one session per directory and never lose a project, a gate or a database handle to a close

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | Opening a second project adds a session, and the first stays open with its tasks | `service.test.ts` "opens another project ALONGSIDE the first, and refuses to guess between them" |
| 2 | Two spellings of one directory open one session | `service.test.ts` "re-opening the same directory under another spelling does not open it twice" |
| 3 | Constructing a service opens no shared database | `service.test.ts` "is not opened merely by constructing a service" |
| 4 | Opening a user project leaves an open shared session open | `service.test.ts` "survives switching the open project, because it is machine-global" |
| 5 | Two services with different base roots share no session, and a root's tasks are not listed from another root | `service.test.ts` "keeps two services with different base roots out of each other's state", "leaves a root's tasks behind when the root is repointed" |
| 6 | A close leaves no project open, does not throw, and can be repeated | `service.test.ts` "closes everything, and says so rather than throwing" |
| 7 | After a close no gate is pending in this process | `service.test.ts` "closing the project releases parked gates" |
| 8 | Projects are remembered in the order they open, re-opening one changes nothing, and a restore opens them in that order with the last as `current` | `settings.test.ts` "records a project as it opens, in the order they were opened", "re-opens them on the next start, in the order they were opened" |
| 9 | A restore forgets a directory that is no longer a project when its parent exists, and keeps one whose parent is missing | `settings.test.ts` "forgets a remembered directory that is no longer a project", "keeps a project whose whole filesystem is missing, rather than forgetting a drive that is offline" |
| 10 | Remembering a project changes no other preference | `settings.test.ts` "leaves the rest of the preferences alone" |
| 11 | `init` lays out and opens a new directory, and on an existing project keeps its `settings.json` | `settings.test.ts` "sets up a directory that is not yet a project, and opens it", "treats init on an existing project as an open, keeping its config" |
| 12 | `inspect` creates and opens nothing | `settings.test.ts` "reports what a directory is without opening or creating anything" |
| 13 | `chooseProject` answers null with no dialog to show, and passes the wording of the action it serves | `settings.test.ts` "answers null from the directory picker when there is no dialog to show", "passes the picker wording that matches what is about to happen" |
| 14 | A state file written while the project is open is in the next browse, whether or not a watcher could run | `maintenance.test.ts` "pushes a workflows invalidation when a state file changes on disk" |
| 15 | A task that was waiting on a person when the app closed is recorded as suspended, and the next open runs it again and parks the same question | `gateDurability.test.ts` "records WHY the close ended the run, so the open knows to resume it", "is being asked again when the app opens, by a run that is running again" |
| 16 | Opening a project is logged with its directory | `service.test.ts` "records opening a project, which is where a recovery would be reported" |
| 17 | A close closes no database while a run of that session has not settled | unasserted |
| 18 | The shared session is never opened after `close()`, and a failed open of it is not tried again | unasserted |

## The failure modes are races around the await in an open, and each leaves the app usable

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two opens of one directory run together | both pass the existing-session check before `prepareUserModules` resolves; `openProject` runs twice, the second session replaces the first in the map, and the first handle and its watchers are never closed | restart the app | none visible |
| `prepareUserModules` throws | the handle `openProject` returned is not closed, no session is added, and the call rejects | restart the app | an error notice; the database stays held |
| An open arrives after `close()` | `open` does not check `closed`, so it opens a database nothing will close | none | none visible |
| The shared root cannot open | the message is kept in `roleError` and logged `the shared project could not be opened: <message>` with the stack; no later read tries again | fix the cause and restart | no shared group, and the error in Logs |
| A remembered project fails to open at startup | logged `could not re-open <dir>: <message>` and kept in the list | fix the cause and reopen it | the project is not open |
| The process is killed during an open or a close | nothing of the session survives; `projects` holds only directories whose open succeeded; the next open's recovery marks running tasks `interrupted` | resume those tasks | tasks read interrupted |
| A close begins while the open's resumes run | `closeSession` removes the session first, so `resumeSuspended` starts no further task, and the close awaits the one in progress before aborting it | none needed | the task resumes at the next open |
| Two processes open one project | each holds its own session and database handle, and nothing here coordinates them; which process may run a task is [process-claims](process-claims.md) | none needed | none |

## The one budget is the watcher debounce

- 150 ms between the last change under a `workflows/` directory and the push, `watchDebounceMs` in `AppServiceOptions`.

## The unit departs from open-then-ready by starting background work it does not wait for

- An open does not wait for suspended tasks to resume or for native transcripts to be folded, because the window should not wait on either; the close does wait for the resumes, because a resume that started after the close began would run without a session.
- The shared session opens on first use, once per process and never after `close()`, because constructing a service must not create a database and a failing open must not be paid again on every read.
