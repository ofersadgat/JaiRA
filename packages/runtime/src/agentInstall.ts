/**
 * Installing and updating the coding agents JaiRA drives — `claude`, `codex`, `gemini`, `agy`, `muse`
 * and `opencode` — and the git programs it checks beside them (`git`, `gh`, `glab`: {@link GIT_CLI_PACKAGES}).
 *
 * Each has several installers, and they do not mix: `claude update` on a Homebrew cask is refused,
 * `npm i -g` beside the native build leaves two binaries that disagree about which one is current, and
 * under nvm the `npm` on the PATH may belong to another Node than the one the agent was installed
 * with. So the way an agent was installed is read off WHERE ITS BINARY LIVES — a Homebrew Caskroom, a
 * global `node_modules`, the native installer's directory — and the update goes back through the same
 * installer, by the same program, that put it there. A path that says nothing known is no update at
 * all, rather than a guess.
 *
 * Nothing here runs at a probe but lookups: where the binary is and which installers this machine has
 * are file checks (or, inside WSL, one `sh`). What installs or updates is run only when a person
 * presses the button, and what runs is decided here, from what was found — the window only names the
 * agent and the way.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { AgentInstall, AgentInstallCommand, AgentInstallMethod, AgentInstallOutcome, ExecutorInfo, ExecutorKind, GitCliName } from "@jaira/shared";
import type { Exec } from "./exec";
import { isWslEnv, type ExecEnv } from "./paths";

/** Where an agent comes from, for each way it can be installed. */
export interface AgentPackage {
  /** The command its installers put on the PATH — what an executor's command is matched by. */
  binary: string;
  /**
   * Its npm package, which Bun and pnpm install too; `also` are the names it shipped under before,
   * read when classifying an install so an old one updates as the package it is.
   */
  npm?: { name: string; also?: readonly string[] };
  /** Its Homebrew package: a cask (macOS only) or a formula (macOS and Linux), by the name `brew install` takes. */
  brew?: { name: string; cask: boolean };
  /** Its WinGet package id. */
  winget?: string;
  /** Its Chocolatey package id. Chocolatey installs into a machine-wide folder, so it runs as administrator. */
  choco?: string;
  /** Its Scoop package, by the name `scoop install` takes — `extras/…` for one in the extras bucket, added first. */
  scoop?: string;
  /** Apple's Command Line Tools ship it: git, which a Mac has only as a placeholder until they are installed. */
  xcode?: boolean;
  /**
   * The vendor's own installer: its script, where it puts the binary (what classifies an install as
   * its), and the binary's own updater — absent where there is none, and the script is run again.
   */
  native?: { posix?: string; windows?: string; paths: readonly RegExp[]; update?: readonly string[] };
  /** The ways it is offered when it is not installed, in the vendor's order of recommendation. */
  order: readonly AgentInstallMethod[];
}

/**
 * The agents JaiRA can install, as their vendors ship them (observed 2026-11):
 *
 *  - Claude Code: Anthropic recommends its native installer, which updates itself (`claude update` asks
 *    now); a Homebrew cask (`claude-code`, or `claude-code@latest`), WinGet and npm besides.
 *  - Codex: npm, and a Homebrew cask.
 *  - Gemini CLI: npm, and a Homebrew formula.
 *  - Muse Code (Meta): its install script, which puts a self-updating launcher in `~/.local/bin`, and
 *    a Homebrew cask. No npm package, and no Windows build (WSL2 is the way there).
 *  - OpenCode: its install script (`~/.opencode/bin`, updated by `opencode upgrade`), npm (`@opencode/cli`
 *    since v2, `opencode-ai` before), and its own Homebrew tap.
 *  - Antigravity CLI (Google, `agy`): its install script only — `~/.local/bin/agy`, or
 *    `%LOCALAPPDATA%\agy\bin` on Windows — which installs the latest when run again. (Homebrew's
 *    `antigravity` is the desktop app, not this.)
 *
 * On Windows, beside the vendors' own ways (checked 2026-11-17): WinGet has Claude Code (Anthropic's docs
 * name it), Codex and OpenCode v2; Chocolatey has Claude Code and Codex, and Scoop's main bucket all
 * three — community packages, kept current, offered after the vendor's. Chocolatey's `claude` and
 * Scoop's extras `claude` are Claude's desktop app; Chocolatey's `gemini-cli` is months behind, and its
 * `opencode` is v1. None of them is offered.
 */
