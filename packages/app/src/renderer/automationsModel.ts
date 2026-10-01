/**
 * Settings → Tools → Automations, as data (decision 0010 §4, the rulings of 2026-09-25): the lines of a
 * layer's events workflow (`workflows/system/events.json`) and the state each runs
 * (`workflows/system/events/<name>.json`), read out of the files and written back into them. Pure —
 * the section (`automationsPane.tsx`) draws what this says and the tests read it without a DOM.
 *
 * ## The files' shape
 *
 * The root has no spine (`sequence: []`) and its own rules are the lines. A line is ONE named rule and
 * ONE async child:
 *
 *  - the rule `{ name, when: "on_event('git.push', { branch: 'main' })", to: name, inputs: { event:
 *    ".event" } }` — it hands the event in, because `.event` (what the rule's `on_event` resolved to)
 *    is readable in the rule's own `inputs` and nowhere else;
 *  - the child `name: { "async": true }`, whose state is the default `./name`: `system/events/<name>`,
 *    a state file of its own beside the root, found through the layers like any state;
 *  - that state's steps are ONE operation list — each step one call, `start_task` or `notify`, run in
 *    order (`@jaira/shared` `automations.ts` writes and reads it).
 *
 * A rule this editor does not recognise — a hand-written guard, a child wired some other way, a state
 * whose operation it cannot take apart — is kept exactly as it stands and shown as a line that is
 * edited as a workflow file.
 *
 * ## Layers
 *
 * Shared's copy is a whole file. A project's copy `$ref`s Shared's (REFERENCES.md §4.2a): its own
 * lines first, then Shared's spliced in minus any it ignores —
 * `{ "$ref": "...filter($BASE/workflows/system/events.transitions, (t) => !['push_main'].includes(t.name))" }`
 * — and its children beside Shared's (`"children": { "$ref": "$BASE/workflows/system/events.children", … }`).
 *
 * An automation's STATE resolves through the layers on its own, so a project changes a Shared line's
 * steps by writing its own `system/events/<name>.json` — a copy of that one file, for that project
 * alone — and needs no copy of the root for it. Changing a Shared line's event or filter from a project
 * is a line of the project's own: Shared's is ignored there (the splice's filter) and the project's
 * copy gets a rule of the same name.
 */
import type { JsonValue } from "@declarative-ai/json";
import {
  automationStateIdOf,
  automationStateOf,
  EVENT_NAMES,
  EVENT_SPECS,
  EVENTS_STATE_ID,
  isEventName,
  matchesGlobs,
  stepsOfAutomationState,
  type AutomationStep,
  type EventFilterKey,
  type EventName,
  type JairaEventsConfig,
  type StepValue,
  type WritableLayer,
} from "@jaira/shared/browser";
import type { ValueSourceOption } from "./schemaForm/types";

export { EVENTS_STATE_ID, automationStateIdOf, type AutomationStep, type StepValue };

/**
 * The events task among a project's tasks: the one the supervisor marks `system: "events"` — or,
 * where a summary does not carry the mark, the one titled `events` running `system/events`.
 */
export const eventsTaskOf = <T extends { title: string; workflow: string }>(tasks: readonly T[]): T | undefined =>
  tasks.find((task) => (task as { system?: unknown }).system === "events") ?? tasks.find((task) => task.title === "events" && task.workflow === EVENTS_STATE_ID);

/** Where the base layer's events workflow is named from a project's copy. */
const BASE_EVENTS = "$BASE/workflows/system/events";

// --- the model -------------------------------------------------------------------------------

export type EventFilterValue = string | string[];

export interface AutomationLine {
  name: string;
  /** The event it waits for — one of `EVENT_NAMES`, or whatever a hand-written line names. */
  event: string;
  /** `on_event`'s filter, by key. */
  filter: Partial<Record<EventFilterKey, EventFilterValue>>;
  /** Its state's operation list, one step per call. */
  steps: AutomationStep[];
  /**
   * A line this editor cannot take apart: its rule and the child it reaches, kept as they are. Drawn
   * read-only; edited as a workflow file.
   */
  raw?: { rule: Record<string, unknown>; children: Record<string, unknown> };
}

/** An automation's steps as a page reads them: through the layers, and from which. */
export interface StepsRead {
  steps?: AutomationStep[];
  /** The layer whose `system/events/<name>` answered. Absent: none has one. */
  from?: WritableLayer;
  /** That file is there but is not an operation list this editor writes. */
  unreadable?: boolean;
}

/** How a page finds a line's steps: by name, through its layers. */
export type StepsOf = (name: string) => StepsRead;

/** Steps no layer holds: a new line, before its state is written. */
export const NO_STEPS: StepsOf = () => ({});

// --- the guard ---------------------------------------------------------------------------------

