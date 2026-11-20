/**
 * Installs that take more than one step (`install/chain.ts`): an agent npm installs, on a machine with
 * no Node.js or one too old for it; a cask, on a Mac with no Homebrew. The menu is a step a row, with
 * the ways to take the step after behind its arrow; a path through it runs a step at a time, each
 * planned from what the step before left on the machine.
 */
import { describe, expect, it } from "vitest";
import type { ExecutorInfo, InstallChoice } from "@jaira/shared";
import { AGENT_PACKAGES, installAgent, installChoicesFor } from "../src/agentInstall";
import { probeExecutor } from "../src/executors";
import { GIT_CLI_PACKAGES, installFactsOf, installPlans, locateBinary, stepsOf, installChoicesOf, gatherChainFacts, managerPlan, parseShellEnv, runPlan, shellAdds, shellEnvCommand, versionWant, TOOL_PACKAGES, type InstallDeps } from "../src/install";
import { DEBIAN, LINUX_HOME, LINUX_PATH, MAC_PATH, MAC_SYSTEM, fakeFs, machineExec, type Files } from "./installRig";

const GEMINI = AGENT_PACKAGES["gemini"]!;
const CODEX = AGENT_PACKAGES["codex"]!;
const HOME = "/Users/me";

/** A machine that answers `node --version` with `version` for any node, and nothing else. */
function nodeSays(version: string | undefined) {
  return machineExec((file, args) => (/\/node$/.test(file) && args[0] === "--version" ? (version !== undefined ? { stdout: `v${version}\n` } : undefined) : { code: 0 }));
}

async function menuOf(pkg = GEMINI, title = "Gemini CLI", deps: InstallDeps, version?: string): Promise<InstallChoice[] | undefined> {
  const exec = nodeSays(version);
  return installChoicesFor(pkg, title, pkg.binary, installFactsOf(pkg.binary, pkg, deps), { exec, deps });
}

/** A row's commands, in order. */
const commands = (choice: InstallChoice | undefined): string[] => (choice?.steps ?? []).map((step) => step.display);

