/**
 * What JaiRA knows how to install, and from where: a {@link ToolPackage} per tool, naming it for each
 * installer that has it. The agents are in `agentInstall.ts`; the git programs and the tools a
 * project's setup asks for are here.
 *
 * A package says where its binary is looked for beyond the PATH and the installers' usual folders,
 * how it says its version, and which version managers keep it — so the lookups, the WSL script and
 * the plans are all read off this data rather than written per tool.
 *
 * Every name here was checked on 2026-11-18 against the registries themselves: Homebrew's API
 * (formulae.brew.sh — a deprecated formula still installs, a disabled one does not, and an alias
 * such as `node@26` installs the formula it names), the HashiCorp and Bun taps, WinGet's source index
 * (cdn.winget.microsoft.com), community.chocolatey.org, the Scoop buckets (Main, Extras, Java), the
 * npm registry, Debian's and Ubuntu's archives (trixie; noble and resolute) and Fedora's (43–45),
 * with CentOS Stream 9 and 10 for RHEL's. A `known` list holds the versions the registry has today.
 */
import type { GitCliName, InstallMethod } from "@jaira/shared";
import type { VersionCommand } from "./version";

/** The version managers a tool may already be kept with on a machine. */
export type VersionManager = "nvm" | "fnm" | "volta" | "mise" | "asdf" | "pyenv" | "uv" | "rbenv" | "rustup" | "corepack";

export const VERSION_MANAGERS: readonly VersionManager[] = ["nvm", "fnm", "volta", "mise", "asdf", "pyenv", "uv", "rbenv", "rustup", "corepack"];

/**
 * A package an installer names for a version: `node@{major}`, `python@{minor}`, `postgresql-client-{major}`.
 * `{major}` is the version's first part, `{minor}` its first two, `{version}` all of it.
 */
export interface VersionedName {
  name: string;
  /** The versions it exists for, as `{major}` or `{minor}` fills in; absent: whichever is asked. */
  known?: readonly string[];
  /** Homebrew: where a keg-only formula keeps its programs, under its `opt` folder — `bin` unless said. */
  bin?: string;
}

/** Where a tool comes from, for each way it can be installed. */
export interface ToolPackage {
  /** The command its installers put on the PATH — what an executor's command is matched by. */
  binary: string;
  /** Other names the same program goes by, looked for when `binary` is not found: `python` after `python3`. */
  also?: readonly string[];
  /** Its name in the catalog and to the version managers (`node`, `python`); `binary` when absent. */
  name?: string;
  /** What it is called in a sentence: `Node.js`, `the GitHub CLI`. */
  title?: string;
  /** How it says its version: `--version`, read for the first dotted number, unless said. */
  version?: VersionCommand;
  /** A native library rather than a program: found by `pkg-config --exists <this>`, its version by `--modversion`. */
  pkgConfig?: string;
  /**
   * Folders it is looked for in beyond the PATH and the installers' usual ones — its own installer's
   * (`~/.opencode/bin`, `%ProgramFiles%\Git\cmd`). `~` is the home folder, `%NAME%` and `$NAME`
   * environment variables, and a `*` part every folder there (newest version first).
   */
  dirs?: { posix?: readonly string[]; windows?: readonly string[] };
  /** Paths that are placeholders, not the program: Windows' `python.exe` that opens the Store. */
  stubs?: readonly RegExp[];
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
  /** Debian's and Ubuntu's packages for it — installed as root, through sudo. */
  apt?: readonly string[];
  /** Fedora's and RHEL's packages for it — installed as root, through sudo. */
  dnf?: readonly string[];
  /** Apple's Command Line Tools ship it: git, which a Mac has only as a placeholder until they are installed. */
  xcode?: boolean;
  /**
   * A placeholder macOS keeps at `/usr/bin/<binary>` (Java's), and how to ask whether the real one is
   * there without running it: `probe` prints the folder it is in (under `bin`), and exits non-zero
   * when there is none. A package with `xcode` asks `xcode-select -p` the same way.
   */
  appleStub?: { probe: readonly string[]; bin: string };
  /**
   * The vendor's own installer: its script, where it puts the binary (what classifies an install as
   * its), and the binary's own updater — absent where there is none, and the script is run again.
   * `versioned` is the script given a version (`{version}`); `sudo` that it asks for root itself.
   */
  native?: { posix?: string; windows?: string; paths: readonly RegExp[]; update?: readonly string[]; versioned?: { posix?: string; windows?: string }; sudo?: boolean };
  /** Packages each installer names for a version, where it has them. */
  versioned?: Partial<Record<"homebrew" | "winget" | "chocolatey" | "apt" | "dnf", VersionedName>>;
  /** The version managers that keep it, the most preferred first, and the name each knows it by when not its {@link name}. */
  managers?: readonly VersionManager[];
  managedAs?: Partial<Record<VersionManager, string>>;
  /** The ways it is offered when it is not installed, in the vendor's order of recommendation. */
  order: readonly InstallMethod[];
}

