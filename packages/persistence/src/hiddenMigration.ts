/**
 * The one-shot rewrite of `files.hidden` from a list that REPLACED what was under it into a list of
 * what the layer ADDS (2026-09-23) — run on every open until there is nothing left to rewrite.
 *
 * The meaning changed under the key. A layer's list used to replace the defaults (the shared root's)
 * or the shared root's list (a project's), which is why the Files page wrote the whole default list
 * out the moment anybody added one pattern. Now the layers concatenate — defaults, shared root,
 * project, the person — and last match wins (`hiddenPaths.ts`). A list written for the old meaning,
 * read under the new one, hides everything under it AS WELL, so a layer that had switched a default
 * off would quietly switch it back on. So each old list is rewritten into its additions:
 *
 *  - the rules it restated at its head, which are now under it anyway, are dropped;
 *  - every rule under it that it LEFT OUT — which it used to switch off by leaving out — becomes
 *    `!rule`, which is how a layer switches one off now;
 *  - everything after its head is kept in place, in order, because order is the semantics.
 *
 * "Under it" is the defaults for the shared root's list, and the defaults followed by the shared
 * root's (rewritten) list for a project's, which is what a project's list used to replace.
 *
 * ## Which lists are old
 *
 * The key did not change, so the FORM has to say. A list is taken for the old form when it is empty
 * (`[]` meant *show everything*; as additions it would mean nothing), or when it restates at least
 * half of the defaults at its head and puts none of them back with a `!`. Every list the old Files
 * page wrote began with the defaults it showed, and a list written as additions has no reason to
 * restate a default it already inherits — let alone half of them. That is also what makes this
 * idempotent: a rewritten list restates no default at its head, and if it left one out it says so
 * with a `!`.
 *
 * What it cannot tell is a hand-written old list that named fewer than half the defaults — `["drafts"]`
 * meaning "only drafts". It is left as it is, and now hides the defaults as well: more than it used to,
 * never less. The rewrite is exact except where a kept default and a left-out one match the same path
 * (a `node_modules` inside a `dist`); there the left-out one decides.
 *
 * Once every checkout has opened, this module and its calls in `project.ts` go (the standing rule:
 * migrate the data, then delete the reader of the old form).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "@declarative-ai/log";
import { DEFAULT_HIDDEN_PATHS, readJsonFile, type JairaPaths } from "@jaira/shared";

const log = createLogger("jaira.persistence.hidden-migration");

/**
 * The defaults as they stood while a layer's list replaced them — what an old list was written
 * against. Frozen here, because the live list has moved on (`**\/build` left it, and
 * `personal-settings.json` joined it) and a rewrite must know what the person was looking at.
 */
const OLD_DEFAULTS: readonly string[] = [
  "system",
  ".jaira/system",
  "settings.json",
  ".jaira/settings.json",
  "user-settings.json",
  "sync.json",
  "**/.env",
  "**/.env.*",
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

/** The defaults both lists share — what an old list could restate and still mean today. */
const CARRIED = DEFAULT_HIDDEN_PATHS.filter((pattern) => OLD_DEFAULTS.includes(pattern));

const clean = (list: readonly unknown[]): string[] =>
  list.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p.length > 0 && p !== "!");

/** The leading run of rules that hide — among which order cannot matter, since every one hides. */
function headOf(list: readonly string[]): string[] {
  const end = list.findIndex((p) => p.startsWith("!"));
  return end < 0 ? [...list] : list.slice(0, end);
}

/** Is this list written for the old meaning? See the header. */
export function isReplacingHiddenList(raw: readonly unknown[]): boolean {
  const list = clean(raw);
  if (raw.length === 0) return true;
  if (list.some((p) => p.startsWith("!") && CARRIED.includes(p.slice(1)))) return false;
  const head = new Set(headOf(list));
  return CARRIED.filter((pattern) => head.has(pattern)).length * 2 >= CARRIED.length;
}

/** The patterns `below` leaves hidden: those whose last word there is a hide rather than a `!`. */
function hiddenBy(below: readonly string[]): string[] {
  const last = new Map<string, boolean>();
  for (const rule of below) {
    const hide = !rule.startsWith("!");
    const pattern = hide ? rule : rule.slice(1);
    last.delete(pattern); // re-inserted, so the order is where each pattern last stood
    last.set(pattern, hide);
  }
  return [...last].filter(([, hide]) => hide).map(([pattern]) => pattern);
}

/**
 * An old list as the additions that mean the same thing laid over `below` — the rules under it
 * (see the header).
 */
export function hiddenAdditionsOf(raw: readonly unknown[], below: readonly string[]): string[] {
  const list = clean(raw);
  const head = headOf(list);
  const rest = list.slice(head.length);
  const under = hiddenBy(below);
  // A default the old list could not have known about is not something it left out.
  const off = under.filter((pattern) => !head.includes(pattern) && (OLD_DEFAULTS.includes(pattern) || !DEFAULT_HIDDEN_PATHS.includes(pattern)));
  const kept = [...new Set(head.filter((pattern) => !under.includes(pattern)))];
  return [...off.map((pattern) => `!${pattern}`), ...kept, ...rest];
}

/** What one layer's rewrite did. */
export interface HiddenMigrationReport {
  settingsFile: string;
  before: string[];
  after: string[];
  /** Where the original was kept. */
  keptAt: string;
}

function readDoc(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const doc = readJsonFile(file);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // the open reports a file that does not parse; this is not where that is said
  }
}

function listOf(doc: Record<string, unknown> | undefined): unknown[] | undefined {
  const files = doc?.["files"];
  if (files === null || typeof files !== "object" || Array.isArray(files)) return undefined;
  const hidden = (files as Record<string, unknown>)["hidden"];
  return Array.isArray(hidden) ? hidden : undefined;
}

/**
 * Rewrite every layer of `paths` whose `files.hidden` is still in the old form: the shared root
 * first, then the project (unless the project IS the shared root). Returns one report per layer
 * rewritten; an empty list means nothing was, and nothing was written.
 */
export function migrateHiddenLists(paths: JairaPaths, options: { now?: () => number } = {}): HiddenMigrationReport[] {
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const layers = [{ file: paths.base.settingsFile, systemDir: paths.base.systemDir }];
  if (paths.settingsFile !== paths.base.settingsFile) layers.push({ file: paths.settingsFile, systemDir: paths.systemDir });

  const reports: HiddenMigrationReport[] = [];
  let below: string[] = [...DEFAULT_HIDDEN_PATHS];
  for (const { file, systemDir } of layers) {
    const doc = readDoc(file);
    const list = listOf(doc);
    if (doc === undefined || list === undefined || !isReplacingHiddenList(list)) {
      below = [...below, ...clean(list ?? [])];
      continue;
    }
    const after = hiddenAdditionsOf(list, below);
    below = [...below, ...after];

    const next = structuredClone(doc);
    const files = next["files"] as Record<string, unknown>;
    if (after.length > 0) files["hidden"] = after;
    else delete files["hidden"];
    if (Object.keys(files).length === 0) delete next["files"];

    const keptAt = join(systemDir, "logs", `hidden-migration-${stamp}`);
    mkdirSync(keptAt, { recursive: true });
    copyFileSync(file, join(keptAt, basename(file)));
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    const before = clean(list);
    log.info(
      `${file}: files.hidden now ADDS to the rules under it rather than replacing them — ${JSON.stringify(before)} became ${JSON.stringify(after)}; the original is in ${keptAt}`,
    );
    reports.push({ settingsFile: file, before, after, keptAt });
  }
  return reports;
}
