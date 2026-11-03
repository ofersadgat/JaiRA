/**
 * The composer's permission STACK (decision 0023 §4.1, rulings 8–11; §7.4): the Permissions chip as
 * one joined segment per layer, oldest to newest — `chat/ask-first ⌄` · `app/build` · `tools · 9 · 3` ·
 * `+` — and everything a segment opens onto, worked out here, pure. The run's answers are no segment of
 * their own: the tools segment counts them, and the Tools card marks each on the line it is about
 * (2026-11-03). `ComposerStack.tsx` draws it; `composerStackHost.ts` reads what it needs from the engine.
 *
 * What a conversation's settings hold is the stack FORM ({@link StackForm}, `ChatSettings.permissionSet`
 * in its stack shape): `layers` oldest first — the bottom (a preset, usually) first — and the TOOLS
 * layer's own lines beside them. The bucket's standing layers come from settings and the run's answers
 * from memory; neither is written there. The Tools card draws what the whole stack comes to and writes
 * back only what differs from the layers under it ({@link toolsWriteOf}, `toolsLayerOf`).
 */
import {
  bucketOfSetId,
  chatStackSettingsOf,
  composePermissionSetLayers,
  layerIdOf,
  ownLinesOf,
  parsePermissionSet,
  permissionSetIdOf,
  PERMISSION_SET_LAYERS_KEY,
  PERMISSION_SET_REF_KEY,
  TOOLS_LAYER,
  toolsLayerOf,
  type ChatSettings,
  type JairaUiState,
  type PermissionSet,
  type PermissionSetScope,
  type PermissionSetTree,
  type PermissionSetTreeBucket,
  type PermissionSetTreeScope,
  type PermissionSetTreeSet,
  type PermissionStackView,
  type PermissionStackViewLayer,
  type SavePermissionStackRequest,
  type WritableLayer,
} from "@jaira/shared/browser";
import type { ChipStep, ChipWidths } from "./composerModel";
import { modeOf } from "./uiState";

// --- the form a conversation keeps ---------------------------------------------------------------

/** A conversation's stack as its settings keep it (§2.6): its own layers and its tools layer's lines. */
export interface StackForm {
  /** References, oldest first: `layers[0]` the bottom — usually a preset — and the rest the conversation's own (§2.6 step 3). */
  layers: string[];
  /**
   * The tools layer's own lines (§2.6 step 5). `undefined` while nothing is chosen here: the stack is
   * the state's, and what it comes to IS the map the state's declaration arrives as.
   */
  tools: Record<string, unknown> | undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The stack a composer's settings name. A `permissionSet` of the stack shape is read as written (a
 * `$ref` copy reads as its one layer); a map with neither is a stack of its tools layer alone. With no
 * `permissionSet` the state's declaration stands, and its stack is the set the state names — its
 * `source` when that is a set file, else the bottom of the stack it was lowered from — with no lines of
 * the conversation's own.
 */
export function stackFormOf(settings: ChatSettings): StackForm {
  const node = settings.permissionSet as unknown;
  if (typeof node === "string") return { layers: [node], tools: {} };
  if (isPlainObject(node)) {
    const listed = node[PERMISSION_SET_LAYERS_KEY];
    const reference = node[PERMISSION_SET_REF_KEY];
    const layers = Array.isArray(listed) ? listed.filter((each): each is string => typeof each === "string") : [];
    return { layers: typeof reference === "string" ? [reference, ...layers] : layers, tools: ownLinesOf(node) };
  }
  const block = settings.permissions;
  const source = block?.source;
  const bottom = source !== undefined && permissionSetIdOf(source) !== undefined ? source : block?.stack?.layers.find((layer) => layer.reference !== undefined && permissionSetIdOf(layer.reference) !== undefined)?.reference;
  return { layers: bottom !== undefined ? [bottom] : [], tools: undefined };
}

/** The settings a form is kept as — `ChatSettings.permissionSet`'s stack shape. */
export function stackSettingsOf(form: StackForm): Record<string, unknown> {
  return chatStackSettingsOf(form.layers, form.tools ?? {});
}

/** What the layers UNDER the tools layer are asked as: the form's layers, and no lines. */
export function belowRequestOf(form: StackForm): Record<string, unknown> {
  return chatStackSettingsOf(form.layers, {});
}

/** The merged map a stack view comes to, as an author would write it — `unavailable` lines and all. */
export function declOfView(view: Pick<PermissionStackView, "lines">): Record<string, unknown> {
  return Object.fromEntries(view.lines.map((line) => [line.subject, line.value]));
}

