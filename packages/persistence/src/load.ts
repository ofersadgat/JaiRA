/**
 * What a stopped task can tell the run that continues it — the LOAD description (Identity and
 * Resume §04), which replaced the replay index.
 *
 * Resume used to be a deterministic fast-forward: the engine re-walked the whole workflow and, at
 * every operation the recorded run already answered, was handed the answer instead of dispatching.
 * That journaled a second walk, re-ran every guard (the call cache died with the process), and
 * re-minted every id, so nothing recorded survived to be pointed at. Loading replaces it: instance
 * ids are DURABLE now, so the machine is constructed from its own record — the journal carries the
 * tree, the inputs and the transitions; `operation_records` carries what came back — and hw's
 * `loadRun` re-enters the evaluation loop exactly where each instance stood.
 *
 * ## The fold is by INSTANCE ID, across runs
 *
 * A continuing run re-states `instance.entered` for the live spine — with the SAME ids — and
 * journals nothing that already happened. So folding every run's events into one table keyed by id
 * yields one tree: a re-stated entry merges into the instance it continues, and history entered
 * once stays entered once. The machine's root is the task's NEWEST parentless entry — a task is one
 * machine now, so there is normally exactly one, and where history holds several trees (an
 * in-place restart) the newest attempt is the task's own. `task_runtime.root_instance_id`
 * (stamped by migration 16 while run boundaries still existed) wins where present.
 *
 * ## Revival: what counts as still-to-do
 *
 * `live` is not just "entered and never terminated" (a crash), because a STOP terminates everything
 * on the way out (`canceled`) and a FAILURE terminates the chain that failed (`error`). Both are
 * interruptions of work, not answers to it, so the fold revives them: under a live parent, a child
 * is live when it never terminated, or when it terminated without success AND the parent never
 * advanced past it — no transition taken, no later child entered. A failure a transition handled is
 * history; the one that ended the run is the frontier, presented live so the engine re-enters it.
 *
 * ## Only completed operations are answers
 *
 * A record still `open`, settled `failed`, or cut (`interrupted`) is not something to load: it is
 * precisely where the run stopped. A live instance with no loaded operation re-dispatches — and
 * because its id and site are the recorded ones, the scoped record id recomputes identically and
 * the store REOPENS a cut record rather than inserting a second ask (§05).
 *
 * ## Deferred calls are not answers either
 *
 * An event is not a memo: "did the user drag this card" holds only until somebody acts on it, and
 * serving a recorded `on_user_event` answer into a resumed run would replay a person's decision.
 * The journal knows exactly which dispatches were deferred (`call.waiting` names them), so their
 * records are excluded from both the answers and the loaded call sites — the re-ask mints a fresh
 * site above `nextSite` and registers a fresh wait, which is the correct meaning of resuming one.
 */
import type { JsonValue } from "@declarative-ai/json";
import { hashOperation, scopedOperationId, type Failure, type ResolvedValue } from "@declarative-ai/exec";
import type { CallResult, LoadedInstance, WorkflowMetrics } from "@declarative-ai/hw";
import { CHAT_INSTANCE_PREFIX } from "@jaira/runtime";
import type { InstanceAddress } from "@jaira/shared";
import { SqliteEventLog } from "./eventLog";
import { hydrate } from "./blobStore";
import type { JairaDb } from "./db";
import type { Project } from "./project";

/** A live leaf of the loaded machine: somewhere the continuing run picks up spending again. */
export interface LoadFrontierEntry {
  address: InstanceAddress;
  stateId: string;
  instanceId: string;
  /**
   * `mid-operation` is the one that carries risk: the call was dispatched and never honestly
   * settled, so re-entering re-issues it (into its own reopened record, where one survives).
   * `between-children` is the quiet case — whatever ran finished, and the run stopped deciding
   * where to go next.
   */
  stopped: "mid-operation" | "between-children";
  /**
   * Why this instance is still to do: `interrupted` — the process died or was stopped under it —
   * or `failed` — it terminated with an error nothing handled, and re-entering is a RETRY. The
   * strip's verb hangs on the distinction, so it is computed here where the termination is visible.
   */
  cause: "interrupted" | "failed";
}

