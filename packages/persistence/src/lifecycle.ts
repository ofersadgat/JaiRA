/**
 * Task lifecycle (DESIGN §12, phases-1/2 slice): create → start → finish /
 * cancel, with workflow-level re-runs after interruption. Engine wiring
 * (executors, providers, interaction) is the caller's concern — this module
 * owns only the durable bookkeeping around a run.
 */
import { createLogger } from "@declarative-ai/log";
import { ApprovalRequired, approvalRefusalMessage, FAST_FORWARD_ENDED_EVENT, FAST_FORWARD_EVENT, refusal } from "@jaira/shared";
import type { Failure, FunctionCapabilities, JsonValue } from "@declarative-ai/exec";
import { validateBundle, type WorkflowBundle } from "@declarative-ai/hw";
import { loadPermissionFunction, loadWorkflowBundle, permissionFunctionRefsOf } from "./toolsets";
import { newTaskId, isStartableStatus, type Holding, type InputProvenance, type SplitEntry, type TaskMeta, type TaskProvenance, type TaskStatus } from "@jaira/shared";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "./snapshots";
import { currentPin, recordVersionPickUp, versionAt, WORKFLOW_VERSION_EVENT } from "./documents";
import { freezeForRun, moduleApprovalsFor, moduleEntriesOf, userModules, watchingForUnapproved, type WithheldSymbol } from "./userModules";
import { nodeVfs } from "./vfs";
import { workflowLoadOptions } from "./workflowRefs";
import type { Project } from "./project";
import { removeTaskJournal } from "./journalFile";
import { removeTaskConversations } from "./conversationFile";
import { removeTaskRows } from "./rowFile";
import { isFileBacked } from "./shadow";
import { dropConnectUndo } from "./connectUndo";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.lifecycle");

export interface CreateTaskInput {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  /** How each input was settled — see `TaskMeta.inputProvenance`. */
  inputProvenance?: Record<string, InputProvenance>;
  branch?: string;
  parentTaskId?: string;
  /** How a fan-out made this task, when one did — see `TaskMeta.origin`. */
  origin?: TaskProvenance;
  /** The lists this task is split on — see `TaskMeta.split`. */
  split?: SplitEntry[];
  /** Tasks that must complete before this one starts — see `TaskMeta.dependsOn`. */
  dependsOn?: string[];
  /**
   * The versioned frozen document this task runs (decision 0005 §3) — `workflow` is then the
   * document's root id, and the task pins the document's latest version each time it loads.
   */
  documentId?: string;
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
    ...(input.inputProvenance !== undefined && Object.keys(input.inputProvenance).length > 0 ? { inputProvenance: input.inputProvenance } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.split !== undefined && input.split.length > 0 ? { split: input.split } : {}),
    ...(input.dependsOn !== undefined && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
  };
  if (project.runtime.get(meta.id)) throw refusal(log, `task '${meta.id}' already exists`, { taskId: meta.id });
  project.tasks.write(meta);
  project.runtime.insert(meta.id, nowMs, {
    branch: meta.branch,
    // The re-run chain (Identity and Resume §05): a task minted as another's re-run points back at
    // it on its runtime row, where a query can walk it — the JSON meta carries it for people.
    ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
    ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
  });
  return meta;
}

