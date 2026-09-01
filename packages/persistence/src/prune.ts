/**
 * History pruning (SPEC §13, DESIGN §12).
 *
 * "Pruning should preserve task correctness. A task cannot prune data required to
 * resume its current active state." In JaiRA that rule is sharp, because the
 * `events` journal *is* the resume and projection source (§1b item 2): deleting a
 * non-terminal task's events would erase the instance tree the board draws and the
 * history a re-run reads. So the safety rule is enforced by the query itself —
 * **only runs that have ended, belonging to tasks in a terminal state, are ever
 * eligible** — rather than by a caller remembering to filter.
 *
 * What that means concretely:
 *  - A `running` or `interrupted` task is never pruned, at any age. An interrupted
 *    task is *resumable*, which is exactly the case §13 protects.
 *  - Within a terminal task, the **latest** run is kept by default, because it is
 *    what the detail view and `runCauses` report; older attempts are the disposable
 *    part.
 *  - Deletion is per-run, in one transaction, so a prune can never leave a run row
 *    whose events are half-gone.
 */
import type { HistorySize, PruneResult } from "@jaira/shared";
import type { Project } from "./project";
import { removeJournal } from "./journalFile";
import { removeConversations } from "./conversationFile";
import { isFileBacked } from "./shadow";
import { collectBlobs, release } from "./blobStore";
import type { JsonValue } from "@declarative-ai/json";

// The view models live in `@jaira/shared` so the renderer can name them too.
export type { HistorySize, PrunePlanEntry, PruneResult } from "@jaira/shared";

/** Statuses whose history is still load-bearing (SPEC §13's "current active state"). */
const NON_TERMINAL = new Set(["queued", "running", "interrupted"]);

export interface PruneOptions {
  /** Delete history from runs that ended before this instant. Default: now. */
  before?: number;
  /**
   * Keep this many most-recent runs per task. Default 1 — the latest run backs the
   * detail view, so dropping it would blank a completed task's history entirely.
   */
  keepRunsPerTask?: number;
  /** Report what would be deleted without deleting it. */
  dryRun?: boolean;
}

interface RunRow {
  id: number;
  task_id: string;
  ended_at: number | null;
}

/**
 * Plan and (unless `dryRun`) perform a prune.
 *
 * The plan is returned either way, so a UI can show exactly what will go before
 * anything is destroyed — pruning history is not undoable.
 */
