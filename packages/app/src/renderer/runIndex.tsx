/**
 * The run's instances, drawn on the conversation's own rail (DESIGN §11.1).
 *
 * The panel used to say this as an indented tree, which drew the same shape as the rail beside it
 * out of entirely different material — so the two could not be read against each other, and neither
 * one said what a repeat was. This is the rail with the contents taken away: the letterheads,
 * stacked, one row per state.
 *
 * ## The three rules
 *
 *  1. **A state with children opens a lane.** Its states are indented inside it and its colour runs
 *     down the whole of it. The indent is arithmetic rather than a special case — the gutter is as
 *     wide as the lanes open on that row, so the run's own trunk is one lane wide, a module is two,
 *     a state is three (see `centresFor`).
 *  2. **A state with nothing under it opens a lane and closes it again inside its own row**, drawn
 *     as a lobe — see {@link lobePath}. Drawn as an ordinary fork and join it is a chevron with no
 *     line in it, and a column of them is a saw blade.
 *  3. **The colour is the state's own**, the same hue the conversation gives it, which is what makes
 *     the panel a legend for the drawing beside it. That only holds if the palette is built ONCE:
 *     a hue is a state's position in the order states first appear, so derived from whatever rows
 *     are on screen it moves every time a loop is folded. See {@link RunIndex}.
 *
 * ## What it is not
 *
 * Not a second reading of the tree with the same information rearranged. Three things the tree could
 * not say are here — a repeat, as a colour returning; where the run is, as the letterhead's own tone;
 * and what each state cost, which the letterhead has always carried and the tree never did. Three it
 * said are gone, each because the drawing already says it: the step number is the row's position,
 * the nesting is the lanes, and the operation kind is one landing away.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { InstanceNode } from "@jaira/shared/browser";
import { paletteOf, type RailLane, type RailStep } from "./rail";
import { RailedRows } from "./railView";
import { headerToneOf, surfaceKindOf, type HeaderTone } from "./stateSurface";
import { isLiveNode, metaOf } from "./sessionPanels";
import { Icon } from "./icons";

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
function useNow(live: boolean): number | undefined {
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
 * A node's identity across the whole task.
 *
 * A durable id cannot repeat across runs, but a LEGACY journal's counter ids can — a task's folded
 * tree can then hold two nodes with the same one. The pair is the key everything here joins on —
 * the same rule the projection states for its consumers.
 */
export function keyOfNode(node: InstanceNode): string {
  return node.instanceId;
}

/** How many states a lane is holding — every descendant, not just its own children. */
function countOf(node: InstanceNode): number {
  return node.children.reduce((total, child) => total + 1 + countOf(child), 0);
}

/**
 * What a lane is CALLED, which is also what it is coloured by.
 *
 * The child key, because that is what the conversation's rail keys on: its lanes are opened from an
 * instance's ADDRESS (`atPiece` → `address.map(step => step.childKey)`), so a lane there is named by
 * the key its parent mounted it under. The two coincide on most workflows and do not have to — one
 * state file mounted twice is two lanes, two names and two colours, and keying the index on the state
 * id would give both of them one.
 */
function nameOf(node: InstanceNode): string {
  return node.childKey ?? node.stateId;
}

/**
 * The colours of one run — the single list both readings of it are drawn from.
 *
 * A hue is a state's position in the order states first appear (see `paletteOf`), so this only works
 * if there is ONE order. There was not: the conversation built its palette from its own band rows and
 * the index from its own instance rows, which are different lists in a different order, so the same
 * state came out olive in one column and blue in the next while both claimed to be drawing the same
 * run. The tree is the honest source for both — it is the run itself, it is in journal order, and it
 * holds every state either view can draw.
 */
export function paletteOfRun(instances: readonly InstanceNode[]): Map<string, string> {
  const names: { stateId: string }[] = [];
  const walk = (nodes: readonly InstanceNode[]): void => {
    for (const node of nodes) {
      names.push({ stateId: nameOf(node) });
      walk(node.children);
    }
  };
  walk(instances);
  return paletteOf(names);
}

