/**
 * What installs or updates a tool from here, decided from what the lookups found: the installer that
 * put it here when there is one (an update, or the version a project wants, goes back through it),
 * then the version managers this machine already keeps the tool with, then the package's own ways in
 * its vendor's order. A request names a tool, a version and at most a preferred way — never a command.
 */
import { posix } from "node:path";
import type { AgentInstallMethod, InstallMethod } from "@jaira/shared";
import { managedName, type ToolPackage, type VersionManager, type VersionedName } from "./catalog";
import { isVersionManager, type InstallFacts, type InstallTool } from "./locate";
import { installOriginOf, type InstallOrigin } from "./origin";
import { isExactVersion, versionWant, type VersionWant } from "./version";

/** The way, as a person names it — for an update by the binary's own updater, see {@link planOf}. */
export const INSTALL_VIA: Readonly<Record<InstallMethod, string>> = {
  native: "the native installer",
  homebrew: "Homebrew",
  npm: "npm",
  bun: "Bun",
  pnpm: "pnpm",
  winget: "WinGet",
  chocolatey: "Chocolatey",
  scoop: "Scoop",
  "command-line-tools": "Apple's Command Line Tools",
  apt: "apt",
  dnf: "dnf",
  nvm: "nvm",
  fnm: "fnm",
  volta: "Volta",
  mise: "mise",
  asdf: "asdf",
  pyenv: "pyenv",
  uv: "uv",
  rbenv: "rbenv",
  rustup: "rustup",
  corepack: "Corepack",
};

const AGENT_METHODS: ReadonlySet<string> = new Set<AgentInstallMethod>(["native", "homebrew", "npm", "bun", "pnpm", "winget", "chocolatey", "scoop", "command-line-tools"]);

/** Is this one of the ways an agent's row knows ({@link AgentInstallMethod})? */
export function isAgentInstallMethod(method: InstallMethod): method is AgentInstallMethod {
  return AGENT_METHODS.has(method);
}

/** Other names a request may give a way. */
const METHOD_NAMES: Readonly<Record<string, InstallMethod>> = {
  brew: "homebrew",
  choco: "chocolatey",
  "apt-get": "apt",
  yum: "dnf",
  xcode: "command-line-tools",
  "xcode-select": "command-line-tools",
  script: "native",
};

/** The way a request names (`brew`, `nvm`, `apt-get`), as an {@link InstallMethod}; undefined for one JaiRA does not know. */
export function installMethodOf(text: string | undefined): InstallMethod | undefined {
  if (text === undefined) return undefined;
  const key = text.trim().toLowerCase();
  const named = METHOD_NAMES[key] ?? key;
  return named in INSTALL_VIA ? (named as InstallMethod) : undefined;
}

