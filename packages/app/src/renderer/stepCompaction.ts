/**
 * The step list that FITS — how the Steps index compacts into a box of fixed height (the person's
 * design, 2026-09-24, rounds 6–9 of the panel-views artifact).
 *
 * The index is a box whose height the person sets, with the chosen step's card under it; a run of
 * thirty-five rows does not fit, and scrolling a list whose whole point is "where am I" loses the
 * answer. So the list compacts around the CURRENT step — the one the conversation is showing, or the
 * live one when it is following the bottom — and it does so in three levels, each applied only when
 * the one before is not enough:
 *
 * 1. **Fold what is off screen.** A state with children, or a loop, that holds no sheet you can see
 *    folds to its own row. With no conversation beside the index, everything off the current path
 *    starts folded. A fold made by hand sticks — except while the current step is inside it, which
 *    opens it, until the current step leaves again.
 * 2. **The fisheye.** Rows farthest from the current one are replaced by `⋯ N steps`, one per run of
 *    siblings. The path above the current step and the rows that close it below always stay: the
 *    hierarchy is what the list is for. A run of one is never elided — its placeholder would cost
 *    the same row it saved.
 * 3. **The breadcrumb.** The parents fold into ONE row, like the address bar — only as many of them
 *    as it takes — and a `⋯` under it still stands for everything between where they were entered and
 *    what is visible.
 *
 * Pure over the rail's own rows (`rail.ts`), so it is tested against real `railOf` output. The index
 * decides what "current" and "on screen" are; this decides what is drawn.
 */
import type { RailLane, RailRow } from "./rail";

/* ------------------------------------------------------------------------------------------------ */
/* Level 1                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** A lane or loop that COULD fold, as the index sees it. */
export interface FoldCandidate {
  key: string;
  /** Rows between it and the current step — farther folds first. */
  distance: number;
  /** It holds the current step: never folded, whatever was said by hand. */
  holdsCurrent: boolean;
  /** It holds a sheet the conversation is showing. */
  holdsOnScreen: boolean;
}

/**
 * Which lanes and loops are folded.
 *
 * `count` measures how many rows the index would draw with a given fold set — the index owns that
 * arithmetic (loops change the step list itself), this owns the order folds are taken in.
 */
export function autoFold({
  candidates,
  convo,
  capacity,
  handShut,
  handOpen,
  count,
}: {
  candidates: readonly FoldCandidate[];
  /** Whether the conversation is on screen beside the index. */
  convo: boolean;
  capacity: number;
  handShut: ReadonlySet<string>;
  handOpen: ReadonlySet<string>;
  count: (shut: ReadonlySet<string>) => number;
}): Set<string> {
  const shut = new Set<string>();
  // A hand fold sticks, but stands aside while the current step is inside it.
  for (const one of candidates) if (handShut.has(one.key) && !one.holdsCurrent) shut.add(one.key);
  const free = candidates.filter((one) => !one.holdsCurrent && !handOpen.has(one.key) && !shut.has(one.key));
  if (!convo) {
    // Nothing to be on screen with: off the current path starts folded, whatever the room.
    for (const one of free) shut.add(one.key);
    return shut;
  }
  const farthest = (a: FoldCandidate, b: FoldCandidate): number => b.distance - a.distance;
  // Off screen first, then — only if that is not enough — on screen but off the path.
  for (const pass of [free.filter((one) => !one.holdsOnScreen), free.filter((one) => one.holdsOnScreen)]) {
    for (const one of [...pass].sort(farthest)) {
      if (count(shut) <= capacity) return shut;
      shut.add(one.key);
    }
  }
  return shut;
}

/* ------------------------------------------------------------------------------------------------ */
/* Levels 2 and 3                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/** A row the rail would draw, with its index in the rail's own row list. */
export interface VisibleRow {
  row: RailRow;
  index: number;
}

/** What the index draws, in order. */
export type DisplayItem =
  | { kind: "row"; index: number }
  /**
   * `⋯ N steps`: the rows it stands for, and the lanes running through it — the innermost is drawn
   * as dots ON the rail, the rest straight, so every placeholder reads the same way.
   */
  | { kind: "gap"; key: string; members: number[]; lanes: RailLane[] }
  /** The parents, folded into one line. `index` is the row that stands for the deepest of them. */
  | { kind: "crumb"; lanes: RailLane[]; index: number };

const keyOfGap = (first: RailRow, index: number): string => `gap:${first.enter?.lane.key ?? first.exit?.lane.key ?? index}`;