export interface TaskLoad {
  taskId: string;
  /** The machine to hand `loadRun`. Absent when there is nothing recorded, or when {@link blocked}. */
  loaded?: LoadedInstance;
  /** Recorded call answers by SCOPED operation id — hw's `EngineConfig.answers`. */
  answers: (scopedId: string) => CallResult | undefined;
  /** How many operations the description answers: loaded state ops plus recorded call answers. */
  loadedOps: number;
  frontier: readonly LoadFrontierEntry[];
  /**
   * Operations the description NEEDS and cannot read back — a completed event whose record is
   * missing or holds no readable value. Not dropped, because the difference matters: an operation
   * with no answer will be DISPATCHED on resume, and for one with side effects that is a
   * double-apply nobody asked for. Non-empty means resume is unsafe and the caller should say so.
   */
  unreadable: readonly { stateId: string; reason: string }[];
  /** Why the task cannot be loaded at all, when it cannot — legacy history, or nothing recorded. */
  blocked?: string;
}

/** What one journaled instance folded to — the mutable half of the description. */
interface FoldNode {
  id: string;
  stateId: string;
  childKey?: string;
  inputs: Record<string, JsonValue>;
  /** In FIRST-entry order — a re-stated entry merges rather than appending. */
  children: FoldNode[];
  terminated?: { outcome: string; failure?: Failure; at: number };
  index: number;
  iteration: number;
  /**
   * The global seq of this instance's last ADVANCEMENT — a transition taken, or a new child
   * entered. A child that finished after it is one no evaluation round ever answered.
   */
  advancedAt: number;
  superseded: boolean;
  opStarted: boolean;
  /** False between a start and its settle — which, for a stopped run, is "the process died in it". */
  opSettled: boolean;
  opCompleted?: { operationId?: string; op: "prompt" | "function"; metrics?: WorkflowMetrics };
  opInterrupted: boolean;
}

/** The record row the description joins to. */
interface RecordRow {
  id: string;
  status: string;
  result_json: string | null;
  request_json: string | null;
  instance_id: string | null;
  sequence: number | null;
}

/** The shape of the pinned definition the fold needs: which child keys form each state's sequence. */
export type SequenceShape = Record<string, { sequence?: readonly string[] } | undefined>;

/**
 * Free the identities of calls that never happened remotely (Identity and Resume §05).
 *
 * A FAILED record with no provider session consumed nothing: no turn landed in any remote stream,
 * so the record is not a witness to anything and deleting it makes the identity and the seat simply
 * free again — the continuing run makes the call fresh. An `interrupted` record, or a failure that
 * did report a handle, is kept: its turns may exist remotely, the row is the only witness, and the
 * re-dispatch REOPENS it rather than asking twice. Delete what never happened; continue what
 * half-happened.
 */
export function releaseUnconsumedFailures(project: Project, taskId: string): number {
  const result = project.db
    .prepare(`DELETE FROM operation_records WHERE task_id = ? AND status = 'failed' AND provider_session_id IS NULL`)
    .run(taskId);
  return result.changes;
}

/**
 * Build the load description for one task — the journal joined to the record store.
 *
 * `shape` is the PINNED snapshot's states: the sequence cursor is an index into each state's
 * declared `sequence`, which the journal does not carry (it records which child was entered, not
 * where that child sits in a list only the definition knows).
 */
