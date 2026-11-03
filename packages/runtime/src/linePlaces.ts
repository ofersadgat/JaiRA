/**
 * Where a permission set line's PLACES are on this machine, and what they come to in an agent's own
 * rules (decision 0023 §3.2, §3.9).
 *
 * Two small pieces the policy, the gate and the agent wrapper all need, kept apart from `tools.ts` and
 * `agentTools.ts` so that neither has to import the other to reach them:
 *
 *  - {@link namedPlacesOf}: `$PROJECT`, `$WORKTREE`, `$TEMP` and `~`, as `places.ts` is handed them;
 *  - {@link compileClaudePlaceRules}: a kept built-in's place map, as Claude Code permission rules.
 */
import { homedir, tmpdir } from "node:os";
import {
  absolutize,
  isFunctionMode,
  NAMED_PLACES,
  nativesOfStandard,
  normalizePath,
  PLACE_ANYWHERE,
  TOOL_SPEC_BY_NAME,
  type AgentToolDeclaration,
  type PermissionSetMode,
  type PlaceOptions,
} from "@jaira/shared";

/**
 * Where `$PROJECT`, `$WORKTREE`, `$TEMP` and `~` are on this machine (decision 0023 §3.2): the
 * workspace a call runs in, the task's worktree (the workspace, where the task has none), the
 * system's temporary folder and the person's home — slashes forward, as places compare.
 */
export function namedPlacesOf(workspaceRoot: string | undefined, worktree?: string | undefined): NonNullable<PlaceOptions["named"]> {
  const slashed = (path: string): string => normalizePath(path);
  const tree = worktree ?? workspaceRoot;
  return {
    ...(workspaceRoot !== undefined ? { $PROJECT: slashed(workspaceRoot) } : {}),
    ...(tree !== undefined ? { $WORKTREE: slashed(tree) } : {}),
    $TEMP: slashed(tmpdir()),
    "~": slashed(homedir()),
  };
}

/** A path place as a rule's glob: named places expanded, relative ones against the root, a bare folder as all under it. `undefined` where it cannot be written. */
function pathGlobsOf(place: string, options: PlaceOptions): string[] | undefined {
  let text = place.trim();
  for (const name of NAMED_PLACES) {
    if (text !== name && !text.startsWith(`${name}/`) && !text.startsWith(`${name}\\`)) continue;
    const at = options.named?.[name] ?? (name === "$PROJECT" ? options.root : undefined);
    if (at === undefined) return undefined;
    text = `${at}${text.slice(name.length)}`;
    break;
  }
  const normalized = normalizePath(text);
  if (/[*?{]/.test(normalized)) {
    // `**/x` and a glob with no folder in it (`*.pem`) are anywhere on the disk, as `places.ts` reads them.
    const glob = normalized.startsWith("**/") ? normalized : !normalized.includes("/") ? `**/${normalized}` : absolutize(normalized, options.root);
    return [glob];
  }
  // A bare path is that file, or that folder and everything under it (ruling 3).
  const at = /^[a-zA-Z]:$/.test(normalized) ? normalized : absolutize(normalized, options.root);
  return [at, `${at.replace(/\/+$/, "")}/**`];
}

/** A site place as a rule's `domain:` — the bare host alone; a path or a wildcard host is left to the gate. */
function siteDomainOf(place: string): string | undefined {
  const text = place.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = text.indexOf("/");
  const host = slash === -1 ? text : text.slice(0, slash);
  const path = slash === -1 ? "" : text.slice(slash);
  if (host === "" || host.includes("*") || (path !== "" && path !== "/" && path !== "/**")) return undefined;
  return host.toLowerCase();
}

/**
 * A kept built-in's PLACE MAP, compiled into Claude Code's own permission rules (decision 0023 §3.9),
 * as `compileClaudeScopeRules` compiles the floor's table: `Read(<glob>)`, `Edit(<glob>)` and every other
 * native of a path tool for each path place, `WebFetch(domain:<host>)` for a site place naming a bare
 * host. A place whose decision is a FUNCTION is an ask rule — the callback is where it runs.
 *
 * SCOPED RULES ONLY, and never a line's `**`: Claude's precedence is `deny > ask > allow`, so a bare
 * rule would decide every call of the tool, and the bare ask the plan already writes for a kept native
 * (`askNatives`) is what routes the calls these rules do not decide to the gate, which judges them at
 * their places. So these bound the built-in up front — a `deny` at `**​/.env` refuses before anything is
 * asked — and the gate stays underneath for the rest. A place that cannot be written as a rule (a
 * named place this machine has no answer for, a site with a path, a wildcard host, a kind with no rule
 * syntax) is left out: the gate judges it, so leaving it out never widens.
 */
export function compileClaudePlaceRules(
  lines: Readonly<Record<string, Readonly<Record<string, PermissionSetMode>>>>,
  options: PlaceOptions & { declaration: AgentToolDeclaration },
): { allow: string[]; ask: string[]; deny: string[] } {
  const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  const push = (mode: PermissionSetMode, rule: string): void => {
    const list = isFunctionMode(mode) ? out.ask : mode === "allow" ? out.allow : mode === "ask" ? out.ask : out.deny;
    if (!list.includes(rule)) list.push(rule);
  };
  for (const [standard, places] of Object.entries(lines)) {
    const spec = TOOL_SPEC_BY_NAME.get(standard);
    const natives = nativesOfStandard(options.declaration, standard);
    if (spec?.scope === undefined || natives.length === 0) continue;
    for (const [place, mode] of Object.entries(places)) {
      if (place.trim() === PLACE_ANYWHERE) continue;
      if (spec.scope === "path") {
        for (const glob of pathGlobsOf(place, options) ?? []) for (const native of natives) push(mode, `${native}(${glob})`);
      } else if (spec.scope === "site") {
        const domain = siteDomainOf(place);
        if (domain !== undefined) for (const native of natives) push(mode, `${native}(domain:${domain})`);
      }
    }
  }
  return out;
}
