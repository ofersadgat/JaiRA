/**
 * Workflow snapshots — `.jaira/snapshots/<hash>/` (DESIGN §5.3, SPEC §12).
 *
 * At task start the transitive closure of state files (a `WorkflowBundle`) is
 * copied into a directory named by its `@declarative-ai/hw` snapshotHash.
 * Directories are content-addressed and immutable: identical workflow versions
 * across tasks share one snapshot. Execution always reads from the snapshot,
 * never from live `workflows/`.
 *
 * What gets written is the **resolved definition** — `bundle.states`, after path
 * lookup, reference expansion and desugaring (EXPRESSIONS.md §11).
 *
 * Definition evaluation is a pre-pass, and a snapshot pins its OUTPUT rather than
 * its input. Storing the authored form instead meant `loadSnapshot` had to re-run
 * the loader, so a pin fixed *bytes* rather than *meaning*: a task pinned before a
 * lowering change replayed its files through the newer loader with no hash change
 * to signal it, and every fragment a reference pulled in had to be tracked into the
 * identity and copied in separately, because resolution reads the project
 * filesystem and not the snapshot. Both problems are absent here rather than
 * mitigated — what was referenced is inlined, and a change to what anything lowers
 * to is a different hash by construction.
 *
 * Files are written without the `id` field: it is the map key already, and reload
 * restores it. This is also why a `LoadedState` has to be plain JSON — see hw's
 * `fanOut`, which was a `Set` and serialized to `{}`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isBareStateId, parseReferencedFile, snapshotHash, stateIdFromPath, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import { readJsonFile } from "@jaira/shared";

const META_FILE = ".meta.json";

interface SnapshotMeta {
  rootId: string;
  hash: string;
  /**
   * Snapshot-relative file → canonical state id, for the ids that are not the same thing.
   *
   * A bare id IS its path under the snapshot, which is why this is absent for almost every state.
   * An OUT-OF-TREE id (WORKFLOWS.md §2.1) is an absolute path and cannot be a relative filename, so
   * it is stored under a content-derived name and mapped back here — the snapshot stays a
   * self-contained directory, and the reloaded bundle still carries the ids the workflow was
   * validated and hashed under.
   */
  ids?: Record<string, string>;
}

function assertSafeStateId(stateId: string): void {
  if (stateId.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`state id '${stateId}' is not a safe relative path`);
  }
}

// A referenced prompt or shared type used to be hashed and copied in alongside the states, because
// expansion splices it in and a pinned run that re-resolved it against the live project would run
// something other than what it pinned. Storing the RESOLVED definition subsumes that entirely: the
// fragment is already inlined, so it is part of the identity by construction rather than by
// bookkeeping, and there is no second filesystem for a pinned run to resolve against.

/** Where one state's file lives inside a snapshot. */
function snapshotFileFor(stateId: string): string {
  if (isBareStateId(stateId)) {
    assertSafeStateId(stateId);
    return stateId;
  }
  // Hashed rather than sanitized: two external ids differing only in a separator must not collide,
  // and the name never has to be read back — `meta.ids` carries the real one.
  return `_external/${createHash("sha256").update(stateId).digest("hex").slice(0, 16)}`;
}

export interface ReadWorkflowFilesOptions {
  /**
   * Called for a file that could not be read or parsed, instead of throwing.
   * Supplying it makes the read TOLERANT — the file is skipped.
   *
   * That tolerance is not laziness: a workflow only needs the transitive closure of
   * its root, and `.jaira/workflows/` is a directory a human edits in another
   * window. Failing every task start because of one unrelated half-saved file was a
   * real bug. A broken file that *is* needed still fails the load, and the caller
   * reports the collected errors alongside it so the diagnosis stays sharp.
   */
  onError?: (relPath: string, message: string) => void;
}

/** The suffixes a state file may carry. A state is JSON or YAML; both parse to the same value. */
export const STATE_SUFFIXES = [".json", ".yaml", ".yml"] as const;

