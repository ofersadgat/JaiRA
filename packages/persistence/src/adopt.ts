/**
 * ADOPT (decision 0005 §2): a task that ran alone becomes the child of a new task — by mirror rows,
 * written after the fact. Adoption ADOPTS; it never copies.
 *
 * The mechanism is the fan-out host's (`fanOut.ts`): an `each: "task"` element is a task of its own,
 * mirrored into its parent's journal as `instance.entered` / `instance.terminated` rows whose
 * instance id IS the task's id. An adoption writes the same two rows for a child that was never an
 * element — into the journal of a NEW parent task, under the child key that mounts the adopted
 * task's root state — and the parent's cursor stands past that child. The adopted task keeps its
 * journal, its sessions, its workspace and its card; what changes is `parentTaskId` and `origin`,
 * which is what files it under the parent on a board.
 *
 * ## The rows carry what the engine cannot recompute
 *
 * A loaded child's outputs are RECOMPUTED by the engine from its recorded operation and children
 * (`loadTerminated`), and a mirror row has neither — they are in the adopted task's journal, under a
 * definition that may since have changed. An `each: "task"` mount is answered by the host; a plain
 * mount has no host to ask. So two fields ride the rows that upstream's event types do not declare
 * (the journal stores the whole event as JSON, so they round-trip): `adopted: true` on the entry, and
 * `outputs` — as the task recorded them — on the end. The load (`load.ts`) turns such a node into
 * history whose state is a STAND-IN ({@link withAdoptedStandIns}): the mounted state's current output
 * slots with no bindings, fed the recorded outputs as its operation's value, so `finish()` validates
 * them against the current schema and hands them to the parent verbatim. The real state is untouched
 * in the bundle, which is what makes a back-transition into the child run it, in the parent, as
 * occurrence 1 — with the adopted task staying as occurrence 0's history.
 *
 * ## What is checked, and refused
 *
 *  - **Schema fit.** The task's root state must be the state the parent mounts. Its recorded outputs
 *    are validated against the CURRENT output slots; a misfit is refused with the path that failed.
 *  - **Holes.** Every spine child before the cursor is adopted, or read by nothing that runs later —
 *    a later child's wiring, the parent's own outputs, a transition's guard. The reference is named.
 *  - **Inputs, inferred backwards.** Where the parent binds the child's input by a plain path
 *    (`product.issue ← .inputs.issue`), the parent's input takes the value the child actually ran
 *    with. The form is asked only for what that does not determine; a required input nobody supplied
 *    refuses a real adoption and is listed by a dry run.
 *  - **The split shape.** A state the parent mounts `each: "split"` is adopted as the element it is:
 *    the new task is split on that list at the element's index, exactly as a split copy is, and the
 *    mount reads as an ordinary one inside it.
 *
 * ## Into a new task, or into one that exists
 *
 * The parent is a NEW task unless the caller names one (`AdoptionInput.parentTaskId`): a task that
 * something else made — `connect()` composing an adoption with a dynamic workflow's task — and that
 * has not reached the child yet. The rules are the same and the record is the constraint: what the
 * parent already ENTERED cannot be rewritten, so a child it has run is not adopted over, a parent
 * standing past the child is refused, its recorded inputs must agree with what the child ran with,
 * and one that has already run in a workspace keeps it.
 *
 * A task still RUNNING is adopted too: its entry is mirrored now, the parent is made holding for it
 * (`dependsOn`), and {@link settleAdoptions} writes the end — outputs checked then — when it
 * completes. The parent's load refuses while a mirror is still open, so nothing can run the child a
 * second time inside the parent.
 */
