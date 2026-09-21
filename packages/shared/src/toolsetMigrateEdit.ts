/**
 * Rewriting a state file's `tools` LIST and `permissions` block as a TOOLSET — text in, text out
 * (decision 0007 step 7).
 *
 * Pure, like `toolsetEdit.ts`, and for the same reason: the caller reads and writes the file, and
 * decides WHAT the toolset is (that takes a measurement — `@jaira/persistence` `toolsetMigration.ts`).
 * This module only knows where the words go:
 *
 *  - the block's `tools` becomes the toolset node — a reference, a `$ref` with overrides, or a map —
 *    replaced where it stands, or added ahead of `permissions` when the block had modes and no list;
 *  - `permissions.tools`, `default`, `other` and `profile` are removed, since a map says all four;
 *  - a `permissions` block left empty goes with them, and one that still holds `scopes` stays.
 *
 * JSON is edited the way `toolsetEdit.ts` edits it — located with `jsonc-parser`'s tree, spliced by
 * hand — so key order, indentation, line endings, comments and every byte of every other line
 * survive. YAML goes through the `yaml` Document, which keeps comments, key order and scalar styles;
 * its serializer owns the whitespace, so a YAML file may come back re-indented where a JSON file
 * never does.
 */
import { findNodeAtLocation, parse as parseJsonc, parseTree, type Node, type ParseError } from "jsonc-parser";
import { isMap, parseDocument, type Document } from "yaml";

/** The byte-order mark, spelled by its code so no editor can drop or double it. */
const BOM = String.fromCharCode(0xfeff);

/** The keys of an old `permissions` block a toolset map says instead. `scopes` is not one. */
export const LEGACY_PERMISSION_KEYS: readonly string[] = ["tools", "default", "other", "profile"];

/** One block to rewrite: where it is, and the toolset node its `tools` becomes. */
export interface ToolsBlockRewrite {
  /** The block's path in the document: `["operation"]`, `["children", "draft", "environment"]`. */
  at: readonly string[];
  /** A reference (`$/toolsets/chat/read-only`), or a map — with `$ref` first when it starts from one. */
  tools: string | Readonly<Record<string, unknown>>;
}

export type StateFileFormat = "json" | "yaml";

/** The format a state file is read as, by its name. */
export function stateFileFormatOf(file: string): StateFileFormat {
  return /\.ya?ml$/i.test(file) ? "yaml" : "json";
}

