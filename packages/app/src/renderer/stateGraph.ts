/**
 * One state, drawn as what it actually does: taken in on the left, handed back on the right, every
 * value that moves between them, and every move of the cursor with the reason it is taken written on
 * it.
 *
 * The form and the JSON tab both answer "what does this file say". Neither answers the two questions
 * an author asks of a composite state — *which child runs after which, and what makes the run go
 * somewhere other than straight down the sequence*, and *where does this value come from*. Both
 * answers are spread across the whole document and have to be assembled in the reader's head, which
 * is exactly the kind of assembly a picture does for free.
 *
 * Three functions, split at the seams that matter. {@link graphOf} reads the DOCUMENT into nodes,
 * ports, wires and edges and knows nothing about pixels. {@link layoutOf} turns that into coordinates
 * and knows nothing about the state format. {@link focusOf} answers "what is this reader looking at",
 * which is neither of those and is the half that makes a dense drawing legible.
 *
 * ## The visual vocabulary
 *
 * Five channels, each answering exactly one question, so that nothing on screen means two things and
 * no question is answered twice. Written out in DESIGN.md; the short form is:
 *
 *  - **position** — WHEN it runs. Columns are run order, left to right; lane 0 is the cursor's own
 *    path, lane 1 is everything it reaches only by jumping.
 *  - **geometry** — WHAT KIND of movement. A smooth curve between two PORTS is a value moving. An
 *    arc between two BOX EDGES, with an arrowhead, is the cursor moving. Nothing else may be a line.
 *  - **hue** — WHICH ONE. A data wire takes the colour of the value it carries — one hue per source
 *    port, the same wherever that value goes, so a bundle of parallel wires can be told apart. A
 *    control edge takes the colour of its DIRECTION: grey for the sequence, {@link EdgeFlow} for the
 *    rest. Hue never distinguishes data from control; geometry does.
 *  - **dash** — HOW IT IS WRITTEN. Solid is the plain case (a bare binding, a rule on the mount).
 *    Dashed is "one of several" (a read inside an expression, a rule that belongs to no child).
 *    Dotted is "not written at all" (the implicit fill, a guard's read, a step that does not wait).
 *  - **weight, opacity, depth** — ATTENTION, and nothing else. See {@link focusOf}.
 *
 * ## Where a transition leaves from
 *
 * A transition declared on a child MOUNT is eligible only in the round that child's completion
 * triggered (`schemas.ts`, §7), so its edge leaves that child's box. A transition in the STATE's own
 * list is evaluated after EVERY round and belongs to no child at all — those leave the {@link ANY}
 * box, which is what that box is for. Nothing here guesses a source from a guard: an edge that left
 * the child a guard happens to read would be claiming an eligibility rule the engine does not have.
 */
import { childOrder } from "./stateForm";
import { childStateIdOf } from "./completions";
import { slotsOf, type SlotRow } from "./slotForm";
import type { StateSlots } from "@jaira/shared/browser";

/** The node the state's inputs belong to — where a run comes in, and where `.inputs.*` is produced. */
export const ENTRY = "entry";
/** The node the state's outputs belong to — where a run leaves, having succeeded. */
export const EXIT = "exit";
/** Where the state's OWN transitions leave from: the round after anything at all finished. */
export const ANY = "any";
/** The state's own operation, when it declares one. */
export const OPERATION = "operation";

/** A child's node id. Keys are the author's, so they are namespaced rather than used bare. */
export function childNodeId(key: string): string {
  return `child:${key}`;
}

/**
 * A guard, as somewhere a wire can END.
 *
 * A rule reads values — that is what a guard IS — so those reads are dataflow and are drawn as
 * dataflow. Giving the label a node id of its own is what lets one wire type serve both: everything
 * else in this module can go on treating a wire as joining a port to a port.
 */
export function ruleNodeId(edgeId: string): string {
  return `rule:${edgeId}`;
}

export type GraphNodeKind = "entry" | "operation" | "child" | "exit" | "outcome" | "any" | "missing";

/**
 * One value a box takes or hands back, and one end of a wire.
 *
 * Both halves on every box, which is the whole of what a node graph is for: a child shown with only
 * its wired inputs answers "what did the author fill in" when the question is "what does this thing
 * take, and what does it give". A slot with nothing wired into it is still a port — an empty one,
 * which is a fact worth being able to see.
 */
export interface GraphPort {
  /** Unique within its node — the side and the name, since a slot may be both. */
  key: string;
  side: "in" | "out";
  name: string;
  /** What a wire cannot say: a type, a literal, `optional`. Empty when the wire says it all. */
  note: string;
  /**
   * True when nothing declares this port and only a reference to it proves it exists.
   *
   * Drawn as a port all the same. A binding that reads `.children.draft.output.plan` where `draft`
   * declares no `plan` is a real wire in the document and a lint error in the panel; a graph that
   * dropped it would be the one surface claiming the wiring is fine.
   */
  inferred: boolean;
  /** True when at least one wire ends here. An empty port is drawn hollow — see the vocabulary. */
  wired: boolean;
  /**
   * The colour of the value this port carries, in degrees of hue, or `null` if nothing flows.
   *
   * Assigned per SOURCE port and carried by every wire leaving it, so one value is one colour
   * wherever it turns up. That is what makes a bundle of eight parallel wires followable, and it is
   * the only reason hue is spent on dataflow at all.
   */
  hue: number | null;
}

/** A line in a box's body that is NOT a port: an operation's settings, mostly. */
export interface GraphRow {
  label: string;
  value: string;
}

export interface GraphChip {
  text: string;
  tone: "plain" | "accent" | "warn" | "bad";
  title?: string;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  title: string;
  /** The second line: a child's state reference, an operation's kind, the state's own label. */
  subtitle: string;
  /**
   * The state a child mounts, resolved to an id — what opening the box opens.
   *
   * Empty when there is nothing to open: `./` still being typed, or a box that is not a mount.
   */
  stateId: string;
  chips: GraphChip[];
  ports: GraphPort[];
  rows: GraphRow[];
  /**
   * The slice of the document this box IS — its mount declaration, the slot map, the operation block.
   *
   * A box draws the shape of a thing; this is the thing. Carried here rather than looked up by the
   * view because which part of the document a box stands for is a fact about the FORMAT — the entry
   * is `inputs`, the `any` box is the state's own `transitions` — and the view has no business
   * knowing that. `undefined` for a box the document does not contain, such as an outcome.
   */
  config: unknown;
  /** A child the cursor never walks into: declared, and reachable only by a jump (§6). */
  offSpine: boolean;
}

/** One end of a wire: a port on a box, or a read of a guard (see {@link ruleNodeId}). */
export interface WireEnd {
  node: string;
  port: string;
}

/**
 * How a value came to be read, which is the wire's dash — see the vocabulary.
 *
 *  - `binding` — a bare path. The plain case, and solid.
 *  - `expr` — one of the paths an expression reads. Dashed: the line is part of the value, not it.
 *  - `produced` — the implicit fill (§3.3), which no line of the document spells out. Dotted.
 *  - `guard` — a read a transition's condition makes. Dotted, and it ends at the rule.
 */
