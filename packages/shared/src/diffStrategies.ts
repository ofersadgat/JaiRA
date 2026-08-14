/**
 * How a change's content is FOUND and SHOWN (CHANGESETS.md §7) — a strategy registry keyed by MIME,
 * the same shape as the file-surface registry: register the most specific type that changes
 * behaviour and let the fallback chain cover the rest.
 *
 * The §1.3 invariant is the contract every strategy meets: however a change is found — a JSON
 * pointer, a YAML node, a line hunk — what it lowers to is a replacement of a text range with a
 * string, and the authored text is the source of truth. The structural strategies are
 * format-preserving for exactly the reason §7.2 names: a diff that round-trips through
 * `JSON.parse`/`stringify` reformats the file and reports every state file in the repo as wholly
 * rewritten.
 *
 * Applying a SUBSET of structural hunks re-derives the edits sequentially through the same
 * format-preserving writer (`jsonc-parser`'s `modify`, the `yaml` Document API) rather than
 * splicing ranges computed against the original — two independent splices into one array collide on
 * index shifts and comma placement. Each sequential application is still a text-range edit, so the
 * invariant holds; only the derivation order differs.
 *
 * Text hunks use THE differ Monaco renders with — `linesDiffComputers.getDefault()`, the 'advanced'
 * algorithm the DiffEditor runs in its worker — imported from monaco's ESM tree, which is pure JS
 * and DOM-free (it normally runs in a worker), so it works headless in the CLI and in tests. That
 * is §7.3's alignment position taken literally: the stored hunks and the full-pane view are
 * computed by the same function. The path is an unversioned internal surface; the "exact differ"
 * test in `test/diffStrategies.test.ts` is the tripwire an upgrade trips instead of a version pin.
 */
/// <reference path="./monacoDiff.d.ts" />
// A NAMESPACE import, unwrapped below, not a named one: monaco ships its ESM tree with no
// `"type": "module"` marker, so plain Node loads it by syntax detection (ESM) while tsx transforms
// it to CJS — under which a NAMED import fails at link time ("does not provide an export named…").
// `import *` never link-fails; the export is found wherever the loader put it.
import * as monacoDiffModule from "monaco-editor/editor/common/diff/linesDiffComputers.js";
import { applyEdits, modify, type JSONPath } from "jsonc-parser";
import { Document, parseDocument } from "yaml";

/**
 * The CJS-interop unwrap, behind a CALL on purpose: under a real ESM loader (Node, Vite, esbuild)
 * the namespace carries the named export and the `default` arm is dead — dead enough that esbuild
 * warned "import 'default' will always be undefined" when the access was written directly on the
 * import binding. Under tsx the module is transformed to CJS and the exports live on `default`.
 * Passing the namespace through a function severs the static import identity, so both loaders
 * resolve at runtime and neither bundler has anything to prove about the other's world.
 */
function interopNamespace<T>(ns: T): T {
  const record = ns as { default?: T };
  return (record.default ?? ns) as T;
}

const linesDiffComputers =
  interopNamespace(monacoDiffModule).linesDiffComputers ??
  ((): never => {
    throw new Error(
      "monaco-editor's linesDiffComputers module no longer exports what it did — the 'exact differ' test in diffStrategies.test.ts documents the fix",
    );
  })();
import type { JsonValue } from "@declarative-ai/json";
import { applyHunks, type ChangeHunk } from "./changeset";
import { mimeFallbacks } from "./mime";

export interface DiffStrategy {
  /** Names the strategy in labels and tests. */
  id: string;
  /** The reviewable regions between two texts, each a text-range replacement into `before` (§1.3). */
  hunks(before: string, after: string): ChangeHunk[];
  /** Apply an accepted subset. MUST equal `applyHunks` in effect when every hunk is accepted. */
  apply(before: string, accepted: readonly ChangeHunk[]): string;
}

// --- the structural value diff (§7.2) ----------------------------------------

interface StructuralOp {
  kind: "add" | "remove" | "replace";
  pointer: Array<string | number>;
  value?: JsonValue;
}

const isPlainObject = (v: unknown): v is Record<string, JsonValue> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Enumerate pointer-level operations, recursing through OBJECTS only. An array that differs is one
 * operation, whole: array element churn re-indexes every later element, which turns "a subset of
 * these rows" into edits that mean different things depending on which others were taken — and a
 * `sequence` or `transitions` block is reviewed as a unit anyway.
 */
