/**
 * Where a move's target is, from where the task stands — the ROWS of the move table (`@jaira/shared`
 * `move.ts`, decision 0005's rulings of 2026-09-22).
 *
 * A move within a task's workflow used to be allowed to any state in the tree (`pathsTo`): a jump
 * sideways, or past a decision the workflow had already taken, was a directed transition like any
 * other. It is now judged against the transitions the workflow DEFINES:
 *
 *  - **behind** — the task has entered it, or a move stepped over it (an ancestor of where it stands included);
 *  - **ahead**  — something the workflow defines can get there from where the task stands: the
 *    sequence's walk, a transition written on a child or on the state, a composite ending and its
 *    parent walking on, a composite entered at its first child or at a child its own rules enter —
 *    whatever a guard says, since a guard is a decision the machine makes on the way;
 *  - **unreachable** — neither: a sideways jump, or a branch whose decision was already made;
 *  - and where NOTHING is ahead — a finished task, a task standing in its last state — a move anywhere
 *    it has not been is a new transition, which is the table's last row (`elsewhere`).
 *
 * Pure over the loaded machine and the pinned definition: a reader of a journal, never of a process.
 * What the task is DOING — the table's columns — is the host's to say (`ConnectHost.activity`); the
 * fallback here reads only what a journal and the task row can say.
 */
