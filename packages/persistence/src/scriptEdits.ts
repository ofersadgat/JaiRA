/**
 * Writing a state's CONFIGURATION back into the workflow script it compiles from (the person, 2026-11-24:
 * a script's configuration "should be in copy on change mode").
 *
 * A script's configuration is the document it compiles to (`scriptStateText`), and a form edits that
 * document. Only some of it is spelled in the code as a value a form can change in place, and only those
 * are written back:
 *
 *   the label            `meta.name`
 *   the description      `meta.description`
 *   an input's default   the default of the parameter it compiles from: `approval: … = "propose"`
 *
 * Everything else — what the code DOES: its calls, its children, its outputs, an input's type — is its
 * code's to change, and an edit to it is refused with a reason rather than dropped, so a form never
 * claims a change it did not make.
 */
import type * as TS from "typescript";

import { scriptCompiler } from "./userModules";

/** The keys of a compiled state document a form edit may change in a script. */
const WRITABLE_KEYS = new Set(["label", "description", "inputs"]);

/**
 * The script's text with `after`'s changes from `before` written into it — or why they cannot be.
 * `before` is what the script compiles to now; `after` the same document as the form left it.
 */
export function scriptWithEdits(file: string, text: string, before: unknown, after: unknown): { text: string; error?: undefined } | { text?: undefined; error: string } {
  const was = record(before);
  const now = record(after);
  if (was === undefined || now === undefined) return { error: "the configuration is not a state document" };
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (!WRITABLE_KEYS.has(key) && !same(was[key], now[key])) return { error: `'${key}' comes from what the script's code does — change it in the script` };
  }
  const ts = scriptCompiler().ts;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.js$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; text: string }> = [];

  // The label and the description: `meta`'s `name` and `description`.
  for (const [key, property] of [["label", "name"], ["description", "description"]] as const) {
    if (same(was[key], now[key])) continue;
    if (typeof now[key] !== "string") return { error: `a script's ${key} is a string in its meta — clear it in the script` };
    const meta = metaObject(ts, sf);
    if (meta === undefined) return { error: "the script declares no `meta` object to write it into" };
    const literal = JSON.stringify(now[key]);
    const found = meta.properties.find((p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && nameOf(ts, p.name) === property);
    if (found !== undefined) edits.push({ start: found.initializer.getStart(sf), end: found.initializer.end, text: literal });
    else edits.push({ start: meta.getStart(sf) + 1, end: meta.getStart(sf) + 1, text: ` ${property}: ${literal},` });
  }

  // An input's default: its parameter's.
  const wasInputs = record(was["inputs"]) ?? {};
  const nowInputs = record(now["inputs"]) ?? {};
  const names = new Set([...Object.keys(wasInputs), ...Object.keys(nowInputs)]);
  let entry: TS.FunctionLikeDeclaration | undefined;
  for (const name of names) {
    const a = record(wasInputs[name]);
    const b = record(nowInputs[name]);
    if (a === undefined || b === undefined) return { error: `the input '${name}' is a parameter of the script — ${a === undefined ? "add" : "remove"} it there` };
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "default" || key === "optional") continue;
      if (!same(a[key], b[key])) return { error: `the input '${name}''s ${key} comes from the script's code — change it there` };
    }
    if (same(a["default"], b["default"])) continue;
    if (b["default"] === undefined) return { error: `the input '${name}''s default is its parameter's — remove it in the script` };
    entry ??= entryFunction(ts, sf);
    if (entry === undefined) return { error: "the script has no default-exported function whose parameters are its inputs" };
    const parameter = entry.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (parameter === undefined) return { error: `the input '${name}' is not one of the script's parameters` };
    const literal = JSON.stringify(b["default"]);
    if (parameter.initializer !== undefined) edits.push({ start: parameter.initializer.getStart(sf), end: parameter.initializer.end, text: literal });
    else edits.push({ start: parameter.end, end: parameter.end, text: ` = ${literal}` });
  }

  // From the end, so each edit's offsets still hold when it is made.
  edits.sort((x, y) => y.start - x.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { text: out };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nameOf(ts: typeof TS, name: TS.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** `export const meta = { … }`'s object. */
function metaObject(ts: typeof TS, sf: TS.SourceFile): TS.ObjectLiteralExpression | undefined {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "meta" || declaration.initializer === undefined) continue;
      let init: TS.Expression = declaration.initializer;
      // `{ … } as const`, `{ … } satisfies Meta`
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) return init;
    }
  }
  return undefined;
}

/** The default-exported function — the state the script IS, whose parameters are its inputs. */
function entryFunction(ts: typeof TS, sf: TS.SourceFile): TS.FunctionLikeDeclaration | undefined {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const flags = ts.getCombinedModifierFlags(statement);
      if ((flags & ts.ModifierFlags.Export) !== 0 && (flags & ts.ModifierFlags.Default) !== 0) return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const e = statement.expression;
      if (ts.isFunctionExpression(e) || ts.isArrowFunction(e)) return e;
    }
  }
  return undefined;
}
