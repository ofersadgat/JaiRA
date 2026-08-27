/**
 * `on_user_event(...)` — a transition that waits for a person to do something (WORKFLOWS.md §7.4).
 *
 * The third human-in-the-loop seam, and the one that is not a QUESTION. {@link InteractionHub} parks
 * a state's whole operation on a form somebody fills in; {@link QuestionHub} parks an agent's turn on
 * a question somebody answers. This parks a TRANSITION on something somebody does to the board — and
 * the difference matters, because the answer is not typed into a dialog that has taken over the
 * screen. It is the ordinary gesture the UI already offers: dragging a card into another column.
 *
 * ## Why it is a call in a guard, and not a state
 *
 * "Wait for a drag" could have been a state whose operation blocks. It must not be, for the same
 * reason a gate that only ever says yes is not a gate: a state that waits is a place a task SITS,
 * and the task is already sitting somewhere — in the column the board draws for the state it is
 * actually in. Writing the wait as a guard leaves the task where it is and says what would move it:
 *
 * ```jsonc
 * { "to": "in_review", "when": ".inputs.severity > 2 && on_user_event('task_drag')" }
 * ```
 *
 * ## One declaration, not two
 *
 * The slots below sit on the ENTRY this module registers, which is what SPEC §7.5 unified: a callee
 * is an operation, and a registry entry declares its own parameters rather than a host writing a
 * document to restate the ones its code already has. JaiRA shipped such a document until the option
 * carrying it was removed upstream — and because a guard whose call does not resolve is DROPPED
 * rather than reported, every `on_user_event` rule in every workflow silently stopped being offered.
 * Deriving the loader's view from this registration ({@link hostCalleeSignatures}) is what makes that
 * unrepeatable: there is no second place to forget.
 *
 * ## What the UI reads
 *
 * {@link UserEventHub.list} is the whole answer to "which cards can be dragged, and where to". A
 * request exists only when the engine actually reached the call, which means every condition ahead of
 * it in the guard was true — so the preconditions are honoured by construction rather than
 * re-evaluated in the renderer against a second copy of the expression language.
 *
 * ## Unattended runs answer `false`
 *
 * With nobody listening — a CLI run, a scheduled one — parking would hang a workflow on a gesture no
 * one can make. `false` is the honest answer there ("the user did not do it"), and it lets the
 * transitions after the wait have their turn, which is what an author's fallback rule is for.
 */
