/**
 * The one filesystem walk behind the Files tree section's rule list (`files:hiddenReport`).
 *
 * The rule of attribution — the last matching rule decides, a hidden folder is counted once and not
 * entered — is `HiddenTally`'s, in shared, where it is tested on paths. What is here is only what
 * needs a disk: reading directories, breadth first, so the samples a rule shows are the shallowest
 * it has (`packages/cli/dist` rather than something four levels into it), and stopping.
 *
 * It stops on a BUDGET, time and entries both, because the question is asked while somebody types
 * (the add line's preview) and a checkout can hold a million files. A capped report says so, and the
 * section says "at least" — a count that is honest about being partial is still an answer, and one
 * that blocks the settings page until a monorepo is walked is not.
 *
 * After the tree a person can see, it looks INSIDE the folders JaiRA's own group hides
 * (`HiddenTally.inside`) with whatever budget is left: a rule whose every match is a workflow state's
 * snapshot is a rule that reads "hides nothing", and that is worth being able to say why.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HiddenTally, type HiddenReport, type HiddenRule } from "@jaira/shared";

export interface HiddenWalkOptions {
  /** A rule to preview, appended after every other and reported apart. */
  extra?: HiddenRule;
  /** Wall-clock budget for the whole walk. */
  budgetMs?: number;
  /** Entry budget for the whole walk. */
  maxEntries?: number;
  now?: () => number;
}

const BUDGET_MS = 1500;
const MAX_ENTRIES = 60_000;

interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return []; // unreadable is empty, as the tree itself treats it
  }
}

/**
 * Is this entry a folder? A link is followed only to ANSWER that — a junction to a `node_modules` is
 * a folder a rule hides — and never walked through, which is what the tree does too.
 */
async function isFolder(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(dir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/** Walk `root` once and say what each rule does there. */
export async function walkHiddenReport(root: string, rules: readonly HiddenRule[], options: HiddenWalkOptions = {}): Promise<HiddenReport> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? BUDGET_MS);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const all = options.extra !== undefined ? [...rules, options.extra] : [...rules];
  const tally = new HiddenTally(all);
  let entries = 0;
  let capped = false;
  const over = (): boolean => entries >= maxEntries || now() >= deadline;

  // The tree a person sees, breadth first.
  const queue: Array<{ dir: string; rel: string; counted: ReadonlySet<number> }> = [{ dir: root, rel: "", counted: new Set() }];
  const own: Array<{ dir: string; rel: string; folder: string; above: ReadonlySet<number> }> = [];
  walk: for (let at = 0; at < queue.length; at++) {
    const { dir, rel, counted } = queue[at]!;
    for (const entry of await entriesOf(dir)) {
      if (over()) {
        capped = true;
        break walk;
      }
      entries += 1;
      const path = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      const folder = await isFolder(dir, entry);
      const seen = tally.visit(path, folder, counted);
      if (seen.descend && entry.isDirectory()) queue.push({ dir: join(dir, entry.name), rel: path, counted: seen.counted });
      if (seen.own && entry.isDirectory()) own.push({ dir: join(dir, entry.name), rel: path, folder: path, above: new Set() });
    }
  }

  // Inside JaiRA's own hidden folders, with what is left — see the header. Running out here caps only
  // the `inside` notes, never the counts the section reads as "what this rule hides".
  if (!capped) {
    inside: for (let at = 0; at < own.length; at++) {
      const { dir, rel, folder, above } = own[at]!;
      for (const entry of await entriesOf(dir)) {
        if (over()) break inside;
        entries += 1;
        const path = `${rel}/${entry.name}`;
        const next = tally.inside(path, folder, above);
        if (entry.isDirectory()) own.push({ dir: join(dir, entry.name), rel: path, folder, above: next });
      }
    }
  }

  const reported = tally.report();
  return {
    root,
    rules: options.extra !== undefined ? reported.slice(0, -1) : reported,
    ...(options.extra !== undefined ? { extra: reported[reported.length - 1]! } : {}),
    capped,
  };
}