export type WireKind = "binding" | "expr" | "produced" | "guard";

/** A value moving from where it was produced to where it is read. */
export interface GraphWire {
  id: string;
  from: WireEnd;
  to: WireEnd;
  kind: WireKind;
  /** The binding as authored — the tooltip, since the line itself only says "from here to there". */
  binding: string;
  /** The source port's colour. One value, one hue, everywhere it goes. */
  hue: number;
}

/**
 * Why an edge exists, which is its dash.
 *
 *  - `sequence` — the cursor's own path: the spine, plus the two ends that bracket it.
 *  - `mount` — a transition declared on the child it leaves, eligible in that child's round only.
 *  - `state` — a rule in the state's own list, which leaves the {@link ANY} box.
 */
export type GraphEdgeKind = "sequence" | "mount" | "state";

/**
 * Which way a move takes the run, which is its hue.
 *
 * The three things that can happen to a run are that it gets nearer the end, that it goes back over
 * ground it has covered, or that it stops badly — and an author reading a graph is asking which of
 * those a given rule does. Measured by the target's COLUMN against the source's, because columns are
 * run order: that is what makes "forward" a fact about the drawing rather than a guess about intent.
 */
export type EdgeFlow = "onward" | "back" | "abort";

/** One clause of a guard, split into the paths it reads and the text between them. */
export interface GuardTerm {
  text: string;
  /** The port this term reads, when it is a runtime path that names one. */
  read: WireEnd | null;
}

/**
 * One clause of a guard, on a line of its own.
 *
 * A compound guard is a stack of conditions with the operator that joins them at the front of each
 * line, because that is how it is read: three conditions on one line is a sentence to parse, three
 * lines is a list to scan. `op` is empty on the first line — nothing precedes it.
 */
export interface GuardLine {
  op: "" | "&&" | "||";
  terms: GuardTerm[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** The guard as authored. `null` is unconditional — a real and useful shape, not a missing value. */
  when: string | null;
  /** The same guard, split at its top-level operators and then at the paths it reads. */
  lines: GuardLine[];
  /** True when the guard survived loading as something other than a plain string. Shown as written. */
  structured: boolean;
  /**
   * Its place in the list it was declared in, and how long that list is.
   *
   * Not drawn. Transitions are evaluated in order and the first match wins, so the position is real
   * and worth having — but a number beside a condition reads as part of the condition, so it is said
   * in words on the label's tooltip instead of stamped on the picture.
   */
  order: number;
  count: number;
  /** A step the cursor does NOT wait for: the child at its tail is `async` (§6). */
  nowait: boolean;
  /** `to` names neither a declared child nor a `terminate.*` outcome. */
  dangling: boolean;
}

export interface StateGraph {
  nodes: GraphNode[];
  /** Control flow: where the cursor goes. */
  edges: GraphEdge[];
  /** Dataflow: what moves, and where from. */
  wires: GraphWire[];
  /** `limits`, spelled for the bar above the drawing. Empty when the state declares none. */
  limits: string[];
}

/** The four documented endings. `terminate.success` is the EXIT box; the rest get boxes of their own. */
const OUTCOMES = ["terminate.success", "terminate.error", "terminate.canceled", "terminate.timeout"];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A value as one line of a box.
 *
 * A reference is shown as the reference — `{"$ref": "$/prompts/draft.md"}` is a path an author knows
 * by sight, and its JSON spelling is four times as long and says the same thing. Everything else
 * falls back to JSON.
 */
function oneLine(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  const record = asRecord(value);
  const ref = record["$ref"];
  if (typeof ref === "string" && Object.keys(record).length === 1) return ref;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  return JSON.stringify(value) ?? "";
}

/** A slot's type, as a port states it: the picker's word, a linked type, or the schema as written. */
function slotType(row: SlotRow): string {
  if (row.typeRef !== undefined) return row.typeRef;
  if (row.type === null) return row.schemaText;
  const name = row.type.name === "artifact" && row.type.mediaType !== undefined ? row.type.mediaType : row.type.name;
  return row.type.list ? `${name}[]` : name;
}

// --- guards --------------------------------------------------------------------

/**
 * Split a guard at its TOP-LEVEL operators, lowest precedence first, then at the paths it reads.
 *
 * `&&` binds tighter than `||`, so a guard holding both splits at the `||`s and each clause that
 * still contains an `&&` is shown parenthesised — otherwise the lines would read as a flat list of
 * alternatives and mean something the engine does not do. Depth and quotes are tracked, so an
 * operator inside a call, an index or a string is not an operator here: `f(a && b)` is one clause.
 *
 * Nothing is rewritten beyond those brackets. Each line is the source text of one clause, so what is
 * on screen can be read back into the file.
 */
export function guardLines(when: string): GuardLine[] {
  const top = splitTop(when);
  if (top.parts.length < 2) return [{ op: "", terms: guardTerms(when.trim()) }];
  return top.parts.map((part, i) => {
    const text = part.trim();
    // A clause that still contains the tighter operator is bracketed, because the operator joining
    // these lines is `||`, and `a || b && c` is not `(a || b) && c`.
    const bracket = top.op === "||" && splitTop(text).parts.length > 1 && !isBracketed(text);
    return { op: i === 0 ? ("" as const) : top.op, terms: guardTerms(bracket ? `(${text})` : text) };
  });
}

/**
 * Split one clause into the runtime paths it reads and the text between them.
 *
 * The paths are what a reader wants to follow — "where does `.children.critique.output.target` come
 * from" is the same question the wires answer everywhere else — so they are marked here and become
 * hoverable terms with a line of their own. Everything else is text and stays text.
 */
export function guardTerms(clause: string): GuardTerm[] {
  const terms: GuardTerm[] = [];
  let at = 0;
  for (const match of clause.matchAll(PATH)) {
    const start = match.index + (match[1]?.length ?? 0);
    const text = match[0].slice(match[1]?.length ?? 0);
    if (start > at) terms.push({ text: clause.slice(at, start), read: null });
    terms.push({ text, read: portOfPath(text) });
    at = start + text.length;
  }
  if (at < clause.length) terms.push({ text: clause.slice(at), read: null });
  return terms.length > 0 ? terms : [{ text: clause, read: null }];
}

/** True for a clause the author already wrapped, so it is not wrapped twice. */
function isBracketed(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      // Closed before the end ⇒ the outer brackets are two groups rather than one wrapper: `(a)&&(b)`.
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return depth === 0;
}

/** The pieces of one expression at bracket depth zero, and which operator separated them. */
function splitTop(text: string): { op: "&&" | "||"; parts: string[] } {
  for (const op of ["||", "&&"] as const) {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (quote !== "") {
        // A backslash escapes the next character, so a quote inside a string does not end it.
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && c === op[0] && text[i + 1] === op[1]) {
        parts.push(text.slice(start, i));
        start = i + 2;
        i++;
      }
    }
    if (parts.length > 0) {
      parts.push(text.slice(start));
      return { op, parts };
    }
  }
  return { op: "&&", parts: [text] };
}

