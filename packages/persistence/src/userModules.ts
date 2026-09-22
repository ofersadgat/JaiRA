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
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
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

import { openDb } from "./db";
import { machineKey } from "./machineKey";
import { nodeVfs } from "./vfs";

/** Absolute, forward-slashed — the one spelling a hash, an approval and a require path agree on. */
export function canonicalModulePath(file: string): string {
  return resolvePath(file).replace(/\\/g, "/");
}

// --- The approval store -------------------------------------------------------

/**
 * The tag that turns a stored pair into a claim somebody made.
 *
 * Over the path AND the hash, separated by a byte that occurs in neither: tagging the hash alone
 * would let a valid row be moved to another path, which is exactly the substitution this exists to
 * stop — approve a harmless `notes.ts`, then point that approval at the module a workflow calls.
 *
 * Not a whole-table MAC, and that limit is worth stating rather than hiding: a row kept from before
 * a revoke still verifies if it is put back. Closing that needs a counter the store can trust, and
 * somewhere to keep it that the same attacker cannot roll back.
 */
function macOf(key: Buffer, path: string, hash: string): string {
  return createHmac("sha256", key).update(`${path}\u0000${hash}`).digest("hex");
}

/**
 * The machine-local record of what may run: the base database, one row per file, each signed.
 *
 * It was a JSON file, and the argument for that was real when it was written — an approval is keyed
 * by ABSOLUTE PATH and spans every project on the disk, so there is no one project's database it
 * could belong to. What changed is that the shared root became a project of its own: `~/.jaira` has
 * a database, it is machine-global, and it opens without any checkout. That is exactly the store
 * this needed, so the hand-rolled file — with its own read, its own atomic write and its own
 * corruption story — is gone.
 *
 * The MAC is the other half, and the reason is on {@link JairaBasePaths.machineKeyFile}: a row is a
 * claim about what a person agreed to, and a claim is worth only as much as what signs it. Writing
 * into the table is not the same as being approved.
 */
export interface Approvals extends ApprovalStore {
  /** Record this file's current bytes as approved. */
  approve(file: string, hash: string): void;
  /** Forget a file, so it is unknown again — and therefore unapproved. */
  revoke(file: string): void;
  /** Everything approved AND verified, for a UI that lists it. */
  all(): ReadonlyMap<string, string>;
  /**
   * Rows that are present but do not verify, for a caller that wants to say so.
   *
   * Separate from {@link all} rather than folded into it, because they are opposite facts: one is
   * what may run, and this is what something put in the table without the key. Reporting them
   * together would present an attempted forgery as an approval.
   */
  unverified(): readonly string[];
  close(): void;
}

/** What {@link approvalsIn} needs off a base root — the two paths, so a test can pass a scratch. */
export interface ApprovalPaths {
  dbFile: string;
  machineKeyFile: string;
}

/** Open the store against a base root. */
export function approvalsIn(base: ApprovalPaths): Approvals {
  // The directory, before the database. Creating the key used to do this on the way past, and the
  // key is lazy now — so without this a root that does not exist yet fails on `openDb` instead of
  // being created, which is the ordinary first-run path.
  mkdirSync(dirname(base.dbFile), { recursive: true });
  const db = openDb(base.dbFile);
  // LAZY, and memoized. Unwrapping costs a subprocess on Windows (see `machineKey`), and a root
  // with no js/ts function modules never asks a single approval question — so paying it at
  // construction would put a quarter-second on the start of every command for a feature most
  // projects do not use. Every path below that needs it goes through here.
  let cached: Buffer | undefined;
  const key = (): Buffer => (cached ??= machineKey(base.machineKeyFile));
  const rows = (): ApprovalRow[] => db.prepare(`SELECT path, hash, mac FROM module_approvals`).all() as ApprovalRow[];

  const put = db.prepare(
    `INSERT INTO module_approvals (path, hash, mac, approved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mac = excluded.mac, approved_at = excluded.approved_at`,
  );
  const write = (path: string, hash: string): void => {
    put.run(path, hash, macOf(key(), path, hash), Date.now());
  };

  /** The verified table, read fresh — another process may have approved something since. */
  const verified = (): Map<string, string> => {
    const out = new Map<string, string>();
    const all = rows();
    // The key is asked for only once there is something to verify. An empty table answers "nothing
    // is approved" whatever the key says, so a root with no js/ts modules never pays for unwrapping
    // one — and a machine whose key is unreadable still gets the correct answer here rather than an
    // error about a secret it was not using. The moment there IS a row, or anything is approved, the
    // key is required and an unreadable one is loud.
    if (all.length === 0) return out;
    const k = key();
    for (const row of all) {
      // A constant-time compare is not the property that matters here: the attacker writes the row
      // rather than probing our answer, so there is no timing oracle to close. What matters is that
      // a row failing this contributes NOTHING — it is not repaired, and it is not trusted.
      if (row.mac === macOf(k, row.path, row.hash)) out.set(row.path, row.hash);
    }
    return out;
  };

  return {
    approved: (f) => verified().get(canonicalModulePath(f)),
    approve: (f, hash) => write(canonicalModulePath(f), hash),
    revoke: (f) => {
      db.prepare(`DELETE FROM module_approvals WHERE path = ?`).run(canonicalModulePath(f));
    },
    all: () => verified(),
    unverified: () => {
      const all = rows();
      if (all.length === 0) return [];
      const k = key();
      return all.filter((row) => row.mac !== macOf(k, row.path, row.hash)).map((row) => row.path);
    },
    close: () => db.close(),
  };
}

