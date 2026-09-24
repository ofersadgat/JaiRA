/**
 * What the Files tree does not draw.
 *
 * The tree walks the two layer roots and nothing else, so this is a small question with one loud
 * answer: `system/` is JaiRA's own directory, nobody authors a line of it, and a root that shows it
 * has buried three authored folders under a database. That single case is the reason the list
 * exists.
 *
 * It is a LIST rather than a constant because the one thing a hard-coded exclusion cannot do is be
 * wrong in public. The set it replaced named `snapshots`, `tasks`, `artifacts` and `worktrees`
 * individually; every one of those moved or was never spelled that way, so the set matched nothing
 * for months and the folder it was meant to hide showed anyway — with no surface anywhere that
 * could have said so. A list you can read, add to, and switch off is a list whose mistakes are
 * visible.
 *
 * ## The rules
 *
 *  - **A pattern is a glob**, matched against the path relative to the layer root — `/`-separated,
 *    no leading `./`. {@link globToRegExp} decides what it means, which is the same matcher a
 *    permission scope and a `glob` tool call use, so `**\/node_modules` cannot mean one thing in a
 *    policy and another here.
 *  - **A directory that matches takes its subtree with it.** The walk does not descend, so hiding
 *    `system` costs one comparison rather than one per journal file underneath it.
 *  - **Order matters, and the LAST match wins.** That is what makes a later list an override
 *    rather than an argument: a personal `!system` reveals what a shared list hid, and a personal
 *    `drafts/**` hides something no one else wanted hidden.
 *  - **The layers CONCATENATE.** The defaults below come first, then the shared root's
 *    `files.hidden`, then the project's, then the person's own — each layer's list is what it ADDS,
 *    never a replacement. Nothing else in configuration layers this way — arrays elsewhere replace
 *    (`mergeConfigDocuments`) — but nothing else in configuration is a list of rules whose whole
 *    purpose is to be narrowed by the next reader. Replacing is what it used to do, and it made a
 *    project that wanted one more folder hidden restate the twenty the defaults already named, or
 *    quietly show a database: a switch that puts one default back is `!pattern`, not a rewrite.
 *  - **`!` un-hides.** Bare `!` is not a pattern and is dropped, so a half-typed entry cannot
 *    silently reveal a root.
 *
 * ## Why a person can reveal `system/`
 *
 * Because "nobody should have to look at it" is not "nobody may". Reading the journal a run wrote
 * is a real thing to want at the moment a run has gone wrong, and the alternative to a checkbox is
 * a file manager — which is to say, leaving the app. The default hides it; the default is not a
 * lock.
 */
import { globToRegExp, normalizePath } from "./scopes";
// `./settings` imports nothing, so this is a leaf-ward edge and not a cycle — and naming the files
// by their constants is what keeps the default from going stale the way the last list did.
import { PERSONAL_SETTINGS_FILE_NAME, SETTINGS_FILE_NAME, USER_SETTINGS_FILE_NAME } from "./settings";

/**
 * The one subdirectory of a root that a person does not own.
 *
 * Everything JaiRA generates goes in it — the database, tasks, snapshots, logs, artifacts — and
 * nothing a person authors does. That is the whole rule, and it is worth a constant because four
 * separate things have to agree on the spelling: the path builders in `./paths`, the `.gitignore`
 * the layout writes, the `$SYSTEM` an artifact destination resolves, and the default below.
 *
 * It lives HERE rather than beside the path builders because this module is browser-safe and that
 * one is not: the Files screen offers a switch for this directory by name, and `./paths` imports
 * `node:fs`. `./paths` re-exports it, so nothing outside had to move.
 */
export const SYSTEM_DIR_NAME = "system";

/**
 * The directory a project keeps its JaiRA layer in.
 *
 * Here for the same reason {@link SYSTEM_DIR_NAME} is: a project's tree is rooted at the checkout,
 * so the defaults below have to name `.jaira/` — and `./paths`, where this used to live, imports
 * `node:fs` and cannot be reached from a renderer. `./paths` re-exports it, so nothing outside moved.
 */