/**
 * What the stack comes to — the map the Tools card draws: the layers below and the tools layer's own
 * lines, merged as every stack is (`composePermissionSetLayers`). A form with no lines of its own is
 * the state's `inherited` map.
 */
export function effectiveMapOf(form: StackForm, below: Record<string, unknown> | undefined, inherited: PermissionSet): PermissionSet {
  if (form.tools === undefined) return inherited;
  return composePermissionSetLayers([
    { id: "below", decl: below ?? {} },
    { id: TOOLS_LAYER, decl: form.tools },
  ]).permissionSet;
}

/** The set the layers below the tools layer come to — what the Tools card's lines are written against. */
export function belowSetOf(below: Record<string, unknown> | undefined): PermissionSet {
  return composePermissionSetLayers([{ id: "below", decl: below ?? {} }]).permissionSet;
}

/**
 * A form the conversation OWNS, ready to be edited: an inherited one takes, as its tools layer, what
 * the state's map says beyond the stack under it — nothing, for a state that names a set and no more.
 */
export function ownedFormOf(form: StackForm, below: PermissionSet, inherited: PermissionSet): StackForm {
  return form.tools !== undefined ? form : { layers: [...form.layers], tools: toolsLayerOf(below, inherited) };
}

/** What the Tools card writes (§2.6 step 5, ruling 8): the stack's layers as they are, and the lines that make them come to `next`. */
export function toolsWriteOf(form: StackForm, below: PermissionSet, next: PermissionSet): StackForm {
  // A line is written only where it differs from below — so over nothing, the whole map is the layer.
  return { layers: [...form.layers], tools: toolsLayerOf(below, next) };
}

// --- a layer's edits ----------------------------------------------------------------------------

/** Swap the layer at `index` for `reference` — the crumb's pick, "Use as this layer". */
export function withLayerSwapped(form: StackForm, index: number, reference: string): StackForm {
  if (index < 0 || index >= form.layers.length) return form;
  return { ...form, layers: form.layers.map((each, i) => (i === index ? reference : each)) };
}

/** Lay `reference` on top of the conversation's layers (`+`): newest of them, under the run's answers and the tools. */
export function withLayerAdded(form: StackForm, reference: string): StackForm {
  return { ...form, layers: [...form.layers, reference] };
}

/** Move the layer at `index` one earlier (−1) or later (+1). Moving the bottom later makes the next one the bottom — two presets stack like any two layers (§2.6). */
export function withLayerMoved(form: StackForm, index: number, by: -1 | 1): StackForm {
  const to = index + by;
  if (index < 0 || index >= form.layers.length || to < 0 || to >= form.layers.length) return form;
  const layers = [...form.layers];
  [layers[index], layers[to]] = [layers[to]!, layers[index]!];
  return { ...form, layers };
}

/** Take the layer at `index` out of the stack. */
export function withLayerRemoved(form: StackForm, index: number): StackForm {
  if (index < 0 || index >= form.layers.length) return form;
  return { ...form, layers: form.layers.filter((_, i) => i !== index) };
}

// --- the segments --------------------------------------------------------------------------------

/** One layer's segment: a permission set, named by its full id (its bucket belongs to it, ruling 8). */
export interface LayerSegment {
  kind: "layer";
  key: string;
  /** `chat/ask-first`, `app/build` — the set file the segment is. */
  id: string;
  /** What the stack names it by: the conversation's reference, or the standing layer's in settings. */
  reference: string | undefined;
  scope: PermissionSetScope | undefined;
  role: PermissionStackViewLayer["role"];
  icon: string;
  /** How many lines its file writes itself. */
  lines: number;
  /** Where it is in the form's `layers` — absent for a standing layer, which settings keep. */
  index: number | undefined;
}

export type StackSegment =
  | LayerSegment
  | { kind: "fold"; key: "fold"; layers: LayerSegment[] }
  /** `count`: the tools offered; `runtime`: the answers this run gave, marked on the lines they are about. */
  | { kind: "tools"; key: "tools"; count: number; runtime: number }
  | { kind: "add"; key: "add" };

/**
 * The layers' segments, oldest first, from the stack as the engine composed it — or, until it has, from
 * the form alone. A file built of layers is several layers of the view and ONE segment (the layers it
 * was reached through share a `via`); a standing layer is a segment of its own, with no place in the
 * form. The tools layer is a segment of its own kind, and the run's answers ride on it ({@link segmentsOf}).
 */
