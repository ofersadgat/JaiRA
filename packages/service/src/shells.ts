/**
 * The engine's side of the agent's shell (decision 0030): which agent's setting a call answers to, and
 * the idle rule that closes a live shell nobody is using.
 */
import type { JairaAgentConfig } from "@jaira/shared";

/** How often the idle rule looks at the live shells. */
export const SHELL_REAP_EVERY_MS = 60_000;
/** How long a live shell's processes must have used no CPU before it may be closed. */
export const SHELL_IDLE_MS = 5 * 60_000;

/**
 * The `shell` setting of the agent making a call, by the name its route wrapper gives it: the two
 * Claude runtimes and codex by their blocks, a generic CLI by its entry's name. An API route, or a call
 * no agent wrapper saw, has none: the emulated shell.
 */
export function agentShellSetting(agents: JairaAgentConfig, agent: string | undefined): string | undefined {
  if (agent === undefined) return undefined;
  if (agent === "claude-code") return agents.claudeCode?.shell;
  if (agent === "claude-cli") return agents.claudeCli?.shell;
  if (agent === "codex-cli") return agents.codex?.shell;
  return agents.genericCli?.find((entry) => (entry.name ?? "generic-cli") === agent)?.shell;
}

/**
 * Whether a live shell is closed now, and the words its agent is told why (ruling 5): only when nothing
 * runs in its task, it has used no CPU for {@link SHELL_IDLE_MS}, and nothing it started listens on a
 * port. A port that cannot be checked (`listens` undefined) keeps the shell: the rule closes only what
 * it can see is idle.
 */
export function idleShellVerdict(at: { running: boolean; quietSince: number; now: number; listens: boolean | undefined }): string | undefined {
  if (at.running || at.listens !== false) return undefined;
  if (at.now - at.quietSince < SHELL_IDLE_MS) return undefined;
  return "was closed after 5 minutes with nothing running in it, nothing listening and nothing using the CPU";
}
