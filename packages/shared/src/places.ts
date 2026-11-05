/**
 * PLACES on a permission set line (decision 0023 §3): which place a call is about, and which of a
 * line's places answers for it.
 *
 * A line's value may be a PLACE MAP — `"write_file": { "src": "allow", "infra": "deny", "**": "ask" }` —
 * and a call answers to the most specific of that line's places that matches it (§3.4), or, where none
 * does, falls to the next less specific line. This module is the pure half of that: given a map, the
 * kind of place the line is about and the places a call names, which place answers, and with what.
 * Which line a call reaches, and what a place that matches nothing falls to, is the policy's
 * (`decideCommand`, `lookUp` and `placeNarrowingFor` in `@jaira/runtime`). What places a tool call
 * is about ({@link callPlacesOf}) and the widths an answer can be remembered at ({@link placeWidthsOf})
 * are here too, because the dialog asks them of a call the renderer holds.
 *
 * ## Not the scope table
 *
 * `scopes.ts` is the other place-first table — an executor's `scopes`, the floor no layer widens
 * (§7.2) — and its rules are not these: there, an unmatched place is DENIED (a sandbox), and a deeper
 * glob simply wins. Here an unmatched place says nothing, a file-pinning place beats every folder that
 * holds it, and two places that rank the same take the stricter answer. Only the spelling is shared —
 * {@link globToRegExp}, {@link normalizePath} and {@link absolutize} — so a glob means the same thing on
 * both, and nothing here changes how the floor reads its table.
 *
 * ## The ranking, restated where it is implemented (§3.2, §3.3)
 *
 * Paths ({@link pathRank}), most specific first:
 *  1. a bare path that IS the call's path — it names that file, and nothing names it more exactly;
 *  2. a FILE pattern — a glob that does not end in `/**` (`**​/.env`, `*.pem`, `src/**​/*.ts`) — over
 *     any folder that holds the file, which is how credentials stay asked about under a broad allow
 *     with no rule of their own (ruling 3); among them, more literal leading segments win
 *     (`src/generated/**​/*.ts` over `src/**​/*.ts`);
 *  3. a FOLDER — a bare path (that folder and everything under it) or a glob ending in `/**` — the
 *     deeper winning (`$PROJECT` over `C:`);
 *  4. `**`, least specific of all.
 *
 * Sites ({@link siteRank}): a host with a path, then the bare host, then a wildcard host (`*.github.com`,
 * its subdomains and not the apex), then `**`. `localhost` and IP addresses are matched only by a place
 * naming them exactly — no wildcard host reaches one — though `**` is everywhere, them included.
 *
 * Branches ({@link branchRank}): an exact name over a glob, a longer literal prefix over a shorter, and
 * — the design leaves it open, so this is the last tie-break — a place naming the remote over one that
 * does not. The other kinds (a repository, a workflow, a program, a host) rank as branches do, without
 * a remote.
 *
 * Two DIFFERENT places that rank the same take the stricter answer — deny ▸ ask ▸ function ▸ allow
 * ({@link modeStrictness}); the same place in two layers never reaches here, the merge having already
 * kept the newer one (`mergePermissionMode`). A call about several places takes the strictest of their
 * answers (§3.5).
 *
 * Pure: no filesystem. The named places (`$PROJECT`, `$WORKTREE`, `$AGENT_WORKSPACE`, `$TEMP`, `~`) are handed in.
 */
import { parseRunnerSubject } from "./commandRunners";
import { isMcpSubject } from "./mcp";
import { modeStrictness, type PermissionSetMode } from "./operationVocabulary";
import { absolutize, globToRegExp, normalizePath, specificityOf } from "./scopes";
import { TOOL_SPEC_BY_NAME, type PlaceKind, type ToolSpec } from "./toolVocabulary";

/** The place that is everywhere — how a place map gives itself a default (§3.4). */
export const PLACE_ANYWHERE = "**";

/**
 * The named places a path place may start from (§3.2). `~` is the person's home folder;
 * `$AGENT_WORKSPACE` the folder the agent keeps for the folder it works in — its memory, its
 * transcripts — which is neither the project nor the worktree.
 */
export const NAMED_PLACES = ["$PROJECT", "$WORKTREE", "$AGENT_WORKSPACE", "$TEMP", "~"] as const;
export type NamedPlace = (typeof NAMED_PLACES)[number];