export function layerSegmentsOf(view: Pick<PermissionStackView, "layers"> | null | undefined, form: StackForm): LayerSegment[] {
  if (view === null || view === undefined) {
    return form.layers.map((reference, index) => ({
      kind: "layer",
      key: `layer:${index}:${reference}`,
      id: layerIdOf(reference),
      reference,
      scope: scopeOfReference(reference),
      role: index === 0 ? "bottom" : "named",
      icon: "layers",
      lines: 0,
      index,
    }));
  }
  const groups: PermissionStackViewLayer[][] = [];
  for (const layer of view.layers) {
    if (layer.role === "runtime" || layer.role === "own") continue;
    const last = groups.at(-1)?.at(-1);
    if (last !== undefined && last.role === layer.role && last.via !== undefined && last.via === layer.via) groups.at(-1)!.push(layer);
    else groups.push([layer]);
  }
  // Each of the conversation's layers in order, matched to the form by what it names.
  let next = 0;
  return groups.map((group, at) => {
    const file = group.at(-1)!;
    const reference = file.via ?? file.reference;
    let index: number | undefined;
    if (file.role !== "standing") {
      const found = form.layers.findIndex((each, i) => i >= next && (each === reference || layerIdOf(each) === file.id));
      if (found >= 0) {
        index = found;
        next = found + 1;
      }
    }
    return { kind: "layer", key: `layer:${at}:${reference ?? file.id}`, id: file.id, reference, scope: file.scope, role: file.role, icon: file.icon, lines: file.lines, index };
  });
}

/** Where a reference's root says a set lives, before the engine has said. */
function scopeOfReference(reference: string): PermissionSetScope | undefined {
  if (reference.startsWith("$SYSTEM/")) return "built in";
  if (reference.startsWith("$BASE/")) return "global";
  if (reference.startsWith("$JAIRA/") || reference.startsWith("$PROJECT/")) return "project";
  return undefined;
}

/** Whether the middle of a stack can fold: it keeps its first layer, so a fold needs two more to be worth one. */
export function foldableOf(layers: readonly LayerSegment[]): boolean {
  return layers.length >= 3;
}

/**
 * The bar: the layers, oldest first, then `tools` and `+` (§4.1). Folded, it keeps its first layer and
 * folds the rest into `⋯ {n}` (§7.4) — when there is a middle to fold.
 */
export function segmentsOf(layers: readonly LayerSegment[], tools: number, runtime: number, folded: boolean): StackSegment[] {
  const tail: StackSegment[] = [
    { kind: "tools", key: "tools", count: tools, runtime },
    { kind: "add", key: "add" },
  ];
  if (!folded || !foldableOf(layers)) return [...layers, ...tail];
  return [layers[0]!, { kind: "fold", key: "fold", layers: layers.slice(1) }, ...tail];
}

/** A segment's words. The tools segment's run answers are drawn beside its words, in --accent ({@link runtimeMarkOf}). */
export function segmentWordsOf(segment: StackSegment): string {
  switch (segment.kind) {
    case "layer":
      return segment.id;
    case "fold":
      return `⋯ ${segment.layers.length}`;
    case "tools":
      return `tools · ${segment.count}`;
    case "add":
      return "+";
  }
}

/** The run's answers on the tools segment, when it has any: `· 3`. */
export function runtimeMarkOf(segment: StackSegment): string | null {
  return segment.kind === "tools" && segment.runtime > 0 ? `· ${segment.runtime}` : null;
}

/**
 * The stack COLLAPSED (2026-11-03), for a composer too narrow for its segments: the shield, the bottom
 * layer's icon, and `+{n}` — the layers over the bottom, and one more when the conversation has changed
 * something of its own (tools lines, or answers this run gave). Pressed, it opens the whole stack.
 */
export interface CollapsedStack {
  /** The bottom layer's icon, when there is a bottom layer. */
  icon: string | undefined;
  /** How much is on top of the bottom: `0` draws no count. */
  more: number;
  /** Its tooltip: everything the count stands for. */
  title: string;
}

export function collapsedOf(layers: readonly LayerSegment[], ownLines: number, runtime: number): CollapsedStack {
  const over = Math.max(0, layers.length - 1);
  const changed = ownLines > 0 || runtime > 0;
  const said = [
    layers[0] !== undefined ? layers[0].id : "no layer",
    ...(over > 0 ? [`${over} more ${over === 1 ? "layer" : "layers"}: ${layers.slice(1).map((layer) => layer.id).join(" · ")}`] : []),
    ...(ownLines > 0 ? [`${ownLines} ${ownLines === 1 ? "line" : "lines"} of this conversation's own`] : []),
    ...(runtime > 0 ? [`${runtime} ${runtime === 1 ? "answer" : "answers"} from this run`] : []),
  ];
  return { icon: layers[0]?.icon, more: over + (changed ? 1 : 0), title: `Permissions: ${said.join("; ")}` };
}

