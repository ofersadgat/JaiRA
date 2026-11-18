/**
 * Where a tool's binary is, and which installers a machine has — file checks on this machine, one
 * `sh` inside WSL, and (on a Mac) a question to whatever says whether Apple's placeholder stands for
 * a real program. Nothing here installs or runs the tool itself.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { Exec } from "../exec";
import { isContainerEnv, isWslEnv, type ExecEnv } from "../paths";
import { VERSION_MANAGERS, type ToolPackage, type VersionManager } from "./catalog";
import { compareVersions, versionParts } from "./version";

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

/**
 * The installers a machine offers, by the program that runs each — and the version managers, by
 * theirs (`nvm` is the `nvm.sh` that defines its shell function).
 */
export type InstallTool =
  | "brew"
  | "npm"
  | "bun"
  | "pnpm"
  | "winget"
  | "choco"
  | "scoop"
  | "powershell"
  | "curl"
  | "bash"
  | "xcode-select"
  | "apt-get"
  | "dnf"
  | "sudo"
  | "pkg-config"
  | VersionManager;

/** What a machine — or a WSL distro — says about one tool: where it is and what can install it. */
export interface InstallFacts {
  platform: "darwin" | "linux" | "win32";
  home: string;
  found?: FoundBinary;
  tools: Partial<Record<InstallTool, string>>;
  /** Is there a program at this path? Absent (inside WSL) is taken as yes — the run says otherwise. */
  has?: (path: string) => boolean;
  /** Running as root: a system package manager needs no sudo. */
  root?: boolean;
}

/** The file system and environment, as the lookups below need them — injected so a test is a table. */
export interface InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  pathDirs: readonly string[];
  /** The environment variables a usual place is spelled with (APPDATA, LOCALAPPDATA, NVM_DIR). */
  env: Readonly<Record<string, string | undefined>>;
  /** Anything at all at this path — a dangling link included. */
  lexists: (path: string) => boolean;
  /** Where the path resolves to through every link; undefined when the target is gone. */
  realpath: (path: string) => string | undefined;
  /** What a link names, for one whose target is gone. */
  readlink: (path: string) => string | undefined;
  /** A file (after links) — what a shell would run. */
  isFile: (path: string) => boolean;
  /** The names in a folder — for a usual place with a version in it (`~/.nvm/versions/node/*`). Absent: such places are not looked in. */
  readDir?: (path: string) => readonly string[] | undefined;
  /** This process runs as root. */
  root?: boolean;
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
    readDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return undefined;
      }
    },
    root: typeof process.getuid === "function" && process.getuid() === 0,
  };
}

export function pathModule(platform: string): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function platformOf(deps: InstallDeps): InstallFacts["platform"] {
  return deps.platform === "win32" ? "win32" : deps.platform === "darwin" ? "darwin" : "linux";
}

/**
 * Where each installer puts its binaries when the PATH this app was started with does not say. A
 * package's own folders ({@link ToolPackage.dirs}) are looked in after these.
 */
function usualDirSpecs(platform: InstallFacts["platform"]): readonly string[] {
  if (platform === "win32") {
    // An installer that adds its folder to the PATH changes it for programs started AFTER it: this app,
    // started before, finds what it installed only here.
    return [
      "~\\.local\\bin",
      "%APPDATA%\\npm",
      "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links",
      // WinGet's machine-wide links; Chocolatey's shims; Scoop's, the person's and the machine-wide.
      "%ProgramFiles%\\WinGet\\Links",
      "%ChocolateyInstall%\\bin",
      "%SCOOP%\\shims",
      "%ProgramData%\\scoop\\shims",
    ];
  }
  // A Mac app started from the Finder gets launchd's PATH — /usr/bin:/bin:/usr/sbin:/sbin — which
  // reaches none of these.
  return ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "~/.bun/bin", "~/.npm-global/bin"];
}

