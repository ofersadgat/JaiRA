/**
 * The two producers of a changeset (CHANGESETS.md), and drift detection.
 *
 * Both things JaiRA has that make changes a person must read — an agent's worktree edits, a sync's
 * proposed state files — lower into the ONE value the reviewer takes ([shared
 * `changeset.ts`](../../shared/src/changeset.ts)):
 *
 *  - {@link worktreeChangeset} reads `git diff` against a pinned base commit; `source` is
 *    `git:<sha>` — the base a worktree diff is taken against (§2), immutable, so the record of the
 *    review stays meaningful after the worktree moves.
 *  - {@link editsChangeset} lowers whole-file proposals (the sync's `EDITS_SCHEMA` shape — complete
 *    files, because models cannot count line numbers, §11) into changes whose `before` is the tree
 *    as it stands; `source` is `file:<root>#sha256=…` — verifiable, not resolvable (§2): the hash
 *    detects drift but cannot recover the content once the tree moves.
 *
 * {@link changesetDrift} is §3.2: the base can move between a changeset being produced and a person
 * reviewing it. When it does, the answer is ANOTHER changeset — from the stored base to what is
 * actually there now — presented alongside the pending one, never silently rebased under it.
 */
import { createHash } from "node:crypto";
import {
  changesetOf,
  diffStrategyFor,
  formatChangesetSource,
  mimeOfPath,
  parseChangesetSource,
  type Change,
  type ChangeAction,
  type Changeset,
  type TreeState,
} from "@jaira/shared";
import type { GitRead } from "./git";

/** How the producer reads the AFTER side (the worktree) or the current tree. Absent file ⇒ undefined. */
export type FileReader = (path: string) => Promise<string | undefined> | string | undefined;

/** Text with a NUL is not text; such a change is carried but cannot be shown (§1.1). */
const looksBinary = (text: string | undefined): boolean => text !== undefined && text.includes("\0");

let nextChangeId = 0;
const changeIds = (): (() => string) => {
  nextChangeId = 0;
  return () => `c${++nextChangeId}`;
};

/** Derive hunks for a change that has both sides, through the mime-keyed strategy registry (§7.1). */
function withHunks(change: Change): Change {
  if (change.unshowable !== undefined) return change;
  if (change.before === undefined || change.after === undefined) return change;
  const strategy = diffStrategyFor(mimeOfPath(change.path));
  return { ...change, hunks: strategy.hunks(change.before, change.after) };
}

/**
 * A worktree's edits against the commit its task started from — producer one.
 *
 * `read` supplies the AFTER side from the working directory; git supplies the BEFORE side from the
 * pinned base, which is what makes the changeset recomputable after the worktree is gone once its
 * record is stored (§5.3 — and it is the record that pins it, not this function).
 */
export async function worktreeChangeset(git: GitRead, base: string, read: FileReader): Promise<Changeset> {
  const resolved = await git.revParse(base);
  if (resolved === undefined) throw new Error(`'${base}' does not resolve in this repository`);
  const id = changeIds();
  const changes: Change[] = [];
  // `.jaira/` is JaiRA's own bookkeeping — task files, the run database, its WAL — not the work
  // under review. Left in, every review would drag the recorder's own writes into the diff, and a
  // "clean" worktree would never read as clean.
  const bookkeeping = (path: string): boolean => path === ".jaira" || path.startsWith(".jaira/");
  for (const entry of (await git.diff(resolved)).filter((e) => !bookkeeping(e.path) && !bookkeeping(e.oldPath ?? e.path))) {
    const beforePath = entry.oldPath ?? entry.path;
    const before = entry.action === "create" ? undefined : await git.show(resolved, beforePath);
    const after = entry.action === "delete" ? undefined : await read(entry.path);
    const change: Change = {
      id: id(),
      path: entry.path,
      action: entry.action,
      ...(entry.oldPath !== undefined ? { fromPath: entry.oldPath } : {}),
      // Carried whenever git reported a BLOB-mode flip, not only for `chmod` actions: an update
      // that also turns a script executable is one change, and applying its content without its
      // mode would merge half of it. A create's 000000→100644 is not a flip — it is a file coming
      // to exist — so it carries nothing.
      ...(entry.modes.before !== entry.modes.after && /^100/.test(entry.modes.before) && /^100/.test(entry.modes.after)
        ? { modes: entry.modes }
        : {}),
    };
    if (looksBinary(before) || looksBinary(after)) {
      change.unshowable = "binary content cannot be shown; the change can still be approved or denied";
    } else {
      if (before !== undefined) change.before = before;
      if (after !== undefined) change.after = after;
    }
    changes.push(withHunks(change));
  }
  return { source: formatChangesetSource({ scheme: "git", rev: resolved }), changes };
}

