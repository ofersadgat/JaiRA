/**
 * The state hierarchy as a RAIL down the left of the conversation.
 *
 * The panels say what each state said; the order they are in says when. Neither says how the states
 * are NESTED — and nesting is most of what a workflow is. `entered product → explore` carried the
 * whole of it in one line of grey text, which meant the shape of a run could only be read by holding
 * a dozen of those sentences in your head at once and hoping none of them scrolled past.
 *
 * So the shape is drawn instead. One lane per state the run is currently inside, forking in where it
 * enters one and joining back out where it leaves. A lane's COLOUR comes from the state id, so the
 * same colour twice is the same state twice — which is what a loop looks like, and is a fact nothing
 * else on the page states.
 *
 * ## What this module is, and is not
 *
 * It is arithmetic. Lane bookkeeping and lane geometry, both pure, both testable without a DOM. The
 * drawing is `railView.tsx`; the sequence of rows is assembled by whoever is rendering them.
 *
 * ## Lanes are opened by ENTERING, and closed by inference
 *
 * The journal records a state being walked into (`instance.entered`, which arrives here as a step
 * with {@link RailStep.opens}) and does not record it being walked out of. It does not need to: a row
 * whose own path is no longer underneath an open lane is proof that lane closed, and the closing is
 * emitted at the row that proves it. That is also why a lane is identified by its INSTANCE and not by
 * its state id — `explore` running twice is two lanes with one colour, and a rail that keyed on the
 * name would draw the second pass as a continuation of the first.
 */

/** How tall a row that forks or joins is. Fixed, because the curves are drawn inside it. */
export const CAP = 34;
/** The vertical middle of a cap — where a fork's knot sits and where a join meets its parent. */
export const MID = CAP / 2;
/** The first lane's centre, and the gutter's own left margin. */
const PAD = 9;
/** The gap between two lanes while there is room for all of them. */
export const PITCH = 18;
/**
 * How the gutter spends its pixels once there is not room.
 *
 * `FULL` gaps at the DEEP end stay at full pitch — the lanes being read keep their room — and
 * everything shallower decays by `RATIO`. Because a geometric tail converges, the lanes span at most
 * `FULL * PITCH + PITCH * RATIO / (1 - RATIO)` ≈ 126px at any depth whatsoever, and the gutter is
 * that plus `PAD`, `TAIL` and the trunk's own floor — under 152px, by construction rather than by a
 * cap somebody has to remember to apply. `MIN_GAP` is where two lanes stop being two lines;
 * `ROOT_GAP` is the floor the trunk never goes below, because it is the one lane that is always
 * there and always clickable.
 */
const FULL = 3;
const RATIO = 0.8;
const MIN_GAP = 2;
const ROOT_GAP = 5;
/**
 * The gap a FANNED gutter guarantees — enough to aim a mouse at, and not one pixel more.
 *
 * Fanning used to go all the way back to full pitch, and the cost of that is movement: every lane
 * right of a widened gap slides, so the lane being pointed at is somewhere else by the time the click
 * lands. Nothing can avoid moving them — every fanned centre is at or right of its squeezed one, so
 * no shift holds one still without pushing the trunk off the left edge — but the DISTANCE is a
 * choice, and full pitch was several times further than the job needs. Measured on the deepest lane:
 * 0.6px at eight deep against 29.5, 23.8 at fourteen against 112.7, 64.7 at twenty against 213.5.
 * And a run of seven or fewer has no gap under this at all, so it never fans and never moves.
 */
const FAN_MIN = 8;
/** The space between the deepest lane and the content beside it. */
const TAIL = 11;

/**
 * The gap between a lane and the one on its left, indexed from the DEEPEST lane inward.
 *
 * ⚠️ From the RIGHT, and that is the whole design. Indexed from the left, every gap is a function of
 * the total depth — so entering one more state re-spaces every existing lane, several of them cross
 * the stacking threshold at once, and the deep gaps grow PAST full pitch to take up the slack, which
 * reads as the drawing lurching sideways at one particular depth. Indexed from the right, an existing
 * gap never moves: going one deeper only appends one new, smaller gap at the shallow end. Which is
 * also why exactly one lane can ever stack at a time.
 */
const gapAt = (j: number): number => (j < FULL ? PITCH : PITCH * RATIO ** (j - FULL + 1));

/**
 * Lane centres, in px — the single array both the straights and the curves read.
 *
 * Computed once per run from its deepest point, never per row: spacing that changed as lanes opened
 * would kink every straight line in the drawing.
 *
 * `fan` raises every gap to {@link FAN_MIN} and leaves the rest alone. That is what a squeezed gutter
 * does while it is being pointed at, because a 3px gap is not something anybody can aim a mouse at —
 * and it is a FLOOR rather than a reset, so the gaps that were already wide enough do not move.
 */
