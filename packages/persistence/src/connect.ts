/**
 * `connect(task, target)` (decision 0005 §1, step 5) — the resolution, and its composition.
 *
 * One operation behind the board's drop, a conversation's `move` tool and `jaira task move`. It owns
 * no mechanism: a move is `task_move` (the host's `move`), an adoption is `adopt.ts`, a modified
 * workflow is `dynamicDocuments.ts`. What is here is the ORDER they are tried in, the question each
 * is asked, and the one thing none of them answers on its own — whether the target's inputs will
 * bind once the task stands there.
 *
 * ## Three resolutions, in order
 *
 *  1. **The target is in the task's workflow** (`resolveWithin`). The pinned definition is searched
 *     for a mount of the target, and the MOVE TABLE judges it (`@jaira/shared` `move.ts`, the rulings
 *     of 2026-09-22; `moveLegality.ts` reads where it is): entered already is BEHIND — a backward move,
 *     taken now if an engine holds the task, which a working task asks first; reachable through the
 *     transitions the workflow defines is AHEAD — a FAST-FORWARD (step 7): no transition at all, the
 *     host is asked for the mode (`ConnectHost.fastForward`) and the machine runs the states between,
 *     its conversation answering on the way; a rule already waiting on exactly this move is answered
 *     instead. Neither is ILLEGAL and refused with why — unless nothing at all is defined ahead of
 *     where the task stands (a finished task), which makes the move a new transition: rule 3.
 *  2. **A real workflow holds both** (`candidatesFor`): a composite that mounts the task's root state
 *     and the target as children — or IS the target, and mounts the task's state. One such workflow
 *     adopts the task into a new task of it, and rule 1 takes that task to the target. More than one
 *     is returned as candidates: the caller asks, and calls again naming one. Nothing is guessed.
 *  3. **The workflow is modified** (`generateDocumentVersion`): `new` for a task that finished alone
 *     — the document is made, its task is made, and the source is ADOPTED into it as the first child,
 *     which is the composition step 4 left to this one — `augmented` for a task already in a
 *     document, `cloned` for one standing inside a real workflow. Then the move.
 *
 * ## Inputs bind, are supplied, or the connect is refused
 *
 * Every resolution ends by settling the target's inputs. The workflow's own bindings come first: a
 * wire whose producers have run, a literal, a slot's own default. `unboundInputs` decides that
 * statically from the lowered definition and the loaded machine, for the target and for every
 * ancestor entered on the way down to it. What they leave open a conversation may supply
 * (`request.supplied`, step 6), and each supplied value is journaled with how it was settled
 * (`jaira.supplied`). A required input still open is ASKED in the task's own conversation: the host
 * parks a question there (`ConnectHost.ask`) and the move is taken when it is answered, the values
 * recorded `asked` (the rulings of 2026-09-22, 2). A host that cannot ask (the CLI) refuses with the
 * input, its declared schema and description, and why.
 *
 * ## Another workflow, or a new transition
 *
 * Rules 2 and 3 are the table's last row: a working task is asked first ("pause and move?"), and a
 * task an engine holds is paused before anything is written (`ConnectHost.pause`) — an adopted one
 * resumed again as the child it now is.
 *
 * ## Written down before it is done, and finished as it was meant
 *
 * A real connect decides everything first — the resolution, the plan, the steps — and then journals
 * that INTENT on the dragged task before it writes anything (`jaira.connect`, {@link begin}). Each
 * step marks itself done with what it made; a `done` row closes it. A connect that stops part-way —
 * a refusal, a throw, a process that died — leaves its intent open, and the same drop again (or the
 * app's next open, for one that was cut off) carries out only the steps not yet done
 * ({@link finishConnect}), from the intent's own request and plan: never a second resolution against
 * what the first attempt left behind, and so never a second document version, a second adoption or a
 * different refusal. Every step also recognises its own unmarked write, for the one gap rows cannot
 * close. The intent rows are also what the connect's Undo is measured from (`connectUndo.ts`).
 *
 * ## §0
 *
 * Nothing here reads or writes a workflow's input by name. The conversation state that roots a new
 * document may declare inputs of its own; they are filled by SCHEMA — a required input that takes
 * a string is given the sentence that says what the person did — and anything else refuses.
 */
