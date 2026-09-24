/**
 * Settings → Permission sets, as data: what every layer holds, and what one layer's pane says about it
 * (decision 0007 §6, and 0006 "Settings shows the third layer").
 *
 * The composer asks "which permission set is this map" and needs only the WINNER of each id
 * ({@link PermissionSetChoice}). A settings pane edits one LAYER, so it needs every layer's file kept apart:
 * which one this layer reads, whether the layer states it or only inherits it, what it would fall back
 * to if its override went, and whether a nearer layer hides it. That is {@link PermissionSetRecord}, read by
 * `@jaira/persistence` `readPermissionSetLayers`, and everything below is a pure function of it — main
 * sends the records, the renderer draws them, and both agree because there is one reading.
 */
import { isFunctionMode, type ToolChoice } from "./operationVocabulary";
import { entryOfDecl, parsePermissionSet, type PermissionSet, type PermissionSetDecl } from "./permissionSets";
import { samePermissionSet, permissionSetBuckets, permissionSetSummary, type PermissionSetBucket, type PermissionSetChoice } from "./permissionSetBuckets";
import { samePermissionSetEntry } from "./permissionSetEdit";
import type { WorkflowLayer } from "./view";

/** One layer's file for a permission set id. */
export interface PermissionSetLayerFile {
  layer: WorkflowLayer;
  /** The file as a person reads it: `.jaira/permission-sets/chat/read-only.json`. */
  file: string;
  /** Only a JSON file is edited in place; a YAML one is read, and overridden or replaced by hand. */
  format: "json" | "yaml";
  /** The `$ref` the file starts from, when it has one — an override that keeps following. */
  follows?: string;
  /** The map, references followed. Absent when the file could not be read; `problem` says why. */
  decl?: PermissionSetDecl;
  problem?: string;
}

/** One permission set id, and every layer that holds a file for it — NEAREST LAYER FIRST. */
export interface PermissionSetRecord {
  /** `<bucket>/<name>` — what follows `$/permission-sets/` in a reference. */
  id: string;
  bucket: string;
  name: string;
  files: PermissionSetLayerFile[];
}

/** What `permissionSets:read` answers: the records, who names each, and what a line can be written for. */
export interface PermissionSetsView {
  records: PermissionSetRecord[];
  /** Permission set id → the states whose `tools` names it, by state id. See `permissionSetUsers` for how. */
  usedBy: Record<string, string[]>;
  /** Every tool a permission set can hold a line for, with what each agent calls its own. */
  tools: ToolChoice[];
  /** The layers this window has, nearest first. No `project` when none is open. */
  layers: WorkflowLayer[];
}

/** The layers, nearest first — the order a bare `$` reference is searched in. */
export const PERMISSION_SET_LAYER_ORDER: readonly WorkflowLayer[] = ["project", "base", "system"];

/** A layer's root as a person reads it, the start of {@link PermissionSetLayerFile.file}. */
export const PERMISSION_SET_ROOT_LABELS: Readonly<Record<WorkflowLayer, string>> = { project: ".jaira", base: "~/.jaira", system: "built in" };

/** The file a layer holds `id` in, or would once written — `~/.jaira/permission-sets/chat/ask-first.json`. */
export function permissionSetFileLabel(layer: WorkflowLayer, id: string): string {
  return `${PERMISSION_SET_ROOT_LABELS[layer]}/permission-sets/${id}.json`;
}

const depthOf = (layer: WorkflowLayer): number => PERMISSION_SET_LAYER_ORDER.indexOf(layer);

/** One permission set as ONE layer's pane shows it. */
export interface PermissionSetAt {
  id: string;
  bucket: string;
  name: string;
  /** The file this layer READS: its own, else the nearest one below it. */
  source: PermissionSetLayerFile;
  /** This layer states it — the rail's dot, and what makes Save an edit in place. */
  here: boolean;
  /** What this layer's file overrides: the nearest file below it. Only when `here`. */
  lower?: PermissionSetLayerFile;
  /** A NEARER layer holds this id too, so a project reading a bare reference gets that one. */
  shadowedBy?: WorkflowLayer;
}

/**
 * The permission sets a layer's pane lists: everything that layer can SEE — its own files and those of the
 * layers below it. Built in sees only what ships; a project sees all three.
 */
