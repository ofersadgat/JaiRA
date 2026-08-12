/**
 * The path bar's tail: the runs walked into below the open file.
 *
 * The bar reads like an address bar because it IS an address — and an address has to survive being
 * navigated. The state-id segments (`feature › plan › draft`) are the file's own hierarchy and come
 * from the document; everything after them is where you went from there, one step per run clicked.
 * The view shows the LAST element, so appending is walking in and truncating is walking back out.
 *
 * ## Why the trail is a list and not a selection
 *
 * A run has children, each of which is a run with children. Selecting one and showing it — which is
 * what the board did — answers "what is inside this" and forgets the question that got you there.
 * With four levels open you had no record of the three above, so going back out meant re-selecting
 * the file and drilling again. A list keeps every level, and the crumb IS the way back.
 *
 * ## What a step is scoped to
 *
 * ONE task. An instance id is unique only within a run of a task, so a trail carried across a
 * selection change would name somebody else's instances — which is why selecting a task RESETS the
 * trail to its base rather than extending it, and why {@link prunedTrail} exists: a re-run restarts
 * instance ids, so steps that no longer resolve are steps about a run that no longer exists.
 */
import type { InstanceNode } from "@jaira/shared/browser";

/** One run in the path — the instance it names, and what it is called. */
export interface TrailStep {
  /** The instance this crumb walks into. Unique within the task's run. */
  instanceId: number;
  /** The state that instance ran, so the board below it knows which children to declare. */
  stateId: string;
  /**
   * The run's own name, when it has one that is not merely the state it ran.
   *
   * ABSENT is the common case at the base of a walk: a state entered as a root has no child key and
   * usually no label, and the state it ran is already the crumb immediately before it. The bar then
   * spells it `#3` — the instance id, which is the one thing that distinguishes one pass from
   * another and the only honest thing left to call it.
   */
  name?: string;
}

/** Find one instance anywhere in a task's tree. */
export function nodeAt(nodes: readonly InstanceNode[], instanceId: number): InstanceNode | undefined {
  for (const node of nodes) {
    if (node.instanceId === instanceId) return node;
    const found = nodeAt(node.children, instanceId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The step for one run.
 *
 * Named the way the board card names it — the run's own label if it has one, the key its parent
 * mounted it under otherwise — because they are the same object and a crumb that read differently
 * from the card you clicked would be a crumb you could not connect to anything.
 *
 * The state id is deliberately NOT a fallback here. It is the crumb immediately before this one, and
 * a path reading `hello_world › hello_world` says the second segment is a state when it is a run.
 */
export function stepOf(node: InstanceNode): TrailStep {
  const name = node.label !== undefined && node.label.length > 0 ? node.label : node.childKey;
  return {
    instanceId: node.instanceId,
    stateId: node.stateId,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
  };
}

/**
 * The instance in the tree that IS a state, for the run being read.
 *
 * Depth-first and newest-first, so a state re-entered by a loop resolves to its latest pass — the
 * one whose children are on screen. A superseded instance is skipped: its children were cleared by
 * a sequence reset and showing them would populate the board with runs the engine has disowned.
 *
 * Here rather than beside the board it draws, because this is also what SEEDS a walk: opening a
 * state file puts its newest run on the path, and that has to work for a state that ran no model
 * call at all. A composite orchestrates and says nothing, so it has no session row — which is why
 * the trail cannot be seeded from the session history, and why looking a run up by state belongs
 * with the rest of the tree queries.
 */
export function instanceOf(nodes: readonly InstanceNode[], stateId: string): InstanceNode | undefined {
  let best: InstanceNode | undefined;
  const walk = (list: readonly InstanceNode[]): void => {
    for (const node of list) {
      if (node.stateId === stateId && !node.superseded) {
        if (best === undefined || node.startedAt >= best.startedAt) best = node;
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return best;
}

/**
 * The trail with anything that no longer resolves cut off.
 *
 * Truncated at the first miss rather than filtered: the steps are a PATH, and a path with a hole in
 * it is not a shorter path, it is a claim about a descent that did not happen. A re-run restarts
 * instance ids, so this is what stops the bar from offering four crumbs into a run that is gone.
 *
 * The STATE is checked as well as the id, and that is the same fact stated twice rather than a
 * belt-and-braces. Instance ids restart, so a re-run does not merely invalidate them — it REISSUES
 * them, and `#3` in the new run is a live node under a different state. On existence alone the crumb
 * survives, keeps its old label, and walks into someone else's run.
 */
export function prunedTrail(trail: readonly TrailStep[], nodes: readonly InstanceNode[]): TrailStep[] {
  const kept: TrailStep[] = [];
  for (const step of trail) {
    if (nodeAt(nodes, step.instanceId)?.stateId !== step.stateId) break;
    kept.push(step);
  }
  return kept;
}

/** Whether two trails name the same descent — what decides if a patch is worth making. */
export function sameTrail(a: readonly TrailStep[], b: readonly TrailStep[]): boolean {
  return a.length === b.length && a.every((step, i) => step.instanceId === b[i]?.instanceId);
}
