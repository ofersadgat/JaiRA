/**
 * The address bar's tail: the runs walked into below the open file.
 *
 * Two things are being guarded. The TRAIL is a path — appending is walking in, truncating is walking
 * back — and it names one task's instances, so it has to be cut when those instances stop existing.
 * And `standingOn` is the rule that makes the bar an address at all: the view is the LAST element,
 * with the file's own state as the fallback when nothing has been walked into.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { FileTree, InstanceNode, StateView } from "@jaira/shared/browser";
import type { Crumb } from "../src/renderer/crumbs";
import { crumbsOf, type CrumbInput } from "../src/renderer/files";
import { standingOn } from "../src/renderer/runViews";
import { nodeAt, prunedTrail, sameTrail, stepOf, type TrailStep } from "../src/renderer/trail";
import type { FileSurfaceContext } from "../src/renderer/fileTypes";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  iteration: 0,
  superseded: false,
  startedAt: patch.instanceId * 10,
  children: [],
  ...patch,
});

const tree = [
  node({
    instanceId: 1,
    stateId: "plan",
    children: [
      node({ instanceId: 2, stateId: "plan/draft", childKey: "draft" }),
      node({
        instanceId: 3,
        stateId: "plan/critique",
        childKey: "critique",
        children: [node({ instanceId: 4, stateId: "plan/critique/read", childKey: "read" })],
      }),
    ],
  }),
];

describe("finding a run in the tree", () => {
  it("reaches any depth, because a walk can go to any depth", () => {
    expect(nodeAt(tree, 4)?.stateId).toBe("plan/critique/read");
  });

  it("answers nothing for an instance this task has not got", () => {
    expect(nodeAt(tree, 99)).toBeUndefined();
  });
});

describe("what a step is called", () => {
  it("uses the run's own name when it has one", () => {
    expect(stepOf(node({ instanceId: 5, stateId: "plan/draft", childKey: "draft", label: "span offsets" }))).toEqual({
      instanceId: 5,
      stateId: "plan/draft",
      name: "span offsets",
    });
  });

  it("falls back to the key its parent mounted it under — the name on the card you clicked", () => {
    expect(stepOf(node({ instanceId: 2, stateId: "plan/draft", childKey: "draft" })).name).toBe("draft");
  });

  it("has NO name for a run entered as a root — the state is the crumb before it", () => {
    // Which is what makes the bar spell it `#1`: see `runCrumbOf`. Falling back to the state id here
    // would produce `plan › plan`, whose second segment reads as another state.
    expect(stepOf(node({ instanceId: 1, stateId: "feature/plan" }))).toEqual({ instanceId: 1, stateId: "feature/plan" });
  });
});

describe("pruning a trail against the run it describes", () => {
  const trail: TrailStep[] = [
    { instanceId: 1, stateId: "plan" },
    { instanceId: 3, stateId: "plan/critique", name: "critique" },
    { instanceId: 4, stateId: "plan/critique/read", name: "read" },
  ];

  it("keeps a trail whose every step still resolves", () => {
    expect(prunedTrail(trail, tree)).toEqual(trail);
  });

  it("TRUNCATES at the first miss rather than filtering — a path with a hole is not a path", () => {
    const gone = [node({ instanceId: 1, stateId: "plan", children: [node({ instanceId: 4, stateId: "plan/critique/read" })] })];
    // 4 still exists, but the descent through 3 does not, so the walk ends at 1.
    expect(prunedTrail(trail, gone)).toEqual([trail[0]]);
  });

  it("empties when the run is gone entirely — a retry restarts instance ids", () => {
    expect(prunedTrail(trail, [])).toEqual([]);
  });

  it("cuts a step whose id was REISSUED to a different state", () => {
    // A re-run does not merely invalidate instance ids, it hands them out again — so `#3` in the new
    // run is a live node under some other state. Checking existence alone kept the crumb, kept its
    // old label, and walked into somebody else's run.
    const rerun = [
      node({
        instanceId: 1,
        stateId: "plan",
        children: [node({ instanceId: 3, stateId: "plan/goals", children: [node({ instanceId: 4, stateId: "plan/critique/read" })] })],
      }),
    ];
    expect(prunedTrail(trail, rerun)).toEqual([trail[0]]);
  });

  it("compares by the instances named, which is what decides whether a patch is worth making", () => {
    expect(sameTrail(trail, [...trail])).toBe(true);
    expect(sameTrail(trail, trail.slice(0, 2))).toBe(false);
  });
});

/**
 * The bar itself: which crumbs there are, what family each belongs to, and what each one does.
 *
 * This is the navigation contract in one function — a folder crumb OPENS a listing, a state crumb
 * opens the state, a run crumb TRUNCATES the walk to it, and the element you are standing on does
 * none of those because you are already there.
 */