/**
 * Programs whose command lines are about a SITE, not a path (§3.1: network programs in the shell). By
 * the command word a line names, lowercased; PowerShell's cmdlets by their own names and their aliases.
 */
const SITE_PROGRAMS: ReadonlySet<string> = new Set(["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"]);

/**
 * The kind of place a SUBJECT's line is about (§3.1) — what a place map on it names — or `undefined`
 * when its calls name no place, and a map on it is refused.
 *
 *  - a standard tool: its {@link ToolSpec.scope} (`read_file` a path, `web_fetch` a site, `git_push` a
 *    branch, `start_task` a workflow; `web_search` and `screenshot` none);
 *  - `script`, `shell`, `runner:*` and every runner's own line: a path — where it runs, and every path
 *    a part names as a file tool — except `runner:ssh`, which is about the HOST it reaches;
 *  - a command line: a path, except `git push` (the branch pushed to) and the network programs
 *    (`curl`, `wget`, `Invoke-WebRequest`: the site), as §3.1's table says;
 *  - `other`: none, since it names no one tool;
 *  - an MCP line: `undefined` here, because an MCP tool takes the place of the standard tool the
 *    configuration maps it to (§3.1), which this module cannot see. The linter does not refuse a map on
 *    one for that reason.
 */
export function placeKindOf(subject: string): PlaceKind | undefined {
  const normalized = subject.trim().replace(/\s+/g, " ");
  if (normalized === "other") return undefined;
  if (normalized === "script") return "path";
  if (isMcpSubject(normalized)) return undefined;
  const runner = parseRunnerSubject(normalized);
  if (runner !== undefined) return runner.program === "ssh" ? "host" : "path";
  const spec = TOOL_SPEC_BY_NAME.get(normalized);
  if (spec !== undefined) return spec.scope;
  const words = normalized.toLowerCase().split(" ");
  if (words[0] === "git" && words[1] === "push") return "branch";
  if (SITE_PROGRAMS.has(words[0]!)) return "site";
  return "path";
}

/** What a path place is resolved against. */
export interface PlaceOptions {
  /** The project root: what a relative path place, and a relative call path, are relative to. Also `$PROJECT` when {@link named} gives none. */
  root?: string | undefined;
  /** Where each named place is on this machine. One not given matches nothing. */
  named?: Partial<Record<NamedPlace, string>> | undefined;
  /** Whether a PATH compares with case. Default false, as `scopes.ts` decides and for its reason: insensitive errs toward the stricter place. */
  caseSensitive?: boolean | undefined;
}

/** The place that answered, and its decision. */
export interface PlaceMatch<M extends PermissionSetMode = PermissionSetMode> {
  /** The place as the map writes it. */
  place: string;
  decision: M;
}

/** What a call about several places comes to (§3.5). */
export interface PlacesResolution<M extends PermissionSetMode = PermissionSetMode> {
  /**
   * The strictest answer among the call's places that a place of the map answered for; `undefined`
   * when none did. NOT the call's answer when {@link unmatched} is not empty: a place that matches
   * nothing falls to the next less specific line (§3.4), which the caller looks up and folds in — this
   * module does not guess what that line says.
   */
  decision?: M;
  /** Per call place that matched, the place that answered. */
  matches: Array<PlaceMatch<M> & { call: string }>;
  /** The call places no place of the map matched. */
  unmatched: string[];
}

/** A rank to compare lexicographically, larger being more specific. */
type Rank = readonly number[];

function compareRank(a: Rank, b: Rank): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const isGlob = (text: string): boolean => /[*?{]/.test(text);

/** The characters before a glob's first wildcard — the literal prefix a branch or a name ranks by. */
const literalPrefixLength = (text: string): number => {
  const at = text.search(/[*?{]/);
  return at === -1 ? text.length : at;
};

// --- paths ---------------------------------------------------------------------

/** A path place's named start replaced by where it is, or `undefined` when that place is not known here. */
function expandNamed(text: string, options: PlaceOptions): string | undefined {
  for (const name of NAMED_PLACES) {
    if (text !== name && !text.startsWith(`${name}/`) && !text.startsWith(`${name}\\`)) continue;
    const at = options.named?.[name] ?? (name === "$PROJECT" ? options.root : undefined);
    return at === undefined ? undefined : `${at}${text.slice(name.length)}`;
  }
  return text;
}

/** A path place made absolute: a drive on its own (`C:`) is that drive, which `absolutize` would read as relative. */
function absolutePlace(normalized: string, root: string | undefined): string {
  return /^[a-zA-Z]:$/.test(normalized) ? normalized : absolutize(normalized, root);
}

/**
 * A path with its `.` and `..` segments walked — `docs/product/../../secrets` is `secrets`. A call's
 * path is compared as a PREFIX of a place's, so a `..` left in it would let `docs/product/../../x` pass
 * as a place under `docs/product`. A `..` above the start stays (nothing is guessed about what lies
 * above a relative path), which keeps such a path from matching anything below it.
 */
function collapseDots(path: string): string {
  if (!/(^|\/)\.\.?(\/|$)/.test(path)) return path;
  const absolute = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== ".." && !/^[a-zA-Z]:$/.test(out[out.length - 1]!)) out.pop();
    else out.push(segment);
  }
  return `${absolute}${out.join("/")}`;
}