// --- bindings ------------------------------------------------------------------

const inPort = (name: string): string => `in:${name}`;
const outPort = (name: string): string => `out:${name}`;

/**
 * Every runtime path that names a port, in one expression.
 *
 * Group 1 is whatever had to precede a bare `.inputs.…` for it to be one — a path is only a path at
 * the start of a term, and `.children.a.inputs.x` is not a read of this state's inputs.
 */
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const READS = [
  String.raw`children\.${NAME}\.(?:output\.${NAME}|outcome)`,
  String.raw`inputs\.${NAME}`,
  String.raw`operation\.outputs?\.${NAME}`,
];
const PATH = new RegExp(String.raw`(^|[^\w.])\.(?:${READS.join("|")})`, "g");

/** The port one runtime path names, or `null` when it names something that is not a port. */
function portOfPath(path: string): WireEnd | null {
  const child = /^\.children\.([A-Za-z_$][\w$]*)\.(?:output\.([A-Za-z_$][\w$]*)|outcome)$/.exec(path);
  if (child !== null) return { node: childNodeId(child[1]!), port: outPort(child[2] ?? "outcome") };
  const input = /^\.inputs\.([A-Za-z_$][\w$]*)$/.exec(path);
  if (input !== null) return { node: ENTRY, port: outPort(input[1]!) };
  const op = /^\.operation\.outputs?\.([A-Za-z_$][\w$]*)$/.exec(path);
  if (op !== null) return { node: OPERATION, port: outPort(op[1]!) };
  return null;
}

/** Every port an expression or a binding reads, in the order it reads them. */
function readsIn(text: string): WireEnd[] {
  const found: WireEnd[] = [];
  for (const match of text.matchAll(PATH)) {
    const read = portOfPath(match[0].slice(match[1]?.length ?? 0));
    if (read !== null && !found.some((e) => e.node === read.node && e.port === read.port)) found.push(read);
  }
  return found;
}

/**
 * What a binding IS, in the two ways the graph needs to know.
 *
 * `reads` is where its value comes from — one path for a bare binding, however many an expression
 * makes, none for a literal. `text` is what the port or the tooltip shows. §8 makes all of these one
 * grammar, so this is the one place that takes them apart.
 */
function bindingOf(value: unknown): { text: string; reads: WireEnd[]; kind: WireKind } {
  if (typeof value === "string") return { text: value, reads: readsIn(value), kind: "binding" };
  const record = asRecord(value);
  const only = Object.keys(record).length === 1;
  const expr = record["expr"];
  if (typeof expr === "string" && only) return { text: expr, reads: readsIn(expr), kind: "expr" };
  // `{ text }`, `{ json }`, `{ $ref }` and anything embedded are VALUES rather than reads. They get
  // no wire, which is why the port shows them instead: a literal with no line to it would otherwise
  // look like a slot nobody filled. Each is shown as the value it IS rather than as its wrapper —
  // `{"text": "engineering"}` is four words of JSON around the one word an author wrote.
  if (typeof record["text"] === "string" && only) return { text: record["text"], reads: [], kind: "binding" };
  if (only && "json" in record) return { text: oneLine(record["json"]), reads: [], kind: "binding" };
  return { text: oneLine(value), reads: [], kind: "binding" };
}

/** A node under construction: its ports arrive from both what it declares and what reads it. */
interface Building extends Omit<GraphNode, "ports"> {
  ports: Map<string, GraphPort>;
}

/**
 * Hues, as far apart as any number of them can be.
 *
 * The golden angle is the standard answer to "N colours, N unknown in advance": every prefix of the
 * sequence is about as evenly spread round the wheel as a set of that size can be, so the fourth
 * value added does not land on the first. The offset starts the run at a warm orange rather than at
 * red, which control flow has already spent on `abort`.
 */
const HUE_STEP = 137.508;
const HUE_START = 32;

// --- reading the document ------------------------------------------------------

/**
 * Read a state document into boxes, ports, wires and edges.
 *
 * Over the parsed DOCUMENT rather than over the form's model, and that is deliberate: the form does
 * not model a transition declared on a child mount — it carries it through untouched, which is
 * correct for saving and useless for drawing. The graph reads the same text the JSON tab shows.
 *
 * `stateId` is this file's own id, needed to resolve a child's `./key` reference into something
 * openable. `declared` is what the children themselves declare, keyed by state id — the same answer
 * the form's wiring table asks for. Without it a child still shows every port anything READS; with
 * it, it also shows the ones nothing has wired yet, which is the half an author is looking for.
 */