import {
  hostFunction,
  newCapabilityRegistry,
  type CapabilityRegistry,
  type EntrySignature,
  type FunctionInputs,
  type FunctionResult,
  type HostCapabilities,
  type InlineFamily,
  type JsonValue,
  type ResolvedValue,
  type Signature,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";

import { ON_USER_EVENT, type UserEventRequest } from "@jaira/shared";

// The vocabulary lives in `@jaira/shared` — persistence hands the document to the loader, the
// renderer matches a drop against a pending wait, and neither may depend on this package. Re-exported
// so a caller wiring the hub does not have to know that.
export { ON_USER_EVENT, TASK_DRAG, type TaskDragOptions, type UserEventRequest } from "@jaira/shared";

/**
 * A wait, not a computation: `deferred` is what makes the engine START the call and read it in a
 * later round rather than awaiting it inside the one that needed it (`HostCapabilities.deferred`).
 *
 * `memoizable: false` because what comes back is an event. Two evaluations of the same guard are not
 * two requests — the engine's own in-flight map sees to that — but a run that comes back to this
 * state later is asking again, and a memo would answer it with the last person's gesture.
 */
/**
 * What `on_user_event(...)` TAKES, as the entry's own declaration.
 *
 * A call in an expression binds its positional arguments against the callee's declared `input`
 * slots, so registering an implementation is only half of making `on_user_event('task_drag')` mean
 * anything. This is the other half, and it lives HERE — on the entry, beside the implementation and
 * the capabilities — rather than in a document a host writes to restate parameters its code already
 * had.
 *
 * That restatement is what SPEC §7.5 removed: "a registry entry declares them directly now, so the
 * three body forms sit beside a fourth source of a callee — the registry, a contributor on the path
 * like any directory — under one rule rather than beside an exception to it." JaiRA shipped an
 * operation DOCUMENT through `LoadBundleOptions.documents` until then. The option is gone; so is the
 * document; the shape is unchanged.
 *
 * A project that wants something else under this name still gets it — the search path is consulted
 * before the registry, so `functions/on_user_event.json` shadows this.
 */
export const USER_EVENT_SIGNATURE: Signature<InlineFamily> = {
  input: {
    /** WHICH event. It also decides what `options` may hold — see {@link TaskDragOptions}. */
    event: { kind: "text", index: 0, schema: { type: "string" } },
    /**
     * The options bag, typed open rather than as the union of every event's options: the events are a
     * growing set, and a closed schema would make adding one a change here as well as to the code
     * that serves it.
     *
     * **Optional, and that is load-bearing.** `on_user_event('task_drag')` with no bag at all is the
     * documented common case — the destination comes from the rule's own `to` — so a required slot
     * here refuses the call every workflow actually writes. It went unnoticed while the signature
     * lived in a document nothing checked calls against; declaring it on the entry is what made the
     * checker able to see it, and the first thing the checker saw was this.
     */
    options: { kind: "json", index: 1, optional: true, schema: { type: "object" } },
    /**
     * WHICH RULE this call is part of — filled by the loader (hw's `TRANSITION_INPUT`), never
     * positional, and never something an author types.
     *
     * It is what lets `on_user_event('task_drag')` with no options at all mean "drag it where this
     * rule goes": the destination is already written on the transition, and making the author repeat
     * it in the options would create two places for it to say two different things.
     *
     * Optional because an AUTHOR never fills it and the loader only fills it for a call that sits on
     * a transition. A call from anywhere else — an output binding, say — has no rule to take it from.
     */
    transition: { kind: "json", optional: true, schema: { type: "object", properties: { to: { type: "string" } } } },
  },
  output: { name: "happened", kind: "json", schema: { type: "boolean" } },
};

export const USER_EVENT_CAPABILITIES: HostCapabilities = {
  interactive: true,
  readOnly: true,
  memoizable: false,
  deferred: true,
};

/**
 * The options this call is waiting on, with what the author left out filled in from the rule.
 *
 * The one defaulting rule, applied HERE rather than in the UI: a request is what the UI reads, and a
 * request whose destination is implicit would make every reader of it re-derive the same default —
 * which is how two readers come to disagree.
 */
function optionsOf(inputs: FunctionInputs): Record<string, JsonValue> {
  const options = asRecord(inputs.options);
  if (options.to_state === undefined) {
    const to = asRecord(inputs.transition).to;
    // `terminate.*` is a rule that ends the run rather than one that moves the task, so there is no
    // column to drop on and none is claimed. The wait is still real — it just cannot be satisfied by
    // a drag, which is an authoring mistake the board shows by offering nothing.
    if (typeof to === "string" && !to.startsWith("terminate.")) options.to_state = to;
  }
  return options;
}

function asRecord(v: unknown): Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? ({ ...v } as Record<string, JsonValue>) : {};
}

export interface UserEventHubOptions {
  /**
   * Called when a transition starts waiting. ABSENT MEANS UNATTENDED — every call answers `false`
   * immediately rather than parking on a gesture nobody can make.
   */
  onRequest?: (request: UserEventRequest) => void;
  /** Called when a wait ends, however it ends. */
  onResolved?: (requestId: string) => void;
  nextId?: () => string;
  now?: () => number;
}

interface Pending {
  request: UserEventRequest;
  /** Settle the call. Returns false if it had already settled — a timer racing a drop. */
  settle: (happened: boolean) => boolean;
}

