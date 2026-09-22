/**
 * Buckets of toolsets, and the one question the composer asks of them: WHICH toolset is this map?
 * (decision 0007 §2 and §5.)
 *
 * The composer's four permission presets used to be FUNCTIONS — `tool.readOnly ? "allow" : "deny"` —
 * spent the moment they were clicked. They are files now (`$SYSTEM/toolsets/chat/*.json`), a bucket
 * is a folder of them, and "which preset is this" became "which toolset IN THE CURRENT BUCKET does
 * this map exactly match". That is {@link matchToolset}, and it is the whole of what a label is:
 *
 * **A label is a match, never a memory.** Nothing records that a map began as `read-only`. The chip
 * reads a toolset's name while the map IS that toolset's — the same tools held, the same mode and
 * the same implementation on each, the same command subjects, the same `other` — and `custom` the
 * moment one line differs.
 *
 * Pure, and in `shared`, because both sides ask: main words the chip before anything is opened
 * (`ChatPlanView.effective.permissions`), and the renderer asks again for whichever bucket the
 * person has picked.
 */
import type { PermissionMode, ToolImplementation } from "./operationVocabulary";
import { holdsTool, MODE_WHEN_UNSET, parseToolset, type Toolset, type ToolsetDecl } from "./toolsets";
import type { WorkflowLayer } from "./view";

/** The bucket a conversation opens on when nothing it inherits is any bucket's toolset. */
export const DEFAULT_TOOLSET_BUCKET = "chat";

/** One toolset a card can offer: where it lives, which layer supplied it, and the map itself. */
export interface ToolsetChoice {
  /** `<bucket>/<name>` — what follows `$/toolsets/` in a reference. */
  id: string;
  /** The folder path, `/`-separated. A bucket may nest (`feature/implementation`). */
  bucket: string;
  name: string;
  /** The layer whose file this is — the first on the search path to hold the id. */
  layer: WorkflowLayer;
  /** The map, references already followed. What picking the row writes. */
  decl: ToolsetDecl;
}

// --- the match ---------------------------------------------------------------

/**
 * A toolset reduced to what it SAYS, in one order — two toolsets are the same iff these are equal.
 *
 *  - only HELD tools count ({@link holdsTool}): a mode for a tool the list does not offer is
 *    not a line of the map;
 *  - a tool `registered` does not list is left out on BOTH sides. A map carrying a line for something
 *    this project no longer registers is stale rather than custom, and letting a dead key hold the
 *    label at `custom` for ever would make every toolset un-selectable-looking for no reason the
 *    reader could see;
 *  - a line with no mode reads as {@link MODE_WHEN_UNSET}, and an implementation nobody chose is
 *    ours — which is how each is drawn, so what matches is what is on the screen.
 */
export function toolsetSignature(toolset: Toolset, registered?: readonly string[]): string {
  const known = registered === undefined ? undefined : new Set(registered);
  const lines: Array<[string, PermissionMode, ToolImplementation | ""]> = [];
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "tool") {
      if (!holdsTool(toolset, subject)) continue;
      if (known !== undefined && !known.has(subject)) continue;
      lines.push([subject, entry.mode ?? MODE_WHEN_UNSET, entry.implementation ?? "app"]);
    } else {
      lines.push([subject, entry.mode ?? MODE_WHEN_UNSET, ""]);
    }
  }
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({ lines, other: toolset.other ?? MODE_WHEN_UNSET });
}

/** Do two toolsets say exactly the same thing? See {@link toolsetSignature}. */
export function sameToolset(a: Toolset, b: Toolset, registered?: readonly string[]): boolean {
  return toolsetSignature(a, registered) === toolsetSignature(b, registered);
}

/**
 * Which toolset of `bucket` this map IS, or `undefined` for one that is nobody's — `custom`.
 *
 * A map that holds nothing at all matches nothing: "no tools were declared" is not a toolset, and a
 * bucket could otherwise claim every undeclared conversation with an empty file.
 */
export function matchToolset(
  current: Toolset,
  choices: readonly ToolsetChoice[],
  bucket: string,
  registered?: readonly string[],
): ToolsetChoice | undefined {
  if (Object.keys(current.entries).length === 0) return undefined;
  const signature = toolsetSignature(current, registered);
  return choices.find((choice) => choice.bucket === bucket && toolsetSignature(parseToolset(choice.decl).toolset, registered) === signature);
}

