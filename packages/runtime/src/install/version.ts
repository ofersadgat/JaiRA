/**
 * Versions: what a tool says it is, whether that is what a project asked for, and what to ask an
 * installer for so it is.
 *
 * A wanted version is TEXT a person or a project file wrote — `22`, `v22`, `22.11.0`, `>=22`,
 * `>9.1 <10`, `^9`, `~3.12`, `22.x`, `lts`. The range rules are npm's (node-semver), the vocabulary
 * most of these files are written in, with the few spellings other ecosystems add:
 *
 *  - A bare or `=` version with fewer than three parts is every version it starts: `22` is `>=22.0.0
 *    <23.0.0`, `22.11` is `>=22.11.0 <22.12.0`. Three or more parts is that version exactly.
 *    `22.x`, `22.*` and `3.12.*` (Python's `==3.12.*`) are the same as `22` and `3.12`; a leading `v`
 *    is dropped.
 *  - `^X.Y.Z` keeps the first non-zero part: `^9` is `>=9 <10`, `^0.2.3` is `>=0.2.3 <0.3.0`.
 *  - `~X.Y.Z` keeps the minor: `~3.12` is `>=3.12 <3.13`, `~3` is `>=3 <4`. Ruby's `~> 3.2` is `>=3.2
 *    <4`, `~> 3.2.1` is `>=3.2.1 <3.3`.
 *  - `>`, `>=`, `<`, `<=`, `!=` compare; on a partial version they mean all of it, as npm's do: `>9.1`
 *    is past every 9.1.x (`>=9.2.0`), `<=9.1` takes every 9.1.x in (`<9.2.0`).
 *  - Space or comma between comparators is AND (`>=3.9,<3.13`); `||` is OR; `1.2 - 2.3` a hyphen range.
 *  - `*`, `x`, `any`, `latest`, `stable`, `lts`, `lts/*` and `current` are any version — they name a
 *    line to install, not a version to hold to. Node's `lts/<codename>` (`lts/jod`) is its major.
 *    `nightly`, `beta` are met by a version that says so (`1.85.0-nightly`).
 *
 * Only the numbers are compared: a pre-release or build tag (`-nightly`, `+g13654a5`) is ignored.
 */
import type { Exec } from "../exec";
import type { ExecEnv } from "../paths";

/** Words that name a line to install rather than a version to hold to: any version meets them. */
const ANY = new Set(["", "*", "x", "any", "latest", "stable", "lts", "lts/*", "current", "node", "newest"]);

/** Words a version meets by saying them: a toolchain channel. */
const CHANNELS = new Set(["nightly", "beta", "canary", "dev"]);

/** Node's LTS lines by codename, as `.nvmrc` may name them (`lts/jod`) — as nodejs.org/dist/index.json names them (2026-11-18). */
const NODE_LTS: Readonly<Record<string, number>> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
  lithium: 26,
};

/** A version's numbers, from its start: `v22.11.0` → [22, 11, 0], `1.85.0-nightly` → [1, 85, 0]; undefined when it starts with none. */
export function versionParts(text: string): number[] | undefined {
  const match = /^\s*v?(\d+(?:\.\d+)*)/i.exec(text);
  return match === null ? undefined : match[1]!.split(".").map(Number);
}

/** -1, 0 or 1 as `a` is before, the same as, or after `b` — missing parts count as 0. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The version number in what a program printed: the first dotted number (`Docker version 27.3.1,
 * build ce12230` → `27.3.1`, `go version go1.23.2 darwin/arm64` → `1.23.2`, `jq-1.7.1` → `1.7.1`),
 * with a pre-release tag that follows it (`1.85.0-nightly`); else the first bare number of the first
 * line (`openjdk 21 2023-09-19` → `21`). `pattern`'s first group, when given and matched, wins.
 */
