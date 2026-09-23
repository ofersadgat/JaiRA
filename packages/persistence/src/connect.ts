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
 *     for a mount of the target; the shared ancestor is the deepest instance the task stands in that
 *     the path to the target passes through. Behind where it stands is a backward move. Ahead of it
 *     is a forward one, which is a FAST-FORWARD by default (step 7): no transition at all — the host
 *     is asked for the mode (`ConnectHost.fastForward`) and the machine runs the states between, its
 *     conversation answering on the way. A host that drives no run has no such operation, and there a
 *     forward move is refused unless it says `skip`. A rule of the workflow already waiting on
 *     exactly this move is answered instead, and steps over nothing.
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
 * ancestor entered on the way down to it. What they leave open a CONVERSATION may supply
 * (`request.supplied`, step 6) — inferred from what was said, or asked of the person in words — and
 * each supplied value is journaled with which of the two it was (`jaira.supplied`). A required input
 * still open refuses the connect with the input, its declared schema and description, and why: that
 * refusal is what the conversation's `move` and `start` tools hand the model, which supplies the
 * value and calls again. A DROP has nobody to hand it to, so it says `askAfter`: where the workflow
 * is being modified anyway, the conversation is made without the target and asks.
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
import { ApprovalRequired, SUPPLIED_EVENT, type ConnectSupplied, type SuppliedEvent } from "@jaira/shared";
import { childrenReadBy, missingInputs, plainInputOf, planAdoption, writeAdoption, type ValueCheck } from "./adopt";
import { DYNAMIC_ROOT_PREFIX, loadPinnedBundle } from "./documents";
import { generateDocumentVersion, type GenerateVersionResult } from "./dynamicDocuments";
import { createTask, pinWorkflow } from "./lifecycle";
import { buildTaskLoad } from "./load";
import { dropConnectUndo } from "./connectUndo";
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
}

const refused = (dryRun: boolean, refusal: ConnectRefusal, plan?: ConnectPlan): TaskConnectResult => ({ ok: false, dryRun, refusal, ...(plan !== undefined ? { plan } : {}) });

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
): void {
  const provenance: SuppliedEvent["provenance"] = {};
  for (const name of names) {
    const entry = supplied?.[name];
    if (entry !== undefined) provenance[name] = { via: entry.via, ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}) };
  }
  if (Object.keys(provenance).length === 0) return;
  const event: SuppliedEvent = { type: SUPPLIED_EVENT, ...(at.instanceId !== undefined ? { instanceId: at.instanceId } : {}), to: at.to, ...(at.nested === true ? { nested: true } : {}), provenance };
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

/** A declared schema in a few words, for a model reading what it is about to ask for. */
function schemaWords(schema: JsonValue | undefined): string | undefined {
  if (schema === undefined || (typeof schema === "object" && schema !== null && !Array.isArray(schema) && Object.keys(schema).length === 0)) return undefined;
  return JSON.stringify(schema);
}

/**
 * The OPENING TURN of a conversation an `askAfter` drop made (decision 0005 §4 "Inputs", 3: asked) —
 * what the host hands that conversation, which the model answers with the question itself.
 *
 * It says what the person did (the same sentence the conversation is opened with), then each input
 * the target still needs by its declared description and schema, and what to do with the answer.
 * The names are the target's OWN declared names, passed through as `start_task` needs them: nothing
 * here knows what any of them means (§0), which is why the model is told to ask in plain words from
 * the descriptions rather than to read the names back to the person.
 */
