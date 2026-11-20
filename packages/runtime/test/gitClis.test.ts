/**
 * The git programs (`gitClis.ts`): git, gh and glab, checked and installed as an agent's binary is —
 * Apple's Command Line Tools on a Mac, WinGet, Chocolatey and Scoop on Windows, Homebrew wherever it
 * is. A table of file systems stands in for the machine, and an Exec that answers by command for it.
 */
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../src/exec";
import { agentInstallOf } from "../src/agentInstall";
import { GIT_CLI_PACKAGES, installFactsOf, installOriginOf, planOf, type InstallDeps } from "../src/install";
import { gitCliVersionOf, installGitCli, probeGitCli } from "../src/gitClis";

const GIT = GIT_CLI_PACKAGES.git;
const GH = GIT_CLI_PACKAGES.gh;
const GLAB = GIT_CLI_PACKAGES.glab;
const HOME = "/Users/me";
const WIN_HOME = "C:\\Users\\me";

function fakeFs(options: { platform?: NodeJS.Platform; home?: string; path: string[]; files: Record<string, "file" | { link: string }>; env?: Record<string, string> }): InstallDeps {
  const platform = options.platform ?? "darwin";
  const path = platform === "win32" ? win32 : posix;
  const resolve = (p: string, depth = 0): string | undefined => {
    const entry = options.files[p];
    if (entry === undefined || depth > 20) return undefined;
    return entry === "file" ? p : resolve(path.resolve(path.dirname(p), entry.link), depth + 1);
  };
  return {
    platform,
    home: options.home ?? (platform === "win32" ? WIN_HOME : HOME),
    pathDirs: options.path,
    env: options.env ?? {},
    lexists: (p) => options.files[p] !== undefined,
    realpath: (p) => resolve(p),
    readlink: (p) => {
      const entry = options.files[p];
      return entry !== undefined && entry !== "file" ? entry.link : undefined;
    },
    isFile: (p) => resolve(p) !== undefined,
  };
}

type Call = { file: string; args: readonly string[] };

/** An Exec that answers by the command's last path part and its first argument, and records what it ran. */
function scriptedExec(answers: Record<string, Partial<ExecResult> | (() => Partial<ExecResult>)>): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args });
      const key = `${file.split(/[\\/]/).pop()} ${args[0] ?? ""}`.trim();
      const answer = answers[key];
      const given = typeof answer === "function" ? answer() : answer;
      if (given === undefined) return Promise.reject(new Error(`spawn ${file} ENOENT`));
      return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", command: file, timedOut: false, aborted: false, ...given } as ExecResult);
    },
  };
}

const MAC = { "/usr/bin/xcode-select": "file", "/usr/bin/curl": "file", "/bin/bash": "file" } as const;
const MAC_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const WIN_TOOLS = {
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "file",
  "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file",
  "C:\\ProgramData\\chocolatey\\bin\\choco.exe": "file",
  "C:\\Users\\me\\scoop\\shims\\scoop.cmd": "file",
} as const;
const WIN_PATH = ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\ProgramData\\chocolatey\\bin", "C:\\Users\\me\\scoop\\shims"];