/**
 * The bucket a conversation opens on: the bucket of the toolset its state names.
 *
 * A loaded state holds the list and block its toolset LOWERED to — the reference it was written as
 * is gone by the time anybody plans a message — so "the toolset its state names" is found the way
 * every label here is, by match: the first bucket holding a toolset this map exactly is, the default
 * bucket tried first. A state that names none, or starts from one and says more, opens on `chat`.
 */
export function bucketOf(current: Toolset, choices: readonly ToolsetChoice[], registered?: readonly string[]): string {
  const buckets = [DEFAULT_TOOLSET_BUCKET, ...choices.map((choice) => choice.bucket)];
  for (const bucket of new Set(buckets)) {
    if (matchToolset(current, choices, bucket, registered) !== undefined) return bucket;
  }
  return DEFAULT_TOOLSET_BUCKET;
}

// --- the words ---------------------------------------------------------------

/**
 * What the SHIPPED toolsets are called and what each is for.
 *
 * A toolset file is a map from a subject to a mode and nothing else (decision 0007 §1), so it has
 * nowhere to keep a sentence about itself. These are the words for the files JaiRA ships, kept
 * beside the code that ships them — the same arrangement as a tool's `label` and `hint` in
 * `toolVocabulary.ts`. A toolset anybody else writes is called by its file name and described by
 * what is in it ({@link toolsetSummary}).
 */
const SHIPPED_TOOLSET_WORDS: Readonly<Record<string, { label: string; hint: string; glyph: PermissionMode }>> = {
  "chat/ask-first": { label: "ask first", hint: "stop and ask before every call", glyph: "ask" },
  "chat/read-only": { label: "read-only", hint: "reading goes ahead, anything that writes is refused", glyph: "deny" },
  "chat/auto": { label: "auto", hint: "each call decided by the approver", glyph: "smart" },
  "chat/full": { label: "full access", hint: "anything, without asking", glyph: "allow" },
  "chat_control/ask-first": { label: "ask first", hint: "ask before starting, moving or answering anything", glyph: "ask" },
  "chat_control/read-only": { label: "read-only", hint: "may look at tasks and workflows; starts and moves nothing", glyph: "deny" },
  "chat_control/auto": { label: "auto", hint: "each call decided by the approver", glyph: "smart" },
  "chat_control/full": { label: "full access", hint: "steer without asking", glyph: "allow" },
};

/** The order the shipped NAMES are listed in, strictest-sounding first — the order the presets had. */
const SHIPPED_NAME_ORDER: readonly string[] = ["ask-first", "read-only", "auto", "full"];

/**
 * The toolsets of one bucket, in the order its rows are drawn: the four names that ship in the
 * order the presets always had, then anybody else's by name.
 */
