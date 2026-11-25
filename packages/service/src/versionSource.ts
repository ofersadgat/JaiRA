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
 * content — a version an improver wrote under `approval: "auto"` or `"accept"` waits, unoffered, until a person agrees
 * to its code (decision 0029 §1). An offered version is pinned as a snapshot first, so a resume can lay
 * it back into the bundle (`withRunVersions`).
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { subtreeIds, versionHashOf, type OfferedVersion, type VersionSource, type WorkflowBundle } from "@declarative-ai/hw";
import {
  loadForPin,
  nodeVfs,
  readWorkflowFiles,
  scriptApprovalsFor,
  pinWorkflow,
  scriptFilesOf,
  userModules,
  workflowLoadOptions,
  type Project,
  scriptContextOf,
} from "@jaira/persistence";
import { grantAlwaysGrantedTools } from "@jaira/runtime";

/** Folders under a layer root that hold no part of a workflow's definition — what moves while it runs. */
const NOT_DEFINITION = new Set(["system", "projects", "personal", "machine", "local", "node_modules", ".git", "skills", "lessons", "tasks", "worktrees"]);

/**
 * What a workflow's definition could have been read from, as of now — every file under the layers'
 * roots that could hold one (its state files, the fragments they reference, the settings that stand
 * over its permission sets), by name, size and time — and which scripts are approved. Cheap next to
 * loading and pinning the workflow, which reads every file; equal to the last one, and the answer is.
 */
function definitionFingerprint(project: Project): string {
  const options = workflowLoadOptions(project.paths, { path: project.config.workflows.path }) as unknown as { rootPath?: readonly string[] };
  const hash = createHash("sha256");
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") && entry.name !== ".jaira") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_DEFINITION.has(entry.name) && depth < 12) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || /\.(db|db-wal|db-shm|sqlite|log)$/i.test(entry.name)) continue;
      try {
        const stat = statSync(full);
        hash.update(full).update("\0").update(String(stat.size)).update("\0").update(String(stat.mtimeMs)).update("\n");
      } catch {
        /* gone between the listing and the look: the next fingerprint says so */
      }
    }
  };
  for (const root of options.rootPath ?? []) walk(root, 0);
  for (const [file, hashOf] of [...(userModules()?.approvals.all() ?? new Map<string, string>())].sort()) hash.update(file).update("\0").update(hashOf).update("\n");
  return hash.digest("hex");
}

export function versionSourceFor(
  project: Project,
  rootId: string,
  onWaiting?: (stateId: string, files: readonly string[]) => void,
  /** The run's functions, which the pin validates against — so a version is pinned as the run was. */
  functions?: NonNullable<Parameters<typeof pinWorkflow>[2]>["functions"],
): VersionSource {
  // The answers since the definition last changed, by the state asked about and the version running:
  // asked at every boundary of a run, and loading the workflow costs what reading every file does.
  let known: { fingerprint: string; answers: Map<string, OfferedVersion | undefined> } | undefined;
  const answer = async (stateId: string, current: string): Promise<OfferedVersion | undefined> => {
    const fingerprint = definitionFingerprint(project);
    const asked = `${stateId}\n${current}`;
    if (known?.fingerprint === fingerprint && known.answers.has(asked)) return known.answers.get(asked);
    const offered = await offer(stateId, current);
    if (known?.fingerprint !== fingerprint) known = { fingerprint, answers: new Map() };
    known.answers.set(asked, offered);
    return offered;
  };
  const offer = async (stateId: string, current: string): Promise<OfferedVersion | undefined> => {
    // A script in the newer version that nobody has agreed to keeps it unoffered — asked about by
    // nothing here, since the run is not where that question is put (decision 0029 §1).
    const modules = userModules();
    if (modules !== undefined) {
      let files: WorkflowBundle;
      try {
        files = loadForPin(project, readWorkflowFiles(project.paths.workflowsDir, { scripts: scriptContextOf(project.paths, project.config.workflows.path) }), rootId, { vfs: nodeVfs() });
      } catch {
        return undefined;
      }
      if (files.states[stateId] === undefined) return undefined;
      const part = { ...files, states: Object.fromEntries(subtreeIds(files, stateId).map((id) => [id, files.states[id]!])) };
      const waiting = scriptApprovalsFor(modules, scriptFilesOf(part));
      if (waiting.length > 0) {
        if (versionHashOf(files, stateId) !== current) onWaiting?.(stateId, waiting.map((w) => w.file));
        return undefined;
      }
    }
    // Pinned exactly as a start would pin the workflow now — loaded, validated against the run's
    // functions, its modules frozen — so a file nobody touched pins as what is running, never as a
    // newer version of it.
    let pinned: Awaited<ReturnType<typeof pinWorkflow>>;
    try {
      pinned = await pinWorkflow(project, rootId, functions !== undefined ? { functions } : {});
    } catch {
      return undefined;
    }
    // …and given what every run is given at its start (`startRun`), so it is the form the run holds.
    grantAlwaysGrantedTools(pinned.bundle.states);
    if (pinned.bundle.states[stateId] === undefined || versionHashOf(pinned.bundle, stateId) === current) return undefined;
    return { bundle: pinned.bundle, snapshot: pinned.hash };
  };
  return answer;
}
