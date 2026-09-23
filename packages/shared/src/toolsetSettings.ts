/**
 * Settings → Toolsets, as data: what every layer holds, and what one layer's pane says about it
 * (decision 0007 §6, and 0006 "Settings shows the third layer").
 *
 * The composer asks "which toolset is this map" and needs only the WINNER of each id
 * ({@link ToolsetChoice}). A settings pane edits one LAYER, so it needs every layer's file kept apart:
 * which one this layer reads, whether the layer states it or only inherits it, what it would fall back
 * to if its override went, and whether a nearer layer hides it. That is {@link ToolsetRecord}, read by
 * `@jaira/persistence` `readToolsetLayers`, and everything below is a pure function of it — main
 * sends the records, the renderer draws them, and both agree because there is one reading.
 */
import { isFunctionMode, type ToolChoice } from "./operationVocabulary";
import { entryOfDecl, parseToolset, type Toolset, type ToolsetDecl } from "./toolsets";
import { sameToolset, toolsetBuckets, toolsetSummary, type ToolsetBucket, type ToolsetChoice } from "./toolsetBuckets";
import { sameToolsetEntry } from "./toolsetEdit";
import type { WorkflowLayer } from "./view";

/** One layer's file for a toolset id. */
export interface ToolsetLayerFile {
  layer: WorkflowLayer;
  /** The file as a person reads it: `.jaira/toolsets/chat/read-only.json`. */
  file: string;
  /** Only a JSON file is edited in place; a YAML one is read, and overridden or replaced by hand. */
  format: "json" | "yaml";
  /** The `$ref` the file starts from, when it has one — an override that keeps following. */
  follows?: string;
  /** The map, references followed. Absent when the file could not be read; `problem` says why. */
  decl?: ToolsetDecl;
  problem?: string;
}

/** One toolset id, and every layer that holds a file for it — NEAREST LAYER FIRST. */
export interface ToolsetRecord {
  /** `<bucket>/<name>` — what follows `$/toolsets/` in a reference. */
  id: string;
  bucket: string;
  name: string;
  files: ToolsetLayerFile[];
}

/** What `toolsets:read` answers: the records, who names each, and what a line can be written for. */
export interface ToolsetsView {
  records: ToolsetRecord[];
  /** Toolset id → the states whose `tools` names it, by state id. See `toolsetUsers` for how. */
  usedBy: Record<string, string[]>;
  /** Every tool a toolset can hold a line for, with what each agent calls its own. */
  tools: ToolChoice[];
  /** The layers this window has, nearest first. No `project` when none is open. */
  layers: WorkflowLayer[];
}

/** The layers, nearest first — the order a bare `$` reference is searched in. */
export const TOOLSET_LAYER_ORDER: readonly WorkflowLayer[] = ["project", "base", "system"];

const depthOf = (layer: WorkflowLayer): number => TOOLSET_LAYER_ORDER.indexOf(layer);

/** One toolset as ONE layer's pane shows it. */
export interface ToolsetAt {
  id: string;
  bucket: string;
  name: string;
  /** The file this layer READS: its own, else the nearest one below it. */
  source: ToolsetLayerFile;
  /** This layer states it — the rail's dot, and what makes Save an edit in place. */
  here: boolean;
  /** What this layer's file overrides: the nearest file below it. Only when `here`. */
  lower?: ToolsetLayerFile;
  /** A NEARER layer holds this id too, so a project reading a bare reference gets that one. */
  shadowedBy?: WorkflowLayer;
}

/**
 * The toolsets a layer's pane lists: everything that layer can SEE — its own files and those of the
 * layers below it. Built in sees only what ships; a project sees all three.
 */