import { sourceStateId, type LoadedInstance, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import type { MoveWhere, TaskActivity } from "@jaira/shared";
import type { Project } from "./project";

const joined = (keys: readonly string[]): string => keys.join("/");
const TERMINATE = "terminate.";

/** The state mounted at a path of child keys from the bundle's root — the root itself for `[]`. */
export function stateAt(bundle: WorkflowBundle, keys: readonly string[]): LoadedState | undefined {
  let state = bundle.states[bundle.rootId];
  for (const key of keys) {
    const mount = state?.children?.[key];
    state = mount !== undefined ? bundle.states[mount.state] : undefined;
    if (state === undefined) return undefined;
  }
  return state;
}

/**
 * Every path the task has been through — the root is `""`. A state a move stepped over counts: it is
 * journaled as an occurrence that ended `skipped`, the task is past it, and going back to it is going
 * back, not sideways.
 */
export function enteredPaths(loaded: LoadedInstance | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (node: LoadedInstance, keys: string[]): void => {
    out.add(joined(keys));
    for (const child of node.children ?? []) if (child.childKey !== undefined) walk(child, [...keys, child.childKey]);
  };
  if (loaded !== undefined) walk(loaded, []);
  return out;
}

/** The instances the task stands in: live, with nothing live beneath them — each with its path. */
export function standingLeaves(loaded: LoadedInstance | undefined): Array<{ keys: string[]; node: LoadedInstance }> {
  const out: Array<{ keys: string[]; node: LoadedInstance }> = [];
  const walk = (node: LoadedInstance, keys: string[]): void => {
    if (!node.live) return;
    const live = (node.children ?? []).filter((child) => child.live && child.childKey !== undefined);
    if (live.length === 0) out.push({ keys, node });
    for (const child of live) walk(child, [...keys, child.childKey!]);
  };
  if (loaded !== undefined) walk(loaded, []);
  return out;
}

/** The targets a state's rules name among its children — the state's own rules, and those written on `key`. */
function ruleTargets(state: LoadedState, key: string | undefined): string[] {
  const rules = [...(state.transitions ?? []), ...(key !== undefined ? (state.children?.[key]?.transitions ?? []) : [])];
  return rules.map((rule) => rule.to).filter((to) => !to.startsWith(TERMINATE) && state.children?.[to] !== undefined);
}

/** Whether the state may END once `key` has: the sequence ran out, `key` is off it, or a rule terminates. */
function mayEndAfter(state: LoadedState, key: string): boolean {
  const sequence = state.sequence ?? [];
  const at = sequence.indexOf(key);
  if (at < 0 || at === sequence.length - 1) return true;
  const rules = [...(state.transitions ?? []), ...(state.children?.[key]?.transitions ?? [])];
  return rules.some((rule) => rule.to.startsWith(TERMINATE));
}

/** Where entering a composite may put the task first: its first child, and any child its own rules enter. */
function entriesOf(state: LoadedState): string[] {
  const first = (state.sequence ?? [])[0];
  return [...new Set([...(first !== undefined ? [first] : []), ...ruleTargets(state, undefined)])];
}

export interface Reach {
  /** Every path reachable ahead through the defined transitions, by its joined key. */
  ahead: Map<string, string[]>;
  /** The paths ONE transition away — entered next, with nothing entered between: the chips. */
  next: Map<string, string[]>;
  /** Where the task stands, first leaf first — for the sentences. */
  standing: string[][];
}

/**
 * What the workflow's DEFINED transitions can reach from where the task stands — see the header.
 *
 * Guards are not evaluated: a guard is a decision the machine makes on the way, and a fast-forward
 * runs the machine through it. A standing rule (a move a host generated) is a defined transition like
 * any other. A task that stands nowhere (finished, or never run) reaches nothing.
 */
export function reachAhead(bundle: WorkflowBundle, loaded: LoadedInstance | undefined): Reach {
  const ahead = new Map<string, string[]>();
  const next = new Map<string, string[]>();
  const entered = new Set<string>();
  const after = new Set<string>();

  const enter = (keys: string[], first: boolean): void => {
    const id = joined(keys);
    if (first && !next.has(id)) next.set(id, keys);
    if (entered.has(id)) return;
    entered.add(id);
    ahead.set(id, keys);
    const state = stateAt(bundle, keys);
    if (state === undefined) return;
    if (Object.keys(state.children ?? {}).length > 0) {
      for (const key of entriesOf(state)) enter([...keys, key], false);
    } else if (keys.length > 0) {
      leave(keys.slice(0, -1), keys.at(-1)!, false);
    }
  };

  /** `key` under the state at `parent` has ended: what the parent does next. */
  const leave = (parent: string[], key: string, first: boolean): void => {
    const id = `${joined(parent)}#${key}#${first ? 1 : 0}`;
    if (after.has(id)) return;
    after.add(id);
    const state = stateAt(bundle, parent);
    if (state === undefined) return;
    const sequence = state.sequence ?? [];
    const at = sequence.indexOf(key);
    const targets = new Set(ruleTargets(state, key));
    if (at >= 0 && at + 1 < sequence.length) targets.add(sequence[at + 1]!);
    for (const target of targets) enter([...parent, target], first);
    // Ending a composite enters nothing, so what its parent enters next is still ONE step away.
    if (mayEndAfter(state, key) && parent.length > 0) leave(parent.slice(0, -1), parent.at(-1)!, first);
  };

  const leaves = standingLeaves(loaded);
  for (const { keys, node } of leaves) {
    const state = stateAt(bundle, keys);
    if (state === undefined) continue;
    const children = node.children ?? [];
    const last = [...children].reverse().find((child) => child.childKey !== undefined);
    if (Object.keys(state.children ?? {}).length > 0) {
      if (last !== undefined) leave(keys, last.childKey!, true);
      else for (const key of entriesOf(state)) enter([...keys, key], true);
    } else if (keys.length > 0) {
      leave(keys.slice(0, -1), keys.at(-1)!, true);
    }
  }
  return { ahead, next, standing: leaves.map((leaf) => leaf.keys) };
}

/** Where the target at `keys` is, from where the task stands — the table's row (see the header). */
export function whereIs(reach: Reach, entered: ReadonlySet<string>, keys: readonly string[]): MoveWhere {
  const id = joined(keys);
  if (entered.has(id)) return "behind";
  if (reach.ahead.has(id)) return "ahead";
  // Nothing further is defined where the task stands: a move is a new transition (the last row).
  if (reach.ahead.size === 0) return "elsewhere";
  return "unreachable";
}

/**
 * Why an unreachable target is refused, in a plain sentence: the decision that leads there was
 * already made, or nothing the workflow defines leads there from where the task stands.
 */
export function unreachableSentence(bundle: WorkflowBundle, reach: Reach, entered: ReadonlySet<string>, keys: readonly string[], title: string): string {
  const where = (path: readonly string[] | undefined): string => (path === undefined || path.length === 0 ? "its workflow's start" : `'${joined(path)}'`);
  const target = `'${joined(keys)}'`;
  const standing = where(reach.standing[0]);
  const parent = stateAt(bundle, keys.slice(0, -1));
  const key = keys.at(-1)!;
  if (parent !== undefined) {
    // The siblings whose own rules lead there — its DECISIONS. All of them already behind the task: the
    // decision was taken, and it went the other way.
    const deciders = Object.entries(parent.children ?? {})
      .filter(([sibling, mount]) => sibling !== key && (mount.transitions ?? []).some((rule) => rule.to === key))
      .map(([sibling]) => sibling);
    const taken = deciders.filter((sibling) => entered.has(joined([...keys.slice(0, -1), sibling])));
    if (deciders.length > 0 && taken.length === deciders.length) {
      return `${target} is reached only by the decision at ${taken.map((s) => `'${joined([...keys.slice(0, -1), s])}'`).join(" or ")}, which '${title}' has already made — a move cannot take the other branch. Move it back to ${taken.length === 1 ? "that state" : "one of them"} to decide again.`;
    }
  }
  return `${target} cannot be reached from where '${title}' stands (${standing}): no transition the workflow defines leads there, so moving it would skip what the workflow decides on the way.`;
}

/** The label a target is drawn with: the mount's own, else the state's. */
export function labelAt(bundle: WorkflowBundle, keys: readonly string[]): string | undefined {
  return stateAt(bundle, keys)?.label;
}

/** The state id at a path, as a person names it. */
export function targetIdAt(bundle: WorkflowBundle, keys: readonly string[]): string | undefined {
  const state = stateAt(bundle, keys);
  return state !== undefined ? sourceStateId(state.id) : undefined;
}

/**
 * What a task is doing, from what a journal and the task row can say — the fallback for a host that
 * holds no hubs (the CLI). A running row is working, unless a gate it parked is still open; a
 * completed one is finished; anything else is stopped.
 */
export function activityFromRow(project: Project, taskId: string, running: boolean): TaskActivity {
  const row = project.runtime.get(taskId);
  if (row?.status === "completed") return "finished";
  if (!running) return "stopped";
  return project.interactions.forTask(taskId).length > 0 ? "waiting-input" : "working";
}
