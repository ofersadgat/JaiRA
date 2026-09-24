/**
 * How the app refreshes an account's allowance without spending a turn (usage-readings contract,
 * "a manual refresh is something an executor's session layer offers the board").
 *
 * claude — ask a claude process started for nothing else (`get_usage`). Which binary matters: the
 * Agent SDK's bundled claude answers it, an older installed claude refuses the subtype (MEASURED
 * 2026-09-24: 2.1.223 answers, 2.1.142 refuses). So the candidates are tried in order — the SDK's own
 * binary when it can be found, then the configured command — and the first that answers wins; when
 * none does, the last reason is kept so a person can be told why the number is missing.
 *
 * codex — re-read the newest `token_count` in codex's own session files. It only helps if some codex
 * session ran since the last reading, and the reading's own `at` says how old it is.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { probeClaudeUsage, readCodexLimits } from "@declarative-ai/agents-cli";
import type { LimitReading } from "@declarative-ai/exec";
import { defaultResolve } from "./executors";

/** The SDK's bundled claude for this platform, when it can be found; `undefined` otherwise. */
export function sdkClaudeBinary(resolve: (id: string) => string = defaultResolve): string | undefined {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const tries: Array<() => string> = [
    () => resolve(pkg),
    // Beside the SDK the upstream agents package resolves — where a linked checkout keeps it.
    () => createRequire(resolve("@declarative-ai/agents-api")).resolve(pkg),
  ];
  for (const attempt of tries) {
    try {
      const path = join(dirname(attempt()), exe);
      if (existsSync(path)) return path;
    } catch {
      // not there — the next place, or none
    }
  }
  return undefined;
}

/** What a claude refresh came to: the reading, or why there is none. */
export interface ClaudeRefreshOutcome {
  reading?: LimitReading;
  unavailable?: string;
}

/**
 * Ask each candidate binary in turn; the first reading wins. An "Unsupported control request" from an
 * older claude is explained in words a person can act on.
 */
export async function refreshClaudeLimits(commands: readonly string[], signal?: AbortSignal): Promise<ClaudeRefreshOutcome> {
  let unavailable: string | undefined;
  for (const command of commands) {
    const answer = await probeClaudeUsage({ command, route: "claude-cli", ...(signal !== undefined ? { signal } : {}) });
    if (answer.reading !== undefined) return { reading: answer.reading };
    unavailable = answer.unavailable?.includes("Unsupported control request")
      ? "this version of claude cannot report usage — update claude to see how much is left"
      : answer.unavailable;
  }
  return unavailable !== undefined ? { unavailable } : {};
}

/** The claude binaries to ask, most capable first. */
export function claudeUsageCommands(configured: string | undefined, resolve?: (id: string) => string): string[] {
  const sdk = sdkClaudeBinary(resolve);
  return [...(sdk !== undefined ? [sdk] : []), configured ?? "claude"];
}

/** codex's refresh: the newest reading any codex session on this machine wrote. */
export function refreshCodexLimits(): Promise<LimitReading | undefined> {
  return readCodexLimits({ route: "codex-cli" });
}