const quote = (text: string): string => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** `on_event('git.push', { branch: 'main' })` — a line's guard. Keys in the order the filter spells them. */
export function whenOf(event: string, filter: AutomationLine["filter"]): string {
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)) as Array<[string, EventFilterValue]>;
  if (entries.length === 0) return `on_event(${quote(event)})`;
  const values = entries.map(([key, value]) => `${key}: ${Array.isArray(value) ? (value.length === 1 ? quote(value[0]!) : `[${value.map(quote).join(", ")}]`) : quote(value)}`);
  return `on_event(${quote(event)}, { ${values.join(", ")} })`;
}

/** A tiny reader for exactly what {@link whenOf} writes (and hand-written guards of the same form). */
class GuardReader {
  private at = 0;
  constructor(private readonly text: string) {}
  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at++;
  }
  eat(token: string): boolean {
    this.space();
    if (this.text.startsWith(token, this.at)) {
      this.at += token.length;
      return true;
    }
    return false;
  }
  peek(token: string): boolean {
    this.space();
    return this.text.startsWith(token, this.at);
  }
  string(): string | undefined {
    this.space();
    const open = this.text[this.at];
    if (open !== "'" && open !== '"') return undefined;
    let out = "";
    for (let i = this.at + 1; i < this.text.length; i++) {
      const c = this.text[i]!;
      if (c === "\\") {
        out += this.text[i + 1] ?? "";
        i++;
      } else if (c === open) {
        this.at = i + 1;
        return out;
      } else out += c;
    }
    return undefined;
  }
  key(): string | undefined {
    const quoted = this.string();
    if (quoted !== undefined) return quoted;
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.at));
    if (match === null) return undefined;
    this.at += match[0].length;
    return match[0];
  }
  done(): boolean {
    this.space();
    return this.at === this.text.length;
  }
}

/** A guard's event and filter, when it is one `on_event` call with a literal filter; else `undefined`. */
export function parseWhen(when: unknown): { event: string; filter: AutomationLine["filter"] } | undefined {
  if (typeof when !== "string") return undefined;
  const r = new GuardReader(when);
  if (!r.eat("on_event") || !r.eat("(")) return undefined;
  const event = r.string();
  if (event === undefined) return undefined;
  const filter: AutomationLine["filter"] = {};
  if (r.eat(",")) {
    if (!r.eat("{")) return undefined;
    while (!r.eat("}")) {
      const key = r.key();
      if (key === undefined || !r.eat(":")) return undefined;
      if (r.eat("[")) {
        const list: string[] = [];
        while (!r.eat("]")) {
          const item = r.string();
          if (item === undefined) return undefined;
          list.push(item);
          if (!r.peek("]") && !r.eat(",")) return undefined;
        }
        filter[key as EventFilterKey] = list;
      } else {
        const value = r.string();
        if (value === undefined) return undefined;
        filter[key as EventFilterKey] = value;
      }
      if (!r.peek("}") && !r.eat(",")) return undefined;
    }
  }
  if (!r.eat(")") || !r.done()) return undefined;
  return { event, filter };
}

// --- a document ↔ its lines ---------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The rule's `inputs`, exactly: the event and nothing else. */
const RULE_INPUTS = { event: ".event" } as const;

/** How a project's copy splices the base layer's lines in, when it does. */
export interface Splice {
  /** The base layer's lines it leaves out, by name. */
  ignored: string[];
}

export interface EventsDoc {
  /** The layer's OWN lines, in order. */
  lines: AutomationLine[];
  /** A project's copy: where it splices Shared's lines in. Absent: this document splices nothing. */
  splice?: Splice;
  /** The document `$ref`s the base layer's — a project's copy. */
  follows: boolean;
}

/** Shared's lines, minus the ones listed — the spliced `$ref` a project's copy holds. */
export function spliceRefOf(ignored: readonly string[]): { $ref: string } {
  if (ignored.length === 0) return { $ref: `...${BASE_EVENTS}.transitions` };
  return { $ref: `...filter(${BASE_EVENTS}.transitions, (t) => ![${ignored.map(quote).join(", ")}].includes(t.name))` };
}

/** What a spliced `$ref` leaves out, or `undefined` when it is not one {@link spliceRefOf} writes. */
export function ignoredOfSplice(ref: unknown): string[] | undefined {
  if (typeof ref !== "string") return undefined;
  if (ref === `...${BASE_EVENTS}.transitions`) return [];
  const prefix = `...filter(${BASE_EVENTS}.transitions, (t) => ![`;
  const suffix = "].includes(t.name))";
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return undefined;
  const list = ref.slice(prefix.length, ref.length - suffix.length);
  const r = new GuardReader(list);
  const out: string[] = [];
  while (!r.done()) {
    const name = r.string();
    if (name === undefined) return undefined;
    out.push(name);
    if (!r.done() && !r.eat(",")) return undefined;
  }
  return out;
}

