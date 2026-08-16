/**
 * Where a tool may act — the scope table, and the mode it gives one call.
 *
 * A permission used to answer one question, *may this agent call `write_file`?*, and answer it the
 * same everywhere. This module is the other half of the answer: **which place is this call about**,
 * and what does the table say about that place.
 *
 * Pure, and deliberately so. Nothing here reads a file, consults a ledger or asks a human — it
 * decides a mode from a table and a path, which is the one part of the permission story that can be
 * tested exhaustively. Enforcement is layered on top of this; the shape of the decision is here.
 *
 * ## The three rules, restated where they are implemented
 *
 *  - **Most specific wins, per tool** ({@link resolveScope}). Inheritance is not a merge — it falls
 *    out of looking each tool up separately, so a scope naming `edit` and saying nothing about
 *    `read_file` leaves the read resolving at its parent. A merge could produce a mode neither entry
 *    contains; this cannot.
 *  - **Unmatched is denied.** This is the whole default policy: a table naming only
 *    `/mnt/c/work/**` is a complete sandbox, and nobody had to write a deny rule to get it. Widening
 *    is what you have to type.
 *  - **Strictest wins across several places** ({@link strictest}). One call may be about more than
 *    one path — `cp a b`, a command's cwd plus its arguments — and the answer is the minimum.
 */
import type { ToolMode } from "./toolVocabulary";

export type { ToolMode };

/**
 * One entry: a place, and what may happen there.
 *
 * `path` and `url` are exclusive. A scope is about a location in a filesystem or a location on the
 * network, and the tools that take one take no notion of the other — see {@link resolveScope} and
 * {@link resolveUrlScope}, which is why they are two functions rather than one with a flag.
 */
export interface Scope {
  /** A path glob. Absolute (`/mnt/c/work/**`, `C:/work/**`) or workspace-relative (`code/**`). */
  path?: string;
  /** A URL glob, for the web tools — `https://docs.example/**`. */
  url?: string;
  /** Modes for tools named here. A tool absent falls to {@link Scope.default}, then to the parent. */
  tools?: Record<string, ToolMode>;
  /** What a tool this scope does not name resolves to HERE. Absent ⇒ keep looking outward. */
  default?: ToolMode;
}

export interface ScopeOptions {
  /**
   * What a relative glob and a relative call path are relative TO.
   *
   * Absent, a relative glob can still be compared against a relative path — which is what a test or
   * a workspace-relative table wants — but an absolute call path will not match a relative glob,
   * because there is nothing to say where it would begin.
   */
  root?: string | undefined;
  /**
   * Whether path matching respects case. Default **false**.
   *
   * Insensitive is the safe default rather than a Windows convenience. The dangerous direction is a
   * call escaping a `deny` entry on a case difference and landing on some broader `allow`; matching
   * insensitively closes that, and the cost is over-matching on a case-sensitive filesystem where
   * two files differ only in case — rarer, and it errs toward the stricter entry.
   */
  caseSensitive?: boolean | undefined;
}

// --- globs -------------------------------------------------------------------

/**
 * Translate a glob into a regular expression.
 *
 * `**` crosses directory separators and `*` does not, which is the one distinction that makes
 * `src/*.ts` mean something different from `src/**\/*.ts`. Written by scanning rather than by
 * chained `replace` calls, because the replacements interfere: turning `*` into `[^/]*` first leaves
 * `**` as two of them.
 *
 * Lives here rather than beside the tools that search, because a scope glob and a search glob have
 * to mean the same thing — a table denying `infra/**` and a `glob` call for `infra/**` disagreeing
 * about what they match is a hole with no visible cause.
 */
export function globToRegExp(pattern: string, flags = ""): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    // A TRAILING `/**` covers the base directory too: `/mnt/c/work/**` is how anybody writes "the
    // sandbox is /mnt/c/work", and a reading under which it excludes `/mnt/c/work` itself makes the
    // project path fall outside its own sandbox — and a `bash` cwd of exactly that directory
    // unmatched, hence denied. Only when trailing: `a/**/b` keeps its ordinary meaning below.
    if (c === "/" && pattern.slice(i) === "/**") {
      out += "(?:/.*)?";
      i += 2;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches ZERO directories, so `**/*.ts` finds `a.ts` at the root — which is what
        // everyone means by it and what a naive `.*/` would miss.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (c === "{") {
      out += "(?:";
      continue;
    }
    if (c === "}") {
      out += ")";
      continue;
    }
    if (c === ",") {
      // Only inside a brace group is a comma an alternation; elsewhere it is a character in a name.
      out += out.includes("(?:") ? "|" : ",";
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, flags);
}

/** Forward slashes, no trailing separator, no `./` — the one spelling everything compares in. */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

/** Whether a path names a location from the filesystem root — `/x`, `C:/x`, `//host/share`. */
export function isAbsolutePath(path: string): boolean {
  return /^(\/|[a-zA-Z]:\/)/.test(normalizePath(path));
}

