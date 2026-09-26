/**
 * What a package manager runs when a shell line names a package script — read out of `package.json`,
 * the workspaces of npm, pnpm and yarn followed (decision 0007, amended 2026-09-26).
 *
 * `npm run lint` is judged by the lines its script runs, so a `"lint": "eslint ."` reads and a
 * `"lint": "eslint --fix ."` writes. `commandParts.ts` reads WHICH script a line asks for and in which
 * package (`packageScriptOf`); this finds the packages — the nearest, one found from a `--prefix`, or
 * the workspaces a line picks — and the lines each one runs. Reading is behind {@link PackageReader}:
 * the file system in the app, a table in a test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import picomatch from "picomatch";
import { globSync } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import { absolutize, isAbsolutePath } from "@jaira/shared";
import type { PackageScriptCall } from "./commandParts";

/** A `package.json`, as far as running its scripts goes. */
export interface PackageInfo {
  /** The directory it is in — where its scripts run. */
  dir: string;
  name?: string;
  /** Its string-valued scripts. */
  scripts: Record<string, string>;
  /** Its `workspaces` patterns (`["packages/*"]`), when it is a workspace root. */
  workspaces?: string[];
}

/** How a line's packages are read. */
export interface PackageReader {
  /** The `package.json` in exactly this directory, or `undefined` when there is none that parses. */
  at(dir: string): PackageInfo | undefined;
  /** The packages a workspace root's patterns name. */
  workspacesOf(root: PackageInfo): PackageInfo[];
}

/** One package a script runs in, and the lines it runs there, in order: `pre`, the script, `post`. */
export interface ScriptRun {
  dir: string;
  lines: string[];
}

/** A word as a POSIX shell would read it back: bare where it can be, single-quoted where it cannot. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** A place, spelled so two spellings of it compare equal: `/` separators, no trailing one, a drive letter's case ignored. */
function placeKey(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

const resolveFrom = (base: string, path: string): string => (isAbsolutePath(path) ? path : absolutize(path, base));

/** The nearest package at or above `dir` — the package `npm run` runs a script of. */
export function nearestPackage(reader: PackageReader, dir: string): PackageInfo | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const found = reader.at(at);
    if (found !== undefined) return found;
    if (dirname(at) === at) return undefined;
  }
}

/** The nearest package at or above `dir` that declares workspaces — the root `-w` picks among. */
export function workspaceRootOf(reader: PackageReader, dir: string): PackageInfo | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const found = reader.at(at);
    if (found?.workspaces !== undefined && found.workspaces.length > 0) return found;
    if (dirname(at) === at) return undefined;
  }
}

/**
 * Whether a pick names a package: its `name`, or a glob of names (`@app/*`); its directory, a folder
 * above it, or a glob of directories (`./packages/*`) — a path read from where the line runs. Each
 * manager reads fewer of these than all of them; reading all of them can only judge more scripts,
 * never fewer.
 */
function pickNames(pkg: PackageInfo, pick: string, start: string): boolean {
  const glob = picomatch.scan(pick).isGlob;
  if (pkg.name !== undefined && (pkg.name === pick || (glob && picomatch(pick)(pkg.name)))) return true;
  const place = placeKey(resolveFrom(start, pick));
  const dir = placeKey(pkg.dir);
  return glob ? picomatch(place)(dir) : dir === place || dir.startsWith(`${place}/`);
}

/**
 * The packages a call runs its script in, and the lines it runs in each — or `undefined` when that
 * cannot be read off the files: no package, a workspace picked that none is, or a picked package
 * without the script and nothing that passes over it (npm fails there, and what it ran before
 * failing is not worth guessing).
 *
 * Picked workspaces are the root's members — `workspaces` in its `package.json`, or its
 * `pnpm-workspace.yaml` — that a pick names ({@link pickNames}), every member for `all`, the root
 * itself for `root` or when a pick names it, less those an exclusion names. Only exclusions picks
 * every member but those.
 */
