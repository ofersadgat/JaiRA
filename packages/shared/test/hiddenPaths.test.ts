/**
 * What the Files tree leaves out (`hiddenPaths.ts`).
 *
 * The behaviours here are the ones the constant this replaced got wrong: it named directories that
 * had moved, it only ever compared against the top level, and there was no way to find out either
 * from inside the app. So the tests are about the RULES being visible and answerable — what a
 * default hides, what a nested path does, and which of two rules wins.
 */
import { describe, expect, it } from "vitest";
import { compileHidden, DEFAULT_HIDDEN_PATHS, hiddenRules, isHiddenPath, SYSTEM_DIR_NAME } from "../src/hiddenPaths";

const hides = (patterns: readonly string[], path: string): boolean => isHiddenPath(path, compileHidden(patterns));

describe("the defaults", () => {
  it("hides the whole of JaiRA's own directory and nothing a person authors", () => {
    const rules = compileHidden(hiddenRules(undefined));
    for (const path of ["system", "system/jaira.db", "system/journal/t-1/journal.jsonl", "system/tasks"]) {
      expect(isHiddenPath(path, rules)).toBe(true);
    }
    for (const path of ["workflows", "workflows/feature/plan.json", "prompts", "skills", "functions"]) {
      expect(isHiddenPath(path, rules)).toBe(false);
    }
  });

  it("hides the three JSON files at the root, and only at the root", () => {
    const rules = compileHidden(hiddenRules(undefined));
    for (const path of ["settings.json", "user-settings.json", "sync.json"]) {
      expect(isHiddenPath(path, rules)).toBe(true);
    }
    // A bare name matches from the root, so a file somebody authored deeper keeps its row. Hiding
    // every `settings.json` anywhere would take a workflow's own fixtures with it.
    expect(isHiddenPath("workflows/settings.json", rules)).toBe(false);
    expect(isHiddenPath("prompts/sync.json", rules)).toBe(false);
  });

  it("hides node_modules wherever it sits, not only at the top", () => {
    // The hole the old top-level comparison had: `functions/` is TypeScript, so a root's
    // dependencies are normally one level down, and that is exactly the case it never matched.
    const rules = compileHidden(hiddenRules(undefined));
    expect(isHiddenPath("node_modules", rules)).toBe(true);
    expect(isHiddenPath("functions/node_modules", rules)).toBe(true);
    expect(isHiddenPath("functions/deep/node_modules", rules)).toBe(true);
    // Not a directory somebody named after it.
    expect(isHiddenPath("functions/node_modules_notes.md", rules)).toBe(false);
  });

  it("names `system` once, so the constant and the default cannot drift apart", () => {
    expect(DEFAULT_HIDDEN_PATHS).toContain(SYSTEM_DIR_NAME);
  });
});

describe("layering", () => {
  it("takes the defaults when the shared list says nothing", () => {
    expect(hiddenRules(undefined)).toEqual([...DEFAULT_HIDDEN_PATHS]);
  });

  it("treats an explicitly empty list as a statement, not as silence", () => {
    // The distinction the whole `string[] | undefined` shape exists for: absent means "no opinion,
    // use the defaults", and `[]` means "show me everything" — including `system/`.
    expect(hiddenRules([])).toEqual([]);
    expect(hides(hiddenRules([]), "system")).toBe(false);
  });

  it("applies the personal list after the shared one", () => {
    expect(hiddenRules(["a"], ["b"])).toEqual(["a", "b"]);
  });

  it("drops blank entries and a bare `!`, which would otherwise read as a rule", () => {
    expect(hiddenRules(["  ", "drafts  "], ["!", ""])).toEqual(["drafts"]);
  });
});

describe("last match wins", () => {
  it("lets a personal `!system` reveal what the shared list hid", () => {
    const rules = hiddenRules(undefined, [`!${SYSTEM_DIR_NAME}`]);
    expect(hides(rules, "system")).toBe(false);
    // And only for the person who asked: the shared list is untouched by the reveal.
    expect(hides(hiddenRules(undefined), "system")).toBe(true);
  });

  it("lets a later pattern hide again what an earlier one revealed", () => {
    expect(hides(["drafts/**", "!drafts/keep", "drafts/keep/secret"], "drafts/keep")).toBe(false);
    expect(hides(["drafts/**", "!drafts/keep", "drafts/keep/secret"], "drafts/keep/secret")).toBe(true);
  });

  it("shows anything no rule mentions", () => {
    // The opposite default from a permission scope, and deliberately: this filters a directory a
    // person already has open, so "hidden unless listed" would draw an empty root.
    expect(hides(["system"], "workflows/plan.json")).toBe(false);
    expect(hides([], "anything")).toBe(false);
  });
});

describe("patterns", () => {
  it("does not let a single star cross a directory boundary", () => {
    expect(hides(["*.md"], "notes.md")).toBe(true);
    expect(hides(["*.md"], "docs/notes.md")).toBe(false);
    expect(hides(["**/*.md"], "docs/notes.md")).toBe(true);
  });

  it("matches a path however the caller spelled it", () => {
    // Windows walks hand back backslashes, and a rule that worked on one platform only would read
    // as the tree being broken rather than as the rule being wrong.
    expect(hides(["system"], "system")).toBe(true);
    expect(hides(["drafts/old"], "drafts\\old")).toBe(true);
    expect(hides(["./drafts"], "drafts")).toBe(true);
  });

  it("ignores case, because the filesystems this runs on disagree about it", () => {
    expect(hides(["system"], "System")).toBe(true);
  });
});
