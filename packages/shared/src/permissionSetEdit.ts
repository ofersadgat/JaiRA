/**
 * Writing a line into a permission set FILE — "add to the permission set" (decision 0007 §4), as text in, text out.
 *
 * Pure: the caller reads and writes the file (`@jaira/persistence` `addToPermissionSet`). Two cases:
 *
 *  - the chosen layer HOLDS the file → a format-preserving edit, located with `jsonc-parser`'s tree
 *    and made by hand: one value replaced where it stands, or one line added after the last. Key
 *    order, indentation, line endings and blank lines survive, and an entry written as
 *    `{ mode, implementation }` keeps its implementation;
 *  - the chosen layer does not, and a LOWER layer does → an OVERRIDE that keeps following what it
 *    overrides: `{ "$ref": "$SYSTEM/permission-sets/<bucket>/<name>", "<subject>": "<mode>" }`. The root is
 *    written out (`$SYSTEM`, `$BASE`) because a bare `$` is searched from the top layer down and
 *    would find the override itself. A copy would freeze the lower file at today's entries; this one
 *    inherits tomorrow's.
 *
 * Not a Node module on purpose (the renderer imports `@jaira/shared/browser`), though only the main
 * process calls it.
 */
import { findNodeAtLocation, parse as parseJsonc, parseTree, type Node, type ParseError } from "jsonc-parser";
import type { PermissionMode, PermissionModeDecl } from "./operationVocabulary";
import {
  entryDeclOf,
  entryOfDecl,
  mergePermissionMode,
  MODE_WHEN_UNSET,
  OTHER_SUBJECT,
  isPermissionSetInstructionKey,
  PERMISSION_SET_ICON_KEY,
  PERMISSION_SET_LAYERS_KEY,
  PERMISSION_SET_REF_KEY,
  type PermissionSetDecl,
  type PermissionSetEntryDecl,
} from "./permissionSets";

/** One of the two answers a person can give, as a line writes it. */
export type AdditionDecision = Extract<PermissionMode, "allow" | "deny">;

/**
 * What a remembered answer writes: a subject and one of the two modes a person can answer with — or,
 * for an answer kept at a PLACE (decision 0023 §3.8, §4.4), that place and its decision
 * (`"npm run build": { "packages": "deny" }`), merged into the line rather than replacing it.
 */
export type PermissionSetAddition = Record<string, AdditionDecision | Record<string, AdditionDecision>>;

/**
 * The value a line holds once an addition is written into it (decision 0023 §2.8): a plain decision
 * replaces the line, since it covers everywhere; a place joins it — a line that is already a place map
 * gains the place (the same place takes the newer decision), and a plain line `x` becomes
 * `{ "**": x, "<place>": decision }`. The same rule a newer layer's line follows over an older one's
 * (`mergePermissionMode`), because writing into a layer is saying something newer in it.
 */
export function addedValueOf(held: unknown, added: PermissionSetAddition[string]): unknown {
  if (typeof added === "string") return added;
  const mode = held !== null && typeof held === "object" && !Array.isArray(held) && Object.keys(held).every((key) => key === "mode" || key === "implementation") ? (held as Record<string, unknown>)["mode"] : held;
  const readable = typeof mode === "string" || (mode !== null && typeof mode === "object" && !Array.isArray(mode));
  return mergePermissionMode(readable ? (mode as PermissionModeDecl) : undefined, added);
}

const normalize = (subject: string): string => subject.trim().replace(/\s+/g, " ");

/**
 * `text` with one more property at the end of its root object, laid out as its neighbours are.
 *
 * By hand rather than `jsonc-parser`'s `modify`: that one re-lays-out the property BEFORE an
 * insertion, so a one-line `{ "mode": …, "implementation": … }` entry came back as four lines for
 * the crime of being last. Here nothing but the new line (and the comma it needs) is touched.
 */