function structuralOps(pointer: Array<string | number>, a: JsonValue | undefined, b: JsonValue | undefined, out: StructuralOp[]): void {
  if (deepEqual(a, b)) return;
  if (a === undefined) {
    out.push({ kind: "add", pointer, value: b });
    return;
  }
  if (b === undefined) {
    out.push({ kind: "remove", pointer });
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      structuralOps([...pointer, key], a[key], b[key], out);
    }
    return;
  }
  out.push({ kind: "replace", pointer, value: b });
}

const JSON_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

/** One op's minimal, format-preserving edit against a given text, as a single hunk range. */
function jsonEditFor(text: string, op: StructuralOp): { start: number; end: number; text: string } | undefined {
  const edits = modify(text, op.pointer as JSONPath, op.kind === "remove" ? undefined : (op.value as never), {
    formattingOptions: JSON_FORMAT,
  });
  if (edits.length === 0) return undefined;
  // `modify` may return several edits (a removal takes its comma). Fold them into one range so the
  // hunk is a single replacement — the invariant's shape.
  const start = Math.min(...edits.map((e) => e.offset));
  const end = Math.max(...edits.map((e) => e.offset + e.length));
  const applied = applyEdits(text, edits);
  // The replacement is whatever the applied text holds where the range was.
  const tailLength = text.length - end;
  return { start, end, text: applied.slice(start, applied.length - tailLength) };
}

const jsonStrategy: DiffStrategy = {
  id: "structural-json",
  hunks(before, after): ChangeHunk[] {
    let a: JsonValue, b: JsonValue;
    try {
      a = JSON.parse(before) as JsonValue;
      b = JSON.parse(after) as JsonValue;
    } catch {
      // Not both valid JSON — a half-written file diffs as text rather than not at all.
      return textStrategy.hunks(before, after);
    }
    const ops: StructuralOp[] = [];
    structuralOps([], a, b, ops);
    const hunks: ChangeHunk[] = [];
    for (const op of ops) {
      const edit = jsonEditFor(before, op);
      if (edit === undefined) continue;
      hunks.push({
        id: `h${hunks.length + 1}`,
        ...edit,
        label: `/${op.pointer.join("/")}`,
        op: { kind: op.kind, pointer: op.pointer, ...(op.value !== undefined ? { value: op.value } : {}) },
      });
    }
    return hunks;
  },
  apply(before, accepted): string {
    // Sequentially, through the same writer that found them: each step recomputes offsets against
    // the text as it now stands, so accepted subsets compose. Structure-less hunks (the text
    // fallback above) splice.
    let out = before;
    const plain = accepted.filter((h) => h.op === undefined);
    if (plain.length > 0) out = applyHunks(out, plain);
    for (const hunk of accepted) {
      if (hunk.op === undefined) continue;
      out = applyEdits(
        out,
        modify(out, hunk.op.pointer as JSONPath, hunk.op.kind === "remove" ? undefined : (hunk.op.value as never), {
          formattingOptions: JSON_FORMAT,
        }),
      );
    }
    return out;
  },
};

// --- YAML, via the Document API (§7.1) ----------------------------------------

/** A YAML node's text range for display, when the parser kept one. */
function yamlRangeAt(doc: Document, pointer: Array<string | number>): { start: number; end: number } | undefined {
  if (pointer.length === 0) return undefined;
  const node: unknown = doc.getIn(pointer.map(String), true);
  const range = (node as { range?: [number, number, number] } | undefined)?.range;
  return range === undefined ? undefined : { start: range[0], end: range[2] };
}

