/**
 * What the file tree says about a state before you click it.
 *
 * The tree used to report only whether a file PARSED, which is the smallest of the things that can
 * be wrong with one. A state that parses perfectly and forgets to wire a child's required input is a
 * state that cannot run, and finding that out meant selecting every file in turn.
 *
 * Two rules carry the design and both are easy to get subtly wrong:
 *
 *  - a directory carries the TOTALS below it, so a fault stays visible with the branch collapsed;
 *  - a state no root reaches is `unchecked`, not clean. Zero errors there means nobody looked, and a
 *    file that reads as clean is exactly the file someone starts a task against.
 *
 * Deliberately built on plain roots and a stub project rather than `openProject`: none of this
 * touches the database, and a test that opened one would be a test about SQLite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileNode, WorkflowBrowser } from "@jaira/shared";
import type { Project } from "../src/project";
import { baseFileTree, baseStateView, fileTree, stateSlots } from "../src/stateViews";
import { browseBaseWorkflows } from "../src/workflows";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-filelint-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a state file under the project layer, creating the directory chain on the way. */
function writeState(id: string, doc: unknown, layer = "project"): void {
  const file = join(dir, layer, "workflows", `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc), "utf8");
}

/** Only `paths.roots` is read — see the module header. */
const projectOf = (): Project =>
  ({ paths: { roots: [join(dir, "project"), join(dir, "base")] } }) as unknown as Project;

/** A browser result naming which states were reachable and what was found wrong with them. */
function browserOf(
  states: string[],
  issues: WorkflowBrowser["workflows"][number]["issues"] = [],
  extra: Partial<WorkflowBrowser["workflows"][number]> = {},
): WorkflowBrowser {
  return {
    workflows: [
      {
        rootId: states[0] ?? "",
        states,
        issues,
        taskIds: [],
        driftedTasks: [],
        layer: "project",
        ...extra,
      },
    ],
    files: states.map((stateId) => ({
      stateId,
      file: `${stateId}.json`,
      layer: "project" as const,
      root: join(dir, "project", "workflows"),
    })),
    unreachable: [],
  };
}

/** Find a node by its path under the project root. */
function find(nodes: FileNode[], path: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const below = node.children === undefined ? undefined : find(node.children, path);
    if (below !== undefined) return below;
  }
  return undefined;
}

describe("lint on the tree", () => {
  it("marks the file an error was reported against", () => {
    writeState("plan", {});
    writeState("plan/goals", {});
    const browser = browserOf(
      ["plan", "plan/goals"],
      [
        {
          stateId: "plan",
          path: "children.goals.inputs",
          message: "required child input 'issue' is not wired",
          severity: "error",
        },
      ],
    );

    const nodes = fileTree(projectOf(), browser).roots[0]!.nodes;
    // The PARENT is at fault — it is the state that forgot to wire the child, and attributing it to
    // the child would put the marker on the one file that is written correctly.
    expect(find(nodes, "workflows/plan.json")?.lint).toEqual({ errors: 1, warnings: 0 });
    expect(find(nodes, "workflows/plan/goals.json")?.lint).toBeUndefined();
  });

  it("counts warnings apart from errors", () => {
    writeState("plan", {});
    const browser = browserOf(["plan"], [
      { stateId: "plan", path: "children.x", message: "not a descendant", severity: "warning" },
      { stateId: "plan", path: "transitions[0]", message: "unreachable", severity: "warning" },
    ]);
    expect(find(fileTree(projectOf(), browser).roots[0]!.nodes, "workflows/plan.json")?.lint).toEqual({
      errors: 0,
      warnings: 2,
    });
  });

  it("counts an issue once even when two roots reach the state", () => {
    // A shared subroutine is linted once per root. Counting the repeats would make it read as N
    // times more broken than it is, which is how a count stops being read.
    writeState("lib/review", {});
    const issue = { stateId: "lib/review", path: "operation", message: "boom", severity: "error" as const };
    const browser = browserOf(["lib/review"], [issue]);
    browser.workflows.push({ ...browser.workflows[0]!, rootId: "other", issues: [issue] });

    expect(find(fileTree(projectOf(), browser).roots[0]!.nodes, "workflows/lib/review.json")?.lint).toEqual({
      errors: 1,
      warnings: 0,
    });
  });

  it("rolls totals up into the directories above", () => {
    writeState("plan/goals", {});
    const browser = browserOf(["plan/goals"], [
      { stateId: "plan/goals", path: "operation", message: "boom", severity: "error" },
    ]);
    const nodes = fileTree(projectOf(), browser).roots[0]!.nodes;

    expect(find(nodes, "workflows/plan")?.lint).toEqual({ errors: 1, warnings: 0 });
    expect(find(nodes, "workflows")?.lint).toEqual({ errors: 1, warnings: 0 });
  });

  it("marks a state no root reaches as unchecked rather than clean", () => {
    writeState("orphan", {});
    writeState("plan", {});
    const browser = browserOf(["plan"]);
    browser.files.push({
      stateId: "orphan",
      file: "orphan.json",
      layer: "project",
      root: join(dir, "project", "workflows"),
    });
    const nodes = fileTree(projectOf(), browser).roots[0]!.nodes;

    expect(find(nodes, "workflows/orphan.json")?.lint).toEqual({ errors: 0, warnings: 0, unchecked: true });
    expect(find(nodes, "workflows/plan.json")?.lint).toBeUndefined();
  });

  it("does not roll `unchecked` up into a directory", () => {
    // An aggregate would say "none of this was checked" about a directory where one state happens to
    // be unreferenced, which is false.
    writeState("orphan", {});
    const browser = browserOf([]);
    browser.files.push({
      stateId: "orphan",
      file: "orphan.json",
      layer: "project",
      root: join(dir, "project", "workflows"),
    });
    expect(find(fileTree(projectOf(), browser).roots[0]!.nodes, "workflows")?.lint).toBeUndefined();
  });

  it("treats a root that failed to load as unchecked, not as clean", () => {
    // No issues were reported because the loader never got far enough to look.
    writeState("plan", {});
    const browser = browserOf(["plan"], [], { loadError: "reference cycle" });
    expect(find(fileTree(projectOf(), browser).roots[0]!.nodes, "workflows/plan.json")?.lint).toEqual({
      errors: 0,
      warnings: 0,
      unchecked: true,
    });
  });

  it("says nothing at all with no browser — nothing has been linted", () => {
    writeState("plan", {});
    expect(find(fileTree(projectOf()).roots[0]!.nodes, "workflows/plan.json")?.lint).toBeUndefined();
  });

  it("leaves a shadowed base copy unmarked", () => {
    // The loader never reads it, so the issues against that state id belong to the file that
    // overrode it. A red row beside an inert file would point at the wrong thing.
    writeState("plan", {});
    writeState("plan", {}, "base");
    const browser = browserOf(["plan"], [
      { stateId: "plan", path: "operation", message: "boom", severity: "error" },
    ]);
    browser.files.push({
      stateId: "plan",
      file: "plan.json",
      layer: "base",
      root: join(dir, "base", "workflows"),
      shadowed: true,
    });
    const tree = fileTree(projectOf(), browser);

    expect(find(tree.roots[0]!.nodes, "workflows/plan.json")?.lint).toEqual({ errors: 1, warnings: 0 });
    expect(find(tree.roots[1]!.nodes, "workflows/plan.json")?.lint).toBeUndefined();
  });
});

/**
 * The shared root, browsed with NO PROJECT OPEN.
 *
 * This was the hole: `~/.jaira` is browsable and authorable on its own — it is machine-global and it
 * is where a workflow meant to outlive one checkout gets written — and it was the one surface that
 * listed state files and never linted them. Nothing was red because nothing had looked.
 *
 * Built on the real browser rather than a stub, deliberately. The stubbed tests above prove the tree
 * renders a diagnostic it is handed; only this one proves a diagnostic is produced at all.
 */
describe("no project open", () => {
  const baseWorkflows = (id: string, doc: unknown): void => {
    const file = join(dir, "shared", "workflows", `${id}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc), "utf8");
  };
  const sharedDir = (): string => join(dir, "shared");

  /** The reported case: `goals` takes an input, `plan` mounts it and binds nothing. */
  const unwiredPair = (): void => {
    baseWorkflows("plan", { label: "Plan", children: { goals: {} }, sequence: ["goals"] });
    baseWorkflows("plan/goals", {
      inputs: { issue: { schema: { type: "string" } } },
      outputs: { goals: { schema: { type: "string" } } },
      operation: { kind: "prompt", prompt: "go" },
    });
  };

  it("reports the parent that binds nothing", () => {
    unwiredPair();
    const issues = browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues);
    expect(issues).toEqual([
      {
        stateId: "plan",
        path: "children.goals.inputs",
        message: "required child input 'issue' is not wired",
        severity: "error",
      },
    ]);
  });

  it("colours the parent's file, and rolls the total up", () => {
    unwiredPair();
    const nodes = baseFileTree(sharedDir(), browseBaseWorkflows(sharedDir())).roots[0]!.nodes;

    expect(find(nodes, "workflows/plan.json")?.lint).toEqual({ errors: 1, warnings: 0 });
    expect(find(nodes, "workflows")?.lint).toEqual({ errors: 1, warnings: 0 });
    expect(find(nodes, "workflows/plan/goals.json")?.lint).toBeUndefined();
  });

  it("shows the same diagnostic in the inspector, so the two panels agree", () => {
    unwiredPair();
    const view = baseStateView(sharedDir(), "plan", {}, browseBaseWorkflows(sharedDir()));
    expect(view.issues.map((i) => i.message)).toEqual(["required child input 'issue' is not wired"]);
  });

  it("lists each state once — the single layer must not be browsed twice", () => {
    // `$` and `$BASE` both name the shared root here. Deriving two layers from that would list every
    // state twice and flag the second copy as shadowing the first.
    unwiredPair();
    const browser = browseBaseWorkflows(sharedDir());
    expect(browser.files.map((f) => f.stateId)).toEqual(["plan", "plan/goals"]);
    expect(browser.files.some((f) => f.shadowed === true)).toBe(false);
  });

  it("finds the workflows even when the shared root is not named .jaira", () => {
    // `JAIRA_HOME` relocates it, and a paths derivation that assumed the `.jaira` basename would
    // point at a sibling that does not exist and report an empty, clean root.
    unwiredPair();
    expect(browseBaseWorkflows(sharedDir()).workflows.map((w) => w.rootId)).toEqual(["plan"]);
  });

  it("says nothing is running — there are no tasks without a project", () => {
    unwiredPair();
    const [plan] = browseBaseWorkflows(sharedDir()).workflows;
    expect(plan?.taskIds).toEqual([]);
    expect(plan?.driftedTasks).toEqual([]);
  });
});

