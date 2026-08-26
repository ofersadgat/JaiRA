/**
 * What a stopped run can tell a resumed one — the replay index (DESIGN §4.3, revised).
 *
 * v1 recovery re-runs an interrupted task from the top. A real resume instead walks the workflow
 * again and, at every operation the recorded run already answered, hands back the answer rather than
 * dispatching. The engine then rebuilds its own instance tree by re-walking, computes outputs with
 * its own `finish()`, and only starts spending again at the frontier. Nothing is reimplemented out
 * here, and — the point of the whole shape — nothing side-effecting runs twice, because an operation
 * that already ran is never dispatched.
 *
 * This module is the half that needs no engine change: it answers *what did this run already do*,
 * and *where did it stop*. The seam that consumes it is `@declarative-ai/hw`'s to add.
 *
 * ## Why the address is structural
 *
 * The obvious key for "which operation is this" is the instance id, and it is wrong: ids are minted
 * `nextInstanceId++` as the engine walks, so a re-walk mints its own and the two runs agree only by
 * luck. The content hash is wrong for a different reason — a loop dispatching the identical operation
 * twice hashes identically, which is exactly why `operation_records.attempt` exists.
 *
 * So an instance is addressed by its POSITION IN THE TREE: the chain of child keys from the root,
 * each with an occurrence index, because a loop re-enters the same key. That is stable across runs
 * of the same pinned definition, which is the only thing a replay is ever compared against.
 *
 * ## One operation per instance
 *
 * SPEC §7.1: a state has ONE operation, and hw's `Instance.opRun` is a boolean that is set once and
 * never cleared. So the address alone identifies an operation — there is no ordinal — and a retry is
 * not a second operation but a second `attempt` inside the executor stack, below the engine's view.
 *
 * ## Only completed operations are answers
 *
 * A record still `open`, or settled `failed`, is not something to replay: it is precisely where the
 * run stopped, and re-entering means running it for real. That makes `operation_records.status` the
 * whole filter, and it is why a failed task resumes by retrying the state that failed rather than by
 * skipping past it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ResolvedValue } from "@declarative-ai/exec";
import type {
  InstanceAddress as HwAddress,
  InstanceAddressStep,
  ReplayedOperation,
  ReplaySource,
} from "@declarative-ai/hw";
import type { InstanceNode } from "@jaira/shared";
import { SqliteEventLog } from "./eventLog";
import { eventsOf, isLive, projectRun } from "./projection";
import { ON_RECORD, scopedSessionId } from "./sessionStore";
import { parseSessionRef } from "./views";
import type { Project } from "./project";

/**
 * The address types are hw's, re-exported rather than restated.
 *
 * They are the CONTRACT between this index and the engine that consumes it — the engine computes an
 * address as it walks and this module computes the same address from the journal, and the two have
 * to be the same thing or every lookup misses. A structurally identical local copy would typecheck
 * and would silently stop matching the day either side gained a field.
 */
export type AddressStep = InstanceAddressStep;
export type InstanceAddress = HwAddress;

/**
 * The canonical string form, and the map key.
 *
 * The root is the empty address and therefore the empty string, which is a legal key and reads as
 * "the run itself" in a log line. Occurrence is always written, even at 0: a reader comparing two
 * addresses should not have to know that a missing index means the first.
 */
export function addressKey(address: InstanceAddress): string {
  return address.map((step) => `${step.childKey}#${step.occurrence}`).join("/");
}

/** What one instance's operation returned, for an operation the recorded run COMPLETED. */
export interface ReplayAnswer {
  address: InstanceAddress;
  stateId: string;
  /** The id the recorded run minted. Diagnostics only — never an address. */
  instanceId: number;
  /** The value the call produced, unwrapped from the record's `{ value }` envelope. */
  value: JsonValue;
}

/**
 * A live leaf: somewhere the resumed run picks up spending again.
 *
 * A SET rather than a path, because an `async: true` child does not hold the cursor and several
 * instances can be live when the process dies. `activePathOf` is the wrong projection to build on
 * here — it takes one node per level, which is right for a board badge and lossy for this.
 */