describe("the menu, a step a row", () => {
  it("on a Mac with no Node.js and no Homebrew, Gemini's one row is Node.js — fnm first, each way then npm", async () => {
    const menu = await menuOf(GEMINI, "Gemini CLI", fakeFs({ path: MAC_PATH, files: MAC_SYSTEM, arch: "arm64" }));
    expect(menu?.map((row) => [row.key, row.name])).toEqual([["npm", "Node.js"]]);
    const node = menu![0]!;
    // A row that groups the ways: it runs nothing itself.
    expect(node.steps).toEqual([]);
    expect(node.next?.map((way) => way.key)).toEqual(["fnm", "nvm", "mise", "homebrew"]);
    const fnm = node.next![0]!;
    // fnm is not here: its row installs it first — on a Mac, its script forced past Homebrew — and makes Node.js the default.
    expect(fnm.steps.map((step) => step.title)).toEqual(["fnm", "Node.js"]);
    expect(commands(fnm)).toEqual(["curl -fsSL https://fnm.vercel.app/install | bash -s -- --force-install", "fnm install --lts && fnm default lts-latest, and fnm's env in your shell's profile"]);
    expect(fnm.next?.map((then) => commands(then))).toEqual([["npm install -g @google/gemini-cli"]]);
    expect(commands(node.next![1])).toEqual(["curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash", "nvm install --lts && nvm alias default 'lts/*'"]);
    expect(commands(node.next![2])).toEqual(["curl -fsSL https://mise.run | sh", "mise use -g node@lts, and mise's activation in your shell's profile"]);
    // Homebrew, from its signed package — which asks for a password in macOS's own window — then Node.js by it.
    const brew = node.next![3]!;
    expect(brew.steps.map((step) => [step.title, step.elevated === true])).toEqual([
      ["Homebrew", true],
      ["Node.js", false],
    ]);
    expect(commands(brew)[1]).toBe("brew install node");
  });

  it("Codex on that Mac has two rows: Node.js, and Homebrew — the one way to get it, then the cask", async () => {
    const menu = await menuOf(CODEX, "Codex", fakeFs({ path: MAC_PATH, files: MAC_SYSTEM, arch: "arm64" }));
    expect(menu?.map((row) => row.name)).toEqual(["Node.js", "Homebrew"]);
    const brew = menu![1]!;
    expect(brew.steps.map((step) => step.title)).toEqual(["Homebrew"]);
    expect(brew.next?.map((then) => commands(then))).toEqual([["brew install --cask codex"]]);
  });

  it("offers no Homebrew on an Intel Mac, which Homebrew no longer installs on", async () => {
    const menu = await menuOf(CODEX, "Codex", fakeFs({ path: MAC_PATH, files: MAC_SYSTEM, arch: "x64" }));
    expect(menu?.map((row) => row.name)).toEqual(["Node.js"]);
    expect(menu![0]!.next?.map((way) => way.key)).toEqual(["fnm", "nvm", "mise"]);
  });

  it("with Homebrew here, its Node.js is one step; with npm and a Node.js that will do, npm is the row", async () => {
    const brewed = fakeFs({ path: [...MAC_PATH, "/opt/homebrew/bin"], files: { ...MAC_SYSTEM, "/opt/homebrew/bin/brew": "file" }, arch: "arm64" });
    const node = (await menuOf(GEMINI, "Gemini CLI", brewed))![0]!;
    expect(node.next?.find((way) => way.key === "homebrew")?.steps.map((step) => step.display)).toEqual(["brew install node"]);
    // fnm comes through Homebrew where Homebrew is: its script on a Mac is deprecated for the formula.
    expect(commands(node.next?.find((way) => way.key === "fnm"))[0]).toBe("brew install fnm");

    const ready = fakeFs({ path: [...MAC_PATH, "/opt/homebrew/bin"], files: { ...MAC_SYSTEM, "/opt/homebrew/bin/node": "file", "/opt/homebrew/bin/npm": "file" } });
    const menu = await menuOf(GEMINI, "Gemini CLI", ready, "24.11.0");
    expect(menu?.map((row) => [row.key, row.name, commands(row)])).toEqual([["npm", "npm", ["npm install -g @google/gemini-cli"]]]);
    expect(menu![0]!.next).toBeUndefined();
  });

  it("brings a Node.js too old for the agent up to date the way it was installed, first — or another way", async () => {
    const old = fakeFs({
      path: [...MAC_PATH, "/opt/homebrew/bin"],
      files: {
        ...MAC_SYSTEM,
        "/opt/homebrew/bin/brew": "file",
        "/opt/homebrew/bin/node": { link: "../Cellar/node/18.20.4/bin/node" },
        "/opt/homebrew/Cellar/node/18.20.4/bin/node": "file",
        "/opt/homebrew/bin/npm": "file",
      },
    });
    const menu = await menuOf(GEMINI, "Gemini CLI", old, "18.20.4");
    expect(menu?.map((row) => row.name)).toEqual(["Node.js 20 or newer"]);
    const first = menu![0]!.next![0]!;
    expect([first.name, commands(first)]).toEqual(["Update it (Homebrew)", ["brew upgrade node"]]);
  });

  it("on Windows, fnm first too — its default's folder put on the person's PATH, so their terminals have it", async () => {
    const deps = fakeFs({ platform: "win32", home: "C:\\Users\\me", path: ["C:\\Windows\\System32", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps"], files: { "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file", "C:\\Windows\\System32\\powershell.exe": "file" }, env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming" } });
    const node = (await menuOf(GEMINI, "Gemini CLI", deps))![0]!;
    // Chocolatey too, though it is not here: installed first.
    expect(node.next?.map((way) => way.key)).toEqual(["fnm", "mise", "winget", "chocolatey"]);
    expect(commands(node.next![0])).toEqual(["winget install --id Schniz.fnm --exact", "fnm install --lts && fnm default lts-latest, and its default on your PATH"]);
    expect(commands(node.next![2])).toEqual(["winget install --id OpenJS.NodeJS --exact"]);
  });

  it("finds WinGet where Windows keeps it — an app execution alias, which neither stat nor realpath can follow", async () => {
    const alias = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps";
    const app = "C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.27.350.0_x64__8wekyb3d8bbwe";
    const deps = fakeFs({
      platform: "win32",
      path: ["C:\\Windows\\System32", alias],
      // The aliases' targets are in a folder no person may read: as the lookups see them, links to nothing.
      files: { "C:\\Windows\\System32\\powershell.exe": "file", [`${alias}\\winget.exe`]: { link: `${app}\\winget.exe` }, [`${alias}\\python.exe`]: { link: `${app}\\AppInstallerPythonRedirector.exe` } },
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
    });
    expect(locateBinary("winget", deps)).toEqual({ path: `${alias}\\winget.exe`, real: `${alias}\\winget.exe`, onPath: true, broken: false });
    // Windows' python.exe hands over to the Store's redirector: not Python.
    expect(locateBinary("python", deps)).toBeUndefined();
    const node = (await menuOf(GEMINI, "Gemini CLI", deps))![0]!;
    expect(commands(node.next![0])).toEqual(["winget install --id Schniz.fnm --exact", "fnm install --lts && fnm default lts-latest, and its default on your PATH"]);
  });

  it("on a Windows with neither WinGet nor Chocolatey, installs either first — Chocolatey's as administrator, in Windows' own prompt", async () => {
    const deps = fakeFs({ platform: "win32", path: ["C:\\Windows\\System32"], files: { "C:\\Windows\\System32\\powershell.exe": "file" }, env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming" } });
    const node = (await menuOf(GEMINI, "Gemini CLI", deps))![0]!;
    expect(node.next?.map((way) => way.key)).toEqual(["fnm", "mise", "winget", "chocolatey"]);
    // fnm still first: WinGet, then fnm by it, then Node.js by fnm.
    expect(node.next![0]!.steps.map((step) => `${step.title}:${step.via}`)).toEqual(["WinGet:the native installer", "fnm:WinGet", "Node.js:fnm"]);
    expect(commands(node.next![2])).toEqual(["Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe, else Repair-WinGetPackageManager", "winget install --id OpenJS.NodeJS --exact"]);
    const choco = node.next![3]!;
    expect(choco.steps.map((step) => [step.title, step.elevated === true])).toEqual([
      ["Chocolatey", true],
      ["Node.js", true],
    ]);
    expect(choco.steps[1]?.display).toBe("choco install nodejs -y (as administrator)");

    // A git CLI WinGet and Chocolatey have: a row for each, each installing its installer, then it.
    const gh = await installChoicesFor(GIT_CLI_PACKAGES["gh"]!, "GitHub CLI", "gh", installFactsOf("gh", GIT_CLI_PACKAGES["gh"]!, deps), { exec: nodeSays(undefined), deps });
    expect(gh?.map((row) => [row.key, row.name, row.steps.map((step) => step.title), row.next?.map((next) => commands(next))])).toEqual([
      ["winget", "WinGet", ["WinGet"], [["winget install --id GitHub.cli --exact"]]],
      ["chocolatey", "Chocolatey", ["Chocolatey"], [["choco install gh -y (as administrator)"]]],
    ]);
  });

  it("runs Chocolatey's own script as administrator, encoded so no quote in it meets the command line's", () => {
    const facts = { platform: "win32" as const, home: "C:\\Users\\me", tools: { powershell: "powershell" } };
    const plan = installPlans(TOOL_PACKAGES["chocolatey"]!, facts)[0]!;
    expect(plan).toMatchObject({ method: "native", elevated: true, file: "powershell" });
    const script = plan.args[plan.args.length - 1]!;
    expect(script).toMatch(/^\$p = Start-Process -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','[A-Za-z0-9+/=]+' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit \$p\.ExitCode$/);
    const encoded = /'-EncodedCommand','([^']+)'/.exec(script)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))");
  });

  it("on a Linux desktop, apt asks for its password in polkit's window; with no desktop, sudo -n as before", async () => {
    const desktop = fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files: { ...DEBIAN, "/usr/bin/pkexec": "file" }, env: { DISPLAY: ":0" } });
    const node = (await menuOf(GEMINI, "Gemini CLI", desktop))![0]!;
    const apt = node.next?.find((way) => way.key === "apt");
    expect(apt?.steps.map((step) => [step.display, step.elevated === true])).toEqual([["sudo apt-get install -y nodejs", true]]);
    // Homebrew on Linux: polkit makes its prefix the person's, and the script runs as them.
    expect(node.next?.find((way) => way.key === "homebrew")?.steps[0]?.elevated).toBe(true);

    const headless = fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files: { ...DEBIAN, "/usr/bin/pkexec": "file" } });
    const plain = (await menuOf(GEMINI, "Gemini CLI", headless))![0]!;
    expect(plain.next?.find((way) => way.key === "apt")?.steps[0]?.elevated).toBeUndefined();
    expect(plain.next?.some((way) => way.key === "homebrew")).toBe(false);
  });

  it("is nothing for an agent that is installed", async () => {
    const deps = fakeFs({ path: [...MAC_PATH, "/opt/homebrew/bin"], files: { ...MAC_SYSTEM, "/opt/homebrew/bin/gemini": "file" } });
    expect(await menuOf(GEMINI, "Gemini CLI", deps)).toBeUndefined();
  });
});

