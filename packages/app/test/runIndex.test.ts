/**
 * The Instances index — see `runIndex.tsx`.
 *
 * Two claims, and they are separate. The first is SHAPE: which rows exist, which of them open a lane
 * and which draw a lobe, given an instance tree. The second is the LOOP, which is the only reading
 * here that is a guess rather than a fact, and so the only one with a way to be wrong.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode } from "@jaira/shared/browser";
import { indexOf, keyOfNode, loopsIn, paletteOfRun } from "../src/renderer/runIndex";
import { paletteOf } from "../src/renderer/rail";

let next = 1;
/** `node("draft")` — a leaf. `node("product", [ ... ])` — something with states under it. */
function node(stateId: string, children: InstanceNode[] = [], extra: Partial<InstanceNode> = {}): InstanceNode {
  return {
    instanceId: next++,
    stateId,
    status: "completed",
    index: 0,
    superseded: false,
    startedAt: 0,
    children,
    ...extra,
  } as InstanceNode;
}

/** Every row as `depth:what`, which is the whole of what the index says. */
function shape(instances: InstanceNode[], shutLoops: ReadonlySet<string> = new Set()): string[] {
  const { steps, rows } = indexOf(instances, shutLoops);
  return steps.map((step, i) => {
    const row = rows[i]!;
    const what = row.kind === "loop" ? `loop×${row.times}` : (row.node.childKey ?? row.node.stateId);
    return `${step.at.length}${step.opens ? " lane" : " lobe"} ${what}`;
  });
}

describe("what opens a lane", () => {
  it("gives a lane to a state with children and a lobe to one without", () => {
    // The whole of the visual fix. A leaf drawn as an ordinary fork and join is a curve down-left
    // and a curve down-right meeting in the middle — a chevron with no line in it — because it has
    // no rows underneath for a straight to run through. See `lobePath`.
    expect(shape([node("feature", [node("product", [node("draft")])])])).toEqual([
      "1 lane feature",
      "2 lane product",
      "2 lobe draft",
    ]);
  });

  it("indents by the lanes open on the row, so the trunk, a module and a state are three levels", () => {
    const { steps } = indexOf([node("feature", [node("product", [node("draft")])])], new Set());
    // `at` is what the gutter is as wide as: one lane, two, three — the indent falls out of the
    // arithmetic rather than out of a rule about parents.
    expect(steps.map((step) => step.at.length)).toEqual([1, 2, 2]);
  });

  it("names a lane by the key its parent mounted it under, not by the state file", () => {
    /*
     * Which is what the CONVERSATION's rail keys on: its lanes are opened out of an instance's
     * address (`atPiece` → `address.map(step => step.childKey)`), so a lane there is named by the
     * child key. Keying the index on the state id instead is how the two came to disagree about
     * what colour a state is while both were drawing the same run.
     */
    const run = [node("feature", [node("review", [], { childKey: "sanity" })])];
    expect(indexOf(run, new Set()).steps[1]!.stateId).toBe("sanity");
    expect([...paletteOfRun(run).keys()]).toEqual(["feature", "sanity"]);
  });

  it("gives one state file mounted under two keys two lanes and two colours", () => {
    // They are two lanes in the conversation for the same reason — two addresses — so one hue
    // between them would say they were the same lane returning, which is what a loop looks like.
    const run = [
      node("feature", [node("review", [], { childKey: "sanity" }), node("review", [], { childKey: "depth" })]),
    ];
    const palette = paletteOfRun(run);
    expect(palette.get("sanity")).not.toBe(palette.get("depth"));
  });
});

describe("finding a loop", () => {
  it("folds consecutive passes of one cycle", () => {
    expect(loopsIn([node("draft"), node("critique"), node("draft"), node("critique")])).toEqual([
      { start: 0, period: 2, times: 2 },
    ]);
  });

  it("finds the SHORTEST cycle, so three of one state is three passes and not one and a half", () => {
    expect(loopsIn([node("draft"), node("draft"), node("draft")])).toEqual([{ start: 0, period: 1, times: 3 }]);
  });

  it("leaves what is around the cycle alone", () => {
    const kids = [node("context"), node("draft"), node("critique"), node("draft"), node("critique"), node("gate")];
    expect(loopsIn(kids)).toEqual([{ start: 1, period: 2, times: 2 }]);
    expect(shape([node("feature", [node("product", kids)])], new Set())).toEqual([
      "1 lane feature",
      "2 lane product",
      "2 lobe context",
      "2 lobe draft",
      "2 lobe critique",
      "2 lobe draft",
      "2 lobe critique",
      "2 lobe gate",
    ]);
  });

  it("REFUSES a superseded pass, which is the same state twice and is not a loop", () => {
    // A retried state is the same id twice in a row — indistinguishable from a one-state loop by
    // this reading — and folding the two would hide the very row saying the first was thrown away.
    // The refusal is what this costs for being a guess; a pass number on the instance would not need it.
    expect(loopsIn([node("publish", [], { superseded: true }), node("publish")])).toEqual([]);
  });

  it("does not look for a cycle across a state that has children", () => {
    // Passes separated by a composite are not a cycle anybody is reading as one.
    const kids = [node("draft"), node("plan", [node("step")]), node("draft")];
    expect(shape([node("feature", [node("product", kids)])], new Set())).toEqual([
      "1 lane feature",
      "2 lane product",
      "2 lobe draft",
      "3 lane plan",
      "3 lobe step",
      "2 lobe draft",
    ]);
  });
});

describe("folding a loop", () => {
  const kids = [node("context"), node("draft"), node("critique"), node("draft"), node("critique"), node("gate")];
  const run = [node("feature", [node("product", kids)])];
  const key = (): string => {
    const { steps, rows } = indexOf(run, new Set());
    const head = rows.findIndex((row) => row.kind === "state" && row.loop?.head === true);
    return (rows[head] as { loop: { key: string } }).loop.key;
  };

  it("replaces every pass with one row", () => {
    expect(shape(run, new Set([key()]))).toEqual([
      "1 lane feature",
      "2 lane product",
      "2 lobe context",
      "2 lobe loop×2",
      "2 lobe gate",
    ]);
  });

  it("does not move a single hue, because the palette is built from the RUN and not from the rows", () => {
    /*
     * A hue is a state's position in the order states first appear. Folding a loop takes `draft` and
     * `critique` out of the step list, so a palette derived from what is on screen shifts every
     * state after them one rung down the ladder — and a legend that recolours itself when you fold
     * something is not a legend. `RunIndex` builds it once; this is the arithmetic behind that.
     */
    const naive = paletteOf(indexOf(run, new Set([key()])).steps);
    expect(naive.get("gate")).not.toBe(paletteOf(indexOf(run, new Set()).steps).get("gate"));
    // ...which is exactly why neither reading derives its own. `paletteOfRun` asks the TREE, and the
    // tree does not know anything has been folded.
    expect(paletteOfRun(run).get("gate")).not.toBe(naive.get("gate"));
    expect(paletteOfRun(run)).toEqual(paletteOf(indexOf(run, new Set()).steps));
  });
});

describe("identity", () => {
  it("keys a node by its run AND its instance, because instance ids repeat across runs", () => {
    const a = node("draft", [], { instanceId: 2, runId: 7 });
    const b = node("draft", [], { instanceId: 2, runId: 8 });
    expect(keyOfNode(a)).not.toBe(keyOfNode(b));
  });
});