import type { FunctionCapabilities, JsonValue } from "@declarative-ai/exec";
import { sourceStateId, type EngineEvent, type LoadedInstance, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import { createLogger } from "@declarative-ai/log";
import type {
  AdoptAsk,
  AdoptPlan,
  ConnectCandidate,
  ConnectInput,
  ConnectMissingInput,
  ConnectMove,
  ConnectPlan,
  ConnectRefusal,
  ConnectUndo,
  InputProvenance,
  TaskAdoptRequest,
  TaskAdoptResult,
  TaskConnectRequest,
  TaskConnectResult,
  TaskFastForwardRequest,
  TaskFastForwardResult,
  TaskMoveRequest,
  TaskMoveResult,
  WorkflowBrowser,
} from "@jaira/shared";
import {
  ApprovalRequired,
  FAST_FORWARD_EVENT,
  MOVE_HELD_EVENT,
  REOPENED_EVENT,
  SUPPLIED_EVENT,
  type ConnectIntent,
  type ConnectStep,
  type ConnectStepResult,
  type ConnectSupplied,
  type FastForwardEvent,
  type SuppliedEvent,
  isLive,
  judgeMove,
  type HeldMoveRequest,
  type MoveJudgement,
  type MoveWhere,
  type TaskActivity,
} from "@jaira/shared";
import { randomUUID } from "node:crypto";
import { childrenReadBy, missingInputs, plainInputOf, planAdoption, writeAdoption, type ValueCheck } from "./adopt";
import { DYNAMIC_ROOT_PREFIX, listDocuments, loadPinnedBundle, tryReadDocument, type FrozenDocument } from "./documents";
import { generateDocumentVersion, type GenerateVersionResult } from "./dynamicDocuments";
import { createTask, pinWorkflow } from "./lifecycle";
import { buildTaskLoad } from "./load";
import { dropConnectUndo } from "./connectUndo";
import { openConnectIntent, recordConnectRow, type OpenConnectIntent } from "./hostRows";
import { activityFromRow, enteredPaths, reachAhead, unreachableSentence, whereIs } from "./moveLegality";
import type { Project } from "./project";
import { bundleFor } from "./views";
import { browseWorkflows } from "./workflows";
import { workflowLoadOptions } from "./workflowRefs";

const log = createLogger("jaira.persistence.connect");

/**
 * THE conversation a dynamic workflow's root is, when a MOVE makes one: `chat/control` — holding only
 * the task and workflow tools (decision 0005 §3, shipped in the built-in layer by step 6).
 *
 * Never what a conversation's own `start` uses: a `chat/session` that starts work keeps its own root,
 * and stays a session.
 */
export const CONNECT_CONVERSATION = "chat/control";

/** What the host lends a connect: its validator, its engine, and what only a running process knows. */
export interface ConnectHost {
  /** The run's own validator — adoption's schema fit, and whether a conversation input takes a string. */
  check?: ValueCheck;
  functions?: ReadonlyMap<string, FunctionCapabilities>;
  /** The conversation state a new document is rooted in. Absent ⇒ {@link CONNECT_CONVERSATION}. */
  conversation?: string;
  /** The `to_state`s transitions of this task are waiting on right now (`on_user_event`). */
  offered?: (taskId: string) => readonly string[];
  /** Whether an engine is running this task — here, or in another process. */
  running?: (taskId: string) => boolean;
  /**
   * What the task is DOING — the move table's columns. Only a host with the hubs can tell waiting for
   * the person from working; absent ⇒ what the row and the parked gates say (`activityFromRow`).
   */
  activity?: (taskId: string) => TaskActivity;
  /**
   * PAUSE the task and wait its run out — what a move into another workflow, or along a new
   * transition, does first to a task an engine holds. Absent ⇒ such a task is refused, saying to pause it.
   */
  pause?(taskId: string): Promise<void>;
  /** Resume a task a move paused and adopted, so it goes on as the child it now is. */
  resume?(taskId: string): Promise<void>;
  /**
   * ASK for the inputs a legal move still lacks, in the task's own conversation: park the question
   * and answer its request id. The move is taken when it is answered. Absent ⇒ such a move is refused
   * with what is missing.
   */
  ask?(question: MoveQuestion): Promise<{ requestId: string }>;
  /** The workflow roots and their closures — `browseWorkflows`, which a host may have cached. */
  browser?: () => WorkflowBrowser;
  /** ADOPT — the host's `task:adopt`. */
  adopt(request: TaskAdoptRequest): Promise<TaskAdoptResult>;
  /** `task_move`, published — the host's `task:move`. */
  move(request: TaskMoveRequest): Promise<TaskMoveResult>;
  /**
   * RUN the machine to the target (§4) — the host's `task:fastForward`.
   *
   * Absent for a host that cannot drive a run (the CLI, a test double), and then a forward move that
   * would step over states is refused with {@link fastForwardRefusal}, as it was before step 7. That
   * refusal is not a fallback so much as the truth: there is nobody here to answer on the way.
   */
  fastForward?(request: TaskFastForwardRequest): Promise<TaskFastForwardResult>;
  /**
   * Why THIS task cannot be run forward right now, if it cannot — asked before anything is written,
   * and by a dry run too, so a hover says what a drop would be refused for. A running task with no
   * conversation (its engine cannot pick one up), a task with nothing left to run.
   */
  fastForwardBlocked?(taskId: string): string | undefined;
  /**
   * Told of each step of a connect's intent just before it runs (`finishConnect`) — a host's
   * progress line, and the seam a test stops a connect part-way at: a throw here is a step that
   * failed, journaled `stopped` like any other.
   */
  onStep?(step: ConnectStep, index: number): void | Promise<void>;
}

/** The input question a move parks in the task's conversation — see {@link ConnectHost.ask}. */
export interface MoveQuestion {
  taskId: string;
  /** The moved task's title, for the question's heading. */
  title: string;
  /** The move, as it is asked again once answered. */
  move: HeldMoveRequest;
  /** The required inputs nothing binds. */
  missing: ConnectMissingInput[];
  /** Inputs of the target nothing binds that may be left out — asked in the same form, not required. */
  optional: ConnectMissingInput[];
  /** Where the task will stand, in words. */
  targetLabel: string;
}

const refused = (dryRun: boolean, refusal: ConnectRefusal, plan?: ConnectPlan): TaskConnectResult => ({ ok: false, dryRun, refusal, ...(plan !== undefined ? { plan } : {}) });

/** The table's cell for a move, with its sentence where it has one — see `@jaira/shared` `move.ts`. */
function judged(where: MoveWhere, activity: TaskActivity, title: string, target: string, at: { eventLeadsThere?: boolean; next?: boolean; illegal?: string } = {}): MoveJudgement {
  const cell = judgeMove(where, activity, at);
  const sentence =
    cell.way === "illegal"
      ? at.illegal
      : cell.confirm === "stop-and-rewind"
        ? `'${title}' is working. Stop it and go back to '${target}'? It is entered again as its next pass; what the task did since stays in its history.`
        : cell.confirm === "pause-and-move"
          ? `'${title}' is working. Pause it and move it to '${target}'?`
          : undefined;
  return { where, activity, ...cell, ...(sentence !== undefined ? { sentence } : {}) };
}

/**
 * An ASK cell the caller has not confirmed. A dry run carries the question on its plan — which is what
 * the board puts in front of the drop — and the real thing refuses with it, having done nothing.
 */
function unconfirmed(request: TaskConnectRequest, judgement: MoveJudgement, plan: ConnectPlan): TaskConnectResult | undefined {
  if (judgement.confirm === undefined || request.confirmed === true || request.dryRun === true) return undefined;
  return refused(false, { code: "confirm", message: judgement.sentence ?? "confirm the move first" }, plan);
}

/**
 * Park the question a legal move needs answered (the rulings of 2026-09-22, 2), and answer that the
 * move is waiting on it. Nothing else is written: the move is taken when it is answered.
 */
async function askFor(
  request: TaskConnectRequest,
  host: ConnectHost,
  at: { title: string; plan: ConnectPlan; missing: ConnectMissingInput[]; optional: ConnectMissingInput[]; path?: readonly string[] },
): Promise<TaskConnectResult> {
  const move: HeldMoveRequest = {
    target: request.target,
    by: request.by ?? "person",
    ...(request.workflow !== undefined ? { workflow: request.workflow } : {}),
    ...(at.path !== undefined ? { path: [...at.path] } : request.path !== undefined ? { path: [...request.path] } : {}),
    ...(skipOf(request) ? { skip: true } : {}),
    ...(request.confirmed === true ? { confirmed: true as const } : {}),
  };
  const targetLabel = at.plan.standsAt.label ?? (at.plan.standsAt.path.join("/") || sourceStateId(request.target));
  const { requestId } = await host.ask!({ taskId: request.taskId, title: at.title, move, missing: at.missing, optional: at.optional, targetLabel });
  log.info(`${request.taskId}: the move to '${request.target}' asks for ${at.missing.map((m) => `'${m.name}'`).join(", ")} in the task's conversation (${requestId})`);
  return { ok: true, dryRun: false, plan: at.plan, taskId: request.taskId, asked: { requestId, taskId: request.taskId, missing: at.missing } };
}

/** Of what is open, what the question can answer: the target's own inputs (an ancestor's are not handed over). */
const answerable = (open: readonly ConnectMissingInput[], target: string): boolean => open.every((m) => sourceStateId(m.state) === sourceStateId(target));

// ---------------------------------------------------------------------------------------------------
// the definition, searched
// ---------------------------------------------------------------------------------------------------

/** Every path of child keys from the bundle's root to a mount of `target`, shortest first. */
export function pathsTo(bundle: WorkflowBundle, target: string): string[][] {
  const wanted = sourceStateId(target);
  const found: string[][] = [];
  const walk = (stateId: string, keys: string[], above: ReadonlySet<string>): void => {
    const state = bundle.states[stateId];
    if (state === undefined || above.has(stateId)) return;
    const within = new Set(above).add(stateId);
    for (const [key, child] of Object.entries(state.children ?? {})) {
      const path = [...keys, key];
      if (sourceStateId(child.state) === wanted) found.push(path);
      walk(child.state, path, within);
    }
  };
  walk(bundle.rootId, [], new Set());
  return found.sort((a, b) => a.length - b.length);
}

/** The states along a path of child keys, root first: `[root, …, target]`. */
function statesAlong(bundle: WorkflowBundle, keys: readonly string[]): LoadedState[] {
  const out: LoadedState[] = [];
  let state = bundle.states[bundle.rootId];
  if (state !== undefined) out.push(state);
  for (const key of keys) {
    const next: LoadedState | undefined = state !== undefined ? bundle.states[state.children?.[key]?.state ?? ""] : undefined;
    if (next === undefined) break;
    out.push(next);
    state = next;
  }
  return out;
}

/** The latest entry under `node` — where, at this level, the task stands. Elements of one batch read as one. */
function lastChildOf(node: LoadedInstance): LoadedInstance | undefined {
  return (node.children ?? []).at(-1);
}

/** The child keys under `node` that have ended well — what a wire may read. */
function succeededUnder(node: LoadedInstance | undefined): Set<string> {
  const out = new Set<string>();
  for (const child of node?.children ?? []) {
    if (child.childKey === undefined) continue;
    if (!child.live && child.outcome === "success") out.add(child.childKey);
    else out.delete(child.childKey);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------------------------------

/** How a lowered wire reads, in words — for the preview, never for a decision. */
function wireFrom(ref: unknown): { via: ConnectInput["via"]; from?: string } {
  const plain = plainInputOf(ref);
  if (plain !== undefined) return { via: "wire", from: `inputs.${plain}` };
  const reads = [...childrenReadBy(ref)].filter((key) => key !== "*");
  if (reads.length > 0) return { via: "wire", from: reads.join(", ") };
  return { via: "literal" };
}

/**
 * The inputs of the state mounted at `key` under `parent`, settled statically.
 *
 * `available` is what the mount's wires may read: the children of the parent that have ended well
 * (and the one running now, which a held move waits for). A composite entered fresh on the way down
 * has none. A required input with no wire, or whose wire reads a child outside `available`, is
 * MISSING; an optional one is merely something a conversation could still be asked for.
 */
export function unboundInputs(
  bundle: WorkflowBundle,
  parent: LoadedState,
  key: string,
  available: ReadonlySet<string>,
): { inputs: ConnectInput[]; missing: ConnectMissingInput[]; asks: ConnectMissingInput[] } {
  const decl = parent.children?.[key];
  const state = decl !== undefined ? bundle.states[decl.state] : undefined;
  const inputs: ConnectInput[] = [];
  const missing: ConnectMissingInput[] = [];
  const asks: ConnectMissingInput[] = [];
  if (decl === undefined || state === undefined) return { inputs, missing, asks };
  // A standing rule to this child states wiring a move carries; the mount's own wins per name.
  const rule = (parent.transitions ?? []).find((t) => t.standing === true && t.to === key);
  const axes = new Set(decl.each ?? []);
  for (const [name, slot] of Object.entries(state.inputs ?? {})) {
    const meta = state.slotMeta?.[`inputs.${name}`];
    const required = meta?.optional !== true && meta?.default === undefined && meta?.defaultRef === undefined;
    const open = (reason: string): void => {
      (required ? missing : asks).push({
        state: sourceStateId(state.id),
        name,
        ...(slot.schema !== undefined ? { schema: slot.schema as JsonValue } : {}),
        ...(meta?.description !== undefined ? { description: meta.description } : {}),
        reason,
      });
    };
    if ((slot as { binding?: unknown }).binding !== undefined) {
      inputs.push({ name, via: "wire" });
      continue;
    }
    const ref = decl.inputs?.[name] ?? rule?.inputRefs?.[name];
    if (ref === undefined) {
      if (axes.has(name) && decl.eachExprs?.[name] !== undefined) inputs.push({ name, via: "wire", from: decl.eachExprs[name]!, each: "split" });
      else if (!required && (meta?.default !== undefined || meta?.defaultRef !== undefined)) inputs.push({ name, via: "default" });
      else open("the workflow binds nothing to it");
      continue;
    }
    const unread = [...childrenReadBy(ref)].filter((read) => read !== "*" && !available.has(read));
    if (unread.length > 0) {
      open(`its binding reads ${unread.map((k) => `'${k}'`).join(" and ")}, which ${unread.length === 1 ? "has" : "have"} not run`);
      continue;
    }
    inputs.push({ name, ...wireFrom(ref), ...(axes.has(name) ? { each: "split" as const } : {}) });
  }
  return { inputs, missing, asks };
}

const asMissing = (state: string, ask: AdoptAsk): ConnectMissingInput => ({
  state,
  name: ask.name,
  ...(ask.schema !== undefined ? { schema: ask.schema } : {}),
  ...(ask.description !== undefined ? { description: ask.description } : {}),
  reason: "the adopted task does not determine it",
});

/** "'a' (schema), 'b' (schema)" — the refusal's own words for what is missing. */
export function missingSentence(missing: readonly ConnectMissingInput[]): string {
  return missing
    .map((m) => `'${m.name}' of '${m.state}'${m.schema !== undefined ? ` (${JSON.stringify(m.schema)})` : ""} — ${m.reason}`)
    .join("; ");
}

// ---------------------------------------------------------------------------------------------------
// what a conversation supplied
// ---------------------------------------------------------------------------------------------------

/** The supplied values that are inputs of `state`, as the plain values a directed transition hands over. */
function suppliedFor(supplied: Readonly<Record<string, ConnectSupplied>> | undefined, state: LoadedState | undefined): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, entry] of Object.entries(supplied ?? {})) if (state?.inputs?.[name] !== undefined) out[name] = entry.value;
  return out;
}

