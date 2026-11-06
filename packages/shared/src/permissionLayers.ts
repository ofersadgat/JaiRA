/**
 * A STACK of permission sets, composed into the one set a conversation or a state is judged under
 * (decision 0023 §2), and who said each line.
 *
 * Every layer is a permission set (ruling 6): the bottom one usually a preset (`ask-first`), then
 * the bucket's standing layers, a state's or a conversation's own, this run's answers, and the
 * conversation's tools (§2.6). They are merged line by line, newest saying — {@link mergeLayerDecls} in
 * `permissionSets.ts`, the same merge a `$ref` copy and a file's `layers` go through — and the result
 * is judged exactly as one set is.
 *
 * What this adds over that merge is the two things only a composed stack has:
 *
 *  - **`unavailable` is resolved.** A layer that says a tool is `unavailable` is saying something
 *    about the layers below it: the line is not offered. The EFFECTIVE set therefore holds no
 *    `unavailable` tool line — the tool is simply absent, as a tool no layer names is (§2.3) — and
 *    {@link ComposedPermissionSet.unavailable} says which layer took it away. An MCP line that comes to
 *    `unavailable` is the one exception, and stays (`mcpGateModes` refuses it): an absent MCP tool
 *    line falls to its server's line and then `other`, which could hand the model the very tool the
 *    layer took away, until what an agent is handed reads `unavailable` itself (§3.9).
 *  - **Provenance** (§2.7). For every line, and every place within a line, the layer that set it —
 *    so an approval row, the card and the composer can say `build-safe allows` or `ask-first asks · no
 *    layer above names one build` ({@link decidedBy}).
 *
 * Each layer is parsed on its own first, so what is wrong with one is reported against it (its id on
 * the issue) and costs that layer that line, not the stack: a bad newer line does not wipe out a good
 * older one.
 *
 * Pure. {@link composePermissionSetLayers} is handed layers whose references are already followed;
 * {@link permissionStackOf} follows a node's through the reader it is handed, and never reads a file
 * itself.
 */
import {
  declOfPermissionSet,
  INLINE_LAYER,
  mergeLayerDecls,
  normalizeSubject,
  OTHER_SUBJECT,
  parsePermissionSet,
  PERMISSION_SET_ICON_KEY,
  PERMISSION_SET_LAYERS_KEY,
  PERMISSION_SET_REF_KEY,
  permissionSetLayersOf,
  type LineProvenance,
  type PermissionSet,
  type PermissionSetIssue,
  type PermissionSetLayerDecl,
  type PermissionSetReader,
} from "./permissionSets";
import type { PermissionStackDecl } from "./operationVocabulary";
import { PLACE_ANYWHERE } from "./places";

/** An issue in one layer of a stack, named by the layer's id. */
export interface LayerIssue extends PermissionSetIssue {
  layer: string;
}

/** A stack composed: the effective set, the merged map it was read from, and who said what. */
export interface ComposedPermissionSet {
  /** The EFFECTIVE set: every layer merged, and no `unavailable` tool line in it — such a tool is not offered. */
  permissionSet: PermissionSet;
  /**
   * The merged map, as an author could write it, `unavailable` lines included — what "save this stack
   * as a set" would flatten to, and what the effective set was read from.
   */
  decl: Record<string, unknown>;
  /** By subject (one spelling, `normalizeSubject`), `other` included: who set the line, at each place. */
  provenance: Record<string, LineProvenance>;
  /** The lines the stack came to `unavailable` on, by subject, each to the layer that said it. */
  unavailable: Record<string, string>;
  /** What was wrong with a layer, against the layer. */
  issues: LayerIssue[];
}

/**
 * Compose a stack of layers, OLDEST FIRST, into the one set it comes to — see the module header. A
 * stack with nothing in it offers nothing.
 */
export function composePermissionSetLayers(layers: readonly PermissionSetLayerDecl[]): ComposedPermissionSet {
  const issues: LayerIssue[] = [];
  // Each layer as the lines it validly says, in one spelling: a line it cannot read is reported and
  // left out, and `other` is carried only where the layer writes one.
  // The lines are kept as WRITTEN, not as `declOfPermissionSet` writes them back: that writes an
  // implementation only where it is `native`, and a newer layer's `"implementation": "app"` is what
  // takes back a `native` below it (`mergeEntryDecl`).
  const cleaned = layers.map(({ id, decl }) => {
    const parsed = parsePermissionSet(decl);
    for (const issue of parsed.issues) issues.push({ ...issue, layer: id });
    const kept: Record<string, unknown> = {};
    for (const [subject, value] of Object.entries(decl)) {
      const normalized = normalizeSubject(subject);
      const read = normalized === OTHER_SUBJECT ? parsed.permissionSet.other !== undefined : Object.hasOwn(parsed.permissionSet.entries, normalized);
      if (read) kept[subject] = value;
    }
    return { id, decl: kept };
  });
  const { decl, provenance } = mergeLayerDecls(cleaned);
  const { permissionSet } = parsePermissionSet(decl);
  const unavailable: Record<string, string> = {};
  const entries: PermissionSet["entries"] = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.unavailable === true) {
      const by = provenance[subject]?.everywhere;
      if (by !== undefined) unavailable[subject] = by;
      if (entry.kind === "tool") continue;
    }
    entries[subject] = entry;
  }
  return { permissionSet: { ...permissionSet, entries }, decl, provenance, unavailable, issues };
}