export function permissionSetsAt(records: readonly PermissionSetRecord[], layer: WorkflowLayer): PermissionSetAt[] {
  const out: PermissionSetAt[] = [];
  for (const record of records) {
    const visible = record.files.filter((file) => depthOf(file.layer) >= depthOf(layer)).sort((a, b) => depthOf(a.layer) - depthOf(b.layer));
    const source = visible[0];
    if (source === undefined) continue;
    const here = source.layer === layer;
    const nearer = record.files.filter((file) => depthOf(file.layer) < depthOf(layer)).sort((a, b) => depthOf(a.layer) - depthOf(b.layer))[0];
    out.push({
      id: record.id,
      bucket: record.bucket,
      name: record.name,
      source,
      here,
      ...(here && visible[1] !== undefined ? { lower: visible[1] } : {}),
      ...(nearer !== undefined ? { shadowedBy: nearer.layer } : {}),
    });
  }
  return out;
}

/** The same permission sets as the bucket hierarchy reads them — what the rail is drawn from. */
export function permissionSetChoicesAt(ats: readonly PermissionSetAt[]): PermissionSetChoice[] {
  return ats.map((at) => ({ id: at.id, bucket: at.bucket, name: at.name, layer: at.source.layer, decl: at.source.decl ?? {} }));
}

/** The rail: every bucket a layer sees, parents before children, each with its permission sets in row order. */
export function permissionSetRailOf(ats: readonly PermissionSetAt[]): Array<{ bucket: PermissionSetBucket; permissionSets: PermissionSetAt[] }> {
  const byId = new Map(ats.map((at) => [at.id, at]));
  return permissionSetBuckets(permissionSetChoicesAt(ats)).map((bucket) => ({ bucket, permissionSets: bucket.permissionSets.map((choice) => byId.get(choice.id)!) }));
}

const OVERRIDDEN: Readonly<Record<WorkflowLayer, string>> = { project: "overridden in this project", base: "overridden for all projects", system: "overridden" };
const SOURCE: Readonly<Record<WorkflowLayer, string>> = { system: "built in", base: "all projects", project: "this project" };
/** A layer as the head of a COPY names the one holding it: `shared · copied from built in`. */
const HOLDER: Readonly<Record<WorkflowLayer, string>> = { system: "built in", base: "shared", project: "this project" };
/** …and the one it was copied from. `Shared` is the switch's own word for the layer. */
const COPIED_FROM: Readonly<Record<WorkflowLayer, string>> = { system: "built in", base: "Shared", project: "this project" };

/**
 * Where a permission set's value comes from, as the pills beside its path say it.
 *
 * `here` is the accent pill — this layer states it, so it can be changed here. A layer's file over a
 * lower one is a COPY of it (the first change to a set a layer only sees writes one, round 5), and
 * says which: `shared · copied from built in`, `this project · copied from Shared`. Otherwise the pill
 * names the layer that supplies it. A second pill says when a nearer layer hides it, because editing
 * something a project never reads is worth knowing before the edit rather than after.
 */
export function permissionSetStanding(at: PermissionSetAt): { here: boolean; label: string; shadowed?: string } {
  const from = copiedFrom(at);
  const label = from !== undefined ? `${HOLDER[at.source.layer]} · copied from ${COPIED_FROM[from]}` : SOURCE[at.source.layer];
  return { here: at.here, label, ...(at.shadowedBy !== undefined ? { shadowed: OVERRIDDEN[at.shadowedBy] } : {}) };
}

/**
 * The layer this layer's file was copied from — the nearest one below that holds the id — or nothing
 * when the layer states no file of it, or the only one there is.
 *
 * Decided by WHERE the files are and not by whether the copy still `$ref`s the lower one: a copy that
 * took a line out had to stop following (`detach`), and is no less a copy of what ships for that.
 */
export function copiedFrom(at: PermissionSetAt): WorkflowLayer | undefined {
  return at.here ? at.lower?.layer : undefined;
}

/**
 * How many lines of a copy say something other than what it was copied from — the head's
 * `1 line differs from what ships`. Counted on the RESOLVED maps, so a line an override repeats
 * unchanged is not a difference and a line a detached copy took out is one. Absent where the set is
 * no copy, or either file could not be read.
 */
export function copyDifferences(at: PermissionSetAt): number | undefined {
  if (copiedFrom(at) === undefined || at.source.decl === undefined || at.lower?.decl === undefined) return undefined;
  return comparePermissionSets(at.lower.decl, at.source.decl).length;
}

/**
 * The same change, made to another map: every line on which `to` differs from `from` is set (or taken
 * out) in `onto`, and every other line of `onto` is left as it says.
 *
 * What a change made on the personal layer is, once the person says where it goes. That layer holds
 * no permission sets (it is one settings file, and a set is a file of its own), so the card there shows
 * what the NEAREST layer says; the layer chosen may say something else, and copying the whole map
 * shown would write that nearer layer's lines into it along with the one line that was changed.
 */
