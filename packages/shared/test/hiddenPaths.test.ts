/**
 * What the Files tree leaves out (`hiddenPaths.ts`).
 *
 * The behaviours here are the ones the constant this replaced got wrong: it named directories that
 * had moved, it only ever compared against the top level, and there was no way to find out either
 * from inside the app. So the tests are about the RULES being visible and answerable — what a
 * default hides, what a nested path does, and which of two rules wins.
 */
import { describe, expect, it } from "vitest";
import {
  compileHidden,
  decidingRule,
  DEFAULT_HIDDEN_PATHS,
  HIDDEN_PATH_GROUPS,
  HiddenTally,
  hiddenGroupOf,
  hiddenRules,
  isHiddenPath,
  layeredHiddenRules,
  SYSTEM_DIR_NAME,
  whyHiddenPath,
  type HiddenRule,
} from "../src/hiddenPaths";

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

  it("is its groups, flattened, and every default is in exactly one", () => {
    expect(DEFAULT_HIDDEN_PATHS).toEqual(HIDDEN_PATH_GROUPS.flatMap((group) => group.patterns));
    expect(new Set(DEFAULT_HIDDEN_PATHS).size).toBe(DEFAULT_HIDDEN_PATHS.length);
    expect(HIDDEN_PATH_GROUPS.map((group) => group.name)).toEqual(["JaiRA's own files", "Secrets", "Version control", "Dependencies", "Build output"]);
    expect(hiddenGroupOf("**/dist")?.name).toBe("Build output");
    expect(hiddenGroupOf("personal-settings.json")?.id).toBe("jaira");
    expect(hiddenGroupOf("drafts")).toBeUndefined();
  });

  it("no longer hides a folder called build", () => {
    // It hid six folders in this repository, every one a workflow state named `build` under
    // `.jaira/system/snapshots` — already hidden, and not build output.
    expect(DEFAULT_HIDDEN_PATHS).not.toContain("**/build");
    expect(isHiddenPath("packages/app/build", compileHidden(hiddenRules()))).toBe(false);
  });
});

describe("layering", () => {
  it("takes the defaults when the shared list says nothing", () => {
    expect(hiddenRules(undefined)).toEqual([...DEFAULT_HIDDEN_PATHS]);
  });

  it("reads an empty list as nothing to add, the same as an absent one", () => {
    // The layers CONCATENATE now: `[]` used to mean "show me everything", and a layer that wants
    // that says it the way it says anything else — a `!` for each thing to put back.
    expect(hiddenRules([])).toEqual([...DEFAULT_HIDDEN_PATHS]);
    expect(hides(hiddenRules([]), "system")).toBe(true);
    expect(hides(hiddenRules(["!system"]), "system")).toBe(false);
  });

  it("applies the defaults, then each layer's list, the personal one last", () => {
    expect(hiddenRules(["a"])).toEqual([...DEFAULT_HIDDEN_PATHS, "a"]);
    expect(layeredHiddenRules({ project: ["a"], you: ["b"] }).map((rule) => rule.pattern)).toEqual([...DEFAULT_HIDDEN_PATHS, "a", "b"]);
  });

  it("drops blank entries and a bare `!`, which would otherwise read as a rule", () => {
    expect(hiddenRules(["  ", "drafts  ", "!", ""])).toEqual([...DEFAULT_HIDDEN_PATHS, "drafts"]);
  });

  it("names each rule's layer, weakest first", () => {
    const rules = layeredHiddenRules({ you: ["!system"], base: ["drafts"], project: ["**/*.log"] });
    expect(rules.slice(DEFAULT_HIDDEN_PATHS.length)).toEqual([
      { pattern: "drafts", layer: "base" },
      { pattern: "**/*.log", layer: "project" },
      { pattern: "!system", layer: "you" },
    ]);
    expect(rules.slice(0, DEFAULT_HIDDEN_PATHS.length).every((rule) => rule.layer === "built in")).toBe(true);
  });
});

