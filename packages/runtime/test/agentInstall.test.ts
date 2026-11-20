/**
 * Installing and updating claude and codex (`agentInstall.ts`): the way each was installed is read off
 * where its binary really lives, and the update goes back through that installer — the same program
 * that put it there. A table of file systems stands in for the machine.
 */
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutorInfo } from "@jaira/shared";
import type { Exec, ExecResult } from "../src/exec";
import { AGENT_PACKAGES, agentInstallOf, agentPackageOf, installAgent } from "../src/agentInstall";
import { installFactsOf, installOriginOf, locateBinary, parseWslFacts, planOf, type InstallDeps } from "../src/install";
import { probeExecutor } from "../src/executors";

const CLAUDE = AGENT_PACKAGES["claude"]!;
const CODEX = AGENT_PACKAGES["codex"]!;
const GEMINI = AGENT_PACKAGES["gemini"]!;
const MUSE = AGENT_PACKAGES["muse"]!;
const OPENCODE = AGENT_PACKAGES["opencode"]!;
const AGY = AGENT_PACKAGES["antigravity"]!;
const HOME = "/Users/me";

/** A file system as a table: a path is a file, or a link to another path (which may be gone). */
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
    home: options.home ?? HOME,
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

/** The usual Mac: curl and bash where the system keeps them. */
const SYSTEM = { "/usr/bin/curl": "file", "/bin/bash": "file" } as const;

