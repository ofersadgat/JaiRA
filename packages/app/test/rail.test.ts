/**
 * The rail — see `rail.ts`.
 *
 * Two claims are being tested and they are unrelated to each other. The first is BOOKKEEPING: which
 * lanes are open on which row, given a run that only ever says where it went and never says it came
 * back. The second is GEOMETRY: that the gutter stays bounded and stays still as a run goes deeper,
 * which is the property the whole spacing scheme exists for and the one that is easy to lose.
 */
import { describe, expect, it } from "vitest";
import {
  centresFor,
  PITCH,
  gutterWidth,
  insideOf,
  lanesOf,
  needsFan,
  paletteOf,
  railOf,
  stacksOf,
  type RailStep,
} from "../src/renderer/rail";

/** `enter("product/explore", "i3")` — a row that walks into a state. */
const enter = (path: string, key: string): RailStep => ({
  key,
  stateId: path.split("/").pop()!,
  at: path.split("/"),
  opens: true,
});

/** `inside("product/explore")` — a row that happens in a state already open: a panel, or a failure. */
const inside = (path: string, key = `n${path}`): RailStep => ({
  key,
  stateId: path.split("/").pop()!,
  at: path === "" ? [] : path.split("/"),
  opens: false,
});

/** Every row as `depth:what`, which is the whole of what the rail says. */
const shape = (steps: readonly RailStep[]): string[] =>
  railOf(steps).rows.map((row) => {
    const parts = [`open=${row.open.map((lane) => lane.stateId).join(",")}`];
    if (row.exit !== undefined) parts.push(`join ${row.exit.lane.stateId}@${row.exit.depth}`);
    if (row.enter !== undefined) parts.push(`fork ${row.enter.lane.stateId}@${row.enter.depth}`);
    if (row.step !== undefined) parts.push(`step ${row.step}`);
    return parts.join(" ");
  });

describe("opening and closing lanes", () => {
  it("forks a lane where a state is entered, and leaves it out of that row's straights", () => {
    // The entering lane starts HALF WAY DOWN the row — that is what the curve is — so drawing a
    // straight for it as well would put a line above the point it came into existence.
    const { rows } = railOf([enter("product", "i1")]);
    expect(rows[0]!.open).toEqual([]);
    expect(rows[0]!.enter).toMatchObject({ depth: 0, root: true });
  });

  it("closes a lane at the row that PROVES it closed, because nothing records leaving", () => {
    // The journal has `instance.entered` and no counterpart. A row whose own path is no longer
    // underneath an open lane is the evidence, and the join is drawn there.
    expect(shape([enter("product", "i1"), enter("product/context", "i2"), inside("product")])).toEqual([
      "open= fork product@0 step 0",
      "open=product fork context@1 step 1",
      // The join gets a row of its own rather than merging into the content below it. Only a FORK
      // merges with a join, and only because both are curves that fit in the same fixed-height row —
      // a content row is as tall as what it says, and a curve stretched to that height is not a curve.
      "open=product join context@1",
      "open=product step 2",
      "open= join product@0",
    ]);
  });

  it("merges a join with the fork that follows it at the same depth", () => {
    // One sibling ending and the next beginning is the run stepping sideways: one row, one curve out
    // and one curve in. Two rows would put a gap in the middle of a single move.
    const rows = shape([
      enter("product", "i1"),
      enter("product/context", "i2"),
      enter("product/draft", "i3"),
    ]);
    expect(rows[2]).toBe("open=product join context@1 fork draft@1 step 2");
  });

  it("closes every lane at the end, so a run that ends deep still joins back to the trunk", () => {
    const rows = shape([enter("a", "i1"), enter("a/b", "i2"), enter("a/b/c", "i3")]);
    expect(rows.slice(3)).toEqual(["open=a,b join c@2", "open=a join b@1", "open= join a@0"]);
  });

  it("gives a loop TWO lanes with one colour — which is what makes a loop legible", () => {
    // Keyed on the instance, so the second pass is a second lane; coloured by the state, so it is
    // recognisably the same state. A rail keyed on the name would draw the second pass as a
    // continuation of the first, which is the one thing a loop is not.
    const { rows } = railOf([
      enter("product", "i1"),
      enter("product/explore", "i2"),
      enter("product/explore", "i3"),
    ]);
    const forks = rows.flatMap((row) => (row.enter === undefined ? [] : [row.enter.lane]));
    expect(forks.map((lane) => lane.key)).toEqual(["i1", "i2", "i3"]);
    expect(forks[1]!.stateId).toBe(forks[2]!.stateId);
  });

  it("re-enters a state it never left, closing the first pass first", () => {
    // `explore` looping while its own child is still open. The child closes, then `explore` itself,
    // and only then does the second pass fork — otherwise the second pass would be drawn as a child
    // of the first.
    const rows = shape([
      enter("p", "i1"),
      enter("p/ex", "i2"),
      enter("p/ex/brief", "i3"),
      enter("p/ex", "i4"),
    ]);
    expect(rows.slice(3)).toEqual([
      "open=p,ex join brief@2",
      "open=p join ex@1 fork ex@1 step 3",
      "open=p join ex@1",
      "open= join p@0",
    ]);
  });

  it("opens the lanes a hole in the record never mentioned, rather than drawing at the wrong depth", () => {
    // Should not happen — every entry is journalled. But a panel drawn at its grandparent's depth
    // would claim a nesting the run did not have, which is worse than an unlabelled lane.
    const { rows } = railOf([enter("a", "i1"), inside("a/b/c")]);
    const content = rows.find((row) => row.step === 1)!;
    expect(content.open.map((lane) => lane.stateId)).toEqual(["a", "b", "c"]);
  });

  it("counts what a folded lane is standing in for, as states rather than as rows", () => {
    // The question a fold raises is not how much of the page went away but how much of the run did.
    const { rows } = railOf([
      enter("p", "i1"),
      enter("p/a", "i2"),
      inside("p/a"),
      enter("p/b", "i3"),
    ]);
    expect(insideOf(rows).get("i1")).toBe(2);
  });
});