export function versionNumberOf(text: string, pattern?: RegExp): string | undefined {
  if (pattern !== undefined) {
    const own = pattern.exec(text);
    if (own !== null) return own[1] ?? own[0];
  }
  const dotted = /(?<![\d.])(\d+(?:\.\d+)+)(-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/.exec(text);
  if (dotted !== null) return `${dotted[1]}${dotted[2] ?? ""}`;
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return /(?<![\d.])(\d+)(?![\d.])/.exec(first)?.[1];
}

/**
 * The first line a program printed for its version, without its own name: `git version 2.39.5 (Apple
 * Git-154)` → `2.39.5 (Apple Git-154)`, `glab 1.48.0 (b9d6e9a5)` → `1.48.0 (b9d6e9a5)` — what a row shows.
 */
export function versionLineOf(binary: string, stdout: string): string | undefined {
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return undefined;
  const name = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return first.replace(new RegExp(`^${name}(\\.exe)?(\\s+version)?\\s+`, "i"), "");
}

// --- ranges ---------------------------------------------------------------------------------------

type Comparator =
  | { op: ">=" | ">" | "<" | "<=" | "="; v: number[] }
  /** Not within [from, to): `!=` on a partial version. */
  | { op: "!in"; from: number[]; to: number[] }
  | { op: "!="; v: number[] }
  /** A channel the found version must name. */
  | { op: "has"; word: string };

/** The version after every one `parts` starts: [9, 1] → [9, 2], [22] → [23]. */
function bump(parts: readonly number[]): number[] {
  return [...parts.slice(0, -1), parts.at(-1)! + 1];
}

/** `22`, `22.x`, `3.12.*`, `v1.2.3` → its numbers and whether it names one version exactly. */
function partial(text: string): { parts: number[]; exact: boolean } | undefined {
  const t = text.replace(/^v/i, "");
  if (!/^\d+(\.(\d+|[x*]))*(\.[x*])?$/i.test(t)) {
    // A full version with a tag after it (`1.2.3-rc.1`, `1.2.3+build`) is that version.
    const tagged = /^(\d+\.\d+\.\d+)[-+][0-9A-Za-z.-]+$/.exec(t);
    return tagged === null ? undefined : { parts: tagged[1]!.split(".").map(Number), exact: true };
  }
  const parts: number[] = [];
  for (const one of t.split(".")) {
    if (/^[x*]$/i.test(one)) break;
    parts.push(Number(one));
  }
  if (parts.length === 0) return undefined;
  return { parts, exact: parts.length >= 3 };
}

/** One token of a range: `^9`, `>=22`, `~3.12`, `22.x`, `nightly`. */
function comparatorsOf(token: string): Comparator[] | undefined {
  const lower = token.toLowerCase();
  if (CHANNELS.has(lower)) return [{ op: "has", word: lower }];
  if (ANY.has(lower)) return [];
  const lts = /^lts\/([a-z]+)$/.exec(lower);
  if (lts !== null) {
    const major = NODE_LTS[lts[1]!];
    return major === undefined ? undefined : [{ op: ">=", v: [major] }, { op: "<", v: [major + 1] }];
  }
  const op = /^(\^|~>|~|>=|<=|>|<|===|==|=|!=)?(.*)$/.exec(token)!;
  const operator = op[1] ?? "";
  const version = partial(op[2]!.trim());
  if (version === undefined) return undefined;
  const { parts, exact } = version;
  switch (operator) {
    case "^": {
      // Up to the first part that is not 0, which may not change; all of them when every one is 0.
      const first = parts.findIndex((n) => n !== 0);
      const upto = first === -1 ? parts : parts.slice(0, first + 1);
      return [
        { op: ">=", v: parts },
        { op: "<", v: bump(upto) },
      ];
    }
    case "~":
      return [
        { op: ">=", v: parts },
        { op: "<", v: bump(parts.slice(0, Math.min(parts.length, 2))) },
      ];
    case "~>":
      return [
        { op: ">=", v: parts },
        { op: "<", v: parts.length === 1 ? bump(parts) : bump(parts.slice(0, -1)) },
      ];
    case ">=":
      return [{ op: ">=", v: parts }];
    case ">":
      return exact ? [{ op: ">", v: parts }] : [{ op: ">=", v: bump(parts) }];
    case "<":
      return [{ op: "<", v: parts }];
    case "<=":
      return exact ? [{ op: "<=", v: parts }] : [{ op: "<", v: bump(parts) }];
    case "!=":
      return exact ? [{ op: "!=", v: parts }] : [{ op: "!in", from: parts, to: bump(parts) }];
    default:
      return exact
        ? [{ op: "=", v: parts }]
        : [
            { op: ">=", v: parts },
            { op: "<", v: bump(parts) },
          ];
  }
}

/** A range as alternatives of comparators all of which must hold; `any` for one any version meets; undefined when it is not one. */
function rangeOf(wanted: string): Comparator[][] | "any" | undefined {
  const text = wanted.trim();
  if (ANY.has(text.toLowerCase())) return "any";
  const alternatives: Comparator[][] = [];
  for (const alternative of text.split("||")) {
    const spaced = alternative
      .replace(/,/g, " ")
      // `>= 22` is `>=22`.
      .replace(/(\^|~>|~|>=|<=|>|<|===|==|=|!=)\s+/g, "$1")
      .trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(spaced);
    if (hyphen !== null) {
      const from = partial(hyphen[1]!);
      const to = partial(hyphen[2]!);
      if (from === undefined || to === undefined) return undefined;
      alternatives.push([{ op: ">=", v: from.parts }, to.exact ? { op: "<=", v: to.parts } : { op: "<", v: bump(to.parts) }]);
      continue;
    }
    const all: Comparator[] = [];
    for (const token of spaced.split(/\s+/).filter((one) => one.length > 0)) {
      const one = comparatorsOf(token);
      if (one === undefined) return undefined;
      all.push(...one);
    }
    if (all.length === 0) return "any";
    alternatives.push(all);
  }
  return alternatives.length === 0 ? "any" : alternatives;
}

function holds(found: string, parts: readonly number[], one: Comparator): boolean {
  switch (one.op) {
    case ">=":
      return compareVersions(parts, one.v) >= 0;
    case ">":
      return compareVersions(parts, one.v) > 0;
    case "<":
      return compareVersions(parts, one.v) < 0;
    case "<=":
      return compareVersions(parts, one.v) <= 0;
    case "=":
      return compareVersions(parts, one.v) === 0;
    case "!=":
      return compareVersions(parts, one.v) !== 0;
    case "!in":
      return compareVersions(parts, one.from) < 0 || compareVersions(parts, one.to) >= 0;
    case "has":
      return found.toLowerCase().includes(one.word);
  }
}

/** Is any version wanted — nothing, `*`, `latest`, `stable`, `lts`? */
export function isAnyVersion(wanted: string | undefined): boolean {
  return wanted === undefined || rangeOf(wanted) === "any";
}

/**
 * Does the version found meet the version wanted? `found` is a version as a program prints it
 * (`v22.11.0`, `3.12.1`, `1.85.0-nightly`); `wanted` is a version or a range as described above.
 * A wanted text that is neither is met by nothing — better to say so than to guess.
 */
export function versionSatisfies(found: string, wanted: string): boolean {
  const range = rangeOf(wanted);
  if (range === "any") return true;
  if (range === undefined) return false;
  const parts = versionParts(found);
  if (parts === undefined) return false;
  return range.some((all) => all.every((one) => holds(found, parts, one)));
}

/** What a request asks an installer for. */
export interface VersionWant {
  /** Any version does — none named, or a line (`latest`, `lts`, `stable`). */
  any: boolean;
  /**
   * The version to ask an installer for: the newest a range allows, as far as a version name says it
   * — `22` for `^22` or `22.x`, `3.12` for `~3.12` or `>=3.9,<3.13`, `22.11.0` exactly. Absent: the
   * installer's latest (no upper bound, or one no name can say).
   */
  pin?: string;
  /** The line a version manager installs by name: `lts`, `latest`, or a toolchain channel. */
  channel?: string;
}

/** The pin of one alternative: its exact version, or the newest its upper bound leaves. */
function pinOf(all: readonly Comparator[]): number[] | "latest" | undefined {
  const exact = all.find((one) => one.op === "=");
  if (exact !== undefined && exact.op === "=") return exact.v;
  const below = all.flatMap((one) => (one.op === "<" ? [one.v] : one.op === "<=" ? [bump(one.v)] : []));
  const above = all.flatMap((one) => (one.op === ">=" ? [one.v] : one.op === ">" ? [bump(one.v)] : []));
  if (below.length === 0) return "latest";
  const upper = below.reduce((low, one) => (compareVersions(one, low) < 0 ? one : low));
  const lower = above.length === 0 ? undefined : above.reduce((high, one) => (compareVersions(one, high) > 0 ? one : high));
  // `<10` (or `<10.0.0`) leaves the newest 9; `<3.13` the newest 3.12. A bound with a patch says no name.
  const [major = 0, minor = 0, ...rest] = upper;
  if (rest.some((n) => n !== 0)) return undefined;
  const pin = minor === 0 ? (major > 0 ? [major - 1] : undefined) : [major, minor - 1];
  if (pin === undefined) return undefined;
  // The newest in the pin's line must still be above the lower bound — `>=9.5 <10` pins 9, and the newest 9 is.
  if (lower !== undefined && compareVersions(bump(pin), lower) <= 0) return undefined;
  return pin;
}

/** What to ask an installer for, to meet `wanted`. */
export function versionWant(wanted: string | undefined): VersionWant {
  if (wanted === undefined) return { any: true };
  const text = wanted.trim().toLowerCase();
  if (text === "lts" || text === "lts/*") return { any: true, channel: "lts" };
  if (text === "stable") return { any: true, channel: "stable" };
  if (text === "latest" || text === "current" || text === "node" || text === "newest") return { any: true, channel: "latest" };
  if (ANY.has(text)) return { any: true };
  if (CHANNELS.has(text)) return { any: false, channel: text };
  const range = rangeOf(wanted);
  if (range === "any") return { any: true };
  if (range === undefined) return { any: false };
  // Of the alternatives, the newest one names: `^20 || ^22` installs 22. One with no upper bound is the latest.
  let best: number[] | undefined;
  for (const all of range) {
    const pin = pinOf(all);
    if (pin === "latest") return { any: false };
    if (pin !== undefined && (best === undefined || compareVersions(pin, best) > 0)) best = pin;
  }
  return best === undefined ? { any: false } : { any: false, pin: best.join(".") };
}

/** A version that names one release exactly — three parts or more — which `--version` flags need. */
export function isExactVersion(pin: string | undefined): boolean {
  return pin !== undefined && /^\d+\.\d+\.\d+/.test(pin);
}

// --- asking the program ---------------------------------------------------------------------------

/** How a package says its version. */
export interface VersionCommand {
  /** What it is run with: `--version` unless said. */
  args?: readonly string[];
  /** Where in the output the version is, as a first group — for one the first dotted number is not (Java's `1.8.0`). */
  pattern?: RegExp;
}

export interface VersionRunOptions {
  exec: Exec;
  execEnv?: ExecEnv;
  timeoutMs?: number;
  /** Where it runs — a version manager's shim answers for the folder's own pinned version. */
  cwd?: string;
  env?: Record<string, string>;
}

const VERSION_TIMEOUT_MS = 10_000;

/**
 * Run a program's version command and read the number it says (stdout first, then stderr — Java
 * prints its version there). Undefined when it could not start, did not answer, or said no number.
 */
export async function runVersion(file: string, command: VersionCommand | undefined, options: VersionRunOptions): Promise<string | undefined> {
  try {
    const result = await options.exec.run(file, [...(command?.args ?? ["--version"])], {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS,
      stdin: "",
    });
    if (result.timedOut || result.aborted) return undefined;
    const said = `${result.stdout}\n${result.stderr}`;
    // A failure that still says a version is a version (some print it and exit 1 for want of a project).
    return versionNumberOf(said, command?.pattern);
  } catch {
    return undefined;
  }
}
