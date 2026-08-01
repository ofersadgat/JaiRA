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
import { SessionStreams } from "./sessions";

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

/**
 * Prune the conversation streams a set of terminal tasks owns (DESIGN.md §7.3).
 *
 * SEPARATE from {@link pruneHistory}, and deliberately not folded into it, because a session is not
 * run history. A session outlives the run that produced it — a later run of the same task, or another
 * task entirely, can continue or branch from it, since a session id is a CAPABILITY: hold one and you
 * may use it. That also raises the stakes, because pruning is then the only thing in the system that
 * can make a held id unresolvable, and nothing else stands behind it.
 *
 * Whole LINEAGES, not individual branches. A fork stores only what it appended, so deleting a parent
 * takes the first fourteen messages of a conversation that still exists. Pruning from a lineage root
 * downward is the only unit that never orphans a prefix.
 *
 * The same safety rule as run history applies first: a non-terminal task is untouchable at any age,
 * because it is resumable and its conversations are what it would resume into.
 */
export function pruneSessions(project: Project, options: PruneOptions = {}): SessionPruneResult {
  const before = options.before ?? Date.now();
  const dryRun = options.dryRun === true;
  const streams = new SessionStreams(project.db);

  const lineages: SessionPruneResult["lineages"] = [];
  const skippedTasks: PruneResult["skippedTasks"] = [];

  for (const task of project.runtime.list()) {
    if (NON_TERMINAL.has(task.status)) {
      skippedTasks.push({
        taskId: task.taskId,
        status: task.status,
        reason: `task is ${task.status}; its conversations are what a resume would continue`,
      });
      continue;
    }
    for (const root of streams.rootsFor(task.taskId)) {
      if (root.createdAt >= before) continue;
      const lineage = streams.lineageFrom(root.id);
      lineages.push({
        taskId: task.taskId,
        sessionId: root.id,
        label: root.label,
        branches: lineage.length,
        messages: lineage.reduce((n, b) => n + streams.materialize(b.id).length, 0),
      });
    }
  }

  const totals = lineages.reduce(
    (acc, l) => ({ branches: acc.branches + l.branches, messages: acc.messages + l.messages }),
    { branches: 0, messages: 0 },
  );

  if (!dryRun && lineages.length > 0) {
    project.db.transaction(() => {
      for (const lineage of lineages) streams.prune(lineage.sessionId);
    })();
  }

  return { lineages, branches: totals.branches, messages: totals.messages, skippedTasks, dryRun };
}

/** What {@link pruneSessions} plans or did. */
export interface SessionPruneResult {
  lineages: Array<{ taskId: string; sessionId: string; label: string; branches: number; messages: number }>;
  branches: number;
  messages: number;
  skippedTasks: PruneResult["skippedTasks"];
  dryRun: boolean;
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

/**
 * Conversation rows currently stored, for the same "before you prune" summary.
 *
 * Worth reporting separately, and worth watching: a real agentic session runs to megabytes of file
 * contents and command output, so this is the number most likely to dominate a project's database.
 */
export function sessionSize(project: Project): { sessions: number; messages: number } {
  return new SessionStreams(project.db).size();
}