export function graphOf(doc: unknown, stateId = "", declared: Record<string, StateSlots> = {}): StateGraph {
  const state = asRecord(doc);
  const building = new Map<string, Building>();
  const edges: GraphEdge[] = [];
  const wires: GraphWire[] = [];

  const add = (node: Omit<GraphNode, "ports">): Building => {
    const box: Building = { ...node, ports: new Map() };
    building.set(node.id, box);
    return box;
  };
  /**
   * Which boxes we can say anything about a missing slot on.
   *
   * This file declares its own slots and its operation's, so a port on those that only a reference
   * proves is a port that does not exist — worth marking. A child whose declaration was never loaded
   * is a different case entirely: nothing is known, and marking every wired slot as suspect would
   * paint a correct graph as one full of errors.
   */
  const known = new Set<string>([ENTRY, EXIT, OPERATION]);
  /**
   * Add a port, or fill in what is now known about one already there.
   *
   * Both directions matter: a port first seen because something read it is `inferred`, and stops
   * being inferred the moment the declaration that owns it turns up.
   */
  const port = (nodeId: string, side: "in" | "out", name: string, note = "", loose = false): void => {
    const box = building.get(nodeId);
    if (box === undefined) return;
    const key = side === "in" ? inPort(name) : outPort(name);
    const found = box.ports.get(key);
    if (found === undefined) {
      box.ports.set(key, { key, side, name, note, inferred: loose && known.has(nodeId), wired: false, hue: null });
      return;
    }
    if (!loose) found.inferred = false;
    if (note.length > 0) found.note = note;
  };

  // --- the two ends ---------------------------------------------------------
  const label = typeof state["label"] === "string" ? state["label"] : "";
  const entry = add({
    id: ENTRY,
    kind: "entry",
    title: "Entry",
    subtitle: label.length > 0 ? label : stateId,
    stateId: "",
    chips: [],
    rows: [],
    config: state["inputs"],
    offSpine: false,
  });
  const inputs = slotsOf(state["inputs"]);
  for (const row of inputs) {
    // What happens if you leave it out, which is the fact an input carries that a type does not.
    port(ENTRY, "out", row.name, row.default.length > 0 ? `= ${row.default}` : row.optional ? "optional" : slotType(row));
  }
  if (inputs.length === 0) entry.chips.push({ text: "no inputs", tone: "plain" });

  const exit = add({
    id: EXIT,
    kind: "exit",
    title: "Exit",
    subtitle: "terminate.success",
    stateId: "",
    chips: [],
    rows: [],
    config: state["outputs"],
    offSpine: false,
  });
  const outputs = slotsOf(state["outputs"]);
  if (outputs.length === 0) exit.chips.push({ text: "no outputs", tone: "plain" });

  // --- the operation --------------------------------------------------------
  const operation = state["operation"];
  const hasOperation = operation !== undefined;
  if (hasOperation) {
    const block = asRecord(operation);
    const kind = typeof block["kind"] === "string" ? block["kind"] : "";
    const chips: GraphChip[] = [];
    if (kind.length > 0) chips.push({ text: kind, tone: "accent" });
    for (const field of ["function", "model"]) {
      const value = oneLine(block[field]);
      if (value.length > 0) chips.push({ text: value, tone: "plain", title: `operation.${field}` });
    }
    add({
      id: OPERATION,
      kind: "operation",
      title: "operation",
      // A whole block written as a reference is a string in an object position (§2.2), so the
      // reference IS the value — there is nothing to take apart and nothing to list.
      subtitle: typeof operation === "string" ? operation : kind.length > 0 ? "" : "kind inherited",
      stateId: "",
      chips,
      rows: typeof operation === "string" ? [] : operationRows(block),
      config: operation,
      offSpine: false,
    });
    for (const [name, param] of Object.entries(asRecord(block["input"]))) {
      // §4.3: a parameter carries its binding under `binding`. A bare string is the documented silent
      // failure — the port says so, because that is the point at which it is spotted.
      const bare = asRecord(param)["binding"] === undefined && typeof param === "string";
      port(OPERATION, "in", name, bare ? "no binding:" : "");
    }
    // One authored field, a MAP whose keys are the returned names — the single-slot spelling beside
    // it is gone, and a lone entry carrying its own `kind` is how "the whole return is that value"
    // is said now.
    for (const name of Object.keys(asRecord(block["output"]))) port(OPERATION, "out", name);
  }

  // --- the children, in the order they run ----------------------------------
  const childMap = asRecord(state["children"]);
  const order = childOrder(state);
  const keys = order.map((c) => c.key);
  for (const { key, inSpine } of order) {
    const decl = asRecord(childMap[key]);
    const ref = typeof decl["state"] === "string" ? decl["state"] : "";
    const environment = asRecord(decl["environment"]);
    const chips: GraphChip[] = [];
    if (decl["async"] === true) chips.push({ text: "async", tone: "warn", title: "the cursor does not wait for it" });
    if (!inSpine) chips.push({ text: "jump target", tone: "plain", title: "declared, but not in the sequence" });
    for (const field of ["kind", "function", "model"]) {
      const value = oneLine(environment[field]);
      if (value.length > 0) chips.push({ text: value, tone: "plain", title: `environment.${field}` });
    }
    add({
      id: childNodeId(key),
      kind: "child",
      title: key,
      // `./<key>` is what an omitted `state` means (§6), so the box says it rather than leaving the
      // second line blank on the majority of mounts.
      subtitle: ref.length > 0 ? ref : `./${key}`,
      stateId: childStateIdOf(stateId, key, ref),
      chips,
      rows: [],
      config: childMap[key],
      offSpine: !inSpine,
    });
    // What the child DECLARES, ahead of what this file happens to have wired: an unfilled input is
    // the port worth seeing, and it is exactly the one a wiring-only reading leaves out.
    const slots = declared[childStateIdOf(stateId, key, ref)];
    if (slots !== undefined) known.add(childNodeId(key));
    for (const slot of slots?.inputs ?? []) port(childNodeId(key), "in", slot.name, slot.optional ? "optional" : "");
    for (const slot of slots?.outputs ?? []) port(childNodeId(key), "out", slot.name);
  }

  // --- the wires ------------------------------------------------------------
  /** One hue per SOURCE port, handed out in the order the sources are first read. */
  const hues = new Map<string, number>();
  const hueOf = (end: WireEnd): number => {
    const key = `${end.node}/${end.port}`;
    const found = hues.get(key);
    if (found !== undefined) return found;
    const hue = (HUE_START + hues.size * HUE_STEP) % 360;
    hues.set(key, hue);
    return hue;
  };
  /** Draw one line, marking both ends as carrying something. */
  const join = (id: string, from: WireEnd, to: WireEnd, kind: WireKind, binding: string): void => {
    const source = building.get(from.node);
    if (source === undefined) return;
    // The port at the far end may be one nothing declares. It is still where the line starts.
    if (!source.ports.has(from.port)) port(from.node, "out", from.port.slice("out:".length), "", true);
    const hue = hueOf(from);
    const at = source.ports.get(from.port);
    if (at !== undefined) {
      at.hue = hue;
      at.wired = true;
    }
    // The far end carries the same value, so it is filled in the same colour: a line that ARRIVES
    // somewhere has to say so at both ends, or a port that is fed reads as one nobody wired. An
    // input read by an expression takes the colour of the first value the expression reads — one of
    // several, where the others are on their own lines.
    const target = building.get(to.node)?.ports.get(to.port);
    if (target !== undefined) {
      target.wired = true;
      if (target.hue === null) target.hue = hue;
    }
    wires.push({ id, from, to, kind, binding, hue });
  };
  /** Wire one binding into one port, or — when it reads nothing — write the value on the port. */
  const wire = (target: WireEnd, name: string, value: unknown, at: string): void => {
    const binding = bindingOf(value);
    port(target.node, "in", name, binding.reads.length === 0 ? binding.text : "");
    binding.reads.forEach((read, i) => join(`${at}:${name}:${i}`, read, target, binding.kind, binding.text));
  };

  for (const { key } of order) {
    for (const [name, value] of Object.entries(asRecord(asRecord(childMap[key])["inputs"]))) {
      wire({ node: childNodeId(key), port: inPort(name) }, name, value, `w:${key}`);
    }
  }
  if (hasOperation) {
    for (const [name, param] of Object.entries(asRecord(asRecord(operation)["input"]))) {
      wire({ node: OPERATION, port: inPort(name) }, name, asRecord(param)["binding"] ?? param, "w:operation");
    }
  }
  for (const row of outputs) {
    if (row.binding.length === 0) {
      // Nothing says where this comes from. The format would fill it from the operation's result of
      // the same name (§3.3); JaiRA reports it instead, and the port says which of the two it is.
      port(EXIT, "in", row.name, hasOperation ? "unbound" : row.optional ? "optional" : slotType(row));
      // The implicit fill (§3.3): an output with no binding takes the operation's result of the same
      // name. That is a value moving, so it is a wire — the one piece of this state's dataflow that
      // no line of the document spells out, which is why it is drawn as the faintest kind.
      if (building.get(OPERATION)?.ports.has(outPort(row.name)) === true) {
        join(
          `w:produced:${row.name}`,
          { node: OPERATION, port: outPort(row.name) },
          { node: EXIT, port: inPort(row.name) },
          "produced",
          "an output with no binding takes the operation's result of its own name",
        );
      }
      continue;
    }
    wire({ node: EXIT, port: inPort(row.name) }, row.name, authoredBinding(state, row.name), "w:exit");
  }

  // --- control flow ---------------------------------------------------------
  const steps = order.filter((c) => c.inSpine).map((c) => childNodeId(c.key));
  const spine = [ENTRY, ...(hasOperation ? [OPERATION] : []), ...steps, EXIT];
  for (let i = 0; i + 1 < spine.length; i++) {
    const from = spine[i]!;
    const key = from.startsWith("child:") ? from.slice("child:".length) : "";
    edges.push({
      id: `seq:${i}`,
      from,
      to: spine[i + 1]!,
      kind: "sequence",
      when: null,
      lines: [],
      structured: false,
      order: 0,
      count: 1,
      nowait: key.length > 0 && asRecord(childMap[key])["async"] === true,
      dangling: false,
    });
  }

  /** Where a `to` lands. `terminate.success` is the exit box; an unknown target gets one of its own. */
  const seen = new Set<string>();
  const targetOf = (to: string): { id: string; dangling: boolean } => {
    if (to === "terminate.success") return { id: EXIT, dangling: false };
    if (OUTCOMES.includes(to)) {
      if (!seen.has(to)) {
        seen.add(to);
        const box = { subtitle: "", stateId: "", chips: [], rows: [], config: undefined, offSpine: true };
        add({ id: to, kind: "outcome", title: to, ...box });
      }
      return { id: to, dangling: false };
    }
    if (keys.includes(to)) return { id: childNodeId(to), dangling: false };
    // Neither a child nor an outcome. The linter says so in words; the graph says so by drawing the
    // dead end, because a transition silently omitted is a transition nobody looks for.
    const id = `missing:${to}`;
    if (!seen.has(id)) {
      seen.add(id);
      add({
        id,
        kind: "missing",
        title: to.length > 0 ? to : "(no target)",
        subtitle: "no such child",
        stateId: "",
        chips: [],
        rows: [],
        config: undefined,
        offSpine: true,
      });
    }
    return { id, dangling: true };
  };

  const transition = (id: string, from: string, kind: GraphEdgeKind, t: Rule, i: number, count: number): void => {
    const target = targetOf(t.to);
    const lines = t.when === null ? [] : guardLines(t.when);
    edges.push({
      id,
      from,
      to: target.id,
      kind,
      when: t.when,
      lines,
      structured: t.structured,
      order: i,
      count,
      nowait: false,
      dangling: target.dangling,
    });
    // A guard READS values, and a read is dataflow wherever it happens. Drawing these is what lets a
    // term inside a condition be followed back to the box that produced it.
    let read = 0;
    for (const line of lines) {
      for (const term of line.terms) {
        if (term.read === null) continue;
        join(`g:${id}:${read}`, term.read, { node: ruleNodeId(id), port: inPort(String(read)) }, "guard", term.text);
        read++;
      }
    }
  };

  // A rule on the mount, taken in the round THAT child's completion triggered. One true source.
  for (const { key } of order) {
    const rules = rulesOf(asRecord(childMap[key])["transitions"]);
    rules.forEach((t, i) => transition(`mount:${key}:${i}`, childNodeId(key), "mount", t, i, rules.length));
  }

  // The state's own list, which belongs to no child — see the header.
  const own = rulesOf(state["transitions"]);
  if (own.length > 0) {
    add({
      id: ANY,
      kind: "any",
      title: "any",
      subtitle: "after any round",
      stateId: "",
      chips: [],
      rows: [],
      config: state["transitions"],
      offSpine: true,
    });
    own.forEach((t, i) => transition(`state:${i}`, ANY, "state", t, i, own.length));
  }

  const limits = asRecord(state["limits"]);
  const stated: string[] = [];
  if (typeof limits["max_iterations"] === "number") stated.push(`max_iterations ${limits["max_iterations"]}`);
  if (typeof limits["timeout"] === "number") stated.push(`timeout ${limits["timeout"]}s`);

  const nodes = [...building.values()].map((box) => ({ ...box, ports: [...box.ports.values()] }));
  return { nodes, edges, wires, limits: stated };
}

