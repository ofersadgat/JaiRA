/**
 * The workflow browser / lint surface (DESIGN §11.1).
 *
 * The behaviour that matters is resilience: the author is editing these files in
 * another window, so the browser is asked to describe a directory that is
 * frequently, temporarily broken. Every kind of breakage must come back as data.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { initProject, openProject, type Project } from "../src/project";
import { browseWorkflows, lintErrors } from "../src/workflows";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-wfbrowse-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  writeFileSync(join(project.paths.workflowsDir, relPath), content, "utf8");
}

describe("browseWorkflows", () => {
  it("finds the workflow root and its closure, and lists every state file", () => {
    const browser = browseWorkflows(project);

    // `feature/plan` is a root because nothing declares it as a child; its
    // descendants are not roots.
    expect(browser.workflows.map((w) => w.rootId)).toEqual(["feature/plan"]);
    const plan = browser.workflows[0]!;
    expect(plan.label).toBe("Planning");
    expect(plan.states).toContain("feature/plan/critique");
    expect(plan.snapshotHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(browser.unreachable).toEqual([]);

    // Every file appears in the tree, root or not.
    expect(browser.files.map((f) => f.stateId)).toEqual([...plan.states].sort());
    expect(browser.files.every((f) => f.file.endsWith(".json") && !f.file.includes("\\"))).toBe(true);
  });

  it("reports lint results rather than throwing, and finds none in the shipped workflow", () => {
    const browser = browseWorkflows(project);
    // The starter workflow is the one thing that must lint clean; `strict` means
    // unregistered functionRefs would show up here, and the planning workflow's
    // human gate is intentionally not registered — so it is a warning-free error
    // check we assert, not zero issues.
    expect(lintErrors(browser)).toEqual([]);
  });

  it("flags an authoring error against the state that has it", () => {
    // A guard that doesn't infer to boolean is exactly the §7.2 strictness the
    // lint surface exists to surface early.
    write(
      "feature/plan/goals.json",
      JSON.stringify({
        label: "Goals",
        outputs: { goals: { kind: "text" } },
        operation: { kind: "prompt", template: "list goals" },
        transitions: [{ to: "terminate.success", when: ".outputs.goals" }],
      }),
    );
    const browser = browseWorkflows(project);
    const errors = lintErrors(browser);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.rootId === "feature/plan")).toBe(true);
  });

  it("survives a half-saved file and names it", () => {
    write("scratch.json", "{ this is not json");
    const browser = browseWorkflows(project);
    const broken = browser.files.find((f) => f.file === "scratch.json")!;
    expect(broken.error).toBeDefined();
    // The rest of the directory still browses — the point of a tolerant read.
    expect(browser.workflows.map((w) => w.rootId)).toEqual(["feature/plan"]);
  });

  it("reports a dangling child reference as a diagnostic, not an exception", () => {
    write(
      "orphan.json",
      JSON.stringify({ label: "Orphan", children: { missing: { state: "nowhere/at/all" } } }),
    );
    const browser = browseWorkflows(project);
    const orphan = browser.workflows.find((w) => w.rootId === "orphan")!;
    // The loader tolerates the dangling reference; the validator is what names it.
    const issue = orphan.issues.find((i) => i.severity === "error")!;
    expect(issue.stateId).toBe("orphan");
    expect(issue.path).toBe("children.missing.state");
    expect(issue.message).toMatch(/nowhere\/at\/all/);
    // And the healthy workflow is unaffected.
    expect(browser.workflows.find((w) => w.rootId === "feature/plan")!.issues).toEqual([]);
  });

  it("reports states left unreachable when references form a cycle", () => {
    // Two states naming each other means neither is a root, so without this both
    // would simply vanish from the browser.
    write("a.json", JSON.stringify({ children: { b: { state: "b" } } }));
    write("b.json", JSON.stringify({ children: { a: { state: "a" } } }));
    const browser = browseWorkflows(project);
    expect(browser.workflows.map((w) => w.rootId)).toEqual(["feature/plan"]);
    expect(browser.unreachable).toEqual(["a", "b"]);
  });

  it("links tasks to their workflow and flags snapshot drift", () => {
    project.runtime.insert("t-1", 1);
    project.tasks.write({
      id: "t-1",
      title: "Plan",
      workflow: "feature/plan",
      createdAt: new Date(1).toISOString(),
    });
    project.runtime.setSnapshot("t-1", "a-stale-hash", 2);

    const plan = browseWorkflows(project).workflows[0]!;
    expect(plan.taskIds).toEqual(["t-1"]);
    // Execution reads the pinned snapshot, never live `workflows/` (§5.3), so a
    // task pinned elsewhere is running different source than the browser shows.
    expect(plan.driftedTasks).toEqual(["t-1"]);
  });

  it("warns when one session declares both summary and full_history", () => {
    // The planning workflow's `critique` already declares full_history; adding a
    // summary state to the same (default) session is the conflict.
    write(
      "feature/plan/goals.json",
      JSON.stringify({
        label: "Goals",
        inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } },
        outputs: { goals: { schema: { type: "array", items: { type: "string" } } } },
        environment: { conversation: { mode: "summary" } },
        operation: { kind: "prompt", prompt: "Extract goals.", model: "planner" },
      }),
    );
    const plan = browseWorkflows(project).workflows[0]!;
    const warning = plan.issues.find((i) => i.path === "operation.conversation.mode")!;
    expect(warning.severity).toBe("warning");
    expect(warning.message).toMatch(/declares both summary and full_history/);
    // Advisory only: the run still works, it just summarizes for both.
    expect(lintErrors(browseWorkflows(project))).toEqual([]);
  });

  it("returns an empty browser for a project with no workflows", () => {
    rmSync(project.paths.workflowsDir, { recursive: true, force: true });
    expect(browseWorkflows(project)).toEqual({ workflows: [], files: [], unreachable: [] });
  });
});
