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
 *  - **Order matters, and the LAST match wins.** That is what makes a second list an override
 *    rather than an argument: a personal `!system` reveals what a shared list hid, and a personal
 *    `drafts/**` hides something no one else wanted hidden. Nothing else in configuration layers
 *    this way — arrays elsewhere replace — but nothing else in configuration is a list of rules
 *    whose whole purpose is to be narrowed by the next reader.
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
import { SETTINGS_FILE_NAME, USER_SETTINGS_FILE_NAME } from "./settings";

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

/**
 * What is hidden when nobody has said otherwise.
 *
 * The list has to work over two differently-shaped roots, and that is why several things are named
 * twice. A project's tree is rooted at the CHECKOUT, so JaiRA's own directories sit under `.jaira/`;
 * the shared root IS a `.jaira`, so the same directories sit at its top. Naming both is duller than
 * a clever glob and says exactly what it does — `**\/system` would also hide a `system/` folder
 * somebody wrote in their own source, which is a surprising thing for a file tree to do.
 *
 * Four groups, each for its own reason:
 *
 *  - **JaiRA's own state.** `system/` holds the database, tasks, snapshots, logs and artifacts.
 *    Nobody authors a line of it.
 *  - **Configuration with a screen of its own.** `settings.json` and the rest are live and are
 *    edited by something that knows the shape of what is in them. Un-hide one if you would rather
 *    edit the document.
 *  - **Secrets.** `.env` and its variants are the secret chain (DESIGN §8.1). A tree is a thing
 *    people screen-share; a key does not belong in one by default.
 *  - **Version control, dependencies and build output.** `.git` alone is tens of thousands of
 *    entries, and none of the rest is anything a person edits. The names match what `@`-completion
 *    already skips, so the two surfaces have one opinion about what a project's files are.
 *
 * The dot rule that used to sit above all of this — skip anything starting with `.` — is gone, and
 * had to be: a checkout-rooted tree that skipped dot-entries could not draw `.jaira/` itself. What
 * replaced it is this list, which is the difference between a rule you can read and one you cannot.
 */
export const DEFAULT_HIDDEN_PATHS: readonly string[] = [
  // JaiRA's own generated state, in both root shapes.
  SYSTEM_DIR_NAME,
  `${JAIRA_DIR_NAME}/${SYSTEM_DIR_NAME}`,
  // Configuration, each of which has a screen.
  SETTINGS_FILE_NAME,
  `${JAIRA_DIR_NAME}/${SETTINGS_FILE_NAME}`,
  USER_SETTINGS_FILE_NAME,
  "sync.json",
  "approvals.local.json",
  // Secrets, anywhere.
  "**/.env",
  "**/.env.*",
  // Version control, dependencies, build output.
  ".git",
  "**/node_modules",
  "**/dist",
  "**/build",
  "**/out",
  "**/target",
  "**/vendor",
  "**/coverage",
  "**/__pycache__",
];

/**
 * The rules in the order they are applied: shared first, personal last.
 *
 * `shared` absent means {@link DEFAULT_HIDDEN_PATHS} rather than nothing — an absent key is
 * "I have no opinion", and the opinion a fresh install needs is the default. An explicitly empty
 * array is therefore a real statement and a different one: *show me everything*, which a person who
 * writes `[]` has unambiguously asked for and used to have no way to say.
 */
export function hiddenRules(shared: readonly string[] | undefined, personal: readonly string[] = []): string[] {
  return [...(shared ?? DEFAULT_HIDDEN_PATHS), ...personal].map((p) => p.trim()).filter((p) => p.length > 0 && p !== "!");
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