/** What is still open once the conversation's values are counted — for inputs of `target` only. */
function stillMissing(missing: readonly ConnectMissingInput[], supplied: Readonly<Record<string, ConnectSupplied>> | undefined, target: string): ConnectMissingInput[] {
  return missing.filter((m) => !(sourceStateId(m.state) === sourceStateId(target) && supplied?.[m.name] !== undefined));
}

/**
 * Journal how the values a conversation handed an entry were settled (§4 "Inputs") — host
 * vocabulary, read back by the projection (`markProvenance`). Written BEFORE the move that enters
 * the child, on the task that takes it.
 */
export function recordSupplied(
  project: Project,
  taskId: string,
  at: { instanceId?: string; to: string; nested?: boolean },
  supplied: Readonly<Record<string, ConnectSupplied>> | undefined,
  names: readonly string[],
  /** The connect writing it — how a retry knows it already did. */
  mark?: string,
): void {
  const provenance: SuppliedEvent["provenance"] = {};
  for (const name of names) {
    const entry = supplied?.[name];
    if (entry !== undefined) provenance[name] = { via: entry.via, ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}) };
  }
  if (Object.keys(provenance).length === 0) return;
  const event: SuppliedEvent = {
    type: SUPPLIED_EVENT,
    ...(at.instanceId !== undefined ? { instanceId: at.instanceId } : {}),
    to: at.to,
    ...(at.nested === true ? { nested: true } : {}),
    provenance,
    ...(mark !== undefined ? { mark } : {}),
  };
  project.events.recorder(taskId).record(event as unknown as EngineEvent, Date.now());
}