export interface FrontierEntry {
  address: InstanceAddress;
  stateId: string;
  instanceId: number;
  /**
   * Which kind of stop this was.
   *
   * `mid-operation` is the one that carries risk: the call was dispatched and never settled, so its
   * side effects may have partly landed and re-entering re-does them. `between-children` is the
   * quiet case — the operation finished (its answer is in {@link RunReplay.answers}) and the run
   * stopped while deciding where to go next.
   */
  stopped: "mid-operation" | "between-children";
}

export interface RunReplay {
  taskId: string;
  runId: number;
  /**
   * Address key → what that instance's operation returned.
   *
   * Deliberately NOT disjoint from {@link frontier}: a leaf that completed its operation and stopped
   * while evaluating transitions appears in both, and correctly so. The re-walk serves its recorded
   * answer, then evaluates the transitions for real.
   */
  answers: ReadonlyMap<string, ReplayAnswer>;
  frontier: readonly FrontierEntry[];
  /**
   * Operations whose event says they completed but whose record could not be read back.
   *
   * Reported rather than dropped, because the difference matters to a caller: an operation with no
   * answer will be DISPATCHED on resume, and if it was one with side effects that is a double-apply
   * nobody asked for. Empty is the expected state; a non-empty list means resume is unsafe for this
   * run and the caller should say so rather than proceeding quietly.
   */
  unreadable: readonly { address: InstanceAddress; stateId: string; reason: string }[];
}

/** The record row a settled operation event points at. */
interface RecordRow {
  status: string;
  result_json: string | null;
}

/**
 * Build the replay index for one run.
 *
 * The tree comes from {@link projectRun} rather than a second fold of the same events: the board and
 * a resume must agree about what happened, and two folds are two chances to disagree. What is added
 * here is the addressing and the payload join, neither of which the board needs.
 */
export function buildRunReplay(project: Project, taskId: string, runId: number): RunReplay {
  const { events } = eventsOf(new SqliteEventLog(project.db).list(taskId, { runId }));
  const { instances } = projectRun(events);

  const addresses = addressesOf(instances);
  const answers = new Map<string, ReplayAnswer>();
  const unreadable: Array<{ address: InstanceAddress; stateId: string; reason: string }> = [];
  const queues = recordQueues(project, taskId, runId);

  for (const event of events) {
    // BOTH settled kinds walk this loop, though only completions become answers. A failed dispatch
    // consumed a record row, and skipping it here would hand the next completion of the same
    // operation somebody else's result — which is the whole hazard this pairing exists to avoid.
    if (event.type !== "operation.completed" && event.type !== "operation.failed") continue;
    const address = addresses.get(event.instanceId);
    // An event naming an instance the projection never built is a journal we cannot address into.
    // It is not silently skipped: an operation missing from the index is one the resume will run.
    if (address === undefined) {
      if (event.type === "operation.completed") {
        unreadable.push({ address: [], stateId: event.stateId, reason: `no instance ${event.instanceId} in the tree` });
      }
      continue;
    }
    const row = takeRecord(project, taskId, runId, queues, event);
    if (event.type !== "operation.completed") continue;
    if (row === undefined) {
      unreadable.push({ address, stateId: event.stateId, reason: "no operation record for this event" });
      continue;
    }
    // `completed` is the whole filter — see the header. A record settled `failed`, or left `open` by
    // a crash, is the frontier rather than an answer, and the projection has already put it there.
    if (row.status !== "completed") continue;
    const value = valueOf(row.result_json);
    if (value === undefined) {
      unreadable.push({ address, stateId: event.stateId, reason: "the record holds no readable value" });
      continue;
    }
    answers.set(addressKey(address), { address, stateId: event.stateId, instanceId: event.instanceId, value });
  }

  return { taskId, runId, answers, frontier: frontierOf(instances, addresses), unreadable };
}