describe("the ways a git program installs", () => {
  it("offers git on a Mac by Apple's Command Line Tools, then Homebrew", () => {
    const deps = fakeFs({ path: [...MAC_PATH, "/opt/homebrew/bin"], files: { ...MAC, "/opt/homebrew/bin/brew": "file" } });
    expect(agentInstallOf(GIT, installFactsOf("git", GIT, deps)).install).toEqual([
      { method: "command-line-tools", via: "Apple's Command Line Tools", display: "xcode-select --install" },
      { method: "homebrew", via: "Homebrew", display: "brew install git" },
    ]);
  });

  it("offers git on Windows by WinGet, Chocolatey as administrator, then Scoop — each only when it is here", () => {
    const deps = fakeFs({ platform: "win32", path: WIN_PATH, files: { ...WIN_TOOLS } });
    const { install } = planOf(GIT, installFactsOf("git", GIT, deps));
    expect(install.map((one) => one.display)).toEqual(["winget install --id Git.Git --exact", "choco install git -y (as administrator)", "scoop install git"]);
    expect(install[0]).toMatchObject({ file: "winget", args: ["install", "--id", "Git.Git", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"] });
    // Chocolatey writes under ProgramData: PowerShell asks Windows for the rights, and hands back choco's exit code.
    expect(install[1]?.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(install[1]?.args.at(-1)).toBe(
      "$p = Start-Process -FilePath 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' -ArgumentList 'install','git','-y','--no-progress' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
    );
    expect(install[2]).toMatchObject({ file: "scoop", args: ["install", "git"] });
    const winget = fakeFs({ platform: "win32", path: WIN_PATH, files: { "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file" } });
    expect(planOf(GIT, installFactsOf("git", GIT, winget)).install.map((one) => one.method)).toEqual(["winget"]);
  });

  it("offers gh and glab by Homebrew, or the Windows managers — and nothing on a Linux with none", () => {
    const brew = fakeFs({ platform: "linux", home: "/home/me", path: ["/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/bin"], files: { "/home/linuxbrew/.linuxbrew/bin/brew": "file" } });
    expect(planOf(GH, installFactsOf("gh", GH, brew)).install.map((one) => one.display)).toEqual(["brew install gh"]);
    const windows = fakeFs({ platform: "win32", path: WIN_PATH, files: { ...WIN_TOOLS } });
    expect(planOf(GLAB, installFactsOf("glab", GLAB, windows)).install.map((one) => one.display)).toEqual(["winget install --id GLab.GLab --exact", "choco install glab -y (as administrator)", "scoop install glab"]);
    const bare = fakeFs({ platform: "linux", home: "/home/me", path: ["/usr/bin", "/bin"], files: { "/usr/bin/curl": "file" } });
    expect(planOf(GH, installFactsOf("gh", GH, bare)).install).toEqual([]);
  });

  it("reads Chocolatey and Scoop off their folders, and updates each by its own program", () => {
    expect(installOriginOf("C:\\ProgramData\\chocolatey\\bin\\gh.exe".replace(/\\/g, "/"), GH)?.method).toBe("chocolatey");
    expect(installOriginOf("C:/Users/me/scoop/shims/glab.exe", GLAB)?.method).toBe("scoop");
    const choco = fakeFs({ platform: "win32", path: WIN_PATH, files: { ...WIN_TOOLS, "C:\\ProgramData\\chocolatey\\bin\\gh.exe": "file" } });
    expect(planOf(GH, installFactsOf("gh", GH, choco)).update?.display).toBe("choco upgrade gh -y (as administrator)");
    const scoop = fakeFs({ platform: "win32", path: WIN_PATH, files: { ...WIN_TOOLS, "C:\\Users\\me\\scoop\\shims\\glab.exe": "file" } });
    expect(planOf(GLAB, installFactsOf("glab", GLAB, scoop)).update).toMatchObject({ file: "scoop", args: ["update", "glab"], display: "scoop update glab" });
  });

  it("says nothing of how Git for Windows got into Program Files — WinGet and Chocolatey both run its installer — so it has no Update", () => {
    const deps = fakeFs({ platform: "win32", path: [...WIN_PATH, "C:\\Program Files\\Git\\cmd"], files: { ...WIN_TOOLS, "C:\\Program Files\\Git\\cmd\\git.exe": "file" } });
    const { origin, update, install } = planOf(GIT, installFactsOf("git", GIT, deps));
    expect(origin).toBeUndefined();
    expect(update).toBeUndefined();
    expect(install).toEqual([]);
  });

  it("finds Git for Windows in Program Files when the PATH this app started with does not name it", () => {
    const deps = fakeFs({ platform: "win32", path: WIN_PATH, files: { ...WIN_TOOLS, "C:\\Program Files\\Git\\cmd\\git.exe": "file" } });
    expect(installFactsOf("git", GIT, deps).found).toMatchObject({ path: "C:\\Program Files\\Git\\cmd\\git.exe", onPath: false });
  });

  it("knows the Command Line Tools' git, which Software Update updates — not JaiRA — and claims no way for Xcode's or a distribution's", () => {
    expect(installOriginOf("/Library/Developer/CommandLineTools/usr/bin/git", GIT)?.method).toBe("command-line-tools");
    expect(installOriginOf("/Applications/Xcode.app/Contents/Developer/usr/bin/git", GIT)).toBeUndefined();
    // Linux's (or WSL's) own git lives in /usr/bin too.
    expect(installOriginOf("/usr/bin/git", GIT)).toBeUndefined();
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC, "/usr/bin/git": "file" } });
    expect(planOf(GIT, installFactsOf("git", GIT, deps)).update).toBeUndefined();
  });
});

describe("probeGitCli", () => {
  it("never runs Apple's placeholder git: with no Command Line Tools it offers them, and asks only xcode-select", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC, "/usr/bin/git": "file" } });
    const exec = scriptedExec({ "xcode-select -p": { code: 2, stderr: "xcode-select: error: unable to get active developer directory" } });
    const result = await probeGitCli("git", { exec, deps });
    expect(result).toMatchObject({ name: "git", status: "failed", detail: "macOS has only a placeholder for git until Apple's Command Line Tools are installed" });
    expect(result.install?.install?.[0]).toMatchObject({ method: "command-line-tools", display: "xcode-select --install" });
    expect(exec.calls.map((call) => call.file)).toEqual(["/usr/bin/xcode-select"]);
  });

  it("runs git once the tools hold it, and reads its version", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC, "/usr/bin/git": "file", "/Library/Developer/CommandLineTools/usr/bin/git": "file" } });
    const exec = scriptedExec({ "xcode-select -p": { stdout: "/Library/Developer/CommandLineTools\n" }, "git --version": { stdout: "git version 2.39.5 (Apple Git-154)\n" } });
    const result = await probeGitCli("git", { exec, deps });
    expect(result).toMatchObject({ status: "ok", version: "2.39.5 (Apple Git-154)", detail: "found at /usr/bin/git", install: { method: "command-line-tools" } });
  });

  it("names no way for the git an Xcode holds", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC, "/usr/bin/git": "file", "/Applications/Xcode.app/Contents/Developer/usr/bin/git": "file" } });
    const exec = scriptedExec({ "xcode-select -p": { stdout: "/Applications/Xcode.app/Contents/Developer\n" }, "git --version": { stdout: "git version 2.50.1 (Apple Git-155)\n" } });
    const result = await probeGitCli("git", { exec, deps });
    expect(result.status).toBe("ok");
    expect(result.install?.method).toBeUndefined();
  });

  // `reach` changes this process's PATH, not the machine already read: the look after it must not wait
  // for `deps` to change, as a real one never does.
  it("reaches a program found only in its installer's folder, and says so", async () => {
    const files: Record<string, "file"> = { ...MAC, "/opt/homebrew/bin/brew": "file", "/opt/homebrew/bin/gh": "file" };
    const deps = fakeFs({ path: [...MAC_PATH], files });
    const reached: string[] = [];
    const exec = scriptedExec({ "gh --version": { stdout: "gh version 2.83.0 (2026-10-21)\nhttps://github.com/cli/cli/releases/tag/v2.83.0\n" } });
    const result = await probeGitCli("gh", { exec, deps, reach: (dir) => reached.push(dir) });
    expect(reached).toEqual(["/opt/homebrew/bin"]);
    expect(result).toMatchObject({ status: "ok", version: "2.83.0 (2026-10-21)", detail: "found at /opt/homebrew/bin/gh — JaiRA added /opt/homebrew/bin to the PATH it runs programs with" });
  });

  it("reaches gh in Program Files right after WinGet installed it there", async () => {
    const deps = fakeFs({ platform: "win32", path: [...WIN_PATH], files: { ...WIN_TOOLS, "C:\\Program Files\\GitHub CLI\\gh.exe": "file" } });
    const reached: string[] = [];
    const exec = scriptedExec({ "gh --version": { stdout: "gh version 2.105.0 (2026-11-12)\n" } });
    const result = await probeGitCli("gh", { exec, deps, reach: (dir) => reached.push(dir) });
    expect(reached).toEqual(["C:\\Program Files\\GitHub CLI"]);
    expect(result).toMatchObject({ status: "ok", detail: "found at C:\\Program Files\\GitHub CLI\\gh.exe — JaiRA added C:\\Program Files\\GitHub CLI to the PATH it runs programs with" });
  });

  it("says what to do on a Linux where nothing here installs it", async () => {
    const deps = fakeFs({ platform: "linux", home: "/home/me", path: ["/usr/bin", "/bin"], files: { "/usr/bin/curl": "file" } });
    const result = await probeGitCli("git", { exec: scriptedExec({}), deps });
    expect(result).toMatchObject({ status: "failed", detail: "git was not found on this machine", fix: expect.stringMatching(/^install it with your distribution's package manager/) });
    expect(result.install?.install).toBeUndefined();
  });

  it("reads each program's version line", () => {
    expect(gitCliVersionOf("git", "git version 2.51.0.windows.1\n")).toBe("2.51.0.windows.1");
    expect(gitCliVersionOf("glab", "glab 1.48.0 (b9d6e9a5)\n")).toBe("1.48.0 (b9d6e9a5)");
    expect(gitCliVersionOf("glab", "glab version 1.73.0\n")).toBe("1.73.0");
  });
});

describe("installGitCli", () => {
  it("waits on Apple's installer until git is there", async () => {
    const files: Record<string, "file"> = { ...MAC, "/usr/bin/git": "file" };
    const deps = fakeFs({ path: MAC_PATH, files });
    let asked = 0;
    const exec = scriptedExec({
      "xcode-select --install": { stdout: "xcode-select: note: install requested for command line developer tools\n" },
      "xcode-select -p": () => {
        asked += 1;
        if (asked < 3) return { code: 2 };
        files["/Library/Developer/CommandLineTools/usr/bin/git"] = "file";
        return { stdout: "/Library/Developer/CommandLineTools\n" };
      },
    });
    const outcome = await installGitCli("git", "command-line-tools", { exec, deps, wait: { pollMs: 1 } });
    expect(outcome).toEqual({ ok: true, path: "/usr/bin/git", onPath: true });
    expect(asked).toBe(3);
  });

  it("stops waiting on Cancel", async () => {
    const deps = fakeFs({ path: MAC_PATH, files: { ...MAC, "/usr/bin/git": "file" } });
    const controller = new AbortController();
    const exec = scriptedExec({
      "xcode-select --install": { stdout: "" },
      "xcode-select -p": () => {
        controller.abort();
        return { code: 2 };
      },
    });
    expect(await installGitCli("git", "command-line-tools", { exec, deps, abortSignal: controller.signal, wait: { pollMs: 1 } })).toEqual({ ok: false, reason: "the install was cancelled" });
  });
});
