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

  /**
   * A root that will not load used to contribute NOTHING — no section, no states, no files — and the
   * error was reported only as a field a caller could refuse over. That made the digest empty in the
   * one case it is most needed: a broken workflow is what somebody wants a sync to help them fix,
   * and a proposal cannot fix a file it was never shown.
   */
  describe("a root that does not load", () => {
    beforeEach(() => {
      // A binding form the loader rejects — the closure cannot be built, but every file is readable.
      writeFileSync(
        join(project.paths.workflowsDir, "feature", "plan.json"),
        JSON.stringify(
          {
            label: "Plan",
            children: { goals: { inputs: { issue: { schema: [] } } } },
            sequence: ["goals"],
          },
          null,
          2,
        ),
        "utf8",
      );
      project.close();
      project = openProject(dir);
    });

    it("is still rendered, from its files on disk", () => {
      const digest = workflowDigest(project);

      expect(digest.loadErrors).toHaveLength(1);
      expect(digest.loadErrors[0]?.rootId).toBe("feature/plan");
      // The root counts as covered, so nothing downstream reads this as "there is nothing here".
      expect(digest.roots).toEqual(["feature/plan"]);
      expect(digest.files.length).toBeGreaterThan(0);
      expect(digest.markdown).toContain("DOES NOT LOAD");
      // The authored text of the broken file itself, which is the thing a fix has to be written from.
      expect(digest.markdown).toContain("### State `feature/plan`");
      expect(digest.markdown).toContain('"schema": []');
      // …and its siblings under the same root, by path rather than by closure.
      expect(digest.markdown).toContain("### State `feature/plan/goals`");
    });

    it("names the load error where the model reading the digest will see it", () => {
      const digest = workflowDigest(project);
      expect(digest.markdown).toContain("unrecognized binding form");
      // Said out loud, because path scope is narrower than a closure and a model that did not know
      // would report a state reached through another root as missing.
      expect(digest.markdown).toContain("a state it reaches by naming a DIFFERENT root");
    });

    it("still hashes the files it showed, so a baseline covers what was judged", () => {
      const digest = workflowDigest(project);
      expect(digest.files).toContain("feature/plan.json");
      expect(digest.files).toContain("feature/plan/goals.json");
    });
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

describe("boundaries — a subtree another description owns", () => {
  const boundary = {
    stateId: "feature/plan/critique",
    document: "workflows/feature/plan/critique.md",
    text: "# Critique\n\nA model finds weaknesses, then a person approves.\n",
  };

  it("renders the boundary state as a contract and drops everything below it", () => {
    const digest = workflowDigest(project, { boundaries: [boundary] });

    expect(digest.bounded).toEqual(["feature/plan/critique"]);
    expect(digest.markdown).toContain("### State `feature/plan/critique` — Critique Plan — described elsewhere");
    // The interface a sibling needs is still there: what it runs, and what it takes and returns.
    expect(digest.markdown).toMatch(/described elsewhere[\s\S]*?resolved: composite \(no operation of its own\)/);
    expect(digest.markdown).toMatch(/described elsewhere[\s\S]*?inputs: plan_doc, severity_threshold/);
    // The authored file is not — showing it is exactly what invites an edit past the boundary.
    expect(digest.markdown).not.toContain("authored (feature/plan/critique.json)");
    // Nor is anything beneath it.
    expect(digest.markdown).not.toContain("feature/plan/critique/human_review`");
    // States outside the boundary are untouched.
    expect(digest.markdown).toContain("### State `feature/plan/goals`");
  });

  it("quotes the owning document, so a parent is judged against prose rather than states", () => {
    // The point of the whole split: the best account of a subtree is the description somebody wrote
    // of it, not a rendering of its state files.
    const digest = workflowDigest(project, { boundaries: [boundary] });
    expect(digest.markdown).toContain("What `workflows/feature/plan/critique.md` says it does:");
    expect(digest.markdown).toContain("A model finds weaknesses, then a person approves.");
  });

  it("leaves a bounded state out of the files a baseline would cover", () => {
    // The baseline has to cover exactly what was judged. A boundary state was seen from the
    // outside only, so claiming agreement about its file would be claiming something unverified.
    const digest = workflowDigest(project, { boundaries: [boundary] });
    expect(digest.files).toContain("feature/plan/goals.json");
    expect(digest.files).not.toContain("feature/plan/critique.json");
    expect(digest.files.some((f) => f.startsWith("feature/plan/critique/"))).toBe(false);
  });

  it("still works when the owning document could not be read", () => {
    // Absent text is not a reason to render the subtree in full — the boundary is about ownership,
    // not about how much prose happens to be available.
    const digest = workflowDigest(project, {
      boundaries: [{ stateId: "feature/plan/critique", document: "workflows/feature/plan/critique.md" }],
    });
    expect(digest.markdown).toContain("described elsewhere");
    expect(digest.markdown).not.toContain("What `workflows/feature/plan/critique.md` says it does:");
  });
});