/** JSON read the way the editors below locate it: comments and a trailing comma are not errors. */
export function parseJsoncText(text: string): { ok: true; value: unknown } | { ok: false } {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0 ? { ok: false } : { ok: true, value };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The same rewrite, applied to the PARSED document — what the text must parse to afterwards.
 *
 * The text editors below are checked against this by their caller, so a splice that lands in the
 * wrong place is a refusal and never a written file.
 */
export function rewriteToolsBlocksValue(doc: unknown, rewrites: readonly ToolsBlockRewrite[]): unknown {
  const out = structuredClone(doc);
  for (const rewrite of rewrites) {
    let block: unknown = out;
    for (const key of rewrite.at) block = isPlainObject(block) ? block[key] : undefined;
    if (!isPlainObject(block)) throw new Error(`there is no block at ${rewrite.at.join(".")}`);
    const rebuilt: Record<string, unknown> = {};
    const tools = typeof rewrite.tools === "string" ? rewrite.tools : { ...rewrite.tools };
    let placed = false;
    for (const [key, value] of Object.entries(block)) {
      if (key === "tools") {
        rebuilt[key] = tools;
        placed = true;
      } else if (key === "permissions" && isPlainObject(value)) {
        if (!placed && !Object.hasOwn(block, "tools")) {
          rebuilt["tools"] = tools;
          placed = true;
        }
        const kept = Object.fromEntries(Object.entries(value).filter(([k]) => !LEGACY_PERMISSION_KEYS.includes(k)));
        if (Object.keys(kept).length > 0) rebuilt[key] = kept;
      } else {
        rebuilt[key] = value;
      }
    }
    if (!placed) rebuilt["tools"] = tools;
    for (const key of Object.keys(block)) delete block[key];
    Object.assign(block, rebuilt);
  }
  return out;
}

/** `text` with every block in `rewrites` rewritten. Throws, naming the block, when one is not there. */
export function rewriteToolsBlocksText(text: string, format: StateFileFormat, rewrites: readonly ToolsBlockRewrite[]): string {
  if (rewrites.length === 0) return text;
  // A byte-order mark is not part of the document either parser reads, and it stays where it was.
  const bom = text.startsWith(BOM) ? BOM : "";
  const body = text.slice(bom.length);
  return bom + (format === "yaml" ? rewriteYaml(body, rewrites) : rewriteJson(body, rewrites));
}

// --- JSON ----------------------------------------------------------------------

const PARSE = { allowTrailingComma: true } as const;

function treeOf(text: string): Node {
  const tree = parseTree(text, [], PARSE);
  if (tree === undefined) throw new Error("the file does not parse as JSON, so nothing in it was rewritten");
  return tree;
}

/** The `property` node for `key` directly under the object at `at`. */
function propertyAt(tree: Node, at: readonly string[], key: string): Node | undefined {
  const parent = at.length === 0 ? tree : findNodeAtLocation(tree, [...at]);
  if (parent === undefined || parent.type !== "object") return undefined;
  return parent.children?.find((child) => child.type === "property" && child.children?.[0]?.value === key);
}

/** The whitespace a line starts with, when `offset` is the first thing on its line; else `undefined`. */
function leadAt(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

/** One level of indentation, as this file writes it: the shortest lead any line has. */
function indentUnitOf(text: string): string {
  let unit: string | undefined;
  for (const match of text.matchAll(/^([ \t]+)\S/gm)) {
    const lead = match[1]!;
    if (unit === undefined || lead.length < unit.length) unit = lead;
  }
  return unit ?? "  ";
}

/** A toolset node as JSON text, laid out under a property whose own line starts with `lead`. */
function renderJsonNode(node: string | Readonly<Record<string, unknown>>, lead: string | undefined, unit: string, eol: string): string {
  if (typeof node === "string") return JSON.stringify(node);
  const entry = (value: unknown): string =>
    isPlainObject(value) ? `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }` : JSON.stringify(value);
  const lines = Object.entries(node).map(([key, value]) => `${JSON.stringify(key)}: ${entry(value)}`);
  if (lines.length === 0) return "{}";
  // A file written on one line stays on one line.
  if (lead === undefined) return `{ ${lines.join(", ")} }`;
  return `{${eol}${lines.map((line) => `${lead}${unit}${line}`).join(`,${eol}`)}${eol}${lead}}`;
}

/** `text` without one property of an object — the comma it owed or was owed goes with it. */
function removeProperty(text: string, parent: Node, property: Node): string {
  const siblings = parent.children ?? [];
  const index = siblings.indexOf(property);
  const next = siblings[index + 1];
  const prior = siblings[index - 1];
  if (next !== undefined) return text.slice(0, property.offset) + text.slice(next.offset);
  if (prior !== undefined) return text.slice(0, prior.offset + prior.length) + text.slice(property.offset + property.length);
  return `${text.slice(0, parent.offset)}{}${text.slice(parent.offset + parent.length)}`;
}

function rewriteJson(text: string, rewrites: readonly ToolsBlockRewrite[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = indentUnitOf(text);
  let out = text;
  for (const rewrite of rewrites) {
    const where = rewrite.at.join(".");
    const blockOf = (tree: Node): Node => {
      const block = findNodeAtLocation(tree, [...rewrite.at]);
      if (block === undefined || block.type !== "object") throw new Error(`there is no block at ${where}`);
      return block;
    };

    // 1. `tools`: replaced where it stands, or added ahead of `permissions` (else at the end).
    let tree = treeOf(out);
    let block = blockOf(tree);
    const tools = propertyAt(tree, rewrite.at, "tools");
    if (tools !== undefined) {
      const value = tools.children![1]!;
      out = out.slice(0, value.offset) + renderJsonNode(rewrite.tools, leadAt(out, tools.offset), unit, eol) + out.slice(value.offset + value.length);
    } else {
      const permissions = propertyAt(tree, rewrite.at, "permissions");
      const last = block.children?.at(-1);
      if (permissions !== undefined) {
        const lead = leadAt(out, permissions.offset);
        const rendered = `"tools": ${renderJsonNode(rewrite.tools, lead, unit, eol)}`;
        out = out.slice(0, permissions.offset) + rendered + (lead !== undefined ? `,${eol}${lead}` : ", ") + out.slice(permissions.offset);
      } else if (last !== undefined) {
        const lead = leadAt(out, last.offset);
        const rendered = `"tools": ${renderJsonNode(rewrite.tools, lead, unit, eol)}`;
        const end = last.offset + last.length;
        out = out.slice(0, end) + (lead !== undefined ? `,${eol}${lead}` : ", ") + rendered + out.slice(end);
      } else {
        out = `${out.slice(0, block.offset)}{ "tools": ${renderJsonNode(rewrite.tools, undefined, unit, eol)} }${out.slice(block.offset + block.length)}`;
      }
    }

    // 2. The keys of `permissions` a map says instead, one at a time so every offset is fresh.
    for (const key of LEGACY_PERMISSION_KEYS) {
      tree = treeOf(out);
      const permissions = propertyAt(tree, rewrite.at, "permissions")?.children?.[1];
      if (permissions === undefined || permissions.type !== "object") break;
      const property = permissions.children?.find((child) => child.children?.[0]?.value === key);
      if (property !== undefined) out = removeProperty(out, permissions, property);
    }

    // 3. …and the block itself, when nothing is left in it.
    tree = treeOf(out);
    block = blockOf(tree);
    const permissions = propertyAt(tree, rewrite.at, "permissions");
    const held = permissions?.children?.[1];
    if (permissions !== undefined && held?.type === "object" && (held.children?.length ?? 0) === 0) out = removeProperty(out, block, permissions);
  }
  return out;
}

// --- YAML ----------------------------------------------------------------------

/** How this YAML file indents, so the serializer writes it back the way it found it. */
function yamlLayoutOf(text: string): { indent: number; indentSeq: boolean } {
  let indent: number | undefined;
  for (const match of text.matchAll(/^( +)[^\s#-]/gm)) {
    const width = match[1]!.length;
    if (indent === undefined || width < indent) indent = width;
  }
  // `key:` followed by a `- item` at the SAME column is the un-indented sequence style.
  const flush = /^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1- /m.test(text);
  return { indent: indent ?? 2, indentSeq: !flush };
}

function rewriteYaml(text: string, rewrites: readonly ToolsBlockRewrite[]): string {
  const doc: Document = parseDocument(text, { uniqueKeys: true, keepSourceTokens: true });
  if (doc.errors.length > 0) throw new Error(`the file does not parse as YAML, so nothing in it was rewritten: ${doc.errors[0]!.message}`);
  for (const rewrite of rewrites) {
    const where = rewrite.at.join(".");
    const block = rewrite.at.length === 0 ? doc.contents : doc.getIn([...rewrite.at], true);
    if (!isMap(block)) throw new Error(`there is no block at ${where}`);
    const node = doc.createNode(typeof rewrite.tools === "string" ? rewrite.tools : { ...rewrite.tools });
    if (block.has("tools")) {
      block.set("tools", node);
    } else {
      // Ahead of `permissions`, where a reader looks for it; else last.
      const pair = doc.createPair("tools", node);
      const at = block.items.findIndex((item) => (item.key as { value?: unknown } | null)?.value === "permissions");
      if (at >= 0) block.items.splice(at, 0, pair as (typeof block.items)[number]);
      else block.items.push(pair as (typeof block.items)[number]);
    }
    const permissions = block.get("permissions", true);
    if (isMap(permissions)) {
      for (const key of LEGACY_PERMISSION_KEYS) permissions.delete(key);
      if (permissions.items.length === 0) block.delete("permissions");
    }
  }
  const layout = yamlLayoutOf(text);
  const out = doc.toString({ lineWidth: 0, indent: layout.indent, indentSeq: layout.indentSeq });
  // The serializer ends a document with `\n`; a file that used CRLF keeps using it.
  return text.includes("\r\n") ? out.replace(/\r?\n/g, "\r\n") : out;
}

// --- the diff a dry run prints ----------------------------------------------------

/**
 * A small unified diff of two texts, by line — what a dry run shows for one file.
 *
 * The common head and tail are cut away first, so the table below is over the changed middle only;
 * a migration touches a few lines of a file, and this is never asked about anything else.
 */
export function unifiedDiff(before: string, after: string, context = 2): string[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  // Longest common subsequence over the middle.
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  // Every line of `before` and `after` as one edit script, each op knowing its line in `before`.
  const ops: Array<{ kind: " " | "-" | "+"; line: string; at: number }> = [];
  let at = Math.max(0, head - context);
  for (const line of a.slice(at, head)) ops.push({ kind: " ", line, at: (at += 1) });
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push({ kind: " ", line: midA[i]!, at: (at += 1) });
      i += 1;
      j += 1;
    } else if (i < midA.length && (j >= midB.length || table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)) {
      ops.push({ kind: "-", line: midA[i]!, at: (at += 1) });
      i += 1;
    } else {
      ops.push({ kind: "+", line: midB[j]!, at });
      j += 1;
    }
  }
  for (const line of a.slice(a.length - tail, a.length - tail + context)) ops.push({ kind: " ", line, at: (at += 1) });

  // Only what is within `context` lines of a change is shown; a gap starts a new hunk.
  const near = ops.map((_, index) => ops.slice(Math.max(0, index - context), index + context + 1).some((op) => op.kind !== " "));
  const out: string[] = [];
  ops.forEach((op, index) => {
    if (!near[index]) return;
    if (index === 0 || !near[index - 1]) out.push(`@@ line ${Math.max(1, op.at)} @@`);
    out.push(`${op.kind}${op.line}`);
  });
  return out;
}