export function scriptRunsOf(reader: PackageReader, call: PackageScriptCall, here: string): ScriptRun[] | undefined {
  const start = call.prefix !== undefined ? resolveFrom(here, call.prefix) : here;
  let targets: PackageInfo[];
  const picks = call.workspaces;
  if (picks === undefined) {
    const found = nearestPackage(reader, start);
    if (found === undefined) return undefined;
    targets = [found];
  } else {
    const root = workspaceRootOf(reader, start);
    if (root === undefined) return undefined;
    const members = reader.workspacesOf(root);
    const onlyExcluding = picks.picked.length === 0 && !picks.all && !picks.root && picks.excluded.length > 0;
    targets = [...(picks.root ? [root] : []), ...(picks.all || onlyExcluding ? members : [])];
    for (const pick of picks.picked) {
      const matches = [root, ...members].filter((pkg) => pickNames(pkg, pick, start));
      if (matches.length === 0) return undefined;
      targets.push(...matches);
    }
    const seen = new Set<string>();
    targets = targets.filter((target) => !seen.has(placeKey(target.dir)) && seen.add(placeKey(target.dir)) !== undefined);
    targets = targets.filter((target) => !picks.excluded.some((pick) => pickNames(target, pick, start)));
  }
  const runs: ScriptRun[] = [];
  for (const target of targets) {
    if (!Object.hasOwn(target.scripts, call.name)) {
      if (call.ifPresent) continue;
      return undefined;
    }
    const main = [target.scripts[call.name]!, ...call.args.map(shellWord)].join(" ");
    const lines = [target.scripts[`pre${call.name}`], main, target.scripts[`post${call.name}`]].filter((line): line is string => line !== undefined && line.trim().length > 0);
    runs.push({ dir: target.dir, lines });
  }
  return runs;
}

// --- the file system ---------------------------------------------------------------------------------

/** A file's parsed contents, or `undefined` when it is missing or does not parse. */
function readParsed(file: string, parse: (text: string) => unknown): unknown {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);

/**
 * The package in exactly `dir`: its `package.json`, and its workspaces — the `workspaces` npm and yarn
 * write there (a list, or yarn classic's `{ "packages": [...] }`), or the `packages` of the
 * `pnpm-workspace.yaml` beside it. A pnpm root with no `package.json` is a package with no scripts.
 */
function readPackage(dir: string): PackageInfo | undefined {
  const json = readParsed(join(dir, "package.json"), JSON.parse);
  const pnpm = readParsed(join(dir, "pnpm-workspace.yaml"), parseYaml);
  if (!isRecord(json) && !isRecord(pnpm)) return undefined;
  const own = isRecord(json) ? json : {};
  const scripts = isRecord(own["scripts"]) ? Object.fromEntries(Object.entries(own["scripts"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  const raw = own["workspaces"];
  const workspaces = strings(raw) ?? (isRecord(raw) ? strings(raw["packages"]) : undefined) ?? (isRecord(pnpm) ? strings(pnpm["packages"]) : undefined);
  return { dir, ...(typeof own["name"] === "string" ? { name: own["name"] } : {}), scripts, ...(workspaces !== undefined ? { workspaces } : {}) };
}

/**
 * The directories a root's `workspaces` patterns name, as npm finds them: each pattern globbed for the
 * `package.json` under it, `!pattern` taking back what the others named, `node_modules` never entered.
 */
export function expandWorkspaces(root: string, patterns: readonly string[]): string[] {
  const manifest = (pattern: string): string => `${pattern.replace(/^\.\//, "").replace(/[\\/]+$/, "")}/package.json`;
  const wanted = patterns.filter((pattern) => !pattern.startsWith("!")).map(manifest);
  if (wanted.length === 0) return [];
  const ignore = ["**/node_modules/**", ...patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => manifest(pattern.slice(1)))];
  const files = globSync(wanted, { cwd: root, ignore, absolute: true, onlyFiles: true, expandDirectories: false });
  return [...new Set(files.map((file) => dirname(file)))].sort();
}

/** The packages on disk. */
export const filePackages: PackageReader = {
  at: readPackage,
  workspacesOf: (root) => expandWorkspaces(root.dir, root.workspaces ?? []).flatMap((dir) => readPackage(dir) ?? []),
};
