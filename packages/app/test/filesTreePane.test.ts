/**
 * The Files tree section's model, over a report (`filesTreeModel.ts`).
 *
 * What is worth holding down is what the chips it replaced could not say: each rule's count and first
 * matches HERE, grouped the way the rules apply; an inherited rule switched off in the layer being
 * edited kept on its own line as off (and the `!` it writes not listed a second time); a group that
 * hides nothing folded; the warning a rule earns when its only matches are inside a folder JaiRA
 * already hides; and who has the last word on a line. The switches write the layer's WHOLE document,
 * never an empty list.
 *
 * The section is drawn by the universal tree from `filesTreeOf`, so these read what it hands the page:
 * the groups and their heads, each line's words, the preview and the "why" sentence.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { layeredHiddenRules, type ConfigView, type HiddenReport, type HiddenRuleReport } from "@jaira/shared/browser";
import { filesTreeOf, groupRules, groupSummary, lastWordOn, previewSentence, ruleNotes, whyParts, withHidden, type HidPart } from "../src/renderer/filesTreeModel";

const OWN = ["drafts", "!**/dist", "**/build", "!drafts/keep"];

/** What a walk of a small checkout found, per rule. */
const FOUND: Record<string, Partial<HiddenRuleReport>> = {
  ".jaira/system": { hides: { files: 0, folders: 1 }, samples: [".jaira/system"] },
  ".git": { hides: { files: 0, folders: 1 }, samples: [".git"] },
  "**/node_modules": { hides: { files: 0, folders: 2 }, samples: ["node_modules", "packages/app/node_modules"] },
  "!**/dist": { hides: { files: 0, folders: 5 }, samples: ["packages/app/dist", "packages/cli/dist", "packages/shared/dist"] },
  drafts: { hides: { files: 0, folders: 1 }, samples: ["drafts"] },
  "**/build": { inside: { folders: [".jaira/system"], count: 6 } },
};

const report = (capped = false): HiddenReport => ({
  root: "C:/repo",
  capped,
  rules: layeredHiddenRules({ project: OWN }).map((rule) => ({ ...rule, hides: { files: 0, folders: 0 }, samples: [], ...FOUND[rule.pattern] })),
});

const VIEW: ConfigView = {
  system: null,
  base: null,
  project: { files: { hidden: OWN } },
  effective: {},
  baseFile: "C:/home/.jaira/settings.json",
  projectFile: "C:/repo/.jaira/settings.json",
  you: null,
  youFile: "C:/home/.jaira/personal-settings.json",
  baseDir: "C:/home/.jaira",
};

/** What the section is drawn from: the project's layer being edited, over the walk's report. */
const treeOf = (found: HiddenReport | null = report()) => filesTreeOf(VIEW, "project", found, () => {});

/** A sentence's parts as one string, a pattern or path between backticks. */
const said = (parts: readonly HidPart[]): string => parts.map((part) => ("code" in part ? `\`${part.code}\`` : part.text)).join("");

