/**
 * History pruning (SPEC §13, DESIGN §12).
 *
 * "Pruning should preserve task correctness. A task cannot prune data required to
 * resume its current active state." In JaiRA that rule is sharp, because the
 * `events` journal *is* the load and projection source (§1b item 2): deleting a
 * non-terminal task's events would erase the instance tree the board draws and the
 * machine a resume loads. So the safety rule is enforced by the query itself —
 * **only tasks in a terminal state, whose machine ended before the cutoff, are ever
 * eligible** — rather than by a caller remembering to filter.
 *
 * A task is one machine now (Identity and Resume §05), so the unit of pruning is the
 * task's history: its journal, its records and conversations, its command audit and
 * captured process output. The task itself — its meta, its runtime row, its outcome —
 * stays, so the board still says what happened; what goes is the how.
 */
import type { HistorySize, PruneResult } from "@jaira/shared";
import type { Project } from "./project";
import { removeTaskJournal } from "./journalFile";
import { removeTaskConversations } from "./conversationFile";
import { isFileBacked } from "./shadow";
import { collectBlobs, release } from "./blobStore";
import type { JsonValue } from "@declarative-ai/json";

// The view models live in `@jaira/shared` so the renderer can name them too.
export type { HistorySize, PrunePlanEntry, PruneResult } from "@jaira/shared";

/** Statuses whose history is still load-bearing (SPEC §13's "current active state"). */
const NON_TERMINAL = new Set(["queued", "running", "interrupted"]);

export interface PruneOptions {
  /** Delete history from tasks whose machine ended before this instant. Default: now. */
  before?: number;
  /** Report what would be deleted without deleting it. */
  dryRun?: boolean;
}

/**
 * Plan and (unless `dryRun`) perform a prune.
 *
 * The plan is returned either way, so a UI can show exactly what will go before
 * anything is destroyed — pruning history is not undoable.
 */
export function pruneHistory(project: Project, options: PruneOptions = {}): PruneResult {
  const before = options.before ?? Date.now();
  const dryRun = options.dryRun === true;

  const tasks: PruneResult["tasks"] = [];
  const skippedTasks: PruneResult["skippedTasks"] = [];

  for (const task of project.runtime.list()) {
    if (NON_TERMINAL.has(task.status)) {
      // Not an age question: a resumable task's journal is what a resume loads.
      skippedTasks.push({
        taskId: task.taskId,
        status: task.status,
        reason: `task is ${task.status}; its history is still required to resume or display it`,
      });
      continue;
    }
    // `endedAt` is when the machine last stopped; a terminal task with none is legacy enough that
    // `updatedAt` is the honest stand-in. Inclusive at the boundary: "ended before this instant"
    // with a default of `now` must cover a task that ended within the same millisecond as the ask.
    const endedAt = task.endedAt ?? task.updatedAt;
    if (endedAt > before) continue;

    const events = (
      project.db.prepare(`SELECT COUNT(*) n FROM state_machine_events WHERE task_id = ?`).get(task.taskId) as {
        n: number;
      }
    ).n;
    const commands = (
      project.db.prepare(`SELECT COUNT(*) n FROM command_log WHERE task_id = ?`).get(task.taskId) as { n: number }
    ).n;
    if (events === 0 && commands === 0) continue; // nothing to prune, nothing to report
    tasks.push({ taskId: task.taskId, endedAt, events, commands });
  }

  const totals = tasks.reduce(
    (acc, task) => ({ events: acc.events + task.events, commands: acc.commands + task.commands }),
    { events: 0, commands: 0 },
  );

  if (!dryRun && tasks.length > 0) {
    // One transaction: a half-pruned task would leave the journal disagreeing with the record store.
    project.db.transaction(() => {
      const dropEvents = project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ?`);
      const dropCommands = project.db.prepare(`DELETE FROM command_log WHERE task_id = ?`);
      // A job's captured output hangs off the job, and jobs were never pruned at all — so a task's
      // children were half-collected and the rows nobody deleted grew forever.
      const dropJobOutput = project.db.prepare(
        `DELETE FROM job_output WHERE job_id IN (SELECT id FROM jobs WHERE task_id = ?)`,
      );
      const dropJobs = project.db.prepare(`DELETE FROM jobs WHERE task_id = ?`);
      // A conversation belongs to the task that held it (see `SessionScope`), so pruning the task
      // prunes its transcripts — and the lineage rows they hang off with them. A record carries its
      // own position inside its request now (migration 14), so deleting the record IS releasing the
      // seat. This also covers the UNPLACED records §5.2's unconditional recording writes (the
      // retention question of CHANGESETS.md §10.5 lands here, in the surface that already prunes).
      const dropRecords = project.db.prepare(`DELETE FROM operation_records WHERE task_id = ?`);
      const readRecords = project.db.prepare(`SELECT result_json, request_json FROM operation_records WHERE task_id = ?`);
      // A branch with no records left AND no descendant pointing at it. Both conditions matter, and
      // the first one alone is actively destructive:
      //
      //  - A RECORDLESS branch is normal and transient. `resolve` and `fork` insert the lineage row
      //    before the first record exists, so "no records" is also what an in-flight call of ANOTHER
      //    task looks like. Deleting it re-created it later with no parent, silently truncating a
      //    conversation's inherited prefix.
      //  - `parent REFERENCES sessions(id)` with foreign keys ON means removing a parent that still
      //    has a child ABORTS THE WHOLE TRANSACTION — taking everything above with it.
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
      for (const task of tasks) {
        dropEvents.run(task.taskId);
        dropCommands.run(task.taskId);
        dropJobOutput.run(task.taskId);
        dropJobs.run(task.taskId);
        // The bytes a record REFERENCED are let go before the row goes, while there is still
        // something to read the references off. A blob two records share survives the first delete
        // and dies with the second, which is what the reference COUNT is for (RECORDS.md §8).
        for (const row of readRecords.all(task.taskId) as Array<{ result_json: string | null; request_json: string | null }>) {
          for (const text of [row.result_json, row.request_json]) {
            if (text !== null) release(project.db, JSON.parse(text) as JsonValue);
          }
        }
        dropRecords.run(task.taskId);
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
    // journal file with no rows is recoverable noise where rows with no journal are a history that
    // silently reads as empty.
    //
    // Deleted rather than dropped from the index, which is the decision §4.4 records: a prune that
    // left the file would see the history return on the next pull, which is a prune that does not
    // prune. If the file was committed, removing it from git is the user's action and JaiRA does not
    // touch the index on their behalf.
    if (isFileBacked(project.config.storage.journal)) {
      for (const task of tasks) removeTaskJournal(project.paths.journalDir, task.taskId);
    }
    if (isFileBacked(project.config.storage.conversations)) {
      for (const task of tasks) removeTaskConversations(project.paths.conversationsDir, task.taskId);
    }
  }

  return { tasks, events: totals.events, commands: totals.commands, skippedTasks, dryRun };
}

/** Rows currently stored, for a "before you prune" summary. */
export function historySize(project: Project): HistorySize {
  const one = (sql: string): number => (project.db.prepare(sql).get() as { n: number }).n;
  return {
    tasks: one(`SELECT COUNT(*) n FROM task_runtime`),
    events: one(`SELECT COUNT(*) n FROM state_machine_events`),
    commands: one(`SELECT COUNT(*) n FROM command_log`),
  };
}
