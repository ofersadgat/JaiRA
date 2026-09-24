/**
 * The Files view's read models (DESIGN §11.1).
 *
 * Three behaviours carry the design and none of them held before:
 *
 *  - a board can be asked for ANY state, not only one on the newest task's workflow;
 *  - the root listing is one column per workflow root, with no order between them;
 *  - a state knows whether the executor it names actually exists, and says so as an error.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { createTask } from "../src/lifecycle";
import { initProject, openProject, type Project } from "../src/project";
import { baseFileTree, baseStateView, boardForState, fileTree, rootContaining, rootsBoard, stateView } from "../src/stateViews";
import { browseWorkflows } from "../src/workflows";
import { compileHidden, hiddenRules } from "@jaira/shared";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-stateview-"));
  const paths = initProject(dir, testHome());
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A second, unrelated workflow — the case a single-workflow board silently got wrong. */
function writeSecondWorkflow(): void {
  writeFileSync(
    join(project.paths.workflowsDir, "release.json"),
    JSON.stringify({
      label: "Release",
      children: { tag: {}, publish: {} },
      sequence: ["tag", "publish"],
    }),
    "utf8",
  );
  mkdirSync(join(project.paths.workflowsDir, "release"), { recursive: true });
  for (const leaf of ["tag", "publish"]) {
    writeFileSync(
      join(project.paths.workflowsDir, `release/${leaf}.json`),
      JSON.stringify({ operation: { kind: "function", function: "generic-cli" } }),
      "utf8",
    );
  }
}

describe("rootsBoard", () => {
  it("gives one column per workflow root and places each task in its own", () => {
    writeSecondWorkflow();
    createTask(project, { title: "plan a thing", workflow: "feature/plan" });
    createTask(project, { title: "cut a release", workflow: "release" });

    const board = rootsBoard(project, browseWorkflows(project));

    expect(board.columns.map((c) => c.stateId).sort()).toEqual(["feature/plan", "release"]);
    // Neither task has run, so both are "not started" rather than sitting in a column — but each is
    // still attributed to its own workflow.
    const all = [...board.finished, ...board.columns.flatMap((c) => c.cards)];
    expect(all.find((c) => c.title === "cut a release")?.workflow).toBe("release");
    expect(all.find((c) => c.title === "plan a thing")?.workflow).toBe("feature/plan");
    // The roots have no parent state, so there is no level and no breadcrumb above them.
    expect(board.level).toBe("");
    expect(board.breadcrumb).toEqual([]);
    expect(board.atLevel).toEqual([]);
  });

  it("files a task spawned by another under its ancestor's column, not its own workflow's", () => {
    // A sync spawns a review, the review spawns a revision: the whole chain is one flow the person
    // started, and none of its machinery workflows should surface as a top-level column.
    const sync = createTask(project, { title: "run the sync", workflow: "feature/plan" });
    const review = createTask(project, {
      title: "review the proposals",
      workflow: "changeset/review-loop",
      parentTaskId: sync.id,
    });
    createTask(project, { title: "revise the proposals", workflow: "changeset/respond", parentTaskId: review.id });

    const board = rootsBoard(project, browseWorkflows(project));

    expect(board.columns.map((c) => c.stateId)).toEqual(["feature/plan"]);
    const column = board.columns[0]!;
    expect(column.cards.map((c) => c.title).sort()).toEqual(["review the proposals", "revise the proposals", "run the sync"]);
    // The card still says what it RAN — only its filing follows the origin.
    expect(column.cards.find((c) => c.title === "review the proposals")?.workflow).toBe("changeset/review-loop");
  });

  it("leaves a task whose parent this project does not hold where it stands", () => {
    // A worktree review records the reviewed task's id, which lives in ANOTHER project's store. The
    // walk stops where the records do, so the review keeps its own column rather than vanishing.
    createTask(project, { title: "review another project's task", workflow: "changeset/review", parentTaskId: "t-elsewhere00" });

    const board = rootsBoard(project, browseWorkflows(project));

    expect(board.columns.map((c) => c.stateId).sort()).toEqual(["changeset/review", "feature/plan"]);
  });
});