/**
 * A glob or a call path, resolved against the root so the two compare.
 *
 * Only relative things are joined. An absolute glob names a place outright — which is the form that
 * matters when the sandbox is somewhere other than the checkout, the case `withinWorkspace` cannot
 * express at all.
 */
export function absolutize(pathOrGlob: string, root?: string): string {
  const value = normalizePath(pathOrGlob);
  if (root === undefined || isAbsolutePath(value)) return value;
  return `${normalizePath(root)}/${value}`;
}

/**
 * How specific a glob is: the number of leading segments containing no wildcard.
 *
 * `/mnt/c/work/app/**` is 4 and `/mnt/c/work/**` is 3, so the deeper table entry wins — which is
 * what makes the model "the directory's permissions" rather than "whichever row you wrote last".
 * Counting only the LEADING run matters: `a/*​/c/d` is as specific as `a`, because everything after
 * the wildcard describes a shape rather than a place.
 */
export function specificityOf(glob: string): number {
  let count = 0;
  for (const segment of normalizePath(glob).split("/")) {
    if (segment === "") continue;
    if (segment.includes("*") || segment.includes("?") || segment.includes("{")) break;
    count++;
  }
  return count;
}

// --- resolution --------------------------------------------------------------

/** deny ▸ ask ▸ smart ▸ allow — how restrictive each mode is, for {@link strictest}. */
const RANK: Record<ToolMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };

/**
 * The most restrictive of several modes — what a call about several places resolves to.
 *
 * `smart` sits under `ask` because it MAY escalate to a human and is not guaranteed to, so it cannot
 * dominate an explicit `ask`. Empty is `deny`, which is the same rule as an unmatched path: nothing
 * said anything, so nothing permitted it.
 */
export function strictest(...modes: readonly ToolMode[]): ToolMode {
  let worst: ToolMode = "deny";
  let seen = false;
  for (const mode of modes) {
    if (!seen || RANK[mode] > RANK[worst]) worst = mode;
    seen = true;
  }
  return seen ? worst : "deny";
}

/** A scope paired with the compiled matcher and specificity its glob implies. */
interface Compiled {
  scope: Scope;
  matches: (value: string) => boolean;
  specificity: number;
  /** Position in the authored table — the tie-break, later winning. */
  index: number;
}

function compile(scopes: readonly Scope[], key: "path" | "url", options: ScopeOptions): Compiled[] {
  const flags = key === "path" && options.caseSensitive !== true ? "i" : "";
  const out: Compiled[] = [];
  for (const [index, scope] of scopes.entries()) {
    const glob = scope[key];
    if (typeof glob !== "string" || glob === "") continue;
    const pattern = key === "path" ? absolutize(glob, options.root) : glob;
    let matcher: RegExp;
    try {
      matcher = globToRegExp(pattern, flags);
    } catch {
      // An unusable glob matches NOTHING rather than everything. A table with a typo in it should
      // narrow toward the deny default, never widen — the failure has to be the safe direction.
      continue;
    }
    out.push({ scope, matches: (value) => matcher.test(value), specificity: specificityOf(pattern), index });
  }
  // Most specific first; ties to the later authored entry.
  return out.sort((a, b) => b.specificity - a.specificity || b.index - a.index);
}

/**
 * The shared walk behind both resolvers.
 *
 * **Specificity dominates.** One pass, most specific first, and a scope answers if it says anything
 * about this tool at all — an explicit entry, or its own `default`. Only a scope with neither is
 * fallen through.
 *
 * The alternative — every scope's explicit entries first, then every scope's defaults — reads
 * plausibly and is wrong. It lets a broad `{"path": "work/**", "tools": {"read_file": "allow"}}`
 * override a nested `{"path": "work/infra/**", "default": "deny"}`, which makes `default: deny`
 * almost inert: it would govern only tools no ancestor happened to name. "Deny everything here" has
 * to mean it, or the root-deny-then-widen shape this whole design is for cannot be written.
 *
 * Inheritance survives because a scope that says nothing is still skipped: a scope naming `edit`
 * with no `default` leaves `read_file` to resolve at its parent.
 */
function resolveIn(compiled: readonly Compiled[], tool: string, value: string): ToolMode {
  for (const entry of compiled) {
    if (!entry.matches(value)) continue;
    const own = entry.scope.tools;
    if (own !== undefined && Object.hasOwn(own, tool)) return own[tool]!;
    if (entry.scope.default !== undefined) return entry.scope.default;
  }
  // Nothing said anything about this place — the sandbox property.
  return "deny";
}

/**
 * The mode a table gives one tool at one path.
 *
 * The path is absolutized first, so an absolute call and a relative glob compare against the same
 * thing. `deny` for a path no scope matches — the sandbox property, and the reason a table
 * needs no root entry to be safe.
 */