/** The lane a row hangs from — what decides whether two elided rows belong to one placeholder. */
const parentOf = (row: RailRow): string => row.open[row.open.length - 1]?.key ?? "";

/**
 * Compact the visible rows around `current` (an index INTO `visible`) to at most `capacity` items.
 *
 * `expanded` names placeholders the person opened: their rows are drawn whatever the height, and the
 * box scrolls. `crumbs` allows level 3.
 */
export function compact(
  visible: readonly VisibleRow[],
  current: number,
  capacity: number,
  { crumbs = true, expanded = new Set<string>() }: { crumbs?: boolean; expanded?: ReadonlySet<string> } = {},
): DisplayItem[] {
  const all = visible.map((_, i) => i);
  if (visible.length <= capacity || current < 0) return all.map((i) => ({ kind: "row", index: visible[i]!.index }));
  const ancestors = visible[current]!.row.open;
  const level2 = fisheye(visible, all, current, capacity, ancestors, expanded, null);
  if (level2.length <= capacity || !crumbs || ancestors.length < 2) return level2;

  // Level 3 — as few parents in the breadcrumb as it takes. The trunk alone saves nothing (it is
  // one row either way), so the first real candidate is the trunk and the lane under it.
  let best = level2;
  for (let depth = 2; depth <= ancestors.length; depth++) {
    const path = ancestors.slice(0, depth);
    const top = path[path.length - 1]!;
    const fork = visible.findIndex((one) => one.row.enter?.lane.key === top.key);
    if (fork < 0) continue;
    const exit = visible.findIndex((one, i) => i > fork && one.row.exit?.lane.key === top.key);
    const onPath = (one: VisibleRow): boolean =>
      (one.row.enter !== undefined && path.some((lane) => lane.key === one.row.enter!.lane.key)) ||
      (one.row.exit !== undefined && path.some((lane) => lane.key === one.row.exit!.lane.key));
    const before = all.slice(0, fork).filter((i) => !onPath(visible[i]!));
    const after = exit < 0 ? [] : all.slice(exit + 1).filter((i) => !onPath(visible[i]!));
    const inner = all.slice(fork + 1, exit < 0 ? visible.length : exit);
    const outer = (members: number[], where: string): DisplayItem[] =>
      members.length === 0
        ? []
        : expanded.has(`crumb-${where}:${top.key}`)
          ? []
          : [{ kind: "gap", key: `crumb-${where}:${top.key}`, members: members.map((i) => visible[i]!.index), lanes: [...path] }];
    // Opening the breadcrumb's own ⋯ is a request to see what it passes over: back to level 2.
    if ((before.length > 0 && expanded.has(`crumb-before:${top.key}`)) || (after.length > 0 && expanded.has(`crumb-after:${top.key}`))) return level2;
    const head: DisplayItem[] = [{ kind: "crumb", lanes: [...path], index: visible[fork]!.index }, ...outer(before, "before")];
    const tail = outer(after, "after");
    // The inner list may use every row the merged placeholders leave free.
    let got: DisplayItem[] = [];
    for (let room = capacity - head.length - tail.length; room <= capacity; room++) {
      const next = merge([...head, ...fisheye(visible, inner, current, room, ancestors, expanded, path), ...tail]);
      if (got.length > 0 && next.length > capacity) break;
      got = next;
      if (next.length >= capacity) break;
    }
    best = got;
    if (got.length <= capacity) return got;
  }
  return best;
}

/**
 * Level 2 over a slice of the visible rows (`among`, indices into `visible`).
 *
 * Units rather than rows are elided: an open state that is NOT on the current path goes as a whole —
 * its fork, its rows, its join — because a lane that appeared from nowhere under a placeholder would
 * claim a nesting the drawing no longer shows.
 */
