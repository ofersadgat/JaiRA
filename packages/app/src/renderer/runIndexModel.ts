/**
 * What the run INDEX derives — its rows, its folds, its loops, the fitting to a box, the clock its live
 * rows read. Nothing here draws: `RunIndex.tsx` (`packages/universal/src/components/panel`) does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstanceNode } from "@jaira/shared/browser";
import { nameOf, paletteOfRun, railOf, type RailLane, type RailRow, type RailStep } from "./rail";
import { autoFold, compact, type DisplayItem, type FoldCandidate, type VisibleRow } from "./stepCompaction";
import { headerToneOf, surfaceKindOf, type HeaderTone } from "./stateSurfaceModel";
import { isLiveNode } from "./sessionRows";

/** How often a live row's elapsed time is redrawn. A second, because that is the unit it shows. */
const ELAPSED_TICK_MS = 1000;

/** Whether anything in the run is still going — the reason to keep a clock at all. */
function anyLive(nodes: readonly InstanceNode[]): boolean {
  return nodes.some((node) => isLiveNode(node) || anyLive(node.children));
}

/**
 * The present moment, ticking while the run is live and frozen once it is not.
 *
 * A live row says how long its state has been going, and that number is wrong the moment after it
 * is drawn unless something redraws it. The index keeps ONE clock for every row rather than a timer
 * per row, and stops it when nothing is running — a finished run is history, and history does not
 * tick. `undefined` while nothing is live, so `metaOf` draws the finished reading and nothing else.
 */
