/**
 * A structured document, read as the VALUE it denotes — the second half of every data format.
 *
 * `valueViews.ts` splits the world at `typeof value === "string"`, and that split had a hole in it.
 * A value that arrives already parsed gets the structured readings (`json`, `form`); a value that
 * arrives as TEXT gets the source, highlighted, and nothing else. But a `.yaml` file and the object
 * it parses to are the same information twice, and only one of them was ever readable as data — so
 * a workflow file could not be read against its schema, a ```yaml fence could not be read at all
 * beyond its colours, and a set of anchors and merge keys was a puzzle the reader had to resolve in
 * their own head.
 *
 * This module is the parse that closes it, and nothing else: a type says which grammar a document is
 * written in, and the text becomes a value or a located complaint about why it could not.
 *
 * ## The source is not replaced, and that is the whole design
 *
 * A parsed reading LOSES things. YAML comments have no counterpart in the data model, a block scalar
 * becomes a string full of `\n`, key order does not survive an object with integer-like keys, anchors
 * are expanded into copies that no longer share identity, and a `!Ref` tag is dropped or stringified.
 * Every one of those is sometimes the most important thing in the file.
 *
 * So this is added ALONGSIDE the source rather than in front of it, and `viewsFor` keeps the source
 * leading for the formats a person writes by hand. The parsed reading answers "what does the machine
 * see" — which is the question you have the moment a merge key or an anchor is involved, and the one
 * the source is worst at.
 *
 * ## Why a failure is a value rather than a throw
 *
 * The moment a reader most wants a parse is when the document is broken: a model emitted YAML with a
 * tab in it, or a JSON body with a trailing comma. A parser that throws gives a surface nothing to
 * draw but a blank panel, so the failure carries its own message and, where the parser knows one, the
 * line and column to point at.
 */
import { parseAllDocuments } from "yaml";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { mimeFallbacks } from "./mime";

/**
 * The grammars this app can turn into a value.
 *
 * Short, and short on purpose — a format is on this list when there is a parser that is CORRECT for
 * it, not when one could be written. TOML and INI are the two obvious absentees: both are common
 * enough to want, neither has a parser in the dependency tree, and a hand-rolled TOML (dotted keys,
 * arrays of tables, offset date-times) is how you get a reader that quietly disagrees with the
 * program that wrote the file. Adding either is one entry below plus one case in
 * {@link parseStructured}, and that is deliberately the whole cost.
 */
export type StructuredFormat = "json" | "jsonl" | "yaml" | "delimited";

/**
 * Which grammar a type names, walking the fallback chain so a vendor type inherits its syntax.
 *
 * `application/vnd.jaira.workflow+yaml` is YAML whatever else it is — the same resolution
 * `fileTypes.ts` uses for surfaces and `typeNames.ts` uses for names, so a new `+json` type gets the
 * structured reading without an entry anywhere.
 *
 * The bare subtypes are accepted for the reason `viewOfMime` accepts them: a slot declares
 * `{contentMediaType: "yaml"}`, and a declaration that never reaches the renderer is a declaration
 * nobody had a reason to write.
 */
export function structuredFormatOf(mime: string | undefined): StructuredFormat | undefined {
  if (mime === undefined || mime === "") return undefined;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  for (const candidate of mimeFallbacks(base)) {
    if (candidate === "jsonl" || candidate === "application/jsonl") return "jsonl";
    if (candidate === "json" || candidate === "application/json") return "json";
    if (candidate === "yaml" || candidate === "application/yaml") return "yaml";
    if (candidate === "csv" || candidate === "text/csv") return "delimited";
    if (candidate === "tsv" || candidate === "text/tab-separated-values") return "delimited";
  }
  return undefined;
}

/** The character that separates fields, for the one format whose name does not carry it. */
export function delimiterOf(mime: string | undefined): string {
  return mime !== undefined && mime.toLowerCase().includes("tab-separated") ? "\t" : ",";
}

/** Where a complaint points. 1-based, because it is shown to a person rather than used as an index. */
export interface ParseSpot {
  line: number;
  column: number;
}

/**
 * What a document turned out to be.
 *
 * `ok: false` is a normal outcome rather than an exceptional one — see the module header. `spot` is
 * absent where the parser knew something was wrong but not where, which happens and is still worth
 * saying.
 */
export type ParsedStructure =
  | {
      ok: true;
      value: unknown;
      /** How many `---` documents the stream held, when it held more than one. */
      documents?: number;
    }
  | { ok: false; message: string; spot?: ParseSpot };

/** A 0-based offset into `text`, as the line and column a person would count to. */
export function spotOf(text: string, offset: number): ParseSpot {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = upto.split("\n").length;
  return { line, column: upto.length - (upto.lastIndexOf("\n") + 1) + 1 };
}

/**
 * The value a document denotes, or why it denotes none.
 *
 * Never throws. Every parser here has some way to fail that is not a syntax error — an alias bomb, a
 * stack overflow on a pathologically nested array — and a viewer is the last place that should
 * discover one, so the whole call is fenced.
 */
