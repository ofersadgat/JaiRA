/**
 * The permission board (decision 0034): a conversation's permissions as a grid. A ROW is a resource
 * (Files), one of its accesses (Files · Read) or one tool on that access (`read_file`); a COLUMN is an
 * answer (allow, smart, ask, deny, off); and each layer of the conversation's stack — the root set, the
 * standing and named layers, the run's answers, the conversation's own lines — is a set of those columns,
 * with the Result, every layer merged, as one more. A CHIP is a place in the cell of its answer: `src/**`
 * allowed in Files · Read by the project's set.
 *
 * Moving a chip is an edit of a layer's lines ({@link moveOf}, {@link withLinesEdited}): within a layer
 * it changes that layer's answer; onto another layer it moves the place there (a read-only layer's is
 * copied); onto the Result it writes the conversation's own layer. Nothing here draws, reads the store or
 * asks the engine — the board's host does (`permissionBoardHost.ts`), the component draws
 * (`PermissionBoard.tsx`).
 *
 * Merging follows `mergePermissionMode` (decision 0023 §2.6): oldest layer first, a plain answer over
 * anything replaces it, a place map over a plain answer keeps that answer as its `**`, a map over a map
 * takes the newer layer's answer at the same place, and a map over `unavailable` replaces it.
 */
import {
  CONTROLLING_VARIABLES,
  normalizeSubject,
  OTHER_SUBJECT,
  PLACE_KINDS,
  placeKindOf,
  RESOURCES,
  RUNTIME_LAYER,
  SCOPE_OF_LAYER,
  SET_ENV_SUBJECT,
  SHELL_TOOL,
  subjectKindOf,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  TOOLS_LAYER,
  toolResourcesOf,
  type PermissionSetScope,
  type PlaceSet,
  type PermissionStackView,
  type PermissionStackViewLayer,
  type PlaceKind,
  type SetLayer,
} from "@jaira/shared/browser";
import { COMMON_SUBCOMMANDS } from "./composerPermissionSet";

// --- answers ------------------------------------------------------------------------------------

export type BoardAnswer = "allow" | "smart" | "ask" | "deny" | "off";
export const BOARD_ANSWERS: readonly BoardAnswer[] = ["allow", "smart", "ask", "deny", "off"];
const STRICT: Readonly<Record<BoardAnswer, number>> = { allow: 0, smart: 1, ask: 2, deny: 3, off: 4 };

/** The column a decision stands in: a function's name (`smart`, or any other) is Smart, `unavailable` is Off. */
export function answerOf(decision: string): BoardAnswer {
  switch (decision) {
    case "allow":
    case "ask":
    case "deny":
      return decision;
    case "unavailable":
      return "off";
    default:
      return "smart";
  }
}

/** What a drop into a column writes: Smart keeps a function a chip already names, else `smart`. */
export function decisionFor(answer: BoardAnswer, was?: string): string {
  if (answer === "off") return "unavailable";
  if (answer === "smart") return was !== undefined && answerOf(was) === "smart" ? was : "smart";
  return answer;
}

/** Ranks answers, strictest highest — where a MIXED chip is parked. */
export const strictness = (answer: BoardAnswer): number => STRICT[answer];

// --- a line's places, flat ------------------------------------------------------------------------

/** The everywhere place: a line's plain answer. */
export const EVERYWHERE = "**";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A line's mode, its `implementation` wrapper taken off. */
function modeOf(value: unknown): unknown {
  return isObject(value) && "mode" in value ? value["mode"] : value;
}

const KIND_SET = new Set<string>(PLACE_KINDS);

/** A kind's map spelled flat: `owner` + `session` → `owner=session`; its own `**` → `owner=**`. */
const kindedKey = (kind: string, place: string): string => `${kind}=${place.trim()}`;

/** The kind a flat key names, when it names one: `owner=session` → `owner`. */
export function kindPrefixOf(key: string): PlaceKind | undefined {
  const at = key.indexOf("=");
  if (at <= 0) return undefined;
  const kind = key.slice(0, at);
  return KIND_SET.has(kind) ? (kind as PlaceKind) : undefined;
}

/**
 * A line flat: `{ "**": decision, place: decision, "owner=session": decision }`. A plain answer is its
 * `**`; a kind's nested map is spelled `kind=place`. `undefined` for a line that is not there.
 */
export function flatOf(value: unknown): Record<string, string> | undefined {
  const mode = modeOf(value);
  if (mode === undefined || mode === null) return undefined;
  if (typeof mode === "string") return { [EVERYWHERE]: mode };
  if (!isObject(mode)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, decision] of Object.entries(mode)) {
    if (typeof decision === "string") out[key.trim()] = decision;
    else if (isObject(decision) && KIND_SET.has(key.trim())) {
      for (const [place, inner] of Object.entries(decision)) if (typeof inner === "string") out[kindedKey(key.trim(), place)] = inner;
    }
  }
  return out;
}

/** A flat line written as an author would: a lone `**` is a plain answer, `kind=place` nests under its kind. */
export function modeDeclOfFlat(flat: Readonly<Record<string, string>>): unknown {
  const keys = Object.keys(flat);
  if (keys.length === 1 && keys[0] === EVERYWHERE) return flat[EVERYWHERE];
  const out: Record<string, unknown> = {};
  for (const [key, decision] of Object.entries(flat)) {
    const kind = kindPrefixOf(key);
    if (kind === undefined) out[key] = decision;
    else ((out[kind] ??= {}) as Record<string, string>)[key.slice(kind.length + 1)] = decision;
  }
  return out;
}

/** Fold a subject's lines over the layers, oldest first: the flat line it comes to, and who wrote each place. */
function foldOf(values: ReadonlyArray<{ layer: string; value: unknown }>): { flat: Record<string, string>; from: Record<string, string> } | undefined {
  let flat: Record<string, string> | undefined;
  let from: Record<string, string> = {};
  for (const { layer, value } of values) {
    const own = flatOf(value);
    if (own === undefined) continue;
    const plain = typeof modeOf(value) === "string";
    const overOff = flat !== undefined && Object.keys(flat).length === 1 && flat[EVERYWHERE] === "unavailable";
    if (flat === undefined || plain || overOff) {
      flat = { ...own };
      from = Object.fromEntries(Object.keys(own).map((key) => [key, layer]));
    } else {
      flat = { ...flat, ...own };
      for (const key of Object.keys(own)) from[key] = layer;
    }
  }
  return flat === undefined ? undefined : { flat, from };
}

