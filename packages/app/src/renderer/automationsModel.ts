/**
 * Settings → Tools → Automations, as data (decision 0010 §4): the lines of a layer's events workflow
 * (`workflows/system/events.json`), read out of the file and written back into it. Pure — the section
 * (`automationsPane.tsx`) draws what this says and the tests read it without a DOM.
 *
 * ## The file's shape
 *
 * A root with no spine (`sequence: []`) whose own rules are the lines. A line is ONE named rule,
 * `{ name, when: "on_event('git.push', { branch: 'main' })", to: <the line's first step> }`, and its
 * steps are async children chained by `{ when: "true", to: <next> }`:
 *
 *  - step 1 is the child keyed by the line's name, and the RULE hands it everything, because `.event`
 *    (what the rule's `on_event` resolved to) is readable in the rule's own `inputs` and nowhere else;
 *  - step n ≥ 2 is `<name>_<n>`, wired from the step before it — the event is each step's output, so
 *    `.children.<prev>.output.event.payload.x` reads what `.event.payload.x` read for step 1.
 *
 * Each step is one of two built-in states: `system/events/start` (`start_task` — `workflow`, `inputs`,
 * `event`) or `system/events/notify` (`text`, `event`). Literals are the binding sugar's own: a string
 * is `{ "text": … }` (a bare string would read as a reference), and the `inputs` map is `{ "$literal":
 * { … } }` with each value picked from the event wrapped `{ "$binding": ".event.payload.x" }`.
 *
 * A rule this editor does not recognise — a hand-written guard, a child of another state — is kept
 * exactly as it stands and shown as a line that is edited as a workflow file.
 *
 * ## Layers
 *
 * Shared's copy is a whole file. A project's copy `$ref`s Shared's (REFERENCES.md §4.2a): its own
 * lines first, then Shared's spliced in minus any it ignores —
 * `{ "$ref": "...filter($BASE/workflows/system/events.transitions, (t) => !['push_main'].includes(t.name))" }`
 * — and its children beside Shared's (`"children": { "$ref": "$BASE/workflows/system/events.children", … }`).
 */
import type { JsonValue } from "@declarative-ai/json";
import { EVENT_SPECS, isEventName, matchesGlobs, type EventFilterKey, type EventName, type JairaEventsConfig } from "@jaira/shared/browser";
import type { ValueSourceOption } from "./schemaForm/types";

/** The state the events task runs, in every layer. */
export const EVENTS_STATE_ID = "system/events";
/** The step states a line's steps mount (decision 0010 §4, built in beside the root). */
export const START_STEP = "system/events/start";
export const NOTIFY_STEP = "system/events/notify";

/**
 * The events task among a project's tasks: the one the supervisor marks `system: "events"` — or,
 * where a summary does not carry the mark, the one titled `events` running `system/events`.
 */
export const eventsTaskOf = <T extends { title: string; workflow: string }>(tasks: readonly T[]): T | undefined =>
  tasks.find((task) => (task as { system?: unknown }).system === "events") ?? tasks.find((task) => task.title === "events" && task.workflow === EVENTS_STATE_ID);

/** Where the base layer's events workflow is named from a project's copy. */
const BASE_EVENTS = "$BASE/workflows/system/events";

// --- the model -------------------------------------------------------------------------------

/**
 * Where a step input's value comes from: typed, or picked from the event — by its path under the
 * delivered event (`payload.branch`, `payload.commits[0].message`; `""` for the whole event).
 */
export type StepValue = { literal: JsonValue } | { event: string };

export type AutomationStep =
  | { kind: "start"; workflow: string; inputs: Record<string, StepValue> }
  | { kind: "notify"; text: string };

export type EventFilterValue = string | string[];

export interface AutomationLine {
  name: string;
  /** The event it waits for — one of `EVENT_NAMES`, or whatever a hand-written line names. */
  event: string;
  /** `on_event`'s filter, by key. */
  filter: Partial<Record<EventFilterKey, EventFilterValue>>;
  steps: AutomationStep[];
  /**
   * A line this editor cannot take apart: its rule and the children it reaches, kept as they are.
   * Drawn read-only; edited as a workflow file.
   */
  raw?: { rule: Record<string, unknown>; children: Record<string, unknown> };
}

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