function appendProperty(text: string, root: Node, key: string, valueText: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${JSON.stringify(key)}: ${valueText}`;
  const last = root.children?.at(-1);
  if (last === undefined) {
    return `${text.slice(0, root.offset)}{${eol}  ${line}${eol}}${text.slice(root.offset + root.length)}`;
  }
  // The indentation of the last property's own line; a file written on one line stays on one line.
  const lineStart = text.lastIndexOf("\n", last.offset) + 1;
  const lead = text.slice(lineStart, last.offset);
  const end = last.offset + last.length;
  const insertion = /^[ \t]*$/.test(lead) && lineStart > 0 ? `,${eol}${lead}${line}` : `, ${line}`;
  return text.slice(0, end) + insertion + text.slice(end);
}

/** The line(s) an addition writes, as a person reads them in the menu: `"git commit": "allow"`. */
export function describeAddition(entries: PermissionSetAddition): string {
  return Object.entries(entries)
    .map(([subject, mode]) => `${JSON.stringify(subject)}: ${inlineJson(mode)}`)
    .join(", ");
}

/** A new override file that keeps following `follows` (`$SYSTEM/permission-sets/chat/ask-first`). */
export function overridePermissionSetText(follows: string, entries: PermissionSetAddition): string {
  if (!/^\$[A-Z]+\//.test(follows)) {
    throw new Error(`an override follows an explicit root ('$SYSTEM/…', '$BASE/…') — '${follows}' would find the override itself`);
  }
  // A place is written alone on the override's line: what the line says elsewhere is the lower
  // layer's, which the override follows (decision 0023 §2.1 makes it the `**` when the two are merged).
  const lines = [`  ${JSON.stringify(PERMISSION_SET_REF_KEY)}: ${JSON.stringify(follows)}`, ...Object.entries(entries).map(([s, m]) => `  ${JSON.stringify(normalize(s))}: ${inlineJson(m)}`)];
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** Does this permission set file start from `follows` — is it an override that keeps following that one? */
export function permissionSetTextFollows(text: string, follows: string): boolean {
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true });
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>)[PERMISSION_SET_REF_KEY] === follows;
}

/**
 * `text` with the entries set, everything else as it was written.
 *
 * Throws when the file is not a permission set MAP — unparsable, a list (which is no permission set, and has no
 * place for a command subject), or a bare reference. `other` and `$ref` are never written: a remembered answer
 * is about a subject.
 */
export function addToPermissionSetText(text: string, entries: PermissionSetAddition): string {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("the permission set file does not parse as JSON, so nothing was written to it");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the permission set file is not a map from a subject to a mode, so there is no place in it for a line");
  }
  let out = text;
  for (const [rawSubject, mode] of Object.entries(entries)) {
    const subject = normalize(rawSubject);
    if (subject.length === 0 || subject.startsWith("$") || subject === OTHER_SUBJECT || isPermissionSetInstructionKey(subject)) {
      throw new Error(`'${rawSubject}' is not a subject an answer can be remembered at`);
    }
    const current = parseJsonc(out, [], { allowTrailingComma: true }) as Record<string, unknown>;
    // The key as its author spelled it (`"git  commit"`), so the edit lands on their line.
    const key = Object.keys(current).find((k) => normalize(k) === subject) ?? subject;
    const held = current[key];
    const isEntryObject = held !== null && typeof held === "object" && !Array.isArray(held);
    const tree = parseTree(out, [], { allowTrailingComma: true })!;
    // A value already there is replaced where it stands — the `mode` alone of an entry written as the
    // wrapper, so its implementation stays — and a new subject goes on a line of its own. A plain
    // answer replaces a PLACE MAP whole, since it covers everywhere (decision 0023 §2.1); an answer at
    // a place joins the line instead ({@link addedValueOf}).
    const wrapper = isEntryObject && findNodeAtLocation(tree, [key, "mode"]) !== undefined && Object.keys(held as object).every((k) => k === "mode" || k === "implementation");
    const node = (wrapper ? findNodeAtLocation(tree, [key, "mode"]) : undefined) ?? findNodeAtLocation(tree, [key]);
    const valueText = inlineJson(addedValueOf(held, mode));
    out = node !== undefined ? out.slice(0, node.offset) + valueText + out.slice(node.offset + node.length) : appendProperty(out, tree, key, valueText);
  }
  return out;
}

// --- the whole map (decision 0007 §6) ------------------------------------------
//
// "Add to the permission set" writes a line. Settings → Permission sets writes a PERMISSION_SET: lines added, lines
// re-moded, lines taken out. Same rule — text in, text out, and nothing a person laid out is moved
// that did not have to be.

/**
 * An entry as one comparable thing: a bare mode and `{ mode }` say the same, a function is its name
 * however it is spaced, a place map is its places (`**` first), and ours is the default. One that does
 * not read compares as what was written.
 */
function entryKey(entry: PermissionSetEntryDecl | undefined): string | undefined {
  if (entry === undefined) return undefined;
  const parts = entryOfDecl(entry);
  if (Object.keys(parts).length === 0) return `unread:${JSON.stringify(entry)}`;
  return `${JSON.stringify(entryDeclOf({ ...parts, implementation: "app" }))}/${parts.implementation ?? "app"}`;
}

/** A value as one line of JSON, spaced as a person writes it: `{ "src": "allow", "**": "ask" }`. */
function inlineJson(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const fields = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`);
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** An entry as it is written on one line — a function by its name, a place map inline, beside its implementation. */
function entryText(entry: PermissionSetEntryDecl): string {
  const parts = entryOfDecl(entry);
  return Object.keys(parts).length === 0 ? inlineJson(entry) : inlineJson(entryDeclOf(parts));
}

