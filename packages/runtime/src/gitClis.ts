/**
 * The git programs on the machine agents run on — git, GitHub's `gh`, GitLab's `glab` — checked and
 * installed as an agent's binary is (`agentInstall.ts`), for Settings → Connections → Git.
 *
 * git is the one JaiRA needs: worktrees, diffs and pushes all run it (`git.ts`). `gh` and `glab` it does
 * not run — a forge is reached through JaiRA's own connection — but an agent may, from a shell, so
 * whether they are there is worth saying, and installing them is one press.
 *
 * A Mac without Apple's Command Line Tools still has /usr/bin/git: a placeholder that opens their
 * installer when it is run. So on a Mac the check asks `xcode-select -p` where the tools are before it
 * runs anything called git, and a check never opens that window.
 */
import { posix, win32 } from "node:path";
import type { AgentInstallMethod, AgentInstallOutcome, GitCliName, ProbeResult } from "@jaira/shared";
import { GIT_CLI_PACKAGES, agentInstallOf, gatherInstallFacts, runInstall, type InstallFacts, type InstallLookup, type InstallRunOptions } from "./agentInstall";
import type { Exec } from "./exec";
import { isWslEnv } from "./paths";

/** What a check of the git programs needs, beside the lookups. */
export interface GitCliCheckOptions extends InstallLookup {
  /**
   * Make a folder reachable by the bare command from here on — called for a program found only in its
   * installer's usual folder, which the PATH this app was started with does not name (a Mac app started
   * from the Finder; a Windows app started before the install). Absent: it is reported, and left.
   */
  reach?: (dir: string) => void;
}

const VERSION_TIMEOUT_MS = 10_000;

/** What the program is called in a sentence. */
const SPOKEN: Record<GitCliName, string> = { git: "git", gh: "gh (GitHub CLI)", glab: "glab (GitLab CLI)" };

/** Check one git program: where it is, how it got there, what installs or updates it, and its version. */
export async function probeGitCli(name: GitCliName, options: GitCliCheckOptions): Promise<ProbeResult> {
  const pkg = GIT_CLI_PACKAGES[name];
  const native = options.execEnv === undefined || !isWslEnv(options.execEnv);
  const looked = await gitCliFacts(name, options);
  if (looked === undefined) return { name, status: "not-checked", detail: `could not look for ${SPOKEN[name]} where agents run` };
  let facts = looked.facts;
  const placeholder = looked.placeholder;

  // Installed where the PATH this app was started with does not reach: made reachable, then looked at again.
  let reached: string | undefined;
  if (facts.found !== undefined && !facts.found.broken && !facts.found.onPath && native && options.reach !== undefined) {
    reached = (facts.platform === "win32" ? win32 : posix).dirname(facts.found.path);
    options.reach(reached);
    facts = (await gitCliFacts(name, options))?.facts ?? facts;
  }

  const install = agentInstallOf(pkg, facts);
  const found = facts.found;
  if (found === undefined) {
    return {
      name,
      status: "failed",
      detail: placeholder ? "macOS has only a placeholder for git until Apple's Command Line Tools are installed" : `${SPOKEN[name]} was not found on this machine`,
      fix: missingFix(name, facts, install.install !== undefined && install.install.length > 0),
      install,
    };
  }
  if (found.broken) {
    return { name, status: "failed", detail: `'${found.path}' is a link to a file that is gone — what is left of an install`, fix: install.update !== undefined ? `reinstall it: ${install.update.display}` : `install it again`, install };
  }
  if (!found.onPath) {
    return { name, status: "failed", detail: `${SPOKEN[name]} is installed at ${found.path}, which the PATH of the machine agents run on does not reach`, fix: `add ${found.path.replace(/[\\/][^\\/]*$/, "")} to that PATH`, install };
  }

  let result;
  try {
    result = await options.exec.run(pkg.binary, ["--version"], { ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}), timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS });
  } catch (e) {
    return { name, status: "failed", detail: `'${pkg.binary}' could not be started: ${(e as Error).message}`, install };
  }
  if (result.timedOut) return { name, status: "failed", detail: `'${pkg.binary} --version' did not answer in time`, install };
  if (result.code !== 0) {
    const said = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
    return { name, status: "failed", detail: `'${pkg.binary} --version' exited ${result.code}${said !== undefined ? `: ${said}` : ""}`, install };
  }
  const version = gitCliVersionOf(pkg.binary, result.stdout);
  return {
    name,
    status: "ok",
    detail: reached !== undefined ? `found at ${found.path} — JaiRA added ${reached} to the PATH it runs programs with` : `found at ${found.path}`,
    ...(version !== undefined ? { version } : {}),
    install,
  };
}

/**
 * Where a git program is and what installs it — as an agent's, except that Apple's placeholder git is
 * not git: a Mac whose Command Line Tools do not hold one has none, and the placeholder is never run.
 */