export function toolsetsOfBucket(choices: readonly ToolsetChoice[], bucket: string): ToolsetChoice[] {
  const rank = (choice: ToolsetChoice): number => {
    const at = SHIPPED_NAME_ORDER.indexOf(choice.name);
    return at === -1 ? SHIPPED_NAME_ORDER.length : at;
  };
  return choices
    .filter((choice) => choice.bucket === bucket)
    .sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The MODE whose glyph stands beside a toolset's name — a shut lock, a shield, a star, an open lock.
 *
 * The shipped ones are told, because `chat_control`'s four all refuse everything else and would
 * otherwise all wear the shield. Anybody else's wears the glyph of its `other`, which is the one line
 * every toolset has.
 */
export function toolsetGlyph(choice: ToolsetChoice): PermissionMode {
  return SHIPPED_TOOLSET_WORDS[choice.id]?.glyph ?? parseToolset(choice.decl).toolset.other ?? MODE_WHEN_UNSET;
}

const SHIPPED_BUCKET_HINTS: Readonly<Record<string, string>> = {
  chat_control: "its own four — the task and workflow tools only",
};

/** What a toolset is called on a row and on the chip. */
export function toolsetLabel(choice: Pick<ToolsetChoice, "id" | "name">): string {
  return SHIPPED_TOOLSET_WORDS[choice.id]?.label ?? choice.name;
}

/**
 * A toolset in a line, from what is in it: `9 lines · all ask`, `7 lines · other deny`.
 *
 * "All" only when every line AND `other` agree, because that is the one case where the count is the
 * less interesting half.
 */
export function toolsetSummary(toolset: Toolset): string {
  const modes = Object.values(toolset.entries).map((entry) => entry.mode ?? MODE_WHEN_UNSET);
  const other = toolset.other ?? MODE_WHEN_UNSET;
  const count = `${modes.length} ${modes.length === 1 ? "line" : "lines"}`;
  const word = (mode: PermissionMode): string => (mode === "smart" ? "auto" : mode);
  return modes.length > 0 && modes.every((mode) => mode === other) ? `${count} · all ${word(other)}` : `${count} · other ${word(other)}`;
}

/** The sentence under a toolset's name: the shipped words for a shipped file, a summary otherwise. */
export function toolsetHint(choice: ToolsetChoice): string {
  const shipped = choice.layer === "system" ? SHIPPED_TOOLSET_WORDS[choice.id]?.hint : undefined;
  return shipped ?? toolsetSummary(parseToolset(choice.decl).toolset);
}

// --- the hierarchy ------------------------------------------------------------

/** One row of the bucket picker. */
export interface ToolsetBucket {
  /** The folder path — `feature/implementation`. */
  path: string;
  /** Its own name — `implementation`. */
  name: string;
  /** How far in it sits: 0 for a top-level bucket. */
  depth: number;
  /**
   * The layer that DEFINES it: the furthest-back layer any of its toolsets comes from, so a shipped
   * bucket with one file overridden here is still the shipped bucket. A folder holding only other
   * buckets takes it from what is inside.
   */
  layer: WorkflowLayer;
  /** The toolsets directly in it. */
  toolsets: ToolsetChoice[];
  /** What it holds, in a line. */
  hint: string;
}

const LAYER_DEPTH: Readonly<Record<WorkflowLayer, number>> = { system: 0, base: 1, project: 2 };

/**
 * The bucket hierarchy, parents before children, siblings by name.
 *
 * A folder that only holds other buckets is listed too — `feature`, above
 * `feature/implementation` — because the picker draws the tree and a child indented under nothing
 * reads as a mistake.
 */
export function toolsetBuckets(choices: readonly ToolsetChoice[]): ToolsetBucket[] {
  const paths = new Set<string>();
  for (const choice of choices) {
    const parts = choice.bucket.split("/");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  // Segment-wise, so `chat` sorts ahead of `chat_control` and a child directly under its parent.
  const ordered = [...paths].sort((a, b) => {
    const left = a.split("/");
    const right = b.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
    }
    return left.length - right.length;
  });
  return ordered.map((path) => {
    const own = toolsetsOfBucket(choices, path);
    const under = choices.filter((choice) => choice.bucket === path || choice.bucket.startsWith(`${path}/`));
    const inside = ordered.filter((other) => other.startsWith(`${path}/`) && !other.slice(path.length + 1).includes("/")).length;
    const layer = under.reduce<WorkflowLayer>((deepest, choice) => (LAYER_DEPTH[choice.layer] < LAYER_DEPTH[deepest] ? choice.layer : deepest), "project");
    const counted = `${own.length} ${own.length === 1 ? "toolset" : "toolsets"}`;
    const hint =
      (layer === "system" ? SHIPPED_BUCKET_HINTS[path] : undefined) ??
      (inside > 0 ? `${counted}, and ${inside} ${inside === 1 ? "bucket" : "buckets"} inside` : own.map(toolsetLabel).join(" · "));
    return { path, name: path.slice(path.lastIndexOf("/") + 1), depth: path.split("/").length - 1, layer, toolsets: own, hint };
  });
}

/** A layer, as the picker names it beside a bucket. */
export const TOOLSET_LAYER_LABELS: Readonly<Record<WorkflowLayer, string>> = {
  system: "built in",
  base: "all projects",
  project: "this project",
};

// --- keeping a map as a new toolset ------------------------------------------

/**
 * Is this a name a toolset FILE can have? One path segment, the characters a reference can carry.
 *
 * Returns what is wrong with it, or `undefined`. Shared so the form that asks and the write that
 * refuses say the same sentence.
 */
export function toolsetNameProblem(name: string): string | undefined {
  if (name.length === 0) return "a toolset needs a name";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return "a name is letters, digits, '-', '_' and '.', starting with a letter or a digit";
  return undefined;
}

/** The same for a bucket path: one or more such segments. */
export function toolsetBucketProblem(bucket: string): string | undefined {
  if (bucket.length === 0) return "a toolset lives in a bucket";
  for (const segment of bucket.split("/")) {
    if (toolsetNameProblem(segment) !== undefined) return `'${bucket}' is not a bucket — each folder is letters, digits, '-', '_' and '.'`;
  }
  return undefined;
}
