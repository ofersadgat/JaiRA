/**
 * A project's tool requests (`install/tool.ts`): `checkTool` only looks — file checks, a version
 * command, whether sudo would ask — and `ensureTool` runs at most the one installer the check names,
 * streams what it prints, and looks again. A table of files stands in for the machine.
 */
import { describe, expect, it } from "vitest";
import { checkTool, ensureTool } from "../src/install";
import { DEBIAN, LINUX_HOME, LINUX_PATH, MAC_PATH, MAC_SYSTEM, fakeFs, machineExec, type Files } from "./installRig";

const HOME = "/Users/me";
const NVM = `${HOME}/.nvm`;

/** What `node --version` says, by which node was run. */
const nodeVersion = (versions: Record<string, string>) => (file: string, args: readonly string[]) => (args[0] === "--version" && versions[file] !== undefined ? { stdout: `${versions[file]}\n` } : undefined);

describe("checkTool", () => {
  it("finds a tool at a version that fits, running nothing but its version command", async () => {
    const deps = fakeFs({ path: ["/opt/homebrew/bin", ...MAC_PATH], files: { ...MAC_SYSTEM, "/opt/homebrew/bin/node": { link: "../Cellar/node/22.11.0/bin/node" }, "/opt/homebrew/Cellar/node/22.11.0/bin/node": "file" } });
    const exec = machineExec(nodeVersion({ "/opt/homebrew/bin/node": "v22.11.0" }));
    const check = await checkTool({ tool: "node", version: "22" }, { exec, deps, cwd: "/work/app" });
    expect(check).toEqual({ tool: "node", wanted: "22", known: true, found: { path: "/opt/homebrew/bin/node", version: "22.11.0", onPath: true }, satisfied: true });
    // In the project's folder, where a version manager's shim reads the version the project pins.
    expect(exec.calls).toEqual([{ file: "/opt/homebrew/bin/node", args: ["--version"], cwd: "/work/app", stdin: "" }]);
  });

  it("says what would install a version that does not fit — and installs nothing", async () => {
    const deps = fakeFs({
      path: [`${NVM}/versions/node/v20.18.1/bin`, ...MAC_PATH],
      files: { ...MAC_SYSTEM, [`${NVM}/nvm.sh`]: "file", [`${NVM}/versions/node/v20.18.1/bin/node`]: "file" },
    });
    const exec = machineExec(nodeVersion({ [`${NVM}/versions/node/v20.18.1/bin/node`]: "v20.18.1" }));
    const check = await checkTool({ tool: "node", version: "22" }, { exec, deps });
    expect(check).toEqual({
      tool: "node",
      wanted: "22",
      known: true,
      found: { path: `${NVM}/versions/node/v20.18.1/bin/node`, version: "20.18.1", onPath: true },
      satisfied: false,
      plan: { method: "nvm", display: "nvm install 22" },
    });
    expect(exec.calls.map((call) => call.args[0])).toEqual(["--version"]);
  });

  it("finds a version installed beside the one the PATH reaches, where its installer keeps it", async () => {
    const v22 = `${NVM}/versions/node/v22.11.0/bin/node`;
    const deps = fakeFs({
      path: [`${NVM}/versions/node/v20.18.1/bin`, ...MAC_PATH],
      files: { ...MAC_SYSTEM, [`${NVM}/nvm.sh`]: "file", [`${NVM}/versions/node/v20.18.1/bin/node`]: "file", [v22]: "file" },
    });
    const exec = machineExec(nodeVersion({ [`${NVM}/versions/node/v20.18.1/bin/node`]: "v20.18.1", [v22]: "v22.11.0" }));
    expect(await checkTool({ tool: "node", version: "22" }, { exec, deps })).toMatchObject({ satisfied: true, found: { path: v22, version: "22.11.0", onPath: false } });
  });

  it("knows a tool not in the catalog only by its being here", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM, "/usr/bin/make": "file" } });
    const exec = machineExec(() => undefined);
    expect(await checkTool({ tool: "make" }, { exec, deps })).toEqual({ tool: "make", known: false, found: { path: "/usr/bin/make", onPath: true }, satisfied: true });
    expect(await checkTool({ tool: "make", version: "4" }, { exec, deps })).toMatchObject({ known: false, satisfied: false });
    expect(await checkTool({ tool: "frobnicate" }, { exec, deps })).toEqual({ tool: "frobnicate", known: false, satisfied: false });
    expect(exec.calls).toEqual([]);
  });

  it("never runs a Mac's placeholder python3 — past it, Homebrew's python is the one", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM, "/usr/bin/python3": "file", "/opt/homebrew/bin/python3": { link: "../Cellar/python@3.13/3.13.1/bin/python3" }, "/opt/homebrew/Cellar/python@3.13/3.13.1/bin/python3": "file" } });
    const exec = machineExec((file, args) => {
      if (file === "/usr/bin/xcode-select" && args[0] === "-p") return { code: 2, stderr: "xcode-select: error: unable to get active developer directory" };
      if (file === "/opt/homebrew/bin/python3") return { stdout: "Python 3.13.1\n" };
      return undefined;
    });
    expect(await checkTool({ tool: "python", version: "3.13" }, { exec, deps })).toMatchObject({ satisfied: true, found: { path: "/opt/homebrew/bin/python3", version: "3.13.1", onPath: false } });
    expect(exec.calls.map((call) => call.file)).not.toContain("/usr/bin/python3");
  });

  it("looks past Windows' python.exe that opens the Store, to the Python installed in the person's Programs", async () => {
    const deps = fakeFs({
      platform: "win32",
      path: ["C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps"],
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      files: { "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe": "file", "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe": "file" },
    });
    const exec = machineExec((file) => (file.endsWith("Python312\\python.exe") ? { stdout: "Python 3.12.7\n" } : undefined));
    expect(await checkTool({ tool: "python", version: "3.12" }, { exec, deps })).toMatchObject({ satisfied: true, found: { path: "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe", onPath: false } });
  });

  it("asks inside WSL with one `sh`, then the version there", async () => {
    const deps = fakeFs({ platform: "win32", path: [], files: {} });
    const exec = machineExec((file, args) => {
      if (file === "sh") return { stdout: "found\t/usr/bin/node\t/usr/bin/node\ntool\tapt-get\t/usr/bin/apt-get\ntool\tsudo\t/usr/bin/sudo\nhome\t/home/me\nuid\t1000\n" };
      if (file === "/usr/bin/node" && args[0] === "--version") return { stdout: "v18.19.1\n" };
      if (file === "/usr/bin/sudo") return { code: 1, stderr: "sudo: a password is required\n" };
      return undefined;
    });
    const check = await checkTool({ tool: "node", version: ">=18" }, { exec, deps, execEnv: { wsl: "Ubuntu" } });
    expect(check).toMatchObject({ satisfied: true, found: { path: "/usr/bin/node", version: "18.19.1" } });
    expect(exec.calls[0]).toMatchObject({ file: "sh", args: ["-c", expect.stringContaining('command -v "$n"'), "sh", "node"], execEnv: { wsl: "Ubuntu" } });
    expect(exec.calls[1]).toMatchObject({ file: "/usr/bin/node", execEnv: { wsl: "Ubuntu" } });
  });
});

