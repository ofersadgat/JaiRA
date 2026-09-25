/**
 * The events workflow as a project reads it, and the one task that runs it (decision 0010 §4).
 *
 * `system/events` is resolved like any bare id — the project's copy, else Shared's, else the one JaiRA
 * ships (`$SYSTEM/workflows/system/events`, which has no automations). What the supervisor needs from
 * it is three facts: does it load, how many automations its root holds, and which version it is (the
 * snapshot hash a task of it would pin — the same comparison the workflow browser's drift check makes).
 *
 * ## Shared's copy, when a project keeps it
 *
 * A project's copy follows Shared's by `$ref: "$BASE/workflows/system/events"`. A named root names ONE
 * place and never searches (REFERENCES.md §1), so with no copy in Shared that reference names nothing
 * and the project's copy does not load. It is not made to fall back: the writer of a project's copy
 * writes Shared's first — {@link ensureBaseEventsCopy}, a copy that follows the built-in — which is
 * also what a person editing the files by hand would see there. That copy spells `transitions` and
 * `children` out, empty: the project's copy reads `$BASE/workflows/system/events.transitions`, and a
 * property read of a file that holds only a `$ref` finds nothing (the engine reads the file's own keys).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { snapshotHash, type WorkflowBundle } from "@declarative-ai/hw";
import type { JairaBasePaths, TaskMeta } from "@jaira/shared";
import { loadWorkflowBundle } from "./permissionSets";
import type { Project } from "./project";
import { readWorkflowFiles } from "./snapshots";
import { workflowLoadOptions } from "./workflowRefs";

/** The events workflow's id, in every layer. */
export const EVENTS_WORKFLOW = "system/events";
/** The events task's title, and its system marker (`TaskMeta.system`). */
export const EVENTS_TASK = "events";

/** The events workflow as it stands now in one project. */
export interface EventsWorkflowReading {
  bundle: WorkflowBundle;
  /** Its version: what a task started now would pin. */
  hash: string;
  /** Its automations: the root's transitions, by name where one is given, else by target. */
  lines: string[];
}

/**
 * Load `system/events` as this project resolves it — live files, like a first start. Throws the load
 * or validation error (a broken copy is not "no automations": the caller leaves a running task alone).
 */
export function readEventsWorkflow(project: Project): EventsWorkflowReading {
  const bundle = loadWorkflowBundle(
    readWorkflowFiles(project.paths.workflowsDir, { onError: () => undefined }),
    EVENTS_WORKFLOW,
    workflowLoadOptions(project.paths, { path: project.config.workflows.path }),
  );
  const root = bundle.states[bundle.rootId] as { transitions?: ReadonlyArray<{ name?: string; to?: string }> } | undefined;
  const lines = (root?.transitions ?? []).map((t, i) => t.name ?? t.to ?? `#${i + 1}`);
  return { bundle, hash: snapshotHash(bundle), lines };
}

/** The project's events task: the newest task of `system/events` carrying the system marker. */
export function eventsTaskOf(project: Project): TaskMeta | undefined {
  const found = project.tasks.list().filter((meta) => meta.system === EVENTS_TASK && meta.workflow === EVENTS_WORKFLOW);
  return found.at(-1);
}

/**
 * Give Shared a copy of `system/events` that follows the built-in, unless it has one — what a project's
 * copy's `$ref: "$BASE/workflows/system/events"` needs to name something. Idempotent: an existing copy
 * (JSON or YAML) is left exactly as it is.
 */
export function ensureBaseEventsCopy(base: Pick<JairaBasePaths, "workflowsDir">): { file: string; created: boolean } {
  for (const ext of [".json", ".yaml", ".yml"]) {
    const file = join(base.workflowsDir, `${EVENTS_WORKFLOW}${ext}`);
    if (existsSync(file)) return { file, created: false };
  }
  const file = join(base.workflowsDir, `${EVENTS_WORKFLOW}.json`);
  mkdirSync(dirname(file), { recursive: true });
  // `transitions` and `children` spelled out, empty, rather than inherited: a project's copy reads
  // `$BASE/workflows/system/events.transitions`, and a property read of a file that holds only a
  // `$ref` finds nothing there — the engine reads the file's own keys, not its target's.
  writeFileSync(file, `${JSON.stringify({ $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, transitions: [], children: {} }, null, 2)}\n`, "utf8");
  return { file, created: true };
}