/**
 * How loud a row is.
 *
 * `headerToneOf` is the letterhead's own rule and is asked first, so the index and the conversation
 * cannot disagree about what a state is doing. It answers for LEAVES, which is all the letterhead
 * ever heads; the two statuses only a composite can be in are added under it.
 */
function toneOf(node: InstanceNode): HeaderTone {
  const tone = headerToneOf(node, surfaceKindOf(node));
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

/** The loop's own control, on the first pass of the cycle. */
function LoopTag({ times, onToggle }: { times: number; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="loop-tag"
      title={`${times} passes of this cycle — fold them into one row`}
      onClick={onToggle}
    >
      <span className="loop-tag-glyph">↻</span> {times} passes
    </button>
  );
}

/**
 * The Instances section: the run's shape, and a bookmark on every row.
 *
 * `onGoTo` is what makes a label a bookmark. Absent — a host with no conversation beside it — the
 * rows are still the run's shape and still fold, but nothing pretends to be a link.
 */
export function RunIndex({
  instances,
  here,
  onGoTo,
}: {
  instances: readonly InstanceNode[];
  /** The state the reader is on, by {@link keyOfNode}. */
  here?: string | undefined;
  onGoTo?: ((node: InstanceNode) => void) | undefined;
}): JSX.Element {
  const [shutLanes, setShutLanes] = useState<ReadonlySet<string>>(() => new Set());
  const [shutLoops, setShutLoops] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The clock the live rows read. Every state on the active path is live — the leaf that is running
   * AND the composites above it, which entered earlier and are still open — so a lane's parent shows
   * how long the whole phase has been going while its child shows the current step. That is the
   * reading a person waiting on a run wants: not when the state started, but how long they have been
   * waiting on it.
   */
  const now = useNow(anyLive(instances));

  const { steps, rows } = useMemo(() => indexOf(instances, shutLoops), [instances, shutLoops]);
  /**
   * ⚠️ From the RUN, not from the rows on screen, and for two reasons at once.
   *
   * Folding a loop takes its states out of the step list, and a hue is a position — so a palette
   * derived from what is drawn shifts every state after the fold one rung down the ladder, and a
   * legend that recolours itself when you fold something is not a legend. The same argument settles
   * the bigger question: the conversation is drawing this run too, and it reads the same list, so the
   * two cannot drift. See {@link paletteOfRun}.
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
      // Everything but the run's own root, which is what `collapse all` leaves standing: folding it
      // puts the whole task behind one row, which is a thing to do and not a resting state.
      if (step.at.length > 1) folds.push(row.lane);
    }
    return { lanes, byKey, folds };
  }, [instances]);

  const toggleLoop = useCallback((key: string): void => {
    setShutLoops((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const foldable = useCallback((key: string) => lanes.has(key), [lanes]);
  /** A lane with nothing under it cannot fold, so its mark does what its label does. */
  const onPick = useCallback(
    (key: string): void => {
      const node = byKey.get(key);
      if (node !== undefined) onGoTo?.(node);
    },
    [byKey, onGoTo],
  );

  const allShut = folds.length > 0 && folds.every((key) => shutLanes.has(key));
  const foldAll = (): void => setShutLanes(allShut ? new Set() : new Set(folds));

  const row = (index: number, folded: boolean): JSX.Element | null => {
    const what = rows[index];
    if (what === undefined) return null;
    if (what.kind === "loop") {
      return (
        <div className="loop-shut">
          <button
            type="button"
            className="loop-shut-go"
            title={`expand ${what.times} passes`}
            onClick={() => toggleLoop(what.key)}
          >
            <span className="loop-swatches" aria-hidden="true">
              {what.members.slice(0, what.period).map((member, i) => (
                <i key={`${keyOfNode(member)}:${i}`} style={{ background: palette.get(nameOf(member)) ?? "var(--rule)" }} />
              ))}
            </span>
            <span className="loop-shut-names mono">
              {what.members
                .slice(0, what.period)
                .map((member) => nameOf(member))
                .join(" · ")}
            </span>
          </button>
          <LoopTag times={what.times} onToggle={() => toggleLoop(what.key)} />
        </div>
      );
    }

    const node = what.node;
    const tone = toneOf(node);
    const held = countOf(node);
    const name = nameOf(node);
    const label = onGoTo === undefined ? undefined : `go to ${name} in the conversation`;
    const inside = (
      <>
        <span className={`rail-mark-dot ts-dot-${node.status}`} />
        <span className="rail-mark-name">{name}</span>
        {node.operation?.status === "failed" && node.operation.reason !== undefined ? (
          <span className="rail-mark-why">{node.operation.reason}</span>
        ) : null}
        {folded ? (
          <span className="rail-mark-count">
            {held} state{held === 1 ? "" : "s"}
          </span>
        ) : null}
        {metaOf(node, now) !== "" ? <span className="rail-mark-meta">{metaOf(node, now)}</span> : null}
      </>
    );
    return (
      <div
        className={[
          "rail-mark",
          tone !== undefined ? `tb ${tone}` : "",
          what.loop !== undefined ? "in-loop" : "",
          node.superseded ? "gone" : "",
          here === keyOfNode(node) ? "here here-chip" : "",
        ]
          .filter((one) => one.length > 0)
          .join(" ")}
      >
        {what.lane !== undefined ? (
          <button
            type="button"
            className={`rail-mark-chev${folded ? "" : " open"}`}
            aria-label={`${folded ? "Expand" : "Collapse"} ${name}`}
            onClick={() =>
              setShutLanes((was) => {
                const next = new Set(was);
                if (!next.delete(what.lane!)) next.add(what.lane!);
                return next;
              })
            }
          >
            <Icon name="chevron" />
          </button>
        ) : (
          // The slot is kept so every name in the column starts at the same x. A leaf has no fold.
          <span className="rail-mark-chev pad" aria-hidden="true" />
        )}
        {onGoTo === undefined ? (
          <span className="rail-mark-go static">{inside}</span>
        ) : (
          <button type="button" className="rail-mark-go" title={label} onClick={() => onGoTo(node)}>
            {inside}
          </button>
        )}
        {what.loop?.head === true ? <LoopTag times={what.loop.times} onToggle={() => toggleLoop(what.loop!.key)} /> : null}
      </div>
    );
  };

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

  const rowClass = useCallback(
    (index: number): string | undefined => {
      const what = rows[index];
      if (what === undefined || what.kind !== "state") return undefined;
      return here === keyOfNode(what.node) ? "is-here" : undefined;
    },
    [rows, here],
  );

  return (
    <section>
      {/* The fold-all lives in the heading, which is the row already reserved for saying what this
          section is — the same arrangement, and the same growing-label control, as a session's own
          gutter in the conversation. */}
      <h3>
        <span>Instances</span>
        {folds.length > 0 ? (
          <button
            type="button"
            className="foldall"
            aria-label={allShut ? "Expand all" : "Collapse all"}
            onClick={foldAll}
          >
            <Icon name={allShut ? "unfold" : "fold"} />
            <span className="foldall-label">{allShut ? "expand all" : "collapse all"}</span>
          </button>
        ) : null}
      </h3>
      {instances.length === 0 ? <p className="empty">No run yet.</p> : <RailedRows
        className="run-index"
        steps={steps}
        renderStep={(index) => row(index, false)}
        renderRolled={(lane) => {
          const at = steps.findIndex((step) => step.key === lane.key);
          return at < 0 ? null : row(at, true);
        }}
        mark={mark}
        rowClass={rowClass}
        palette={palette}
        shut={shutLanes}
        onShut={setShutLanes}
        foldable={foldable}
        onPick={onPick}
      />}
    </section>
  );
}