/** The count a collapsed stack draws: `+2`, or nothing. */
export function collapsedWordsOf(collapsed: CollapsedStack): string | null {
  return collapsed.more > 0 ? `+${collapsed.more}` : null;
}

/** A segment's tooltip. */
export function segmentTitleOf(segment: StackSegment): string {
  switch (segment.kind) {
    case "layer":
      return `${segment.id}${segment.scope !== undefined ? ` · ${segment.scope}` : ""}${segment.role === "standing" ? " · pinned to this project" : ""} — adjust this layer`;
    case "fold":
      return `${segment.layers.length} more layers: ${segment.layers.map((layer) => layer.id).join(" · ")}`;
    case "tools":
      return `tools: ${segment.count} offered — this conversation's own lines${segment.runtime > 0 ? `; ${segment.runtime === 1 ? "one answer" : `${segment.runtime} answers`} from this run, marked on the lines they are about` : ""}`;
    case "add":
      return "Lay a permission set on top";
  }
}

/** The widths of the stack, drawn: all of it, folded, and collapsed to the shield. */
export interface StackWidths {
  full: number;
  folded: number;
  collapsed: number;
}

/** How the stack is drawn: every segment, the middle folded, or collapsed to the shield ({@link collapsedOf}). */
export type StackLook = "whole" | "folded" | "collapsed";

/**
 * Which step the foot's words are at, and how the stack is drawn — the first that fits `room`, in order:
 * every word with the stack whole; every word, the stack folded; shorter words; shorter words with the
 * stack collapsed to the shield; the model's name and icons; icons alone. `chips` are the chips before
 * the stack (the model's and Thinking's), `gap` apart; the live note's words go with them while they
 * have words.
 */
export function footFitOf(room: number, chips: readonly ChipWidths[], stack: StackWidths, gap: number, noteWords = 0): { step: ChipStep; look: StackLook } {
  const chipsAt = (step: ChipStep): number => chips.reduce((sum, chip, i) => sum + (step === 0 ? chip.full : step === 1 ? chip.short : step === 2 && i === 0 ? chip.short : chip.icon), 0);
  const stackAt: Record<StackLook, number> = { whole: stack.full, folded: stack.folded, collapsed: stack.collapsed };
  const width = (step: ChipStep, look: StackLook): number => chipsAt(step) + gap * chips.length + stackAt[look] + (step <= 1 ? noteWords : 0);
  const tries: Array<{ step: ChipStep; look: StackLook }> = [
    { step: 0, look: "whole" },
    { step: 0, look: "folded" },
    { step: 1, look: "folded" },
    { step: 1, look: "collapsed" },
    { step: 2, look: "collapsed" },
  ];
  for (const each of tries) if (width(each.step, each.look) <= room) return each;
  return { step: 3, look: "collapsed" };
}

// --- browsing the sets: crumbs and the tree -------------------------------------------------------

/** Where in the tree: a scope, a bucket path in it (`""` at the scope's top), and a set, by id. */
export interface TreeAt {
  scope: PermissionSetScope;
  bucket: string;
  set?: string;
}

/** A scope as the browser names it. */
export const SCOPE_WORDS: Readonly<Record<string, { name: string; hint: string; icon: string }>> = {
  "built in": { name: "Built in", hint: "what ships", icon: "system" },
  global: { name: "Global", hint: "~/.jaira", icon: "web" },
  project: { name: "Project", hint: ".jaira", icon: "folder" },
  runtime: { name: "Runtime", hint: "this task", icon: "clock" },
};

/** The scopes a layer can be picked from: the set FILES' (the runtime scope is this task's answers, which are no file). */
export function browsableScopes(tree: PermissionSetTree): PermissionSetTreeScope[] {
  return tree.scopes.filter((scope) => scope.scope !== "runtime");
}

function bucketAt(scope: PermissionSetTreeScope, path: string): PermissionSetTreeBucket | undefined {
  let found: PermissionSetTreeBucket | undefined;
  let level = scope.buckets;
  for (const part of path.split("/").filter((each) => each !== "")) {
    found = level.find((bucket) => bucket.name === part);
    if (found === undefined) return undefined;
    level = found.buckets;
  }
  return found;
}

