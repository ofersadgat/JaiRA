---
id: engineering/units/process-claims
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/pick-up-where-it-left-off, product/failures-explain-themselves, product/find-out-why-the-app-misbehaves, ui/surfaces/logs-view]
layer: data
owns_contracts: []
requires: []
implemented_by: [packages/persistence/src/jobs.ts, packages/persistence/src/jobOwner.ts, packages/persistence/src/jobOutput.ts]
verified_by: [packages/persistence/test/jobs.test.ts, packages/persistence/test/jobOutput.test.ts, packages/cli/test/jobs.e2e.test.ts, packages/app/test/service.test.ts]
siblings: [engineering/units/project-store, engineering/units/task-lifecycle, engineering/units/process-exec, engineering/units/app-log]
---

# Process claims

## Claims record which run a process drives and which children it started, and never kill anything

`JobStore` in `jobs.ts` keeps the `jobs` table:

- `claimRun` inserts a `run` job, and `spawned` inserts a `process` job under it.
- `heartbeat(ownerToken, now)` refreshes every open job of that token; `end` and `endOwner` close jobs.
- `liveRunJob(taskId, now)` returns the newest open run job whose heartbeat is inside the stale window; `isClaimedElsewhere` compares its token.
- `requestCancel(taskId, now)` stamps `cancel_requested_at` on the open run job that has none and says whether a row changed; `cancelRequested(jobId)` reads it.
- `orphans(now)` lists open `process` jobs with a stale heartbeat, and `reapStale(now)` ends every stale open job with outcome `abandoned`. `live(now)` and `list(taskId)` serve `job:list`.

`RunOwner` in `jobOwner.ts` is one claim. Constructing it claims the run with `process.pid` and a fresh `newOwnerToken()`, so a token names a claim and not a process. An `unref`'d interval calls `beat`, which heartbeats and, when `onCancelRequested` is set, polls the flag. `observer()` returns the `ExecObserver<number>` that records spawn, output and exit. `release(outcome)` stops the interval and calls `endOwner`.

`JobOutputSink` in `jobOutput.ts` keeps a head and a tail per job and stream, flushes on a debounce, and `end(jobId)` flushes and forgets one job. `jobOutput(db, {jobId, stream?, limit?})` reads the rows back.

It deliberately does not own:

- Killing a process. `killTree` in [process-exec](process-exec.md) kills a child its own process holds, and an orphan is only reported.
- What a cancel does. The owner's `onCancelRequested` decides it, and the app's `cancelTaskIn` is [task-lifecycle](task-lifecycle.md).
- The open sequence that reads orphans, recovers tasks and then reaps: [project-store](project-store.md).
- The columns and indexes: [sqlite-schema](../contracts/sqlite-schema.md). The hook it implements: [exec-observer](../contracts/exec-observer.md). The `process` log lines beside each spawn: [app-log](app-log.md).

## Claims sit in the data layer, and both hosts hand one claim's observer to a run's children

- Layer `data`, package `@jaira/persistence`. It calls only the database connection. No upstream seam: the observer reaches `NodeExec` and `agentSpawn` in `@jaira/runtime`, never the engine.
- The app's `startRun` in `service.ts` builds a `JobOutputSink` and a `RunOwner` after `beginTaskRun`, logs observer failures as `recording a child process failed (<phase>)`, and passes `cancelTaskIn` as `onCancelRequested`. It forwards the owner's observer through one that also logs `started <command>` and `finished <code>`, and its `finally` flushes the sink and releases the claim.
- The CLI's `runTaskNow` in `cli.ts` builds a `RunOwner` with no sink, so a CLI run's child output is drained and kept nowhere, and releases the claim in `finally`.
- `parseStorage` in `shared/src/config.ts` refuses `jobs` and `job_output` as storage concerns, because a replayed table is per connection and a claim only means something across processes.

## The jobs table is the only store of liveness, and nothing else holds it

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `jobs` rows of kind `run` | inserted by `claimRun`; `heartbeat_at` moved by `heartbeat`; closed by `end`, `endOwner` and `reapStale` | the table, always in the database | `recoverInterrupted` at open; the CLI's start and the app's rewind, fork, delete and cancel ask `liveRunJob`; `deleteTask` and `pruneHistory` delete rows |
| `jobs` rows of kind `process` | `spawned` writes `command` as the command and argv joined by spaces, `pid` and `cwd`; `onExit` closes with `exit:<code>`, `exit:?` or `signal:<name>` | the table | `orphans` at open; `job:list`. `toJob` never reads `cwd`, so `JobRow.cwd` is always absent |
| `jobs.cancel_requested_at` | `requestCancel`; polled by `cancelRequested` | the table | the app's `cancelTaskIn` and the CLI's `task cancel` raise it |
| `job_output` | `flush` deletes and rewrites seq 0, the head, and seq 1, the tail with `dropped` | the table | `job:output`, which the Logs view opens from a log row's `jobId` |
| A sink's head, tail and dropped count | `write` | memory, until the next flush | none |