/** A call's path, in the one spelling places compare in: slashes forward, absolute against the root, `..` walked. */
function callPath(path: string, options: PlaceOptions): string | undefined {
  const expanded = expandNamed(path.trim(), options);
  return expanded === undefined ? undefined : collapseDots(absolutePlace(normalizePath(expanded), options.root));
}

/**
 * How specific a PATH place is about one call path, or `undefined` when it does not match it — see
 * the module header for the order. `[tier, depth]`: tier 3 a bare path naming the file itself, 2 a
 * file pattern, 1 a folder, 0 `**`; depth the literal leading segments.
 */
export function pathRank(place: string, path: string, options: PlaceOptions = {}): Rank | undefined {
  const text = place.trim();
  if (text === PLACE_ANYWHERE) return [0, 0];
  const value = callPath(path, options);
  const expanded = expandNamed(text, options);
  if (value === undefined || expanded === undefined) return undefined;
  const fold = (s: string): string => (options.caseSensitive === true ? s : s.toLowerCase());
  const normalized = normalizePath(expanded);
  if (isGlob(normalized)) {
    // `**/x` is anywhere on the disk, and so is a glob with no folder in it (`*.pem`, `id_rsa*`) — the
    // reading `.gitignore` gives one, and the one a credential pattern needs to beat `C:`. Any other
    // relative glob is the project's (§3.2).
    const pattern = normalized.startsWith("**/") ? normalized : !normalized.includes("/") ? `**/${normalized}` : absolutize(normalized, options.root);
    let matcher: RegExp;
    try {
      matcher = globToRegExp(pattern, options.caseSensitive === true ? "" : "i");
    } catch {
      // An unusable glob matches nothing — it never widens.
      return undefined;
    }
    if (!matcher.test(value)) return undefined;
    // A glob ending in `/**` is a folder and all under it; any other glob pins files.
    return [pattern.endsWith("/**") ? 1 : 2, specificityOf(pattern)];
  }
  const folder = absolutePlace(normalized, options.root);
  const depth = folder.split("/").filter((segment) => segment !== "").length;
  if (fold(value) === fold(folder)) return [3, depth];
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return fold(value).startsWith(fold(prefix)) ? [1, depth] : undefined;
}

// --- sites -------------------------------------------------------------------

/** `localhost` and an IP address, which no wildcard host reaches (§3.3). */
function isLocalOrAddress(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":") || hostname.startsWith("[");
}

/** A call's URL as host and path, or `undefined` when it is no URL. A bare host is read as `https://` it. */
function parseSite(call: string): { host: string; hostname: string; path: string } | undefined {
  const text = call.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase(), path: url.pathname };
  } catch {
    return undefined;
  }
}

/**
 * How specific a SITE place is about one URL, or `undefined` when it does not match it.
 * `[host, hasPath, pathDepth, wildcardSuffix]`: host 2 exact, 1 a wildcard host, 0 `**`.
 */