/** One thing a crumb's menu offers: a scope, a bucket or a set. */
export interface CrumbChoice {
  key: string;
  kind: "scope" | "bucket" | "set";
  label: string;
  hint?: string;
  icon: string;
  at: TreeAt;
  set?: PermissionSetTreeSet;
}

const setChoice = (scope: PermissionSetScope, set: PermissionSetTreeSet): CrumbChoice => ({
  key: `set:${scope}:${set.id}`,
  kind: "set",
  label: `${set.name}.json`,
  hint: `${set.lines} ${set.lines === 1 ? "line" : "lines"}${set.inStack ? " · in the stack" : ""}${set.shadowedBy !== undefined ? ` · ${set.shadowedBy} has its own` : ""}${set.problem !== undefined ? ` · ${set.problem}` : ""}`,
  icon: set.icon,
  at: { scope, bucket: set.bucket, set: set.id },
  set,
});

const bucketChoice = (scope: PermissionSetScope, bucket: PermissionSetTreeBucket): CrumbChoice => {
  const sets = bucket.sets.length;
  const inner = bucket.buckets.length;
  return {
    key: `bucket:${scope}:${bucket.path}`,
    kind: "bucket",
    label: bucket.name,
    hint: inner > 0 ? `${sets} ${sets === 1 ? "set" : "sets"}, and ${inner} inside` : `${sets} ${sets === 1 ? "set" : "sets"}`,
    icon: "folder",
    at: { scope, bucket: bucket.path },
  };
};

/** What is IN a place of the tree — a scope's buckets, or a bucket's buckets and then its sets. */
export function childrenOf(tree: PermissionSetTree, at: Pick<TreeAt, "scope" | "bucket">): CrumbChoice[] {
  const scope = browsableScopes(tree).find((each) => each.scope === at.scope);
  if (scope === undefined) return [];
  if (at.bucket === "") return [...scope.buckets.map((bucket) => bucketChoice(scope.scope, bucket)), ...scope.sets.map((set) => setChoice(scope.scope, set))];
  const bucket = bucketAt(scope, at.bucket);
  if (bucket === undefined) return [];
  return [...bucket.buckets.map((inner) => bucketChoice(scope.scope, inner)), ...bucket.sets.map((set) => setChoice(scope.scope, set))];
}

/** The scopes, as the first crumb's menu offers them. */
export function scopeChoicesOf(tree: PermissionSetTree): CrumbChoice[] {
  return browsableScopes(tree).map((scope) => {
    const words = SCOPE_WORDS[scope.scope] ?? { name: scope.scope, hint: scope.label, icon: "folder" };
    return { key: `scope:${scope.scope}`, kind: "scope", label: words.name, hint: words.hint, icon: words.icon, at: { scope: scope.scope, bucket: "" } };
  });
}

/** One crumb of a set's path: what it says, and what sits beside it — its menu. */
export interface Crumb {
  key: string;
  kind: "scope" | "bucket" | "set";
  label: string;
  /** The crumb's siblings, itself among them. */
  siblings: CrumbChoice[];
  /** The sibling the crumb is. */
  on: string | undefined;
}

/**
 * A set's path as crumbs that are pickers (§4.1): `Built in › chat › ask-first.json`. The scope's crumb
 * lists the scopes, a bucket's lists the buckets beside it, and the set's the sets of its bucket — so
 * swapping `ask-first` for `read-only` is two presses. With no set chosen yet the last crumb is
 * `choose a set` over the bucket's sets.
 */
export function crumbsOf(tree: PermissionSetTree, at: TreeAt): Crumb[] {
  const scopeWords = SCOPE_WORDS[at.scope];
  const crumbs: Crumb[] = [{ key: `scope:${at.scope}`, kind: "scope", label: scopeWords?.name ?? at.scope, siblings: scopeChoicesOf(tree), on: `scope:${at.scope}` }];
  const parts = at.bucket.split("/").filter((each) => each !== "");
  parts.forEach((part, i) => {
    const parent = parts.slice(0, i).join("/");
    const path = parts.slice(0, i + 1).join("/");
    crumbs.push({ key: `bucket:${at.scope}:${path}`, kind: "bucket", label: part, siblings: childrenOf(tree, { scope: at.scope, bucket: parent }).filter((choice) => choice.kind === "bucket"), on: `bucket:${at.scope}:${path}` });
  });
  const sets = childrenOf(tree, at).filter((choice) => choice.kind === "set");
  const set = at.set !== undefined ? sets.find((choice) => choice.set?.id === at.set) : undefined;
  crumbs.push({ key: `set:${at.scope}:${at.set ?? ""}`, kind: "set", label: set?.label ?? (at.set !== undefined ? `${at.set.split("/").at(-1)}.json` : "choose a set"), siblings: sets, on: set?.key });
  return crumbs;
}

