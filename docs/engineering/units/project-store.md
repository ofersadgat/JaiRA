---
id: engineering/units/project-store
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/pick-up-where-it-left-off, product/share-processes-across-projects, product/run-history-travels-with-the-repository, ux/patterns/refuse-with-the-reason-and-the-fix]
layer: data
owns_contracts: [engineering/contracts/sqlite-schema]
requires: [engineering/units/storage-policy, engineering/units/event-journal, engineering/units/operation-record-store, engineering/units/task-lifecycle, engineering/units/process-claims, engineering/units/project-layout, engineering/units/project-config]
implemented_by: [packages/persistence/src/project.ts, packages/persistence/src/db.ts, packages/persistence/src/migrations.ts, packages/persistence/src/nativeBinding.ts]
verified_by: [packages/persistence/test/lifecycle.test.ts, packages/persistence/test/systemProject.test.ts, packages/persistence/test/nativeBinding.test.ts, packages/persistence/test/jobs.test.ts, packages/persistence/test/sessionStore.test.ts, packages/persistence/test/rowFile.test.ts]
siblings: [engineering/units/storage-policy, engineering/units/process-claims, engineering/units/project-layout, engineering/units/module-approvals]
---

# Project store

## The project store turns a directory into an open `Project`, and leaves what each store writes to the stores

`openProject(dir, {baseDir})` in `project.ts` refuses a directory with no `.jaira/`, creates the shared root's layout with `initBase`, loads the layered config with `loadLayeredConfig` and hands both to `openAt`. `openSharedProject` opens the shared root itself as a `Project` of `kind: "shared"`, parsing its `settings.json` alone because no layer sits behind it. `openAt` then runs, in this order:

1. It creates `system/snapshots` and `system/tasks`, so a deleted or never-cloned `system/` is regenerated rather than refused.
2. It opens `system/jaira.db` with `openDb`.
3. It calls `applyStorage` before any store exists, so a file-backed concern's statements are prepared against its shadow table.
4. It builds every store on that one connection, handing the journal, task and artifact stores a file log only when their concern is file-backed.
5. It reads `jobs.orphans`, lets `runtime.recoverInterrupted` mark every `running` task with no live run claim `interrupted`, then calls `jobs.reapStale`.

`openDb` in `db.ts` loads the `better-sqlite3` addon cached for this runtime's ABI under `build/abi/<abi>/` when there is one, sets `journal_mode = WAL` and `foreign_keys = ON`, runs the bootstrap `SCHEMA`, runs `migrate`, and drops the `events` and `runs` shells the bootstrap recreates when they are empty. `migrate` in `migrations.ts` applies `MIGRATIONS` in order, each step in its own IMMEDIATE transaction that re-reads `PRAGMA user_version` before acting. `initProject` creates the project layout, writes `settings.json` from `defaultConfig()` when it is absent, and writes the `.gitignore` template or appends the `system/machine.key` line to an existing ignore file that lacks it. `sessionStoreFor(project, scope)` is the only constructor that gives a session store its conversation file log.

It deliberately does not own:

- What each store writes: [event-journal](event-journal.md), [operation-record-store](operation-record-store.md), and [task-lifecycle](task-lifecycle.md) for the task row and `recoverInterrupted`.
- Run claims, orphans and reaping: [process-claims](process-claims.md).
- Shadow tables, replay and the file formats: [storage-policy](storage-policy.md).
- Paths and the ignore list's place in the layout: [project-layout](project-layout.md) and [jaira-layout](../contracts/jaira-layout.md). Parsing and merging `settings.json`: [project-config](project-config.md).
- The shared root's `module_approvals` rows, which `approvalsIn` in [module-approvals](module-approvals.md) reads through its own `openDb`.

## The store is the data layer's entry point, and every host opens a project through it

- Layer `data`, package `@jaira/persistence`. It calls `@jaira/shared` for paths, `parseConfig`, `mergeConfigDocuments` and `refusal`, then `applyStorage`, the replay sources and every store constructor.
- No upstream seam. The engine reaches the stores it builds, never the open.
- The app opens one `Project` per open directory through `openProject` and the shared root through `openSharedProject`. The CLI opens through `openWithRecoveryNote`, which prints `recovered N interrupted task(s)` and a `process left running by a previous session` warning per orphan.
- Boundary: derived and committed. The `.gitignore` it writes names the line: `system/jaira.db` with its `-wal` and `-shm` files, `system/logs/`, `system/machine.key`, `system/approvals.local.json` and `.env.local` stay out, and everything else under `system/` is meant to be committed.

## The database is the truth for the schema, and each open computes what it recovered

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `.jaira/workflows/`, `skills/`, `system/snapshots/`, `system/tasks/` | created by `initProject`; the two `system/` directories re-created by every open | the filesystem | the app's project init |
| Shared root `workflows/`, `functions/`, `skills/`, `system/snapshots/`, `system/tasks/` | created by `initBase` on every open of any project | the filesystem | none |
| `.jaira/settings.json` initial document | written once by `initProject` as the whole of `defaultConfig()` | the file | Settings, hand edits |
| `<layer>/.gitignore` | written when absent; `system/machine.key` appended when the file names neither it nor `system/` | the file | the person |
| `system/jaira.db` schema and `PRAGMA user_version` | bootstrap and migrations on every open | the database, see [sqlite-schema](../contracts/sqlite-schema.md) | every store |
| `Project.recovered`, `Project.orphans`, `Project.storage` | computed per open | `task_runtime` and `jobs` rows; the `ShadowReport` | the CLI prints the first two; the app recovers native sessions for `recovered` |

