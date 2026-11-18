/**
 * A tool a project's setup asks for — `node` at `22`, `vips`, `python` through `uv` — checked and,
 * when it is not there at a version that fits, installed by the way this machine already uses for it.
 *
 * {@link checkTool} only looks: file checks, the tool's version command, and (for a way that runs as
 * root) whether sudo would ask for a password. {@link ensureTool} runs at most one installer — the
 * one the check would name — and looks again after.
 */
import { posix, win32 } from "node:path";
import type { ToolPackage } from "./catalog";
import { titleOf, toolPackageOf } from "./catalog";
import { expandDir, gatherInstallFacts, inGuest, installFactsOf, withoutApplePlaceholder, wslDirs, type InstallFacts, type InstallLookup } from "./locate";
import { toolPlans, type InstallPlan } from "./plan";
import { runPlan, waitForAppleInstall, type AppleWait, type InstallRunOptions } from "./run";
import { isAnyVersion, runVersion, versionSatisfies } from "./version";

/** A tool asked for. `version` is a version or a range (`22`, `>=3.9`, `lts`) — never a file name: the caller reads the file. */
export interface ToolRequest {
  tool: string;
  version?: string;
  /** The way it would rather go (`nvm`, `brew`, `uv`): first where this machine has it, else the usual choice. */
  through?: string;
}

/** What a look found for one request. */
export interface ToolCheck {
  tool: string;
  wanted?: string;
  /** The catalog knows this tool, so JaiRA can install it. */
  known: boolean;
  /** Where it is, and the version it says — `onPath` false for one found only where its installer keeps it. */
  found?: { path: string; version?: string; onPath?: boolean };
  /** Found, and the version fits. */
  satisfied: boolean;
  /** What {@link ensureTool} would run, when not satisfied. */
  plan?: { method: string; display: string; needsPassword?: boolean };
}

/** What {@link ensureTool} came to. `path` is where the tool is now; `onPath` false when only its folder reaches it. */
export type ToolOutcome =
  | { ok: true; already: boolean; path?: string; version?: string; onPath?: boolean }
  | { ok: false; reason: string; needsPassword?: boolean; command?: string };

type Found = { path: string; version?: string; onPath: boolean; broken: boolean };

interface Looked {
  pkg?: ToolPackage;
  facts: InstallFacts;
  found?: Found;
  satisfied: boolean;
  plans: InstallPlan[];
}

/** The tool's binaries: its own name, then the others it goes by. */
function namesOf(pkg: ToolPackage): string[] {
  return [pkg.binary, ...(pkg.also ?? [])];
}

/** Does this version fit what is wanted? Any version fits nothing asked; a version that could not be read fits only that. */
function fits(version: string | undefined, wanted: string | undefined): boolean {
  if (isAnyVersion(wanted)) return true;
  return version !== undefined && versionSatisfies(version, wanted!);
}

/**
 * Where the tool's binary is — by each name it goes by — with a Mac's placeholder seen for what it
 * is: past a placeholder (/usr/bin/python3 with no Command Line Tools) the usual places may still hold
 * the real one.
 */
async function locateTool(pkg: ToolPackage, lookup: InstallLookup): Promise<InstallFacts | undefined> {
  let first: InstallFacts | undefined;
  for (const name of namesOf(pkg)) {
    const facts = await gatherInstallFacts(name, pkg, lookup);
    if (facts === undefined) return first;
    let { facts: seen, placeholder } = await withoutApplePlaceholder(pkg, name, facts, lookup);
    if (placeholder) seen = installFactsOf(name, pkg, lookup.deps, { skip: (real) => real === `/usr/bin/${name}` });
    if (seen.found !== undefined) return seen;
    first ??= seen;
  }
  return first;
}

/** pkg-config, with a keg-only Homebrew library's own folder added where Homebrew keeps it (not inside WSL). */
function pkgConfigEnv(pkg: ToolPackage, facts: InstallFacts, lookup: InstallLookup): Record<string, string> | undefined {
  const brew = facts.tools.brew;
  if (inGuest(lookup) || brew === undefined || pkg.brew === undefined || !/\/bin\/brew$/.test(brew)) return undefined;
  const prefix = posix.dirname(posix.dirname(brew));
  const own = posix.join(prefix, "opt", pkg.brew.name.split("/").pop()!, "lib", "pkgconfig");
  const before = lookup.deps.env["PKG_CONFIG_PATH"];
  return { PKG_CONFIG_PATH: [own, ...(before !== undefined && before.length > 0 ? [before] : [])].join(":") };
}

