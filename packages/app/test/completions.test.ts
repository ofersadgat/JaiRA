/**
 * What the state form offers to complete.
 *
 * The rule under test is the tree convention: a state owns the namespace under its OWN id, so
 * `feature/plan`'s children are the states exactly one segment below it — `feature/plan/goals`, not
 * `feature/goals`. Getting that backwards would suggest a state's siblings as its children, which is
 * the one wrong answer that still looks plausible.
 */
import { describe, expect, it } from "vitest";
import {
  mimeOfPath,
  type ExecutorInfo,
  type FileNode,
  type FileTree,
  type StateSlots,
  type WorkflowLayer,
} from "@jaira/shared/browser";
import {
  allStateIds,
  bindingTargets,
  childKeyOptions,
  childStateIdOf,
  childStateOptions,
  functionOptions,
  guardTargets,
  linkTargets,
  operationOutputNames,
} from "../src/renderer/completions";

/** A workflow file node. `path` is incidental here; the id is what every suggestion is built from. */
const file = (stateId: string, layer: WorkflowLayer = "project"): FileNode => ({
  path: `${stateId}.json`,
  name: `${stateId.split("/").pop()!}.json`,
  kind: "workflow",
  mime: mimeOfPath(`workflows/${stateId}.json`),
  layer,
  stateId,
});

const treeOf = (project: FileNode[], base: FileNode[] = []): FileTree => ({
  roots: [
    { layer: "project", project: "/p", label: "p", dir: "/p/.jaira/workflows", exists: true, nodes: project },
    { layer: "base", label: "~/.jaira", dir: "/home/.jaira/workflows", exists: true, nodes: base },
  ],
});

/** The layout WORKFLOWS.md §1 describes: `plan.json` beside a `plan/` holding its children. */
const TREE = treeOf([
  file("feature"),
  file("feature/plan"),
  file("feature/plan/goals"),
  file("feature/plan/context"),
  file("feature/plan/critique"),
  file("feature/plan/critique/rubric"),
  file("feature/ship"),
]);

describe("child detection", () => {
  it("finds the states one segment below, and not the ones further down", () => {
    // `critique/rubric` is a grandchild — it is `critique`'s child, not `plan`'s.
    expect(childKeyOptions(TREE, "feature/plan")).toEqual(["context", "critique", "goals"]);
  });

  it("does not mistake a sibling for a child", () => {
    // `feature/ship` sits beside `feature/plan`. Resolving children against the FILE's directory
    // rather than the state's id is what would pull it in.
    expect(childKeyOptions(TREE, "feature/plan")).not.toContain("ship");
    expect(childKeyOptions(TREE, "feature")).toEqual(["plan", "ship"]);
  });

  it("has nothing to offer for a leaf", () => {
    expect(childKeyOptions(TREE, "feature/plan/goals")).toEqual([]);
  });

  it("does not treat a name-prefix as a path-prefix", () => {
    // `feature/planning` starts with `feature/plan` as a STRING but is not below it.
    const tricky = treeOf([file("feature/plan"), file("feature/planning"), file("feature/planning/x")]);
    expect(childKeyOptions(tricky, "feature/plan")).toEqual([]);
  });

  it("offers nothing for a state with no id yet", () => {
    expect(childKeyOptions(TREE, "")).toEqual([]);
  });
});

describe("state references", () => {
  it("offers descendants relatively and everything else bare", () => {
    // `./goals` is what a child reference MEANS here, and a bare id is how a cross-tree mount is
    // written — the validator only warns on those, so they belong in the list.
    const options = childStateOptions(TREE, "feature/plan");

    expect(options.slice(0, 3)).toEqual(["./context", "./critique", "./goals"]);
    expect(options).toContain("feature/ship");
    expect(options).not.toContain("feature/plan");
  });
});

describe("both layers", () => {
  it("collapses a base file its project copy shadows to one suggestion", () => {
    // The id is the same string whichever layer supplies it, so offering it twice would suggest
    // there are two states to choose between when there is one.
    const layered = treeOf([file("review/step")], [file("review"), { ...file("review/step", "base"), shadowed: true }]);

    expect(allStateIds(layered)).toEqual(["review", "review/step"]);
    expect(childKeyOptions(layered, "review")).toEqual(["step"]);
  });

  it("finds states nested inside directory nodes", () => {
    const nested: FileNode = {
      path: "feature",
      name: "feature",
      kind: "directory",
      mime: mimeOfPath("feature", true),
      layer: "project",
      children: [file("feature/plan")],
    };
    expect(allStateIds(treeOf([nested]))).toEqual(["feature/plan"]);
  });

  it("ignores files that are not workflows", () => {
    const prompt: FileNode = {
      path: "prompts/review.md",
      name: "review.md",
      kind: "prompt",
      mime: mimeOfPath("prompts/review.md"),
      layer: "project",
    };
    expect(allStateIds(treeOf([prompt, file("review")]))).toEqual(["review"]);
  });

  it("survives having no tree at all", () => {
    expect(allStateIds(null)).toEqual([]);
    expect(childStateOptions(null, "feature/plan")).toEqual([]);
  });
});