/**
 * The index for a whole TASK — every run folded oldest-first, later answers winning.
 *
 * Which is what makes a second resume work, and the reason it cannot just be the last run. A
 * replayed operation never reaches the executor, so it writes no record: a resumed run's own store
 * holds only the operations it actually dispatched. Reading that run alone would lose everything the
 * original answered and re-run the lot.
 *
 * Later wins because a later run is a re-attempt: where run 2 actually dispatched an address that
 * run 1 had also answered, run 2 answered it more recently and is what the task last did.
 *
 * The FRONTIER comes from the last run alone. It is "where did this task stop", and only the run
 * that stopped can say — an earlier run's live leaves are just how it looked when it was superseded.
 */
export function buildTaskReplay(project: Project, taskId: string): RunReplay {
  const runs = project.runtime.listRuns(taskId);
  const last = runs[runs.length - 1];
  if (last === undefined) {
    return { taskId, runId: 0, answers: new Map(), frontier: [], unreadable: [] };
  }
  const answers = new Map<string, ReplayAnswer>();
  let latest: RunReplay | undefined;
  for (const run of runs) {
    latest = buildRunReplay(project, taskId, run.id);
    for (const [address, answer] of latest.answers) answers.set(address, answer);
  }
  return { taskId, runId: last.id, answers, frontier: latest!.frontier, unreadable: latest!.unreadable };
}

/**
 * A {@link ReplaySource} over an index — the shape hw's engine consumes.
 *
 * The address is the whole key, and `undefined` is how the frontier is expressed: the engine walks
 * until the answers run out and dispatches from there.
 */
export function replaySourceOf(replay: RunReplay): ReplaySource {
  return {
    operationAt: (address: InstanceAddress): ReplayedOperation | undefined => {
      const answer = replay.answers.get(addressKey(address));
      return answer === undefined ? undefined : { value: answer.value as ResolvedValue };
    },
  };
}

/**
 * Every instance's address, by the id the recorded run gave it.
 *
 * Occurrence counts entries under one key IN THIS PARENT, which is what `projectRun` already orders
 * correctly: `parent.children.push(node)` appends in entry order, so the nth node carrying a key is
 * the nth entry of it. Superseded siblings are counted rather than skipped — a loop's second
 * iteration is occurrence 1 whether or not the first was cleared, and renumbering it to 0 would make
 * the address of a live instance depend on history it does not own.
 */
function addressesOf(roots: readonly InstanceNode[]): Map<number, InstanceAddress> {
  const out = new Map<number, InstanceAddress>();
  const walk = (nodes: readonly InstanceNode[], prefix: InstanceAddress): void => {
    const seen = new Map<string, number>();
    for (const node of nodes) {
      // A root has no child key and therefore no step: the run itself is the empty address.
      let address = prefix;
      if (node.childKey !== undefined) {
        const occurrence = seen.get(node.childKey) ?? 0;
        seen.set(node.childKey, occurrence + 1);
        address = [...prefix, { childKey: node.childKey, occurrence }];
      }
      out.set(node.instanceId, address);
      walk(node.children, address);
    }
  };
  walk(roots, []);
  return out;
}

/** Live leaves — a live instance with no live child under it. */
function frontierOf(roots: readonly InstanceNode[], addresses: Map<number, InstanceAddress>): FrontierEntry[] {
  const out: FrontierEntry[] = [];
  const walk = (nodes: readonly InstanceNode[]): void => {
    for (const node of nodes) {
      if (!isLive(node)) continue;
      const live = node.children.filter(isLive);
      if (live.length > 0) {
        walk(live);
        continue;
      }
      out.push({
        address: addresses.get(node.instanceId) ?? [],
        stateId: node.stateId,
        instanceId: node.instanceId,
        // The operation is `running` exactly while it has started and not settled — which for a
        // stopped run means the process died inside it.
        stopped: node.operation?.status === "running" ? "mid-operation" : "between-children",
      });
    }
  };
  walk(roots);
  return out;
}

