/**
 * The tool catalog and what installs a tool from here (`install/catalog.ts`, `install/plan.ts`): the
 * installer that put it here first, then the version managers the machine keeps it with, then the
 * package's own ways — a version named where the installer can name it, and apt or dnf through sudo.
 */
import { describe, expect, it } from "vitest";
import { agentInstallOf } from "../src/agentInstall";
import { GIT_CLI_PACKAGES, TOOL_PACKAGES, installFactsOf, installMethodOf, installOriginOf, planOf, toolPackageOf, toolPlans, wslFactsScript, type ToolPackage } from "../src/install";
import { DEBIAN, FEDORA, LINUX_HOME, LINUX_PATH, MAC_PATH, MAC_SYSTEM, fakeFs, type Files } from "./installRig";

const HOME = "/Users/me";
const NODE = TOOL_PACKAGES["node"]!;
const PYTHON = TOOL_PACKAGES["python"]!;
const PNPM = TOOL_PACKAGES["pnpm"]!;
const RUST = TOOL_PACKAGES["rust"]!;
const JAVA = TOOL_PACKAGES["java"]!;
const POSTGRES = TOOL_PACKAGES["postgres"]!;
const VIPS = TOOL_PACKAGES["vips"]!;

const mac = (files: Files, path: string[] = MAC_PATH) => fakeFs({ path, files: { ...MAC_SYSTEM, ...files } });
/** A Windows with PowerShell, WinGet, Chocolatey and Scoop — and whatever else `files` adds. */
const windowsMachine = (files: Files = {}) =>
  fakeFs({
    platform: "win32",
    path: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\ProgramData\\chocolatey\\bin", "C:\\Users\\me\\scoop\\shims"],
    files: {
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "file",
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file",
      "C:\\ProgramData\\chocolatey\\bin\\choco.exe": "file",
      "C:\\Users\\me\\scoop\\shims\\scoop.cmd": "file",
      ...files,
    },
  });
const linux = (files: Files, root = false) => fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files, root });
const plans = (pkg: ToolPackage, deps: ReturnType<typeof fakeFs>, version?: string, through?: string) =>
  toolPlans(pkg, installFactsOf(pkg.binary, pkg, deps), { ...(version !== undefined ? { version } : {}), ...(through !== undefined ? { through } : {}) });

describe("the catalog", () => {
  it("knows every tool a project's setup names, each with a way to install it", () => {
    const wanted = ["node", "pnpm", "yarn", "bun", "deno", "python", "uv", "poetry", "ruby", "go", "rust", "java", "docker", "just", "mise", "asdf", "devbox", "nix", "conda", "terraform", "kubectl", "helm", "postgres", "jq", "vips"];
    for (const tool of wanted) {
      expect(TOOL_PACKAGES[tool], tool).toBeDefined();
      expect(TOOL_PACKAGES[tool]!.order.length, tool).toBeGreaterThan(0);
    }
  });

  it("names every installer it orders — a way in the order is a way the package has", () => {
    for (const [name, pkg] of [...Object.entries(TOOL_PACKAGES), ...Object.entries(GIT_CLI_PACKAGES)]) {
      for (const method of pkg.order) {
        const has =
          (method === "homebrew" && pkg.brew !== undefined) ||
          (method === "npm" && pkg.npm !== undefined) ||
          (method === "winget" && pkg.winget !== undefined) ||
          (method === "chocolatey" && pkg.choco !== undefined) ||
          (method === "scoop" && pkg.scoop !== undefined) ||
          (method === "apt" && pkg.apt !== undefined) ||
          (method === "dnf" && pkg.dnf !== undefined) ||
          (method === "native" && pkg.native !== undefined) ||
          (method === "command-line-tools" && pkg.xcode === true);
        expect(has, `${name} orders ${method}`).toBe(true);
      }
    }
  });

  it("finds a tool by the other names a project gives it", () => {
    expect(toolPackageOf("nodejs")).toBe(NODE);
    expect(toolPackageOf("Python3")).toBe(PYTHON);
    expect(toolPackageOf("psql")).toBe(POSTGRES);
    expect(toolPackageOf("cargo")).toBe(RUST);
    expect(toolPackageOf("gh")).toBe(GIT_CLI_PACKAGES.gh);
    expect(toolPackageOf("aider")).toBeUndefined();
  });

  it("reads a way a request names in the words people use for it", () => {
    expect(installMethodOf("brew")).toBe("homebrew");
    expect(installMethodOf("apt-get")).toBe("apt");
    expect(installMethodOf("nvm")).toBe("nvm");
    expect(installMethodOf("choco")).toBe("chocolatey");
    expect(installMethodOf("pip")).toBeUndefined();
  });

  it("writes the WSL lookup from the package's own folders and the installers it needs", () => {
    const node = wslFactsScript(NODE);
    // A folder under a variable that is not set is no word at all, rather than one under `/`.
    expect(node).toContain('"${NVM_DIR:+$NVM_DIR/nvm.sh}" "$HOME/.nvm/nvm.sh"');
    expect(node).toContain("${VOLTA_HOME:+$VOLTA_HOME/bin}");
    expect(node).toContain("$HOME/.volta/bin");
    expect(node).toContain("apt-get");
    expect(node).toContain('printf "uid\\t%s\\n" "$(id -u)"');
    const opencode = wslFactsScript({ binary: "opencode", dirs: { posix: ["~/.opencode/bin"] }, order: ["native"] });
    expect(opencode).toContain("$HOME/.opencode/bin");
    // An agent's lookup asks for no system package manager.
    expect(opencode).not.toContain("apt-get");
  });
});

