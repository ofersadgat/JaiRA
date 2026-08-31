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
 * fresh (UUIDv7) as the engine walks, so a re-walk mints its own and the two runs never agree.
 * The content hash is wrong for a different reason — a loop dispatching the identical operation
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
import type { AddressStep as ViewAddressStep, InstanceNode } from "@jaira/shared";
import { SqliteEventLog } from "./eventLog";
import { eventsOf, foldRuns, isLive, projectRun, type ProjectedRun } from "./projection";
import { hydrate } from "./blobStore";
import { ON_RECORD, scopedSessionId } from "./sessionStore";
import { parseSessionRef } from "./views";
import type { JairaDb } from "./db";
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
 * hw's address shape and the one the RENDERER reads are the same shape, checked here.
 *
 * `@jaira/shared` cannot import the engine — it is what the browser gets — so it restates the step
 * (`AddressStep` there) and this is what stops the two from drifting. A field added upstream, or a
 * name changed on either side, fails this build instead of quietly becoming a second vocabulary in
 * which every address comparison silently stops matching.
 */
const _addressShapesAgree: ViewAddressStep = undefined as unknown as InstanceAddressStep;
const _addressShapesAgreeBack: InstanceAddressStep = undefined as unknown as ViewAddressStep;
void _addressShapesAgree;
void _addressShapesAgreeBack;

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
  instanceId: string;
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
  instanceId: string;
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
  /**
   * Where the run about to start will begin doing its OWN work — see {@link forkPointOf}.
   *
   * The first address, in walk order, that {@link answers} cannot answer: everything before it will
   * be replayed, and this is the first thing dispatched. That is the boundary a run-scale fork mark
   * is drawn at, and recording it is the whole reason it is computed here rather than guessed later
   * from the shape of what the run left behind.
   *
   * Absent when every recorded address is answered — the run picks up past the end of what the tree
   * holds, so it diverges from nothing that was drawn.
   */
  forkPoint?: InstanceAddress;
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
    const value = valueOf(project.db, row.result_json, event.op);
    if (value === undefined) {
      unreadable.push({ address, stateId: event.stateId, reason: "the record holds no readable value" });
      continue;
    }
    answers.set(addressKey(address), { address, stateId: event.stateId, instanceId: event.instanceId, value });
  }

  return { taskId, runId, answers, frontier: frontierOf(instances), unreadable };
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
 * The FRONTIER comes from the folded tree — every run merged by position (`foldRuns`) — and not from
 * the last run alone. It used to, on the reasoning that only the run that stopped can say where the
 * task stopped, and an earlier run's live leaves are how it looked when it was superseded. That holds
 * only while a later run always gets at least as far as an earlier one. A resume that fails BEHIND
 * the frontier breaks it: run 10 replayed five calls, died at `verdict`, and terminated every
 * instance on the way out — so the task's edge at `confidence` vanished and the strip offered a retry
 * of a task that had a perfectly good frontier two runs back.
 *
 * A replay failing short of the frontier is a defect rather than a state to model, and each one gets
 * fixed where it lives. Until none are left, the fold is what keeps the edge from being forgotten by
 * an attempt that never reached it.
 *
 * `unreadable` is folded over the SAME runs as `answers`, and then filtered by what the fold
 * produced. Taking it from the last run alone was wrong in a way that defeated the guard it feeds: a
 * hole in run 1's record left that address with no answer, and if run 2 stopped before reaching it,
 * run 2 reported nothing unreadable and `resumeTask` proceeded — dispatching an operation whose side
 * effects had already landed. The rule is the one the caller actually needs: an address is a problem
 * if, after everything is folded, nothing can answer it.
 */