describe("a path through the menu", () => {
  it("names its steps: the rows its keys name, then the recommended way at each step after", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: MAC_SYSTEM, arch: "arm64" });
    const chain = (await gatherChainFacts({ exec: nodeSays(undefined), deps }))!;
    const choices = installChoicesOf(GEMINI, "Gemini CLI", "gemini", installFactsOf("gemini", GEMINI, deps), chain);
    const titles = (path: string[]) => stepsOf(choices, path)?.map((step) => `${step.title}:${step.method}`);
    expect(titles(["npm"])).toEqual(["fnm:native", "Node.js:fnm", "Gemini CLI:npm"]);
    expect(titles(["npm", "nvm"])).toEqual(["nvm:native", "Node.js:nvm", "Gemini CLI:npm"]);
    expect(titles(["npm", "homebrew", "npm"])).toEqual(["Homebrew:native", "Node.js:homebrew", "Gemini CLI:npm"]);
    expect(titles(["npm", "volta"])).toBeUndefined();
  });

  it("runs a step at a time, each planned from what the one before left — fnm's script, its Node.js, then that Node's npm", async () => {
    const fnmDir = `${LINUX_HOME}/.local/share/fnm`;
    const bin = `${fnmDir}/aliases/default/bin`;
    const files: Files = { ...DEBIAN };
    const exec = machineExec((file, args) => {
      if (file === "/usr/bin/bash" && args[1] === "curl -fsSL https://fnm.vercel.app/install | bash") {
        files[`${fnmDir}/fnm`] = "file";
        return { prints: [["stdout", "Installing fnm…\n"]] };
      }
      if (file === "/usr/bin/bash" && args[1]!.startsWith(`${fnmDir}/fnm install --lts && ${fnmDir}/fnm default lts-latest && case`)) {
        files[`${bin}/node`] = "file";
        files[`${bin}/npm`] = "file";
        return {};
      }
      if (file === `${bin}/npm` && args.join(" ") === "install -g @google/gemini-cli") {
        files[`${bin}/gemini`] = { link: "../lib/node_modules/@google/gemini-cli/dist/index.js" };
        files[`${fnmDir}/aliases/default/lib/node_modules/@google/gemini-cli/dist/index.js`] = "file";
        return {};
      }
      if (file === `${bin}/node` && args[0] === "--version") return { stdout: "v24.11.1\n" };
      return undefined;
    });
    const deps = fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files });
    let said = "";
    const info: ExecutorInfo = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    const outcome = await installAgent(info, { choice: ["npm"] }, { exec, deps, onOutput: (text) => (said += text) });
    expect(outcome).toEqual({ ok: true, path: `${bin}/gemini`, onPath: false });
    expect(exec.calls.filter((call) => !(call.args[0] === "--version")).map((call) => call.file)).toEqual(["/usr/bin/bash", "/usr/bin/bash", `${bin}/npm`]);
    // npm runs with its own Node first on the PATH: it is `#!/usr/bin/env node`.
    expect(exec.calls.find((call) => call.file === `${bin}/npm`)?.env?.["PATH"]?.split(":")[0]).toBe(bin);
    expect(said).toContain("── Step 1 of 3: fnm (the native installer)");
    expect(said).toContain("── Step 3 of 3: Gemini (cli) (npm)");
    expect(said).toContain("$ npm install -g @google/gemini-cli");
  });

  it("stops at a step that failed, saying which — and at a Node.js that came out too old", async () => {
    const files: Files = { ...DEBIAN };
    const failing = machineExec((file) => (file === "/usr/bin/bash" ? { code: 1, stderr: "unzip: command not found\n" } : undefined));
    const deps = fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files });
    const info = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    const failed = await installAgent(info, { choice: ["npm", "fnm"] }, { exec: failing, deps });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.ok === false && failed.reason).toMatch(/^step 1 of 3, fnm: .* exited 1: unzip: command not found$/);

    // apt's Node.js, run as root (this process is): Debian's may be older than Gemini runs on.
    const rootFiles: Files = { ...DEBIAN };
    const apt = machineExec((file, args) => {
      if (file === "env" && args.includes("/usr/bin/apt-get")) {
        rootFiles["/usr/bin/node"] = "file";
        rootFiles["/usr/bin/npm"] = "file";
        return {};
      }
      if (file === "/usr/bin/node" && args[0] === "--version") return { stdout: "v18.19.0\n" };
      return undefined;
    });
    const root = fakeFs({ platform: "linux", home: "/root", path: LINUX_PATH, files: rootFiles, root: true });
    const old = await installAgent(info, { choice: ["npm", "apt"] }, { exec: apt, deps: root });
    expect(old).toEqual({ ok: false, reason: "apt installed Node.js 18.19.0, older than Gemini (cli) runs on (20 or newer) — choose another way" });
  });

  it("on Windows, finds fnm in WinGet's own folder — WinGet could not link it, and put that folder on a PATH this app does not have", async () => {
    const local = "C:\\Users\\me\\AppData\\Local";
    const fnmHome = "C:\\Users\\me\\AppData\\Roaming\\fnm\\aliases\\default";
    const pkgDir = `${local}\\Microsoft\\WinGet\\Packages\\Schniz.fnm_Microsoft.Winget.Source_8wekyb3d8bbwe`;
    const files: Files = { "C:\\Windows\\System32\\powershell.exe": "file", [`${local}\\Microsoft\\WindowsApps\\winget.exe`]: "file" };
    const exec = machineExec((file, args) => {
      if (file === "winget" && args.includes("Schniz.fnm")) {
        files[`${pkgDir}\\fnm.exe`] = "file";
        return {};
      }
      if (/powershell(\.exe)?$/i.test(file) && args.some((one) => one.includes(`${pkgDir}\\fnm.exe`))) {
        files[`${fnmHome}\\node.exe`] = "file";
        files[`${fnmHome}\\npm.cmd`] = "file";
        return {};
      }
      if (file === `${fnmHome}\\node.exe` && args[0] === "--version") return { stdout: "v24.11.1\n" };
      if (file === `${fnmHome}\\npm.cmd` && args.join(" ") === "install -g @google/gemini-cli") {
        files[`${fnmHome}\\gemini.cmd`] = "file";
        return {};
      }
      return undefined;
    });
    const deps = fakeFs({ platform: "win32", path: ["C:\\Windows\\System32", `${local}\\Microsoft\\WindowsApps`], files, env: { LOCALAPPDATA: local, APPDATA: "C:\\Users\\me\\AppData\\Roaming" } });
    const info = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    let said = "";
    const outcome = await installAgent(info, { choice: ["npm"] }, { exec, deps, onOutput: (text) => (said += text) });
    expect(said).toContain("── Step 2 of 3: Node.js (fnm)");
    expect(outcome).toEqual({ ok: true, path: `${fnmHome}\\gemini.cmd`, onPath: false });
  });

  it("looks at the machine again after each step, the person's terminal asked afresh — what an installer added to the PATH is there", async () => {
    const tools = "C:\\Tools\\fnm";
    const files: Files = { "C:\\Windows\\System32\\powershell.exe": "file", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file" };
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };
    const path = ["C:\\Windows\\System32", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps"];
    const exec = machineExec((file, args) => {
      if (file === "winget" && args.includes("Schniz.fnm")) {
        files[`${tools}\\fnm.exe`] = "file";
        return {};
      }
      return /powershell(\.exe)?$/i.test(file) ? { code: 1, stderr: "stop here\n" } : undefined;
    });
    let refreshed = 0;
    const deps = fakeFs({ platform: "win32", path, files, env });
    const refresh = () => {
      refreshed++;
      return Promise.resolve({ ...deps, shell: { pathDirs: [tools], vars: {} } });
    };
    const info = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    const outcome = await installAgent(info, { choice: ["npm"] }, { exec, deps, refresh });
    expect(refreshed).toBe(1);
    // fnm was found where the terminal now has it: step 2 ran it, and stopped where this machine said to.
    expect(outcome).toEqual({ ok: false, reason: "step 2 of 3, Node.js: 'fnm install --lts && fnm default lts-latest, and its default on your PATH' exited 1: stop here" });
    expect(exec.calls.at(-1)?.args.join(" ")).toContain(`${tools}\\fnm.exe`);
  });

  it("tells a watcher where each command starts, of several steps which one — the text is then the command's output alone", async () => {
    const exec = machineExec(() => ({ prints: [["stdout", "ok\n"]] }));
    const commands: unknown[] = [];
    let said = "";
    const facts = { platform: "win32" as const, home: "C:\\Users\\me", tools: { powershell: "powershell" } };
    const plan = installPlans(TOOL_PACKAGES["chocolatey"]!, facts)[0]!;
    await runPlan(plan, { exec, deps: fakeFs({ platform: "win32", path: [], files: {} }), onOutput: (text) => (said += text), onCommand: (command) => commands.push(command) }, "install", "Step 1 of 2: Chocolatey (the native installer)");
    expect(commands).toEqual([{ display: plan.display, step: "Step 1 of 2: Chocolatey (the native installer)" }]);
    // Run as administrator: said inside its own command, before it waits.
    expect(said).toBe("Windows asks for an administrator's permission in its own window.\nok\n");
  });

  it("takes WinGet's 'no newer version' as done: fnm it installed before is still there", async () => {
    const exec = machineExec(() => ({ code: 2316632107, stdout: "Found an existing package already installed. Trying to upgrade the installed package...\nNo available upgrade found.\n" }));
    const facts = { platform: "win32" as const, home: "C:\\Users\\me", tools: { winget: "winget" } };
    const plan = installPlans(TOOL_PACKAGES["fnm"]!, facts).find((one) => one.method === "winget")!;
    expect(await runPlan(plan, { exec, deps: fakeFs({ platform: "win32", path: [], files: {} }) }, "install")).toMatchObject({ ok: true });
    const failing = machineExec(() => ({ code: 2316632100 }));
    expect(await runPlan(plan, { exec: failing, deps: fakeFs({ platform: "win32", path: [], files: {} }) }, "install")).toMatchObject({ ok: false });
  });

  it("refuses a path the machine no longer offers, running nothing", async () => {
    const exec = nodeSays(undefined);
    const info = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    const outcome = await installAgent(info, { choice: ["npm", "chocolatey"] }, { exec, deps: fakeFs({ path: MAC_PATH, files: MAC_SYSTEM }) });
    expect(outcome).toEqual({ ok: false, reason: "that way to install Gemini (cli) is not offered here any more — check again" });
    expect(exec.calls).toEqual([]);
  });
});

