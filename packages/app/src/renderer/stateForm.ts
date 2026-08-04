/**
 * The state form's model, and the two pure functions that move a document in and out of it.
 *
 * Extracted from the editor component so the MERGE can be tested. This is the code most able to
 * destroy someone's work silently — a form that rebuilt a document from its own fields would drop
 * every field it does not render — and it had no coverage while it lived inside a `.tsx` that the
 * node-environment test runner could not reach.
 *
 * The contract, in one sentence: the form reads what it understands, writes back only what it
 * understands, and leaves everything else exactly where it found it.
 */
import { readRef, writeRef } from "@jaira/shared/browser";
import { applySlots, slotsOf, type SlotRow } from "./slotForm";
export { emptySlotRow, type SlotRow } from "./slotForm";
import {
  applyOperationFields,
  EMPTY_OPERATION_FIELDS,
  isEmptyBlock,
  operationFieldsOf,
  type OperationFieldsForm,
} from "./operationForm";

/** One wire into a child's declared input: the slot's name, and where its value comes from. */
export interface BindingRow {
  name: string;
  /** The binding as authored. A path, an expression, a literal — all one text field (§8). */
  value: string;
  /** True when the binding is not a plain string: `{ json }`, `{ $ref }`, `{ op }`. Read-only. */
  structured?: boolean;
}

/**
 * The per-mount defaults an author sets on ONE child (WORKFLOWS.md §6.1).
 *
 * Three fields rather than the whole `OperationFields` shape, and deliberately: this layer exists so
 * that mounting one state twice under two runtimes is a two-line change, and `kind` + `function` +
 * `model` is what that takes. Every other key an author writes here is merged through untouched, so
 * the subset is a rendering limit and not a data limit.
 */
export interface ChildEnvironmentForm {
  kind: "" | "prompt" | "function";
  functionRef: string;
  model: string;
}

/** One declared child. Rows are held in RUN ORDER, which is what the board's columns show. */
export interface ChildRow {
  key: string;
  /** The state it runs. Empty means `./<key>` — the state the key itself names (WORKFLOWS.md §6). */
  state: string;
  /** SPEC §10.4: starting this child does not block the sequence. */
  async: boolean;
  /**
   * Whether the cursor walks into this child, i.e. whether it is in `sequence`.
   *
   * Not decoration. The engine advances the cursor through `sequence` and nothing else, so a child
   * left out of it runs ONLY if a transition names it — `"sequence": []` is the documented way to
   * declare children that are jump targets rather than steps. The form used to show such a child
   * last and then write it back INTO the spine, quietly turning a jump target into a step.
   */
  inSpine: boolean;
  /** Wiring into the child's declared inputs — the substance of a child declaration. */
  inputs: BindingRow[];
  environment: ChildEnvironmentForm;
}

/**
 * What the form's Operation control is showing.
 *
 * Five values rather than three, because "this state declares no operation" and "this state declares
 * an operation whose `kind` an ancestor supplies" are different documents that a three-valued control
 * collapsed into one — and collapsing them DELETED the second one on the next save.
 *
 *  - `""` — no `operation` block. The state groups its children and nothing else.
 *  - `"ref"` — `operation` is a transcluded reference (`"operation": "$/lib/review.operation"`),
 *    not a block this form can take apart. Shown read-only.
 *  - `"inherit"` — an `operation` block that declares no `kind` of its own. Legal and load-bearing:
 *    `{}` is the documented opt-in to a fully inherited operation, and leaving `function` to the
 *    chain is how one state is mounted under two runtimes (WORKFLOWS.md §6.1).
 *  - `"prompt"` / `"function"` — the kind is settled in this file.
 */
export type OperationKind = "" | "ref" | "inherit" | "prompt" | "function";

/** One transition off the state. `to` is a child key or a `terminate.*` outcome. */
export interface TransitionRow {
  /** Guard expression. Empty is unconditional — and that is a real, useful shape. */
  when: string;
  to: string;
  /** True when the guard survived loading as something other than a plain string. */
  structured?: boolean;
}

/** `limits` (SPEC §3.4). Held as text so a half-typed number is not parsed under the cursor. */
export interface LimitsForm {
  /** Exposed to guards as `limits.max_iterations`. */
  maxIterations: string;
  /** Seconds. Exceeding it is `terminate.timeout`. */
  timeout: string;
}

