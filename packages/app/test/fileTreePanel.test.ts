/**
 * Which root in the Files drawer introduces itself, and which one does not.
 *
 * The tree's top level is every open project with `~/.jaira` beside them (SHELL.md §2.2), and each
 * root used to be headed by a row carrying its own name. Nested under a project row that is already
 * that name, that row printed the same word twice and spent the first line of a 250px column doing
 * it — so the root you are standing in stopped drawing one.
 *
 * The case worth a test is the shared root. It carries no `project` (it belongs to none) and it is
 * also a row in the sidebar and a perfectly ordinary place to stand — so a stamp-only test can never
 * be true there, and `~/.jaira` went on introducing itself inside itself.
 */
import { describe, expect, it } from "vitest";
import type { FileNode, FileRoot, FileTree } from "@jaira/shared";
import {
  anchorIn,
  childStateDraft,
  fileDraft,
  inLayerOf,
  newItems,
  revealKeys,
  rootNeedsName,
  standingRoot,
  stateDraft,
  statePrefixOf,
  workflowsDirOf,
} from "../src/renderer/files";

const project = (dir: string): { dir: string; project?: string } => ({ dir: `${dir}/.jaira`, project: dir });
const shared = { dir: "/home/me/.jaira" };

describe("rootNeedsName", () => {
  it("does not name the checkout the drawer is standing in", () => {
    expect(rootNeedsName(project("/w/atlas"), "/w/atlas")).toBe(false);
  });

  it("does not name the SHARED root while you are standing in it", () => {
    // The reported fault: `~/.jaira` is a project row too, and standing there the tree showed one
    // root, headed by the name of the place you had just clicked to get there.
    expect(rootNeedsName(shared, "/home/me/.jaira")).toBe(false);
  });

  it("names the shared root from inside a checkout, because it is somewhere else", () => {
    expect(rootNeedsName(shared, "/w/atlas")).toBe(true);
  });

  it("names another open checkout, for the same reason", () => {
    expect(rootNeedsName(project("/w/notes"), "/w/atlas")).toBe(true);
  });

  it("names everything at the root of the address, where you are standing in nothing", () => {
    expect(rootNeedsName(project("/w/atlas"), null)).toBe(true);
    expect(rootNeedsName(shared, null)).toBe(true);
  });
});

/**
 * Where a new thing lands, asked of the ROOT rather than of the string `.jaira`.
 *
 * The bug this fixes was invisible for exactly one reason: `~/.jaira` answers the same to both
 * questions. The tree is rooted at the CHECKOUT, so a project's states are at `.jaira/workflows/…`
 * and a literal `workflows` test is false for every one of them — "New state here…" appeared only
 * in the shared root, in a menu that looked complete.
 */
/** A directory row, as the tree carries one: the path is relative to the ROOT, not to its parent. */
const dir = (path: string, children: FileNode[]): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: "directory",
  mime: "inode/directory",
  layer: "project",
  children,
});

const checkout: FileRoot = {
  layer: "project",
  project: "/w/atlas",
  label: "atlas",
  dir: "/w/atlas",
  prefix: ".jaira",
  exists: true,
  nodes: [dir(".jaira", [dir(".jaira/prompts", []), dir(".jaira/workflows", [dir(".jaira/workflows/feature", [])])])],
};
const sharedRoot: FileRoot = { layer: "base", label: "~/.jaira", dir: "/home/me/.jaira", prefix: "", exists: true, nodes: [] };

describe("where workflows/ is", () => {
  it("is under the layer prefix in a checkout, and at the top of the shared root", () => {
    expect(workflowsDirOf(checkout.prefix)).toBe(".jaira/workflows");
    expect(workflowsDirOf(sharedRoot.prefix)).toBe("workflows");
  });

  it("reads a state-id prefix out of a directory in either root", () => {
    expect(statePrefixOf(".jaira/workflows", ".jaira")).toBe("");
    expect(statePrefixOf(".jaira/workflows/feature", ".jaira")).toBe("feature/");
    expect(statePrefixOf("workflows/feature/plan", "")).toBe("feature/plan/");
  });

  it("says nothing about a directory outside workflows/", () => {
    expect(statePrefixOf(".jaira/prompts", ".jaira")).toBeNull();
    expect(statePrefixOf("src/workflows", ".jaira")).toBeNull();
    // The near-miss that a `startsWith` alone would call a match.
    expect(statePrefixOf(".jaira/workflows-old", ".jaira")).toBeNull();
  });

  it("holds `.jaira` and everything in it to be inside the layer, and the shared root to be all of it", () => {
    expect(inLayerOf(".jaira", ".jaira")).toBe(true);
    expect(inLayerOf(".jaira/prompts", ".jaira")).toBe(true);
    expect(inLayerOf("src", ".jaira")).toBe(false);
    expect(inLayerOf("anything", "")).toBe(true);
  });
});

