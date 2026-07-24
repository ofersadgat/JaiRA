/**
 * The live human-in-the-loop seam (DESIGN §7.1, SPEC §11.4).
 *
 * An interactive state is an ordinary `FunctionOp` whose function is registered
 * as `interactive`. This hub registers such functions and, instead of answering
 * from a script, parks the call and emits a request for a UI to answer. The
 * Electron main process forwards those requests to the renderer over IPC and
 * feeds answers back through {@link InteractionHub.submit}.
 *
 * Why this preserves the approval-gate guarantee: the registry is supplied by
 * the caller (the main process), and nothing running *inside* a workflow can
 * reach it or this hub. An answer can only arrive through `submit`, which only
 * the IPC layer calls — so an agent cannot fabricate a human decision.
 */
import {
  failureOf,
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type JsonValue,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { INTERACTIVE } from "./scriptedFunctions";

export interface HubRequest {
  requestId: string;
  /** The registered function name — the UI component to render. */
  component: string;
  inputs: Record<string, JsonValue>;
}

type Pending = {
  request: HubRequest;
  resolve: (result: FunctionResult<ResolvedValue, WorkflowMetrics>) => void;
};

export interface InteractionHubOptions {
  /** Called when a state parks awaiting a human. */
  onRequest?: (request: HubRequest) => void;
  /** Called when a parked request is answered, canceled, or rejected. */
  onResolved?: (requestId: string) => void;
  /** Request id generator — injectable so tests are deterministic. */
  nextId?: () => string;
}

export class InteractionHub {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly options: InteractionHubOptions = {}) {}

  /** Requests currently awaiting an answer, oldest first. */
  list(): HubRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Register `name` as an interactive function backed by this hub. Every call
   * parks until `submit`/`reject` names its request id.
   */
  register(registry: CapabilityRegistry<WorkflowMetrics>, name: string): this {
    registry.functions.set(
      name,
      hostFunction(async (inputs: FunctionInputs) => this.park(name, inputs), INTERACTIVE),
    );
    return this;
  }

  private park(component: string, inputs: FunctionInputs): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    const requestId = this.options.nextId?.() ?? `ui-${++this.counter}`;
    const request: HubRequest = { requestId, component, inputs: inputs as Record<string, JsonValue> };
    return new Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>((resolve) => {
      this.pending.set(requestId, { request, resolve });
      this.options.onRequest?.(request);
    });
  }

  /** Answer a parked request. Returns false when the id is unknown (or already answered). */
  submit(requestId: string, value: JsonValue): boolean {
    return this.settle(requestId, { value });
  }

  /** Fail a parked request — a declined gate, as DATA (the engine's contract). */
  reject(requestId: string, reason: string): boolean {
    return this.settle(requestId, { error: failureOf(new Error(reason)) });
  }

  /**
   * Fail every parked request — used when a run is canceled or the window
   * closes, so a workflow never hangs on a gate nobody can answer any more.
   */
  rejectAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) this.reject(requestId, reason);
  }

  private settle(requestId: string, result: FunctionResult<ResolvedValue, WorkflowMetrics>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(result);
    this.options.onResolved?.(requestId);
    return true;
  }
}