/**
 * Which runtime paths actually LOAD, checked against the engine rather than against a reading of it.
 *
 * The authoring form completes bindings and guards from two different lists, and the reason is here:
 * hw refuses a BINDING whose path starts with `operation` outright, while the same path in a `when`
 * loads cleanly. Both of the format's own `.operation.*` examples are guards, so the asymmetry is
 * easy to read past — and a completion list on the wrong side of it suggests paths that fail the
 * whole workflow to load.
 *
 * These assertions exist so that a change upstream shows up here, in a test about the boundary,
 * rather than as a suggestion that quietly starts breaking documents.
 */
/**
 * Does the state pass its operation what the operation needs?
 *
 * The engine asks this of any function whose registered entry declares a `signature`. JaiRA's
 * built-in components have none to declare — their contract is a shape inside `config`, not a
 * parameter list — so the same question is asked from the contract itself, and the answer has to
 * reach the file tree like any other error.
 */
describe("component operations that are not passed what they need", () => {
  const sharedDir = (): string => join(dir, "shared");
  const write = (id: string, doc: unknown): void => {
    const file = join(sharedDir(), "workflows", `${id}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc), "utf8");
  };

  it("reports a gate that declares no options", () => {
    // A `choose_option` with nothing to choose is a run that parks forever, not one that reads oddly.
    write("gate", { operation: { kind: "function", function: "choose_option" } });
    const issues = browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.path).toBe("operation.args");
    expect(issues[0]!.message).toMatch(/options/);
  });

  it("turns the FILE red in the tree", () => {
    // The whole point: the fault has to be visible before the file is opened.
    write("gate", { operation: { kind: "function", function: "choose_option", args: {} } });
    const nodes = baseFileTree(sharedDir(), browseBaseWorkflows(sharedDir())).roots[0]!.nodes;
    expect(find(nodes, "workflows/gate.json")?.lint).toEqual({ errors: 1, warnings: 0 });
  });

  it("is clean once the options are there", () => {
    write("gate", {
      operation: { kind: "function", function: "choose_option", args: { prompt: "pick", options: ["a", "b"] } },
    });
    expect(browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues)).toEqual([]);
  });

  it("says nothing about a component that needs no config", () => {
    // `confirm_action` defaults every field, so declaring nothing is complete rather than missing.
    write("gate", { operation: { kind: "function", function: "confirm_action" } });
    expect(browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues)).toEqual([]);
  });

  it("says nothing about a function that is not a built-in component", () => {
    // An executor's contract is not JaiRA's to know from the document.
    write("gate", { operation: { kind: "function", function: "claude-code" } });
    expect(browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues)).toEqual([]);
  });

  it("says nothing when the args are a REFERENCE it cannot see", () => {
    // The referenced block may well supply the options; reporting a missing one would name a file
    // that never claimed to declare it.
    write("gate", { operation: { kind: "function", function: "choose_option", args: "$/lib/gate.args" } });
    expect(browseBaseWorkflows(sharedDir()).workflows.flatMap((w) => w.issues)).toEqual([]);
  });
});

describe("binding and guard scopes", () => {
  const problems = (files: Record<string, unknown>): string[] => {
    const root = join(dir, "shared");
    for (const [id, doc] of Object.entries(files)) {
      const file = join(root, "workflows", `${id}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(doc), "utf8");
    }
    return browseBaseWorkflows(root).workflows.flatMap((w) => [
      ...(w.loadError !== undefined ? [w.loadError] : []),
      ...w.issues.filter((i) => i.severity === "error").map((i) => i.message),
    ]);
  };

  it("binds a state output to the operation's result through `.outputs.<produced>`", () => {
    // The capability itself: `report` has no binding, so the operation fills it; `summary` reads it
    // back. This is the only route — see the next test for why.
    expect(
      problems({
        s: {
          outputs: {
            report: { schema: { type: "string" } },
            summary: { schema: { type: "string" }, binding: ".outputs.report" },
          },
          operation: { kind: "prompt", prompt: "go" },
        },
      }),
    ).toEqual([]);
  });

  it("binds an output to what the call RETURNED, through `.operation.output.<name>`", () => {
    // The capability the produced-output mechanism could not express: the returned value and the
    // published slot are two names with a binding between them, so this renames on the way through.
    expect(
      problems({
        s: {
          outputs: {
            report: { schema: { type: "string" } },
            summary: { schema: { type: "string" }, binding: ".operation.output.report" },
          },
          operation: { kind: "prompt", prompt: "go" },
        },
      }),
    ).toEqual([]);
  });

  it("reports a returned name the operation never produces", () => {
    const [message] = problems({
      s: {
        outputs: {
          report: { schema: { type: "string" } },
          summary: { schema: { type: "string" }, binding: ".operation.output.nope" },
        },
        operation: { kind: "prompt", prompt: "go" },
      },
    });
    expect(message).toMatch(/nope/);
  });

  it("accepts `.operation.*` in a guard", () => {
    expect(
      problems({
        s: {
          transitions: [{ when: ".operation.outcome === 'success'", to: "terminate.success" }],
          operation: { kind: "prompt", prompt: "go" },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a child's outputs and its outcome as bindings", () => {
    expect(
      problems({
        p: {
          children: { kid: {} },
          sequence: ["kid"],
          outputs: {
            note: { schema: { type: "string" }, binding: ".children.kid.outputs.note" },
            how: { schema: { type: "string" }, binding: ".children.kid.outcome" },
          },
        },
        "p/kid": {
          outputs: { note: { schema: { type: "string" } } },
          operation: { kind: "prompt", prompt: "go" },
        },
      }),
    ).toEqual([]);
  });
});

describe("declared slots", () => {
  const roots = (): string[] => [join(dir, "project", "workflows"), join(dir, "base", "workflows")];

  it("reads a state's inputs, marking which must be wired", () => {
    // SPEC §4.1: required unless it says otherwise, and a `default` says otherwise too.
    writeState("plan/goals", {
      inputs: {
        issue: { schema: { type: "string" }, description: "the ticket" },
        depth: { optional: true },
        mode: { default: "significant" },
      },
      outputs: { goals: {} },
    });

    expect(stateSlots(roots(), ["plan/goals"])).toEqual({
      "plan/goals": {
        inputs: [
          { name: "issue", optional: false, description: "the ticket" },
          { name: "depth", optional: true },
          { name: "mode", optional: true },
        ],
        outputs: [{ name: "goals", optional: false }],
      },
    });
  });

  it("reports a state that declares nothing as two empty lists", () => {
    writeState("plan", { children: {} });
    expect(stateSlots(roots(), ["plan"])).toEqual({ plan: { inputs: [], outputs: [] } });
  });

  it("reads outputs too — what a sibling's binding may point at", () => {
    writeState("plan/goals", { outputs: { goals: {}, notes: { optional: true } } });
    expect(stateSlots(roots(), ["plan/goals"])["plan/goals"]?.outputs).toEqual([
      { name: "goals", optional: false },
      { name: "notes", optional: true },
    ]);
  });

  it("keeps a state whose OUTPUTS are transcluded, minus the completions", () => {
    // Losing the completion list costs a suggestion. Losing the state would cost the wiring rows,
    // which is the part that stops a mount failing to lint — so only the outputs degrade.
    writeState("plan", { inputs: { issue: {} }, outputs: "$/lib/common.outputs" });
    expect(stateSlots(roots(), ["plan"])["plan"]).toEqual({
      inputs: [{ name: "issue", optional: false }],
      outputs: [],
    });
  });

  it("omits an id that names nothing", () => {
    // The caller is a form where the reference is being TYPED, so a miss is the normal case — and
    // "declares nothing" is the one answer it must not be confused with.
    expect(stateSlots(roots(), ["nope", ""])).toEqual({});
  });

  it("omits a state whose inputs are a transcluded reference", () => {
    // Expanding it needs the loader's search path. Showing half a transclusion would be worse than
    // showing none: the author would take the short list for the whole surface.
    writeState("plan", { inputs: "$/lib/common.inputs" });
    expect(stateSlots(roots(), ["plan"])).toEqual({});
  });

  it("lets the project layer shadow the base's, as resolution does", () => {
    writeState("lib/review", { inputs: { local: {} } });
    writeState("lib/review", { inputs: { shared: {} } }, "base");
    expect(stateSlots(roots(), ["lib/review"])["lib/review"]?.inputs).toEqual([{ name: "local", optional: false }]);
  });

  it("falls through to the base layer when the project has no copy", () => {
    writeState("lib/review", { inputs: { shared: {} } }, "base");
    expect(stateSlots(roots(), ["lib/review"])["lib/review"]?.inputs).toEqual([{ name: "shared", optional: false }]);
  });

  it("reads a YAML state as readily as a JSON one", () => {
    const file = join(dir, "project", "workflows", "plan.yaml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "inputs:\n  issue: {}\n", "utf8");
    expect(stateSlots(roots(), ["plan"])["plan"]?.inputs).toEqual([{ name: "issue", optional: false }]);
  });

  it("survives a file that is mid-edit and unparsable", () => {
    const file = join(dir, "project", "workflows", "plan.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ broken", "utf8");
    expect(stateSlots(roots(), ["plan"])).toEqual({});
  });
});
