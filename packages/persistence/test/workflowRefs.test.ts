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
  initProject(dir);
  project = openProject(dir);
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

  it("round-trips an out-of-tree state through a snapshot", () => {
    const wf = project.paths.workflowsDir;
    write(wf, "feature/plan.json", { label: "Plan", children: { goals: { state: "$PROJECT/shared/goals" } } });
    write(project.paths.projectDir, "shared/goals.json", leaf);

    const bundle = load("feature/plan");
    const snap = ensureSnapshot(project.paths.snapshotsDir, bundle);
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
      outputs: { goals: { schema: { type: "string" } } },
      operation: { prompt: "go" },
    });

    const goals = load("feature/plan").states["feature/plan/goals"]!;
    expect(goals.operation).toMatchObject({ kind: "prompt", config: { model: "anthropic/claude-sonnet-5" } });
    expect(goals.environment).toEqual({ session: "planning" });
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
  it("pins the referenced file, so editing it cannot change a started task", () => {
    withPromptFile("Original.");
    const bundle = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths, { vfs: nodeVfs() }));
    const snap = ensureSnapshot(project.paths.snapshotsDir, bundle);

    // Edit the prompt AFTER pinning — the snapshot must still carry the original.
    writeFileSync(join(project.paths.jairaDir, "prompts", "goals.md"), "Rewritten.", "utf8");
    const reloaded = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect((reloaded.states.plan!.operation as { user?: string }).user).toBe("Original.");
  });

  it("gives a different hash when a referenced file differs", () => {
    const hashFor = (body: string): string => {
      withPromptFile(body);
      const bundle = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths, { vfs: nodeVfs() }));
      return ensureSnapshot(project.paths.snapshotsDir, bundle).hash;
    };
    // The state files are byte-identical; only the fragment changed — and the fragment is part of
    // the resolved definition, so it is part of the identity without being tracked separately.
    expect(hashFor("One.")).not.toBe(hashFor("Two."));
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
 * The project's configured search path (EXPRESSIONS.md §4, JaiRA half).
 *
 * `config.workflows.path` decides what comes AFTER the workflows directory — never what comes
 * first. Only the first entry produces bare state ids, and a bare id keys the snapshot hash, the
 * event log and task rows, so letting configuration reorder it would re-identify every state.
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

  it("does not find it without the configured entry", () => {
    write(join(project.paths.jairaDir, "functions"), "review.json", { kind: "prompt", prompt: "x", model: "m" });
    write(project.paths.workflowsDir, "plan.json", {
      outputs: { v: { schema: { type: "string" } } },
      operation: "review",
    });
    expect(() =>
      loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plan", workflowLoadOptions(project.paths)),
    ).toThrow(/matches no file/);
  });

  it("keeps the workflows dir first, whatever the config asks for", () => {
    // Even asked to put another root first, the workflows dir leads — otherwise every bare state id
    // in the project would re-identify.
    const options = workflowLoadOptions(project.paths, { path: ["$JAIRA/functions"] });
    expect((options.defaultRoot as string[])[0]).toBe(project.paths.workflowsDir);
  });

  it("defaults to the workflows dir alone when nothing is configured", () => {
    expect(workflowLoadOptions(project.paths).defaultRoot).toEqual([project.paths.workflowsDir]);
  });
});