import { createLogger } from "@declarative-ai/log";
import type { JsonValue } from "@declarative-ai/json";
import { sourceStateId, uuidv7, type EngineEvent, type LoadedInstance, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import type { AdoptAsk, AdoptPlan, AdoptRefusal, AdoptedChild, AdoptionTarget, InputProvenance, InputSettledVia, SplitEntry, TaskMeta } from "@jaira/shared";
import { createTask } from "./lifecycle";
import { loadPinnedBundle } from "./documents";
import { loadSnapshot } from "./snapshots";
import type { Project } from "./project";

const log = createLogger("jaira.persistence.adopt");

/** The state id a mirrored adoption loads under — see the header. One stand-in per mounted state. */
export const ADOPTED_STATE_PREFIX = "jaira:adopted:";
/** The function the stand-in's operation names. Never dispatched: a stand-in is only ever history. */
export const ADOPTED_FUNCTION = "jaira.adopted";

/** `undefined` when the value fits; else where it does not, and why. Supplied by the host, which owns the validator. */
export type ValueCheck = (schema: JsonValue, value: JsonValue) => { path: string; message: string } | undefined;

export interface AdoptDeps {
  /** The run's own schema validation. Absent ⇒ presence is checked and shapes are not. */
  check?: ValueCheck;
  now?: () => number;
  newInstanceId?: () => string;
}

export interface AdoptionInput {
  workflow: string;
  /** Adopt INTO this task instead of a new one — see the header. `bundle` is then what it runs under. */
  parentTaskId?: string;
  targets: readonly AdoptionTarget[];
  inputs?: Record<string, JsonValue>;
  suppliedVia?: Exclude<InputSettledVia, "bound">;
  title?: string;
}

/** A child of the plan with what writing it needs. */
interface PlannedChild extends AdoptedChild {
  inputs: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  split?: SplitEntry;
  branch?: string;
  worktreePath?: string;
}

export interface PlannedAdoption {
  plan: AdoptPlan;
  children: PlannedChild[];
  /** The parent root's inputs as its `instance.entered` row records them: the plan's, with literal defaults applied. */
  entered: Record<string, JsonValue>;
  split: SplitEntry[];
  worktreePath?: string;
  /** The existing task being adopted into, and the root instance its journal already entered, if any. */
  parent?: { taskId: string; rootInstanceId?: string };
}

export type AdoptionOutcome = { ok: true; planned: PlannedAdoption } | { ok: false; refusal: AdoptRefusal };

const refuse = (refusal: AdoptRefusal): AdoptionOutcome => ({ ok: false, refusal });

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// reading lowered wiring
// ---------------------------------------------------------------------------------------------------

/** The literal text a lowered slot binds, when it binds one. */
function textOf(slot: unknown): string | undefined {
  const text = isRecord(slot) && isRecord(slot["binding"]) ? slot["binding"]["text"] : undefined;
  return typeof text === "string" ? text : undefined;
}

/** `context.get("<name>")` — a whole namespace read — when this op is one. */
function namespaceOf(op: unknown): string | undefined {
  if (!isRecord(op) || op["functionRef"] !== "context.get" || !isRecord(op["input"])) return undefined;
  return textOf(op["input"]["name"]);
}

/** `[namespace, member]` when this op reads one member of a namespace by a LITERAL name — either lowering. */
function memberOf(op: unknown): [string, string] | undefined {
  if (!isRecord(op) || !isRecord(op["input"])) return undefined;
  const input = op["input"];
  if (op["functionRef"] === "scope.get") {
    const scope = textOf(input["scope"]);
    const name = textOf(input["name"]);
    return scope !== undefined && name !== undefined ? [scope, name] : undefined;
  }
  if (op["functionRef"] === "op.member") {
    const value = isRecord(input["value"]) && isRecord(input["value"]["binding"]) ? input["value"]["binding"]["op"] : undefined;
    const namespace = namespaceOf(value);
    const prop = textOf(input["prop"]);
    return namespace !== undefined && prop !== undefined ? [namespace, prop] : undefined;
  }
  return undefined;
}

/**
 * The parent input a wire reads by a PLAIN path (`.inputs.issue`), or undefined for anything else —
 * an expression over it, a literal, a sibling's output. Only a plain path can be inferred backwards:
 * it is the one wiring whose value at the child IS the value at the parent.
 */
export function plainInputOf(ref: unknown): string | undefined {
  const member = isRecord(ref) ? memberOf(ref["op"]) : undefined;
  return member !== undefined && member[0] === "inputs" ? member[1] : undefined;
}

/**
 * The child keys a lowered ref READS, by walking it. `*` stands for a read of the whole `children`
 * namespace that names no key literally — which reads every child, as far as anyone can tell.
 */
export function childrenReadBy(ref: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(ref)) {
    for (const item of ref) childrenReadBy(item, out);
    return out;
  }
  if (!isRecord(ref)) return out;
  // A PRODUCER edge — `.children.ux.output.plan` lowers to a selection over `{ op: "ux" }`, the child
  // named as the producer it is rather than looked up in a namespace.
  if (typeof ref["op"] === "string") {
    out.add(ref["op"]);
    return out;
  }
  const member = memberOf(ref);
  if (member !== undefined && member[0] === "children") {
    out.add(member[1]);
    return out;
  }
  if (namespaceOf(ref) === "children") {
    out.add("*");
    return out;
  }
  for (const value of Object.values(ref)) childrenReadBy(value, out);
  return out;
}

/** Everything in the parent that runs AFTER the cursor and reads a child, as `[where, ref]`. */
function laterReaders(root: LoadedState, sequence: readonly string[], cursor: number): Array<[string, unknown]> {
  const readers: Array<[string, unknown]> = [];
  for (const key of sequence.slice(cursor + 1)) {
    const decl = root.children?.[key];
    if (decl === undefined) continue;
    for (const [name, ref] of Object.entries(decl.inputs ?? {})) readers.push([`children.${key}.inputs.${name}`, ref]);
    if (decl.asyncRef !== undefined) readers.push([`children.${key}.async`, decl.asyncRef]);
    (decl.transitions ?? []).forEach((rule, i) => readers.push([`children.${key}.transitions[${i}]`, rule]));
  }
  for (const [name, slot] of Object.entries(root.outputs ?? {})) {
    if (slot.binding !== undefined) readers.push([`outputs.${name}`, slot.binding]);
  }
  for (const [path, meta] of Object.entries(root.slotMeta ?? {})) {
    if (path.startsWith("outputs.") && meta.defaultRef !== undefined) readers.push([`${path}.default`, meta.defaultRef]);
  }
  (root.transitions ?? []).forEach((rule, i) => readers.push([`transitions[${i}]`, rule]));
  return readers;
}

// ---------------------------------------------------------------------------------------------------
// what a task recorded
// ---------------------------------------------------------------------------------------------------

