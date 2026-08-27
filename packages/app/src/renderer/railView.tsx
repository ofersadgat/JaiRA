/**
 * Drawing the rail — see `rail.ts` for what a lane is and how the columns are spaced.
 *
 * The whole conversation is laid out here rather than beside here, and that is deliberate: the rail
 * only means anything if the row it belongs to is exactly as tall as it is, so the gutter and the
 * content have to be siblings in one row rather than two columns drawn independently. Which also buys
 * the thing the rail was asked for last: the content INDENTS, because the gutter is as wide as the
 * lanes open on that row and nothing more.
 *
 * ## Why the interaction is imperative
 *
 * Hovering a lane lights it in every row it crosses, and a long run is hundreds of rows. Holding the
 * hovered lane in React state would re-render all of them on every mouse move for the sake of one
 * CSS class. So the pointer is handled with one listener on the container, and the class is toggled
 * on the matching nodes directly. React still owns the structure; this owns one attribute of it.
 *
 * ⚠️ The listener is on the CONTAINER, never on the lanes. Two reasons, both of which were bugs:
 * fanning a squeezed gutter re-renders it, destroying the very element that fired `mouseenter` so its
 * `mouseleave` never arrives and the fan latches on; and a lane is one element PER ROW, so moving
 * down one crossed a leave/enter boundary at every row and the highlight blinked all the way down.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  CAP,
  MID,
  bumpPath,
  centresFor,
  forkPath,
  gutterWidth,
  insideOf,
  joinPath,
  lanesOf,
  needsFan,
  paletteOf,
  railOf,
  stackPaint,
  stacksOf,
  type RailLane,
  type RailRow,
  type RailStep,
} from "./rail";

/** The trunk is the run itself and is not a state anybody named — drawn in the ordinary rule colour. */
type Palette = ReadonlyMap<string, string>;
function laneColour(lane: RailLane, root: boolean, palette: Palette): string {
  return root ? "var(--rule)" : (palette.get(lane.stateId) ?? "var(--rule)");
}

/**
 * One row's gutter: the lanes crossing it, and the fork or join that happens inside it.
 *
 * Straights are absolutely positioned top to bottom, so a row of any height keeps its lines
 * continuous. Curves live in an SVG that is exactly one cap tall — which is why a row that forks or
 * joins is fixed at that height and every other row is free to be as tall as its content.
 */
function RailGutter({
  row,
  centres,
  columns,
  folded,
  palette,
}: {
  row: RailRow;
  centres: readonly number[];
  /** Which lane indices share a column, by the index of the lane that heads the column. */
  columns: Map<number, number[]>;
  /** Whether the lane this row enters is rolled up — it gets a bump and a plus instead of a fork. */
  folded: boolean;
  palette: Palette;
}): JSX.Element {
  const lanes = lanesOf(row);
  const width = gutterWidth(centres, lanes);

  const straights: JSX.Element[] = [];
  const drawn = new Set<number>();
  for (const [i, lane] of row.open.entries()) {
    const group = columns.get(i) ?? [i];
    const head = group[0]!;
    if (drawn.has(head)) continue;
    drawn.add(head);
    // Only the lanes actually open on THIS row: a column stacks by geometry, which is a property of
    // the run's deepest point, and a shallow row must not draw stripes for lanes that are not there.
    const mates = group.filter((j) => j < row.open.length);
    const centre = centres[head] ?? 0;
    const style =
      mates.length > 1
        ? { left: `${centre - 2}px`, background: stackPaint(mates.map((j) => laneColour(row.open[j]!, j === 0, palette))) }
        : { left: `${centre - 1}px`, background: laneColour(lane, i === 0, palette) };
    straights.push(
      <span
        key={head}
        className={mates.length > 1 ? "rail-seg rail-stack" : "rail-seg"}
        style={style}
        data-lane={row.open[head]!.key}
        data-name={
          mates.length > 1
            ? `${mates.length} lanes · ${mates.map((j) => row.open[j]!.stateId).join(" · ")}`
            : lane.stateId
        }
        {...(mates.length > 1 ? { "data-stack": "1" } : {})}
      />,
    );
  }

  return (
    <div className="rail-gut" style={{ width: `${width}px` }}>
      {straights}
      {row.turn && (
        <svg className="rail-cap" viewBox={`0 0 ${width} ${CAP}`} preserveAspectRatio="none" aria-hidden="true">
          {row.exit !== undefined && (
            <path
              d={joinPath(centres, row.exit.depth, row.exit.depth - 1)}
              stroke={laneColour(row.exit.lane, row.exit.depth === 0, palette)}
              data-lane={row.exit.lane.key}
              data-name={row.exit.lane.stateId}
            />
          )}
          {row.enter !== undefined && (
            <RailFork
              lane={row.enter.lane}
              depth={row.enter.depth}
              root={row.enter.root}
              centres={centres}
              folded={folded}
              palette={palette}
            />
          )}
        </svg>
      )}
    </div>
  );
}

