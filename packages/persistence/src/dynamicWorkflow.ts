/**
 * The dynamic workflow GENERATOR (decision 0005 §3) — the pure half.
 *
 * A dynamic workflow is an ordinary workflow document: a root state with an operation (a
 * conversation) and children (what was started from it), in the authored format, linted like any
 * other. This module writes one, or the next version of one, from three things and nothing else:
 *
 *  - **producers** — the children of the document that have run for the task being moved, with their
 *    declared output schemas and what they recorded;
 *  - **the target** — a state's declared input schemas;
 *  - **what the caller supplied** — values, with who supplied them.
 *
 * ## Wires come from schema fit
 *
 * The platform never names a workflow's input (§0). A target input is wired to a producer's output
 * when the output's declared schema FITS the input's (`isSubschema`) — and to nothing because of what
 * either is called. Where several outputs fit, one that fits BOTH WAYS (the same type, not merely an
 * acceptable one) is taken when it is the only such; otherwise the input is returned AMBIGUOUS with
 * its candidates, for whoever has the conversation to choose from. An input nothing fits is returned
 * unsettled with its schema. Nothing is guessed.
 *
 * ## One output, many inputs
 *
 * When no output fits an input whole but a LIST output's item schema does, the mount is a split:
 * `each: "split"` over the list with `start: "manual"`, so the tasks are made held and nothing is
 * confirmed. A target that takes the list fits it whole and is a plain mount — a join. The target's
 * input arity decides which; one mount splits on one list.
 *
 * ## Every generated rule is a standing `task_move`
 *
 * `{ "when": "on_user_event('task_move', { to_state: '<x>' })", "to": "<x>", "standing": true }` —
 * taken only when a person says so, only for that task, evaluated last, holding nothing.
 *
 * ## Augment, never rewrite
 *
 * Given an existing document the result is that document plus one child and one rule, appended. A
 * child that is already there is never touched: other tasks stand in it, and records made under it
 * keep meaning what they meant. Given a real workflow's frozen root (a clone), the result is the
 * ADDITIONS alone — the host lowers them through the loader and grafts them onto the frozen copy,
 * because a resolved state is not an authored one and cannot be written back as one.
 *
 * Pure: no filesystem, no clock, no ids. `dynamicDocuments.ts` is the host half.
 */
import { isSubschema, type Schema } from "@declarative-ai/validate";
import type { JsonValue } from "@declarative-ai/exec";

/** One authored state document — the JSON a person could have written. */
export type AuthoredState = Record<string, JsonValue>;

/** One declared slot, as far as wiring needs to know it. */
export interface SlotShape {
  kind?: string;
  schema?: JsonValue;
  /** `optional: true` or a `default` — an absent value is acceptable here. */
  optional?: boolean;
  description?: string;
}

/** A state's declared surface: what it takes and what it gives. */
export interface StateSurface {
  /** The canonical state id — what a mount's `state` names. */
  id: string;
  label?: string;
  inputs: Record<string, SlotShape>;
  outputs: Record<string, SlotShape>;
}

/** Who a literal came from — stored on the binding, beside the value (§3, §4 "Inputs"). */
export interface LiteralProvenance {
  /**
   * `inferred` — the conversation supplied it from what had been said; `asked` — a person answered;
   * `recorded` — it is what a task actually ran with, carried into the document that now holds it.
   */
  via: "inferred" | "asked" | "recorded";
  /** Who: `person`, `control`, `session`, or a task id for `recorded`. */
  by?: string;
  at?: string;
  note?: string;
}

export interface SuppliedValue {
  value: JsonValue;
  provenance: LiteralProvenance;
}

/**
 * A child of the document whose outputs may feed the target.
 *
 * Listed NEAREST FIRST: the state the moved task stands in, then what ran before it. Order is the one
 * tie-break between two producers that fit equally, and it is structural — where the task is — not
 * a reading of anybody's names.
 */
export interface Producer {
  /** Its child key in the document. For a NEW document, the key it will be mounted under. */
  key: string;
  state: StateSurface;
  /**
   * What it recorded, when it has run. An output it did not produce is not a wire candidate: the
   * wire would resolve to nothing at the entry it feeds. Absent ⇒ every declared output is one.
   */
  outputs?: Record<string, JsonValue>;
  /** What it ran with — a NEW document mounts it with these as `recorded` literals. */
  inputs?: Record<string, JsonValue>;
  /** The task that ran it, for the provenance of those literals. */
  taskId?: string;
}