interface ApprovalRow {
  path: string;
  hash: string;
  mac: string;
}

/**
 * Whether a module file is the app's OWN code — under the built-in layer (decision 0006) — and
 * therefore not something a person is asked to approve.
 *
 * The whole layer rather than its `functions/` alone: the decision names `$SYSTEM/functions` because
 * that is where a callee lives, but a shipped function that imports a helper from beside it would
 * otherwise put an approval prompt in front of somebody for code that came in the same installer.
 *
 * By LOCATION, and only by location. A person's `~/.jaira/functions/text.ts` that shadows a shipped
 * `text.ts` is a different file at a different path, so it is not under this directory and is gated
 * exactly as it always was; being a copy of trusted bytes does not make a file trusted, because the
 * next edit to it is nobody's but theirs.
 *
 * Compared on the canonical spelling with a trailing slash, so `…/builtin-evil/x.ts` is not "under"
 * `…/builtin`. Case-insensitive on Windows only, where the two spellings are
 * one directory — the same rule `sessionKey` follows.
 */
export function isBuiltInModule(file: string, builtInDir: string): boolean {
  const fold = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
  const root = `${fold(canonicalModulePath(builtInDir))}/`;
  return fold(canonicalModulePath(file)).startsWith(root);
}

/**
 * An approval store that answers YES for the built-in layer's modules and defers for everything else.
 *
 * The exemption is expressed as a store rather than as a branch at each gate because there are three
 * gates — the symbol index, the pending-approvals walk and the freeze — and two of them live
 * upstream, where the only seam is `ApprovalStore.approved`. Answering with the file's CURRENT hash
 * is what "exempt" means in that contract: whatever bytes ship are the bytes agreed to, so an app
 * upgrade that changes a built-in function does not put a prompt in front of anybody.
 *
 * A file that cannot be read has no current hash and is answered `undefined` — unapproved — which is
 * the conservative reading the rest of this module takes of "cannot tell".
 *
 * Only `approved` is widened. `all` and `unverified` still describe the PERSON's table: a settings
 * page listing what they agreed to run should not list code they were never asked about.
 */