/** Where a version manager puts the programs it keeps on the PATH — its shims, or its default's folder. */
const MANAGER_DIRS: Readonly<Record<VersionManager, { posix?: readonly string[]; windows?: readonly string[] }>> = {
  nvm: { posix: ["$NVM_DIR/versions/node/*/bin", "~/.nvm/versions/node/*/bin"] },
  fnm: { posix: ["~/.local/share/fnm/aliases/default/bin", "~/Library/Application Support/fnm/aliases/default/bin"], windows: ["%APPDATA%\\fnm\\aliases\\default"] },
  volta: { posix: ["$VOLTA_HOME/bin", "~/.volta/bin"], windows: ["%LOCALAPPDATA%\\Volta\\bin"] },
  mise: { posix: ["$MISE_DATA_DIR/shims", "~/.local/share/mise/shims"], windows: ["%LOCALAPPDATA%\\mise\\shims"] },
  asdf: { posix: ["$ASDF_DATA_DIR/shims", "~/.asdf/shims"] },
  pyenv: { posix: ["$PYENV_ROOT/shims", "~/.pyenv/shims"] },
  uv: {},
  rbenv: { posix: ["$RBENV_ROOT/shims", "~/.rbenv/shims"] },
  rustup: { posix: ["$CARGO_HOME/bin", "~/.cargo/bin"], windows: ["~\\.cargo\\bin"] },
  corepack: {},
};

/**
 * The installers and version managers JaiRA may run, where each is looked for. Every package's
 * lookup asks for the installers an agent's always did, and the rest only where its package names
 * them — a library's pkg-config, a language's version managers, Linux's apt and dnf.
 */
const INSTALL_TOOLS: Readonly<Record<InstallTool, { on: readonly InstallFacts["platform"][]; dirs?: readonly string[]; files?: readonly string[] }>> = {
  brew: { on: ["darwin", "linux"] },
  npm: { on: ["darwin", "linux", "win32"] },
  bun: { on: ["darwin", "linux", "win32"] },
  pnpm: { on: ["darwin", "linux", "win32"] },
  winget: { on: ["win32"] },
  choco: { on: ["win32"] },
  scoop: { on: ["win32"] },
  powershell: { on: ["win32"] },
  curl: { on: ["darwin", "linux"] },
  bash: { on: ["darwin", "linux"] },
  "xcode-select": { on: ["darwin"] },
  "apt-get": { on: ["linux"] },
  dnf: { on: ["linux"] },
  sudo: { on: ["darwin", "linux"] },
  "pkg-config": { on: ["darwin", "linux"] },
  // nvm is a shell function, defined by sourcing this file.
  nvm: { on: ["darwin", "linux"], files: ["$NVM_DIR/nvm.sh", "~/.nvm/nvm.sh", "$XDG_CONFIG_HOME/nvm/nvm.sh", "~/.config/nvm/nvm.sh"] },
  fnm: { on: ["darwin", "linux", "win32"], dirs: ["~/.local/share/fnm", "~/.fnm"] },
  volta: { on: ["darwin", "linux", "win32"], dirs: ["~/.volta/bin"] },
  mise: { on: ["darwin", "linux", "win32"] },
  asdf: { on: ["darwin", "linux"], dirs: ["~/.asdf/bin"] },
  pyenv: { on: ["darwin", "linux"], dirs: ["$PYENV_ROOT/bin", "~/.pyenv/bin"] },
  uv: { on: ["darwin", "linux", "win32"], dirs: ["~/.cargo/bin"] },
  rbenv: { on: ["darwin", "linux"], dirs: ["~/.rbenv/bin"] },
  rustup: { on: ["darwin", "linux", "win32"], dirs: ["~/.cargo/bin"] },
  corepack: { on: ["darwin", "linux", "win32"] },
};

/** The installers every lookup asks for — the ones an agent's update may need, whatever its order says. */
const ALWAYS: readonly InstallTool[] = ["brew", "npm", "bun", "pnpm", "winget", "choco", "scoop", "powershell", "curl", "bash", "xcode-select"];

/** The installers worth looking for on behalf of one package. */
export function toolsFor(pkg: ToolPackage | undefined): InstallTool[] {
  if (pkg === undefined) return Object.keys(INSTALL_TOOLS) as InstallTool[];
  const wanted = new Set<InstallTool>(ALWAYS);
  if (pkg.apt !== undefined || pkg.versioned?.apt !== undefined || pkg.order.includes("apt")) wanted.add("apt-get").add("sudo");
  if (pkg.dnf !== undefined || pkg.versioned?.dnf !== undefined || pkg.order.includes("dnf")) wanted.add("dnf").add("sudo");
  if (pkg.native?.sudo === true) wanted.add("sudo");
  if (pkg.pkgConfig !== undefined) wanted.add("pkg-config");
  for (const manager of pkg.managers ?? []) wanted.add(manager);
  return [...wanted];
}