export const JAIRA_DIR_NAME = ".jaira";


/** One named group of the defaults: what the Files tree section draws as a fold. */
export interface HiddenPathGroup {
  /** Stable, for a key and a test — never shown. */
  id: "jaira" | "secrets" | "vcs" | "dependencies" | "build";
  /** What the fold is called. */
  name: string;
  patterns: readonly string[];
}

/**
 * What is hidden when nobody has said otherwise, in the groups the Files tree section draws.
 *
 * The list has to work over two differently-shaped roots, and that is why several things are named
 * twice. A project's tree is rooted at the CHECKOUT, so JaiRA's own directories sit under `.jaira/`;
 * the shared root IS a `.jaira`, so the same directories sit at its top. Naming both is duller than
 * a clever glob and says exactly what it does — `**\/system` would also hide a `system/` folder
 * somebody wrote in their own source, which is a surprising thing for a file tree to do.
 *
 * Five groups, each for its own reason:
 *
 *  - **JaiRA's own files.** `system/` holds the database, tasks, snapshots, logs and artifacts —
 *    nobody authors a line of it — and the settings files are live and edited by something that
 *    knows the shape of what is in them. Put one back if you would rather edit the document.
 *  - **Secrets.** `.env` and its variants are the secret chain (DESIGN §8.1). A tree is a thing
 *    people screen-share; a key does not belong in one by default.
 *  - **Version control.** `.git` alone is tens of thousands of entries.
 *  - **Dependencies** and **build output.** Nothing a person edits. The names match what
 *    `@`-completion already skips, so the two surfaces have one opinion about what a project's files
 *    are.
 *
 * `**\/build` is not here, and was until 2026-09-23: asked what it hid in this repository, the answer
 * was six folders, and every one was a workflow state named `build` under `.jaira/system/snapshots`
 * — already hidden, and not build output. A default nobody can name a real catch for is a default
 * that will one day hide somebody's source.
 */
export const HIDDEN_PATH_GROUPS: readonly HiddenPathGroup[] = [
  {
    id: "jaira",
    name: "JaiRA's own files",
    patterns: [
      SYSTEM_DIR_NAME,
      `${JAIRA_DIR_NAME}/${SYSTEM_DIR_NAME}`,
      SETTINGS_FILE_NAME,
      `${JAIRA_DIR_NAME}/${SETTINGS_FILE_NAME}`,
      USER_SETTINGS_FILE_NAME,
      "sync.json",
      PERSONAL_SETTINGS_FILE_NAME,
    ],
  },
  { id: "secrets", name: "Secrets", patterns: ["**/.env", "**/.env.*"] },
  { id: "vcs", name: "Version control", patterns: [".git"] },
  { id: "dependencies", name: "Dependencies", patterns: ["**/node_modules", "**/vendor", "**/__pycache__"] },
  { id: "build", name: "Build output", patterns: ["**/dist", "**/out", "**/target", "**/coverage"] },
];

/**
 * Every default, in order — the groups flattened, so the list and its grouping cannot disagree.
 *
 * The order inside is immaterial (every default hides, so no default can undo another); what matters
 * is that the whole list comes FIRST, before any layer's own.
 */
export const DEFAULT_HIDDEN_PATHS: readonly string[] = HIDDEN_PATH_GROUPS.flatMap((group) => group.patterns);

/** The group a default belongs to, or `undefined` for a pattern no default spells exactly. */
export function hiddenGroupOf(pattern: string): HiddenPathGroup | undefined {
  return HIDDEN_PATH_GROUPS.find((group) => group.patterns.includes(pattern));
}

/**
 * Where a rule came from: what ships, or one of the layers that add to it.
 *
 * Its own vocabulary rather than `ConfigLayer`, because a default is not a layer anybody writes —
 * and the person's own layer is named `you` here whatever its file is called.
 */