/** Every set file in a tree, with its scope. */
function everySet(tree: PermissionSetTree): PermissionSetTreeSet[] {
  const out: PermissionSetTreeSet[] = [];
  const walk = (buckets: readonly PermissionSetTreeBucket[]): void => {
    for (const bucket of buckets) {
      out.push(...bucket.sets);
      walk(bucket.buckets);
    }
  };
  for (const scope of browsableScopes(tree)) {
    out.push(...scope.sets);
    walk(scope.buckets);
  }
  return out;
}

/**
 * Where a layer is in the tree: the copy its reference names exactly (`$SYSTEM/…`), else the copy a
 * `$/…` reference finds — the nearest scope's, the one nothing shadows.
 */
export function treeAtOf(tree: PermissionSetTree, reference: string | undefined, id: string): TreeAt | undefined {
  const sets = everySet(tree).filter((set) => set.id === id);
  const found = (reference !== undefined ? sets.find((set) => set.explicit === reference) : undefined) ?? sets.find((set) => set.shadowedBy === undefined) ?? sets[0];
  return found !== undefined ? { scope: found.scope, bucket: found.bucket, set: found.id } : undefined;
}

/** The set a place of the tree is, when it is one. */
export function setAtOf(tree: PermissionSetTree, at: TreeAt | undefined): PermissionSetTreeSet | undefined {
  if (at?.set === undefined) return undefined;
  return childrenOf(tree, at).find((choice) => choice.set?.id === at.set)?.set;
}

/**
 * What a picked set is named by in the stack: `$/permission-sets/<id>`, which finds the nearest copy —
 * unless a nearer scope shadows the one picked, when it is that copy exactly (`$SYSTEM/…`), so what was
 * looked at is what is laid.
 */
export function referenceOfPick(set: PermissionSetTreeSet): string | undefined {
  return set.shadowedBy !== undefined ? (set.explicit ?? set.reference) : (set.reference ?? set.explicit);
}

/** One row of the expanded browser's tree. */
export interface TreeRow {
  key: string;
  depth: number;
  kind: "scope" | "bucket" | "set";
  label: string;
  hint?: string;
  icon: string;
  /** A scope or bucket: whether it is open. */
  open?: boolean;
  /** The set selected. */
  on: boolean;
  inStack: boolean;
  at: TreeAt;
  set?: PermissionSetTreeSet;
}

/**
 * The expanded browser's tree (§4.1): scopes, their buckets, nested, and the sets, each with its icon.
 * A scope opens by default and a bucket opens when it holds the selection; `toggled` is what the person
 * opened or shut, by row key, over that.
 */
export function treeRowsOf(tree: PermissionSetTree, toggled: Readonly<Record<string, boolean>>, selected: TreeAt | undefined): TreeRow[] {
  const rows: TreeRow[] = [];
  const holdsSelection = (scope: PermissionSetScope, path: string): boolean =>
    selected !== undefined && selected.scope === scope && (selected.bucket === path || selected.bucket.startsWith(`${path}/`));
  const walk = (scope: PermissionSetScope, buckets: readonly PermissionSetTreeBucket[], sets: readonly PermissionSetTreeSet[], depth: number): void => {
    for (const bucket of buckets) {
      const key = `bucket:${scope}:${bucket.path}`;
      const open = toggled[key] ?? holdsSelection(scope, bucket.path);
      rows.push({ key, depth, kind: "bucket", label: bucket.name, icon: "folder", open, on: false, inStack: false, at: { scope, bucket: bucket.path } });
      if (open) walk(scope, bucket.buckets, bucket.sets, depth + 1);
    }
    for (const set of sets) {
      const key = `set:${scope}:${set.id}`;
      rows.push({
        key,
        depth,
        kind: "set",
        label: `${set.name}.json`,
        hint: `${set.lines} ${set.lines === 1 ? "line" : "lines"}`,
        icon: set.icon,
        on: selected?.scope === scope && selected.set === set.id,
        inStack: set.inStack,
        at: { scope, bucket: set.bucket, set: set.id },
        set,
      });
    }
  };
  for (const scope of browsableScopes(tree)) {
    const key = `scope:${scope.scope}`;
    const open = toggled[key] ?? true;
    const words = SCOPE_WORDS[scope.scope] ?? { name: scope.scope, hint: scope.label, icon: "folder" };
    rows.push({ key, depth: 0, kind: "scope", label: words.name, hint: words.hint, icon: words.icon, open, on: false, inStack: false, at: { scope: scope.scope, bucket: "" } });
    if (open) walk(scope.scope, scope.buckets, scope.sets, 1);
  }
  return rows;
}