export function buildTaskLoad(project: Project, taskId: string, shape: SequenceShape): TaskLoad {
  const rows = new SqliteEventLog(project.db).list(taskId);
  const none = (blocked?: string): TaskLoad => ({
    taskId,
    answers: () => undefined,
    loadedOps: 0,
    frontier: [],
    unreadable: [],
    ...(blocked !== undefined ? { blocked } : {}),
  });
  if (rows.length === 0) return none();

  // --- fold the journal into one instance table, keyed by durable id -------
  const nodes = new Map<string, FoldNode>();
  /**
   * The LAST first-time parentless entry — the machine. One task normally has exactly one (a
   * continuation re-states the same root, which merges above rather than landing here), and where
   * history holds several — an in-place restart, before re-runs minted tasks — the newest attempt
   * is the task's machine and the older trees are history it does not stand on.
   */
  let lastRootId: string | undefined;
  const deferredOps = new Set<string>();
  let legacy = false;
  for (const row of rows) {
    const event = row.event;
    const at = row.seq;
    switch (event.type) {
      case "instance.entered": {
        // A hand-continued conversation journals a SYNTHETIC child (`chat:<host>`, key "ask") into
        // the same stream — a person talking beside the machine, not the machine acting. It is not
        // part of the loaded tree: folded in, a completed chat turn (whose event names no operation
        // record) blocks resume as unreadable, and a stopped one revives into an uninvited dispatch
        // of the host's own op. Skipping the entry here drops the whole chat quietly — its other
        // events find no node — and deliberately does NOT advance the host.
        if (event.instanceId.startsWith(CHAT_INSTANCE_PREFIX)) break;
        // Durable ids are UUIDs; a counter id ("5") predates them, collides across runs, and keys
        // nothing in the record store. Such history cannot be loaded — only re-run.
        if (!event.instanceId.includes("-")) legacy = true;
        const existing = nodes.get(event.instanceId);
        if (existing !== undefined) {
          // The live spine re-stated by a continuing run, or a revived instance re-entered: the
          // structure is already known, and the entry means it is LIVE again. Deliberately not an
          // advancement of the parent — a re-statement answers nothing.
          delete existing.terminated;
          break;
        }
        const node: FoldNode = {
          id: event.instanceId,
          stateId: event.stateId,
          ...(event.childKey !== undefined ? { childKey: event.childKey } : {}),
          inputs: (event.inputs ?? {}) as Record<string, JsonValue>,
          children: [],
          index: 0,
          iteration: 0,
          advancedAt: 0,
          superseded: false,
          opStarted: false,
          opSettled: false,
          opInterrupted: false,
        };
        nodes.set(node.id, node);
        const parent = event.parentInstanceId === undefined ? undefined : nodes.get(event.parentInstanceId);
        if (parent !== undefined) {
          parent.children.push(node);
          // Entering a NEW child is the parent acting: whatever finished before this was answered.
          parent.advancedAt = at;
        } else {
          lastRootId = node.id;
        }
        break;
      }
      case "instance.terminated": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.terminated = {
            outcome: event.outcome,
            ...(event.failure !== undefined ? { failure: event.failure } : {}),
            at,
          };
        }
        break;
      }
      case "transition.taken": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.index = event.index;
          node.iteration = event.iteration;
          node.advancedAt = at;
        }
        break;
      }
      case "child.superseded": {
        const parent = nodes.get(event.instanceId);
        // The NEWEST entry under the key is the one a sequence reset clears — earlier ones were
        // already history when it ran.
        const target = parent?.children.filter((c) => c.childKey === event.childKey && !c.superseded).at(-1);
        if (target !== undefined) target.superseded = true;
        break;
      }
      case "operation.started": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.opStarted = true;
          node.opSettled = false;
        }
        break;
      }
      case "operation.completed": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.opSettled = true;
          node.opInterrupted = false;
          node.opCompleted = {
            ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
            op: event.op,
            ...(event.metrics !== undefined ? { metrics: event.metrics } : {}),
          };
        }
        break;
      }
      case "operation.failed": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.opSettled = true;
          node.opCompleted = undefined;
          node.opInterrupted = event.failure.classification === "interrupted";
        }
        break;
      }
      case "call.waiting": {
        deferredOps.add(event.operationId);
        break;
      }
      default:
        break;
    }
  }
  if (legacy) {
    return none("this task's history predates durable instance ids — run it again instead");
  }
  // The machine's root: the newest parentless tree (see `lastRootId`). The migration's
  // `root_instance_id` stamp — written for pre-collapse history while run boundaries still existed
  // to read — wins where present, because it is the same answer computed with more information.
  const stamped = project.runtime.get(taskId)?.rootInstanceId;
  const root = (stamped !== undefined ? nodes.get(stamped) : undefined) ?? (lastRootId !== undefined ? nodes.get(lastRootId) : undefined);
  if (root === undefined) return none();

  // --- join the record store: call sites, call answers, operation values ---
  const records = project.db
    .prepare(`SELECT id, status, result_json, request_json, instance_id, sequence FROM operation_records WHERE task_id = ?`)
    .all(taskId) as RecordRow[];
  const recordById = new Map(records.map((row) => [row.id, row]));
  const answers = new Map<string, CallResult>();
  const sitesByInstance = new Map<string, Array<readonly [string, number]>>();
  const nextSiteByInstance = new Map<string, number>();
  for (const row of records) {
    if (row.instance_id === null || row.sequence === null || row.sequence < 1) continue;
    // Every dispatched sequence is BURNED whether or not its site is loaded — a fresh mint must
    // land above it, or two asks would compute one identity.
    nextSiteByInstance.set(row.instance_id, Math.max(nextSiteByInstance.get(row.instance_id) ?? 1, row.sequence + 1));
    if (row.request_json === null) continue;
    let request: unknown;
    try {
      request = JSON.parse(row.request_json);
    } catch {
      continue;
    }
    if (request === null || typeof request !== "object" || Array.isArray(request)) continue;
    // The dispatched op is the request minus the identity that was spliced beside it. Hashing it
    // back recomputes the engine's content key — except where a render changed the op on the way
    // out, and then the site is simply absent: the engine mints a fresh one and pays again, which
    // is a cost and never a collision.
    const { scope: _scope, session: _session, ...op } = request as Record<string, unknown>;
    const key = hashOperation(op as never);
    // The deferred exclusion compares CONTENT keys: `call.waiting` stamps the bare hash (an event
    // fires before any scope is claimed), while `row.id` is the scoped id — comparing those two
    // spellings matched nothing, and recorded human answers loaded as memo hits.
    if (deferredOps.has(key)) continue;
    const sites = sitesByInstance.get(row.instance_id);
    const site = [key, row.sequence] as const;
    if (sites === undefined) sitesByInstance.set(row.instance_id, [site]);
    else sites.push(site);
    if (row.status !== "completed") continue;
    const value = recordValue(project.db, row.result_json, (op as { kind?: string }).kind === "prompt" ? "prompt" : "function");
    if (value === undefined) continue;
    answers.set(scopedOperationId(key, { instanceId: row.instance_id, sequence: row.sequence }), {
      value: value as ResolvedValue,
    });
  }

  // --- emit the LoadedInstance tree, top-down --------------------------------
  const unreadable: Array<{ stateId: string; reason: string }> = [];
  const frontier: LoadFrontierEntry[] = [];
  let loadedOps = answers.size;

  const operationOf = (node: FoldNode, required: boolean): LoadedInstance["operation"] => {
    if (node.opCompleted === undefined) return undefined;
    const miss = (reason: string): undefined => {
      if (required) unreadable.push({ stateId: node.stateId, reason });
      return undefined;
    };
    const opId = node.opCompleted.operationId;
    if (opId === undefined) return miss("its completion names no operation record");
    const row = recordById.get(opId);
    if (row === undefined) return miss("no operation record for this event");
    if (row.status !== "completed") return miss(`its record is '${row.status}', not completed`);
    const value = recordValue(project.db, row.result_json, node.opCompleted.op);
    if (value === undefined) return miss("the record holds no readable value");
    loadedOps += 1;
    const metrics = node.opCompleted.metrics;
    const sessionRef = (metrics as { sessionRef?: string } | undefined)?.sessionRef;
    return {
      value: value as ResolvedValue,
      ...(metrics !== undefined ? { metrics } : {}),
      ...(sessionRef !== undefined ? { sessionRef } : {}),
    };
  };

  const emit = (node: FoldNode, live: boolean, occurrence: number, prefix: InstanceAddress): LoadedInstance => {
    const address: InstanceAddress =
      node.childKey === undefined ? prefix : [...prefix, { childKey: node.childKey, occurrence }];
    const children: LoadedInstance[] = [];
    const unanswered: Array<{ key: string; at: number }> = [];
    // Occurrence counts entries under one key IN THIS PARENT, superseded included — a loop's second
    // iteration is occurrence 1 whether or not the first was cleared.
    const seen = new Map<string, number>();
    let anyChildLive = false;
    for (const child of node.children) {
      const key = child.childKey ?? "";
      const childOccurrence = seen.get(key) ?? 0;
      seen.set(key, childOccurrence + 1);
      // A sequence reset disowned it: history whose entry still counts, and nothing to load.
      if (child.superseded) continue;
      // The revival rule (see the header): still-running continues, and an unhandled non-success
      // end — nothing advanced past it — is work interrupted, presented live so it re-enters.
      const childLive =
        live &&
        (child.terminated === undefined ||
          (child.terminated.outcome !== "success" && child.terminated.at > node.advancedAt));
      if (childLive) anyChildLive = true;
      else if (live && child.terminated !== undefined && child.terminated.outcome === "success" && child.terminated.at > node.advancedAt) {
        // Finished after this instance's last advancement: the round that would have read it never
        // ran, so the loaded round owes it an answer.
        unanswered.push({ key, at: child.terminated.at });
      }
      children.push(emit(child, childLive, childOccurrence, address));
    }
    // The state's own operation. Required reading for a live instance (re-dispatching a completed
    // op is the double-apply this whole join exists to prevent) and for successful history (its
    // outputs are recomputed from the value); a failed instance's own record is not — it re-runs.
    const stateHasOp = node.opStarted || node.opCompleted !== undefined;
    const required = live || node.terminated?.outcome === "success";
    const operation = stateHasOp ? operationOf(node, required) : undefined;

    if (live && !anyChildLive) {
      frontier.push({
        address,
        stateId: node.stateId,
        instanceId: node.id,
        stopped: node.opStarted && (!node.opSettled || node.opInterrupted) ? "mid-operation" : "between-children",
        cause:
          node.terminated !== undefined && (node.terminated.outcome === "error" || node.terminated.outcome === "timeout")
            ? "failed"
            : "interrupted",
      });
    }

    const sites = sitesByInstance.get(node.id);
    const nextSite = nextSiteByInstance.get(node.id);
    const cursor = cursorOf(node, shape);
    return {
      id: node.id,
      stateId: node.stateId,
      ...(node.childKey !== undefined ? { childKey: node.childKey } : {}),
      occurrence,
      inputs: node.inputs as Record<string, ResolvedValue>,
      index: node.index,
      iteration: node.iteration,
      ...(cursor !== undefined ? { cursor } : {}),
      live,
      ...(node.terminated !== undefined && !live
        ? {
            outcome: node.terminated.outcome as LoadedInstance["outcome"],
            ...(node.terminated.failure !== undefined ? { failure: node.terminated.failure } : {}),
          }
        : {}),
      ...(operation !== undefined ? { operation } : {}),
      ...(live && unanswered.length > 0
        ? { unanswered: unanswered.sort((a, b) => a.at - b.at).map((entry) => entry.key) }
        : {}),
      ...(sites !== undefined ? { sites } : {}),
      ...(nextSite !== undefined ? { nextSite } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  };

  const rootLive = root.terminated === undefined || root.terminated.outcome !== "success";
  const loaded = emit(root, rootLive, 0, []);
  return {
    taskId,
    loaded,
    answers: (scopedId) => answers.get(scopedId),
    loadedOps,
    frontier,
    unreadable,
  };
}

/**
 * Where the sequence cursor stands: the index of the last ENTERED sequence member.
 *
 * The entry IS the cursor move — backwards it re-runs the tail, forwards it skips the head — so the
 * last entry under a sequence key is where the walk stands, superseded or not (a reset re-enters
 * its target, which is a later entry and wins). The journal records which child entered; only the
 * pinned definition knows where that key sits, which is why the shape is a parameter.
 */
function cursorOf(node: FoldNode, shape: SequenceShape): number | undefined {
  const sequence = shape[node.stateId]?.sequence;
  if (sequence === undefined || sequence.length === 0) return undefined;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const key = node.children[i]?.childKey;
    if (key === undefined) continue;
    const at = sequence.indexOf(key);
    if (at >= 0) return at;
  }
  return undefined;
}