/** An agent's package — the same shape, kept under the name `agentInstall.ts` gave it. */
export type AgentPackage = ToolPackage;

/** The name a version manager knows the package by. */
export function managedName(pkg: ToolPackage, manager: VersionManager): string {
  return pkg.managedAs?.[manager] ?? pkg.name ?? pkg.binary;
}

/** What a package is called in a sentence. */
export function titleOf(pkg: ToolPackage): string {
  return pkg.title ?? pkg.name ?? pkg.binary;
}

/**
 * The git programs JaiRA checks (Settings → Connections → Git), as their makers and the package
 * managers ship them (observed 2026-11):
 *
 *  - git: on a Mac, Apple's Command Line Tools — /usr/bin/git is a placeholder that opens their
 *    installer until they are there — and Homebrew's formula. On Windows, Git for Windows by WinGet,
 *    Chocolatey or Scoop: the first two run its own installer into Program Files, which says nothing of
 *    which of them ran it, so that git has no Update here. On Linux, Homebrew's formula where there is
 *    one; the distribution's own package (apt, dnf) needs root, and is offered to a project's setup.
 *  - gh (GitHub CLI) and glab (GitLab CLI): Homebrew formulae, and a package in each Windows manager.
 */
export const GIT_CLI_PACKAGES: Readonly<Record<GitCliName, ToolPackage>> = {
  git: {
    binary: "git",
    brew: { name: "git", cask: false },
    winget: "Git.Git",
    choco: "git",
    scoop: "git",
    apt: ["git"],
    dnf: ["git"],
    xcode: true,
    // Git for Windows, however it was installed (WinGet and Chocolatey both run its own installer) —
    // in Program Files, or the person's own Programs when Program Files was not writable.
    dirs: { windows: ["%ProgramFiles%\\Git\\cmd", "%LOCALAPPDATA%\\Programs\\Git\\cmd"] },
    order: ["command-line-tools", "homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  gh: {
    binary: "gh",
    title: "the GitHub CLI",
    brew: { name: "gh", cask: false },
    winget: "GitHub.cli",
    choco: "gh",
    scoop: "gh",
    apt: ["gh"],
    dnf: ["gh"],
    // The GitHub CLI's MSI.
    dirs: { windows: ["%ProgramFiles%\\GitHub CLI"] },
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  glab: {
    binary: "glab",
    title: "the GitLab CLI",
    brew: { name: "glab", cask: false },
    winget: "GLab.GLab",
    choco: "glab",
    scoop: "glab",
    apt: ["glab"],
    dnf: ["glab"],
    // The GitLab CLI's installer, machine-wide or for the person.
    dirs: { windows: ["%ProgramFiles%\\glab", "%LOCALAPPDATA%\\Programs\\glab"] },
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
};

/** The Node version managers, the most preferred first. */
const NODE_MANAGERS: readonly VersionManager[] = ["nvm", "fnm", "volta", "mise", "asdf"];

/** A native library, found by pkg-config and installed as its development package. */
function library(pc: string, title: string, brew: string, apt: string, dnf: string): ToolPackage {
  return { binary: pc, name: pc, title, pkgConfig: pc, brew: { name: brew, cask: false }, apt: [apt], dnf: [dnf], order: ["apt", "dnf", "homebrew"] };
}

/**
 * The tools a project's setup may ask for, as each is shipped (checked 2026-11-18, as above). Each
 * lists the installers that carry a current build; the system package managers come last for a language, whose
 * distribution builds lag, and first for a library, which the system's own compiler and pkg-config
 * must find. Version managers the machine already keeps the tool with go before all of them.
 */
export const TOOL_PACKAGES: Readonly<Record<string, ToolPackage>> = {
  node: {
    binary: "node",
    name: "node",
    title: "Node.js",
    brew: { name: "node", cask: false },
    winget: "OpenJS.NodeJS",
    choco: "nodejs",
    scoop: "nodejs",
    apt: ["nodejs"],
    dnf: ["nodejs"],
    // node@20 is disabled; node@26 is `node`'s own alias (installs it, and links opt/node@26).
    versioned: { homebrew: { name: "node@{major}", known: ["22", "24", "26"] } },
    managers: NODE_MANAGERS,
    managedAs: { asdf: "nodejs" },
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  pnpm: {
    binary: "pnpm",
    name: "pnpm",
    npm: { name: "pnpm" },
    brew: { name: "pnpm", cask: false },
    winget: "pnpm.pnpm",
    choco: "pnpm",
    scoop: "pnpm",
    // Its standalone script's PNPM_HOME: the binary, and `pnpm self-update` to update it.
    native: {
      posix: "curl -fsSL https://get.pnpm.io/install.sh | sh -",
      windows: "Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression",
      paths: [/\/Library\/pnpm\/pnpm$/, /\/\.local\/share\/pnpm\/pnpm$/, /\/AppData\/Local\/pnpm\/pnpm\.exe$/i],
      update: ["self-update"],
    },
    dirs: { posix: ["~/Library/pnpm", "~/.local/share/pnpm"], windows: ["%LOCALAPPDATA%\\pnpm"] },
    managers: ["corepack", "mise"],
    order: ["npm", "native", "homebrew", "winget", "chocolatey", "scoop"],
  },
  yarn: {
    binary: "yarn",
    name: "yarn",
    npm: { name: "yarn" },
    brew: { name: "yarn", cask: false },
    winget: "Yarn.Yarn",
    choco: "yarn",
    scoop: "yarn",
    managers: ["corepack", "mise"],
    order: ["npm", "homebrew", "winget", "chocolatey", "scoop"],
  },
  bun: {
    binary: "bun",
    name: "bun",
    title: "Bun",
    npm: { name: "bun" },
    brew: { name: "oven-sh/bun/bun", cask: false },
    winget: "Oven-sh.Bun",
    scoop: "bun",
    native: { posix: "curl -fsSL https://bun.sh/install | bash", windows: "irm bun.sh/install.ps1 | iex", paths: [/\/\.bun\/bin\/bun(\.exe)?$/i], update: ["upgrade"] },
    managers: ["mise", "asdf"],
    order: ["native", "npm", "homebrew", "winget", "scoop"],
  },
  deno: {
    binary: "deno",
    name: "deno",
    title: "Deno",
    npm: { name: "deno" },
    brew: { name: "deno", cask: false },
    winget: "DenoLand.Deno",
    choco: "deno",
    scoop: "deno",
    native: { posix: "curl -fsSL https://deno.land/install.sh | sh -s -- -y", windows: "irm https://deno.land/install.ps1 | iex", paths: [/\/\.deno\/bin\//], update: ["upgrade"] },
    dirs: { posix: ["~/.deno/bin"], windows: ["~\\.deno\\bin"] },
    managers: ["mise", "asdf"],
    order: ["native", "homebrew", "winget", "chocolatey", "scoop", "npm"],
  },
  python: {
    binary: "python3",
    also: ["python"],
    name: "python",
    title: "Python",
    brew: { name: "python", cask: false },
    // python.org's installer, newest line: what Chocolatey's `python` and Scoop's install too.
    winget: "Python.Python.3.15",
    choco: "python",
    scoop: "python",
    apt: ["python3"],
    dnf: ["python3"],
    // /usr/bin/python3 on a Mac is the Command Line Tools' placeholder until they are installed.
    xcode: true,
    // The Store's placeholders, which open the Store rather than run anything.
    stubs: [/\/Microsoft\/WindowsApps\/python3?\.exe$/i],
    dirs: { windows: ["%LOCALAPPDATA%\\Programs\\Python\\Python3*"] },
    versioned: {
      // python@3.9 is disabled; python@3.15 is the formula `python` names.
      homebrew: { name: "python@{minor}", known: ["3.10", "3.11", "3.12", "3.13", "3.14", "3.15"], bin: "libexec/bin" },
      winget: { name: "Python.Python.{minor}", known: ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14", "3.15"] },
    },
    managers: ["pyenv", "uv", "mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  uv: {
    binary: "uv",
    name: "uv",
    brew: { name: "uv", cask: false },
    winget: "astral-sh.uv",
    choco: "uv",
    scoop: "uv",
    native: {
      posix: "curl -LsSf https://astral.sh/uv/install.sh | sh",
      windows: "irm https://astral.sh/uv/install.ps1 | iex",
      paths: [/\/\.local\/bin\/uv(\.exe)?$/i, /\/\.cargo\/bin\/uv(\.exe)?$/i],
      update: ["self", "update"],
    },
    order: ["native", "homebrew", "winget", "chocolatey", "scoop"],
  },
  poetry: {
    binary: "poetry",
    name: "poetry",
    title: "Poetry",
    brew: { name: "poetry", cask: false },
    apt: ["python3-poetry"],
    dnf: ["poetry"],
    native: {
      posix: "curl -sSL https://install.python-poetry.org | python3 -",
      windows: "(Invoke-WebRequest -Uri https://install.python-poetry.org -UseBasicParsing).Content | py -",
      paths: [/\/pypoetry\/venv\//i, /\/\.local\/share\/pypoetry\//],
      update: ["self", "update"],
    },
    order: ["native", "homebrew", "apt", "dnf"],
  },
  ruby: {
    binary: "ruby",
    name: "ruby",
    title: "Ruby",
    // Homebrew's ruby is keg-only: macOS has its own.
    brew: { name: "ruby", cask: false },
    // RubyInstaller with its Devkit (MSYS2), the build rubyinstaller.org recommends: without it a gem
    // with a C extension cannot be built, which most bundles have.
    winget: "RubyInstallerTeam.RubyWithDevKit.4.0",
    choco: "ruby",
    scoop: "ruby",
    apt: ["ruby-full"],
    dnf: ["ruby", "ruby-devel"],
    versioned: {
      // ruby@3.1 is disabled; ruby@4.0 is `ruby`'s own alias.
      homebrew: { name: "ruby@{minor}", known: ["3.2", "3.3", "3.4", "4.0"] },
      winget: { name: "RubyInstallerTeam.RubyWithDevKit.{minor}", known: ["3.1", "3.2", "3.3", "3.4", "4.0"] },
    },
    managers: ["rbenv", "mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  go: {
    binary: "go",
    name: "go",
    title: "Go",
    version: { args: ["version"] },
    brew: { name: "go", cask: false },
    winget: "GoLang.Go",
    choco: "golang",
    scoop: "go",
    apt: ["golang-go"],
    dnf: ["golang"],
    dirs: { posix: ["/usr/local/go/bin"], windows: ["%ProgramFiles%\\Go\\bin"] },
    // go@1.23 is disabled; go@1.27 is `go`'s own alias.
    versioned: { homebrew: { name: "go@{minor}", known: ["1.24", "1.25", "1.26", "1.27"] } },
    managers: ["mise", "asdf"],
    managedAs: { asdf: "golang" },
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  rust: {
    binary: "rustc",
    name: "rust",
    title: "Rust",
    // rustup's own installer; the toolchain it installs is then rustup's, which is how it updates.
    native: {
      posix: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
      versioned: { posix: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain {version}" },
      paths: [],
    },
    brew: { name: "rust", cask: false },
    winget: "Rustlang.Rustup",
    choco: "rustup.install",
    scoop: "rustup",
    apt: ["rustc", "cargo"],
    dnf: ["rust", "cargo"],
    managers: ["rustup", "mise", "asdf"],
    order: ["native", "homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  java: {
    binary: "java",
    name: "java",
    title: "Java",
    // `java -version` says it on stderr, and Java 8 calls itself 1.8.
    version: { args: ["-version"], pattern: /version "(?:1\.(?=\d+\.))?(\d+(?:\.\d+)*)/ },
    appleStub: { probe: ["/usr/libexec/java_home"], bin: "bin" },
    brew: { name: "openjdk", cask: false },
    // The newest LTS, as Chocolatey's `temurin` is.
    winget: "EclipseAdoptium.Temurin.25.JDK",
    choco: "temurin",
    scoop: "java/temurin-jdk",
    apt: ["default-jdk"],
    dnf: ["java-latest-openjdk-devel"],
    versioned: {
      // openjdk@8 has no bottle for a Mac; openjdk@27 is `openjdk`'s own alias.
      homebrew: { name: "openjdk@{major}", known: ["11", "17", "21", "25", "27"] },
      winget: { name: "EclipseAdoptium.Temurin.{major}.JDK", known: ["8", "11", "17", "21", "25", "26", "27"] },
      chocolatey: { name: "temurin{major}", known: ["8", "11", "17", "21", "25"] },
      // Debian 13 has 21 and 25; Ubuntu 24.04 every one of these.
      apt: { name: "openjdk-{major}-jdk", known: ["8", "11", "17", "21", "25"] },
      // Fedora has 25 (and 21 until 43) beside java-latest; RHEL 9 has 11, 17, 21 and 25, RHEL 10 21 and 25.
      // Java 8's is java-1.8.0-openjdk-devel, which this name cannot say.
      dnf: { name: "java-{major}-openjdk-devel", known: ["11", "17", "21", "25"] },
    },
    managers: ["mise"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  docker: {
    binary: "docker",
    name: "docker",
    title: "Docker",
    // Docker Desktop's cask, renamed from `docker` (now only the CLI's formula, which runs no engine).
    brew: { name: "docker-desktop", cask: true },
    winget: "Docker.DockerDesktop",
    choco: "docker-desktop",
    apt: ["docker.io"],
    dnf: ["moby-engine"],
    dirs: { posix: ["~/.docker/bin", "/Applications/Docker.app/Contents/Resources/bin"], windows: ["%ProgramFiles%\\Docker\\Docker\\resources\\bin"] },
    order: ["homebrew", "winget", "chocolatey", "apt", "dnf"],
  },
  // The Dev Containers CLI: what runs a workspace inside its Dev Container (decision 0027) — npm's
  // `@devcontainers/cli`, and a Homebrew formula.
  devcontainer: {
    binary: "devcontainer",
    name: "devcontainer",
    title: "the Dev Containers CLI",
    npm: { name: "@devcontainers/cli" },
    brew: { name: "devcontainer", cask: false },
    order: ["npm", "homebrew"],
  },
  just: {
    binary: "just",
    name: "just",
    npm: { name: "rust-just" },
    brew: { name: "just", cask: false },
    winget: "Casey.Just",
    choco: "just",
    scoop: "just",
    apt: ["just"],
    dnf: ["just"],
    managers: ["mise"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "npm", "apt", "dnf"],
  },
  mise: {
    binary: "mise",
    name: "mise",
    brew: { name: "mise", cask: false },
    winget: "jdx.mise",
    scoop: "mise",
    native: { posix: "curl -fsSL https://mise.run | sh", paths: [/\/\.local\/bin\/mise$/], update: ["self-update", "--yes"] },
    order: ["native", "homebrew", "winget", "scoop"],
  },
  asdf: {
    binary: "asdf",
    name: "asdf",
    brew: { name: "asdf", cask: false },
    dirs: { posix: ["~/.asdf/bin"] },
    order: ["homebrew"],
  },
  devbox: {
    binary: "devbox",
    name: "devbox",
    title: "Devbox",
    // Jetify ships it by its script alone (and Nix): there is no jetify-com Homebrew tap, nor a formula
    // in homebrew-core. The script writes /usr/local/bin, asking sudo for it; `-f` answers its question.
    native: { posix: "curl -fsSL https://get.jetify.com/devbox | bash -s -- -f", paths: [/^\/usr\/local\/bin\/devbox$/], update: ["version", "update"], sudo: true },
    order: ["native"],
  },
  nix: {
    binary: "nix",
    name: "nix",
    title: "Nix",
    // Determinate Systems' installer, which asks no questions with --no-confirm; it makes /nix as root.
    native: { posix: "curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install --no-confirm", paths: [/^\/nix\//], sudo: true },
    dirs: { posix: ["/nix/var/nix/profiles/default/bin", "~/.nix-profile/bin"] },
    order: ["native"],
  },
  conda: {
    binary: "conda",
    name: "conda",
    title: "conda",
    brew: { name: "miniconda", cask: true },
    winget: "Anaconda.Miniconda3",
    choco: "miniconda3",
    scoop: "extras/miniconda3",
    dirs: {
      posix: ["~/miniconda3/condabin", "~/miniforge3/condabin", "~/anaconda3/condabin", "/opt/homebrew/Caskroom/miniconda/base/condabin", "/usr/local/Caskroom/miniconda/base/condabin"],
      windows: ["~\\miniconda3\\condabin", "~\\miniforge3\\condabin", "~\\anaconda3\\condabin", "%ProgramData%\\miniconda3\\condabin"],
    },
    order: ["homebrew", "winget", "chocolatey", "scoop"],
  },
  terraform: {
    binary: "terraform",
    name: "terraform",
    title: "Terraform",
    version: { args: ["-version"] },
    // Homebrew's own terraform stopped at 1.5 when its licence changed and has since left homebrew-core;
    // HashiCorp's tap is current.
    brew: { name: "hashicorp/tap/terraform", cask: false },
    winget: "Hashicorp.Terraform",
    choco: "terraform",
    scoop: "terraform",
    managers: ["mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop"],
  },
  kubectl: {
    binary: "kubectl",
    name: "kubectl",
    version: { args: ["version", "--client"] },
    // The formula's own name (`kubectl` is its alias): what its Cellar folder, and so an update, says.
    brew: { name: "kubernetes-cli", cask: false },
    winget: "Kubernetes.kubectl",
    choco: "kubernetes-cli",
    scoop: "kubectl",
    // Fedora ships a package per Kubernetes minor (kubernetes1.37-client); each provides this name.
    dnf: ["kubernetes-client"],
    managers: ["mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "dnf"],
  },
  helm: {
    binary: "helm",
    name: "helm",
    title: "Helm",
    version: { args: ["version", "--short"] },
    brew: { name: "helm", cask: false },
    winget: "Helm.Helm",
    choco: "kubernetes-helm",
    scoop: "helm",
    dnf: ["helm"],
    managers: ["mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "dnf"],
  },
  postgres: {
    binary: "psql",
    name: "postgres",
    title: "PostgreSQL's psql",
    // libpq is the client alone, keg-only; a version is the whole server's versioned formula.
    brew: { name: "libpq", cask: false },
    // The newest major, as Chocolatey's `postgresql` and Scoop's are.
    winget: "PostgreSQL.PostgreSQL.18",
    choco: "postgresql",
    scoop: "postgresql",
    apt: ["postgresql-client"],
    dnf: ["postgresql"],
    dirs: { posix: ["/Applications/Postgres.app/Contents/Versions/latest/bin"], windows: ["%ProgramFiles%\\PostgreSQL\\*\\bin"] },
    versioned: {
      // postgresql@13 is disabled.
      homebrew: { name: "postgresql@{major}", known: ["14", "15", "16", "17", "18"] },
      winget: { name: "PostgreSQL.PostgreSQL.{major}", known: ["13", "14", "15", "16", "17", "18"] },
      chocolatey: { name: "postgresql{major}", known: ["13", "14", "15", "16", "17", "18"] },
      // A distribution carries one major (Debian 13 17, Ubuntu 24.04 16, 26.04 18); PostgreSQL's own
      // apt repository (apt.postgresql.org), which many machines add, every one from 10 to 18.
      apt: { name: "postgresql-client-{major}" },
    },
    managers: ["mise", "asdf"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  jq: {
    binary: "jq",
    name: "jq",
    brew: { name: "jq", cask: false },
    winget: "jqlang.jq",
    choco: "jq",
    scoop: "jq",
    apt: ["jq"],
    dnf: ["jq"],
    managers: ["mise"],
    order: ["homebrew", "winget", "chocolatey", "scoop", "apt", "dnf"],
  },
  "pkg-config": {
    binary: "pkg-config",
    name: "pkg-config",
    brew: { name: "pkgconf", cask: false },
    apt: ["pkg-config"],
    dnf: ["pkgconf-pkg-config"],
    order: ["homebrew", "apt", "dnf"],
  },
  vips: library("vips", "libvips", "vips", "libvips-dev", "vips-devel"),
  openssl: library("openssl", "OpenSSL", "openssl@3", "libssl-dev", "openssl-devel"),
  libffi: library("libffi", "libffi", "libffi", "libffi-dev", "libffi-devel"),
  zlib: library("zlib", "zlib", "zlib", "zlib1g-dev", "zlib-devel"),
  sqlite3: library("sqlite3", "SQLite", "sqlite", "libsqlite3-dev", "sqlite-devel"),
  libpq: library("libpq", "libpq", "libpq", "libpq-dev", "libpq-devel"),
  cairo: library("cairo", "cairo", "cairo", "libcairo2-dev", "cairo-devel"),
  libxml2: library("libxml-2.0", "libxml2", "libxml2", "libxml2-dev", "libxml2-devel"),
  libyaml: library("yaml-0.1", "libyaml", "libyaml", "libyaml-dev", "libyaml-devel"),
};

/** Other names a project may give a tool. */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  nodejs: "node",
  "node.js": "node",
  python3: "python",
  golang: "go",
  rustc: "rust",
  cargo: "rust",
  jdk: "java",
  openjdk: "java",
  psql: "postgres",
  postgresql: "postgres",
  libvips: "vips",
  "kubernetes-cli": "kubectl",
  pkgconf: "pkg-config",
  miniconda: "conda",
  "docker-desktop": "docker",
  "@devcontainers/cli": "devcontainer",
  "devcontainers": "devcontainer",
};

/** The package a tool request names — by its catalog name, an alias, or a git program's. */
export function toolPackageOf(tool: string): ToolPackage | undefined {
  const key = tool.trim().toLowerCase();
  const name = TOOL_ALIASES[key] ?? key;
  return TOOL_PACKAGES[name] ?? (GIT_CLI_PACKAGES as Readonly<Record<string, ToolPackage>>)[name];
}
