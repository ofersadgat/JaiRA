/**
 * Task lifecycle (DESIGN §12, phases-1/2 slice): create → start → finish /
 * cancel, with workflow-level re-runs after interruption. Engine wiring
 * (executors, providers, interaction) is the caller's concern — this module
 * owns only the durable bookkeeping around a run.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import type { Failure, FunctionCapabilities, JsonValue } from "@declarative-ai/exec";
import { loadBundle, validateBundle, type WorkflowBundle } from "@declarative-ai/hw";
import { newTaskId, isStartableStatus, type InstanceAddress, type TaskMeta, type TaskStatus } from "@jaira/shared";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "./snapshots";
import { freezeForRun, moduleEntriesOf, userModules } from "./userModules";
import { nodeVfs } from "./vfs";
import { workflowLoadOptions } from "./workflowRefs";
import type { Project } from "./project";
import { removeTaskJournal } from "./journalFile";
import { removeTaskConversations } from "./conversationFile";
import { removeTaskRows } from "./rowFile";
import { isFileBacked } from "./shadow";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.lifecycle");

export interface CreateTaskInput {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  branch?: string;
  parentTaskId?: string;
  id?: string;
}

export function createTask(project: Project, input: CreateTaskInput, nowMs = Date.now()): TaskMeta {
  // Neither project that is not a checkout takes a worktree, and this is where that is ENFORCED
  // rather than promised. Neither directory is a git repository, so a bound task in one would fail
  // inside `ensureWorkspace` at start — a refusal at creation says the same thing where it can still
  // be acted on. The base root is not a checkout, so a task recorded there can never take one.
  if (project.kind !== "project" && input.branch !== undefined) {
    throw refusal(log, `a ${project.kind} task cannot be bound to a branch — the shared root is not a checkout`);
  }
  const meta: TaskMeta = {
    id: input.id ?? newTaskId(),
    title: input.title,
    workflow: input.workflow,
    createdAt: new Date(nowMs).toISOString(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
  };
  if (project.runtime.get(meta.id)) throw refusal(log, `task '${meta.id}' already exists`, { taskId: meta.id });
  project.tasks.write(meta);
  project.runtime.insert(meta.id, nowMs, { branch: meta.branch });
  return meta;
}

export interface StartedRun {
  meta: TaskMeta;
  runId: number;
  bundle: WorkflowBundle;
  snapshotHash: string;
  snapshotDir: string;
  /** true when this run re-uses a previously pinned snapshot (re-run after interruption). */
  pinned: boolean;
}

export interface BeginRunOptions {
  /**
   * The registry's `functions` facet the bundle will run against. Passing it
   * lets validation resolve every `functionRef` (an interactive host function,
   * a delegated agent, a sub-workflow) at task start instead of failing partway
   * into the run. Omitted ⇒ unregistered refs are warnings, per
   * `validateBundle`'s default.
   */
  functions?: ReadonlyMap<string, FunctionCapabilities>;
  /**
   * A workflow that exists only in memory — pinned as this run's snapshot instead of read off disk.
   *
   * For JaiRA's OWN workflows (the description sync, the conformance check), which are synthesized
   * rather than authored into anyone's `workflows/`. A snapshot stores a RESOLVED definition and
   * `ensureSnapshot` already takes a bundle, so nothing about pinning one needs a file to exist —
   * only the read that produces it did.
   *
   * Stated rather than arranged by pre-setting `snapshotHash`, which also works: that borrows the
   * "re-run after interruption" branch below, and a reader would never find it there.
   */
  bundle?: WorkflowBundle;
  /**
   * Where this run's own work will begin — `forkPointOf` over the replay index it is resuming from.
   *
   * Written on the run row rather than derived later, because it is knowable NOW and stops being so
   * afterwards: replay leaves no record of its own, and the trace it does leave (a completion with
   * no session ref) is what a function op looks like too. See `RunRow.forkedAt`.
   *
   * Omitted for a run that shares nothing — every run started from the top.
   */
  forkedAt?: InstanceAddress;
  nowMs?: number;
}

/**
 * Transition a task to `running` and pin its workflow version.
 *
 * First run: read live `workflows/`, validate (enforced at task start,
 * DESIGN §5.2), FREEZE the js/ts modules it reaches (SPEC §7.5.5), snapshot (§5.3), pin the hash.
 * Re-run after interruption or failure: execute the *pinned* snapshot again from the workflow start
 * (DESIGN §1a item 1) — live workflow edits never affect an existing task.
 *
 * **Async because the freeze is.** Verifying what a workflow will run means transpiling its module
 * closure, and the compiler import is a dynamic one. The alternative — freezing outside and passing
 * the result in — cannot work: which modules a workflow reaches is only known once the bundle has
 * loaded, and the bundle loads here.
 */