export function centresFor(depth: number, fan = false): number[] {
  if (depth <= 1) return [PAD];
  const centres = [PAD];
  for (let i = 1; i < depth; i++) {
    // The trunk keeps a floor: it is the lane that is always present and always clickable.
    const gap = Math.max(gapAt(depth - 1 - i), i === 1 ? ROOT_GAP : 0, fan ? FAN_MIN : 0);
    centres.push(centres[i - 1]! + gap);
  }
  return centres;
}

/**
 * Whether a gutter this deep has gaps too tight to aim at, and so is worth fanning at all.
 *
 * Asked of the run's DEPTH rather than of the centres currently drawn. Asked of those, it is false
 * the moment the gutter fans — which un-fans it, which makes it true again, sixty times a second.
 */
export function needsFan(depth: number): boolean {
  const centres = centresFor(depth);
  return centres.some((c, i) => i > 0 && c - centres[i - 1]! < FAN_MIN - 0.01);
}

/**
 * Which lanes share a column — the ones whose gap has fallen under a couple of pixels.
 *
 * Lane 0 is never absorbed. Everything else merges leftward, so a stack always grows from the shallow
 * end and the deepest lanes stay separate however far down the run goes. Returned as groups in lane
 * order; a group of one is a lane with a column to itself.
 */
export function stacksOf(centres: readonly number[]): number[][] {
  const groups: number[][] = [];
  let current = [0];
  for (let i = 1; i < centres.length; i++) {
    if (i > 1 && centres[i]! - centres[i - 1]! < MIN_GAP) current.push(i);
    else {
      groups.push(current);
      current = [i];
    }
  }
  groups.push(current);
  return groups;
}

/** How wide the gutter is when `lanes` of them are open. What makes the content step in and out. */
export function gutterWidth(centres: readonly number[], lanes: number): number {
  return (centres[Math.max(0, Math.min(lanes, centres.length) - 1)] ?? PAD) + TAIL;
}

/**
 * A stacked column, drawn as its members' colours in turn.
 *
 * One segment per lane in the stack, repeating down the line — so the number of colours IS the number
 * of lanes folded into that column, and a state can still be found by its hue without hovering
 * anything.
 */
export function stackPaint(colours: readonly string[]): string {
  const height = 9;
  const gap = 3;
  const period = colours.length * (height + gap);
  const stops = colours.map((colour, i) => {
    const a = i * (height + gap);
    return `${colour} ${a}px ${a + height}px, transparent ${a + height}px ${a + height + gap}px`;
  });
  return `repeating-linear-gradient(180deg, ${stops.join(", ")}) 0 0 / 100% ${period}px`;
}

/** The fork: a lane diving from its parent's column into its own, ending at the row's bottom edge. */
export function forkPath(centres: readonly number[], from: number, to: number): string {
  const a = centres[from] ?? PAD;
  const b = centres[to] ?? PAD;
  return `M${a} ${MID} C ${a} ${MID + 7}, ${b} ${MID + 5}, ${b} ${CAP}`;
}

/** The join: a lane arriving from the row's top edge and merging into its parent's column. */
export function joinPath(centres: readonly number[], from: number, to: number): string {
  const a = centres[from] ?? PAD;
  const b = centres[to] ?? PAD;
  return `M${a} 0 C ${a} ${MID - 5}, ${b} ${MID - 7}, ${b} ${MID}`;
}

/**
 * Out and straight back in — what a FOLDED lane leaves behind.
 *
 * A rolled-up state still happened, and the bump is the trace of it: the rail leaves the trunk and
 * rejoins immediately, so the shape of the run still shows a detour where one was taken. Drawn
 * alongside the plus in the knot, which is the thing you click to get it back.
 */
export function bumpPath(centres: readonly number[], from: number, to: number): string {
  const a = centres[from] ?? PAD;
  const b = centres[to] ?? PAD;
  return (
    `M${a} ${MID} C ${a} ${MID + 5}, ${b} ${MID + 4}, ${b} ${MID + 9}` +
    ` C ${b} ${MID + 14}, ${a} ${MID + 13}, ${a} ${CAP}`
  );
}

/**
 * Out and straight back, CENTRED on the row — a state that opens a lane and closes it again inside
 * the one row it owns.
 *
 * The same gesture as {@link bumpPath} and drawn for the same reason: a lane that leaves and rejoins
 * immediately is a detour the run took, and the shape is the trace of it. The difference is where it
 * sits. `bumpPath` hangs off the bottom half of a cap because there it TRAILS a fork; this one is the
 * whole of its row, because a state with nothing under it has no fork to trail and no rows to run a
 * straight through.
 *
 * Which is what makes it the right mark for an index. Drawn as an ordinary fork and join, such a
 * state is a curve down-left and a curve down-right meeting in the middle — a chevron with no line
 * in it — and a column of them is a saw blade rather than a list of states.
 */