/** A conversation's values as the generator takes them: a literal each, provenance beside the value. */
export function generatorSupplied(
  supplied: Readonly<Record<string, ConnectSupplied>> | undefined,
): Record<string, { value: JsonValue; provenance: { via: "inferred" | "asked"; by: string; note?: string } }> | undefined {
  if (supplied === undefined || Object.keys(supplied).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(supplied).map(([name, entry]) => [
      name,
      { value: entry.value, provenance: { via: entry.via, by: entry.via === "asked" ? "person" : "control", ...(entry.confidence !== undefined ? { note: `confidence ${entry.confidence}` } : {}) } },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------
// rule 1: within the task's workflow
// ---------------------------------------------------------------------------------------------------

export interface WithinInput {
  bundle: WorkflowBundle;
  /** The machine as recorded — absent for a task with no journal, which stands nowhere. */
  loaded?: LoadedInstance;
  /** Child keys from the root to the target. */
  keys: readonly string[];
  skip: boolean;
  /** A task that is not running steps past the state it stopped in; a finished one has nothing running. */
  running: boolean;
  /** Children the caller KNOWS will have ended well when the move is taken (an adoption about to be written). */
  alsoAvailable?: ReadonlySet<string>;
  /** `to_state`s the workflow's own rules are waiting on. */
  offered?: readonly string[];
}

export interface WithinOutcome {
  move: ConnectMove;
  inputs: ConnectInput[];
  missing: ConnectMissingInput[];
  asks: ConnectMissingInput[];
}

/**
 * Where a move to `keys` starts, which way it goes, what it steps over, and whether what it enters
 * will have its inputs.
 */
export function resolveWithin(input: WithinInput): WithinOutcome {
  const { bundle, keys } = input;
  // The shared ancestor: down the path for as long as the task STANDS in the composite named next.
  let node = input.loaded;
  let depth = 0;
  while (node !== undefined && depth < keys.length - 1) {
    const last = lastChildOf(node);
    if (last === undefined || last.childKey !== keys[depth] || last.element !== undefined || last.outcome === "skipped") break;
    node = last;
    depth += 1;
  }
  const states = statesAlong(bundle, keys);
  const parent = states[depth]!;
  const to = keys[depth]!;
  const sequence = parent.sequence ?? [];
  const at = sequence.indexOf(to);
  const entered = new Set((node?.children ?? []).flatMap((child) => (child.childKey !== undefined ? [child.childKey] : [])));
  const last = node !== undefined ? lastChildOf(node) : undefined;
  let from = -1;
  for (const child of [...(node?.children ?? [])].reverse()) {
    const index = child.childKey !== undefined ? sequence.indexOf(child.childKey) : -1;
    if (index >= 0) {
      from = index;
      break;
    }
  }
  const answersRule = depth === 0 && keys.length === 1 && !input.skip && (input.offered ?? []).includes(to);
  const backward = at >= 0 && from >= 0 && at <= from;
  const passes: string[] = [];
  if (at >= 0 && !backward && !answersRule) {
    for (const key of sequence.slice(from + 1, at)) if (!entered.has(key) && input.alsoAvailable?.has(key) !== true) passes.push([...keys.slice(0, depth), key].join("/"));
  }
  // Below the ancestor every composite is entered fresh: what comes before the named child is stepped over too.
  for (let level = depth + 1; level < keys.length; level += 1) {
    const inner = states[level]?.sequence ?? [];
    const index = inner.indexOf(keys[level]!);
    for (const key of inner.slice(0, Math.max(index, 0))) passes.push([...keys.slice(0, level), key].join("/"));
  }
  const direction: ConnectMove["direction"] = at < 0 ? "aside" : backward ? "backward" : passes.length > 0 ? "forward" : "next";
  // A task that is not running and had not finished STOPPED in a state; the move steps past it.
  const stoppedIn = !input.running && last?.live === true && last.childKey !== undefined ? [...keys.slice(0, depth), last.childKey].join("/") : undefined;

  // What the target's wires may read. A held move waits for the state running now, so that state
  // counts; a skip steps past it, and a backward move resets what comes after the target.
  const available = succeededUnder(node);
  for (const key of input.alsoAvailable ?? []) available.add(key);
  if (last?.live === true && last.childKey !== undefined && input.running && !input.skip) available.add(last.childKey);
  if (backward) for (const key of sequence.slice(at)) available.delete(key);

  const inputs: ConnectInput[] = [];
  const missing: ConnectMissingInput[] = [];
  const asks: ConnectMissingInput[] = [];
  for (let level = depth; level < keys.length; level += 1) {
    const settled = unboundInputs(bundle, states[level]!, keys[level]!, level === depth ? available : new Set());
    if (level === keys.length - 1) inputs.push(...settled.inputs);
    missing.push(...settled.missing);
    asks.push(...settled.asks);
  }
  return {
    move: {
      direction,
      ...(node !== undefined && depth > 0 ? { instanceId: node.id } : {}),
      to,
      path: keys.slice(depth + 1),
      passes,
      ...(stoppedIn !== undefined ? { stepsPast: stoppedIn } : {}),
      ...(answersRule ? { answersRule: true } : {}),
    },
    inputs,
    missing,
    asks,
  };
}

// ---------------------------------------------------------------------------------------------------
// rule 2: a real workflow that holds both
// ---------------------------------------------------------------------------------------------------

/** Every composite that mounts `ran` as a child and either IS `target` or mounts it as one too. */
export function candidatesFor(project: Project, browser: WorkflowBrowser, ran: string, target: string, only?: string): ConnectCandidate[] {
  const source = sourceStateId(ran);
  const wanted = sourceStateId(target);
  const out = new Map<string, ConnectCandidate>();
  for (const workflow of browser.workflows) {
    if (workflow.rootId.startsWith(DYNAMIC_ROOT_PREFIX)) continue;
    const reaches = (id: string): boolean => workflow.rootId === id || workflow.states.includes(id);
    if (!reaches(source) || !reaches(wanted)) continue;
    const bundle = bundleFor(project, workflow.rootId);
    if (bundle === undefined) continue;
    for (const state of Object.values(bundle.states)) {
      const id = sourceStateId(state.id);
      if (out.has(id) || (only !== undefined && sourceStateId(only) !== id)) continue;
      const mounts = Object.entries(state.children ?? {});
      const asChild = mounts.filter(([, child]) => sourceStateId(child.state) === source);
      if (asChild.length === 0) continue;
      const targetKey = id === wanted ? undefined : mounts.find(([, child]) => sourceStateId(child.state) === wanted)?.[0];
      if (id !== wanted && targetKey === undefined) continue;
      out.set(id, { workflow: id, ...(state.label !== undefined ? { label: state.label } : {}), childKey: asChild[0]![0], ...(targetKey !== undefined ? { targetKey } : {}) });
    }
  }
  return [...out.values()].sort((a, b) => a.workflow.localeCompare(b.workflow));
}

// ---------------------------------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------------------------------

/** What the person did, in a sentence — what a conversation made by a move is opened with. */
function moveSentence(title: string, target: string): string {
  return `"${title}" was moved to ${target}.`;
}

/**
 * The inputs of a new document's ROOT — the conversation state's own.
 *
 * Filled by schema, never by name (§0): a required input that takes a string is given the sentence
 * that says what happened, which is what a conversation made by a move is opened with. Anything
 * else required is returned as missing.
 */
function conversationInputs(
  project: Project,
  conversation: string,
  sentence: string,
  check: ValueCheck | undefined,
): { inputs: Record<string, JsonValue>; provenance: Record<string, InputProvenance>; missing: ConnectMissingInput[] } {
  const inputs: Record<string, JsonValue> = {};
  const provenance: Record<string, InputProvenance> = {};
  const missing: ConnectMissingInput[] = [];
  const doc = workflowLoadOptions(project.paths, { path: project.config.workflows.path }).loadState?.(conversation);
  const declared = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as { inputs?: unknown }).inputs : undefined;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return { inputs, provenance, missing };
  for (const [name, raw] of Object.entries(declared as Record<string, unknown>)) {
    const slot = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { schema?: JsonValue; optional?: unknown; default?: unknown; binding?: unknown; description?: unknown };
    if (slot.optional === true || slot.default !== undefined || slot.binding !== undefined) continue;
    const schema = slot.schema ?? {};
    const takesText = check !== undefined ? check(schema, sentence) === undefined : (schema as { type?: unknown }).type === undefined || (schema as { type?: unknown }).type === "string";
    if (takesText) {
      inputs[name] = sentence;
      provenance[name] = { via: "bound" };
    } else {
      missing.push({ state: conversation, name, schema, ...(typeof slot.description === "string" ? { description: slot.description } : {}), reason: "the conversation that controls the new workflow requires it, and a move supplies only what happened, in words" });
    }
  }
  return { inputs, provenance, missing };
}

/** A connect's request as its intent keeps it — what the steps are carried out with. */
type Asked = ConnectIntent["request"];

const skipOf = (request: Asked): boolean => request.skip === true || request.forward === "skip";

/**
 * A forward move nobody here can run (§4): no host to drive one, so there is nobody to answer on
 * the way. Skip is the whole of what is left, and it is what the CLI has always used.
 */
function fastForwardRefusal(move: ConnectMove): ConnectRefusal {
  return {
    code: "fast-forward",
    message:
      move.passes.length > 0
        ? `'${[move.to, ...move.path].join("/")}' is ahead of where the task stands, past ${move.passes.map((p) => `'${p}'`).join(", ")}. ` +
          `Running the states between (fast-forward) needs a conversation to answer what comes up on the way, and there is none here — ` +
          `say skip to go there directly, which records ${move.passes.length === 1 ? "it" : "them"} as skipped`
        : `'${[move.to, ...move.path].join("/")}' is ahead of where the task stands, through what the workflow decides on the way. ` +
          `Running there (fast-forward) needs a conversation to answer what comes up, and there is none here — say skip to go there directly`,
  };
}

/** The mode a forward move asks the host for — see {@link ConnectHost.fastForward}. */
function fastForwardRequest(request: Asked, taskId: string, target: string, move: ConnectMove, inputs: Record<string, JsonValue>): TaskFastForwardRequest {
  return {
    taskId,
    target,
    toState: move.to,
    ...(move.instanceId !== undefined ? { instanceId: move.instanceId } : {}),
    ...(move.path.length > 0 ? { path: [...move.path] } : {}),
    ...(move.passes.length > 0 ? { through: [...move.passes] } : {}),
    by: request.by ?? "person",
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
    ...(request.fake !== undefined ? { fake: request.fake } : {}),
  };
}

function moveRequest(request: Asked, taskId: string, move: ConnectMove, inputs: Record<string, JsonValue> = {}): TaskMoveRequest {
  return {
    taskId,
    toState: move.to,
    by: request.by ?? "person",
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(move.instanceId !== undefined ? { instanceId: move.instanceId } : {}),
    ...(move.path.length > 0 ? { path: move.path } : {}),
    ...(skipOf(request) && move.answersRule !== true ? { skip: true } : {}),
    ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
    ...(request.fake !== undefined ? { fake: request.fake } : {}),
  };
}

/**
 * Send a task to a state — see the module header. A refusal is an answer; only a broken
 * installation (a module awaiting approval, a generator bug) rejects.
 *
 * A connect that was MADE is the next decision about the task, so an Undo it kept from an earlier
 * drop is over (`connectUndo.ts`); a host that hands this connect's own Undo to a card keeps that
 * one after this returns. A dry run and a refusal decide nothing.
 */
export async function connectTask(project: Project, request: TaskConnectRequest, host: ConnectHost): Promise<TaskConnectResult> {
  const dryRun = request.dryRun === true;
  // A drop of this task that stopped part-way is finished as it was MEANT — its written intent, never
  // a second resolution against what it left behind — and nothing else is done with the task first.
  const open = project.runtime.get(request.taskId) !== undefined ? openConnectIntent(project, request.taskId) : undefined;
  if (open !== undefined) {
    if (!sameDrop(open.intent.request, request)) return refused(dryRun, connectingRefusal(project, request.taskId, open), open.intent.plan);
    if (dryRun) return { ok: true, dryRun, plan: open.intent.plan };
    return finishConnect(project, request.taskId, open, host, request.project);
  }
  return connectOnce(project, request, host);
}

/**
 * Rule 1, judged: the target is in the task's workflow and the table has said where (`where` is never
 * `elsewhere` here — that one is rule 3's). See the module header for what each row does.
 */
async function moveWithin(
  project: Project,
  request: TaskConnectRequest,
  host: ConnectHost,
  at: {
    title: string;
    own: string;
    target: string;
    bundle: WorkflowBundle;
    loaded: LoadedInstance;
    keys: string[];
    where: Exclude<MoveWhere, "elsewhere">;
    activity: TaskActivity;
    running: boolean;
    reach: ReturnType<typeof reachAhead>;
    entered: ReadonlySet<string>;
    /** How the task stood before the move — what a move's Undo puts back, written into the intent. */
    before: ConnectIntent["before"];
  },
): Promise<TaskConnectResult> {
  const dryRun = request.dryRun === true;
  const { taskId } = request;
  const { bundle, keys, where, activity, target } = at;
  const states = statesAlong(bundle, keys);
  // BEHIND, with an engine holding the task: taken NOW — the state it stands in is stopped (a
  // working task asks first) — rather than held until that state ends, which a waiting one never would.
  const backNow = where === "behind" && isLive(activity);
  const within = resolveWithin({ bundle, loaded: at.loaded, keys, skip: skipOf(request) || backNow, running: at.running, offered: host.offered?.(taskId) ?? [] });
  const event = within.move.answersRule === true;
  const judgement = judged(where, activity, at.title, keys.join("/"), {
    eventLeadsThere: event,
    next: within.move.direction === "next",
    ...(where === "unreachable" ? { illegal: unreachableSentence(bundle, at.reach, at.entered, keys, at.title) } : {}),
  });
  // AHEAD and not simply next: the machine RUNS there (§4) — through the states between, and through
  // the decisions on the way, which a directed jump would take out of the workflow's hands. That is a
  // target past states nobody has run, and one off the spine that only a rule of the workflow enters.
  const runs = judgement.way === "fast-forward" && (within.move.direction === "forward" || within.move.direction === "aside");
  const plan: ConnectPlan = {
    resolution: "move",
    workflow: at.own,
    ...(states[0]?.label !== undefined ? { workflowLabel: states[0].label } : {}),
    standsAt: { path: [...keys], stateId: target, ...(states.at(-1)?.label !== undefined ? { label: states.at(-1)!.label! } : {}) },
    move: within.move,
    ...(runs ? { forward: skipOf(request) ? ("skip" as const) : ("fast-forward" as const) } : {}),
    inputs: within.inputs,
    asks: within.asks,
    judgement,
  };
  if (judgement.way === "illegal") return refused(dryRun, { code: "illegal", message: judgement.sentence! }, plan);
  const confirm = unconfirmed(request, judgement, plan);
  if (confirm !== undefined) return confirm;
  // FORWARD: the machine runs there (§4). Not a transition at all — the host is asked for the MODE,
  // and the workflow walks itself into the target.
  const forward = runs && !skipOf(request);
  if (forward && host.fastForward === undefined) return refused(dryRun, fastForwardRefusal(within.move), plan);
  const blocked = forward ? host.fastForwardBlocked?.(taskId) : undefined;
  if (blocked !== undefined) return refused(dryRun, { code: "fast-forward", message: blocked }, plan);
  const open = stillMissing(within.missing, request.supplied, target);
  if (open.length > 0 && within.move.answersRule !== true) {
    // Asked in the task's own conversation, where the host can ask and what is open is the target's.
    if (host.ask !== undefined && answerable(open, target)) {
      const asking: ConnectPlan = { ...plan, question: open };
      if (dryRun) return { ok: true, dryRun, plan: asking, taskId };
      return askFor(request, host, { title: at.title, plan: asking, missing: open, optional: within.asks.filter((m) => sourceStateId(m.state) === target), path: keys });
    }
    return refused(dryRun, { code: "inputs-missing", message: `moving '${at.title}' to '${keys.join("/")}' leaves required inputs unbound: ${missingSentence(open)}`, missing: open }, plan);
  }
  if (dryRun) return { ok: true, dryRun, plan, taskId };
  const handed = suppliedFor(request.supplied, states.at(-1));
  const inputs = Object.keys(handed).length > 0 ? { inputs: handed } : {};
  // Written down first (`begin`), with the exact mount, and — for a move back taken now — `skip`, so a
  // retry takes the same move the same way.
  return begin(project, { ...request, path: keys, ...(backNow ? { skip: true } : {}) }, host, {
    plan,
    before: at.before,
    steps: [
      ...suppliedStep("task", { ...(within.move.instanceId !== undefined ? { instanceId: within.move.instanceId } : {}), to: keys.at(-1)!, nested: within.move.path.length > 0 }, Object.keys(handed)),
      forward ? { kind: "fastForward", on: "task", move: within.move, ...inputs } : { kind: "move", on: "task", move: within.move, ...inputs },
    ],
  });
}

async function connectOnce(project: Project, request: TaskConnectRequest, host: ConnectHost): Promise<TaskConnectResult> {
  const dryRun = request.dryRun === true;
  const { taskId } = request;
  const meta = project.tasks.tryRead(taskId);
  const row = project.runtime.get(taskId);
  if (meta === undefined || row === undefined) return refused(dryRun, { code: "unknown-task", message: `unknown task '${taskId}'` });
  const target = sourceStateId(request.target);
  let running = host.running?.(taskId) ?? (row.status === "running" || row.status === "stopping");
  const activity: TaskActivity = host.activity?.(taskId) ?? activityFromRow(project, taskId, running);
  // How the task stood before the drop — what a move's Undo puts back, written into the intent.
  const pinNow = row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash, ...(row.documentId !== undefined ? { documentId: row.documentId } : {}) } : undefined;
  const before: ConnectIntent["before"] = { ...(pinNow !== undefined ? { pin: pinNow } : {}), ...(row.status === "completed" ? { wasCompleted: true as const } : {}) };

  // ---- rule 1: the target is in the task's workflow ----------------------------------------------
  const own = sourceStateId(meta.workflow);
  if (target === own && (request.workflow === undefined || sourceStateId(request.workflow) === own)) {
    return refused(dryRun, { code: "already-there", message: `'${meta.title}' already runs '${own}'` });
  }
  let bundle: WorkflowBundle | undefined;
  if (row.snapshotHash !== undefined || row.documentId !== undefined) {
    try {
      bundle = loadPinnedBundle(project, row);
    } catch (e) {
      return refused(dryRun, { code: "unloadable", message: `the workflow '${meta.title}' runs does not load: ${(e as Error).message}` });
    }
  }
  if (bundle !== undefined && (request.workflow === undefined || sourceStateId(request.workflow) === own)) {
    const paths = pathsTo(bundle, target);
    if (paths.length > 0) {
      const load = buildTaskLoad(project, taskId, bundle.states);
      if (load.loaded === undefined) {
        return refused(dryRun, { code: load.blocked !== undefined ? "unloadable" : "never-run", message: load.blocked !== undefined ? `'${meta.title}' cannot be moved: ${load.blocked}` : `'${meta.title}' has never run, so it stands nowhere to be moved from — start it instead` });
      }
      // WHERE the target is, from where the task stands (the move table's rows, `moveLegality.ts`).
      const entered = enteredPaths(load.loaded);
      const reach = reachAhead(bundle, load.loaded);
      const standing: string[] = [];
      for (let node: LoadedInstance | undefined = lastChildOf(load.loaded); node?.childKey !== undefined; node = lastChildOf(node)) standing.push(node.childKey);
      const shared = (keys: readonly string[]): number => {
        let n = 0;
        while (n < keys.length && n < standing.length && keys[n] === standing[n]) n += 1;
        return n;
      };
      const RANK: Record<MoveWhere, number> = { ahead: 0, behind: 1, elsewhere: 2, unreachable: 3 };
      let keys: string[];
      if (request.path !== undefined) {
        const named = paths.find((p) => p.join("/") === request.path!.join("/"));
        if (named === undefined) return refused(dryRun, { code: "unknown-target", message: `'${request.path.join("/")}' is not where '${target}' is mounted in the workflow '${meta.title}' runs` });
        keys = named;
      } else {
        // A state mounted twice: the mount the table can take — ahead, then behind — then the one that
        // shares most with where the task stands, then the shortest.
        keys = [...paths].sort((a, b) => RANK[whereIs(reach, entered, a)] - RANK[whereIs(reach, entered, b)] || shared(b) - shared(a) || a.length - b.length)[0]!;
      }
      const where = whereIs(reach, entered, keys);
      // Nothing is defined ahead of where the task stands (it finished): a move anywhere it has not
      // been is a NEW transition — rule 3, below.
      if (where !== "elsewhere") return moveWithin(project, request, host, { title: meta.title, own, target, bundle, loaded: load.loaded, keys, where, activity, running, reach, entered, before });
    }
  }

  // ---- rules 2–3: the table's last row ------------------------------------------------------------
  const elsewhere = judged("elsewhere", activity, meta.title, target);
  /**
   * What a move into another workflow does first to a task an engine holds: PAUSE it and wait the run
   * out (the person confirmed it, or it was only waiting). Asked only once everything has been checked.
   */
  const pauseFirst = async (): Promise<ConnectRefusal | undefined> => {
    if (!running) return undefined;
    if (host.pause === undefined) {
      return { code: "running", message: `'${meta.title}' is running, and no workflow relates '${own}' to '${target}': the move is a new transition, which a task picks up the next time it loads. Pause it, then move it` };
    }
    await host.pause(taskId);
    running = false;
    return undefined;
  };

  // ---- rule 2: a real workflow holds both ---------------------------------------------------------
  const inDocument = row.documentId !== undefined;
  if (!inDocument && meta.origin === undefined) {
    const browser = host.browser?.() ?? browseWorkflows(project);
    const candidates = candidatesFor(project, browser, own, target, request.workflow);
    if (candidates.length > 1) {
      return refused(dryRun, {
        code: "ambiguous-workflow",
        message: `${candidates.map((c) => `'${c.workflow}'`).join(" and ")} each hold both '${own}' and '${target}' — say which workflow '${meta.title}' joins`,
        candidates,
      });
    }
    const candidate = candidates[0];
    if (candidate !== undefined) return adoptInto(project, request, host, { title: meta.title, own, target, candidate, judgement: elsewhere, paused: running, pauseFirst });
  }

  // ---- rule 3: the workflow is modified -----------------------------------------------------------
  if (row.snapshotHash === undefined && row.documentId === undefined) {
    return refused(dryRun, { code: "never-run", message: `'${meta.title}' has never run, so it stands nowhere to be moved from — start it instead` });
  }
  if (loadsNothing(project, target)) return refused(dryRun, { code: "unknown-target", message: `no state '${target}' was found on the workflow path` });
  const finishedWell = row.status === "completed" && (row.outcome === undefined || row.outcome === "success");
  const modification: NonNullable<ConnectPlan["modification"]> = inDocument ? "augmented" : finishedWell ? "new" : "cloned";
  if (running && host.pause === undefined) {
    return refused(dryRun, {
      code: "running",
      message: `'${meta.title}' is running, and no workflow relates '${own}' to '${target}': the move is a new transition, which a task picks up the next time it loads. Pause it, then move it`,
    });
  }
  const conversation = host.conversation ?? CONNECT_CONVERSATION;
  const suppliedLiterals = generatorSupplied(request.supplied);
  const generate = (dry: boolean): Promise<GenerateVersionResult> =>
    generateDocumentVersion(project, {
      taskId,
      target,
      conversation,
      ...(suppliedLiterals !== undefined ? { supplied: suppliedLiterals } : {}),
      ...(host.functions !== undefined ? { functions: host.functions } : {}),
      ...(dry ? { dryRun: true } : {}),
    });
  let preview: GenerateVersionResult;
  try {
    preview = await generate(true);
  } catch (e) {
    return refused(dryRun, { code: "generate", message: (e as Error).message });
  }
  const generated = preview.generated;
  const planOf = (workflow: string): ConnectPlan => ({
    resolution: "modify",
    modification,
    workflow,
    standsAt: { path: [generated.targetKey], stateId: target },
    move: { direction: "aside", to: generated.targetKey, path: [], passes: [] },
    mount: generated.mount,
    inputs: [
      ...generated.wires.map((wire): ConnectInput => ({ name: wire.input, via: "wire", from: `${wire.from.child}.${wire.from.output}`, ...(wire.each !== undefined ? { each: wire.each } : {}) })),
      ...generated.literals.map((literal): ConnectInput => ({ name: literal.input, via: "literal" })),
    ],
    asks: generated.unsettled.filter((u) => !u.required).map((u): ConnectMissingInput => unsettledAsMissing(target, u)),
    judgement: elsewhere,
  });
  const wouldStandIn = modification === "new" ? `${DYNAMIC_ROOT_PREFIX}…` : meta.workflow;
  const confirm = unconfirmed(request, elsewhere, planOf(wouldStandIn));
  if (confirm !== undefined) return confirm;
  if (!generated.ok) {
    const missing = generated.unsettled.filter((u) => u.required).map((u) => unsettledAsMissing(target, u));
    // Asked in the task's own conversation, where the host can ask; the move is taken when answered.
    if (host.ask !== undefined) {
      const plan: ConnectPlan = { ...planOf(wouldStandIn), question: missing };
      if (dryRun) return { ok: true, dryRun, plan, ...(modification !== "new" ? { taskId } : {}) };
      const optional = generated.unsettled.filter((u) => !u.required).map((u) => unsettledAsMissing(target, u));
      return askFor(request, host, { title: meta.title, plan, missing, optional });
    }
    return refused(dryRun, { code: "inputs-missing", message: `a move of '${meta.title}' to '${target}' leaves required inputs unbound: ${missingSentence(missing)}`, missing }, planOf(wouldStandIn));
  }
  const opening = modification === "new" ? conversationInputs(project, conversation, moveSentence(meta.title, target), host.check) : undefined;
  if (opening !== undefined && opening.missing.length > 0) {
    return refused(dryRun, { code: "inputs-missing", message: `the conversation '${conversation}' cannot be opened by a move: ${missingSentence(opening.missing)}`, missing: opening.missing }, planOf(wouldStandIn));
  }
  const sourceKey = Object.entries(generated.additions.children).find(([, mount]) => sourceStateId(String(mount["state"])) === own)?.[0];
  if (dryRun) return { ok: true, dryRun, plan: { ...planOf(wouldStandIn), ...(modification === "new" ? { adoptedAs: sourceKey ?? Object.keys(generated.additions.children)[0] ?? generated.targetKey } : {}) }, ...(modification !== "new" ? { taskId } : {}) };

  // A task an engine holds is paused first: its engine runs the version it loaded, and the new
  // transition is one it could not see.
  const paused = await pauseFirst();
  if (paused !== undefined) return refused(dryRun, paused, planOf(wouldStandIn));

  // The real thing, written down first (`begin`): the document, then — for a NEW one — its task and
  // the adoption into it, then what the conversation supplied, then the move. The target's key is the
  // one the document gives it; the preview names the same one, and the step's result is what is used.
  const literalNames = generated.literals.map((literal) => literal.input);
  const move: ConnectMove = { direction: "aside", to: TARGET_KEY, path: [], passes: [] };
  if (modification !== "new") {
    return begin(project, request, host, {
      plan: planOf(meta.workflow),
      before,
      steps: [{ kind: "document", conversation }, ...suppliedStep("task", { to: TARGET_KEY }, literalNames), { kind: "move", on: "task", move }],
    });
  }
  return begin(project, request, host, {
    plan: planOf(`${DYNAMIC_ROOT_PREFIX}…`),
    before,
    steps: [
      { kind: "document", conversation },
      { kind: "parent", title: meta.title, ...(Object.keys(opening!.inputs).length > 0 ? { inputs: opening!.inputs, provenance: opening!.provenance } : {}) },
      { kind: "adopt", intoParent: true, ...(sourceKey !== undefined ? { childKey: sourceKey } : {}), start: false },
      ...suppliedStep("parent", { to: TARGET_KEY }, literalNames),
      { kind: "move", on: "parent", move },
    ],
  });
}

export function unsettledAsMissing(target: string, u: { input: string; schema: JsonValue; description?: string; reason: string; candidates?: Array<{ child: string; output: string }> }): ConnectMissingInput {
  const reason =
    u.reason === "ambiguous"
      ? `${(u.candidates ?? []).map((c) => `${c.child}.${c.output}`).join(" and ")} fit it equally, and nothing but their names tells them apart`
      : u.reason === "second-list"
        ? "it takes one element of a second list, and one mount splits on one"
        : "nothing the task produced fits it";
  return { state: target, name: u.input, schema: u.schema, ...(u.description !== undefined ? { description: u.description } : {}), reason };
}

function loadsNothing(project: Project, target: string): boolean {
  const doc = workflowLoadOptions(project.paths, { path: project.config.workflows.path }).loadState?.(target);
  if (doc !== undefined && doc !== null) return false;
  return bundleFor(project, target) === undefined;
}

/** Rule 2, composed: adopt into a new task of the candidate workflow, then rule 1 for that task. */
async function adoptInto(
  project: Project,
  request: TaskConnectRequest,
  host: ConnectHost,
  at: {
    title: string;
    own: string;
    target: string;
    candidate: ConnectCandidate;
    /** The table's last row, for this task. */
    judgement: MoveJudgement;
    /** An engine held the task when the move was asked: it is paused first, and resumed as the child. */
    paused: boolean;
    pauseFirst: () => Promise<ConnectRefusal | undefined>;
  },
): Promise<TaskConnectResult> {
  const dryRun = request.dryRun === true;
  const { candidate, target } = at;
  const pass = { ...(request.project !== undefined ? { project: request.project } : {}) };
  const dry = await host.adopt({ taskId: request.taskId, workflow: candidate.workflow, childKey: candidate.childKey, dryRun: true, ...pass });
  if (!dry.ok) return refused(dryRun, { code: "adopt", message: dry.refusal.message, adopt: dry.refusal });
  const adoptPlan: AdoptPlan = dry.plan;
  const bundle = bundleFor(project, candidate.workflow);
  if (bundle === undefined) return refused(dryRun, { code: "unloadable", message: `workflow '${candidate.workflow}' does not load` });
  const root = bundle.states[bundle.rootId]!;

  // Rule 1, for the task the adoption makes: it will stand past the adopted child, with that child
  // — and nothing else — behind it. The target that comes next anyway needs no move at all.
  const adoptedKeys = new Set(adoptPlan.adopted.filter((child) => !child.pending).map((child) => child.childKey));
  const stand: LoadedInstance = {
    id: "",
    stateId: bundle.rootId,
    inputs: {},
    live: true,
    children: adoptPlan.adopted.map((child) => ({ id: child.taskId, stateId: child.stateId, childKey: child.childKey, inputs: {}, live: child.pending, ...(child.pending ? {} : { outcome: "success" as const }) })),
  };
  const within = candidate.targetKey !== undefined ? resolveWithin({ bundle, loaded: stand, keys: [candidate.targetKey], skip: skipOf(request), running: false, alsoAvailable: adoptedKeys }) : undefined;
  const needsMove = within !== undefined && within.move.direction !== "next";
  const standsKey = candidate.targetKey ?? adoptPlan.next;
  // What the conversation supplied settles the parent's own asks by the parent's names, and the
  // target's by the target's — one bag, since a caller answers the `missing` it was handed.
  const parentSupplied = Object.fromEntries(adoptPlan.asks.filter((ask) => request.supplied?.[ask.name] !== undefined).map((ask) => [ask.name, request.supplied![ask.name]!.value]));
  const missing: ConnectMissingInput[] = [
    ...adoptPlan.asks.filter((ask) => ask.required && parentSupplied[ask.name] === undefined).map((ask) => asMissing(candidate.workflow, ask)),
    ...stillMissing(within?.missing ?? [], request.supplied, target),
  ];
  // Entering what comes next is the workflow's own walk; its inputs are checked the same way, so a
  // drop never makes a task that blocks on its first state.
  const nextUp = within === undefined && adoptPlan.next !== undefined ? unboundInputs(bundle, root, adoptPlan.next, adoptedKeys) : undefined;
  const plan: ConnectPlan = {
    resolution: "adopt",
    workflow: candidate.workflow,
    ...(candidate.label !== undefined ? { workflowLabel: candidate.label } : {}),
    standsAt: {
      path: standsKey !== undefined ? [standsKey] : [],
      stateId: standsKey !== undefined ? sourceStateId(root.children?.[standsKey]?.state ?? target) : candidate.workflow,
      ...(standsKey !== undefined && bundle.states[root.children?.[standsKey]?.state ?? ""]?.label !== undefined ? { label: bundle.states[root.children![standsKey]!.state]!.label! } : {}),
    },
    ...(needsMove ? { move: within!.move } : {}),
    ...(needsMove && within!.move.direction === "forward" ? { forward: skipOf(request) ? ("skip" as const) : ("fast-forward" as const) } : {}),
    adopt: adoptPlan,
    adoptedAs: candidate.childKey,
    inputs: within?.inputs ?? nextUp?.inputs ?? [],
    asks: [...adoptPlan.asks.filter((ask) => !ask.required).map((ask) => asMissing(candidate.workflow, ask)), ...(within?.asks ?? nextUp?.asks ?? [])],
    ...(adoptPlan.branch !== undefined ? { branch: adoptPlan.branch } : {}),
    judgement: at.judgement,
  };
  const confirm = unconfirmed(request, at.judgement, plan);
  if (confirm !== undefined) return confirm;
  const forward = needsMove && within!.move.direction === "forward" && !skipOf(request);
  if (forward && host.fastForward === undefined) return refused(dryRun, fastForwardRefusal(within!.move), plan);
  if (missing.length > 0) {
    // Asked in the task's own conversation — the one the adoption extends — and adopted when answered.
    if (host.ask !== undefined && (within === undefined || answerable(stillMissing(within.missing, request.supplied, target), target))) {
      const asking: ConnectPlan = { ...plan, question: missing };
      if (dryRun) return { ok: true, dryRun, plan: asking };
      const optional = [...adoptPlan.asks.filter((ask) => !ask.required).map((ask) => asMissing(candidate.workflow, ask)), ...(within?.asks ?? []).filter((m) => sourceStateId(m.state) === sourceStateId(target))];
      return askFor(request, host, { title: at.title, plan: asking, missing, optional });
    }
    return refused(dryRun, { code: "inputs-missing", message: `adopting '${at.title}' into '${candidate.workflow}' leaves required inputs unbound: ${missingSentence(missing)}`, missing }, plan);
  }
  if (dryRun) return { ok: true, dryRun, plan };
  const paused = await at.pauseFirst();
  if (paused !== undefined) return refused(dryRun, paused, plan);

  const handed = needsMove ? suppliedFor(request.supplied, bundle.states[root.children?.[candidate.targetKey ?? ""]?.state ?? ""]) : {};
  const inputs = Object.keys(handed).length > 0 ? { inputs: handed } : {};
  const done = await begin(project, request, host, {
    plan,
    before: {},
    steps: [
      {
        kind: "adopt",
        workflow: candidate.workflow,
        childKey: candidate.childKey,
        // A move is taken by an engine that loads with it waiting, so the parent is not started twice.
        start: needsMove ? false : request.start !== false,
        ...(Object.keys(parentSupplied).length > 0
          ? { inputs: parentSupplied, suppliedVia: Object.keys(parentSupplied).every((name) => request.supplied![name]!.via === "asked") ? ("asked" as const) : ("inferred" as const) }
          : {}),
      },
      ...(needsMove
        ? [
            ...suppliedStep("parent", { to: within!.move.to }, Object.keys(handed)),
            forward ? ({ kind: "fastForward", on: "parent", move: within!.move, ...inputs } as const) : ({ kind: "move", on: "parent", move: within!.move, ...inputs } as const),
          ]
        : []),
    ],
  });
  // Paused for the move, it goes on as the child it now is; the parent holds for it as for any task
  // adopted before it finished, and is released when it does.
  if (done.ok && at.paused) await host.resume?.(request.taskId);
  return done;
}

// ---------------------------------------------------------------------------------------------------
// the intent, and carrying it out
// ---------------------------------------------------------------------------------------------------

/** Where a document's key for the target goes in a step — replaced by the key the `document` step's result names. */
const TARGET_KEY = "@target";

/** The `supplied` step, when anything was supplied for the names the entry takes. */
function suppliedStep(on: "task" | "parent", at: { instanceId?: string; to: string; nested?: boolean }, names: readonly string[]): ConnectStep[] {
  if (names.length === 0) return [];
  return [{ kind: "supplied", on, to: at.to, ...(at.instanceId !== undefined ? { instanceId: at.instanceId } : {}), ...(at.nested === true ? { nested: true as const } : {}), names: [...names] }];
}

/** Two requests are the SAME drop when they send the same task to the same target, in the same workflow. */
function sameDrop(asked: ConnectIntent["request"], request: TaskConnectRequest): boolean {
  const workflow = (w: string | undefined): string | undefined => (w === undefined ? undefined : sourceStateId(w));
  return sourceStateId(asked.target) === sourceStateId(request.target) && workflow(asked.workflow) === workflow(request.workflow);
}

const STEP_WORDS: Record<ConnectStep["kind"], string> = {
  document: "writing the workflow",
  parent: "making its task",
  adopt: "the adoption",
  supplied: "recording what was supplied",
  move: "the move",
  fastForward: "starting the fast-forward",
};

/**
 * WRITE the intent, then carry it out. Called by each resolution once it has decided everything and
 * before it writes anything: from here on the journal says what this drop is, so a retry — or the
 * next open after a crash — finishes it as it was meant ({@link finishConnect}) instead of resolving it
 * again against what the first attempt left behind.
 */
async function begin(
  project: Project,
  request: TaskConnectRequest,
  host: ConnectHost,
  intent: Omit<ConnectIntent, "request">,
): Promise<TaskConnectResult> {
  const { dryRun: _dry, project: _project, ...asked } = request;
  const whole: ConnectIntent = { request: asked, ...intent };
  const mark = `c-${randomUUID()}`;
  const atMs = Date.now();
  recordConnectRow(project, request.taskId, { mark, at: "intent", intent: whole }, atMs);
  return finishConnect(project, request.taskId, { mark, intent: whole, atMs, results: whole.steps.map(() => undefined) }, host, request.project);
}

/** What one step answered: what it made, or why it will not. */
type StepOutcome = { result: ConnectStepResult } | { refusal: ConnectRefusal };

/**
 * Carry an intent out: every step not yet done, in order, each journaling itself done with what it
 * made. A step that REFUSES, or throws, is journaled `stopped` and the intent stays open; the same
 * drop again carries on from it, and gets the same answer where nothing has changed. When every step
 * is done the intent is closed, and the answer is assembled from what the steps made.
 *
 * Each step is also IDEMPOTENT on its own, for the one gap the rows cannot close: a step that ran and
 * whose `step` row never landed (the process died between the two). What it would have made is looked
 * for first — written by this drop's own task, after its intent — and taken if it is there.
 */
export async function finishConnect(project: Project, taskId: string, open: OpenConnectIntent, host: ConnectHost, projectRef?: string): Promise<TaskConnectResult> {
  const { intent, mark } = open;
  const results = [...open.results];
  for (let i = 0; i < intent.steps.length; i += 1) {
    if (results[i] !== undefined) continue;
    let outcome: StepOutcome;
    try {
      await host.onStep?.(intent.steps[i]!, i);
      outcome = await runStep(project, taskId, open, results, i, host, projectRef);
    } catch (e) {
      recordConnectRow(project, taskId, { mark, at: "stopped", step: i, reason: (e as Error).message });
      throw e;
    }
    if ("refusal" in outcome) {
      recordConnectRow(project, taskId, { mark, at: "stopped", step: i, reason: outcome.refusal.message });
      return refused(false, outcome.refusal, intent.plan);
    }
    recordConnectRow(project, taskId, { mark, at: "step", step: i, result: outcome.result });
    results[i] = outcome.result;
  }
  const made = (key: keyof ConnectStepResult): ConnectStepResult | undefined => results.find((result) => result?.[key] !== undefined);
  const parentTaskId = made("parentTaskId")?.parentTaskId;
  const adopts = intent.steps.some((step) => step.kind === "adopt");
  // The intent is closed where the drop's own writes end — on the watched journal too, for an adoption.
  recordConnectRow(project, taskId, { mark, at: "done" });
  if (adopts && parentTaskId !== undefined && parentTaskId !== taskId) recordConnectRow(project, parentTaskId, { mark, at: "done" });
  // A connect that was MADE is the next decision about the task (`connectUndo.ts`).
  dropConnectUndo(project, taskId);

  const document = made("documentId");
  const adopted = made("adopt")?.adopt;
  const moved = made("moved");
  const targetKey = document?.targetKey;
  const plan: ConnectPlan = {
    ...intent.plan,
    ...(document?.rootId !== undefined && (parentTaskId !== undefined && adopts && intent.plan.resolution === "modify") ? { workflow: document.rootId } : {}),
    ...(targetKey !== undefined && intent.plan.resolution === "modify" ? { standsAt: { ...intent.plan.standsAt, path: [targetKey] } } : {}),
    ...(intent.plan.move !== undefined && targetKey !== undefined && intent.plan.resolution === "modify" ? { move: { ...intent.plan.move, to: targetKey } } : {}),
    ...(adopted !== undefined ? { adopt: adopted } : {}),
    ...(document?.sourceKey !== undefined && adopts ? { adoptedAs: document.sourceKey } : {}),
    ...(adopted?.branch !== undefined && intent.plan.resolution === "modify" ? { branch: adopted.branch } : {}),
  };
  const undo: ConnectUndo =
    adopts && parentTaskId !== undefined
      ? { kind: "adopt", parentTaskId, adoptedTaskId: taskId, made: true, mark }
      : { kind: "move", taskId, mark, ...(intent.before.pin !== undefined ? { pin: intent.before.pin } : {}), ...(intent.before.wasCompleted === true ? { wasCompleted: true } : {}) };
  log.info(`connected ${taskId} to '${sourceStateId(intent.request.target)}' (${intent.plan.resolution}${intent.plan.modification !== undefined ? `, ${intent.plan.modification}` : ""})${parentTaskId !== undefined ? ` through ${parentTaskId}` : ""}${document?.documentId !== undefined ? `, ${document.documentId}` : ""}`);
  return {
    ok: true,
    dryRun: false,
    plan,
    taskId: adopts && parentTaskId !== undefined ? parentTaskId : taskId,
    ...(moved?.moved !== undefined ? { moved: moved.moved } : {}),
    ...(moved?.controlTaskId !== undefined ? { controlTaskId: moved.controlTaskId } : {}),
    undo,
  };
}

/** One step — see {@link finishConnect}. */
async function runStep(
  project: Project,
  taskId: string,
  open: OpenConnectIntent,
  results: ReadonlyArray<ConnectStepResult | undefined>,
  index: number,
  host: ConnectHost,
  projectRef: string | undefined,
): Promise<StepOutcome> {
  const { intent, atMs, mark } = open;
  const step = intent.steps[index]!;
  const asked = intent.request;
  const target = sourceStateId(asked.target);
  const title = project.tasks.tryRead(taskId)?.title ?? taskId;
  const earlier = (key: keyof ConnectStepResult): ConnectStepResult | undefined => results.slice(0, index).find((result) => result?.[key] !== undefined);
  const document = earlier("documentId") ?? earlier("targetKey");
  const parentTaskId = earlier("parentTaskId")?.parentTaskId;
  const on = (which: "task" | "parent"): string | undefined => (which === "parent" ? parentTaskId : taskId);
  const keyOf = (key: string): string => (key === TARGET_KEY ? (document?.targetKey ?? key) : key);
  const pass = projectRef !== undefined ? { project: projectRef } : {};
  const scripted = { ...(asked.interactions !== undefined ? { interactions: asked.interactions } : {}), ...(asked.fake !== undefined ? { fake: asked.fake } : {}) };

  switch (step.kind) {
    case "document": {
      const own = sourceStateId(project.tasks.tryRead(taskId)?.workflow ?? "");
      const found = documentMadeBy(project, taskId, target, atMs);
      if (found !== undefined) return { result: documentResult(found, target, own) };
      const suppliedLiterals = generatorSupplied(asked.supplied);
      let made: GenerateVersionResult;
      try {
        made = await generateDocumentVersion(project, {
          taskId,
          target,
          conversation: step.conversation,
          ...(suppliedLiterals !== undefined ? { supplied: suppliedLiterals } : {}),
          ...(host.functions !== undefined ? { functions: host.functions } : {}),
        });
      } catch (e) {
        return { refusal: { code: "generate", message: (e as Error).message } };
      }
      if (made.resolution === "unsettled") return { refusal: { code: "generate", message: `the workflow for '${target}' could not be generated` } };
      return {
        result: {
          ...(made.document !== undefined ? documentResult(made.document, target, own) : {}),
          targetKey: made.generated.targetKey,
        },
      };
    }
    case "parent": {
      const doc = document?.documentId !== undefined ? tryReadDocument(project.paths.snapshotsDir, document.documentId) : undefined;
      if (doc === undefined) return { refusal: { code: "generate", message: `the workflow '${title}' was to be moved into is gone` } };
      // Made already, by this drop, and not marked — the task standing in the document since the intent.
      const made = project.tasks
        .list()
        .find((meta) => meta.id !== taskId && project.runtime.get(meta.id)?.documentId === doc.id && Date.parse(meta.createdAt) >= atMs - 1);
      if (made !== undefined) return { result: { parentTaskId: made.id } };
      const parent = createTask(project, {
        title: step.title,
        workflow: doc.rootId,
        documentId: doc.id,
        ...(step.inputs !== undefined ? { inputs: step.inputs, ...(step.provenance !== undefined ? { inputProvenance: step.provenance } : {}) } : {}),
      });
      return { result: { parentTaskId: parent.id } };
    }
    case "adopt": {
      const meta = project.tasks.tryRead(taskId);
      const into = step.intoParent === true ? parentTaskId : undefined;
      if (step.intoParent === true && into === undefined) return { refusal: { code: "adopt", message: `there is no task for '${title}' to be adopted into` } };
      // Adopted already, by this drop — the one thing an adoption leaves on the adopted task.
      if (meta?.origin?.kind === "adopt" && (into === undefined || meta.origin.taskId === into)) return { result: { parentTaskId: meta.origin.taskId } };
      const childKey = document?.sourceKey ?? step.childKey;
      const adopted = await host.adopt({
        taskId,
        ...(into !== undefined ? { parentTaskId: into } : { workflow: step.workflow! }),
        ...(childKey !== undefined ? { childKey } : {}),
        start: step.start,
        ...(step.inputs !== undefined ? { inputs: step.inputs } : {}),
        ...(step.suppliedVia !== undefined ? { suppliedVia: step.suppliedVia } : {}),
        ...(into === undefined ? scripted : {}),
        ...pass,
      });
      if (!adopted.ok) {
        const message =
          into !== undefined && document?.documentId !== undefined
            ? `the workflow was made (${document.documentId}) and '${project.tasks.tryRead(into)?.title ?? into}' (${into}) stands in it, but '${title}' could not be adopted into it: ${adopted.refusal.message}`
            : adopted.refusal.message;
        return { refusal: { code: "adopt", message, adopt: adopted.refusal } };
      }
      return { result: { parentTaskId: adopted.taskId ?? into!, adopt: adopted.plan } };
    }
    case "supplied": {
      const where = on(step.on);
      if (where === undefined) return { refusal: { code: "adopt", message: `there is no task for what was supplied to '${title}' to be journaled on` } };
      // Journaled already, by this drop, and not marked.
      const journaled = project.events.list(where).some((stored) => (stored.event as unknown as Partial<SuppliedEvent>).type === SUPPLIED_EVENT && (stored.event as unknown as Partial<SuppliedEvent>).mark === mark);
      if (!journaled) {
        recordSupplied(project, where, { ...(step.instanceId !== undefined ? { instanceId: step.instanceId } : {}), to: keyOf(step.to), ...(step.nested === true ? { nested: true } : {}) }, asked.supplied, step.names, mark);
      }
      return { result: {} };
    }
    case "move": {
      const where = on(step.on);
      if (where === undefined) return { refusal: { code: "adopt", message: `there is no task for '${title}' to move` } };
      const move = { ...step.move, to: keyOf(step.move.to) };
      if (moveTakenSince(project, where, move.to, atMs)) return { result: { moved: "taking" } };
      const moved = await host.move({ ...moveRequest(asked, where, move, step.inputs), ...pass });
      return { result: { moved: moved.status } };
    }
    case "fastForward": {
      const where = on(step.on);
      if (where === undefined) return { refusal: { code: "adopt", message: `there is no task for '${title}' to run forward` } };
      if (host.fastForward === undefined) return { refusal: fastForwardRefusal(step.move) };
      const started = fastForwardSince(project, where, atMs);
      if (started !== undefined) return { result: { moved: "fast-forwarding", controlTaskId: started } };
      const running = await host.fastForward({ ...fastForwardRequest(asked, where, target, step.move, step.inputs ?? {}), ...pass });
      return { result: { moved: "fast-forwarding", controlTaskId: running.controlTaskId } };
    }
  }
}

/** What a document step made, read off the document — its key for the target, and for the task it wraps. */
function documentResult(document: FrozenDocument, target: string, own: string): ConnectStepResult {
  const mounts = Object.entries(document.versions.flatMap((version) => Object.entries(version.additions?.children ?? {})).reduce<Record<string, unknown>>((all, [key, mount]) => ({ ...all, [key]: mount }), {}));
  const keyOf = (state: string): string | undefined => mounts.find(([, mount]) => sourceStateId(String((mount as { state?: unknown }).state ?? "")) === state)?.[0];
  const targetKey = keyOf(target);
  const sourceKey = own !== "" ? keyOf(own) : undefined;
  return { documentId: document.id, rootId: document.rootId, ...(targetKey !== undefined ? { targetKey } : {}), ...(sourceKey !== undefined ? { sourceKey } : {}) };
}

/**
 * A document version this drop wrote and never marked: the newest version of a document whose cause
 * is this task moved to this target, written at or after the intent. The task's own document first —
 * a clone or an augmentation — then any dynamic document, which is where a `new` one is.
 */
function documentMadeBy(project: Project, taskId: string, target: string, sinceMs: number): FrozenDocument | undefined {
  const byThisDrop = (document: FrozenDocument | undefined): boolean => {
    const latest = document?.versions.at(-1);
    return latest !== undefined && latest.cause?.taskId === taskId && latest.cause.target === target && Date.parse(latest.createdAt) >= sinceMs - 1;
  };
  const own = project.runtime.get(taskId)?.documentId;
  const mine = own !== undefined ? tryReadDocument(project.paths.snapshotsDir, own) : undefined;
  if (byThisDrop(mine)) return mine;
  return listDocuments(project.paths.snapshotsDir).find((document) => document.kind === "dynamic" && document.versions.length === 1 && byThisDrop(document));
}

/** The move to `to` has been handed over since `sinceMs` — held, taken, reopened for, or entered. */
function moveTakenSince(project: Project, taskId: string, to: string, sinceMs: number): boolean {
  return project.events.list(taskId).some((stored) => {
    if (stored.createdAt < sinceMs) return false;
    const e = stored.event as unknown as { type: string; to?: string; by?: string; childKey?: string };
    return (e.type === MOVE_HELD_EVENT && e.to === to) || e.type === REOPENED_EVENT || (e.type === "transition.taken" && e.by !== undefined && e.to === to) || (e.type === "instance.entered" && e.childKey === to);
  });
}

/** The fast-forward started since `sinceMs`, by the conversation answering it — absent when none did. */
function fastForwardSince(project: Project, taskId: string, sinceMs: number): string | undefined {
  const row = project.events.list(taskId).find((stored) => stored.createdAt >= sinceMs && (stored.event as unknown as { type: string }).type === FAST_FORWARD_EVENT);
  return row === undefined ? undefined : (row.event as unknown as FastForwardEvent).controlTaskId;
}

/** Why a different drop of a task is refused while an earlier one is not finished. */
function connectingRefusal(project: Project, taskId: string, open: OpenConnectIntent): ConnectRefusal {
  const title = project.tasks.tryRead(taskId)?.title ?? taskId;
  const at = open.stopped !== undefined ? ` — it stopped at ${STEP_WORDS[open.intent.steps[open.stopped.step]?.kind ?? "move"]}: ${open.stopped.reason}` : "";
  return {
    code: "connecting",
    message: `'${title}' is still being moved to '${sourceStateId(open.intent.request.target)}'${at}. Drop it there again to finish that move first`,
  };
}

// ---------------------------------------------------------------------------------------------------
// adopt, for a host with no service around it
// ---------------------------------------------------------------------------------------------------

/**
 * ADOPT as `task:adopt` answers it, without starting anything — what the CLI lends `connectTask` as
 * its `adopt`. The app's `AppService.adoptTask` is the same composition with a service's concerns
 * around it (a live-run check, logging, starting the parent); the rules are all `adopt.ts`'s.
 */
export async function adoptTaskIn(project: Project, request: TaskAdoptRequest, deps: { check?: ValueCheck } = {}): Promise<TaskAdoptResult> {
  const dryRun = request.dryRun === true;
  const into = request.parentTaskId !== undefined ? project.runtime.get(request.parentTaskId) : undefined;
  const intoMeta = request.parentTaskId !== undefined ? project.tasks.tryRead(request.parentTaskId) : undefined;
  if (request.parentTaskId !== undefined && (into === undefined || intoMeta === undefined)) {
    return { ok: false, dryRun, refusal: { code: "unknown-task", message: `unknown task '${request.parentTaskId}'` } };
  }
  if (request.parentTaskId !== undefined && project.jobs.liveRunJob(request.parentTaskId, Date.now()) !== undefined) {
    return { ok: false, dryRun, refusal: { code: "parent-state", message: `'${intoMeta!.title}' is running — a task adopts only while it is not` } };
  }
  const workflow = intoMeta?.workflow ?? request.workflow;
  if (workflow === undefined) return { ok: false, dryRun, refusal: { code: "unknown-workflow", message: "an adoption names the workflow that adopts, or the task that does" } };
  const pinnedAlready = into !== undefined && (into.snapshotHash !== undefined || into.documentId !== undefined);
  const input = {
    workflow,
    ...(request.parentTaskId !== undefined ? { parentTaskId: request.parentTaskId } : {}),
    targets: [{ taskId: request.taskId, ...(request.childKey !== undefined ? { childKey: request.childKey } : {}) }, ...(request.also ?? [])],
    ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
    ...(request.suppliedVia !== undefined ? { suppliedVia: request.suppliedVia } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
  };
  let pin: { bundle: WorkflowBundle; hash?: string };
  try {
    if (pinnedAlready) pin = { bundle: loadPinnedBundle(project, into!) };
    else if (dryRun) {
      const bundle = bundleFor(project, workflow);
      if (bundle === undefined) return { ok: false, dryRun, refusal: { code: "unknown-workflow", message: `workflow '${workflow}' does not load` } };
      pin = { bundle };
    } else pin = await pinWorkflow(project, workflow);
  } catch (e) {
    if (e instanceof ApprovalRequired) throw e;
    return { ok: false, dryRun, refusal: { code: "unknown-workflow", message: (e as Error).message } };
  }
  const outcome = planAdoption(project, pin.bundle, input, deps);
  if (!outcome.ok) return { ok: false, dryRun, refusal: outcome.refusal };
  if (dryRun) return { ok: true, dryRun, plan: outcome.planned.plan };
  const missing = missingInputs(outcome.planned.plan);
  if (missing !== undefined) return { ok: false, dryRun, refusal: missing };
  const parent = writeAdoption(project, pin, outcome.planned);
  return { ok: true, dryRun, plan: outcome.planned.plan, taskId: parent.id, started: false };
}
