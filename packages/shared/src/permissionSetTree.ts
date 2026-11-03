/**
 * Permission sets as FILES, for the set browser and the composer's stack (decision 0023 §4.1, rulings
 * 8–11; §7.4) — the data the UI draws, and the pure readings of it.
 *
 * "Each permission set is a file on a path, each one has an icon, therefore, selecting a permission set
 * should follow some of the folder browser ui. The 'contents' of a permission is the tool mappings …
 * with anything unset being filtered out" (ruling 10). So there are three reads, each a shape here:
 *
 *  - the TREE ({@link PermissionSetTree}): scopes (built in, global, project, runtime) → buckets
 *    (folders, nested) → sets (files), each with its id, file, line count, icon, and whether it is in
 *    the stack being looked at — what the crumbs and the expanded browser are drawn from;
 *  - one set's OWN lines ({@link OwnPermissionSet}): what its file writes, `$ref` and `layers` apart —
 *    what a segment's compact popover draws under its crumbs;
 *  - the WHOLE stack composed ({@link PermissionStackView}): every line it comes to, each tagged with
 *    the layer that decided it and each place with its own — the Tools card's "Everything" (§7.4).
 *
 * The filesystem half is `@jaira/persistence`'s (`permissionSetTree`, `readOwnPermissionSet`); the
 * service answers `permissionSets:tree`, `permissionSets:own`, `permissionSets:stack` and
 * `permissionSets:saveStack` with these.
 */
import { composePermissionSetLayers, RUNTIME_LAYER, TOOLS_LAYER, type LayerIssue, type PermissionStackLayer, type PermissionStackRole } from "./permissionLayers";
import { isPermissionSetInstructionKey, normalizeSubject, OTHER_SUBJECT, type PermissionSetIssue } from "./permissionSets";
import { PLACE_ANYWHERE } from "./places";
import type { WorkflowLayer } from "./view";

/**
 * Where a layer LIVES (decision 0023 §2.6): `built in` (what ships), `global` (`~/.jaira`), `project`
 * (`.jaira/`), `runtime` (this task's answers, in memory), `this conversation` (the tools layer, kept on
 * the task) and `this state` (lines written on a state itself, `inline`). A stack's layers are the same
 * kind of thing whatever their scope (ruling 8).
 */
export type PermissionSetScope = "built in" | "global" | "project" | "runtime" | "this conversation" | "this state";

/** The scope of a layer root. */
export const SCOPE_OF_LAYER: Readonly<Record<WorkflowLayer, PermissionSetScope>> = { system: "built in", base: "global", project: "project" };

/** One set file as the browser lists it. */
export interface PermissionSetTreeSet {
  /** `<bucket>/<name>` — `chat/ask-first`, `feature/implementation/writes-asking`. For the runtime layer, `runtime`. */
  id: string;
  name: string;
  /** The folder path, `/`-separated; empty for the runtime layer. */
  bucket: string;
  scope: PermissionSetScope;
  /** The layer root it is in. Absent for the runtime layer. */
  layer?: WorkflowLayer;
  /** What a stack names it by: `$/permission-sets/<id>`, which finds the NEAREST scope's copy. Absent for runtime. */
  reference?: string;
  /** This scope's copy exactly — `$SYSTEM/permission-sets/chat/ask-first` — what an override follows. */
  explicit?: string;
  /** The file as a person reads it: `built in/permission-sets/chat/ask-first.json`. */
  file: string;
  /** The absolute file. Absent for runtime. */
  path?: string;
  /** How many lines the file writes ITSELF — `other` counted, `$ref`, `layers` and `icon` not. Runtime: answers kept. */
  lines: number;
  /** Its icon — see `permissionSetIconOf`: a glyph name, or a mode word for that mode's glyph. */
  icon: string;
  /** In the stack being looked at — by id, so a project copy of a set in the stack counts. */
  inStack: boolean;
  /** A nearer scope holds its own copy, so `reference` finds that one, not this. */
  shadowedBy?: PermissionSetScope;
  /** The `$ref` the file starts from. */
  follows?: string;
  /** The `layers` the file is built from, oldest first (§2.5). */
  layers?: string[];
  /** Why the file could not be read. It is still listed: a browser that hid a broken file would offer to create the one that is there. */
  problem?: string;
}

/** A bucket — a folder — and what is in it. */
export interface PermissionSetTreeBucket {
  /** The folder's own name: `implementation`. */
  name: string;
  /** Its path from the scope's `permission-sets/`: `feature/implementation`. */
  path: string;
  buckets: PermissionSetTreeBucket[];
  sets: PermissionSetTreeSet[];
}

/** One scope of the tree. */
export interface PermissionSetTreeScope {
  scope: PermissionSetScope;
  layer?: WorkflowLayer;
  /** The scope's root as a person reads it: `built in`, `~/.jaira`, `.jaira`, `runtime`. */
  label: string;
  buckets: PermissionSetTreeBucket[];
  /** Sets directly in the scope — only the runtime layer, which has no buckets. */
  sets: PermissionSetTreeSet[];
}

/** What `permissionSets:tree` answers: every scope this window has, nearest LAST — built in first, as the browser reads down. */
export interface PermissionSetTree {
  scopes: PermissionSetTreeScope[];
}

/** What `permissionSets:own` answers: one set file, and the lines it writes itself — "anything unset filtered out" (ruling 10). */
export interface OwnPermissionSet {
  set: PermissionSetTreeSet;
  /** The file's own lines, as written, `$ref`, `layers` and `icon` apart. */
  lines: Record<string, unknown>;
}

