/**
 * Naming one run of a state.
 *
 * The rule with the most riding on it is the compatibility one: a label that does not parse as an
 * expression is a literal. Every workflow written before `label` became an expression says
 * `"label": "Planning"`, and any reading that turns those into parse errors — or worse, into empty
 * cards — breaks files nobody touched.
 */
import { describe, expect, it } from "vitest";
import { checkLabel, resolveLabel } from "../src/runLabel";

describe("resolveLabel", () => {
  it("treats a bare word as a literal, so no existing label had to grow quotes", () => {
    expect(resolveLabel("Planning")).toEqual({ label: "Planning" });
    expect(resolveLabel("Spec the feature")).toEqual({ label: "Spec the feature" });
  });

  it("treats a quoted string as the same literal, so both spellings agree", () => {
    expect(resolveLabel("'Design'")).toEqual({ label: "Design" });
  });

  it("resolves a reference against the run's own inputs", () => {
    const inputs = { description: "span offsets survive a rewrite" };
    expect(resolveLabel(".inputs.description", inputs)).toEqual({ label: "span offsets survive a rewrite" });
  });

  it("shows a non-string input rather than hiding it", () => {
    expect(resolveLabel(".inputs.depth", { depth: 3 }).label).toBe("3");
    expect(resolveLabel(".inputs.goals", { goals: ["a", "b"] }).label).toBe('["a","b"]');
  });

  it("does not quote a string value — a card names the thing, it does not cite it", () => {
    expect(resolveLabel(".inputs.d", { d: "hello" }).label).toBe("hello");
  });

  it("says nothing when the state declares no label", () => {
    expect(resolveLabel(undefined)).toEqual({});
    expect(resolveLabel("")).toEqual({});
    expect(resolveLabel("   ")).toEqual({});
  });

  it("reports a reference to an input that is not set, rather than rendering blank", () => {
    const { label, issue } = resolveLabel(".inputs.missing", { description: "x" });
    expect(label).toBeUndefined();
    expect(issue).toMatchObject({ kind: "unknown-input" });
  });

  it("refuses a scope that is not resolved when a run starts", () => {
    // `.children.*` and `.outputs.*` only exist once the run is over, and a label that appears
    // after the fact is useless on the card you are watching.
    expect(resolveLabel(".outputs.plan_doc", {}).issue).toMatchObject({ kind: "unsupported" });
    expect(resolveLabel(".children.goals.output.g", {}).issue).toMatchObject({ kind: "unsupported" });
  });

  it("refuses an expression richer than a path instead of half-evaluating it", () => {
    // A comparison is a producer tree the engine evaluates. A second evaluator here is how the two
    // come to disagree about what an expression means.
    expect(resolveLabel(".inputs.a === 'b'", { a: "b" }).issue).toMatchObject({ kind: "unsupported" });
  });
});

describe("checkLabel — what lint asks with no run in hand", () => {
  it("passes a reference to a declared input", () => {
    expect(checkLabel(".inputs.description", ["description", "issue"])).toBeUndefined();
  });

  it("catches a typo against the state's own declaration", () => {
    expect(checkLabel(".inputs.descriptoin", ["description"])).toMatchObject({ kind: "unknown-input" });
  });

  it("passes a literal, which needs no inputs at all", () => {
    expect(checkLabel("Planning", [])).toBeUndefined();
  });
});