export function toolsetsAt(records: readonly ToolsetRecord[], layer: WorkflowLayer): ToolsetAt[] {
  const out: ToolsetAt[] = [];
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

/** The same toolsets as the bucket hierarchy reads them — what the rail is drawn from. */
export function toolsetChoicesAt(ats: readonly ToolsetAt[]): ToolsetChoice[] {
  return ats.map((at) => ({ id: at.id, bucket: at.bucket, name: at.name, layer: at.source.layer, decl: at.source.decl ?? {} }));
}

/** The rail: every bucket a layer sees, parents before children, each with its toolsets in row order. */
export function toolsetRailOf(ats: readonly ToolsetAt[]): Array<{ bucket: ToolsetBucket; toolsets: ToolsetAt[] }> {
  const byId = new Map(ats.map((at) => [at.id, at]));
  return toolsetBuckets(toolsetChoicesAt(ats)).map((bucket) => ({ bucket, toolsets: bucket.toolsets.map((choice) => byId.get(choice.id)!) }));
}

const OVERRIDES: Readonly<Record<WorkflowLayer, string>> = { system: "overrides built in", base: "overrides all projects", project: "overrides this project" };
const OVERRIDDEN: Readonly<Record<WorkflowLayer, string>> = { project: "overridden in this project", base: "overridden for all projects", system: "overridden" };
const SOURCE: Readonly<Record<WorkflowLayer, string>> = { system: "built in", base: "all projects", project: "this project" };

/**
 * Where a toolset's value comes from, as the pills beside its path say it.
 *
 * `here` is the accent pill — this layer states it, so it can be changed here. Otherwise the pill
 * names the layer that supplies it. A second pill says when a nearer layer hides it, because editing
 * something a project never reads is worth knowing before the edit rather than after.
 */
export function toolsetStanding(at: ToolsetAt): { here: boolean; label: string; shadowed?: string } {
  const label = at.here ? (at.lower !== undefined ? OVERRIDES[at.lower.layer] : SOURCE[at.source.layer]) : SOURCE[at.source.layer];
  return { here: at.here, label, ...(at.shadowedBy !== undefined ? { shadowed: OVERRIDDEN[at.shadowedBy] } : {}) };
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

/** Unsaved edits, by toolset id. Kept per toolset so that looking at another one loses nothing. */
export type ToolsetDrafts = Readonly<Record<string, Toolset>>;

/** The toolset a pane opens a record's source as. A file that could not be read opens empty. */
export function toolsetOfAt(at: ToolsetAt): Toolset {
  return parseToolset(at.source.decl ?? {}).toolset;
}

/** Has this toolset been edited and not saved? A draft that says what is saved is not one. */
export function isToolsetDirty(at: ToolsetAt, draft: Toolset | undefined): boolean {
  return draft !== undefined && !sameToolset(toolsetOfAt(at), draft);
}

/** The line under a toolset's name in the rail. It follows the draft, and says so. */
export function toolsetRailSummary(at: ToolsetAt, draft?: Toolset): string {
  if (at.source.decl === undefined) return "could not be read";
  return isToolsetDirty(at, draft) ? `unsaved · ${toolsetSummary(draft!)}` : toolsetSummary(toolsetOfAt(at));
}

/**
 * The toolset that is actually open, given the one that was asked for.
 *
 * One just added or overridden is not in the records until the write lands and they are read again —
 * `pending` names it, and the view stays where it is rather than jumping to another toolset and back.
 * One that is simply gone (reset, deleted by hand, a different layer) falls to the first.
 */
export function resolveToolsetChoice(ats: readonly ToolsetAt[], wanted: string | undefined, pending?: string | null): string | undefined {
  if (wanted !== undefined && (ats.some((at) => at.id === wanted) || wanted === pending)) return wanted;
  return toolsetRailOf(ats)[0]?.toolsets[0]?.id ?? ats[0]?.id;
}

// --- compare with what ships -----------------------------------------------------

export interface ToolsetDifference {
  subject: string;
  /** The entry as the lower layer has it, in a word (`allow`, `ask · native`). Absent ⇒ it has no such line. */
  theirs?: string;
  /** The entry as this layer has it. Absent ⇒ this layer took the line out. */
  ours?: string;
}

function entryWords(entry: ToolsetDecl[string]): string {
  const { mode, implementation } = entryOfDecl(entry);
  const word = isFunctionMode(mode) ? `function ${mode.function}` : mode;
  return implementation === "native" ? `${word} · native` : word;
}

/** Every line on which two maps differ, `theirs` order first — what "Compare with what ships" lists. */
export function compareToolsets(theirs: ToolsetDecl, ours: ToolsetDecl): ToolsetDifference[] {
  const out: ToolsetDifference[] = [];
  for (const subject of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
    const a = Object.hasOwn(theirs, subject) ? theirs[subject] : undefined;
    const b = Object.hasOwn(ours, subject) ? ours[subject] : undefined;
    if (sameToolsetEntry(subject, a, b)) continue;
    out.push({ subject, ...(a !== undefined ? { theirs: entryWords(a) } : {}), ...(b !== undefined ? { ours: entryWords(b) } : {}) });
  }
  return out;
}

// --- what a write will do ------------------------------------------------------------

/** What a save does to the file, said before it happens. */
export type ToolsetWriteKind =
  /** The layer holds the file: it is edited in place. */
  | "edit"
  /** The layer does not: an override is created that keeps following the lower layer's. */
  | "override"
  /** A line the lower layer holds was taken out, which an override cannot say: the file stops following. */
  | "detach"
  /** No layer below holds it: a new file. */
  | "create";