/** One transition as declared. */
interface Rule {
  to: string;
  when: string | null;
  structured: boolean;
}

/** Read one `transitions` array. Order is kept: the list is evaluated top down, first match wins. */
function rulesOf(value: unknown): Rule[] {
  const raw = Array.isArray(value) ? (value as unknown[]) : [];
  return raw.map((entry) => {
    const t = asRecord(entry);
    const when = t["when"];
    return {
      to: typeof t["to"] === "string" ? t["to"] : "",
      when: when === undefined ? null : typeof when === "string" ? when : JSON.stringify(when),
      structured: when !== undefined && typeof when !== "string",
    };
  });
}

/**
 * An output's binding as the DOCUMENT holds it, rather than as the slot row flattened it.
 *
 * `slotRowOf` stringifies a structured binding so a text box can show it; a wire needs the value
 * back, because `{ expr }` reads paths and `{ text }` does not.
 */
function authoredBinding(state: Record<string, unknown>, name: string): unknown {
  return asRecord(asRecord(state["outputs"])[name])["binding"];
}

/**
 * The operation's settings, as body lines.
 *
 * `input` and `output` are ports rather than rows — they are the wiring, and the wiring is what the
 * lines join. What is left is `prompt`, `tools`, `session`, `permissions`: settings whose presence is
 * most of what a picture needs to convey.
 */
function operationRows(operation: Record<string, unknown>): GraphRow[] {
  const skip = ["kind", "function", "model", "input", "output", "outputs"];
  return Object.entries(operation)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => ({ label: key, value: oneLine(value) }));
}

// --- attention -----------------------------------------------------------------

/** What the pointer is on. Each of these is something a reader can ask a question about. */
export type Focus =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "port"; node: string; port: string }
  | { kind: "wire"; id: string };

/** Everything the drawing can raise or fade, under one naming scheme. */
export const idOf = {
  node: (id: string): string => `node:${id}`,
  edge: (id: string): string => `edge:${id}`,
  wire: (id: string): string => `wire:${id}`,
  port: (node: string, port: string): string => `port:${node}:${port}`,
};

/**
 * Three tiers, and what belongs in each: the answer to "what is this reader looking at".
 *
 * `lit` is the thing under the pointer and every line that IS its answer. `near` is what those lines
 * touch — kept legible, because an arrow pointing into a faded box answers nothing. Everything else
 * is dimmed hard, which is the whole point: a dense graph is unreadable not because it holds too
 * much but because at any moment almost all of it is beside the question.
 *
 * One function for all four kinds of hover, so the four cannot drift into four different ideas of
 * what "related" means:
 *
 *  - a BOX — itself, every line that touches it, and the boxes at their far ends.
 *  - a RULE — itself, its arrow, the two boxes it joins, and the reads its condition makes.
 *  - a PORT — itself, the wires through it, and the ports and boxes at their far ends.
 *  - a TERM in a rule — the one wire it reads, the port it comes from, and that port's box.
 */
