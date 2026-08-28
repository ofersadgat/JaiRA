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
import { workflowSearchPath, type ModuleApproval, type JairaPaths } from "@jaira/shared";

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
 * A plain file rather than a table in the database, and the reason is its own rather than shared
 * with `sync.json` as this used to claim: an approval is keyed by ABSOLUTE PATH and spans every
 * project on the disk, so there is no one project's database it could belong to. It is also read
 * before any project is open — the symbol index is built at process start, ahead of knowing which
 * project this is. Neither of those is true of `sync.json`, which is per-layer and read from an
 * open session like anything else.
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
  /**
   * The same index with NO approval gate — for diagnosis, never for resolution.
   *
   * Building it executes nothing (§7.5.4): it parses declarations to learn which file WOULD supply a
   * symbol. That is the one question the gated index structurally cannot answer, and without it an
   * unapproved module is indistinguishable from a typo — see {@link watchingForUnapproved}.
   */
  openSymbols: SymbolIndex;
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
  // ONE parse cache behind both indexes. Named off the option rather than off a `SymbolTable` import
  // because hw does not re-export that type — and a cache is exactly the thing that must not be two
  // maps, since the gated and ungated indexes read the very same files.
  const cache: NonNullable<Parameters<typeof createSymbolIndex>[0]["cache"]> = new Map();
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
    cache,
  });
  // Shares `cache` with the gated index above, keyed by content hash, so the second index re-reads
  // directory listings but never re-parses a module. Building it is not a hole in the gate: an index
  // records what a file DECLARES, and resolution still asks `symbols`, which refuses.
  const openSymbols = await createSymbolIndex({ vfs, cache });
  const userFunctions = await createUserFunctions({ vfs, requirePath });
  current = { symbols, openSymbols, userFunctions, approvals, requirePath, vfs };
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

// --- Telling an unapproved module apart from a typo ---------------------------

/** A symbol a load ASKED FOR and the gate withheld, with the file that would have answered it. */
export interface WithheldSymbol {
  /** The dotted name as the expression wrote it — `confidence.score`. */
  symbol: string;
  /** The file that declares it, which is the file awaiting a decision. */
  file: string;
}

/** Watches one load, and answers what the approval gate cost it. */
export interface UnapprovedWatch {
  /** The index to hand the loader in place of the gated one. */
  symbols: SymbolIndex;
  /** What was withheld and never resolved anywhere else. Read after the load, however it ended. */
  withheld(): WithheldSymbol[];
}

/**
 * Wrap the gated index so one load records what the gate cost it.
 *
 * The problem this solves is the one that makes the feature necessary at all. An unapproved module
 * contributes no symbol, so `confidence.score` resolves to nothing, so the expression fails to lower
 * and the whole bundle fails to LOAD — which means there is no bundle to walk and
 * {@link moduleEntriesOf} has nothing to report. The load has to say what it wanted while it is
 * failing, because afterwards nobody can reconstruct it.
 *
 * ## Two ways to be wrong, and what rules them out
 *
 * **A typo must not become an approval prompt.** A name missing from BOTH indexes is left alone to
 * fail as one; only a name the ungated index can place is recorded. `confidence.nope` stays "not a
 * known operation"; `confidence.score` becomes a file to approve.
 *
 * **A miss is not a failure.** Resolution walks the search path directory by directory, so missing
 * in the first is the ORDINARY way of finding something in the second — and an unapproved
 * `$PROJECT/functions/text.ts` shadowed by an approved `$BASE/functions/text.ts` would otherwise be
 * reported as blocking a load it did not block. So hits are tracked alongside misses and subtracted
 * at the end: a symbol that resolved anywhere resolved.
 *
 * The gated answer is returned UNCHANGED in every case. This observes resolution, it does not
 * participate in it — nothing here can make an unapproved symbol resolve.
 */
