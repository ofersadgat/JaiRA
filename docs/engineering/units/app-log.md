---
id: engineering/units/app-log
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/find-out-why-the-app-misbehaves, product/failures-explain-themselves, ui/surfaces/logs-view, ux/patterns/filter-in-place]
layer: service
owns_contracts: []
requires: [engineering/units/user-settings, engineering/units/project-layout, engineering/units/project-sessions, engineering/units/process-claims]
implemented_by: [packages/app/src/main/diagnostics.ts, packages/app/src/main/service.ts]
verified_by: [packages/app/test/diagnostics.test.ts, packages/app/test/service.test.ts]
siblings: [engineering/units/process-claims, engineering/units/user-settings, engineering/units/app-shell]
---

# App log

## The log keeps every entry its policy admits, pushes each one live, mirrors it to a file per day, and reads the files back newest first

`Diagnostics` in `diagnostics.ts` is the store, and `AppService` in `service.ts` is every way into it:

- `log(entry)` gates the entry, gives it an `id` from a counter and an `at`, keeps it in a ring, publishes it as `log:entry`, and appends it as one JSON line to `<base>/system/logs/jaira-<UTC day>.log`. It never throws.
- `read(query)` answers `log:list` with a `LogPage`, from the files when the directory exists and from the ring otherwise.
- `AppService` files entries through `log`, `refusal` at `warn`, `recordIpcFailure` at `error` under `ipc`, `recordCrash` at `error` under `crash`, `recordWarning` at `warn` under `runtime`, and `recordApp` under `app`.
- `traceRun` narrates a run from its journal: `instance.entered` at `debug` as `entered <state> (<childKey>)`, `instance.blocked` at `warn` as `could not enter <state> (<childKey>): <reason>`, `operation.failed` at `warn` as `<op> failed in <state>: <reason>` with its classification, and `call.waiting` at `debug` as `waiting on someone in <state>`.
- The constructor installs the service's sink and level policy on `@declarative-ai/log`, so every library record arrives as an entry: its scope becomes `source`, the `taskId`, `instanceId` and `project` strings and the `jobId` number in its fields become pointers when their types match, and the rest of its fields and its `err` become `detail`. `close()` hands each back only while this service still holds it.
- `listJobs` and `jobOutput` answer `job:list` and `job:output` for the Logs view, from the session a request names or the only open one, and answer empty when none resolves.

An entry is kept when it is an `error`. Otherwise the rule that applies is a `tag` override whose key equals `detail.tag`, else the longest `scope` override that is the source or a dot-path ancestor of it, else the floor `minLevel`; the entry is kept at or above that level, and a `samplingRate` below 1 keeps that fraction. `applyLogPolicy` reads `logging` from `user-settings.json` and installs it in `Diagnostics`, in `setMinLevel` and in `setLevelPolicy`; `writeSettings` calls it again whenever a write carries `logging`.

A read clamps `limit` to 1 through 1000, 200 by default. It walks the day files newest first, each backwards in chunks, skipping lines that do not parse, and applies the filters while it scans: `level` as this level and worse, `source` exactly or as a dot-path ancestor, `project` exactly, and `text` as a case-blind substring of the message, the source or the JSON of `detail`. A read-back entry's `id` is the byte offset its line starts at. It stops with `cursor` `<file name>:<offset>` when the page is full or its scan budget is spent, and with no cursor when the oldest file runs out.

It deliberately does not own:

- What each producer says, or when: every unit that logs owns its messages. The `process` entries around each child process are written by the run's exec observer in [task-lifecycle](task-lifecycle.md).
- The job and output rows `job:list` and `job:output` read: [process-claims](process-claims.md).
- Declining and the refusal classes: [refusal-errors](../contracts/refusal-errors.md).
- Where `logging` is stored and how the preferences file is written: [user-settings](user-settings.md), in the shape [user-settings-json](../contracts/user-settings-json.md) gives.
- The shapes of `log:list`, `job:list` and `job:output`: [ipc-channels](../contracts/ipc-channels.md). The `log:entry` push: [push-messages](../contracts/push-messages.md).
- The upstream gate that drops a library record before the sink sees it: `@declarative-ai/log`.
- How the Logs view folds pushes into pages: [renderer-store](renderer-store.md).

## The log is main-process service code below every other unit, and it is kept out of every database

- Layer `service`, `packages/app/src/main`. It calls `node:fs` for the files, `jairaBasePaths` from [project-layout](project-layout.md) for the directory, and the session's `jobs` and `jobOutput` from `@jaira/persistence`.
- Upstream seam: `setLogSink`, `resetLogSink`, `setMinLevel`, `setLevelPolicy` and `resetLevelPolicy` in `@declarative-ai/log` `logger.ts`, all process-global.
- Boundary: renderer and main, through `log:list`, `job:list`, `job:output` and the `log:entry` push.
- Every other unit may call it, and it calls none of them back.

## The day files are the truth, and the ring only stands in when there are none

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `<base>/system/logs/jaira-<UTC day>.log`, one `LogEntry` per line | appended once per kept entry; read backwards by `log:list`; nothing in the app deletes them | the files, across every launch against that base root | people read and grep them |
| The ring, the last 2000 kept entries | written by `log`; read by `read` when there is no directory or the files fail to read | process memory | none |
| `LogEntry.project` | set by each producer | the session key: the real path, lower-cased on Windows, not the directory the renderer holds | `LogQuery.project` must equal it |
| The installed sink and level policy | set in the constructor and by `applyLogPolicy`; reset by `close` | module variables `installed` and `installedPolicy` in `service.ts` | `@declarative-ai/log` calls them |
| `logging` in `user-settings.json` | read by `applyLogPolicy` | the file | [user-settings](user-settings.md) |