/** One layer of a stack, as the composer's segments draw it (§4.1), oldest first. */
export interface PermissionStackViewLayer {
  /** `chat/ask-first`, `app/build`, `inline`, `runtime`, `tools`. */
  id: string;
  /** The reference it was read through, for a layer in a file. */
  reference?: string;
  /** The reference the stack NAMED that this layer was reached through — one segment per `via` (see `PermissionStackLayer.via`). */
  via?: string;
  scope: PermissionSetScope;
  /** Where it stands in §2.6's order; `runtime` for this task's answers. */
  role: PermissionStackRole | "runtime";
  icon: string;
  /** How many lines the layer says — for runtime, how many answers are kept. */
  lines: number;
}

/** One line of the stack composed (§7.4 "Everything"), and who decided it. */
export interface PermissionStackLine {
  subject: string;
  /** The line as the stack comes to it, as an author would write it. */
  value: unknown;
  /** The layer whose plain decision, or `**`, is the line's own mode. */
  layer?: string;
  /** Each other place, its decision and the layer that wrote it. */
  places: Record<string, { decision: unknown; layer?: string }>;
  /** The layer whose `implementation` stands, when one does. */
  implementationLayer?: string;
  /** The stack came to `unavailable` on this line: it is not offered, and this is who said so. */
  unavailable?: string;
}

/** What `permissionSets:stack` answers: a stack, composed, with who said each line. */
export interface PermissionStackView {
  layers: PermissionStackViewLayer[];
  lines: PermissionStackLine[];
  /** This task's answers "for this run", as `CommandGrants.list()` keeps them: `width` or `width @ place` → decision. */
  runtime: Record<string, "allow" | "deny">;
  issues: Array<LayerIssue | PermissionSetIssue>;
}

/** How many lines a set's own text writes — `other` counted, `$ref`, `layers` and `icon` not. */
export function ownLineCount(own: unknown): number {
  if (own === null || typeof own !== "object" || Array.isArray(own)) return 0;
  return Object.keys(own).filter((key) => !isPermissionSetInstructionKey(key)).length;
}

/** A set file's own lines — its text read, the instructions taken out. */
export function ownLinesOf(own: unknown): Record<string, unknown> {
  if (own === null || typeof own !== "object" || Array.isArray(own)) return {};
  return Object.fromEntries(Object.entries(own as Record<string, unknown>).filter(([key]) => !isPermissionSetInstructionKey(key)));
}

/**
 * A stack composed into the rows "Everything" draws (§7.4): `composePermissionSetLayers` over its
 * layers, each line of the merged map with the layer behind its own mode, behind each place and behind
 * its implementation — and a line the stack came to `unavailable` on marked with who said so. The
 * runtime layer is drawn among the layers (under the tools layer) but writes no line here: its
 * answers are by width and place, listed in `runtime`.
 */
export function permissionStackViewOf(
  layers: readonly PermissionStackLayer[],
  describe: (layer: PermissionStackLayer) => { scope: PermissionSetScope; icon: string },
  runtime: Readonly<Record<string, "allow" | "deny">> = {},
  issues: readonly PermissionSetIssue[] = [],
): PermissionStackView {
  const composed = composePermissionSetLayers(layers);
  const lines: PermissionStackLine[] = [];
  const single = layers.length === 1 ? layers[0]!.id : undefined;
  for (const [subject, value] of Object.entries(composed.decl)) {
    const key = subject === OTHER_SUBJECT ? subject : normalizeSubject(subject);
    const provenance = composed.provenance[key];
    const places: PermissionStackLine["places"] = {};
    const mode = value !== null && typeof value === "object" && !Array.isArray(value) && "mode" in (value as object) ? (value as { mode: unknown }).mode : value;
    if (mode !== null && typeof mode === "object" && !Array.isArray(mode)) {
      for (const [place, decision] of Object.entries(mode as Record<string, unknown>)) {
        if (place.trim() === PLACE_ANYWHERE) continue;
        const layer = provenance?.places[place.trim()] ?? single;
        places[place] = { decision, ...(layer !== undefined ? { layer } : {}) };
      }
    }
    const everywhere = provenance?.everywhere ?? single;
    const implementation = provenance?.implementation;
    lines.push({
      subject,
      value,
      ...(everywhere !== undefined ? { layer: everywhere } : {}),
      places,
      ...(implementation !== undefined ? { implementationLayer: implementation } : {}),
      ...(Object.hasOwn(composed.unavailable, key) ? { unavailable: composed.unavailable[key]! } : {}),
    });
  }
  const viewLayers: PermissionStackViewLayer[] = layers.map((layer) => ({
    id: layer.id,
    ...(layer.reference !== undefined ? { reference: layer.reference } : {}),
    ...(layer.via !== undefined ? { via: layer.via } : {}),
    role: layer.role,
    lines: ownLineCount(layer.decl),
    ...describe(layer),
  }));
  // The runtime layer stands under the tools layer (§2.6 step 4), and over everything else.
  const runtimeLayer: PermissionStackViewLayer = { id: RUNTIME_LAYER, scope: "runtime", role: "runtime", icon: "history", lines: Object.keys(runtime).length };
  const toolsAt = viewLayers.findIndex((layer) => layer.id === TOOLS_LAYER && layer.role === "own");
  if (toolsAt < 0) viewLayers.push(runtimeLayer);
  else viewLayers.splice(toolsAt, 0, runtimeLayer);
  return { layers: viewLayers, lines, runtime: { ...runtime }, issues: [...composed.issues, ...issues] };
}