describe("where an agent is, and how it got there", () => {
  it("reads the native installer off its versions directory, and updates through the binary's own updater", () => {
    const deps = fakeFs({
      path: [`${HOME}/.local/bin`, "/usr/bin", "/bin"],
      files: { ...SYSTEM, [`${HOME}/.local/bin/claude`]: { link: `${HOME}/.local/share/claude/versions/2.1.150` }, [`${HOME}/.local/share/claude/versions/2.1.150`]: "file" },
    });
    const facts = installFactsOf("claude", CLAUDE, deps);
    const { origin, update, install } = planOf(CLAUDE, facts);
    expect(origin?.method).toBe("native");
    expect(update).toMatchObject({ method: "native", display: "claude update", file: `${HOME}/.local/bin/claude`, args: ["update"] });
    expect(install).toEqual([]);
  });

  it("updates a Homebrew cask with the brew of the prefix it lives under, and keeps the cask's own name", () => {
    const deps = fakeFs({
      path: ["/usr/bin", "/bin", "/opt/homebrew/bin"],
      files: {
        ...SYSTEM,
        "/opt/homebrew/bin/brew": "file",
        "/opt/homebrew/bin/claude": { link: "/opt/homebrew/Caskroom/claude-code@latest/2.1.150/claude" },
        "/opt/homebrew/Caskroom/claude-code@latest/2.1.150/claude": "file",
      },
    });
    const { update } = planOf(CLAUDE, installFactsOf("claude", CLAUDE, deps));
    expect(update).toMatchObject({ method: "homebrew", file: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "claude-code@latest"], display: "brew upgrade --cask claude-code@latest" });
  });

  it("updates an npm install with the npm of ITS Node — under nvm, not whichever npm the PATH reaches first", () => {
    const v22 = `${HOME}/.nvm/versions/node/v22.15.1`;
    const v20 = `${HOME}/.nvm/versions/node/v20.13.1`;
    const deps = fakeFs({
      path: [`${v20}/bin`, `${v22}/bin`, "/usr/bin", "/bin"],
      files: {
        ...SYSTEM,
        [`${v20}/bin/npm`]: "file",
        [`${v22}/bin/npm`]: "file",
        [`${v22}/bin/claude`]: { link: "../lib/node_modules/@anthropic-ai/claude-code/cli.js" },
        [`${v22}/lib/node_modules/@anthropic-ai/claude-code/cli.js`]: "file",
      },
    });
    const { origin, update } = planOf(CLAUDE, installFactsOf("claude", CLAUDE, deps));
    expect(origin).toEqual({ method: "npm", prefix: v22, npmName: "@anthropic-ai/claude-code" });
    expect(update).toMatchObject({ file: `${v22}/bin/npm`, args: ["install", "-g", "@anthropic-ai/claude-code@latest"], display: "npm install -g @anthropic-ai/claude-code@latest" });
    // `npm` is `#!/usr/bin/env node`: its own Node goes first on the PATH it runs with.
    expect(update?.env?.["PATH"]?.split(":")[0]).toBe(`${v22}/bin`);
  });

  it("falls back to the npm found when the install's prefix has none of its own", () => {
    const deps = fakeFs({
      path: ["/usr/local/bin", `${HOME}/.npm-global/bin`, "/usr/bin", "/bin"],
      files: {
        ...SYSTEM,
        "/usr/local/bin/npm": "file",
        [`${HOME}/.npm-global/bin/codex`]: { link: "../lib/node_modules/@openai/codex/bin/codex.js" },
        [`${HOME}/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`]: "file",
      },
    });
    expect(planOf(CODEX, installFactsOf("codex", CODEX, deps)).update).toMatchObject({ file: "/usr/local/bin/npm", args: ["install", "-g", "@openai/codex@latest"] });
  });

  it("reads Bun, pnpm, the old local install and WinGet off their directories", () => {
    expect(installOriginOf(`${HOME}/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js`, CLAUDE)?.method).toBe("bun");
    expect(installOriginOf(`${HOME}/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js`, CODEX)?.method).toBe("pnpm");
    expect(installOriginOf(`${HOME}/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js`, CLAUDE)?.method).toBe("native");
    expect(installOriginOf("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe", CLAUDE)?.method).toBe("winget");
    expect(installOriginOf("/usr/local/Cellar/codex/0.98.0/bin/codex", CODEX)).toEqual({ method: "homebrew", prefix: "/usr/local", name: "codex", formula: true });
    // The native build is Claude's: a codex under a path that looks like it is nothing known.
    expect(installOriginOf(`${HOME}/.local/share/claude/versions/1/codex`, CODEX)).toBeUndefined();
  });

  it("offers no update for a binary whose path says nothing known — a guess would be worse", () => {
    const deps = fakeFs({ path: ["/opt/tools", "/usr/bin", "/bin"], files: { ...SYSTEM, "/opt/tools/claude": "file" } });
    const install = agentInstallOf(CLAUDE, installFactsOf("claude", CLAUDE, deps));
    expect(install).toEqual({ path: "/opt/tools/claude", onPath: true });
  });

  it("finds one installed where this app's PATH does not reach — a Mac app started from the Finder", () => {
    const deps = fakeFs({
      path: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
      files: { ...SYSTEM, [`${HOME}/.local/bin/claude`]: { link: `${HOME}/.local/share/claude/versions/2.1.150` }, [`${HOME}/.local/share/claude/versions/2.1.150`]: "file" },
    });
    expect(agentInstallOf(CLAUDE, installFactsOf("claude", CLAUDE, deps))).toMatchObject({ path: `${HOME}/.local/bin/claude`, onPath: false, method: "native" });
  });

  it("reports a cask whose files are gone as broken, and mends it with a reinstall", () => {
    // Observed on a Mac, 2026-11: the link Homebrew made, pointing into a version directory now empty.
    const deps = fakeFs({
      path: ["/usr/local/bin", "/usr/bin", "/bin"],
      files: { ...SYSTEM, "/usr/local/bin/brew": "file", "/usr/local/bin/codex": { link: "/usr/local/Caskroom/codex/0.106.0/codex-x86_64-apple-darwin" } },
    });
    const facts = installFactsOf("codex", CODEX, deps);
    expect(facts.found).toEqual({ path: "/usr/local/bin/codex", real: "/usr/local/Caskroom/codex/0.106.0/codex-x86_64-apple-darwin", onPath: true, broken: true });
    expect(agentInstallOf(CODEX, facts)).toEqual({
      path: "/usr/local/bin/codex",
      onPath: true,
      broken: true,
      method: "homebrew",
      update: { method: "homebrew", via: "Homebrew", display: "brew reinstall --cask codex" },
    });
  });

  it("goes past a dangling link to a working binary later on the PATH, as a shell would", () => {
    const deps = fakeFs({
      path: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"],
      files: { ...SYSTEM, "/usr/local/bin/codex": { link: "/gone" }, "/opt/homebrew/bin/codex": { link: "/opt/homebrew/Caskroom/codex/0.150.0/codex" }, "/opt/homebrew/Caskroom/codex/0.150.0/codex": "file" },
    });
    expect(locateBinary("codex", deps)).toMatchObject({ path: "/opt/homebrew/bin/codex", broken: false });
  });
});