export function lobePath(centres: readonly number[], from: number, to: number): string {
  const a = centres[from] ?? PAD;
  const b = centres[to] ?? PAD;
  return (
    `M${a} 0 C ${a} ${MID - 9}, ${b} ${MID - 8}, ${b} ${MID}` +
    ` C ${b} ${MID + 8}, ${a} ${MID + 9}, ${a} ${CAP}`
  );
}

// --- lane bookkeeping ---------------------------------------------------------

/**
 * One row of the conversation, as the rail sees it.
 *
 * `at` is the chain of child keys from the top, and it is the only thing that decides depth. A row
 * that OPENS a state names that state as its last segment; every other row names the state it happens
 * INSIDE.
 */
export interface RailStep {
  /** This row's own identity — an instance, so two passes of a loop are two lanes. */
  key: string;
  /** What the lane is called on hover, and what its colour is derived from. */
  stateId: string;
  /** `["product", "explore"]`. Empty is the top of the view. */
  at: readonly string[];
  /** True when this row is a state being walked INTO — the row that forks its lane off its parent. */
  opens: boolean;
}

/** A state the run is currently inside. Identified by instance; coloured by state. */
export interface RailLane {
  key: string;
  stateId: string;
  /** The lane's own full path, which is what says whether a later row is still underneath it. */
  at: readonly string[];
}

/** One drawn row: the lanes running through it, and the fork or join that happens in it. */
export interface RailRow {
  /** Lanes crossing this row top to bottom, shallowest first. */
  open: readonly RailLane[];
  /** A lane forking off its parent here. Not in {@link open} — it starts half way down. */
  enter?: { lane: RailLane; depth: number; root: boolean };
  /** A lane joining its parent here. Not in {@link open} — it ends half way down. */
  exit?: { lane: RailLane; depth: number };
  /** Which step's content this row carries. Absent ⇒ a row that only LEAVES a state. */
  step?: number;
  /** Whether a curve is drawn in this row, and so whether it is exactly one cap tall. */
  turn: boolean;
}

/** How many lane columns a row needs — what its gutter is as wide as. */
export function lanesOf(row: RailRow): number {
  return Math.max(
    row.open.length,
    row.enter === undefined ? 0 : row.enter.depth + 1,
    row.exit === undefined ? 0 : row.exit.depth + 1,
    1,
  );
}

/** Whether `at` is at or underneath `lane` — the test that says a lane is still open. */
function holds(lane: RailLane, at: readonly string[]): boolean {
  return lane.at.length <= at.length && lane.at.every((key, i) => at[i] === key);
}

/**
 * Turn a sequence of rows into lanes.
 *
 * The whole of it is one rule: **before a row is drawn, every open lane that does not hold its path
 * is closed.** Entering forks a lane; anything else is drawn against the lanes already open. Closures
 * become rows of their own, because leaving a state is something that happened and the join has to be
 * somewhere — except for the last one before a fork at the same depth, which merges with it. That is
 * the ordinary case: one sibling ending and the next beginning is a single row that reads as the run
 * stepping across.
 *
 * A row whose path is DEEPER than anything open opens the missing lanes silently. That should not
 * happen — the journal records every entry — but a projection with a hole in it would otherwise draw
 * a panel at its grandparent's depth, claiming a nesting the run did not have.
 *
 * **The trunk is never closed.** The lane at depth 0 is the run itself as this view reads it — drawn
 * in the rule colour, it is the spine every other lane forks off. A row at the top of the view (the
 * run's own note: its terminate, a fork's seam, an armed cut at the root) is drawn ON that spine, and
 * the spine runs off the bottom of the last row rather than curving into nothing. It used to close
 * like any other lane: the run's last note sat below a join with no line beside it, and the rail
 * read as broken where the run had merely ended. A sibling at depth 0 still closes the one before it,
 * because that is the run stepping sideways and the two curves are one row.
 */