export function pruneHistory(project: Project, options: PruneOptions = {}): PruneResult {
  const before = options.before ?? Date.now();
  const keep = Math.max(0, options.keepRunsPerTask ?? 1);
  const dryRun = options.dryRun === true;

  const runs: PruneResult["runs"] = [];
  const skippedTasks: PruneResult["skippedTasks"] = [];

  for (const task of project.runtime.list()) {
    if (NON_TERMINAL.has(task.status)) {
      // Not an age question: a resumable task's journal is its resume source.
      skippedTasks.push({
        taskId: task.taskId,
        status: task.status,
        reason: `task is ${task.status}; its history is still required to resume or display it`,
      });
      continue;
    }

    const all = project.db
      .prepare(`SELECT id, task_id, ended_at FROM runs WHERE task_id = ? ORDER BY id DESC`)
      .all(task.taskId) as RunRow[];
    // Newest first, so `keep` protects the most recent attempts.
    const candidates = all.slice(keep).filter((run) => run.ended_at !== null && run.ended_at < before);

    for (const run of candidates) {
      const events = (
        project.db.prepare(`SELECT COUNT(*) n FROM state_machine_events WHERE run_id = ?`).get(run.id) as { n: number }
      ).n;
      const commands = (
        project.db.prepare(`SELECT COUNT(*) n FROM command_log WHERE run_id = ?`).get(run.id) as { n: number }
      ).n;
      runs.push({
        taskId: run.task_id,
        runId: run.id,
        ...(run.ended_at !== null ? { endedAt: run.ended_at } : {}),
        events,
        commands,
      });
    }
  }

  const totals = runs.reduce(
    (acc, run) => ({ events: acc.events + run.events, commands: acc.commands + run.commands }),
    { events: 0, commands: 0 },
  );

  if (!dryRun && runs.length > 0) {
    // One transaction: a half-pruned run would leave the journal disagreeing with
    // the run row that references it.
    project.db.transaction(() => {
      const dropEvents = project.db.prepare(`DELETE FROM state_machine_events WHERE run_id = ?`);
      const dropCommands = project.db.prepare(`DELETE FROM command_log WHERE run_id = ?`);
      // A job's captured output hangs off the job, and jobs were never pruned at all — so a run's
      // children were half-collected and the rows nobody deleted grew forever.
      const dropJobOutput = project.db.prepare(
        `DELETE FROM job_output WHERE job_id IN (SELECT id FROM jobs WHERE run_id = ?)`,
      );
      const dropJobs = project.db.prepare(`DELETE FROM jobs WHERE run_id = ?`);
      // A conversation belongs to the run that held it (see `SessionScope`), so pruning the run
      // prunes its transcripts — and the lineage rows they hang off with them. A record carries its
      // own position inside its request now (migration 14), so deleting the record IS releasing the
      // seat. This also covers the UNPLACED records §5.2's unconditional recording writes (the
      // retention question of CHANGESETS.md §10.5 lands here, in the surface that already prunes).
      const dropRecords = project.db.prepare(`DELETE FROM operation_records WHERE run_id = ?`);
      const readRecords = project.db.prepare(`SELECT result_json, request_json FROM operation_records WHERE run_id = ?`);
      // A branch with no records left AND no descendant pointing at it. Both conditions matter, and
      // the first one alone is actively destructive:
      //
      //  - A RECORDLESS branch is normal and transient. `resolve` and `fork` insert the lineage row
      //    before the first record exists, so "no records" is also what an in-flight call of ANOTHER
      //    run looks like. Deleting it re-created it later with no parent, silently truncating a
      //    conversation's inherited prefix.
      //  - `parent REFERENCES sessions(id)` with foreign keys ON means removing a parent that still
      //    has a child ABORTS THE WHOLE TRANSACTION — taking the events, jobs and runs with it.
      //
      // Age-bounded for the same reason: a conversation younger than the prune window belongs to work
      // that is still going on.
      const dropSessions = project.db.prepare(
        `DELETE FROM sessions
          WHERE created_at < ?
            AND id NOT IN (SELECT DISTINCT COALESCE(landed_session_id, session_id) FROM operation_records
                            WHERE session_id IS NOT NULL)
            AND id NOT IN (SELECT parent FROM sessions WHERE parent IS NOT NULL)`,
      );
      const dropRun = project.db.prepare(`DELETE FROM runs WHERE id = ?`);
      for (const run of runs) {
        // Children before the parent: `command_log.run_id` and `events.run_id`
        // reference `runs(id)`, so the run row goes last or the FK refuses.
        dropEvents.run(run.runId);
        dropCommands.run(run.runId);
        dropJobOutput.run(run.runId);
        dropJobs.run(run.runId);
        // The bytes a record REFERENCED are let go before the row goes, while there is still
        // something to read the references off. A blob two records share survives the first delete
        // and dies with the second, which is what the reference COUNT is for (RECORDS.md §8).
        for (const row of readRecords.all(run.runId) as Array<{ result_json: string | null; request_json: string | null }>) {
          for (const text of [row.result_json, row.request_json]) {
            if (text !== null) release(project.db, JSON.parse(text) as JsonValue);
          }
        }
        dropRecords.run(run.runId);
        dropRun.run(run.runId);
      }
      // Once, after the records are gone. Repeated until it stops removing anything, because a chain
      // is peeled a generation at a time: deleting a leaf is what makes its parent deletable.
      let removed = 0;
      do {
        removed = dropSessions.run(before).changes;
      } while (removed > 0);
      // Aliases are soft references (migration 15): a name whose session is gone names nothing.
      project.db.prepare(`DELETE FROM session_names WHERE session_id NOT IN (SELECT id FROM sessions)`).run();
      // And the bytes nothing names any more. Swept here rather than inside each delete: a prune
      // removes thousands of rows and a blob released by one may be re-referenced by none, so the
      // question is asked once, at the end, when the answer has stopped changing.
      collectBlobs(project.db);
    })();
    // The FILES, after the rows and outside the transaction — a filesystem does not roll back, and a
    // journal file with no run row is recoverable noise where a run row with no journal is a run
    // whose history silently reads as empty.
    //
    // Deleted rather than dropped from the index, which is the decision §4.4 records: a prune that
    // left the file would see the run return on the next pull, which is a prune that does not prune.
    // If the file was committed, removing it from git is the user's action and JaiRA does not touch
    // the index on their behalf.
    if (isFileBacked(project.config.storage.journal)) {
      for (const run of runs) removeJournal(project.paths.journalDir, run.taskId, run.runId);
    }
    if (isFileBacked(project.config.storage.conversations)) {
      for (const run of runs) removeConversations(project.paths.conversationsDir, run.taskId, run.runId);
    }
  }

  return { runs, events: totals.events, commands: totals.commands, skippedTasks, dryRun };
}

/** Rows currently stored, for a "before you prune" summary. */
export function historySize(project: Project): HistorySize {
  const one = (sql: string): number => (project.db.prepare(sql).get() as { n: number }).n;
  return {
    runs: one(`SELECT COUNT(*) n FROM runs`),
    events: one(`SELECT COUNT(*) n FROM state_machine_events`),
    commands: one(`SELECT COUNT(*) n FROM command_log`),
  };
}
