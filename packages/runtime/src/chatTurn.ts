/**
 * One typed message, run and recorded.
 *
 * The engine is not involved and does not need to be. A chat child never participates in the state
 * machine — nothing binds to its output, no transition fires from it — so what is left of "run a
 * state" is: resolve a position, call the executor, write the journal events a projection reads.
 * All three are things the engine does for an ordinary state, and all three are small.
 *
 * ## The loop is one instance, not one per message
 *
 * A fifty-message conversation is ONE instance at `index: 50`, and that is load-bearing rather
 * than tidy. `projection.ts` marks a previous instance under the same child key as superseded the
 * moment that key is re-entered, and a message-per-instance design would therefore leave
 * forty-nine of them superseded — every reader of the tree drawing them as work the engine has
 * disowned, which is not what a message that was sent and answered is.
 *
 * (The sharper version of this used to be that the run's transcript DROPPED superseded nodes, so
 * the other design would have made every message but the last vanish outright. It no longer does —
 * a loop's earlier passes are history and are shown — but nothing above depends on that, and the
 * shape here is the right one either way.)
 *
 * So the first message enters the instance and every message after it takes a transition. The
 * projection reads `iteration` straight off `transition.taken`, and re-terminating an id it has
 * already terminated just moves `endedAt` forward. Nothing else has to know the loop exists.
 *
 * ## Terminating between messages is deliberate
 *
 * A chat child that stayed `running` while it waited for someone to type would make its whole task
 * read as busy — task status derives from the instance tree, so an idle conversation would look like
 * work in flight forever. Each turn therefore ends properly, and the next one reopens the same
 * instance rather than a new one.
 */
import type { EngineEvent, TerminationOutcome, WorkflowMetrics } from "@declarative-ai/hw";
import type {
  ExecServices,
  Executor,
  InlineFamily,
  PromptOp,
  ResolvedValue,
  SessionStore,
} from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";

/**
 * Where a chat instance's id comes from.
 *
 * DERIVED from the host instance rather than minted, because the derivation is the determinism a
 * chat needs: every turn of a conversation — across service restarts — must land on the SAME
 * synthetic instance, and only a value computed from the host can promise that. The engine's own
 * ids are UUIDv7 hex-and-dashes, so the `chat:` prefix is a namespace no engine id can ever occupy
 * and no race with a running engine exists to lose.
 */
export const CHAT_INSTANCE_PREFIX = "chat:";

/** The synthetic instance a hand-continued conversation under `hostInstanceId` lives in. */
export function chatInstanceIdOf(hostInstanceId: string): string {
  return `${CHAT_INSTANCE_PREFIX}${hostInstanceId}`;
}

/** True for an id this module derived rather than the engine minted — see {@link CHAT_INSTANCE_PREFIX}. */
export function isChatInstance(instanceId: string): boolean {
  return instanceId.startsWith(CHAT_INSTANCE_PREFIX);
}

/**
 * The child key a hand-continued conversation is mounted at.
 *
 * One reserved key per host, which is what makes the loop one node: a second `instance.entered` under
 * the same key would supersede the first and the panel would show only the latest message. It is not
 * a key any workflow declares, so it never collides with an authored child — and the board draws its
 * columns from the DECLARED children, so a conversation appears in the transcript without inventing a
 * column in a board the workflow's author never wrote.
 */
export const CHAT_CHILD_KEY = "ask";

/** Which conversation, and where in the tree it hangs. */
export interface ChatInstance {
  /** The synthetic child's own id. See {@link CHAT_INSTANCE_PREFIX}. */
  instanceId: string;
  /** The instance being read — the one this conversation is a child OF. */
  parentInstanceId: string;
  /** The state the child is recorded under, which is the host's own id. */
  stateId: string;
  /** The reserved key this conversation is mounted at. One per host, so the loop stays one node. */
  childKey: string;
  /**
   * 0 for the first message, then one per message.
   *
   * `index` rather than `iteration` since hw split the two: `index` counts every transition an
   * instance takes and `iteration` counts only the backward ones — the passes of a loop. A chat has
   * no sequence to step back into, so a message is a transition and never a pass, and its counter is
   * the one that moves per message.
   */
  index: number;
}

export interface ChatTurnPorts {
  /**
   * The prompt executor, ALREADY under `withSessionLayers`.
   *
   * Taken layered rather than layering it here, because the stores are the caller's and the ordering
   * is a correctness property that belongs in one place — see `withSessionLayers`. A caller that
   * hands over a bare executor gets a turn that runs and is never recorded, which is the failure this
   * module cannot detect and the helper exists to prevent.
   */
  executor: Executor<ExecServices, WorkflowMetrics>;
  sessions: SessionStore<JsonValue>;
  /** The run's journal. Same sink the engine writes to, so one projection reads both. */
  record: (event: EngineEvent, atMs: number) => void;
  /** Everything the call needs that is not the session: tools, workspace, validator, abort. */
  services?: ExecServices;
  now?: () => number;
}

export interface ChatTurnRequest {
  instance: ChatInstance;
  operation: PromptOp<InlineFamily>;
  /** The exact position the displayed transcript ends at. */
  position: string;
}

export interface ChatTurnResult {
  /** What came back, when it did. */
  value?: ResolvedValue;
  /** Where the conversation now ends — the caller's next `position`. */
  sessionRef?: string;
  /** Why it did not, worded for someone reading the transcript rather than a stack trace. */
  failure?: string;
}