/** The fork itself: the curve off the parent, the knot it leaves from, and the target you click. */
function RailFork({
  lane,
  depth,
  root,
  centres,
  folded,
  palette,
}: {
  lane: RailLane;
  depth: number;
  root: boolean;
  centres: readonly number[];
  folded: boolean;
  palette: Palette;
}): JSX.Element {
  const colour = laneColour(lane, root, palette);
  const cx = centres[root ? 0 : depth - 1] ?? 0;
  return (
    <>
      {/* A folded lane still leaves and comes straight back: the run took the detour whether or not
          the page is showing it, and a rail that went perfectly straight would say it did not. */}
      {!root && (
        <path
          d={folded ? bumpPath(centres, depth - 1, depth) : forkPath(centres, depth - 1, depth)}
          stroke={colour}
          data-lane={lane.key}
          data-name={lane.stateId}
        />
      )}
      <circle className="rail-knot" cx={cx} cy={MID} r={4.5} fill="var(--bg)" stroke={colour} strokeWidth={2} data-lane={lane.key} data-name={lane.stateId} />
      {folded && (
        <path
          className="rail-knot"
          d={`M${cx - 2.2} ${MID} H${cx + 2.2} M${cx} ${MID - 2.2} V${MID + 2.2}`}
          stroke={colour}
          strokeWidth={1.6}
        />
      )}
      {/* A circle you can actually hit. The knot is 9px across and is the only way back into a lane
          that has been rolled up, so the target is more than twice that and invisible. */}
      <circle className="rail-hit" cx={cx} cy={MID} r={11} data-lane={lane.key} data-name={lane.stateId} />
    </>
  );
}

/**
 * The conversation with its hierarchy drawn beside it.
 *
 * `steps` and `renderStep` are separate because the rail's model is about STATES and the content is
 * about anything at all — a panel, a note, a fork mark. The rail decides the order rows appear in and
 * inserts the rows that only leave a state; the caller decides what a row says.
 */
