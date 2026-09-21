/**
 * A state's `tools`, as ONE field: the toolset it starts from, and the lines it writes over it
 * (decision 0007 §1 and §6).
 *
 * ```jsonc
 * "tools": "$/toolsets/chat/read-only"                                   // names one
 * "tools": { "$ref": "$/toolsets/chat/read-only", "write_file": "ask" }  // starts from one, says more
 * "tools": { "read_file": "allow", "other": "deny" }                     // lines of its own only
 * ```
 *
 * All three are this form: a `reference` (empty for none) and `lines`. A state still written the old
 * way — `tools` as a LIST, or a `permissions` block — is NOT: {@link toolsFieldOf} answers
 * `undefined` for it, and the editor keeps showing the two old fields unchanged. Which of the two a
 * state means is chosen when it is migrated (0007 step 7), never by opening it in a form.
 *
 * Pure, and beside the component rather than in it, because there is no DOM harness here: the
 * round-trip (document → form → document) is the part that can lose somebody's line, so it is the
 * part that is tested.
 */
import {
  MODE_WHEN_UNSET,
  parseToolset,
  TOOLSET_LAYER_LABELS,
  TOOLSET_REF_KEY,
  toolsetsOfBucket,
  type Toolset,
  type ToolsetChoice,
  type ToolsetDecl,
} from "@jaira/shared/browser";

export interface ToolsFieldForm {
  /** The toolset the state starts from, as written — `$/toolsets/chat/read-only`. Empty ⇒ none. */
  reference: string;
  /** The lines the state writes itself: over the toolset, or on their own. */
  lines: ToolsetDecl;
  /**
   * Sibling keys this form could not read as a line (a mode nobody knows, a nested object). Carried
   * through untouched: the linter is where they are reported, and an editor that dropped what it
   * could not draw would be deleting the evidence.
   */
  unread: Record<string, unknown>;
}

export const NO_TOOLS: ToolsFieldForm = { reference: "", lines: {}, unread: {} };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a `tools` value into the form, or `undefined` when it is not the form's to edit: the LIST of
 * an unmigrated state, or an object carrying an instruction other than `$ref` (a binding, which the
 * engine reads a non-array `tools` as and a toolset never is).
 */
export function toolsFieldOf(raw: unknown): ToolsFieldForm | undefined {
  if (raw === undefined) return NO_TOOLS;
  if (typeof raw === "string") return { reference: raw, lines: {}, unread: {} };
  if (!isPlainObject(raw)) return undefined;
  const reference = raw[TOOLSET_REF_KEY];
  if (reference !== undefined && typeof reference !== "string") return undefined;
  const lines: ToolsetDecl = {};
  const unread: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === TOOLSET_REF_KEY) continue;
    if (key.startsWith("$")) return undefined;
    // One line at a time through the real reader, so "can this be drawn" and "will this load" agree.
    // A name no tool has is only a WARNING there — reported and dropped — so "it produced a line"
    // is the test, not "it produced no error".
    const read = parseToolset({ [key]: value }).toolset;
    if (Object.keys(read.entries).length === 0 && read.other === undefined) unread[key] = value;
    else lines[key] = value as ToolsetDecl[string];
  }
  return { reference: reference ?? "", lines, unread };
}

/**
 * Does a block show the ONE Tools field? Yes when its `tools` is the form's — and, where it has no
 * `tools` at all, only when it has no old `permissions` block either: that block is the other half
 * of the legacy statement, and a state that carries one is unmigrated whatever its `tools` says.
 */
export function showsToolsField(op: Record<string, unknown>): boolean {
  const field = toolsFieldOf(op["tools"]);
  if (field === undefined) return false;
  if (op["tools"] !== undefined) return true;
  const permissions = op["permissions"];
  return !isPlainObject(permissions) || (permissions["profile"] === undefined && permissions["default"] === undefined && permissions["tools"] === undefined);
}

/**
 * The form, as the `tools` value to write — `undefined` to write none.
 *
 * The three spellings, each used where it is the plain one: a bare string when the state only names
 * a toolset, `$ref` plus siblings when it says more, a map when it names none. `previous` is handed
 * back AS IT WAS when it already says this, so opening and saving a state does not re-spell a
 * `{ "$ref": … }` somebody wrote as an object, or reorder their lines.
 */