// --- one step's bindings -------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** What a step reads the event through: the rule's `.event`, or the previous step's output. */
const eventRefOf = (previous: string | undefined): string => (previous === undefined ? ".event" : `.children.${previous}.output.event`);

/** A step's wiring — the rule's `inputs` for step 1, the mount's for the rest. */
function wiringOf(step: AutomationStep, previous: string | undefined): Record<string, unknown> {
  const event = eventRefOf(previous);
  if (step.kind === "notify") return { event, text: { text: step.text } };
  const wiring: Record<string, unknown> = { event, workflow: { text: step.workflow } };
  const entries = Object.entries(step.inputs);
  if (entries.length > 0) {
    const literal: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      literal[key] = "literal" in value ? value.literal : { $binding: value.event.length > 0 ? `${event}.${value.event}` : event };
    }
    wiring["inputs"] = { $literal: literal };
  }
  return wiring;
}

/** A step read back from its state and wiring; `undefined` when it is not one this editor writes. */
function stepOf(state: unknown, wiring: unknown, previous: string | undefined): AutomationStep | undefined {
  if (!isRecord(wiring)) return undefined;
  const event = eventRefOf(previous);
  if (wiring["event"] !== event) return undefined;
  const textOf = (value: unknown): string | undefined => (isRecord(value) && typeof value["text"] === "string" && Object.keys(value).length === 1 ? value["text"] : undefined);
  if (state === NOTIFY_STEP) {
    const text = textOf(wiring["text"]);
    return text === undefined ? undefined : { kind: "notify", text };
  }
  if (state !== START_STEP) return undefined;
  const workflow = textOf(wiring["workflow"]);
  if (workflow === undefined) return undefined;
  const inputs: Record<string, StepValue> = {};
  const held = wiring["inputs"];
  if (held !== undefined) {
    if (!isRecord(held) || !isRecord(held["$literal"])) return undefined;
    for (const [key, value] of Object.entries(held["$literal"])) {
      if (isRecord(value) && Object.keys(value).length === 1 && typeof value["$binding"] === "string") {
        const ref = value["$binding"] as string;
        if (ref !== event && !ref.startsWith(`${event}.`)) return undefined;
        inputs[key] = { event: ref.slice(event.length + 1) };
      } else inputs[key] = { literal: value as JsonValue };
    }
  }
  return { kind: "start", workflow, inputs };
}

const stateOfStep = (step: AutomationStep): string => (step.kind === "start" ? START_STEP : NOTIFY_STEP);

/** The child keys a line's steps are mounted under: its name, then `<name>_2`, `<name>_3`… */
export const stepKeysOf = (line: Pick<AutomationLine, "name" | "steps">): string[] => line.steps.map((_, i) => (i === 0 ? line.name : `${line.name}_${i + 1}`));

// --- a document ↔ its lines ---------------------------------------------------------------------

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

/** Read a layer's events workflow into its lines. A document that is not an object reads as none. */
export function parseEventsDoc(doc: unknown): EventsDoc {
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
    lines.push(lineOf(rule, children, index));
  });
  return { lines, ...(splice !== undefined ? { splice } : {}), follows: typeof root["$ref"] === "string" };
}

/** One rule and the chain of children it starts, as a line — or kept raw. */
function lineOf(rule: unknown, children: Record<string, unknown>, index: number): AutomationLine {
  const record = isRecord(rule) ? rule : {};
  const name = typeof record["name"] === "string" ? record["name"] : `line_${index + 1}`;
  const raw = (): AutomationLine => {
    const guard = parseWhen(record["when"]);
    // The children the rule reaches along plain `true` chains — what goes with it if it is removed.
    const reached: Record<string, unknown> = {};
    let key = typeof record["to"] === "string" ? record["to"] : undefined;
    while (key !== undefined && children[key] !== undefined && reached[key] === undefined) {
      reached[key] = children[key];
      const mount = children[key];
      const next = isRecord(mount) && Array.isArray(mount["transitions"]) && mount["transitions"].length === 1 && isRecord(mount["transitions"][0]) ? mount["transitions"][0]["to"] : undefined;
      key = typeof next === "string" ? next : undefined;
    }
    return { name, event: guard?.event ?? "", filter: guard?.filter ?? {}, steps: [], raw: { rule: record, children: reached } };
  };
  const guard = parseWhen(record["when"]);
  const known = new Set(["name", "when", "to", "inputs"]);
  if (guard === undefined || typeof record["name"] !== "string" || record["to"] !== name || Object.keys(record).some((k) => !known.has(k))) return raw();
  const steps: AutomationStep[] = [];
  let key: string | undefined = name;
  let previous: string | undefined;
  let wiring: unknown = record["inputs"];
  while (key !== undefined) {
    const mount: unknown = children[key];
    if (!isRecord(mount) || mount["async"] !== true) return raw();
    if (key !== (steps.length === 0 ? name : `${name}_${steps.length + 1}`)) return raw();
    const step = stepOf(mount["state"], previous === undefined ? wiring : mount["inputs"], previous);
    if (step === undefined) return raw();
    if (previous === undefined && mount["inputs"] !== undefined) return raw();
    steps.push(step);
    const rules: unknown = mount["transitions"];
    previous = key;
    if (rules === undefined) key = undefined;
    else if (Array.isArray(rules) && rules.length === 1 && isRecord(rules[0]) && rules[0]["when"] === "true" && typeof rules[0]["to"] === "string") key = rules[0]["to"];
    else return raw();
    wiring = undefined;
  }
  return { name, event: guard.event, filter: guard.filter, steps };
}