/** A native library, by pkg-config: there or not, its version, and the `.pc` file that says so. */
async function locateLibrary(pkg: ToolPackage, lookup: InstallLookup): Promise<{ facts: InstallFacts; found?: Found } | undefined> {
  const looked = await gatherInstallFacts("pkg-config", pkg, lookup);
  if (looked === undefined) return undefined;
  // What was found is pkg-config itself, not the library.
  const { found: _pkgConfig, ...facts } = looked;
  const pc = facts.tools["pkg-config"];
  if (pc === undefined) return { facts };
  const env = pkgConfigEnv(pkg, facts, lookup);
  const ask = async (args: string[]): Promise<{ code: number | null; stdout: string } | undefined> => {
    try {
      const result = await lookup.exec.run(pc, [...args, pkg.pkgConfig!], {
        ...(lookup.execEnv !== undefined ? { execEnv: lookup.execEnv } : {}),
        ...(env !== undefined ? { env } : {}),
        timeoutMs: lookup.timeoutMs ?? 10_000,
        stdin: "",
      });
      return { code: result.code, stdout: result.stdout.trim() };
    } catch {
      return undefined;
    }
  };
  const exists = await ask(["--exists"]);
  if (exists?.code !== 0) return { facts };
  const version = (await ask(["--modversion"]))?.stdout;
  const dir = (await ask(["--variable=pcfiledir"]))?.stdout;
  const path = dir !== undefined && dir.length > 0 ? posix.join(dir, `${pkg.pkgConfig}.pc`) : pkg.pkgConfig!;
  return { facts, found: { path, ...(version !== undefined && version.length > 0 ? { version } : {}), onPath: true, broken: false } };
}

/**
 * A copy of the tool that fits, in the folders installs land in (a keg-only formula's, a version
 * manager's versions) — what a look finds after an install that put it beside, not over, the one the
 * PATH reaches. Newest first.
 */
async function findInLands(pkg: ToolPackage, specs: readonly string[], wanted: string | undefined, lookup: InstallLookup, facts: InstallFacts): Promise<Found | undefined> {
  if (specs.length === 0) return undefined;
  const wsl = inGuest(lookup);
  const dirs = wsl ? await wslDirs(specs, lookup) : [...new Set(specs.flatMap((spec) => expandDir(spec, lookup.deps)))];
  const path = facts.platform === "win32" ? win32 : posix;
  const exts = facts.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    for (const name of namesOf(pkg)) {
      for (const ext of exts) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (!wsl && !lookup.deps.isFile(candidate)) continue;
        const version = await runVersion(candidate, pkg.version, lookup);
        if (version === undefined && wsl) continue;
        if (fits(version, wanted)) return { path: candidate, ...(version !== undefined ? { version } : {}), onPath: false, broken: false };
        break;
      }
    }
  }
  return undefined;
}

/** Look at one request: where the tool is, its version, whether it fits, and what would install it. */
async function look(req: ToolRequest, lookup: InstallLookup, landsFirst: readonly string[] = []): Promise<Looked | undefined> {
  const pkg = toolPackageOf(req.tool);
  if (pkg === undefined) {
    // Not one JaiRA installs — but it may be here all the same, which is all an unversioned request needs.
    const bare: ToolPackage = { binary: req.tool, order: [] };
    const facts = await gatherInstallFacts(req.tool, bare, lookup);
    if (facts === undefined) return undefined;
    const found = facts.found !== undefined ? { path: facts.found.path, onPath: facts.found.onPath, broken: facts.found.broken } : undefined;
    return { facts, ...(found !== undefined ? { found } : {}), satisfied: found !== undefined && !found.broken && isAnyVersion(req.version), plans: [] };
  }

  let facts: InstallFacts;
  let found: Found | undefined;
  if (pkg.pkgConfig !== undefined) {
    const library = await locateLibrary(pkg, lookup);
    if (library === undefined) return undefined;
    facts = library.facts;
    found = library.found;
  } else {
    const located = await locateTool(pkg, lookup);
    if (located === undefined) return undefined;
    facts = located;
    const at = facts.found;
    if (at !== undefined) {
      const version = at.broken ? undefined : await runVersion(at.path, pkg.version, lookup);
      found = { path: at.path, ...(version !== undefined ? { version } : {}), onPath: at.onPath, broken: at.broken };
    }
  }

  if (found !== undefined && !found.broken && fits(found.version, req.version)) return { pkg, facts, found, satisfied: true, plans: [] };
  const plans = toolPlans(pkg, facts, { ...(req.version !== undefined ? { version: req.version } : {}), ...(req.through !== undefined ? { through: req.through } : {}) });
  // Installed already beside the one found — by an earlier setup, or by hand — where an install would put it.
  if (pkg.pkgConfig === undefined) {
    const lands = [...landsFirst, ...plans.flatMap((one) => one.lands ?? [])];
    const beside = await findInLands(pkg, lands, req.version, lookup, facts);
    if (beside !== undefined) return { pkg, facts, found: beside, satisfied: true, plans: [] };
  }
  return { pkg, facts, ...(found !== undefined ? { found } : {}), satisfied: false, plans };
}

