/**
 * Splitting Monaco's `keyword` into the classes a theme is actually written against.
 *
 * A theme colours what a tokenizer says, and Monaco's bundled tokenizers say very little. Measured,
 * for `function f(x: boolean): string { const y = true; if (y) return x; }`:
 *
 * ```
 * function=keyword  f=identifier  x=identifier  boolean=keyword  string=keyword
 * const=keyword     true=keyword  if=keyword    return=keyword
 * ```
 *
 * Seven words, one class. The same line under VSCode's TextMate grammar is six: `storage.type` for
 * `function` and `const`, `support.type.primitive` for `boolean` and `string`, `constant.language`
 * for `true`, `keyword.control` for `if` and `return`, `variable.parameter` for `x`. That is why an
 * editor painted in a theme's exact colours still does not look like the same theme in VSCode — the
 * palette is right and the classification is coarse, so every one of those words gets the one colour
 * the theme names for "keyword".
 *
 * ## What this does about it, and what it cannot
 *
 * Monaco's Monarch definitions are plain data and it exports them, so the fix is to take theirs and
 * add cases to the one rule that classifies words: three named sets on the way in, three token
 * classes on the way out. Nothing is forked — the definition is spread and one rule is replaced, so
 * a Monaco upgrade brings its own keyword list, its own regexes and its own everything else.
 *
 * What it CANNOT do is `variable.parameter` or `entity.name.function`. Both are `identifier` to a
 * Monarch tokenizer and telling them apart means parsing the signature they are in — which is what
 * a real TextMate grammar does, and the reason the honest route to full parity is `vscode-textmate`
 * with Oniguruma rather than a longer list of words here.
 *
 * ## The registration is deliberately late
 *
 * Monaco loads a language's definition lazily: `onLanguage` fires, a dynamic import resolves, and
 * `setMonarchTokensProvider` is called from inside it. Registering ours at import time therefore
 * loses — theirs lands a microtask later and replaces it. So this runs when an editor is created,
 * after the language it needs is already loaded, and re-registering is cheap and idempotent: Monaco
 * re-tokenizes the open models and nothing else happens.
 */
import * as monaco from "monaco-editor";

/**
 * Declaring words: `storage.type` in every TextMate grammar, and the reason `function` is a
 * different colour from `if` in every theme anybody recognises.
 */
const STORAGE = [
  "function",
  "const",
  "let",
  "var",
  "class",
  "interface",
  "enum",
  "type",
  "namespace",
  "module",
  "declare",
  "abstract",
  "static",
  "readonly",
  "public",
  "private",
  "protected",
  "async",
  "get",
  "set",
];

/** The primitives a type annotation is made of — `support.type.primitive`, which themes italicise. */
const PRIMITIVES = [
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
];

/** `constant.language`: the three words a theme colours as values rather than as instructions. */
const CONSTANTS = ["true", "false", "null"];

/**
 * One rule replaced, per language.
 *
 * The rule is found by the token it produces rather than by its position, because a position is a
 * fact about the file we are patching and the token is a fact about what we are patching it FOR: if
 * Monaco reorders its tokenizer this finds the rule anyway, and if it ever stops classifying words
 * this way the patch quietly does nothing rather than corrupting a definition it no longer
 * understands.
 */
function split(language: Record<string, unknown>): Record<string, unknown> {
  const tokenizer = language["tokenizer"] as Record<string, unknown[]> | undefined;
  if (tokenizer === undefined) return language;
  const rules: Record<string, unknown[]> = {};
  let found = false;
  for (const [state, list] of Object.entries(tokenizer)) {
    rules[state] = list.map((rule) => {
      const pair = rule as [unknown, { cases?: Record<string, string> }];
      const cases = Array.isArray(pair) ? pair[1]?.cases : undefined;
      // The word rule, identified by what it does: map `@keywords` to `keyword` and everything else
      // to `identifier`. Nothing else in these definitions does that.
      if (cases?.["@keywords"] !== "keyword" || cases["@default"] !== "identifier") return rule;
      found = true;
      return [
        pair[0],
        {
          ...pair[1],
          // ORDER MATTERS: Monarch takes the first case that matches, so the three narrow sets have
          // to precede the keyword list they are drawn from.
          cases: {
            "@storage": "keyword.storage",
            "@primitives": "type.primitive",
            "@constants": "constant.language",
            ...cases,
          },
        },
      ];
    });
  }
  if (!found) return language;
  return { ...language, tokenizer: rules, storage: STORAGE, primitives: PRIMITIVES, constants: CONSTANTS };
}

/** Languages whose definitions classify words this way, and which anybody actually reads here. */
const LANGUAGES: ReadonlyArray<{ id: string; load: () => Promise<{ language: unknown }> }> = [
  { id: "typescript", load: () => import("monaco-editor/languages/definitions/typescript/typescript.js") },
  { id: "javascript", load: () => import("monaco-editor/languages/definitions/typescript/typescript.js") },
];

const patched = new Set<string>();

/**
 * Re-register the split definitions, once each.
 *
 * Called on editor creation rather than at import: see the note above on why late is the only time
 * that sticks. Failures are swallowed on purpose — an import path Monaco has moved, or a definition
 * shaped differently than this expects, costs the finer colouring and nothing else, and an editor
 * that refused to open because a keyword list could not be widened would be a far worse trade.
 */
export function splitMonacoKeywords(): void {
  for (const { id, load } of LANGUAGES) {
    if (patched.has(id)) continue;
    patched.add(id);
    void load()
      .then((module) => {
        const language = module.language as Record<string, unknown>;
        const next = split(language);
        if (next === language) return;
        // A MACROTASK, and that is the whole of why this works. Monaco registers its own definition
        // from inside a dynamic import, which resolves on the microtask queue; registering in the
        // same turn loses to it. A timeout runs after every microtask the load queued, so ours is
        // the registration that stands.
        setTimeout(() => monaco.languages.setMonarchTokensProvider(id, next as monaco.languages.IMonarchLanguage), 0);
      })
      .catch(() => undefined);
  }
}