/**
 * Read a layer's events workflow into its lines, each line's steps found by `stepsOf` (through the
 * page's layers). A document that is not an object reads as none.
 */
export function parseEventsDoc(doc: unknown, stepsOf: StepsOf = NO_STEPS): EventsDoc {
  const root = isRecord(doc) ? doc : {};
  const children = isRecord(root["children"]) ? root["children"] : {};
  const rules = Array.isArray(root["transitions"]) ? root["transitions"] : [];
  const lines: AutomationLine[] = [];
  let splice: Splice | undefined;
  rules.forEach((rule, index) => {
    if (isRecord(rule) && typeof rule["$ref"] === "string" && Object.keys(rule).length === 1) {
      const ignored = ignoredOfSplice(rule["$ref"]);
      if (ignored !== undefined) {
        splice = { ignored };
        return;
      }
    }
    lines.push(lineOf(rule, children, index, stepsOf));
  });
  return { lines, ...(splice !== undefined ? { splice } : {}), follows: typeof root["$ref"] === "string" };
}

/** One rule and the child it enters, as a line — or kept raw. */
function lineOf(rule: unknown, children: Record<string, unknown>, index: number, stepsOf: StepsOf): AutomationLine {
  const record = isRecord(rule) ? rule : {};
  const name = typeof record["name"] === "string" ? record["name"] : `line_${index + 1}`;
  const guard = parseWhen(record["when"]);
  const raw = (): AutomationLine => {
    const to = typeof record["to"] === "string" ? record["to"] : undefined;
    const reached = to !== undefined && children[to] !== undefined ? { [to]: children[to] } : {};
    return { name, event: guard?.event ?? "", filter: guard?.filter ?? {}, steps: [], raw: { rule: record, children: reached } };
  };
  const known = new Set(["name", "when", "to", "inputs"]);
  if (guard === undefined || typeof record["name"] !== "string" || record["to"] !== name || Object.keys(record).some((k) => !known.has(k))) return raw();
  if (JSON.stringify(record["inputs"]) !== JSON.stringify(RULE_INPUTS)) return raw();
  const mount = children[name];
  if (!isRecord(mount) || mount["async"] !== true || Object.keys(mount).length !== 1) return raw();
  const read = stepsOf(name);
  // A state file this editor cannot take apart is edited as one, and so is the line that runs it.
  if (read.unreadable === true) return raw();
  return { name, event: guard.event, filter: guard.filter, steps: read.steps ?? [] };
}

/** The rule and the child one line writes. A raw line writes what it held. */
export function writeLine(line: AutomationLine): { rule: Record<string, unknown>; children: Record<string, unknown> } {
  if (line.raw !== undefined) return { rule: line.raw.rule, children: line.raw.children };
  return {
    rule: { name: line.name, when: whenOf(line.event, line.filter), to: line.name, inputs: { ...RULE_INPUTS } },
    children: { [line.name]: { async: true } },
  };
}

/** The children a document's lines own — what rewriting the lines replaces. */
function ownedKeys(doc: EventsDoc): Set<string> {
  const keys = new Set<string>();
  for (const line of doc.lines) for (const key of Object.keys(writeLine(line).children)) keys.add(key);
  return keys;
}

/**
 * A layer's events workflow with `lines` in place of the ones it held — every other key of `previous`
 * kept, and every child not a line's own kept too. `splice` is a project's copy: it follows the base
 * layer's document and splices its lines in after its own, minus those ignored.
 */
export function writeEventsDoc(previous: unknown, lines: readonly AutomationLine[], splice?: Splice): Record<string, unknown> {
  const before = isRecord(previous) ? previous : {};
  const old = ownedKeys(parseEventsDoc(before));
  const held = isRecord(before["children"]) ? before["children"] : {};
  const children: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(held)) if (!old.has(key)) children[key] = value;
  const rules: unknown[] = [];
  for (const line of lines) {
    const written = writeLine(line);
    rules.push(written.rule);
    Object.assign(children, written.children);
  }
  if (splice !== undefined) {
    rules.push(spliceRefOf(splice.ignored));
    return {
      ...before,
      $ref: BASE_EVENTS,
      transitions: rules,
      children: { $ref: `${BASE_EVENTS}.children`, ...Object.fromEntries(Object.entries(children).filter(([key]) => key !== "$ref")) },
    };
  }
  // Shared's copy follows the built-in (`$SYSTEM`) and states its own lines: both keys always, since a
  // project's `$BASE/…events.transitions` reads this FILE's keys, not what it refers to.
  if (typeof before["$ref"] === "string") return { ...before, transitions: rules, children };
  return { ...skeleton(), ...before, sequence: [], transitions: rules, children };
}