describe("last match wins", () => {
  it("lets a personal `!system` reveal what the shared list hid", () => {
    const rules = layeredHiddenRules({ you: [`!${SYSTEM_DIR_NAME}`] }).map((rule) => rule.pattern);
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

describe("which rule decides", () => {
  const rules = (base: string[] = [], project: string[] = [], you: string[] = []): HiddenRule[] => layeredHiddenRules({ base, project, you });

  it("is the last rule that matches", () => {
    const compiled = compileHidden(["drafts", "!drafts", "drafts/secret"]);
    expect(decidingRule("drafts", compiled)).toBe(1);
    expect(decidingRule("drafts/secret/x", compiled)).toBe(2);
    expect(decidingRule("other", compiled)).toBe(-1);
  });

  it("says why a path is hidden, and through which folder", () => {
    const verdict = whyHiddenPath("packages/cli/dist/index.js", rules());
    expect(verdict).toEqual({ hidden: true, rule: "**/dist", layer: "built in", via: "packages/cli/dist" });
    // A path matched itself has no `via`.
    expect(whyHiddenPath(".env", rules())).toEqual({ hidden: true, rule: "**/.env", layer: "built in" });
  });

  it("answers top-down, the way the walk decides", () => {
    // `!system/logs` reads as putting the logs back and does not: `system` took them with it.
    const verdict = whyHiddenPath("system/logs/app.log", rules([], ["!system/logs"]));
    expect(verdict).toMatchObject({ hidden: true, rule: "system", via: "system" });
    // Asked of the path alone, the answer is the misleading one.
    expect(isHiddenPath("system/logs/app.log", compileHidden(hiddenRules(["!system/logs"])))).toBe(false);
  });

  it("names the rule that put a path back, and the layer that wrote it", () => {
    expect(whyHiddenPath("system/jaira.db", rules([], [], ["!system"]))).toEqual({ hidden: false, rule: "!system", layer: "you" });
    expect(whyHiddenPath("workflows/plan.json", rules())).toEqual({ hidden: false });
    expect(whyHiddenPath("", rules())).toEqual({ hidden: false });
  });

  it("takes a backslashed path", () => {
    expect(whyHiddenPath("functions\\node_modules\\x", rules())).toMatchObject({ hidden: true, via: "functions/node_modules" });
  });
});

/**
 * A walk over an in-memory tree, the way `hiddenReport.ts` walks a disk: breadth first, into what is
 * shown, then inside JaiRA's own hidden folders.
 */
type Tree = { [name: string]: Tree | null };
function walk(tree: Tree, rules: HiddenRule[]): ReturnType<HiddenTally["report"]> {
  const tally = new HiddenTally(rules);
  const queue: Array<{ node: Tree; rel: string; counted: ReadonlySet<number> }> = [{ node: tree, rel: "", counted: new Set() }];
  const own: Array<{ node: Tree; rel: string; folder: string; above: ReadonlySet<number> }> = [];
  for (let at = 0; at < queue.length; at++) {
    const { node, rel, counted } = queue[at]!;
    for (const [name, child] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
      const path = rel.length === 0 ? name : `${rel}/${name}`;
      const seen = tally.visit(path, child !== null, counted);
      if (seen.descend && child !== null) queue.push({ node: child, rel: path, counted: seen.counted });
      if (seen.own && child !== null) own.push({ node: child, rel: path, folder: path, above: new Set() });
    }
  }
  for (let at = 0; at < own.length; at++) {
    const { node, rel, folder, above } = own[at]!;
    for (const [name, child] of Object.entries(node)) {
      const path = `${rel}/${name}`;
      const next = tally.inside(path, folder, above);
      if (child !== null) own.push({ node: child, rel: path, folder, above: next });
    }
  }
  return tally.report();
}

describe("attribution", () => {
  // A checkout: its own `.jaira/` with generated state under `system/`, two packages with build
  // output, dependencies at two depths, and a secret.
  const tree: Tree = {
    ".env": null,
    ".git": { HEAD: null, objects: { ab: null } },
    ".jaira": {
      "settings.json": null,
      workflows: { "plan.json": null },
      system: { snapshots: { s1: { build: { "state.json": null } }, s2: { build: null } }, "jaira.db": null },
    },
    node_modules: { react: { "index.js": null } },
    packages: {
      app: { dist: { "main.js": null }, src: { "a.ts": null }, node_modules: { x: null } },
      cli: { dist: { "cli.js": null }, "notes.log": null },
    },
    "README.md": null,
  };
  const report = (layers: Parameters<typeof layeredHiddenRules>[0] = {}) => {
    const out = walk(tree, layeredHiddenRules(layers));
    return (pattern: string, layer?: string) => out.find((r) => r.pattern === pattern && (layer === undefined || r.layer === layer))!;
  };

  it("counts a hidden folder once, and nothing under it", () => {
    const of = report();
    expect(of("**/dist").hides).toEqual({ files: 0, folders: 2 });
    expect(of("**/dist").samples).toEqual(["packages/app/dist", "packages/cli/dist"]);
    // Shallowest first: the walk is breadth first.
    expect(of("**/node_modules").hides).toEqual({ files: 0, folders: 2 });
    expect(of("**/node_modules").samples).toEqual(["node_modules", "packages/app/node_modules"]);
    expect(of(".git").hides).toEqual({ files: 0, folders: 1 });
    expect(of("**/.env").hides).toEqual({ files: 1, folders: 0 });
    expect(of(".jaira/system").hides).toEqual({ files: 0, folders: 1 });
    expect(of(".jaira/settings.json").hides).toEqual({ files: 1, folders: 0 });
    expect(of("**/target").hides).toEqual({ files: 0, folders: 0 });
  });

  it("gives a path to the LAST rule that matches it", () => {
    // The project states `packages/cli` after the defaults, so the folder is its — and `**/dist`
    // under it is never reached.
    const of = report({ project: ["packages/cli"] });
    expect(of("packages/cli").hides).toEqual({ files: 0, folders: 1 });
    expect(of("**/dist").hides).toEqual({ files: 0, folders: 1 });
    expect(of("**/dist").samples).toEqual(["packages/app/dist"]);
    // Restating a default moves the attribution to the later copy.
    const again = report({ base: ["**/dist"] });
    expect(again("**/dist", "built in").hides.folders).toBe(0);
    expect(again("**/dist", "base").hides.folders).toBe(2);
  });

  it("counts what a `!` puts back, top-most", () => {
    const of = report({ you: ["!**/dist"] });
    expect(of("!**/dist").hides).toEqual({ files: 0, folders: 2 });
    expect(of("**/dist").hides).toEqual({ files: 0, folders: 0 });
    // A `!` for something nothing hid puts nothing back...
    expect(report({ you: ["!README.md"] })("!README.md").hides).toEqual({ files: 0, folders: 0 });
    // ...and a `!` for a folder puts back EVERYTHING inside it an earlier rule hid, because a rule
    // carries its subtree: `!packages` brings back both `dist`s and a `node_modules`.
    expect(report({ you: ["!packages"] })("!packages").hides).toEqual({ files: 0, folders: 3 });
  });

  it("notes a rule whose only matches are inside JaiRA's own hidden folder", () => {
    // The `**/build` story: two workflow states named build, both under `.jaira/system`.
    const of = report({ project: ["**/build"] });
    expect(of("**/build").hides).toEqual({ files: 0, folders: 0 });
    expect(of("**/build").inside).toEqual({ folders: [".jaira/system"], count: 2 });
    expect(of("**/dist").inside).toBeUndefined();
  });
});
