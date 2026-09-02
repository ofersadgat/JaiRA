/**
 * YAML, taken apart into coloured pieces — the counterpart of `jsonHighlight.ts`, for the one place
 * Monaco must not go.
 *
 * The app already colours YAML: `CodeText` is Monaco's tokenizer with no editor under it, and it is
 * what the `code` view mounts. This exists because of front matter. Every markdown document in the
 * shared root opens with a `---` block, `markdown.tsx` renders one per message down a transcript of
 * forty, and that module is deliberately synchronous and dependency-light — a `Suspense` boundary
 * and a lazy megabyte to colour five lines of `name:` and `description:` is the wrong trade twice
 * over. So: a line scanner, no parser, no dependency, no await.
 *
 * ## What "line scanner" costs, and why it is the right size
 *
 * This does not parse YAML and does not pretend to. Flow mappings spanning lines, complex keys
 * (`? [a, b]`), and multi-line quoted scalars are coloured approximately rather than correctly. That
 * is acceptable HERE, where the subject is a header of scalar keys, and would not be acceptable as
 * the app's only YAML rendering — which is why it is not: the `code` view is still Monaco, and the
 * `data` view is still a real parse.
 *
 * The one piece of state it does keep is block scalars. `prompt: |` followed by twenty indented
 * lines is the single most common shape in this repo's workflow files, and colouring that body as if
 * each line were a fresh key is worse than not colouring it at all.
 *
 * ## The invariant it shares with the JSON one
 *
 * Concatenating every token of every line, with newlines between, reproduces the input EXACTLY. The
 * JSON scanner needs that because a coloured layer sits behind a textarea; this one needs it because
 * a header that silently dropped a character would be a renderer quietly editing the document.
 */
import type { Describe, HighlightLine, Token, TokenKind } from "./jsonHighlight";

/** Values that are not strings or numbers. `~` is null, and is the spelling people actually type. */
const LITERALS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

/** A plain scalar that is a number — the same shapes JSON allows, plus YAML's octal and hex. */
const NUMBER = /^[-+]?(?:0[xob][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.inf|\.nan)$/i;

/** One open block, for tracking the path a key sits at. Sequences borrow their key, as in JSON. */
interface Frame {
  indent: number;
  key: string;
}

/**
 * Colour a YAML document, and tell each key what it MEANS where a schema says so.
 *
 * `describe` is the same seam `highlightJson` offers and is unused by front matter, which has no
 * schema to describe it. It is here so the two scanners have one contract rather than nearly one —
 * the moment a YAML document is shown against a schema, the hint machinery is already wired.
 */
export function highlightYaml(text: string, describe?: Describe): HighlightLine[] {
  const out: HighlightLine[] = [];
  const stack: Frame[] = [];
  /** The indent that opened a `|` or `>` block, when one is open. Its body is all one scalar. */
  let blockIndent: number | null = null;

  for (const raw of text.split("\n")) {
    const tokens: Token[] = [];
    const emit = (chunk: string, kind: TokenKind): void => {
      if (chunk.length > 0) tokens.push({ text: chunk, kind });
    };

    const indent = raw.length - raw.trimStart().length;
    const blank = raw.trim() === "";

    // --- inside a block scalar: everything more-indented is its body ---
    if (blockIndent !== null && (blank || indent > blockIndent)) {
      emit(raw, "string");
      out.push({ tokens });
      continue;
    }
    if (!blank) blockIndent = null;

    if (blank) {
      out.push({ tokens });
      continue;
    }

    emit(raw.slice(0, indent), "plain");
    let rest = raw.slice(indent);

    // --- a whole-line comment ---
    if (rest.startsWith("#")) {
      emit(rest, "comment");
      out.push({ tokens });
      continue;
    }

    // --- document markers ---
    if (rest === "---" || rest === "..." || rest.startsWith("--- ") || rest.startsWith("%")) {
      emit(rest, "punct");
      out.push({ tokens });
      continue;
    }

    // --- sequence dashes, however many are stacked on one line (`- - a`) ---
    let column = indent;
    while (rest === "-" || rest.startsWith("- ")) {
      const dash = rest === "-" ? "-" : "- ";
      emit(dash, "punct");
      column += dash.length;
      rest = rest.slice(dash.length);
    }
    if (rest === "") {
      out.push({ tokens });
      continue;
    }

    // --- a key, when this line opens one ---
    let hint: string | undefined;
    const key = keyAt(rest);
    if (key !== null) {
      emit(key.raw, "key");
      emit(":", "punct");
      // Pop every block at or inside this one's indent: a key at column 2 closes everything that was
      // open at column 2 or deeper. Then this key's own path is what remains.
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= column) stack.pop();
      hint = describe?.(
        stack.map((frame) => frame.key),
        key.name,
      );
      stack.push({ indent: column, key: key.name });
      rest = rest.slice(key.raw.length + 1);
    }

    emitValue(rest, emit);
    if (blockOpensAt(rest)) blockIndent = indent;
    out.push({ tokens, ...(hint !== undefined ? { hint } : {}) });
  }

  // `split` on a document ending in a newline yields a trailing empty line, which is a real line and
  // is kept: dropping it would break the reconstruction invariant by exactly one newline.
  return out;
}