export async function beginTaskRun(project: Project, taskId: string, options: BeginRunOptions = {}): Promise<StartedRun> {
  const nowMs = options.nowMs ?? Date.now();
  const runtime = project.runtime.get(taskId);
  if (!runtime) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  if (!isStartableStatus(runtime.status)) {
    throw refusal(log, `task '${taskId}' is ${runtime.status}; only queued/interrupted/failed tasks can start`, { taskId });
  }
  const meta = project.tasks.read(taskId);

  let bundle: WorkflowBundle;
  let hash: string;
  let dir: string;
  const pinned = runtime.snapshotHash !== undefined;
  if (runtime.snapshotHash !== undefined) {
    // No options: a snapshot stores the RESOLVED definition, so there is nothing left to resolve
    // and no root a reference could still need (EXPRESSIONS.md §11).
    bundle = loadSnapshot(project.paths.snapshotsDir, runtime.snapshotHash);
    hash = runtime.snapshotHash;
    dir = `${project.paths.snapshotsDir}/${hash}`;
  } else if (options.bundle !== undefined) {
    // Supplied whole: nothing to read, nothing to validate against a directory it was never in. It is
    // still snapshotted, so a re-run of this task replays the same definition through the branch
    // above rather than depending on the caller synthesizing an identical one.
    bundle = options.bundle;
    const snap = await snapshotWithModules(project, bundle);
    hash = snap.hash;
    dir = snap.dir;
  } else {
    // Unreadable files are collected rather than thrown: only the root's transitive
    // closure matters, so one half-saved scratch file elsewhere must not block every
    // task start. If the load then fails, they are reported with it — a missing
    // state and a broken state file are otherwise indistinguishable.
    const unreadable: string[] = [];
    const files = readWorkflowFiles(project.paths.workflowsDir, {
      onError: (relPath, message) => unreadable.push(`${relPath}: ${message}`),
    });
    // A fragment a document reference pulls in no longer has to be tracked and pinned alongside
    // the states: the snapshot stores the resolved definition, which has it spliced in already
    // (EXPRESSIONS.md §11).
    const vfs = nodeVfs();
    try {
      bundle = loadBundle(files, meta.workflow, workflowLoadOptions(project.paths, { vfs, path: project.config.workflows.path }));
    } catch (e) {
      const note = unreadable.length > 0 ? `\n  unreadable files:\n  ${unreadable.join("\n  ")}` : "";
      throw refusal(log, `${(e as Error).message}${note}`);
    }
    const report = validateBundle(bundle, options.functions ? { functions: options.functions } : {});
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
      throw refusal(log, `workflow validation failed for '${meta.workflow}':\n  ${detail}`);
    }
    const snap = await snapshotWithModules(project, bundle);
    hash = snap.hash;
    dir = snap.dir;
    bundle = snap.bundle;
  }

  const runId = project.db.transaction(() => {
    project.runtime.setSnapshot(taskId, hash, nowMs);
    project.runtime.setStatus(taskId, "running", nowMs);
    return project.runtime.beginRun(taskId, hash, nowMs, options.forkedAt);
  })();

  return { meta, runId, bundle, snapshotHash: hash, snapshotDir: dir, pinned };
}

/**
 * Freeze whatever js/ts modules this bundle reaches, then snapshot it (SPEC §7.5.5).
 *
 * The ORDER is the whole content of this function. `FrozenModules.digest` has to be on the bundle
 * before `snapshotHash` runs, because a module reached by name is the one reference the resolved
 * form does not inline — so it must reach the identity some other way or a pinned task would run
 * edited code under an unchanged version. Snapshotting first and folding the digest in after would
 * store the emit under a hash that does not account for it.
 *
 * A workflow that reaches no module takes the early return and is snapshotted exactly as before,
 * digest key absent — which is what keeps every snapshot taken before this feature identical.
 */
async function snapshotWithModules(
  project: Project,
  bundle: WorkflowBundle,
): Promise<{ hash: string; dir: string; bundle: WorkflowBundle }> {
  const entries = moduleEntriesOf(bundle);
  if (entries.length === 0) {
    const snap = ensureSnapshot(project.paths.snapshotsDir, bundle);
    return { hash: snap.hash, dir: snap.dir, bundle };
  }
  const modules = userModules();
  if (modules === undefined) {
    // The bundle names a module symbol, which means the loader resolved one, which means this
    // process built the pair. Reaching here would be a wiring bug rather than an authoring one, so it
    // says so instead of failing later with something about an unregistered function.
    throw refusal(log, 
      `workflow '${bundle.rootId}' calls js/ts functions (${entries.join(", ")}) but this process never called prepareUserModules()`,
    );
  }
  const frozen = await freezeForRun(modules, entries);
  const withDigest: WorkflowBundle = { ...bundle, moduleDigest: frozen.digest };
  const snap = ensureSnapshot(project.paths.snapshotsDir, withDigest, { modules: frozen.emitted });
  return { hash: snap.hash, dir: snap.dir, bundle: withDigest };
}