/**
 * The value out of a record's payload — undoing the choice `withRecord` made when it wrote the row.
 *
 * Records are written `{ value }` by `withRecord`, and a row that is not that shape is left alone
 * rather than guessed at: a wrong unwrapping here would feed the engine a value the call never
 * returned. One level is not always enough: a PROMPT record's payload is the whole `LlmOutput` —
 * the op's value plus reasoning, tool trace and finish reason — because a record says what the call
 * PRODUCED, not the one field the op declared. The engine wants the other one: the loaded value is
 * what a state's outputs bind through. Detection is the op kind AND `finishReason` — the kind alone
 * is wrong because a scripted prompt executor stores the flat value, and the field alone is wrong
 * because nothing stops a function from returning an object that happens to carry it.
 *
 * Hydrated like every other reader of `result_json`: big string leaves live in the blob store and
 * the row keeps `{"$blob": …}` in their place, which is a reference and not a value.
 */
function recordValue(db: JairaDb, resultJson: string | null, op: "prompt" | "function"): JsonValue | undefined {
  if (resultJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return undefined;
  }
  const hydrated = hydrate(db, parsed as JsonValue);
  if (hydrated === null || typeof hydrated !== "object" || Array.isArray(hydrated)) return undefined;
  const value = (hydrated as { value?: JsonValue }).value;
  if (value === undefined) return undefined;
  return isLlmPayload(value, op) ? (value as { value?: JsonValue }).value : value;
}

/** Whether a prompt record's stored payload is an `LlmOutput` rather than the projected value —
 *  `finishReason` is the payload's one REQUIRED field, so its presence on a prompt op's row is what
 *  says the projection still has to be applied. */
function isLlmPayload(value: JsonValue, op: "prompt" | "function"): boolean {
  return (
    op === "prompt" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { finishReason?: unknown }).finishReason === "string"
  );
}

/**
 * The canonical string form of an address, and a map key — never an identity (it joins with `/` and
 * `#`, neither reserved in a child key). Kept from the replay module for the callers that log one.
 */
export function addressKey(address: InstanceAddress): string {
  return address.map((step) => `${step.childKey}#${step.occurrence}`).join("/");
}