/** The rule and the children one line writes. A raw line writes what it held. */
export function writeLine(line: AutomationLine): { rule: Record<string, unknown>; children: Record<string, unknown> } {
  if (line.raw !== undefined) return { rule: line.raw.rule, children: line.raw.children };
  const keys = stepKeysOf(line);
  const children: Record<string, unknown> = {};
  line.steps.forEach((step, i) => {
    const mount: Record<string, unknown> = { state: stateOfStep(step), async: true };
    if (i > 0) mount["inputs"] = wiringOf(step, keys[i - 1]);
    if (i + 1 < keys.length) mount["transitions"] = [{ when: "true", to: keys[i + 1] }];
    children[keys[i]!] = mount;
  });
  const rule: Record<string, unknown> = { name: line.name, when: whenOf(line.event, line.filter), to: line.name };
  if (line.steps.length > 0) rule["inputs"] = wiringOf(line.steps[0]!, undefined);
  return { rule, children };
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
    description: "Waits for events and starts tasks. Each rule is one automation of Settings → Tools → Automations.",
    sequence: [],
    transitions: [],
    children: {},
  };
}

/** Serialize as the Files view would — two spaces, a trailing newline. */
export const eventsDocText = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

// --- what a layer shows ---------------------------------------------------------------------------

/** One line as a layer's section draws it. */
export interface ShownLine {
  line: AutomationLine;
  /** Whose line it is: the layer's own, or the base layer's spliced into a project's copy. */
  from: "own" | "shared";
  /** A Shared line this project leaves out. */
  ignored: boolean;
}

/**
 * What the section lists for a layer: its own lines, then — on a project's copy — Shared's, each
 * marked ignored or not. `shared` is the base layer's lines (its copy, or the built-in's); a project
 * with no copy of its own shows every Shared line, none ignored.
 */
export function shownLinesOf(own: EventsDoc, shared: readonly AutomationLine[] | undefined): ShownLine[] {
  const out: ShownLine[] = own.lines.map((line) => ({ line, from: "own", ignored: false }));
  if (shared !== undefined && own.splice !== undefined) {
    const ignored = new Set(own.splice.ignored);
    for (const line of shared) out.push({ line, from: "shared", ignored: ignored.has(line.name) });
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

export function stepOfForm(workflow: string, values: Record<string, unknown>, picked: Record<string, string>): Extract<AutomationStep, { kind: "start" }> {
  const inputs: Record<string, StepValue> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined && picked[key] === undefined) inputs[key] = { literal: value as JsonValue };
  for (const [key, id] of Object.entries(picked)) inputs[key] = { event: id };
  return { kind: "start", workflow, inputs };
}

/** "issue ← event.commits[0].message · branch ← event.branch" — a step's inputs in one line. */
export function stepSummary(step: AutomationStep): string {
  if (step.kind === "notify") return `“${step.text}”`;
  const parts = Object.entries(step.inputs).map(([key, value]) =>
    "literal" in value ? `${key} = ${JSON.stringify(value.literal)}` : `${key} ← event${value.event.length > 0 ? value.event.slice("payload".length) : ""}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "no inputs";
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