/** The built-in events workflow, as Shared's copy names it. */
export const SYSTEM_EVENTS = "$SYSTEM/workflows/system/events";

/**
 * Shared's copy when it has none yet — made from the built-in: it follows it, and states the
 * built-in's lines as its own (a `$ref` alone is never written, as the project's copy reads Shared's
 * own `transitions` and `children`). The rule persistence's `ensureBaseEventsCopy` follows.
 */
export function sharedSeedOf(builtIn: unknown): Record<string, unknown> {
  const doc = isRecord(builtIn) ? builtIn : {};
  return {
    $ref: SYSTEM_EVENTS,
    transitions: Array.isArray(doc["transitions"]) ? doc["transitions"] : [],
    children: isRecord(doc["children"]) ? doc["children"] : {},
  };
}

/** What an events workflow is before any layer writes one: a root that only waits. */
export function skeleton(): Record<string, unknown> {
  return {
    label: "Events",
    description: "Waits for events and starts tasks. Each rule is one automation of Settings → Tools → Automations, and runs the state `system/events/<its name>`.",
    sequence: [],
    transitions: [],
    children: {},
  };
}

/** Serialize as the Files view would — two spaces, a trailing newline. */
export const eventsDocText = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

// --- an automation's state ------------------------------------------------------------------------

/**
 * A line's steps as a page reads them from the state files it has: `own`'s layer first, then the ones
 * behind it — the project's copy of `system/events/<name>`, else Shared's.
 */
export function stepsReaderOf(layers: ReadonlyArray<{ layer: WritableLayer; states: Readonly<Record<string, unknown>> }>): StepsOf {
  return (name) => {
    for (const { layer, states } of layers) {
      const doc = states[name];
      if (doc === undefined) continue;
      const steps = stepsOfAutomationState(doc);
      return steps === undefined ? { from: layer, unreadable: true } : { steps, from: layer };
    }
    return {};
  };
}

/** Two step lists say the same thing. */
export const sameSteps = (a: readonly AutomationStep[] | undefined, b: readonly AutomationStep[] | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `name`'s state file as it is written with `steps` — `previous` (that layer's file) kept where it has more. */
export const automationStateText = (name: string, steps: readonly AutomationStep[], previous?: unknown): string => eventsDocText(automationStateOf(name, steps, previous));

// --- a page's files, and what a change writes ------------------------------------------------------

/** One writable layer's files as a page read them: its events root, and its automations' states by name. */
export interface LayerFiles {
  /** Its `system/events` — absent: the layer has no copy. */
  root?: unknown;
  /** Its `system/events/<name>` files, parsed, by name. */
  states: Readonly<Record<string, unknown>>;
}

export interface Copies {
  project?: LayerFiles;
  base?: LayerFiles;
  /** What JaiRA ships: the root only (it ships no automation). */
  system?: { root?: unknown };
}

/** One file a change writes, or takes away. */
export type AutomationWrite = { layer: WritableLayer; stateId: string; text: string } | { layer: WritableLayer; stateId: string; remove: true };

/** The layers a page on `layer` reads a state through, nearest first. */
export function stateLayersOf(copies: Copies, layer: WritableLayer): Array<{ layer: WritableLayer; states: Readonly<Record<string, unknown>> }> {
  const base = { layer: "base" as const, states: copies.base?.states ?? {} };
  return layer === "project" ? [{ layer: "project", states: copies.project?.states ?? {} }, base] : [base];
}

/** What a page on `reads` lists: its own lines, Shared's (on a project page), and where each line's steps come from. */
export function automationsReadOf(copies: Copies, reads: WritableLayer): { own: EventsDoc; source: "copy" | "built in" | "none"; shared: AutomationLine[] | undefined; stepsOf: StepsOf } {
  const stepsOf = stepsReaderOf(stateLayersOf(copies, reads));
  const base = copies.base?.root;
  const system = copies.system?.root;
  const sharedDoc = base ?? system;
  // Shared's lines as THIS page runs them: on a project page, a line's steps are the project's own copy
  // of its state where there is one.
  const shared = sharedDoc !== undefined ? parseEventsDoc(sharedDoc, stepsOf).lines : [];
  if (reads === "base") {
    if (base !== undefined) return { own: parseEventsDoc(base, stepsOf), source: "copy", shared: undefined, stepsOf };
    return { own: parseEventsDoc(system ?? skeleton(), stepsOf), source: system !== undefined ? "built in" : "none", shared: undefined, stepsOf };
  }
  const project = copies.project?.root;
  if (project !== undefined) return { own: parseEventsDoc(project, stepsOf), source: "copy", shared, stepsOf };
  return { own: { lines: [], splice: { ignored: [] }, follows: true }, source: "none", shared, stepsOf };
}