## The invariants keep a live run unreclaimed and a finished run free of orphans

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A run claim reads live only while its heartbeat is inside the stale window, and a released claim never reads live | `jobs.test.ts` "reports a claim as live while it keeps beating", "treats a released claim as gone even within the window" |
| 2 | Liveness keys on the owner token and never on the pid | `jobs.test.ts` "identifies an owner by token, not pid" |
| 3 | A child is recorded under its run job with its command and pid, and closed with its exit | `jobs.test.ts` "records a spawn against the run that owns it, and closes it on exit" |
| 4 | Releasing a claim closes every child it never saw exit, so a finished run leaves no orphan | `jobs.test.ts` "releasing an owner closes children it never saw exit"; `jobs.e2e.test.ts` "leaves no phantom orphans behind a clean run" |
| 5 | An open child of a dead owner is reported once, at the open that then reaps it | `jobs.test.ts` "surfaces a child abandoned by a dead owner as an orphan"; `jobs.e2e.test.ts` "warns about a process a dead session left running" |
| 6 | A CLI run releases its claim whether it completes or fails, and a CLI start of a task another live claim holds is refused | `jobs.e2e.test.ts` "records a run job and releases it when the run ends", "releases the claim even when the run fails", "is refused rather than taking the task over" |
| 7 | A cancel of a task another process drives raises the flag and writes no status, the owner sees it at its next beat, and a cancel with no open claim changes nothing | `jobs.test.ts` `"is a flag the owner polls — no socket needed"`, "reports that there was nothing to cancel"; `jobs.e2e.test.ts` "requests a cancel instead of writing a terminal status" |
| 8 | Output reaches the table only on a flush, keeps both ends with the elided count, is replaced rather than duplicated by a later flush, keeps streams apart, and an ended job is never written again | `jobOutput.test.ts` "writes nothing until it is flushed", "keeps both ends and counts what it dropped between them", "replaces the tail on a re-flush rather than appending it twice", "keeps the two streams apart", "flushes and forgets a job when it ends" |
| 9 | A reader never finds a stream empty in the middle of a flush | unasserted |
| 10 | Listing jobs or output for something that never ran answers empty rather than throwing | `service.test.ts` "returns no jobs and no output rather than throwing when nothing has run" |

## Every failure leaves rows that the next open reaps, and some leave a run nobody can see

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The owning process crashes | beats stop; the first open after the stale window recovers its task, reports its open children, then ends every job `abandoned` | kill the reported process by its pid | the CLI prints `warning: process left running by a previous session: <command> (pid <pid>)`; the app shows nothing |
| The owner's event loop misses beats for longer than the window, under a debugger or a suspended machine | another process's open recovers the task and reaps the claim; `heartbeat` skips ended rows, so the claim never returns while the run goes on | none | the task reads interrupted while its run still writes, and it is startable elsewhere |
| Two processes start one task | `claimRun` has no uniqueness; the guard is the CLI's `liveRunJob` check and `beginTaskRun` refusing a `running` status, and `liveRunJob` answers the newest open claim | none needed | refusal naming the other process or the status |
| Another process opens the project between `beginTaskRun` committing `running` and the `RunOwner` insert | it finds no claim and recovers the task | none | the task reads interrupted while its run continues |
| A cancel flag is raised | `onCancelRequested` runs at every beat until release, not once, so the handler must be idempotent | none needed | stopping, then canceled |
| The process is killed between flushes | up to one debounce window of output per stream never reaches the table | none | the output ends early |
| A flush repeats or retries | both rows are deleted and rewritten, so nothing duplicates | none needed | none |
| A child is spawned outside a run: a chat turn, a follow-up round, a probe, or git in `ensureWorkspace` | its `NodeExec` or agent spawn has no observer, so it gets no job row and is never reported as an orphan | none | an agent a conversation left running is never shown |
| The Logs view opens a job's output while several projects are open | `job:output` carries no project, `sessionOf()` finds no single session, and the answer is empty; with one project open, a job id logged by another database is read from that project's | open the output with only the job's project open | the output reads empty or shows another process |

## Two migrations shaped the tables, and neither rolls back

- Migration 3 added `job_output` and `jobs.cwd`. Migration 16 dropped `jobs.run_id`. Neither rolls back, and the rows need no conversion.

## The budgets are the heartbeat, the window, the kept output and the flush

- Heartbeat 5 000 ms: `DEFAULT_HEARTBEAT_MS` in `jobs.ts`, overridable by `RunOwnerOptions.heartbeatMs`.
- Stale window 30 000 ms: `DEFAULT_STALE_MS` in `jobs.ts`, overridable by the `JobStore` constructor and `openProject`'s `staleMs`.
- 262 144 characters kept at each end, per stream, per job: `DEFAULT_KEEP_BYTES` in `jobOutput.ts`, counted as string length rather than bytes.
- Flush debounce 500 ms: `DEFAULT_FLUSH_MS` in `jobOutput.ts`. `jobOutput` returns at most 200 rows by default.

## The claim departs from the layering to implement the exec seam's hook

- `jobOwner.ts` imports `ExecObserver` from `@jaira/runtime`, a data unit depending on core, because the hook belongs to the exec seam and the runtime may not import persistence.
- Orphans are reported and never killed, because a recorded pid may name another program after the owner died.