export function rebasePermissionSetChange(from: PermissionSetDecl, to: PermissionSetDecl, onto: PermissionSetDecl): PermissionSetDecl {
  const out: PermissionSetDecl = { ...onto };
  for (const subject of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const was = Object.hasOwn(from, subject) ? from[subject] : undefined;
    const is = Object.hasOwn(to, subject) ? to[subject] : undefined;
    if (samePermissionSetEntry(subject, was, is)) continue;
    if (is === undefined) delete out[subject];
    else out[subject] = is;
  }
  return out;
}

/** `used by sync/review and 18 more states`, or that nothing names it. */
export function usedByLine(states: readonly string[] | undefined): string {
  const list = states ?? [];
  if (list.length === 0) return "no state names it";
  if (list.length === 1) return `used by ${list[0]!}`;
  if (list.length === 2) return `used by ${list[0]!} and ${list[1]!}`;
  return `used by ${list[0]!} and ${list.length - 1} more states`;
}

// --- drafts ------------------------------------------------------------------

/** Unsaved edits, by permission set id. Kept per permission set so that looking at another one loses nothing. */
export type PermissionSetDrafts = Readonly<Record<string, PermissionSet>>;

/** The permission set a pane opens a record's source as. A file that could not be read opens empty. */
export function permissionSetOfAt(at: PermissionSetAt): PermissionSet {
  return parsePermissionSet(at.source.decl ?? {}).permissionSet;
}

/** Has this permission set been edited and not saved? A draft that says what is saved is not one. */
export function isPermissionSetDirty(at: PermissionSetAt, draft: PermissionSet | undefined): boolean {
  return draft !== undefined && !samePermissionSet(permissionSetOfAt(at), draft);
}

/** The line under a permission set's name in the rail. It follows the draft, and says so. */
export function permissionSetRailSummary(at: PermissionSetAt, draft?: PermissionSet): string {
  if (at.source.decl === undefined) return "could not be read";
  return isPermissionSetDirty(at, draft) ? `unsaved · ${permissionSetSummary(draft!)}` : permissionSetSummary(permissionSetOfAt(at));
}

/**
 * The permission set that is actually open, given the one that was asked for.
 *
 * One just added or overridden is not in the records until the write lands and they are read again —
 * `pending` names it, and the view stays where it is rather than jumping to another permission set and back.
 * One that is simply gone (reset, deleted by hand, a different layer) falls to the first.
 */
export function resolvePermissionSetChoice(ats: readonly PermissionSetAt[], wanted: string | undefined, pending?: string | null): string | undefined {
  if (wanted !== undefined && (ats.some((at) => at.id === wanted) || wanted === pending)) return wanted;
  return permissionSetRailOf(ats)[0]?.permissionSets[0]?.id ?? ats[0]?.id;
}

// --- compare with what ships -----------------------------------------------------

export interface PermissionSetDifference {
  subject: string;
  /** The entry as the lower layer has it, in a word (`allow`, `ask · native`). Absent ⇒ it has no such line. */
  theirs?: string;
  /** The entry as this layer has it. Absent ⇒ this layer took the line out. */
  ours?: string;
}

function entryWords(entry: PermissionSetDecl[string]): string {
  const { mode, implementation } = entryOfDecl(entry);
  const word = isFunctionMode(mode) ? `function ${mode.function}` : mode;
  return implementation === "native" ? `${word} · native` : word;
}

/** Every line on which two maps differ, `theirs` order first — what "Compare with what ships" lists. */
export function comparePermissionSets(theirs: PermissionSetDecl, ours: PermissionSetDecl): PermissionSetDifference[] {
  const out: PermissionSetDifference[] = [];
  for (const subject of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
    const a = Object.hasOwn(theirs, subject) ? theirs[subject] : undefined;
    const b = Object.hasOwn(ours, subject) ? ours[subject] : undefined;
    if (samePermissionSetEntry(subject, a, b)) continue;
    out.push({ subject, ...(a !== undefined ? { theirs: entryWords(a) } : {}), ...(b !== undefined ? { ours: entryWords(b) } : {}) });
  }
  return out;
}

// --- what a write will do ------------------------------------------------------------

/** What a save does to the file, said before it happens. */
export type PermissionSetWriteKind =
  /** The layer holds the file: it is edited in place. */
  | "edit"
  /** The layer does not: an override is created that keeps following the lower layer's. */
  | "override"
  /** A line the lower layer holds was taken out, which an override cannot say: the file stops following. */
  | "detach"
  /** No layer below holds it: a new file. */
  | "create";
