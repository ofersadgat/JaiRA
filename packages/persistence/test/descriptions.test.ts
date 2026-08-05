/**
 * The ownership rule, on its own.
 *
 * Everything about nested descriptions rests on one answer — which document is a state's — and the
 * rest of the feature is only as sound as it is. Three properties matter here:
 *
 *  - **exactly one owner.** A state claimed by two documents means drift reported twice with no way
 *    to settle either, and two syncs each able to overwrite the other's work.
 *  - **nearest wins.** The more specific document is the one that knows; a parent that kept
 *    ownership would make splitting a description out change nothing.
 *  - **the parent still knows what it handed over.** A boundary it cannot name is one it cannot
 *    describe the contract of, and cannot warn about.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDescriptions, nearestRoot, ownershipOf } from "../src/descriptions";

const STATES = [
  "feature",
  "feature/plan",
  "feature/plan/goals",
  "feature/plan/critique",
  "feature/plan/critique/human_review",
  "release",
];

const WORKFLOW_MD = "workflows/workflow.md";
const FEATURE_MD = "workflows/feature.md";
const PLAN_MD = "workflows/feature/plan.md";
const CRITIQUE_MD = "workflows/feature/plan/critique.md";

describe("nearestRoot", () => {
  it("prefers the longer match, because it is the more specific claim", () => {
    expect(nearestRoot("feature/plan/goals", ["feature", "feature/plan"])).toBe("feature/plan");
  });

  it("matches on whole segments, so a name that merely starts the same does not count", () => {
    // `feature_flags` is not inside `feature`, and a prefix test on raw strings would say it was.
    expect(nearestRoot("feature_flags/x", ["feature"])).toBeNull();
  });

  it("counts a root as owning itself", () => {
    expect(nearestRoot("feature/plan", ["feature/plan"])).toBe("feature/plan");
  });
});

describe("ownershipOf", () => {
  it("gives every state exactly one owner", () => {
    const documents = [WORKFLOW_MD, FEATURE_MD, PLAN_MD, CRITIQUE_MD];
    const owners = documents.map((d) => ownershipOf(d, documents, STATES));

    const seen = new Map<string, string[]>();
    for (const ownership of owners) {
      for (const state of ownership.owns) {
        seen.set(state, [...(seen.get(state) ?? []), ownership.document]);
      }
    }
    // Every state claimed, and none of them twice.
    expect([...seen.keys()].sort()).toEqual([...STATES].sort());
    expect([...seen.values()].filter((docs) => docs.length !== 1)).toEqual([]);
  });

  it("stops a description at the nearest one below it", () => {
    const documents = [FEATURE_MD, PLAN_MD];
    const feature = ownershipOf(FEATURE_MD, documents, STATES);

    expect(feature.owns).toEqual(["feature"]);
    expect(feature.delegates).toEqual([{ document: PLAN_MD, root: "feature/plan", states: 4 }]);
  });

  it("names only its DIRECT delegates, not every description beneath it", () => {
    const documents = [FEATURE_MD, PLAN_MD, CRITIQUE_MD];
    const feature = ownershipOf(FEATURE_MD, documents, STATES);

    // `critique.md` is `plan.md`'s boundary, not `feature.md`'s. Listing it here would make the
    // parent name a boundary it never touches, and count the same states twice.
    expect(feature.delegates.map((d) => d.document)).toEqual([PLAN_MD]);
    // The count is the whole subtree, sub-delegated states included: the question is "how much am I
    // not looking at", and that does not care how many documents share the rest.
    expect(feature.delegates[0]?.states).toBe(4);

    const plan = ownershipOf(PLAN_MD, documents, STATES);
    expect(plan.owns).toEqual(["feature/plan", "feature/plan/goals"]);
    expect(plan.delegates.map((d) => d.document)).toEqual([CRITIQUE_MD]);
  });

  it("gives the layer-wide document everything nothing else claims", () => {
    const documents = [WORKFLOW_MD, PLAN_MD];
    const workflow = ownershipOf(WORKFLOW_MD, documents, STATES);

    expect(workflow.root).toBeNull();
    expect(workflow.owns).toEqual(["feature", "release"]);
    expect(workflow.delegates.map((d) => d.root)).toEqual(["feature/plan"]);
  });

  it("behaves exactly as before when it is the only description", () => {
    // The property that keeps existing projects working: one `workflow.md` owns the whole layer.
    const workflow = ownershipOf(WORKFLOW_MD, [WORKFLOW_MD], STATES);
    expect(workflow.owns).toEqual([...STATES].sort());
    expect(workflow.delegates).toEqual([]);
  });

  it("owns nothing when its whole subtree has been split out", () => {
    // Not an error — the document is then purely a statement about how its children fit together.
    const documents = [FEATURE_MD, PLAN_MD];
    const feature = ownershipOf(FEATURE_MD, documents, ["feature/plan", "feature/plan/goals"]);
    expect(feature.owns).toEqual([]);
    expect(feature.delegates).toHaveLength(1);
  });
});

describe("listDescriptions", () => {
  it("finds every markdown file under workflows/, at any depth", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-descriptions-"));
    try {
      mkdirSync(join(dir, "feature", "plan"), { recursive: true });
      writeFileSync(join(dir, "workflow.md"), "#", "utf8");
      writeFileSync(join(dir, "feature.md"), "#", "utf8");
      writeFileSync(join(dir, "feature", "plan.md"), "#", "utf8");
      writeFileSync(join(dir, "feature", "plan", "critique.md"), "#", "utf8");
      // Not descriptions: a state file, and a document that is not markdown.
      writeFileSync(join(dir, "feature.json"), "{}", "utf8");
      writeFileSync(join(dir, "notes.txt"), "x", "utf8");

      expect(listDescriptions(dir)).toEqual([FEATURE_MD, CRITIQUE_MD, PLAN_MD, WORKFLOW_MD].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers nothing for a directory that does not exist", () => {
    expect(listDescriptions(join(tmpdir(), "jaira-no-such-dir-xyz"))).toEqual([]);
  });
});