export function askingMessage(title: string, target: string, asking: readonly ConnectMissingInput[]): string {
  const one = asking.length === 1;
  const lines = asking.map((m) => {
    const what = [m.description, schemaWords(m.schema) !== undefined ? `schema ${schemaWords(m.schema)}` : undefined].filter((part) => part !== undefined).join(" — ");
    return `- \`${m.name}\`${sourceStateId(m.state) !== sourceStateId(target) ? ` (of \`${m.state}\`)` : ""}${what !== "" ? `: ${what}` : ""}`;
  });
  return [
    `${moveSentence(title, target)} ${target} needs ${one ? "an input" : `${asking.length} inputs`} that nothing the task produced gives, so the move has not been taken yet:`,
    ...lines,
    "",
    `Ask the person for ${one ? "it" : "them"} now, in words: one short message, in plain language drawn from ${one ? "the description" : "the descriptions"}, and nothing else yet. ` +
      `When they answer, call \`start_task\` with state \`${target}\` and ${one ? "the value" : "the values"}, naming ${one ? "it" : "each"} in \`asked\`.`,
  ].join("\n");
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

const skipOf = (request: TaskConnectRequest): boolean => request.skip === true || request.forward === "skip";

/**
 * A forward move nobody here can run (§4): no host to drive one, so there is nobody to answer on
 * the way. Skip is the whole of what is left, and it is what the CLI has always used.
 */
function fastForwardRefusal(move: ConnectMove): ConnectRefusal {
  return {
    code: "fast-forward",
    message:
      `'${[move.to, ...move.path].join("/")}' is ahead of where the task stands, past ${move.passes.map((p) => `'${p}'`).join(", ")}. ` +
      `Running the states between (fast-forward) needs a conversation to answer what comes up on the way, and there is none here — ` +
      `say skip to go there directly, which records ${move.passes.length === 1 ? "it" : "them"} as skipped`,
  };
}

/** The mode a forward move asks the host for — see {@link ConnectHost.fastForward}. */
function fastForwardRequest(request: TaskConnectRequest, taskId: string, target: string, move: ConnectMove, inputs: Record<string, JsonValue>): TaskFastForwardRequest {
  return {
    taskId,
    target,
    toState: move.to,
    ...(move.instanceId !== undefined ? { instanceId: move.instanceId } : {}),
    ...(move.path.length > 0 ? { path: [...move.path] } : {}),
    ...(move.passes.length > 0 ? { through: [...move.passes] } : {}),
    by: request.by ?? "person",
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(request.project !== undefined ? { project: request.project } : {}),
    ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
    ...(request.fake !== undefined ? { fake: request.fake } : {}),
  };
}

function moveRequest(request: TaskConnectRequest, taskId: string, move: ConnectMove, inputs: Record<string, JsonValue> = {}): TaskMoveRequest {
  return {
    taskId,
    toState: move.to,
    by: request.by ?? "person",
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(request.project !== undefined ? { project: request.project } : {}),
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
  const result = await connectOnce(project, request, host);
  if (result.ok && !result.dryRun) dropConnectUndo(project, request.taskId);
  return result;
}

async function connectOnce(project: Project, request: TaskConnectRequest, host: ConnectHost): Promise<TaskConnectResult> {
  const dryRun = request.dryRun === true;
  const { taskId } = request;
  const meta = project.tasks.tryRead(taskId);
  const row = project.runtime.get(taskId);
  if (meta === undefined || row === undefined) return refused(dryRun, { code: "unknown-task", message: `unknown task '${taskId}'` });
  const target = sourceStateId(request.target);
  const running = host.running?.(taskId) ?? (row.status === "running" || row.status === "stopping");
  const lastSeq = (): number => project.events.list(taskId).at(-1)?.seq ?? 0;
  const pinNow = row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash, ...(row.documentId !== undefined ? { documentId: row.documentId } : {}) } : undefined;
  const moveUndo = (): ConnectUndo => ({ kind: "move", taskId, after: lastSeq(), ...(pinNow !== undefined ? { pin: pinNow } : {}), ...(row.status === "completed" ? { wasCompleted: true } : {}) });

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
      // The path that shares most with where the task stands; then the shortest.
      const standing: string[] = [];
      for (let node: LoadedInstance | undefined = lastChildOf(load.loaded); node?.childKey !== undefined; node = lastChildOf(node)) standing.push(node.childKey);
      const shared = (keys: readonly string[]): number => {
        let n = 0;
        while (n < keys.length && n < standing.length && keys[n] === standing[n]) n += 1;
        return n;
      };
      const keys = [...paths].sort((a, b) => shared(b) - shared(a) || a.length - b.length)[0]!;
      const within = resolveWithin({ bundle, loaded: load.loaded, keys, skip: skipOf(request), running, offered: host.offered?.(taskId) ?? [] });
      const states = statesAlong(bundle, keys);
      const plan: ConnectPlan = {
        resolution: "move",
        workflow: own,
        ...(states[0]?.label !== undefined ? { workflowLabel: states[0].label } : {}),
        standsAt: { path: [...keys], stateId: target, ...(states.at(-1)?.label !== undefined ? { label: states.at(-1)!.label! } : {}) },
        move: within.move,
        ...(within.move.direction === "forward" ? { forward: skipOf(request) ? ("skip" as const) : ("fast-forward" as const) } : {}),
        inputs: within.inputs,
        asks: within.asks,
      };
      // FORWARD, past states nobody has run: the machine runs them (§4). Not a transition at all —
      // the host is asked for the MODE, and the spine walks itself into the target.
      const forward = within.move.direction === "forward" && !skipOf(request);
      if (forward && host.fastForward === undefined) return refused(dryRun, fastForwardRefusal(within.move), plan);
      const blocked = forward ? host.fastForwardBlocked?.(taskId) : undefined;
      if (blocked !== undefined) return refused(dryRun, { code: "fast-forward", message: blocked }, plan);
      const open = stillMissing(within.missing, request.supplied, target);
      if (open.length > 0 && within.move.answersRule !== true) {
        return refused(dryRun, { code: "inputs-missing", message: `moving '${meta.title}' to '${keys.join("/")}' leaves required inputs unbound: ${missingSentence(open)}`, missing: open }, plan);
      }
      if (dryRun) return { ok: true, dryRun, plan, taskId };
      const undo = moveUndo();
      const handed = suppliedFor(request.supplied, states.at(-1));
      recordSupplied(project, taskId, { ...(within.move.instanceId !== undefined ? { instanceId: within.move.instanceId } : {}), to: keys.at(-1)!, nested: within.move.path.length > 0 }, request.supplied, Object.keys(handed));
      if (forward) {
        const running = await host.fastForward!(fastForwardRequest(request, taskId, target, within.move, handed));
        return { ok: true, dryRun, plan, taskId, moved: "fast-forwarding", controlTaskId: running.controlTaskId, undo };
      }
      const moved = await host.move(moveRequest(request, taskId, within.move, handed));
      return { ok: true, dryRun, plan, taskId, moved: moved.status, undo };
    }
  }

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
    if (candidate !== undefined) return adoptInto(project, request, host, { title: meta.title, own, target, candidate });
  }

  // ---- rule 3: the workflow is modified -----------------------------------------------------------
  if (row.snapshotHash === undefined && row.documentId === undefined) {
    return refused(dryRun, { code: "never-run", message: `'${meta.title}' has never run, so it stands nowhere to be moved from — start it instead` });
  }
  if (loadsNothing(project, target)) return refused(dryRun, { code: "unknown-target", message: `no state '${target}' was found on the workflow path` });
  const finishedWell = row.status === "completed" && (row.outcome === undefined || row.outcome === "success");
  const modification: NonNullable<ConnectPlan["modification"]> = inDocument ? "augmented" : finishedWell ? "new" : "cloned";
  if (running) {
    return refused(dryRun, {
      code: "running",
      message: `'${meta.title}' is running, and no workflow relates '${own}' to '${target}': the move is a new transition, which a task picks up the next time it loads. Pause it, then move it`,
    });
  }
  const conversation = host.conversation ?? CONNECT_CONVERSATION;
  const suppliedLiterals = generatorSupplied(request.supplied);
  const generate = (dry: boolean, withoutTarget = false): Promise<GenerateVersionResult> =>
    generateDocumentVersion(project, {
      taskId,
      target,
      conversation,
      ...(suppliedLiterals !== undefined ? { supplied: suppliedLiterals } : {}),
      ...(host.functions !== undefined ? { functions: host.functions } : {}),
      ...(dry ? { dryRun: true } : {}),
      ...(withoutTarget ? { withoutTarget: true } : {}),
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
  });
  const wouldStandIn = modification === "new" ? `${DYNAMIC_ROOT_PREFIX}…` : meta.workflow;
  if (!generated.ok) {
    const missing = generated.unsettled.filter((u) => u.required).map((u) => unsettledAsMissing(target, u));
    if (request.askAfter === true) return askAfter(project, request, host, { title: meta.title, own, target, conversation, modification, missing, plan: planOf(wouldStandIn), generate, undo: moveUndo });
    return refused(dryRun, { code: "inputs-missing", message: `a move of '${meta.title}' to '${target}' leaves required inputs unbound: ${missingSentence(missing)}`, missing }, planOf(wouldStandIn));
  }
  const opening = modification === "new" ? conversationInputs(project, conversation, moveSentence(meta.title, target), host.check) : undefined;
  if (opening !== undefined && opening.missing.length > 0) {
    return refused(dryRun, { code: "inputs-missing", message: `the conversation '${conversation}' cannot be opened by a move: ${missingSentence(opening.missing)}`, missing: opening.missing }, planOf(wouldStandIn));
  }
  if (dryRun) return { ok: true, dryRun, plan: { ...planOf(wouldStandIn), ...(modification === "new" ? { adoptedAs: Object.keys(generated.additions.children)[0] ?? generated.targetKey } : {}) }, ...(modification !== "new" ? { taskId } : {}) };

  // The real thing. Anything past this point has written: the document first, then its task, then
  // the adoption — each usable on its own if the next refuses, and each said in the refusal.
  let made: GenerateVersionResult;
  try {
    made = await generate(false);
  } catch (e) {
    return refused(dryRun, { code: "generate", message: (e as Error).message });
  }
  if (made.resolution === "unsettled") return refused(dryRun, { code: "generate", message: `the workflow for '${target}' could not be generated` });
  const targetKey = made.generated.targetKey;

  const literalNames = made.generated.literals.map((literal) => literal.input);
  if (modification !== "new") {
    const plan = planOf(meta.workflow);
    const undo = moveUndo();
    recordSupplied(project, taskId, { to: targetKey }, request.supplied, literalNames);
    const moved = await host.move(moveRequest(request, taskId, plan.move!));
    log.info(`connected ${taskId} to '${target}' by ${made.resolution === "cloned" ? "cloning its workflow" : "augmenting its document"} (${made.document?.id ?? "?"})`);
    return { ok: true, dryRun, plan, taskId, moved: moved.status, undo };
  }

  // NEW: the document's task, with the source adopted into it as the first child.
  const document = made.document!;
  const sourceKey = Object.entries(made.generated.additions.children).find(([, mount]) => sourceStateId(String(mount["state"])) === own)?.[0];
  const parent = createTask(project, {
    title: meta.title,
    workflow: document.rootId,
    documentId: document.id,
    ...(Object.keys(opening!.inputs).length > 0 ? { inputs: opening!.inputs, inputProvenance: opening!.provenance } : {}),
  });
  const adopted = await host.adopt({
    taskId,
    parentTaskId: parent.id,
    ...(sourceKey !== undefined ? { childKey: sourceKey } : {}),
    ...(request.project !== undefined ? { project: request.project } : {}),
    start: false,
  });
  if (!adopted.ok) {
    return refused(dryRun, { code: "adopt", message: `the workflow was made (${document.id}) and '${parent.title}' (${parent.id}) stands in it, but '${meta.title}' could not be adopted into it: ${adopted.refusal.message}`, adopt: adopted.refusal });
  }
  const plan: ConnectPlan = { ...planOf(document.rootId), standsAt: { path: [targetKey], stateId: target }, adopt: adopted.plan, ...(sourceKey !== undefined ? { adoptedAs: sourceKey } : {}), ...(adopted.plan.branch !== undefined ? { branch: adopted.plan.branch } : {}) };
  const undo: ConnectUndo = { kind: "adopt", parentTaskId: parent.id, adoptedTaskId: taskId, made: true };
  recordSupplied(project, parent.id, { to: targetKey }, request.supplied, literalNames);
  const moved = await host.move(moveRequest(request, parent.id, plan.move!));
  log.info(`connected ${taskId} to '${target}' through a new workflow ${document.id}: adopted into ${parent.id} as '${sourceKey ?? "?"}'`);
  return { ok: true, dryRun, plan, taskId: parent.id, moved: moved.status, undo };
}