export class UserEventHub {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly options: UserEventHubOptions = {}) {}

  /** Everything currently waiting, oldest first — the whole of what the board needs. */
  list(): UserEventRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** The waits of one event type, for one task when named. */
  matching(event: string, taskId?: string): UserEventRequest[] {
    return this.list().filter((r) => r.event === event && (taskId === undefined || r.taskId === taskId));
  }

  /**
   * Register `on_user_event` for one run.
   *
   * `taskId` is stamped on every request the registration parks, exactly as {@link InteractionHub}
   * does it: a registry is built per run, so the run is known here and never has to be guessed from
   * whichever one happens to be first in a map.
   */
  register(registry: CapabilityRegistry<WorkflowMetrics>, taskId?: string): this {
    registry.functions.set(
      ON_USER_EVENT,
      hostFunction(
        async (inputs: FunctionInputs, ctx: { abortSignal?: AbortSignal }) => this.park(inputs, taskId, ctx?.abortSignal),
        USER_EVENT_CAPABILITIES,
        // The slots the loader bound this call's arguments against, on the entry the engine
        // dispatches. One object, so a change to what the call takes cannot reach one and miss the
        // other.
        { signature: USER_EVENT_SIGNATURE },
      ),
    );
    return this;
  }

  private park(
    inputs: FunctionInputs,
    taskId: string | undefined,
    abortSignal?: AbortSignal,
  ): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    if (this.options.onRequest === undefined) return Promise.resolve({ value: false as ResolvedValue });

    const event = String(inputs.event ?? "");
    const options = optionsOf(inputs);
    const requestId = this.options.nextId?.() ?? `event-${++this.counter}`;
    const request: UserEventRequest = {
      requestId,
      event,
      options,
      ...(taskId !== undefined ? { taskId } : {}),
      at: this.options.now?.() ?? Date.now(),
    };

    return new Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>((resolve) => {
      const timeout = typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /**
       * The ENGINE cancelling the call — the state terminated, or a sequence reset superseded it.
       * The offer is withdrawn from the UI and the promise is left to the executor's own
       * cancellation, which has already settled the call by the time this fires.
       *
       * Named, `once`, and REMOVED when the wait ends any other way. It used to be an anonymous
       * listener that was neither, on a signal that lives as long as the RUN — so every wait that
       * was delivered, declined or timed out left its listener behind, and a workflow that parks
       * once per loop iteration accumulated one per pass. Node says so at eleven
       * (`MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]`) and then stops
       * mentioning it, which is the part that makes this worth fixing rather than silencing.
       */
      const onAbort = (): void => {
        if (!this.pending.delete(requestId)) return;
        if (timer !== undefined) clearTimeout(timer);
        this.options.onResolved?.(requestId);
      };
      const settle = (happened: boolean): boolean => {
        if (!this.pending.delete(requestId)) return false;
        if (timer !== undefined) clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve({ value: happened as ResolvedValue });
        this.options.onResolved?.(requestId);
        return true;
      };
      if (timeout !== undefined) {
        timer = setTimeout(() => settle(false), timeout * 1000);
        // A workflow's own timer must not be what keeps the process alive; a run that is over should
        // be able to exit with an unfired wait still on the clock.
        timer.unref?.();
      }
      this.pending.set(requestId, { request, settle });
      this.options.onRequest?.(request);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      // An ALREADY-cancelled signal fires no event — `addEventListener` on an aborted signal is
      // silent, which is why `exec.ts` asks the same question. Without this the wait would be
      // offered on a run that is already over and would sit in `pending` until the window closed.
      // After the registration above so the two orders behave identically.
      if (abortSignal?.aborted === true) onAbort();
    });
  }

  /**
   * The event happened — the person did the thing this wait was offering.
   *
   * Returns false for an unknown or already-settled id, which is not an error: a drop can land on a
   * card whose run moved on while it was being dragged, and the honest answer is that there was
   * nothing there to answer.
   */
  deliver(requestId: string): boolean {
    return this.pending.get(requestId)?.settle(true) ?? false;
  }

  /** The event did NOT happen — the rules behind this one get their turn. */
  decline(requestId: string): boolean {
    return this.pending.get(requestId)?.settle(false) ?? false;
  }

  /** Withdraw every wait — a closing window, a cancelled run. */
  declineAll(): void {
    for (const requestId of [...this.pending.keys()]) this.decline(requestId);
  }
}

/**
 * The host callees a workflow may CALL BY NAME from an expression, with the slots each takes.
 *
 * What the LOADER needs, and the reason it is derived rather than written down: a registry is a
 * contributor on the search path (SPEC §7.1), so "which names resolve" and "what the engine will
 * dispatch" have to be the same answer. Building this by registering into a throwaway registry means
 * the loader's view comes out of the SAME registration the run uses — add a callee, or change what
 * one takes, and this follows without anybody remembering to update a second list.
 *
 * Only entries that actually DECLARE a signature are included. A registered name with no slots is
 * still perfectly callable as `operation.function`, where the author writes the arguments out; what
 * it cannot be is called positionally from an expression, because there is nothing to bind against.
 * Leaving it out is therefore the honest answer rather than an omission — and it is why this returns
 * a map built by filtering rather than a cast of `registry.functions`.
 */
export function hostCalleeSignatures(): ReadonlyMap<string, EntrySignature> {
  const probe = newCapabilityRegistry<WorkflowMetrics>();
  // The same call the CLI and the app make. A hub with no `onRequest` never parks anything, which is
  // exactly right for a registry nothing will run: what is wanted here is the entry's declaration.
  new UserEventHub().register(probe);
  return signaturesOf(probe);
}

/** The signature-carrying entries of a registry, in the shape `loadBundle` takes. */
export function signaturesOf(registry: CapabilityRegistry<WorkflowMetrics>): ReadonlyMap<string, EntrySignature> {
  const out = new Map<string, EntrySignature>();
  for (const [name, entry] of registry.functions) {
    if (entry.signature !== undefined) out.set(name, { signature: entry.signature });
  }
  return out;
}