export function resolveScope(
  scopes: readonly Scope[],
  tool: string,
  path: string,
  options: ScopeOptions = {},
): ToolMode {
  // Case is handled by the compiled matcher's flag, not by folding the value — folding here as well
  // would be a second mechanism for one rule, and the two could disagree about a locale.
  return resolveIn(compile(scopes, "path", options), tool, absolutize(path, options.root));
}

/**
 * The same, for a URL.
 *
 * Separate because a URL is not a path and must not be absolutized against a filesystem root — and
 * because the sandbox property means something stronger here: a web tool whose call matches no `url`
 * scope is denied, so the default posture is no network and an allowlist is how you open it.
 */
export function resolveUrlScope(
  scopes: readonly Scope[],
  tool: string,
  url: string,
  options: ScopeOptions = {},
): ToolMode {
  return resolveIn(compile(scopes, "url", options), tool, url);
}

/**
 * The strictest answer across several paths — one call about more than one place.
 *
 * `cp code/app/x infra/x` is an `infra/**` call however permissive the source is, and a command's
 * own working directory is always in the set rather than a fallback when no path is named.
 */
export function resolveScopes(
  scopes: readonly Scope[],
  tool: string,
  paths: readonly string[],
  options: ScopeOptions = {},
): ToolMode {
  if (paths.length === 0) return "deny";
  return strictest(...paths.map((path) => resolveScope(scopes, tool, path, options)));
}

/**
 * Whether the table says anything at all about the project path — the misconfiguration warning.
 *
 * A sandbox that excludes the open project denies everything the run was started to do, and that is
 * far more likely to be a path typed for another machine than an intention. A warning rather than a
 * refusal, because bounding an executor somewhere else entirely is a legitimate thing to configure.
 *
 * Deliberately NOT "is there a root entry" — that question has the ordinary safe answer `no`, and
 * warning about it would train people to widen tables to silence a warning.
 */
export function coversProjectPath(scopes: readonly Scope[], projectPath: string, options: ScopeOptions = {}): boolean {
  const value = absolutize(projectPath, options.root);
  return compile(scopes, "path", options).some((entry) => entry.matches(value));
}

// --- resolving a CALL --------------------------------------------------------

/** The places one call is about, pulled out of its arguments by the vocabulary's own declaration. */
export interface CallSubjects {
  paths: string[];
  urls: string[];
}

/**
 * What a call is ABOUT — the places its arguments name.
 *
 * Read from {@link ToolSpec.pathArgs} / {@link ToolSpec.urlArgs} rather than from a table of
 * argument names kept here, so the answer cannot drift from the tool: the same declaration that says
 * `read_file` takes a `path` is the one a permission resolves against.
 *
 * A path-taking tool called with NO path is about the workspace root. That is the honest reading for
 * the ones where it is legal — `glob` and `grep` walk from the root when given no directory — and
 * harmless for the ones where it is not, since `read_file` without a path fails on its own before
 * touching anything. Denying instead would refuse every unscoped `glob`, which is the ordinary call.
 *
 * A tool the vocabulary does not know is about NOWHERE, and the caller decides what that means. It
 * is deliberately not "the root": an unmodelled tool resolving to the workspace's own permissions
 * would be the widest possible guess about the one call we understand least.
 */
export function subjectsOf(
  spec: { pathArgs?: readonly string[]; urlArgs?: readonly string[] } | undefined,
  input: unknown,
  root?: string,
): CallSubjects {
  const out: CallSubjects = { paths: [], urls: [] };
  if (spec === undefined) return out;
  const args: Record<string, unknown> =
    input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const name of spec.pathArgs ?? []) {
    const value = args[name];
    if (typeof value === "string" && value.trim() !== "") out.paths.push(value);
  }
  for (const name of spec.urlArgs ?? []) {
    const value = args[name];
    if (typeof value === "string" && value.trim() !== "") out.urls.push(value);
  }
  // About the workspace, when it names no place of its own and takes paths at all.
  if (out.paths.length === 0 && (spec.pathArgs ?? []).length > 0 && root !== undefined) out.paths.push(root);
  return out;
}

/**
 * The mode a scope table gives one CALL — every place it names, strictest winning.
 *
 * `undefined` when the table has nothing to say about this call: no scopes at all, or a tool that
 * names no place. That is the value the permission gate takes as "no narrowing", which is why it is
 * distinct from `deny` — a table that does not apply must not refuse.
 */
export function scopeModeOf(
  scopes: readonly Scope[] | undefined,
  spec: { pathArgs?: readonly string[]; urlArgs?: readonly string[] } | undefined,
  tool: string,
  input: unknown,
  options: ScopeOptions = {},
): ToolMode | undefined {
  if (scopes === undefined || scopes.length === 0) return undefined;
  const subjects = subjectsOf(spec, input, options.root);
  if (subjects.paths.length === 0 && subjects.urls.length === 0) return undefined;
  const modes: ToolMode[] = [
    ...subjects.paths.map((path) => resolveScope(scopes, tool, path, options)),
    ...subjects.urls.map((url) => resolveUrlScope(scopes, tool, url, options)),
  ];
  return strictest(...modes);
}