export interface StartedRun {
  meta: TaskMeta;
  bundle: WorkflowBundle;
  snapshotHash: string;
  snapshotDir: string;
  /** true when this start re-uses a previously pinned snapshot (a resume of the same machine). */
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
   * This start CONTINUES the recorded machine — the caller is loading it (Identity and Resume §04)
   * rather than walking a fresh one. Required for a task that has run before: session resolution is
   * task-scoped and run-free now, so a fresh walk over history would resolve its authored names
   * straight into the last stretch's conversations — the whole transcript as preamble, continuing
   * the old remote session — and grow a second parentless tree in one journal. Exactly the two
   * shapes the runs collapse retired.
   */
  continues?: boolean;
  /**
   * This start REOPENS a finished task to take a person's move (decision 0005): the one case a
   * `completed` task runs again under its own id. Only with {@link continues} — the reopened machine
   * is loaded, never walked afresh — and only the caller that holds the move sets it, so every other
   * path still finds a completed lifecycle closed.
   */
  reopen?: boolean;
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
/**
 * Has this task's machine said anything yet?
 *
 * The one question that decides whether a start is a RESTART. A task with no journal entered no
 * instance and held no conversation, so walking it fresh contaminates nothing; one with a journal
 * would resolve its authored session names into what it already said and continue those remote
 * conversations with the whole transcript in front of the prompt.
 *
 * Exported because two callers must agree: `beginTaskRun` refuses the restart, and the app's
 * `resumable` tells a person which button they are looking at. Asking it two ways is how the button
 * comes to promise what the lifecycle then refuses.
 */
export function hasJournalHistory(project: Project, taskId: string): boolean {
  // A version pick-up (`documents.ts`) is the host's note about what the machine is ABOUT to run
  // under, written before the engine says anything — so it is not the machine having said something.
  // Nor is a fast-forward's start (`hostRows.ts`): the host writes it before it starts a task that
  // has never run, and the start must still be a first start.
  return (
    project.db
      .prepare(`SELECT 1 FROM state_machine_events WHERE task_id = ? AND type NOT IN (?, ?, ?) LIMIT 1`)
      .get(taskId, WORKFLOW_VERSION_EVENT, FAST_FORWARD_EVENT, FAST_FORWARD_ENDED_EVENT) !== undefined
  );
}

/**
 * The dependencies a task is still HOLDING for (decision 0003): every task in `dependsOn` that has
 * not completed, with its title and standing. Derived, never stored — the dependency's row is the
 * fact, so a dependency finishing releases every task holding for it without a write to any of them.
 *
 * A dependency that no longer exists is not waited for: the task that could have completed it is
 * gone, and holding for it would hold forever.
 */
export function holdingOf(project: Project, meta: Pick<TaskMeta, "dependsOn">): Holding[] {
  const holding: Holding[] = [];
  for (const dependency of meta.dependsOn ?? []) {
    const row = project.runtime.get(dependency);
    if (row === undefined || row.status === "completed") continue;
    holding.push({ taskId: dependency, title: project.tasks.tryRead(dependency)?.title ?? dependency, status: row.status });
  }
  return holding;
}

export async function beginTaskRun(project: Project, taskId: string, options: BeginRunOptions = {}): Promise<StartedRun> {
  const nowMs = options.nowMs ?? Date.now();
  const runtime = project.runtime.get(taskId);
  if (!runtime) throw refusal(log, `unknown task '${taskId}'`, { taskId });
  const reopening = options.reopen === true && options.continues === true && runtime.status === "completed";
  if (!isStartableStatus(runtime.status) && !reopening) {
    throw refusal(log, `task '${taskId}' is ${runtime.status}; only queued/interrupted/failed tasks can start`, { taskId });
  }
  // A task that ran before is not restarted in place — see {@link BeginRunOptions.continues}. The
  // journal probe is what spares the one safe case: a start that died before the engine journaled
  // anything left no tree and no conversations, and walking it fresh contaminates nothing.
  //
  // Probed whatever the status says, `queued` included: a task a SPLIT made (decision 0003) has
  // never run and stands `queued`, and its journal already holds its parent's history up to the
  // mount. Starting it fresh would run that history again — product deciding the features a second
  // time, inside one feature's task.
  if (options.continues !== true && hasJournalHistory(project, taskId)) {
    throw refusal(
      log,
      `task '${taskId}' is ${runtime.status} and already has history — restarting it in place would ` +
        `continue its old conversations with their whole transcript as preamble. Resume it to continue, ` +
        `or re-run it as a new task.`,
      { taskId },
    );
  }
  const meta = project.tasks.read(taskId);
  // A task HOLDING for a dependency (decision 0003) does not start until the dependency is done.
  // Refused here, where every start path ends, with the names — a button that greyed itself out
  // would be a second copy of this rule, and a CLI would have none.
  const holding = holdingOf(project, meta);
  if (holding.length > 0) {
    throw refusal(
      log,
      `task '${taskId}' is waiting for ${holding.map((h) => `'${h.title}' (${h.status})`).join(", ")} to complete`,
      { taskId },
    );
  }

  let bundle: WorkflowBundle;
  let hash: string;
  let dir: string;
  const pinned = runtime.snapshotHash !== undefined;
  // What this task runs under NOW: the snapshot it pinned — or, for a task in a versioned document
  // (decision 0005 §3), the document's LATEST version, which is how a modification reaches every
  // task standing in it. A task loads rather than replays, so continuing under a later version is
  // no more than being handed a root with another child in it.
  const pin = currentPin(project, runtime);
  if (pin !== undefined) {
    // No options: a snapshot stores the RESOLVED definition, so there is nothing left to resolve
    // and no root a reference could still need (EXPRESSIONS.md §11).
    bundle = loadSnapshot(project.paths.snapshotsDir, pin.snapshotHash);
    hash = pin.snapshotHash;
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
    const fresh = await pinWorkflow(project, meta.workflow, options.functions ? { functions: options.functions } : {});
    bundle = fresh.bundle;
    hash = fresh.hash;
    dir = fresh.dir;
  }

  project.db.transaction(() => {
    // A version picked up is journaled BEFORE the stretch that runs under it, so every row after it
    // — and every record those rows name — says which version it ran under by where it sits.
    if (pin?.documentId !== undefined && pin.snapshotHash !== runtime.snapshotHash) {
      recordVersionPickUp(project, taskId, pin, runtime.snapshotHash !== undefined ? versionAt(project, taskId) : undefined, nowMs);
    }
    // `beginTask` pins the snapshot, stamps when execution started, and clears how the last
    // stretch ended — one machine, one row (Identity and Resume §05).
    project.runtime.beginTask(taskId, hash, nowMs);
    project.runtime.setStatus(taskId, "running", nowMs);
  })();

  return { meta, bundle, snapshotHash: hash, snapshotDir: dir, pinned };
}

/**
 * Read a workflow off disk, validate it, FREEZE the modules it reaches and snapshot it — what a
 * task's first start pins, as its own step.
 *
 * Separate from {@link beginTaskRun} because one caller pins BEFORE there is a run: an adoption
 * (decision 0005 §2) writes mirror rows into a new task's journal, and a task with a journal is
 * continued, never started fresh — so its snapshot has to be on its row when the rows are, or the
 * load that follows has no definition to read the rows against.
 */
export async function pinWorkflow(
  project: Project,
  workflow: string,
  options: Pick<BeginRunOptions, "functions"> = {},
): Promise<{ bundle: WorkflowBundle; hash: string; dir: string }> {
  let bundle: WorkflowBundle;
  {
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
    // What the approval gate withholds while this load runs. Watched unconditionally because the
    // load is where the evidence exists: a withheld symbol makes the bundle fail to load, and a
    // failed load leaves nothing behind to ask the question of afterwards.
    const modules = userModules();
    const watch = modules !== undefined ? watchingForUnapproved(modules) : undefined;
    try {
      bundle = loadWorkflowBundle(
        files,
        workflow,
        workflowLoadOptions(project.paths, {
          vfs,
          path: project.config.workflows.path,
          ...(watch !== undefined ? { watch } : {}),
        }),
      );
    } catch (e) {
      // An unapproved module is raised FIRST, because it explains the load failure rather than
      // accompanying it: the parse error the loader raised is downstream of the symbol the gate
      // withheld, so reporting it would send the reader hunting a typo that is not there.
      await refuseIfUnapproved(watch?.withheld() ?? []);
      const note = unreadable.length > 0 ? `\n  unreadable files:\n  ${unreadable.join("\n  ")}` : "";
      throw refusal(log, `${(e as Error).message}${note}`);
    }
    const report = validateBundle(bundle, options.functions ? { functions: options.functions } : {});
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
      throw refusal(log, `workflow validation failed for '${workflow}':\n  ${detail}`);
    }
    const snap = await snapshotWithModules(project, bundle);
    return { bundle: snap.bundle, hash: snap.hash, dir: snap.dir };
  }
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
export async function snapshotWithModules(
  project: Project,
  bundle: WorkflowBundle,
): Promise<{ hash: string; dir: string; bundle: WorkflowBundle }> {
  // A toolset line's FUNCTION is not in the resolved states — lowering carries its NAME — so the
  // modules it reaches are found by loading it the way a run will, and are held to the same approval
  // and the same freeze as a module a state calls (decision 0007, amended 2026-09-22).
  const entries = [...new Set([...moduleEntriesOf(bundle), ...permissionFunctionModulesOf(project, bundle)])].sort();
  if (entries.length === 0) {
    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);
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
  // The freeze refuses with a message; this refuses with a QUESTION, and it has to come first or the
  // question never gets asked. Both cases reach here — a module approved but since edited, and an
  // import of an approved module that was never approved itself — and neither shows up as a withheld
  // symbol, because a bundle that names an approved module loads perfectly well.
  await refuseIfUnapproved([], entries);
  const frozen = await freezeForRun(modules, entries);
  const withDigest: WorkflowBundle = { ...bundle, moduleDigest: frozen.digest };
  const snap = await ensureSnapshot(project.paths.snapshotsDir, withDigest, { modules: frozen.emitted });
  return { hash: snap.hash, dir: snap.dir, bundle: withDigest };
}

/**
 * The module files the permission functions a bundle's toolsets name reach — each function loaded as
 * the one state it runs as, with this project's options. A function that does not load reaches nothing
 * here: the load that pinned the bundle has already refused it (`lowerStateToolsets` checks every
 * function a toolset names).
 */
function permissionFunctionModulesOf(project: Project, bundle: WorkflowBundle): string[] {
  const references = permissionFunctionRefsOf(bundle);
  if (references.length === 0) return [];
  const options = workflowLoadOptions(project.paths, { vfs: nodeVfs(), path: project.config.workflows.path });
  const out: string[] = [];
  for (const reference of references) {
    try {
      out.push(...moduleEntriesOf(loadPermissionFunction(reference, options)));
    } catch {
      // Reported where the workflow was loaded; nothing to freeze for a function that does not load.
    }
  }
  return out;
}

/**
 * Raise the answerable refusal, if there is anything to answer.
 *
 * A no-op in the ordinary case — nothing withheld, nothing pending — which is what lets both call
 * sites run it unconditionally rather than guarding it. When there IS something, the error carries
 * the whole list: a person about to approve wants to see what they are approving, not to be asked
 * again after each answer.
 *
 * It stays a `Refusal`, so a host with nobody attached prints the message and stops exactly as
 * before. A host with a human narrows to {@link ApprovalRequired} and asks.
 */
async function refuseIfUnapproved(withheld: readonly WithheldSymbol[], entries: readonly string[] = []): Promise<void> {
  if (withheld.length === 0 && entries.length === 0) return;
  const modules = userModules();
  if (modules === undefined) return;
  const pending = await moduleApprovalsFor(modules, entries, withheld);
  if (pending.length === 0) return;
  throw new ApprovalRequired(approvalRefusalMessage(pending), pending);
}

export type RunEndStatus = Extract<TaskStatus, "completed" | "failed" | "canceled">;

export function finishTaskRun(
  project: Project,
  taskId: string,
  status: RunEndStatus,
  result?: { outputs?: unknown; failure?: Failure },
  nowMs = Date.now(),
): void {
  const outcome = status === "completed" ? "success" : status === "canceled" ? "canceled" : "error";
  project.db.transaction(() => {
    project.runtime.endTask(taskId, outcome, nowMs, {
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
    project.runtime.endTask(taskId, "canceled", nowMs);
    project.runtime.setStatus(taskId, "canceled", nowMs);
  })();
  // A stop is a decision about the task: a connect's Undo it kept is over (`connectUndo.ts`).
  dropConnectUndo(project, taskId);
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
  // One transaction, children before parents. A process job's captured output goes first because it
  // references the job rows. The self-referencing parent_job_id is safe in one statement: SQLite
  // checks immediate foreign keys at statement end, so a parent and its child leave together.
  project.db.transaction(() => {
    const jobs = `SELECT id FROM jobs WHERE task_id = ?`;
    project.db.prepare(`DELETE FROM state_machine_events WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM command_log WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM job_output WHERE job_id IN (${jobs})`).run(taskId);
    project.db.prepare(`DELETE FROM jobs WHERE task_id = ?`).run(taskId);
    // Straight off the record row since migration 8: it carries the scope its record does, so the
    // subquery that used to reach through `operation_record_id` has nothing left to do.
    project.db.prepare(`DELETE FROM operation_records WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM session_names WHERE task_id = ?`).run(taskId);
    project.db.prepare(`DELETE FROM artifacts WHERE task_id = ?`).run(taskId);
    // A gate outlives the process that parked it, so it also has to leave with its task — otherwise
    // the strip goes on offering a question about a task that is no longer there to answer it.
    project.db.prepare(`DELETE FROM pending_interactions WHERE task_id = ?`).run(taskId);
    // The ROW goes; the merge request does not. Deleting a task is a local act, and closing a request
    // on somebody's forge because a card was removed would be an outward one nobody asked for.
    project.db.prepare(`DELETE FROM remote_handles WHERE task_id = ?`).run(taskId);
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