/**
 * A drop that has to ASK (step 6): the workflow is being modified anyway, its target's required
 * inputs are open, and the person is not in a conversation that could be handed the refusal. So the
 * conversation is made — without the target — and the answer says what it is about to ask for. The
 * task does not move; the conversation's own `start_task` mounts the target with what it is told.
 * The host then gives that conversation its opening turn ({@link askingMessage}).
 *
 *  - `new`       — the document holds the conversation and what already ran; its task is made and
 *                  the source adopted into it, idle (`load.ts`, "A conversation starts idle").
 *  - `cloned`    — the task's frozen copy diverges with the conversation grafted on.
 *  - `augmented` — the task already stands in a document, which has a conversation: nothing is written.
 *
 * A DRY RUN answers the same `asking` and writes nothing, so a hover says the drop makes a
 * conversation that asks rather than that it would be refused.
 */
async function askAfter(
  project: Project,
  request: TaskConnectRequest,
  host: ConnectHost,
  at: {
    title: string;
    own: string;
    target: string;
    conversation: string;
    modification: NonNullable<ConnectPlan["modification"]>;
    missing: ConnectMissingInput[];
    plan: ConnectPlan;
    generate: (dry: boolean, withoutTarget?: boolean) => Promise<GenerateVersionResult>;
    /** The move-kind undo, taken BEFORE anything is written. */
    undo: () => ConnectUndo;
  },
): Promise<TaskConnectResult> {
  const { taskId } = request;
  const dryRun = request.dryRun === true;
  const { move: _move, ...standing } = at.plan;
  // Nothing but the conversation is written — the opening turn, and for a clone the pin — so the
  // undo cuts the journal back and puts the pin back, and resumes nothing.
  const undo: ConnectUndo = { ...(at.undo() as Extract<ConnectUndo, { kind: "move" }>), asking: true };
  if (at.modification === "augmented") return { ok: true, dryRun, plan: standing, taskId, asking: at.missing, ...(dryRun ? {} : { undo }) };
  const opening = at.modification === "new" ? conversationInputs(project, at.conversation, moveSentence(at.title, at.target), host.check) : undefined;
  if (opening !== undefined && opening.missing.length > 0) {
    return refused(dryRun, { code: "inputs-missing", message: `the conversation '${at.conversation}' cannot be opened by a move: ${missingSentence(opening.missing)}`, missing: opening.missing }, at.plan);
  }
  if (dryRun) return { ok: true, dryRun, plan: standing, ...(at.modification !== "new" ? { taskId } : {}), asking: at.missing };
  let made: GenerateVersionResult;
  try {
    made = await at.generate(false, true);
  } catch (e) {
    return refused(false, { code: "generate", message: (e as Error).message });
  }
  if (made.generated.deferred !== true || made.document === undefined) {
    // A root that already speaks needed no version: the conversation is the task's own.
    if (made.resolution === "unsettled") return { ok: true, dryRun: false, plan: standing, taskId, asking: at.missing, undo };
    return refused(false, { code: "generate", message: `the conversation for '${at.target}' could not be made` });
  }
  if (at.modification === "cloned") {
    log.info(`${taskId} was given a conversation (${made.document.id}) to ask for what '${at.target}' needs`);
    return { ok: true, dryRun: false, plan: { ...standing, workflow: made.document.rootId }, taskId, asking: at.missing, undo };
  }
  const document = made.document;
  const sourceKey = Object.entries(made.generated.additions.children).find(([, mount]) => sourceStateId(String(mount["state"])) === at.own)?.[0];
  const parent = createTask(project, {
    title: at.title,
    workflow: document.rootId,
    documentId: document.id,
    ...(Object.keys(opening!.inputs).length > 0 ? { inputs: opening!.inputs, inputProvenance: opening!.provenance } : {}),
  });
  const adopted = await host.adopt({ taskId, parentTaskId: parent.id, ...(sourceKey !== undefined ? { childKey: sourceKey } : {}), ...(request.project !== undefined ? { project: request.project } : {}), start: false });
  if (!adopted.ok) {
    return refused(false, { code: "adopt", message: `the workflow was made (${document.id}) and '${parent.title}' (${parent.id}) stands in it, but '${at.title}' could not be adopted into it: ${adopted.refusal.message}`, adopt: adopted.refusal });
  }
  log.info(`${taskId} was adopted into a new workflow ${document.id} (${parent.id}) whose conversation asks for what '${at.target}' needs`);
  return {
    ok: true,
    dryRun: false,
    plan: { ...standing, workflow: document.rootId, adopt: adopted.plan, ...(sourceKey !== undefined ? { adoptedAs: sourceKey } : {}) },
    taskId: parent.id,
    undo: { kind: "adopt", parentTaskId: parent.id, adoptedTaskId: taskId, made: true },
    asking: at.missing,
  };
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
  at: { title: string; own: string; target: string; candidate: ConnectCandidate },
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
  };
  const forward = needsMove && within!.move.direction === "forward" && !skipOf(request);
  if (forward && host.fastForward === undefined) return refused(dryRun, fastForwardRefusal(within!.move), plan);
  if (missing.length > 0) {
    return refused(dryRun, { code: "inputs-missing", message: `adopting '${at.title}' into '${candidate.workflow}' leaves required inputs unbound: ${missingSentence(missing)}`, missing }, plan);
  }
  if (dryRun) return { ok: true, dryRun, plan };

  const scripted = { ...(request.interactions !== undefined ? { interactions: request.interactions } : {}), ...(request.fake !== undefined ? { fake: request.fake } : {}) };
  const adopted = await host.adopt({
    taskId: request.taskId,
    workflow: candidate.workflow,
    childKey: candidate.childKey,
    // A move is taken by an engine that loads with it waiting, so the parent is not started twice.
    start: needsMove ? false : request.start !== false,
    ...(Object.keys(parentSupplied).length > 0
      ? { inputs: parentSupplied, suppliedVia: Object.keys(parentSupplied).every((name) => request.supplied![name]!.via === "asked") ? ("asked" as const) : ("inferred" as const) }
      : {}),
    ...scripted,
    ...pass,
  });
  if (!adopted.ok) return refused(dryRun, { code: "adopt", message: adopted.refusal.message, adopt: adopted.refusal }, plan);
  const parentId = adopted.taskId!;
  const undo: ConnectUndo = { kind: "adopt", parentTaskId: parentId, adoptedTaskId: request.taskId, made: true };
  if (!needsMove) return { ok: true, dryRun, plan: { ...plan, adopt: adopted.plan }, taskId: parentId, undo };
  const handed = suppliedFor(request.supplied, bundle.states[root.children?.[candidate.targetKey ?? ""]?.state ?? ""]);
  recordSupplied(project, parentId, { to: within!.move.to }, request.supplied, Object.keys(handed));
  if (forward) {
    const running = await host.fastForward!(fastForwardRequest(request, parentId, target, within!.move, handed));
    return { ok: true, dryRun, plan: { ...plan, adopt: adopted.plan }, taskId: parentId, moved: "fast-forwarding", controlTaskId: running.controlTaskId, undo };
  }
  const moved = await host.move(moveRequest(request, parentId, within!.move, handed));
  return { ok: true, dryRun, plan: { ...plan, adopt: adopted.plan }, taskId: parentId, moved: moved.status, undo };
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