describe("function names", () => {
  const executor = (name: string, enabled: boolean): ExecutorInfo => ({
    name,
    kind: "cli",
    enabled,
    credentialUse: "none",
    policyEnforcement: "callback",
  });

  it("offers the built-in gates and the executors together", () => {
    const names = functionOptions([executor("claude-code", true)]).map((f) => f.name);

    expect(names).toContain("choose_option");
    expect(names).toContain("claude-code");
  });

  it("offers a disabled executor, and says it is off", () => {
    // Naming one is an authoring error — but far likelier from memory than from a list that says so.
    const off = functionOptions([executor("codex-cli", false)]).find((f) => f.name === "codex-cli");
    expect(off?.note).toContain("turned off");
  });
});

/**
 * Which state a child row actually mounts.
 *
 * Three spellings collapse to one id (WORKFLOWS.md §6), and the one that catches people is `./`:
 * it hangs off the PARENT'S ID, not off the directory the parent's file sits in. `./goals` from
 * `feature/plan` is `feature/plan/goals`, never `feature/goals`.
 */
describe("resolving a child's state", () => {
  it("defaults to the key, under the parent", () => {
    expect(childStateIdOf("feature/plan", "goals", "")).toBe("feature/plan/goals");
  });

  it("resolves ./ against the parent's id", () => {
    expect(childStateIdOf("feature/plan", "g", "./goals")).toBe("feature/plan/goals");
  });

  it("walks up with ../", () => {
    expect(childStateIdOf("feature/plan", "g", "../shared/goals")).toBe("feature/shared/goals");
  });

  it("leaves a bare id alone — a cross-tree mount", () => {
    expect(childStateIdOf("feature/plan", "g", "lib/review")).toBe("lib/review");
  });

  it("has no answer for a row that names nothing yet", () => {
    expect(childStateIdOf("feature/plan", "", "")).toBe("");
    expect(childStateIdOf("feature/plan", "g", "./")).toBe("");
    expect(childStateIdOf("", "g", "../up")).toBe("");
  });
});

/**
 * The references a link control can offer.
 *
 * The extension rule is the substance — see `references.test.ts` for why a `.md` prompt has to be
 * offered with its suffix and a `.json` type without one.
 */
describe("link targets", () => {
  const plain = (path: string, layer: WorkflowLayer = "project"): FileNode => ({
    path,
    name: path.split("/").pop()!,
    kind: "prompt",
    mime: mimeOfPath(path),
    layer,
  });
  const dir = (path: string, children: FileNode[]): FileNode => ({
    path,
    name: path.split("/").pop()!,
    kind: "directory",
    mime: mimeOfPath(path, true),
    layer: "project",
    children,
  });

  it("offers every file, spelled as a reference", () => {
    const tree = treeOf([dir("prompts", [plain("prompts/goals.md"), plain("types/markdown.json")])]);
    expect(linkTargets(tree)).toEqual(["$/prompts/goals.md", "$/types/markdown"]);
  });

  it("collapses the two layers into one suggestion", () => {
    // A bare `$` is searched along the path, so the project copy and the base copy are ONE spelling
    // — which is the point of offering it rather than `$JAIRA`.
    const tree = treeOf([plain("prompts/goals.md")], [plain("prompts/goals.md", "base")]);
    expect(linkTargets(tree)).toEqual(["$/prompts/goals.md"]);
  });

  it("has nothing to offer with no tree", () => {
    expect(linkTargets(null)).toEqual([]);
  });
});

/**
 * The paths a binding may name (WORKFLOWS.md §8).
 *
 * A binding is where a value comes from, and it used to be a bare box with a placeholder — so the
 * two commonest bindings in the format were typed from memory. A slot name off by one character is
 * not a syntax error; it is a binding that resolves to nothing.
 */