/**
 * The files one change to a layer's OWN lines writes (`before` → `after`), in order:
 *
 *  1. Shared's copy made from the built-in, when a project's copy is being made and Shared has none (a
 *     project's copy `$ref`s Shared's, and a `$BASE` that is not there does not fall back);
 *  2. each line's state, `system/events/<name>` in the layer — only where the steps now differ from
 *     what the layer reads through its layers (so a project line of a Shared name, with Shared's steps,
 *     writes no copy of them);
 *  3. the layer's events root, when its rules or its ignored list changed;
 *  4. the state of each line taken out — unless Shared still has a line of that name, whose steps a
 *     project's file of that name is changing.
 *
 * `ignored` is a project's new ignore list; absent: as it stands.
 */
export function automationsWritesOf(
  copies: Copies,
  into: WritableLayer,
  before: readonly AutomationLine[],
  after: readonly AutomationLine[],
  ignored?: readonly string[],
): AutomationWrite[] {
  const out: AutomationWrite[] = [];
  const base = copies.base?.root;
  const system = copies.system?.root;
  const mine = copies[into];
  const stepsOf = stepsReaderOf(stateLayersOf(copies, into));
  const sharedNames = new Set(into === "project" && (base ?? system) !== undefined ? parseEventsDoc(base ?? system).lines.map((line) => line.name) : []);

  let root: Record<string, unknown>;
  if (into === "base") root = writeEventsDoc(base ?? sharedSeedOf(system), after);
  else {
    const held = copies.project?.root;
    const splice = { ignored: [...(ignored ?? (held !== undefined ? (parseEventsDoc(held).splice?.ignored ?? []) : []))] };
    root = writeEventsDoc(held ?? {}, after, splice);
  }
  const rootChanged = JSON.stringify(root) !== JSON.stringify(mine?.root);
  // A `$BASE` that is not there does not fall back to the built-in: Shared's copy is written first.
  if (into === "project" && rootChanged && base === undefined) out.push({ layer: "base", stateId: EVENTS_STATE_ID, text: eventsDocText(sharedSeedOf(system)) });
  for (const line of after) {
    if (line.raw !== undefined || sameSteps(stepsOf(line.name).steps, line.steps)) continue;
    out.push({ layer: into, stateId: automationStateIdOf(line.name), text: automationStateText(line.name, line.steps, mine?.states[line.name]) });
  }
  if (rootChanged) out.push({ layer: into, stateId: EVENTS_STATE_ID, text: eventsDocText(root) });
  const kept = new Set(after.map((line) => line.name));
  for (const line of before) {
    if (line.raw !== undefined || kept.has(line.name) || sharedNames.has(line.name) || mine?.states[line.name] === undefined) continue;
    out.push({ layer: into, stateId: automationStateIdOf(line.name), remove: true });
  }
  return out;
}

/**
 * A Shared line's STEPS changed from a project page: that project's own `system/events/<name>` — a
 * copy of that one file, for that project alone. Steps back to Shared's own take the copy away.
 */
export function sharedStepsWritesOf(copies: Copies, name: string, steps: readonly AutomationStep[]): AutomationWrite[] {
  const shared = stepsReaderOf(stateLayersOf(copies, "base"))(name).steps;
  const own = copies.project?.states[name];
  if (sameSteps(shared, steps)) return own !== undefined ? [{ layer: "project", stateId: automationStateIdOf(name), remove: true }] : [];
  return [{ layer: "project", stateId: automationStateIdOf(name), text: automationStateText(name, steps, own ?? copies.base?.states[name]) }];
}

// --- what a layer shows ---------------------------------------------------------------------------

/** One line as a layer's section draws it. */
export interface ShownLine {
  line: AutomationLine;
  /** Whose line it is: the layer's own, or the base layer's spliced into a project's copy. */
  from: "own" | "shared";
  /** A Shared line this project leaves out. */
  ignored: boolean;
  /** Where its steps are read from — the project's own `system/events/<name>`, or Shared's. */
  stepsFrom?: WritableLayer;
  /** An own line standing in for a Shared line of the same name, which this project ignores. */
  replaces?: boolean;
}

/**
 * What the section lists for a layer: its own lines, then — on a project page — Shared's, each marked
 * ignored or not. `shared` is the base layer's lines (its copy, or the built-in's); a project with no
 * copy of its own shows every Shared line, none ignored. `stepsOf` says where each line's steps come
 * from on this page.
 */
