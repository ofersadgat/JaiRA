/**
 * Workflow path references end to end (WORKFLOWS.md §2.1).
 *
 * The load path, the lint surface and the snapshotter each resolve references independently, so the
 * thing worth testing is that they agree — a workflow that lints must be the one that runs, and a
 * snapshot of it must reload to the same state ids.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { loadBundle, snapshotHash } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";
import { browseWorkflows } from "../src/workflows";
import { nodeVfs, workflowLoadOptions } from "../src/workflowRefs";

let dir: string;
let project: Project;

const leaf = {
  label: "Goals",
  outputs: { goals: { schema: { type: "string" } } },
  operation: { kind: "prompt", prompt: "go", model: "anthropic/claude-sonnet-5" },
};

function write(root: string, relPath: string, body: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-wfrefs-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Load the project's live workflows the way `beginTaskRun` does. */
function load(rootId: string) {
  return loadBundle(readWorkflowFiles(project.paths.workflowsDir), rootId, workflowLoadOptions(project.paths));
}

describe("reference spellings", () => {
  it.each([["feature/plan/goals"], ["./goals"], ["$JAIRA/workflows/feature/plan/goals"]])(
    "resolves %s to the same canonical state id",
    (ref) => {
      const wf = project.paths.workflowsDir;
      write(wf, "feature/plan.json", { label: "Plan", children: { goals: { state: ref } } });
      write(wf, "feature/plan/goals.json", leaf);

      const bundle = load("feature/plan");
      expect(Object.keys(bundle.states).sort()).toEqual(["feature/plan", "feature/plan/goals"]);
      // And the browser agrees about which file is the root — it derives roots from the same refs.
      const browser = browseWorkflows(project);
      expect(browser.workflows.map((w) => w.rootId)).toEqual(["feature/plan"]);
      expect(browser.unreachable).toEqual([]);
    },
  );

  it("reads an out-of-tree state through the $PROJECT root", () => {
    const wf = project.paths.workflowsDir;
    write(wf, "feature/plan.json", { label: "Plan", children: { goals: { state: "$PROJECT/shared/goals" } } });
    write(project.paths.projectDir, "shared/goals.json", leaf);

    const bundle = load("feature/plan");
    const external = join(project.paths.projectDir, "shared/goals").replace(/\\/g, "/");
    expect(Object.keys(bundle.states).sort()).toEqual([external, "feature/plan"].sort());
  });

  it("round-trips an out-of-tree state through a snapshot", async () => {
    const wf = project.paths.workflowsDir;
    write(wf, "feature/plan.json", { label: "Plan", children: { goals: { state: "$PROJECT/shared/goals" } } });
    write(project.paths.projectDir, "shared/goals.json", leaf);

    const bundle = load("feature/plan");
    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);
    // Reloading verifies the content hash, so an id that failed to round-trip would fail here.
    const reloaded = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect(Object.keys(reloaded.states).sort()).toEqual(Object.keys(bundle.states).sort());
    expect(reloaded.rootId).toBe("feature/plan");
  });

  it("reports an unresolvable reference instead of throwing out of the browser", () => {
    write(project.paths.workflowsDir, "feature/plan.json", {
      label: "Plan",
      children: { goals: { state: "$NOPE/goals" } },
    });
    const browser = browseWorkflows(project);
    expect(browser.workflows[0]!.loadError).toMatch(/unknown root '\$NOPE'/);
  });
});