describe("installing an agent that is not here", () => {
  const empty = (files: Record<string, "file">, platform: NodeJS.Platform = "darwin") => fakeFs({ platform, path: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"], files: { ...SYSTEM, ...files } });

  it("offers Claude's native installer first, then Homebrew and npm when they are here", () => {
    const install = agentInstallOf(CLAUDE, installFactsOf("claude", CLAUDE, empty({ "/opt/homebrew/bin/brew": "file", "/usr/local/bin/npm": "file" })));
    expect(install.install).toEqual([
      { method: "native", via: "the native installer", display: "curl -fsSL https://claude.ai/install.sh | bash" },
      { method: "homebrew", via: "Homebrew", display: "brew install --cask claude-code" },
      { method: "npm", via: "npm", display: "npm install -g @anthropic-ai/claude-code" },
    ]);
  });

  it("offers Codex through npm, then its cask — and no cask off a Mac, where Homebrew has none", () => {
    const tools = { "/opt/homebrew/bin/brew": "file", "/usr/local/bin/npm": "file" } as const;
    expect(agentInstallOf(CODEX, installFactsOf("codex", CODEX, empty(tools))).install?.map((one) => one.display)).toEqual(["npm install -g @openai/codex", "brew install --cask codex"]);
    expect(agentInstallOf(CODEX, installFactsOf("codex", CODEX, empty(tools, "linux"))).install?.map((one) => one.method)).toEqual(["npm"]);
    expect(agentInstallOf(CODEX, installFactsOf("codex", CODEX, empty({}))).install).toBeUndefined();
  });

  it("runs Claude's Windows installer in PowerShell, and an npm shim by its name", () => {
    const deps = fakeFs({
      platform: "win32",
      home: "C:\\Users\\me",
      path: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0", "C:\\Program Files\\nodejs"],
      files: { "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "file", "C:\\Program Files\\nodejs\\npm.cmd": "file" },
    });
    const { install } = planOf(CLAUDE, installFactsOf("claude", CLAUDE, deps));
    expect(install[0]).toMatchObject({ method: "native", file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"] });
    expect(install[1]).toMatchObject({ method: "npm", file: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] });
  });

  it("reads a Windows npm shim by the package beside it", () => {
    const deps = fakeFs({
      platform: "win32",
      home: "C:\\Users\\me",
      path: ["C:\\Users\\me\\AppData\\Roaming\\npm"],
      files: { "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd": "file", "C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd": "file", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code": "file" },
    });
    expect(planOf(CLAUDE, installFactsOf("claude", CLAUDE, deps)).update).toMatchObject({ method: "npm", file: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] });
  });
});

describe("on Windows, beside the vendors' own ways", () => {
  const windows = (files: Record<string, "file">) =>
    fakeFs({
      platform: "win32",
      home: "C:\\Users\\me",
      path: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0", "C:\\Program Files\\nodejs", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\ProgramData\\chocolatey\\bin", "C:\\Users\\me\\scoop\\shims"],
      files: { "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "file", ...files },
    });
  const ALL = {
    "C:\\Program Files\\nodejs\\npm.cmd": "file",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe": "file",
    "C:\\ProgramData\\chocolatey\\bin\\choco.exe": "file",
    "C:\\Users\\me\\scoop\\shims\\scoop.cmd": "file",
  } as const;

  it("offers WinGet, Chocolatey and Scoop where each has the agent — after the vendor's own", () => {
    const methods = (pkg: typeof CLAUDE) => planOf(pkg, installFactsOf(pkg.binary, pkg, windows({ ...ALL }))).install.map((one) => one.method);
    expect(methods(CLAUDE)).toEqual(["native", "winget", "npm", "chocolatey", "scoop"]);
    expect(methods(CODEX)).toEqual(["npm", "winget", "chocolatey", "scoop"]);
    // OpenCode v2 only: Chocolatey's `opencode` is v1.
    expect(methods(OPENCODE)).toEqual(["npm", "winget", "scoop"]);
    // Nothing current for Gemini on any of them.
    expect(methods(GEMINI)).toEqual(["npm"]);
  });

  it("installs Claude by WinGet's id, and Chocolatey's as administrator", () => {
    const { install } = planOf(CLAUDE, installFactsOf("claude", CLAUDE, windows({ ...ALL })));
    expect(install.find((one) => one.method === "winget")?.display).toBe("winget install --id Anthropic.ClaudeCode --exact");
    expect(install.find((one) => one.method === "chocolatey")?.display).toBe("choco install claude-code -y (as administrator)");
    expect(install.find((one) => one.method === "scoop")?.display).toBe("scoop install claude-code");
  });

  it("updates an agent Scoop or Chocolatey installed by the same program", () => {
    const scoop = windows({ ...ALL, "C:\\Users\\me\\scoop\\shims\\codex.exe": "file" });
    expect(planOf(CODEX, installFactsOf("codex", CODEX, scoop)).update?.display).toBe("scoop update codex");
    const choco = windows({ ...ALL, "C:\\ProgramData\\chocolatey\\bin\\claude.exe": "file" });
    expect(planOf(CLAUDE, installFactsOf("claude", CLAUDE, choco)).update?.display).toBe("choco upgrade claude-code -y (as administrator)");
  });
});

describe("Gemini, Muse Code and OpenCode", () => {
  const machine = (files: Record<string, "file" | { link: string }>, platform: NodeJS.Platform = "darwin") =>
    fakeFs({ platform, path: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"], files: { ...SYSTEM, "/opt/homebrew/bin/brew": "file", "/usr/local/bin/npm": "file", ...files } });

  it("installs Gemini with npm alone — Homebrew's formula is deprecated — and still updates one the formula installed, by name", () => {
    expect(agentInstallOf(GEMINI, installFactsOf("gemini", GEMINI, machine({}))).install?.map((one) => one.display)).toEqual(["npm install -g @google/gemini-cli"]);
    expect(agentInstallOf(GEMINI, installFactsOf("gemini", GEMINI, machine({}, "linux"))).install?.map((one) => one.method)).toEqual(["npm"]);
    const installed = machine({ "/opt/homebrew/bin/gemini": { link: "../Cellar/gemini-cli/0.63.0/bin/gemini" }, "/opt/homebrew/Cellar/gemini-cli/0.63.0/bin/gemini": "file" });
    expect(planOf(GEMINI, installFactsOf("gemini", GEMINI, installed)).update).toMatchObject({ file: "/opt/homebrew/bin/brew", args: ["upgrade", "gemini-cli"] });
  });

  it("installs Muse Code with Meta's script, then its cask; its self-updating launcher updates by the script again", () => {
    expect(agentInstallOf(MUSE, installFactsOf("muse", MUSE, machine({}))).install?.map((one) => one.display)).toEqual(["curl -fsSL https://dev.meta.ai/install.sh | bash", "brew install --cask muse-code"]);
    // The launcher is a plain file beside the build it runs — no link to follow.
    const installed = fakeFs({ path: [`${HOME}/.local/bin`, "/usr/bin", "/bin"], files: { ...SYSTEM, [`${HOME}/.local/bin/muse`]: "file", [`${HOME}/.local/bin/muse-bin-1.4.20`]: "file" } });
    expect(planOf(MUSE, installFactsOf("muse", MUSE, installed)).update).toMatchObject({ method: "native", file: "/bin/bash", args: ["-c", "curl -fsSL https://dev.meta.ai/install.sh | bash"] });
  });

  it("offers nothing for Muse Code on Windows, which it does not run on", () => {
    const deps = fakeFs({ platform: "win32", home: "C:\\Users\\me", path: ["C:\\Program Files\\nodejs"], files: { "C:\\Program Files\\nodejs\\npm.cmd": "file" } });
    expect(agentInstallOf(MUSE, installFactsOf("muse", MUSE, deps))).toEqual({});
  });

  it("installs OpenCode by its script first; one installed so updates with `opencode upgrade`, an old npm one as the package it is", () => {
    expect(agentInstallOf(OPENCODE, installFactsOf("opencode", OPENCODE, machine({}))).install?.map((one) => one.display)).toEqual([
      "curl -fsSL https://opencode.ai/v2/install | bash",
      "npm install -g @opencode/cli",
      "brew install anomalyco/tap/opencode-v2",
    ]);
    const script = fakeFs({ path: [`${HOME}/.opencode/bin`, "/usr/bin", "/bin"], files: { ...SYSTEM, [`${HOME}/.opencode/bin/opencode`]: "file" } });
    expect(planOf(OPENCODE, installFactsOf("opencode", OPENCODE, script)).update).toMatchObject({ file: `${HOME}/.opencode/bin/opencode`, args: ["upgrade"], display: "opencode upgrade" });
    const old = machine({ "/usr/local/bin/opencode": { link: "../lib/node_modules/opencode-ai/bin/opencode" }, "/usr/local/lib/node_modules/opencode-ai/bin/opencode": "file" });
    expect(planOf(OPENCODE, installFactsOf("opencode", OPENCODE, old)).update).toMatchObject({ file: "/usr/local/bin/npm", args: ["install", "-g", "opencode-ai@latest"] });
    const tapped = machine({ "/opt/homebrew/bin/opencode": { link: "../Cellar/opencode-v2/2.0.4/bin/opencode" }, "/opt/homebrew/Cellar/opencode-v2/2.0.4/bin/opencode": "file" });
    expect(planOf(OPENCODE, installFactsOf("opencode", OPENCODE, tapped)).update?.display).toBe("brew upgrade opencode-v2");
  });

  it("installs Antigravity by Google's script alone, and updates it by running the script again", () => {
    expect(agentInstallOf(AGY, installFactsOf("agy", AGY, machine({}))).install).toEqual([{ method: "native", via: "the native installer", display: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }]);
    const installed = fakeFs({ path: ["/usr/bin", "/bin"], files: { ...SYSTEM, [`${HOME}/.local/bin/agy`]: "file" } });
    const install = agentInstallOf(AGY, installFactsOf("agy", AGY, installed));
    // ~/.local/bin is off this PATH: found there, and the row offers to use it.
    expect(install).toMatchObject({ path: `${HOME}/.local/bin/agy`, onPath: false, method: "native", update: { display: "curl -fsSL https://antigravity.google/cli/install.sh | bash" } });
    const windows = fakeFs({
      platform: "win32",
      home: "C:\\Users\\me",
      path: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0"],
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      files: { "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": "file", "C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe": "file" },
    });
    expect(planOf(AGY, installFactsOf("agy", AGY, windows))).toMatchObject({ origin: { method: "native" }, update: { args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"] } });
  });

  it("finds OpenCode in the directory its script installs to when the PATH does not reach it", () => {
    const deps = fakeFs({ path: ["/usr/bin", "/bin"], files: { ...SYSTEM, [`${HOME}/.opencode/bin/opencode`]: "file" } });
    expect(agentInstallOf(OPENCODE, installFactsOf("opencode", OPENCODE, deps))).toMatchObject({ onPath: false, method: "native", update: { display: "opencode upgrade" } });
  });

  it("knows a generic CLI by its program, whatever it is called", () => {
    const generic = (command: string): ExecutorInfo => ({ name: "my-agent", kind: "generic", enabled: true, command, credentialUse: "optional", policyEnforcement: "none" });
    expect(agentPackageOf(generic("opencode"))?.binary).toBe("opencode");
    expect(agentPackageOf(generic("/opt/homebrew/bin/gemini"))?.binary).toBe("gemini");
    expect(agentPackageOf(generic("C:\\Users\\me\\.local\\bin\\muse.exe"))?.binary).toBe("muse");
    expect(agentPackageOf(generic("agy"))?.binary).toBe("agy");
    expect(agentPackageOf(generic("aider"))).toBeUndefined();
    expect(agentPackageOf(CLAUDE_CLI)?.binary).toBe("claude");
  });
});

describe("inside WSL", () => {
  it("reads what one `sh` reported", () => {
    const facts = parseWslFacts("found\t/home/me/.local/bin/claude\t/home/me/.local/share/claude/versions/2.1.150\ntool\tcurl\t/usr/bin/curl\ntool\tbash\t/usr/bin/bash\nhome\t/home/me\n");
    expect(facts).toEqual({
      platform: "linux",
      home: "/home/me",
      found: { path: "/home/me/.local/bin/claude", real: "/home/me/.local/share/claude/versions/2.1.150", onPath: true, broken: false },
      tools: { curl: "/usr/bin/curl", bash: "/usr/bin/bash" },
    });
    expect(planOf(CLAUDE, facts).update?.display).toBe("claude update");
  });
});

/** An Exec that answers every command the same, and records what it ran — printing `prints` as it runs. */
function recordingExec(answer: Partial<ExecResult>, after?: () => void, prints: Array<["stdout" | "stderr", string]> = []): Exec & { calls: Array<{ file: string; args: readonly string[]; stdin?: string }> } {
  const calls: Array<{ file: string; args: readonly string[]; stdin?: string }> = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push({ file, args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
      for (const [stream, chunk] of prints) options?.onOutput?.(stream, chunk);
      after?.();
      return Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "", command: file, timedOut: false, aborted: false, ...answer } as ExecResult);
    },
  };
}

const CLAUDE_CLI: ExecutorInfo = { name: "claude-cli", kind: "cli", enabled: true, command: "claude", credentialUse: "none", policyEnforcement: "callback" };

describe("installAgent", () => {
  it("runs the way named, with stdin closed, and answers where the binary is now", async () => {
    const files: Record<string, "file" | { link: string }> = { ...SYSTEM };
    const deps = fakeFs({ path: ["/usr/bin", "/bin"], files });
    // The installer puts the binary in ~/.local/bin, which this PATH does not reach.
    const exec = recordingExec({ code: 0 }, () => {
      files[`${HOME}/.local/bin/claude`] = { link: `${HOME}/.local/share/claude/versions/2.1.150` };
      files[`${HOME}/.local/share/claude/versions/2.1.150`] = "file";
    });
    const outcome = await installAgent(CLAUDE_CLI, "native", { exec, deps });
    expect(exec.calls).toEqual([{ file: "/bin/bash", args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], stdin: "" }]);
    expect(outcome).toEqual({ ok: true, path: `${HOME}/.local/bin/claude`, onPath: false });
  });

  it("updates by the way it was installed when no way is named", async () => {
    const deps = fakeFs({
      path: ["/opt/homebrew/bin", "/usr/bin", "/bin"],
      files: { ...SYSTEM, "/opt/homebrew/bin/brew": "file", "/opt/homebrew/bin/claude": { link: "/opt/homebrew/Caskroom/claude-code/2.1.140/claude" }, "/opt/homebrew/Caskroom/claude-code/2.1.140/claude": "file" },
    });
    const exec = recordingExec({ code: 0 });
    expect(await installAgent(CLAUDE_CLI, undefined, { exec, deps })).toEqual({ ok: true, path: "/opt/homebrew/bin/claude", onPath: true });
    expect(exec.calls[0]).toMatchObject({ file: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "claude-code"] });
  });

  it("refuses a way this machine does not offer, and an update it cannot place — running nothing", async () => {
    const exec = recordingExec({ code: 0 });
    const bare = fakeFs({ path: ["/usr/bin", "/bin"], files: { ...SYSTEM } });
    expect(await installAgent(CLAUDE_CLI, "homebrew", { exec, deps: bare })).toEqual({ ok: false, reason: "Homebrew cannot install claude here" });
    const odd = fakeFs({ path: ["/opt/tools", "/usr/bin", "/bin"], files: { ...SYSTEM, "/opt/tools/claude": "file" } });
    expect(await installAgent(CLAUDE_CLI, undefined, { exec, deps: odd })).toMatchObject({ ok: false, reason: expect.stringMatching(/not installed in a way JaiRA can update/) });
    expect(exec.calls).toEqual([]);
  });

  it("says what it runs, then what the installer prints as it prints it, to whoever is watching", async () => {
    const deps = fakeFs({ path: ["/usr/local/bin", "/usr/bin", "/bin"], files: { ...SYSTEM, "/usr/local/bin/npm": "file" } });
    const said: string[] = [];
    const exec = recordingExec({ code: 0 }, undefined, [
      ["stdout", "added 3 packages\r"],
      ["stderr", "npm warn deprecated\n"],
    ]);
    await installAgent(CLAUDE_CLI, "npm", { exec, deps, onOutput: (text) => said.push(text) });
    expect(said).toEqual(["$ npm install -g @anthropic-ai/claude-code\n", "added 3 packages\r", "npm warn deprecated\n"]);
    // A watcher that throws is nobody's problem but its own.
    const broken = await installAgent(CLAUDE_CLI, "npm", {
      exec,
      deps,
      onOutput: () => {
        throw new Error("a broken watcher");
      },
    });
    expect(broken.ok).toBe(true);
  });

  it("says why an installer failed in its own last words, and a cancel as a cancel", async () => {
    const deps = fakeFs({ path: ["/usr/local/bin", "/usr/bin", "/bin"], files: { ...SYSTEM, "/usr/local/bin/npm": "file" } });
    const failed = await installAgent(CLAUDE_CLI, "npm", { exec: recordingExec({ code: 243, stdout: "added 0 packages\n", stderr: "npm error code EACCES\nnpm error \u001b[31mpermission denied\u001b[0m\n" }), deps });
    expect(failed).toEqual({ ok: false, reason: "'npm install -g @anthropic-ai/claude-code' exited 243: npm error permission denied" });
    expect(await installAgent(CLAUDE_CLI, "npm", { exec: recordingExec({ code: null, aborted: true }), deps })).toEqual({ ok: false, reason: "the install was cancelled" });
  });
});

describe("the probe, asked about the install", () => {
  it("offers the install for a claude that is not here, and says where to do it", async () => {
    const deps = fakeFs({ path: ["/usr/bin", "/bin"], files: { ...SYSTEM } });
    const exec: Exec = { run: () => Promise.reject(new Error("spawn claude ENOENT")) };
    const result = await probeExecutor(CLAUDE_CLI, { exec, install: deps });
    expect(result.status).toBe("failed");
    expect(result.fix).toBe("install it from Settings → Connections → Agents, or point this executor at its full path");
    expect(result.install?.install?.[0]?.method).toBe("native");
  });

  it("names the path a claude is installed at when this app's PATH does not reach it", async () => {
    const deps = fakeFs({
      path: ["/usr/bin", "/bin"],
      files: { ...SYSTEM, [`${HOME}/.local/bin/claude`]: { link: `${HOME}/.local/share/claude/versions/2.1.150` }, [`${HOME}/.local/share/claude/versions/2.1.150`]: "file" },
    });
    const exec: Exec = { run: () => Promise.reject(new Error("spawn claude ENOENT")) };
    const result = await probeExecutor(CLAUDE_CLI, { exec, install: deps });
    expect(result.detail).toBe(`'claude' is installed at ${HOME}/.local/bin/claude, which this app's PATH does not reach`);
    expect(result.install).toMatchObject({ onPath: false, method: "native" });
  });

  it("carries how a working claude was installed, beside its version and login", async () => {
    const deps = fakeFs({
      path: [`${HOME}/.local/bin`, "/usr/bin", "/bin"],
      files: { ...SYSTEM, [`${HOME}/.local/bin/claude`]: { link: `${HOME}/.local/share/claude/versions/2.1.150` }, [`${HOME}/.local/share/claude/versions/2.1.150`]: "file" },
    });
    const exec: Exec = {
      run: (_file, args) =>
        Promise.resolve({
          code: 0,
          signal: null,
          stdout: args[0] === "--version" ? "2.1.150 (Claude Code)\n" : JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com" }),
          stderr: "",
          command: "claude",
          timedOut: false,
          aborted: false,
        }),
    };
    const result = await probeExecutor(CLAUDE_CLI, { exec, install: deps });
    expect(result).toMatchObject({ status: "ok", version: "2.1.150 (Claude Code)", install: { method: "native", update: { display: "claude update" } } });
  });

  it("looks nothing up unless asked — every probe without it is as it was", async () => {
    const exec: Exec = { run: () => Promise.reject(new Error("spawn claude ENOENT")) };
    expect((await probeExecutor(CLAUDE_CLI, { exec })).install).toBeUndefined();
  });
});