/**
 * The shield's browser (2026-11-03): its tree starts with THIS stack — a `This conversation` root, each
 * layer oldest first, then `tools` — above the scopes, so the whole permission picture is one place.
 */
export type StackPick = { kind: "layer"; key: string } | { kind: "tools" } | { kind: "set"; at: TreeAt };

export interface StackRow {
  key: string;
  kind: "root" | "layer" | "tools";
  depth: number;
  label: string;
  hint?: string;
  icon: string;
  pick?: StackPick;
  layer?: LayerSegment;
}

export function stackRowsOf(layers: readonly LayerSegment[], tools: number, runtime: number): StackRow[] {
  return [
    { key: "stack:root", kind: "root", depth: 0, label: "This conversation", hint: "oldest first", icon: "shield" },
    ...layers.map(
      (layer): StackRow => ({
        key: `stack:${layer.key}`,
        kind: "layer",
        depth: 1,
        label: layer.id,
        hint: [layer.scope, layer.role === "standing" ? "pinned" : undefined, `${layer.lines} ${layer.lines === 1 ? "line" : "lines"}`].filter((each) => each !== undefined).join(" · "),
        icon: layer.icon,
        pick: { kind: "layer", key: layer.key },
        layer,
      }),
    ),
    {
      key: "stack:tools",
      kind: "tools",
      depth: 1,
      label: "tools",
      hint: `${tools} offered${runtime > 0 ? ` · ${runtime} from this run` : ""}`,
      icon: "tool",
      pick: { kind: "tools" },
    },
  ];
}

/** What the contents' note says: where the set lives, and how many lines it writes — only those are drawn. */
export function contentsNoteOf(set: Pick<PermissionSetTreeSet, "scope" | "lines">): string {
  return `${set.scope} · ${set.lines} ${set.lines === 1 ? "line" : "lines"} — only what it writes is shown`;
}

// --- the remembered mode -------------------------------------------------------------------------

/** The two looks of a segment's popover (ruling 11): compact, or the browser it widens into. */
export const BROWSER_MODES = ["compact", "expanded"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];
/** Where the look is remembered — the window's UI state (`JairaUiState.modes`), so it stays expanded on every segment until ⤡. */
export const STACK_BROWSER_MODE = "composer.stack.browser";

export function browserModeOf(ui: JairaUiState | undefined): BrowserMode {
  return ui === undefined ? "compact" : modeOf(ui, STACK_BROWSER_MODE, BROWSER_MODES, "compact");
}

// --- pinning, and saving the stack ---------------------------------------------------------------

/** The bucket a stack's standing layers are by (§2.6): its bottom's — `chat` for a stack with no set at the bottom. */
export function stackBucketOf(form: StackForm): string {
  const id = form.layers[0] !== undefined ? permissionSetIdOf(form.layers[0]) : undefined;
  return (id !== undefined ? bucketOfSetId(id) : undefined) ?? "chat";
}

/**
 * The project's settings with `reference` pinned to (or taken off) the bucket's standing layers —
 * `permissions.layers.<bucket>` (§7.3). A project's list replaces the one under it whole, so the list
 * written starts from what stands now (`standing`, the effective list) when the project has none.
 */
export function pinnedConfigOf(project: unknown, standing: readonly string[] | undefined, bucket: string, reference: string, pin: boolean): Record<string, unknown> {
  const doc = isPlainObject(project) ? project : {};
  const permissions = isPlainObject(doc["permissions"]) ? doc["permissions"] : {};
  const layers = isPlainObject(permissions["layers"]) ? permissions["layers"] : {};
  const own = layers[bucket];
  const was = Array.isArray(own) ? own.filter((each): each is string => typeof each === "string") : [...(standing ?? [])];
  const same = (each: string): boolean => each === reference || (permissionSetIdOf(each) !== undefined && permissionSetIdOf(each) === permissionSetIdOf(reference));
  const list = pin ? (was.some(same) ? was : [...was, reference]) : was.filter((each) => !same(each));
  const nextLayers: Record<string, unknown> = { ...layers, [bucket]: list };
  return { ...doc, permissions: { ...permissions, layers: nextLayers } };
}