// --- the board's input ----------------------------------------------------------------------------

/** One column group of the board: a layer of the conversation's stack. */
export interface BoardLayer {
  /** Unique on the board: the layer's place in the stack and its id. */
  key: string;
  id: string;
  label: string;
  hint: string;
  scope: PermissionSetScope;
  role: PermissionStackViewLayer["role"];
  icon: string;
  /**
   * Who a move into it writes: the conversation's own lines; a permission set's file (asked first:
   * other conversations use it); or nobody.
   */
  writes: "conversation" | "unsaved" | "set" | "none";
  /** The settings layer its file is in, for a set. */
  setLayer?: SetLayer;
  /** Why it cannot be written, for a read-only layer. */
  readOnly?: string;
  /**
   * Its place in the conversation's stack (`StackForm.layers`), for a layer the conversation names —
   * the root, a named layer, an unsaved one. A file built of layers is several columns groups with one
   * place. Absent for what the conversation does not order: a standing layer, this run, its own lines.
   */
  entry?: number;
  /** An unsaved layer's key (`$unsaved/<key>`). */
  unsaved?: string;
}

/**
 * What a layer's head can do (2026-11-23): its name swaps it for another set, its swatch drags it, a +
 * between heads adds an unsaved layer, and its ⋯ menu holds the rest.
 */
export interface LayerActs {
  /** Swap it for a set (the name's menu); an unsaved layer with lines asks to replace or merge first. */
  swap: boolean;
  /** Drag it, or move it earlier or later. */
  move: boolean;
  remove: boolean;
  /** A new unsaved layer can go just before it (the + on its left edge). */
  addBefore: boolean;
  /** Keep it as a set file. */
  save: boolean;
  /** Its own lines can be cleared (This conversation). */
  clear: boolean;
  /** Its answers can be forgotten (This run). */
  forget: boolean;
  /** Pinned in the project's settings: unpinned, not moved. */
  unpin: boolean;
}

/** What each layer's head offers: the root, a named and an unsaved layer move, swap and go; the rest is pinned. */
export function layerActsOf(layer: BoardLayer): LayerActs {
  const ordered = layer.entry !== undefined;
  return {
    swap: ordered,
    move: ordered,
    remove: ordered,
    addBefore: ordered || layer.role === "runtime" || layer.writes === "conversation",
    save: layer.unsaved !== undefined || layer.writes === "conversation",
    clear: layer.writes === "conversation",
    forget: layer.role === "runtime",
    unpin: layer.role === "standing",
  };
}

/**
 * An unsaved layer's lines with a set's merged in (2026-11-23: "copy the data from the new layer into
 * the existing layer replacing only conflicting permissions"): every line of the set is written over the
 * layer's at the places it names — a plain answer is its `**` — and the layer's other places stay.
 */
export function mergedLines(lines: Readonly<Record<string, unknown>>, from: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...lines };
  for (const [subject, value] of Object.entries(from)) {
    const key = Object.keys(next).find((each) => (each === OTHER_SUBJECT ? each : normalizeSubject(each)) === (subject === OTHER_SUBJECT ? subject : normalizeSubject(subject))) ?? subject;
    const was = next[key];
    const over = flatOf(value);
    if (over === undefined) continue;
    const mode = modeDeclOfFlat({ ...(flatOf(was) ?? {}), ...over });
    next[key] = isObject(was) && "mode" in was ? { ...was, mode } : mode;
  }
  return next;
}

const SCOPE_NAMES: Readonly<Record<string, string>> = {
  "built in": "built in",
  global: "Shared",
  project: "project",
  machine: "this machine",
  "project on machine": "project on this machine",
  you: "Just you",
  "you in project": "you in this project",
  runtime: "this run",
  "this conversation": "this conversation",
  "this state": "this state",
};

const LAYER_OF_SCOPE: Readonly<Record<string, SetLayer>> = Object.fromEntries(Object.entries(SCOPE_OF_LAYER).map(([layer, scope]) => [scope, layer as SetLayer]));

/** The stack's layers as the board's column groups, oldest first. */
export function boardLayersOf(view: Pick<PermissionStackView, "layers">): BoardLayer[] {
  // The conversation's own order: the root and each named layer, a file built of layers counted once.
  let entries = -1;
  let lastVia: string | undefined;
  const layers = view.layers.map((layer, index): BoardLayer => {
    const key = `${index}:${layer.id}`;
    let entry: number | undefined;
    if (layer.role === "bottom" || layer.role === "named") {
      const via = layer.via ?? layer.reference ?? layer.id;
      if (via !== lastVia || layer.unsaved !== undefined) entries += 1;
      lastVia = via;
      entry = entries;
    }
    const base = { key, id: layer.id, scope: layer.scope, role: layer.role, icon: layer.icon, ...(entry !== undefined ? { entry } : {}) };
    if (layer.role === "runtime") return { ...base, label: "This run", hint: "answered for this run", writes: "none", readOnly: "the run's answers are kept as they were given" };
    if (layer.id === TOOLS_LAYER && layer.role === "own") return { ...base, label: "This conversation", hint: "kept with the conversation", writes: "conversation" };
    if (layer.unsaved !== undefined) return { ...base, label: layer.unsaved.name, hint: "unsaved · this conversation", writes: "unsaved", unsaved: layer.unsaved.key };
    const where = SCOPE_NAMES[layer.scope] ?? layer.scope;
    const label = layer.role === "bottom" ? `Root · ${layer.id}` : layer.id;
    const hint = layer.role === "standing" ? `standing · ${where}` : where;
    if (layer.scope === "built in") return { ...base, label, hint, writes: "none", readOnly: "what ships with JaiRA is read-only" };
    if (layer.scope === "this state") return { ...base, label, hint, writes: "none", readOnly: "written on the state itself" };
    const setLayer = LAYER_OF_SCOPE[layer.scope];
    if (setLayer === undefined) return { ...base, label, hint, writes: "none", readOnly: "not a file JaiRA can write" };
    return { ...base, label, hint, writes: "set", setLayer };
  });
  // A conversation with no lines of its own yet has no such layer in its stack: the board still draws
  // one, empty, so a move on the Result has somewhere to land — its first line makes it.
  if (!layers.some((layer) => layer.writes === "conversation")) {
    layers.push({ key: `${layers.length}:${TOOLS_LAYER}`, id: TOOLS_LAYER, label: "This conversation", hint: "kept with the conversation", scope: "this conversation", role: "own", icon: "chat", writes: "conversation" });
  }
  return layers;
}