describe("binding targets", () => {
  const slots = (...names: string[]): StateSlots => ({
    inputs: [],
    outputs: names.map((name) => ({ name, optional: false })),
  });

  it("offers this state's own inputs and each child's outputs", () => {
    const targets = bindingTargets(
      [
        { key: "goals", stateId: "plan/goals" },
        { key: "critique", stateId: "plan/critique" },
      ],
      { "plan/goals": slots("goals"), "plan/critique": slots("outcome", "notes") },
      ["issue"],
    );
    expect(targets).toEqual([
      ".inputs.issue",
      ".children.goals.output.goals",
      ".children.goals.outcome",
      ".children.critique.output.outcome",
      ".children.critique.output.notes",
      ".children.critique.outcome",
    ]);
  });

  it("keys the path by the child's KEY, not by its state id", () => {
    // `.children.<key>` — a state mounted under a different key is read under that key, and using
    // the id would produce a path that looks right and resolves to nothing.
    expect(bindingTargets([{ key: "first", stateId: "lib/review" }], { "lib/review": slots("outcome") }, [])).toEqual([
      ".children.first.output.outcome",
      ".children.first.outcome",
    ]);
  });

  it("offers no OUTPUTS for a child whose state has not been read", () => {
    // Its outcome still stands: how a child terminated does not depend on reading its file.
    expect(bindingTargets([{ key: "goals", stateId: "plan/goals" }], {}, ["issue"])).toEqual([
      ".inputs.issue",
      ".children.goals.outcome",
    ]);
  });

  it("skips a child with no key yet", () => {
    expect(bindingTargets([{ key: "  ", stateId: "plan/goals" }], { "plan/goals": slots("goals") }, [])).toEqual([]);
  });

  it("does not offer the state's own outputs", () => {
    // Binding one of a state's outputs to another is a loop or a rename; neither belongs in a list
    // of places a value can come from.
    expect(bindingTargets([], {}, ["issue"])).toEqual([".inputs.issue"]);
  });

  it("offers how a child TERMINATED, not just what it declared", () => {
    // `.children.<key>.outcome` is a different thing from any output the child has, and it is how a
    // parent turns "the review said block" into a derived output or a transition.
    expect(bindingTargets([{ key: "review", stateId: "x" }], {}, [])).toEqual([".children.review.outcome"]);
  });

  /**
   * The operation's RESULT — which arrives through `.outputs.*`, not through `.operation.*`.
   *
   * An output with no binding is *produced*: the operation fills it (§3.3). Reading it back is how a
   * second output derives from what the call returned, and it is the ONLY route — hw refuses a
   * binding whose path starts with `operation` outright.
   */
  it("offers the outputs the operation produces", () => {
    expect(bindingTargets([], {}, [], ["report", "score"])).toEqual([".outputs.report", ".outputs.score"]);
  });

  it("offers what the call returned, directly", () => {
    // The engine gained `.operation.output.*` as a BINDING namespace, so an output can rename or
    // transform the result rather than only receiving it.
    expect(bindingTargets([], {}, [], ["report"], ["report", "session"])).toEqual([
      // The bare path first: for an operation returning a LIST it is the only way to name the value.
      ".operation.output",
      ".operation.output.report",
      ".operation.output.session",
      ".outputs.report",
    ]);
  });

  it("never offers the call's METADATA — that is a guard's, not a slot's", () => {
    const all = bindingTargets([{ key: "kid", stateId: "x" }], {}, ["issue"], ["report"], ["report"]);
    expect(all).not.toContain(".operation.outcome");
    expect(all).not.toContain(".operation.cost");
  });
});

/**
 * Guards branch on how the call WENT; bindings receive what it RETURNED. Two lists because the
 * scopes genuinely differ — `.run.*` and `.limits.*` are guard-only, and a slot has no business
 * receiving them.
 */
describe("guard targets", () => {
  it("adds the call's metadata and the control-flow scalars", () => {
    expect(guardTargets("function")).toEqual([
      ".operation.outcome",
      ".operation.cost",
      ".operation.model",
      ".operation.usage",
      ".run.index",
      ".run.iteration",
      ".run.cursor",
      ".run.position",
      ".limits.max_iterations",
      ".limits.timeout",
    ]);
  });

  it("leaves `.operation.output.*` to the binding list", () => {
    // It is dataflow, not control flow: a guard branches on how the call went, a slot receives what
    // it returned. Offering the same paths in both lists would blur which is which.
    expect(guardTargets("prompt").some((path) => path.startsWith(".operation.output."))).toBe(false);
  });

  it("still offers the metadata when the kind is settled elsewhere", () => {
    expect(guardTargets("unknown")).toContain(".operation.outcome");
  });

  it("drops the operation entirely for a state that has none", () => {
    // Not an object of unknowns — the node's schema is `undefined`, so `.operation.cost` on a pure
    // composite is an unresolved reference.
    expect(guardTargets("").some((path) => path.startsWith(".operation."))).toBe(false);
    expect(guardTargets("")).toContain(".run.iteration");
  });
});

/**
 * The names the operation puts in `.operation.output.*`.
 *
 * `session` is one of a prompt operation's outputs rather than an envelope beside them, which is
 * the change that made the whole namespace bindable.
 */
describe("operation output names", () => {
  it("takes the outputs the operation fills, plus the session on a prompt op", () => {
    expect(operationOutputNames("prompt", ["report"])).toEqual(["report", "session"]);
  });

  it("gives a function op no session", () => {
    expect(operationOutputNames("function", ["report"])).toEqual(["report"]);
  });

  it("lets an operation's own `session` output win", () => {
    // The author named it; the engine writes its position UNDER a returned value of the same name.
    expect(operationOutputNames("prompt", ["session"])).toEqual(["session"]);
  });

  it("offers nothing for a state with no operation", () => {
    expect(operationOutputNames("", ["report"])).toEqual([]);
  });
});