/** One whole-file proposal — the shape a sync's edits arrive in (complete files, §11). */
export interface ProposedEdit {
  /** Layer-root-relative path, forward slashes. */
  path: string;
  action: "create" | "update" | "delete";
  /** The complete proposed file. Absent for delete. */
  text?: string;
  /** Why, in the producer's words. */
  reason?: string;
}

/**
 * Whole-file proposals against the tree as it stands — producer two.
 *
 * The source pins the BEFORE side by content hash: sha-256 over each touched path and the bytes it
 * held, so a later application can verify nothing moved underneath the review (§2's `file:` row).
 */
export async function editsChangeset(root: string, edits: readonly ProposedEdit[], read: FileReader): Promise<Changeset> {
  const id = changeIds();
  const hash = createHash("sha256");
  const changes: Change[] = [];
  for (const edit of [...edits].sort((a, b) => a.path.localeCompare(b.path))) {
    const before = await read(edit.path);
    hash.update(edit.path);
    hash.update("\0");
    hash.update(before ?? "\0absent");
    hash.update("\0");
    // The producer said `update` but nothing is there (or `create` over something): believe the
    // TREE, not the claim — the action is what the application step will take whole.
    const action: ChangeAction = edit.action === "delete" ? "delete" : before === undefined ? "create" : "update";
    const change: Change = {
      id: id(),
      path: edit.path,
      action,
      ...(before !== undefined ? { before } : {}),
      ...(edit.text !== undefined && action !== "delete" ? { after: edit.text } : {}),
      ...(edit.reason !== undefined ? { reason: edit.reason } : {}),
    };
    changes.push(withHunks(change));
  }
  return {
    source: formatChangesetSource({ scheme: "file", path: root.replace(/\\/g, "/"), sha256: hash.digest("hex") }),
    changes,
  };
}

/**
 * Has the world moved under a pending changeset — and if so, what exactly changed? (§3.2)
 *
 * What "moved" means depends on what the tree is SUPPOSED to hold ({@link TreeState}): under a
 * sync's changeset (`base`) the files should still read as each change's `before`; under a
 * worktree changeset (`proposal`) they should still read as the `after` the reviewer was shown.
 * Either way the answer is a changeset from the EXPECTED content to what `read` finds now, chained
 * by `source` onto the pending changeset's own source, and `undefined` when nothing drifted.
 * Presenting both is the design's position (§10.1): a silent rebase is how a reviewer stops
 * trusting what it shows.
 */
export async function changesetDrift(
  pending: Changeset,
  read: FileReader,
  tree: TreeState = "base",
): Promise<Changeset | undefined> {
  parseChangesetSource(pending.source); // the chain link must itself be addressable
  const id = changeIds();
  const changes: Change[] = [];
  for (const change of pending.changes) {
    if (change.unshowable !== undefined) continue;
    // The files this change claims something about, and what each should currently hold.
    const expectations: Array<[string, string | undefined]> =
      tree === "base"
        ? [[change.fromPath ?? change.path, change.before]]
        : change.action === "rename"
          ? [
              [change.path, change.after],
              [change.fromPath!, undefined],
            ]
          : [[change.path, change.action === "delete" ? undefined : change.after]];
    for (const [path, expected] of expectations) {
      const now = await read(path);
      if (now === expected) continue;
      const drifted: Change = {
        id: id(),
        path,
        action: expected === undefined ? "create" : now === undefined ? "delete" : "update",
        ...(expected !== undefined ? { before: expected } : {}),
        ...(now !== undefined ? { after: now } : {}),
        reason: `'${path}' moved while the changeset was pending — it no longer holds the ${tree === "base" ? "base" : "proposal"} the review was about`,
      };
      changes.push(withHunks(drifted));
    }
  }
  if (changes.length === 0) return undefined;
  return { source: pending.source, changes };
}

/** Re-validate a changeset that arrived as an op input — the runtime's defensive read. */
export { changesetOf };
