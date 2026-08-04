/**
 * Lint paths, and which control answers for one.
 *
 * The two properties that carry the feature:
 *
 *  1. An anchor claims a path on SEGMENT boundaries. `inputs.a` claiming `inputs.abbrev` would put a
 *     red outline on the wrong row and scroll to it — a diagnostic pointing at innocent data is
 *     worse than one pointing at nothing.
 *  2. The MOST SPECIFIC anchor wins, and a container still catches what no row of it declares. That
 *     is what stops "required child input 'x' is not wired" — reported against the table, because
 *     the row that would hold it does not exist — from being unreachable.
 */
import { describe, expect, it } from "vitest";
import type { LintIssue } from "@jaira/shared";
import { anchorFor, covers, fieldClass, formIssues, markFor, NO_ISSUES } from "../src/renderer/issues";

const error = (path: string, message = "boom"): LintIssue => ({
  stateId: "review",
  path,
  message,
  severity: "error",
});
const warning = (path: string, message = "hmm"): LintIssue => ({
  stateId: "review",
  path,
  message,
  severity: "warning",
});

describe("covers", () => {
  it("claims itself and anything inside it", () => {
    expect(covers("outputs", "outputs")).toBe(true);
    expect(covers("outputs", "outputs.report")).toBe(true);
    expect(covers("outputs", "outputs.report.kind")).toBe(true);
    expect(covers("transitions", "transitions[2].when")).toBe(true);
    expect(covers("transitions[2]", "transitions[2].to")).toBe(true);
  });

  it("stops at a segment boundary", () => {
    // The whole reason this is not `startsWith`.
    expect(covers("inputs.a", "inputs.abbrev")).toBe(false);
    expect(covers("outputs", "outputsize")).toBe(false);
    expect(covers("transitions[1]", "transitions[10].to")).toBe(false);
  });

  it("claims nothing when there is no anchor", () => {
    // `path: ""` is the whole-file diagnostic — "not valid JSON" — which no control owns.
    expect(covers("", "outputs")).toBe(false);
  });
});

describe("what a container declares", () => {
  const issues = formIssues([error("outputs.report.kind"), warning("outputs.plan")]);

  it("is a scroll target and a tooltip, never a colour", () => {
    // The row is where the reveal lands; which of its boxes is wrong is the boxes' own business.
    // A container outline would also collide with the file tree, whose rows use `has-error`.
    const row = markFor(issues, "outputs.report", "slot-row");

    expect(row.className).toBe("slot-row");
    expect(row.title).toBe("boom");
    expect(row["data-issue"]).toBe("outputs.report");
  });

  it("carries everything under it, so a table still explains a row it has no box for", () => {
    const unwired = formIssues([error("children.critique.inputs", "required child input 'issue' is not wired")]);

    expect(markFor(unwired, "children.critique.inputs", "bindings").title).toBe(
      "required child input 'issue' is not wired",
    );
  });

  it("answers for two parts of the document at once", () => {
    // The children table edits `sequence` too — the spine checkbox is the only control for it.
    const both = formIssues([error("sequence[0]", "'plan' is not a declared child")]);
    const table = markFor(both, ["children", "sequence"], "slots");

    expect(table.title).toBe("'plan' is not a declared child");
    expect(table["data-issue"]).toBe("children sequence");
  });

  it("says an error before a warning, so the tooltip opens with the worst of it", () => {
    const mixed = formIssues([warning("operation", "slow"), error("operation", "broken")]);

    expect(markFor(mixed, "operation", "op-block").title).toBe("broken\nslow");
  });

  it("counts a duplicate once", () => {
    // A state reachable from two roots is linted once per root, so the same issue arrives twice.
    const twice = formIssues([error("outputs.report"), error("outputs.report")]);

    expect(markFor(twice, "outputs.report", "slot-row").title).toBe("boom");
  });
});

describe("what a box wears", () => {
  const issues = formIssues([error("outputs.report.kind"), warning("outputs.plan")]);

  it("marks the box in the severity of what is reported against it", () => {
    expect(fieldClass(issues, "outputs.report.kind")).toBe(" issue-bad");
    expect(fieldClass(issues, "outputs.plan")).toBe(" issue-warn");
    expect(fieldClass(issues, "outputs.other")).toBe("");
  });

  it("leaves its neighbour's share alone", () => {
    // A slot row is a type picker beside a binding box. The binding box takes what is reported
    // against the slot; `.kind` is the picker's, and lighting both would answer neither question.
    expect(fieldClass(issues, "outputs.report", ["outputs.report.kind"])).toBe("");
  });

  it("gives a missing wire's blank row the table's error, in ERROR colour", () => {
    // hw reports "required child input 'goal' is not wired" against the TABLE — the wire it is about
    // is not in the document to be named. The box for it is, because `seedRequiredBindings` puts a
    // blank row there, and that row carries the form's own `.unwired` warning border. Leave the
    // table's error on the table and the only thing on screen is a yellow box for a red problem.
    const unwired = formIssues([error("children.plan.inputs", "required child input 'goal' is not wired")]);

    expect(fieldClass(unwired, "children.plan.inputs.goal")).toBe("");
    expect(fieldClass(unwired, "children.plan.inputs", ["children.plan.inputs.goal"])).toBe(" issue-bad");
  });

  it("marks nothing when nothing was linted", () => {
    expect(NO_ISSUES.empty).toBe(true);
    expect(fieldClass(NO_ISSUES, "outputs.report")).toBe("");
  });
});

/**
 * A stand-in for the form's DOM.
 *
 * `anchorFor` reads two methods and no more, which is deliberate: the search is over declared paths,
 * not over React or over a layout, and it stays testable in the node environment the rest of this
 * suite runs in.
 */
function fakeForm(anchors: string[]): ParentNode {
  const elements = anchors.map((value) => ({ getAttribute: () => value }) as unknown as HTMLElement);
  return { querySelectorAll: () => elements } as unknown as ParentNode;
}

describe("anchorFor", () => {
  it("picks the most specific control that covers the path", () => {
    const form = fakeForm(["inputs", "outputs", "outputs.report"]);

    expect(anchorFor(form, "outputs.report.kind")?.getAttribute("")).toBe("outputs.report");
  });

  it("falls back to the container when no row declares the path", () => {
    const form = fakeForm(["outputs", "outputs.report"]);

    expect(anchorFor(form, "outputs.missing")?.getAttribute("")).toBe("outputs");
  });

  it("reads a control that answers for two paths", () => {
    const form = fakeForm(["children sequence", "transitions"]);

    expect(anchorFor(form, "sequence[1]")?.getAttribute("")).toBe("children sequence");
  });

  it("finds nothing rather than the nearest thing", () => {
    // A diagnostic the form has no control for reveals nothing — the inspector still shows the text.
    expect(anchorFor(fakeForm(["inputs", "outputs"]), "limits.timeout")).toBeNull();
  });
});
