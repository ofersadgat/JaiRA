/**
 * The workflow browser and lint surface (DESIGN §11.1, §14 phase 7).
 *
 * "Read-only tree of state files with lint results; editing happens in the user's
 * editor, JaiRA watches and re-lints." Two consequences shape this module:
 *
 *  - **It must survive a broken workflows directory.** The user is editing these
 *    files in another window, so at any instant one may be half-saved, invalid
 *    JSON, or referencing a state that does not exist yet. A lint surface that
 *    throws on the first bad file tells the author nothing; every failure is
 *    reported as a diagnostic against a file instead. (This is why it does not
 *    reuse `readWorkflowFiles`, which is right to throw for execution.)
 *  - **Roots are derived, not declared.** A state file is a workflow root when no
 *    other state names it as a child, which matches how `jaira task create
 *    --workflow <rootStateId>` is used. If mutual references leave no root at all,
 *    the states are reported as unreachable rather than silently yielding an empty
 *    browser.
 *
 * Linting is `validateBundle` with `strict: true` — the mode its own docs reserve
 * for a lint/CI surface, where every `functionRef` is expected to resolve. The
 * pre-run gate in `beginTaskRun` deliberately stays non-strict, because a state a
 * run never enters never needs its function.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FunctionCapabilities } from "@declarative-ai/exec";
import { loadBundle, parseReferencedFile, resolveStateRef, snapshotHash, stateIdFromPath, validateBundle } from "@declarative-ai/hw";
import { conversationModesOf, parseJsonText } from "@jaira/shared";
import type { LintIssue, WorkflowBrowser, WorkflowEntry, WorkflowFileEntry } from "@jaira/shared";
import type { Project } from "./project";
import { isStateFile } from "./snapshots";
import { workflowLoadOptions } from "./workflowRefs";

// The view models live in `@jaira/shared` so the renderer can name them without
// reaching into this Node-only package.
export type { LintIssue, LintSeverity, WorkflowBrowser, WorkflowEntry, WorkflowFileEntry } from "@jaira/shared";

/** Read every `*.json` under a workflows dir, keeping parse failures as data. */
function readTolerantly(workflowsDir: string): {
  files: Record<string, unknown>;
  errors: Map<string, string>;
} {
  const files: Record<string, unknown> = {};
  const errors = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !isStateFile(entry.name)) continue;
      const rel = relative(workflowsDir, full).split(sep).join("/");
      try {
        files[rel] = parseReferencedFile(rel, readFileSync(full, "utf8"));
      } catch (e) {
        // The author is mid-edit: report it against the file, don't abort the pass.
        errors.set(rel, (e as Error).message);
      }
    }
  };
  walk(workflowsDir);
  return { files, errors };
}

/**
 * The states a raw state file names as children.
 *
 * A child that declares no `state` runs the one its KEY names (WORKFLOWS.md §6), so the default has
 * to be applied here too — this is what root derivation subtracts, and without it every child of a
 * state that used the shorthand would be reported as a workflow root of its own.
 */
function childStatesOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") return [];
  const children = (raw as { children?: unknown }).children;
  if (children === null || typeof children !== "object") return [];
  const out: string[] = [];
  for (const [key, decl] of Object.entries(children as Record<string, unknown>)) {
    if (decl === null || typeof decl !== "object") continue;
    const state = (decl as { state?: unknown }).state;
    out.push(typeof state === "string" ? state : `./${key}`);
  }
  return out;
}

function labelOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const label = (raw as { label?: unknown }).label;
  return typeof label === "string" ? label : undefined;
}

export interface BrowseOptions {
  /** The registry a run would use, so `functionRef`s are resolved while linting. */
  functions?: ReadonlyMap<string, FunctionCapabilities>;
}

/**
 * Browse and lint the project's live `workflows/` directory.
 *
 * Pure read — nothing is snapshotted or written, so a UI can call this on every
 * file-watch event.
 */