export function useNow(live: boolean): number | undefined {
  const [now, setNow] = useState<number | undefined>(() => (live ? Date.now() : undefined));
  useEffect(() => {
    if (!live) {
      setNow(undefined);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : undefined;
}

/**
 * A node's identity across the whole task: its durable instance id, which cannot repeat.
 */
export function keyOfNode(node: InstanceNode): string {
  return node.instanceId;
}

/**
 * How many STEPS a lane is holding — the leaves under it, which is what a folded row's tile says
 * ("12 steps"). Its composites are not counted: they are the drawing's structure, not work that ran.
 */
export function stepsIn(node: InstanceNode): number {
  return node.children.reduce((total, child) => total + (child.children.length === 0 ? 1 : stepsIn(child)), 0);
}

/**
 * How loud a row is.
 *
 * `headerToneOf` is the letterhead's own rule and is asked first, so the index and the conversation
 * cannot disagree about what a state is doing. It answers for LEAVES, which is all the letterhead
 * ever heads; the two statuses only a composite can be in are added under it.
 */
export function toneOf(node: InstanceNode, asking: string | undefined): HeaderTone {
  const tone = headerToneOf(node, surfaceKindOf(node), asking !== undefined && asking === node.instanceId);
  if (tone !== undefined) return tone;
  if (node.status === "waiting_for_user") return "amber";
  if (node.status === "running") return "accent";
  return undefined;
}

/** One pass of a cycle, folded or not — see {@link loopsIn}. */
interface Loop {
  start: number;
  /** How many states one pass is. `draft → critique` is 2. */
  period: number;
  /** How many times it ran. Never below 2, or it is not a loop. */
  times: number;
}

/**
 * Consecutive passes of one cycle among sibling states.
 *
 * ⚠️ A SUPERSEDED pass is refused, and that is not a nicety. A retried state is the same state twice
 * in a row, which is exactly what a one-state loop looks like from here — and folding the two would
 * hide the very row saying the first attempt was thrown away. The refusal is what this reading costs
 * for being a guess: the projection does not stamp an instance with the pass it belongs to, and if it
 * did, this would be reading a fact and would survive a loop whose body changes between passes.
 */
export function loopsIn(nodes: readonly InstanceNode[]): Loop[] {
  const found: Loop[] = [];
  const same = (a: number, b: number, period: number): boolean => {
    for (let q = 0; q < period; q++) if (nodes[a + q]!.stateId !== nodes[b + q]!.stateId) return false;
    return true;
  };
  const clean = (from: number, count: number): boolean => {
    for (let q = 0; q < count; q++) if (nodes[from + q]!.superseded) return false;
    return true;
  };
  let i = 0;
  while (i < nodes.length) {
    let loop: Loop | undefined;
    // Shortest cycle first: `draft draft draft` is three passes of one state, not one and a half of
    // two, and asking about the longer period first would find neither.
    for (let period = 1; period <= 3 && loop === undefined; period++) {
      if (i + 2 * period > nodes.length) continue;
      let times = 1;
      while (i + (times + 1) * period <= nodes.length && same(i, i + times * period, period)) times++;
      if (times >= 2 && clean(i, period * times)) loop = { start: i, period, times };
    }
    if (loop === undefined) i++;
    else {
      found.push(loop);
      i = loop.start + loop.period * loop.times;
    }
  }
  return found;
}

/** One state's row. */
export interface IndexStateRow {
  kind: "state";
  node: InstanceNode;
  /** The lane this row opens, when it has children. Absent ⇒ it is drawn as a lobe instead. */
  lane?: string;
  /** Which loop it belongs to, and whether it is the pass the control sits on. */
  loop?: { key: string; times: number; head: boolean };
}

/** A folded loop, standing in for every pass of it. */
export interface IndexLoopRow {
  kind: "loop";
  key: string;
  /** Every pass, in order. The first `period` of them are the cycle. */
  members: readonly InstanceNode[];
  period: number;
  times: number;
}

export type IndexRow = IndexStateRow | IndexLoopRow;

/**
 * The instance tree as rail steps, and what each row says.
 *
 * The two lists are built together and stay index-aligned, the same arrangement the conversation
 * uses: `steps` is what the rail reasons about and `rows` is what the row says. Folded loops are
 * merged HERE rather than at the drawing, because a fold changes which rows exist at all.
 */
export function indexOf(
  instances: readonly InstanceNode[],
  shutLoops: ReadonlySet<string>,
): { steps: RailStep[]; rows: IndexRow[] } {
  const steps: RailStep[] = [];
  const rows: IndexRow[] = [];
  const add = (step: RailStep, row: IndexRow): void => {
    steps.push(step);
    rows.push(row);
  };

  const walk = (nodes: readonly InstanceNode[], at: readonly string[]): void => {
    let i = 0;
    while (i < nodes.length) {
      const node = nodes[i]!;
      if (node.children.length > 0) {
        const key = keyOfNode(node);
        const path = [...at, key];
        add({ key, stateId: nameOf(node), at: path, opens: true }, { kind: "state", node, lane: key });
        walk(node.children, path);
        i++;
        continue;
      }
      // A run of consecutive leaves. Only these can loop: a cycle whose passes are separated by a
      // composite is not a cycle anybody is reading as one.
      let j = i;
      while (j < nodes.length && nodes[j]!.children.length === 0) j++;
      const run = nodes.slice(i, j);
      const loops = loopsIn(run);
      let k = 0;
      while (k < run.length) {
        const loop = loops.find((one) => one.start === k);
        if (loop === undefined) {
          const leaf = run[k]!;
          add({ key: keyOfNode(leaf), stateId: nameOf(leaf), at, opens: false }, { kind: "state", node: leaf });
          k += 1;
          continue;
        }
        const members = run.slice(loop.start, loop.start + loop.period * loop.times);
        const key = `${at.join("/")}#loop${keyOfNode(members[0]!)}`;
        if (shutLoops.has(key)) {
          add(
            { key, stateId: nameOf(members[0]!), at, opens: false },
            { kind: "loop", key, members, period: loop.period, times: loop.times },
          );
        } else {
          for (const [pass, member] of members.entries()) {
            add(
              { key: keyOfNode(member), stateId: nameOf(member), at, opens: false },
              { kind: "state", node: member, loop: { key, times: loop.times, head: pass === 0 } },
            );
          }
        }
        k += loop.period * loop.times;
      }
      i = j;
    }
  };

  walk(instances, []);
  return { steps, rows };
}

/**
 * The index fitted to a box of fixed height — see `stepCompaction.ts` for the three levels.
 *
 * Handed in by a host that has a box to fill (the side panel's Steps tab); absent, the index draws
 * every row and folds only by hand, as it always has.
 */
export interface RunIndexFit {
  /** How many rows the box holds. */
  capacity: number;
  /**
   * The step being viewed, by {@link keyOfNode}: the sheet at the conversation's centre, or the live
   * one while it follows the bottom. Absent ⇒ the last step, which is usually the live one.
   */
  current?: string | undefined;
  /** Every instance with a sheet on screen in the conversation beside the index. */
  onScreen?: ReadonlySet<string> | undefined;
  /** Whether a conversation is beside the index at all. Without one, off the path starts folded. */
  convo: boolean;
}

/** A fold candidate's span over the WHOLE step list: its first and last step. */
interface Span {
  key: string;
  first: number;
  last: number;
  loop: boolean;
}

/** What a placeholder row names — see `gapOf` in {@link useRunIndexModel}. */
export interface GapWords {
  count: number;
  /** The outermost states it passes over, at most three, each a way to the top of it. */
  named: readonly { key: string; stateId: string; goTo: string }[];
  more: number;
}

/**
 * Everything the index draws from, worked out once per render: the rows (folds applied), the rail's
 * rows over them, the palette, the folds and the gestures that change them, the clock, and the fitted
 * rows.
 */
export function useRunIndexModel({ instances, fit, here }: { instances: readonly InstanceNode[]; fit?: RunIndexFit | undefined; here?: string | undefined }) {
  const [ownLanes, setOwnLanes] = useState<ReadonlySet<string>>(() => new Set());
  const [ownLoops, setOwnLoops] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Fitted, a fold made by hand is a STANDING instruction rather than the state itself: it sticks,
   * stands aside while the current step is inside it, and holds again once the current step leaves
   * (the person's ruling, 2026-09-24). So the hand is kept as two sets — shut and opened — and what is
   * drawn is worked out from them every time the current step moves. See `autoFold`.
   */
  const [handShut, setHandShut] = useState<ReadonlySet<string>>(() => new Set());
  const [handOpen, setHandOpen] = useState<ReadonlySet<string>>(() => new Set());
  /** `⋯` placeholders the person opened: their rows are drawn whatever the height. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The clock the live rows read. Every state on the active path is live — the leaf that is running
   * AND the composites above it, which entered earlier and are still open — so a lane's parent shows
   * how long the whole phase has been going while its child shows the current step.
   */
  const now = useNow(anyLive(instances));

  /** Every foldable lane and loop over the WHOLE run, with its span — what level 1 reasons about. */
  const spans = useMemo<{ list: Span[]; whole: RailStep[] }>(() => {
    const whole = indexOf(instances, new Set());
    const list: Span[] = [];
    for (const [i, step] of whole.steps.entries()) {
      const row = whole.rows[i];
      if (row?.kind !== "state") continue;
      // The run's own root never folds on its own: it is the whole task behind one row.
      if (row.lane !== undefined && step.at.length > 1) {
        const lane = row.lane;
        let last = i;
        while (last + 1 < whole.steps.length && whole.steps[last + 1]!.at.includes(lane)) last++;
        list.push({ key: lane, first: i, last, loop: false });
      }
      if (row.loop?.head === true) {
        const key = row.loop.key;
        const members = whole.rows.flatMap((other, j) => (other.kind === "state" && other.loop?.key === key ? [j] : []));
        list.push({ key, first: members[0]!, last: members[members.length - 1]!, loop: true });
      }
    }
    return { list, whole: whole.steps };
  }, [instances]);

  const fitted = useMemo<{ lanes: ReadonlySet<string>; loops: ReadonlySet<string> } | undefined>(() => {
    if (fit === undefined) return undefined;
    const { list, whole } = spans;
    const found = fit.current === undefined ? -1 : whole.findIndex((step) => step.key === fit.current);
    const current = found >= 0 ? found : whole.length - 1;
    const onScreen = fit.onScreen ?? new Set<string>();
    const candidates: FoldCandidate[] = list.map((span) => {
      let holdsOnScreen = false;
      for (let i = span.first; i <= span.last && !holdsOnScreen; i++) holdsOnScreen = onScreen.has(whole[i]!.key);
      return {
        key: span.key,
        distance: current < span.first ? span.first - current : current > span.last ? current - span.last : 0,
        holdsCurrent: current >= span.first && current <= span.last,
        holdsOnScreen,
      };
    });
    const loopKeys = new Set(list.filter((span) => span.loop).map((span) => span.key));
    const split = (shut: ReadonlySet<string>): { lanes: Set<string>; loops: Set<string> } => {
      const lanes = new Set<string>();
      const loops = new Set<string>();
      for (const key of shut) (loopKeys.has(key) ? loops : lanes).add(key);
      return { lanes, loops };
    };
    // The rows a fold set leaves: the step list with its loops merged, less what a shut lane holds.
    const count = (shut: ReadonlySet<string>): number => {
      const { lanes, loops } = split(shut);
      const rail = railOf(indexOf(instances, loops).steps).rows;
      return rail.filter(
        (row) =>
          !row.open.some((lane) => lanes.has(lane.key)) &&
          !(row.exit !== undefined && lanes.has(row.exit.lane.key) && row.enter === undefined),
      ).length;
    };
    return split(autoFold({ candidates, convo: fit.convo, capacity: fit.capacity, handShut, handOpen, count }));
  }, [fit, spans, instances, handShut, handOpen]);

  const shutLanes = fitted?.lanes ?? ownLanes;
  const shutLoops = fitted?.loops ?? ownLoops;

  /** A fold by hand. Fitted, it becomes a standing instruction; otherwise it is the fold itself. */
  const toggleFold = useCallback(
    (key: string, loop: boolean): void => {
      if (fit !== undefined) {
        const shutNow = (loop ? shutLoops : shutLanes).has(key);
        setHandShut((was) => {
          const next = new Set(was);
          if (shutNow) next.delete(key);
          else next.add(key);
          return next;
        });
        setHandOpen((was) => {
          const next = new Set(was);
          if (shutNow) next.add(key);
          else next.delete(key);
          return next;
        });
        return;
      }
      (loop ? setOwnLoops : setOwnLanes)((was) => {
        const next = new Set(was);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    [fit, shutLanes, shutLoops],
  );

  const { steps, rows } = useMemo(() => indexOf(instances, shutLoops), [instances, shutLoops]);
  /** The rail's own rows over the same steps — what a placeholder's members index into. */
  const railRows = useMemo(() => railOf(steps).rows, [steps]);
  /**
   * ⚠️ From the RUN, not from the rows on screen: folding a loop takes its states out of the step
   * list, and a hue is a position. See {@link paletteOfRun}.
   */
  const palette = useMemo(() => paletteOfRun(instances), [instances]);

  /** Every lane, and every node by its key — the two lookups the row and the gutter both need. */
  const { lanes, byKey, folds } = useMemo(() => {
    const whole = indexOf(instances, new Set());
    const lanes = new Set<string>();
    const byKey = new Map<string, InstanceNode>();
    const folds: string[] = [];
    for (const [i, step] of whole.steps.entries()) {
      const row = whole.rows[i];
      if (row?.kind !== "state") continue;
      byKey.set(step.key, row.node);
      if (row.lane === undefined) continue;
      lanes.add(row.lane);
      // Everything but the run's own root, which is what `collapse all` leaves standing.
      if (step.at.length > 1) folds.push(row.lane);
    }
    return { lanes, byKey, folds };
  }, [instances]);

  const toggleLoop = useCallback((key: string): void => toggleFold(key, true), [toggleFold]);
  const foldable = useCallback((key: string) => lanes.has(key), [lanes]);

  const allShut = folds.length > 0 && folds.every((key) => shutLanes.has(key));
  const foldAll = (): void => {
    if (fit === undefined) {
      setOwnLanes(allShut ? new Set() : new Set(folds));
      return;
    }
    // Fitted, "all" is said by hand too — and still stands aside for the current step's own path.
    setHandShut(allShut ? new Set() : new Set(folds));
    setHandOpen(allShut ? new Set(folds) : new Set());
  };
  /** The rail's knot folds too: say it the same way as the chevron. */
  const onShut = useCallback(
    (next: ReadonlySet<string>): void => {
      if (fit === undefined) {
        setOwnLanes(next);
        return;
      }
      for (const key of new Set([...next, ...shutLanes])) if (next.has(key) !== shutLanes.has(key)) toggleFold(key, false);
    },
    [fit, shutLanes, toggleFold],
  );

  /**
   * A state's own lobe. Only for a row that opens NO lane — a module's line is drawn by the rail
   * itself, in the rows its states are in.
   */
  const mark = useCallback(
    (index: number): RailLane | undefined => {
      const what = rows[index];
      if (what === undefined) return undefined;
      if (what.kind === "loop") return { key: what.key, stateId: nameOf(what.members[0]!), at: [] };
      if (what.lane !== undefined) return undefined;
      return { key: keyOfNode(what.node), stateId: nameOf(what.node), at: [] };
    },
    [rows],
  );

  /** Whether row `index` is the one the reader is on. */
  const isHere = useCallback(
    (index: number): boolean => {
      const what = rows[index];
      return what !== undefined && what.kind === "state" && here === keyOfNode(what.node);
    },
    [rows, here],
  );

  /** The current step in the rows as fitted: the one asked for, else the last. */
  const currentKey = fit === undefined ? undefined : (fit.current ?? steps[steps.length - 1]?.key);
  const fitRows = useMemo(() => {
    if (fit === undefined) return undefined;
    return (visible: readonly VisibleRow[]): DisplayItem[] => {
      let at = visible.findIndex((one) => one.row.step !== undefined && steps[one.row.step]?.key === currentKey);
      if (at < 0) {
        // Inside a folded loop, or not drawn at all: the nearest row that stands for it.
        const inLoop = rows.findIndex((row) => row.kind === "loop" && row.members.some((member) => keyOfNode(member) === currentKey));
        at = inLoop < 0 ? -1 : visible.findIndex((one) => one.row.step === inLoop);
      }
      if (at < 0) at = visible.length - 1;
      return compact(visible, at, fit.capacity, { expanded });
    };
  }, [fit, steps, rows, currentKey, expanded]);

  /** What a placeholder passes over, by name: the outermost states among its rows, each a way to the top of it. */
  const gapOf = (item: Extract<DisplayItem, { kind: "gap" }>): GapWords => {
    const members = item.members.flatMap((index) => {
      const step = (railRows as readonly RailRow[])[index]?.step;
      return step === undefined ? [] : [{ step: steps[step]!, row: rows[step]! }];
    });
    const depthOf = (step: RailStep): number => step.at.length + (step.opens ? -1 : 0);
    const top = Math.min(...members.map((one) => depthOf(one.step)));
    const named = members.filter((one) => depthOf(one.step) === top);
    const count = members.reduce((sum, one) => sum + (one.row.kind === "loop" ? one.row.members.length : one.step.opens ? 0 : 1), 0);
    return {
      count,
      named: named.slice(0, 3).map((one) => ({ key: one.step.key, stateId: one.step.stateId, goTo: one.row.kind === "loop" ? keyOfNode(one.row.members[0]!) : one.step.key })),
      more: Math.max(0, named.length - 3),
    };
  };
  const expand = (key: string): void => setExpanded((was) => new Set([...was, key]));

  return { steps, rows, railRows, palette, shutLanes, shutLoops, toggleFold, toggleLoop, foldable, allShut, foldAll, folds, onShut, byKey, mark, isHere, fitRows, gapOf, expand, now };
}