export const AGENT_PACKAGES: Readonly<Record<string, AgentPackage>> = {
  claude: {
    binary: "claude",
    npm: { name: "@anthropic-ai/claude-code" },
    brew: { name: "claude-code", cask: true },
    winget: "Anthropic.ClaudeCode",
    choco: "claude-code",
    scoop: "claude-code",
    native: {
      posix: "curl -fsSL https://claude.ai/install.sh | bash",
      windows: "irm https://claude.ai/install.ps1 | iex",
      paths: [/\/\.local\/share\/claude\//, /\/\.claude\/local\//, /\/\.local\/bin\/claude\.exe$/i],
      update: ["update"],
    },
    order: ["native", "homebrew", "winget", "npm", "chocolatey", "scoop"],
  },
  codex: {
    binary: "codex",
    npm: { name: "@openai/codex" },
    brew: { name: "codex", cask: true },
    winget: "OpenAI.Codex",
    choco: "codex",
    scoop: "codex",
    order: ["npm", "homebrew", "winget", "chocolatey", "scoop"],
  },
  gemini: {
    binary: "gemini",
    npm: { name: "@google/gemini-cli" },
    brew: { name: "gemini-cli", cask: false },
    order: ["npm", "homebrew"],
  },
  muse: {
    binary: "muse",
    brew: { name: "muse-code", cask: true },
    // A launcher at ~/.local/bin/muse, the build beside it as muse-bin-<version>.
    native: { posix: "curl -fsSL https://dev.meta.ai/install.sh | bash", paths: [/\/\.local\/bin\/muse(-bin-[^/]*)?$/] },
    order: ["native", "homebrew"],
  },
  opencode: {
    binary: "opencode",
    npm: { name: "@opencode/cli", also: ["opencode-ai"] },
    brew: { name: "anomalyco/tap/opencode-v2", cask: false },
    // v2 both: Chocolatey's `opencode` is still v1, and its `opencode2` too new to lean on.
    winget: "Anomaly.OpenCode",
    scoop: "opencode",
    native: { posix: "curl -fsSL https://opencode.ai/v2/install | bash", paths: [/\/\.opencode\/bin\//], update: ["upgrade"] },
    order: ["native", "npm", "homebrew", "winget", "scoop"],
  },
  antigravity: {
    binary: "agy",
    native: {
      posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      windows: "irm https://antigravity.google/cli/install.ps1 | iex",
      paths: [/\/\.local\/bin\/agy$/, /\/AppData\/Local\/agy\/bin\//i],
    },
    order: ["native"],
  },
};

/**
 * The git programs JaiRA checks (Settings → Connections → Git), as their makers and the package
 * managers ship them (observed 2026-11):
 *
 *  - git: on a Mac, Apple's Command Line Tools — /usr/bin/git is a placeholder that opens their
 *    installer until they are there — and Homebrew's formula. On Windows, Git for Windows by WinGet,
 *    Chocolatey or Scoop: the first two run its own installer into Program Files, which says nothing of
 *    which of them ran it, so that git has no Update here. On Linux, Homebrew's formula where there is
 *    one; the distribution's own package needs root, which the person runs themselves.
 *  - gh (GitHub CLI) and glab (GitLab CLI): Homebrew formulae, and a package in each Windows manager.
 */
export const GIT_CLI_PACKAGES: Readonly<Record<GitCliName, AgentPackage>> = {
  git: {
    binary: "git",
    brew: { name: "git", cask: false },
    winget: "Git.Git",
    choco: "git",
    scoop: "git",
    xcode: true,
    order: ["command-line-tools", "homebrew", "winget", "chocolatey", "scoop"],
  },
  gh: {
    binary: "gh",
    brew: { name: "gh", cask: false },
    winget: "GitHub.cli",
    choco: "gh",
    scoop: "gh",
    order: ["homebrew", "winget", "chocolatey", "scoop"],
  },
  glab: {
    binary: "glab",
    brew: { name: "glab", cask: false },
    winget: "GLab.GLab",
    choco: "glab",
    scoop: "glab",
    order: ["homebrew", "winget", "chocolatey", "scoop"],
  },
};

/** Where Windows installers put the git programs that do not add a folder of their own to a usual place. */
const WINDOWS_PROGRAM_DIRS = ["GitHub CLI", "glab"] as const;

/** The way, as a person names it — for an update by the binary's own updater, see {@link planOf}. */
const VIA: Record<AgentInstallMethod, string> = {
  native: "the native installer",
  homebrew: "Homebrew",
  npm: "npm",
  bun: "Bun",
  pnpm: "pnpm",
  winget: "WinGet",
  chocolatey: "Chocolatey",
  scoop: "Scoop",
  "command-line-tools": "Apple's Command Line Tools",
};

// --- where the binary is ------------------------------------------------------------------------

/** The binary as found. */
export interface FoundBinary {
  /** Where it was found: a PATH entry, a usual place, or the path config names. */
  path: string;
  /** What that resolves to through every link — where its installer actually put it. */
  real: string;
  /** Reached by the bare command from this app — false for one found only in a usual place. */
  onPath: boolean;
  /** A link whose target is gone. */
  broken: boolean;
}

/** The installers a machine offers, by the program that runs each. */
export type InstallTool = "brew" | "npm" | "bun" | "pnpm" | "winget" | "choco" | "scoop" | "powershell" | "curl" | "bash" | "xcode-select";

/** What a machine — or a WSL distro — says about one agent: where it is and what can install it. */
export interface InstallFacts {
  platform: "darwin" | "linux" | "win32";
  home: string;
  found?: FoundBinary;
  tools: Partial<Record<InstallTool, string>>;
  /** Is there a program at this path? Absent (inside WSL) is taken as yes — the run says otherwise. */
  has?: (path: string) => boolean;
}

/** The file system and environment, as the lookups below need them — injected so a test is a table. */
export interface InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  pathDirs: readonly string[];
  /** The environment variables a usual place is spelled with on Windows (APPDATA, LOCALAPPDATA). */
  env: Readonly<Record<string, string | undefined>>;
  /** Anything at all at this path — a dangling link included. */
  lexists: (path: string) => boolean;
  /** Where the path resolves to through every link; undefined when the target is gone. */
  realpath: (path: string) => string | undefined;
  /** What a link names, for one whose target is gone. */
  readlink: (path: string) => string | undefined;
  /** A file (after links) — what a shell would run. */
  isFile: (path: string) => boolean;
}

/** This process's machine. */
export function nodeInstallDeps(): InstallDeps {
  const platform = process.platform;
  return {
    platform,
    home: homedir(),
    pathDirs: (process.env["PATH"] ?? "").split(platform === "win32" ? ";" : ":").filter((dir) => dir.length > 0),
    env: process.env,
    lexists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    readlink: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return undefined;
      }
    },
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  };
}

function pathModule(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Where each installer puts its binaries when the PATH this app was started with does not say. */
function usualDirs(deps: InstallDeps): string[] {
  const path = pathModule(deps.platform);
  if (deps.platform === "win32") {
    // An installer that adds its folder to the PATH changes it for programs started AFTER it: this app,
    // started before, finds what it installed only here.
    const programFiles = deps.env["ProgramFiles"] ?? "C:\\Program Files";
    const programData = deps.env["ProgramData"] ?? "C:\\ProgramData";
    const localAppData = deps.env["LOCALAPPDATA"];
    return [
      path.join(deps.home, ".local", "bin"),
      ...(deps.env["APPDATA"] !== undefined ? [path.join(deps.env["APPDATA"], "npm")] : []),
      ...(localAppData !== undefined ? [path.join(localAppData, "Microsoft", "WinGet", "Links"), path.join(localAppData, "agy", "bin")] : []),
      // WinGet's machine-wide links; Chocolatey's shims; Scoop's, the person's and the machine-wide.
      path.join(programFiles, "WinGet", "Links"),
      path.join(deps.env["ChocolateyInstall"] ?? path.join(programData, "chocolatey"), "bin"),
      path.join(deps.env["SCOOP"] ?? path.join(deps.home, "scoop"), "shims"),
      path.join(programData, "scoop", "shims"),
      // Git for Windows, however it was installed (WinGet and Chocolatey both run its own installer) —
      // in Program Files, or the person's own Programs when Program Files was not writable.
      path.join(programFiles, "Git", "cmd"),
      ...(localAppData !== undefined ? [path.join(localAppData, "Programs", "Git", "cmd")] : []),
      // The GitHub CLI's MSI, and the GitLab CLI's installer machine-wide or for the person.
      ...WINDOWS_PROGRAM_DIRS.map((dir) => path.join(programFiles, dir)),
      ...(localAppData !== undefined ? [path.join(localAppData, "Programs", "glab")] : []),
    ];
  }
  // A Mac app started from the Finder gets launchd's PATH — /usr/bin:/bin:/usr/sbin:/sbin — which
  // reaches none of these.
  return [
    path.join(deps.home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    path.join(deps.home, ".bun", "bin"),
    path.join(deps.home, ".npm-global", "bin"),
    path.join(deps.home, ".opencode", "bin"),
  ];
}

/** The names a command may have on disk: itself, and on Windows each runnable extension. */
function namesOf(command: string, platform: string): string[] {
  if (platform !== "win32" || /\.[a-z0-9]+$/i.test(command)) return [command];
  return [".exe", ".cmd", ".bat", ".com"].map((ext) => `${command}${ext}`);
}

/**
 * Look a command up the way a shell would — the first runnable one on the PATH — then, failing that,
 * in the usual places. A dangling link is not runnable, so the search goes past it; it is reported
 * only when nothing runnable turns up anywhere, since then it IS the install, half-removed.
 */
export function locateBinary(command: string, deps: InstallDeps): FoundBinary | undefined {
  const path = pathModule(deps.platform);
  const named = command.includes("/") || command.includes("\\");
  let broken: FoundBinary | undefined;
  const look = (candidate: string, onPath: boolean): FoundBinary | undefined => {
    if (!deps.lexists(candidate)) return undefined;
    const real = deps.realpath(candidate);
    if (real !== undefined) return deps.isFile(candidate) ? { path: candidate, real, onPath, broken: false } : undefined;
    const target = deps.readlink(candidate);
    broken ??= { path: candidate, real: target !== undefined ? path.resolve(path.dirname(candidate), target) : candidate, onPath, broken: true };
    return undefined;
  };
  // A configured path is what runs, so "on the PATH" is beside the point: it is reached.
  const searches: Array<{ dirs: readonly string[]; onPath: boolean }> = named
    ? [{ dirs: [""], onPath: true }]
    : [
        { dirs: deps.pathDirs, onPath: true },
        { dirs: usualDirs(deps).filter((dir) => !deps.pathDirs.includes(dir)), onPath: false },
      ];
  for (const { dirs, onPath } of searches) {
    for (const dir of dirs) {
      for (const name of namesOf(command, deps.platform)) {
        const hit = look(dir === "" ? name : path.join(dir, name), onPath);
        if (hit !== undefined) return hit;
      }
    }
  }
  return broken;
}

/** Every installer this machine has, found as the agent is (PATH first, then the usual places). */
function locateTools(deps: InstallDeps): Partial<Record<InstallTool, string>> {
  const tools: Partial<Record<InstallTool, string>> = {};
  const names: InstallTool[] =
    deps.platform === "win32"
      ? ["npm", "bun", "pnpm", "winget", "choco", "scoop", "powershell"]
      : ["brew", "npm", "bun", "pnpm", "curl", "bash", ...(deps.platform === "darwin" ? (["xcode-select"] as const) : [])];
  for (const name of names) {
    const found = locateBinary(name, deps);
    if (found !== undefined && !found.broken) tools[name] = found.path;
  }
  return tools;
}

/**
 * An npm shim on Windows is a `.cmd` file and no link, so its path says nothing — the package it runs
 * sits beside it, in the `node_modules` of the same prefix, and that is what is classified.
 */
function shimPackage(found: FoundBinary, pkg: AgentPackage, deps: InstallDeps): FoundBinary {
  if (deps.platform !== "win32" || !/\.(cmd|ps1)$/i.test(found.path)) return found;
  for (const name of npmNames(pkg)) {
    const dir = win32.join(win32.dirname(found.path), "node_modules", ...name.split("/"));
    if (deps.lexists(dir)) return { ...found, real: dir };
  }
  return found;
}

/** Every name the package's npm releases have gone by, the current one first. */
function npmNames(pkg: AgentPackage): string[] {
  return pkg.npm === undefined ? [] : [pkg.npm.name, ...(pkg.npm.also ?? [])];
}

/** What this machine says about one agent. */
export function installFactsOf(command: string, pkg: AgentPackage, deps: InstallDeps): InstallFacts {
  const found = locateBinary(command, deps);
  return {
    platform: deps.platform === "win32" ? "win32" : deps.platform === "darwin" ? "darwin" : "linux",
    home: deps.home,
    ...(found !== undefined ? { found: shimPackage(found, pkg, deps) } : {}),
    tools: locateTools(deps),
    has: deps.isFile,
  };
}

/**
 * The same, asked inside a WSL distro — where the agent runs when the project does. One `sh` reports
 * what `command -v` finds and where it resolves to; a dangling link is not reported there.
 */
const WSL_FACTS = [
  'n="$1"',
  'p=$(command -v "$n" 2>/dev/null)',
  'if [ -n "$p" ]; then printf "found\\t%s\\t%s\\n" "$p" "$(readlink -f "$p" 2>/dev/null || printf %s "$p")"; else',
  '  for d in "$HOME/.local/bin" /home/linuxbrew/.linuxbrew/bin "$HOME/.bun/bin" "$HOME/.npm-global/bin" "$HOME/.opencode/bin"; do',
  '    if [ -x "$d/$n" ]; then printf "usual\\t%s\\t%s\\n" "$d/$n" "$(readlink -f "$d/$n" 2>/dev/null || printf %s "$d/$n")"; break; fi',
  "  done",
  "fi",
  'for t in brew npm bun pnpm curl bash; do q=$(command -v "$t" 2>/dev/null) && printf "tool\\t%s\\t%s\\n" "$t" "$q"; done',
  'printf "home\\t%s\\n" "$HOME"',
].join("\n");

/** Read {@link WSL_FACTS}' answer. */
export function parseWslFacts(stdout: string): InstallFacts {
  const facts: InstallFacts = { platform: "linux", home: "", tools: {} };
  for (const line of stdout.split(/\r?\n/)) {
    const [key, a, b] = line.split("\t");
    if ((key === "found" || key === "usual") && a !== undefined && a.length > 0) facts.found = { path: a, real: b || a, onPath: key === "found", broken: false };
    else if (key === "tool" && a !== undefined && b !== undefined && b.length > 0) facts.tools[a as InstallTool] = b;
    else if (key === "home" && a !== undefined) facts.home = a;
  }
  return facts;
}

export interface InstallLookup {
  exec: Exec;
  execEnv?: ExecEnv;
  deps: InstallDeps;
  timeoutMs?: number;
}

/** What the machine the agent runs on says about it — this one, or the WSL distro config names. */
export async function gatherInstallFacts(command: string, pkg: AgentPackage, lookup: InstallLookup): Promise<InstallFacts | undefined> {
  if (lookup.execEnv === undefined || !isWslEnv(lookup.execEnv)) return installFactsOf(command, pkg, lookup.deps);
  try {
    const result = await lookup.exec.run("sh", ["-c", WSL_FACTS, "sh", command], { execEnv: lookup.execEnv, timeoutMs: lookup.timeoutMs ?? 10_000 });
    return result.code === 0 ? parseWslFacts(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

// --- how it was installed -----------------------------------------------------------------------

/** How a binary was installed, read off where it really lives, with what the update needs from there. */
export interface InstallOrigin {
  method: AgentInstallMethod;
  /** The installer's own prefix, for the program that updates it: Homebrew's, npm's. */
  prefix?: string;
  /** A Homebrew cask's or formula's name, and which of the two. */
  name?: string;
  formula?: boolean;
  /** The npm package it was installed as — an old name updates as itself. */
  npmName?: string;
}

/** Read an install's way off the path its binary resolves to; undefined when the path says nothing known. */
export function installOriginOf(real: string, pkg: AgentPackage): InstallOrigin | undefined {
  const p = real.replace(/\\/g, "/");
  const brew = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\//.exec(p);
  if (brew !== null) return { method: "homebrew", prefix: brew[1]!, name: brew[3]!, formula: brew[2] === "Cellar" };
  if (/\/WinGet\/(Packages|Links)\//i.test(p)) return { method: "winget" };
  if (/\/chocolatey\/(lib|bin)\//i.test(p)) return { method: "chocolatey" };
  if (/\/scoop\/(apps|shims)\//i.test(p)) return { method: "scoop" };
  // Apple's own git, read where /usr/bin/git hands over to (`gitClis.ts`): the Command Line Tools'. Xcode's
  // says nothing JaiRA could install or update it by.
  if (pkg.xcode === true && /^\/Library\/Developer\/CommandLineTools\//.test(p)) return { method: "command-line-tools" };
  if (pkg.native?.paths.some((path) => path.test(p)) === true) return { method: "native" };
  const npmName = npmNames(pkg).find((name) => p.includes(`/node_modules/${name}/`) || p.endsWith(`/node_modules/${name}`));
  if (npmName === undefined) return undefined;
  if (/\/\.bun\/install\/global\//.test(p)) return { method: "bun", npmName };
  if (/\/pnpm\/global\//i.test(p) || /\/\.pnpm-global\//.test(p)) return { method: "pnpm", npmName };
  // POSIX keeps a global package in <prefix>/lib/node_modules, Windows in <prefix>\node_modules.
  const before = p.slice(0, p.indexOf(`/node_modules/${npmName}`));
  return { method: "npm", prefix: before.endsWith("/lib") ? before.slice(0, -4) : before, npmName };
}

// --- what installs or updates it ----------------------------------------------------------------

/** One command, as shown and as run. */
export interface InstallPlan extends AgentInstallCommand {
  file: string;
  args: string[];
  /** Laid over the environment it runs in. */
  env?: Record<string, string>;
}

/**
 * A package manager's own program run with its directory first on the PATH: npm is `#!/usr/bin/env
 * node`, and the node it should find is the one it came with, not whichever the app's PATH reaches.
 */
function withDirOnPath(file: string, platform: string): Record<string, string> | undefined {
  if (platform === "win32" || !file.includes("/")) return undefined;
  const dir = posix.dirname(file);
  return { PATH: [dir, ...(process.env["PATH"] ?? "").split(":").filter((one) => one.length > 0 && one !== dir)].join(":") };
}

function plan(method: AgentInstallMethod, via: string, file: string, args: string[], display: string, platform: string): InstallPlan {
  const env = withDirOnPath(file, platform);
  return { method, via, display, file, args, ...(env !== undefined ? { env } : {}) };
}

/** The native installer: its script, run the way its page says to — where the vendor ships one for this system. */
function nativeInstall(pkg: AgentPackage, facts: InstallFacts): InstallPlan | undefined {
  const native = pkg.native;
  if (native === undefined) return undefined;
  if (facts.platform === "win32") {
    if (native.windows === undefined) return undefined;
    return plan("native", VIA.native, facts.tools.powershell ?? "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", native.windows], native.windows, facts.platform);
  }
  if (native.posix === undefined || facts.tools.curl === undefined) return undefined;
  return plan("native", VIA.native, facts.tools.bash ?? "bash", ["-c", native.posix], native.posix, facts.platform);
}

/**
 * Which program runs an installer: the one the install itself names (`own`, when it is there), else
 * the one found. On Windows the bare name, since the `.cmd` shim resolution needs a name to look up.
 */
function program(facts: InstallFacts, tool: InstallTool, own?: string): string | undefined {
  if (facts.platform === "win32") return facts.tools[tool] !== undefined ? tool : own;
  return own !== undefined && (facts.has?.(own) ?? true) ? own : facts.tools[tool];
}

/**
 * The update for an agent installed this way — or, for a broken one, the reinstall — and undefined when
 * the way is unknown or its installer cannot be found.
 */
function updatePlan(pkg: AgentPackage, facts: InstallFacts, origin: InstallOrigin): InstallPlan | undefined {
  const found = facts.found!;
  const { platform } = facts;
  switch (origin.method) {
    case "native": {
      const own = pkg.native?.update;
      if (!found.broken && own !== undefined) return plan("native", "its own updater", found.path, [...own], [pkg.binary, ...own].join(" "), platform);
      // No updater of its own (Muse's launcher updates itself, and its script installs the latest), or
      // a broken install with no binary left to ask: the installer, again.
      return nativeInstall(pkg, facts);
    }
    case "homebrew": {
      // The brew of the prefix it was installed under — Apple silicon and Intel keep one each.
      const brew = program(facts, "brew", origin.prefix !== undefined ? posix.join(origin.prefix, "bin", "brew") : undefined);
      if (brew === undefined || origin.name === undefined) return undefined;
      const verb = found.broken ? "reinstall" : "upgrade";
      const args = origin.formula === true ? [verb, origin.name] : [verb, "--cask", origin.name];
      return plan("homebrew", VIA.homebrew, brew, args, ["brew", ...args].join(" "), platform);
    }
    case "npm": {
      // The npm of the prefix it was installed under: under nvm, every Node has its own.
      const own = origin.prefix !== undefined && platform !== "win32" ? posix.join(origin.prefix, "bin", "npm") : undefined;
      const npm = program(facts, "npm", own);
      if (npm === undefined || origin.npmName === undefined) return undefined;
      const args = ["install", "-g", `${origin.npmName}@latest`];
      return plan("npm", VIA.npm, npm, args, ["npm", ...args].join(" "), platform);
    }
    case "bun": {
      const bun = program(facts, "bun", platform === "win32" ? undefined : posix.join(facts.home, ".bun", "bin", "bun"));
      if (bun === undefined || origin.npmName === undefined) return undefined;
      const args = ["add", "-g", `${origin.npmName}@latest`];
      return plan("bun", VIA.bun, bun, args, ["bun", ...args].join(" "), platform);
    }
    case "pnpm": {
      const pnpm = program(facts, "pnpm");
      if (pnpm === undefined || origin.npmName === undefined) return undefined;
      const args = ["add", "-g", `${origin.npmName}@latest`];
      return plan("pnpm", VIA.pnpm, pnpm, args, ["pnpm", ...args].join(" "), platform);
    }
    case "winget": {
      if (pkg.winget === undefined || found.broken) return undefined;
      const winget = program(facts, "winget", "winget");
      const args = ["upgrade", "--id", pkg.winget, "--exact", "--disable-interactivity"];
      return plan("winget", VIA.winget, winget!, args, `winget upgrade --id ${pkg.winget} --exact`, platform);
    }
    case "chocolatey":
      return pkg.choco !== undefined ? chocoPlan(facts, "upgrade", pkg.choco) : undefined;
    case "scoop":
      return pkg.scoop !== undefined ? scoopPlan(facts, "update", pkg.scoop) : undefined;
    case "command-line-tools":
      // Apple's Software Update brings them up to date, not anything JaiRA runs.
      return undefined;
  }
}

/**
 * Chocolatey's install or upgrade, run as administrator: it writes under %ProgramData%, and run without
 * the rights it warns and then fails. PowerShell asks Windows for them — the person answers Windows'
 * own prompt — and waits for choco, whose exit code is the answer (its output stays in its own window).
 */
function chocoPlan(facts: InstallFacts, verb: "install" | "upgrade", id: string): InstallPlan | undefined {
  const choco = facts.tools.choco;
  if (facts.platform !== "win32" || choco === undefined) return undefined;
  const quote = (one: string): string => `'${one.replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath ${quote(choco)} -ArgumentList ${[verb, id, "-y", "--no-progress"].map(quote).join(",")} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  return plan("chocolatey", VIA.chocolatey, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], `choco ${verb} ${id} -y (as administrator)`, facts.platform);
}

/** Scoop's install or update — in the person's own folder, so no rights are asked for. A package in another bucket adds the bucket first. */
function scoopPlan(facts: InstallFacts, verb: "install" | "update", name: string): InstallPlan | undefined {
  if (facts.platform !== "win32" || facts.tools.scoop === undefined) return undefined;
  const bucket = verb === "install" && name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined;
  const target = verb === "update" ? name.slice(name.indexOf("/") + 1) : name;
  if (bucket === undefined) return plan("scoop", VIA.scoop, "scoop", [verb, target], `scoop ${verb} ${target}`, facts.platform);
  // Scoop is PowerShell; adding a bucket already there is a warning, not a failure.
  const display = `scoop bucket add ${bucket}; scoop install ${target}`;
  return plan("scoop", VIA.scoop, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", `scoop bucket add ${bucket} *> $null; scoop install ${target}; exit $LASTEXITCODE`], display, facts.platform);
}

/** The ways to install an agent from here, in its vendor's order ({@link AgentPackage.order}). */
function installPlans(pkg: AgentPackage, facts: InstallFacts): InstallPlan[] {
  const { platform } = facts;
  const way = (method: AgentInstallMethod): InstallPlan | undefined => {
    switch (method) {
      case "native":
        return nativeInstall(pkg, facts);
      case "homebrew": {
        const brew = facts.tools.brew;
        // A cask is macOS's; a formula installs on Linux as well.
        if (pkg.brew === undefined || brew === undefined || platform === "win32" || (pkg.brew.cask && platform !== "darwin")) return undefined;
        const args = pkg.brew.cask ? ["install", "--cask", pkg.brew.name] : ["install", pkg.brew.name];
        return plan("homebrew", VIA.homebrew, brew, args, ["brew", ...args].join(" "), platform);
      }
      case "npm": {
        const npm = program(facts, "npm");
        if (pkg.npm === undefined || npm === undefined) return undefined;
        const args = ["install", "-g", pkg.npm.name];
        return plan("npm", VIA.npm, npm, args, ["npm", ...args].join(" "), platform);
      }
      case "winget": {
        if (pkg.winget === undefined || platform !== "win32" || facts.tools.winget === undefined) return undefined;
        // Its agreements accepted here, since nobody can answer them: stdin is closed.
        const args = ["install", "--id", pkg.winget, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];
        return plan("winget", VIA.winget, "winget", args, `winget install --id ${pkg.winget} --exact`, platform);
      }
      case "chocolatey":
        return pkg.choco !== undefined ? chocoPlan(facts, "install", pkg.choco) : undefined;
      case "scoop":
        return pkg.scoop !== undefined ? scoopPlan(facts, "install", pkg.scoop) : undefined;
      case "command-line-tools": {
        // It asks macOS to install them, in Apple's own window, and exits at once (`installGitCli` waits).
        if (pkg.xcode !== true || platform !== "darwin") return undefined;
        const xcodeSelect = facts.tools["xcode-select"] ?? "/usr/bin/xcode-select";
        return plan("command-line-tools", VIA["command-line-tools"], xcodeSelect, ["--install"], "xcode-select --install", platform);
      }
      default:
        return undefined;
    }
  };
  return pkg.order.flatMap((method) => way(method) ?? []);
}

/** Everything the facts allow: where it is, how it got there, and what installs or updates it. */
export function planOf(pkg: AgentPackage, facts: InstallFacts): { origin?: InstallOrigin; update?: InstallPlan; install: InstallPlan[] } {
  const found = facts.found;
  const origin = found !== undefined ? installOriginOf(found.real, pkg) : undefined;
  const update = found !== undefined && origin !== undefined ? updatePlan(pkg, facts, origin) : undefined;
  // Installed and working — or broken with a way back — is updated, not installed again.
  const installed = found !== undefined && (!found.broken || update !== undefined);
  return { ...(origin !== undefined ? { origin } : {}), ...(update !== undefined ? { update } : {}), install: installed ? [] : installPlans(pkg, facts) };
}

/** Only what the person is shown: the commands without the program that runs them. */
function shown(one: InstallPlan): AgentInstallCommand {
  return { method: one.method, via: one.via, display: one.display };
}

/** What a probe reports of an agent's install. */
export function agentInstallOf(pkg: AgentPackage, facts: InstallFacts): AgentInstall {
  const { origin, update, install } = planOf(pkg, facts);
  const found = facts.found;
  return {
    ...(found !== undefined ? { path: found.path, onPath: found.onPath, ...(found.broken ? { broken: true } : {}) } : {}),
    ...(origin !== undefined ? { method: origin.method } : {}),
    ...(update !== undefined ? { update: shown(update) } : {}),
    ...(install.length > 0 ? { install: install.map(shown) } : {}),
  };
}

/** The built-in kinds that drive one agent's binary, and which. */
const PACKAGE_OF_KIND: Partial<Record<ExecutorKind, string>> = { cli: "claude", codex: "codex" };

/**
 * The package JaiRA installs this executor from, when it is one it knows how to install. A built-in
 * kind names its own; a generic CLI is known by its PROGRAM, whatever it is called here — a CLI added
 * as `my-agent` running `opencode` is OpenCode, and installs and updates as it.
 */
export function agentPackageOf(info: ExecutorInfo): AgentPackage | undefined {
  const byKind = PACKAGE_OF_KIND[info.kind];
  if (byKind !== undefined) return AGENT_PACKAGES[byKind];
  if (info.kind !== "generic" || info.command === undefined) return undefined;
  const program = (info.command.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return Object.values(AGENT_PACKAGES).find((pkg) => pkg.binary === program);
}

// --- running it ---------------------------------------------------------------------------------

export interface InstallRunOptions extends InstallLookup {
  abortSignal?: AbortSignal;
  /**
   * What the install prints, as it prints it: the command first (`$ brew install gh`), then the
   * installer's stdout and stderr as they come, interleaved, untouched — escapes and carriage returns
   * included, for whoever draws it to make sense of. Settings → Connections shows it under the row.
   */
  onOutput?: (text: string) => void;
}

/** Long enough for a download on a slow line; an installer that waits on a question fails sooner (stdin is closed). */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Install an agent the way named, or — with no way named — update it the way it was installed (a
 * broken one is reinstalled). Only a way the facts offer is run: the request names a way, never a
 * command. Answers when the installer exits, with where the binary is now.
 */
export async function installAgent(info: ExecutorInfo, method: AgentInstallMethod | undefined, options: InstallRunOptions): Promise<AgentInstallOutcome> {
  const pkg = agentPackageOf(info);
  if (pkg === undefined) return { ok: false, reason: `JaiRA does not know how to install ${info.name}` };
  return runInstall(pkg, info.command ?? pkg.binary, method, options);
}

/** What a caller of {@link runInstall} adds to it. */
export interface InstallRunHooks {
  /** How the machine is looked at, before and after — {@link gatherInstallFacts} unless a package needs more. */
  facts?: () => Promise<InstallFacts | undefined>;
  /** Called once the installer exited 0, before the binary is looked for again; its answer is the outcome. */
  afterRun?: (chosen: InstallPlan, result: { stdout: string; stderr: string }) => Promise<AgentInstallOutcome | undefined>;
}

/** The install or update of one package, by the way named (none: the update), as {@link installAgent} describes. */
export async function runInstall(pkg: AgentPackage, command: string, method: AgentInstallMethod | undefined, options: InstallRunOptions, hooks: InstallRunHooks = {}): Promise<AgentInstallOutcome> {
  const look = hooks.facts ?? (() => gatherInstallFacts(command, pkg, options));
  const facts = await look();
  if (facts === undefined) return { ok: false, reason: `could not look for '${command}' where it runs` };
  const plans = planOf(pkg, facts);
  const chosen = method === undefined ? plans.update : plans.install.find((one) => one.method === method);
  if (chosen === undefined) {
    return {
      ok: false,
      reason:
        method === undefined
          ? `'${command}' was not installed in a way JaiRA can update — update it the way you installed it`
          : `${VIA[method]} cannot install ${pkg.binary} here`,
    };
  }
  const say = (text: string): void => {
    try {
      options.onOutput?.(text);
    } catch {
      // Somebody watching; the install goes on without them.
    }
  };
  say(`$ ${chosen.display}\n`);
  let result;
  try {
    result = await options.exec.run(chosen.file, chosen.args, {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      // Passed into WSL it would be the Windows side's; there, the distro's own PATH is the right one.
      ...(chosen.env !== undefined && (options.execEnv === undefined || !isWslEnv(options.execEnv)) ? { env: chosen.env } : {}),
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
      // Closed, so an installer that stops to ask fails with its question rather than waiting forever.
      stdin: "",
      ...(options.onOutput !== undefined ? { onOutput: (_stream: "stdout" | "stderr", chunk: string) => say(chunk) } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `'${chosen.display}' could not be started: ${(e as Error).message}` };
  }
  const verb = method === undefined ? "update" : "install";
  if (result.aborted) return { ok: false, reason: `the ${verb} was cancelled` };
  if (result.timedOut) return { ok: false, reason: `'${chosen.display}' did not finish in time` };
  if (result.code !== 0) {
    // The installer's own last words: "already installed", "permission denied" and a network error are
    // different problems, and the last line is where each says which.
    const said = lastLine(`${result.stdout}\n${result.stderr}`, result.stderr);
    return { ok: false, reason: `'${chosen.display}' exited ${result.code}${said ? `: ${said}` : ""}` };
  }
  const waited = hooks.afterRun !== undefined ? await hooks.afterRun(chosen, result) : undefined;
  if (waited !== undefined) return waited;
  const after = await look();
  const now = after?.found;
  return now !== undefined && !now.broken ? { ok: true, path: now.path, onPath: now.onPath } : { ok: true };
}

/** The last line that says something — stderr's, when there is one, since that is where an error goes. */
function lastLine(all: string, stderr: string): string {
  const pick = (text: string): string | undefined =>
    text
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop();
  return pick(stderr) ?? pick(all) ?? "";
}