export function buildTaskReplay(project: Project, taskId: string): RunReplay {
  const runs = project.runtime.listRuns(taskId);
  const last = runs[runs.length - 1];
  if (last === undefined) {
    return { taskId, runId: 0, answers: new Map(), frontier: [], unreadable: [] };
  }
  const answers = new Map<string, ReplayAnswer>();
  const holes: Array<{ address: InstanceAddress; stateId: string; reason: string }> = [];
  const projected: Array<{ runId: number; run: ProjectedRun }> = [];
  for (const run of runs) {
    const one = buildRunReplay(project, taskId, run.id);
    for (const [address, answer] of one.answers) answers.set(address, answer);
    holes.push(...one.unreadable);
    const { events } = eventsOf(new SqliteEventLog(project.db).list(taskId, { runId: run.id }));
    projected.push({ runId: run.id, run: projectRun(events) });
  }
  // A later run that re-dispatched the address and recorded it properly has REPAIRED the hole, so
  // reporting it would refuse a resume that is now perfectly safe. Only a hole nothing filled counts.
  const unreadable = holes.filter((hole) => !answers.has(addressKey(hole.address)));
  const folded = foldRuns(projected).instances;
  const forkPoint = forkPointOf(folded, answers);
  return {
    taskId,
    runId: last.id,
    answers,
    frontier: frontierOf(folded),
    unreadable,
    ...(forkPoint !== undefined ? { forkPoint } : {}),
  };
}

/**
 * The first address a resumed run will DISPATCH rather than replay — where its own work begins.
 *
 * Everything before it in walk order has a recorded answer and will be served from it, so it is
 * shared with whichever earlier runs produced it. Everything from here is the new run's. That single
 * boundary is the whole content of a run-scale fork, and it is knowable now — before the walk — for
 * both kinds of resume, which is why it is written down rather than reconstructed afterwards from
 * what the finished run happens to have left behind.
 *
 * ONE rule covers both kinds, and that is the argument for stating it this way:
 *
 *  - **continue** — the process died inside an operation, so that operation never completed and has
 *    no answer. It is the first unanswered address, and it is the frontier.
 *  - **retry** — a state FAILED. `buildRunReplay` records answers for completed operations only, so
 *    a failed one has none either, and the same walk lands on it.
 *
 * Walk order is the tree's own order, which is entry order: `projectRun` appends each child as it is
 * entered, so a depth-first walk visits addresses in the order the engine reached them.
 *
 * `undefined` when every address in the tree is answered — the run resumes past the end of what was
 * recorded and diverges from nothing anybody can see. Distinct from an EMPTY address, which is the
 * root and means the run shares nothing at all.
 */