export function focusOf(graph: StateGraph, focus: Focus | null): { lit: Set<string>; near: Set<string> } {
  const lit = new Set<string>();
  const near = new Set<string>();
  if (focus === null) return { lit, near };

  /** A wire's rule, when it ends in one — the label is where the reader's eye already is. */
  const ruleOf = (node: string): string | null => (node.startsWith("rule:") ? node.slice("rule:".length) : null);
  const litWire = (wire: GraphWire): void => {
    lit.add(idOf.wire(wire.id));
    lit.add(idOf.port(wire.from.node, wire.from.port));
    const rule = ruleOf(wire.to.node);
    if (rule === null) {
      lit.add(idOf.port(wire.to.node, wire.to.port));
      near.add(idOf.node(wire.to.node));
    } else lit.add(idOf.edge(rule));
    near.add(idOf.node(wire.from.node));
  };

  if (focus.kind === "node") {
    lit.add(idOf.node(focus.id));
    for (const edge of graph.edges) {
      if (edge.from !== focus.id && edge.to !== focus.id) continue;
      lit.add(idOf.edge(edge.id));
      near.add(idOf.node(edge.from === focus.id ? edge.to : edge.from));
    }
    for (const wire of graph.wires) {
      if (wire.from.node !== focus.id && wire.to.node !== focus.id) continue;
      litWire(wire);
    }
  } else if (focus.kind === "edge") {
    const edge = graph.edges.find((e) => e.id === focus.id);
    if (edge !== undefined) {
      // The rule, its arrow and the two boxes it joins are the answer — all four are LIT rather than
      // near, because "what does this rule do" is a question about the pair of boxes.
      lit.add(idOf.edge(edge.id));
      lit.add(idOf.node(edge.from));
      lit.add(idOf.node(edge.to));
      for (const wire of graph.wires) {
        if (ruleOf(wire.to.node) === edge.id) litWire(wire);
      }
    }
  } else if (focus.kind === "port") {
    lit.add(idOf.port(focus.node, focus.port));
    lit.add(idOf.node(focus.node));
    for (const wire of graph.wires) {
      const mine =
        (wire.from.node === focus.node && wire.from.port === focus.port) ||
        (wire.to.node === focus.node && wire.to.port === focus.port);
      if (mine) litWire(wire);
    }
  } else {
    const wire = graph.wires.find((w) => w.id === focus.id);
    if (wire !== undefined) litWire(wire);
  }
  for (const id of lit) near.delete(id);
  return { lit, near };
}

// --- the drawing ---------------------------------------------------------------

/**
 * Geometry, in px.
 *
 * The stylesheet has to agree with the numbers that decide a box's height — see the `.sg-*` rules,
 * which carry the same ones as fixed line heights. That duplication is deliberate and bounded: a box
 * is positioned AND sized from here, and a port's dot has to land on the line that ends at it.
 */
const NODE_W = 258;
const COL_GAP = 104;
const ROW_H = 17;
const TITLE_H = 20;
const SUB_H = 15;
const CHIP_H = 21;
const PAD = 9;
const BORDER = 1;
/** Between the last chip or row and the first port — the body's own shoulder. */
const PORTS_GAP = 5;
/** Between the spine's lane and the lane below it, where a jump target sits. */
const LANE_GAP = 60;
/** Between the boxes and the first arc, above and below. */
const ARC_GAP = 26;
/** Between one arc lane's labels and the next one's. */
const LANE_PAD = 14;
const MARGIN = 24;
/** How far into a box's edge the outermost arc may attach. */
const ANCHOR_INSET = 18;

/**
 * A guard label's box, measured rather than guessed.
 *
 * The label is set in the data voice at a fixed size (see `.sg-label` in the stylesheet), so its
 * width is countable. It has to be: labels are centred on their arcs, arcs are stacked into lanes so
 * their labels do not collide, and a stack computed from a guessed width collides anyway.
 */
const LABEL_CHAR = 6.25;
const LABEL_LINE = 15;
const LABEL_PAD_X = 18;
const LABEL_PAD_Y = 7;
/** Past this a line wraps. Wide enough for most guards whole — no guard is ever cut. */
const LABEL_MAX_W = 460;

export interface PlacedPort extends GraphPort {
  x: number;
  y: number;
}

export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: PlacedPort[];
}

/**
 * A line, as the shape it actually is: one cubic, start to end.
 *
 * Every line in the drawing is one — a step of the sequence is the degenerate case, with its control
 * points on its ends. Kept beside the `d` string rather than only as one, because the VIEW has to
 * ask questions of the shape that a string cannot answer: where does this line leave the screen, and
 * where along it is there still room to write its condition. See {@link pointOn}.
 */
export interface Curve {
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
}

/** A cubic at `t`. The de Casteljau weights, written out — it is called a few hundred times a frame. */
export function pointOn(c: Curve, t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.x1 + b * c.c1x + d * c.c2x + e * c.x2,
    y: a * c.y1 + b * c.c1y + d * c.c2y + e * c.y2,
  };
}

/** The `d` of one curve. One spelling, so the string and the shape cannot disagree. */
export function pathOf(c: Curve): string {
  return `M ${c.x1} ${c.y1} C ${c.c1x} ${c.c1y}, ${c.c2x} ${c.c2y}, ${c.x2} ${c.y2}`;
}

export interface PlacedEdge {
  edge: GraphEdge;
  /** The SVG path. Straight for a step of the sequence, an arc over or under everything otherwise. */
  d: string;
  curve: Curve;
  /** Which way it takes the run — its hue. See {@link EdgeFlow}. */
  flow: EdgeFlow;
  /** Where the guard is written, and how much room it needs. `null` for a step of the sequence. */
  label: { x: number; y: number; w: number; h: number } | null;
}

export interface PlacedWire {
  wire: GraphWire;
  d: string;
  curve: Curve;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  wires: PlacedWire[];
  width: number;
  height: number;
}

/** What a guard's label reads when it has no guard: the two spellings mean different things (§7). */
export function unconditional(edge: GraphEdge): string {
  return edge.kind === "mount" ? "when it finishes" : "always";
}

/** How much room a guard needs, counting the lines that wrap. */
function labelSize(edge: GraphEdge): { w: number; h: number } {
  const lines =
    edge.lines.length > 0 ? edge.lines : [{ op: "" as const, terms: [{ text: unconditional(edge), read: null }] }];
  let width = 0;
  let rows = 0;
  for (const line of lines) {
    const text = line.terms.map((t) => t.text).join("");
    const w = (text.length + (line.op === "" ? 0 : line.op.length + 1)) * LABEL_CHAR;
    width = Math.max(width, Math.min(w, LABEL_MAX_W));
    rows += Math.max(1, Math.ceil(w / LABEL_MAX_W));
  }
  return { w: width + LABEL_PAD_X, h: rows * LABEL_LINE + LABEL_PAD_Y * 2 };
}