/** One command, as shown and as run. */
export interface InstallPlan {
  method: InstallMethod;
  /** The way, as a person names it: "the native installer", "Homebrew", "nvm". */
  via: string;
  /** The command as a person would type it in a terminal. */
  display: string;
  file: string;
  args: string[];
  /** Laid over the environment it runs in. */
  env?: Record<string, string>;
  /** It runs as root through sudo, or asks sudo itself: it needs a password where sudo would ask for one. */
  sudo?: boolean;
  /** It asks for an administrator's password in the system's own window (macOS's, polkit's) — never through JaiRA. */
  elevated?: boolean;
  /** It names the version wanted (a versioned package, a version flag, a version manager) rather than installing the latest. */
  pinned?: boolean;
  /**
   * Folders what it installs lands in, beyond where the binary is looked for — a keg-only formula's
   * `opt` folder, a version manager's versions — as usual places are written (`~`, `$NAME`, `*`).
   */
  lands?: string[];
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

function plan(method: InstallMethod, via: string, file: string, args: string[], display: string, platform: string, extra: Pick<InstallPlan, "sudo" | "elevated" | "pinned" | "lands"> = {}): InstallPlan {
  const env = withDirOnPath(file, platform);
  return {
    method,
    via,
    display,
    file,
    args,
    ...(env !== undefined ? { env } : {}),
    ...(extra.sudo === true ? { sudo: true } : {}),
    ...(extra.elevated === true ? { elevated: true } : {}),
    ...(extra.pinned === true ? { pinned: true } : {}),
    ...(extra.lands !== undefined && extra.lands.length > 0 ? { lands: extra.lands } : {}),
  };
}

/**
 * The line a version manager needs in the person's shell profile for their terminals to have what it
 * installs — fnm's env, mise's activation — added once, by the program's own path (a Homebrew fnm is not
 * on a Finder app's PATH, nor perhaps on the profile's before the line), unless the profile has one:
 * fnm's script writes its own. zsh's `.zshrc`, bash's `.bashrc` (a Mac's login `.bash_profile`, or
 * `.profile`), fish's `conf.d`; another shell is left as it is.
 */
function profileLine(manager: "fnm" | "mise", tool: string): string {
  const program = shq(tool);
  const zsh = manager === "fnm" ? `eval "$(${program} env --use-on-cd --shell zsh)"` : `eval "$(${program} activate zsh)"`;
  const bashLine = manager === "fnm" ? `eval "$(${program} env --use-on-cd --shell bash)"` : `eval "$(${program} activate bash)"`;
  const fish = manager === "fnm" ? `${program} env --use-on-cd --shell fish | source` : `${program} activate fish | source`;
  const marker = manager === "fnm" ? "fnm env" : "mise activate";
  return [
    `case "\${SHELL##*/}" in`,
    `zsh) rc="\${ZDOTDIR:-$HOME}/.zshrc"; line=${shq(zsh)} ;;`,
    `bash) rc="$HOME/.bashrc"; if [ "$(uname)" = Darwin ]; then rc="$HOME/.bash_profile"; [ -f "$rc" ] || rc="$HOME/.profile"; fi; line=${shq(bashLine)} ;;`,
    `fish) rc="$HOME/.config/fish/conf.d/${manager}.fish"; line=${shq(fish)} ;;`,
    `*) rc="" ;;`,
    `esac;`,
    `if [ -n "$rc" ] && ! grep -qs ${shq(marker)} "$rc"; then mkdir -p "$(dirname "$rc")" && printf '\\n# ${manager}, set up by JaiRA\\n%s\\n' "$line" >> "$rc"; fi; true`,
  ].join(" ");
}

/** PowerShell that adds a folder to the person's own PATH, in the registry, once — for terminals opened after. */
function WINDOWS_PATH_ADD(dir: string): string {
  return [
    `$p = "${dir}"`,
    `$u = [string][Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if (-not (($u -split ';') -contains $p)) { [Environment]::SetEnvironmentVariable('Path', ((@($u.TrimEnd(';'), $p) | Where-Object { $_ }) -join ';'), 'User') }`,
    `exit 0`,
  ].join("; ");
}

/** A word for PowerShell, quoted. */
function psq(word: string): string {
  return `'${word.replace(/'/g, "''")}'`;
}

/** A word for `sh`, quoted when it needs to be. */
function shq(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A package an installer names for this version — `node@22`, `python@3.12` — when it has one for it. */
function versionedName(spec: VersionedName | undefined, pin: string | undefined): string | undefined {
  if (spec === undefined || pin === undefined) return undefined;
  const parts = pin.split(".");
  if (!/^\d/.test(pin)) return undefined;
  const needsMinor = spec.name.includes("{minor}");
  if (needsMinor && parts.length < 2) return undefined;
  const key = needsMinor ? parts.slice(0, 2).join(".") : spec.name.includes("{major}") ? parts[0]! : pin;
  if (spec.known !== undefined && !spec.known.includes(key)) return undefined;
  return spec.name.replace("{major}", parts[0]!).replace("{minor}", parts.slice(0, 2).join(".")).replace("{version}", pin);
}

/** Homebrew's prefix, from its program's path (`/opt/homebrew/bin/brew` → `/opt/homebrew`). */
function brewPrefix(brew: string): string | undefined {
  return /\/bin\/brew$/.test(brew) ? posix.dirname(posix.dirname(brew)) : undefined;
}

/** pkg-config, added to a library's install where the machine has none — or the library cannot be found after. */
function withPkgConfig(pkg: ToolPackage, facts: InstallFacts, names: readonly string[], pkgConfigName: string): string[] {
  return pkg.pkgConfig !== undefined && facts.tools["pkg-config"] === undefined ? [...names, pkgConfigName] : [...names];
}

/** The native installer: its script, run the way its page says to — where the vendor ships one for this system. */
function nativeInstall(pkg: ToolPackage, facts: InstallFacts, want: VersionWant = { any: true }): InstallPlan | undefined {
  const native = pkg.native;
  if (native === undefined) return undefined;
  // A toolchain channel (`nightly`) is a version to rustup's script; `latest` and `lts` are its default.
  const asked = want.pin ?? (want.channel !== undefined && want.channel !== "latest" && want.channel !== "lts" ? want.channel : undefined);
  const windows = facts.platform === "win32";
  const versioned = asked !== undefined ? (windows ? native.versioned?.windows : native.versioned?.posix)?.replace("{version}", asked) : undefined;
  // A script that asks for a password in the system's window: on Linux, polkit's, which needs a desktop.
  if (native.darwinArm64Only === true && facts.platform === "darwin" && facts.arch !== undefined && facts.arch !== "arm64") return undefined;
  const elevated = native.elevated?.includes(facts.platform) === true;
  if (elevated && facts.platform === "linux" && facts.tools.pkexec === undefined) return undefined;
  const extra = { ...(native.sudo === true ? { sudo: true } : {}), ...(elevated ? { elevated: true } : {}), ...(versioned !== undefined ? { pinned: true } : {}) };
  if (windows) {
    const script = versioned ?? native.windows;
    if (script === undefined) return undefined;
    return plan("native", INSTALL_VIA.native, facts.tools.powershell ?? "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], versioned === undefined ? (native.shown?.windows ?? script) : script, facts.platform, extra);
  }
  const script = versioned ?? (facts.platform === "darwin" ? (native.darwin ?? native.posix) : native.posix);
  if (script === undefined || facts.tools.curl === undefined) return undefined;
  // A script of several lines is shown as the command a person would recognise for it.
  const display = versioned === undefined ? (facts.platform === "darwin" ? (native.shown?.darwin ?? native.shown?.posix) : native.shown?.posix) : undefined;
  return plan("native", INSTALL_VIA.native, facts.tools.bash ?? "bash", ["-c", script], display ?? script, facts.platform, extra);
}

/**
 * Which program runs an installer: the one the install itself names (`own`, when it is there), else
 * the one found. On Windows the bare name, since the `.cmd` shim resolution needs a name to look up —
 * unless it was found only where this app's PATH does not reach (installed a step before): its path.
 */
function program(facts: InstallFacts, tool: InstallTool, own?: string): string | undefined {
  if (facts.platform === "win32") return facts.tools[tool] !== undefined ? (facts.offPath?.includes(tool) === true ? facts.tools[tool] : tool) : own;
  return own !== undefined && (facts.has?.(own) ?? true) ? own : facts.tools[tool];
}

/**
 * The update for a tool installed this way — or, for a broken one, the reinstall — and undefined when
 * the way is unknown or its installer cannot be found.
 */
function updatePlan(pkg: ToolPackage, facts: InstallFacts, origin: InstallOrigin): InstallPlan | undefined {
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
      return plan("homebrew", INSTALL_VIA.homebrew, brew, args, ["brew", ...args].join(" "), platform);
    }
    case "npm":
    case "bun":
    case "pnpm":
      return npmFamilyPlan(origin.method, facts, origin, `${origin.npmName}@latest`);
    case "winget": {
      if (pkg.winget === undefined || found.broken) return undefined;
      const winget = program(facts, "winget", "winget");
      const args = ["upgrade", "--id", pkg.winget, "--exact", "--disable-interactivity"];
      return plan("winget", INSTALL_VIA.winget, winget!, args, `winget upgrade --id ${pkg.winget} --exact`, platform);
    }
    case "chocolatey":
      return pkg.choco !== undefined ? chocoPlan(facts, "upgrade", pkg.choco) : undefined;
    case "scoop":
      return pkg.scoop !== undefined ? scoopPlan(facts, "update", pkg.scoop) : undefined;
    case "command-line-tools":
    case "apt":
    case "dnf":
      // Apple's Software Update brings the tools up to date, and the system's package manager the rest
      // of the system — not anything JaiRA runs.
      return undefined;
    default:
      return isVersionManager(origin.method) ? managerPlan(origin.method, pkg, facts, { any: true, channel: "latest" }) : undefined;
  }
}

/** npm, Bun or pnpm installing `spec` (`name@version`) globally, by the program of the prefix it was installed under. */
function npmFamilyPlan(method: "npm" | "bun" | "pnpm", facts: InstallFacts, origin: InstallOrigin, spec: string): InstallPlan | undefined {
  const { platform } = facts;
  if (origin.npmName === undefined) return undefined;
  if (method === "npm") {
    // The npm of the prefix it was installed under: under nvm, every Node has its own.
    const own = origin.prefix !== undefined && platform !== "win32" ? posix.join(origin.prefix, "bin", "npm") : undefined;
    const npm = program(facts, "npm", own);
    if (npm === undefined) return undefined;
    const args = ["install", "-g", spec];
    return plan("npm", INSTALL_VIA.npm, npm, args, ["npm", ...args].join(" "), platform);
  }
  const tool = program(facts, method, method === "bun" && platform !== "win32" ? posix.join(facts.home, ".bun", "bin", "bun") : undefined);
  if (tool === undefined) return undefined;
  const args = ["add", "-g", spec];
  return plan(method, INSTALL_VIA[method], tool, args, [method, ...args].join(" "), platform);
}

/**
 * Chocolatey's install or upgrade, run as administrator: it writes under %ProgramData%, and run without
 * the rights it warns and then fails. PowerShell asks Windows for them — the person answers Windows'
 * own prompt — and waits for choco, whose exit code is the answer (its output stays in its own window).
 */
function chocoPlan(facts: InstallFacts, verb: "install" | "upgrade", id: string, version?: string): InstallPlan | undefined {
  const choco = facts.tools.choco;
  if (facts.platform !== "win32" || choco === undefined) return undefined;
  const quote = (one: string): string => `'${one.replace(/'/g, "''")}'`;
  const versionArgs = version !== undefined ? ["--version", version, ...(verb === "upgrade" ? ["--allow-downgrade"] : [])] : [];
  const script = `$p = Start-Process -FilePath ${quote(choco)} -ArgumentList ${[verb, id, ...versionArgs, "-y", "--no-progress"].map(quote).join(",")} -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  const display = `choco ${verb} ${id}${version !== undefined ? ` --version ${version}` : ""} -y (as administrator)`;
  return plan("chocolatey", INSTALL_VIA.chocolatey, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], display, facts.platform, { elevated: true, ...(version !== undefined ? { pinned: true } : {}) });
}

/** Scoop's install or update — in the person's own folder, so no rights are asked for. A package in another bucket adds the bucket first. */
function scoopPlan(facts: InstallFacts, verb: "install" | "update", name: string, version?: string): InstallPlan | undefined {
  if (facts.platform !== "win32" || facts.tools.scoop === undefined) return undefined;
  const bucket = verb === "install" && name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined;
  const bare = verb === "update" ? name.slice(name.indexOf("/") + 1) : name;
  const target = version !== undefined ? `${bare}@${version}` : bare;
  const extra = version !== undefined ? { pinned: true } : {};
  if (bucket === undefined) return plan("scoop", INSTALL_VIA.scoop, "scoop", [verb, target], `scoop ${verb} ${target}`, facts.platform, extra);
  // Scoop is PowerShell; adding a bucket already there is a warning, not a failure.
  const display = `scoop bucket add ${bucket}; scoop install ${target}`;
  return plan("scoop", INSTALL_VIA.scoop, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", `scoop bucket add ${bucket} *> $null; scoop install ${target}; exit $LASTEXITCODE`], display, facts.platform, extra);
}

/** WinGet's install, with its agreements accepted here, since nobody can answer them: stdin is closed. */
function wingetInstall(facts: InstallFacts, id: string, version?: string, pinned = false): InstallPlan {
  const args = ["install", "--id", id, "--exact", ...(version !== undefined ? ["--version", version] : []), "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];
  return plan("winget", INSTALL_VIA.winget, program(facts, "winget") ?? "winget", args, `winget install --id ${id} --exact${version !== undefined ? ` --version ${version}` : ""}`, facts.platform, pinned || version !== undefined ? { pinned: true } : {});
}

/**
 * apt or dnf, as root: through `sudo -n`, which fails at once rather than ask for a password nobody
 * can type (stdin is closed) — or directly, for a process that is root already. What is shown is
 * what a person runs on that machine, where sudo can ask them.
 */
function systemPlan(kind: "apt" | "dnf", pkg: ToolPackage, facts: InstallFacts, want: VersionWant): InstallPlan | undefined {
  if (facts.platform !== "linux") return undefined;
  const tool = kind === "apt" ? facts.tools["apt-get"] : facts.tools.dnf;
  if (tool === undefined || (facts.root !== true && facts.tools.sudo === undefined && facts.tools.pkexec === undefined)) return undefined;
  const versioned = versionedName(pkg.versioned?.[kind], want.pin);
  const base = versioned !== undefined ? [versioned] : (pkg[kind] ?? []);
  if (base.length === 0) return undefined;
  const names = withPkgConfig(pkg, facts, base, kind === "apt" ? "pkg-config" : "pkgconf-pkg-config");
  const shown = `${kind === "apt" ? "apt-get" : "dnf"} install -y ${names.join(" ")}`;
  // apt's own questions (a timezone, a service restart) answered by their defaults.
  const command = kind === "apt" ? ["env", "DEBIAN_FRONTEND=noninteractive", tool, "install", "-y", ...names] : [tool, "install", "-y", ...names];
  const extra = { ...(versioned !== undefined ? { pinned: true } : {}) };
  if (facts.root === true) return plan(kind, INSTALL_VIA[kind], command[0]!, command.slice(1), shown, facts.platform, extra);
  // On a desktop, polkit asks for the password in its own window; elsewhere `sudo -n`, which fails
  // rather than ask where nobody can answer.
  if (facts.tools.pkexec !== undefined) return plan(kind, INSTALL_VIA[kind], facts.tools.pkexec, command, `sudo ${shown}`, facts.platform, { ...extra, elevated: true });
  return plan(kind, INSTALL_VIA[kind], facts.tools.sudo!, ["-n", ...command], `sudo ${shown}`, facts.platform, { ...extra, sudo: true });
}

/**
 * A version manager installing the version wanted — it installs beside what it already has, and
 * changes no default: the installed one is found where the manager keeps it ({@link InstallPlan.lands}).
 * With `makeDefault` (Node.js installed for an agent that needs it) it is made the default too, so the
 * person's own shell has it as well — where the manager has a default to make.
 */
export function managerPlan(manager: VersionManager, pkg: ToolPackage, facts: InstallFacts, want: VersionWant, makeDefault = false): InstallPlan | undefined {
  const tool = facts.tools[manager];
  if (tool === undefined) return undefined;
  const { platform } = facts;
  const name = managedName(pkg, manager);
  const pin = want.pin;
  const glob = pin ?? "";
  const bash = facts.tools.bash ?? "bash";
  const windows = platform === "win32";
  const pinned = { pinned: pin !== undefined || (want.channel !== undefined && want.channel !== "latest") };
  switch (manager) {
    case "nvm": {
      if (windows) {
        // nvm-windows: a program, not a function. `use` points %NVM_SYMLINK% at the version — every
        // terminal's Node — and asks Windows for the rights to, in Windows' own prompt.
        const arg = pin ?? (want.channel === "lts" ? "lts" : "latest");
        const use = makeDefault ? `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ${psq(tool)} use ${arg}` : "";
        const script = `& ${psq(tool)} install ${arg}${use}; exit $LASTEXITCODE`;
        return plan("nvm", INSTALL_VIA.nvm, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], `nvm install ${arg}${makeDefault ? ` && nvm use ${arg}` : ""}`, platform, {
          ...pinned,
          lands: ["%NVM_SYMLINK%", `%NVM_HOME%\\v${glob}*`],
        });
      }
      // A shell function, defined by sourcing nvm.sh — which takes NVM_DIR as its own folder when it is
      // not set. Homebrew's nvm.sh is in Homebrew's folder and keeps its versions in ~/.nvm, as its
      // caveat has the person's profile say; one the person's terminal names is theirs.
      const nvmDir = facts.env?.["NVM_DIR"] ?? (/\/(opt|Cellar)\/nvm\//.test(tool) ? posix.join(facts.home, ".nvm") : posix.dirname(tool));
      const arg = pin ?? (want.channel === "lts" ? "--lts" : "node");
      const alias = pin ?? (want.channel === "lts" ? "lts/*" : "node");
      const then = makeDefault ? ` && nvm alias default ${shq(alias)}` : "";
      const script = `export NVM_DIR=${shq(nvmDir)}; mkdir -p "$NVM_DIR" && source ${shq(tool)} && nvm install ${arg}${then}`;
      return plan("nvm", INSTALL_VIA.nvm, bash, ["-lc", script], `nvm install ${arg}${then}`, platform, {
        ...pinned,
        lands: [`${nvmDir}/versions/node/v${glob}*/bin`],
      });
    }
    case "fnm": {
      const arg = pin ?? (want.channel === "lts" ? "--lts" : "--latest");
      const lands = windows
        ? [`%FNM_DIR%\\node-versions\\v${glob}*\\installation`, `%APPDATA%\\fnm\\node-versions\\v${glob}*\\installation`]
        : [`$FNM_DIR/node-versions/v${glob}*/installation/bin`, `~/.local/share/fnm/node-versions/v${glob}*/installation/bin`, `~/Library/Application Support/fnm/node-versions/v${glob}*/installation/bin`];
      if (makeDefault) {
        // `--lts` names what it installed `lts-latest`; `--latest`, `latest-…`: the version, by `fnm current`'s alias.
        const alias = pin ?? (want.channel === "lts" ? "lts-latest" : "latest");
        const display = `fnm install ${arg} && fnm default ${alias}`;
        if (windows) {
          // A terminal has fnm's Node only once fnm's env is in its profile; its default's folder — a
          // junction fnm repoints at each `fnm default` — on the person's PATH serves every one of them.
          const script = [
            `& ${psq(tool)} install ${arg}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
            `& ${psq(tool)} default ${alias}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
            WINDOWS_PATH_ADD("$(if ($env:FNM_DIR) { $env:FNM_DIR } else { Join-Path $env:APPDATA 'fnm' })\\aliases\\default"),
          ].join("; ");
          return plan("fnm", INSTALL_VIA.fnm, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], `${display}, and its default on your PATH`, platform, { ...pinned, lands });
        }
        const script = `${shq(tool)} install ${arg} && ${shq(tool)} default ${shq(alias)} && ${profileLine("fnm", tool)}`;
        return plan("fnm", INSTALL_VIA.fnm, bash, ["-c", script], `${display}, and fnm's env in your shell's profile`, platform, { ...pinned, lands });
      }
      return plan("fnm", INSTALL_VIA.fnm, tool, ["install", arg], `fnm install ${arg}`, platform, { ...pinned, lands });
    }
    case "volta": {
      // `fetch`, not `install`: install would make it the person's default everywhere — unless that is wanted.
      const spec = `${name}@${pin ?? (want.channel === "lts" ? "lts" : "latest")}`;
      if (makeDefault) return plan("volta", INSTALL_VIA.volta, tool, ["install", spec], `volta install ${spec}`, platform, { ...pinned, lands: windows ? ["%LOCALAPPDATA%\\Volta\\bin"] : ["$VOLTA_HOME/bin", "~/.volta/bin"] });
      const lands = windows ? [`%LOCALAPPDATA%\\Volta\\tools\\image\\${name}\\${glob}*`] : [`$VOLTA_HOME/tools/image/${name}/${glob}*/bin`, `~/.volta/tools/image/${name}/${glob}*/bin`];
      return plan("volta", INSTALL_VIA.volta, tool, ["fetch", spec], `volta fetch ${spec}`, platform, { ...pinned, lands });
    }
    case "mise": {
      const spec = `${name}@${pin ?? (want.channel === "lts" ? "lts" : "latest")}`;
      const lands = windows
        ? [`%LOCALAPPDATA%\\mise\\installs\\${name}\\${glob}*`, `%LOCALAPPDATA%\\mise\\installs\\${name}\\${glob}*\\bin`]
        : [`$MISE_DATA_DIR/installs/${name}/${glob}*/bin`, `~/.local/share/mise/installs/${name}/${glob}*/bin`];
      // `use -g` installs it and makes it the global one, in mise's own config — which a terminal reads
      // once mise is activated in its profile, which mise's own script leaves to the person.
      if (makeDefault && !windows) return plan("mise", INSTALL_VIA.mise, bash, ["-c", `${shq(tool)} use -g ${shq(spec)} && ${profileLine("mise", tool)}`], `mise use -g ${spec}, and mise's activation in your shell's profile`, platform, { ...pinned, lands });
      if (makeDefault) return plan("mise", INSTALL_VIA.mise, tool, ["use", "-g", spec], `mise use -g ${spec}`, platform, { ...pinned, lands });
      return plan("mise", INSTALL_VIA.mise, tool, ["install", spec], `mise install ${spec}`, platform, { ...pinned, lands });
    }
    case "asdf": {
      if (windows) return undefined;
      // Its plugin first, which is a warning when it is there already; `latest:22` is the newest 22.
      const version = isExactVersion(pin) ? pin : pin !== undefined ? `latest:${pin}` : "latest";
      const script = `${shq(tool)} plugin add ${shq(name)} >/dev/null 2>&1; ${shq(tool)} install ${shq(name)} ${version}`;
      return plan("asdf", INSTALL_VIA.asdf, bash, ["-c", script], `asdf install ${name} ${version}`, platform, {
        ...pinned,
        lands: [`$ASDF_DATA_DIR/installs/${name}/${glob}*/bin`, `~/.asdf/installs/${name}/${glob}*/bin`],
      });
    }
    case "pyenv": {
      if (windows) return undefined;
      // pyenv takes a prefix (`3.12`) as the newest release it starts.
      const version = pin ?? "3";
      return plan("pyenv", INSTALL_VIA.pyenv, tool, ["install", "--skip-existing", version], `pyenv install --skip-existing ${version}`, platform, {
        ...pinned,
        lands: [`$PYENV_ROOT/versions/${glob}*/bin`, `~/.pyenv/versions/${glob}*/bin`],
      });
    }
    case "uv": {
      const args = ["python", "install", ...(pin !== undefined ? [pin] : [])];
      // uv's data folder is `$XDG_DATA_HOME/uv` or `~/.local/share/uv`, and on Windows `%APPDATA%\uv\data`;
      // its Pythons are under `python` there, unless UV_PYTHON_INSTALL_DIR says otherwise.
      const lands = windows
        ? [`%UV_PYTHON_INSTALL_DIR%\\cpython-${glob}*`, `%APPDATA%\\uv\\data\\python\\cpython-${glob}*`]
        : [`$UV_PYTHON_INSTALL_DIR/cpython-${glob}*/bin`, `$XDG_DATA_HOME/uv/python/cpython-${glob}*/bin`, `~/.local/share/uv/python/cpython-${glob}*/bin`];
      return plan("uv", INSTALL_VIA.uv, tool, args, ["uv", ...args].join(" "), platform, { ...pinned, lands });
    }
    case "rbenv": {
      if (windows) return undefined;
      const lands = [`$RBENV_ROOT/versions/${glob}*/bin`, `~/.rbenv/versions/${glob}*/bin`];
      if (pin !== undefined && isExactVersion(pin)) return plan("rbenv", INSTALL_VIA.rbenv, tool, ["install", "--skip-existing", pin], `rbenv install --skip-existing ${pin}`, platform, { ...pinned, lands });
      // An older ruby-build wants a whole version: the newest of its list (`-l`, the newest of each line)
      // that the prefix starts. A current one resolves a prefix itself, and is given it when the list has none.
      const prefix = pin !== undefined ? `^${pin.replace(/\./g, "\\.")}(\\.|$)` : "^[0-9]+\\.[0-9]+\\.[0-9]+$";
      const script = `v=$(${shq(tool)} install -l 2>/dev/null | grep -E ${shq(prefix)} | tail -1); ${shq(tool)} install --skip-existing "\${v:-${pin ?? ""}}"`;
      return plan("rbenv", INSTALL_VIA.rbenv, bash, ["-c", script], `rbenv install --skip-existing <the newest ${pin ?? "stable"}${pin !== undefined ? ".x" : ""}>`, platform, { ...pinned, lands });
    }
    case "rustup": {
      const toolchain = pin ?? (want.channel === "nightly" || want.channel === "beta" ? want.channel : "stable");
      // With no Rust here yet, the toolchain is made the default — there is none for it to replace.
      const args = facts.found === undefined ? ["default", toolchain] : ["toolchain", "install", toolchain];
      const lands = windows ? [`~\\.rustup\\toolchains\\${toolchain}*\\bin`] : [`$RUSTUP_HOME/toolchains/${toolchain}*/bin`, `~/.rustup/toolchains/${toolchain}*/bin`];
      return plan("rustup", INSTALL_VIA.rustup, tool, args, ["rustup", ...args].join(" "), platform, { pinned: true, lands });
    }
    case "corepack": {
      // Corepack, beside the node it came with (Node 14.19 to 24) or installed apart (npm's or Homebrew's
      // `corepack`, from Node 25): its shim beside it, then the version — a range is its newest — made the global one.
      const spec = `${name}@${pin ?? "latest"}`;
      const display = `corepack enable ${name} && corepack install -g ${spec}`;
      const lands = [windows ? tool.replace(/[\\/][^\\/]*$/, "") : posix.dirname(tool)];
      if (windows) {
        const script = `corepack enable ${name}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; corepack install -g ${spec}; exit $LASTEXITCODE`;
        return plan("corepack", INSTALL_VIA.corepack, facts.tools.powershell ?? "powershell", ["-NoProfile", "-NonInteractive", "-Command", script], display, platform, { ...pinned, lands });
      }
      return plan("corepack", INSTALL_VIA.corepack, bash, ["-c", `${shq(tool)} enable ${shq(name)} && ${shq(tool)} install -g ${shq(spec)}`], display, platform, { ...pinned, lands });
    }
  }
}

/** The ways to install a tool from here, in its vendor's order ({@link ToolPackage.order}), each for the version wanted where it can name it. */
export function installPlans(pkg: ToolPackage, facts: InstallFacts, want: VersionWant = { any: true }): InstallPlan[] {
  const { platform } = facts;
  const pin = want.pin;
  const way = (method: InstallMethod): InstallPlan | undefined => {
    switch (method) {
      case "native":
        return nativeInstall(pkg, facts, want);
      case "homebrew": {
        const brew = facts.tools.brew;
        // A cask is macOS's; a formula installs on Linux as well.
        if (pkg.brew === undefined || brew === undefined || platform === "win32" || (pkg.brew.cask && platform !== "darwin")) return undefined;
        const versioned = pkg.brew.cask ? undefined : versionedName(pkg.versioned?.homebrew, pin);
        const name = versioned ?? pkg.brew.name;
        const args = pkg.brew.cask ? ["install", "--cask", name] : ["install", ...withPkgConfig(pkg, facts, [name], "pkgconf")];
        // A keg-only formula (a versioned one, Ruby, libpq) is not linked into the prefix: its own folder.
        const prefix = brewPrefix(brew);
        const lands = !pkg.brew.cask && prefix !== undefined && pkg.pkgConfig === undefined ? [posix.join(prefix, "opt", name.split("/").pop()!, (versioned !== undefined ? pkg.versioned?.homebrew?.bin : undefined) ?? "bin")] : [];
        return plan("homebrew", INSTALL_VIA.homebrew, brew, args, ["brew", ...args].join(" "), platform, { ...(versioned !== undefined ? { pinned: true } : {}), lands });
      }
      case "npm": {
        const npm = program(facts, "npm");
        if (pkg.npm === undefined || npm === undefined) return undefined;
        const args = ["install", "-g", pin !== undefined ? `${pkg.npm.name}@${pin}` : pkg.npm.name];
        return plan("npm", INSTALL_VIA.npm, npm, args, ["npm", ...args].join(" "), platform, pin !== undefined ? { pinned: true } : {});
      }
      case "winget": {
        if (pkg.winget === undefined || platform !== "win32" || facts.tools.winget === undefined) return undefined;
        const versioned = versionedName(pkg.versioned?.winget, pin);
        if (versioned !== undefined) return wingetInstall(facts, versioned, isExactVersion(pin) ? pin : undefined, true);
        return wingetInstall(facts, pkg.winget, isExactVersion(pin) ? pin : undefined);
      }
      case "chocolatey": {
        if (pkg.choco === undefined) return undefined;
        const versioned = versionedName(pkg.versioned?.chocolatey, pin);
        const one = chocoPlan(facts, "install", versioned ?? pkg.choco, isExactVersion(pin) ? pin : undefined);
        return one !== undefined && versioned !== undefined ? { ...one, pinned: true } : one;
      }
      case "scoop":
        return pkg.scoop !== undefined ? scoopPlan(facts, "install", pkg.scoop, isExactVersion(pin) ? pin : undefined) : undefined;
      case "command-line-tools": {
        // It asks macOS to install them, in Apple's own window, and exits at once (`installGitCli` waits).
        if (pkg.xcode !== true || platform !== "darwin") return undefined;
        const xcodeSelect = facts.tools["xcode-select"] ?? "/usr/bin/xcode-select";
        return plan("command-line-tools", INSTALL_VIA["command-line-tools"], xcodeSelect, ["--install"], "xcode-select --install", platform);
      }
      case "apt":
      case "dnf":
        return systemPlan(method, pkg, facts, want);
      default:
        return isVersionManager(method) && pkg.managers?.includes(method) === true ? managerPlan(method, pkg, facts, want) : undefined;
    }
  };
  return pkg.order.flatMap((method) => way(method) ?? []);
}

/** Everything the facts allow: where it is, how it got there, and what installs or updates it. */
export function planOf(pkg: ToolPackage, facts: InstallFacts): { origin?: InstallOrigin; update?: InstallPlan; install: InstallPlan[] } {
  const found = facts.found;
  const origin = found !== undefined ? installOriginOf(found.real, pkg) : undefined;
  const update = found !== undefined && origin !== undefined ? updatePlan(pkg, facts, origin) : undefined;
  // Installed and working — or broken with a way back — is updated, not installed again.
  const installed = found !== undefined && (!found.broken || update !== undefined);
  return { ...(origin !== undefined ? { origin } : {}), ...(update !== undefined ? { update } : {}), install: installed ? [] : installPlans(pkg, facts) };
}

/**
 * What brings a tool found here to the version wanted by the installer that put it here: a version
 * manager's install, a versioned formula, `npm i -g name@22`, a pinned WinGet or Chocolatey upgrade.
 * With nothing pinned, the update.
 */
export function originPlan(pkg: ToolPackage, facts: InstallFacts, origin: InstallOrigin, want: VersionWant): InstallPlan | undefined {
  const pin = want.pin;
  if (isVersionManager(origin.method)) return managerPlan(origin.method, pkg, facts, want);
  if (pin === undefined && want.channel === undefined) return updatePlan(pkg, facts, origin);
  switch (origin.method) {
    case "native": {
      if (pin === undefined) return updatePlan(pkg, facts, origin);
      // Its script, given the version — where it takes one.
      const again = nativeInstall(pkg, facts, want);
      return again?.pinned === true ? again : undefined;
    }
    case "homebrew": {
      if (pkg.brew === undefined || pkg.brew.cask || origin.formula !== true) return updatePlan(pkg, facts, origin);
      // The versioned formula for it; else, off a versioned one, the current formula.
      const versioned = versionedName(pkg.versioned?.homebrew, pin);
      if (versioned === undefined && !origin.name?.includes("@")) return updatePlan(pkg, facts, origin);
      const brew = program(facts, "brew", origin.prefix !== undefined ? posix.join(origin.prefix, "bin", "brew") : undefined);
      if (brew === undefined) return undefined;
      const name = versioned ?? pkg.brew.name;
      const lands = origin.prefix !== undefined ? [posix.join(origin.prefix, "opt", name.split("/").pop()!, (versioned !== undefined ? pkg.versioned?.homebrew?.bin : undefined) ?? "bin")] : [];
      return plan("homebrew", INSTALL_VIA.homebrew, brew, ["install", name], `brew install ${name}`, facts.platform, { ...(versioned !== undefined ? { pinned: true } : {}), lands });
    }
    case "npm":
    case "bun":
    case "pnpm": {
      const one = npmFamilyPlan(origin.method, facts, origin, `${origin.npmName}@${pin ?? "latest"}`);
      return one !== undefined && pin !== undefined ? { ...one, pinned: true } : one;
    }
    case "winget": {
      if (pkg.winget === undefined || facts.found?.broken === true || pin === undefined || !isExactVersion(pin)) return updatePlan(pkg, facts, origin);
      const args = ["upgrade", "--id", pkg.winget, "--exact", "--version", pin, "--disable-interactivity"];
      return plan("winget", INSTALL_VIA.winget, program(facts, "winget") ?? "winget", args, `winget upgrade --id ${pkg.winget} --exact --version ${pin}`, facts.platform, { pinned: true });
    }
    case "chocolatey":
      return pkg.choco !== undefined ? chocoPlan(facts, "upgrade", pkg.choco, isExactVersion(pin) ? pin : undefined) : undefined;
    default:
      return updatePlan(pkg, facts, origin);
  }
}

/** What a tool request asks of the plans: a version (text, never a file name) and a way it would rather. */
export interface PlanWanted {
  version?: string;
  through?: string;
}

/**
 * Every way to bring a tool to the version wanted from here, the one to run first: the installer that
 * put it here (an update, or that version through it), then the version managers this machine keeps
 * it with, then the package's own ways in its vendor's order. A pinned version puts the ways that can
 * name it before those that would install their latest. A way the request names (`through`) goes
 * first where this machine has it; where it has not, the rest are still offered.
 */
export function toolPlans(pkg: ToolPackage, facts: InstallFacts, wanted: PlanWanted = {}): InstallPlan[] {
  const want = versionWant(wanted.version);
  const found = facts.found;
  const origin = found !== undefined ? installOriginOf(found.real, pkg) : undefined;
  const candidates: InstallPlan[] = [];
  const add = (one: InstallPlan | undefined): void => {
    if (one !== undefined && !candidates.some((other) => other.method === one.method)) candidates.push(one);
  };
  if (origin !== undefined) add(originPlan(pkg, facts, origin, want));
  for (const manager of pkg.managers ?? []) if (facts.tools[manager] !== undefined) add(managerPlan(manager, pkg, facts, want));
  for (const one of installPlans(pkg, facts, want)) add(one);
  let ordered = want.pin !== undefined ? [...candidates.filter((one) => one.pinned === true), ...candidates.filter((one) => one.pinned !== true)] : candidates;
  const through = installMethodOf(wanted.through);
  if (through !== undefined) ordered = [...ordered.filter((one) => one.method === through), ...ordered.filter((one) => one.method !== through)];
  return ordered;
}

/** The way {@link toolPlans} would run first, if any. */
export function toolPlanOf(pkg: ToolPackage, facts: InstallFacts, wanted: PlanWanted = {}): InstallPlan | undefined {
  return toolPlans(pkg, facts, wanted)[0];
}
