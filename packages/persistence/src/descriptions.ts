/**
 * Which description a state belongs to, when descriptions nest.
 *
 * `workflows/feature.md` describes the root `feature`; `workflows/feature/plan.md` describes a
 * subtree of the same thing. The state tree is already hierarchical — `feature` CONTAINS
 * `feature/plan` — so without a rule the two descriptions overlap by construction, and overlap is
 * not a cosmetic problem:
 *
 *  - editing `feature/plan/goals.json` would report drift on both descriptions, with no way to say
 *    which one is now the stale account;
 *  - and a sync of `feature.md` towards the states could rewrite files that `feature/plan.md` is
 *    the authority on, silently making the more specific document wrong.
 *
 * ## The rule (WORKFLOWS.md §11.3)
 *
 * **The nearest description owns a state.** The same resolution `.gitignore` and CODEOWNERS use: a
 * state belongs to the closest description at or above it, so `feature.md` owns `feature` and
 * everything below it EXCEPT subtrees that have a description of their own. Every state is
 * answerable to exactly one document, which is what makes both the baseline and a proposal
 * well-defined.
 *
 * `workflows/workflow.md` sits at the top of that hierarchy: it names no root, so it owns whatever
 * no nearer description claims. A layer with only a `workflow.md` therefore behaves exactly as it
 * did before descriptions could nest.
 *
 * ## What a parent is left saying
 *
 * Not nothing — the CONTRACT of what it delegated. `feature.md` still has to say what `plan` is
 * for, what it takes and what it produces; it just stops being the account of how `plan` works
 * inside. That boundary is what {@link ownershipOf} exists to compute, and what the digest renders
 * against.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { descriptionRootOf, isWorkflowDescription } from "@jaira/shared";

/** One description, and the states it is answerable for. */
export interface DescriptionOwnership {
  /** Path relative to the layer root, e.g. `workflows/feature.md`. */
  document: string;
  /** The root it names, or null for the layer-wide `workflow.md`. */
  root: string | null;
  /**
   * The states it owns, in id order — its subtree minus everything a nearer description claims.
   *
   * Empty is a real answer: a description whose whole subtree has been split into child documents
   * owns no state files, and is then purely a statement about how its children fit together.
   */
  owns: string[];
  /** The descriptions it hands its remaining subtree to, nearest-first by root. */
  delegates: DescriptionBoundary[];
}

/** A subtree a description does NOT describe, and the document that does. */
export interface DescriptionBoundary {
  /** Path relative to the layer root — what the panel names when it says who owns this. */
  document: string;
  /** The root that document describes. */
  root: string;
  /** How many states sit under it, so a status line can say what it is not counting. */
  states: number;
}

/**
 * Every markdown description in a layer's `workflows/`, as paths relative to the LAYER root.
 *
 * Walks the directory rather than deriving from the state files, because a description naming no
 * state is a case that has to be reportable — it is usually a typo in a filename, and a lister that
 * only returned descriptions with a matching state would make it invisible.
 */
export function listDescriptions(workflowsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (isWorkflowDescription(`workflows/${rel}`)) out.push(`workflows/${rel}`);
    }
  };
  walk(workflowsDir, "");
  return out.sort();
}

/** True when `stateId` is `root` or sits underneath it — segment-wise, so `feat` is not under `fe`. */
export function isUnder(stateId: string, root: string): boolean {
  return stateId === root || stateId.startsWith(`${root}/`);
}

/**
 * The nearest description root at or above `stateId`, or null when only the layer-wide one applies.
 *
 * Longest match wins, which is what "nearest" means once roots are paths: `feature/plan` beats
 * `feature` for `feature/plan/goals`, because it is the more specific claim.
 */
export function nearestRoot(stateId: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (!isUnder(stateId, root)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/** As {@link nearestRoot}, but strictly ABOVE — used to place one description under another. */
function nearestRootAbove(root: string, roots: readonly string[]): string | null {
  return nearestRoot(root, roots.filter((r) => r !== root));
}

/**
 * Resolve one description's ownership against every description in its layer.
 *
 * `states` is the full set of state ids the layer resolves — the union of every root's closure. It
 * is passed in rather than read here because computing it means loading bundles, which is the
 * caller's business and can fail in ways this function has no way to report.
 */
export function ownershipOf(
  document: string,
  descriptions: readonly string[],
  states: readonly string[],
): DescriptionOwnership {
  const root = descriptionRootOf(document);
  const rootOf = new Map<string, string>();
  for (const other of descriptions) {
    const otherRoot = descriptionRootOf(other);
    if (otherRoot !== null) rootOf.set(otherRoot, other);
  }
  const roots = [...rootOf.keys()];

  // In this description's subtree at all? The layer-wide document's subtree is everything.
  const inSubtree = (id: string): boolean => root === null || isUnder(id, root);

  const owns: string[] = [];
  for (const id of states) {
    if (!inSubtree(id)) continue;
    // `nearest === root` covers both the named case and, when this is `workflow.md`, the case where
    // no description claims the state at all (`nearest` is null and so is `root`).
    if (nearestRoot(id, roots) === root) owns.push(id);
  }

  // DIRECT children in the description hierarchy only. If `feature/plan.md` and
  // `feature/plan/critique.md` both exist, `feature.md` hands its subtree to `feature/plan.md` and
  // stops — listing `critique` here too would make the parent name a boundary it does not touch,
  // and would count the same states twice.
  const delegates: DescriptionBoundary[] = roots
    .filter((r) => r !== root && inSubtree(r) && nearestRootAbove(r, roots) === root)
    .map((r) => ({
      document: rootOf.get(r)!,
      root: r,
      // Everything below it, sub-delegated states included: the question a status line answers is
      // "how much of this subtree am I not looking at", and that number does not care how many
      // documents share the rest of it.
      states: states.filter((id) => isUnder(id, r)).length,
    }))
    .sort((a, b) => a.root.localeCompare(b.root));

  return { document, root, owns: owns.sort(), delegates };
}