/** Each layer's own lines by normalized subject — the run's answers turned into lines of their widths. */
function linesByLayer(view: Pick<PermissionStackView, "layers" | "runtime">, layers: readonly BoardLayer[]): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  view.layers.forEach((layer, index) => {
    const lines = new Map<string, unknown>();
    if (layer.role === "runtime") {
      for (const [key, decision] of Object.entries(view.runtime)) {
        const at = key.indexOf(" @ ");
        const subject = normalizeSubject(at < 0 ? key : key.slice(0, at));
        const place = at < 0 ? EVERYWHERE : key.slice(at + 3).trim();
        const was = (lines.get(subject) as Record<string, string> | undefined) ?? {};
        lines.set(subject, { ...was, [place]: decision });
      }
    } else for (const [subject, value] of Object.entries(layer.own ?? {})) lines.set(subject === OTHER_SUBJECT ? subject : normalizeSubject(subject), value);
    out.set(layers[index]!.key, lines);
  });
  return out;
}

// --- rows -------------------------------------------------------------------------------------------

export type BoardRowRef =
  | { level: 1; resource: string }
  | { level: 2; resource: string; access: string }
  | { level: 3; resource: string; access: string; subject: string }
  /** A line's row — a tool, a program, a subcommand, a flag line — opened on the lines under it, by its row's key. */
  | { level: 4; key: string };

export interface BoardRow {
  key: string;
  ref: BoardRowRef;
  level: 1 | 2 | 3;
  label: string;
  /** Under the label: the tools on an access, the accesses of a resource. */
  sub: string;
  icon: string;
  /** The resource it belongs to — its colour. */
  resource: string;
  /** Has rows under it. */
  opens: boolean;
  open: boolean;
  /** A tool on more than one resource: the others' names. */
  also: string[];
  /** The last row under its parent — where the thread stops. */
  last: boolean;
  /** The one line a row stands for — a tool's, a program's, a subcommand's — where it stands for one: what an empty cell's press writes. */
  subject?: string;
  /** How far under its tool's row a line's row is: a program 1, its subcommand 2. */
  depth?: number;
}

/** A place in a cell. */
export interface BoardChip {
  /** Unique in its cell. */
  id: string;
  /** The flat place: `src/**`, `owner=session`, `**`. */
  place: string;
  label: string;
  /** Its kind of place, for the icon: `path`, `owner`… `any` for everywhere, `tool` for a whole tool. */
  kind: string;
  answer: BoardAnswer;
  /** The decision as written: `smart`, another function's name, `allow`. */
  decision: string;
  /** The subjects it stands for and the place on each. */
  lines: Array<{ subject: string; place: string }>;
  /** On a resource's row: the accesses it holds for, by name. */
  tags?: Array<{ label: string; icon: string }>;
  /** The Result: the tools under it disagree here — it is parked at the strictest. */
  mixed?: boolean;
  /** The Result: the layer that answered, when one did. */
  from?: string;
  /** A layer: the newer layer that says otherwise at the same place. */
  overruled?: string;
  /** A layer: only some of the tools under it say this here — `2 of 3`. */
  part?: string;
  /** The Result, MIXED: what each tool under it comes to here. */
  answers?: Array<{ subject: string; decision: string; from?: string }>;
  /** A place set (`credentials`): the set, and a chip for each of its places. */
  set?: { id: string; label: string; places: readonly string[] };
  members?: BoardChip[];
}

/** The board: its layers, oldest first, and its rows, each with every column group's chips. */
export interface Board {
  layers: BoardLayer[];
  rows: Array<BoardRow & { cells: Record<string, BoardChip[]> }>;
}

/** The column group of the merged answer. */
export const RESULT = "result";

export interface BoardInput {
  view: Pick<PermissionStackView, "layers" | "runtime">;
  /** `permissions.resources` as the settings come to. */
  mapping?: Readonly<Record<string, readonly string[]>>;
  /** Opened resources and accesses (`files`, `files.read`), and the line rows opened on the lines under them, by key. */
  open: { resources: ReadonlySet<string>; accesses: ReadonlySet<string>; lines?: ReadonlySet<string> };
  /** The place sets a cell draws as one chip (`placeSetsOf`). */
  placeSets?: readonly PlaceSet[];
  /** Rows by resource (the default), or by tool, under the app's tool categories. */
  by?: "resources" | "tools";
}

/** The Tools view's groups: the app's tool categories, then Other. A command line, `script` and a runner are Execution's. */
function categoryOf(subject: string): { id: string; label: string; icon: string } {
  if (subject === OTHER_SUBJECT) return { id: "other", label: "Other", icon: "tool" };
  const spec = TOOL_SPEC_BY_NAME.get(subject) ?? TOOL_SPEC_BY_NAME.get(subject.split(" ")[0] ?? "");
  const id = spec?.category ?? (subject.startsWith("mcp__") ? "mcp" : "execution");
  const category = TOOL_CATEGORIES.find((each) => each.id === id);
  return { id, label: category?.label ?? id, icon: CATEGORY_ICONS[id] ?? "tool" };
}

const CATEGORY_ICONS: Readonly<Record<string, string>> = { files: "folder", execution: "terminal", system: "system", web: "web", git: "git", ci: "git", tasks: "workflow", mcp: "tool", other: "tool" };

const RESOURCE_BY_ID = new Map(RESOURCES.map((resource) => [resource.id, resource]));

/** A flat place's kind on a subject's line. */
function placeKindOn(subject: string, place: string): string {
  if (place === EVERYWHERE) return "any";
  const kinded = kindPrefixOf(place);
  if (kinded !== undefined) return place.endsWith("=**") ? "any" : kinded;
  return placeKindOf(subject) ?? "any";
}

/** How a place reads on its chip. */
function placeLabel(subject: string, place: string): string {
  if (place === EVERYWHERE) {
    const kind = placeKindOf(subject);
    return kind === undefined || kind === "path" ? "**" : `any ${kind}`;
  }
  const kinded = kindPrefixOf(place);
  if (kinded !== undefined) {
    const rest = place.slice(kinded.length + 1);
    return rest === EVERYWHERE ? `any ${kinded}` : rest;
  }
  return place;
}

