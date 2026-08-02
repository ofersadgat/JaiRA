/**
 * The conformance digest: the live workflows as one document.
 *
 * What it must not do is summarize. A judge reading this decides whether the
 * project implements a described flow, so the tests here are about EVIDENCE —
 * the authored file arriving verbatim, the inherited operation being visible
 * even though no file says it, and nothing being dropped quietly.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import { initProject, openProject, type Project } from "../src/project";
import { workflowDigest } from "../src/digest";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-digest-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("workflowDigest", () => {
  it("covers every state of every root, and says which files they came from", () => {
    const digest = workflowDigest(project);

    expect(digest.roots).toEqual(["feature/plan"]);
    expect(digest.states).toBe(Object.keys(specPlanningFiles()).length);
    expect(digest.unreadable).toEqual([]);
    expect(digest.loadErrors).toEqual([]);
    for (const stateId of Object.keys(specPlanningFiles())) {
      expect(digest.markdown).toContain(`### State \`${stateId}\``);
    }
    expect(digest.markdown).toContain("authored (feature/plan/goals.json):");
  });

  it("reproduces the authored file rather than a summary of it", () => {
    // A comment is authorial intent; a re-serialized state would have lost it.
    writeFileSync(
      join(project.paths.workflowsDir, "feature", "plan", "goals.json"),
      '{\n  "label": "Goals",\n  "outputs": { "goals": { "schema": { "type": "array", "items": { "type": "string" } } } },\n  "operation": { "prompt": "Extract goals from {{.inputs.issue}}." }\n}\n',
      "utf8",
    );
    const digest = workflowDigest(project);
    expect(digest.markdown).toContain('"prompt": "Extract goals from {{.inputs.issue}}."');
  });

  it("shows the operation the state will RUN, including what it inherits", () => {
    // `feature/plan/goals` names no model and no kind: both come from the root's
    // `environment`. A judge reading only the file would call it empty.
    expect(workflowDigest(project).markdown).toMatch(/### State `feature\/plan\/goals`[\s\S]*?resolved: prompt on model 'planner'/);
    // The composite says so, and names the order its cursor follows.
    expect(workflowDigest(project).markdown).toMatch(
      /resolved: composite \(no operation of its own\) · children in order: goals \[feature\/plan\/goals\] → context \[feature\/plan\/context\]/,
    );
    // `sequence: []` is a claim about control flow, not an absence.
    expect(workflowDigest(project).markdown).toContain("children entered only by a transition:");
  });

  it("reports a file that will not parse instead of dropping it", () => {
    writeFileSync(join(project.paths.workflowsDir, "scratch.json"), "{ half-written", "utf8");
    const digest = workflowDigest(project);
    expect(digest.unreadable.map((f) => f.file)).toEqual(["scratch.json"]);
    // The rest of the project is still described — the caller decides what to do.
    expect(digest.roots).toEqual(["feature/plan"]);
  });

  it("names any state it had to clip", () => {
    const digest = workflowDigest(project, { maxStateChars: 200 });
    expect(digest.truncated.length).toBeGreaterThan(0);
    expect(digest.markdown).toContain("… clipped: this state is longer than the digest shows");
  });

  it("narrows to the named roots, and refuses one it does not know", () => {
    expect(workflowDigest(project, { roots: ["feature/plan"] }).roots).toEqual(["feature/plan"]);
    expect(() => workflowDigest(project, { roots: ["feature/nope"] })).toThrow(/unknown workflow 'feature\/nope'/);
  });
});