describe("newItems", () => {
  const labels = (root: FileRoot, dir: string): string[] => newItems(root, dir, () => {}).map((i) => i.label);

  it("offers a workflow at the top of a checkout, where the row's own + acts", () => {
    expect(labels(checkout, "")).toEqual(["New file…", "New folder…", "New workflow…"]);
  });

  it("offers it inside .jaira, and not beside src/", () => {
    expect(labels(checkout, ".jaira/prompts")).toContain("New workflow…");
    expect(labels(checkout, "src")).toEqual(["New file…", "New folder…"]);
  });

  it("offers a STATE inside workflows/, never both", () => {
    expect(labels(checkout, ".jaira/workflows")).toEqual(["New file…", "New folder…", "New state…"]);
    expect(labels(checkout, ".jaira/workflows/feature")).toEqual(["New file…", "New folder…", "New state…"]);
  });

  it("sends a workflow to workflows/ whatever folder it was asked from", () => {
    const drafts: string[] = [];
    const items = newItems(checkout, ".jaira", (draft) => drafts.push(JSON.stringify(draft.target)));
    items.find((i) => i.label === "New workflow…")!.onSelect();
    // Prefix "" — a workflow is a ROOT state, so the name typed is the whole id.
    expect(drafts).toEqual([JSON.stringify({ kind: "state", prefix: "" })]);
  });
});

describe("the draft a menu starts", () => {
  it("names the folder it was asked from as where it lands", () => {
    const draft = fileDraft(checkout, ".jaira/prompts", "file");
    expect(draft.dir).toBe(".jaira/prompts");
    expect(draft.target).toEqual({ kind: "file" });
  });

  it("unfolds every branch between the root and a workflow's folder", () => {
    expect(stateDraft(checkout, ".jaira/workflows").reveal).toEqual([".jaira", ".jaira/workflows"].map((p) => `project:${p}`));
    expect(revealKeys("base", "workflows")).toEqual(["base:workflows"]);
  });

  it("extends the id, for a state typed inside a folder that is already one", () => {
    expect(stateDraft(checkout, ".jaira/workflows/feature").target).toEqual({ kind: "state", prefix: "feature/" });
  });

  it("carries the project, so a + pressed in one checkout does not write into another", () => {
    expect(fileDraft(checkout, "", "file").project).toBe("/w/atlas");
    expect(fileDraft(sharedRoot, "", "file").project).toBeUndefined();
  });
});

/**
 * WHERE the row is drawn, which is a question about the tree and not about the destination.
 *
 * The reported fault is the third case: this project keeps its workflows in the shared root, so it
 * has no `.jaira/workflows/` — and a draft that insisted on that row as its anchor was a menu entry
 * that did nothing at all, silently, every time.
 */
describe("anchorIn", () => {
  it("hangs a draft under the folder it lands in, when that folder is on screen", () => {
    expect(anchorIn(checkout, fileDraft(checkout, ".jaira/prompts", "file"))).toEqual({
      under: "project:.jaira/prompts",
      depth: 2,
      missing: "",
    });
  });

  it("puts a root-level draft at the top of its root, under no row", () => {
    expect(anchorIn(checkout, fileDraft(checkout, "", "directory"))).toEqual({ under: null, depth: 0, missing: "" });
  });

  it("falls back to the deepest folder that DOES exist, and says what is still to be made", () => {
    const bare: FileRoot = { ...checkout, nodes: [dir(".jaira", [])] };
    expect(anchorIn(bare, stateDraft(bare, ".jaira/workflows"))).toEqual({
      under: "project:.jaira",
      depth: 1,
      missing: "workflows/",
    });
  });

  it("falls all the way back to the root when nothing on the path exists", () => {
    const empty: FileRoot = { ...checkout, nodes: [] };
    expect(anchorIn(empty, stateDraft(empty, ".jaira/workflows"))).toEqual({
      under: null,
      depth: 0,
      missing: ".jaira/workflows/",
    });
  });

  it("hangs a CHILD state off the parent's own row, because its folder is not there yet", () => {
    const node = {
      path: ".jaira/workflows/feature.json",
      name: "feature.json",
      kind: "workflow" as const,
      mime: "application/json",
      layer: "project" as const,
      stateId: "feature",
    };
    const draft = childStateDraft(checkout, node, "feature");
    expect(draft.target).toEqual({ kind: "state", prefix: "feature/" });
    // The explicit anchor wins over the walk: the folder it lands in is the one being created, and
    // the walk would have put the row under `workflows/` instead of under its own parent.
    expect(anchorIn(checkout, draft)).toEqual({
      under: "project:.jaira/workflows/feature.json",
      depth: 3,
      missing: "",
    });
  });

  it("carries the project, so a + pressed in one checkout does not write into another", () => {
    expect(fileDraft(checkout, "", "file").project).toBe("/w/atlas");
    expect(fileDraft(sharedRoot, "", "file").project).toBeUndefined();
  });
});

describe("standingRoot", () => {
  const tree: FileTree = { roots: [checkout, sharedRoot] };

  it("is the checkout you are standing in", () => {
    expect(standingRoot(tree, "/w/atlas")).toBe(checkout);
  });

  it("is the shared root at the address root, where there is no project layer to be in", () => {
    expect(standingRoot(tree, null)).toBe(sharedRoot);
  });

  it("is the shared root while standing in it, which is a project row of its own", () => {
    expect(standingRoot(tree, "/home/me/.jaira")).toBe(sharedRoot);
  });

  it("is nothing at all with no tree, so the row's + can decline rather than guess", () => {
    expect(standingRoot(null, "/w/atlas")).toBeNull();
    expect(standingRoot({ roots: [] }, null)).toBeNull();
  });
});
