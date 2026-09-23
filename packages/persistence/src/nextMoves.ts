/**
 * A task's NEXT TRANSITIONS, as the chips its card offers (decision 0005, the rulings of 2026-09-22, 5).
 *
 * Computed here, in the main process, from the transitions the task's PINNED workflow defines out of
 * the state it stands in — the sequence's next member, a rule written on the child or on the state,
 * the parent's next member when the state it stands in is the last — and from the rules waiting on a
 * user event right now. Never from the renderer reading a document, which was rejected when
 * `on_user_event` was built, and never from the engine's waits alone, which a finished task has none of.
 *
 * Each chip carries the move table's answer for it (`judgeMove`), so pressing one does what a drop on
 * that column would: a chip is ahead (`next` / `fast-forward`), the event a rule waits on, or a loop the
 * workflow defines back to a state already entered (`back`, which a working task asks before). A
 * finished task gets none — nothing is defined past its end, and a move from there is a new
 * transition, which is a drop's to make.
 */
import { judgeMove, type NextMove, type TaskActivity } from "@jaira/shared";
import { resolveWithin } from "./connect";
import { loadPinnedBundle } from "./documents";
import { buildTaskLoad } from "./load";
import { enteredPaths, labelAt, reachAhead, stateAt, targetIdAt, whereIs } from "./moveLegality";
import type { Project } from "./project";

export interface NextMovesInput {
  activity: TaskActivity;
  /** The `to_state`s a rule of this task is waiting on right now (`on_user_event`), at the root. */
  offered?: readonly string[];
  /** Whether an engine holds the task — here, or elsewhere. */
  running: boolean;
  /** Why a FAST-FORWARD of this task cannot be served right now, if it cannot. */
  fastForwardBlocked?: () => string | undefined;
}

/** The chips — see the module header. Empty for a finished task and one that has never run. */
export function nextMovesOf(project: Project, taskId: string, input: NextMovesInput): NextMove[] {
  if (input.activity === "finished") return [];
  const row = project.runtime.get(taskId);
  const title = project.tasks.tryRead(taskId)?.title ?? taskId;
  if (row === undefined || (row.snapshotHash === undefined && row.documentId === undefined)) return [];
  let bundle;
  try {
    bundle = loadPinnedBundle(project, row);
  } catch {
    return [];
  }
  const load = buildTaskLoad(project, taskId, bundle.states);
  if (load.loaded === undefined || !load.loaded.live) return [];
  const reach = reachAhead(bundle, load.loaded);
  const entered = enteredPaths(load.loaded);
  const offered = input.offered ?? [];
  const candidates = new Map(reach.next);
  // A rule waiting on a user event is a transition the workflow defines too; it is offered even where
  // the walk above would not reach it first.
  for (const to of offered) if (stateAt(bundle, [to]) !== undefined && !candidates.has(to)) candidates.set(to, [to]);
  const out: NextMove[] = [];
  let blocked: string | undefined | null = null;
  for (const keys of candidates.values()) {
    const target = targetIdAt(bundle, keys);
    if (target === undefined) continue;
    const where = whereIs(reach, entered, keys);
    if (where !== "ahead" && where !== "behind") continue;
    const event = keys.length === 1 && offered.includes(keys[0]!);
    const within = resolveWithin({ bundle, loaded: load.loaded, keys, skip: false, running: input.running, offered });
    const cell = judgeMove(where, input.activity, { eventLeadsThere: event, next: within.move.direction === "next" });
    // What a chip pressed would do is what `connect` does with it: a target that is not simply next
    // is RUN to, and a host that cannot run one now says why on the chip.
    if (cell.way === "illegal") continue;
    const label = labelAt(bundle, keys);
    const move: NextMove = { target, path: [...keys], way: cell.way, ...(label !== undefined ? { label } : {}), ...(event ? { event: true as const } : {}) };
    if (cell.confirm !== undefined) {
      move.confirm = cell.confirm;
      move.sentence = `'${title}' is working. Stop it and go back to '${keys.join("/")}'? It is entered again as its next pass; what the task did since stays in its history.`;
    }
    if (cell.way === "fast-forward") {
      if (blocked === null) blocked = input.fastForwardBlocked?.();
      if (blocked !== undefined) move.blocked = blocked;
    }
    out.push(move);
  }
  return out;
}
