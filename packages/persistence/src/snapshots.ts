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
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isBareStateId, parseReferencedFile, snapshotHash, stateIdFromPath, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import { readJsonFile } from "@jaira/shared";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.snapshots");

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
  /**
   * The one value standing for every js/ts module this workflow reaches (SPEC §7.5.5).
   *
   * Stored because the snapshot hash is computed over it: a module reached by NAME is the one
   * reference the resolved form does not inline, so without this a task pinned to a snapshot could
   * run edited code under an unchanged version. Reload puts it back on the bundle, and the hash
   * check that follows is what proves it round-tripped.
   *
   * Absent for a workflow that reaches no module, and absent is not empty — the key is left out of
   * the hashed document entirely, so every snapshot taken before modules existed keeps its identity.
   */
  moduleDigest?: string;
  /**
   * Source path → the file inside `_modules/` holding its TRANSPILED output.
   *
   * Copying the emit rather than the source is what makes a frozen run actually frozen. A stored
   * hash can only detect drift and refuse; it cannot execute the version that was approved. It also
   * removes the compiler from replay, so a later toolchain upgrade cannot change what a pinned run
   * does.
   */
  modules?: Record<string, string>;
}

/** Where a frozen module's emitted CommonJS lives inside a snapshot. */
const MODULES_DIR = "_modules";

