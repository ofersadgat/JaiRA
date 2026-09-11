/**
 * Delegated agent runtimes (DESIGN §8, §8.1) — the `claude-code` adapters, split
 * by *invocation mechanism* upstream: `@declarative-ai/agents-api` reaches the
 * agent through its in-process SDK, `@declarative-ai/agents-cli` through a
 * subprocess. A workflow authored against one runs against the other; what differs
 * is how the safety policy is enforced (`callback` vs `config`), which is exactly
 * what DESIGN §8.2's capability gating reads.
 *
 * JaiRA's job here is small and worth keeping small: name the runtimes, pass the
 * execution environment through (a WSL project's agent must run inside the
 * distro), and let the engine supply `ctx.workspace` / `ctx.policy` /
 * `ctx.approve`. Everything about *how* an agent is driven belongs upstream.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runtimeFunction, type CapabilityRegistry, type RuntimeCapabilities } from "@declarative-ai/exec";
import { createClaudeCodeFunction, type AgentQuery, type ClaudeCodeFunctionOptions } from "@declarative-ai/agents-api";
import {
  createCliAgentFunction,
  createCodexAgentFunction,
  CODEX_CAPS,
  stderrTail,
  type CodexSandbox,
  type SpawnProcess,
  type StartMcpBridge,
} from "@declarative-ai/agents-cli";

// The persistent bridge, re-exported so the app and the CLI reach it through the runtime they already
// depend on rather than growing a dependency on the adapter package for one factory.
export { createMcpBridgeHost, type McpBridgeHost, type McpBridgeHostOptions, type StartMcpBridge } from "@declarative-ai/agents-cli";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { resolveInvocation, type ExecObserver } from "./exec";
import { detachedForTree, killTree } from "./killTree";
import type { ExecEnv } from "./paths";
import { claudeReplacements } from "./tools";

/** The registry names JaiRA registers its agents under. */
export const AGENT_SDK = "claude-code";
export const AGENT_CLI = "claude-cli";
/**
 * Codex (DESIGN §8.1). A separate NAME rather than a `generic-cli` entry because it
 * is a separate adapter: `generic-cli` enforces nothing and §8.2 refuses it under
 * any policy that can ask a human, where codex has a real up-front channel (its
 * sandbox) and therefore declares `policyEnforcement: "config"` — which passes.
 */
export const AGENT_CODEX = "codex-cli";

/**
 * Spawn a CLI agent through a seam JaiRA can watch, in the project's execution
 * environment (DESIGN §4.2a, §9.1).
 *
 * Two jobs upstream's default spawn cannot do:
 *
 *  - **Track the process.** An abandoned agent keeps billing, and it was recorded
 *    nowhere; the observer is what makes an orphan findable.
 *  - **Reach into WSL.** Every other child JaiRA starts is mapped by
 *    {@link resolveInvocation}, and an agent must be too. It used to be expressed
 *    as `command: "wsl.exe"` plus `args: ["-d", distro, "--", "claude"]` on the
 *    adapter — which is WRONG, and silently: an adapter builds
 *    `[command, ...its own flags, ...args]`, so `wsl.exe` was handed the agent's
 *    flags before its own arguments and `--cd` was never passed at all. Mapping the
 *    whole argv HERE is the same thing Exec does, in the one place that sees the
 *    finished command line.
 *
 * Three details are copied deliberately from upstream's version and must not be
 * "tidied":
 *
 *  - **stderr is piped and UNCONDITIONALLY drained.** It used to be `"ignore"`d, and the reason is
 *    still true and still load-bearing: an unread pipe fills at ~64 KB and the child then blocks
 *    forever on write, so stdout stops and `exit` never settles. It is piped now because an agent
 *    that fails prints why on stderr and JaiRA was throwing that away — but the drain below runs
 *    whether or not anybody is listening, because the deadlock does not care why the pipe is unread.
 *  - **an `error` listener is attached.** A `ChildProcess` `'error'` with no
 *    listener throws and would take the host process down — and ENOENT on a missing
 *    `claude` binary is the likeliest first-run outcome.
 *  - **stdin errors are swallowed.** An agent that answers before reading its whole
 *    prompt leaves an EPIPE on the pipe, which arrives as an unhandled `'error'`.
 */
