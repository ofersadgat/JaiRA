/**
 * js/ts function modules: what may contribute, what has been approved, and what a run is frozen to
 * (SPEC §7.5.5).
 *
 * A workflow can call a TypeScript function by bare name — `confidence.score(.inputs.rank)` — and hw
 * supplies every mechanism that makes it work: a symbol index over the search path, a signature read
 * out of the parameter list, hashing, and a freeze. What hw deliberately does NOT supply is the
 * policy: `ModuleIndexOptions.approved` and `DiscoverOptions.approvals` are seams, and this module is
 * JaiRA's answer to them.
 *
 * ## Why the two factories are built once and read synchronously
 *
 * `createSymbolIndex` and `createUserFunctions` are async exactly once — they await the TypeScript
 * compiler — and synchronous forever after. That shape is not an optimization, it is what lets a
 * SYNC `loadBundle` consult them, and `loadBundle` is called from `browseWorkflows`, the pre-run
 * gate, the digest and the app's views, none of which are async. So the pair is built at process
 * start and stashed here, and `workflowLoadOptions` reads it without awaiting anything.
 *
 * A process that never calls {@link prepareUserModules} gets the behavior that predates the feature:
 * no module contributes any symbol, and a `.ts` callee is an authoring error rather than something
 * that silently half-works.
 *
 * ## An unknown file is an unapproved file
 *
 * The strong form, and the reason it is strong: a NEW file earlier on the search path changes which
 * module a symbol resolves to without modifying anything that already existed. "Known files must
 * match" does not cover that; only "unknown means unapproved" does. So {@link approvalsFor} answers
 * `undefined` for a file it has never seen, and both the index and the freeze treat that as no.
 *
 * ## Where the gate sits, and where it does not
 *
 * Resolving and type-checking READ files; running them is a decision somebody has to have made.
 * hw draws that line at `UserFunctions.prepare()`, and this module keeps it: the symbol index is
 * gated (an unapproved file contributes nothing, so it cannot capture a name), lint runs freely over
 * whatever is approved, and the hard refusal happens once, at task start, in {@link freezeForRun}.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import {
  createSymbolIndex,
  createUserFunctions,
  freezeModules,
  moduleHash,
  pendingApprovals,
  requirePathFor,
  type ApprovalStore,
  type FrozenModules,
  type PendingApproval,
  type SymbolIndex,
  type UserFunctions,
  type Vfs,
  type WorkflowBundle,
} from "@declarative-ai/hw";
import { workflowSearchPath, type JairaPaths } from "@jaira/shared";

import { nodeVfs } from "./vfs";

/** Absolute, forward-slashed — the one spelling a hash, an approval and a require path agree on. */
export function canonicalModulePath(file: string): string {
  return resolvePath(file).replace(/\\/g, "/");
}

// --- The approval store -------------------------------------------------------

interface ApprovalFile {
  /** Absolute path → the approved content hash of that file's SOURCE. */
  approved: Record<string, string>;
}

/**
 * The machine-local record of what may run, backed by one JSON file.
 *
 * A plain file rather than a table in the database, for the same reason `sync.json` is one: it is
 * read before any project is open — the symbol index is built at process start, ahead of knowing
 * which project this is — and it spans every project on the disk rather than belonging to one.
 */
export interface Approvals extends ApprovalStore {
  /** Record this file's current bytes as approved. */
  approve(file: string, hash: string): void;
  /** Forget a file, so it is unknown again — and therefore unapproved. */
  revoke(file: string): void;
  /** Everything approved, for a UI that lists it. */
  all(): ReadonlyMap<string, string>;
}

export function approvalsFor(file: string): Approvals {
  let table: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ApprovalFile;
      if (parsed && typeof parsed === "object" && parsed.approved && typeof parsed.approved === "object") {
        table = { ...parsed.approved };
      }
    } catch {
      // A corrupt store is an EMPTY store, never a permissive one: the failure mode of guessing here
      // is running unapproved code, so the safe reading of "cannot tell" is "nothing is approved".
      table = {};
    }
  }
  const flush = (): void => {
    mkdirSync(dirname(file), { recursive: true });
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify({ approved: table } satisfies ApprovalFile, null, 2) + "\n", "utf8");
    renameSync(staging, file);
  };
  return {
    approved: (f) => table[canonicalModulePath(f)],
    approve: (f, hash) => {
      table[canonicalModulePath(f)] = hash;
      flush();
    },
    revoke: (f) => {
      delete table[canonicalModulePath(f)];
      flush();
    },
    all: () => new Map(Object.entries(table)),
  };
}

// --- The process-wide pair ----------------------------------------------------

export interface UserModules {
  symbols: SymbolIndex;
  userFunctions: UserFunctions;
  approvals: Approvals;
  /** The require path modules resolve each other along — the search path plus its `node_modules`. */
  requirePath: readonly string[];
  vfs: Vfs;
}

let current: UserModules | undefined;