/** Do two entries say the same thing? `other` left out reads as the mode an unset line reads as. */
export function samePermissionSetEntry(subject: string, a: PermissionSetEntryDecl | undefined, b: PermissionSetEntryDecl | undefined): boolean {
  const unset = subject === OTHER_SUBJECT ? `${JSON.stringify(MODE_WHEN_UNSET)}/app` : undefined;
  return (entryKey(a) ?? unset) === (entryKey(b) ?? unset);
}

/**
 * What a map says OVER the one it starts from — the sibling keys of an override.
 *
 * `{ "$ref": …, …siblings }` can add a line and change one; it has no way to take one OUT, because
 * absent means "as the lower layer says". So a `next` that no longer holds something `base` does
 * cannot be written as an override: `dropped` names those subjects, and the caller writes the whole
 * map instead — a file that has stopped following.
 */
export function overridesOf(base: PermissionSetDecl, next: PermissionSetDecl): { siblings: PermissionSetDecl; dropped: string[] } {
  const siblings: PermissionSetDecl = {};
  for (const [subject, entry] of Object.entries(next)) {
    if (!samePermissionSetEntry(subject, Object.hasOwn(base, subject) ? base[subject] : undefined, entry)) siblings[subject] = entry;
  }
  const dropped = Object.keys(base).filter((subject) => subject !== OTHER_SUBJECT && !isPermissionSetInstructionKey(subject) && !Object.hasOwn(next, subject));
  return { siblings, dropped };
}

/** A NEW permission set file: the map, one line per subject, `$ref` first when it starts from another. */
export function newPermissionSetText(next: PermissionSetDecl, follows?: string): string {
  if (follows !== undefined && !/^\$[A-Z]+\//.test(follows)) {
    throw new Error(`an override follows an explicit root ('$SYSTEM/…', '$BASE/…') — '${follows}' would find the override itself`);
  }
  const lines = [
    ...(follows !== undefined ? [`  ${JSON.stringify(PERMISSION_SET_REF_KEY)}: ${JSON.stringify(follows)}`] : []),
    ...Object.entries(next).map(([subject, entry]) => `  ${JSON.stringify(normalize(subject))}: ${entryText(entry)}`),
  ];
  return lines.length === 0 ? "{}\n" : `{\n${lines.join(",\n")}\n}\n`;
}

/** `text` without the root property at `index`: its line when it has one to itself, its comma either way. */
function removeProperty(text: string, root: Node, index: number): string {
  const props = root.children ?? [];
  const prop = props[index]!;
  const prev = props[index - 1];
  const next = props[index + 1];
  const end = prop.offset + prop.length;
  // The last of several: the comma that goes is the one BEFORE it, with whatever lay between.
  if (next === undefined && prev !== undefined) return text.slice(0, prev.offset + prev.length) + text.slice(end);
  let stop = end;
  if (next !== undefined) {
    const comma = text.indexOf(",", end);
    if (comma !== -1 && comma < next.offset) stop = comma + 1;
  }
  const lineStart = text.lastIndexOf("\n", prop.offset - 1) + 1;
  const rest = /^[ \t]*\r?\n/.exec(text.slice(stop));
  if (/^[ \t]*$/.test(text.slice(lineStart, prop.offset)) && rest !== null) return text.slice(0, lineStart) + text.slice(stop + rest[0].length);
  return text.slice(0, prop.offset) + text.slice(stop + /^[ \t]*/.exec(text.slice(stop))![0].length);
}