describe("the Files tree section", () => {
  const tree = treeOf();
  const groupOf = (id: string) => tree.groups.find((group) => group.id === id)!;
  const lineOf = (pattern: string, layer = "built in") => {
    const index = tree.rules.findIndex((r) => r.pattern === pattern && r.layer === layer);
    return tree.lineOf({ rule: tree.rules[index]!, index });
  };

  it("groups the rules the way they apply, with a count on each head", () => {
    expect(tree.groups.map((group) => group.name)).toEqual(["JaiRA's own files", "Secrets", "Version control", "Dependencies", "Build output", "Added in this project"]);
    expect(groupSummary(groupOf("jaira"), tree.rules, tree.capped)).toBe("7 rules · hides 1 folder");
    expect(groupSummary(groupOf("dependencies"), tree.rules, tree.capped)).toBe("3 rules · hides 2 folders");
    expect(groupSummary(groupOf("build"), tree.rules, tree.capped)).toBe("4 rules · hides nothing here · 1 off");
  });

  it("folds a group that hides nothing, and opens the rest", () => {
    expect(tree.openOf(groupOf("secrets"), {})).toBe(false);
    expect(tree.openOf(groupOf("dependencies"), {})).toBe(true);
    // A person's own fold wins over the default.
    expect(tree.openOf(groupOf("secrets"), { secrets: true })).toBe(true);
  });

  it("keeps an inherited rule this layer switched off on its own line, off, saying what it writes", () => {
    const dist = lineOf("**/dist");
    expect(dist.off).toBe(true);
    expect(said(dist.offNote)).toBe("off here, so this project shows it (writes `!**/dist`)");
    // The `!` is that line's state, not a second rule of the project's own.
    const own = groupOf("project").lines.map(({ rule }) => rule.pattern);
    expect(own).not.toContain("!**/dist");
    expect(own).toContain("drafts");
  });

  it("gives each line its count and first matches, or nothing where it hides nothing here", () => {
    const modules = lineOf("**/node_modules");
    expect(modules.amount).toBe("2 folders");
    expect(modules.samples).toBe("node_modules, packages/app/node_modules");
    // A rule with no match has no amount: the page says "nothing here" in its place.
    expect(lineOf("**/build", "project").amount).toBeNull();
    // A walk that stopped early says so, and the page then writes "at least" before every count.
    expect(tree.capped).toBe(false);
    expect(treeOf(report(true)).capped).toBe(true);
  });

  it("marks where each rule came from, the edited layer's own apart, and a `!` as one that puts back", () => {
    expect(lineOf(".git")).toMatchObject({ origin: "built in", mine: false, put: false });
    expect(lineOf("drafts", "project")).toMatchObject({ origin: "this project", mine: true, put: false });
    expect(lineOf("!drafts/keep", "project")).toMatchObject({ origin: "this project", mine: true, put: true });
  });

  it("warns about a rule whose only matches are inside a folder already hidden", () => {
    expect(lineOf("**/build", "project").notes).toEqual(["every match is inside .jaira/system, which is already hidden"]);
    expect(lineOf("!drafts/keep", "project").notes).toEqual(["puts back nothing: drafts is hidden by drafts, and a hidden folder takes its contents with it"]);
  });

  it("previews a typed rule and answers why a path is hidden", () => {
    expect(previewSentence({ pattern: "**/*.snap", layer: "project", hides: { files: 0, folders: 5 }, samples: ["a", "b", "c"] }, false)).toBe("would hide 5 folders: a, b, c, +2");
    expect(said(whyParts({ hidden: true, rule: "**/dist", layer: "built in", via: "packages/cli/dist" }))).toBe("hidden by `**/dist`, built in, in Build output: its folder `packages/cli/dist` matches");
    expect(said(whyParts({ hidden: false }))).toBe("not hidden");
  });
});

describe("the pieces it is drawn from", () => {
  const rules = report().rules;
  const at = (pattern: string, layer = "built in"): number => rules.findIndex((r) => r.pattern === pattern && r.layer === layer);

  it("knows who has the last word on a line", () => {
    expect(lastWordOn(rules, at("**/dist"))).toEqual({ on: false, by: "project" });
    expect(lastWordOn(rules, at("**/dist"), "project")).toEqual({ on: true, by: "built in" });
    expect(lastWordOn(rules, at(".git"))).toEqual({ on: true, by: "built in" });
  });

  it("does not draw a layer's switch of an earlier rule as a rule of its own", () => {
    const own = groupRules(rules).find((group) => group.id === "project")!;
    expect(own.lines.map(({ rule }) => rule.pattern)).toEqual(["drafts", "**/build", "!drafts/keep"]);
  });

  it("writes the layer's whole document, and never an empty list", () => {
    const doc: JsonValue = { memo: { enabled: true }, files: { hidden: ["a"] } };
    expect(withHidden(doc, ["a", "b"])).toEqual({ memo: { enabled: true }, files: { hidden: ["a", "b"] } });
    expect(withHidden(doc, [])).toEqual({ memo: { enabled: true } });
    expect(withHidden(null, ["x"])).toEqual({ files: { hidden: ["x"] } });
  });

  it("says nothing extra about a rule that is doing its job", () => {
    expect(ruleNotes(rules[at("**/node_modules")]!, at("**/node_modules"), rules)).toEqual([]);
    expect(previewSentence({ pattern: "!x", layer: "you", hides: { files: 0, folders: 0 }, samples: [] }, false)).toBe("would put back nothing here");
    expect(said(whyParts({ hidden: false, rule: "!system", layer: "you" }))).toBe("not hidden: `!system`, just you, puts it back");
  });
});