describe("libraries, by pkg-config", () => {
  const debian = (files: Files = {}) => fakeFs({ platform: "linux", home: LINUX_HOME, path: LINUX_PATH, files: { ...DEBIAN, "/usr/bin/pkg-config": "file", ...files } });

  it("finds one pkg-config knows, with its version and the file that says so", async () => {
    const exec = machineExec((file, args) => {
      if (file !== "/usr/bin/pkg-config") return undefined;
      if (args[0] === "--exists") return { code: 0 };
      if (args[0] === "--modversion") return { stdout: "8.15.1\n" };
      if (args[0] === "--variable=pcfiledir") return { stdout: "/usr/lib/x86_64-linux-gnu/pkgconfig\n" };
      return undefined;
    });
    expect(await checkTool({ tool: "vips", version: ">=8.14" }, { exec, deps: debian() })).toEqual({
      tool: "vips",
      wanted: ">=8.14",
      known: true,
      found: { path: "/usr/lib/x86_64-linux-gnu/pkgconfig/vips.pc", version: "8.15.1", onPath: true },
      satisfied: true,
    });
    expect(exec.calls.map((call) => call.args)).toEqual([
      ["--exists", "vips"],
      ["--modversion", "vips"],
      ["--variable=pcfiledir", "vips"],
    ]);
  });

  it("marks an apt install that needs sudo's password — and ensureTool then runs nothing, and says what to run", async () => {
    const exec = machineExec((file, args) => {
      if (file === "/usr/bin/pkg-config") return { code: 1 };
      if (file === "/usr/bin/sudo" && args.join(" ") === "-n true") return { code: 1, stderr: "sudo: a password is required\n" };
      return undefined;
    });
    const check = await checkTool({ tool: "vips" }, { exec, deps: debian() });
    expect(check).toEqual({ tool: "vips", known: true, satisfied: false, plan: { method: "apt", display: "sudo apt-get install -y libvips-dev", needsPassword: true } });
    const outcome = await ensureTool({ tool: "vips" }, { exec, deps: debian() });
    expect(outcome).toEqual({
      ok: false,
      reason: "installing libvips needs a password for sudo on this machine — run this there: sudo apt-get install -y libvips-dev",
      needsPassword: true,
      command: "sudo apt-get install -y libvips-dev",
    });
    expect(exec.calls.some((call) => call.args.includes("apt-get") || call.args.includes("/usr/bin/apt-get"))).toBe(false);
  });

  it("installs through `sudo -n` where sudo asks no password, then finds it", async () => {
    let installed = false;
    const said: string[] = [];
    const exec = machineExec((file, args) => {
      if (file === "/usr/bin/pkg-config") {
        if (!installed) return { code: 1 };
        return args[0] === "--modversion" ? { stdout: "8.15.1\n" } : args[0] === "--variable=pcfiledir" ? { stdout: "/usr/lib/pkgconfig\n" } : { code: 0 };
      }
      if (file === "/usr/bin/sudo" && args.join(" ") === "-n true") return { code: 0 };
      if (file === "/usr/bin/sudo" && args.includes("/usr/bin/apt-get")) {
        installed = true;
        return { code: 0, prints: [["stdout", "Setting up libvips-dev (8.15.1-1) ...\n"]] };
      }
      return undefined;
    });
    const outcome = await ensureTool({ tool: "vips" }, { exec, deps: debian(), onOutput: (text) => said.push(text) });
    expect(outcome).toEqual({ ok: true, already: false, path: "/usr/lib/pkgconfig/vips.pc", version: "8.15.1", onPath: true });
    expect(exec.calls.find((call) => call.args.includes("/usr/bin/apt-get"))).toMatchObject({ file: "/usr/bin/sudo", args: ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "install", "-y", "libvips-dev"], stdin: "" });
    expect(said).toEqual(["$ sudo apt-get install -y libvips-dev\n", "Setting up libvips-dev (8.15.1-1) ...\n"]);
  });

  it("reads sudo's refusal in the run as wanting a password, too", async () => {
    const exec = machineExec((file, args) => {
      if (file === "/usr/bin/pkg-config") return { code: 1 };
      if (file === "/usr/bin/sudo" && args.join(" ") === "-n true") return { code: 0 };
      if (file === "/usr/bin/sudo") return { code: 1, stderr: "sudo: a password is required\n" };
      return undefined;
    });
    expect(await ensureTool({ tool: "vips" }, { exec, deps: debian() })).toMatchObject({ ok: false, needsPassword: true, command: "sudo apt-get install -y libvips-dev" });
  });
});

