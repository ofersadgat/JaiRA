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
import { agentInstallOf } from "./agentInstall";
import {
  GIT_CLI_PACKAGES,
  gatherInstallFacts,
  runInstall,
  versionLineOf,
  waitForAppleInstall,
  withoutApplePlaceholder,
  type AppleWait,
  type InstallFacts,
  type InstallLookup,
  type InstallRunOptions,
} from "./install";
import { isWslEnv, onMachine } from "./paths";

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
export async function probeGitCli(name: GitCliName, given: GitCliCheckOptions): Promise<ProbeResult> {
  // git is the machine's: a workspace's container (decision 0027) is not where it is looked for.
  const options = onMachine(given);
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
  return withoutApplePlaceholder(pkg, pkg.binary, facts, lookup);
}

/** `git version 2.39.5 (Apple Git-154)` → `2.39.5 (Apple Git-154)`; `glab 1.48.0 (b9d6e9a5)` → `1.48.0 (b9d6e9a5)`. */
export function gitCliVersionOf(binary: string, stdout: string): string | undefined {
  return versionLineOf(binary, stdout);
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

/**
 * Install a git program the way named, or update it the way it was installed. Apple's Command Line
 * Tools install in a window of their own — `xcode-select --install` only asks for it — so that way
 * answers once git is there, on Cancel, or after an hour.
 */
export async function installGitCli(name: GitCliName, method: AgentInstallMethod | undefined, given: InstallRunOptions & { wait?: AppleWait }): Promise<AgentInstallOutcome> {
  const options = onMachine(given);
  const pkg = GIT_CLI_PACKAGES[name];
  return runInstall(pkg, pkg.binary, method, options, {
    facts: async () => (await gitCliFacts(name, options))?.facts,
    afterRun: async (chosen) => (chosen.method === "command-line-tools" ? waitForAppleInstall(pkg, pkg.binary, options, options.wait) : undefined),
  });
}