describe("the address bar's crumbs", () => {
  /** A tree with a state under `workflows/`, a folder beside it, and a prompt outside. */
  const files: FileTree = {
    roots: [
      {
        layer: "project",
        dir: "/repo/.jaira",
        exists: true,
        nodes: [
          {
            path: "workflows",
            name: "workflows",
            kind: "directory",
            mime: "",
            layer: "project",
            children: [
              {
                path: "workflows/plan",
                name: "plan",
                kind: "directory",
                mime: "",
                layer: "project",
                children: [
                  { path: "workflows/plan/draft.json", name: "draft.json", kind: "workflow", mime: "", layer: "project", stateId: "plan/draft" },
                  { path: "workflows/plan/critique.json", name: "critique.json", kind: "workflow", mime: "", layer: "project", stateId: "plan/critique" },
                ],
              },
            ],
          },
          {
            path: "prompts",
            name: "prompts",
            kind: "directory",
            mime: "",
            layer: "project",
            children: [
              { path: "prompts/goals.md", name: "goals.md", kind: "prompt", mime: "text/markdown", layer: "project" },
              { path: "prompts/style.md", name: "style.md", kind: "prompt", mime: "text/markdown", layer: "project" },
            ],
          },
        ],
      },
      { layer: "base", dir: "/home/me/.jaira", exists: true, nodes: [] },
    ],
  } as unknown as FileTree;

  const states = new Set(["plan/draft", "plan/critique"]);
  const log: string[] = [];
  const input = (patch: Partial<CrumbInput>): CrumbInput => ({
    layer: "project",
    path: "workflows/plan/draft.json",
    stateId: "plan/draft",
    states,
    tree: files,
    trail: [],
    instances: tree,
    runs: [],
    selectedTask: null,
    onOpenState: (id) => log.push(`state:${id}`),
    onOpenFile: (layer, path) => log.push(`file:${layer}:${path}`),
    onOpenDir: (layer, path) => log.push(`dir:${layer}:${path || "/"}`),
    onOpenProject: () => log.push("project"),
    onWalkBack: (i) => log.push(`back:${i}`),
    onWalkTo: (i, node) => log.push(`to:${i}:#${node.instanceId}`),
    onSelectTask: (taskId) => log.push(`task:${taskId}`),
    ...patch,
  });

  beforeEach(() => {
    log.length = 0;
  });

  /** What each crumb does, as a readable trace. */
  const trace = (crumbs: readonly Crumb[]): string[] => {
    for (const crumb of crumbs) crumb.go?.();
    return log;
  };

  it("draws the whole address: the root, the folders, then the state hierarchy", () => {
    const crumbs = crumbsOf(input({}));
    expect(crumbs.map((c) => `${c.kind}:${c.text}`)).toEqual([
      "folder:.jaira",
      "folder:workflows",
      "state:plan",
      "state:draft",
    ]);
  });

  it("puts a segment under `workflows/` in the state family whether or not a file sits at that id", () => {
    // `plan/` has no `plan.json`, but it is still the first half of `plan/draft` — a level of the
    // hierarchy, which is what the colour is about. Where clicking it GOES is the other question.
    expect(crumbsOf(input({})).find((c) => c.text === "plan")?.kind).toBe("state");
  });

  it("navigates a state segment to its file, and one with no file to its folder", () => {
    const crumbs = crumbsOf(input({ path: "workflows/plan/draft/pass.json", stateId: "plan/draft/pass" }));
    trace(crumbs);
    // `.jaira` and `workflows` are folders; `plan` has no state file so it opens its directory;
    // `draft` has one so it opens the state. The last crumb is where you are.
    expect(log).toEqual(["dir:project:/", "dir:project:workflows", "dir:project:workflows/plan", "state:plan/draft"]);
  });

  it("keeps a document that is not a state entirely in the folder family", () => {
    const crumbs = crumbsOf(input({ path: "prompts/goals.md", stateId: undefined }));
    expect(crumbs.map((c) => `${c.kind}:${c.text}`)).toEqual(["folder:.jaira", "folder:prompts", "folder:goals.md"]);
  });

  it("stands on a folder, with its own last crumb as where you are", () => {
    const crumbs = crumbsOf(input({ path: "workflows/plan", stateId: undefined, isDir: true }));
    expect(crumbs.map((c) => c.text)).toEqual([".jaira", "workflows", "plan"]);
    expect(crumbs.at(-1)!.go).toBeUndefined();
  });

  it("stands on the ROOT, which is a real place with nothing above it", () => {
    const crumbs = crumbsOf(input({ path: "", stateId: undefined, isDir: true }));
    expect(crumbs.map((c) => `${c.kind}:${c.text}`)).toEqual(["folder:.jaira"]);
    expect(crumbs[0]!.go).toBeUndefined();
  });

  it("appends the runs walked into, and shows the last one as where you are", () => {
    const crumbs = crumbsOf(
      input({
        trail: [
          { instanceId: 1, stateId: "plan/draft" },
          { instanceId: 7, stateId: "plan/draft/critique", name: "Say Hello" },
        ],
      }),
    );
    expect(crumbs.map((c) => `${c.kind}:${c.text}`)).toEqual([
      "folder:.jaira",
      "folder:workflows",
      "state:plan",
      "state:draft",
      "run:#1",
      "run:Say Hello",
    ]);
    expect(crumbs.at(-1)!.go).toBeUndefined();
  });

  it("truncates to the crumb clicked, which is what walking back out means", () => {
    const crumbs = crumbsOf(
      input({
        trail: [
          { instanceId: 1, stateId: "plan/draft" },
          { instanceId: 7, stateId: "plan/draft/critique", name: "Say Hello" },
          { instanceId: 9, stateId: "plan/draft/critique/read", name: "read" },
        ],
      }),
    );
    trace(crumbs);
    // The file's own crumb walks the trail back to nothing rather than re-opening the document it
    // already has; then one `back` per run above the tail. The tail itself does nothing.
    expect(log.slice(-3)).toEqual(["back:-1", "back:0", "back:1"]);
  });

  it("makes the file's own crumb a way OUT once a run is on the path", () => {
    expect(crumbsOf(input({})).at(-1)!.go).toBeUndefined();
    expect(crumbsOf(input({ trail: [{ instanceId: 1, stateId: "plan/draft" }] }))[3]!.go).toBeDefined();
  });

  /**
   * The base crumb names the TASK, and the reason is a bug that made the bar lie.
   *
   * Instance ids restart at 1 on every run, so the root instance of every task is `#1`. A base crumb
   * built from one read `#1` whichever run you picked out of the chevron — identical before and
   * after, which is indistinguishable from a selection that did not happen.
   */
  describe("the base crumb, which is a run and therefore a task", () => {
    const runOf = (taskTitle: string, stateId: string, instanceId = 1): string =>
      crumbsOf(input({ taskTitle, stateId, trail: [{ instanceId, stateId }] })).at(-1)!.text;

    it("drops the part of the task's name the path already says", () => {
      expect(runOf("plan/draft #2", "plan/draft")).toBe("#2");
    });

    it("tells two runs apart even though both root instances are #1", () => {
      expect(runOf("plan/draft #1", "plan/draft")).toBe("#1");
      expect(runOf("plan/draft #2", "plan/draft")).toBe("#2");
    });

    it("leaves a name somebody chose alone", () => {
      expect(runOf("Fix the parser", "plan/draft")).toBe("Fix the parser");
    });

    it("falls back to the instance id when there is no task to name", () => {
      expect(crumbsOf(input({ trail: [{ instanceId: 4, stateId: "plan/draft" }] })).at(-1)!.text).toBe("#4");
    });

    it("keeps the whole name in the tooltip, which is where the short form's cost is paid", () => {
      const crumbs = crumbsOf(input({ taskTitle: "plan/draft #2", trail: [{ instanceId: 1, stateId: "plan/draft" }] }));
      expect(crumbs.at(-1)!.title).toBe("plan/draft #2 — run #1 of plan/draft");
    });
  });

  it("spells a deeper run `#id` only when it has no name of its own", () => {
    const crumbs = crumbsOf(
      input({
        trail: [
          { instanceId: 1, stateId: "plan/draft" },
          { instanceId: 12, stateId: "plan/draft/pass" },
        ],
      }),
    );
    expect(crumbs.at(-1)!.text).toBe("#12");
  });
});