describe("ensureTool", () => {
  it("runs nothing for a tool that is here at a version that fits", async () => {
    const deps = fakeFs({ path: ["/usr/local/bin", ...MAC_PATH], files: { ...MAC_SYSTEM, "/usr/local/bin/jq": "file" } });
    const exec = machineExec((file) => (file === "/usr/local/bin/jq" ? { stdout: "jq-1.7.1\n" } : undefined));
    expect(await ensureTool({ tool: "jq" }, { exec, deps })).toEqual({ ok: true, already: true, path: "/usr/local/bin/jq", version: "1.7.1", onPath: true });
    expect(exec.calls).toHaveLength(1);
  });

  it("installs a version through nvm, streams it, and answers where nvm put it", async () => {
    const files: Files = { ...MAC_SYSTEM, [`${NVM}/nvm.sh`]: "file", [`${NVM}/versions/node/v20.18.1/bin/node`]: "file" };
    const deps = fakeFs({ path: [`${NVM}/versions/node/v20.18.1/bin`, ...MAC_PATH], files });
    const v22 = `${NVM}/versions/node/v22.11.0/bin/node`;
    const versions: Record<string, string> = { [`${NVM}/versions/node/v20.18.1/bin/node`]: "v20.18.1", [v22]: "v22.11.0" };
    const said: string[] = [];
    const exec = machineExec((file, args) => {
      if (file === "/bin/bash" && args[0] === "-lc") {
        files[v22] = "file";
        return { prints: [["stdout", "Downloading and installing node v22.11.0...\n"]] };
      }
      return nodeVersion(versions)(file, args);
    });
    const outcome = await ensureTool({ tool: "node", version: "22" }, { exec, deps, onOutput: (text) => said.push(text) });
    expect(outcome).toEqual({ ok: true, already: false, path: v22, version: "22.11.0", onPath: false });
    expect(said).toEqual(["$ nvm install 22\n", "Downloading and installing node v22.11.0...\n"]);
    const runs = exec.calls.filter((call) => call.file === "/bin/bash");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ args: ["-lc", `export NVM_DIR=${NVM}; mkdir -p "$NVM_DIR" && source ${NVM}/nvm.sh && nvm install 22`], stdin: "" });
  });

  it("installs a keg-only versioned formula and finds it in Homebrew's opt folder", async () => {
    const files: Files = { ...MAC_SYSTEM, "/opt/homebrew/bin/brew": "file", "/opt/homebrew/bin/node": { link: "../Cellar/node/25.1.0/bin/node" }, "/opt/homebrew/Cellar/node/25.1.0/bin/node": "file" };
    const deps = fakeFs({ path: ["/opt/homebrew/bin", ...MAC_PATH], files });
    const exec = machineExec((file, args) => {
      if (file === "/opt/homebrew/bin/brew") {
        files["/opt/homebrew/opt/node@22/bin/node"] = "file";
        return { code: 0 };
      }
      return nodeVersion({ "/opt/homebrew/bin/node": "v25.1.0", "/opt/homebrew/opt/node@22/bin/node": "v22.11.0" })(file, args);
    });
    expect(await ensureTool({ tool: "node", version: "^22" }, { exec, deps })).toEqual({ ok: true, already: false, path: "/opt/homebrew/opt/node@22/bin/node", version: "22.11.0", onPath: false });
    expect(exec.calls.find((call) => call.file === "/opt/homebrew/bin/brew")).toMatchObject({ args: ["install", "node@22"] });
  });

  it("says so when the installer finished and the version still does not fit", async () => {
    const files: Files = { ...MAC_SYSTEM, "/opt/homebrew/bin/brew": "file" };
    const deps = fakeFs({ path: ["/opt/homebrew/bin", ...MAC_PATH], files });
    const exec = machineExec((file, args) => {
      if (file === "/opt/homebrew/bin/brew") {
        files["/opt/homebrew/bin/jq"] = "file";
        return { code: 0 };
      }
      return file === "/opt/homebrew/bin/jq" && args[0] === "--version" ? { stdout: "jq-1.7.1\n" } : undefined;
    });
    expect(await ensureTool({ tool: "jq", version: ">=2" }, { exec, deps })).toEqual({ ok: false, reason: "'brew install jq' finished, but jq >=2 is still not here — /opt/homebrew/bin/jq is 1.7.1" });
  });

  it("answers an installer's failure in its own last words, and a tool nothing here installs as such", async () => {
    const deps = fakeFs({ path: ["/opt/homebrew/bin", ...MAC_PATH], files: { ...MAC_SYSTEM, "/opt/homebrew/bin/brew": "file" } });
    const exec = machineExec((file) => (file === "/opt/homebrew/bin/brew" ? { code: 1, stderr: "Error: No available formula with the name \"jq\".\n" } : undefined));
    expect(await ensureTool({ tool: "jq" }, { exec, deps })).toEqual({ ok: false, reason: "'brew install jq' exited 1: Error: No available formula with the name \"jq\"." });
    const bare = fakeFs({ path: MAC_PATH, files: { ...MAC_SYSTEM } });
    expect(await ensureTool({ tool: "jq" }, { exec, deps: bare })).toEqual({ ok: false, reason: "nothing on this machine installs jq" });
    expect(await ensureTool({ tool: "frobnicate" }, { exec, deps: bare })).toEqual({ ok: false, reason: "JaiRA does not know how to install frobnicate" });
  });

  it("goes the way the request names when it can", async () => {
    const files: Files = { ...MAC_SYSTEM, [`${NVM}/nvm.sh`]: "file", "/opt/homebrew/bin/brew": "file" };
    const deps = fakeFs({ path: ["/opt/homebrew/bin", ...MAC_PATH], files });
    const exec = machineExec(() => ({ code: 0 }));
    expect((await checkTool({ tool: "node", version: "22", through: "brew" }, { exec, deps })).plan).toEqual({ method: "homebrew", display: "brew install node@22" });
    expect((await checkTool({ tool: "node", version: "22", through: "nvm" }, { exec, deps })).plan).toEqual({ method: "nvm", display: "nvm install 22" });
  });
});