/**
 * A usual place as written (`~/.nvm/versions/node/*\/bin`, `%LOCALAPPDATA%\agy\bin`), as the folders
 * it names here: none when a variable it needs is not set, several for a `*` part — newest first.
 */
export function expandDir(spec: string, deps: InstallDeps): string[] {
  const path = pathModule(deps.platform);
  const defaults: Record<string, string> = {
    ProgramFiles: "C:\\Program Files",
    ProgramData: "C:\\ProgramData",
    ChocolateyInstall: path.join(deps.env["ProgramData"] ?? "C:\\ProgramData", "chocolatey"),
    SCOOP: path.join(deps.home, "scoop"),
  };
  let missing = false;
  const text = spec
    .replace(/^~(?=[\\/]|$)/, deps.home)
    .replace(/%([A-Za-z_]+)%/g, (_all, name: string) => {
      const value = deps.env[name] ?? defaults[name];
      if (value === undefined) missing = true;
      return value ?? "";
    })
    .replace(/\$([A-Za-z_]+)/g, (_all, name: string) => {
      const value = deps.env[name];
      if (value === undefined || value.length === 0) missing = true;
      return value ?? "";
    });
  if (missing) return [];
  if (!text.includes("*")) return [text];
  if (deps.readDir === undefined) return [];
  // One `*` part at a time, each matched against what is in the folder before it.
  const sep = deps.platform === "win32" ? /[\\/]/ : /\//;
  const parts = text.split(sep);
  // The root: `/`, or a drive (`C:` alone is the drive's current folder, not its root).
  let found: string[] = [parts[0] === "" ? "/" : /^[A-Za-z]:$/.test(parts[0]!) ? `${parts[0]}\\` : parts[0]!];
  for (const part of parts.slice(1)) {
    if (!part.includes("*")) {
      found = found.map((dir) => path.join(dir, part));
      continue;
    }
    const pattern = new RegExp(`^${part.split("*").map((one) => one.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    found = found.flatMap((dir) => {
      const names = (deps.readDir!(dir) ?? []).filter((name) => pattern.test(name));
      return newestFirst(names).map((name) => path.join(dir, name));
    });
  }
  return found;
}

/** Names sorted by the version in them, newest first: `v22.11.0` before `v20.18.1`. */
function newestFirst(names: readonly string[]): string[] {
  const version = (name: string): number[] => versionParts(name.replace(/^[^\d]*/, "")) ?? [];
  return [...names].sort((a, b) => compareVersions(version(b), version(a)) || (a < b ? 1 : -1));
}

function expandAll(specs: readonly string[] | undefined, deps: InstallDeps): string[] {
  return (specs ?? []).flatMap((spec) => expandDir(spec, deps));
}

/** A package's own folders, and those of the version managers that keep it. */
export function packageDirs(pkg: ToolPackage | undefined, deps: InstallDeps): string[] {
  if (pkg === undefined) return [];
  const windows = deps.platform === "win32";
  const own = windows ? pkg.dirs?.windows : pkg.dirs?.posix;
  const managed = (pkg.managers ?? []).flatMap((manager) => (windows ? MANAGER_DIRS[manager].windows : MANAGER_DIRS[manager].posix) ?? []);
  return [...expandAll(own, deps), ...expandAll(managed, deps)];
}

/** The names a command may have on disk: itself, and on Windows each runnable extension. */
function namesOf(command: string, platform: string): string[] {
  if (platform !== "win32" || /\.[a-z0-9]+$/i.test(command)) return [command];
  return [".exe", ".cmd", ".bat", ".com"].map((ext) => `${command}${ext}`);
}

export interface LocateOptions {
  /** Folders looked in after the usual ones — a package's own. */
  dirs?: readonly string[];
  /** A path that is not the program, though it is there (a placeholder): looked past, as a dangling link is. */
  skip?: (real: string) => boolean;
}

/**
 * Look a command up the way a shell would — the first runnable one on the PATH — then, failing that,
 * in the usual places. A dangling link is not runnable, so the search goes past it; it is reported
 * only when nothing runnable turns up anywhere, since then it IS the install, half-removed.
 */
export function locateBinary(command: string, deps: InstallDeps, options: LocateOptions = {}): FoundBinary | undefined {
  const path = pathModule(deps.platform);
  const named = command.includes("/") || command.includes("\\");
  let broken: FoundBinary | undefined;
  const look = (candidate: string, onPath: boolean): FoundBinary | undefined => {
    if (!deps.lexists(candidate)) return undefined;
    const real = deps.realpath(candidate);
    if (real !== undefined) {
      if (options.skip?.(real.replace(/\\/g, "/")) === true) return undefined;
      return deps.isFile(candidate) ? { path: candidate, real, onPath, broken: false } : undefined;
    }
    const target = deps.readlink(candidate);
    broken ??= { path: candidate, real: target !== undefined ? path.resolve(path.dirname(candidate), target) : candidate, onPath, broken: true };
    return undefined;
  };
  const usual = [...expandAll(usualDirSpecs(platformOf(deps)), deps), ...(options.dirs ?? [])];
  // A configured path is what runs, so "on the PATH" is beside the point: it is reached.
  const searches: Array<{ dirs: readonly string[]; onPath: boolean }> = named
    ? [{ dirs: [""], onPath: true }]
    : [
        { dirs: deps.pathDirs, onPath: true },
        { dirs: usual.filter((dir, i) => !deps.pathDirs.includes(dir) && usual.indexOf(dir) === i), onPath: false },
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

/** The installers this machine has of those named, found as the tool is (PATH first, then the usual places). */
export function locateTools(deps: InstallDeps, names: readonly InstallTool[] = Object.keys(INSTALL_TOOLS) as InstallTool[]): Partial<Record<InstallTool, string>> {
  const platform = platformOf(deps);
  const tools: Partial<Record<InstallTool, string>> = {};
  for (const name of names) {
    const spec = INSTALL_TOOLS[name];
    if (!spec.on.includes(platform)) continue;
    if (spec.files !== undefined) {
      const file = expandAll(spec.files, deps).find((one) => deps.isFile(one));
      if (file !== undefined) tools[name] = file;
      continue;
    }
    const found = locateBinary(name, deps, { dirs: expandAll(spec.dirs, deps) });
    if (found !== undefined && !found.broken) tools[name] = found.path;
  }
  return tools;
}

/**
 * An npm shim on Windows is a `.cmd` file and no link, so its path says nothing — the package it runs
 * sits beside it, in the `node_modules` of the same prefix, and that is what is classified.
 */
function shimPackage(found: FoundBinary, pkg: ToolPackage, deps: InstallDeps): FoundBinary {
  if (deps.platform !== "win32" || !/\.(cmd|ps1)$/i.test(found.path)) return found;
  for (const name of npmNames(pkg)) {
    const dir = win32.join(win32.dirname(found.path), "node_modules", ...name.split("/"));
    if (deps.lexists(dir)) return { ...found, real: dir };
  }
  return found;
}

/** Every name the package's npm releases have gone by, the current one first. */
export function npmNames(pkg: ToolPackage): string[] {
  return pkg.npm === undefined ? [] : [pkg.npm.name, ...(pkg.npm.also ?? [])];
}

/** Is this real path one of the package's placeholders? */
function isStub(pkg: ToolPackage, real: string): boolean {
  return pkg.stubs?.some((stub) => stub.test(real)) === true;
}

/** What this machine says about one tool. */
export function installFactsOf(command: string, pkg: ToolPackage, deps: InstallDeps, options: { skip?: (real: string) => boolean } = {}): InstallFacts {
  const skip = (real: string): boolean => isStub(pkg, real) || options.skip?.(real) === true;
  const found = locateBinary(command, deps, { dirs: packageDirs(pkg, deps), skip });
  return {
    platform: platformOf(deps),
    home: deps.home,
    ...(found !== undefined ? { found: shimPackage(found, pkg, deps) } : {}),
    tools: locateTools(deps, toolsFor(pkg)),
    has: deps.isFile,
    ...(deps.root === true ? { root: true } : {}),
  };
}

// --- inside WSL -----------------------------------------------------------------------------------

/**
 * A usual place as `sh` spells it: `~` and `$NAME` left to the shell, a `*` part to its globbing — and
 * one under a variable that is not set no word at all (`${NAME:+…}`), as {@link expandDir} drops it.
 */
function shDir(spec: string): string {
  const spelled = spec.replace(/^~(?=\/|$)/, "$HOME").replace(/ /g, "\\ ");
  const variable = /^\$([A-Za-z_]+)(.*)$/.exec(spelled);
  return variable !== null && variable[1] !== "HOME" ? `\${${variable[1]}:+$${variable[1]}${variable[2]}}` : spelled;
}

/**
 * The lookup asked inside a WSL distro — where the tool runs when the project does. One `sh` reports
 * what `command -v` finds and where it resolves to (a dangling link is not reported there), else the
 * first runnable one in the usual places and the package's own; then each installer, its uid and home.
 */
export function wslFactsScript(pkg: ToolPackage | undefined): string {
  const linux = (specs: readonly string[] | undefined): string[] => (specs ?? []).map(shDir);
  const dirs = [...linux(usualDirSpecs("linux")), ...linux(pkg?.dirs?.posix), ...(pkg?.managers ?? []).flatMap((manager) => linux(MANAGER_DIRS[manager].posix))];
  const tools = toolsFor(pkg).filter((name) => INSTALL_TOOLS[name].on.includes("linux"));
  const plain = tools.filter((name) => INSTALL_TOOLS[name].files === undefined && INSTALL_TOOLS[name].dirs === undefined);
  const lines = [
    'n="$1"',
    'p=$(command -v "$n" 2>/dev/null)',
    'if [ -n "$p" ]; then printf "found\\t%s\\t%s\\n" "$p" "$(readlink -f "$p" 2>/dev/null || printf %s "$p")"; else',
    `  for d in ${dirs.join(" ")}; do`,
    '    if [ -x "$d/$n" ]; then printf "usual\\t%s\\t%s\\n" "$d/$n" "$(readlink -f "$d/$n" 2>/dev/null || printf %s "$d/$n")"; break; fi',
    "  done",
    "fi",
    `for t in ${plain.join(" ")}; do q=$(command -v "$t" 2>/dev/null) && printf "tool\\t%s\\t%s\\n" "$t" "$q"; done`,
  ];
  for (const name of tools) {
    const spec = INSTALL_TOOLS[name];
    if (spec.files !== undefined) {
      lines.push(`for f in ${linux(spec.files).map((one) => `"${one.replace(/\\ /g, " ")}"`).join(" ")}; do if [ -f "$f" ]; then printf "tool\\t${name}\\t%s\\n" "$f"; break; fi; done`);
    } else if (spec.dirs !== undefined) {
      lines.push(`q=$(command -v ${name} 2>/dev/null) || for d in ${linux(spec.dirs).join(" ")}; do if [ -x "$d/${name}" ]; then q="$d/${name}"; break; fi; done; [ -n "$q" ] && printf "tool\\t${name}\\t%s\\n" "$q"; q=`);
    }
  }
  lines.push('printf "home\\t%s\\n" "$HOME"', 'printf "uid\\t%s\\n" "$(id -u)"');
  return lines.join("\n");
}

/** Read {@link wslFactsScript}'s answer. */
export function parseWslFacts(stdout: string): InstallFacts {
  const facts: InstallFacts = { platform: "linux", home: "", tools: {} };
  for (const line of stdout.split(/\r?\n/)) {
    const [key, a, b] = line.split("\t");
    if ((key === "found" || key === "usual") && a !== undefined && a.length > 0) facts.found = { path: a, real: b || a, onPath: key === "found", broken: false };
    else if (key === "tool" && a !== undefined && b !== undefined && b.length > 0) facts.tools[a as InstallTool] = b;
    else if (key === "home" && a !== undefined) facts.home = a;
    else if (key === "uid" && a === "0") facts.root = true;
  }
  return facts;
}

/** Folders as `sh` lists them inside WSL — for where an install landed, which may have a `*` part. */
export async function wslDirs(specs: readonly string[], lookup: InstallLookup): Promise<string[]> {
  if (specs.length === 0) return [];
  const script = `for d in ${specs.map(shDir).join(" ")}; do [ -d "$d" ] && printf "%s\\n" "$d"; done; true`;
  try {
    const result = await lookup.exec.run("sh", ["-c", script], { ...(lookup.execEnv !== undefined ? { execEnv: lookup.execEnv } : {}), timeoutMs: lookup.timeoutMs ?? 10_000 });
    return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export interface InstallLookup {
  exec: Exec;
  execEnv?: ExecEnv;
  deps: InstallDeps;
  timeoutMs?: number;
  /** The folder a version is asked in — a version manager's shim answers with the version that folder pins. */
  cwd?: string;
}

/**
 * Is the lookup inside a Linux machine reached only through a command — a WSL distro, or a
 * workspace's container (decision 0027)? Both are asked with one `sh` ({@link wslFactsScript}), and
 * neither is this process's file system or PATH.
 */
export function inGuest(lookup: { execEnv?: ExecEnv }): boolean {
  return lookup.execEnv !== undefined && (isWslEnv(lookup.execEnv) || isContainerEnv(lookup.execEnv));
}

/** What the machine the tool runs on says about it — this one, or the WSL distro or container config names. */
export async function gatherInstallFacts(command: string, pkg: ToolPackage, lookup: InstallLookup): Promise<InstallFacts | undefined> {
  if (!inGuest(lookup)) return installFactsOf(command, pkg, lookup.deps);
  try {
    const result = await lookup.exec.run("sh", ["-c", wslFactsScript(pkg), "sh", command], { execEnv: lookup.execEnv!, timeoutMs: lookup.timeoutMs ?? 10_000 });
    if (result.code !== 0) return undefined;
    const facts = parseWslFacts(result.stdout);
    return facts.found !== undefined && isStub(pkg, facts.found.real) ? (({ found: _stub, ...rest }) => rest)(facts) : facts;
  } catch {
    return undefined;
  }
}

// --- Apple's placeholders ---------------------------------------------------------------------------

/** How to ask whether the program behind a Mac's placeholder at /usr/bin is there. */
function appleStubOf(pkg: ToolPackage, facts: InstallFacts): { probe: readonly string[]; bin: string } | undefined {
  if (pkg.appleStub !== undefined) return pkg.appleStub;
  if (pkg.xcode === true) return { probe: [facts.tools["xcode-select"] ?? "/usr/bin/xcode-select", "-p"], bin: "usr/bin" };
  return undefined;
}

/**
 * Where the program a Mac's placeholder stands for really is — Apple's Command Line Tools (or an
 * Xcode chosen with `xcode-select`), or the Java `java_home` names — when it is there. The probe
 * names the folder and exits non-zero when there is none; it never opens the installer, which
 * running the placeholder would.
 */
export async function appleStubTarget(pkg: ToolPackage, command: string, exec: Exec, facts: InstallFacts, timeoutMs = 10_000): Promise<string | undefined> {
  const stub = appleStubOf(pkg, facts);
  if (stub === undefined) return undefined;
  try {
    const result = await exec.run(stub.probe[0]!, stub.probe.slice(1), { timeoutMs });
    const dir = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (result.code !== 0 || dir.length === 0) return undefined;
    const program = posix.join(dir, stub.bin, command);
    return (facts.has?.(program) ?? true) ? program : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The facts with a Mac's placeholder seen for what it is: a package Apple keeps a placeholder for at
 * /usr/bin (git and python3 until the Command Line Tools are installed, java until a JDK is) is the
 * real program when the probe finds one — and when not, is not found at all. Off a Mac, inside WSL,
 * or for anything else, the facts as they were.
 */
export async function withoutApplePlaceholder(pkg: ToolPackage, command: string, facts: InstallFacts, lookup: InstallLookup): Promise<{ facts: InstallFacts; placeholder: boolean }> {
  const found = facts.found;
  if (facts.platform !== "darwin" || inGuest(lookup) || found === undefined || appleStubOf(pkg, facts) === undefined || found.real !== `/usr/bin/${command}`) return { facts, placeholder: false };
  const target = await appleStubTarget(pkg, command, lookup.exec, facts);
  // The program /usr/bin hands over to is the one installed.
  if (target !== undefined) return { facts: { ...facts, found: { ...found, real: target } }, placeholder: false };
  const { found: _placeholder, ...rest } = facts;
  return { facts: rest, placeholder: true };
}

/** A version manager's tool, as {@link InstallTool}. */
export function isVersionManager(tool: string): tool is VersionManager {
  return (VERSION_MANAGERS as readonly string[]).includes(tool);
}
