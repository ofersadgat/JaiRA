import { describe, expect, it } from "vitest";
import { railOf, type RailStep } from "../src/renderer/rail";
import { autoFold, compact, hiddenExits, type DisplayItem, type VisibleRow } from "../src/renderer/stepCompaction";

/** `[name, children?]` — a run as the index sees it. */
type Spec = [string, Spec[]?];

const run: Spec = [
  "feature",
  [
    ["plan", [["goals"], ["context"], ["critique"], ["critique2"], ["critique3"], ["human_review"]]],
    ["ux", [["draft"], ["critique"], ["verify"]]],
    [
      "build",
      [
        ["pause-control", [["draft"], ["test"], ["verify"]]],
        ["resume-plan", [["draft"], ["test"], ["verify"]]],
        ["task-card", [["draft"], ["test"], ["verify"]]],
        ["cancel-flow", [["draft"], ["test"]]],
      ],
    ],
  ],
];

function stepsOf(spec: Spec, at: string[] = []): RailStep[] {
  const [name, children] = spec;
  const key = [...at, name].join("/");
  if (children === undefined) return [{ key, stateId: name, at, opens: false }];
  const path = [...at, key];
  return [{ key, stateId: name, at: path, opens: true }, ...children.flatMap((child) => stepsOf(child, path))];
}

const steps = stepsOf(run);
const rows = railOf(steps).rows;
/** Every row visible (nothing folded), as the rail would hand them over. */
const visible: VisibleRow[] = rows.map((row, index) => ({ row, index }));
/** cancel-flow's test: the live step, three lanes deep. */
const CURRENT = visible.findIndex(
  (one) => one.row.step !== undefined && steps[one.row.step]!.stateId === "test" && one.row.open[2]?.stateId === "cancel-flow",
);

const describeItem = (item: DisplayItem): string => {
  if (item.kind === "gap") return `(${item.members.length}…)`;
  if (item.kind === "crumb") return `[${item.lanes.map((lane) => lane.stateId).join(">")}]`;
  const row = rows[item.index]!;
  if (row.step !== undefined) return steps[row.step]!.stateId + (row.enter !== undefined ? "(" : "");
  return ")";
};

describe("level 1: folding what is off screen", () => {
  const candidates = [
    { key: "plan", distance: 20, holdsCurrent: false, holdsOnScreen: false },
    { key: "ux", distance: 14, holdsCurrent: false, holdsOnScreen: false },
    { key: "task-card", distance: 3, holdsCurrent: false, holdsOnScreen: true },
    { key: "cancel-flow", distance: 0, holdsCurrent: true, holdsOnScreen: true },
  ];
  const cost: Record<string, number> = { plan: 7, ux: 4, "task-card": 4 };
  const count = (shut: ReadonlySet<string>): number => 35 - [...shut].reduce((sum, key) => sum + (cost[key] ?? 0), 0);

  it("folds off-screen states farthest first, only as far as it takes", () => {
    const shut = autoFold({ candidates, convo: true, capacity: 30, handShut: new Set(), handOpen: new Set(), count });
    expect([...shut]).toEqual(["plan"]);
  });
  it("folds on-screen states only after every off-screen one, and never the current path", () => {
    const shut = autoFold({ candidates, convo: true, capacity: 10, handShut: new Set(), handOpen: new Set(), count });
    expect([...shut].sort()).toEqual(["plan", "task-card", "ux"]);
  });
  it("with no conversation, everything off the current path starts folded", () => {
    const shut = autoFold({ candidates, convo: false, capacity: 99, handShut: new Set(), handOpen: new Set(), count });
    expect([...shut].sort()).toEqual(["plan", "task-card", "ux"]);
  });
  it("a hand fold sticks, but opens while the current step is inside it", () => {
    const shut = autoFold({ candidates, convo: true, capacity: 99, handShut: new Set(["ux", "cancel-flow"]), handOpen: new Set(), count });
    expect([...shut]).toEqual(["ux"]);
  });
  it("a state opened by hand is never folded automatically", () => {
    const shut = autoFold({ candidates, convo: false, capacity: 99, handShut: new Set(), handOpen: new Set(["plan"]), count });
    expect(shut.has("plan")).toBe(false);
  });
});

describe("levels 2 and 3: the fisheye and the breadcrumb", () => {
  it("finds the current step", () => expect(CURRENT).toBeGreaterThan(0));

  it("draws everything when it fits", () => {
    expect(compact(visible, CURRENT, 99)).toHaveLength(visible.length);
  });

  it("elides the rows farthest from the current one, keeping the path above it and the rows closing it", () => {
    const items = compact(visible, CURRENT, 14, { crumbs: false });
    expect(items.length).toBeLessThanOrEqual(14);
    const said = items.map(describeItem).join(" ");
    expect(said).toContain("feature(");
    expect(said).toContain("build(");
    expect(said).toContain("cancel-flow(");
    expect(said).toContain("test");
    expect(items.some((item) => item.kind === "gap")).toBe(true);
    // No placeholder stands for a single row.
    for (const item of items) if (item.kind === "gap") expect(item.members.length).toBeGreaterThan(1);
  });

  it("folds the parents into one breadcrumb when the fisheye alone does not fit, keeping a ⋯ for what it passes over", () => {
    const items = compact(visible, CURRENT, 6);
    expect(items.length).toBeLessThanOrEqual(6);
    expect(items[0]!.kind).toBe("crumb");
    expect(items[1]!.kind).toBe("gap");
    expect(items.map(describeItem).join(" ")).toContain("test");
  });

  it("puts as few parents in the breadcrumb as it takes", () => {
    const loose = compact(visible, CURRENT, 9);
    const tight = compact(visible, CURRENT, 5);
    const depth = (items: DisplayItem[]): number => (items[0]!.kind === "crumb" ? items[0]!.lanes.length : 0);
    expect(depth(tight)).toBeGreaterThanOrEqual(depth(loose));
  });

  it("never draws a join whose fork went into a placeholder", () => {
    const items = compact(visible, CURRENT, 10, { crumbs: false });
    const hidden = hiddenExits(items, rows);
    for (const item of items) {
      if (item.kind !== "row") continue;
      const exit = rows[item.index]!.exit?.lane.key;
      // Either the join is for a lane still drawn, or the renderer is told to leave it off.
      if (exit !== undefined && items.every((other) => other.kind !== "row" || rows[other.index]!.enter?.lane.key !== exit)) expect(hidden.has(exit)).toBe(true);
    }
  });

  it("an opened placeholder draws its rows whatever the height", () => {
    const first = compact(visible, CURRENT, 14, { crumbs: false });
    const gap = first.find((item) => item.kind === "gap");
    expect(gap).toBeDefined();
    const opened = compact(visible, CURRENT, 14, { crumbs: false, expanded: new Set([(gap as { key: string }).key]) });
    expect(opened.some((item) => item.kind === "gap" && item.key === (gap as { key: string }).key)).toBe(false);
  });
});