/**
 * Build the index and the compiler once, for this process.
 *
 * Idempotent by design rather than by accident: the CLI awaits it before dispatching a command and
 * the app awaits it at startup, and a second call from a test harness must not build a second
 * compiler with a different approval store behind it.
 */
export async function prepareUserModules(paths: JairaPaths, options: PrepareUserModulesOptions = {}): Promise<UserModules> {
  if (current !== undefined && options.rebuild !== true) return current;
  // A FRESH vfs per build. `nodeVfs` caches listings for the life of one load, which is what makes a
  // single load self-consistent and what makes a process-wide one go stale — so a rebuild is the only
  // way a function file added after startup becomes visible, and it must not inherit the old cache.
  const vfs = nodeVfs();
  const approvals = approvalsFor(paths.base.approvalsFile);
  const searchPath = (options.searchPath ?? workflowSearchPath(paths.roots)).map(canonicalModulePath);
  const requirePath = requirePathFor(searchPath);
  const symbols = await createSymbolIndex({
    vfs,
    // The gate, at the only place it can be applied without lying about resolution: an unapproved
    // file contributes NO symbol, so it cannot capture a name a later approved file would answer.
    //
    // Both `undefined`s are refusals and neither may cancel the other: a file that has never been
    // approved has no stored hash, and one that cannot be read has no current hash. Comparing them
    // directly would make an unreadable, never-approved file compare EQUAL and contribute.
    approved: (file) => {
      const stored = approvals.approved(file);
      if (stored === undefined) return false;
      const actual = currentHashOf(vfs, file);
      return actual !== undefined && actual === stored;
    },
    cache: new Map(),
  });
  const userFunctions = await createUserFunctions({ vfs, requirePath });
  current = { symbols, userFunctions, approvals, requirePath, vfs };
  return current;
}

export interface PrepareUserModulesOptions {
  searchPath?: readonly string[];
  /**
   * Build again even if this process already has a pair.
   *
   * What the app calls after an approval is granted or a function file changes. The index reads each
   * directory once and the compiler caches its emit, so nothing short of a rebuild notices a new
   * file — and a long-running process that never rebuilt would answer for the disk as it was at
   * startup.
   */
  rebuild?: boolean;
}

/** The pair, if this process built it. Sync, because `workflowLoadOptions` is. */
export function userModules(): UserModules | undefined {
  return current;
}

/** Drop the pair — tests only, so one suite's approval store does not leak into the next. */
export function resetUserModules(): void {
  current = undefined;
}

/** The hash of what is on disk now, or `undefined` if it cannot be read. */
function currentHashOf(vfs: Vfs, file: string): string | undefined {
  const source = vfs.read(file);
  return source === undefined ? undefined : moduleHash(source);
}

// --- Which modules a bundle actually reaches ----------------------------------

/** The prefix `userFunctionRef` gives every resolved module symbol. */
const USER_REF = "user:";
/** An embedded body's pseudo-path — a module with no file behind it. */
const BODY_PSEUDO_PATH = "<body>/";

/**
 * The module FILES this bundle calls into, as absolute paths.
 *
 * Read off the resolved states rather than off `UserFunctions.entries`, and the difference matters:
 * the facade accumulates every symbol resolved for the life of the process, so a second workflow
 * loaded in the same app would be frozen against the first one's modules as well as its own.
 *
 * An EMBEDDED body is deliberately excluded. Its pseudo-path names no file to hash, and it needs
 * none: the body is part of the document, so it is inlined into the resolved state and already
 * inside the snapshot hash (SPEC §7.5.1).
 */
export function moduleEntriesOf(bundle: WorkflowBundle): string[] {
  const files = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const ref = record.functionRef;
    if (typeof ref === "string" && ref.startsWith(USER_REF)) {
      const withoutPrefix = ref.slice(USER_REF.length);
      const file = withoutPrefix.split("#")[0] ?? "";
      if (file.length > 0 && !file.startsWith(BODY_PSEUDO_PATH)) files.add(file);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(bundle.states);
  return [...files].sort();
}

// --- Approval and the freeze --------------------------------------------------

export type { PendingApproval } from "@declarative-ai/hw";

/**
 * What a workflow reaches that has not been agreed to.
 *
 * Runs the closure walk with no gate — which is safe because preparing does not execute anything —
 * so the answer covers a module's imports as well as the module a state names.
 */
export async function approvalsPending(modules: UserModules, entries: readonly string[]): Promise<PendingApproval[]> {
  return pendingApprovals(entries.map(canonicalModulePath), {
    vfs: modules.vfs,
    requirePath: modules.requirePath,
    approvals: modules.approvals,
  });
}

/**
 * Freeze every module this run reaches, refusing before anything executes if one is unapproved.
 *
 * An error and not a prompt, deliberately: a run is not the moment to be deciding what code to
 * trust. The caller's job is to have asked first — {@link approvalsPending} is how.
 */
export async function freezeForRun(modules: UserModules, entries: readonly string[]): Promise<FrozenModules> {
  return freezeModules(entries.map(canonicalModulePath), {
    vfs: modules.vfs,
    requirePath: modules.requirePath,
    approvals: modules.approvals,
  });
}
