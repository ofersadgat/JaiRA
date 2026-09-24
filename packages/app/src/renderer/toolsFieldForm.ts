/**
 * A state's `tools`, as ONE field: the permission set it starts from, and the lines it writes over it
 * (decision 0007 §1 and §6).
 *
 * ```jsonc
 * "tools": "$/permission-sets/chat/read-only"                                   // names one
 * "tools": { "$ref": "$/permission-sets/chat/read-only", "write_file": "ask" }  // starts from one, says more
 * "tools": { "read_file": "allow", "other": "deny" }                     // lines of its own only
 * ```
 *
 * All three are this form: a `reference` (empty for none) and `lines`. A value that is not a permission set —
 * a binding the engine resolves — is NOT: {@link toolsFieldOf} answers `undefined` for it, and the
 * editor shows it read-only.
 *
 * Pure, and beside the component rather than in it, because there is no DOM harness here: the
 * round-trip (document → form → document) is the part that can lose somebody's line, so it is the
 * part that is tested.
 */
import {
  MODE_WHEN_UNSET,
  parsePermissionSet,
  PERMISSION_SET_LAYER_LABELS,
  PERMISSION_SET_REF_KEY,
  permissionSetsOfBucket,
  type PermissionSet,
  type PermissionSetChoice,
  type PermissionSetDecl,
} from "@jaira/shared/browser";

export interface ToolsFieldForm {
  /** The permission set the state starts from, as written — `$/permission-sets/chat/read-only`. Empty ⇒ none. */
  reference: string;
  /** The lines the state writes itself: over the permission set, or on their own. */
  lines: PermissionSetDecl;
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
 * Read a `tools` value into the form, or `undefined` when it is not the form's to edit: an object
 * carrying an instruction other than `$ref` (a binding, which the engine reads a non-array `tools` as
 * and a permission set never is), or anything else that is no permission set — a list included, which the linter
 * refuses.
 */
export function toolsFieldOf(raw: unknown): ToolsFieldForm | undefined {
  if (raw === undefined) return NO_TOOLS;
  if (typeof raw === "string") return { reference: raw, lines: {}, unread: {} };
  if (!isPlainObject(raw)) return undefined;
  const reference = raw[PERMISSION_SET_REF_KEY];
  if (reference !== undefined && typeof reference !== "string") return undefined;
  const lines: PermissionSetDecl = {};
  const unread: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === PERMISSION_SET_REF_KEY) continue;
    if (key.startsWith("$")) return undefined;
    // One line at a time through the real reader, so "can this be drawn" and "will this load" agree.
    // A name no tool has is only a WARNING there — reported and dropped — so "it produced a line"
    // is the test, not "it produced no error".
    const read = parsePermissionSet({ [key]: value }).permissionSet;
    if (Object.keys(read.entries).length === 0 && read.other === undefined) unread[key] = value;
    else lines[key] = value as PermissionSetDecl[string];
  }
  return { reference: reference ?? "", lines, unread };
}

/** Does a block show the ONE Tools field? Yes when its `tools` is the form's to edit. */
export function showsToolsField(op: Record<string, unknown>): boolean {
  return toolsFieldOf(op["tools"]) !== undefined;
}

/**
 * The form, as the `tools` value to write — `undefined` to write none.
 *
 * The three spellings, each used where it is the plain one: a bare string when the state only names
 * a permission set, `$ref` plus siblings when it says more, a map when it names none. `previous` is handed
 * back AS IT WAS when it already says this, so opening and saving a state does not re-spell a
 * `{ "$ref": … }` somebody wrote as an object, or reorder their lines.
 */
export function applyToolsField(previous: unknown, form: ToolsFieldForm): unknown {
  const was = toolsFieldOf(previous);
  if (was !== undefined && sameToolsField(was, form)) return previous;
  const reference = form.reference.trim();
  const siblings = { ...form.unread, ...form.lines };
  if (reference.length === 0) return Object.keys(siblings).length === 0 ? undefined : siblings;
  return Object.keys(siblings).length === 0 ? reference : { [PERMISSION_SET_REF_KEY]: reference, ...siblings };
}

function sameToolsField(a: ToolsFieldForm, b: ToolsFieldForm): boolean {
  // Order counts: lines are drawn and written in authored order, and reordering them is an edit.
  return a.reference.trim() === b.reference.trim() && JSON.stringify(a.lines) === JSON.stringify(b.lines) && JSON.stringify(a.unread) === JSON.stringify(b.unread);
}

// --- the lines, as the rows take them -------------------------------------------------

/** The lines as a {@link Permission set}, for the rows. Its `other` is set only when a line writes it. */
export function permissionSetOfLines(lines: PermissionSetDecl): PermissionSet {
  return parsePermissionSet(lines).permissionSet;
}

/**
 * A {@link Permission set} of lines, back as the map a state writes.
 *
 * NOT `declOfPermissionSet`: that one always writes `other`, because a whole permission set should say what
 * happens to everything it does not name. Lines over a permission set say only what they change — writing
 * `other` here would override the permission set's own on every state that was opened in the form.
 */
export function linesOfPermissionSet(permissionSet: PermissionSet): PermissionSetDecl {
  const out: PermissionSetDecl = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    const mode = entry.mode ?? MODE_WHEN_UNSET;
    out[subject] = entry.kind === "tool" && entry.implementation === "native" ? { mode, implementation: "native" } : mode;
  }
  if (permissionSet.other !== undefined) out["other"] = permissionSet.other;
  return out;
}

// --- the picker -----------------------------------------------------------------------

/** How a state names a permission set on the layered search path. */
export const permissionSetReference = (id: string): string => `$/permission-sets/${id}`;

export const NO_PERMISSION_SET_LABEL = "none — lines of its own only";

export interface PermissionSetPick {
  /** `chat / read-only — this project`. What the picker lists, and what it hands back. */
  label: string;
  /** What is written: `$/permission-sets/chat/read-only`, or empty for none. */
  reference: string;
}

/**
 * The picker's rows: every permission set the project can name as `bucket / name — layer`, bucket by
 * bucket in row order, then "none". A reference the state already holds that is NOT one of them — an
 * explicit root, a relative path, a permission set since deleted — is listed first, as written, so opening
 * the form never shows a state naming something other than what it names.
 */
export function permissionSetPicks(permissionSets: readonly PermissionSetChoice[], reference: string): PermissionSetPick[] {
  const buckets = [...new Set(permissionSets.map((choice) => choice.bucket))].sort();
  const picks = buckets.flatMap((bucket) =>
    permissionSetsOfBucket(permissionSets, bucket).map((choice) => ({
      label: `${choice.bucket.split("/").join(" / ")} / ${choice.name} — ${PERMISSION_SET_LAYER_LABELS[choice.layer]}`,
      reference: permissionSetReference(choice.id),
    })),
  );
  const held = reference.trim();
  const known = held.length === 0 || picks.some((pick) => pick.reference === held);
  return [...(known ? [] : [{ label: `${held} — as written`, reference: held }]), ...picks, { label: NO_PERMISSION_SET_LABEL, reference: "" }];
}

/** The pick a reference is, and the reference a picked label writes — `undefined` for a label nobody offered. */
export function pickOfReference(picks: readonly PermissionSetPick[], reference: string): PermissionSetPick {
  return picks.find((pick) => pick.reference === reference.trim()) ?? picks[picks.length - 1]!;
}
export function referenceOfLabel(picks: readonly PermissionSetPick[], label: string): string | undefined {
  return picks.find((pick) => pick.label === label)?.reference;
}