export function shownLinesOf(own: EventsDoc, shared: readonly AutomationLine[] | undefined, stepsOf: StepsOf = NO_STEPS): ShownLine[] {
  const ignored = new Set(own.splice?.ignored ?? []);
  const sharedNames = new Set((shared ?? []).map((line) => line.name));
  const from = (name: string): { stepsFrom?: WritableLayer } => {
    const layer = stepsOf(name).from;
    return layer !== undefined ? { stepsFrom: layer } : {};
  };
  const out: ShownLine[] = own.lines.map((line) => ({
    line,
    from: "own",
    ignored: false,
    ...from(line.name),
    ...(shared !== undefined && ignored.has(line.name) && sharedNames.has(line.name) ? { replaces: true } : {}),
  }));
  if (shared !== undefined && own.splice !== undefined) {
    for (const line of shared) out.push({ line, from: "shared", ignored: ignored.has(line.name), ...from(line.name) });
  }
  return out;
}

// --- flags --------------------------------------------------------------------------------------

/** What is said under a line. */
export type LineFlag =
  | { kind: "never"; by: string }
  | { kind: "shadowed"; by: string[] }
  | { kind: "off"; event: string }
  | { kind: "unknown"; event: string }
  | { kind: "duplicate" };

const GLOB = /[*?[\]{}]/;

const listOf = (value: EventFilterValue | undefined): string[] | undefined => (value === undefined ? undefined : typeof value === "string" ? [value] : value);

/** Every value `inner` matches, `outer` matches too — conservatively: false where it cannot tell. */
function patternCovers(outer: string, inner: string, caseless: boolean): boolean {
  if (outer === "**") return true;
  if (outer === inner) return true;
  if (!GLOB.test(inner)) return matchesGlobs(inner, outer, caseless);
  // `*` covers any one segment: `*` over `release*` is true, over `release/*` false.
  if (outer === "*" && !inner.includes("/")) return true;
  return false;
}

/** Some value both match — conservatively: true where it cannot tell. */
function patternsMeet(a: string, b: string, caseless: boolean): boolean {
  if (!GLOB.test(a)) return matchesGlobs(a, b, caseless);
  if (!GLOB.test(b)) return matchesGlobs(b, a, caseless);
  // Without `**`, a glob matches only names with as many slashes as it has: `*` never meets `release/*`.
  if (!a.includes("**") && !b.includes("**") && a.split("/").length !== b.split("/").length) return false;
  return true;
}

/** Every event `later`'s filter lets through, `earlier`'s lets through too (same event). */
export function filterCovers(earlier: AutomationLine["filter"], later: AutomationLine["filter"]): boolean {
  for (const [key, value] of Object.entries(earlier) as Array<[EventFilterKey, EventFilterValue | undefined]>) {
    const outer = listOf(value);
    if (outer === undefined || outer.length === 0) continue;
    const inner = listOf(later[key]);
    if (inner === undefined || inner.length === 0) return false;
    if (!inner.every((pattern) => outer.some((glob) => patternCovers(glob, pattern, key === "author")))) return false;
  }
  return true;
}

/** Some event lets both filters through (same event). */
export function filtersMeet(a: AutomationLine["filter"], b: AutomationLine["filter"]): boolean {
  for (const [key, value] of Object.entries(a) as Array<[EventFilterKey, EventFilterValue | undefined]>) {
    const left = listOf(value);
    const right = listOf(b[key]);
    if (left === undefined || right === undefined || left.length === 0 || right.length === 0) continue;
    if (!left.some((x) => right.some((y) => patternsMeet(x, y, key === "author")))) return false;
  }
  return true;
}

/** Whether an event is switched on for any remote (or, for JaiRA's own, at all). */
export function eventOnAnywhere(events: JairaEventsConfig, name: string): boolean {
  if (!isEventName(name)) return false;
  const setting = events[name];
  if (setting === undefined) return false;
  return setting.enabled || Object.values(setting.remotes ?? {}).some((on) => on);
}

/** The event box's `<datalist>`: every event, labelled with what it is — and when it is switched off everywhere. */
export function eventOptionsOf(events: JairaEventsConfig): { value: string; label: string }[] {
  return EVENT_NAMES.map((name) => ({ value: name, label: `${EVENT_SPECS[name].label}${eventOnAnywhere(events, name) ? "" : " · switched off"}` }));
}

/** The workflow box's `<datalist>`: every workflow a step can start, by its label where it has one. */
export function workflowOptionsOf(workflows: ReadonlyArray<{ id: string; label?: string | undefined }>): { value: string; label: string }[] {
  return workflows.map((workflow) => ({ value: workflow.id, label: workflow.label ?? workflow.id }));
}

/**
 * What to say under each line, by its position in `lines` — the lines in the order the task reads
 * them (a project's own, then Shared's that it keeps). First match wins, so a later line an earlier
 * one always catches is never reached, and one an earlier one sometimes catches is not reached then.
 */