/** Whether a place on a subject's line belongs to a resource (`**` belongs to every one). */
function placeIn(resource: string | undefined, subject: string, place: string, resources: readonly string[]): boolean {
  if (resource === undefined || place === EVERYWHERE) return true;
  if (!RESOURCE_BY_ID.has(resource)) return true;
  const kind = kindPrefixOf(place) ?? placeKindOf(subject);
  // The first of the subject's resources whose kinds have it; a kind none of them has is the first's.
  const ids = resources.map((name) => name.split(".")[0]!);
  const owner = ids.find((id) => kind !== undefined && RESOURCE_BY_ID.get(id)?.kinds.includes(kind)) ?? ids[0];
  return owner === undefined || owner === resource;
}

/** A subject's answer at a flat place, as its flat line comes to it: the place, its kind's `**`, then `**`. */
function answerAt(flat: Readonly<Record<string, string>>, place: string): { decision: string; key: string } | undefined {
  if (flat[place] !== undefined) return { decision: flat[place]!, key: place };
  const kind = kindPrefixOf(place);
  if (kind !== undefined && flat[`${kind}=**`] !== undefined) return { decision: flat[`${kind}=**`]!, key: `${kind}=**` };
  if (flat[EVERYWHERE] !== undefined) return { decision: flat[EVERYWHERE]!, key: EVERYWHERE };
  return undefined;
}

/**
 * The kinds of place a subject's line can be placed by: its tool's own and its dimensions; a command
 * line's, `script`'s or a runner's folder (or host). None for a tool granted whatever its line says
 * (`show_artifact`), an MCP tool, or a tool with no place (the skill tools).
 */
export function kindsOfSubject(subject: string): string[] {
  const spec = TOOL_SPEC_BY_NAME.get(subject) ?? TOOL_SPEC_BY_NAME.get(subject.split(" ")[0] ?? "");
  if (spec !== undefined) return spec.alwaysGranted === true ? [] : [...(spec.scope !== undefined ? [spec.scope] : []), ...(spec.dimensions ?? [])];
  const kind = placeKindOf(subject);
  return kind !== undefined ? [kind] : [];
}

/** Every subject the board has a row for: the tools JaiRA ships, and every line any layer writes. */
function subjectsOf(lines: Map<string, Map<string, unknown>>): string[] {
  const out = new Set<string>(TOOL_SPECS.map((spec) => spec.name));
  for (const layer of lines.values()) for (const subject of layer.keys()) out.add(subject);
  // `other` is Other's own last row, never one of the subjects.
  out.delete(OTHER_SUBJECT);
  return [...out];
}

/**
 * The lines a line's row opens on (2026-11-25: "it should show you everything … you still should be
 * able to manually expand the row to see its children and have it be empty, so you can configure that
 * subcommand"). A line's parent is the longest line its words start with — `git push --force` under
 * `git push`, `git push` under `git`, `shell --run_in_background` under `shell`, `set_env PATH` under
 * `set_env` — and a program no line names a start of is the shell's, whose line answers for any command
 * no other names. Beside the lines the layers write stand the ones worth reaching by name: the programs
 * people name most and their usual subcommands, each tool's flags, and the variables that change what
 * runs. Only `roots` are rows of their own; the rest are under them.
 */
export function lineTreeOf(subjects: readonly string[]): { roots: string[]; children: Map<string, string[]> } {
  const nodes = new Set(subjects);
  if (nodes.has(SHELL_TOOL))
    for (const [program, subs] of Object.entries(COMMON_SUBCOMMANDS)) {
      nodes.add(program);
      for (const sub of subs) nodes.add(`${program} ${sub}`);
    }
  for (const spec of TOOL_SPECS) {
    if (!nodes.has(spec.name)) continue;
    for (const [name, flag] of Object.entries(spec.flags ?? {})) {
      if (flag.type === "boolean") nodes.add(`${spec.name} --${name}`);
      else if (flag.type === "choice") for (const value of flag.values) nodes.add(`${spec.name} --${name}=${value}`);
    }
  }
  if (nodes.has(SET_ENV_SUBJECT)) for (const name of CONTROLLING_VARIABLES) if (!name.endsWith("*")) nodes.add(`${SET_ENV_SUBJECT} ${name}`);

  const parentOf = (subject: string): string | undefined => {
    const words = subject.split(" ");
    for (let at = words.length - 1; at >= 1; at -= 1) {
      const prefix = words.slice(0, at).join(" ");
      if (nodes.has(prefix)) return prefix;
    }
    if (subject !== SHELL_TOOL && subject !== SET_ENV_SUBJECT && nodes.has(SHELL_TOOL) && subjectKindOf(subject) === "command") return SHELL_TOOL;
    return undefined;
  };
  const written = new Set(subjects);
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const subject of nodes) {
    const parent = parentOf(subject);
    if (parent === undefined) roots.push(subject);
    else (children.get(parent) ?? children.set(parent, []).get(parent)!).push(subject);
  }
  // The lines a layer writes first, then the rest, each alphabetically.
  for (const list of children.values()) list.sort((a, b) => Number(written.has(b)) - Number(written.has(a)) || a.localeCompare(b));
  return { roots, children };
}

/** Kinds of line whose everywhere answer can be off: a tool's, a flag line's and an MCP tool's — never a command, `script`, a runner or `other` (decision 0023). */
const OFF_KINDS = new Set(["tool", "tool-flag", "mcp", "unknown-tool"]);

