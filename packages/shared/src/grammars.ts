/**
 * What each type is called by the engines that colour it — the far end of the ONE route.
 *
 * The route is `name-or-path → mime → everything`: `mimeOfFenceLang` and `mimeOfPath` answer what a
 * thing IS, this answers which grammar can colour it, and `viewsFor` answers how it can be read.
 * Nothing here is an entry point. A caller holding a language name asks `mimeOfFenceLang` first and
 * arrives with a MIME type, exactly as a caller holding a path does — so a fence, a file and a tool
 * result cannot reach different conclusions about the same format.
 *
 * ## Why this is in `shared` rather than beside the editors
 *
 * Because `viewsFor` has to read it. Whether to offer a `code` view is the question "can this be
 * coloured?", and that was being answered TWICE: here, by whether a grammar exists, and in
 * `isCodeMime`, by a heuristic (is it text, is it not plain, is it not markdown). The two disagreed
 * about four types — TOML, CSV, TSV and diff — each of which offered a Code button that produced
 * text identical to Source, because no grammar was ever found for it. A control that can only be
 * pressed to no effect is the specific failure `valueView.tsx` opens by warning about.
 *
 * So the table is the single fact, and both the view list and the editors read it. It is the same
 * kind of thing `typeNames.ts` already keeps in this package: data ABOUT a type, no imports.
 *
 * ## One table, two columns
 *
 * A type gets a row, and a row names it in each engine that has a grammar for it. Empty in a column
 * means that engine has none — a real answer, and the reason {@link monacoGrammarOf} can promise
 * `plaintext` rather than guessing. The ids are the ENGINES' own and mostly are not the format's
 * name: Monaco calls C++ `cpp` and Protobuf `proto`; CodeMirror calls Solidity `sol`.
 *
 * The loaders are deliberately NOT here. Naming a grammar is a fact about a type; importing one
 * drags a package into whatever chunk reads this, and this is read by every surface in the app. So
 * the column holds a name, and the one surface that needs CodeMirror's parsers resolves it there —
 * see `markdownEditor.tsx`.
 */
import { mimeFallbacks } from "./mime";

/** What one type is called by each engine. An absent column means that engine has no grammar. */
interface Grammar {
  /** Monaco's language id — see `monaco.languages.getLanguages()`. */
  monaco?: string;
  /** CodeMirror's, as `markdownEditor.tsx`'s loader table keys it. */
  codemirror?: string;
}

/**
 * The table, by MIME type.
 *
 * Resolution walks `mimeFallbacks`, which is what makes the vendor types free: a
 * `application/vnd.jaira.workflow+yaml` falls back to `application/yaml` and is coloured as YAML
 * without an entry of its own, the same way `typeNames.ts` names it and `structuredFormatOf` parses
 * it. It also replaced three hand-written `endsWith("+json")`-style checks that did the same job for
 * three suffixes and nothing else.
 */