export function railOf(steps: readonly RailStep[]): { rows: RailRow[]; deepest: number } {
  const stack: RailLane[] = [];
  const rows: RailRow[] = [];

  const push = (row: RailRow): void => {
    const previous = rows[rows.length - 1];
    // A join and the fork that follows it at the same depth are one row: `explore` ending and
    // `draft` beginning is the run stepping sideways, not two separate events with a gap between.
    if (
      row.enter !== undefined &&
      row.step !== undefined &&
      previous !== undefined &&
      previous.exit !== undefined &&
      previous.enter === undefined &&
      previous.open.length === row.open.length
    ) {
      previous.enter = row.enter;
      previous.step = row.step;
      return;
    }
    rows.push(row);
  };

  const closeTo = (at: readonly string[]): void => {
    while (stack.length > 0 && !holds(stack[stack.length - 1]!, at)) {
      const gone = stack.pop()!;
      push({ open: [...stack], exit: { lane: gone, depth: stack.length }, turn: true });
    }
  };

  const open = (lane: RailLane, step?: number): void => {
    push({
      open: [...stack],
      enter: { lane, depth: stack.length, root: stack.length === 0 },
      ...(step !== undefined ? { step } : {}),
      turn: true,
    });
    stack.push(lane);
  };

  /** Close everything under the trunk, and keep the trunk — see above. */
  const closeUnderTrunk = (): void => {
    if (stack.length > 0) closeTo(stack[0]!.at);
  };

  for (const [i, step] of steps.entries()) {
    const inside = step.opens ? step.at.slice(0, -1) : step.at;
    if (!step.opens && inside.length === 0) closeUnderTrunk();
    else closeTo(inside);
    if (step.opens) {
      open({ key: step.key, stateId: step.stateId, at: step.at }, i);
      continue;
    }
    // A hole in the record: this row is deeper than anything open. Fill it in rather than drawing the
    // row at a depth the run was not at — see the note above.
    for (let d = stack.length; d < inside.length; d++) {
      const at = inside.slice(0, d + 1);
      open({ key: `${step.key}/${at.join("/")}`, stateId: at[d]!, at });
    }
    push({ open: [...stack], step: i, turn: false });
  }
  closeUnderTrunk();

  const deepest = rows.reduce((most, row) => Math.max(most, lanesOf(row)), 1);
  return { rows, deepest };
}

/**
 * How many states a folded lane is standing in for — what its rolled-up row reports.
 *
 * Counted as lanes FORKED underneath it rather than as rows hidden, because that is the question a
 * fold raises: not how much of the page went away, but how much of the run did.
 */
export function insideOf(rows: readonly RailRow[]): Map<string, number> {
  const inside = new Map<string, number>();
  for (const row of rows) {
    if (row.enter === undefined) continue;
    for (const lane of row.open) inside.set(lane.key, (inside.get(lane.key) ?? 0) + 1);
  }
  return inside;
}

/**
 * The golden angle. Each new hue lands in the largest gap left by the ones before it.
 *
 * Which is the property that makes the ladder below work while a run is still going: hues are handed
 * out as states appear, so the eighth state is as far from the other seven as it can be without any
 * of them moving.
 */
const GOLDEN = 137.508;
/** Where the ladder starts. Anywhere; not pure red, which reads as an error against `--bad`. */
const HUE0 = 18;

/**
 * A colour per state, handed out in the order the states first appear.
 *
 * ⚠️ NOT a hash of the state id, which is what this was. A hash is stable across runs and that sounds
 * like the better property until you look at one: hashing the feature workflow's own names put
 * `explore` at 204°, `critique` at 217° and `plan` at 224° — three lanes in one run that a reader
 * cannot tell apart — and `synthesize` and `design` four degrees apart. Nothing about a hash prevents
 * that, and no amount of mixing does: sixteen draws from a 360° wheel collide, and a scheme that
 * quantises to buckets to avoid near-misses buys exact collisions instead.
 *
 * The property that actually matters is LOCAL: within one run, two lanes of one colour are the same
 * state. So the wheel is spent on the states in front of you rather than on every state that could
 * exist. Ordered by first appearance and stepped by the golden angle, which means a live run only
 * ever appends — a state entered for the first time takes the next hue and no lane already on screen
 * changes colour underneath the person reading it. The cost is that one state is not the same colour
 * in two different runs, which is a comparison nothing in this view invites.
 *
 * ⚠️ WHICH LIST IS HANDED IN IS THE WHOLE ANSWER, and two readings of one run must not each build
 * their own. A hue is a POSITION, so a list that omits a state — or orders it differently — moves
 * every hue after it, and the conversation and the index then disagree about what colour `draft` is
 * while both are drawing the same run. `paletteOfRun` in `runIndex.tsx` is the one list; this takes
 * anything with a name so it can be given that rather than a set of rows.
 */
export function paletteOf(steps: readonly { stateId: string }[]): Map<string, string> {
  const hues = new Map<string, number>();
  for (const step of steps) {
    if (step.stateId === "" || hues.has(step.stateId)) continue;
    hues.set(step.stateId, (HUE0 + hues.size * GOLDEN) % 360);
  }
  return new Map([...hues].map(([id, hue]) => [id, `hsl(${hue.toFixed(1)} var(--rail-s) var(--rail-l))`]));
}
