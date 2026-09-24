/**
 * The one-shot rename of a layer's `toolsets/` to `permission-sets/` (the person's ruling, 2026-09-23:
 * toolsets are PERMISSION SETS, "rename everywhere"), run on every open until there is nothing left to
 * move — and BEFORE the settings migration, which reads the permission sets it writes into.
 *
 * Per layer root — the shared root, and the project's `.jaira/` when it is not the shared root — it:
 *
 *  - moves `toolsets/` to `permission-sets/`, whole when there is no `permission-sets/` yet, and file by
 *    file into one that exists (a file already at the new place is kept, and the old one reported and
 *    left where it is, so nothing is overwritten);
 *  - rewrites every reference that names the old directory — `$/toolsets/…`, `$BASE/toolsets/…`,
 *    `$SYSTEM/toolsets/…` — in the layer's workflows, functions, prompts and `settings.json`.
 *
 * A frozen snapshot is not touched: a permission set is lowered into the state when the snapshot is
 * taken, and the old path it names there is provenance, not a reference anything resolves.
 *
 * Every file changed in place is copied first under the layer's `system/logs/permission-set-rename-<stamp>/`
 * with a report. A layer with nothing to move is not touched, which is what makes it idempotent. Once
 * every checkout has opened, this module and its call in `project.ts` go (the standing rule: migrate the
 * data, then delete the reader of the old form).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "@declarative-ai/log";
import type { JairaPaths } from "@jaira/shared";

const log = createLogger("jaira.persistence.permission-set-rename");

const OLD_DIR = "toolsets";
const NEW_DIR = "permission-sets";
/** A reference to the old directory through any root variable: `$/toolsets/`, `$BASE/toolsets/`, … */
const OLD_REFERENCE = /(\$[A-Z_]*)\/toolsets\//g;
/** The authored folders a reference can sit in, and the text files it can sit in. */
const AUTHORED = ["workflows", "functions", "prompts", "skills"];
const TEXT = /\.(json|ya?ml|md|txt|ts|mts|js|mjs)$/i;

export interface PermissionSetRenameReport {
  root: string;
  lines: string[];
  written: string[];
  keptAt?: string;
}

/** Rename the old directory, and the references to it, in every layer root of `paths`. */
export function renamePermissionSetLayers(paths: JairaPaths, options: { dryRun?: boolean; now?: () => number } = {}): PermissionSetRenameReport[] {
  const roots = [...new Set([paths.base.baseDir, paths.jairaDir])];
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const reports: PermissionSetRenameReport[] = [];
  for (const root of roots) {
    const report = renameIn(root, options.dryRun === true, stamp);
    if (report !== undefined) reports.push(report);
  }
  return reports;
}

function renameIn(root: string, dryRun: boolean, stamp: string): PermissionSetRenameReport | undefined {
  if (!existsSync(root)) return undefined;
  const lines: string[] = [];
  const written: string[] = [];
  const keptAt = join(root, "system", "logs", `permission-set-rename-${stamp}`);
  const keep = (file: string): void => {
    const copy = join(keptAt, "originals", relative(root, file));
    if (existsSync(copy)) return;
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(file, copy);
  };

  // 1. the directory
  const oldDir = join(root, OLD_DIR);
  const newDir = join(root, NEW_DIR);
  if (existsSync(oldDir) && statSync(oldDir).isDirectory()) {
    if (!existsSync(newDir)) {
      if (!dryRun) renameSync(oldDir, newDir);
      lines.push(`${OLD_DIR}/ became ${NEW_DIR}/.`);
      written.push(newDir);
    } else {
      for (const file of filesUnder(oldDir)) {
        const inside = relative(oldDir, file);
        const target = join(newDir, inside);
        if (existsSync(target)) {
          lines.push(`${OLD_DIR}/${inside} was NOT moved: ${NEW_DIR}/${inside} is already there. The old file is left where it is.`);
          continue;
        }
        if (!dryRun) {
          mkdirSync(dirname(target), { recursive: true });
          renameSync(file, target);
        }
        lines.push(`${OLD_DIR}/${inside} moved into ${NEW_DIR}/.`);
        written.push(target);
      }
      if (!dryRun) removeEmptyDirs(oldDir);
    }
  }

  // 2. the references
  const files = [join(root, "settings.json"), ...AUTHORED.flatMap((dir) => (existsSync(join(root, dir)) ? filesUnder(join(root, dir)) : []))];
  for (const file of files) {
    if (!existsSync(file) || !TEXT.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!OLD_REFERENCE.test(text)) continue;
    OLD_REFERENCE.lastIndex = 0;
    const count = (text.match(OLD_REFERENCE) ?? []).length;
    if (!dryRun) {
      keep(file);
      writeFileSync(file, text.replace(OLD_REFERENCE, `$1/${NEW_DIR}/`), "utf8");
    }
    lines.push(`${relative(root, file)}: ${count} reference${count === 1 ? "" : "s"} to ${OLD_DIR}/ now name ${NEW_DIR}/.`);
    written.push(file);
  }

  if (lines.length === 0) return undefined;
  const report: PermissionSetRenameReport = { root, lines, written };
  if (!dryRun) {
    mkdirSync(keptAt, { recursive: true });
    writeFileSync(join(keptAt, "report.txt"), [`permission set rename in ${root}, ${stamp}`, "", ...lines.map((line) => `- ${line}`), ""].join("\n"), "utf8");
    report.keptAt = keptAt;
    for (const line of lines) log.info(`${root}: ${line}`);
  }
  return report;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Remove what the move emptied, deepest first; a folder that still holds a file is left. */
function removeEmptyDirs(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