/** True for a file the workflow walk should read as a state. */
export function isStateFile(name: string): boolean {
  const lower = name.toLowerCase();
  return STATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Read every state file under a workflows dir as loader input (relPath → parsed document). */
export function readWorkflowFiles(
  workflowsDir: string,
  options: ReadWorkflowFilesOptions = {},
): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // editor/tool droppings, snapshot .meta.json
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !isStateFile(entry.name)) continue;
      const rel = relative(workflowsDir, full);
      if (options.onError === undefined) {
        files[rel] = readStateDocument(full);
        continue;
      }
      try {
        files[rel] = readStateDocument(full);
      } catch (e) {
        options.onError(rel, (e as Error).message);
      }
    }
  };
  walk(workflowsDir);
  return files;
}

/**
 * Parse one state file, JSON or YAML.
 *
 * `parseReferencedFile` is the same function reference expansion uses, so a state and a fragment
 * are read by identical rules — including YAML's refusals (non-JSON values, alias cycles, duplicate
 * keys), which would otherwise be enforced in one place and not the other.
 */
export function readStateDocument(file: string): unknown {
  return parseReferencedFile(file, readFileSync(file, "utf8"));
}

export interface SnapshotRef {
  hash: string;
  dir: string;
  /** false when an identical snapshot already existed (deduplicated). */
  created: boolean;
}

export function ensureSnapshot(snapshotsDir: string, bundle: WorkflowBundle): SnapshotRef {
  const hash = snapshotHash(bundle);
  const dir = join(snapshotsDir, hash);
  if (existsSync(dir)) return { hash, dir, created: false };

  // Stage then rename, so a crash mid-write never leaves a half snapshot
  // behind under its final content-addressed name.
  const staging = join(snapshotsDir, `.staging-${hash}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const ids: Record<string, string> = {};
  for (const stateId of Object.keys(bundle.states)) {
    const relPath = snapshotFileFor(stateId);
    if (relPath !== stateId) ids[relPath] = stateId;
    // The RESOLVED state (see the module note), minus its `id` — which is the key this is stored
    // under, and which reload puts back.
    const { id: _id, ...resolved } = bundle.states[stateId]!;
    const file = join(staging, ...relPath.split("/")) + ".json";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(resolved, null, 2) + "\n", "utf8");
  }
  const meta: SnapshotMeta = {
    rootId: bundle.rootId,
    hash,
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
  };
  writeFileSync(join(staging, META_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");
  try {
    renameSync(staging, dir);
  } catch (e) {
    // Lost a race with a concurrent writer of the same content — fine.
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(dir)) throw e;
  }
  return { hash, dir, created: true };
}

/**
 * Load a pinned snapshot back into a bundle, verifying content addressing.
 *
 * DESERIALIZES rather than re-loading: the stored form is already the resolved definition, so there
 * is no loader to re-run, no reference to re-resolve, and therefore nothing about a pinned run that
 * can change when the loader does. That is the whole point of storing the output of definition
 * evaluation instead of its input — a pin fixes MEANING, not bytes.
 *
 * It also takes no options. Reference roots used to be needed so a `$JAIRA/…` child reference
 * resolved to the canonical id it validated under; there are no unresolved references left to
 * resolve.
 */
export function loadSnapshot(snapshotsDir: string, hash: string): WorkflowBundle {
  const dir = join(snapshotsDir, hash);
  const metaFile = join(dir, META_FILE);
  if (!existsSync(metaFile)) throw new Error(`snapshot '${hash}' not found under ${snapshotsDir}`);
  const meta = readJsonFile(metaFile) as SnapshotMeta;

  const states: Record<string, LoadedState> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === META_FILE) continue;
      const relPath = relative(dir, full).split(sep).join("/");
      // Key by the CANONICAL id, restoring an out-of-tree one from the meta map, and put the `id`
      // back on the state — it is stripped on write because it duplicates this key.
      const stem = relPath.replace(/\.json$/i, "");
      const id = meta.ids?.[stem] ?? stem;
      states[id] = { ...(readJsonFile(full) as Omit<LoadedState, "id">), id };
    }
  };
  walk(dir);

  const bundle: WorkflowBundle = { rootId: meta.rootId, states };
  const actual = snapshotHash(bundle);
  if (actual !== hash) {
    throw new Error(`snapshot '${hash}' is corrupt: contents hash to ${actual}`);
  }
  return bundle;
}

export { stateIdFromPath };