/** The inputs a task's root actually ran with: what its journal entered, under what it was created with. */
function ranWith(project: Project, meta: TaskMeta): Record<string, JsonValue> {
  let entered: Record<string, JsonValue> = {};
  const stamped = project.runtime.get(meta.id)?.rootInstanceId;
  for (const row of project.events.list(meta.id)) {
    const event = row.event;
    if (event.type !== "instance.entered" || event.parentInstanceId !== undefined) continue;
    if (stamped !== undefined && event.instanceId !== stamped) continue;
    entered = (event.inputs ?? {}) as Record<string, JsonValue>;
  }
  // The task's own file wins: it holds what was typed, whole, where the journal may hold a reference.
  return { ...entered, ...(meta.inputs ?? {}) };
}

/**
 * Recorded outputs against the CURRENT output slots of the state the parent mounts.
 *
 * An artifact travels by reference and carries its own identity, not the slot's shape — the engine
 * lets one through for the same reason (`validateSlotValue`) — so only plain values meet a schema.
 */
export function fitOutputs(def: LoadedState, outputs: Record<string, JsonValue>, check?: ValueCheck): { path: string; message: string } | undefined {
  for (const [name, slot] of Object.entries(def.outputs ?? {})) {
    const meta = def.slotMeta?.[`outputs.${name}`];
    const value = outputs[name];
    if (value === undefined) {
      if (meta?.optional === true || meta?.default !== undefined || meta?.defaultRef !== undefined) continue;
      return { path: `outputs.${name}`, message: "is required, and the task did not produce it" };
    }
    if (slot.kind === "blob" || (isRecord(value) && value["artifact"] === true)) continue;
    const schema = slot.schema as JsonValue | undefined;
    if (check === undefined || schema === undefined || (isRecord(schema) && Object.keys(schema).length === 0)) continue;
    const miss = check(schema, value);
    if (miss !== undefined) return { path: `outputs.${name}${miss.path}`, message: miss.message };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------------------

/**
 * What adopting `targets` into a new task of `bundle`'s workflow would do — or why it cannot.
 *
 * Pure over the store: nothing is written, which is what makes it the dry run. `bundle` is the
 * parent workflow as it would be pinned — the live files for a hover, the pinned snapshot for the
 * adoption itself, so the plan that is written is the plan that was checked.
 */
export function planAdoption(project: Project, bundle: WorkflowBundle, input: AdoptionInput, deps: AdoptDeps = {}): AdoptionOutcome {
  const root = bundle.states[bundle.rootId];
  if (root === undefined) return refuse({ code: "unknown-workflow", message: `workflow '${input.workflow}' has no root state` });
  const sequence = root.sequence ?? Object.keys(root.children ?? {});
  const mounts = Object.entries(root.children ?? {});

  // --- the parent, when it already exists -----------------------------------------------------
  let standing: StandingParent | undefined;
  if (input.parentTaskId !== undefined) {
    const found = standingParentOf(project, input.parentTaskId);
    if ("code" in found) return refuse(found);
    standing = found;
    if (input.targets.some((target) => target.taskId === input.parentTaskId)) {
      return refuse({ code: "parent-state", message: `'${standing.meta.title}' cannot adopt itself` });
    }
  }

  // --- which child each task is ---------------------------------------------------------------
  const children: PlannedChild[] = [];
  for (const target of input.targets) {
    const meta = project.tasks.tryRead(target.taskId);
    const row = project.runtime.get(target.taskId);
    if (meta === undefined || row === undefined) return refuse({ code: "unknown-task", message: `unknown task '${target.taskId}'` });
    if (meta.origin !== undefined) {
      const owner = project.tasks.tryRead(meta.origin.taskId)?.title ?? meta.origin.taskId;
      return refuse({ code: "already-adopted", message: `'${meta.title}' already belongs to '${owner}' (${meta.origin.kind === "adopt" ? "adopted" : `each: "${meta.origin.kind}"`})` });
    }
    const ran = sourceStateId(meta.workflow);
    const fits = mounts.filter(([key, decl]) => sourceStateId(decl.state) === ran && (target.childKey === undefined || key === target.childKey));
    if (fits.length === 0) {
      const named = target.childKey !== undefined ? root.children?.[target.childKey] : undefined;
      return refuse({
        code: "not-mounted",
        message:
          named !== undefined
            ? `child '${target.childKey}' of '${input.workflow}' mounts '${sourceStateId(named.state)}', and '${meta.title}' ran '${ran}'`
            : `'${input.workflow}' mounts no child that runs '${ran}', which is what '${meta.title}' ran`,
      });
    }
    if (fits.length > 1) {
      return refuse({ code: "ambiguous-child", message: `'${input.workflow}' mounts '${ran}' as ${fits.map(([key]) => `'${key}'`).join(" and ")} — say which child '${meta.title}' is` });
    }
    const [childKey, decl] = fits[0]!;
    if (children.some((child) => child.childKey === childKey)) {
      return refuse({ code: "ambiguous-child", message: `two tasks were given for child '${childKey}' of '${input.workflow}'` });
    }
    const each = decl.each ?? [];
    if (each.length > 0 && decl.eachKind !== "split") {
      return refuse({
        code: "unsupported-mount",
        message: `child '${childKey}' of '${input.workflow}' fans out (each: "${decl.eachKind ?? "inline"}") — its elements belong to the batch that made them, and one task cannot stand for the mount`,
      });
    }
    const def = bundle.states[decl.state];
    if (def === undefined) return refuse({ code: "unknown-workflow", message: `'${input.workflow}' mounts '${decl.state}', which did not load` });

    const pending = !(row.status === "completed" && (row.outcome === undefined || row.outcome === "success"));
    const outputs = pending ? undefined : ((row.outputsJson !== undefined ? JSON.parse(row.outputsJson) : {}) as Record<string, JsonValue>);
    const stateChanged = hasStateChanged(project, row.snapshotHash, meta.workflow, def);
    if (outputs !== undefined) {
      const miss = fitOutputs(def, outputs, deps.check);
      if (miss !== undefined) {
        return refuse({
          code: "schema-misfit",
          message: `'${meta.title}' does not fit '${sourceStateId(decl.state)}' as it is now: ${miss.path} ${miss.message}`,
          path: miss.path,
        });
      }
    }
    children.push({
      taskId: meta.id,
      title: meta.title,
      childKey,
      stateId: decl.state,
      shape: decl.eachKind === "split" ? "split" : "child",
      pending,
      stateChanged,
      inputs: ranWith(project, meta),
      ...(outputs !== undefined ? { outputs } : {}),
      ...(meta.branch !== undefined ? { branch: meta.branch } : {}),
      ...(row.worktreePath !== undefined ? { worktreePath: row.worktreePath } : {}),
    });
  }
  if (children.length === 0) return refuse({ code: "unknown-task", message: "no task was given to adopt" });
  children.sort((a, b) => sequence.indexOf(a.childKey) - sequence.indexOf(b.childKey));
  if (standing !== undefined) {
    // What the parent already entered is its record. A child it ran is not adopted over, and mirror
    // rows land at the END of its journal — where the cursor reads them — so a parent that has gone
    // past the child would be sent back by them.
    const last = sequence.indexOf(children.at(-1)!.childKey);
    for (const child of children) {
      if (standing.entered.has(child.childKey)) {
        return refuse({ code: "parent-state", message: `'${standing.meta.title}' has already entered '${child.childKey}' — rewind it to before that, or adopt into a new task` });
      }
    }
    const past = sequence.slice(last + 1).find((key) => standing!.entered.has(key));
    if (past !== undefined) {
      return refuse({ code: "parent-state", message: `'${standing.meta.title}' already stands at '${past}', past '${children.at(-1)!.childKey}'` });
    }
  }

  // --- holes ----------------------------------------------------------------------------------
  const cursorKey = children.at(-1)!.childKey;
  const cursor = sequence.indexOf(cursorKey);
  const adoptedKeys = new Set(children.map((child) => child.childKey));
  // A child the existing parent ran itself is no hole: it is there to be read.
  const holes = new Set(sequence.slice(0, Math.max(cursor, 0)).filter((key) => !adoptedKeys.has(key) && standing?.succeeded.has(key) !== true));
  if (holes.size > 0) {
    for (const [where, ref] of laterReaders(root, sequence, cursor)) {
      const read = childrenReadBy(ref);
      const hit = [...holes].find((key) => read.has(key)) ?? (read.has("*") ? [...holes][0] : undefined);
      if (hit === undefined) continue;
      const reference = `${where} → children.${read.has(hit) ? hit : "*"}`;
      return refuse({
        code: "hole",
        message: `'${hit}' comes before '${cursorKey}' in '${input.workflow}', nothing was adopted for it, and ${where} reads it — adopt a task for '${hit}' too, or start '${input.workflow}' from the top`,
        reference,
      });
    }
  }

  // --- inputs, inferred backwards -------------------------------------------------------------
  // An existing parent's inputs are already its own: recorded on its root's entry where it has one,
  // else in its file. What the child ran with has to AGREE with them; it fills only what is absent.
  const inputs: Record<string, JsonValue> = { ...(standing?.inputs ?? {}) };
  const provenance: Record<string, InputProvenance> = { ...(standing?.meta.inputProvenance ?? {}) };
  for (const child of children) {
    const decl = root.children![child.childKey]!;
    const axes = new Set(decl.each ?? []);
    for (const [name, ref] of Object.entries(decl.inputs ?? {})) {
      if (axes.has(name)) continue;
      const parentInput = plainInputOf(ref);
      const value = child.inputs[name];
      if (parentInput === undefined || value === undefined || root.inputs?.[parentInput] === undefined) continue;
      if (inputs[parentInput] !== undefined && !deepEqual(inputs[parentInput], value)) {
        const other = provenance[parentInput]?.from?.taskId;
        return refuse({
          code: "inputs-conflict",
          message:
            other !== undefined
              ? `'${child.title}' and '${project.tasks.tryRead(other)?.title ?? other}' ran with different values of what '${input.workflow}' binds from one input ('${parentInput}')`
              : `'${child.title}' ran with a different value of '${parentInput}' than '${standing?.meta.title ?? input.workflow}' holds`,
        });
      }
      if (inputs[parentInput] !== undefined) continue;
      // A root already entered cannot be given an input after the fact; the child's value stands
      // unrecorded there, which is what an optional input the parent never had amounts to.
      if (standing?.rootInstanceId !== undefined) continue;
      inputs[parentInput] = value;
      provenance[parentInput] = { via: "bound", from: { taskId: child.taskId, input: name } };
    }
  }
  const supplied = input.suppliedVia ?? "asked";
  for (const [name, value] of Object.entries(input.inputs ?? {})) {
    // What the child ran with is the record; a form value for the same input would make the record lie.
    if (inputs[name] !== undefined || root.inputs?.[name] === undefined || standing?.rootInstanceId !== undefined) continue;
    inputs[name] = value;
    provenance[name] = { via: supplied };
  }
  const asks: AdoptAsk[] = [];
  const entered: Record<string, JsonValue> = { ...inputs };
  for (const [name, slot] of Object.entries(root.inputs ?? {})) {
    // A root that has entered asked for what it needed then; nothing is asked on its behalf now.
    if (standing?.rootInstanceId !== undefined) break;
    if (inputs[name] !== undefined || (slot as { binding?: unknown }).binding !== undefined) continue;
    const meta = root.slotMeta?.[`inputs.${name}`];
    if (meta?.default !== undefined) entered[name] = meta.default;
    asks.push({
      name,
      required: meta?.optional !== true && meta?.default === undefined && meta?.defaultRef === undefined,
      ...(slot.schema !== undefined ? { schema: slot.schema as JsonValue } : {}),
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
    });
  }

  // --- the split shape ------------------------------------------------------------------------
  const split: SplitEntry[] = [];
  for (const child of children) {
    if (child.shape !== "split") continue;
    const decl = root.children![child.childKey]!;
    const axis = decl.each?.[0];
    const expr = axis !== undefined ? decl.eachExprs?.[axis] : undefined;
    if (axis === undefined || expr === undefined) return refuse({ code: "split-element", message: `child '${child.childKey}' is each: "split" and names no list` });
    const element = child.inputs[axis];
    const list = splitListOf(expr.trim(), inputs, children);
    if (list === "unknown") {
      return refuse({
        code: "split-element",
        message: `'${child.childKey}' splits over ${expr}, which is neither an input of '${input.workflow}' nor an output of a child adopted with it — so which element '${child.title}' is cannot be said`,
        reference: expr,
      });
    }
    // The list is an input nobody has supplied yet: a dry run lists it under `asks`, a real adoption refuses below.
    if (list === undefined) continue;
    const idField = decl.spawn?.id;
    const index = list.findIndex(
      (item) => deepEqual(item, element) || (idField !== undefined && isRecord(item) && isRecord(element) && item[idField] !== undefined && item[idField] === element[idField]),
    );
    if (index < 0) {
      return refuse({ code: "split-element", message: `what '${child.title}' ran with is not an element of ${expr}`, reference: expr });
    }
    child.index = index;
    child.split = { expr, index };
    split.push(child.split);
  }

  // --- the workspace --------------------------------------------------------------------------
  const bound = children.filter((child) => child.branch !== undefined);
  const branches = new Set(bound.map((child) => child.branch!));
  if (branches.size > 1) {
    return refuse({ code: "workspace", message: `the adopted tasks stand on different branches (${[...branches].join(", ")}), and the parent can take up one` });
  }
  const workspace = bound.at(-1);
  if (standing !== undefined) {
    const theirs = workspace?.branch;
    const ours = standing.meta.branch;
    const ran = standing.rootInstanceId !== undefined;
    // A parent that has not run takes the child's workspace up as a new one does. One that has run
    // stands in a tree already, and it has to be the tree the child wrote in.
    if (ours !== theirs && (ran || ours !== undefined)) {
      const where = (branch: string | undefined): string => (branch !== undefined ? `branch '${branch}'` : "the project directory");
      return refuse({ code: "workspace", message: `'${standing.meta.title}' stands in ${where(ours)} and what it would adopt was written in ${where(theirs)}` });
    }
  }

  const plan: AdoptPlan = {
    workflow: input.workflow,
    ...(standing !== undefined ? { parentTaskId: standing.meta.id } : {}),
    title: standing?.meta.title ?? input.title ?? children.at(-1)!.title,
    adopted: children.map(({ inputs: _inputs, outputs: _outputs, split: _split, branch: _branch, worktreePath: _worktree, ...child }) => child),
    cursor: cursorKey,
    ...(sequence[cursor + 1] !== undefined ? { next: sequence[cursor + 1]! } : {}),
    inputs,
    provenance,
    asks,
    ...(workspace?.branch !== undefined ? { branch: workspace.branch } : {}),
    waitsFor: children.filter((child) => child.pending).map((child) => child.taskId),
  };
  return {
    ok: true,
    planned: {
      plan,
      children,
      entered,
      split,
      ...(workspace?.worktreePath !== undefined ? { worktreePath: workspace.worktreePath } : {}),
      ...(standing !== undefined ? { parent: { taskId: standing.meta.id, ...(standing.rootInstanceId !== undefined ? { rootInstanceId: standing.rootInstanceId } : {}) } } : {}),
    },
  };
}

/** An existing task as an adoption finds it: its file, and what its journal has already entered. */
interface StandingParent {
  meta: TaskMeta;
  /** Its root instance, when its journal has entered one. */
  rootInstanceId?: string;
  /** The inputs on record: the root entry's where there is one, else the file's. */
  inputs: Record<string, JsonValue>;
  /** Child keys entered under the root and not since superseded. */
  entered: Set<string>;
  /** Those of them that ended in success — history a later state can read. */
  succeeded: Set<string>;
}

function standingParentOf(project: Project, taskId: string): StandingParent | AdoptRefusal {
  const meta = project.tasks.tryRead(taskId);
  const row = project.runtime.get(taskId);
  if (meta === undefined || row === undefined) return { code: "unknown-task", message: `unknown task '${taskId}'` };
  if (row.status !== "queued" && row.status !== "interrupted" && row.status !== "failed" && row.status !== "canceled") {
    return { code: "parent-state", message: `'${meta.title}' is ${row.status} — a task adopts only while it is neither running nor finished` };
  }
  let rootInstanceId: string | undefined = undefined;
  let inputs: Record<string, JsonValue> | undefined;
  const keyOf = new Map<string, string>();
  const entered = new Set<string>();
  const succeeded = new Set<string>();
  for (const stored of project.events.list(taskId)) {
    const event = stored.event;
    if (event.type === "instance.entered") {
      if (event.parentInstanceId === undefined) {
        if (row.rootInstanceId !== undefined && event.instanceId !== row.rootInstanceId) continue;
        rootInstanceId = event.instanceId;
        inputs = (event.inputs ?? {}) as Record<string, JsonValue>;
        entered.clear();
        succeeded.clear();
      } else if (event.parentInstanceId === rootInstanceId && event.childKey !== undefined) {
        keyOf.set(event.instanceId, event.childKey);
        entered.add(event.childKey);
        succeeded.delete(event.childKey);
      }
    } else if (event.type === "child.superseded" && event.instanceId === rootInstanceId) {
      entered.delete(event.childKey);
      succeeded.delete(event.childKey);
    } else if (event.type === "instance.terminated" && event.outcome === "success") {
      const key = keyOf.get(event.instanceId);
      if (key !== undefined && entered.has(key)) succeeded.add(key);
    }
  }
  return { meta, ...(rootInstanceId !== undefined ? { rootInstanceId } : {}), inputs: inputs ?? meta.inputs ?? {}, entered, succeeded };
}

/** A required input of the plan nobody supplied — what refuses a REAL adoption, and only that. */
export function missingInputs(plan: AdoptPlan): AdoptRefusal | undefined {
  const missing = plan.asks.filter((ask) => ask.required);
  if (missing.length === 0) return undefined;
  return {
    code: "inputs-missing",
    message: `'${plan.workflow}' needs ${missing.map((ask) => `'${ask.name}'`).join(", ")}, which ${plan.adopted.length === 1 ? `'${plan.adopted[0]!.title}' does` : "the adopted tasks do"} not determine`,
  };
}

/** The list a split's wire names — from the parent's inputs, or an adopted sibling's outputs. */
function splitListOf(expr: string, inputs: Record<string, JsonValue>, children: readonly PlannedChild[]): JsonValue[] | undefined | "unknown" {
  const fromInput = /^\.inputs\.([A-Za-z_$][\w$-]*)$/.exec(expr);
  if (fromInput !== null) {
    const value = inputs[fromInput[1]!];
    return value === undefined ? undefined : Array.isArray(value) ? value : "unknown";
  }
  const fromChild = /^\.children\.([A-Za-z_$][\w$-]*)\.outputs?\.([A-Za-z_$][\w$-]*)$/.exec(expr);
  if (fromChild !== null) {
    const value = children.find((child) => child.childKey === fromChild[1])?.outputs?.[fromChild[2]!];
    return Array.isArray(value) ? value : "unknown";
  }
  return "unknown";
}

/** Whether the state the parent mounts differs from the one the task was pinned to. */
function hasStateChanged(project: Project, snapshotHash: string | undefined, workflow: string, current: LoadedState): boolean {
  if (snapshotHash === undefined) return false;
  try {
    const pinned = loadSnapshot(project.paths.snapshotsDir, snapshotHash).states[workflow];
    if (pinned === undefined) return true;
    const strip = (def: LoadedState): string => JSON.stringify({ ...def, id: undefined });
    return strip(pinned) !== strip(current);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------
// writing it
// ---------------------------------------------------------------------------------------------------

function mirrorEntered(child: PlannedChild, parentInstanceId: string): EngineEvent {
  return {
    type: "instance.entered",
    instanceId: child.taskId,
    stateId: child.stateId,
    childKey: child.childKey,
    parentInstanceId,
    inputs: child.inputs,
    adopted: true,
  } as unknown as EngineEvent;
}

function mirrorTerminated(taskId: string, stateId: string, outputs: Record<string, JsonValue>): EngineEvent {
  return { type: "instance.terminated", instanceId: taskId, stateId, outcome: "success", outputs } as unknown as EngineEvent;
}

/**
 * Make the parent task and write the mirror rows — the adoption itself.
 *
 * The snapshot is pinned on the row BEFORE the journal exists: a task with a journal is continued,
 * never started fresh, and the load that continues it reads the rows against the pinned definition.
 * The parent stands `queued`, past the child, until somebody starts it — by resume, as a split copy
 * is started — or holding, where an adopted task has yet to complete.
 */
export function writeAdoption(project: Project, pin: { bundle: WorkflowBundle; hash?: string }, planned: PlannedAdoption, deps: AdoptDeps = {}): TaskMeta {
  const now = deps.now ?? Date.now;
  const { plan, children } = planned;
  const parent = planned.parent !== undefined ? takeUpInto(project, planned, now()) : createTask(
    project,
    {
      title: plan.title,
      workflow: plan.workflow,
      ...(Object.keys(plan.inputs).length > 0 ? { inputs: plan.inputs } : {}),
      inputProvenance: plan.provenance,
      // The workspace comes along: the child came first, so the parent takes up the child's branch —
      // otherwise the next state reads a tree that lacks what the adopted task wrote.
      ...(plan.branch !== undefined ? { branch: plan.branch } : {}),
      ...(planned.split.length > 0 ? { split: planned.split } : {}),
      ...(plan.waitsFor.length > 0 ? { dependsOn: plan.waitsFor } : {}),
    },
    now(),
  );
  const standing = project.runtime.get(parent.id);
  // A task in a versioned document, or one already pinned, keeps what it runs under.
  if (pin.hash !== undefined && standing?.snapshotHash === undefined && standing?.documentId === undefined) project.runtime.setSnapshot(parent.id, pin.hash, now());
  if (planned.worktreePath !== undefined && standing?.worktreePath === undefined) project.runtime.setWorktree(parent.id, planned.worktreePath, now());

  const recorder = project.events.recorder(parent.id);
  let rootInstanceId = planned.parent?.rootInstanceId;
  if (rootInstanceId === undefined) {
    rootInstanceId = (deps.newInstanceId ?? (() => uuidv7(now())))();
    recorder.record({ type: "instance.entered", instanceId: rootInstanceId, stateId: pin.bundle.rootId, inputs: planned.entered } as EngineEvent, now());
  }
  for (const child of children) {
    recorder.record(mirrorEntered(child, rootInstanceId), now());
    if (child.outputs !== undefined) recorder.record(mirrorTerminated(child.taskId, child.stateId, child.outputs), now());
  }

  for (const child of children) {
    const meta = project.tasks.read(child.taskId);
    project.tasks.write({
      ...meta,
      parentTaskId: parent.id,
      origin: {
        kind: "adopt",
        taskId: parent.id,
        key: child.childKey,
        index: child.index ?? 0,
        ...(meta.parentTaskId !== undefined ? { formerParentTaskId: meta.parentTaskId } : {}),
      },
    });
    project.runtime.setParent(child.taskId, parent.id, now());
  }
  log.info(`adopted ${children.map((child) => child.taskId).join(", ")} into ${parent.id} (${plan.workflow}), standing past '${plan.cursor}'`);
  return project.tasks.read(parent.id);
}

/**
 * An EXISTING task's file, brought to what the plan says: inputs the adoption inferred or the form
 * supplied (only where its root has not entered), the workspace where it had none, the lists it is
 * now split on, and what it now waits for.
 */
function takeUpInto(project: Project, planned: PlannedAdoption, nowMs: number): TaskMeta {
  const { plan } = planned;
  const meta = project.tasks.read(planned.parent!.taskId);
  const fresh = planned.parent!.rootInstanceId === undefined;
  const split = [...(meta.split ?? []), ...planned.split.filter((entry) => !(meta.split ?? []).some((held) => held.expr === entry.expr))];
  const dependsOn = [...new Set([...(meta.dependsOn ?? []), ...plan.waitsFor])];
  const next: TaskMeta = {
    ...meta,
    ...(fresh && Object.keys(plan.inputs).length > 0 ? { inputs: plan.inputs } : {}),
    ...(fresh && Object.keys(plan.provenance).length > 0 ? { inputProvenance: plan.provenance } : {}),
    ...(fresh && meta.branch === undefined && plan.branch !== undefined ? { branch: plan.branch } : {}),
    ...(split.length > 0 ? { split } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
  project.tasks.write(next);
  if (next.branch !== meta.branch && next.branch !== undefined) project.runtime.setBranch(meta.id, next.branch, nowMs);
  return next;
}

/** The adoption mirrors in a task's journal: each adopted task's entry, and whether its end is written. */
function mirrorsOf(project: Project, parentTaskId: string): Array<{ taskId: string; stateId: string; ended: boolean }> {
  const mirrors = new Map<string, { taskId: string; stateId: string; ended: boolean }>();
  for (const row of project.events.list(parentTaskId)) {
    const event = row.event as EngineEvent & { adopted?: boolean };
    if (event.type === "instance.entered" && event.adopted === true) mirrors.set(event.instanceId, { taskId: event.instanceId, stateId: event.stateId, ended: false });
    else if (event.type === "instance.terminated") {
      const mirror = mirrors.get(event.instanceId);
      if (mirror !== undefined) mirror.ended = true;
    }
  }
  return [...mirrors.values()];
}

/**
 * Write the END of every mirror whose adopted task has since completed — what a parent adopted a
 * running task is owed before it may start. Outputs are checked against the parent's PINNED slots
 * first; a misfit leaves the mirror open, the parent refusing to load, and the reason returned.
 */
export function settleAdoptions(project: Project, parentTaskId: string, deps: AdoptDeps = {}): { settled: string[]; misfits: Array<{ taskId: string; reason: string }> } {
  const settled: string[] = [];
  const misfits: Array<{ taskId: string; reason: string }> = [];
  const open = mirrorsOf(project, parentTaskId).filter((mirror) => !mirror.ended);
  if (open.length === 0) return { settled, misfits };
  const parentRow = project.runtime.get(parentTaskId);
  // What the parent runs under NOW — a document's latest version, for a task in one.
  const states = parentRow !== undefined && (parentRow.snapshotHash !== undefined || parentRow.documentId !== undefined) ? loadPinnedBundle(project, parentRow).states : {};
  const recorder = project.events.recorder(parentTaskId);
  for (const mirror of open) {
    const row = project.runtime.get(mirror.taskId);
    if (row === undefined || row.status !== "completed" || (row.outcome !== undefined && row.outcome !== "success")) continue;
    const outputs = (row.outputsJson !== undefined ? JSON.parse(row.outputsJson) : {}) as Record<string, JsonValue>;
    const def = states[mirror.stateId];
    const miss = def !== undefined ? fitOutputs(def, outputs, deps.check) : undefined;
    if (miss !== undefined) {
      misfits.push({ taskId: mirror.taskId, reason: `${miss.path} ${miss.message}` });
      continue;
    }
    recorder.record(mirrorTerminated(mirror.taskId, mirror.stateId, outputs), (deps.now ?? Date.now)());
    settled.push(mirror.taskId);
  }
  return { settled, misfits };
}

/**
 * UN-ADOPT what a task's journal no longer mirrors — after a rewind past the mirror row, or the
 * parent's deletion. The adopted task was never changed beyond where it files, so taking the
 * adoption back is putting that back: `origin` goes, `parentTaskId` returns to what it was, and the
 * parent stops holding for it.
 */
export function releaseUnmirroredAdoptions(project: Project, parentTaskId: string, nowMs = Date.now()): string[] {
  const mirrored = new Set(project.runtime.get(parentTaskId) !== undefined ? mirrorsOf(project, parentTaskId).map((mirror) => mirror.taskId) : []);
  const released: string[] = [];
  for (const meta of project.tasks.list()) {
    if (meta.origin?.kind !== "adopt" || meta.origin.taskId !== parentTaskId || mirrored.has(meta.id)) continue;
    const { origin, parentTaskId: _parent, ...rest } = meta;
    project.tasks.write({ ...rest, ...(origin.formerParentTaskId !== undefined ? { parentTaskId: origin.formerParentTaskId } : {}) });
    if (project.runtime.get(meta.id) !== undefined) project.runtime.setParent(meta.id, origin.formerParentTaskId, nowMs);
    released.push(meta.id);
  }
  if (released.length > 0) {
    const parent = project.tasks.tryRead(parentTaskId);
    if (parent?.dependsOn !== undefined) {
      const { dependsOn, ...rest } = parent;
      const still = dependsOn.filter((id) => !released.includes(id));
      project.tasks.write({ ...rest, ...(still.length > 0 ? { dependsOn: still } : {}) });
    }
    log.info(`un-adopted ${released.join(", ")} from ${parentTaskId}`);
  }
  return released;
}

/** The parent a task was adopted into, when it was. */
export function adoptedInto(meta: Pick<TaskMeta, "origin"> | undefined): string | undefined {
  return meta?.origin?.kind === "adopt" ? meta.origin.taskId : undefined;
}

// ---------------------------------------------------------------------------------------------------
// the stand-in
// ---------------------------------------------------------------------------------------------------

export function adoptedStandInId(stateId: string): string {
  return `${ADOPTED_STATE_PREFIX}${stateId}`;
}

/**
 * The bundle a loaded run is handed, with a stand-in state for every adopted child in `loaded` —
 * see the header. The real states are untouched; a bundle with no adoption in its load is returned
 * as it came.
 */
export function withAdoptedStandIns(bundle: WorkflowBundle, loaded: LoadedInstance | undefined): WorkflowBundle {
  const wanted = new Set<string>();
  const walk = (node: LoadedInstance | undefined): void => {
    if (node === undefined) return;
    if (node.stateId.startsWith(ADOPTED_STATE_PREFIX)) wanted.add(node.stateId.slice(ADOPTED_STATE_PREFIX.length));
    for (const child of node.children ?? []) walk(child);
  };
  walk(loaded);
  if (wanted.size === 0) return bundle;
  const states = { ...bundle.states };
  for (const stateId of wanted) {
    const real = bundle.states[stateId];
    if (real !== undefined) states[adoptedStandInId(stateId)] = standInOf(real, stateId);
  }
  return { ...bundle, states };
}

/** The mounted state's CURRENT output slots, produced by an operation that is never dispatched. */
function standInOf(real: LoadedState, stateId: string): LoadedState {
  const outputs = Object.fromEntries(Object.entries(real.outputs ?? {}).map(([name, { binding: _binding, ...slot }]) => [name, slot]));
  const slotMeta = Object.fromEntries(
    Object.entries(real.slotMeta ?? {}).map(([path, { defaultRef: _defaultRef, ...meta }]) => [path, path.startsWith("outputs.") && _defaultRef !== undefined ? { ...meta, optional: true } : meta]),
  );
  return {
    id: adoptedStandInId(stateId),
    ...(real.label !== undefined ? { label: real.label } : {}),
    ...(real.inputs !== undefined ? { inputs: real.inputs } : {}),
    outputs,
    slotMeta,
    operation: { kind: "function", functionRef: ADOPTED_FUNCTION, input: {}, output: { name: "value", kind: "json" } },
  } as unknown as LoadedState;
}