/** The fields the form understands. Anything else is why the JSON tab exists. */
export interface FormModel {
  label: string;
  /** The author's note — also useful prompt context, which is why it is worth a box. */
  description: string;
  operationKind: OperationKind;
  /**
   * `operationKind === "ref"` only: the reference the whole block IS.
   *
   * An `operation` sits in an OBJECT position, so the reference is the bare string itself —
   * `"operation": "$/lib/review.operation"` — rather than the `{"$ref": …}` a string position takes
   * (WORKFLOWS.md §2.2). That asymmetry is the whole reason `readRef`/`writeRef` take a position.
   */
  operationRef: string;
  /** The `operation` block's fields (minus `kind`, which {@link operationKind} carries). */
  operation: OperationFieldsForm;
  /**
   * The `environment` DEFAULTS layer (§5) — the same shape, inherited by this state's operation and
   * by every descendant's. `null` when the state declares none, which is not the same as declaring
   * an empty one: only a state that declares `operation` gets one at all.
   */
  environment: OperationFieldsForm | null;
  limits: LimitsForm;
  inputs: SlotRow[];
  outputs: SlotRow[];
  children: ChildRow[];
  transitions: TransitionRow[];
}

export const EMPTY_FORM: FormModel = {
  label: "",
  description: "",
  operationKind: "",
  operationRef: "",
  operation: EMPTY_OPERATION_FIELDS,
  environment: null,
  limits: { maxIterations: "", timeout: "" },
  inputs: [],
  outputs: [],
  children: [],
  transitions: [],
};

/**
 * Children in the order they RUN: the state's `sequence` first, then anything it left out.
 *
 * The same rule the board's columns use, so the form and the columns above it never disagree about
 * which child is first. A child omitted from `sequence` is still SHOWN — appended rather than
 * dropped, since it is declared and a transition may enter it — but it is marked out of the spine,
 * which is what stops the next save from turning it into a step.
 */
function childrenOf(state: Record<string, unknown>): ChildRow[] {
  const map = asRecord(state["children"]);
  const declared = Object.keys(map);
  const authored = Array.isArray(state["sequence"]);
  const sequence = (authored ? (state["sequence"] as unknown[]) : []).filter(
    (k): k is string => typeof k === "string" && declared.includes(k),
  );
  // Absent `sequence` means declaration order, so every child is in the spine. An authored one is a
  // CLAIM about which children are steps, and a child it leaves out is a jump target.
  const inSpine = (key: string): boolean => !authored || sequence.includes(key);
  return [...sequence, ...declared.filter((k) => !sequence.includes(k))].map((key) => {
    const decl = asRecord(map[key]);
    const environment = asRecord(decl["environment"]);
    const kind = environment["kind"];
    return {
      key,
      state: typeof decl["state"] === "string" ? decl["state"] : "",
      async: decl["async"] === true,
      inSpine: inSpine(key),
      inputs: bindingsOf(decl["inputs"]),
      environment: {
        kind: kind === "prompt" || kind === "function" ? kind : "",
        functionRef: typeof environment["function"] === "string" ? environment["function"] : "",
        model: typeof environment["model"] === "string" ? environment["model"] : "",
      },
    };
  });
}

/** Read one `inputs` wiring map into rows, in declaration order. */
function bindingsOf(map: unknown): BindingRow[] {
  return Object.entries(asRecord(map)).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : JSON.stringify(value),
    ...(typeof value === "string" ? {} : { structured: true }),
  }));
}

/** A blank wire, as "+ Add" produces it. */
export function emptyBindingRow(): BindingRow {
  return { name: "", value: "" };
}

/** A blank child, as "+ Add" produces it. */
export function emptyChildRow(): ChildRow {
  return {
    key: "",
    state: "",
    async: false,
    inSpine: true,
    inputs: [],
    environment: { kind: "", functionRef: "", model: "" },
  };
}