/** Build the board. */
export function boardOf(input: BoardInput): Board {
  const layers = boardLayersOf(input.view);
  const lines = linesByLayer(input.view, layers);
  const mapping = input.mapping ?? {};
  const all = subjectsOf(lines);
  // Rows stand for the tools and the lines no other line is under; a program, a subcommand and a flag
  // line are under their line's row (`lineTreeOf`).
  const tree = lineTreeOf(all);
  const subjects = tree.roots.filter((subject) => all.includes(subject));
  const written = new Set([...lines.values()].flatMap((layer) => [...layer.keys()]));
  const resourcesOf = new Map(all.map((subject) => [subject, toolResourcesOf(subject, mapping)]));

  // What each subject comes to, and the `other` line under the ones no layer names.
  const valuesOf = (subject: string): Array<{ layer: string; value: unknown }> => layers.map((layer) => ({ layer: layer.key, value: lines.get(layer.key)?.get(subject) }));
  const otherFold = foldOf(valuesOf(OTHER_SUBJECT));
  const resultOf = new Map<string, { flat: Record<string, string>; from: Record<string, string | undefined> }>();
  for (const subject of [...all, OTHER_SUBJECT]) {
    const fold = foldOf(valuesOf(subject));
    if (fold !== undefined) resultOf.set(subject, fold);
    else if (otherFold !== undefined) resultOf.set(subject, { flat: { [EVERYWHERE]: otherFold.flat[EVERYWHERE] ?? "ask" }, from: { [EVERYWHERE]: otherFold.from[EVERYWHERE] } });
    else resultOf.set(subject, { flat: { [EVERYWHERE]: "ask" }, from: {} });
  }

  // Who overrules a layer's place on a subject: the newest LATER layer that writes the place, or a plain answer.
  const overruledAt = (layerIndex: number, subject: string, place: string): string | undefined => {
    for (let at = layers.length - 1; at > layerIndex; at -= 1) {
      const value = lines.get(layers[at]!.key)?.get(subject);
      const flat = flatOf(value);
      if (flat === undefined) continue;
      if (typeof modeOf(value) === "string" || flat[place] !== undefined) return layers[at]!.key;
    }
    return undefined;
  };

  /** A layer's chips for some subjects at one resource: one per place and answer. */
  const layerChips = (layerIndex: number, group: readonly string[], resource: string | undefined): BoardChip[] => {
    const layer = layers[layerIndex]!;
    const byKey = new Map<string, BoardChip & { owners: string[] }>();
    for (const subject of group) {
      const flat = flatOf(lines.get(layer.key)?.get(subject));
      if (flat === undefined) continue;
      for (const [place, decision] of Object.entries(flat)) {
        if (!placeIn(resource, subject, place, resourcesOf.get(subject) ?? [])) continue;
        const id = `${place}|${decision}`;
        const chip = byKey.get(id) ?? { id, place, label: placeLabel(subject, place), kind: placeKindOn(subject, place), answer: answerOf(decision), decision, lines: [], owners: [] };
        chip.lines.push({ subject, place });
        chip.owners.push(subject);
        byKey.set(id, chip);
      }
    }
    return [...byKey.values()].map(({ owners, ...chip }) => {
      const overruledBy = owners.map((subject) => overruledAt(layerIndex, subject, chip.place));
      const overruled = overruledBy.every((each) => each !== undefined) ? overruledBy[0] : undefined;
      const part = group.length > 1 && owners.length < group.length ? `${owners.length} of ${group.length}` : undefined;
      return { ...chip, ...(overruled !== undefined ? { overruled } : {}), ...(part !== undefined ? { part } : {}) };
    });
  };

  /** The Result's chips for some subjects at one resource: one per place, MIXED where they disagree. */
  const resultChips = (group: readonly string[], resource: string | undefined): BoardChip[] => {
    const places = new Set<string>();
    for (const subject of group) for (const place of Object.keys(resultOf.get(subject)!.flat)) if (placeIn(resource, subject, place, resourcesOf.get(subject) ?? [])) places.add(place);
    const chips: BoardChip[] = [];
    for (const place of places) {
      const answers = group.map((subject) => {
        const result = resultOf.get(subject)!;
        const at = answerAt(result.flat, place);
        return { subject, decision: at?.decision ?? "ask", from: at !== undefined ? result.from[at.key] : undefined };
      });
      const decisions = new Set(answers.map((each) => each.decision));
      const froms = new Set(answers.map((each) => each.from));
      const mixed = decisions.size > 1;
      const decision = mixed ? [...decisions].sort((a, b) => STRICT[answerOf(b)] - STRICT[answerOf(a)])[0]! : answers[0]!.decision;
      const from = !mixed && froms.size === 1 ? answers[0]!.from : undefined;
      const subject = group[0]!;
      chips.push({
        id: place,
        place,
        label: placeLabel(subject, place),
        kind: placeKindOn(subject, place),
        answer: answerOf(decision),
        decision,
        lines: group.map((each) => ({ subject: each, place })),
        ...(mixed ? { mixed: true, answers: answers.map((each) => ({ subject: each.subject, decision: each.decision, ...(each.from !== undefined ? { from: each.from } : {}) })) } : {}),
        ...(from !== undefined ? { from } : {}),
      });
    }
    return chips;
  };

  const cellsFor = (group: readonly string[], resource: string | undefined): Record<string, BoardChip[]> => {
    const cells: Record<string, BoardChip[]> = { [RESULT]: resultChips(group, resource) };
    layers.forEach((layer, index) => (cells[layer.key] = layerChips(index, group, resource)));
    return cells;
  };

  /**
   * The rows under an open line's row: a row per line under it, empty where no layer writes it — it
   * answers as its parent does, and the parent's row says so — and otherwise saying only where it
   * differs from its parent. `parent` is what the parent comes to (its own cells, or what it inherits).
   */
  const lineRows = (of: string, ofKey: string, parent: Readonly<Record<string, BoardChip[]>>, resource: string | undefined, hue: string, depth: number): Board["rows"] => {
    const out: Board["rows"] = [];
    const under = tree.children.get(of) ?? [];
    under.forEach((subject, index) => {
      const key = `${ofKey}>${subject}`;
      const own = written.has(subject) ? cellsFor([subject], resource) : undefined;
      const opens = (tree.children.get(subject)?.length ?? 0) > 0;
      const open = opens && input.open.lines?.has(key) === true;
      out.push({
        key,
        ref: { level: 4, key },
        level: 3,
        depth,
        label: subject,
        sub: "",
        icon: subjectKindOf(subject) === "command" ? "terminal" : "tool",
        resource: hue,
        opens,
        open,
        also: [],
        last: index === under.length - 1,
        cells: own !== undefined ? without(own, parent) : {},
        subject,
      });
      if (open) out.push(...lineRows(subject, key, own ?? parent, resource, hue, depth + 1));
    });
    return out;
  };
  /** A tool's row opens when lines are under it. */
  const opensOf = (subject: string, key: string): { opens: boolean; open: boolean } => {
    const opens = (tree.children.get(subject)?.length ?? 0) > 0;
    return { opens, open: opens && input.open.lines?.has(key) === true };
  };

  /** A resource's row, closed: each access's chips, grouped by place and answer, tagged with the accesses. */
  const condensed = (accesses: ReadonlyArray<{ id: string; label: string; icon: string; group: string[] }>, resource: string): Record<string, BoardChip[]> => {
    const cells: Record<string, BoardChip[]> = {};
    for (const column of [RESULT, ...layers.map((layer) => layer.key)]) {
      const byKey = new Map<string, BoardChip>();
      for (const access of accesses) {
        const chips = column === RESULT ? resultChips(access.group, resource) : layerChips(layers.findIndex((layer) => layer.key === column), access.group, resource);
        for (const chip of chips) {
          const id = `${chip.place}|${chip.decision}|${chip.mixed === true}|${chip.from ?? ""}|${chip.overruled ?? ""}`;
          const was = byKey.get(id);
          if (was === undefined) byKey.set(id, { ...chip, id, tags: [{ label: access.label, icon: access.icon }] });
          else {
            was.lines.push(...chip.lines);
            was.tags!.push({ label: access.label, icon: access.icon });
          }
        }
      }
      cells[column] = [...byKey.values()];
    }
    return cells;
  };

  const sets = input.placeSets ?? [];
  const withAllSets = (rows: Board["rows"]): Board["rows"] => {
    if (sets.length > 0) for (const row of rows) for (const column of Object.keys(row.cells)) row.cells[column] = withSets(row.cells[column]!, sets);
    return rows;
  };

  // The Tools view: a band per tool category, a row per tool — every place of its line, whatever the
  // resource — under it; an open band keeps what every one of its tools says alike.
  if (input.by === "tools") {
    const rows: Board["rows"] = [];
    const order = [...TOOL_CATEGORIES.map((category) => category.id), "other"];
    const byCategory = new Map<string, string[]>();
    for (const subject of [...subjects.sort(), OTHER_SUBJECT]) (byCategory.get(categoryOf(subject).id) ?? byCategory.set(categoryOf(subject).id, []).get(categoryOf(subject).id)!).push(subject);
    for (const id of order) {
      const group = byCategory.get(id);
      if (group === undefined || group.length === 0) continue;
      const category = categoryOf(group[0]!);
      const key = `cat:${id}`;
      const open = input.open.resources.has(key);
      const toolCells = open ? group.map((subject) => cellsFor([subject], undefined)) : [];
      const shared = open ? commonOf(toolCells, group.map((subject) => new Set(kindsOfSubject(subject)))) : {};
      rows.push({ key, ref: { level: 1, resource: key }, level: 1, label: category.label, sub: `${group.length} tool${group.length === 1 ? "" : "s"}`, icon: category.icon, resource: key, opens: true, open, also: [], last: false, cells: open ? shared : cellsFor(group, undefined) });
      if (!open) continue;
      group.forEach((subject, index) => {
        const names = (resourcesOf.get(subject) ?? []).map((name) => {
          const [resource, access] = name.split(".");
          const spec = RESOURCE_BY_ID.get(resource!);
          return `${spec?.label ?? resource} · ${spec?.accesses.find((each) => each.id === access)?.label ?? access}`;
        });
        const rowKey = `${key}.${subject}`;
        const fold = opensOf(subject, rowKey);
        rows.push({
          key: rowKey,
          ref: fold.opens ? { level: 4, key: rowKey } : { level: 2, resource: key, access: subject },
          level: 2,
          label: subject === OTHER_SUBJECT ? "everything not listed" : subject,
          sub: names.length > 0 ? names.join(", ") : "no resource",
          icon: "tool",
          resource: key,
          ...fold,
          also: [],
          last: index === group.length - 1,
          cells: without(toolCells[index]!, shared),
          ...(subject !== OTHER_SUBJECT ? { subject } : {}),
        });
        if (fold.open) rows.push(...lineRows(subject, rowKey, toolCells[index]!, undefined, key, 1));
      });
    }
    return { layers, rows: withAllSets(rows) };
  }

  const rows: Board["rows"] = [];
  for (const resource of RESOURCES) {
    const accesses = resource.accesses
      .map((access) => ({ id: access.id, label: access.label, icon: access.icon, group: subjects.filter((subject) => resourcesOf.get(subject)!.includes(`${resource.id}.${access.id}`)).sort() }))
      .filter((access) => access.group.length > 0);
    if (accesses.length === 0) continue;
    const open = input.open.resources.has(resource.id);
    const tools = new Set(accesses.flatMap((access) => access.group)).size;
    // Open, a row keeps what every row under it says alike, and those rows say only where they differ.
    const accessCells = open ? accesses.map((access) => cellsFor(access.group, resource.id)) : [];
    const hoisted = open ? commonOf(accessCells, accesses.map((access) => new Set(access.group.flatMap(kindsOfSubject)))) : {};
    rows.push({
      key: resource.id,
      ref: { level: 1, resource: resource.id },
      level: 1,
      label: resource.label,
      sub: open ? `${accesses.length} access${accesses.length === 1 ? "" : "es"} · ${tools} tool${tools === 1 ? "" : "s"}` : accesses.map((access) => access.label.toLowerCase()).join(" · "),
      icon: resource.icon,
      resource: resource.id,
      opens: true,
      open,
      also: [],
      last: false,
      cells: open ? hoisted : condensed(accesses, resource.id),
    });
    if (!open) continue;
    accesses.forEach((access, at) => {
      const name = `${resource.id}.${access.id}`;
      const accessOpen = input.open.accesses.has(name);
      const fullCells = accessOpen ? access.group.map((subject) => cellsFor([subject], resource.id)) : [];
      let toolCells = fullCells;
      let cells = without(accessCells[at]!, hoisted);
      if (accessOpen) {
        const shared = commonOf(toolCells, access.group.map((subject) => new Set(kindsOfSubject(subject))));
        cells = without(shared, hoisted);
        toolCells = toolCells.map((each) => without(each, shared));
      }
      rows.push({
        key: name,
        ref: { level: 2, resource: resource.id, access: access.id },
        level: 2,
        label: access.label,
        sub: accessOpen ? `${access.group.length} tool${access.group.length === 1 ? "" : "s"}` : access.group.join(" · "),
        icon: access.icon,
        resource: resource.id,
        opens: true,
        open: accessOpen,
        also: [],
        last: at === accesses.length - 1,
        cells,
      });
      if (!accessOpen) return;
      access.group.forEach((subject, index) => {
        const also = (resourcesOf.get(subject) ?? []).map((each) => each.split(".")[0]!).filter((each, i, all) => each !== resource.id && all.indexOf(each) === i).map((each) => RESOURCE_BY_ID.get(each)?.label ?? each);
        const rowKey = `${name}@${subject}`;
        const fold = opensOf(subject, rowKey);
        rows.push({
          key: rowKey,
          ref: fold.opens ? { level: 4, key: rowKey } : { level: 3, resource: resource.id, access: access.id, subject },
          level: 3,
          label: subject,
          sub: "",
          icon: "tool",
          resource: resource.id,
          ...fold,
          also,
          last: index === access.group.length - 1,
          cells: toolCells[index]!,
          subject,
        });
        if (fold.open) rows.push(...lineRows(subject, rowKey, fullCells[index]!, resource.id, resource.id, 1));
      });
    });
  }

  // Everything no resource holds: a row of its own each, under Other.
  const loose = [...subjects.filter((subject) => resourcesOf.get(subject)!.length === 0).sort(), OTHER_SUBJECT];
  const otherOpen = input.open.resources.has("other");
  rows.push({
    key: "other",
    ref: { level: 1, resource: "other" },
    level: 1,
    label: "Other",
    sub: otherOpen ? `${loose.length} lines` : "touch no resource · one answer each",
    icon: "tool",
    resource: "other",
    opens: true,
    open: otherOpen,
    also: [],
    last: false,
    cells: otherOpen ? {} : otherCondensed(loose, cellsFor),
  });
  if (otherOpen)
    loose.forEach((subject, index) => {
      const rowKey = `other.${subject}`;
      const fold = opensOf(subject, rowKey);
      const own = cellsFor([subject], undefined);
      rows.push({
        key: rowKey,
        ref: fold.opens ? { level: 4, key: rowKey } : { level: 2, resource: "other", access: subject },
        level: 2,
        label: subject === OTHER_SUBJECT ? "everything not listed" : subject,
        sub: "",
        icon: "tool",
        resource: "other",
        ...fold,
        also: [],
        last: index === loose.length - 1,
        cells: own,
        ...(subject !== OTHER_SUBJECT ? { subject } : {}),
      });
      if (fold.open) rows.push(...lineRows(subject, rowKey, own, undefined, "other", 1));
    });
  return { layers, rows: withAllSets(rows) };
}

