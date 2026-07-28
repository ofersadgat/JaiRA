/**
 * Workflow snapshots — `.jaira/snapshots/<hash>/` (DESIGN §5.3, SPEC §12).
 *
 * At task start the transitive closure of state files (a `WorkflowBundle`) is
 * copied into a directory named by its `@declarative-ai/hw` snapshotHash.
 * Directories are content-addressed and immutable: identical workflow versions
 * across tasks share one snapshot. Execution always reads from the snapshot,
 * never from live `workflows/`.
 *
 * What gets written is the bundle's `source` — the states **as authored**, before
 * the loader desugars binding sugar into base refs. That is deliberate and
 * load-bearing: `snapshotHash` is the identity of what the author wrote, so
 * writing the desugared form would both change the hash and freeze today's
 * lowering into stored snapshots. Files are written without the (possibly
 * loader-derived) `id` field — `snapshotHash` ignores `id` and reloading derives
 * it from the path, so the written form round-trips to the same hash.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { loadBundle, snapshotHash, stateIdFromPath, type WorkflowBundle } from "@declarative-ai/hw";
import { readJsonFile } from "@jaira/shared";

const META_FILE = ".meta.json";

interface SnapshotMeta {
  rootId: string;
  hash: string;
}

function assertSafeStateId(stateId: string): void {
  if (stateId.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`state id '${stateId}' is not a safe relative path`);
  }
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

/** Read every `*.json` under a workflows dir as loader input (relPath → parsed JSON). */
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
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const rel = relative(workflowsDir, full);
      if (options.onError === undefined) {
        files[rel] = readJsonFile(full);
        continue;
      }
      try {
        files[rel] = readJsonFile(full);
      } catch (e) {
        options.onError(rel, (e as Error).message);
      }
    }
  };
  walk(workflowsDir);
  return files;
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
  // The AUTHORED states (see the module note) — `source` is present on every
  // bundle `loadBundle` produces; the desugared `states` are the fallback only
  // for a hand-built bundle.
  for (const stateId of Object.keys(bundle.states)) {
    assertSafeStateId(stateId);
    const def = bundle.source?.[stateId] ?? bundle.states[stateId]!;
    const { id: _id, ...authored } = def;
    const file = join(staging, ...stateId.split("/")) + ".json";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(authored, null, 2) + "\n", "utf8");
  }
  const meta: SnapshotMeta = { rootId: bundle.rootId, hash };
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

/** Load a pinned snapshot back into a bundle, verifying content addressing. */
export function loadSnapshot(snapshotsDir: string, hash: string): WorkflowBundle {
  const dir = join(snapshotsDir, hash);
  const metaFile = join(dir, META_FILE);
  if (!existsSync(metaFile)) throw new Error(`snapshot '${hash}' not found under ${snapshotsDir}`);
  const meta = readJsonFile(metaFile) as SnapshotMeta;

  const files: Record<string, unknown> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== META_FILE) {
        files[relative(dir, full).split(sep).join("/")] = readJsonFile(full);
      }
    }
  };
  walk(dir);

  const bundle = loadBundle(files, meta.rootId);
  const actual = snapshotHash(bundle);
  if (actual !== hash) {
    throw new Error(`snapshot '${hash}' is corrupt: contents hash to ${actual}`);
  }
  return bundle;
}

export { stateIdFromPath };