function transitionsOf(state: Record<string, unknown>): TransitionRow[] {
  const raw = Array.isArray(state["transitions"]) ? (state["transitions"] as unknown[]) : [];
  return raw.map((entry) => {
    const t = asRecord(entry);
    const when = t["when"];
    return {
      to: typeof t["to"] === "string" ? t["to"] : "",
      when: typeof when === "string" ? when : when === undefined ? "" : JSON.stringify(when),
      ...(when !== undefined && typeof when !== "string" ? { structured: true } : {}),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** True for a value the form can take apart — a plain JSON object, not a reference or a list. */
function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which of the five {@link OperationKind}s a document is in.
 *
 * The two cases worth stating: an `operation` that is not an object is a TRANSCLUDED REFERENCE, and
 * an object without a `kind` INHERITS one. Reading either as "no operation" is what let a save on an
 * unrelated field delete the block.
 */
function operationKindOf(operation: unknown): OperationKind {
  if (operation === undefined) return "";
  if (!isPlainObject(operation)) return "ref";
  const kind = (operation as Record<string, unknown>)["kind"];
  return kind === "prompt" || kind === "function" ? kind : "inherit";
}

/** Read the form's fields out of a parsed state document. */
export function formOf(doc: unknown): FormModel {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return EMPTY_FORM;
  const state = doc as Record<string, unknown>;
  const operation = state["operation"];
  const operationKind = operationKindOf(operation);
  const op = operationFieldsOf(operation);

  // The nested spelling an earlier version of this form wrote. `model` is a FLAT operation field —
  // hw hoists every field it does not own into the call config, so `operation.config.model` reached
  // the model as `config.config.model` and did nothing. Read here only so those files migrate.
  const legacyModel = asRecord(asRecord(operation)["config"])["model"];
  if (op.fields["model"] === "" && typeof legacyModel === "string") op.fields["model"] = legacyModel;

  const limits = asRecord(state["limits"]);
  return {
    label: typeof state["label"] === "string" ? state["label"] : "",
    description: typeof state["description"] === "string" ? state["description"] : "",
    operationKind,
    operationRef: operationKind === "ref" ? (typeof operation === "string" ? operation : JSON.stringify(operation)) : "",
    operation: op,
    environment: state["environment"] === undefined ? null : operationFieldsOf(state["environment"]),
    limits: {
      maxIterations: typeof limits["max_iterations"] === "number" ? String(limits["max_iterations"]) : "",
      timeout: typeof limits["timeout"] === "number" ? String(limits["timeout"]) : "",
    },
    inputs: slotsOf(state["inputs"]),
    outputs: slotsOf(state["outputs"]),
    children: childrenOf(state),
    transitions: transitionsOf(state),
  };
}

/**
 * Fold the form's fields back into the document, leaving everything else exactly as it was.
 *
 * This is the whole contract that makes a partial form safe. `children`, `transitions`, `inputs`,
 * `outputs` and every field the form has never heard of are carried through untouched, so editing a
 * label cannot delete a workflow's structure. A form that rebuilt the document from its own fields
 * would silently destroy the parts it does not render — which is exactly why the JSON tab is not
 * optional and why this merges rather than replaces.
 */
/**
 * Fold the children table back, keeping each child's wiring.
 *
 * Every surviving key is merged onto what was there. Positional carry-over again: renaming a child
 * keeps its wiring rather than silently emptying it.
 *
 * `sequence` is written explicitly whenever there is more than one child, even into files that did
 * not have one. Run order is semantics, and leaving it implied by JSON key order makes it depend on
 * a serialiser detail — integer-like keys are reordered by every JS engine, so `{"2":…,"1":…}` would
 * silently run backwards. Naming the order costs one line and cannot be broken by a reformat.
 *
 * It holds only the children in the SPINE. A child outside it is declared but never reached by the
 * cursor, so writing every child into `sequence` — which is what this did — turned a jump target
 * into a step on the first save. `[]` is written rather than omitted when no child is in the spine,
 * because an absent `sequence` means "all of them, in declaration order": the opposite claim.
 */
function applyChildren(previous: unknown, rows: ChildRow[]): { children?: Record<string, unknown>; sequence?: string[] } {
  const before = asRecord(previous);
  const children: Record<string, unknown> = {};
  const order: string[] = [];
  const spine: string[] = [];
  // Keyed rows only, indexed among themselves — see {@link applySlots}.
  rows
    .filter((row) => row.key.trim().length > 0)
    .forEach((row, index) => {
    const key = row.key.trim();
    const kept = asRecord(before[key] ?? Object.values(before)[index]);
    const decl: Record<string, unknown> = { ...kept };
    if (row.state.trim().length > 0) decl["state"] = row.state.trim();
    else delete decl["state"];
    if (row.async) decl["async"] = true;
    else delete decl["async"];
    applyBindings(decl, row.inputs);
    applyChildEnvironment(decl, row.environment);
    children[key] = decl;
    order.push(key);
    if (row.inSpine) spine.push(key);
    });
  if (order.length === 0) return {};
  // Stated whenever it says something the document would not otherwise say: that some child is NOT a
  // step, or — with more than one child — what the order of the steps is.
  const needed = spine.length !== order.length || order.length > 1;
  return { children, ...(needed ? { sequence: spine } : {}) };
}

/**
 * Fold a child's input wiring back.
 *
 * Positional carry-over, as everywhere else here: renaming a wire keeps whatever it was bound to, so
 * fixing a typo in a slot name does not silently unwire the child. A structured binding — `{ json }`,
 * `{ $ref }`, an embedded operation — is shown read-only and written back exactly as it was.
 */
function applyBindings(decl: Record<string, unknown>, rows: BindingRow[]): void {
  const before = asRecord(decl["inputs"]);
  const after: Record<string, unknown> = {};
  rows
    .filter((row) => row.name.trim().length > 0)
    .forEach((row, index) => {
      const name = row.name.trim();
      const kept = before[name] ?? Object.values(before)[index];
      if (row.structured === true) {
        if (kept !== undefined) after[name] = kept;
        return;
      }
      if (row.value.trim().length > 0) after[name] = row.value.trim();
    });
  if (Object.keys(after).length > 0) decl["inputs"] = after;
  else delete decl["inputs"];
}

/**
 * Fold a child's per-mount `environment` back, keeping every field the three controls do not model.
 *
 * The merge matters more here than almost anywhere else: this block sits BETWEEN the parent's
 * environment and the child's own, so an author who set `tools` or `permissions` on one mount has
 * put real policy in a place the form only partly renders.
 */
function applyChildEnvironment(decl: Record<string, unknown>, form: ChildEnvironmentForm): void {
  const environment: Record<string, unknown> = { ...asRecord(decl["environment"]) };
  if (form.kind !== "") environment["kind"] = form.kind;
  else delete environment["kind"];
  if (form.functionRef.trim().length > 0) environment["function"] = form.functionRef.trim();
  else if (typeof environment["function"] === "string") delete environment["function"];
  if (form.model.trim().length > 0) environment["model"] = form.model.trim();
  else if (typeof environment["model"] === "string") delete environment["model"];

  if (Object.keys(environment).length > 0) decl["environment"] = environment;
  else delete decl["environment"];
}

function applyTransitions(previous: unknown, rows: TransitionRow[]): unknown[] | undefined {
  const before = Array.isArray(previous) ? (previous as unknown[]) : [];
  const out = rows
    .filter((row) => row.to.trim().length > 0)
    .map((row, index) => {
      const kept = asRecord(before[index]);
      const decl: Record<string, unknown> = { ...kept, to: row.to.trim() };
      // A guard that survived as a non-string is shown read-only, so it is left exactly as it was.
      if (row.structured !== true) {
        if (row.when.trim().length > 0) decl["when"] = row.when.trim();
        else delete decl["when"];
      }
      return decl;
    });
  return out.length > 0 ? out : undefined;
}

export function applyForm(doc: unknown, form: FormModel): unknown {
  const state = (doc !== null && typeof doc === "object" && !Array.isArray(doc) ? { ...(doc as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (form.label) state["label"] = form.label;
  else delete state["label"];
  if (form.description.trim().length > 0) state["description"] = form.description;
  else delete state["description"];

  applyLimits(state, form.limits);

  // The DEFAULTS layer (§5). Written whether or not the state has an operation of its own: declaring
  // `environment.session` on a pure composite is the ordinary way to give a whole subtree one
  // session, and the engine reads it there specifically.
  if (form.environment === null) delete state["environment"];
  else {
    const environment = applyOperationFields(state["environment"], form.environment);
    if (isEmptyBlock(environment)) delete state["environment"];
    else state["environment"] = environment;
  }

  // Inputs and outputs belong to the STATE, not to its operation — a pure composite that only groups
  // children still declares both, and wiring them is most of what authoring one consists of.
  const inputs = applySlots(state["inputs"], form.inputs, true);
  if (inputs) state["inputs"] = inputs;
  else delete state["inputs"];
  const outputs = applySlots(state["outputs"], form.outputs, false);
  if (outputs) state["outputs"] = outputs;
  else delete state["outputs"];

  const { children, sequence } = applyChildren(state["children"], form.children);
  if (children) state["children"] = children;
  else delete state["children"];
  if (sequence) state["sequence"] = sequence;
  else delete state["sequence"];

  const transitions = applyTransitions(state["transitions"], form.transitions);
  if (transitions) state["transitions"] = transitions;
  else delete state["transitions"];

  if (form.operationKind === "ref") {
    const ref = form.operationRef.trim();
    // An empty box while the previous value was a BLOCK is someone who has just moved the control on
    // to Link and not yet said what to. Writing the empty string would delete a whole operation on
    // the strength of a dropdown change, so the block is left exactly where it is until there is a
    // reference to replace it with.
    if (ref.length > 0) state["operation"] = writeRef(ref, "object");
    else if (typeof state["operation"] === "string") delete state["operation"];
    return state;
  }
  if (form.operationKind === "") {
    // A state with no operation only groups its children — a real and useful shape.
    delete state["operation"];
    return state;
  }
  const op = applyOperationFields(state["operation"], form.operation);
  // `inherit` writes NO kind: the block exists, and an ancestor's `environment` settles what it is.
  if (form.operationKind === "inherit") delete op["kind"];
  else op["kind"] = form.operationKind;

  // Whichever field the chosen kind has no use for goes, which is what switching kind is FOR. A
  // shape the form only showed READ-ONLY is exempt: a blank control there is not evidence that the
  // author wanted nothing. A LINK is not exempt — the form shows it, so removing it is as deliberate
  // as clearing the box would have been.
  if (form.operationKind === "prompt" && form.operation.structured["functionRef"] !== true) {
    if (typeof op["function"] === "string") delete op["function"];
    if (typeof op["functionRef"] === "string") delete op["functionRef"];
  }
  if (form.operationKind === "function" && form.operation.structured["prompt"] !== true) {
    if (typeof op["prompt"] === "string" || readRef(op["prompt"], "string") !== undefined) delete op["prompt"];
  }
  if (form.operation.structured["model"] !== true) dropLegacyModel(op);

  state["operation"] = op;
  return state;
}

/** `limits` (SPEC §3.4). Absent when neither guard is set — an empty block claims a bound it has not. */
function applyLimits(state: Record<string, unknown>, form: LimitsForm): void {
  const limits: Record<string, unknown> = { ...asRecord(state["limits"]) };
  for (const [key, text] of [
    ["max_iterations", form.maxIterations],
    ["timeout", form.timeout],
  ] as const) {
    const value = Number(text.trim());
    if (text.trim().length === 0) delete limits[key];
    else if (Number.isFinite(value)) limits[key] = value;
  }
  if (Object.keys(limits).length > 0) state["limits"] = limits;
  else delete state["limits"];
}

/**
 * Remove `operation.config.model`, the nested spelling an earlier version of this form wrote.
 *
 * `model` sits FLAT on the operation — "the operation IS the call" — and hw hoists every field it
 * does not own into the call config, so the nested form arrived at the provider as `config.model`
 * and the state ran on the default model instead. Left in place it would also shadow the correct
 * field on the next read. The rest of a `config` block is not touched, and the block goes only when
 * emptying it leaves nothing behind.
 */
function dropLegacyModel(op: Record<string, unknown>): void {
  const config = op["config"];
  if (!isPlainObject(config) || !("model" in (config as Record<string, unknown>))) return;
  const rest = { ...(config as Record<string, unknown>) };
  delete rest["model"];
  if (Object.keys(rest).length > 0) op["config"] = rest;
  else delete op["config"];
}