describe("how wide the gutter is", () => {
  it("steps in and out with the lanes open on THAT row — the content indent", () => {
    // Sized to the run's full depth instead, as it was, the content edge never moves and the indent
    // is a claim the drawing does not keep.
    const { rows, deepest } = railOf([enter("a", "i1"), enter("a/b", "i2"), inside("a/b"), inside("a")]);
    const centres = centresFor(deepest);
    const widths = rows.map((row) => gutterWidth(centres, lanesOf(row)));
    expect(widths[0]).toBeLessThan(widths[1]!);
    expect(widths[widths.length - 1]).toBeLessThan(widths[1]!);
  });
});

describe("how the gutter spends its pixels", () => {
  const gapsAt = (depth: number): number[] => {
    const centres = centresFor(depth);
    return centres.slice(1).map((c, i) => c - centres[i]!);
  };

  it("stays bounded however deep the run goes", () => {
    // A geometric tail converges, so the lanes span at most `FULL * PITCH + PITCH * RATIO / (1 -
    // RATIO)` ≈ 126px — by construction rather than by a cap somebody has to remember to apply. The
    // gutter is that plus the trunk's own margin and the space before the content.
    for (const depth of [10, 25, 60, 200]) {
      expect(gutterWidth(centresFor(depth), depth)).toBeLessThan(152);
    }
    expect(gutterWidth(centresFor(200), 200)).toBeGreaterThan(gutterWidth(centresFor(60), 60));
  });

  it("never moves an existing gap when the run goes one deeper", () => {
    // The property the whole scheme is for. Indexed from the LEFT, every gap is a function of the
    // total depth: one more state re-spaces every lane, several cross the stacking threshold at once,
    // and the deep gaps grow past full pitch to take up the slack — which reads as the drawing
    // lurching sideways at one particular depth. Indexed from the right, going deeper only appends
    // one new, smaller gap at the shallow end.
    for (let depth = 4; depth < 30; depth++) {
      const before = gapsAt(depth);
      const after = gapsAt(depth + 1);
      // Compared from the DEEP end, and one shorter: the shallowest gap of each is the one that is
      // allowed to differ, because that is where the new one is inserted.
      const kept = before.length - 1;
      // Approximately, because the centres are an accumulated sum and the gaps are read back out of
      // it. The claim is that the gap does not MOVE, not that floating point is associative.
      for (const [i, gap] of after.slice(-kept).entries()) expect(gap).toBeCloseTo(before.slice(-kept)[i]!, 9);
    }
  });

  it("stacks at most one more lane per level", () => {
    // Three at once was the jump from 8 deep to 9 that made the drawing look like it broke.
    let previous = 0;
    for (let depth = 1; depth < 40; depth++) {
      const folded = stacksOf(centresFor(depth))
        .filter((group) => group.length > 1)
        .reduce((n, group) => n + group.length - 1, 0);
      expect(folded - previous).toBeLessThanOrEqual(1);
      expect(folded).toBeGreaterThanOrEqual(previous);
      previous = folded;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("never absorbs the trunk, whatever the depth", () => {
    // Lane 0 is the one that is always there and always clickable — it is the way back out of a run
    // that has been rolled up.
    for (const depth of [20, 50, 120]) {
      expect(stacksOf(centresFor(depth))[0]).toEqual([0]);
    }
  });

  it("opens every gap to something aimable when it is fanned, and nothing more", () => {
    // A FLOOR, not a reset. Fanning back to full pitch made every lane right of a widened gap slide,
    // which is what made a squeezed gutter impossible to click: the lane you aimed at was somewhere
    // else by the time the click landed. Nothing can hold it perfectly still — every fanned centre is
    // at or right of its squeezed one — but this moves it about a third as far.
    const fanned = centresFor(20, true);
    const gaps = fanned.slice(1).map((c, i) => c - fanned[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
    expect(stacksOf(fanned).every((group) => group.length === 1)).toBe(true);

    const still = centresFor(20);
    const before = still.slice(1).map((c, i) => c - still[i]!);
    // The gaps that were already wide enough do not move at all.
    for (const [i, gap] of before.entries()) if (gap >= 8) expect(gaps[i]).toBeCloseTo(gap, 9);
    // And the claim that matters, against the thing it replaced: a fan to uniform pitch, which is
    // what this was, moves the deepest lane more than three times as far.
    const uniform = still[0]! + 19 * PITCH;
    expect(fanned[19]! - still[19]!).toBeLessThan((uniform - still[19]!) / 3);
  });

  it("does not fan a run that is shallow enough to aim at as it is", () => {
    // Which is most of them — and there, nothing moves on hover at any point.
    expect(needsFan(7)).toBe(false);
    expect(needsFan(12)).toBe(true);
  });
});

/** The hue ladder — see `paletteOf`. */
describe("what colour a lane is", () => {
  const hue = (colour: string): number => Number(colour.slice(colour.indexOf("(") + 1, colour.indexOf(" ")));
  const run = (...names: string[]): RailStep[] => names.map((name, i) => enter(name, `i${i}`));

  it("gives one state one colour, however many times it is entered", () => {
    const palette = paletteOf(run("product", "explore", "draft", "explore"));
    expect(palette.size).toBe(3);
    expect(palette.get("explore")).toBe(palette.get("explore"));
  });

  it("keeps every pair in a run well apart, which a hash of the state id did not", () => {
    // The names that made this necessary: hashed, `explore` `critique` and `plan` landed inside 20°
    // of each other and `synthesize` and `design` inside four — three lanes in one run that a reader
    // cannot tell apart, in the workflow this view was built for.
    const hues = [...paletteOf(run("product", "context", "explore", "brief", "synthesize", "verdict", "draft", "critique", "confidence", "design")).values()]
      .map(hue)
      .sort((a, b) => a - b);
    const gaps = hues.slice(1).map((h, i) => h - hues[i]!);
    expect(Math.min(...gaps)).toBeGreaterThan(19);
  });

  it("only ever APPENDS, so a live run never repaints a lane already on screen", () => {
    // The reason the ladder is ordered by first appearance rather than spread over the states a run
    // turns out to have: a state entered for the first time takes the next hue, and nothing already
    // being read changes colour underneath the person reading it.
    const before = paletteOf(run("product", "explore"));
    const after = paletteOf(run("product", "explore", "draft"));
    expect(after.get("product")).toBe(before.get("product"));
    expect(after.get("explore")).toBe(before.get("explore"));
  });
});
