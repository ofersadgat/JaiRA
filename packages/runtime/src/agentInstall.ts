/**
 * Installing and updating the coding agents JaiRA drives — `claude`, `codex`, `gemini`, `agy`, `muse`
 * and `opencode` — through the tool installer (`install/`), which the git programs (`gitClis.ts`) and a
 * project's setup use too.
 *
 * Each agent has several installers, and they do not mix: `claude update` on a Homebrew cask is
 * refused, `npm i -g` beside the native build leaves two binaries that disagree about which one is
 * current, and under nvm the `npm` on the PATH may belong to another Node than the one the agent was
 * installed with. So the way an agent was installed is read off WHERE ITS BINARY LIVES, and the update
 * goes back through the same installer, by the same program, that put it there (`install/origin.ts`).
 *
 * Nothing here runs at a probe but lookups. What installs or updates is run only when a person
 * presses the button, and what runs is decided from what was found — the window only names the agent
 * and the way.
 */
import { EXECUTOR_TITLES, type AgentInstall, type AgentInstallCommand, type AgentInstallMethod, type AgentInstallOutcome, type AgentInstallRequest, type ExecutorInfo, type ExecutorKind, type InstallChoice } from "@jaira/shared";
import {
  gatherChainFacts,
  installChoicesOf,
  isAgentInstallMethod,
  planOf,
  runChoice,
  runInstall,
  shownChoices,
  type AgentPackage,
  type ChainRunHooks,
  type InstallFacts,
  type InstallLookup,
  type InstallPlan,
  type InstallRunOptions,
} from "./install";
import { onMachine } from "./paths";

/**
 * The agents JaiRA can install, as their vendors ship them (observed 2026-11):
 *
 *  - Claude Code: Anthropic recommends its native installer, which updates itself (`claude update` asks
 *    now); a Homebrew cask (`claude-code`, or `claude-code@latest`), WinGet and npm besides.
 *  - Codex: npm, and a Homebrew cask.
 *  - Gemini CLI: npm. Homebrew's formula is deprecated — it is behind npm, and is disabled on 2026-12-18
 *    for Antigravity CLI — so it is not offered.
 *  - Muse Code (Meta): its install script, which puts a self-updating launcher in `~/.local/bin`, and
 *    a Homebrew cask. No npm package, and no Windows build (WSL2 is the way there).
 *  - OpenCode: its install script (`~/.opencode/bin`, updated by `opencode upgrade`), npm (`@opencode/cli`
 *    since v2, `opencode-ai` before), and its own Homebrew tap.
 *  - Antigravity CLI (Google, `agy`): its install script only — `~/.local/bin/agy`, or
 *    `%LOCALAPPDATA%\agy\bin` on Windows — which installs the latest when run again. (Homebrew's
 *    `antigravity` is the desktop app, not this.)
 *
 * On Windows, beside the vendors' own ways (checked 2026-11-17): WinGet has Claude Code (Anthropic's docs
 * name it), Codex and OpenCode v2; Chocolatey has Claude Code and Codex, and Scoop's main bucket all
 * three — community packages, kept current, offered after the vendor's. Each npm package names the
 * oldest Node.js it runs on (its `engines.node`, read 2026-11-19). Chocolatey's `claude` and
 * Scoop's extras `claude` are Claude's desktop app; Chocolatey's `gemini-cli` is months behind, and its
 * `opencode` is v1. None of them is offered.
 */