export type HiddenRuleLayer = "built in" | "base" | "project" | "you";

/** One rule of the effective list, and the layer that states it. */
export interface HiddenRule {
  pattern: string;
  layer: HiddenRuleLayer;
}

/** The layers that add rules, weakest first — the order their lists are appended in. */
export const HIDDEN_RULE_LAYERS = ["base", "project", "you"] as const;

/** A list as written, cleaned: trimmed, and without blanks or a bare `!`, which would read as a rule. */
function cleanPatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).map((p) => p.trim()).filter((p) => p.length > 0 && p !== "!");
}

/**
 * The effective list, each rule with its layer: the defaults, then every layer's additions in
 * {@link HIDDEN_RULE_LAYERS} order.
 *
 * An absent layer and an empty one say the same thing — nothing to add — which is the one
 * difference from the list this replaced, where `[]` meant *show everything*. Showing everything is
 * now what it is in every other place: a `!` for each thing to put back.
 */
export function layeredHiddenRules(layers: Partial<Record<(typeof HIDDEN_RULE_LAYERS)[number], readonly string[] | undefined>>): HiddenRule[] {
  return [
    ...DEFAULT_HIDDEN_PATHS.map((pattern) => ({ pattern, layer: "built in" as const })),
    ...HIDDEN_RULE_LAYERS.flatMap((layer) => cleanPatterns(layers[layer]).map((pattern) => ({ pattern, layer }))),
  ];
}

/**
 * The rules in the order they are applied: the defaults, the configured layers, the personal list.
 *
 * `configured` is `config.files.hidden` as parsed — already the concatenation of the layers' lists
 * (`mergeConfigDocuments`) — so the defaults are put in front of it here and nowhere else.
 */
export function hiddenRules(configured?: readonly string[]): string[] {
  return layeredHiddenRules({ project: configured }).map((rule) => rule.pattern);
}
/** One compiled rule: what it matches, and whether matching it hides or reveals. */
interface Rule {
  match: RegExp;
  hide: boolean;
}

/**
 * Compile a rule list once, for a walk that will ask it thousands of times.
 *
 * A `RegExp` per pattern per directory entry is the shape this had before it was a list, and it was
 * affordable only because the list was five literals compared with `Set.has`. Compiled here, the
 * cost is per TREE rather than per file.
 *
 * Case-insensitive, matching {@link globToRegExp}'s own default reasoning: the two filesystems this
 * runs on disagree about case, and a rule that hides `System` on one machine and not the other is a
 * rule that reads as a bug in the tree.
 */
export function compileHidden(patterns: readonly string[]): Rule[] {
  return patterns.map((pattern) => {
    const hide = !pattern.startsWith("!");
    // `/**` appended, which {@link globToRegExp} reads as "this path OR anything under it" — so one
    // expression carries the subtree rule rather than every caller having to know it. The walk gets
    // the same answer by not descending, but a predicate that called `system` hidden and
    // `system/jaira.db` visible would be wrong for anyone who asked it about a path rather than
    // about a directory entry, and would be discovered by that person rather than here.
    return { match: globToRegExp(`${normalizePath(hide ? pattern : pattern.slice(1))}/**`, "i"), hide };
  });
}

/**
 * Is this path hidden?
 *
 * Last match wins, so a later `!` reveals and a later pattern re-hides. Unmatched is VISIBLE — the
 * opposite of the scope tables in `scopes.ts`, and deliberately: a scope table is a sandbox, where
 * what is not named is refused, whereas this is a filter over a directory a person already has open
 * on disk. Defaulting a file tree to "hidden unless listed" would show an empty root.
 */
export function isHiddenPath(relPath: string, rules: readonly Rule[]): boolean {
  const path = normalizePath(relPath);
  let hidden = false;
  for (const rule of rules) if (rule.match.test(path)) hidden = rule.hide;
  return hidden;
}