describe("a version manager the machine already keeps the tool with", () => {
  const NVM = `${HOME}/.nvm`;

  it("installs the version wanted through nvm when node lives in nvm's versions — a shell function, sourced", () => {
    const deps = mac({ [`${NVM}/nvm.sh`]: "file", [`${NVM}/versions/node/v20.18.1/bin/node`]: "file", "/opt/homebrew/bin/brew": "file" }, [`${NVM}/versions/node/v20.18.1/bin`, ...MAC_PATH]);
    const facts = installFactsOf("node", NODE, deps);
    expect(installOriginOf(facts.found!.real, NODE)?.method).toBe("nvm");
    const [first] = toolPlans(NODE, facts, { version: "22" });
    expect(first).toMatchObject({ method: "nvm", file: "/bin/bash", args: ["-lc", `export NVM_DIR=${NVM}; mkdir -p "$NVM_DIR" && source ${NVM}/nvm.sh && nvm install 22`], display: "nvm install 22", pinned: true, lands: [`${NVM}/versions/node/v22*/bin`] });
    expect(toolPlans(NODE, facts, { version: "lts" })[0]?.display).toBe("nvm install --lts");
  });

  it("prefers a version manager that is here to the package's own ways, for a tool not here yet", () => {
    const deps = mac({ [`${NVM}/nvm.sh`]: "file", "/opt/homebrew/bin/brew": "file" }, ["/opt/homebrew/bin", ...MAC_PATH]);
    expect(plans(NODE, deps, "22").map((one) => one.method)).toEqual(["nvm", "homebrew"]);
  });

  it("goes the way a request names first, and the usual way when this machine has not that one", () => {
    const deps = mac({ [`${NVM}/nvm.sh`]: "file", "/opt/homebrew/bin/brew": "file" }, ["/opt/homebrew/bin", ...MAC_PATH]);
    expect(plans(NODE, deps, "22", "brew")[0]).toMatchObject({ method: "homebrew", display: "brew install node@22", lands: ["/opt/homebrew/opt/node@22/bin"] });
    expect(plans(NODE, deps, "22", "volta")[0]?.method).toBe("nvm");
  });

  it("reads fnm, Volta, mise and asdf off their folders — by the name each knows the tool by", () => {
    expect(installOriginOf(`${HOME}/.local/share/fnm/node-versions/v22.11.0/installation/bin/node`, NODE)?.method).toBe("fnm");
    expect(installOriginOf(`${HOME}/.volta/bin/volta-shim`, NODE)?.method).toBe("volta");
    expect(installOriginOf(`${HOME}/.local/share/mise/installs/node/22.11.0/bin/node`, NODE)?.method).toBe("mise");
    expect(installOriginOf(`${HOME}/.asdf/installs/nodejs/22.11.0/bin/node`, NODE)?.method).toBe("asdf");
    // pnpm installed by npm into mise's Node is npm's.
    expect(installOriginOf(`${HOME}/.local/share/mise/installs/node/22.11.0/lib/node_modules/pnpm/bin/pnpm.cjs`, PNPM)).toMatchObject({ method: "npm", npmName: "pnpm" });
    // An agent npm put under nvm is still npm's: agents keep no version manager.
    expect(installOriginOf(`${NVM}/versions/node/v22.11.0/lib/node_modules/@openai/codex/bin/codex.js`, { binary: "codex", npm: { name: "@openai/codex" }, order: ["npm"] })?.method).toBe("npm");
  });

  it("installs with mise and asdf by the version's prefix, changing no default", () => {
    const deps = mac({ [`${HOME}/.local/bin/mise`]: "file", [`${HOME}/.asdf/bin/asdf`]: "file" });
    const [mise, asdf] = plans(NODE, deps, "22");
    expect(mise).toMatchObject({ method: "mise", args: ["install", "node@22"], lands: ["$MISE_DATA_DIR/installs/node/22*/bin", "~/.local/share/mise/installs/node/22*/bin"] });
    expect(asdf).toMatchObject({ method: "asdf", display: "asdf install nodejs latest:22" });
    expect(asdf?.args[1]).toBe(`${HOME}/.asdf/bin/asdf plugin add nodejs >/dev/null 2>&1; ${HOME}/.asdf/bin/asdf install nodejs latest:22`);
  });

  it("installs Python through pyenv when python lives in pyenv's shims, and through uv when uv is all there is", () => {
    const pyenv = mac({ [`${HOME}/.pyenv/bin/pyenv`]: "file", [`${HOME}/.pyenv/shims/python3`]: "file" }, [`${HOME}/.pyenv/shims`, ...MAC_PATH]);
    expect(plans(PYTHON, pyenv, "3.12")[0]).toMatchObject({ method: "pyenv", file: `${HOME}/.pyenv/bin/pyenv`, args: ["install", "--skip-existing", "3.12"] });
    const uv = mac({ [`${HOME}/.local/bin/uv`]: "file", "/opt/homebrew/bin/brew": "file" });
    expect(plans(PYTHON, uv, "3.12").map((one) => one.display)).toEqual(["uv python install 3.12", "brew install python@3.12"]);
  });

  it("installs pnpm through Corepack when Node has it, else npm with the version", () => {
    const corepack = mac({ "/opt/homebrew/bin/corepack": "file", "/opt/homebrew/bin/npm": "file" }, ["/opt/homebrew/bin", ...MAC_PATH]);
    expect(plans(PNPM, corepack, "9")[0]).toMatchObject({ method: "corepack", display: "corepack enable pnpm && corepack install -g pnpm@9", args: ["-c", "/opt/homebrew/bin/corepack enable pnpm && /opt/homebrew/bin/corepack install -g pnpm@9"] });
    const npm = mac({ "/usr/local/bin/npm": "file" }, ["/usr/local/bin", ...MAC_PATH]);
    expect(plans(PNPM, npm, "9")[0]).toMatchObject({ method: "npm", args: ["install", "-g", "pnpm@9"], pinned: true });
  });

  it("installs Rust's toolchain through rustup — the default when there is no Rust yet", () => {
    const bare = mac({ [`${HOME}/.cargo/bin/rustup`]: "file" });
    expect(plans(RUST, bare)[0]).toMatchObject({ method: "rustup", args: ["default", "stable"] });
    const installed = mac({ [`${HOME}/.cargo/bin/rustup`]: "file", [`${HOME}/.cargo/bin/rustc`]: { link: "rustup" } }, [`${HOME}/.cargo/bin`, ...MAC_PATH]);
    expect(plans(RUST, installed, "1.82")[0]).toMatchObject({ method: "rustup", args: ["toolchain", "install", "1.82"], lands: ["$RUSTUP_HOME/toolchains/1.82*/bin", "~/.rustup/toolchains/1.82*/bin"] });
    // No rustup at all: its own installer, given the toolchain.
    expect(plans(RUST, mac({}), "nightly")[0]).toMatchObject({ method: "native", display: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly" });
  });
});

describe("the installer that put it here, for a version", () => {
  it("installs a versioned Homebrew formula beside the current one, and upgrades for a version none names", () => {
    const files: Files = { "/opt/homebrew/bin/brew": "file", "/opt/homebrew/bin/node": { link: "../Cellar/node/25.1.0/bin/node" }, "/opt/homebrew/Cellar/node/25.1.0/bin/node": "file" };
    const deps = mac(files, ["/opt/homebrew/bin", ...MAC_PATH]);
    expect(plans(NODE, deps, "22")[0]).toMatchObject({ method: "homebrew", file: "/opt/homebrew/bin/brew", args: ["install", "node@22"], lands: ["/opt/homebrew/opt/node@22/bin"] });
    expect(plans(NODE, deps, "27")[0]).toMatchObject({ method: "homebrew", args: ["upgrade", "node"] });
    // Python's versioned formulae keep `python3` in libexec.
    const python = mac({ "/opt/homebrew/bin/brew": "file" });
    expect(plans(PYTHON, python, "3.12")[0]).toMatchObject({ args: ["install", "python@3.12"], lands: ["/opt/homebrew/opt/python@3.12/libexec/bin"] });
  });

  it("asks npm for the version by the npm of the prefix it was installed under", () => {
    const v22 = `${HOME}/.nvm/versions/node/v22.11.0`;
    const deps = mac({ [`${v22}/bin/npm`]: "file", [`${v22}/bin/pnpm`]: { link: "../lib/node_modules/pnpm/bin/pnpm.cjs" }, [`${v22}/lib/node_modules/pnpm/bin/pnpm.cjs`]: "file" }, [`${v22}/bin`, ...MAC_PATH]);
    expect(plans(PNPM, deps, "9")[0]).toMatchObject({ method: "npm", file: `${v22}/bin/npm`, args: ["install", "-g", "pnpm@9"] });
  });

  it("names an exact version to WinGet, Chocolatey and Scoop, and a versioned package where one exists", () => {
    const windows = windowsMachine();
    expect(plans(NODE, windows, "22.11.0").map((one) => one.display)).toEqual([
      "winget install --id OpenJS.NodeJS --exact --version 22.11.0",
      "choco install nodejs --version 22.11.0 -y (as administrator)",
      "scoop install nodejs@22.11.0",
    ]);
    expect(plans(PYTHON, windows, "3.12")[0]?.display).toBe("winget install --id Python.Python.3.12 --exact");
    expect(plans(POSTGRES, windows, "16").map((one) => one.display)).toEqual(["winget install --id PostgreSQL.PostgreSQL.16 --exact", "choco install postgresql16 -y (as administrator)", "scoop install postgresql"]);
  });
});

describe("apt and dnf", () => {
  it("installs through `sudo -n` — failing at once rather than asking — and shows what a person runs", () => {
    const [apt] = plans(VIPS, linux({ ...DEBIAN, "/usr/bin/pkg-config": "file" }));
    expect(apt).toMatchObject({ method: "apt", file: "/usr/bin/sudo", args: ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "install", "-y", "libvips-dev"], display: "sudo apt-get install -y libvips-dev", sudo: true });
    const [dnf] = plans(VIPS, linux({ ...FEDORA, "/usr/bin/pkg-config": "file" }));
    expect(dnf).toMatchObject({ method: "dnf", file: "/usr/bin/sudo", args: ["-n", "/usr/bin/dnf", "install", "-y", "vips-devel"], display: "sudo dnf install -y vips-devel", sudo: true });
  });

  it("runs as itself when it is root already", () => {
    const [apt] = plans(VIPS, linux({ ...DEBIAN, "/usr/bin/pkg-config": "file" }, true));
    expect(apt).toMatchObject({ file: "env", args: ["DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "install", "-y", "libvips-dev"], display: "apt-get install -y libvips-dev" });
    expect(apt?.sudo).toBeUndefined();
  });

  it("adds pkg-config to a library's install where the machine has none to find it with", () => {
    expect(plans(VIPS, linux({ ...DEBIAN }))[0]?.display).toBe("sudo apt-get install -y libvips-dev pkg-config");
    expect(plans(VIPS, linux({ ...FEDORA }))[0]?.display).toBe("sudo dnf install -y vips-devel pkgconf-pkg-config");
  });

  it("names a version's own package — Java's, PostgreSQL's — and offers none without sudo or root", () => {
    expect(plans(JAVA, linux({ ...FEDORA }), "21")[0]).toMatchObject({ display: "sudo dnf install -y java-21-openjdk-devel", pinned: true });
    expect(plans(POSTGRES, linux({ ...DEBIAN }), "16")[0]?.display).toBe("sudo apt-get install -y postgresql-client-16");
    const { "/usr/bin/sudo": _sudo, ...noSudo } = DEBIAN;
    expect(plans(VIPS, linux(noSudo))).toEqual([]);
  });

  it("is left off an agent's or a git program's row, which knows only its own ways", () => {
    const deps = linux({ ...DEBIAN });
    const gh = GIT_CLI_PACKAGES.gh;
    expect(planOf(gh, installFactsOf("gh", gh, deps)).install.map((one) => one.method)).toEqual(["apt"]);
    expect(agentInstallOf(gh, installFactsOf("gh", gh, deps)).install).toBeUndefined();
  });
});

describe("the names, as the registries have them (checked 2026-11-18)", () => {
  it("names a versioned Homebrew formula only where Homebrew has one: not a disabled one, and an alias as itself", () => {
    const deps = mac({ "/opt/homebrew/bin/brew": "file" });
    // node@20 is disabled: the current formula, not pinned. node@26 is `node`'s alias, linked as opt/node@26.
    expect(plans(NODE, deps, "20")[0]).toMatchObject({ display: "brew install node", lands: ["/opt/homebrew/opt/node/bin"] });
    expect(plans(NODE, deps, "20")[0]?.pinned).toBeUndefined();
    expect(plans(NODE, deps, "26")[0]).toMatchObject({ display: "brew install node@26", pinned: true });
    expect(plans(PYTHON, deps, "3.9")[0]?.display).toBe("brew install python");
    expect(plans(PYTHON, deps, "3.15")[0]).toMatchObject({ display: "brew install python@3.15", lands: ["/opt/homebrew/opt/python@3.15/libexec/bin"] });
    expect(plans(TOOL_PACKAGES["ruby"]!, deps, "4.0")[0]?.display).toBe("brew install ruby@4.0");
    expect(plans(TOOL_PACKAGES["go"]!, deps, "1.23")[0]?.display).toBe("brew install go");
    expect(plans(JAVA, deps, "25")[0]?.display).toBe("brew install openjdk@25");
    expect(plans(POSTGRES, deps, "13")[0]?.display).toBe("brew install libpq");
  });

  it("installs Docker Desktop by its cask's own name, kubectl by its formula's, and Devbox by its script alone", () => {
    const deps = mac({ "/opt/homebrew/bin/brew": "file" });
    expect(plans(TOOL_PACKAGES["docker"]!, deps)[0]?.display).toBe("brew install --cask docker-desktop");
    expect(plans(TOOL_PACKAGES["kubectl"]!, deps)[0]).toMatchObject({ display: "brew install kubernetes-cli", lands: ["/opt/homebrew/opt/kubernetes-cli/bin"] });
    expect(plans(TOOL_PACKAGES["terraform"]!, deps)[0]).toMatchObject({ display: "brew install hashicorp/tap/terraform", lands: ["/opt/homebrew/opt/terraform/bin"] });
    expect(plans(TOOL_PACKAGES["devbox"]!, deps).map((one) => one.display)).toEqual(["curl -fsSL https://get.jetify.com/devbox | bash -s -- -f"]);
  });

  it("installs the newest line WinGet has by default, and RubyInstaller with its Devkit", () => {
    const windows = windowsMachine();
    expect(plans(PYTHON, windows)[0]?.display).toBe("winget install --id Python.Python.3.15 --exact");
    expect(plans(POSTGRES, windows)[0]?.display).toBe("winget install --id PostgreSQL.PostgreSQL.18 --exact");
    expect(plans(JAVA, windows).map((one) => one.display)).toEqual([
      "winget install --id EclipseAdoptium.Temurin.25.JDK --exact",
      "choco install temurin -y (as administrator)",
      "scoop bucket add java; scoop install java/temurin-jdk",
    ]);
    expect(plans(TOOL_PACKAGES["ruby"]!, windows).map((one) => one.display)).toEqual(["winget install --id RubyInstallerTeam.RubyWithDevKit.4.0 --exact", "choco install ruby -y (as administrator)", "scoop install ruby"]);
    expect(plans(TOOL_PACKAGES["ruby"]!, windows, "3.3")[0]?.display).toBe("winget install --id RubyInstallerTeam.RubyWithDevKit.3.3 --exact");
    // Temurin 27 is on WinGet; Chocolatey stops at temurin25.
    expect(plans(JAVA, windows, "27").map((one) => one.display)).toEqual([
      "winget install --id EclipseAdoptium.Temurin.27.JDK --exact",
      "choco install temurin -y (as administrator)",
      "scoop bucket add java; scoop install java/temurin-jdk",
    ]);
  });

  it("names a JDK package only for a major the distributions carry", () => {
    expect(plans(JAVA, linux({ ...DEBIAN }), "17")[0]).toMatchObject({ display: "sudo apt-get install -y openjdk-17-jdk", pinned: true });
    // No Debian or Ubuntu has openjdk-23-jdk: their default JDK, not pinned.
    expect(plans(JAVA, linux({ ...DEBIAN }), "23")[0]).toMatchObject({ display: "sudo apt-get install -y default-jdk" });
    expect(plans(JAVA, linux({ ...DEBIAN }), "23")[0]?.pinned).toBeUndefined();
    expect(plans(JAVA, linux({ ...FEDORA }), "25")[0]?.display).toBe("sudo dnf install -y java-25-openjdk-devel");
    // Java 8's is java-1.8.0-openjdk-devel, which is not offered as java-8-openjdk-devel.
    expect(plans(JAVA, linux({ ...FEDORA }), "8")[0]?.display).toBe("sudo dnf install -y java-latest-openjdk-devel");
  });

  it("looks for uv's Pythons in its data folder, which on Windows is %APPDATA%\\uv\\data", () => {
    const windows = windowsMachine({ "C:\\Users\\me\\.local\\bin\\uv.exe": "file" });
    expect(plans(PYTHON, windows, "3.12")[0]).toMatchObject({
      method: "uv",
      display: "uv python install 3.12",
      lands: ["%UV_PYTHON_INSTALL_DIR%\\cpython-3.12*", "%APPDATA%\\uv\\data\\python\\cpython-3.12*"],
    });
    expect(installOriginOf("C:\\Users\\me\\AppData\\Roaming\\uv\\data\\python\\cpython-3.12.7-windows-x86_64-none\\python.exe", PYTHON)?.method).toBe("uv");
    expect(installOriginOf(`${HOME}/.local/share/uv/python/cpython-3.12.7-macos-aarch64-none/bin/python3`, PYTHON)?.method).toBe("uv");
  });
});