export const AGENT_PACKAGES: Readonly<Record<string, AgentPackage>> = {
  claude: {
    binary: "claude",
    npm: { name: "@anthropic-ai/claude-code", node: ">=22" },
    brew: { name: "claude-code", cask: true },
    winget: "Anthropic.ClaudeCode",
    choco: "claude-code",
    scoop: "claude-code",
    native: {
      posix: "curl -fsSL https://claude.ai/install.sh | bash",
      windows: "irm https://claude.ai/install.ps1 | iex",
      paths: [/\/\.local\/share\/claude\//, /\/\.claude\/local\//, /\/\.local\/bin\/claude\.exe$/i],
      update: ["update"],
    },
    order: ["native", "homebrew", "winget", "npm", "chocolatey", "scoop"],
  },
  codex: {
    binary: "codex",
    npm: { name: "@openai/codex", node: ">=16" },
    brew: { name: "codex", cask: true },
    winget: "OpenAI.Codex",
    choco: "codex",
    scoop: "codex",
    order: ["npm", "homebrew", "winget", "chocolatey", "scoop"],
  },
  gemini: {
    binary: "gemini",
    npm: { name: "@google/gemini-cli", node: ">=20" },
    order: ["npm"],
  },
  muse: {
    binary: "muse",
    brew: { name: "muse-code", cask: true },
    // A launcher at ~/.local/bin/muse, the build beside it as muse-bin-<version>.
    native: { posix: "curl -fsSL https://dev.meta.ai/install.sh | bash", paths: [/\/\.local\/bin\/muse(-bin-[^/]*)?$/] },
    order: ["native", "homebrew"],
  },
  opencode: {
    binary: "opencode",
    npm: { name: "@opencode/cli", also: ["opencode-ai"] },
    brew: { name: "anomalyco/tap/opencode-v2", cask: false },
    // v2 both: Chocolatey's `opencode` is still v1, and its `opencode2` too new to lean on.
    winget: "Anomaly.OpenCode",
    scoop: "opencode",
    native: { posix: "curl -fsSL https://opencode.ai/v2/install | bash", paths: [/\/\.opencode\/bin\//], update: ["upgrade"] },
    // Where its script installs it, which the PATH this app started with may not reach.
    dirs: { posix: ["~/.opencode/bin"] },
    order: ["native", "npm", "homebrew", "winget", "scoop"],
  },
  antigravity: {
    binary: "agy",
    native: {
      posix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      windows: "irm https://antigravity.google/cli/install.ps1 | iex",
      paths: [/\/\.local\/bin\/agy$/, /\/AppData\/Local\/agy\/bin\//i],
    },
    dirs: { windows: ["%LOCALAPPDATA%\\agy\\bin"] },
    order: ["native"],
  },
};

/** Only what the person is shown: the commands without the program that runs them — the ways an agent's row knows. */
function shown(one: InstallPlan): AgentInstallCommand[] {
  return isAgentInstallMethod(one.method) ? [{ method: one.method, via: one.via, display: one.display }] : [];
}

/** What a probe reports of an agent's install — or a git program's: only the ways its row knows. */
export function agentInstallOf(pkg: AgentPackage, facts: InstallFacts): AgentInstall {
  const { origin, update, install } = planOf(pkg, facts);
  const found = facts.found;
  const method: AgentInstallMethod | undefined = origin !== undefined && isAgentInstallMethod(origin.method) ? origin.method : undefined;
  const updates = update !== undefined ? shown(update) : [];
  const installs = install.flatMap(shown);
  return {
    ...(found !== undefined ? { path: found.path, onPath: found.onPath, ...(found.broken ? { broken: true } : {}) } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(updates[0] !== undefined ? { update: updates[0] } : {}),
    ...(installs.length > 0 ? { install: installs } : {}),
  };
}

/**
 * The install menu for a package that is not installed here — or is, but broken, with nothing to mend
 * it: each way, and the rows for what a way needs first (Node.js for npm, Homebrew for a formula), as
 * `chain.ts` builds them. Undefined when installed, or when nothing here could install it at all.
 */
export async function installChoicesFor(pkg: AgentPackage, title: string, command: string, facts: InstallFacts, lookup: InstallLookup): Promise<InstallChoice[] | undefined> {
  const found = facts.found;
  if (found !== undefined && (!found.broken || planOf(pkg, facts).update !== undefined)) return undefined;
  const chain = await gatherChainFacts(lookup);
  if (chain === undefined) return undefined;
  const shown = shownChoices(installChoicesOf(pkg, title, command, facts, chain), (step) => (step.pkg === pkg ? facts : chain.machine));
  return shown.length > 0 ? shown : undefined;
}

/** What an agent is called in a sentence: its row's title, else its name. */
export function agentTitleOf(info: ExecutorInfo): string {
  return EXECUTOR_TITLES[info.name] ?? info.name;
}

/** The built-in kinds that drive one agent's binary, and which. */
export const PACKAGE_OF_KIND: Partial<Record<ExecutorKind, string>> = { cli: "claude", codex: "codex" };

/**
 * The package JaiRA installs this executor from, when it is one it knows how to install. A built-in
 * kind names its own; a generic CLI is known by its PROGRAM, whatever it is called here — a CLI added
 * as `my-agent` running `opencode` is OpenCode, and installs and updates as it.
 */
export function agentPackageOf(info: ExecutorInfo): AgentPackage | undefined {
  const byKind = PACKAGE_OF_KIND[info.kind];
  if (byKind !== undefined) return AGENT_PACKAGES[byKind];
  if (info.kind !== "generic" || info.command === undefined) return undefined;
  const program = (info.command.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return Object.values(AGENT_PACKAGES).find((pkg) => pkg.binary === program);
}

/**
 * Install an agent the way named, or by the path chosen through its install menu (each step in turn:
 * Node.js, then npm's install of it), or — with neither — update it the way it was installed (a broken
 * one is reinstalled). Only a way the facts offer is run: the request names a way or a path, never a
 * command. Answers when the last installer exits, with where the binary is now.
 */
export async function installAgent(info: ExecutorInfo, request: AgentInstallRequest | AgentInstallMethod | undefined, options: InstallRunOptions, hooks: ChainRunHooks = {}): Promise<AgentInstallOutcome> {
  const pkg = agentPackageOf(info);
  if (pkg === undefined) return { ok: false, reason: `JaiRA does not know how to install ${info.name}` };
  const asked: AgentInstallRequest = typeof request === "string" ? { method: request } : (request ?? {});
  // An agent is the machine's: never installed into a workspace's container (decision 0027).
  const machine = onMachine(options);
  const command = info.command ?? pkg.binary;
  if (asked.choice !== undefined && asked.choice.length > 0) return runChoice(pkg, agentTitleOf(info), command, asked.choice, machine, hooks);
  return runInstall(pkg, command, asked.method, machine);
}
