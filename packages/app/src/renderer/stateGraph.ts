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
 *  - **geometry** — WHAT KIND of movement. A line between two PORTS is a value moving. An arc
 *    between two BOX EDGES, with an arrowhead, is the cursor moving. Nothing else may be a line.
 *    A value's line is a curve when it has only the box next door to reach and is ROUTED when it has
 *    further to go — out of the port, along a channel under the boxes, and up beside the box it is
 *    going to. See {@link routes}: that is what keeps every line off every box.
 *  - **hue** — WHICH ONE, and only while it is asked. A control edge takes the colour of its
 *    DIRECTION and keeps it: grey for the sequence, {@link EdgeFlow} for the rest — there are three
 *    of those and they are the same three in every state, so they can be learned. A data wire is
 *    GREY until it is pointed at, and then takes the colour of the value it carries — one hue per
 *    source port, the same wherever that value goes. A state moves twenty values and no reader can
 *    hold twenty hues, so spending colour on all of them at once spends it on nothing; spending it
 *    on the one being asked about is what makes a bundle of wires followable. Hue never
 *    distinguishes data from control; geometry does.
 *  - **dash** — HOW IT IS WRITTEN. Solid is the plain case (a bare binding, a rule on the mount).
 *    Dashed is "one of several" (a read inside an expression, a rule that belongs to no child).
 *    Dotted is "not written at all" (the implicit fill, a guard's read, a step that does not wait).
 *  - **weight, opacity, depth, and a wire's hue** — ATTENTION, and nothing else. See
 *    {@link focusOf}.
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
   * wherever it turns up — and worn only while that value is the one being asked about. See the
   * vocabulary above for why colour on dataflow is rationed rather than spent.
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
  /**
   * The conversation this box's call joins, or `null` when it starts one nobody else can reach.
   *
   * On the BOX rather than only in {@link GraphSession}, because a session of one is still a fact
   * about the box — that its transcript survives the loop it sits in, and that it is scoped where it
   * is scoped — and it is a fact nothing else on the drawing says.
   */
  session: NodeSession | null;
}

/** One box's answer to "which conversation does this run in". */
export interface NodeSession {
  /** The key two boxes must share to be in one conversation: the name AND the scope it lives in. */
  id: string;
  name: string;
  scope: string;
  /** Which document said so — this file, or the state being mounted. */
  from: "here" | "mount" | "child";
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
 *
 * Blue onward, red back, amber for an ending that is not success — the palette's accent, bad and
 * warning hues, which is to say each of the three already means what it is being asked to mean
 * everywhere else in the app. See `--go-*` in the stylesheet.
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

/**
 * A conversation two or more of these boxes share, and the boxes that share it.
 *
 * A session is the one thing about a state that is both load-bearing and completely invisible: two
 * children in one conversation see each other's turns, and two children in separate ones do not,
 * and nothing on a form or in a drawing has ever said which. It is also the thing that is easiest to
 * get subtly wrong — see {@link sessionKeyOf} for why a bare name on two siblings does NOT join
 * them, which is a mistake no error will ever report.
 *
 * Drawn only when at least two boxes are in it. One box in a session is a fact about that box and
 * belongs on the box, which is where the chip puts it; a container round a single thing draws a
 * boundary where there is no boundary to draw.
 */
export interface GraphSession {
  id: string;
  /** The name as authored — what an author greps for. */
  name: string;
  /** Where that name lives, in words: what makes two identical names two different conversations. */
  scope: string;
  /** The boxes in it, in run order. */
  members: string[];
}

export interface StateGraph {
  nodes: GraphNode[];
  /** Control flow: where the cursor goes. */
  edges: GraphEdge[];
  /** Dataflow: what moves, and where from. */
  wires: GraphWire[];
  /** The conversations more than one box shares. */
  sessions: GraphSession[];
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