async function gitCliFacts(name: GitCliName, lookup: InstallLookup): Promise<{ facts: InstallFacts; placeholder: boolean } | undefined> {
  const pkg = GIT_CLI_PACKAGES[name];
  const facts = await gatherInstallFacts(pkg.binary, pkg, lookup);
  if (facts === undefined) return undefined;
  const native = lookup.execEnv === undefined || !isWslEnv(lookup.execEnv);
  const found = facts.found;
  if (pkg.xcode !== true || facts.platform !== "darwin" || !native || found === undefined || found.real !== `/usr/bin/${pkg.binary}`) return { facts, placeholder: false };
  const tools = await appleTools(pkg.binary, lookup.exec, facts);
  // The git /usr/bin/git hands over to is the one installed — the Command Line Tools', or Xcode's.
  if (tools !== undefined) return { facts: { ...facts, found: { ...found, real: tools } }, placeholder: false };
  const { found: _placeholder, ...rest } = facts;
  return { facts: rest, placeholder: true };
}

/** `git version 2.39.5 (Apple Git-154)` → `2.39.5 (Apple Git-154)`; `glab 1.48.0 (b9d6e9a5)` → `1.48.0 (b9d6e9a5)`. */
export function gitCliVersionOf(binary: string, stdout: string): string | undefined {
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return undefined;
  return first.replace(new RegExp(`^${binary}(\\.exe)?(\\s+version)?\\s+`, "i"), "");
}

/**
 * Where Apple's Command Line Tools (or an Xcode chosen with `xcode-select`) hold the program, when they
 * are here: `xcode-select -p` names their folder, and exits non-zero when there is none. It never opens
 * the installer, which running /usr/bin/git would.
 */
async function appleTools(binary: string, exec: Exec, facts: InstallFacts): Promise<string | undefined> {
  try {
    const result = await exec.run(facts.tools["xcode-select"] ?? "/usr/bin/xcode-select", ["-p"], { timeoutMs: VERSION_TIMEOUT_MS });
    const dir = result.stdout.trim();
    if (result.code !== 0 || dir.length === 0) return undefined;
    const program = posix.join(dir, "usr", "bin", binary);
    return (facts.has?.(program) ?? true) ? program : undefined;
  } catch {
    return undefined;
  }
}

/** What to do about a program that is not here, when no way here installs it — or a word on which to pick. */
function missingFix(name: GitCliName, facts: InstallFacts, installable: boolean): string {
  if (installable) return "install it — Settings → Connections → Git offers the ways this machine has";
  if (facts.platform === "linux") {
    if (name === "git") return "install it with your distribution's package manager — sudo apt install git (Debian, Ubuntu), sudo dnf install git (Fedora)";
    return name === "gh" ? "install it as cli.github.com/manual/installation says for your distribution" : "install it as gitlab.com/gitlab-org/cli says for your distribution";
  }
  if (facts.platform === "win32") return "install WinGet (the App Installer from the Microsoft Store), Chocolatey or Scoop — then it installs from here";
  return "install Homebrew (brew.sh) — then it installs from here";
}

/** How long Apple's installer is waited on: it downloads a few hundred megabytes. */
const APPLE_TOOLS_WAIT_MS = 60 * 60_000;
const APPLE_TOOLS_POLL_MS = 3_000;

/**
 * Install a git program the way named, or update it the way it was installed. Apple's Command Line
 * Tools install in a window of their own — `xcode-select --install` only asks for it — so that way
 * answers once git is there, on Cancel, or after an hour.
 */
export async function installGitCli(name: GitCliName, method: AgentInstallMethod | undefined, options: InstallRunOptions & { wait?: { pollMs?: number; maxMs?: number } }): Promise<AgentInstallOutcome> {
  const pkg = GIT_CLI_PACKAGES[name];
  return runInstall(pkg, pkg.binary, method, options, {
    facts: async () => (await gitCliFacts(name, options))?.facts,
    afterRun: async (chosen) => {
      if (chosen.method !== "command-line-tools") return undefined;
      // Nothing more is printed while Apple's window works: say what is being waited on.
      try {
        options.onOutput?.("Apple's installer runs in a window of its own — waiting until git is there…\n");
      } catch {
        // Somebody watching; the wait goes on without them.
      }
      const facts = await gatherInstallFacts(pkg.binary, pkg, options);
      if (facts === undefined) return undefined;
      const deadline = Date.now() + (options.wait?.maxMs ?? APPLE_TOOLS_WAIT_MS);
      while ((await appleTools(pkg.binary, options.exec, facts)) === undefined) {
        if (options.abortSignal?.aborted === true) return { ok: false, reason: "the install was cancelled" };
        if (Date.now() > deadline) return { ok: false, reason: "Apple's installer did not finish within an hour — press Re-check once it has" };
        await pause(options.wait?.pollMs ?? APPLE_TOOLS_POLL_MS, options.abortSignal);
      }
      return { ok: true, path: `/usr/bin/${pkg.binary}`, onPath: true };
    },
  });
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