export type DynamicBase =
  /** No document yet: the root is the conversation state, and the producers become its first children. */
  | { kind: "new"; conversation: AuthoredState }
  /** An existing dynamic document, as authored. It is augmented. */
  | { kind: "dynamic"; document: AuthoredState }
  /**
   * A real workflow's frozen root, which cannot be re-authored: only what is ADDED is generated.
   * `children` are the keys it already mounts; `offered` the `to_state`s its standing rules already offer.
   */
  | { kind: "clone"; children: readonly string[]; offered: readonly string[] };

export interface GenerateInput {
  base: DynamicBase;
  producers: readonly Producer[];
  target: StateSurface;
  /** The key to mount the target under. Defaults to the last segment of its id, made unique. */
  targetKey?: string;
  /** Values the caller settled, by the target's own declared input. They win over a wire. */
  supplied?: Readonly<Record<string, SuppliedValue>>;
}

export interface GeneratedWire {
  input: string;
  from: { child: string; output: string };
  /** Present when the input takes ONE element of the list this output is. */
  each?: "split";
}

export interface GeneratedLiteral {
  input: string;
  value: JsonValue;
  provenance: LiteralProvenance;
}

export interface WireCandidate {
  child: string;
  output: string;
  /** The output is a list whose ITEMS fit — choosing it makes the mount a split. */
  element: boolean;
}

export interface UnsettledInput {
  input: string;
  schema: JsonValue;
  kind?: string;
  description?: string;
  required: boolean;
  /** `ambiguous` carries the candidates; `second-list` is an element fit on a mount already split on another list. */
  reason: "no-fit" | "ambiguous" | "second-list";
  candidates?: WireCandidate[];
}

/** What one version adds to a document — the authored pieces, in the authored format. */
export interface DocumentAdditions {
  /** Child key → mount, in the order added. */
  children: Record<string, AuthoredState>;
  /** The standing rules, in the order added. */
  transitions: AuthoredState[];
}

export interface GenerateResult {
  /**
   * True when every REQUIRED input of the target is settled. False ⇒ nothing was generated:
   * `document` is absent, `additions` is empty, and `unsettled` says what to supply and ask again.
   */
  ok: boolean;
  /** The whole authored root — absent for a clone (see {@link DynamicBase}) and when `ok` is false. */
  document?: AuthoredState;
  additions: DocumentAdditions;
  /** The key the target is mounted under. When it was ALREADY mounted, that key, and `additions` is empty. */
  targetKey: string;
  /** True when the document already mounted the target: nothing to add, and no new version to write. */
  existing: boolean;
  mount: "plain" | "split";
  wires: GeneratedWire[];
  literals: GeneratedLiteral[];
  unsettled: UnsettledInput[];
}

// ---------------------------------------------------------------------------------------------------
// the rule
// ---------------------------------------------------------------------------------------------------

/** The one spelling of a generated transition (decision 0005 §3). */
export function standingMoveRule(toKey: string): AuthoredState {
  return { when: `on_user_event('task_move', { to_state: ${quoted(toKey)} })`, to: toKey, standing: true };
}

/** True for a transition this generator wrote — or one written by hand in its exact shape. */
export function isStandingMoveRule(rule: unknown, toKey?: string): boolean {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return false;
  const t = rule as { when?: unknown; to?: unknown; standing?: unknown };
  if (t.standing !== true || typeof t.to !== "string" || typeof t.when !== "string") return false;
  if (!/^\s*on_user_event\(\s*'task_move'/.test(t.when)) return false;
  return toKey === undefined || t.to === toKey;
}

const quoted = (text: string): string => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** One path segment of a runtime reference — quoted where the identifier grammar cannot spell it. */
const segment = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name));

/** `.children.<child>.output.<output>` — a wire, as a person would write it. */
export function wireExpression(child: string, output: string): string {
  return `.children.${segment(child)}.output.${segment(output)}`;
}

// ---------------------------------------------------------------------------------------------------
// fit
// ---------------------------------------------------------------------------------------------------

const asSchema = (schema: JsonValue | undefined): Schema =>
  schema !== null && typeof schema === "object" && !Array.isArray(schema) ? (schema as Schema) : {};

/** Does a value of `produced` go where `wanted` is expected? Kinds, where both say one, must agree. */
export function schemaFits(produced: SlotShape, wanted: SlotShape): boolean {
  if (produced.kind !== undefined && wanted.kind !== undefined && produced.kind !== wanted.kind) return false;
  return isSubschema(asSchema(produced.schema), asSchema(wanted.schema)).ok;
}

/** The item schema of a LIST output, when it declares one. */
function itemsOf(slot: SlotShape): SlotShape | undefined {
  const schema = asSchema(slot.schema);
  if (schema["type"] !== "array") return undefined;
  const items = schema["items"];
  if (items === null || typeof items !== "object" || Array.isArray(items)) return undefined;
  // An element is a JSON value whatever the list's own slot kind was.
  return { schema: items as JsonValue };
}