export function browseWorkflows(project: Project, options: BrowseOptions = {}): WorkflowBrowser {
  const { files, errors } = readTolerantly(project.paths.workflowsDir);

  const byStateId = new Map<string, { file: string; raw: unknown }>();
  const fileEntries: WorkflowFileEntry[] = [];
  for (const [file, message] of errors) {
    fileEntries.push({ stateId: stateIdFromPath(file), file, error: message });
  }
  for (const [file, raw] of Object.entries(files)) {
    const stateId = stateIdFromPath(file);
    byStateId.set(stateId, { file, raw });
    const label = labelOf(raw);
    fileEntries.push({ stateId, file, ...(label !== undefined ? { label } : {}) });
  }
  fileEntries.sort((a, b) => a.stateId.localeCompare(b.stateId));

  // A child reference is a PATH (WORKFLOWS.md §2.1), so `./critique` and `feature/plan/critique`
  // can name the same state. Roots are derived by "no one references me", which only works if both
  // spellings are reduced to the canonical id first.
  const refOptions = workflowLoadOptions(project.paths, { tolerant: true, path: project.config.workflows.path });
  const referenced = new Set<string>();
  for (const [stateId, { raw }] of byStateId) {
    for (const state of childStatesOf(raw)) {
      try {
        // The PRIMARY root: a state id resolves against one root, not the search path
        // (EXPRESSIONS.md §4 — `resolveStateRef` has no filesystem to search with).
        const defaultRoot = Array.isArray(refOptions.defaultRoot) ? refOptions.defaultRoot[0] : (refOptions.defaultRoot as string | undefined);
        referenced.add(resolveStateRef(state, { ...refOptions, defaultRoot, from: stateId }));
      } catch {
        // An unresolvable reference is a load/lint diagnostic below, not a reason to lose the tree.
      }
    }
  }
  const roots = [...byStateId.keys()].filter((id) => !referenced.has(id)).sort();

  // Tasks per workflow root, so the browser answers "is anything using this?".
  const tasksByWorkflow = new Map<string, string[]>();
  const pinsByWorkflow = new Map<string, Array<{ taskId: string; snapshotHash: string }>>();
  for (const row of project.runtime.list()) {
    const meta = project.tasks.tryRead(row.taskId);
    if (!meta) continue;
    const list = tasksByWorkflow.get(meta.workflow) ?? [];
    list.push(row.taskId);
    tasksByWorkflow.set(meta.workflow, list);
    if (row.snapshotHash !== undefined) {
      const pins = pinsByWorkflow.get(meta.workflow) ?? [];
      pins.push({ taskId: row.taskId, snapshotHash: row.snapshotHash });
      pinsByWorkflow.set(meta.workflow, pins);
    }
  }

  const covered = new Set<string>();
  const workflows: WorkflowEntry[] = roots.map((rootId) => {
    const label = labelOf(byStateId.get(rootId)?.raw);
    const taskIds = tasksByWorkflow.get(rootId) ?? [];
    const base: WorkflowEntry = {
      rootId,
      ...(label !== undefined ? { label } : {}),
      states: [],
      issues: [],
      taskIds,
      driftedTasks: [],
    };
    let bundle;
    try {
      bundle = loadBundle(files, rootId, workflowLoadOptions(project.paths, { tolerant: true, path: project.config.workflows.path }));
    } catch (e) {
      // An unresolvable child reference or a malformed state: the closure is
      // unknown, so the only honest answer is the load error itself.
      return { ...base, states: [rootId], loadError: (e as Error).message };
    }
    const states = Object.keys(bundle.states).sort();
    for (const id of states) covered.add(id);
    const report = validateBundle(bundle, {
      strict: true,
      ...(options.functions !== undefined ? { functions: options.functions } : {}),
    });
    const issues: LintIssue[] = [
      ...report.errors.map((issue) => ({ ...issue, severity: "error" as const })),
      ...report.warnings.map((issue) => ({ ...issue, severity: "warning" as const })),
    ];
    // A session cannot carry full history and a summary at once (one session, one
    // transcript). JaiRA summarizes it for all of them, so say so at lint time
    // rather than letting a `full_history` state be quietly compacted.
    //
    // Read from the LOADED states, not `source`: a mode inherited from an ancestor's `environment`
    // (WORKFLOWS.md §5) is nowhere in the authored file, and reading the file alone would miss
    // exactly the conflicts inheritance makes easiest to create.
    for (const conflict of conversationModesOf(bundle.states as unknown as Record<string, unknown>).conflicts) {
      issues.push({
        stateId: conflict.stateIds[0] ?? rootId,
        path: "operation.conversation.mode",
        message:
          `session '${conflict.session}' declares both summary and full_history ` +
          `(${conflict.stateIds.join(", ")}); the transcript is summarized for all of them`,
        severity: "warning",
      });
    }
    const hash = snapshotHash(bundle);
    // A task pinned to a different hash is running older source — worth showing,
    // since execution reads the snapshot and never live `workflows/` (§5.3).
    const drifted = (pinsByWorkflow.get(rootId) ?? []).filter((pin) => pin.snapshotHash !== hash).map((p) => p.taskId);
    return { ...base, states, snapshotHash: hash, issues, driftedTasks: drifted };
  });

  const unreachable = [...byStateId.keys()].filter((id) => !covered.has(id)).sort();
  return { workflows, files: fileEntries, unreachable };
}

/** Errors only, across every workflow — the "can I run anything?" question. */
export function lintErrors(browser: WorkflowBrowser): Array<{ rootId: string; issue: LintIssue | { message: string } }> {
  const out: Array<{ rootId: string; issue: LintIssue | { message: string } }> = [];
  for (const workflow of browser.workflows) {
    if (workflow.loadError !== undefined) out.push({ rootId: workflow.rootId, issue: { message: workflow.loadError } });
    for (const issue of workflow.issues) {
      if (issue.severity === "error") out.push({ rootId: workflow.rootId, issue });
    }
  }
  return out;
}