/**
 * A cell's chips with each place set said once: where every place of a set is in the cell with one
 * decision, they become one chip — `credentials 8` — standing for all their lines, the places kept as
 * its members (the inspector's). A set of one place (`project files`) is that place, named.
 */
export function withSets(chips: readonly BoardChip[], sets: readonly PlaceSet[]): BoardChip[] {
  let left = [...chips];
  const out: BoardChip[] = [];
  for (const set of sets) {
    const decisions = new Set(left.filter((chip) => set.places.includes(chip.place) && chip.set === undefined).map((chip) => chip.decision));
    for (const decision of decisions) {
      const members = set.places.map((place) => left.find((chip) => chip.place === place && chip.decision === decision && chip.set === undefined));
      if (members.some((member) => member === undefined)) continue;
      const found = members as BoardChip[];
      const one = (pick: (chip: BoardChip) => string | undefined): string | undefined => (new Set(found.map(pick)).size === 1 ? pick(found[0]!) : undefined);
      const from = one((chip) => chip.from);
      const overruled = one((chip) => chip.overruled);
      const tags = found[0]!.tags !== undefined ? [...new Map(found.flatMap((chip) => chip.tags ?? []).map((tag) => [tag.label, tag])).values()] : undefined;
      out.push({
        id: `set:${set.id}|${decision}`,
        place: `set:${set.id}`,
        label: set.places.length > 1 ? `${set.label} ${set.places.length}` : set.label,
        kind: found[0]!.kind === "any" ? "any" : "set",
        answer: found[0]!.answer,
        decision,
        lines: found.flatMap((chip) => chip.lines),
        set: { id: set.id, label: set.label, places: set.places },
        members: found,
        ...(from !== undefined ? { from } : {}),
        ...(overruled !== undefined ? { overruled } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(found.some((chip) => chip.mixed === true) ? { mixed: true } : {}),
      });
      left = left.filter((chip) => !found.includes(chip));
    }
  }
  return [...out, ...left];
}

/** Other, closed: each line's everywhere answer as a chip named for the line. */
function otherCondensed(loose: readonly string[], cellsFor: (group: readonly string[], resource: string | undefined) => Record<string, BoardChip[]>): Record<string, BoardChip[]> {
  const cells: Record<string, BoardChip[]> = {};
  for (const subject of loose) {
    for (const [column, chips] of Object.entries(cellsFor([subject], undefined))) {
      const everywhere = chips.find((chip) => chip.place === EVERYWHERE);
      if (everywhere === undefined) continue;
      (cells[column] ??= []).push({ ...everywhere, id: `${subject}|${everywhere.id}`, label: subject === OTHER_SUBJECT ? "everything not listed" : subject, kind: "tool" });
    }
  }
  return cells;
}

// --- what a row's rows say alike ------------------------------------------------------------------------

const chipKey = (chip: Pick<BoardChip, "place" | "decision">): string => `${chip.place}|${chip.decision}`;
/** A chip that says one thing for all it stands for: not MIXED, not "2 of 3". */
const whole = (chip: BoardChip): boolean => chip.mixed !== true && chip.part === undefined;

/**
 * What every one of some rows says alike, column by column: a place with the same decision in each, as
 * one chip standing for all their lines — the row above them draws it, and they do not (2026-11-23: "if
 * a scope is the same across all of the sub rows, it stays in the parent row instead of being duplicated").
 */
export function commonOf(children: ReadonlyArray<Readonly<Record<string, BoardChip[]>>>, kinds?: ReadonlyArray<ReadonlySet<string>>): Record<string, BoardChip[]> {
  const out: Record<string, BoardChip[]> = {};
  if (children.length === 0) return out;
  // A row whose tools cannot be placed by a place's kind (the skill tools at a path; `show_artifact`,
  // which is granted whatever a line says) has nothing to say about that place: it is judged by the rest.
  const columns = new Set(children.flatMap((cells) => Object.keys(cells)));
  for (const column of columns) {
    const each = children.map((cells, at) => ({ kinds: kinds?.[at], chips: new Map((cells[column] ?? []).filter(whole).map((chip) => [chipKey(chip), chip])) }));
    const keys = new Map<string, BoardChip>();
    for (const child of each) for (const [key, chip] of child.chips) if (!keys.has(key)) keys.set(key, chip);
    const common: BoardChip[] = [];
    for (const [key, chip] of keys) {
      const judges = chip.kind === "any" ? each : each.filter((child) => child.kinds === undefined || child.kinds.has(chip.kind));
      if (judges.length === 0) continue;
      const all = judges.map((child) => child.chips.get(key));
      if (all.some((found) => found === undefined)) continue;
      const found = all as BoardChip[];
      const from = new Set(found.map((one) => one.from)).size === 1 ? chip.from : undefined;
      const overruled = new Set(found.map((one) => one.overruled)).size === 1 ? chip.overruled : undefined;
      const { from: _from, overruled: _overruled, tags: _tags, ...rest } = chip;
      common.push({ ...rest, id: key, lines: found.flatMap((one) => one.lines), ...(from !== undefined ? { from } : {}), ...(overruled !== undefined ? { overruled } : {}) });
    }
    out[column] = common;
  }
  return out;
}

/** A row's cells without what the row above it draws for it. */
export function without(cells: Readonly<Record<string, BoardChip[]>>, taken: Readonly<Record<string, BoardChip[]>>): Record<string, BoardChip[]> {
  const out: Record<string, BoardChip[]> = {};
  for (const [column, chips] of Object.entries(cells)) {
    const gone = new Set((taken[column] ?? []).map(chipKey));
    out[column] = chips.filter((chip) => !gone.has(chipKey(chip)));
  }
  return out;
}

// --- moving a chip ----------------------------------------------------------------------------------

/** One place written into (or, `decision: null`, taken out of) one layer's line for one subject. */
export interface LineEdit {
  layer: string;
  subject: string;
  place: string;
  decision: string | null;
}

export type BoardMove =
  | { ok: true; edits: LineEdit[]; says: string; ask?: string }
  | { ok: false; says: string };

/**
 * What dropping a chip into a column means. `from` is the column group the chip was in (a layer's key
 * or {@link RESULT}), `to` the group and answer it lands in. A drop on the Result is written to the
 * conversation's own layer; a set's layer is asked about first (`ask`); a read-only layer refuses.
 */
export function moveOf(board: Pick<Board, "layers">, chip: Pick<BoardChip, "lines" | "decision" | "label" | "place">, from: string, to: { column: string; answer: BoardAnswer }): BoardMove {
  const own = board.layers.find((layer) => layer.writes === "conversation");
  const target = to.column === RESULT ? own : board.layers.find((layer) => layer.key === to.column);
  if (target === undefined) return { ok: false, says: "This conversation has no layer of its own to write to." };
  if (target.writes === "none") return { ok: false, says: `${target.label} can't be changed: ${target.readOnly ?? "it is read-only"}.` };
  if (to.answer === "off" && chip.lines.some((line) => line.place !== EVERYWHERE)) return { ok: false, says: "Only a tool's everywhere answer can be off." };
  const decision = decisionFor(to.answer, chip.decision);
  const edits: LineEdit[] = chip.lines.map((line) => ({ layer: target.key, subject: line.subject, place: line.place, decision }));
  const source = board.layers.find((layer) => layer.key === from);
  const moving = source !== undefined && source.key !== target.key;
  if (moving && source.writes !== "none") for (const line of chip.lines) edits.push({ layer: source.key, subject: line.subject, place: line.place, decision: null });
  const subjects = [...new Set(chip.lines.map((line) => line.subject))];
  const what = `${subjects.length === 1 ? subjects[0] : `${subjects.length} tools`} at ${chip.label}`;
  const where = target.writes === "conversation" ? "this conversation" : target.label;
  const says = moving ? `${what} → ${decision}, ${source.writes === "none" ? "copied" : "moved"} from ${source.label} to ${where}.` : `${what} → ${decision}, in ${where}.`;
  const sets = [...new Set(edits.map((edit) => board.layers.find((layer) => layer.key === edit.layer)).filter((layer) => layer?.writes === "set").map((layer) => layer!.label))];
  return { ok: true, edits, says, ...(sets.length > 0 ? { ask: `This changes ${sets.join(" and ")} for every conversation that uses ${sets.length === 1 ? "it" : "them"}.` } : {}) };
}

/**
 * An empty cell pressed: the row's line given an answer of its own everywhere, in that column's layer —
 * the Result's is the conversation's own, as a drop there is. How a subcommand that answers as its
 * program does gets a line of its own (2026-11-25). Off is a tool's alone: a command, `script`, a runner
 * and `other` cannot be.
 */
export function addOf(board: Pick<Board, "layers">, subject: string, to: { column: string; answer: BoardAnswer }): BoardMove {
  if (to.answer === "off" && !OFF_KINDS.has(subjectKindOf(subject))) return { ok: false, says: `${subject} can't be off — only a tool can. Deny it instead.` };
  return moveOf(board, { lines: [{ subject, place: EVERYWHERE }], decision: decisionFor(to.answer), label: EVERYWHERE, place: EVERYWHERE }, "", to);
}

/** A layer's lines with some places written or taken out. A line left with nothing is dropped. */
export function withLinesEdited(lines: Readonly<Record<string, unknown>>, edits: readonly Omit<LineEdit, "layer">[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...lines };
  for (const edit of edits) {
    const key = Object.keys(next).find((each) => (each === OTHER_SUBJECT ? each : normalizeSubject(each)) === edit.subject) ?? edit.subject;
    const was = next[key];
    const flat = { ...(flatOf(was) ?? {}) };
    if (edit.decision === null) delete flat[edit.place];
    else if (edit.place === EVERYWHERE && edit.decision === "unavailable") {
      // Off is the whole line's: no place of it stays.
      for (const place of Object.keys(flat)) delete flat[place];
      flat[EVERYWHERE] = "unavailable";
    } else {
      if (flat[EVERYWHERE] === "unavailable" && edit.place !== EVERYWHERE) delete flat[EVERYWHERE];
      flat[edit.place] = edit.decision;
    }
    if (Object.keys(flat).length === 0) {
      delete next[key];
      continue;
    }
    const mode = modeDeclOfFlat(flat);
    next[key] = isObject(was) && "mode" in was ? { ...was, mode } : mode;
  }
  return next;
}

/** The edits a move makes to one layer. */
export const editsIn = (edits: readonly LineEdit[], layer: string): LineEdit[] => edits.filter((edit) => edit.layer === layer);