export function trustingBuiltIn(approvals: Approvals, builtInDir: string, vfs: Vfs): Approvals {
  return {
    ...approvals,
    approved: (file) =>
      isBuiltInModule(file, builtInDir) ? currentHashOf(vfs, file) : approvals.approved(file),
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
  // A rebuild REPLACES the pair, so the store it is replacing has to be closed here — otherwise
  // every rebuild (an approval granted, a function file changed) leaves another open handle on the
  // base database for the life of the process.
  resetUserModules();
  // A FRESH vfs per build. `nodeVfs` caches listings for the life of one load, which is what makes a
  // single load self-consistent and what makes a process-wide one go stale — so a rebuild is the only
  // way a function file added after startup becomes visible, and it must not inherit the old cache.
  const vfs = nodeVfs();
  // Everything below asks THIS store, so the built-in layer's exemption (decision 0006) holds at all
  // three gates at once — the index, the pending walk and the freeze — rather than at whichever of
  // them somebody remembered.
  const approvals = trustingBuiltIn(approvalsIn(paths.base), paths.builtIn.dir, vfs);
  // The built-in layer's directories close the list whatever was configured, for the reason
  // `searchPathFor` gives: `workflows.path` replaces the generated list, and what ships is not
  // something a replacement may drop.
  const builtIn = workflowSearchPath([paths.builtIn.dir]).map(canonicalModulePath);
  const configured = (options.searchPath ?? workflowSearchPath(paths.roots)).map(canonicalModulePath);
  const searchPath = [...configured.filter((dir) => !builtIn.includes(dir)), ...builtIn];
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

/**
 * Drop the pair, closing the approval store's database handle.
 *
 * Closing is the half that is not optional. The store used to be a JSON file, so dropping the
 * reference was the whole of releasing it; it is a SQLite connection now, and an unclosed one keeps
 * the file locked — which on Windows means the directory it lives in cannot be removed. That is a
 * test's temp home failing to clean up, and it is also a long-running process holding the base
 * database open for no reason.
 */
export function resetUserModules(): void {
  current?.approvals.close();
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
  return [...new Set(userFunctionRefsOf(bundle).map((ref) => ref.file))].sort();
}

/** One `user:` reference a bundle makes, split back into the file and the symbol inside it. */
export interface UserFunctionRef {
  /** The registry key exactly as the lowered operation spells it — `user:<file>#<a.b>`. */
  ref: string;
  /** The module file, absolute and forward-slashed. */
  file: string;
  /** The dotted property path as segments — `confidence.score` is `["confidence", "score"]`. */
  property: string[];
}

/**
 * Every module FUNCTION this bundle calls, by reference, each once, in the order first met.
 *
 * The walk {@link moduleEntriesOf} always did, keeping the symbol instead of dropping it. Read off the
 * resolved states for the reason that function gives — the facade accumulates for the life of the
 * process, and this is about ONE bundle. Embedded bodies are skipped here as they are there: a body
 * is compiled from text the document carries, and re-resolving it takes that text, which a
 * reference does not hold.
 */
export function userFunctionRefsOf(bundle: WorkflowBundle): UserFunctionRef[] {
  const out = new Map<string, UserFunctionRef>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const ref = record.functionRef;
    if (typeof ref === "string" && ref.startsWith(USER_REF) && !out.has(ref)) {
      const withoutPrefix = ref.slice(USER_REF.length);
      const hash = withoutPrefix.indexOf("#");
      const file = hash < 0 ? withoutPrefix : withoutPrefix.slice(0, hash);
      const property = hash < 0 ? [] : withoutPrefix.slice(hash + 1).split(".").filter((part) => part.length > 0);
      if (file.length > 0 && !file.startsWith(BODY_PSEUDO_PATH)) out.set(ref, { ref, file, property });
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(bundle.states);
  return [...out.values()];
}

/**
 * Make the facade hold an entry for every module function this bundle names.
 *
 * `UserFunctions.entries` is filled by RESOLUTION — the loader asking for `confidence.score` while it
 * lowers a binding — and a run does not always load. A task pinned to a snapshot reads the resolved
 * definition back and resolves nothing, and a pair rebuilt after an approval starts with nothing in
 * it; either way a host that merges `entries` into its registry merges an empty map, and the run fails
 * at the first call with "no function is registered" about a function that is approved, frozen and
 * sitting in the snapshot. Seen live on a re-run of an already-pinned task. So a host asks for each
 * reference by name before it merges, which is the same resolution the loader would have done —
 * type-checked, cached per reference, executing nothing (SPEC §7.5.4) — and idempotent where a load
 * already did it.
 *
 * Returns how many references were resolved. Throws where the loader would have: a module that no
 * longer reads or types is a run that cannot start, and the message names the file.
 */
export function resolveUserFunctions(modules: UserModules, bundle: WorkflowBundle): number {
  const refs = userFunctionRefsOf(bundle);
  for (const { file, property } of refs) modules.userFunctions.operationFor(file, property);
  return refs.length;
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
