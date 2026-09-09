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
  lobePath,
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
  mark,
  hideExit,
  here,
  cut,
}: {
  row: RailRow;
  centres: readonly number[];
  /** Which lane indices share a column, by the index of the lane that heads the column. */
  columns: Map<number, number[]>;
  /** Whether the lane this row enters is rolled up — it gets a bump and a plus instead of a fork. */
  folded: boolean;
  palette: Palette;
  /**
   * A lane this row opens and closes again inside itself — drawn as a lobe off the column to its
   * left. See {@link lobePath} and `RailedRows`' own `mark`.
   */
  mark?: RailLane | undefined;
  /**
   * Drop the join. Only ever true when the lane it would draw is FOLDED, in which case every row it
   * was open in is gone and the curve would arrive out of blank space — see `RailedRows`.
   */
  hideExit?: boolean;
  /** Halo the mark's knot: this is the row the reader is on. */
  here?: boolean;
  /** Halo the FORK's knot, in the danger colour: this is the row an armed rewind cuts at. */
  cut?: boolean;
}): JSX.Element {
  const lanes = Math.max(lanesOf(row), mark === undefined ? 0 : row.open.length + 1);
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

  const exit = hideExit === true ? undefined : row.exit;
  return (
    <div className="rail-gut" style={{ width: `${width}px` }}>
      {straights}
      {(row.turn || mark !== undefined) && (
        <svg className="rail-cap" viewBox={`0 0 ${width} ${CAP}`} preserveAspectRatio="none" aria-hidden="true">
          {mark !== undefined && (
            <RailLobe lane={mark} depth={row.open.length} centres={centres} palette={palette} here={here === true} />
          )}
          {exit !== undefined && (
            <path
              d={joinPath(centres, exit.depth, exit.depth - 1)}
              stroke={laneColour(exit.lane, exit.depth === 0, palette)}
              data-lane={exit.lane.key}
              data-name={exit.lane.stateId}
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
              cut={cut === true}
            />
          )}
        </svg>
      )}
    </div>
  );
}

/**
 * A state that opens a lane and closes it inside its own row — see {@link lobePath}.
 *
 * The knot sits at the far side rather than on the parent, because the knot is what NAMES the thing
 * this row is about, and here that is the lane going out rather than the one it left. It keeps the
 * state's own hue in both cases: the colour is how a reader matches a row here to a panel in the
 * conversation, and an accent knot would spend it on saying something the chip beside it already says.
 */