/** Where a box's ports begin: under its heading, its chips and whatever settings it lists. */
function bodyTop(node: GraphNode): number {
  return (
    PAD +
    BORDER +
    TITLE_H +
    (node.subtitle.length > 0 ? SUB_H : 0) +
    (node.chips.length > 0 ? CHIP_H : 0) +
    node.rows.length * ROW_H +
    (node.ports.length > 0 ? PORTS_GAP : 0)
  );
}

/** Ports go in two columns, so a box is as tall as its longer side. */
function heightOf(node: GraphNode): number {
  const ins = node.ports.filter((p) => p.side === "in").length;
  const outs = node.ports.length - ins;
  return bodyTop(node) + Math.max(ins, outs) * ROW_H + PAD + BORDER;
}

/**
 * Place the boxes, hang the wires, route the arrows.
 *
 * One column per box, and that is a routing property rather than an aesthetic one: an arc runs
 * vertically out of the box it leaves before it turns, so a box directly above or below another
 * would have that arc pass straight through it. With a column to itself, every vertical run is over
 * empty ground.
 *
 * Columns are RUN ORDER and nothing else, the same rule the board's columns follow: a guard that
 * jumps backwards is control flow, and letting it reorder the columns would turn the one axis a
 * reader can trust into something that has to be worked out. It is also what makes {@link EdgeFlow}
 * measurable — "onward" is a direction on this axis, not a guess.
 */