export function watchingForUnapproved(modules: UserModules): UnapprovedWatch {
  const missed = new Map<string, string>();
  const resolved = new Set<string>();
  return {
    symbols: (dir, symbol) => {
      const name = symbol.join(".");
      const gated = modules.symbols(dir, symbol);
      if (gated.found) {
        resolved.add(name);
        return gated;
      }
      if (!missed.has(name)) {
        const open = modules.openSymbols(dir, symbol);
        if (open.found) missed.set(name, canonicalModulePath(open.file));
      }
      return gated;
    },
    withheld: () =>
      [...missed]
        .filter(([name]) => !resolved.has(name))
        .map(([symbol, file]) => ({ symbol, file }))
        .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
  };
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
 * The withheld symbols alone, as approvals — no closure walk, and therefore SYNCHRONOUS.
 *
 * For the lint surface, which is sync all the way down to an IPC handler and would have to become
 * async to reach {@link moduleApprovalsFor}. What it gives up is a module's own imports: a file
 * reached only by `import` of a withheld file is not listed here. That is the honest boundary for
 * lint — it reports the files this workflow NAMES — and the run gate, which is async anyway, walks
 * the rest before anybody is asked to answer.
 */
export function withheldApprovalsOf(modules: UserModules, withheld: readonly WithheldSymbol[]): ModuleApproval[] {
  const byFile = new Map<string, Set<string>>();
  for (const { file, symbol } of withheld) {
    const canonical = canonicalModulePath(file);
    const known = byFile.get(canonical) ?? new Set<string>();
    known.add(symbol);
    byFile.set(canonical, known);
  }
  const out: ModuleApproval[] = [];
  for (const [file, symbols] of [...byFile].sort()) {
    const source = modules.vfs.read(file);
    // A file the index placed but the vfs cannot re-read has been deleted mid-lint. Dropping it is
    // right: there is nothing left to approve, and the load error it caused is now the true answer.
    if (source === undefined) continue;
    const previousHash = modules.approvals.approved(file);
    out.push({
      file,
      hash: moduleHash(source),
      source,
      ...(previousHash !== undefined ? { previousHash } : {}),
      symbols: [...symbols].sort(),
    });
  }
  return out;
}

/**
 * Everything a person would have to agree to before this workflow could run, as a prompt sees it.
 *
 * Takes both halves because the two ways a workflow reaches an unapproved module produce different
 * evidence and neither covers the other:
 *
 *  - `entries` are the files a LOADED bundle names, from {@link moduleEntriesOf}. Available only
 *    when the bundle loaded, which it does when the module is approved and one of its imports is not.
 *  - `withheld` is what {@link watchingForUnapproved} caught during a load that FAILED. Available
 *    only when it failed, which is the ordinary case of a module nobody has approved yet.
 *
 * Either way the closure walk runs over the union, so an import two files deep is on the list before
 * anybody is asked rather than after they answer the first prompt.
 */
export async function moduleApprovalsFor(
  modules: UserModules,
  entries: readonly string[],
  withheld: readonly WithheldSymbol[] = [],
): Promise<ModuleApproval[]> {
  const calls = new Map<string, Set<string>>();
  for (const { file, symbol } of withheld) {
    const canonical = canonicalModulePath(file);
    const known = calls.get(canonical) ?? new Set<string>();
    known.add(symbol);
    calls.set(canonical, known);
  }
  const roots = [...new Set([...entries.map(canonicalModulePath), ...calls.keys()])];
  if (roots.length === 0) return [];
  const pending = await approvalsPending(modules, roots);
  return pending
    .map((entry): ModuleApproval => {
      const symbols = [...(calls.get(canonicalModulePath(entry.file)) ?? [])].sort();
      return {
        file: canonicalModulePath(entry.file),
        hash: entry.hash,
        source: entry.source,
        ...(entry.previousHash !== undefined ? { previousHash: entry.previousHash } : {}),
        // Omitted rather than empty where nothing named it: a file reached only as an import has no
        // call site, and an empty array reads as "called with no symbols", which is not the same.
        ...(symbols.length > 0 ? { symbols } : {}),
      };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
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