export function siteRank(place: string, url: string, _options: PlaceOptions = {}): Rank | undefined {
  const text = place.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (text === PLACE_ANYWHERE || text === "*") return [0, 0, 0, 0];
  const call = parseSite(url);
  if (call === undefined) return undefined;
  const slash = text.indexOf("/");
  const host = (slash === -1 ? text : text.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "" : text.slice(slash);
  let hostRank: number;
  let suffix = 0;
  if (host.startsWith("*.")) {
    // Its subdomains, not the host itself, and never a loopback name or an address.
    const tail = host.slice(1);
    if (isLocalOrAddress(call.hostname) || !call.hostname.endsWith(tail)) return undefined;
    hostRank = 1;
    suffix = tail.length;
  } else {
    // A place with a port names that port; one without names the host on any.
    if (host !== (host.includes(":") ? call.host : call.hostname)) return undefined;
    hostRank = 2;
  }
  if (path === "" || path === "/" || path === "/**") return [hostRank, 0, 0, suffix];
  // URL paths keep their case.
  if (isGlob(path)) {
    let matcher: RegExp;
    try {
      matcher = globToRegExp(path);
    } catch {
      return undefined;
    }
    if (!matcher.test(call.path)) return undefined;
  } else {
    const bare = path.replace(/\/+$/, "");
    if (call.path !== bare && !call.path.startsWith(`${bare}/`)) return undefined;
  }
  return [hostRank, 1, specificityOf(path), suffix];
}

// --- branches and names ----------------------------------------------------------

/** One name against one place: exact, or a glob. `[exact, literalPrefix]`. */
function nameRank(place: string, name: string, caseSensitive: boolean): Rank | undefined {
  if (place === PLACE_ANYWHERE) return [0, 0];
  if (!isGlob(place)) return (caseSensitive ? place === name : place.toLowerCase() === name.toLowerCase()) ? [1, place.length] : undefined;
  let matcher: RegExp;
  try {
    matcher = globToRegExp(place, caseSensitive ? "" : "i");
  } catch {
    return undefined;
  }
  return matcher.test(name) ? [0, literalPrefixLength(place)] : undefined;
}

/** `origin:claude/x` as its remote and its branch. A branch name cannot hold `:`, so the first one splits. */
function splitRemote(text: string): { remote?: string; branch: string } {
  const at = text.indexOf(":");
  return at === -1 ? { branch: text } : { remote: text.slice(0, at), branch: text.slice(at + 1) };
}

/**
 * How specific a BRANCH place is about one branch (`main`, or `origin:main` where the call knows its
 * remote), or `undefined` when it does not match it. `[exact, literalPrefix, namesRemote]`. A place
 * naming a remote matches only a call to that remote; one naming none matches a call to any.
 */
export function branchRank(place: string, branch: string, _options: PlaceOptions = {}): Rank | undefined {
  const text = place.trim();
  if (text === PLACE_ANYWHERE) return [0, 0, 0];
  const want = splitRemote(text);
  const call = splitRemote(branch.trim());
  if (want.remote !== undefined && want.remote !== call.remote) return undefined;
  const rank = nameRank(want.branch, call.branch, true);
  return rank === undefined ? undefined : [...rank, want.remote !== undefined ? 1 : 0];
}

/** A place of one of the kinds named by a word (repository, workflow, program, host): exact over glob, longer prefix first. */
function plainRank(kind: PlaceKind, place: string, name: string): Rank | undefined {
  // A forge's `owner/name`, a program and a host name are read without case; a workflow id with it.
  return nameRank(place.trim(), name.trim(), kind === "workflow");
}

/** How specific a place of `kind` is about one call place, or `undefined` when it does not match it. */
export function placeRank(kind: PlaceKind, place: string, call: string, options: PlaceOptions = {}): Rank | undefined {
  switch (kind) {
    case "path":
      return pathRank(place, call, options);
    case "site":
      return siteRank(place, call, options);
    case "branch":
      return branchRank(place, call, options);
    default:
      return plainRank(kind, place, call);
  }
}

// --- resolving ---------------------------------------------------------------

/**
 * The place of `map` that answers for ONE call place, and its decision — the most specific that
 * matches, the stricter where two rank the same — or `undefined` when no place matches, and the call
 * falls to the next less specific line (§3.4).
 */
export function resolvePlace<M extends PermissionSetMode>(
  map: Readonly<Record<string, M>>,
  kind: PlaceKind,
  call: string,
  options: PlaceOptions = {},
): PlaceMatch<M> | undefined {
  let best: { match: PlaceMatch<M>; rank: Rank } | undefined;
  for (const [place, decision] of Object.entries(map)) {
    const rank = placeRank(kind, place, call, options);
    if (rank === undefined) continue;
    const order = best === undefined ? 1 : compareRank(rank, best.rank);
    if (order > 0 || (order === 0 && modeStrictness(decision) > modeStrictness(best!.match.decision))) best = { match: { place, decision }, rank };
  }
  return best?.match;
}

/**
 * What `map` says about a call that names several places (§3.5) — each answered by
 * {@link resolvePlace}, the strictest answer kept — with the places it had nothing to say about kept
 * apart, for the caller to put to the next less specific line. See {@link PlacesResolution}.
 */
export function resolvePlaces<M extends PermissionSetMode>(
  map: Readonly<Record<string, M>>,
  kind: PlaceKind,
  calls: readonly string[],
  options: PlaceOptions = {},
): PlacesResolution<M> {
  const out: PlacesResolution<M> = { matches: [], unmatched: [] };
  for (const call of calls) {
    const match = resolvePlace(map, kind, call, options);
    if (match === undefined) {
      out.unmatched.push(call);
      continue;
    }
    out.matches.push({ ...match, call });
    if (out.decision === undefined || modeStrictness(match.decision) > modeStrictness(out.decision)) out.decision = match.decision;
  }
  return out;
}

/**
 * A line's places, most specific first, as the card draws them (§4.2) — by the rank each has on its
 * own, with no call to measure against: a file pattern before a folder, a deeper folder before a
 * shallower one, `**` last; among equals, as written. A bare path ranks as a folder here, since
 * whether it names a file is only known against a call.
 */
export function placesMostSpecificFirst(kind: PlaceKind, places: readonly string[], options: PlaceOptions = {}): string[] {
  const own = (place: string): Rank => {
    const text = place.trim();
    if (text === PLACE_ANYWHERE) return [-1];
    switch (kind) {
      case "path": {
        const expanded = expandNamed(text, options) ?? text;
        const normalized = normalizePath(expanded);
        if (!isGlob(normalized)) return [1, absolutePlace(normalized, options.root).split("/").filter((s) => s !== "").length];
        const pattern = normalized.startsWith("**/") ? normalized : !normalized.includes("/") ? `**/${normalized}` : absolutize(normalized, options.root);
        return [pattern.endsWith("/**") ? 1 : 2, specificityOf(pattern)];
      }
      case "site": {
        const bare = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
        const slash = bare.indexOf("/");
        const host = slash === -1 ? bare : bare.slice(0, slash);
        const path = slash === -1 ? "" : bare.slice(slash);
        const hasPath = path !== "" && path !== "/" && path !== "/**";
        return [host.startsWith("*.") ? 1 : 2, hasPath ? 1 : 0, hasPath ? specificityOf(path) : 0, host.startsWith("*.") ? host.length - 1 : 0];
      }
      case "branch": {
        const { remote, branch } = splitRemote(text);
        return [isGlob(branch) ? 0 : 1, literalPrefixLength(branch), remote !== undefined ? 1 : 0];
      }
      default:
        return [isGlob(text) ? 0 : 1, literalPrefixLength(text)];
    }
  };
  return places
    .map((place, index) => ({ place, index, rank: own(place) }))
    .sort((a, b) => compareRank(b.rank, a.rank) || a.index - b.index)
    .map((entry) => entry.place);
}

// --- what a call is about ----------------------------------------------------

/**
 * The places one call to a standard tool is about, of its tool's kind (`ToolSpec.scope`), read off its
 * arguments: a path tool's {@link ToolSpec.pathArgs} (the project root when it names none, as a `glob`
 * with no folder walks the root — the reading `subjectsOf` gives the scope tables), a site tool's
 * {@link ToolSpec.urlArgs}, and any other kind's {@link ToolSpec.placeArgs} — a branch pushed
 * (`origin:main` where the call names its remote), a workflow started, a program named. Empty when
 * the call names no place of its kind that can be read (`git_push` with no branch: the current one is
 * the forge's to know), and the line's own mode — or the line below it — answers (§3.4).
 */
export function callPlacesOf(
  spec: Pick<ToolSpec, "scope" | "pathArgs" | "urlArgs" | "placeArgs"> | undefined,
  input: unknown,
  root?: string,
): string[] {
  if (spec?.scope === undefined) return [];
  const args: Record<string, unknown> = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const strings = (names: readonly string[] | undefined): string[] =>
    (names ?? []).flatMap((name) => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? [(args[name] as string).trim()] : []));
  if (spec.scope === "path") {
    const paths = strings(spec.pathArgs);
    return paths.length > 0 ? paths : root !== undefined && (spec.pathArgs ?? []).length > 0 ? [root] : [];
  }
  if (spec.scope === "site") return strings(spec.urlArgs);
  const named = strings(spec.placeArgs);
  if (spec.scope !== "branch") return named;
  const remote = typeof args["remote"] === "string" && args["remote"].trim() !== "" ? args["remote"].trim() : undefined;
  return named.map((branch) => (remote !== undefined && !branch.includes(":") ? `${remote}:${branch}` : branch));
}