export function agentSpawn(options: { execEnv?: ExecEnv; observer?: ExecObserver } = {}): SpawnProcess {
  return (argv, opts) => {
    const [agentCommand, ...agentArgs] = argv;
    const { file: command, argv: args, cwd } = resolveInvocation(agentCommand!, agentArgs, {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const child = spawn(command, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      // stdin is PIPED whenever the adapter may speak again, not only when it has a prompt to hand
      // over. That is what makes steering possible at all: a closed channel is why the only mid-run
      // signal this transport used to have was `kill()`.
      stdio: [opts.stdin === undefined && opts.keepInputOpen !== true ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group on POSIX, so `kill` below can reach the tools the agent spawns and not
      // just the agent. See `detachedForTree` for the trade this makes with terminal signals.
      ...detachedForTree,
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const observer = options.observer;

    let token: unknown;
    try {
      token = observer?.onSpawn({
        command,
        argv: args,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch (e) {
      token = undefined;
      report(observer, e, "spawn");
    }
    const observeExit = (code: number | null): void => {
      try {
        observer?.onExit(token, { code, signal: null });
      } catch (e) {
        // Bookkeeping must not change the agent's outcome — but it is no longer silent about it.
        report(observer, e, "exit");
      }
    };

    // THE DRAIN, and it is not optional. Attached unconditionally, before anything can await the
    // process: with `stdio[2]` piped and nobody reading, the child blocks at ~64 KB and never exits.
    // Forwarding to the observer is the point; consuming the bytes is the requirement.
    // The tail is kept as well as forwarded: the job store holds the whole stream for anyone who goes
    // looking, but the FAILURE REASON is what a reader sees first, and a CLI that died at startup
    // said why here and nowhere else (`AgentProcess.stderrTail`).
    const tail = stderrTail();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail.push(chunk);
      try {
        observer?.onOutput?.(token, { stream: "stderr", chunk });
      } catch (e) {
        report(observer, e, "output");
      }
    });
    // A stream that errors is still a stream nobody may leave unhandled.
    child.stderr?.on("error", () => undefined);

    let spawnError: Error | undefined;
    child.on("error", (e: Error) => {
      spawnError = e;
      lines.close();
    });

    child.stdin?.on("error", () => {});
    if (opts.stdin !== undefined) {
      // Written either way; only the CLOSE depends on whether the caller means to say more. Closing it
      // is what ENDS a stream-json session, so an adapter that wants to interrupt must keep it open
      // and close it itself.
      if (opts.keepInputOpen === true) child.stdin?.write(opts.stdin);
      else child.stdin?.end(opts.stdin);
    }

    return {
      lines,
      ...(child.stdin !== null
        ? {
            write: (line: string): void => void child.stdin?.write(line),
            endInput: (): void => void child.stdin?.end(),
          }
        : {}),
      // The WHOLE tree, not the child. `child.kill()` here killed the Chocolatey shim and left the
      // real `claude` running against the pipe it had inherited — the run was recorded as stopped
      // while the agent went on working and billing. See `killTree`.
      kill: () => killTree(child),
      // Both halves of "why did it fail", which this seam used to answer with `-1` and `1`
      // respectively: the launch error names a binary that could not start, the tail names what a
      // binary that did start said before it died.
      launchFailure: () => spawnError,
      stderrTail: () => tail.read(),
      exit: new Promise<number>((resolve) => {
        child.on("error", () => {
          observeExit(-1);
          resolve(-1);
        });
        child.on("close", (code) => {
          const value = spawnError ? -1 : (code ?? 0);
          observeExit(value);
          resolve(value);
        });
      }),
    };
  };
}

export interface AgentRuntimeOptions {
  /** Where the agent runs. A WSL project drives the CLI adapters inside the distro. */
  execEnv?: ExecEnv;
  /** Records the agent subprocess as a job, so an abandoned one is findable. */
  observer?: ExecObserver;
  /**
   * Replace the agent-query seam — the whole reason this is testable without an
   * SDK, a `claude` binary, or a network: a fake query drives the same adapter.
   */
  query?: AgentQuery;
  /** Which adapters to register. Default: all three. */
  adapters?: Array<"sdk" | "cli" | "codex">;
  /** Extra options forwarded to the SDK adapter (tool injection, native renames). */
  sdk?: Omit<ClaudeCodeFunctionOptions, "query">;
  /** Path to the CLI binary (default: `claude` on PATH). */
  cliCommand?: string;
  /**
   * Replace the process seam the CLI adapters spawn through.
   *
   * The counterpart of {@link AgentRuntimeOptions.query} one level down: a fake query replaces the
   * whole transport, where a fake spawn keeps the real argv-building and stream-parsing and only
   * stands in for the binary — which is the half worth testing for a CLI agent.
   */
  spawn?: SpawnProcess;
  /**
   * How a CLI agent's permission and tool bridge is stood up — a `createMcpBridgeHost().start` in
   * production, so every run registers on ONE listener on a worker thread instead of binding its
   * own on the main loop. Absent ⇒ upstream's per-run in-process bridge, which is fine for a process
   * whose loop is idle and was measured losing the CLI's handshake race in one that is not.
   */
  startBridge?: StartMcpBridge;
  /** Path to the codex binary (default: `codex` on PATH). */
  codexCommand?: string;
  /**
   * The sandbox a codex run gets when the state names no permission mode
   * (default `workspace-write`).
   *
   * Worth setting to `read-only` for a project whose codex states only review:
   * it is codex's ONLY up-front enforcement channel, so it is what the honest
   * `policyEnforcement: "config"` rests on.
   */
  codexSandbox?: CodexSandbox;
}

/**
 * Register the delegated agent runtimes on a capability registry.
 *
 * A state reaches one with `operation: { kind: "function", function: "claude-code",
 * config: { … } }`; its `prompt` input is the instruction, and the authored
 * `config` is the runtime surface.
 */
export function registerAgentRuntimes(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: AgentRuntimeOptions = {},
): CapabilityRegistry<WorkflowMetrics> {
  const adapters = options.adapters ?? ["sdk", "cli", "codex"];
  // Injecting a tool without DISPLACING the agent's own is a second set of tools the model ignores.
  // Observed on a live run: with `read_file` injected and `Read` still available, the agent reached
  // for `Read` every time — its system prompt steers it there. So a declared tool of ours takes the
  // built-in's place, which is what makes "JaiRA's implementation" mean anything at all; the tools
  // NOT declared are untouched, and that is how "the agent's own" stays expressible.
  const sdkOptions: Omit<ClaudeCodeFunctionOptions, "query"> = {
    replacesNative: claudeReplacements(),
    ...options.sdk,
  };

  if (adapters.includes("sdk")) {
    const sdk = createClaudeCodeFunction({
      ...sdkOptions,
      ...(options.query !== undefined ? { query: options.query } : {}),
    });
    registry.functions.set(
      AGENT_SDK,
      runtimeFunction(sdk.run as never, sdk.capabilities) as never,
    );
  }

  // Both CLI adapters get JaiRA's spawn: it is what maps the argv into the project's
  // execution environment (a WSL project runs its agent in the distro) and what
  // records the process as a job. Supplied ALWAYS, not just when an observer is
  // wired — upstream's default cannot reach WSL, and a silently-native agent in a
  // WSL project is the kind of wrong that looks like it works until paths differ.
  const spawn =
    options.spawn ??
    agentSpawn({
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(options.observer !== undefined ? { observer: options.observer } : {}),
    });

  if (adapters.includes("cli")) {
    const cli =
      options.query !== undefined
        ? // A supplied query replaces the subprocess entirely, so the CLI adapter
          // becomes the SDK adapter with a different name — which is what makes the
          // registration path testable without a `claude` binary.
          createClaudeCodeFunction({ ...sdkOptions, query: options.query })
        : createCliAgentFunction({
            ...options.sdk,
            ...(options.cliCommand !== undefined ? { command: options.cliCommand } : {}),
            ...(options.startBridge !== undefined ? { startBridge: options.startBridge } : {}),
            spawn,
          });
    registry.functions.set(
      AGENT_CLI,
      runtimeFunction(cli.run as never, cli.capabilities) as never,
    );
  }

  if (adapters.includes("codex")) {
    // Registered whether or not the binary is present, exactly as `claude-cli` is: a
    // state that names it fails with codex's own "could not be started", which says
    // more than "unregistered function" would.
    const codex =
      options.query !== undefined
        ? createClaudeCodeFunction({ ...sdkOptions, capabilities: CODEX_CAPS, approvalCallback: false, query: options.query })
        : createCodexAgentFunction({
            ...options.sdk,
            ...(options.codexCommand !== undefined ? { command: options.codexCommand } : {}),
            ...(options.codexSandbox !== undefined ? { sandbox: options.codexSandbox } : {}),
            ...(options.startBridge !== undefined ? { startBridge: options.startBridge } : {}),
            spawn,
          });
    registry.functions.set(
      AGENT_CODEX,
      runtimeFunction(codex.run as never, codex.capabilities) as never,
    );
  }

  return registry;
}

// --- Capability gating (DESIGN §8.2) -----------------------------------------

export interface GateIssue {
  stateId: string;
  functionRef: string;
  message: string;
}

export interface GateOptions {
  /** True when the project's policy can escalate a call to a human. */
  policyNeedsApproval?: boolean;
  /** True when no UI can answer an approval (a headless run). */
  unattended?: boolean;
}

function capabilitiesOf(
  registry: CapabilityRegistry<WorkflowMetrics>,
  name: string,
): RuntimeCapabilities | undefined {
  const entry = registry.functions.get(name);
  if (!entry || entry.kind !== "runtime") return undefined;
  return entry.capabilities as RuntimeCapabilities;
}

/**
 * The function a state's operation dispatches to, from either state shape.
 *
 * The authored form spells it `function` and the loaded form `functionRef`, and
 * callers naturally reach for `bundle.source` (it is what a snapshot stores).
 * Reading only `functionRef` made this whole gate a silent no-op against authored
 * states — a check that never fires is worse than no check, because it reads as
 * one that passed.
 */
function functionRefOf(def: { operation?: { kind?: string; functionRef?: unknown; function?: unknown } }): string | undefined {
  const op = def.operation;
  if (op?.kind !== "function") return undefined;
  if (typeof op.functionRef === "string") return op.functionRef;
  return typeof op.function === "string" ? op.function : undefined;
}

/**
 * Cross-check each state's chosen runtime against what it actually supports
 * (DESIGN §8.2): "violations block the task with a clear error rather than
 * degrading silently".
 *
 * The check that matters: a policy which can require approval is meaningless
 * against an adapter that enforces nothing, so that combination is refused rather
 * than quietly running unguarded.
 */
export function gateCapabilities(
  registry: CapabilityRegistry<WorkflowMetrics>,
  states: Record<string, { operation?: { kind?: string; functionRef?: unknown; function?: unknown } }>,
  options: GateOptions = {},
): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const [stateId, def] of Object.entries(states)) {
    const functionRef = functionRefOf(def);
    if (functionRef === undefined) continue;
    const caps = capabilitiesOf(registry, functionRef);
    if (caps === undefined) continue; // a host function or an unregistered ref — not this check's business

    if (options.policyNeedsApproval === true && caps.policyEnforcement === "none") {
      issues.push({
        stateId,
        functionRef,
        message: `'${functionRef}' enforces no policy (policyEnforcement: "none"), but this project's policy can require approval — refusing rather than running it unguarded`,
      });
    }
    if (options.unattended === true && caps.policyEnforcement === "callback" && options.policyNeedsApproval === true) {
      issues.push({
        stateId,
        functionRef,
        message: `'${functionRef}' will escalate tool calls to a human, but this run has no interactive surface to answer them`,
      });
    }
  }
  return issues;
}

/** Report an observer's own failure, never rethrowing — the agent's outcome is not its business. */
function report(observer: ExecObserver | undefined, error: unknown, phase: "spawn" | "exit" | "output"): void {
  try {
    observer?.onError?.(error instanceof Error ? error : new Error(String(error)), phase);
  } catch {
    // An error channel that throws has nowhere left to go.
  }
}