describe("an agent npm put beside its own Node.js", () => {
  it("is made reachable by its folder, which holds the node it runs on — and then runs", async () => {
    const bin = `${HOME}/.local/share/fnm/aliases/default/bin`;
    const deps = fakeFs({
      path: MAC_PATH,
      files: { ...MAC_SYSTEM, [`${bin}/node`]: "file", [`${bin}/npm`]: "file", [`${bin}/gemini`]: { link: "../lib/node_modules/@google/gemini-cli/dist/index.js" }, [`${HOME}/.local/share/fnm/aliases/default/lib/node_modules/@google/gemini-cli/dist/index.js`]: "file" },
    });
    const reached: string[] = [];
    const exec = machineExec((file, args) => (file === "gemini" && args[0] === "--version" ? { stdout: "0.70.0\n" } : file.endsWith("/node") ? { stdout: "v24.11.1\n" } : undefined));
    const info = { name: "gemini-cli", kind: "generic", command: "gemini", enabled: true } as ExecutorInfo;
    const probe = await probeExecutor(info, { exec, install: deps, reach: (dir) => reached.push(dir) });
    expect(reached).toEqual([bin]);
    expect(probe.install).toMatchObject({ path: `${bin}/gemini`, onPath: true, method: "npm" });
    expect(probe.install?.choices).toBeUndefined();
  });
});

