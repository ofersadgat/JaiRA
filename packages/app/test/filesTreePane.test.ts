/**
 * The Files tree section, rendered to static markup over a report (`filesTreePane.tsx`).
 *
 * What is worth holding down is what the chips it replaced could not say: each rule's count and first
 * matches HERE, grouped the way the rules apply; an inherited rule switched off in the layer being
 * edited drawn on its own line as off (and the `!` it writes not drawn a second time); a group that
 * hides nothing folded; and the warning a rule earns when its only matches are inside a folder JaiRA
 * already hides. The switches write the layer's WHOLE document, never an empty list.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonValue } from "@declarative-ai/json";
import { layeredHiddenRules, type ConfigView, type HiddenReport, type HiddenRuleReport } from "@jaira/shared/browser";
import { SettingsRowsContext } from "../src/renderer/controls";
import { FilesTreeView, groupRules, lastWordOn, previewSentence, ruleNotes, whySentence, withHidden, type FilesTreeViewProps } from "../src/renderer/filesTreePane";

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

function draw(patch: Partial<FilesTreeViewProps> = {}): string {
  const props: FilesTreeViewProps = {
    view: VIEW,
    layer: "project",
    report: report(),
    busy: false,
    onWrite: () => {},
    typed: "",
    preview: null,
    onType: () => {},
    asked: "",
    answer: null,
    onAsk: () => {},
    open: {},
    onFold: () => {},
    ...patch,
  };
  return renderToStaticMarkup(createElement(SettingsRowsContext.Provider, { value: true }, createElement(FilesTreeView, props)));
}

describe("the Files tree section", () => {
  it("is a settings section with the row, the table, the add line and the why line", () => {
    const html = draw();
    expect(html).toContain('data-part="files-tree"');
    expect(html).toContain("Files tree");
    expect(html).toContain("Hidden in the tree");
    expect(html).toContain("Later rules win, so a !pattern puts back something an earlier rule hid.");
    for (const column of ["Pattern", "What it hides here", "From"]) expect(html).toContain(`>${column}</span>`);
    expect(html).toContain('placeholder="pattern, or !pattern to put something back"');
    expect(html).toContain("Why is a path hidden?");
    expect(html).toContain("Show system/");
  });

  it("groups the rules the way they apply, with a count on each head", () => {
    const html = draw();
    const heads = [...html.matchAll(/class="hid-group-name">([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(["JaiRA&#x27;s own files", "Secrets", "Version control", "Dependencies", "Build output", "Added in this project"]);
    expect(html).toContain("7 rules · hides 1 folder");
    expect(html).toContain("3 rules · hides 2 folders");
    expect(html).toContain("4 rules · hides nothing here · 1 off");
  });

  it("folds a group that hides nothing, and opens the rest", () => {
    const html = draw();
    expect(html).toMatch(/<div class="hid-group"><button[^>]*aria-expanded="false"[^>]*>.*?Secrets/);
    expect(html).toMatch(/<div class="hid-group open"><button[^>]*aria-expanded="true"[^>]*>.*?Dependencies/);
    // A person's own fold wins over the default.
    expect(draw({ open: { secrets: true } })).toMatch(/<div class="hid-group open"><button[^>]*aria-expanded="true"[^>]*>.*?Secrets/);
  });

  it("draws an inherited rule this layer switched off on its own line, struck, saying what it writes", () => {
    const html = draw();
    expect(html).toContain('class="hid-line is-off"');
    expect(html).toContain("off here, so this project shows it (writes <code class=\"hid-code\">!**/dist</code>)");
    // The `!` is that line's state, not a second rule of the project's own.
    const own = html.slice(html.indexOf("Added in this project"));
    expect(own).not.toContain(">!</span>**/dist");
    expect(own).toContain(">drafts</span>");
  });

  it("gives each line its count and first matches, or says it hides nothing here", () => {
    const html = draw();
    expect(html).toContain('<span class="hid-count">2 folders</span><span class="hid-samples data-secondary">node_modules, packages/app/node_modules</span>');
    expect(html).toContain("nothing here");
    expect(draw({ report: report(true) })).toContain('<span class="hid-count">at least 2 folders</span>');
  });

  it("marks where each rule came from, the edited layer's own in the accent", () => {
    const html = draw();
    expect(html).toContain('<span class="hid-chip hid-origin">built in</span>');
    expect(html).toContain('<span class="hid-chip hid-origin is-here">this project</span>');
    expect(html).toContain('<span class="hid-chip hid-puts">puts back</span>');
    expect(html).toContain('<span class="hid-bang">!</span>');
  });

  it("warns about a rule whose only matches are inside a folder already hidden", () => {
    const html = draw();
    expect(html).toContain("every match is inside .jaira/system, which is already hidden");
    expect(html).toContain("puts back nothing: drafts is hidden by drafts, and a hidden folder takes its contents with it");
  });

  it("previews a typed rule and answers why a path is hidden", () => {
    const preview: HiddenReport = {
      root: "C:/repo",
      capped: false,
      rules: [],
      extra: { pattern: "**/*.snap", layer: "project", hides: { files: 0, folders: 5 }, samples: ["a", "b", "c"] },
    };
    expect(draw({ typed: "**/*.snap", preview })).toContain("would hide 5 folders: a, b, c, +2");
    const why = draw({ asked: "packages/cli/dist/cli.js", answer: { hidden: true, rule: "**/dist", layer: "built in", via: "packages/cli/dist" } });
    expect(why).toContain('hidden by <code class="hid-code">**/dist</code>, built in, in Build output: its folder <code class="hid-code">packages/cli/dist</code> matches');
    expect(draw({ asked: "src/a.ts", answer: { hidden: false } })).toContain("not hidden");
  });

  it("says while it is still reading", () => {
    expect(draw({ report: null })).toContain("reading the tree…");
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
    expect(renderToStaticMarkup(whySentence({ hidden: false, rule: "!system", layer: "you" }))).toContain("just you, puts it back");
  });
});