export type RunEndStatus = Extract<TaskStatus, "completed" | "failed" | "canceled">;

export function finishTaskRun(
  project: Project,
  taskId: string,
  runId: number,
  status: RunEndStatus,
  result?: { outputs?: unknown; failure?: Failure },
  nowMs = Date.now(),
): void {
  const outcome = status === "completed" ? "success" : status === "canceled" ? "canceled" : "error";
  project.db.transaction(() => {
    project.runtime.endRun(runId, outcome, nowMs, {
      outputsJson: result?.outputs !== undefined ? JSON.stringify(result.outputs) : undefined,
      failureJson: result?.failure !== undefined ? JSON.stringify(result.failure) : undefined,
    });
    project.runtime.setStatus(taskId, status, nowMs);
  })();
}

/**
 * Cancel a non-terminal task. In this headless v1 a `running` row with no live
 * engine in this process is a stale crash residue, so cancel simply records
 * the terminal status; in-process runs are canceled by aborting the engine
 * (the CLI does this on Ctrl-C) and land here through `finishTaskRun`.
 */
export function cancelTask(project: Project, taskId: string, nowMs = Date.now()): void {
  project.runtime.assertCancelable(taskId);
  project.db.transaction(() => {
    project.db
      .prepare(`UPDATE runs SET ended_at = ?, outcome = 'canceled' WHERE task_id = ? AND ended_at IS NULL`)
      .run(nowMs, taskId);
    project.runtime.setStatus(taskId, "canceled", nowMs);
  })();
}

/**
 * Delete a task outright: every run's journal, its runtime row, and its JSON file.
 *
 * Distinct from pruning (SPEC §13), which trims old runs while keeping the task: this removes the
 * task itself, and with it every row that hangs off one. A `running` task is refused — its journal
 * is the live engine's resume source, and the caller that wants it gone cancels it first. Any other
 * status may go, including `interrupted`: pruning protects a resumable task because the *user* may
 * still want it, and deleting is the user saying they do not.
 *
 * Session lineage rows are deliberately left behind. A session with no records is also what another
 * run's in-flight fork looks like (see the prune's age-bounded cleanup), and an orphaned lineage row
 * costs one row until the next prune collects it — the wrong deletion here truncates someone else's
 * conversation.
 */
export function deleteTask(project: Project, taskId: string): void {
  const row = project.runtime.get(taskId);
  if (!row) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  if (row.status === "running") {
    throw refusal(log, `task '${taskId}' is running; cancel it before deleting it`, { taskId });
  }
  // One transaction, children before parents: events and jobs reference runs, runs reference the
  // runtime row, and foreign keys are ON. Jobs are matched by task OR by run — a process job records
  // both, but only one is guaranteed — and their captured output goes first because it references
  // them. The self-referencing parent_job_id is safe in one statement: SQLite checks immediate
  // foreign keys at statement end, so a parent and its child leave together.
  project.db.transaction(() => {
    const runs = `SELECT id FROM runs WHERE task_id = ?`;
    const jobs = `SELECT id FROM jobs WHERE task_id = ? OR run_id IN (${runs})`;
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM command_log WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM job_output WHERE job_id IN (${jobs})`).run(taskId, taskId);
    project.db.prepare(`DELETE FROM jobs WHERE task_id = ? OR run_id IN (${runs})`).run(taskId, taskId);
    // Straight off the position row since migration 8: it carries the scope its record does, so the
    // subquery that used to reach through `operation_record_id` has nothing left to do.
    project.db.prepare(`DELETE FROM session_positions WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM operation_records WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM artifacts WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM runs WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM task_runtime WHERE task_id = ?`).run(taskId);
  })();
  // The task's journal files, for the reason `prune` deletes a run's: with the file as the truth, a
  // deletion that left it behind is a task that returns on the next pull (DESIGN §4.4).
  if (isFileBacked(project.config.storage.journal)) removeTaskJournal(project.paths.journalDir, taskId);
  if (isFileBacked(project.config.storage.conversations)) {
    removeTaskConversations(project.paths.conversationsDir, taskId);
  }
  if (isFileBacked(project.config.storage.tasks)) removeTaskRows(project.paths.taskRowsDir, taskId);
  if (isFileBacked(project.config.storage.artifacts)) removeTaskRows(project.paths.artifactRowsDir, taskId);
  // The file after the rows: a crash between the two leaves a task file with no runtime row, which
  // `list` still shows and a re-created row could adopt — recoverable, unlike the reverse order,
  // where the rows would describe a task no file can name.
  project.tasks.remove(taskId);
}