function fisheye(
  visible: readonly VisibleRow[],
  among: readonly number[],
  current: number,
  capacity: number,
  ancestors: readonly RailLane[],
  expanded: ReadonlySet<string>,
  gapLanes: readonly RailLane[] | null,
): DisplayItem[] {
  const isAncestor = (key: string | undefined): boolean => key !== undefined && ancestors.some((lane) => lane.key === key);
  const keep = new Set<number>();
  for (const i of among) {
    const row = visible[i]!.row;
    if (isAncestor(row.enter?.lane.key) || isAncestor(row.exit?.lane.key)) keep.add(i);
  }
  keep.add(current);
  const at = among.indexOf(current);
  if (at > 0) keep.add(among[at - 1]!);
  if (at >= 0 && at < among.length - 1) keep.add(among[at + 1]!);

  // Units: a non-ancestor OPEN state is its fork through its last row; anything else is one row.
  const units: number[][] = [];
  for (let k = 0; k < among.length; k++) {
    const i = among[k]!;
    const lane = visible[i]!.row.enter?.lane;
    if (lane !== undefined && !isAncestor(lane.key) && !keep.has(i)) {
      // Its fork through the last row it is open in, and the row that closes it only when that row
      // does nothing else. A join the rail merged with the NEXT sibling's fork stays a unit of its
      // own: swallowing it would take the next state's fork with it (see `hiddenExits`).
      let end = k;
      for (let m = k + 1; m < among.length; m++) {
        const row = visible[among[m]!]!.row;
        if (row.open.some((one) => one.key === lane.key)) end = m;
        else {
          if (row.exit?.lane.key === lane.key && row.enter === undefined && row.step === undefined) end = m;
          break;
        }
      }
      const block = among.slice(k, end + 1);
      if (!block.some((j) => keep.has(j))) {
        units.push(block);
        k = end;
        continue;
      }
    }
    units.push([i]);
  }
  const unitOf = new Map<number, number>();
  units.forEach((unit, u) => unit.forEach((i) => unitOf.set(i, u)));
  const removable = units.map((_, u) => u).filter((u) => !units[u]!.some((i) => keep.has(i)));
  const distance = (u: number): number => Math.min(...units[u]!.map((i) => Math.abs(i - current)));
  const order = [...removable].sort((a, b) => distance(b) - distance(a) || a - b);

  const gone = new Set<number>();
  const build = (): DisplayItem[] => {
    const out: DisplayItem[] = [];
    for (let k = 0; k < among.length; k++) {
      const i = among[k]!;
      if (!gone.has(unitOf.get(i)!)) {
        out.push({ kind: "row", index: visible[i]!.index });
        continue;
      }
      const run: number[] = [];
      const parent = parentOf(visible[i]!.row);
      while (k < among.length && gone.has(unitOf.get(among[k]!)!) && (run.length === 0 || parentOf(visible[among[k]!]!.row) === parent || unitOf.get(among[k]!) === unitOf.get(run[run.length - 1]!))) {
        run.push(among[k]!);
        k++;
      }
      k--;
      const first = visible[run[0]!]!;
      const key = keyOfGap(first.row, first.index);
      if (expanded.has(key)) {
        for (const j of run) out.push({ kind: "row", index: visible[j]!.index });
        continue;
      }
      out.push({ kind: "gap", key, members: run.map((j) => visible[j]!.index), lanes: [...(gapLanes ?? first.row.open)] });
    }
    return out;
  };

  for (const u of order) {
    if (build().length <= capacity) break;
    gone.add(u);
    // A run of one costs as much as it saves: take its sibling on the far side too, when there is one.
    const first = units[u]![0]!;
    const k = among.indexOf(first);
    const step = first < current ? -1 : 1;
    const neighbour = among[step < 0 ? k - 1 : among.indexOf(units[u]![units[u]!.length - 1]!) + 1];
    if (neighbour === undefined) continue;
    const v = unitOf.get(neighbour)!;
    if (removable.includes(v) && !gone.has(v) && parentOf(visible[neighbour]!.row) === parentOf(visible[first]!.row)) gone.add(v);
  }
  return merge(build());
}

/** Adjacent placeholders say the same thing twice: one `⋯` stands for both. */
function merge(items: readonly DisplayItem[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "gap" && last?.kind === "gap") {
      out[out.length - 1] = {
        kind: "gap",
        key: last.key,
        members: [...last.members, ...item.members],
        lanes: last.lanes.length >= item.lanes.length ? last.lanes : item.lanes,
      };
    } else out.push(item);
  }
  return out;
}

/**
 * Lanes whose fork is inside a placeholder. A row still drawn that closes one of them must not draw
 * the curve back: the lane it curves out of is not on the page.
 */
export function hiddenExits(items: readonly DisplayItem[], rows: readonly RailRow[]): Set<string> {
  const hidden = new Set<string>();
  for (const item of items) {
    if (item.kind !== "gap") continue;
    for (const index of item.members) {
      const lane = rows[index]?.enter?.lane.key;
      if (lane !== undefined) hidden.add(lane);
    }
  }
  return hidden;
}