interface Fit extends WireCandidate {
  /** The fit holds both ways — the same type, not merely an acceptable one. */
  exact: boolean;
  /** The producer's position, nearest first. */
  rank: number;
}

function fitsFor(wanted: SlotShape, producers: readonly Producer[]): Fit[] {
  const fits: Fit[] = [];
  producers.forEach((producer, rank) => {
    for (const [output, slot] of Object.entries(producer.state.outputs)) {
      if (producer.outputs !== undefined && !(output in producer.outputs)) continue;
      if (schemaFits(slot, wanted)) {
        fits.push({ child: producer.key, output, element: false, exact: schemaFits({ schema: wanted.schema }, { schema: slot.schema }), rank });
        continue;
      }
      const item = itemsOf(slot);
      // A JSON element does not feed a slot that wants bytes or prose by kind; the schema decides the rest.
      if (item !== undefined && schemaFits(item, { schema: wanted.schema })) {
        fits.push({ child: producer.key, output, element: true, exact: schemaFits({ schema: wanted.schema }, item), rank });
      }
    }
  });
  return fits;
}

/**
 * The one fit to take, or none: whole before element; then the nearest producer that has any; then
 * the only one — or the only EXACT one. Anything else is a choice, and a choice is returned.
 */
function choose(fits: readonly Fit[]): Fit | undefined {
  for (const element of [false, true]) {
    const pool = fits.filter((fit) => fit.element === element);
    if (pool.length === 0) continue;
    const nearest = Math.min(...pool.map((fit) => fit.rank));
    const near = pool.filter((fit) => fit.rank === nearest);
    if (near.length === 1) return near[0];
    const exact = near.filter((fit) => fit.exact);
    return exact.length === 1 ? exact[0] : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A literal binding with its provenance beside it — `{ "json": …, "provenance": … }`. */
export function literalBinding(value: JsonValue, provenance: LiteralProvenance): AuthoredState {
  return { json: value, provenance: provenance as unknown as JsonValue };
}

function uniqueKey(wanted: string, taken: ReadonlySet<string>): string {
  const base = wanted.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "state";
  const stem = /^[0-9]/.test(base) ? `s_${base}` : base;
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) if (!taken.has(`${stem}_${n}`)) return `${stem}_${n}`;
}

/** The mounts an authored document declares, by key — `state` as written. */
function mountsOf(document: AuthoredState): Record<string, AuthoredState> {
  const children = document["children"];
  return isObject(children) ? (children as Record<string, AuthoredState>) : {};
}

/**
 * Generate a dynamic document, its next version, or a clone's additions.
 *
 * @see the module header for the rules; `dynamicDocuments.ts` `generateDocumentVersion` for the host half.
 */
export function generateDynamicWorkflow(input: GenerateInput): GenerateResult {
  const { base, target } = input;
  const taken = new Set<string>(
    base.kind === "clone" ? base.children : base.kind === "dynamic" ? Object.keys(mountsOf(base.document)) : [],
  );
  const additions: DocumentAdditions = { children: {}, transitions: [] };
  const offered = new Set<string>(
    base.kind === "clone"
      ? base.offered
      : base.kind === "dynamic"
        ? (Array.isArray(base.document["transitions"]) ? base.document["transitions"] : []).filter((t) => isStandingMoveRule(t)).map((t) => (t as { to: string }).to)
        : [],
  );
  const add = (key: string, mount: AuthoredState): void => {
    additions.children[key] = mount;
    taken.add(key);
  };
  const offer = (key: string): void => {
    if (offered.has(key)) return;
    offered.add(key);
    additions.transitions.push(standingMoveRule(key));
  };

  // A NEW document mounts what already ran, as it ran: the producers become its first children, each
  // with the inputs its task recorded, so the document lints on its own and a backward move into one
  // re-enters it with what it had.
  if (base.kind === "new") {
    for (const producer of input.producers) {
      if (taken.has(producer.key)) continue;
      const wires: Record<string, JsonValue> = {};
      for (const name of Object.keys(producer.state.inputs)) {
        const value = producer.inputs?.[name];
        if (value === undefined) continue;
        wires[name] = literalBinding(value, { via: "recorded", ...(producer.taskId !== undefined ? { by: producer.taskId } : {}) });
      }
      add(producer.key, { state: producer.state.id, ...(Object.keys(wires).length > 0 ? { inputs: wires } : {}) });
      offer(producer.key);
    }
  }

  // Already mounted? Then the move is one the document supports, and there is nothing to write. Only
  // an authored base can say — a clone's caller resolves the target inside the workflow first (§1).
  if (base.kind === "dynamic") {
    const at = Object.entries(mountsOf(base.document)).find(([, mount]) => mount["state"] === target.id);
    if (at !== undefined && input.targetKey === undefined) {
      offer(at[0]);
      const document = additions.transitions.length > 0 ? withAdditions(base.document, additions) : base.document;
      return { ok: true, document, additions, targetKey: at[0], existing: additions.transitions.length === 0, mount: "plain", wires: [], literals: [], unsettled: [] };
    }
  }

  const targetKey = input.targetKey !== undefined && !taken.has(input.targetKey) ? input.targetKey : uniqueKey(input.targetKey ?? target.id.split("/").at(-1) ?? "state", taken);

  const wires: GeneratedWire[] = [];
  const literals: GeneratedLiteral[] = [];
  const unsettled: UnsettledInput[] = [];
  let splitOn: string | undefined;
  for (const [name, slot] of Object.entries(target.inputs)) {
    const supplied = input.supplied?.[name];
    if (supplied !== undefined) {
      literals.push({ input: name, value: supplied.value, provenance: supplied.provenance });
      continue;
    }
    const open = (reason: UnsettledInput["reason"], candidates?: WireCandidate[]): void => {
      unsettled.push({
        input: name,
        schema: slot.schema ?? {},
        ...(slot.kind !== undefined ? { kind: slot.kind } : {}),
        ...(slot.description !== undefined ? { description: slot.description } : {}),
        required: slot.optional !== true,
        reason,
        ...(candidates !== undefined && candidates.length > 0 ? { candidates } : {}),
      });
    };
    const fits = fitsFor(slot, input.producers);
    const candidates = fits.map(({ child, output, element }) => ({ child, output, element }));
    if (fits.length === 0) {
      open("no-fit");
      continue;
    }
    const chosen = choose(fits);
    if (chosen === undefined) {
      open("ambiguous", candidates);
      continue;
    }
    if (chosen.element) {
      const list = wireExpression(chosen.child, chosen.output);
      // One mount splits on one list (WORKFLOWS.md §6.3). The same list again is the same element.
      if (splitOn !== undefined && splitOn !== list) {
        open("second-list", candidates);
        continue;
      }
      splitOn = list;
    }
    wires.push({ input: name, from: { child: chosen.child, output: chosen.output }, ...(chosen.element ? { each: "split" as const } : {}) });
  }

  const mount: GenerateResult["mount"] = splitOn !== undefined ? "split" : "plain";
  if (unsettled.some((entry) => entry.required)) {
    return { ok: false, additions: { children: {}, transitions: [] }, targetKey, existing: false, mount, wires, literals, unsettled };
  }

  const inputs: Record<string, JsonValue> = {};
  for (const name of Object.keys(target.inputs)) {
    const wire = wires.find((w) => w.input === name);
    const literal = literals.find((l) => l.input === name);
    if (literal !== undefined) inputs[name] = literalBinding(literal.value, literal.provenance);
    else if (wire !== undefined) {
      const expr = wireExpression(wire.from.child, wire.from.output);
      // Held, and nothing confirmed: the tasks are made and stand until somebody starts them.
      inputs[name] = wire.each === "split" ? { $expr: expr, each: "split", start: "manual" } : expr;
    }
  }
  add(targetKey, { state: target.id, ...(Object.keys(inputs).length > 0 ? { inputs } : {}) });
  offer(targetKey);

  const document =
    base.kind === "clone" ? undefined : withAdditions(base.kind === "new" ? rootFrom(base.conversation) : base.document, additions);
  return { ok: true, ...(document !== undefined ? { document } : {}), additions, targetKey, existing: false, mount, wires, literals, unsettled };
}

/**
 * The root of a new document: the conversation state, as authored, with no children yet and NO SPINE.
 *
 * `sequence: []` is the point: nothing here runs because it comes next. Every child is entered by a
 * person's move, the conversation's turn ends the way it always did, and a task with nothing asked
 * of it finishes rather than walking into work nobody started.
 */
function rootFrom(conversation: AuthoredState): AuthoredState {
  const { id: _id, children: _children, sequence: _sequence, transitions, ...rest } = conversation;
  return { ...rest, children: {}, sequence: [], transitions: Array.isArray(transitions) ? transitions : [] };
}

/** A document with additions APPENDED — existing children and rules keep their place and their text. */
export function withAdditions(document: AuthoredState, additions: DocumentAdditions): AuthoredState {
  const transitions = Array.isArray(document["transitions"]) ? document["transitions"] : [];
  return {
    ...document,
    children: { ...mountsOf(document), ...additions.children } as unknown as JsonValue,
    // Written out even where the base inferred it: a new child must not join a spine by being declared.
    sequence: Array.isArray(document["sequence"]) ? document["sequence"] : Object.keys(mountsOf(document)),
    transitions: [...transitions, ...additions.transitions],
  };
}