function assertSafeStateId(stateId: string): void {
  if (stateId.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw refusal(log, `state id '${stateId}' is not a safe relative path`);
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

export interface EnsureSnapshotOptions {
  /**
   * The frozen module half: source path → emitted CommonJS (SPEC §7.5.5).
   *
   * The caller has already folded `FrozenModules.digest` into `bundle.moduleDigest`, so the hash
   * these files are stored under already accounts for them. Passing the emit without the digest
   * would store code the identity does not cover, which is the failure this exists to prevent.
   */
  modules?: ReadonlyMap<string, string>;
  /**
   * The rename {@link commitStaging} retries, for tests only.
   *
   * A seam rather than a mock because the failure it guards against cannot be provoked on the
   * platform CI runs: the retry exists for a Windows rule about open handles, and a POSIX box will
   * rename a staged directory on the first try every time. Injecting the call is the only way the
   * loop is executed anywhere but the machine that reported the bug.
   */
  rename?: (from: string, to: string) => void;
}

/**
 * Delay before each retry of the rename below, in ms — five attempts across roughly a third of a
 * second, which is long enough to outlast a scanner holding a handful of small JSON files and short
 * enough that a genuinely stuck rename still reports promptly.
 */
const COMMIT_BACKOFF_MS = [20, 40, 80, 160] as const;

/**
 * Throw away a staging directory, tolerating the same handles that make the rename fail.
 *
 * `force` alone suppresses a missing path, not a busy one: node only retries EBUSY/EPERM/ENOTEMPTY
 * when asked, and without that this cleanup can throw over the error it is cleaning up after —
 * replacing a diagnosis with a complaint about a temp directory.
 */
function discardStaging(staging: string): void {
  rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

/**
 * Publish a staged snapshot under its content-addressed name, retrying a rename that Windows
 * refuses.
 *
 * Renaming a DIRECTORY on Windows fails with EPERM while any handle is open on a file inside it,
 * and every file inside this one was written microseconds ago — which is exactly what a virus
 * scanner or the search indexer opens. The failure is therefore specific to a snapshot being
 * CREATED, not to a machine being busy: an existing snapshot takes the early return in
 * {@link ensureSnapshot} and never renames at all, so a task that started fine yesterday can fail
 * today on the first workflow it has not seen before. Nothing is wrong with what was written and
 * nothing about the write needs to change — the handles close on their own, so the answer is to
 * ask again.
 *
 * `existsSync(dir)` is re-checked BETWEEN attempts rather than only after the last one. That is the
 * concurrent-writer case — a second process staging identical content, which is the whole reason
 * this is content-addressed — and that writer's rename can land at any point during the backoff.
 * Checking once at the end would still be correct, but would sit out the remaining delays waiting to
 * discover work that is already done.
 */
async function commitStaging(staging: string, dir: string, rename: (from: string, to: string) => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(staging, dir);
      return;
    } catch (e) {
      // Lost a race with a concurrent writer of the same content — fine. Immutable and
      // content-addressed means their directory and ours are the same directory.
      if (existsSync(dir)) {
        discardStaging(staging);
        return;
      }
      const backoff = COMMIT_BACKOFF_MS[attempt];
      if (backoff === undefined) {
        discardStaging(staging);
        throw e;
      }
      log.debug(`snapshot rename failed, retrying in ${backoff}ms: ${(e as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

/**
 * Async only for the backoff in {@link commitStaging} — everything this does with the filesystem
 * is still synchronous, and deliberately so: a snapshot is written in one uninterrupted stretch,
 * which is what makes two starts in one process serialize rather than interleave over a staging path
 * they share. The one `await` is on the retry path, where the process has nothing better to do than
 * wait for somebody else to close a file.
 */
export async function ensureSnapshot(
  snapshotsDir: string,
  bundle: WorkflowBundle,
  options: EnsureSnapshotOptions = {},
): Promise<SnapshotRef> {
  const hash = snapshotHash(bundle);
  const dir = join(snapshotsDir, hash);
  if (existsSync(dir)) return { hash, dir, created: false };

  // Stage then rename, so a crash mid-write never leaves a half snapshot
  // behind under its final content-addressed name.
  const staging = join(snapshotsDir, `.staging-${hash}-${process.pid}`);
  discardStaging(staging);
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
  // The frozen modules, under content-derived names for the same reason an out-of-tree state id is:
  // a source path is absolute and machine-specific, and a snapshot must stay a self-contained
  // directory that means the same thing wherever it is read.
  const modules: Record<string, string> = {};
  for (const [source, emitted] of options.modules ?? []) {
    const name = `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.cjs`;
    modules[source] = name;
    const file = join(staging, MODULES_DIR, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, emitted, "utf8");
  }
  const meta: SnapshotMeta = {
    rootId: bundle.rootId,
    hash,
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
    ...(bundle.moduleDigest !== undefined ? { moduleDigest: bundle.moduleDigest } : {}),
    ...(Object.keys(modules).length > 0 ? { modules } : {}),
  };
  writeFileSync(join(staging, META_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");
  await commitStaging(staging, dir, options.rename ?? renameSync);
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
  if (!existsSync(metaFile)) throw refusal(log, `snapshot '${hash}' not found under ${snapshotsDir}`);
  const meta = readJsonFile(metaFile) as SnapshotMeta;

  const states: Record<string, LoadedState> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        // The frozen module emit is not a state file. Skipped by name rather than left to the
        // `.json` test below, so a `.cjs` that ever gained a `.json` sibling could not be read back
        // as a state.
        if (d === dir && entry.name === MODULES_DIR) continue;
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

  // The module digest is part of the identity, so it has to be back on the bundle BEFORE the check
  // below — a pinned run whose digest went missing would hash to something else and read as corrupt.
  const bundle: WorkflowBundle = {
    rootId: meta.rootId,
    states,
    ...(meta.moduleDigest !== undefined ? { moduleDigest: meta.moduleDigest } : {}),
  };
  const actual = snapshotHash(bundle);
  if (actual !== hash) {
    throw refusal(log, `snapshot '${hash}' is corrupt: contents hash to ${actual}`);
  }
  return bundle;
}

/**
 * The frozen module emit stored with a snapshot — source path → emitted CommonJS.
 *
 * What a RESUMED run executes. SPEC §7.5.5: a run whose frozen copies no longer match the files on
 * disk still executes the frozen copies, and reports drift; the choice that offers — continue the
 * old run, or start a new one against the current code — belongs to the user, so drift surfaces as a
 * decision rather than as a silent re-compile.
 */
export function snapshotModules(snapshotsDir: string, hash: string): Map<string, string> {
  const dir = join(snapshotsDir, hash);
  const metaFile = join(dir, META_FILE);
  if (!existsSync(metaFile)) return new Map();
  const meta = readJsonFile(metaFile) as SnapshotMeta;
  const out = new Map<string, string>();
  for (const [source, name] of Object.entries(meta.modules ?? {})) {
    const file = join(dir, MODULES_DIR, name);
    if (existsSync(file)) out.set(source, readFileSync(file, "utf8"));
  }
  return out;
}

export { stateIdFromPath };