export function RailedRows({
  steps,
  renderStep,
  className,
}: {
  steps: readonly RailStep[];
  /** What row `index` of `steps` draws. */
  renderStep: (index: number) => ReactNode;
  className?: string;
}): JSX.Element {
  const { rows, deepest } = useMemo(() => railOf(steps), [steps]);
  const palette = useMemo(() => paletteOf(steps), [steps]);
  const inside = useMemo(() => insideOf(rows), [rows]);
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Whether the gutter is spread back to full pitch.
   *
   * Held in state because it changes the GEOMETRY and so has to re-render — unlike the highlight,
   * which is one class. Keyed on the pointer being in a squeezed gutter rather than on it touching a
   * stacked column, because once fanned the stack no longer exists: asking "is this a stack" would
   * un-fan it, re-stack it, and oscillate.
   */
  const [fan, setFan] = useState(false);

  const centres = useMemo(() => centresFor(deepest, fan), [deepest, fan]);
  const columns = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const group of stacksOf(centres)) for (const i of group) map.set(i, group);
    return map;
  }, [centres]);
  /** Whether this gutter is tight enough to be worth fanning — a property of the run's depth. */
  const compressed = useMemo(() => needsFan(deepest), [deepest]);

  const host = useRef<HTMLDivElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  /**
   * The lane under the pointer, held by IDENTITY rather than by position.
   *
   * Which is what lets it survive the fan: the lanes move, and the one you aimed at stays the one
   * that is lit and the one a click acts on. See {@link onClick}.
   */
  const hot = useRef<string | null>(null);
  /** Whether the lit thing is a stacked COLUMN rather than a lane — several lanes, no one answer. */
  const hotStack = useRef(false);

  /** Light every stroke of the lane under the pointer — straights, curves and knot, in every row. */
  const paint = useCallback((): void => {
    const root = host.current;
    if (root === null) return;
    for (const lit of root.querySelectorAll(".rail-lit")) lit.classList.remove("rail-lit");
    if (hot.current === null) return;
    for (const one of root.querySelectorAll(`[data-lane="${CSS.escape(hot.current)}"]`)) one.classList.add("rail-lit");
  }, []);

  // React rebuilds these nodes whenever anything above changes, taking the class with them.
  useEffect(paint);

  const onMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const target = event.target instanceof Element ? event.target.closest("[data-lane]") : null;
      const inGutter = event.target instanceof Element && event.target.closest(".rail-gut") !== null;
      const label = tip.current;
      if (label !== null) {
        label.style.left = `${event.clientX}px`;
        label.style.top = `${event.clientY}px`;
        const name = target?.getAttribute("data-name");
        if (name === null || name === undefined) label.classList.remove("on");
        else {
          label.textContent = name;
          label.classList.add("on");
        }
      }
      const lane = target?.getAttribute("data-lane") ?? null;
      if (lane !== hot.current) {
        hot.current = lane;
        hotStack.current = target?.getAttribute("data-stack") === "1";
        paint();
      }
      setFan(inGutter && compressed);
    },
    [compressed, paint],
  );

  const onLeave = useCallback((): void => {
    hot.current = null;
    hotStack.current = false;
    paint();
    tip.current?.classList.remove("on");
    setFan(false);
  }, [paint]);

  /**
   * Fold the LIT lane — never a fresh hit-test of wherever the pointer happens to be.
   *
   * ⚠️ This is the whole of the fix for a gutter you could not click. Fanning MOVES the lanes, and it
   * has to: spreading them to a pitch a mouse can aim at needs more room than the squeezed layout
   * has, and no shift can hold the pointed-at lane still without pushing the trunk off the left edge
   * (every fanned centre is at or right of its squeezed one, by construction). So the lane you aimed
   * at is no longer under the pointer by the time the click lands, and asking the DOM again folded
   * whichever lane had slid into its place — and chasing it was no better, because moving re-picks.
   *
   * `hot` is held by identity and survives the re-render, so the highlight is a promise this keeps:
   * what is lit is what folds, with no second aim required. A STACKED column is refused rather than
   * folded — it is several lanes and there is no answer to which one, and the fan it just triggered
   * is already showing them separately to be picked from.
   */
  const onClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    // Still gated on the gutter: `hot` is stale the moment the pointer leaves without a `mousemove`
    // to clear it — a scroll, a focus change — and a click in a panel must not fold anything.
    const inGutter = event.target instanceof Element && event.target.closest(".rail-gut") !== null;
    const lane = hot.current;
    if (!inGutter || lane === null || hotStack.current) return;
    setShut((held) => {
      const next = new Set(held);
      if (!next.delete(lane)) next.add(lane);
      return next;
    });
  }, []);

  return (
    <div className={className === undefined ? "rail" : `rail ${className}`} ref={host} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}>
      {/*
        A fold or a fan re-renders this component and NOT the conversation inside it. `renderStep`
        hands back element objects its caller built once, so React sees the same reference for every
        panel and skips those subtrees — which is what makes changing the geometry on hover cost the
        gutters and nothing else, in a view that is otherwise hundreds of transcripts deep.
      */}
      {rows.map((row) => {
        // A row inside a rolled-up lane is not drawn. Its own enter row survives, because `open`
        // excludes the lane a row forks — which is exactly the row that has to stay as the handle.
        if (row.open.some((lane) => shut.has(lane.key))) return null;
        const rolled = row.enter !== undefined && shut.has(row.enter.lane.key) ? row.enter.lane : undefined;
        // Nor is the join of a lane whose fork was rolled up: the bump already said it left and came
        // back, and a join with no lane above it would come from nowhere.
        if (row.exit !== undefined && shut.has(row.exit.lane.key) && row.enter === undefined) return null;
        const held = rolled === undefined ? 0 : (inside.get(rolled.key) ?? 0);
        return (
          <div
            className={row.turn ? "rail-row rail-turn" : "rail-row"}
            // Not the row index: a live run inserts rows, and an index key would make every row after
            // the insertion a different row. A lane forks once and joins once, and a content row is
            // its step — so this is both stable and unique.
            key={`${row.exit?.lane.key ?? ""}|${row.enter?.lane.key ?? ""}|${row.step ?? ""}`}
          >
            <RailGutter row={row} centres={centres} columns={columns} folded={rolled !== undefined} palette={palette} />
            <div className="rail-content">
              {rolled !== undefined ? (
                <span className="rail-rolled">
                  <span className="rail-rolled-name mono">{rolled.stateId}</span>
                  <span className="rail-rolled-tag">rolled up</span>
                  <span>
                    {held} state{held === 1 ? "" : "s"}
                  </span>
                </span>
              ) : row.step === undefined ? null : (
                renderStep(row.step)
              )}
            </div>
          </div>
        );
      })}
      <div className="rail-tip" ref={tip} />
    </div>
  );
}