export function layoutOf(graph: StateGraph): GraphLayout {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const heights = new Map(graph.nodes.map((n) => [n.id, heightOf(n)]));
  const height = (id: string): number => heights.get(id) ?? 0;

  const spine = graph.nodes.filter((n) => (n.kind === "operation" || n.kind === "child") && !n.offSpine);
  const below = graph.nodes.filter((n) => n.kind === "child" && n.offSpine);
  const any = graph.nodes.filter((n) => n.kind === "any");
  const outcomes = graph.nodes.filter((n) => n.kind === "outcome" || n.kind === "missing");
  const entry = byId.get(ENTRY);
  const exit = byId.get(EXIT);
  const order = [
    ...(entry === undefined ? [] : [entry]),
    ...spine,
    ...below,
    ...any,
    ...(exit === undefined ? [] : [exit]),
    // After the exit, because that is what they are: the ways out that are not the way out.
    ...outcomes,
  ];
  const onSpine = new Set([ENTRY, EXIT, ...spine.map((n) => n.id)]);
  const colX = (col: number): number => MARGIN + col * (NODE_W + COL_GAP);

  const placed: PlacedNode[] = [];
  const at = new Map<string, PlacedNode>();
  const place = (node: GraphNode, x: number, y: number): void => {
    const top = y + bodyTop(node);
    let ins = 0;
    let outs = 0;
    // A port sits on the edge it belongs to, at the middle of its own row — which is where the wire
    // that ends at it is drawn to, and why both numbers come from here rather than from the CSS.
    const ports = node.ports.map((p) => {
      const row = p.side === "in" ? ins++ : outs++;
      return { ...p, x: p.side === "in" ? x : x + NODE_W, y: top + row * ROW_H + ROW_H / 2 };
    });
    const box = { node, x, y, w: NODE_W, h: height(node.id), ports };
    placed.push(box);
    at.set(node.id, box);
  };

  /**
   * Lane 0 is TOP-aligned rather than centred, and that is what keeps the spine legible.
   *
   * Centred boxes put the sequence's own line through the middle of every box — which is exactly
   * where the ports are, so the one line that says what runs next was drawn through the densest part
   * of the drawing and lost in it. Aligned at the top, the spine runs level across the HEADINGS,
   * over ground nothing else uses, and the ports hang below it.
   */
  const belowY = Math.max(...[...onSpine].map(height), 0) + LANE_GAP;
  order.forEach((node, col) => place(node, colX(col), onSpine.has(node.id) ? 0 : belowY));
  const columns = order.length;

  const boxTop = Math.min(...placed.map((b) => b.y));
  const boxBottom = Math.max(...placed.map((b) => b.y + b.h));

  // --- the arcs -------------------------------------------------------------
  /**
   * Which side of the drawing an arc travels on.
   *
   * Both routes clear every box — one rides above the top of everything, the other below the bottom
   * — so no transition ever crosses a box, whatever the shape of the state.
   */
  type Arc = {
    edge: GraphEdge;
    flow: EdgeFlow;
    up: boolean;
    from: PlacedNode;
    to: PlacedNode;
    lane: number;
    x1: number;
    x2: number;
    size: { w: number; h: number };
  };
  const arcs: Arc[] = [];
  for (const edge of graph.edges) {
    if (edge.kind === "sequence") continue;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const bad = to.node.kind === "outcome" || to.node.kind === "missing";
    const flow: EdgeFlow = bad ? "abort" : to.x > from.x ? "onward" : "back";
    // Over the top when it is a forward jump between two boxes ON the line — a skip reads as a skip
    // when it arcs over what it skipped. Everything else goes under the bottom: a backwards jump is
    // a loop and looks like one there, and traffic to or from the lane below stays in the half of
    // the drawing those boxes are in rather than sweeping over the spine to reach them.
    const up = flow === "onward" && onSpine.has(edge.from) && onSpine.has(edge.to);
    arcs.push({ edge, flow, up, from, to, lane: 0, x1: 0, x2: 0, size: labelSize(edge) });
  }

  /**
   * Where each arc meets each box.
   *
   * Every endpoint on one edge of one box is fanned across its width, sorted by where the other end
   * of the line is. Sorting is what stops two lines leaving the same box from crossing each other
   * before they have gone anywhere, and fanning is what stops a child that both loops back to itself
   * and terminates from drawing its two lines on top of each other.
   */
  type End = { box: PlacedNode; arc: Arc; role: "from" | "to"; toward: number };
  const ends = new Map<string, End[]>();
  const addEnd = (end: End): void => {
    const key = `${end.box.node.id}:${end.arc.up ? "top" : "bottom"}`;
    const list = ends.get(key);
    if (list === undefined) ends.set(key, [end]);
    else list.push(end);
  };
  for (const arc of arcs) {
    addEnd({ box: arc.from, arc, role: "from", toward: arc.to.x });
    addEnd({ box: arc.to, arc, role: "to", toward: arc.from.x });
  }
  const anchors = new Map<string, number>();
  for (const list of ends.values()) {
    list.sort((a, b) => a.toward - b.toward || a.arc.edge.id.localeCompare(b.arc.edge.id));
    const span = NODE_W - ANCHOR_INSET * 2;
    list.forEach((end, i) => {
      const x = list.length === 1 ? end.box.x + NODE_W / 2 : end.box.x + ANCHOR_INSET + (span * i) / (list.length - 1);
      anchors.set(`${end.arc.edge.id}:${end.role}`, x);
    });
  }
  for (const arc of arcs) {
    arc.x1 = anchors.get(`${arc.edge.id}:from`) ?? arc.from.x + NODE_W / 2;
    arc.x2 = anchors.get(`${arc.edge.id}:to`) ?? arc.to.x + NODE_W / 2;
  }

  /**
   * Stack the arcs so their labels do not sit on top of one another.
   *
   * Shortest span first, into the lowest lane it fits: a short hop between neighbours stays close to
   * the boxes, and the long loop back to the first child rides above all of it. Overlap is measured
   * on the LABEL rather than on the arc, since the label is the wide part — and a lane is then as
   * tall as the tallest guard in it, which is what keeps a five-clause condition off the line above.
   */
  const laneHeight: Record<"up" | "down", number[]> = { up: [], down: [] };
  for (const up of [true, false]) {
    const lanes: { lo: number; hi: number }[][] = [];
    const side = arcs.filter((a) => a.up === up);
    side.sort((a, b) => Math.abs(a.x2 - a.x1) - Math.abs(b.x2 - b.x1) || a.edge.id.localeCompare(b.edge.id));
    for (const arc of side) {
      const mid = (arc.x1 + arc.x2) / 2;
      const lo = Math.min(Math.min(arc.x1, arc.x2), mid - arc.size.w / 2);
      const hi = Math.max(Math.max(arc.x1, arc.x2), mid + arc.size.w / 2);
      let lane = 0;
      while ((lanes[lane] ?? []).some((s) => s.lo < hi && lo < s.hi)) lane++;
      (lanes[lane] ??= []).push({ lo, hi });
      arc.lane = lane;
      const tall = laneHeight[up ? "up" : "down"];
      tall[lane] = Math.max(tall[lane] ?? 0, arc.size.h);
    }
  }
  /** The rail of lane n sits past every lane below it, each as tall as its own tallest label. */
  const railOffset = (up: boolean, lane: number): number => {
    const tall = laneHeight[up ? "up" : "down"];
    let offset = ARC_GAP;
    for (let i = 0; i < lane; i++) offset += (tall[i] ?? 0) + LANE_PAD;
    return offset + (tall[lane] ?? 0) / 2;
  };
  const railY = (arc: Arc): number =>
    arc.up ? boxTop - railOffset(true, arc.lane) : boxBottom + railOffset(false, arc.lane);

  // --- into positive coordinates -------------------------------------------
  const rails = arcs.map((arc) => ({ y: railY(arc), h: arc.size.h }));
  const minY = Math.min(boxTop, ...rails.map((r) => r.y - r.h / 2));
  const maxY = Math.max(boxBottom, ...rails.map((r) => r.y + r.h / 2));
  const shift = MARGIN - minY;

  /** The height the spine runs at: the middle of a box's heading — see the lane-0 note above. */
  const spineY = PAD + BORDER + TITLE_H / 2 + shift;
  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "sequence") continue;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    // A step is straight, which is a cubic whose control points sit on its own ends.
    const line: Curve = {
      x1: from.x + NODE_W,
      y1: spineY,
      c1x: from.x + NODE_W,
      c1y: spineY,
      c2x: to.x,
      c2y: spineY,
      x2: to.x,
      y2: spineY,
    };
    edges.push({ edge, flow: "onward", d: pathOf(line), curve: line, label: null });
  }
  for (const arc of arcs) {
    const rail = railY(arc) + shift;
    const y1 = arc.up ? arc.from.y + shift : arc.from.y + arc.from.h + shift;
    const y2 = arc.up ? arc.to.y + shift : arc.to.y + arc.to.h + shift;
    const curve: Curve = { x1: arc.x1, y1, c1x: arc.x1, c1y: rail, c2x: arc.x2, c2y: rail, x2: arc.x2, y2 };
    edges.push({
      edge: arc.edge,
      flow: arc.flow,
      d: pathOf(curve),
      curve,
      // The apex of that curve, worked out rather than guessed: at t = ½ a cubic sits at
      // (y1 + 3·rail + 3·rail + y2) / 8, which is where the line is flat and a label reads level.
      label: { x: (arc.x1 + arc.x2) / 2, y: (y1 + y2 + 6 * rail) / 8, w: arc.size.w, h: arc.size.h },
    });
  }

  /**
   * A wire leaves a port sideways and arrives sideways.
   *
   * Horizontal tangents at both ends, which is the node-editor idiom and not decoration: it is what
   * makes a line readable as belonging to the port it touches rather than to the one beside it. A
   * wire that runs backwards — a loop reading a later child's output — bows out further, so it reads
   * as going back rather than as a crease.
   *
   * A guard's read ends at the RULE instead of at a port, on whichever side of the label the value
   * comes from, fanned down that edge so several reads of one condition stay apart.
   */
  const labelled = new Map(edges.filter((e) => e.label !== null).map((e) => [ruleNodeId(e.edge.id), e]));
  const reads = new Map<string, number>();
  const endOf = (end: WireEnd): { x: number; y: number } | null => {
    const rule = labelled.get(end.node);
    if (rule === undefined) {
      const port = at.get(end.node)?.ports.find((p) => p.key === end.port);
      return port === undefined ? null : { x: port.x, y: port.y + shift };
    }
    const box = rule.label!;
    const index = Number(end.port.slice("in:".length));
    const total = (reads.get(end.node) ?? 0) + 1;
    reads.set(end.node, Math.max(total, index + 1));
    return { x: box.x - box.w / 2, y: box.y - box.h / 2 + (index + 0.5) * LABEL_LINE };
  };

  const wires: PlacedWire[] = [];
  for (const wire of graph.wires) {
    const from = endOf(wire.from);
    const to = endOf(wire.to);
    if (from === null || to === null) continue;
    const back = to.x < from.x;
    const bow = back ? Math.max(90, (from.x - to.x) / 2) : Math.max(36, (to.x - from.x) * 0.45);
    const curve: Curve = {
      x1: from.x,
      y1: from.y,
      c1x: from.x + bow,
      c1y: from.y,
      c2x: to.x - bow,
      c2y: to.y,
      x2: to.x,
      y2: to.y,
    };
    wires.push({ wire, d: pathOf(curve), curve });
  }

  // A label is centred on its arc and is wider than the point it sits on, so the last box's column
  // is not necessarily the right-hand edge of the drawing.
  const width = Math.max(
    colX(columns - 1) + NODE_W + MARGIN,
    ...edges.map((e) => (e.label === null ? 0 : e.label.x + e.label.w / 2 + MARGIN)),
  );
  return {
    nodes: placed.map((b) => ({
      ...b,
      y: b.y + shift,
      ports: b.ports.map((p) => ({ ...p, y: p.y + shift })),
    })),
    edges,
    wires,
    width,
    height: maxY - minY + MARGIN * 2,
  };
}