export function applyToolsField(previous: unknown, form: ToolsFieldForm): unknown {
  const was = toolsFieldOf(previous);
  if (was !== undefined && sameToolsField(was, form)) return previous;
  const reference = form.reference.trim();
  const siblings = { ...form.unread, ...form.lines };
  if (reference.length === 0) return Object.keys(siblings).length === 0 ? undefined : siblings;
  return Object.keys(siblings).length === 0 ? reference : { [TOOLSET_REF_KEY]: reference, ...siblings };
}

function sameToolsField(a: ToolsFieldForm, b: ToolsFieldForm): boolean {
  // Order counts: lines are drawn and written in authored order, and reordering them is an edit.
  return a.reference.trim() === b.reference.trim() && JSON.stringify(a.lines) === JSON.stringify(b.lines) && JSON.stringify(a.unread) === JSON.stringify(b.unread);
}

// --- the lines, as the rows take them -------------------------------------------------

/** The lines as a {@link Toolset}, for the rows. Its `other` is set only when a line writes it. */
export function toolsetOfLines(lines: ToolsetDecl): Toolset {
  return parseToolset(lines).toolset;
}

/**
 * A {@link Toolset} of lines, back as the map a state writes.
 *
 * NOT `declOfToolset`: that one always writes `other`, because a whole toolset should say what
 * happens to everything it does not name. Lines over a toolset say only what they change — writing
 * `other` here would override the toolset's own on every state that was opened in the form.
 */
export function linesOfToolset(toolset: Toolset): ToolsetDecl {
  const out: ToolsetDecl = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    const mode = entry.mode ?? MODE_WHEN_UNSET;
    out[subject] = entry.kind === "tool" && entry.implementation === "native" ? { mode, implementation: "native" } : mode;
  }
  if (toolset.other !== undefined) out["other"] = toolset.other;
  return out;
}

// --- the picker -----------------------------------------------------------------------

/** How a state names a toolset on the layered search path. */
export const toolsetReference = (id: string): string => `$/toolsets/${id}`;

export const NO_TOOLSET_LABEL = "none — lines of its own only";

export interface ToolsetPick {
  /** `chat / read-only — this project`. What the picker lists, and what it hands back. */
  label: string;
  /** What is written: `$/toolsets/chat/read-only`, or empty for none. */
  reference: string;
}

/**
 * The picker's rows: every toolset the project can name as `bucket / name — layer`, bucket by
 * bucket in row order, then "none". A reference the state already holds that is NOT one of them — an
 * explicit root, a relative path, a toolset since deleted — is listed first, as written, so opening
 * the form never shows a state naming something other than what it names.
 */
export function toolsetPicks(toolsets: readonly ToolsetChoice[], reference: string): ToolsetPick[] {
  const buckets = [...new Set(toolsets.map((choice) => choice.bucket))].sort();
  const picks = buckets.flatMap((bucket) =>
    toolsetsOfBucket(toolsets, bucket).map((choice) => ({
      label: `${choice.bucket.split("/").join(" / ")} / ${choice.name} — ${TOOLSET_LAYER_LABELS[choice.layer]}`,
      reference: toolsetReference(choice.id),
    })),
  );
  const held = reference.trim();
  const known = held.length === 0 || picks.some((pick) => pick.reference === held);
  return [...(known ? [] : [{ label: `${held} — as written`, reference: held }]), ...picks, { label: NO_TOOLSET_LABEL, reference: "" }];
}

/** The pick a reference is, and the reference a picked label writes — `undefined` for a label nobody offered. */
export function pickOfReference(picks: readonly ToolsetPick[], reference: string): ToolsetPick {
  return picks.find((pick) => pick.reference === reference.trim()) ?? picks[picks.length - 1]!;
}
export function referenceOfLabel(picks: readonly ToolsetPick[], label: string): string | undefined {
  return picks.find((pick) => pick.label === label)?.reference;
}
