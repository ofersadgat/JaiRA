/**
 * Which states are switched off on a project's workflow path (decision 0021) — read from the files
 * as they stand, at each question, never from a run's snapshot.
 *
 * A snapshot is what a run FOLLOWS; whether a state may be started or entered is a question about
 * the workflow NOW, so the answer is the live one (the person, 2026-10-26: "if a running state is
 * supposed to transition to a state/workflow which is disabled, it errors"). Which is also why the
 * loader strips the field from what it loads: switching a workflow off must not read as a change to
 * the definition every running task of it follows (`withoutSwitches`).
 *
 * A state is switched off by the WINNING file for its id — the first layer that has one — saying
 * `"disabled": true`, itself or through the file it follows: `{ "$ref": "$SYSTEM/workflows/chat/session",
 * "disabled": true }` is how a built-in is switched off in one project without copying it, and
 * `{ "$ref": "$BASE/workflows/feature", "disabled": false }` is how a project switches a Shared one
 * back on. Every state under a switched-off id is off with it ({@link disabledBy}).
 */
import { createLogger } from "@declarative-ai/log";
import { expandReferences, stateIdFromPath, type LoadBundleOptions } from "@declarative-ai/hw";
import { disabledBy, disabledWords, refusal, type JairaPaths } from "@jaira/shared";
import type { Project } from "./project";
import { readWorkflowsTolerantly } from "./workflows";
import { workflowLoadOptions } from "./workflowRefs";

const log = createLogger("jaira.persistence.disabled");

/**
 * Whether one winning state file switches its state off. A file that says nothing itself and
 * follows another answers with what it follows; one that cannot be followed switches nothing off —
 * the lint is where a reference that does not resolve is reported.
 */
export function fileDisables(stateId: string, raw: unknown, options: LoadBundleOptions): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const own = (raw as { disabled?: unknown }).disabled;
  if (typeof own === "boolean") return own;
  if ((raw as { $ref?: unknown }).$ref === undefined || options.vfs === undefined) return false;
  try {
    const followed = expandReferences(raw, {
      vfs: options.vfs,
      from: stateId,
      ...(options.defaultRoot !== undefined ? { defaultRoot: options.defaultRoot } : {}),
      ...(options.roots !== undefined ? { roots: options.roots } : {}),
      ...(options.rootPath !== undefined ? { rootPath: options.rootPath } : {}),
      shadowing: "override",
    }) as { disabled?: unknown } | null;
    return followed?.disabled === true;
  } catch {
    return false;
  }
}

/** The ids switched off among the winning files of a workflow path, in id order. */
export function disabledAmong(winning: ReadonlyMap<string, unknown>, options: LoadBundleOptions): string[] {
  return [...winning].filter(([stateId, raw]) => fileDisables(stateId, raw, options)).map(([stateId]) => stateId).sort();
}

/**
 * The layer directories a project searches, in order — its own, the Shared root's, the built-in one —
 * each once.
 */
function layerDirsOf(paths: JairaPaths): string[] {
  return [...new Set([paths.workflowsDir, paths.base.workflowsDir, paths.builtIn.workflowsDir])];
}

/**
 * The states switched off on this project's workflow path, read now. The state FILES alone: a
 * workflow script is compiled code with no field to switch, so it is never one of them.
 */
export function disabledStatesOf(project: Project): string[] {
  return disabledStatesIn(project.paths, project.config.workflows.path);
}

/**
 * {@link disabledStatesOf} over any layer layout — a project's, or the shared root's on its own
 * (`baseAsProjectPaths`), where what Shared says is all there is above what ships.
 */
export function disabledStatesIn(paths: JairaPaths, searchPath?: readonly string[]): string[] {
  const winning = new Map<string, unknown>();
  for (const dir of layerDirsOf(paths)) {
    for (const [file, raw] of Object.entries(readWorkflowsTolerantly(dir, { scripts: false }).files)) {
      const stateId = stateIdFromPath(file);
      if (!winning.has(stateId)) winning.set(stateId, raw);
    }
  }
  return disabledAmong(winning, workflowLoadOptions(paths, { tolerant: true, ...(searchPath !== undefined ? { path: searchPath } : {}) }));
}

/**
 * Why `stateId` may not be started, entered or moved to now — `Not run: 'x' is disabled.` — or
 * `undefined`. `verb` is what was not done: a move says `moved`.
 */
export function disabledRefusalOf(project: Project, stateId: string, verb: "run" | "moved" = "run"): string | undefined {
  const by = disabledBy(disabledStatesOf(project), stateId);
  return by !== undefined ? `Not ${verb}: ${disabledWords(stateId, by)}.` : undefined;
}

/** Refuse a start of a disabled state — the one door every start path ends at calls this. */
export function refuseIfDisabled(project: Project, stateId: string): void {
  const words = disabledRefusalOf(project, stateId);
  if (words !== undefined) throw refusal(log, words, { stateId });
}