/** A compiled rule, for a caller that holds a list of them across calls. */
export type CompiledHiddenRule = Rule;

/**
 * Which rule decides this path — the index of the LAST that matches — or `-1` when none does.
 *
 * The question under {@link isHiddenPath}, asked separately because "hidden or not" is only half of
 * what a person wants to know. The other half is *by what*, and a rule list whose answer is a bare
 * boolean is the list this replaced.
 */
export function decidingRule(relPath: string, rules: readonly Rule[]): number {
  const path = normalizePath(relPath);
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.match.test(path)) return i;
  return -1;
}

/** Why a path is or is not in the tree — the answer to "Why is a path hidden?". */
export interface HiddenVerdict {
  hidden: boolean;
  /**
   * The rule that decided. For a hidden path, the rule that hid it (or hid the folder it is in); for
   * a visible one, the `!` rule that put it back, when one did — absent when no rule mentions it.
   */
  rule?: string;
  layer?: HiddenRuleLayer;
  /** The folder that matched, when the path is INSIDE a hidden folder rather than matched itself. */
  via?: string;
}

/**
 * Why a path is hidden, asked the way the walk asks it: top-down.
 *
 * The walk never descends into a hidden folder, so what decides a path deep in a tree is the first
 * ancestor that is hidden, not the path's own last match — `!system/logs` reads as putting the logs
 * back and does not, because `system` took them with it. Answering from the path alone would say
 * "shown" about a file nobody can find in the tree.
 */
export function whyHiddenPath(
  relPath: string,
  rules: readonly HiddenRule[],
  compiled: readonly Rule[] = compileHidden(rules.map((r) => r.pattern)),
): HiddenVerdict {
  const segments = normalizePath(relPath)
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return { hidden: false };
  for (let depth = 1; depth <= segments.length; depth++) {
    const at = segments.slice(0, depth).join("/");
    const index = decidingRule(at, compiled);
    if (index < 0 || !compiled[index]!.hide) continue;
    const rule = rules[index]!;
    return { hidden: true, rule: rule.pattern, layer: rule.layer, ...(depth < segments.length ? { via: at } : {}) };
  }
  const index = decidingRule(segments.join("/"), compiled);
  if (index < 0) return { hidden: false };
  const rule = rules[index]!;
  return { hidden: false, rule: rule.pattern, layer: rule.layer };
}

/** What one rule does to one root — a line of the Files tree section's rule list. */
export interface HiddenRuleReport {
  pattern: string;
  layer: HiddenRuleLayer;
  /**
   * What this rule DECIDES here, counted top-most: a hidden folder is one folder, and nothing under
   * it is counted again. For a `!` rule it is what it puts back — a path an earlier rule would have
   * hidden.
   */
  hides: { files: number; folders: number };
  /** The first few of those paths, relative to the root, shallowest first. At most three. */
  samples: string[];
  /**
   * Matches the rule has only INSIDE a folder JaiRA's own group already hides — `.jaira/system`, a
   * shared root's `system`. What makes "hides nothing" legible: a rule written for a workflow state
   * matches its snapshots and nothing a person can see.
   */
  inside?: { folders: string[]; count: number };
}

/** Every effective rule with what it does, from ONE walk of the root. */
export interface HiddenReport {
  /** The directory walked: the project's checkout, or the shared root with no project. */
  root: string;
  rules: HiddenRuleReport[];
  /** The preview rule the caller asked about, appended after every other — absent when none was. */
  extra?: HiddenRuleReport;
  /** The walk stopped at its time or entry budget, so every count is "at least". */
  capped: boolean;
}

/** How many sample paths a rule keeps. */
const SAMPLES = 3;

/**
 * The attribution half of a report: fed every entry a walk reaches, it says whether to go in, and
 * keeps the counts.
 *
 * Kept apart from the walk so the rule of attribution — the LAST matching rule decides, a hidden
 * folder is counted once and not entered — is tested on a list of paths rather than on a disk, and so
 * the one filesystem walk that feeds it can live where the filesystem is.
 */