/** The standing layers settings hold for a bucket, from a config document's effective value. */
export function standingOf(effective: unknown, bucket: string): string[] {
  if (!isPlainObject(effective)) return [];
  const permissions = effective["permissions"];
  const layers = isPlainObject(permissions) ? permissions["layers"] : undefined;
  const list = isPlainObject(layers) ? layers[bucket] : undefined;
  return Array.isArray(list) ? list.filter((each): each is string => typeof each === "string") : [];
}

/** "Save this stack as a set" (§7.4): the stack's own layers and its tools layer's lines, as a file of `bucket`. */
export function saveStackRequestOf(form: StackForm, name: string, layer: WritableLayer, bucket = stackBucketOf(form)): Omit<SavePermissionStackRequest, "project"> {
  return { layer, bucket, name: name.trim(), permissionSet: stackSettingsOf(form) };
}

// --- the Tools card's Everything ----------------------------------------------------------------

/**
 * Which layer decided a line, as Everything tags it (§7.4): the one that took a tool away, else the
 * one behind its own mode. `undefined` for a line the stack does not write.
 */
export function decidedTagOf(view: Pick<PermissionStackView, "lines"> | null | undefined, subject: string): string | undefined {
  const line = view?.lines.find((each) => each.subject === subject);
  return line === undefined ? undefined : (line.unavailable ?? line.layer ?? Object.values(line.places)[0]?.layer);
}

/** One answer this run gave: what it is kept by (`width @ place`), its width, its place and the answer. */
export interface RuntimeAnswer {
  key: string;
  width: string;
  place: string | undefined;
  decision: "allow" | "deny";
}

/** The runtime answers: each key split into its width and its place. */
export function runtimeAnswersOf(runtime: Readonly<Record<string, "allow" | "deny">>): RuntimeAnswer[] {
  return Object.entries(runtime).map(([key, decision]) => {
    const at = key.indexOf(" @ ");
    return { key, width: at < 0 ? key : key.slice(0, at), place: at < 0 ? undefined : key.slice(at + 3), decision };
  });
}

/**
 * Where the Tools card marks each of the run's answers (2026-11-03: the runtime layer folded into the
 * tools segment). An answer is kept by WIDTH, normalized as subjects are, so it is about:
 *
 *   - a tool, when the width is one of the tools offered (`read_file`) — marked on the tool's line;
 *   - a command line the map writes, when the width is that line (`npm run build`) — marked on it;
 *   - a program the map groups lines under, when the width starts with it (`git`, `git commit`) —
 *     a line of its own inside that program's group;
 *   - else a line of its own at Execution's end.
 */
export interface RuntimeRows {
  byTool: Record<string, RuntimeAnswer[]>;
  bySubject: Record<string, RuntimeAnswer[]>;
  byProgram: Record<string, RuntimeAnswer[]>;
  loose: RuntimeAnswer[];
}

export function runtimeRowsOf(answers: readonly RuntimeAnswer[], tools: readonly string[], subjects: readonly string[], programs: readonly string[]): RuntimeRows {
  const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();
  const toolOf = new Map(tools.map((name) => [norm(name), name]));
  const subjectOf = new Map(subjects.map((subject) => [norm(subject), subject]));
  const programOf = new Map(programs.map((program) => [norm(program), program]));
  const rows: RuntimeRows = { byTool: {}, bySubject: {}, byProgram: {}, loose: [] };
  const push = (into: Record<string, RuntimeAnswer[]>, key: string, answer: RuntimeAnswer): void => {
    (into[key] ??= []).push(answer);
  };
  for (const answer of answers) {
    const width = norm(answer.width);
    const tool = toolOf.get(width);
    const subject = subjectOf.get(width);
    const program = programOf.get(width.split(" ")[0] ?? "");
    if (tool !== undefined) push(rows.byTool, tool, answer);
    else if (subject !== undefined) push(rows.bySubject, subject, answer);
    else if (program !== undefined) push(rows.byProgram, program, answer);
    else rows.loose.push(answer);
  }
  return rows;
}

/** How an answer reads on its mark: `this run · allow`, `this run · allow in packages`. */
export function runtimeWordsOf(answer: Pick<RuntimeAnswer, "decision" | "place">): string {
  return `this run · ${answer.decision}${answer.place !== undefined ? ` in ${answer.place}` : ""}`;
}

/** A set's own lines as the card reads them. */
export function ownSetOf(lines: Record<string, unknown>): PermissionSet {
  return parsePermissionSet(lines).permissionSet;
}
