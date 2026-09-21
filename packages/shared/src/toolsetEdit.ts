/**
 * Writing a line into a toolset FILE — "add to the toolset" (decision 0007 §4), as text in, text out.
 *
 * Pure: the caller reads and writes the file (`@jaira/persistence` `addToToolset`). Two cases:
 *
 *  - the chosen layer HOLDS the file → a format-preserving edit, located with `jsonc-parser`'s tree
 *    and made by hand: one value replaced where it stands, or one line added after the last. Key
 *    order, indentation, line endings and blank lines survive, and an entry written as
 *    `{ mode, implementation }` keeps its implementation;
 *  - the chosen layer does not, and a LOWER layer does → an OVERRIDE that keeps following what it
 *    overrides: `{ "$ref": "$SYSTEM/toolsets/<bucket>/<name>", "<subject>": "<mode>" }`. The root is
 *    written out (`$SYSTEM`, `$BASE`) because a bare `$` is searched from the top layer down and
 *    would find the override itself. A copy would freeze the lower file at today's entries; this one
 *    inherits tomorrow's.
 *
 * Not a Node module on purpose (the renderer imports `@jaira/shared/browser`), though only the main
 * process calls it.
 */
import { findNodeAtLocation, parse as parseJsonc, parseTree, type Node, type ParseError } from "jsonc-parser";
import type { PermissionMode } from "./operationVocabulary";
import { OTHER_SUBJECT, TOOLSET_REF_KEY } from "./toolsets";

/** What a remembered answer writes: a subject and one of the two modes a person can answer with. */
export type ToolsetAddition = Record<string, Extract<PermissionMode, "allow" | "deny">>;

const normalize = (subject: string): string => subject.trim().replace(/\s+/g, " ");

/**
 * `text` with one more property at the end of its root object, laid out as its neighbours are.
 *
 * By hand rather than `jsonc-parser`'s `modify`: that one re-lays-out the property BEFORE an
 * insertion, so a one-line `{ "mode": …, "implementation": … }` entry came back as four lines for
 * the crime of being last. Here nothing but the new line (and the comma it needs) is touched.
 */
function appendProperty(text: string, root: Node, key: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
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
export function describeAddition(entries: ToolsetAddition): string {
  return Object.entries(entries)
    .map(([subject, mode]) => `${JSON.stringify(subject)}: ${JSON.stringify(mode)}`)
    .join(", ");
}

/** A new override file that keeps following `follows` (`$SYSTEM/toolsets/chat/ask-first`). */
export function overrideToolsetText(follows: string, entries: ToolsetAddition): string {
  if (!/^\$[A-Z]+\//.test(follows)) {
    throw new Error(`an override follows an explicit root ('$SYSTEM/…', '$BASE/…') — '${follows}' would find the override itself`);
  }
  const lines = [`  ${JSON.stringify(TOOLSET_REF_KEY)}: ${JSON.stringify(follows)}`, ...Object.entries(entries).map(([s, m]) => `  ${JSON.stringify(normalize(s))}: ${JSON.stringify(m)}`)];
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** Does this toolset file start from `follows` — is it an override that keeps following that one? */
export function toolsetTextFollows(text: string, follows: string): boolean {
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true });
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>)[TOOLSET_REF_KEY] === follows;
}

/**
 * `text` with the entries set, everything else as it was written.
 *
 * Throws when the file is not a toolset MAP — unparsable, a list (the legacy form has no place for
 * a command subject), or a bare reference. `other` and `$ref` are never written: a remembered answer
 * is about a subject.
 */
export function addToToolsetText(text: string, entries: ToolsetAddition): string {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error("the toolset file does not parse as JSON, so nothing was written to it");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the toolset file is not a map from a subject to a mode, so there is no place in it for a line");
  }
  let out = text;
  for (const [rawSubject, mode] of Object.entries(entries)) {
    const subject = normalize(rawSubject);
    if (subject.length === 0 || subject.startsWith("$") || subject === OTHER_SUBJECT) {
      throw new Error(`'${rawSubject}' is not a subject an answer can be remembered at`);
    }
    const current = parseJsonc(out, [], { allowTrailingComma: true }) as Record<string, unknown>;
    // The key as its author spelled it (`"git  commit"`), so the edit lands on their line.
    const key = Object.keys(current).find((k) => normalize(k) === subject) ?? subject;
    const held = current[key];
    const isEntryObject = held !== null && typeof held === "object" && !Array.isArray(held);
    const tree = parseTree(out, [], { allowTrailingComma: true })!;
    // A value already there is replaced where it stands — the `mode` alone of an entry written as an
    // object, so its implementation stays — and a new subject goes on a line of its own.
    const node = (isEntryObject ? findNodeAtLocation(tree, [key, "mode"]) : undefined) ?? findNodeAtLocation(tree, [key]);
    out = node !== undefined ? out.slice(0, node.offset) + JSON.stringify(mode) + out.slice(node.offset + node.length) : appendProperty(out, tree, key, mode);
  }
  return out;
}