describe("boardForState", () => {
  it("projects a state's children as columns, in the order they run", () => {
    const board = boardForState(project, "feature/plan", browseWorkflows(project));

    // `sequence` is the order the engine advances through, so it is the column order.
    expect(board?.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    expect(board?.breadcrumb.map((c) => c.stateId)).toEqual(["feature/plan"]);
  });

  it("resolves a state from ITS OWN workflow, not the newest task's", () => {
    writeSecondWorkflow();
    // The newest task is on `feature/plan`; asking for a `release` state used to project against the
    // wrong shape and come back with no columns at all.
    createTask(project, { title: "plan a thing", workflow: "feature/plan" });

    const board = boardForState(project, "release", browseWorkflows(project));

    expect(board).not.toBeNull();
    expect(board?.columns.map((c) => c.key)).toEqual(["tag", "publish"]);
  });

  it("returns null for a state no workflow contains, rather than an empty board", () => {
    expect(boardForState(project, "nope/not-a-state", browseWorkflows(project))).toBeNull();
  });
});

describe("rootContaining", () => {
  it("finds the root whose closure holds a nested state", () => {
    expect(rootContaining(browseWorkflows(project), "feature/plan/critique")?.rootId).toBe("feature/plan");
  });
});

describe("stateView", () => {
  it("describes a composite state: its children, its board and where it came from", () => {
    const view = stateView(project, "feature/plan", browseWorkflows(project));

    expect(view.stateId).toBe("feature/plan");
    expect(view.label).toBe("Planning");
    expect(view.layer).toBe("project");
    expect(view.exists).toBe(true);
    expect(view.rootId).toBe("feature/plan");
    expect(view.children.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    // A composite has a board; that is what makes the Files view draw columns rather than a task list.
    expect(view.board).not.toBeNull();
    expect(view.board?.columns).toHaveLength(3);
  });

  it("gives a leaf no board, so the view shows its tasks instead", () => {
    const view = stateView(project, "feature/plan/goals", browseWorkflows(project));

    expect(view.children).toEqual([]);
    expect(view.board).toBeNull();
    expect(view.referencedBy).toContain("feature/plan");
  });

  it("reports an unavailable executor as a blocking error", () => {
    writeSecondWorkflow();
    const browser = browseWorkflows(project);

    const view = stateView(project, "release/tag", browser, {
      knownExecutors: new Set(["generic-cli", "claude-cli"]),
      availableExecutors: new Set(["claude-cli"]),
    });

    expect(view.environment.executor).toBe("generic-cli");
    expect(view.environment.available).toBe(false);
    const error = view.issues.find((i) => i.severity === "error" && i.message.includes("generic-cli"));
    expect(error).toBeDefined();
    expect(error?.message).toContain("refused at start");
  });

  it("does not judge a function that is not an executor at all", () => {
    writeSecondWorkflow();
    // `review_artifact` is a UI component. Calling it "unavailable" would be both wrong and
    // unfixable, so a name outside the known set is left alone.
    const view = stateView(project, "release/tag", browseWorkflows(project), {
      knownExecutors: new Set(["claude-cli"]),
      availableExecutors: new Set(["claude-cli"]),
    });

    expect(view.environment.available).toBe(true);
    expect(view.issues.filter((i) => i.message.includes("not available"))).toEqual([]);
  });
});

describe("fileTree", () => {
  it("lists both layer roots, with state ids on the workflow files", () => {
    const tree = fileTree(project, browseWorkflows(project));

    // The two a person owns, then what ships (decision 0006) — empty here, see `test/setup.ts`.
    expect(tree.roots.map((r) => r.layer)).toEqual(["project", "base", "system"]);
    const projectRoot = tree.roots[0]!;
    // Rooted at the CHECKOUT, so the layer is a directory in it rather than the top of it.
    const layer = projectRoot.nodes.find((n) => n.name === ".jaira");
    expect(layer?.kind).toBe("directory");
    expect(layer?.children?.find((n) => n.name === "workflows")?.kind).toBe("directory");

    // The state id is the path under `workflows/` minus the suffix — the same derivation the loader
    // uses, so the tree and a `--workflow` argument name the same thing.
    const ids: string[] = [];
    const walk = (nodes: typeof projectRoot.nodes): void => {
      for (const node of nodes) {
        if (node.stateId !== undefined) ids.push(node.stateId);
        if (node.children) walk(node.children);
      }
    };
    walk(projectRoot.nodes);
    expect(ids).toContain("feature/plan");
    expect(ids).toContain("feature/plan/critique");
  });

  it("lists a root that does not exist on disk, and says it does not", () => {
    // The shared root is a place you can put things before it is a directory. Hiding it until
    // someone has already used it would mean the one affordance for "share this across projects"
    // appears only after you have found another way to do it.
    //
    // `openProject` calls `initBase`, so the base root exists by the time a project is open —
    // deleting it afterwards is how the absent case is reached at all, and it is a real one: the
    // directory can be removed while the app is running.
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const absent = join(home, "shared");
    const withBase = openProject(dir, { baseDir: absent });
    rmSync(absent, { recursive: true, force: true });
    try {
      const tree = fileTree(withBase, browseWorkflows(withBase));

      expect(tree.roots.map((r) => r.layer)).toEqual(["project", "base", "system"]);
      const base = tree.roots[1]!;
      expect(base.exists).toBe(false);
      expect(base.nodes).toEqual([]);
      expect(base.dir).toBe(absent);
      expect(tree.roots[0]!.exists).toBe(true);
    } finally {
      withBase.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads a shared state from its file when there is no project", () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const base = join(home, "shared");
    try {
      mkdirSync(join(base, "workflows", "review"), { recursive: true });
      writeFileSync(
        join(base, "workflows", "review.json"),
        JSON.stringify({
          label: "Shared review",
          children: { step: {}, sign_off: {} },
          // Declared order is the run order, and it is not the declaration order here on purpose.
          sequence: ["sign_off", "step"],
          transitions: [{ when: "$.done", to: "review" }],
        }),
        "utf8",
      );
      writeFileSync(join(base, "workflows", "review", "step.json"), JSON.stringify({ label: "Step" }), "utf8");
      writeFileSync(join(base, "workflows", "review", "sign_off.json"), JSON.stringify({ label: "Sign off" }), "utf8");

      const view = baseStateView(base, "review");

      expect(view).toMatchObject({ stateId: "review", label: "Shared review", layer: "base", exists: true, fileOnly: true });
      // `sequence` wins over declaration order, exactly as the loaded view does it.
      expect(view.children.map((c) => c.key)).toEqual(["sign_off", "step"]);
      expect(view.children.map((c) => c.stateId)).toEqual(["review/sign_off", "review/step"]);
      // Columns come from the children, so a composite still shows its structure with no runs in it.
      expect(view.board?.columns.map((c) => c.key)).toEqual(["sign_off", "step"]);
      expect(view.board?.columns.every((c) => c.cards.length === 0)).toBe(true);
      // A transition back into the state itself is knowably a loop even without an ancestor chain.
      expect(view.transitions).toEqual([{ when: "$.done", to: "review", loops: true }]);
      // Unknown, not empty — the caller is told which by `fileOnly`.
      expect(view.referencedBy).toEqual([]);
      expect(view.issues).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("judges an unavailable executor from the authored 'function' field", () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    const base = join(home, "shared");
    try {
      mkdirSync(join(base, "workflows"), { recursive: true });
      // The AUTHORED spelling is `function`; `functionRef` is what the loader produces. Reading only
      // the latter is how this view would silently never judge anything.
      writeFileSync(
        join(base, "workflows", "tag.json"),
        JSON.stringify({ operation: { kind: "function", function: "generic-cli" } }),
        "utf8",
      );

      const view = baseStateView(base, "tag", {
        knownExecutors: new Set(["generic-cli"]),
        availableExecutors: new Set(),
      });

      expect(view.environment).toMatchObject({ executor: "generic-cli", available: false });
      expect(view.issues.some((i) => i.severity === "error" && i.message.includes("generic-cli"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("describes a state that is not there yet rather than throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    try {
      // Reached the moment someone types a new id into the shared root: the editor opens on a state
      // whose file does not exist, and the panel beside it still has to render.
      const view = baseStateView(join(home, "shared"), "brand/new");
      expect(view).toMatchObject({ stateId: "brand/new", exists: false, board: null, fileOnly: true });
      expect(view.issues).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives the shared root on its own when there is no project", () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    try {
      // Absent on a fresh machine, and still listed — this is the tree the Files view shows before
      // anyone has opened anything.
      const tree = baseFileTree(join(home, "shared"));
      expect(tree.roots.map((r) => r.layer)).toEqual(["base", "system"]);
      expect(tree.roots[0]).toMatchObject({ layer: "base", exists: false, nodes: [] });
      // The suite's built-in layer is an absent directory: an empty root, still listed.
      expect(tree.roots[1]).toMatchObject({ label: "Built in", exists: false, nodes: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps run state out of the authoring tree", () => {
    mkdirSync(project.paths.snapshotsDir, { recursive: true });
    mkdirSync(project.paths.tasksDir, { recursive: true });

    const tree = fileTree(project, browseWorkflows(project));
    // The tree is rooted at the CHECKOUT, so the layer is one directory in it.
    const top = tree.roots[0]!.nodes.map((n) => n.name);
    expect(top).toContain(".jaira");
    const inLayer = tree.roots[0]!.nodes.find((n) => n.name === ".jaira")?.children?.map((n) => n.name) ?? [];
    // Everything generated lives under `system/` — the database, tasks, snapshots, logs — so hiding
    // that one directory is the whole rule, and what is left is exactly what a person authors.
    expect(inLayer).not.toContain("system");
    expect(inLayer).toContain("workflows");
    // `settings.json` is live but is not edited here — Settings → settings.json knows the shape of
    // what is in it. It is hidden by DEFAULT rather than structurally, so anyone who would rather
    // edit the document can put it back.
    expect(inLayer).not.toContain("settings.json");
  });

  it("hides what the setting names, and nothing else", () => {
    mkdirSync(join(project.paths.workflowsDir, "scratch"), { recursive: true });
    writeFileSync(join(project.paths.workflowsDir, "scratch", "wip.json"), "{}", "utf8");

    const rules = compileHidden(hiddenRules([".jaira/workflows/scratch"]));
    const layer = fileTree(project, browseWorkflows(project), rules).roots[0]!.nodes.find((n) => n.name === ".jaira");
    const workflows = layer?.children?.find((n) => n.name === "workflows");
    expect(workflows?.children?.map((n) => n.name)).not.toContain("scratch");
    // The setting REPLACES the defaults rather than adding to them, which is what makes a list a
    // person can read the whole of. Nobody named `system`, so it is back.
    expect(layer?.children?.map((n) => n.name)).toContain("system");
  });

  it("says where the LAYER sits inside each root, which is what the tree's menus ask", () => {
    // The tree is rooted at the checkout, so `workflows/` is two levels down in a project and at
    // the top of the shared root. A renderer that assumed `.jaira` would be wrong about one of
    // them, and one that assumed `workflows` was wrong about every project — which is exactly what
    // hid "New state here…" from a project's own workflows folder.
    const roots = fileTree(project, browseWorkflows(project)).roots;
    expect(roots.find((r) => r.layer === "project")?.prefix).toBe(".jaira");
    expect(baseFileTree(testHome()).roots[0]?.prefix).toBe("");
  });

  it("puts a hidden directory back when a later rule reveals it", () => {
    // The personal half of the setting: `!` after the defaults, which is what the Files screen's
    // switch writes. A run that has gone wrong is read out of this directory.
    const rules = compileHidden(hiddenRules(undefined, ["!.jaira/system"]));
    const layer = fileTree(project, browseWorkflows(project), rules).roots[0]!.nodes.find((n) => n.name === ".jaira");
    expect(layer?.children?.map((n) => n.name)).toContain("system");
  });
});
