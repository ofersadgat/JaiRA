/**
 * Scripted interactive host functions for headless runs (mirrors declarative-ai's
 * test `ScriptedFunction`).
 *
 * Since the ops redesign there is no `InteractionPort`: an interactive UI state
 * is an ordinary `FunctionOp` whose `function` names an entry in
 * `registry.functions`, marked `interactive` by its capabilities. Scripting a
 * human gate headlessly therefore means registering a function that returns
 * canned answers — which is what this does.
 *
 * Responses are FIFO queues keyed by FUNCTION NAME (the state's
 * `operation.function`, e.g. `choose_option`), supplied as JSON:
 * `{"choose_option": [{"decision": "approve"}]}`. A `"*"` key answers any
 * function that has no queue of its own.
 */
import {
  failureOf,
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type HostCapabilities,
  type JsonValue,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";

/** A human gate: interactive, side-effect-free, and never memoized (the answer
 *  is a fresh human decision, not a cacheable computation). */
export const INTERACTIVE: HostCapabilities = { interactive: true, readOnly: true, memoizable: false };

/** Wildcard key: answers any function with no queue of its own. */
export const ANY_FUNCTION = "*";

export interface ScriptedCall {
  function: string;
  inputs: FunctionInputs;
}

export function parseInteractionScript(raw: unknown): Record<string, JsonValue[]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("interaction script must be a JSON object of functionName → response array");
  }
  const script: Record<string, JsonValue[]> = {};
  for (const [name, responses] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(responses)) {
      throw new Error(`interaction script for '${name}' must be an array of responses`);
    }
    script[name] = [...(responses as JsonValue[])];
  }
  return script;
}

export class ScriptedFunctions {
  readonly calls: ScriptedCall[] = [];

  constructor(private readonly responses: Record<string, JsonValue[]>) {}

  /** The function names this script can answer (excluding the wildcard). */
  names(): string[] {
    return Object.keys(this.responses).filter((n) => n !== ANY_FUNCTION);
  }

  /**
   * Register one interactive host function per scripted name. Errors come back
   * as DATA (a classified `Failure`), not exceptions, so an exhausted queue
   * degrades the state per SPEC §3.3 instead of escaping the engine.
   */
  register(registry: CapabilityRegistry<WorkflowMetrics>): this {
    for (const name of this.names()) {
      registry.functions.set(name, hostFunction(this.impl(name), INTERACTIVE));
    }
    return this;
  }

  /** Register a fallback under `name` when the script only supplies `"*"`. */
  registerWildcard(registry: CapabilityRegistry<WorkflowMetrics>, name: string): this {
    if (this.responses[ANY_FUNCTION] !== undefined && !registry.functions.has(name)) {
      registry.functions.set(name, hostFunction(this.impl(name), INTERACTIVE));
    }
    return this;
  }

  private impl(name: string): (inputs: FunctionInputs) => Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    return async (inputs: FunctionInputs) => {
      this.calls.push({ function: name, inputs });
      const queue = this.responses[name] ?? this.responses[ANY_FUNCTION];
      if (queue === undefined) {
        return { error: failureOf(new Error(`no scripted response for interactive function '${name}'`)) };
      }
      const next = queue.shift();
      if (next === undefined) {
        return { error: failureOf(new Error(`scripted responses for '${name}' exhausted`)) };
      }
      return { value: next };
    };
  }
}
