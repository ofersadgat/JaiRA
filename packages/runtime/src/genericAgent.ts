/**
 * The `generic-cli` agent runtime (DESIGN §14 phase 7, §8.1, §16).
 *
 * A coding agent that is not Claude Code — opencode, codex, or anything else that
 * takes an instruction and writes to the workspace. Upstream's `claude-cli`
 * adapter cannot serve these: its argv (`--output-format stream-json`,
 * `--permission-prompt-tool`) and its stream parsing are Claude's protocol. What
 * *is* reusable is the normalized `AgentQuery` seam, so JaiRA supplies a query and
 * gets the same registry entry shape.
 *
 * **This runtime is policy-weak, and says so.** DESIGN §16: "generic-cli runners
 * start policy-weak by design." A generic binary offers no permission callback and
 * no reliable pre-approval flags, so nothing JaiRA does can gate the commands it
 * runs — its capabilities therefore declare `policyEnforcement: "none"`, which is
 * what makes §8.2's `gateCapabilities` refuse it under a policy that can require
 * approval. Declaring anything stronger would be the exact failure DESIGN §16
 * warns about: pretending uniformity.
 *
 * What it *does* get is JaiRA's own Exec layer, so a WSL project runs its agent
 * inside the distro (DESIGN §9.1) with no extra work here.
 */
import { runtimeFunction, type CapabilityRegistry, type RuntimeCapabilities } from "@declarative-ai/exec";
import {
  createClaudeCodeFunction,
  DELEGATED_CAPS,
  type AgentQuery,
  type AgentStreamMessage,
} from "@declarative-ai/agents-api";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import type { JairaGenericCliAgent } from "@jaira/shared";
import { NodeExec, type Exec } from "./exec";
import { pathFor, type ExecEnv } from "./paths";

/** The default registry name a single configured generic CLI is registered under. */
export const AGENT_GENERIC_CLI = "generic-cli";

/**
 * Honest capabilities for a generic binary.
 *
 * `policyEnforcement: "none"` is the load-bearing field: no callback reaches
 * `ctx.approve`, and there is no flag vocabulary to translate a deny list into, so
 * neither `callback` nor `config` would be true. `interactive: false` because a
 * generic CLI in a workflow has no channel to ask a human anything.
 */
export const GENERIC_CLI_CAPS: RuntimeCapabilities = {
  ...DELEGATED_CAPS,
  policyEnforcement: "none",
  interactive: false,
  streaming: false,
};

/** Where the prompt is substituted when the argv template does not name it. */
export const PROMPT_PLACEHOLDER = "{prompt}";

export interface GenericCliQueryOptions {
  /** Where to run (a WSL project runs its agent in the distro). */
  execEnv?: ExecEnv;
  /** The process seam. Tests inject a fake; production uses {@link NodeExec}. */
  exec?: Exec;
  /** Cap a runaway agent. Absent ⇒ no limit. */
  timeoutMs?: number;
}

/**
 * Build an `AgentQuery` that drives a generic CLI.
 *
 * The prompt reaches the binary one of two ways, because CLIs differ and guessing
 * would break one of them: as an argument (the `{prompt}` placeholder, or appended
 * after `--`), or on stdin. Rendering it into a shell string is never an option —
 * an instruction is workflow data, and Exec passes argv without a shell.
 */
export function createGenericCliQuery(spec: JairaGenericCliAgent, options: GenericCliQueryOptions = {}): AgentQuery {
  const exec = options.exec ?? new NodeExec();
  return async function* genericCliQuery(opts): AsyncIterable<AgentStreamMessage> {
    const template = spec.args ?? [];
    const usesPlaceholder = template.includes(PROMPT_PLACEHOLDER);
    const viaStdin = spec.prompt === "stdin";
    const args = usesPlaceholder
      ? template.map((arg) => (arg === PROMPT_PLACEHOLDER ? opts.prompt : arg))
      : viaStdin
        ? [...template]
        : // `--` first: an instruction beginning with `-` must not be read as a flag.
          [...template, "--", opts.prompt];

    let result;
    try {
      result = await exec.run(spec.command, args, {
        // The agent works in the task's worktree; a WSL run needs the distro's view.
        ...(opts.cwd !== undefined
          ? { cwd: options.execEnv !== undefined ? pathFor(options.execEnv, opts.cwd) : opts.cwd }
          : {}),
        ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        ...(viaStdin ? { stdin: opts.prompt } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
      });
    } catch (e) {
      // A failure to *start* — usually the binary is not installed.
      yield { type: "other", error: `'${spec.command}' could not be started: ${(e as Error).message}` };
      return;
    }

    if (result.aborted) {
      yield { type: "other", error: `'${spec.command}' was canceled` };
      return;
    }
    if (result.timedOut) {
      yield { type: "other", error: `'${spec.command}' timed out` };
      return;
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      yield { type: "other", error: `'${spec.command}' exited ${result.code}${detail ? `: ${detail}` : ""}` };
      return;
    }
    // No cost is reported: a generic CLI does not tell us what it spent, and
    // inventing a number would corrupt the run's roll-up.
    yield { type: "result", result: { text: result.stdout.trim() } };
  };
}

export interface GenericAgentOptions extends GenericCliQueryOptions {
  /** The configured generic agents (`config.agents.genericCli`). */
  agents?: readonly JairaGenericCliAgent[];
}

/**
 * Register every configured generic CLI as a `runtime` entry.
 *
 * Nothing is registered when nothing is configured, so a state naming
 * `generic-cli` in a project that never set one up fails with "unregistered
 * function" — the honest error — rather than silently running some default binary.
 */
export function registerGenericAgents(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: GenericAgentOptions = {},
): CapabilityRegistry<WorkflowMetrics> {
  for (const spec of options.agents ?? []) {
    const fn = createClaudeCodeFunction({
      capabilities: GENERIC_CLI_CAPS,
      query: createGenericCliQuery(spec, options),
    });
    registry.functions.set(
      spec.name ?? AGENT_GENERIC_CLI,
      runtimeFunction(fn.run as never, fn.capabilities) as never,
    );
  }
  return registry;
}