## The invariants keep a project openable and its recovery honest

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A directory with no `.jaira/` is refused with a message naming `jaira init` | `lifecycle.test.ts` "initProject creates the .jaira layout with a default config, idempotently" |
| 2 | Running `initProject` on an initialised project succeeds and leaves the layout whole | `lifecycle.test.ts` "initProject creates the .jaira layout with a default config, idempotently" |
| 3 | `initProject` never overwrites an existing `settings.json` | unasserted |
| 4 | A missing `system/` is regenerated on open rather than failing it | `lifecycle.test.ts` "regenerates a missing system/ on open" |
| 5 | A database at an older `user_version` opens at the current version with its conversations still readable | `sessionStore.test.ts` "normalises an old turn store into records plus positions, keeping every conversation readable", "moves a position onto the record's own key, and renumbers attempts so that key is one" |
| 6 | Two processes migrating one database apply each step once | unasserted |
| 7 | A `running` task with a live run claim is never recovered, and one with a stale claim or no claim is marked `interrupted` | `jobs.test.ts` "does NOT interrupt a task another live process is driving", "interrupts a task whose owner stopped breathing", `"interrupts a task with no claim at all — the pre-jobs case still works"` |
| 8 | An orphaned child process is reported in `Project.orphans` before it is reaped | `jobs.test.ts` "surfaces a child abandoned by a dead owner as an orphan" |
| 9 | A store never reads a file-backed concern from `main`, because `applyStorage` runs before any store is built | `rowFile.test.ts` "survives the database being thrown away, the machine's outcome included" |
| 10 | The ignore template hides the database and logs and nothing else in `system/`, and the machine key is ignored however the root was created | `rowFile.test.ts` "ignores the database and the logs, and nothing else"; `systemProject.test.ts` "keeps the machine key out of every repository, however the root was created", "adds the key to an ignore file written before the key existed", "leaves an ignore file alone when the key is already covered" |
| 11 | The shared root searches only itself, parses its config without layering it over itself, and generates only under `system/` | `systemProject.test.ts` `"searches only itself — there is no layer behind the layer"`, "reads its own config without laying it over itself", "puts everything it generates under system/, and nothing else there" |
| 12 | An ABI mismatch becomes a `Refusal` naming the command that fixes it, and every other open failure passes through unchanged | `nativeBinding.test.ts` "turns the loader's two version numbers into the command that fixes them", "stays out of the way of every other failure" |

## Every open failure stops the project from opening, and every half-finished open is finished by the next one

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Either `settings.json` layer is malformed, half-written or holds a refused field | `readJsonFile` or `parseConfig` throws out of the open | fix the named field and reopen | the project does not open; the error names `config.<field>` |
| No addon is built for this runtime's ABI | `openDb` throws a `Refusal` carrying the loader's message and the advice | run `npm run abi` | the open error names the command |
| Two processes open one database at once | each migration step takes the write lock, so the second waits and skips a step whose version it re-reads as applied; a lock held past `better-sqlite3`'s busy timeout throws `database is locked` | reopen | the second open fails only when the lock outlasts the timeout |
| The process is killed during a migration | the step's transaction never commits and the database stays at the last whole version; rebuild steps check the table's shape, never the version | the next open re-runs the step | none |
| A migration step throws | the step rolls back and the error leaves `openDb` | fix the cause and reopen | the project does not open |
| The process is killed between the recovery transaction and the task row line under `storage.tasks: file` | the change dies with the connection and the file still says `running` | the next open recovers the task again | the task reads `interrupted` after that open |
| The same project is opened again, by a second window or a retry | layout creation, `initBase`, migrations and recovery are idempotent; a task another process claimed within the stale window is left `running` | none needed | none |
| A setting in the shared root's `settings.json` that `defaultConfig()` also states, such as `storage.*`, `memo.enabled`, `artifacts.*`, `artifactDir` or `execEnvironment` | `initProject` wrote the default into the project file, and the project layer wins the merge | delete the key from the project's `settings.json` | the shared value silently never applies to a project created by `init` |

## Migrations only append, the older build cannot read a newer database, and nothing rolls back

- `MIGRATIONS` holds 17 steps. Step 7 is kept as a no-op because databases recorded running it. Steps 8, 12, 13, 14 and 16 rebuild or fold stored data; the shape each left is in [sqlite-schema](../contracts/sqlite-schema.md).
- A step is idempotent where SQLite allows it: `addColumn` checks `PRAGMA table_info`, and every rebuild returns early when the table already has its new shape.
- There are no down-migrations. An older build runs no step against a higher `user_version`, and its queries then fail on the dropped `runs`, `run_id` and `session_positions`.
- The bootstrap `SCHEMA` still creates `events` and `runs`, so a fresh database walks the same steps an old one did; `openDb` drops each only while it is empty.

## Budgets are the claim staleness window and nothing else

- A run claim whose heartbeat is older than 30 s is recovered at open: `DEFAULT_STALE_MS` in `jobs.ts`, overridable through the `staleMs` option of `openProject` and `openSharedProject`.

## The ignore template commits snapshots and artifacts, which architecture.md lists as derived

- Everything under `system/` except the database, logs, machine key and legacy approvals file is left committable, because once a concern's truth is a mergeable JSONL file nothing derived is left to hide.