/** `text` with one more root property, written BEFORE the property at `index` and laid out as it is. */
function insertPropertyBefore(text: string, root: Node, index: number, key: string, valueText: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const at = root.children![index]!;
  const line = `${JSON.stringify(key)}: ${valueText}`;
  const lineStart = text.lastIndexOf("\n", at.offset) + 1;
  const lead = text.slice(lineStart, at.offset);
  return /^[ \t]*$/.test(lead) && lineStart > 0
    ? `${text.slice(0, lineStart)}${lead}${line},${eol}${text.slice(lineStart)}`
    : `${text.slice(0, at.offset)}${line}, ${text.slice(at.offset)}`;
}

/**
 * `text` saying exactly `next` — and, when `follows` is given, starting from that reference.
 *
 * A line whose entry is unchanged is not touched, one whose entry changed has its VALUE replaced where
 * it stands, one `next` does not hold loses its line, and a new one goes after the last — before
 * `other`, which a person reads as the last line of a permission set and which therefore stays it. A `$ref`
 * the file has is kept when it is `follows`, re-pointed when it is another, and removed when
 * `follows` is absent: that is a file that has stopped following.
 *
 * Throws for a file that does not parse or is not a map, having changed nothing.
 */
export function setPermissionSetText(text: string, next: PermissionSetDecl, follows?: string): string {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("the permission set file does not parse as JSON, so nothing was written to it");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the permission set file is not a map from a subject to a mode, so it cannot be edited line by line");
  }
  const wanted = new Map<string, PermissionSetEntryDecl>(Object.entries(next).map(([subject, entry]) => [normalize(subject), entry]));
  const tree = (source: string): Node => parseTree(source, [], { allowTrailingComma: true })!;
  const keyOf = (prop: Node): string => String(prop.children![0]!.value);
  let out = text;

  // Out, and changed — one edit at a time against a fresh tree, last property first so an offset
  // already used is never one that moved.
  for (let index = (tree(out).children ?? []).length - 1; index >= 0; index--) {
    const root = tree(out);
    const prop = root.children![index]!;
    const key = keyOf(prop);
    const valueNode = prop.children![1]!;
    const replace = (value: string): string => out.slice(0, valueNode.offset) + value + out.slice(valueNode.offset + valueNode.length);
    // The stack a file is built from, and its icon, are no lines: they stay as they are written.
    if (key === PERMISSION_SET_LAYERS_KEY || key === PERMISSION_SET_ICON_KEY) continue;
    if (key === PERMISSION_SET_REF_KEY) {
      if (follows === undefined) out = removeProperty(out, root, index);
      else if (valueNode.value !== follows) out = replace(JSON.stringify(follows));
      continue;
    }
    const subject = normalize(key);
    const entry = wanted.get(subject);
    if (entry === undefined) {
      out = removeProperty(out, root, index);
      continue;
    }
    const held = (parsed as Record<string, unknown>)[key];
    const readable = typeof held === "string" || (held !== null && typeof held === "object" && !Array.isArray(held));
    if (!readable || !samePermissionSetEntry(subject, held as PermissionSetEntryDecl, entry)) out = replace(entryText(entry));
  }

  // In. `$ref` first, when the file is to start from one and does not.
  const has = (key: string): boolean => (tree(out).children ?? []).some((prop) => normalize(keyOf(prop)) === key);
  if (follows !== undefined && !has(PERMISSION_SET_REF_KEY)) {
    const root = tree(out);
    out = (root.children ?? []).length > 0 ? insertPropertyBefore(out, root, 0, PERMISSION_SET_REF_KEY, JSON.stringify(follows)) : newPermissionSetText({}, follows);
  }
  for (const [subject, entry] of wanted) {
    if (has(subject)) continue;
    const root = tree(out);
    const props = root.children ?? [];
    const last = props.at(-1);
    // `other` stays the last line; everything else goes after the last.
    if (subject !== OTHER_SUBJECT && last !== undefined && normalize(keyOf(last)) === OTHER_SUBJECT) {
      out = insertPropertyBefore(out, root, props.length - 1, subject, entryText(entry));
    } else {
      out = appendProperty(out, root, subject, entryText(entry));
    }
  }
  return out;
}