export function parseStructured(text: string, format: StructuredFormat, delimiter = ","): ParsedStructure {
  try {
    if (format === "json") return parseAsJson(text);
    if (format === "jsonl") return parseAsJsonLines(text);
    if (format === "yaml") return parseAsYaml(text);
    return { ok: true, value: parseDelimited(text, delimiter) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * JSON, read the way the files in this repo are actually written.
 *
 * `jsonc-parser` rather than `JSON.parse`, and the tolerance is the point: `settings.json` carries
 * comments, a model's ```json block routinely carries a trailing comma, and refusing both would mean
 * the reading is unavailable exactly where it would help. What is NOT tolerated is silence — the
 * errors are collected and the first is reported, so a document that only half-parsed says so rather
 * than showing a plausible-looking half of itself.
 */
function parseAsJson(text: string): ParsedStructure {
  if (text.trim() === "") return { ok: false, message: "The document is empty." };
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first !== undefined) {
    return { ok: false, message: printParseErrorCode(first.error), spot: spotOf(text, first.offset) };
  }
  return { ok: true, value };
}

/**
 * JSON Lines: one value per line, read as the list it is.
 *
 * The format a log, an export or an eval run arrives in, and the one where "just show the text" is
 * furthest from useful — a thousand lines of `{"ts":...,"event":...}` is a wall that happens to be
 * made of records. Whole-file `JSON.parse` refuses it (it is not one document), which is why it read
 * as plain text until now.
 *
 * Blank lines are skipped, because a trailing newline is not a record and every writer leaves one. A
 * line that does not parse fails the whole file WITH ITS LINE NUMBER rather than being dropped: a
 * reader shown 999 of 1000 records and told nothing has been lied to about what the file contains.
 */
function parseAsJsonLines(text: string): ParsedStructure {
  const values: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    const errors: ParseError[] = [];
    const value = parseJsonc(line, errors, { allowTrailingComma: true, disallowComments: false });
    const first = errors[0];
    if (first !== undefined) {
      return { ok: false, message: printParseErrorCode(first.error), spot: { line: i + 1, column: first.offset + 1 } };
    }
    values.push(value);
  }
  if (values.length === 0) return { ok: false, message: "The document is empty." };
  return { ok: true, value: values, documents: values.length };
}

/**
 * YAML, as every document in the stream.
 *
 * `parseAllDocuments` rather than `parse`, because a stream of `---`-separated documents is a thing
 * JSON has no counterpart for and is common exactly where this gets used — a Kubernetes manifest, a
 * model putting two examples in one fence. One document reads as itself; several read as a list,
 * with the count carried so a surface can say which of the two it is showing.
 *
 * `toJS` is where the lossiness the module header warns about actually happens: non-string keys are
 * stringified, tags resolve away, and aliases expand into copies. The last of those can also fail
 * outright — a cyclic anchor is a graph and the result has to be a tree — and `yaml`'s own
 * `maxAliasCount` is what stops that becoming a hang. It throws, {@link parseStructured} catches, and
 * the reader is told rather than left watching a panel that never fills in.
 */
function parseAsYaml(text: string): ParsedStructure {
  if (text.trim() === "") return { ok: false, message: "The document is empty." };
  // `merge: true` is not a default and has to be asked for: `<<` is a YAML 1.1 convention that the
  // 1.2 core schema does not know, so without it a merge key comes back as an ORDINARY key called
  // `<<` whose value is the map it was supposed to have been merged in. That is not a near miss —
  // it is a different document from the one every tool that honours merge keys reads, and a reading
  // that disagrees with the program consuming the file is worse than no reading.
  const docs = parseAllDocuments(text, { prettyErrors: true, merge: true });
  for (const doc of docs) {
    const error = doc.errors[0];
    if (error !== undefined) {
      const at = error.linePos?.[0];
      return {
        ok: false,
        message: error.message.split("\n")[0]!,
        ...(at !== undefined ? { spot: { line: at.line, column: at.col } } : {}),
      };
    }
  }
  if (docs.length === 0) return { ok: false, message: "The document is empty." };
  if (docs.length === 1) return { ok: true, value: docs[0]!.toJS() };
  return { ok: true, value: docs.map((doc) => doc.toJS()), documents: docs.length };
}

/**
 * CSV and TSV, by RFC 4180 — quotes included, because they are the whole difficulty.
 *
 * Hand-written rather than a dependency, which is the opposite of the call made for TOML above, and
 * the difference is the size of the grammar. This one is four rules: a field is quoted or it is not,
 * `""` inside a quoted field is one quote, and a quoted field may contain the delimiter and the
 * newline that would otherwise end it. Everything that makes a CSV parser genuinely hard is a
 * question about DIALECT — is the separator a semicolon, is the first row a header, are the numbers
 * localised — and those are questions this does not answer and does not need to.
 *
 * Ragged rows stay ragged. Padding them would be inventing cells, and a row with the wrong number of
 * fields is usually the thing the reader opened the file to find.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  /** Whether anything at all has been seen on this row — what tells a trailing newline from a row. */
  let started = false;

  const endRow = (): void => {
    row.push(field);
    rows.push(row);
    field = "";
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') {
        field += ch;
        continue;
      }
      // A doubled quote is one quote; a lone one closes the field.
      if (text[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      quoted = false;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      started = true;
      continue;
    }
    // `\r` is dropped wherever it appears outside a quoted field: a CRLF file is the same table as
    // an LF one, and a stray carriage return in a cell is not data anybody put there.
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
    started = true;
  }
  // A file that does not end in a newline still ends in a row; one that does must not gain a blank.
  if (started || field !== "" || row.length > 0) endRow();
  return rows;
}