/**
 * Every settled record of the run, queued by content id in the order it was written.
 *
 * The content hash is NOT unique per call, and that is the trap this exists for: a loop dispatching
 * the identical operation three times writes three rows under one `record_id`, told apart only by
 * `attempt` — which is exactly what migration 8's unique index says. Reading "the record for this
 * `operationId`" therefore has to mean "the next one", not "the latest one", or every iteration of a
 * loop is handed the last iteration's answer.
 *
 * Ordered by `id` rather than by `attempt`, because insertion order is the thing actually being
 * paired against and `attempt` is derived from it. An executor-level retry does not add a row — the
 * open row is reused (`SqliteSessionStore.close`) — so a row here is one engine dispatch.
 */
function recordQueues(project: Project, taskId: string, runId: number): Map<string, RecordRow[]> {
  const rows = project.db
    .prepare(
      `SELECT record_id, status, result_json FROM operation_records
        WHERE task_id IS ? AND run_id IS ? AND status != 'open'
        ORDER BY id`,
    )
    .all(taskId, runId) as Array<RecordRow & { record_id: string }>;
  const out = new Map<string, RecordRow[]>();
  for (const row of rows) {
    const queue = out.get(row.record_id);
    if (queue) queue.push(row);
    else out.set(row.record_id, [row]);
  }
  return out;
}

/**
 * The record a settled operation event points at — through whichever of the two joins applies.
 *
 * **The POSITION first, wherever there is one, and the order is the whole correctness of this.** A
 * settled event carries BOTH ids: `operationId` (the content hash) and `metrics.sessionRef` (the
 * seat the call took). But a PLACED call's record is keyed by that seat — `withRecord` names it
 * `<session>:<seq>` — and nothing was ever written under the hash, so reaching for the hash first
 * finds nothing and reports every prompt and every agent call as unreadable. Which is what it did:
 * the whole feature fell back to "start over" on any workflow that talks to a model, because the
 * fixtures were all interactive gates and a gate is unplaced.
 *
 * An UNPLACED call (a pure helper, a gate, an embedded call) has no seat, and its content hash is
 * NOT unique — a loop dispatching the identical operation writes one row per dispatch, told apart by
 * `attempt`. So those are CONSUMED from the queue above: one row per settled event, in order.
 *
 * The known imprecision on that queue, stated because it fails safe rather than silently: if a
 * crashed dispatch left a row and a LATER identical dispatch settled, the pairing hands the later
 * event the earlier row. That yields no readable value, so the operation lands in `unreadable` and
 * the caller is told resume would re-dispatch it — the conservative answer, not a wrong one.
 */
function takeRecord(
  project: Project,
  taskId: string,
  runId: number,
  queues: Map<string, RecordRow[]>,
  event: { operationId?: string; metrics?: { sessionRef?: string } },
): RecordRow | undefined {
  const ref = event.metrics?.sessionRef;
  const position = ref === undefined ? undefined : parseSessionRef(ref);
  if (position !== undefined) {
    return (
      project.db
        .prepare(
          `SELECT r.status, r.result_json FROM session_positions p
             JOIN operation_records r ON ${ON_RECORD}
            WHERE p.session_id = ? AND p.seq = ?`,
        )
        // Two adjustments, both easy to omit and each fatal on its own. The id is SCOPED — a session
        // name is instance-scoped and instance ids restart every run, so the store namespaces every
        // row by the run that made it. And the seq is one BACK from where the call ended, which is
        // `sessionRef`'s documented contract and the same arithmetic `stateSessions` does.
        .get(scopedSessionId({ taskId, runId }, position.id), position.seq - 1) as RecordRow | undefined
    );
  }
  if (event.operationId !== undefined) return queues.get(event.operationId)?.shift();
  return undefined;
}

/**
 * The value out of a record's payload.
 *
 * Records are written `{ value }` by `withRecord`, and a row that is not that shape is left alone
 * rather than guessed at — the same rule `foldNativeCapture` follows, and for the same reason: a
 * wrong unwrapping here would feed the engine a value the call never returned.
 */
function valueOf(resultJson: string | null): JsonValue | undefined {
  if (resultJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = (parsed as { value?: JsonValue }).value;
  return value === undefined ? undefined : value;
}