## The invariants keep an error from ever being lost and keep paging exact

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A page is newest first, spans every day in the mirror, and includes what this launch just wrote | `diagnostics.test.ts` "reads back NEWEST FIRST, which is the end a log is read from", "spans the launches BEFORE this one, oldest day last", "reads what THIS launch just wrote, without waiting for a restart" |
| 2 | Filters apply while scanning: a level is itself and worse, a source matches its dot-path family, and text is searched in the detail too | `diagnostics.test.ts` "filters by level as 'this and worse', not 'this exactly'", "matches a source as a family, not only as a word", "searches the DETAIL as well as the message, which is where a file name lives", "filters where the entries ARE, so a search reaches the past" |
| 3 | Paging by cursor neither repeats nor skips an entry, across a day boundary or a chunk seam, and only the last page has no cursor | `diagnostics.test.ts` "pages backwards through the cursor, and says when there is no more", "pages across a day boundary without repeating or skipping an entry", "walks a file bigger than one chunk without losing an entry at the seam" |
| 4 | A half-written line and a file that is not a day of the mirror are skipped, and `detail` survives the read | `diagnostics.test.ts` "survives the half-written last line a crash leaves behind", "ignores anything in the directory that is not a day of the mirror", "keeps the detail, which is the half worth reading back" |
| 5 | Every kept entry is published, and a listener that throws neither escapes `log` nor loses the entry | `diagnostics.test.ts` "publishes each entry, which is how the renderer hears without polling", "never throws, because its callers are catch blocks" |
| 6 | Every kept entry is appended to its UTC day's file, and a directory that cannot be written is reported once | `diagnostics.test.ts` "mirrors to NDJSON, which survives a crash and greps without the app", "says so once when the file cannot be written, rather than failing every entry" |
| 7 | An entry below its rule is dropped before it is written; a scope rule can loosen or tighten the floor, the longest scope wins, a tag beats a scope, and a new policy governs the next entry | `diagnostics.test.ts` "drops below the floor, before anything is written", "lets a scope disagree with the floor, in both directions", "gives the longest matching scope the last word", "lets a tag beat a scope, being the more specific statement", "changes what is kept without a restart, which is the whole point of the control" |
| 8 | An error is never dropped, and a sampled scope keeps a fraction of the rest | `diagnostics.test.ts` "NEVER drops an error, whatever the policy says", "samples a chatty scope, keeping the shape without the flood" |
| 9 | A library record is filed under its scope, with a pointer lifted only when its type matches | `service.test.ts` "carries a LIBRARY's refusal into the panel, under the scope it came from", "carries the task pointer across, so a library's row is actionable", "refuses to promote a pointer that is not what its type promises" |
| 10 | A closed service leaves the sink of a service built after it in place | `service.test.ts` "hands the log back when it closes, so a later service is not written over" |
| 11 | A run's trace files each state it entered at `debug` with its instance pointer | `service.test.ts` "traces a run's MIDDLE, not just that it started and stopped" |
| 12 | Every `process` entry names its task | `service.test.ts` "records a child process against the task that started it" |
| 13 | `job:list` and `job:output` answer empty rather than throwing when nothing has run | `service.test.ts` "returns no jobs and no output rather than throwing when nothing has run" |

## Every failure degrades to fewer or older entries, and none of them throws into a caller

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The log directory cannot be written | entries stay in the ring and are still published; one `warn` says `the diagnostics log file could not be written; entries are in memory only` | free the disk or fix the permissions | the Logs view shows this launch only |
| The process is killed mid-append | the last line is partial; every read skips it | none needed | that one entry is missing |
| Reading the files throws | `read` answers from the ring | none needed | the Logs view shows this launch only |
| A filter matches little | a read stops after its scan budget with the entries it found and a cursor, possibly none | the view asks again as it scrolls | an empty or short page that keeps loading |
| Two processes use one base root | both append to the same day's file, one `appendFileSync` per entry | none needed | both launches' entries interleave |
| Two services live in one process | the one constructed last holds the sink and the policy, and library records reach only it | close the later one | the earlier service's log lacks library records |
| An entry is pushed live and later read back | the push carries the counter `id` and the read carries the byte offset, so the same entry has two ids | key an entry by more than `id` | none |
| A `tag` override admits more than the scope rule or floor would | the library passes the record, but its sink leaves `tag` out of the entry, so `Diagnostics` applies the scope rule or floor and drops it | write the rule as a `scope` override | those entries never appear |
| A `scope` override samples a library scope | the library samples at the rate and `Diagnostics` samples the survivors again | none | about the square of the rate is kept |
| `job:list` or `job:output` names no project while several are open | answers empty | open the output with only its project open | an empty output, as [process-claims](process-claims.md) describes |

## The budgets are constants in `diagnostics.ts`

- `RING` 2000 entries kept in memory.
- `CHUNK` 128 KiB read per step of a backwards scan.
- `SCAN_LIMIT` 8 MiB read per page before a cursor is handed back.
- `PAGE` 200 entries by default, with `limit` clamped to 1 through 1000.

## The log departs from the stores around it by living outside the database and gating before it writes

- Entries are kept in memory and in day files rather than in a project database, because an entry about a project that could not be opened has no database to go in.
- Entries are dropped by the policy before they are written rather than filtered when read, so a policy change governs the next entry and nothing already dropped can be recovered.