describe("inherited environment across files", () => {
  it("gives a leaf the model its root declared", () => {
    const wf = project.paths.workflowsDir;
    write(wf, "feature/plan.json", {
      label: "Plan",
      environment: { kind: "prompt", model: "anthropic/claude-sonnet-5", session: "planning" },
      children: { goals: { state: "./goals" } },
    });
    write(wf, "feature/plan/goals.json", {
      label: "Goals",
      // Bound like every other output (see `workflows.ts`), so the only thing this leaf is testing
      // is where its `kind` and its model came from.
      outputs: { goals: { schema: { type: "string" }, binding: ".operation.output.goals" } },
      operation: { prompt: "go", output: { goals: { schema: { type: "string" } } } },
    });

    const goals = load("feature/plan").states["feature/plan/goals"]!;
    expect(goals.operation).toMatchObject({ kind: "prompt", config: { model: "anthropic/claude-sonnet-5" } });
    // The session arrives CANONICALIZED, not as the sugar the root wrote: `"planning"` is
    // `{ $ref: "planning", $in: <the state that declared it> }` (hw's `session.ts`), and the scope is
    // what keeps two mounts of one subtree from sharing a conversation because they share a name.
    expect(goals.environment).toEqual({ session: { $ref: "planning", $in: "feature/plan" } });
    // Nothing in the lint surface objects to an operation completed from an ancestor.
    expect(browseWorkflows(project).workflows[0]!.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("document references", () => {
  /** A workflow whose prompt lives in a markdown file under `$JAIRA/prompts`. */
  function withPromptFile(body: string): void {
    const wf = project.paths.workflowsDir;
    write(wf, "plan.json", {
      label: "Plan",
      outputs: { goals: { schema: { type: "string" } } },
      operation: { kind: "prompt", prompt: { $ref: "$/prompts/goals.md" }, model: "m" },
    });
    writeFileSync(join(project.paths.jairaDir, "prompts", "goals.md"), body, "utf8");
  }

  beforeEach(() => mkdirSync(join(project.paths.jairaDir, "prompts"), { recursive: true }));

  it("loads a prompt out of a markdown file", () => {
    withPromptFile("Extract goals.");
    const op = load("plan").states.plan!.operation as { user?: string };
    expect(op.user).toBe("Extract goals.");
  });

  /**
   * The fragment used to be copied into the snapshot alongside the states and hashed with them.
   * Storing the RESOLVED definition gets the same guarantee for free and more directly: the prompt
   * body is already spliced into the stored operation, so there is no second file for a reload to
   * resolve — and nothing for an edit to reach.
   */
  it("pins the referenced file, so editing it cannot change a started task", async () => {
    withPromptFile("Original.");
    const bundle = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths, { vfs: nodeVfs() }));
    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);

    // Edit the prompt AFTER pinning — the snapshot must still carry the original.
    writeFileSync(join(project.paths.jairaDir, "prompts", "goals.md"), "Rewritten.", "utf8");
    const reloaded = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect((reloaded.states.plan!.operation as { user?: string }).user).toBe("Original.");
  });

  it("gives a different hash when a referenced file differs", async () => {
    const hashFor = async (body: string): Promise<string> => {
      withPromptFile(body);
      const bundle = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths, { vfs: nodeVfs() }));
      return (await ensureSnapshot(project.paths.snapshotsDir, bundle)).hash;
    };
    // The state files are byte-identical; only the fragment changed — and the fragment is part of
    // the resolved definition, so it is part of the identity without being tracked separately.
    expect(await hashFor("One.")).not.toBe(await hashFor("Two."));
  });
});

describe("YAML state files", () => {
  it("loads a state authored in YAML, and hashes it the same as its JSON spelling", () => {
    const wf = project.paths.workflowsDir;
    const yaml = ["label: Plan", "operation:", "  kind: prompt", "  prompt: go", "  model: m", "outputs:", "  goals:", "    schema:", "      type: string", ""].join("\n");
    writeFileSync(join(wf, "plan.yaml"), yaml, "utf8");
    const fromYaml = load("plan");
    expect(fromYaml.states.plan!.label).toBe("Plan");
    expect((fromYaml.states.plan!.operation as { user?: string }).user).toBe("go");

    // The same content as JSON is the SAME workflow: the hash is over the parsed value.
    rmSync(join(wf, "plan.yaml"));
    write(wf, "plan.json", {
      label: "Plan",
      operation: { kind: "prompt", prompt: "go", model: "m" },
      outputs: { goals: { schema: { type: "string" } } },
    });
    expect(snapshotHash(load("plan"))).toBe(snapshotHash(fromYaml));
  });
});

/**
 * The project's search path (EXPRESSIONS.md §4, JaiRA half).
 *
 * Absent configuration, it is GENERATED from the layer roots — `<root>/workflows` then
 * `<root>/functions`, for the project's `.jaira/` and then the shared one. `config.workflows.path`
 * replaces that list, and whatever it says the workflows directory still leads: a layer that
 * configuration could push behind another would stop being an override.
 */