// --- the widths an answer may be remembered at (§3.8) ---------------------------

/**
 * How far a remembered answer reaches over a place, narrowest first: `this` (the file, the page, the
 * branch, the name), its `folder`, the `package` (where a `package.json` is above), this `project`,
 * the `host`, its `parent` domain (`*.github.com`), a branch's `prefix` (`claude/**`), or `anywhere`.
 */
export type PlaceWidthName = "this" | "folder" | "package" | "project" | "host" | "parent" | "prefix" | "anywhere";

/** One width a place can be remembered at, and the place it writes — as a line would write it. */
export interface PlaceWidth {
  width: PlaceWidthName;
  place: string;
}

/** What {@link placeWidthsOf} reads a path against beyond {@link PlaceOptions}. */
export interface PlaceWidthOptions extends PlaceOptions {
  /** The folder of the nearest `package.json` at or above a path, when there is one — the filesystem's answer, handed in. */
  packageOf?: ((path: string) => string | undefined) | undefined;
}

/** A path as a line would write it: relative to the project where it lies inside, else as it is. */
function writtenPath(path: string, project: string | undefined, caseSensitive: boolean): string {
  if (project === undefined) return path;
  const fold = (s: string): string => (caseSensitive ? s : s.toLowerCase());
  const base = normalizePath(project);
  if (fold(path) === fold(base)) return "$PROJECT";
  return fold(path).startsWith(fold(`${base}/`)) ? path.slice(base.length + 1) : path;
}