export class HiddenTally {
  private readonly compiled: Rule[];
  private readonly counts: HiddenRuleReport[];
  /** Built-in rules of JaiRA's own group — a folder one of these hides is looked inside, see {@link inside}. */
  private readonly own: Set<number>;

  constructor(rules: readonly HiddenRule[]) {
    this.compiled = compileHidden(rules.map((rule) => rule.pattern));
    this.counts = rules.map((rule) => ({ pattern: rule.pattern, layer: rule.layer, hides: { files: 0, folders: 0 }, samples: [] }));
    const jaira = HIDDEN_PATH_GROUPS.find((group) => group.id === "jaira")?.patterns ?? [];
    this.own = new Set(rules.flatMap((rule, i) => (rule.layer === "built in" && jaira.includes(rule.pattern) ? [i] : [])));
  }

  /**
   * One entry the walk reached (its parent is shown). `counted` is the set of `!` rules an ancestor
   * was already counted for — so a folder put back is one folder, not one plus everything in it.
   *
   * Answers whether the walk goes in (`descend`, for a folder that is shown), the set to hand its
   * children, and whether the entry is a folder JaiRA's own group hid, which {@link inside} is then
   * asked about.
   */
  visit(
    relPath: string,
    isDir: boolean,
    counted: ReadonlySet<number> = new Set(),
  ): { descend: boolean; counted: ReadonlySet<number>; own: boolean } {
    const path = normalizePath(relPath);
    const index = decidingRule(path, this.compiled);
    if (index < 0) return { descend: isDir, counted, own: false };
    if (this.compiled[index]!.hide) {
      this.count(index, path, isDir);
      return { descend: false, counted, own: isDir && this.own.has(index) };
    }
    // A `!` rule decides it. It PUTS BACK only what an earlier rule would have hidden — the last
    // match before it is the verdict without it.
    let before = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (this.compiled[i]!.match.test(path)) {
        before = i;
        break;
      }
    }
    if (before < 0 || !this.compiled[before]!.hide || counted.has(index)) return { descend: isDir, counted, own: false };
    this.count(index, path, isDir);
    return { descend: isDir, counted: new Set([...counted, index]), own: false };
  }

  /**
   * An entry inside a folder JaiRA's own group hid (`folder`), which the tree never shows. Every
   * OTHER rule that matches it is noted as matching there — top-most, like {@link visit}: `above` is
   * the rules an ancestor inside the folder already matched. Returns the set for its children.
   */
  inside(relPath: string, folder: string, above: ReadonlySet<number> = new Set()): ReadonlySet<number> {
    const path = normalizePath(relPath);
    let next: Set<number> | undefined;
    for (let i = 0; i < this.compiled.length; i++) {
      if (above.has(i) || this.own.has(i) || !this.compiled[i]!.match.test(path)) continue;
      const entry = this.counts[i]!;
      const inside = (entry.inside ??= { folders: [], count: 0 });
      inside.count += 1;
      if (!inside.folders.includes(folder)) inside.folders.push(folder);
      (next ??= new Set(above)).add(i);
    }
    return next ?? above;
  }

  private count(index: number, path: string, isDir: boolean): void {
    const entry = this.counts[index]!;
    if (isDir) entry.hides.folders += 1;
    else entry.hides.files += 1;
    if (entry.samples.length < SAMPLES) entry.samples.push(path);
  }

  /** The counts so far, one per rule in order. */
  report(): HiddenRuleReport[] {
    return this.counts.map((entry) => ({
      ...entry,
      hides: { ...entry.hides },
      samples: [...entry.samples],
      ...(entry.inside !== undefined ? { inside: { folders: [...entry.inside.folders], count: entry.inside.count } } : {}),
    }));
  }
}
