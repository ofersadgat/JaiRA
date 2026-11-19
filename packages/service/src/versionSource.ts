/**
 * Newer versions of the states a run's scripts CALL (decision 0029 §3) — what JaiRA answers the engine's
 * `versions` question with.
 *
 * The run's ROOT workflow is loaded fresh from the files as they are now, and the called state's part of
 * it is offered when it differs from what the run is running. The whole root rather than the state on
 * its own, because a loaded state carries what its mount chain hands it (the environment, the session
 * scope): offered alone, a state would lose what it inherits and read as changed when it is not.
 *
 * A version is offered only when it could run: it validates, and every script in it is APPROVED by its
 * content — a version an improver wrote under `approval: "auto"` waits, unoffered, until a person agrees
 * to its code (decision 0029 §1). An offered version is pinned as a snapshot first, so a resume can lay
 * it back into the bundle (`withRunVersions`).
 */
import { subtreeIds, validateBundle, versionHashOf, type VersionSource, type WorkflowBundle } from "@declarative-ai/hw";
import {
  loadWorkflowBundle,
  readWorkflowFiles,
  scriptApprovalsFor,
  scriptFilesOf,
  snapshotWithModules,
  userModules,
  workflowLoadOptions,
  type Project,
} from "@jaira/persistence";

export function versionSourceFor(project: Project, rootId: string, onWaiting?: (stateId: string, files: readonly string[]) => void): VersionSource {
  return async (stateId, current) => {
    let live: WorkflowBundle;
    try {
      live = loadWorkflowBundle(readWorkflowFiles(project.paths.workflowsDir), rootId, workflowLoadOptions(project.paths));
    } catch {
      return undefined;
    }
    if (live.states[stateId] === undefined) return undefined;
    if (versionHashOf(live, stateId) === current) return undefined;
    if (validateBundle(live).errors.length > 0) return undefined;
    const modules = userModules();
    if (modules !== undefined) {
      const part = { ...live, states: Object.fromEntries(subtreeIds(live, stateId).map((id) => [id, live.states[id]!])) };
      const waiting = scriptApprovalsFor(modules, scriptFilesOf(part));
      if (waiting.length > 0) {
        onWaiting?.(stateId, waiting.map((w) => w.file));
        return undefined;
      }
    }
    try {
      const pinned = await snapshotWithModules(project, live);
      return { bundle: pinned.bundle, snapshot: pinned.hash };
    } catch {
      return undefined;
    }
  };
}