/**
 * The widths the approval dialog offers for one place a call is about (§3.8), narrowest first, each
 * with the place it writes: a path's file (`packages/app/x.ts`), its folder (`packages/app`), its
 * package (the folder of the nearest `package.json`, from {@link PlaceWidthOptions.packageOf}), this
 * project (`$PROJECT`) and anywhere (`**`); a URL's page (`github.com/anthropics/x`), host
 * (`github.com`), `*.parent` (`*.github.com`, for a host under a domain of two labels or more — never
 * an address or `localhost`) and anywhere; a branch (`claude/x`), its prefix (`claude/**`) and any
 * branch. Pure: a width that would write the same place as a narrower one is left out, and a place
 * that cannot be read gives `anywhere` alone.
 */
export function placeWidthsOf(kind: PlaceKind, at: string, options: PlaceWidthOptions = {}): PlaceWidth[] {
  const out: PlaceWidth[] = [];
  const push = (width: PlaceWidthName, place: string | undefined): void => {
    if (place !== undefined && place !== "" && !out.some((w) => w.place === place)) out.push({ width, place });
  };
  switch (kind) {
    case "path": {
      const path = callPath(at, options);
      if (path === undefined) break;
      const project = options.named?.$PROJECT ?? options.root;
      const caseSensitive = options.caseSensitive === true;
      const inProject = project !== undefined && writtenPath(path, project, caseSensitive) !== path;
      push("this", writtenPath(path, project, caseSensitive));
      const slash = path.lastIndexOf("/");
      const folder = slash > 0 ? path.slice(0, slash) : undefined;
      if (folder !== undefined && !/^[a-zA-Z]:$/.test(folder)) push("folder", writtenPath(folder, project, caseSensitive));
      const pkg = options.packageOf?.(path);
      if (pkg !== undefined) push("package", writtenPath(collapseDots(normalizePath(pkg)), project, caseSensitive));
      if (inProject) push("project", "$PROJECT");
      break;
    }
    case "site": {
      const site = parseSite(at);
      if (site === undefined) break;
      const page = site.path.replace(/\/+$/, "");
      if (page !== "") push("this", `${site.host}${page}`);
      push("host", site.host);
      const labels = site.hostname.split(".");
      if (!isLocalOrAddress(site.hostname) && labels.length >= 3) push("parent", `*.${labels.slice(1).join(".")}`);
      break;
    }
    case "branch": {
      const { branch } = splitRemote(at.trim());
      push("this", at.trim());
      const slash = branch.lastIndexOf("/");
      if (slash > 0) push("prefix", `${branch.slice(0, slash)}/**`);
      break;
    }
    default:
      push("this", at.trim());
  }
  push("anywhere", PLACE_ANYWHERE);
  return out;
}