describe("a version manager the person's terminal sets up, which this app's environment does not", () => {
  it("reads a login shell's env after its mark, whatever its profile printed first", () => {
    const said = ["Last login: Thu", "nvm is loading…", "__JAIRA_SHELL_ENV__", "HOME=/Users/me", "NVM_DIR=/Users/me/tools/nvm", "PATH=/Users/me/bin:/opt/homebrew/bin:/usr/bin", "SECRET_TOKEN=x"].join("\n");
    expect(parseShellEnv(said, "darwin")).toEqual({ vars: { NVM_DIR: "/Users/me/tools/nvm", PATH: "/Users/me/bin:/opt/homebrew/bin:/usr/bin" }, pathDirs: ["/Users/me/bin", "/opt/homebrew/bin", "/usr/bin"] });
    // Windows: the registry's user and machine PATHs, and its names in any case.
    const windows = ["__JAIRA_SHELL_ENV__", "nvm_home=C:\\Users\\me\\AppData\\Roaming\\nvm", "PATH_USER=C:\\Users\\me\\AppData\\Roaming\\fnm\\aliases\\default", "PATH_MACHINE=C:\\Windows\\System32"].join("\r\n");
    expect(parseShellEnv(windows, "win32").vars).toEqual({ NVM_HOME: "C:\\Users\\me\\AppData\\Roaming\\nvm", PATH: "C:\\Users\\me\\AppData\\Roaming\\fnm\\aliases\\default;C:\\Windows\\System32" });
    // Asked of the person's own shell, login and interactive — `.zshrc` is where NVM_DIR is set.
    expect(shellEnvCommand("darwin", "/bin/zsh")).toEqual({ file: "/bin/zsh", args: ["-ilc", "echo __JAIRA_SHELL_ENV__; /usr/bin/env"] });
    expect(shellEnvCommand("win32", undefined).file).toBe("powershell");
  });

  it("adds only what this app has not: the terminal's other PATH folders, and the variables it lacks", () => {
    const adds = shellAdds({ vars: { NVM_DIR: "/Users/me/tools/nvm", HOME: "/x", PATH: "/a:/usr/bin" }, pathDirs: ["/a", "/usr/bin"] }, { HOME: "/Users/me" }, ["/usr/bin"], "darwin");
    expect(adds).toEqual({ pathDirs: ["/a"], vars: { NVM_DIR: "/Users/me/tools/nvm" } });
    expect(shellAdds({ vars: {}, pathDirs: ["/usr/bin"] }, {}, ["/usr/bin"], "darwin")).toBeUndefined();
  });

  it("finds nvm where only the terminal's NVM_DIR says, and Node.js and npm in its versions — so npm is the row", async () => {
    const nvm = `${HOME}/tools/nvm`;
    const files: Files = { ...MAC_SYSTEM, [`${nvm}/nvm.sh`]: "file", [`${nvm}/versions/node/v22.11.0/bin/node`]: "file", [`${nvm}/versions/node/v22.11.0/bin/npm`]: "file" };
    const terminal = { pathDirs: [], vars: { NVM_DIR: nvm } };
    const deps = { ...fakeFs({ path: MAC_PATH, files, env: { NVM_DIR: nvm } }), shell: terminal };
    expect(installFactsOf("node", TOOL_PACKAGES["node"]!, deps).tools.nvm).toBe(`${nvm}/nvm.sh`);
    const menu = await menuOf(GEMINI, "Gemini CLI", deps, "22.11.0");
    expect(menu?.map((row) => [row.key, commands(row)])).toEqual([["npm", ["npm install -g @google/gemini-cli"]]]);
  });

  it("uses an nvm that is here but has no Node.js yet — first, by itself, not installed again", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM, [`${HOME}/.nvm/nvm.sh`]: "file" } });
    const node = (await menuOf(GEMINI, "Gemini CLI", deps))![0]!;
    expect(node.next?.[0]).toMatchObject({ key: "nvm", name: "nvm" });
    expect(commands(node.next![0])).toEqual(["nvm install --lts && nvm alias default 'lts/*'"]);
  });

  it("finds fnm on the terminal's PATH and in cargo's folder, and runs it by its path", async () => {
    const onTerminal = { ...fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM, [`${HOME}/bin/fnm`]: "file" } }), shell: { pathDirs: [`${HOME}/bin`], vars: {} } };
    expect(installFactsOf("node", TOOL_PACKAGES["node"]!, onTerminal).tools.fnm).toBe(`${HOME}/bin/fnm`);
    const node = (await menuOf(GEMINI, "Gemini CLI", onTerminal))![0]!;
    expect(node.next?.[0]?.key).toBe("fnm");
    expect(node.next?.[0]?.steps.map((step) => step.title)).toEqual(["Node.js"]);

    const cargo = fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM, [`${HOME}/.cargo/bin/fnm`]: "file" } });
    expect(installFactsOf("node", TOOL_PACKAGES["node"]!, cargo).tools.fnm).toBe(`${HOME}/.cargo/bin/fnm`);
  });

  it("runs Homebrew's nvm with NVM_DIR at ~/.nvm — not Homebrew's folder, where nvm.sh is — unless the terminal names one", () => {
    const facts = { platform: "darwin" as const, home: HOME, tools: { nvm: "/opt/homebrew/opt/nvm/nvm.sh", bash: "/bin/bash" } };
    expect(managerPlan("nvm", TOOL_PACKAGES["node"]!, facts, versionWant("lts"), true)?.args[1]).toBe(`export NVM_DIR=${HOME}/.nvm; mkdir -p "$NVM_DIR" && source /opt/homebrew/opt/nvm/nvm.sh && nvm install --lts && nvm alias default 'lts/*'`);
    const theirs = managerPlan("nvm", TOOL_PACKAGES["node"]!, { ...facts, env: { NVM_DIR: `${HOME}/tools/nvm` } }, versionWant("lts"), true);
    expect(theirs?.args[1]).toMatch(new RegExp(`^export NVM_DIR=${HOME}/tools/nvm;`));
    expect(theirs?.lands).toEqual([`${HOME}/tools/nvm/versions/node/v*/bin`]);
  });

  it("uses nvm-windows where it is, `nvm use` making it every terminal's Node.js", async () => {
    const deps = fakeFs({
      platform: "win32",
      home: "C:\\Users\\me",
      path: ["C:\\Windows\\System32"],
      files: { "C:\\Windows\\System32\\powershell.exe": "file", "C:\\Users\\me\\AppData\\Roaming\\nvm\\nvm.exe": "file" },
      env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    });
    const node = (await menuOf(GEMINI, "Gemini CLI", deps))![0]!;
    expect(node.next?.[0]).toMatchObject({ key: "nvm" });
    expect(commands(node.next![0])).toEqual(["nvm install lts && nvm use lts"]);
  });

  it("runs an installer with the terminal's variables, and its PATH after this app's", async () => {
    const exec = machineExec(() => ({}));
    const deps = { ...fakeFs({ path: MAC_PATH, files: MAC_SYSTEM }), shell: { pathDirs: [`${HOME}/bin`], vars: { FNM_DIR: `${HOME}/.fnm-data` } } };
    await runPlan({ method: "fnm", via: "fnm", display: "fnm install --lts", file: `${HOME}/bin/fnm`, args: ["install", "--lts"], env: { PATH: "/usr/bin:/bin" } }, { exec, deps }, "install");
    expect(exec.calls[0]?.env).toEqual({ FNM_DIR: `${HOME}/.fnm-data`, PATH: `/usr/bin:/bin:${HOME}/bin` });
  });
});