const yamlStrategy: DiffStrategy = {
  id: "structural-yaml",
  hunks(before, after): ChangeHunk[] {
    const docA = parseDocument(before);
    const docB = parseDocument(after);
    if (docA.errors.length > 0 || docB.errors.length > 0) return textStrategy.hunks(before, after);
    const ops: StructuralOp[] = [];
    structuralOps([], docA.toJS() as JsonValue, docB.toJS() as JsonValue, ops);
    const hunks: ChangeHunk[] = [];
    for (const op of ops) {
      // The DISPLAY range is the node in the authored text; the applied edit is re-derived through
      // the Document API in `apply`, so an approximate range here costs nothing in correctness.
      const range = yamlRangeAt(docA, op.pointer) ?? { start: before.length, end: before.length };
      const replacement =
        op.kind === "remove" ? "" : new Document(op.value as never).toString({ indent: 2 }).replace(/\n$/, "");
      hunks.push({
        id: `h${hunks.length + 1}`,
        start: range.start,
        end: range.end,
        text: replacement,
        label: `/${op.pointer.join("/")}`,
        op: { kind: op.kind, pointer: op.pointer, ...(op.value !== undefined ? { value: op.value } : {}) },
      });
    }
    return hunks;
  },
  apply(before, accepted): string {
    const doc = parseDocument(before);
    if (doc.errors.length > 0) return applyHunks(before, accepted);
    let structural = false;
    for (const hunk of accepted) {
      if (hunk.op === undefined) continue;
      structural = true;
      const path = hunk.op.pointer;
      if (hunk.op.kind === "remove") {
        if (path.length === 0) return "";
        doc.deleteIn(path);
      } else if (path.length === 0) {
        doc.contents = new Document(hunk.op.value as never).contents as never;
      } else {
        doc.setIn(path, hunk.op.value);
      }
    }
    if (!structural) return applyHunks(before, accepted);
    return doc.toString({ indent: 2 });
  },
};

// --- text (§7.3) --------------------------------------------------------------

/**
 * Character offsets of each 1-based line start, plus one PAST-THE-END entry clamped to the text
 * length — so a line-range `[s, e)` maps to `[starts[s-1], starts[e-1])` even when `e` runs past
 * the last line (a file with no trailing newline).
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  // `"a\n".split` yields a phantom empty last line; the clamp entry makes ranges into it resolve
  // to the text's end rather than past it.
  starts.push(text.length);
  return starts;
}

const at = (starts: number[], line: number): number => starts[Math.min(line - 1, starts.length - 1)]!;

const textStrategy: DiffStrategy = {
  id: "text-lines",
  hunks(before, after): ChangeHunk[] {
    // The exact function the DiffEditor runs (see the module note). `ignoreTrimWhitespace: false`
    // is not negotiable here: a hunk is APPLIED, and applying a diff that ignored whitespace would
    // rewrite whitespace nobody touched.
    const diff = linesDiffComputers.getDefault().computeDiff(before.split("\n"), after.split("\n"), {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 5000,
    });
    const beforeStarts = lineStarts(before);
    const afterStarts = lineStarts(after);
    return diff.changes.map((change, i) => {
      const start = at(beforeStarts, change.original.startLineNumber);
      const end = at(beforeStarts, change.original.endLineNumberExclusive);
      // The replacement is the corresponding region of `after`, taken by the SAME line-offset rule
      // — which is what makes applying every hunk reproduce `after` byte for byte.
      const text = after.slice(at(afterStarts, change.modified.startLineNumber), at(afterStarts, change.modified.endLineNumberExclusive));
      const removed = change.original.endLineNumberExclusive - change.original.startLineNumber;
      const added = change.modified.endLineNumberExclusive - change.modified.startLineNumber;
      return {
        id: `h${i + 1}`,
        start,
        end,
        text,
        label: `@@ -${change.original.startLineNumber},${removed} +${added} @@`,
      };
    });
  },
  apply: applyHunks,
};

// --- the registry (§7.1) -------------------------------------------------------

const REGISTRY = new Map<string, DiffStrategy>([
  ["application/json", jsonStrategy],
  ["application/yaml", yamlStrategy],
]);

/**
 * The strategy for a MIME type, resolved along the same fallback chain the file surfaces use — a
 * `+json` vendor type gets the structural JSON strategy without registering itself, and everything
 * ends at text, which is the entry that guarantees no file is dead.
 */
export function diffStrategyFor(mime: string): DiffStrategy {
  for (const candidate of mimeFallbacks(mime)) {
    const strategy = REGISTRY.get(candidate);
    if (strategy !== undefined) return strategy;
  }
  return textStrategy;
}

/** Registered so tests and future per-language strategies (§7.4) can name them directly. */
export const DIFF_STRATEGIES = { json: jsonStrategy, yaml: yamlStrategy, text: textStrategy } as const;