describe("the project search path", () => {
  it("finds a fragment under a configured root that is not the workflows dir", () => {
    const functions = join(project.paths.jairaDir, "functions");
    write(functions, "review.json", { kind: "prompt", prompt: "Review it.", model: "from-path" });
    write(project.paths.workflowsDir, "plan.json", {
      outputs: { v: { schema: { type: "string" } } },
      operation: "review", // bare, and nowhere under workflows/ — only the path finds it
    });

    const options = workflowLoadOptions(project.paths, { path: ["$JAIRA/functions"] });
    const op = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", options).states.plan!
      .operation as { user?: string; config?: unknown };
    expect(op.user).toBe("Review it.");
    expect(op.config).toEqual({ model: "from-path" });
  });

  it("does not find a fragment that sits off the path entirely", () => {
    // `lib/` is on no layer's path — unlike `functions/`, which the generated default now includes.
    write(join(project.paths.jairaDir, "lib"), "review.json", { kind: "prompt", prompt: "x", model: "m" });
    write(project.paths.workflowsDir, "plan.json", {
      outputs: { v: { schema: { type: "string" } } },
      operation: "review",
    });
    expect(() =>
      loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths)),
    ).toThrow(/matches no file/);
  });

  it("finds a project fragment under functions/ with NO configuration at all", () => {
    // The generated default carries `<root>/functions`, so a project need not configure a path to
    // put shared operations somewhere other than `workflows/`.
    write(join(project.paths.jairaDir, "functions"), "review.json", {
      kind: "prompt",
      prompt: "Review it.",
      model: "from-default-path",
    });
    write(project.paths.workflowsDir, "plan.json", {
      outputs: { v: { schema: { type: "string" } } },
      operation: "review",
    });

    const op = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths))
      .states.plan!.operation as { config?: unknown };
    expect(op.config).toEqual({ model: "from-default-path" });
  });

  it("keeps the workflows dir first, whatever the config asks for", () => {
    // Even asked to put another root first, the workflows dir leads — otherwise every bare state id
    // in the project would re-identify.
    const options = workflowLoadOptions(project.paths, { path: ["$JAIRA/functions"] });
    expect((options.defaultRoot as string[])[0]).toBe(project.paths.workflowsDir);
  });

  it("generates the layer path when nothing is configured", () => {
    // One source of truth: `paths.roots` in, `<root>/workflows` + `<root>/functions` out. Nothing
    // is written down twice, so adding a layer later cannot leave a stale constant behind.
    expect(workflowLoadOptions(project.paths).defaultRoot).toEqual([
      project.paths.workflowsDir,
      join(project.paths.jairaDir, "functions"),
      project.paths.base.workflowsDir,
      project.paths.base.functionsDir,
      // What ships, last (decision 0006) — see `builtInLayer.test.ts` for what that layer promises.
      project.paths.builtIn.workflowsDir,
      project.paths.builtIn.functionsDir,
    ]);
  });

  it("exposes the layer roots a bare `$` searches", () => {
    expect(workflowLoadOptions(project.paths).rootPath).toEqual([
      project.paths.jairaDir,
      project.paths.base.baseDir,
      project.paths.builtIn.dir,
    ]);
  });
});

/**
 * The operations JaiRA itself supplies (WORKFLOWS.md §7.4).
 *
 * A call in an expression names a DOCUMENT, so `on_user_event('task_drag')` resolves only because
 * the load path is handed one. It is shipped rather than written into `~/.jaira/functions` — a file
 * is one a user can edit into disagreement with the code that serves it — and it is consulted LAST,
 * so a project that wants its own still gets it.
 */
describe("host-shipped operation documents", () => {
  const waiting = {
    operation: { kind: "prompt", prompt: "go", model: "anthropic/claude-sonnet-5" },
    children: { deploy: { state: "./deploy" } },
    transitions: [{ to: "deploy", when: "on_user_event('task_drag')" }],
  };

  it("resolves `on_user_event` with no file anywhere", () => {
    write(project.paths.workflowsDir, "ship.json", waiting);
    write(project.paths.workflowsDir, "ship/deploy.json", leaf);
    const guard = load("ship").states.ship!.transitions![0]!;
    expect(guard.whenError).toBeUndefined();
    expect((guard.whenRef as { op: { functionRef: string } }).op.functionRef).toBe("on_user_event");
  });

  /** The rule's own target, bound by the loader — what makes the options bag optional. */
  it("fills the call's `transition` input with where the rule goes", () => {
    write(project.paths.workflowsDir, "ship.json", waiting);
    write(project.paths.workflowsDir, "ship/deploy.json", leaf);
    const guard = load("ship").states.ship!.transitions![0]!;
    const parameters = (guard.whenRef as { parameters?: Record<string, { binding?: { json?: unknown } }> }).parameters;
    expect(parameters?.transition?.binding?.json).toEqual({ to: "deploy" });
  });

  it("loses to a project file of the same name", () => {
    write(project.paths.workflowsDir, "ship.json", waiting);
    write(project.paths.workflowsDir, "ship/deploy.json", leaf);
    write(project.paths.jairaDir, "functions/on_user_event.json", {
      kind: "function",
      function: "something_else",
      input: { event: { kind: "text", index: 0 } },
    });
    const guard = load("ship").states.ship!.transitions![0]!;
    expect((guard.whenRef as { op: { functionRef: string } }).op.functionRef).toBe("something_else");
  });
});