function RailLobe({
  lane,
  depth,
  centres,
  palette,
  here,
}: {
  lane: RailLane;
  /** How many lanes are already open — the column this one goes out from. */
  depth: number;
  centres: readonly number[];
  palette: Palette;
  here: boolean;
}): JSX.Element {
  const colour = laneColour(lane, false, palette);
  const cx = centres[depth] ?? 0;
  return (
    <>
      <path d={lobePath(centres, depth - 1, depth)} stroke={colour} data-lane={lane.key} data-name={lane.stateId} />
      <circle
        className="rail-knot"
        cx={cx}
        cy={MID}
        r={3.5}
        fill="var(--bg)"
        stroke={colour}
        strokeWidth={2}
        data-lane={lane.key}
        data-name={lane.stateId}
      />
      {here && <circle className="rail-halo" cx={cx} cy={MID} r={7.5} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
      <circle className="rail-hit" cx={cx} cy={MID} r={9} data-lane={lane.key} data-name={lane.stateId} />
    </>
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
  cut,
}: {
  lane: RailLane;
  depth: number;
  root: boolean;
  centres: readonly number[];
  folded: boolean;
  palette: Palette;
  /** The ring an armed rewind puts on the knot it cuts at — the index's "you are here", in the danger colour. */
  cut: boolean;
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
      {cut && <circle className="rail-halo cut" cx={cx} cy={MID} r={7.5} fill="none" stroke="var(--bad)" strokeWidth={1.5} />}
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
  mark,
  rowClass,
  renderRolled,
  palette: given,
  shut: held,
  onShut,
  foldable,
  onPick,
  onContext,
}: {
  steps: readonly RailStep[];
  /** What row `index` of `steps` draws. */
  renderStep: (index: number) => ReactNode;
  className?: string;
  /**
   * A right-click on a lane in the gutter — its knot, or the line itself. The lane's key, and
   * where the pointer was, for a host with verbs to offer about the state (a rewind, a fork). Absent
   * ⇒ the gutter has no menu and the browser's own is left alone.
   */
  onContext?: ((key: string, point: { x: number; y: number }) => void) | undefined;
  /**
   * A step that opens a lane and closes it again in its own row, drawn as a lobe rather than as a
   * fork and a join — see {@link RailLobe}. Absent ⇒ every step is an ordinary row.
   */
  mark?: ((index: number) => RailLane | undefined) | undefined;
  /** Extra classes for a step's row — what marks the row the reader is on. */
  rowClass?: ((index: number) => string | undefined) | undefined;
  /**
   * What a rolled-up lane says in place of its contents. Absent ⇒ the standing `.rail-rolled` line.
   *
   * The index overrides it because there a fold hides LABELS rather than pages: swapping the row for
   * a different kind of row would take away the name, the outcome and the chevron that was just
   * clicked, which is the handle you fold with.
   */
  renderRolled?: ((lane: RailLane, held: number) => ReactNode) | undefined;
  /**
   * The lane colours, when the caller needs them STABLE across renders.
   *
   * A hue is a state's position in the order states first appear, so derived from whatever steps are
   * currently on screen it moves: fold a loop and every state after it shifts one rung down the
   * ladder. A caller that folds rows out of its own step list has to hand the palette in, built once.
   */
  palette?: Palette | undefined;
  /** Folded lanes, controlled. Absent ⇒ this component remembers them itself. */
  shut?: ReadonlySet<string> | undefined;
  onShut?: ((next: ReadonlySet<string>) => void) | undefined;
  /** Whether a lane can be folded at all. Absent ⇒ all of them can. */
  foldable?: ((key: string) => boolean) | undefined;
  /** A click on a lane that {@link foldable} refused — a lane with nothing under it to fold. */
  onPick?: ((key: string) => void) | undefined;
}): JSX.Element {
  const { rows, deepest: reached } = useMemo(() => railOf(steps), [steps]);
  // A lobe reaches one column past the lanes open on its row, and nothing else on the page knows to
  // make room for it. Asked once, over the whole run, for the same reason the spacing is: centres
  // that changed per row would kink every straight in the drawing.
  const deepest = useMemo(
    () =>
      mark === undefined
        ? reached
        : rows.reduce(
            (most, row) =>
              row.step !== undefined && mark(row.step) !== undefined ? Math.max(most, row.open.length + 1) : most,
            reached,
          ),
    [rows, reached, mark],
  );
  const derived = useMemo(() => paletteOf(steps), [steps]);
  const palette = given ?? derived;
  const inside = useMemo(() => insideOf(rows), [rows]);
  const [own, setOwn] = useState<ReadonlySet<string>>(() => new Set());
  const shut = held ?? own;
  const setShut = useCallback(
    (next: (previous: ReadonlySet<string>) => ReadonlySet<string>): void => {
      if (held !== undefined && onShut !== undefined) onShut(next(held));
      else setOwn(next);
    },
    [held, onShut],
  );
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
    // A lane with nothing under it cannot be folded, and doing nothing is the wrong answer: it lit
    // up under the pointer, so it has to answer. The caller says what that means.
    if (foldable !== undefined && !foldable(lane)) {
      onPick?.(lane);
      return;
    }
    setShut((was) => {
      const next = new Set(was);
      if (!next.delete(lane)) next.add(lane);
      return next;
    });
  }, [foldable, onPick, setShut]);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (onContext === undefined) return;
      const target = event.target instanceof Element ? event.target.closest("[data-lane]") : null;
      const inGutter = event.target instanceof Element && event.target.closest(".rail-gut") !== null;
      const key = target?.getAttribute("data-lane");
      if (!inGutter || key === null || key === undefined) return;
      event.preventDefault();
      onContext(key, { x: event.clientX, y: event.clientY });
    },
    [onContext],
  );

  return (
    <div
      className={className === undefined ? "rail" : `rail ${className}`}
      ref={host}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
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
        /*
         * Nor is the join of a lane whose fork was rolled up: the bump already said it left and came
         * back, and a join with no lane above it would come from nowhere.
         *
         * ⚠️ Only when the row does nothing ELSE. A join and the fork that follows it at the same
         * depth are ONE row — see `push` in `rail.ts` — so on a folded lane whose sibling comes next,
         * dropping the row takes that sibling's fork with it and keeping it draws a curve arriving
         * out of blank space. Suppressing just the join is the only reading that leaves both true.
         */
        const orphan = row.exit !== undefined && shut.has(row.exit.lane.key);
        if (orphan && row.enter === undefined) return null;
        const held = rolled === undefined ? 0 : (inside.get(rolled.key) ?? 0);
        const lobe = row.step === undefined ? undefined : mark?.(row.step);
        const extra = row.step === undefined ? undefined : rowClass?.(row.step);
        return (
          <div
            className={
              [row.turn || lobe !== undefined ? "rail-row rail-turn" : "rail-row", extra]
                .filter((one) => one !== undefined && one.length > 0)
                .join(" ")
            }
            // Not the row index: a live run inserts rows, and an index key would make every row after
            // the insertion a different row. A lane forks once and joins once, and a content row is
            // its step — so this is both stable and unique.
            key={`${row.exit?.lane.key ?? ""}|${row.enter?.lane.key ?? ""}|${row.step ?? ""}`}
          >
            <RailGutter
              row={row}
              centres={centres}
              columns={columns}
              folded={rolled !== undefined}
              palette={palette}
              {...(lobe !== undefined ? { mark: lobe } : {})}
              {...(orphan ? { hideExit: true } : {})}
              {...(extra !== undefined && extra.includes("is-here") ? { here: true } : {})}
              {...(extra !== undefined && extra.includes("is-cut") ? { cut: true } : {})}
            />
            <div className="rail-content">
              {rolled !== undefined ? (
                (renderRolled?.(rolled, held) ?? (
                  <span className="rail-rolled">
                    <span className="rail-rolled-name mono">{rolled.stateId}</span>
                    <span className="rail-rolled-tag">rolled up</span>
                    <span>
                      {held} state{held === 1 ? "" : "s"}
                    </span>
                  </span>
                ))
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