  const add = (node: Omit<GraphNode, "ports" | "session"> & { session?: NodeSession | null }): Building => {
    const box: Building = { session: null, ...node, ports: new Map() };
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

  /**
   * What this file says about conversations, before any child is looked at.
   *
   * `environment.session` is the layer every child inherits when it declares none of its own, and it
   * is also what a child's `join: "parent"` takes verbatim — so it is resolved once, here, and both
   * questions are answered from it.
   */
  const environment = asRecord(state["environment"]);
  const inherited = "session" in environment ? environment["session"] : undefined;
  const inheritedKey =
    inherited === undefined ? null : sessionKeyOf(inherited, "here", "");

  /**
   * Which conversation one box's call joins.
   *
   * Nearest layer wins (§5.2): the mounted state's own word beats the mount's, which beats this
   * file's default. `null` is a word — the explicit fresh marker — so presence is tested rather than
   * nullishness, which would let an explicit `null` fall through to the very default it refuses.
   */
  const sessionFor = (mountKey: string, mount: Record<string, unknown>, own: unknown, hasOwn: boolean): NodeSession | null => {
    const mountEnv = asRecord(mount["environment"]);
    const layer: { declared: unknown; from: NodeSession["from"] } | undefined = hasOwn
      ? { declared: own, from: "child" }
      : "session" in mountEnv
        ? { declared: mountEnv["session"], from: "mount" }
        : inherited !== undefined
          ? { declared: inherited, from: "here" }
          : undefined;
    if (layer === undefined) return null;
    // `join` names another declaration and takes its name and scope whole. The only ancestry this
    // file can see is itself, so `join: "parent"` from a child is exactly what this state declares
    // — and every other join names something outside the file and is left unresolved.
    const join = asRecord(layer.declared)["join"];
    if (typeof join === "string") {
      return join === "parent" && layer.from === "child" && inheritedKey !== null
        ? { ...inheritedKey, from: "here" }
        : null;
    }
    const key = sessionKeyOf(layer.declared, layer.from === "child" ? "child" : "here", mountKey);
    return key === null ? null : { ...key, from: layer.from };
  };

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
      // Its own `session`, else this file's default — the same nearest-wins ladder a child walks,
      // with the middle rung missing because an operation has no mount.
      session: sessionFor("", {}, block["session"], "session" in block),
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
    const slots = declared[childStateIdOf(stateId, key, ref)];
    add({
      id: childNodeId(key),
      kind: "child",
      title: key,
      session: sessionFor(key, decl, slots?.session?.declared, slots?.session !== undefined),
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
  /**
   * The conversations more than one box is in, in the order the run reaches them.
   *
   * Two and not one: a box's own session is already on the box, and a container drawn round a single
   * thing draws a boundary that is not there. What a container says that a chip cannot is that these
   * boxes can see each other's turns — which is a statement about a SET.
   */
  const shared = new Map<string, GraphSession>();
  for (const node of nodes) {
    if (node.session === null) continue;
    const found = shared.get(node.session.id);
    if (found === undefined) {
      shared.set(node.session.id, { ...node.session, members: [node.id] });
    } else found.members.push(node.id);
  }
  const sessions = [...shared.values()].filter((one) => one.members.length > 1);
  return { nodes, edges, wires, sessions, limits: stated };
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


// --- conversations -------------------------------------------------------------

/**
 * Which conversation a declaration names — the PAIR, which is the whole of the difficulty.
 *
 * A session is `(name, scope)`, and `in` names the scope relative to WHOEVER WROTE the declaration:
 * absent means the writer itself, `"parent"` means the writer's parent, `"global"` the run root, and
 * anything else an ancestor by id. So the same four characters mean different conversations
 * depending on which file they are in, and — the trap this is mostly here for — two siblings that
 * each write a bare `session: "review"` scope that name to THEMSELVES and do not share a word.
 * Sharing is spelled by naming a common scope, and the commonest spelling of that is
 * `{ "name": "review", "in": "parent" }` in each child, whose parent is the state drawn here.
 *
 * `writer` is which document the declaration was found in, which is what `in` is relative to:
 *
 *  - `child` — the mounted state's own file. `parent` then means THIS state, which is why a child
 *    saying `in: "parent"` is groupable at all.
 *  - `here` / `mount` — this file, either the state's own `environment` or one mount's. The writer
 *    is this state, so a bare name scopes HERE and every child inheriting it is in one conversation.
 *
 * `null` is a declaration and not an absence — "a fresh stream, private to this call" — so it
 * resolves to nothing groupable, deliberately. So do `{ id }` and `{ expr }`, which name a position
 * arrived at through data flow: what they resolve to is a fact about a RUN, and this is a drawing of
 * a document.
 */
function sessionKeyOf(
  declared: unknown,
  writer: "child" | "mount" | "here",
  mountKey: string,
): { id: string; name: string; scope: string } | null {
  const name = typeof declared === "string" ? declared : undefined;
  const record = asRecord(declared);
  // `join` takes another declaration's name AND its scope verbatim: the joiner does not know the
  // name and must not have to. `join: "parent"` from a child is therefore whatever THIS state
  // declares — which the caller has already resolved and passes back in as `here`.
  const named = name ?? (typeof record["name"] === "string" ? record["name"] : undefined);
  if (named === undefined || named.length === 0) return null;
  const scope = typeof record["in"] === "string" ? record["in"] : undefined;
  const mine = writer === "child" ? `the child ${mountKey}` : "this state";
  if (scope === undefined) {
    // The writer itself. Written in this file that is this state — so every child inheriting it is
    // in one conversation. Written in the CHILD's file it is that child, and a sibling writing the
    // same name is somewhere else entirely; keyed per MOUNT, since two mounts of one state are two
    // instances and two conversations.
    return writer === "child"
      ? { id: `${named}@child:${mountKey}`, name: named, scope: `in ${mine}` }
      : { id: `${named}@here`, name: named, scope: "in this state" };
  }
  if (scope === "parent") {
    return writer === "child"
      ? { id: `${named}@here`, name: named, scope: "in this state" }
      : { id: `${named}@up`, name: named, scope: "in whatever mounts this state" };
  }
  if (scope === "global") return { id: `${named}@global`, name: named, scope: "in the run" };
  // An ancestor by id. Which one is outside this file, but the pair is still the key: two boxes
  // naming the same name in the same ancestor are in the same conversation wherever it turns out
  // to be. `document` is refused by the loader and so names nothing here either.
  if (scope === "document") return null;
  return { id: `${named}@id:${scope}`, name: named, scope: `in ${scope}` };
}

// --- attention -----------------------------------------------------------------

/** What the pointer is on. Each of these is something a reader can ask a question about. */
export type Focus =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "port"; node: string; port: string }
  | { kind: "wire"; id: string }
  | { kind: "session"; id: string };

/** Everything the drawing can raise or fade, under one naming scheme. */
export const idOf = {
  node: (id: string): string => `node:${id}`,
  edge: (id: string): string => `edge:${id}`,
  wire: (id: string): string => `wire:${id}`,
  port: (node: string, port: string): string => `port:${node}:${port}`,
  session: (id: string): string => `session:${id}`,
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
 *  - a SESSION — itself, the boxes in it, and the lines that run BETWEEN them, which are the only
 *    lines the conversation itself explains. A line to somewhere outside is a line about something
 *    else, so its far end is merely kept legible.
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
  } else if (focus.kind === "session") {
    const session = graph.sessions.find((one) => one.id === focus.id);
    if (session !== undefined) {
      const inside = new Set(session.members);
      lit.add(idOf.session(session.id));
      for (const member of session.members) lit.add(idOf.node(member));
      for (const edge of graph.edges) {
        if (inside.has(edge.from) && inside.has(edge.to)) lit.add(idOf.edge(edge.id));
        else if (inside.has(edge.from) || inside.has(edge.to)) {
          near.add(idOf.edge(edge.id));
          near.add(idOf.node(inside.has(edge.from) ? edge.to : edge.from));
        }
      }
      for (const wire of graph.wires) {
        if (inside.has(wire.from.node) && inside.has(wire.to.node)) lit.add(idOf.wire(wire.id));
      }
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
 * How far an arc runs STRAIGHT out of a box before it starts to bend, and straight back in.
 *
 * An arrowhead is drawn along the line's direction at the point it ends, and on a bare cubic that
 * direction is the tangent — which for these is exactly vertical, while the last visible stretch of
 * the curve is still coming in at an angle. The head then reads as sitting beside its line rather
 * than on the end of it. A short straight run at each end makes the two the same thing: the line
 * arrives vertically because it IS vertical there, over ground the columns already keep clear.
 */
const ARC_STUB = 12;

/*
 * How a value's line is routed once it has further to go than the box next door.
 *
 * A wire between neighbours is a short hop over empty ground and stays the curve it always was. A
 * wire that reaches PAST the box beside it is a different thing entirely: drawn straight it crosses
 * every box in between, through the exact rows their ports are on, and that is the point at which a
 * state with eight values in it stops being readable. Those are routed instead — out of the port,
 * down into a CHANNEL under the boxes, along it, and back up in the gutter beside the box it is
 * going to. Every straight run is then over ground nothing else occupies, so the only crossings left
 * in the drawing are between one routed wire and another.
 */
/** How far past a port a wire runs before it turns — enough to read as leaving that port. */
const STUB = 22;
/** Between two routed wires running down the same gutter: what keeps them from being one line. */
const TRUNK_STEP = 9;
/** How far short of a box a wire leaves its channel to come into one of that box's ports. */
const BRANCH_INSET = 16;
/**
 * One channel of the band the routed wires run along, and the clear air above and below the band.
 *
 * Tight, because the band is HEIGHT the drawing did not need before and a state that will not fit
 * the pane is zoomed until its type is a smudge. A wire is under two pixels wide and its neighbours
 * in the band are parallel to it, so a channel needs to be a legible gap and nothing more.
 */
const CHANNEL_H = 11;
const BAND_GAP = 14;
/** How tightly a routed wire turns its corners. */
const TURN = 9;

/*
 * A session's frame: what it costs to draw a conversation as a place.
 *
 * Its members are stacked rather than laid along the run, so the frame is ONE column and the run
 * leaves it and comes back — which is what a shared conversation actually looks like and what makes
 * this drawing stop being a straight line. Everything here is the room that costs.
 */
/** The caption above the first member, and the air around the stack. */
const GROUP_HEAD = 20;
const GROUP_PAD = 10;
/**
 * The clear column inside the frame, on each side of its members.
 *
 * The thing that makes stacking survivable. A framed box may have a sibling directly above it, so a
 * line leaving through its top would go through that sibling; it steps sideways into this column
 * first and travels up THERE. It is also where a routed value branches in — the same gutter it would
 * have used, moved inside the frame.
 */
const GROUP_INSET = 34;
/** Between two members of one session: room for a line to get out sideways between them. */
const GROUP_GAP = 34;

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

/** The `d` of a run of joined curves: one `M`, then a `C` each, so the run draws as one stroke. */
export function pathOfAll(curves: Curve[]): string {
  const first = curves[0];
  if (first === undefined) return "";
  const rest = curves.map((c) => `C ${c.c1x} ${c.c1y}, ${c.c2x} ${c.c2y}, ${c.x2} ${c.y2}`).join(" ");
  return `M ${first.x1} ${first.y1} ${rest}`;
}

/**
 * `n + 1` points spread along a run of curves, by LENGTH rather than by segment.
 *
 * A routed wire is a 9px corner beside a 600px channel run, so spreading the samples evenly over the
 * segments would put five points on the corner and five on the run — and the one question this is
 * asked ("where does this line leave the pane") would be answered a hundred pixels out. Chord length
 * is close enough to arc length for a run this straight, and it is the measure that has to be cheap.
 */
export function samples(curves: Curve[], n: number): { x: number; y: number }[] {
  if (curves.length === 0) return [];
  const lengths = curves.map((c) => Math.hypot(c.x2 - c.x1, c.y2 - c.y1) || 1);
  const total = lengths.reduce((sum, one) => sum + one, 0);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    let want = (i / n) * total;
    let which = 0;
    while (which < lengths.length - 1 && want > lengths[which]!) {
      want -= lengths[which]!;
      which++;
    }
    points.push(pointOn(curves[which]!, Math.min(1, want / lengths[which]!)));
  }
  return points;
}

/** A straight run, as the cubic every line here is: its control points on its own ends. */
function straight(a: { x: number; y: number }, b: { x: number; y: number }): Curve {
  return { x1: a.x, y1: a.y, c1x: a.x, c1y: a.y, c2x: b.x, c2y: b.y, x2: b.x, y2: b.y };
}

/** `by` px from `from` toward `to`, or all the way there when the run is shorter than that. */
function toward(from: { x: number; y: number }, to: { x: number; y: number }, by: number): { x: number; y: number } {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const k = Math.min(1, by / (len === 0 ? 1 : len));
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/**
 * A polyline with its corners rounded off, as a run of curves.
 *
 * The corner IS both control points, which is what makes the turn read as a turn: the curve leaves
 * along the run coming in and arrives along the run going out, so nothing kinks. A radius never eats
 * more than half of the run it is taken out of, so two corners close together stay two corners.
 */
function roundedPath(points: { x: number; y: number }[], radius: number): Curve[] {
  const pts = points.filter(
    (p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) > 0.01,
  );
  if (pts.length < 2) return [];
  const curves: Curve[] = [];
  let from = pts[0]!;
  for (let i = 1; i + 1 < pts.length; i++) {
    const corner = pts[i]!;
    const next = pts[i + 1]!;
    const back = toward(corner, from, Math.min(radius, Math.hypot(corner.x - from.x, corner.y - from.y) / 2));
    const on = toward(corner, next, Math.min(radius, Math.hypot(next.x - corner.x, next.y - corner.y) / 2));
    if (Math.hypot(back.x - from.x, back.y - from.y) > 0.01) curves.push(straight(from, back));
    curves.push({ x1: back.x, y1: back.y, c1x: corner.x, c1y: corner.y, c2x: corner.x, c2y: corner.y, x2: on.x, y2: on.y });
    from = on;
  }
  curves.push(straight(from, pts[pts.length - 1]!));
  return curves;
}

export interface PlacedEdge {
  edge: GraphEdge;
  /** The SVG path. Straight for a step of the sequence, an arc over or under everything otherwise. */
  d: string;
  /** The line as a run of joined curves: one for a step, a straight-bend-straight three for an arc. */
  curves: Curve[];
  /** Which way it takes the run — its hue. See {@link EdgeFlow}. */
  flow: EdgeFlow;
  /** Where the guard is written, and how much room it needs. `null` for a step of the sequence. */
  label: { x: number; y: number; w: number; h: number } | null;
}

export interface PlacedWire {
  wire: GraphWire;
  d: string;
  /** The line as a run of joined curves — one for a short hop, six for a routed one. */
  curves: Curve[];
  /**
   * The bundle this line belongs to, or `null` when it is drawn on its own.
   *
   * Every wire out of one source port shares its route until the last moment, so the DRAWING holds
   * one line where the document holds four reads of one value. They are still four wires — each has
   * its own binding and its own far end — and what they share is only geometry, which is why this is
   * here: the part they have in common cannot answer for one of them, so pointing at it asks about
   * the PORT, and the port's answer is the whole bundle.
   */
  bundle: string | null;
}

/** One session's frame, drawn behind its members. */
export interface PlacedSession {
  session: GraphSession;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  wires: PlacedWire[];
  /** The conversations, as the regions holding the boxes that are in them. */
  frames: PlacedSession[];
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
    (node.session !== null ? ROW_H : 0) +
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
 * Every wire out of one source port, as one line with somewhere to run.
 *
 * Two facts about a value, and one shape that says both: it comes from ONE place, and it is read in
 * several. Drawn as one line per read, a value read four times is four lines that leave the same dot
 * and stay side by side for most of their length — four times the ink for one fact, and four things
 * to follow where there is one. Drawn as a bundle it is one line that splits where the answers
 * actually differ, which is beside the box each read happens in.
 */
interface Bundle {
  key: string;
  from: WireEnd;
  wires: GraphWire[];
  /** Where it turns out of the gutter beside its source box. */
  stubX: number;
  /** Which channel of the band under the boxes it runs along. */
  channel: number;
  /** Wire id ⇒ the x it leaves the channel at, which is the gutter beside the box it arrives in. */
  branches: Map<string, number>;
}

interface Routing {
  /** How many channels the band has to hold. Zero when nothing needs routing at all. */
  channels: number;
  /** Wire id ⇒ its bundle. A wire that is not here is a short hop and is drawn as its own curve. */
  of: Map<string, Bundle>;
}

/**
 * Decide which wires are routed, where they run, and how many channels that takes.
 *
 * Over COLUMNS and x alone, and that is what makes it usable: the band's height decides where the
 * lane below the spine starts, so this has to be answerable before a single box has a y.
 *
 * Two rules, and nothing else:
 *
 *  - a bundle whose every read is in the box NEXT DOOR is left alone. Nothing is in the way, and
 *    three corners spent on a hop that needs none is worse than the hop.
 *  - a value read both further on and further back is two bundles, because one line cannot travel
 *    in two directions and pretending otherwise would draw a line through its own source.
 */
function routes(graph: StateGraph, colOf: Map<string, number>, boxX: (id: string) => number): Routing {
  /** A port's row on its own side of its box: the order two lines out of one box are fanned in. */
  const rowOf = new Map<string, number>();
  for (const node of graph.nodes) {
    let ins = 0;
    let outs = 0;
    for (const port of node.ports) rowOf.set(`${node.id}/${port.key}`, port.side === "in" ? ins++ : outs++);
  }
  const row = (node: string, port: string): number => rowOf.get(`${node}/${port}`) ?? 0;

  const groups = new Map<string, GraphWire[]>();
  for (const wire of graph.wires) {
    const from = colOf.get(wire.from.node);
    const to = colOf.get(wire.to.node);
    // A rule is not a box, and it still has a column — see where `colOf` is built. Anything with no
    // column at all is something this cannot route, and it stays the curve it was.
    if (from === undefined || to === undefined) continue;
    const key = `${wire.from.node}/${wire.from.port}|${to > from ? "on" : "back"}`;
    const found = groups.get(key);
    if (found === undefined) groups.set(key, [wire]);
    else found.push(wire);
  }

  const bundles: Bundle[] = [];
  for (const [key, list] of groups) {
    const from = colOf.get(list[0]!.from.node)!;
    if (list.every((w) => colOf.get(w.to.node) === from + 1)) continue;
    bundles.push({ key, from: list[0]!.from, wires: list, stubX: 0, channel: 0, branches: new Map() });
  }

  // Fanned on the way out, in the order the ports are stacked: two bundles sharing a gutter x would
  // share a vertical run, which is the one thing routing them was for.
  const leaving = new Map<string, Bundle[]>();
  for (const bundle of bundles) {
    const found = leaving.get(bundle.from.node);
    if (found === undefined) leaving.set(bundle.from.node, [bundle]);
    else found.push(bundle);
  }
  for (const [node, list] of leaving) {
    list.sort((a, b) => row(node, a.from.port) - row(node, b.from.port) || a.key.localeCompare(b.key));
    list.forEach((bundle, i) => {
      // Never past the gutter either, for the same reason the branches are held inside it.
      bundle.stubX = boxX(node) + NODE_W + Math.min(COL_GAP - 10, STUB + i * TRUNK_STEP);
    });
  }

  // And fanned on the way in, by the row each is going to — so the branch for the topmost port turns
  // up nearest the box and the rest stack out behind it, without ever leaving the gutter.
  const arriving = new Map<string, { bundle: Bundle; wire: GraphWire }[]>();
  for (const bundle of bundles) {
    for (const wire of bundle.wires) {
      const found = arriving.get(wire.to.node);
      if (found === undefined) arriving.set(wire.to.node, [{ bundle, wire }]);
      else found.push({ bundle, wire });
    }
  }
  for (const [node, list] of arriving) {
    list.sort((a, b) => row(node, a.wire.to.port) - row(node, b.wire.to.port) || a.wire.id.localeCompare(b.wire.id));
    list.forEach((one, i) => {
      // Never further out than the gutter is wide: past that a branch would turn up under the box to
      // the LEFT, which is the crossing this whole arrangement exists to avoid.
      const back = Math.min(COL_GAP - 10, BRANCH_INSET + i * TRUNK_STEP);
      one.bundle.branches.set(one.wire.id, boxX(node) - back);
    });
  }

  /** How far along the band a bundle reaches: its own gutter, and the gutter of its furthest read. */
  const spanOf = (bundle: Bundle): { lo: number; hi: number } => {
    const xs = [bundle.stubX, ...bundle.branches.values()];
    return { lo: Math.min(...xs), hi: Math.max(...xs) };
  };
  // Shortest first, into the lowest channel it fits — the same packing the arcs use, for the same
  // reason: a short run stays near the boxes and the long one that crosses the state rides under it.
  const lanes: { lo: number; hi: number }[][] = [];
  const packed = [...bundles].sort((a, b) => {
    const one = spanOf(a);
    const two = spanOf(b);
    return one.hi - one.lo - (two.hi - two.lo) || a.key.localeCompare(b.key);
  });
  for (const bundle of packed) {
    const span = spanOf(bundle);
    let lane = 0;
    while ((lanes[lane] ?? []).some((o) => o.lo < span.hi && span.lo < o.hi)) lane++;
    (lanes[lane] ??= []).push(span);
    bundle.channel = lane;
  }

  const of = new Map<string, Bundle>();
  for (const bundle of bundles) for (const wire of bundle.wires) of.set(wire.id, bundle);
  return { channels: lanes.length, of };
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
  /**
   * Where in the RUN each box sits, which is no longer where in the drawing it sits.
   *
   * The two used to be one number: a column WAS a run position, so "does this rule go forward" could
   * be read straight off the x axis. A session's frame breaks that — its members are stacked in one
   * column however far apart in the sequence they are — so the question goes back to the list that
   * always answered it. Columns are still ordered BY run order; they are no longer numbered by it.
   */
  const runAt = new Map(order.map((node, i) => [node.id, i]));

  // --- the columns ----------------------------------------------------------
  /**
   * One column per box, except that one session is one column.
   *
   * Its members stack top to bottom in run order, and the run leaves the frame and comes back to it
   * — which is the shape a shared conversation actually has, and the reason this drawing stops being
   * a straight line. A frame goes where the run FIRST reaches it, so left to right is still the
   * order in which things start happening.
   */
  type Column = { nodes: GraphNode[]; session: GraphSession | null };
  const sessionOf = new Map<string, GraphSession>();
  for (const one of graph.sessions) for (const member of one.members) sessionOf.set(member, one);
  const columns: Column[] = [];
  const drawn = new Set<string>();
  for (const node of order) {
    const session = sessionOf.get(node.id);
    if (session === undefined) {
      columns.push({ nodes: [node], session: null });
      continue;
    }
    if (drawn.has(session.id)) continue;
    drawn.add(session.id);
    columns.push({ nodes: order.filter((n) => session.members.includes(n.id)), session });
  }
  /** A framed column is wider than its members by the two clear columns their lines get out through. */
  const columnW = (column: Column | undefined): number =>
    column === undefined || column.session === null ? NODE_W : NODE_W + GROUP_INSET * 2;
  const columnX: number[] = [];
  let running = MARGIN;
  for (const column of columns) {
    columnX.push(running);
    running += columnW(column) + COL_GAP;
  }
  /** Which column a box is in, and where inside its frame — the two facts its lines are routed by. */
  const seat = new Map<string, { column: number; index: number; count: number; framed: boolean }>();
  columns.forEach((column, i) => {
    column.nodes.forEach((node, index) => {
      seat.set(node.id, { column: i, index, count: column.nodes.length, framed: column.session !== null });
    });
  });
  /** A box's own left edge: inside its frame when it has one, at the column's edge when it has none. */
  const boxX = (id: string): number => {
    const where = seat.get(id);
    if (where === undefined) return MARGIN;
    return (columnX[where.column] ?? MARGIN) + (where.framed ? GROUP_INSET : 0);
  };

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
   * The band the routed wires run along, worked out before anything has a y.
   *
   * It sits between the spine and the lane under it, which is the one strip of the drawing nothing
   * else wants: the arcs ride above the top of everything and below the bottom of it, the boxes are
   * in the two lanes, and this is the gap that was already there between them. Its HEIGHT is what
   * the lane below has to be pushed down by, so it has to be known first — see {@link routes},
   * which answers in columns and needs no y from anybody.
   */
  const colOf = new Map([...seat].map(([id, where]) => [id, where.column]));
  /**
   * A rule's column: halfway along the arc it is written on.
   *
   * A guard READS values, and those reads are the same dataflow as everything else — so they want
   * the same channel and the same gutters, and the only thing standing in the way is that a rule is
   * not in a column because it is not a box. It is over one, though: its label sits at the middle of
   * its arc, so the gutter beside the box halfway along is the gutter to come up through. Near
   * enough to leave from, and — being a gutter — clear of every box in both lanes on the way.
   */
  for (const edge of graph.edges) {
    if (edge.kind === "sequence") continue;
    const from = colOf.get(edge.from);
    const to = colOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const mid = Math.round((from + to) / 2);
    colOf.set(ruleNodeId(edge.id), Math.min(columns.length - 1, Math.max(1, mid)));
  }
  const plan = routes(graph, colOf, boxX);

  /**
   * Lane 0 is TOP-aligned rather than centred, and that is what keeps the spine legible.
   *
   * Centred boxes put the sequence's own line through the middle of every box — which is exactly
   * where the ports are, so the one line that says what runs next was drawn through the densest part
   * of the drawing and lost in it. Aligned at the top, the spine runs level across the HEADINGS,
   * over ground nothing else uses, and the ports hang below it.
   *
   * A framed column obeys the same rule and pays for its own name out of its own pocket: its FIRST
   * member sits at the lane's y, level with every unframed box, and the frame is drawn ABOVE it.
   * Otherwise one session anywhere in a state would push the whole spine down by a caption.
   */
  /** How far below its lane's top a column reaches, frame and all. */
  const columnH = (column: Column): number => {
    const stack = column.nodes.reduce((sum, n) => sum + height(n.id), 0) + (column.nodes.length - 1) * GROUP_GAP;
    return column.session === null ? stack : stack + GROUP_PAD;
  };
  const spineBottom = Math.max(...columns.filter((c) => c.nodes.some((n) => onSpine.has(n.id))).map(columnH), 0);
  const bandTop = spineBottom + BAND_GAP;
  const bandH = plan.channels * CHANNEL_H;
  const belowY = spineBottom + Math.max(LANE_GAP, BAND_GAP * 2 + bandH);

  const frames: PlacedSession[] = [];
  columns.forEach((column, i) => {
    const lane = column.nodes.some((n) => onSpine.has(n.id)) ? 0 : belowY;
    const x = columnX[i] ?? MARGIN;
    let y = lane;
    for (const node of column.nodes) {
      place(node, x + (column.session === null ? 0 : GROUP_INSET), y);
      y += height(node.id) + GROUP_GAP;
    }
    if (column.session === null) return;
    // `y` has run one gap past the last member, so the stack ends a gap back.
    frames.push({
      session: column.session,
      x,
      y: lane - GROUP_PAD - GROUP_HEAD,
      w: NODE_W + GROUP_INSET * 2,
      h: y - GROUP_GAP - lane + GROUP_HEAD + GROUP_PAD * 2,
    });
  });

  const boxTop = Math.min(...placed.map((b) => b.y), ...frames.map((f) => f.y));
  const boxBottom = Math.max(...placed.map((b) => b.y + b.h), ...frames.map((f) => f.y + f.h));
  /**
   * What an arc going under the drawing has to clear.
   *
   * The boxes, the frames, and the band — which is normally between the two lanes and so already
   * above the lowest box, but is the lowest thing there is in a state with no lane below the spine.
   */
  const floor = Math.max(boxBottom, bandTop + bandH);
  const frameOf = new Map<string, PlacedSession>();
  for (const frame of frames) for (const member of frame.session.members) frameOf.set(member, frame);

  // --- the arcs -------------------------------------------------------------
  /**
   * Which side of the drawing an arc travels on.
   *
   * Both routes clear every box — one rides above the top of everything, the other below the bottom
   * — so no transition ever crosses a box, whatever the shape of the state.
   */
  type Point = { x: number; y: number };
  type Arc = {
    edge: GraphEdge;
    flow: EdgeFlow;
    up: boolean;
    from: PlacedNode;
    to: PlacedNode;
    lane: number;
    x1: number;
    x2: number;
    /** From the source box's edge to where the bend begins, and from where it ends to the target's. */
    lead: Point[];
    trail: Point[];
    /** False for a step of the sequence that could not be drawn straight: no guard, so no label. */
    labelled: boolean;
    size: { w: number; h: number };
  };
  const arcs: Arc[] = [];
  const arcOf = (edge: GraphEdge, from: PlacedNode, to: PlacedNode, labelled: boolean): void => {
    const bad = to.node.kind === "outcome" || to.node.kind === "missing";
    // On RUN ORDER rather than on x, which stopped being the same question the moment a session's
    // frame began holding members from either end of the sequence in one column.
    const ahead = (runAt.get(to.node.id) ?? 0) > (runAt.get(from.node.id) ?? 0);
    const flow: EdgeFlow = bad ? "abort" : ahead ? "onward" : "back";
    // Over the top when it is a forward jump between two boxes ON the line — a skip reads as a skip
    // when it arcs over what it skipped. Everything else goes under the bottom: a backwards jump is
    // a loop and looks like one there, and traffic to or from the lane below stays in the half of
    // the drawing those boxes are in rather than sweeping over the spine to reach them.
    const overhead = flow === "onward" && onSpine.has(from.node.id) && onSpine.has(to.node.id);
    arcs.push({
      edge,
      flow,
      up: overhead,
      from,
      to,
      lane: 0,
      x1: 0,
      x2: 0,
      lead: [],
      trail: [],
      labelled,
      size: labelled ? labelSize(edge) : { w: 0, h: 0 },
    });
  };
  for (const edge of graph.edges) {
    if (edge.kind === "sequence") continue;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    arcOf(edge, from, to, true);
  }

  /**
   * A step of the sequence, which used to be able to assume it was a horizontal line.
   *
   * It still is in the ordinary case, and that case is most of every drawing: two boxes side by side
   * at the same height, joined across the gutter at the level of their headings. A session's frame
   * is what breaks the assumption — its second member is a column further DOWN rather than a column
   * further along — so there are three more shapes, each the simplest thing that reaches the next
   * box without crossing anything:
   *
   *  - a step into or out of a frame, still to the next column along: a curve, the same one a value's
   *    line takes between neighbours.
   *  - a step INSIDE one frame, between two of its members: out the right, down the frame's own clear
   *    column, across the gap between the two, and in at the left. It never leaves the frame, which
   *    is the truth of it — the conversation does not end between those two states.
   *  - a step BACKWARDS, to a frame the run has already been in: an arc, like every other move over
   *    ground already covered, and still grey, because it is still the sequence.
   */
  type Step = { edge: GraphEdge; from: PlacedNode; to: PlacedNode; shape: "straight" | "curve" | "inside" };
  const steps: Step[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "sequence") continue;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const frame = frameOf.get(from.node.id);
    // NEXT DOOR, and that is the whole of what "straight" and "curve" are allowed to assume: a
    // frame holds members from either end of the sequence, so a step can now skip a column, and a
    // line drawn across the gap between two columns that are not next to each other goes through
    // whatever is between them.
    const beside = (seat.get(to.node.id)?.column ?? -1) === (seat.get(from.node.id)?.column ?? -1) + 1;
    if (beside && from.y === to.y) steps.push({ edge, from, to, shape: "straight" });
    else if (beside) steps.push({ edge, from, to, shape: "curve" });
    else if (to.x === from.x && frame !== undefined && frameOf.get(to.node.id) === frame) {
      steps.push({ edge, from, to, shape: "inside" });
    } else arcOf(edge, from, to, false);
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

  /**
   * How a line gets out of a session's frame when a sibling is in the way.
   *
   * An arc leaves through the top or the bottom of the box it starts at, and a framed box may have
   * another one directly above or below it — so a run that went straight up would go straight
   * through a sibling. It steps sideways first: out into the gap between the two members, across
   * into the frame's clear column, and up or down THAT, which is what the clear column is for.
   * Nothing is ever in the way there, whatever else the frame holds.
   *
   * The unobstructed case is the same shape with the sideways step missing — see {@link ARC_STUB}
   * for why there is a straight run at all.
   */
  const sideChannels = new Map<string, number>();
  const escapeOf = (arc: Arc, role: "from" | "to"): { x: number; y: number; lead: Point[] } => {
    const box = role === "from" ? arc.from : arc.to;
    const ax = anchors.get(`${arc.edge.id}:${role}`) ?? box.x + NODE_W / 2;
    const edgeY = arc.up ? box.y : box.y + box.h;
    const away = arc.up ? -ARC_STUB : ARC_STUB;
    const frame = frameOf.get(box.node.id);
    const where = seat.get(box.node.id);
    const blocked =
      frame !== undefined && where !== undefined && (arc.up ? where.index > 0 : where.index < where.count - 1);
    if (!blocked || frame === undefined) return { x: ax, y: edgeY + away, lead: [{ x: ax, y: edgeY }] };
    // The side the rest of the line is on, so the detour is a step towards where it is going.
    const other = role === "from" ? arc.to : arc.from;
    const key = `${frame.session.id}:${other.x >= box.x ? "r" : "l"}:${arc.up ? "u" : "d"}`;
    const taken = sideChannels.get(key) ?? 0;
    sideChannels.set(key, taken + 1);
    const inset = Math.min(GROUP_INSET - 6, GROUP_INSET / 2 + taken * TRUNK_STEP);
    const chX = other.x >= box.x ? frame.x + frame.w - inset : frame.x + inset;
    return {
      x: chX,
      y: arc.up ? frame.y : frame.y + frame.h,
      lead: [
        { x: ax, y: edgeY },
        { x: ax, y: edgeY + away },
        { x: chX, y: edgeY + away },
      ],
    };
  };
  for (const arc of arcs) {
    const out = escapeOf(arc, "from");
    const into = escapeOf(arc, "to");
    arc.x1 = out.x;
    arc.x2 = into.x;
    arc.lead = [...out.lead, { x: out.x, y: out.y }];
    arc.trail = [{ x: into.x, y: into.y }, ...[...into.lead].reverse()];
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
  for (const overhead of [true, false]) {
    const lanes: { lo: number; hi: number }[][] = [];
    const side = arcs.filter((a) => a.up === overhead);
    side.sort((a, b) => Math.abs(a.x2 - a.x1) - Math.abs(b.x2 - b.x1) || a.edge.id.localeCompare(b.edge.id));
    for (const arc of side) {
      const mid = (arc.x1 + arc.x2) / 2;
      const lo = Math.min(Math.min(arc.x1, arc.x2), mid - arc.size.w / 2);
      const hi = Math.max(Math.max(arc.x1, arc.x2), mid + arc.size.w / 2);
      let lane = 0;
      while ((lanes[lane] ?? []).some((s) => s.lo < hi && lo < s.hi)) lane++;
      (lanes[lane] ??= []).push({ lo, hi });
      arc.lane = lane;
      const tall = laneHeight[overhead ? "up" : "down"];
      tall[lane] = Math.max(tall[lane] ?? 0, arc.size.h);
    }
  }
  /** The rail of lane n sits past every lane below it, each as tall as its own tallest label. */
  const railOffset = (overhead: boolean, lane: number): number => {
    const tall = laneHeight[overhead ? "up" : "down"];
    let offset = ARC_GAP;
    for (let i = 0; i < lane; i++) offset += (tall[i] ?? 0) + LANE_PAD;
    return offset + (tall[lane] ?? 0) / 2;
  };
  const railY = (arc: Arc): number =>
    arc.up ? boxTop - railOffset(true, arc.lane) : floor + railOffset(false, arc.lane);

  // --- into positive coordinates -------------------------------------------
  const rails = arcs.map((arc) => ({ y: railY(arc), h: arc.size.h }));
  const minY = Math.min(boxTop, ...rails.map((r) => r.y - r.h / 2));
  const maxY = Math.max(floor, ...rails.map((r) => r.y + r.h / 2));
  const shift = MARGIN - minY;
  const down = (p: Point): Point => ({ x: p.x, y: p.y + shift });

  /** The height a step of the sequence runs at on one box: the middle of its heading. */
  const headY = (box: PlacedNode): number => box.y + PAD + BORDER + TITLE_H / 2 + shift;
  const edges: PlacedEdge[] = [];
  for (const { edge, from, to, shape } of steps) {
    const y1 = headY(from);
    const y2 = headY(to);
    if (shape === "straight") {
      // A step is straight, which is a cubic whose control points sit on its own ends.
      const line: Curve = { x1: from.x + NODE_W, y1, c1x: from.x + NODE_W, c1y: y1, c2x: to.x, c2y: y2, x2: to.x, y2 };
      edges.push({ edge, flow: "onward", d: pathOfAll([line]), curves: [line], label: null });
      continue;
    }
    if (shape === "curve") {
      const bow = Math.max(36, (to.x - (from.x + NODE_W)) * 0.55);
      const line: Curve = {
        x1: from.x + NODE_W,
        y1,
        c1x: from.x + NODE_W + bow,
        c1y: y1,
        c2x: to.x - bow,
        c2y: y2,
        x2: to.x,
        y2,
      };
      edges.push({ edge, flow: "onward", d: pathOfAll([line]), curves: [line], label: null });
      continue;
    }
    const frame = frameOf.get(from.node.id)!;
    // Halfway down the gap between the two members, whichever way round they are.
    const gap = (from.y < to.y ? from.y + from.h + to.y : to.y + to.h + from.y) / 2 + shift;
    const curves = roundedPath(
      [
        { x: from.x + NODE_W, y: y1 },
        { x: frame.x + frame.w - GROUP_INSET / 2, y: y1 },
        { x: frame.x + frame.w - GROUP_INSET / 2, y: gap },
        { x: frame.x + GROUP_INSET / 2, y: gap },
        { x: frame.x + GROUP_INSET / 2, y: y2 },
        { x: to.x, y: y2 },
      ],
      TURN,
    );
    edges.push({ edge, flow: "onward", d: pathOfAll(curves), curves, label: null });
  }
  for (const arc of arcs) {
    const rail = railY(arc) + shift;
    const lead = arc.lead.map(down);
    const trail = arc.trail.map(down);
    const start = lead[lead.length - 1]!;
    const end = trail[0]!;
    const bend: Curve = {
      x1: start.x,
      y1: start.y,
      c1x: arc.x1,
      c1y: rail,
      c2x: arc.x2,
      c2y: rail,
      x2: end.x,
      y2: end.y,
    };
    const curves = [...roundedPath(lead, TURN), bend, ...roundedPath(trail, TURN)];
    edges.push({
      edge: arc.edge,
      flow: arc.flow,
      d: pathOfAll(curves),
      curves,
      // The apex of the BEND, worked out rather than guessed: at t = ½ a cubic sits at
      // (y1 + 3·rail + 3·rail + y2) / 8, which is where the line is flat and a label reads level.
      label: arc.labelled
        ? { x: (arc.x1 + arc.x2) / 2, y: (bend.y1 + bend.y2 + 6 * rail) / 8, w: arc.size.w, h: arc.size.h }
        : null,
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
   * That is the SHORT hop, between neighbours, over ground nothing else is on. A wire with further
   * to go is routed instead — see {@link routes} for why, and for the two rules that decide which of
   * the two a given wire gets.
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
    const bundle = plan.of.get(wire.id);
    const branch = bundle?.branches.get(wire.id);
    if (bundle !== undefined && branch !== undefined) {
      // Out of the port, down to the channel, along it, up the gutter beside the box it is going to,
      // and in. Every wire of one bundle is given the SAME first three corners, so the run they have
      // in common lands on itself to the pixel and the drawing holds one line until it branches.
      const channel = bandTop + shift + (bundle.channel + 0.5) * CHANNEL_H;
      const curves = roundedPath(
        [
          { x: from.x, y: from.y },
          { x: bundle.stubX, y: from.y },
          { x: bundle.stubX, y: channel },
          { x: branch, y: channel },
          { x: branch, y: to.y },
          { x: to.x, y: to.y },
        ],
        TURN,
      );
      wires.push({ wire, d: pathOfAll(curves), curves, bundle: bundle.key });
      continue;
    }
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
    wires.push({ wire, d: pathOf(curve), curves: [curve], bundle: null });
  }

  // A label is centred on its arc and is wider than the point it sits on, so the last box's column
  // is not necessarily the right-hand edge of the drawing.
  const last = columns.length - 1;
  const width = Math.max(
    (columnX[last] ?? MARGIN) + columnW(columns[last]) + MARGIN,
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
    frames: frames.map((f) => ({ ...f, y: f.y + shift })),
    width,
    height: maxY - minY + MARGIN * 2,
  };
}