/**
 * The seed a fork of this turn would be named by.
 *
 * `mint` is deterministic — `s_${seed}` — so two forks sharing a seed share an id and collide. hw
 * uses `${stateId}:${sessionId}`, stable per state so a REPLAY of one call lands on the conversation
 * it landed on before instead of minting a second beside it. A chat turn wants the same property per
 * MESSAGE, which is what the iteration is doing here: replaying message 4 reuses message 4's branch,
 * and message 5 cannot land on it.
 */
function seedFor(instance: ChatInstance): string {
  return `chat:${instance.instanceId}:${instance.index}`;
}

/**
 * Run one message and journal it.
 *
 * Failures are RETURNED, never thrown: a model that refused is a turn of the conversation, and the
 * journal has to record it as one or the panel shows a message that was sent and no reason it went
 * nowhere. Only a caller bug — a store that will not resolve — escapes.
 */
export async function runChatTurn(ports: ChatTurnPorts, request: ChatTurnRequest): Promise<ChatTurnResult> {
  const { instance } = request;
  const now = ports.now ?? (() => Date.now());
  const at = now();
  const emit = (event: EngineEvent, when: number = now()): void => ports.record(event, when);
  const where = { instanceId: instance.instanceId, stateId: instance.stateId };

  // Entering once and transitioning after is what keeps a long conversation one node — see the
  // module header on why a second `instance.entered` under this key would hide everything above it.
  if (instance.index === 0) {
    emit(
      {
        type: "instance.entered",
        ...where,
        childKey: instance.childKey,
        parentInstanceId: instance.parentInstanceId,
        // The message is not an input the way a state's inputs are — it is the operation's own
        // prompt, and it is already in the transcript. Recording it here would print it twice.
        inputs: {},
      },
      at,
    );
  } else {
    emit({ type: "transition.taken", ...where, to: instance.stateId, index: instance.index, iteration: 0 }, at);
  }
  emit({ type: "operation.started", ...where, op: "prompt" }, at);

  const resolved = await ports.sessions.resolve({ ref: request.position, seed: seedFor(instance) });
  /**
   * The call, and a terminal event WHATEVER it does — including throw.
   *
   * A rejection is not the ordinary shape (an executor reports failures as error results, which is
   * why the branch below exists) but it is a reachable one: a store that will not write, a wrapper
   * that gives up, a bug. Unhandled, it left the turn journalled as started and never ended — and an
   * unterminated turn is exactly the state that makes its position invisible, so the next message
   * collides with the record this one already claimed and forks away from it, taking the turn off
   * the screen.
   *
   * The position is known without the metrics: it is where the call was RESOLVED to, one on, which
   * is the same arithmetic `withSessionPosition` reports when it gets the chance. Stated through the
   * store's own `refAt` rather than concatenated, because the ref's spelling belongs to the store.
   */
  let result;
  try {
    // The DISPATCH SCOPE, same contract as the engine's (`ExecServices.scope`): the chat child is
    // the instance, and the message index is the site — so the record id is the hash of the scoped
    // request and two identical messages in one thread cannot collide, which under bare content
    // hashes they silently did.
    const scope = { instanceId: instance.instanceId, sequence: instance.index };
    result = await ports.executor.start(request.operation, { ...ports.services, session: resolved, scope }).result;
  } catch (e) {
    const failure = { classification: "permanent" as const, reason: (e as Error).message };
    const sessionRef = ports.sessions.refAt({ id: resolved.at.id, seq: resolved.at.seq + 1 });
    emit({ type: "operation.failed", ...where, op: "prompt", failure, metrics: { durationMs: 0, sessionRef } as WorkflowMetrics });
    emit({ type: "instance.terminated", ...where, outcome: "error", failure });
    return { sessionRef, failure: failure.reason };
  }

  // The join between a turn and its transcript. `withSessionPosition` stamps the position a call
  // ENDED at onto the metrics, and the projection reads it off `operation.completed` — so dropping it
  // here would record a conversation nothing could find its way back to.
  const sessionRef = result.metrics.sessionRef;

  // `"error" in result`, not `result.error`: the success branch has no `error` key at all, precisely
  // so that the second spelling fails to compile rather than compiling and widening `value`.
  if ("error" in result) {
    const failure = result.error;
    // The METRICS ride on the failure too, and they are not decoration: `session_ref` is a generated
    // column over `$.metrics.sessionRef`, so an `operation.failed` without them names no position —
    // and a turn that names no position is invisible to `stateSessions`, which is what the app reads
    // to find where a conversation ends.
    //
    // That invisibility is the whole of the interrupted-chat failure. A canceled turn still CLAIMED
    // its position (the record row is there, holding whatever streamed before the stop), so the next
    // message computed the same position again, collided with it, and forked — landing on a branch
    // the panel does not read, dropping the interrupted turn out of the thread, and inheriting no
    // provider handle, so the agent started a fresh session instead of resuming. One field.
    emit({ type: "operation.failed", ...where, op: "prompt", failure, metrics: result.metrics });
    emit({ type: "instance.terminated", ...where, outcome: outcomeOf(failure), failure });
    return { ...(sessionRef !== undefined ? { sessionRef } : {}), failure: failure.reason };
  }

  emit({ type: "operation.completed", ...where, op: "prompt", metrics: result.metrics });
  emit({ type: "instance.terminated", ...where, outcome: "success" });
  return {
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
  };
}

/** A cancel reads as cancelled rather than failed — the person stopped it, nothing went wrong. */
function outcomeOf(failure: { classification?: string }): TerminationOutcome {
  return failure.classification === "canceled" ? "canceled" : "error";
}