export function lineFlagsOf(lines: readonly ShownLine[], events: JairaEventsConfig): LineFlag[][] {
  const live = lines.map((shown) => !shown.ignored && shown.line.raw === undefined);
  return lines.map((shown, i) => {
    const flags: LineFlag[] = [];
    const { line } = shown;
    if (shown.ignored) return flags;
    if (lines.some((other, j) => j < i && !other.ignored && other.line.name === line.name)) flags.push({ kind: "duplicate" });
    if (line.raw === undefined) {
      if (!isEventName(line.event)) flags.push({ kind: "unknown", event: line.event });
      else if (!eventOnAnywhere(events, line.event)) flags.push({ kind: "off", event: line.event });
    }
    if (!live[i]) return flags;
    const before = lines.filter((other, j) => j < i && live[j] && other.line.event === line.event).map((other) => other.line);
    const catcher = before.find((earlier) => filterCovers(earlier.filter, line.filter));
    if (catcher !== undefined) flags.push({ kind: "never", by: catcher.name });
    else {
      const sometimes = before.filter((earlier) => filtersMeet(earlier.filter, line.filter)).map((earlier) => earlier.name);
      if (sometimes.length > 0) flags.push({ kind: "shadowed", by: sometimes });
    }
    return flags;
  });
}

/** A flag in words. */
export function flagText(flag: LineFlag): string {
  switch (flag.kind) {
    case "never":
      return `Never reached: ${flag.by} matches every event this line would, and the first line that matches wins. Drag it above ${flag.by} to run it first.`;
    case "shadowed":
      return `Not reached when ${flag.by.join(" or ")} matches: the first line that matches wins.`;
    case "off":
      return `${flag.event} is switched off, so nothing arrives for this line.`;
    case "unknown":
      return `${flag.event.length > 0 ? flag.event : "This"} is not an event JaiRA raises.`;
    case "duplicate":
      return "Another line above has this name; names must differ.";
  }
}

// --- the event's values, for a step's inputs --------------------------------------------------------

type Schema = Record<string, unknown>;

/** The payload's fields, as picks for a step input: `payload.branch`, `payload.commits[0].message`, … */
export function eventPicksOf(name: string): ValueSourceOption[] {
  const picks: ValueSourceOption[] = [{ id: "", label: "← event", note: "the whole event — its name, payload and when it arrived" }];
  if (!isEventName(name)) return picks;
  const walk = (schema: Schema, path: string, depth: number): void => {
    const properties = schema["properties"];
    if (typeof properties !== "object" || properties === null) return;
    for (const [key, sub] of Object.entries(properties as Record<string, Schema>)) {
      const at = `${path}.${key}`;
      picks.push({ id: at, label: `← event${at.slice("payload".length)}`, ...(typeof sub["description"] === "string" ? { note: sub["description"] } : {}) });
      if (depth >= 2) continue;
      if (sub["type"] === "object") walk(sub, at, depth + 1);
      if (sub["type"] === "array" && typeof sub["items"] === "object" && sub["items"] !== null) {
        const items = sub["items"] as Schema;
        if (items["type"] === "object") {
          const first = `${at}[0]`;
          const itemProps = (items["properties"] ?? {}) as Record<string, Schema>;
          for (const [k, s] of Object.entries(itemProps)) {
            if (s["type"] === "object") continue;
            picks.push({ id: `${first}.${k}`, label: `← event${first.slice("payload".length)}.${k}`, note: `the first one's ${k}` });
          }
        }
      }
    }
  };
  walk(EVENT_SPECS[name as EventName].schema as Schema, "payload", 0);
  return picks;
}

/** A line's filter, as the schema the filter form draws — the keys this event's filter takes. */
export function filterSchemaOf(name: string): Schema {
  const keys: readonly EventFilterKey[] = isEventName(name) ? EVENT_SPECS[name].filters : [];
  const words: Record<EventFilterKey, string> = {
    branch: "Branch globs — a push's branch, a merge request's target, the branch checks ran for.",
    remote: "Remote names — origin, mirror.",
    author: "Who — a merge request's author, a push's head commit's.",
    source_branch: "The branch a merge request asks to merge.",
    target_branch: "The branch a merge request asks to merge into.",
  };
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((key) => [key, { type: "array", items: { type: "string" }, description: words[key] }])),
    additionalProperties: false,
  };
}

/** A filter as the form holds it — every key a list — and back. */
export const filterFormOf = (filter: AutomationLine["filter"]): Record<string, string[]> =>
  Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, listOf(value) ?? []]));

export function filterOfForm(form: unknown): AutomationLine["filter"] {
  const out: AutomationLine["filter"] = {};
  if (!isRecord(form)) return out;
  for (const [key, value] of Object.entries(form)) {
    const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
    if (list.length > 0) out[key as EventFilterKey] = list.length === 1 ? list[0]! : list;
  }
  return out;
}