/**
 * Which layer decided a line — at one of its places, or everywhere (its plain decision or its `**`)
 * when `place` is absent or `**`. `undefined` when no layer set it there: a place no layer names falls
 * to the line's own mode, which is a separate answer and a separate question.
 */
export function decidedBy(composed: Pick<ComposedPermissionSet, "provenance">, subject: string, place?: string): string | undefined {
  const line = composed.provenance[subject === OTHER_SUBJECT ? subject : normalizeSubject(subject)];
  if (line === undefined) return undefined;
  const at = place?.trim();
  return at === undefined || at === PLACE_ANYWHERE ? line.everywhere : line.places[at];
}

// --- the stack a node is, in §2.6's order -------------------------------------------------------

/** The id of the layer the composer's Tools card writes (§2.6, step 5): the conversation's own lines. */
export const TOOLS_LAYER = "tools";
/** The id of the answers given in this task, kept in memory (§2.6, step 4): `CommandGrants`. */
export const RUNTIME_LAYER = "runtime";

const SET_REFERENCE = /^\$[A-Z]*\/permission-sets\/((?:[^/\\#]+\/)*[^/\\#]+?)(?:\.(?:json|ya?ml))?$/;

/**
 * The layer ids that are not set files: this task's answers, the conversation's own lines and lines
 * written on a state. A set at the TOP LEVEL is named by its bare name (`read-only`), so these names
 * cannot be a top-level set's: a stack names a layer by id, and `tools` would mean two things.
 */
// `"inline"` is `INLINE_LAYER`, spelled out: `permissionSets.ts` imports this module, so its constant is
// not yet defined while this one is evaluated (`permissionSetBuckets.test.ts` holds the two equal).
export const RESERVED_LAYER_IDS: readonly string[] = [RUNTIME_LAYER, TOOLS_LAYER, "inline"];

/**
 * The set id a reference names — `$/permission-sets/read-only`, `$SYSTEM/permission-sets/control/ask-first.json`
 * → `read-only`, `control/ask-first` — whatever root it is searched from. `undefined` for anything else
 * (`./mine`, `inline`), and for a reserved top-level name ({@link RESERVED_LAYER_IDS}).
 * The id is how a person reads a layer (`read-only`, `app/build`): its bucket, if it is in one, then its name.
 */
export function permissionSetIdOf(reference: string): string | undefined {
  const match = SET_REFERENCE.exec(reference.trim());
  if (match === null) return undefined;
  const id = match[1]!;
  if (RESERVED_LAYER_IDS.includes(id)) return undefined;
  return id.split("/").some((segment) => segment === "." || segment === "..") ? undefined : id;
}

/** Is this layer id a set file's (`read-only`, `control/ask-first`), rather than `runtime`, `tools`, `inline` or a path? */
export function isPermissionSetId(id: string): boolean {
  return permissionSetIdOf(`$/permission-sets/${id}`) === id;
}

/**
 * The bucket of a set id — everything before its name (`feature/implementation/writes-asking` →
 * `feature/implementation`), and `""` for a set at the top level (`read-only`).
 */
export function bucketOfSetId(id: string): string {
  const at = id.lastIndexOf("/");
  return at > 0 ? id.slice(0, at) : "";
}

/** How a layer is named to a person: a set file by its id, anything else as it was written (`inline`, `tools`, `./mine`). */
export function layerIdOf(reference: string): string {
  return permissionSetIdOf(reference) ?? reference;
}

/** Where a layer of a stack stands in §2.6's order. */
export type PermissionStackRole =
  /** (1) The bottom: the first set the node names — usually a preset. */
  | "bottom"
  /** (2) A standing layer of the bottom set's bucket, from settings (`permissions.layers.<bucket>`). */
  | "standing"
  /** (3) A layer the node names after the bottom: a state's, or a conversation's own. */
  | "named"
  /** (3), or (5) for a conversation: the lines written on the node itself. */
  | "own";

/** One layer of a stack, with where it came from. */
export interface PermissionStackLayer extends PermissionSetLayerDecl {
  /** The reference it was read through, for a layer in a file — what "Add to" writes into. Absent for lines written in place. */
  reference?: string;
  /**
   * The reference the NODE (or settings, for a standing layer) named that this layer was reached
   * through: a file built of layers is several layers, all with the one `via` — which is how the
   * composer draws it as the one segment the conversation names (decision 0023 §4.1).
   */
  via?: string;
  role: PermissionStackRole;
}

export interface PermissionStackOptions {
  /** `config.permissions.layers`: each bucket's standing layers, oldest first (§7.3). */
  standing?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * The bucket whose standing layers apply when the bottom names none — a node written in place. A
   * conversation's is `chat`; a state's map written on the state has none, and so no standing layers.
   */
  bucket?: string | undefined;
  /** The id of the lines written on the node itself: {@link INLINE_LAYER} for a state, {@link TOOLS_LAYER} for a conversation. */
  ownId?: string | undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A permission set node as the STACK it is judged under, oldest first, in §2.6's order — every
 * reference followed, each layer named by its id ({@link layerIdOf}):
 *
 *  1. the BOTTOM — the first set the node names: a bare reference, its `$ref`, or the first of its
 *     `layers`. A file reached that way is the stack it is itself (its own `$ref` and `layers`);
 *  2. the bucket's STANDING layers, from settings, for the bottom set's bucket (or `options.bucket`
 *     when the bottom is no set file) — a standing layer that names the bottom set itself is skipped;
 *  3. the rest of the node's `layers`, in order;
 *  4. the lines written on the node itself, as `options.ownId` (§2.6's tools layer for a conversation).
 *
 * The runtime layer is not here: it is this task's answers, which are memory, not a set
 * (`CommandGrants`, which the policy reads beside the stack).
 *
 * A reference that cannot be followed is an error on `issues`. For the node's own references the
 * whole stack is `undefined`, as `resolvePermissionSetDecl` answers; a STANDING layer that cannot be
 * read is reported and left out, so a typo in settings is said — and does not stop every set of the
 * bucket from being read.
 */
export function permissionStackOf(
  node: unknown,
  read: PermissionSetReader,
  from: string,
  issues: PermissionSetIssue[],
  options: PermissionStackOptions = {},
): PermissionStackLayer[] | undefined {
  const ownId = options.ownId ?? INLINE_LAYER;
  const follow = (reference: string, role: PermissionStackRole, into: PermissionSetIssue[]): PermissionStackLayer[] | undefined => {
    const layers = permissionSetLayersOf(reference, read, from, into, reference);
    return layers?.map((layer) => ({ id: layerIdOf(layer.id), decl: layer.decl, ...(layer.id !== INLINE_LAYER ? { reference: layer.id } : {}), via: reference, role }));
  };
  let bottomReference: string | undefined;
  let named: string[] = [];
  let own: Record<string, unknown> | undefined;
  if (typeof node === "string") {
    bottomReference = node;
  } else if (isPlainObject(node)) {
    const reference = node[PERMISSION_SET_REF_KEY];
    const listed = node[PERMISSION_SET_LAYERS_KEY];
    if (reference !== undefined && typeof reference !== "string") {
      issues.push({ path: PERMISSION_SET_REF_KEY, message: `'${PERMISSION_SET_REF_KEY}' takes a reference, as a string`, severity: "error" });
      return undefined;
    }
    if (listed !== undefined && (!Array.isArray(listed) || !listed.every((each) => typeof each === "string"))) {
      issues.push({ path: PERMISSION_SET_LAYERS_KEY, message: `'${PERMISSION_SET_LAYERS_KEY}' takes a list of references, oldest first`, severity: "error" });
      return undefined;
    }
    const list = (listed as string[] | undefined) ?? [];
    bottomReference = reference ?? list[0];
    named = reference !== undefined ? list : list.slice(1);
    const { [PERMISSION_SET_REF_KEY]: _ref, [PERMISSION_SET_LAYERS_KEY]: _layers, [PERMISSION_SET_ICON_KEY]: _icon, ...lines } = node;
    own = lines;
  } else {
    issues.push({ path: "", message: "a permission set is a map from a subject to a mode, or a reference to one", severity: "error" });
    return undefined;
  }
  let bottom: PermissionStackLayer[] = [];
  if (bottomReference !== undefined) {
    const followed = follow(bottomReference, "bottom", issues);
    if (followed === undefined) return undefined;
    bottom = followed;
  }
  const bottomId = bottomReference !== undefined ? permissionSetIdOf(bottomReference) : undefined;
  const bucket = bottomId !== undefined ? bucketOfSetId(bottomId) : options.bucket;
  const standing: PermissionStackLayer[] = [];
  for (const reference of bucket !== undefined ? (options.standing?.[bucket] ?? []) : []) {
    if (bottomId !== undefined && permissionSetIdOf(reference) === bottomId) continue;
    const found: PermissionSetIssue[] = [];
    const followed = follow(reference, "standing", found);
    for (const issue of found) issues.push({ ...issue, message: `the standing layer '${reference}' of '${bucket}' (settings: ${standingKeyOf(bucket ?? "")}): ${issue.message}` });
    if (followed !== undefined) standing.push(...followed);
  }
  const middle: PermissionStackLayer[] = [];
  for (const reference of named) {
    const followed = follow(reference, "named", issues);
    if (followed === undefined) return undefined;
    middle.push(...followed);
  }
  // The node's own lines are a layer when it writes any — and a node that names nothing IS its lines,
  // even none: a map with no lines is a stack of one empty layer, which offers nothing (§2.6).
  const ownLayer = own !== undefined && (Object.keys(own).length > 0 || bottomReference === undefined) ? [{ id: ownId, decl: own, role: "own" as const }] : [];
  return [...bottom, ...standing, ...middle, ...ownLayer];
}

/** A stack read: its layers, the one map they merge to, and who set each line. */
export interface ResolvedPermissionStack {
  layers: PermissionStackLayer[];
  /** The merged map, `unavailable` lines and all — what is parsed into the set judged. */
  decl: Record<string, unknown>;
  /** By normalized subject, `other` included. Empty for a stack of one layer, which set every line. */
  provenance: Record<string, LineProvenance>;
}

/**
 * {@link permissionStackOf}, merged line by line ({@link mergeLayerDecls}) — exactly the merge
 * `resolvePermissionSetDecl` makes, with the standing layers in it. `undefined` when the stack could
 * not be read; the issues say why.
 */
export function resolvePermissionStack(
  node: unknown,
  read: PermissionSetReader,
  from: string,
  issues: PermissionSetIssue[],
  options: PermissionStackOptions = {},
): ResolvedPermissionStack | undefined {
  const layers = permissionStackOf(node, read, from, issues, options);
  if (layers === undefined) return undefined;
  if (layers.length === 1) return { layers, decl: layers[0]!.decl, provenance: {} };
  const { decl, provenance } = mergeLayerDecls(layers);
  return { layers, decl, provenance };
}

/**
 * A stack as a lowered block carries it (`PermissionsDecl.stack`): its layers oldest first, and — when
 * there is more than one — who set each line. One layer needs no lines: it set them all.
 */
export function stackDeclOf(stack: Pick<ResolvedPermissionStack, "layers" | "provenance">): PermissionStackDecl {
  return {
    layers: stack.layers.map((layer) => ({ id: layer.id, ...(layer.reference !== undefined ? { reference: layer.reference } : {}) })),
    ...(stack.layers.length > 1 ? { lines: stack.provenance } : {}),
  };
}

/**
 * Which layer of a stack set a line — at a place, or everywhere — as a part's or a call's row names it
 * (§2.7). One layer is the whole answer; where the line's provenance has nothing for the place (a place
 * no layer names answers by the line's own mode), the layer that gave the line its own mode answers.
 * `undefined` when the stack says nothing of the line — it is not this stack's (the built-ins, the floor).
 */
export function layerOfLine(stack: PermissionStackDecl | undefined, subject: string, place?: string): string | undefined {
  if (stack === undefined || stack.layers.length === 0) return undefined;
  if (stack.lines === undefined) return stack.layers.at(-1)!.id;
  const line = stack.lines[subject === OTHER_SUBJECT ? subject : normalizeSubject(subject)];
  if (line === undefined) return undefined;
  const at = place?.trim();
  return (at !== undefined && at !== PLACE_ANYWHERE ? line.places[at] : undefined) ?? line.everywhere;
}

/** The stack's layer ids, NEWEST first — what an approval lists for "Add to" (§4.4), each named once. */
export function stackIdsNewestFirst(stack: PermissionStackDecl | undefined): string[] {
  const out: string[] = [];
  for (const layer of [...(stack?.layers ?? [])].reverse()) if (!out.includes(layer.id)) out.push(layer.id);
  return out;
}

// --- a conversation's stack (§2.6, ruling 8) ---------------------------------------------------

/** A conversation's set read through its stack: the set it is judged under, the stack it came from, and what was wrong. */
export interface ChatPermissionStack {
  /** The EFFECTIVE set — the stack merged, as one set is judged. Offers nothing when the stack could not be read. */
  permissionSet: PermissionSet;
  /** The merged map, as an author could write it — what a turn's settings carry once the stack is followed. */
  decl: Record<string, unknown>;
  /** The layers, oldest first, and who set each line. */
  stack: PermissionStackDecl;
  issues: PermissionSetIssue[];
}

/**
 * A conversation's `ChatSettings.permissionSet` read through its stack (decision 0023 §2.6): the bottom
 * layer (`layers[0]`, the preset), the bucket's standing layers (`options.standing`, by the bottom's
 * bucket, or the top level for a map that names no set), the conversation's own layers (the rest of `layers`),
 * and the lines written beside them as the TOOLS layer ({@link TOOLS_LAYER}). The runtime layer is the
 * task's `CommandGrants`, read by the policy beside this.
 *
 * A stack whose own references cannot be followed offers NOTHING (§2.6: a stack with nothing in it
 * offers nothing), and the issues say why: a conversation whose preset cannot be read is not judged
 * under the half of its stack that could.
 */
export function resolveChatPermissionStack(
  node: unknown,
  read: PermissionSetReader,
  options: { standing?: Readonly<Record<string, readonly string[]>> | undefined; bucket?: string | undefined; from?: string | undefined } = {},
): ChatPermissionStack {
  const issues: PermissionSetIssue[] = [];
  const resolved = resolvePermissionStack(node, read, options.from ?? "", issues, {
    standing: options.standing,
    bucket: options.bucket ?? CHAT_BUCKET,
    ownId: TOOLS_LAYER,
  });
  if (resolved === undefined) return { permissionSet: { entries: {} }, decl: {}, stack: { layers: [] }, issues };
  const parsed = parsePermissionSet(resolved.decl);
  issues.push(...parsed.issues);
  return { permissionSet: parsed.permissionSet, decl: resolved.decl, stack: stackDeclOf(resolved), issues };
}

/** The bucket a conversation's map is in when its bottom layer names none — the composer's: the top level. */
const CHAT_BUCKET = "";

/** How a person writes a bucket's standing layers in settings: `permissions.layers.feature`, and `permissions.layers[""]` for the top level. */
export function standingKeyOf(bucket: string): string {
  return bucket === "" ? 'permissions.layers[""]' : `permissions.layers.${bucket}`;
}

/**
 * The TOOLS layer that makes `below` come to `wanted` (§2.6 step 5, ruling 8) — what the composer's
 * Tools card writes over the composed stack instead of the whole map: each line of `wanted` that says
 * something other than `below` does, and `unavailable` for each tool `below` holds and `wanted` does
 * not (§1: "what the composer's Tools card writes when a tool is unticked over a layer that offers it").
 *
 * A line that is not a tool — a command, `script`, a runner line — cannot be taken away by a newer
 * layer (it cannot be `unavailable`, and absent says nothing, §2.3), so one `below` holds and `wanted`
 * does not is left as `below` says. `other` is written only when the two differ.
 */
export function toolsLayerOf(below: PermissionSet, wanted: PermissionSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lower = declOfPermissionSet(below) as Record<string, unknown>;
  const upper = declOfPermissionSet(wanted) as Record<string, unknown>;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const [subject, entry] of Object.entries(upper)) {
    if (subject === OTHER_SUBJECT) continue;
    if (!Object.hasOwn(lower, subject) || !same(lower[subject], entry)) out[subject] = entry;
  }
  for (const subject of Object.keys(lower)) {
    if (subject === OTHER_SUBJECT || Object.hasOwn(upper, subject)) continue;
    const entry = below.entries[subject];
    if (entry?.kind === "tool" || entry?.kind === "mcp") out[subject] = UNAVAILABLE_WORD;
  }
  if (wanted.other !== undefined && !same(lower[OTHER_SUBJECT], upper[OTHER_SUBJECT])) out[OTHER_SUBJECT] = upper[OTHER_SUBJECT];
  return out;
}

const UNAVAILABLE_WORD = "unavailable";

/**
 * A conversation's settings as a STACK (ruling 8): `layers` oldest first — the bottom preset first —
 * and the tools layer's own lines beside them. What `ChatSettings.permissionSet` holds once the
 * composer writes a stack rather than the whole map.
 */
export function chatStackSettingsOf(layers: readonly string[], tools: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...(layers.length > 0 ? { [PERMISSION_SET_LAYERS_KEY]: [...layers] } : {}), ...tools };
}