/** Would sudo ask for a password here? `sudo -n` fails at once rather than ask. */
async function sudoAsks(facts: InstallFacts, lookup: InstallLookup): Promise<boolean> {
  if (facts.root === true) return false;
  try {
    const result = await lookup.exec.run(facts.tools.sudo ?? "sudo", ["-n", "true"], {
      ...(lookup.execEnv !== undefined ? { execEnv: lookup.execEnv } : {}),
      timeoutMs: lookup.timeoutMs ?? 10_000,
      stdin: "",
    });
    return result.code !== 0;
  } catch {
    return true;
  }
}

function foundOf(found: Found | undefined): ToolCheck["found"] | undefined {
  return found === undefined ? undefined : { path: found.path, ...(found.version !== undefined ? { version: found.version } : {}), onPath: found.onPath };
}

/**
 * Check a tool without installing anything: whether the catalog knows it, where it is and which
 * version, whether that fits, and — when it does not — what {@link ensureTool} would run, marked
 * `needsPassword` when that runs through sudo and sudo would ask here.
 */
export async function checkTool(req: ToolRequest, opts: InstallLookup): Promise<ToolCheck> {
  const base = { tool: req.tool, ...(req.version !== undefined ? { wanted: req.version } : {}), known: toolPackageOf(req.tool) !== undefined };
  const looked = await look(req, opts);
  if (looked === undefined) return { ...base, satisfied: false };
  const found = foundOf(looked.found);
  const chosen = looked.satisfied ? undefined : looked.plans[0];
  const needsPassword = chosen?.sudo === true && (await sudoAsks(looked.facts, opts));
  return {
    ...base,
    ...(found !== undefined ? { found } : {}),
    satisfied: looked.satisfied,
    ...(chosen !== undefined ? { plan: { method: chosen.method, display: chosen.display, ...(needsPassword ? { needsPassword: true } : {}) } } : {}),
  };
}

/** The words for a tool at a version: `node 22`, `vips`. */
function spoken(req: ToolRequest, pkg: ToolPackage | undefined): string {
  const name = pkg !== undefined ? titleOf(pkg) : req.tool;
  return req.version !== undefined && !isAnyVersion(req.version) ? `${name} ${req.version}` : name;
}

/** sudo's own words for wanting a password it could not ask for. */
const SUDO_ASKED = /a password is required|a terminal is required|no tty present|no askpass program/i;

/**
 * Make sure a tool is here at a version that fits: nothing runs when it already is (`already`);
 * otherwise the one installer {@link checkTool} names runs, its output streamed to `onOutput` after
 * the command, and the tool is looked for again. A way that needs sudo's password here is not run —
 * the answer says so, with the command to run on that machine.
 */
export async function ensureTool(req: ToolRequest, opts: InstallRunOptions & { wait?: AppleWait }): Promise<ToolOutcome> {
  const before = await look(req, opts);
  if (before === undefined) return { ok: false, reason: `could not look for ${req.tool} where it runs` };
  const ok = (already: boolean, found: Found | undefined): ToolOutcome => ({
    ok: true,
    already,
    ...(found !== undefined ? { path: found.path, ...(found.version !== undefined ? { version: found.version } : {}), onPath: found.onPath } : {}),
  });
  if (before.satisfied) return ok(true, before.found);
  const pkg = before.pkg;
  const what = spoken(req, pkg);
  if (pkg === undefined) return { ok: false, reason: `JaiRA does not know how to install ${req.tool}` };
  const chosen = before.plans[0];
  if (chosen === undefined) {
    const there = before.found !== undefined && !before.found.broken ? ` — ${before.found.path} is ${before.found.version ?? "a version it would not say"}` : "";
    return { ok: false, reason: `nothing on this machine installs ${what}${there}` };
  }
  const password = (): ToolOutcome => ({
    ok: false,
    reason: `installing ${what} needs a password for sudo on this machine — run this there: ${chosen.display}`,
    needsPassword: true,
    command: chosen.display,
  });
  if (chosen.sudo === true && (await sudoAsks(before.facts, opts))) return password();

  const ran = await runPlan(chosen, opts, "install");
  if (!ran.ok) {
    if (chosen.sudo === true && SUDO_ASKED.test(`${ran.stderr ?? ""}\n${ran.reason}`)) return password();
    return { ok: false, reason: ran.reason };
  }
  if (chosen.method === "command-line-tools") {
    const waited = await waitForAppleInstall(pkg, pkg.binary, opts, opts.wait);
    if (waited !== undefined && !waited.ok) return { ok: false, reason: waited.reason };
  }
  const after = await look(req, opts, chosen.lands ?? []);
  if (after?.satisfied === true) return ok(false, after.found);
  const now = after?.found !== undefined && !after.found.broken ? ` — ${after.found.path} is ${after.found.version ?? "a version it would not say"}` : "";
  return { ok: false, reason: `'${chosen.display}' finished, but ${what} is still not here${now}` };
}