const GRAMMARS: Record<string, Grammar> = {
  "application/json": { monaco: "json", codemirror: "json" },
  // One JSON value per line: no grammar of its own anywhere, and JSON's is very nearly right,
  // because every LINE is a JSON document even though the file is not.
  "application/jsonl": { monaco: "json", codemirror: "json" },
  "application/yaml": { monaco: "yaml", codemirror: "yaml" },
  "text/markdown": { monaco: "markdown" },
  "text/javascript": { monaco: "javascript", codemirror: "javascript" },
  "text/x-typescript": { monaco: "typescript", codemirror: "typescript" },
  "text/html": { monaco: "html", codemirror: "html" },
  "text/css": { monaco: "css", codemirror: "css" },
  "text/x-python": { monaco: "python" },
  "application/x-sh": { monaco: "shell" },
  "application/xml": { monaco: "xml" },
  "image/svg+xml": { monaco: "xml" },
  "text/x-c": { monaco: "c" },
  "text/x-c++src": { monaco: "cpp" },
  "text/x-csharp": { monaco: "csharp" },
  "text/x-java": { monaco: "java" },
  "text/x-go": { monaco: "go" },
  "text/x-rust": { monaco: "rust" },
  "text/x-ruby": { monaco: "ruby" },
  "text/x-php": { monaco: "php" },
  "text/x-swift": { monaco: "swift" },
  "text/x-kotlin": { monaco: "kotlin" },
  "text/x-scala": { monaco: "scala" },
  "text/x-lua": { monaco: "lua" },
  "text/x-r": { monaco: "r" },
  "text/x-perl": { monaco: "perl" },
  "text/x-dart": { monaco: "dart" },
  "text/x-sql": { monaco: "sql" },
  "application/graphql": { monaco: "graphql" },
  "text/x-scss": { monaco: "scss" },
  "text/x-less": { monaco: "less" },
  "text/x-ini": { monaco: "ini" },
  "text/x-elixir": { monaco: "elixir" },
  "text/x-clojure": { monaco: "clojure" },
  "text/x-hcl": { monaco: "hcl" },
  "text/x-protobuf": { monaco: "proto" },
  "text/x-julia": { monaco: "julia" },
  "text/x-fsharp": { monaco: "fsharp" },
  "text/x-vb": { monaco: "vb" },
  "text/x-solidity": { monaco: "sol" },
  "text/x-tcl": { monaco: "tcl" },
  "text/x-coffeescript": { monaco: "coffeescript" },
  "text/x-pascal": { monaco: "pascal" },
  "text/x-scheme": { monaco: "scheme" },
  "text/x-objectivec": { monaco: "objective-c" },
  "text/x-systemverilog": { monaco: "systemverilog" },
  "text/x-wgsl": { monaco: "wgsl" },
  "text/x-handlebars": { monaco: "handlebars" },
  "text/x-pug": { monaco: "pug" },
  "text/x-rst": { monaco: "restructuredtext" },
  "text/x-dockerfile": { monaco: "dockerfile" },
  "application/x-powershell": { monaco: "powershell" },
  "application/x-bat": { monaco: "bat" },
};

/**
 * What the engines know about a type, walking the fallback chain. Empty for one with no row.
 *
 * `mimeFallbacks` is the mechanism the rest of the package already resolves with — `typeNames.ts`
 * for the label, `structuredFormatOf` for the parse — so a vendor type is coloured as the syntax it
 * is written in with no entry of its own. It replaced three hand-written `endsWith("+json")`-style
 * checks that did the same job for three suffixes and nothing else.
 *
 * The BARE subtypes are accepted for the reason `viewOfMime` and `structuredFormatOf` accept them: a
 * slot declares `{contentMediaType: "yaml"}` and means it, and a declaration that never reaches the
 * renderer is one nobody had a reason to write.
 */
function grammarOf(mime: string): Grammar {
  const base = mime.split(";")[0]!.trim().toLowerCase();
  for (const candidate of mimeFallbacks(BARE[base] ?? base)) {
    const found = GRAMMARS[candidate];
    if (found !== undefined) return found;
  }
  return {};
}

/** The short spellings a slot may declare, resolved before anything else — as in `typeNames.ts`. */
const BARE: Record<string, string> = {
  markdown: "text/markdown",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  yaml: "application/yaml",
  csv: "text/csv",
  diff: "text/x-diff",
};

/**
 * The Monaco language id for a MIME type — display only, so unknown safely means plain text.
 *
 * `plaintext` is the correct failure and never a wrong grammar: a format Monaco has no parser for
 * shows uncoloured rather than wearing one that is only mostly right. `languages.test.ts` holds the
 * table to that promise from the other side, listing the types this deliberately cannot colour.
 */
export function monacoGrammarOf(mime: string): string {
  return grammarOf(mime).monaco ?? "plaintext";
}

/** The CodeMirror grammar name for a MIME type, or null where there is none. */
export function codeMirrorGrammarOf(mime: string): string | null {
  return grammarOf(mime).codemirror ?? null;
}

/**
 * Whether ANY editor in this app can colour a type — what the `code` view is offered on.
 *
 * The whole reason the table lives in this package. See the header: asking a heuristic instead was
 * how four types came to offer a reading that could not be produced.
 */
export function hasGrammar(mime: string | undefined): boolean {
  return mime !== undefined && grammarOf(mime).monaco !== undefined;
}

/** Every CodeMirror grammar this app names — what the loader table must cover. Exported for its test. */
export function codeMirrorGrammars(): string[] {
  const named = Object.values(GRAMMARS).flatMap((row) => (row.codemirror === undefined ? [] : [row.codemirror]));
  return [...new Set(named)].sort();
}
