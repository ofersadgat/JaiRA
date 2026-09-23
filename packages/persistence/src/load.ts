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
 * A continuing run journals nothing that already happened — a loaded instance is not entered again.
 * Folding every event into one table keyed by id is what yields one tree: a revived instance's
 * re-entry merges into the instance it continues, and history entered once stays entered once.
 * The machine's root is the task's NEWEST parentless entry — a task is one
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
 *
 * ## A person's move: `skipped` is an answer, and a directed transition reopens (decision 0005)
 *
 * A `transition.taken` row carrying `by` was DIRECTED — injected on somebody's behalf, not fired by
 * a rule. Three things follow for the fold. What it stepped past ended `skipped`, and `skipped` is
 * never revived: it is not work interrupted but a decision made, however early in the run's
 * wind-down the process died. A directed transition on an instance that had already terminated
 * REOPENS it, and every ancestor with it — the row is the reopening, exactly as a chat turn's
 * transition reopens its instance — so a task that died after taking a move as a finished task
 * loads live. And a directed transition whose target never entered is an entry the instance still
 * OWES (`LoadedInstance.directed`): the run died between the two rows, and the load makes the entry
 * without journaling the transition again.
 *
 * A move to a NESTED target is taken a level at a time, each step's row carrying the rest of the way
 * down (`transition.taken`'s `descent`). The instance a step entered owes the next step until it
 * journals a directed transition of its own; one still owing it is loaded with it
 * (`LoadedInstance.descent`), so a restart part-way down continues to the target instead of walking
 * the composite's spine from its first child.
 *
 * ## An adopted child is history whose outputs are ON its row (decision 0005 §2)
 *
 * An adoption (`adopt.ts`) mirrors a task that ran alone into this journal: an `instance.entered`
 * marked `adopted`, whose instance id is that task's, and an `instance.terminated` carrying the
 * outputs the task recorded. Such a node has no operation and no children here — they are in the
 * adopted task's journal — so there is nothing for the engine to recompute its outputs FROM. It is
 * emitted as history under a STAND-IN state id (`adoptedStandInId`), its recorded outputs as the
 * stand-in operation's value; `withAdoptedStandIns` puts the matching state into the bundle the run
 * is handed. A mirror still OPEN — the adopted task has not completed — blocks the load: continued
 * live, the engine would run the child a second time, inside the parent.
 *
 * ## A conversation starts idle (decision 0005 §3, step 6)
 *
 * A dynamic workflow's root is a state with an operation — a conversation — AND children. When a
 * MOVE makes one (a new document for a finished task, a real workflow's copy given a conversation),
 * the root has an operation it never ran, and an instance loaded with an operation it never ran
 * dispatches it: a model call made by a drop, saying nothing anybody asked. So the root of a task
 * that stands in a DOCUMENT, whose state has a PROMPT operation and children, and whose operation
 * never started, is loaded with that operation SETTLED and nothing said (`IDLE_CONVERSATION_VALUE`).
 * A prompt and not any operation: a conversation is what may be left unsaid, and a root that runs a
 * function is running something, which is not this rule's to skip. The
 * engine goes straight to what the move asked for. The conversation exists all the same: typed
 * turns run as the synthetic child `chat:<root>` (`chat-turns`), which the engine never sees, and
 * the first of them is whatever the person types. A root whose operation DID run — a `chat/session`
 * that grew a child — is read from its record like any other.
 */
import type { JsonValue } from "@declarative-ai/json";
import { hashOperation, scopedOperationId, type Failure, type ResolvedValue } from "@declarative-ai/exec";
import type { CallResult, DirectedDescent, LoadedInstance, WorkflowMetrics } from "@declarative-ai/hw";
import { CHAT_INSTANCE_PREFIX } from "@jaira/runtime";
import type { InstanceAddress } from "@jaira/shared";
import { SqliteEventLog } from "./eventLog";
import { hydrate } from "./blobStore";
import type { JairaDb } from "./db";
import type { Project } from "./project";
import { adoptedStandInId } from "./adopt";
import { settleConnectUndo } from "./connectUndo";

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
  /** Why the task cannot be loaded at all, when it cannot — nothing recorded, or an open adoption. */
  blocked?: string;
}

/** What one journaled instance folded to — the mutable half of the description. */
interface FoldNode {
  id: string;
  stateId: string;
  /** The instance that entered this one — walked upward when a directed transition reopens a path. */
  parentId?: string;
  /** A DIRECTED transition journaled here whose target has not entered since — see the header. */
  directed?: { to: string; inputs?: Record<string, JsonValue>; descent?: DirectedDescent };
  /** The next step of a way down this instance was entered to take, and has not — see the header. */
  descent?: DirectedDescent;
  childKey?: string;
  /** The element of a fanned-out mount this instance is — see `InstanceNode.element`. */
  element?: number;
  /** A mirrored ADOPTION — see the header. The outputs arrive with its end. */
  adopted?: { outputs?: Record<string, JsonValue> };
  inputs: Record<string, JsonValue>;
  /** In FIRST-entry order — a re-stated entry (older journals) merges rather than appending. */
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
  /**
   * The computed fields that SETTLED (SPEC §5.3), by authored path — `LoadedInstance.fields`.
   *
   * The last `value.settled` per field wins, and a fallback's value counts: it is the value the
   * instance ran with, and handing it back is what keeps a resume from paying for the title prompt
   * again and coming back with a different name.
   */
  fields: Map<string, ResolvedValue>;
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
export type SequenceShape = Record<string, { sequence?: readonly string[]; operation?: { kind?: string } | undefined; children?: unknown } | undefined>;

/** What an idle conversation's never-run operation is loaded as having said — see the header. */
export const IDLE_CONVERSATION_VALUE = "";

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
 * Delete the failure the revived instances carry, so the journal says what the retry says (§05).
 *
 * A retry revives the failed chain — the fold presents every instance that ended without success,
 * and nothing advanced past, as LIVE again — and the failed call's record is already freed by
 * {@link releaseUnconsumedFailures}. What stayed behind was the journal's account of the failure:
 * the `instance.terminated` rows for the leaf and every ancestor that fell with it, the
 * `operation.failed` row for the call, the `call.waiting`/`call.settled` pair of a wait the stop
 * withdrew, and the `value.settled` row of a computed field (a title) that failed with no
 * `failureValue` to stand in. Every reader of the journal then drew the failure beside the retry — the conversation's
 * grey notes, the run causes, a resume of the resume — as an error the run still had. The state
 * info was deleted; the error info was not. This deletes it.
 *
 * ONLY for instances the load holds live: a failure a transition handled is history, stays history,
 * and is not touched. Nor is the entry, the transitions, the completed operations or anything under
 * a terminated instance — the retry continues those, it does not re-do them. Liveness is read off
 * the description the caller has already built, and deleting these rows does not change it: an
 * instance with no termination is live by the fold's first rule, and one whose failure this removes
 * was live by its second.
 */
export function releaseRevivedFailures(project: Project, load: TaskLoad): number {
  const live: string[] = [];
  const walk = (node: LoadedInstance | undefined): void => {
    if (node === undefined) return;
    if (node.live) live.push(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  walk(load.loaded);
  if (live.length === 0) return 0;
  // The failure deleted here may be what ended a connect's Undo (the state a drop landed in failed):
  // judged before it is forgotten, so a retry does not bring the Undo back (`connectUndo.ts`).
  settleConnectUndo(project, load.taskId);
  const marks = live.map(() => "?").join(", ");
  const result = project.db
    .prepare(
      `DELETE FROM state_machine_events
       WHERE task_id = ? AND instance_id IN (${marks})
         AND (
           (type = 'instance.terminated' AND json_extract(payload_json, '$.outcome') <> 'success')
           OR type = 'operation.failed'
           OR type = 'call.waiting'
           OR type = 'call.settled'
           -- A computed field that failed with nothing standing in: the failure that ended the
           -- instance. The retry evaluates it afresh; a fallback is a value, and stays.
           OR (type = 'value.settled' AND json_extract(payload_json, '$.value') IS NULL
               AND COALESCE(json_extract(payload_json, '$.fallback'), 0) = 0)
         )`,
    )
    .run(load.taskId, ...live);
  return result.changes;
}

/**
 * The content behind an engine artifact ref, read back from the record store by NAME.
 *
 * An engine ref is `user-facing state id # instance id . slot` (`registerArtifact`): the slot is a
 * blob output of that instance, and the instance's completed operation record holds the value the
 * output was bound from. A ref that reaches a reader without its content — the journal elides it,
 * and a gate row written by a run before the engine learned to put it back carries that elision —
 * can be filled in from here. Undefined where the name does not parse, the instance has no
 * completed record, or the slot is not a string there; the caller keeps the ref it had.
 */
export function artifactContentOf(project: Project, taskId: string, name: string): string | undefined {
  const hash = name.indexOf("#");
  const dot = name.lastIndexOf(".");
  if (hash < 0 || dot < hash + 2) return undefined;
  const instanceId = name.slice(hash + 1, dot);
  const slot = name.slice(dot + 1);
  const row = project.db
    .prepare(
      `SELECT request_json, result_json FROM operation_records
       WHERE task_id = ? AND instance_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId, instanceId) as { request_json: string | null; result_json: string | null } | undefined;
  if (row === undefined) return undefined;
  let op: "prompt" | "function" = "function";
  try {
    const request = JSON.parse(row.request_json ?? "{}") as { kind?: unknown };
    if (request.kind === "prompt") op = "prompt";
  } catch {
    // An unreadable request still has a readable value; the kind only decides one unwrapping.
  }
  const value = recordValue(project.db, row.result_json, op);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const found = (value as Record<string, JsonValue>)[slot];
  return typeof found === "string" ? found : undefined;
}

/**
 * The same inputs, with every content-less artifact ref filled in from the record store.
 *
 * For a gate row read back off disk (`pending_interactions`): the row is what a run parked, and a
 * run parked before the engine rehydrated loaded inputs wrote the reference alone. The component
 * on the other end exists to show the document, so it gets the document. Returns the input map it
 * was given when nothing changed, so a caller can keep an identity check.
 */
export function rehydrateArtifactInputs(project: Project, taskId: string, inputs: Record<string, JsonValue>): Record<string, JsonValue> {
  let changed = false;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const ref = value as { artifact?: unknown; name?: unknown; content?: unknown };
      if (ref.artifact === true && typeof ref.name === "string" && ref.content === undefined) {
        const content = artifactContentOf(project, taskId, ref.name);
        if (content !== undefined) {
          out[key] = { ...(value as Record<string, JsonValue>), content };
          changed = true;
          continue;
        }
      }
    }
    out[key] = value;
  }
  return changed ? out : inputs;
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
   * The LAST first-time parentless entry — the machine. One task normally has exactly one (an older
   * continuation re-stated the same root, which merges above rather than landing here), and where
   * history holds several — an in-place restart, before re-runs minted tasks — the newest attempt
   * is the task's machine and the older trees are history it does not stand on.
   */
  let lastRootId: string | undefined;
  const deferredOps = new Set<string>();
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
        const existing = nodes.get(event.instanceId);
        if (existing !== undefined) {
          // A revived instance re-entered: the structure is already known, and the entry means it is
          // LIVE again. Deliberately not an advancement of the parent — a re-entry answers nothing.
          delete existing.terminated;
          break;
        }
        const node: FoldNode = {
          id: event.instanceId,
          stateId: event.stateId,
          ...(event.parentInstanceId !== undefined ? { parentId: event.parentInstanceId } : {}),
          ...(event.childKey !== undefined ? { childKey: event.childKey } : {}),
          ...(event.element !== undefined ? { element: event.element } : {}),
          ...((event as { adopted?: boolean }).adopted === true ? { adopted: {} } : {}),
          inputs: (event.inputs ?? {}) as Record<string, JsonValue>,
          children: [],
          index: 0,
          iteration: 0,
          advancedAt: 0,
          superseded: false,
          opStarted: false,
          opSettled: false,
          opInterrupted: false,
          fields: new Map(),
        };
        nodes.set(node.id, node);
        const parent = event.parentInstanceId === undefined ? undefined : nodes.get(event.parentInstanceId);
        if (parent !== undefined) {
          parent.children.push(node);
          // Entering a NEW child is the parent acting: whatever finished before this was answered.
          parent.advancedAt = at;
          // The entry a directed transition owed has been made — and, on a way down, this instance
          // owes the next step until it takes one.
          const owed = parent.directed;
          if (owed !== undefined && owed.to === event.childKey) {
            if (owed.descent !== undefined) node.descent = owed.descent;
            delete parent.directed;
          }
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
          const outputs = (event as { outputs?: Record<string, JsonValue> }).outputs;
          if (node.adopted !== undefined && outputs !== undefined) node.adopted = { outputs };
        }
        break;
      }
      case "transition.taken": {
        const node = nodes.get(event.instanceId);
        if (node !== undefined) {
          node.index = event.index;
          node.iteration = event.iteration;
          node.advancedAt = at;
          if (event.by !== undefined) {
            // DIRECTED (see the header): the target's entry is owed until it is seen, and an
            // instance that had terminated is live again — with everything above it.
            node.directed = {
              to: event.to,
              ...(event.inputs !== undefined ? { inputs: event.inputs as Record<string, JsonValue> } : {}),
              ...(event.descent !== undefined ? { descent: event.descent } : {}),
            };
            // A directed step of its own is the step a way down was waiting for — or a later word.
            delete node.descent;
            for (let up: FoldNode | undefined = node; up !== undefined; up = up.parentId === undefined ? undefined : nodes.get(up.parentId)) {
              delete up.terminated;
            }
          }
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
      case "value.settled": {
        const node = nodes.get(event.instanceId);
        if (node === undefined) break;
        // A failure with nothing standing in carries no value and failed the instance. A retry that
        // revives it must evaluate the field afresh, so an earlier value — there is none in practice,
        // a field settles once — is not left behind to be loaded in its place.
        if (event.value === undefined) node.fields.delete(event.field);
        else node.fields.set(event.field, event.value);
        break;
      }
      default:
        break;
    }
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

  /** Adopted tasks whose mirror is still open — see the header. */
  const awaited: string[] = [];
  const inDocument = project.runtime.get(taskId)?.documentId !== undefined;
  const hasChildren = (children: unknown): boolean => children !== null && typeof children === "object" && Object.keys(children as object).length > 0;

  const emit = (node: FoldNode, live: boolean, occurrence: number, prefix: InstanceAddress): LoadedInstance => {
    const address: InstanceAddress =
      node.childKey === undefined
        ? prefix
        : [...prefix, { childKey: node.childKey, occurrence, ...(node.element !== undefined ? { element: node.element } : {}) }];
    if (node.adopted !== undefined) {
      // History, read off the row: never live, never revived, and nothing beneath it to walk.
      const ended = node.terminated?.outcome === "success" && node.adopted.outputs !== undefined;
      if (!ended) awaited.push(node.id);
      else loadedOps += 1;
      return {
        id: node.id,
        stateId: adoptedStandInId(node.stateId),
        ...(node.childKey !== undefined ? { childKey: node.childKey } : {}),
        occurrence,
        inputs: node.inputs as Record<string, ResolvedValue>,
        live: false,
        outcome: "success",
        operation: { value: (node.adopted.outputs ?? {}) as ResolvedValue },
      };
    }
    const children: LoadedInstance[] = [];
    const unanswered: Array<{ key: string; at: number }> = [];
    // Occurrence counts entries under one key IN THIS PARENT, superseded included — a loop's second
    // iteration is occurrence 1 whether or not the first was cleared. The ELEMENTS of one fan-out
    // entry share an occurrence (`occurrenceOf`): a batch is one entry, however many it ran.
    const seen = new Map<string, number>();
    let anyChildLive = false;
    for (const child of node.children) {
      const key = child.childKey ?? "";
      const childOccurrence = occurrenceOf(seen, key, child.element);
      // A sequence reset disowned it: history whose entry still counts, and nothing to load.
      if (child.superseded) continue;
      // The revival rule (see the header): still-running continues, and an unhandled non-success
      // end — nothing advanced past it — is work interrupted, presented live so it re-enters.
      // `skipped` is never revived: a person stepped past it, which is an answer and not an
      // interruption — wherever its row landed relative to the transition that decided it.
      const childLive =
        live &&
        child.adopted === undefined &&
        (child.terminated === undefined ||
          (child.terminated.outcome !== "success" && child.terminated.outcome !== "skipped" && child.terminated.at > node.advancedAt));
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
    // A conversation a move made starts idle — see the header.
    const idle = !stateHasOp && node === root && inDocument && shape[node.stateId]?.operation?.kind === "prompt" && hasChildren(shape[node.stateId]?.children);
    const operation = stateHasOp ? operationOf(node, required) : idle ? { value: IDLE_CONVERSATION_VALUE as ResolvedValue } : undefined;

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
      ...(node.element !== undefined ? { element: node.element } : {}),
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
      ...(live && node.directed !== undefined ? { directed: node.directed as NonNullable<LoadedInstance["directed"]> } : {}),
      ...(live && node.descent !== undefined && node.descent.path.length > 0 ? { descent: node.descent } : {}),
      // Settled fields are used verbatim by `loadRun` and never re-evaluated; an absent one is.
      ...(node.fields.size > 0 ? { fields: Object.fromEntries(node.fields) } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  };

  const rootLive = root.terminated === undefined || root.terminated.outcome !== "success";
  const loaded = emit(root, rootLive, 0, []);
  if (awaited.length > 0) {
    const names = awaited.map((id) => `'${project.tasks.tryRead(id)?.title ?? id}'`).join(", ");
    return none(`it adopted ${names}, which ${awaited.length === 1 ? "has" : "have"} not completed — it continues when ${awaited.length === 1 ? "that does" : "they do"}`);
  }
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
  return address.map((step) => `${step.childKey}#${step.occurrence}${step.element === undefined ? "" : `[${step.element}]`}`).join("/");
}

/**
 * The occurrence of the next entry under `key`, counting it — with one rule for a fan-out's elements
 * (WORKFLOWS.md §6.2): the batch is ONE entry, so its first element takes a fresh occurrence and the
 * rest share it. Entries arrive in journal order, so "the rest" are the elements that follow with a
 * position above 0; a new batch begins the moment a position 0 appears again.
 *
 * Shared by the fold and the projection because the two must agree to the number: an address the
 * projection stamps is compared against an address the load computed, and a walk that counted the
 * elements as passes would put the second element in a different place than the engine did.
 */
export function occurrenceOf(seen: Map<string, number>, key: string, element: number | undefined): number {
  if (element !== undefined && element > 0) return Math.max(0, (seen.get(key) ?? 1) - 1);
  const occurrence = seen.get(key) ?? 0;
  seen.set(key, occurrence + 1);
  return occurrence;
}