/** A key at the head of `rest`, quoted or bare, or null when this line does not open one. */
function keyAt(rest: string): { raw: string; name: string } | null {
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0]!;
    const end = closingQuote(rest, quote);
    if (end === -1 || rest[end + 1] !== ":") return null;
    return { raw: rest.slice(0, end + 1), name: rest.slice(1, end) };
  }
  // A bare key runs to the first `:` that ends it — one followed by a space or by the end of the
  // line. `http://x` is therefore not a key, which is the case this rule exists for.
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === "#") return null;
    if (ch !== ":") continue;
    if (i + 1 !== rest.length && rest[i + 1] !== " ") continue;
    const name = rest.slice(0, i);
    return name.trim() === "" ? null : { raw: name, name: name.trimEnd() };
  }
  return null;
}

/** The index of the quote that closes one opened at 0, or -1 for a scalar that never closes. */
function closingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    // In a single-quoted scalar `''` is one quote rather than a close.
    if (text[i] === quote && !(quote === "'" && text[i + 1] === "'")) return i;
    if (text[i] === quote && quote === "'") i++;
  }
  return -1;
}

/** Whether a value opens a literal or folded block — `|`, `>`, with any chomping indicator. */
function blockOpensAt(value: string): boolean {
  return /^\s*[|>][-+]?\d*\s*(?:#.*)?$/.test(value);
}

/**
 * Everything after the colon: leading space, the scalar, and a trailing comment.
 *
 * Split rather than scanned character by character because the only ambiguity that matters is the
 * `#`: it starts a comment when whitespace precedes it and is an ordinary character otherwise, and a
 * quoted scalar swallows it either way. Getting that one rule right is most of what makes a header
 * look correct.
 */
function emitValue(value: string, emit: (chunk: string, kind: TokenKind) => void): void {
  if (value === "") return;
  const lead = value.length - value.trimStart().length;
  emit(value.slice(0, lead), "plain");
  let body = value.slice(lead);
  if (body === "") return;

  // A quoted scalar owns everything up to its close, `#` included.
  if (body.startsWith('"') || body.startsWith("'")) {
    const end = closingQuote(body, body[0]!);
    const scalar = end === -1 ? body : body.slice(0, end + 1);
    emit(scalar, "string");
    emitValue(body.slice(scalar.length), emit);
    return;
  }

  // Anchors, aliases and tags — the parts of YAML that JSON has no word for, so they get their own
  // colour rather than disappearing into the scalar beside them.
  const marked = /^([&*!][^\s]*)(\s*)/.exec(body);
  if (marked !== null) {
    emit(marked[1]!, "literal");
    emit(marked[2]!, "plain");
    emitValue(body.slice(marked[0].length), emit);
    return;
  }

  // A comment, when a `#` is preceded by whitespace or starts the value.
  const comment = /(^|\s)#/.exec(body);
  if (comment !== null) {
    const at = comment.index + comment[1]!.length;
    emitValue(body.slice(0, at), emit);
    emit(body.slice(at), "comment");
    return;
  }

  // A plain scalar, trailing whitespace kept separate so the invariant holds.
  const trail = body.length - body.trimEnd().length;
  const scalar = trail === 0 ? body : body.slice(0, body.length - trail);
  body = trail === 0 ? "" : body.slice(body.length - trail);
  if (NUMBER.test(scalar)) emit(scalar, "number");
  else if (LITERALS.has(scalar.toLowerCase())) emit(scalar, "literal");
  else if (/^[|>][-+]?\d*$/.test(scalar)) emit(scalar, "punct");
  else emit(scalar, "string");
  emit(body, "plain");
}