/**
 * The chevrons: what else could stand at each level.
 *
 * Explorer's move, and the reason a separator is a control rather than punctuation — it is the join
 * between two levels, and the question it answers is "what else is in the one on the left".
 */
describe("what a chevron drops down", () => {
  const files: FileTree = {
    roots: [
      {
        layer: "project",
        dir: "/repo/.jaira",
        exists: true,
        nodes: [
          {
            path: "workflows",
            name: "workflows",
            kind: "directory",
            mime: "",
            layer: "project",
            children: [
              { path: "workflows/other", name: "other", kind: "directory", mime: "", layer: "project", children: [] },
              { path: "workflows/draft.json", name: "draft.json", kind: "workflow", mime: "", layer: "project", stateId: "draft" },
              { path: "workflows/critique.json", name: "critique.json", kind: "workflow", mime: "", layer: "project", stateId: "critique" },
            ],
          },
          { path: "notes.md", name: "notes.md", kind: "prompt", mime: "text/markdown", layer: "project" },
        ],
      },
      { layer: "base", dir: "/home/me/.jaira", exists: true, nodes: [] },
    ],
  } as unknown as FileTree;

  const log: string[] = [];
  const input = (patch: Partial<CrumbInput>): CrumbInput => ({
    layer: "project",
    path: "workflows/draft.json",
    stateId: "draft",
    states: new Set(["draft", "critique"]),
    tree: files,
    trail: [],
    instances: tree,
    runs: [],
    selectedTask: null,
    onOpenState: (id) => log.push(`state:${id}`),
    onOpenFile: (layer, path) => log.push(`file:${layer}:${path}`),
    onOpenDir: (layer, path) => log.push(`dir:${layer}:${path || "/"}`),
    onOpenProject: () => log.push("project"),
    onWalkBack: (i) => log.push(`back:${i}`),
    onWalkTo: (i, node) => log.push(`to:${i}:#${node.instanceId}`),
    onSelectTask: (taskId) => log.push(`task:${taskId}`),
    ...patch,
  });

  beforeEach(() => {
    log.length = 0;
  });

  it("offers the OTHER ROOTS before the project, and the way to one that is not open", () => {
    const options = crumbsOf(input({}))[0]!.options!;
    expect(options.map((o) => o.label)).toEqual([".jaira", "~/.jaira", "Open another project…"]);
    expect(options.find((o) => o.checked)?.label).toBe(".jaira");
    options[1]!.onSelect();
    options[2]!.onSelect();
    // Picking a root navigates to it as a FOLDER — its listing is what is under it.
    expect(log).toEqual(["dir:base:/", "project"]);
  });

  it("offers the containing directory's entries, folders first", () => {
    const options = crumbsOf(input({}))[2]!.options!;
    // `workflows/` holds a folder and two states; a state is offered by its ID, not its filename.
    expect(options.map((o) => o.label)).toEqual(["other", "critique", "draft"]);
    expect(options.find((o) => o.checked)?.label).toBe("draft");
  });

  it("opens each entry as what it is", () => {
    const options = crumbsOf(input({}))[2]!.options!;
    options[0]!.onSelect();
    options[1]!.onSelect();
    expect(log).toEqual(["dir:project:workflows/other", "state:critique"]);
  });

  it("offers a file that is not a state by its own name", () => {
    const options = crumbsOf(input({ path: "notes.md", stateId: undefined }))[1]!.options!;
    expect(options.map((o) => o.label)).toEqual(["workflows", "notes.md"]);
    options[1]!.onSelect();
    expect(log).toEqual(["file:project:notes.md"]);
  });

  it("offers the state's other RUNS before the base — which are other tasks", () => {
    const runs = [
      { taskId: "t-1", title: "Fix the parser", status: "completed" },
      { taskId: "t-2", title: "Ship it", status: "running", activeStateId: "draft" },
    ] as unknown as CrumbInput["runs"];
    const crumbs = crumbsOf(input({ trail: [{ instanceId: 1, stateId: "draft" }], runs, selectedTask: "t-2" }));
    const options = crumbs.at(-1)!.options!;
    expect(options.map((o) => o.label)).toEqual(["Fix the parser", "Ship it"]);
    expect(options.find((o) => o.checked)?.label).toBe("Ship it");
    options[0]!.onSelect();
    expect(log).toEqual(["task:t-1"]);
  });

  it("shortens those entries exactly as the crumb they become", () => {
    const runs = [
      { taskId: "t-1", title: "draft #1", status: "completed" },
      { taskId: "t-2", title: "draft #2", status: "completed" },
    ] as unknown as CrumbInput["runs"];
    const crumbs = crumbsOf(input({ trail: [{ instanceId: 1, stateId: "draft" }], runs, selectedTask: "t-1" }));
    expect(crumbs.at(-1)!.options?.map((o) => o.label)).toEqual(["#1", "#2"]);
  });

  it("offers the SIBLING runs below the base, and picking one replaces that level", () => {
    const crumbs = crumbsOf(
      input({
        stateId: "plan",
        trail: [
          { instanceId: 1, stateId: "plan" },
          { instanceId: 2, stateId: "plan/draft", name: "draft" },
        ],
      }),
    );
    const options = crumbs.at(-1)!.options!;
    // Both children of `#1`, oldest first, with the one on the path marked.
    expect(options.map((o) => o.label)).toEqual(["draft", "critique"]);
    expect(options.find((o) => o.checked)?.label).toBe("draft");
    // Replaced at index 1, NOT appended: a sibling is not a step deeper.
    options[1]!.onSelect();
    expect(log).toEqual(["to:1:#3"]);
  });

  it("has no menu where the only entry would be where you already are", () => {
    // A chevron that opens to tell you what the crumb beside it already says is a control that does
    // nothing — so the separator stays punctuation.
    const bare = { roots: [{ layer: "project", dir: "/repo/.jaira", exists: true, nodes: [] }] } as unknown as FileTree;
    const crumbs = crumbsOf(input({ path: "", stateId: undefined, isDir: true, tree: bare, onOpenProject: undefined }));
    expect(crumbs[0]!.options).toBeUndefined();
  });
});

