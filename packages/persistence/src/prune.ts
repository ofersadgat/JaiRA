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
        project.db.prepare(`SELECT COUNT(*) n FROM events WHERE run_id = ?`).get(run.id) as { n: number }
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
      const dropEvents = project.db.prepare(`DELETE FROM events WHERE run_id = ?`);
      const dropCommands = project.db.prepare(`DELETE FROM command_log WHERE run_id = ?`);
      const dropRun = project.db.prepare(`DELETE FROM runs WHERE id = ?`);
      for (const run of runs) {
        // Children before the parent: `command_log.run_id` and `events.run_id`
        // reference `runs(id)`, so the run row goes last or the FK refuses.
        dropEvents.run(run.runId);
        dropCommands.run(run.runId);
        dropRun.run(run.runId);
      }
    })();
  }

  return { runs, events: totals.events, commands: totals.commands, skippedTasks, dryRun };
}

/** Rows currently stored, for a "before you prune" summary. */
export function historySize(project: Project): HistorySize {
  const one = (sql: string): number => (project.db.prepare(sql).get() as { n: number }).n;
  return {
    runs: one(`SELECT COUNT(*) n FROM runs`),
    events: one(`SELECT COUNT(*) n FROM events`),
    commands: one(`SELECT COUNT(*) n FROM command_log`),
  };
}
