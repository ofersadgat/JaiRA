/**
 * What a run's BOARD derives — the columns, the executions in each, the drags a waiting transition
 * offers, and what each execution's card says — moved out of `runViews.tsx` unchanged so the universal
 * copy (decision 0015, `packages/universal/src/components/run/`) draws the same board from the same
 * reading. Nothing here touches the DOM.
 */
import { MOVE_EVENTS, type InstanceNode, type PendingUserEvent, type StateChild, type StateView } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "./fileTypes";
import { durationOf } from "./runActivityModel";
import { advanceTargetOf } from "./stateSurface";
import { signatureOf } from "./transcript";
import { instanceOf as instanceOfState, nodeAt } from "./trail";

/** Every execution of each declared child, keyed by the child key the parent mounted it under. */
export function runsByChild(parent: InstanceNode | undefined): Map<string, InstanceNode[]> {
  const out = new Map<string, InstanceNode[]>();
  for (const child of parent?.children ?? []) {
    const key = child.childKey ?? child.stateId;
    const list = out.get(key);
    if (list === undefined) out.set(key, [child]);
    else list.push(child);
  }
  // Oldest first inside a column, so a retry reads downward as the story it is.
  for (const list of out.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

/**
 * The columns a run's board draws: the declared children, or — when nothing says what was declared (a
 * state view still in flight, or one that would not load) — what actually ran. Fewer columns than the
 * truth (a child nothing reached cannot appear) but never wrong about the ones it draws, which beats an
 * empty board while a fetch lands.
 */
export function runColumnsOf(declared: readonly StateChild[], byChild: ReadonlyMap<string, readonly InstanceNode[]>): readonly StateChild[] {
  return declared.length > 0 ? declared : [...byChild.keys()].map((key) => ({ key }) as StateChild);
}

/**
 * The card a drag picks up: the execution the run RESTS on — the parent's latest child that was not
 * superseded. A wait belongs to the run, not to a pass, and the pass it is about is the one the parent
 * stopped after; every other card in the column is history.
 */
export function restingOf(parent: InstanceNode | undefined): InstanceNode | undefined {
  return [...(parent?.children ?? [])].reverse().find((n) => !n.superseded);
}

export const NO_RUN_OFFERS: ReadonlyMap<string, string> = new Map();

/**
 * The drags this run's board can offer: column key → the wait a drop there would answer.
 *
 * The same reading `dragOffersOf` makes for the Tasks board, one level down. A wait names the task
 * it parked in and the child key its rule moves to (`to_state`, filled in by the hub), and this
 * board's columns ARE those keys — so a wait of this task whose target is a column here is an
 * offer, and one aimed anywhere else is not. FIRST wins where two rules offer the same move, which
 * is the engine's own order.
 */
export function runDragOffersOf(
  taskId: string | undefined,
  columns: readonly { key: string }[],
  requests: readonly PendingUserEvent[],
): ReadonlyMap<string, string> {
  if (taskId === undefined) return NO_RUN_OFFERS;
  const keys = new Set(columns.map((c) => c.key));
  const offers = new Map<string, string>();
  for (const request of requests) {
    if (!MOVE_EVENTS.includes(request.event) || request.taskId !== taskId) continue;
    const to = advanceTargetOf(request);
    if (to === undefined || !keys.has(to) || offers.has(to)) continue;
    offers.set(to, request.requestId);
  }
  return offers;
}

/** What one execution's card says (`RunTile`): its name, its hover, its two meta words and its arguments. */
export interface RunTileWords {
  /** The call's label, else its name — the same signature the transcript card carries. */
  title: string;
  tip: string;
  /** How long it took, "running", or when it started. */
  when: string;
  /** Its status, in words. */
  status: string;
  /** The first two arguments it was called with, a line each. */
  args: readonly { name: string; preview: string }[];
  /** How many more there were. */
  more: number;
}

export function runTileWordsOf(node: InstanceNode): RunTileWords {
  const sig = signatureOf(node);
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return {
    title: sig.label ?? sig.name,
    tip: `${node.stateId} · ${new Date(node.startedAt).toLocaleString()} — double-click to walk in`,
    when: node.status === "running" ? "running" : (took ?? new Date(node.startedAt).toLocaleTimeString()),
    status: node.status.replace(/_/g, " "),
    args: sig.params.slice(0, 2).map((param) => ({ name: param.name, preview: param.preview })),
    more: Math.max(0, sig.params.length - 2),
  };
}

/**
 * Where the walk is standing, and what is under it.
 *
 * The trail's tail is the answer to both questions, and everything the panel renders comes from
 * here. The FALLBACK is what keeps the old behaviour honest rather than special: with no run walked
 * into, the run is this state's own newest instance and the declared children are the open file's —
 * exactly what the panel showed before there was a trail.
 */
export function standingOn(
  state: StateView,
  context: Pick<FileSurfaceContext, "detail" | "trail" | "trailState">,
): {
  node: InstanceNode | undefined;
  stateId: string;
  declared: readonly StateChild[];
  deep: boolean;
  /** Set when the tail is a SUBAGENT CONVERSATION — `node` is then its host. See `TrailStep.sidechain`. */
  sidechain?: string;
} {
  const detail = context.detail;
  const tail = context.trail?.at(-1);
  if (tail === undefined) {
    return {
      node: instanceOfState(detail?.instances ?? [], state.stateId),
      stateId: state.stateId,
      declared: state.children,
      deep: false,
    };
  }
  const deep = tail.stateId !== state.stateId;
  return {
    node: nodeAt(detail?.instances ?? [], tail.instanceId),
    stateId: tail.stateId,
    // A step deeper is a different state, and its columns are ITS declared children. `trailState` is
    // fetched for exactly this; without it the board falls back to what actually ran, which is the
    // instance tree's own answer and misses only the children nothing reached.
    declared: deep ? (context.trailState?.children ?? []) : state.children,
    deep,
    ...(tail.sidechain !== undefined ? { sidechain: tail.sidechain } : {}),
  };
}