describe("standingOn — what the viewer shows", () => {
  const state = {
    stateId: "plan",
    children: [{ key: "draft" }, { key: "critique" }],
    board: {},
  } as unknown as StateView;

  const context = (patch: Partial<FileSurfaceContext>): FileSurfaceContext =>
    ({ detail: { instances: tree }, trail: [], trailState: null, ...patch }) as unknown as FileSurfaceContext;

  it("falls back to the file's own newest run when nothing has been walked into", () => {
    const at = standingOn(state, context({}));
    expect(at.node?.instanceId).toBe(1);
    expect(at.declared).toBe(state.children);
    expect(at.deep).toBe(false);
  });

  it("stands on the LAST element of the trail, which is what makes the bar an address", () => {
    const at = standingOn(state, context({ trail: [{ instanceId: 3, stateId: "plan/critique", name: "critique" }] }));
    expect(at.node?.instanceId).toBe(3);
    expect(at.stateId).toBe("plan/critique");
    expect(at.deep).toBe(true);
  });

  it("takes the columns from the state it is standing on, not from the file", () => {
    const deeper = { children: [{ key: "read" }, { key: "never-ran" }] } as unknown as StateView;
    const at = standingOn(
      state,
      context({ trail: [{ instanceId: 3, stateId: "plan/critique", name: "critique" }], trailState: deeper }),
    );
    // Including the child that was never reached — a column the instance tree cannot know about.
    expect(at.declared.map((c) => c.key)).toEqual(["read", "never-ran"]);
  });

  it("keeps the file's own columns when the tail IS the file's state", () => {
    const at = standingOn(state, context({ trail: [{ instanceId: 1, stateId: "plan" }] }));
    expect(at.declared).toBe(state.children);
    expect(at.deep).toBe(false);
  });

  it("stands on nothing when the trail names an instance the task no longer has", () => {
    const at = standingOn(state, context({ trail: [{ instanceId: 99, stateId: "plan/gone", name: "gone" }] }));
    expect(at.node).toBeUndefined();
  });
});
