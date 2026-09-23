/**
 * What an agent call's outcome says about the AGENT — not about the workflow that called it.
 *
 * One failure is a fact about the executor rather than the work: a refused sign-in. Every call through
 * that agent fails the same way until a person signs it in again, so the host wants to hear about it
 * (to mark the agent unusable, and stop routing to it by default) and the person reading the failure
 * wants the one command that fixes it. Both are decided here, from the failure's own `code` — never
 * from its prose.
 *
 * The free health check cannot catch this case: `claude auth status` reads the stored sign-in and
 * does not ask the server, so an expired, unrenewable token reads as signed in until a call is refused.
 */
import type { Executor, ExecHandle, ExecServices } from "@declarative-ai/exec";
import type { Failure } from "@declarative-ai/json";

/** The code an agent gives when its sign-in (or key) was refused — the SDK's own vocabulary. */
export const SIGN_IN_REFUSED = "authentication_failed";

/** The default binary and the arguments that sign it in and out, per agent that signs itself in. */
export const SIGN_IN_COMMANDS: Readonly<Record<string, { command: string; login: readonly string[]; logout: readonly string[] }>> = {
  "claude-cli": { command: "claude", login: ["auth", "login"], logout: ["auth", "logout"] },
  "codex-cli": { command: "codex", login: ["login"], logout: ["logout"] },
};

/** `claude auth login`, with the binary this project actually runs; undefined for an agent with no sign-in. */
export function signInCommand(agent: string, command?: string): string | undefined {
  const known = SIGN_IN_COMMANDS[agent];
  return known === undefined ? undefined : [command ?? known.command, ...known.login].join(" ");
}

/** Hear every agent call's outcome: the failure, or `undefined` for a call that succeeded. */
export type AgentOutcomeObserver = (agent: string, error: Failure | undefined) => void;

/** Was this failure the agent's sign-in being refused? */
export function isSignInRefused(error: Failure | undefined): boolean {
  return error?.code === SIGN_IN_REFUSED;
}

/**
 * The failure with the fix appended, when it is a refused sign-in of an agent that signs itself in.
 * Anything else is returned untouched.
 */
export function withSignInFix(agent: string, error: Failure, command?: string): Failure {
  if (!isSignInRefused(error)) return error;
  const fix = signInCommand(agent, command);
  return fix === undefined ? error : { ...error, reason: `${error.reason} — run '${fix}' in a terminal to sign in again` };
}

/**
 * Read one settled result: fix its failure's wording, and tell the observer.
 *
 * A cancelled or interrupted call says nothing about the agent — someone stopped it — so it is passed
 * through unreported.
 */
function settle<R extends { error?: Failure } | object>(agent: string, result: R, observe: AgentOutcomeObserver | undefined, command?: string): R {
  const error = (result as { error?: Failure }).error;
  if (error?.classification === "canceled" || error?.classification === "interrupted") return result;
  try {
    observe?.(agent, error);
  } catch {
    // An observer is bookkeeping; it must never change what the call returned.
  }
  return error === undefined ? result : ({ ...result, error: withSignInFix(agent, error, command) } as R);
}

/** A function entry's `run`, observed. */
export function observeAgentRun<F extends (inputs: never, ctx: never) => Promise<unknown>>(
  agent: string,
  run: F,
  observe: AgentOutcomeObserver | undefined,
  command?: string,
): F {
  return (async (inputs: never, ctx: never) => settle(agent, (await run(inputs, ctx)) as object, observe, command)) as F;
}

/** A prompt route, observed: the same executor, whose handles settle through {@link settle}. */
export function observeAgentRoute<E extends Executor<ExecServices, any>>(
  agent: string,
  inner: E,
  observe: AgentOutcomeObserver | undefined,
  command?: string,
): E {
  return {
    capabilities: inner.capabilities,
    metrics: inner.metrics,
    ...(inner.capabilitiesFor !== undefined ? { capabilitiesFor: (op: Parameters<NonNullable<E["capabilitiesFor"]>>[0]) => inner.capabilitiesFor!(op) } : {}),
    start: (op: Parameters<E["start"]>[0], ctx: ExecServices) => {
      const handle = inner.start(op, ctx) as ExecHandle<unknown, any>;
      return {
        events: handle.events,
        result: handle.result.then((result) => settle(agent, result, observe, command)),
        cancel: () => handle.cancel(),
        // A getter, not a copy: `control` follows the CURRENT inner attempt (see ExecHandle).
        get control() {
          return handle.control;
        },
      };
    },
  } as unknown as E;
}