export function forkPointOf(
  roots: readonly InstanceNode[],
  answers: ReadonlyMap<string, ReplayAnswer>,
): InstanceAddress | undefined {
  let found: InstanceAddress | undefined;
  const walk = (nodes: readonly InstanceNode[], prefix: InstanceAddress): void => {
    const seen = new Map<string, number>();
    for (const node of nodes) {
      if (found !== undefined) return;
      let address = prefix;
      if (node.childKey !== undefined) {
        const occurrence = seen.get(node.childKey) ?? 0;
        seen.set(node.childKey, occurrence + 1);
        address = [...prefix, { childKey: node.childKey, occurrence }];
      }
      // Superseded is not somewhere a resume goes — a sequence reset disowned it — and counting it
      // as unanswered would put the boundary inside history the engine has already abandoned. The
      // occurrence still counted above, for the reason `addressesOf` gives.
      if (node.superseded) continue;
      // A COMPOSITE answers nothing itself; its children are the operations. Only a leaf can be the
      // place where dispatching resumes, so only a leaf can be the boundary.
      if (node.children.length === 0 && !answers.has(addressKey(address))) {
        found = address;
        return;
      }
      walk(node.children, address);
    }
  };
  walk(roots, []);
  return found;
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
function addressesOf(roots: readonly InstanceNode[]): Map<string, InstanceAddress> {
  const out = new Map<string, InstanceAddress>();
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

/**
 * A leaf a STOP caught in the middle of its operation.
 *
 * A crash leaves instances live, because nothing ran to tidy them up. A cancel does not: the abort
 * unwinds the tree on the way out and terminates every instance it passes, so by the time the run
 * settles there is nothing live anywhere — and a frontier read off liveness alone is empty for
 * every stopped run, whatever it was in the middle of.
 *
 * That made the two ways of stopping report differently about the same fact. `isStartableStatus`
 * already says they are the same fact: "a stop is an INTERRUPTION — the difference between it and a
 * crash is who caused it, which is not a fact about whether there is anything left to pick up." The
 * frontier is the half that never got the message, so a run stopped on a human gate came back
 * offering `retry` — the word for a state that FAILED — about a state that did nothing wrong.
 *
 * The signature is exact and it is not "status is canceled". It is an operation that STARTED and
 * never settled: `completed` has its answer in the replay index and is walked past, `failed` is a
 * genuine retry and keeps that word, and a composite has no operation of its own, so an ancestor
 * the same abort terminated cannot match. What is left is the one instance the process was actually
 * inside — which is what a frontier is.
 */
function stoppedInside(node: InstanceNode): boolean {
  return !node.superseded && node.status === "canceled" && node.operation?.status === "running";
}

/** Live leaves — a live instance with no live child under it, plus whatever a stop caught mid-operation. */
function frontierOf(roots: readonly InstanceNode[]): FrontierEntry[] {
  const out: FrontierEntry[] = [];
  /** How many frontier entries this subtree contributed — see the descent rule below. */
  const walk = (nodes: readonly InstanceNode[], prefix: InstanceAddress): number => {
    let pushed = 0;
    // Counted over ALL siblings, live or not — the same rule `addressesOf` follows, and it has to be
    // the same or the two disagree about which occurrence a live instance is. Descending only into
    // the live ones (as this used to, reading a precomputed map) would renumber a second iteration
    // back to 0 the moment the first was cleared.
    const seen = new Map<string, number>();
    for (const node of nodes) {
      let address = prefix;
      if (node.childKey !== undefined) {
        const occurrence = seen.get(node.childKey) ?? 0;
        seen.set(node.childKey, occurrence + 1);
        address = [...prefix, { childKey: node.childKey, occurrence }];
      }
      // SUPERSEDED is the only subtree never descended into: a sequence reset abandoned it, and a
      // node left "running" inside one is history rather than somewhere to resume.
      if (node.superseded) continue;
      // Descend through a TERMINATED node, which the single-run walk never had to do. In a folded
      // tree the ancestors come from the newest run and the tail from an older one, so a failed
      // `feature` can sit above a live `confidence` — and stopping at the first non-live node found
      // no frontier at all on exactly the task this fold exists for. Depth-first and count what came
      // back: a node is the frontier only when it is live and nothing deeper is.
      if (walk(node.children, address) > 0) {
        pushed += 1;
        continue;
      }
      if (!isLive(node) && !stoppedInside(node)) continue;
      out.push({
        address,
        stateId: node.stateId,
        instanceId: node.instanceId,
        // The operation is `running` exactly while it has started and not settled — which for a
        // stopped run means the process died inside it.
        stopped: node.operation?.status === "running" ? "mid-operation" : "between-children",
      });
      pushed += 1;
    }
    return pushed;
  };
  walk(roots, []);
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
 * The value out of a record's payload — undoing the choice `withRecord` made when it wrote the row.
 *
 * Records are written `{ value }` by `withRecord`, and a row that is not that shape is left alone
 * rather than guessed at — the same rule `foldNativeCapture` follows, and for the same reason: a
 * wrong unwrapping here would feed the engine a value the call never returned.
 *
 * One level is NOT always enough, and the extra one is the whole reason a resumed run could fail on
 * a state that had already succeeded. `withRecord` stores `result.record` when the executor reported
 * one and `result.value` only when it did not, and for a PROMPT op those are different objects: the
 * payload is the whole `LlmOutput` — the op's value plus reasoning, tool trace, messages, finish
 * reason — because a record says what the call PRODUCED, not the one field the op happened to
 * declare. hw wants the other one: `ReplayedOperation.value` becomes `.operation.output`, which is
 * what a state's outputs bind through, so handing it the payload makes every
 * `.operation.output.<name>` binding resolve to nothing and the state fail "required output '<name>'
 * was not produced" — on a replay of a call that answered perfectly the first time.
 *
 * Which of the two is in a given row is NOT a per-call flag to be recovered. `ctx.returnRecord` is
 * what an executor answers, and `withRecord` sets it UNCONDITIONALLY on every call it records; the
 * memo normalizes the same way (ask for everything, store everything, serve what was asked) and
 * `withMetrics` names `record` explicitly so retry/budget/memo rebuilds carry it rather than dropping
 * it. So the request is invariant, and what actually varies is whether the executor IMPLEMENTS it:
 * the prompt family does — agent executors included, since they override only `lower` and `invoke`
 * and inherit the phase that reports it — and the scripted executor does not.
 *
 * So a prompt payload is projected the way `projectLlmOutput` projects it live, and detection is the
 * event's op kind AND `finishReason`, not either alone. The kind alone is wrong because a SCRIPTED
 * prompt executor reports no payload, so its row already holds the flat value — which is exactly why
 * the faked tests stayed green while every real workflow failed here. `finishReason` alone is wrong
 * because nothing stops a function op from returning an object that happens to carry the field. It
 * is the payload type's one REQUIRED field, so its presence on a prompt row is a contract rather
 * than a guess — even the stub written for a call that produced nothing is `{ finishReason: "error" }`.
 *
 * The one shape the pair cannot separate is a payload with no `value` — indistinguishable from a flat
 * value that carries a `finishReason` of its own. Both fall through as unreadable, which is the
 * honest answer for either: `resumeTask` names the operation and declines instead of replaying a
 * value it had to invent. In practice only a FAILED call records that shape, and a failed record is
 * already filtered out above as the frontier.
 *
 * The blob rule is deliberately NOT reproduced. Live, a blob-kind prompt output projects to
 * `files[0].bytes`; this module cannot see `op.output.kind`, and bytes do not survive the row's JSON
 * anyway. Such a payload carries no `value` either, so it lands on the same refusal.
 */
function valueOf(db: JairaDb, resultJson: string | null, op?: string): JsonValue | undefined {
  if (resultJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return undefined;
  }
  // HYDRATED, like every other reader of `result_json` (see `sessionStore`). A record does not store
  // its big string leaves any more — since RECORDS.md §8 they are written once by content hash and
  // the record keeps `{"$blob": "<sha>"}` in their place — so a raw parse hands back the reference
  // instead of the value.
  //
  // That is not a cosmetic difference to a replayed answer. A state whose output is `kind: "blob"`
  // takes a string and makes an artifact of it; handed an object with one reserved key it refuses,
  // and the resume dies on the first state that produced a document — which for any real workflow
  // is the first state. The threshold is 1 KB, so a fixture answering "ok" replays perfectly and
  // everything that does actual work does not, which is why this survived its tests.
  const hydrated = hydrate(db, parsed as JsonValue);
  if (hydrated === null || typeof hydrated !== "object" || Array.isArray(hydrated)) return undefined;
  const value = (hydrated as { value?: JsonValue }).value;
  if (value === undefined) return undefined;
  return isLlmPayload(value, op) ? (value as { value?: JsonValue }).value : value;
}

/** Whether a prompt record's stored payload is an `LlmOutput` rather than the projected value.
 *  `finishReason` is the payload's one REQUIRED field — even the stub written for a call that
 *  produced nothing is `{ finishReason: "error" }` — so its presence on a prompt op's row is what
 *  says the projection still has to be applied. */
function isLlmPayload(value: JsonValue, op?: string): boolean {
  return (
    op === "prompt" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { finishReason?: unknown }).finishReason === "string"
  );
}