/** A step input's value as the form holds it: the typed ones, and which picks are from the event. */
export function stepFormOf(step: Extract<AutomationStep, { kind: "start" }>): { values: Record<string, JsonValue>; picked: Record<string, string> } {
  const values: Record<string, JsonValue> = {};
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.inputs)) {
    if ("literal" in value) values[key] = value.literal;
    else picked[key] = value.event;
  }
  return { values, picked };
}

/** A start with its inputs as the form holds them — its workflow, title and how it starts kept. */
export function stepOfForm(step: Extract<AutomationStep, { kind: "start" }>, values: Record<string, unknown>, picked: Record<string, string>): Extract<AutomationStep, { kind: "start" }> {
  const inputs: Record<string, StepValue> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined && picked[key] === undefined) inputs[key] = { literal: value as JsonValue };
  for (const [key, id] of Object.entries(picked)) inputs[key] = { event: id };
  return { ...step, inputs };
}

/** "issue ← event.commits[0].message · branch ← event.branch" — a step's inputs in one line. */
export function stepSummary(step: AutomationStep): string {
  if (step.kind === "notify") return `“${step.text}”`;
  const parts = Object.entries(step.inputs).map(([key, value]) =>
    "literal" in value ? `${key} = ${JSON.stringify(value.literal)}` : `${key} ← event${value.event.length > 0 ? value.event.slice("payload".length) : ""}`,
  );
  return `${parts.length > 0 ? parts.join(" · ") : "no inputs"}${step.topLevel === true ? " · on its own" : ""}`;
}

/** A name for a new line that no line has: `automation_1`, `automation_2`, … */
export function freshLineName(taken: Iterable<string>): string {
  const names = new Set(taken);
  for (let i = 1; ; i++) if (!names.has(`automation_${i}`)) return `automation_${i}`;
}

/** Whether a name can be a line's (and so a child's key and a transition's name). */
export const lineNameProblem = (name: string, others: Iterable<string>): string | undefined => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "A name is letters, digits and underscores, not starting with a digit.";
  for (const other of others) if (other === name) return "Another line has this name.";
  return undefined;
};

/** Why a set of lines cannot be written yet — the first problem, in words — or `undefined`. */
export function linesProblem(lines: readonly AutomationLine[]): string | undefined {
  const seen: string[] = [];
  for (const line of lines) {
    if (line.raw !== undefined) {
      seen.push(line.name);
      continue;
    }
    const named = lineNameProblem(line.name, seen);
    if (named !== undefined) return `${line.name.length > 0 ? line.name : "A line"}: ${named}`;
    seen.push(line.name);
    if (line.event.length === 0) return `${line.name}: pick the event it waits for.`;
    if (line.steps.length === 0) return `${line.name}: give it a step.`;
    const blank = line.steps.findIndex((step) => (step.kind === "start" ? step.workflow.trim().length === 0 : step.text.trim().length === 0));
    if (blank >= 0) return `${line.name}: step ${blank + 1} ${line.steps[blank]!.kind === "start" ? "needs the workflow it starts" : "needs what it tells you"}.`;
  }
  return undefined;
}

/**
 * A change made to one list of lines (`before` → `after`), made again to another (`onto`) — what a
 * change on the personal layer, which holds no workflow file, becomes once the person says which
 * layer it goes to. Lines are matched by name: one added or changed is set in `onto` (in place, or at
 * the end), one taken out is taken out, and `onto`'s other lines are left as they are.
 */
export function rebaseLines(before: readonly AutomationLine[], after: readonly AutomationLine[], onto: readonly AutomationLine[]): AutomationLine[] {
  const was = new Map(before.map((line) => [line.name, JSON.stringify(line)]));
  const now = new Set(after.map((line) => line.name));
  let out = onto.filter((line) => now.has(line.name) || !was.has(line.name));
  for (const line of after) {
    if (was.get(line.name) === JSON.stringify(line)) continue;
    const at = out.findIndex((other) => other.name === line.name);
    if (at >= 0) out = [...out.slice(0, at), line, ...out.slice(at + 1)];
    else out = [...out, line];
  }
  return out;
}

/** Move one element of a list from `from` to before `to` (the drag's drop). */
export function moveLine<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...list];
  next.splice(to > from ? to - 1 : to, 0, moved);
  return next;
}

/** What a line's grip puts on the drag: its index among the layer's own lines, as text. */
export const LINE_DRAG = "application/x-jaira-automation";

/**
 * A line dropped on the row at `to`: the lines reordered, or `undefined` for a drop that moves nothing.
 * `from` is what the drag carried, as it came off the transfer — the pane's and its universal copy's
 * drop both read it here.
 */
export function lineDropOf<T>(list: readonly T[], from: string, to: number): T[] | undefined {
  const at = Number(from);
  if (!Number.isInteger(at) || at === to) return undefined;
  return moveLine(list, at, to);
}
