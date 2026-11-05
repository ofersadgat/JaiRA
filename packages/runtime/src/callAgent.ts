/**
 * Which agent one call is made by (decision 0023 ruling 19).
 *
 * `$AGENT_WORKSPACE` on a line is the folder the agent keeps for itself — Claude Code's is not Codex's —
 * and the gate and the narrowing are built before the call's route is known, and are asked about a call
 * by its standard name, which says nothing of whose it is. So the agent's wrapper notes its declaration
 * against the call's input as it hands the call on ({@link noteCallAgent}), and whoever resolves the
 * line's places finds it there ({@link callAgentOf}), as a shell line's dialect is found
 * (`callDialect.ts`).
 */
import type { AgentToolDeclaration } from "@jaira/shared";

const AGENTS = new WeakMap<object, AgentToolDeclaration>();

/** Note the agent a call is made by, against the call's own input. */
export function noteCallAgent(input: unknown, agent: AgentToolDeclaration): void {
  if (input !== null && typeof input === "object") AGENTS.set(input, agent);
}

/** The agent a call is made by, or `undefined` for one no agent's wrapper handed on — JaiRA's own. */
export function callAgentOf(input: unknown): AgentToolDeclaration | undefined {
  return input !== null && typeof input === "object" ? AGENTS.get(input) : undefined;
}
