/**
 * JSON, taken apart into coloured pieces — and told what each key MEANS.
 *
 * Two features share this one pass, which is why they share a module. Colouring needs the tokens;
 * the end-of-line hints need to know, for every key, which schema property it is — and that is a
 * question about the key's PATH, not its name. `model` inside `operation` and a `model` someone put
 * at the top level are different fields, and only a scan that tracked the containers can tell them
 * apart. Doing that twice would be two scanners to keep in agreement.
 *
 * ## It must survive text that is not JSON
 *
 * The input is a document being typed into. Unterminated strings, a trailing comma, a brace that
 * never closes — all normal mid-edit, and none of them may throw or lose a character. The one
 * invariant that matters is that concatenating every token of every line, with newlines between,
 * reproduces the input EXACTLY. If it did not, the coloured layer would drift out of alignment with
 * the textarea it sits behind, which is worse than no colour at all.
 *
 * ## Keys are recognised retroactively
 *
 * A string is a key if a `:` follows it, and that is not known when the string ends. So strings are
 * emitted as strings and re-labelled when the colon arrives — which is also the moment the key's
 * path is known, and therefore the moment its hint can be looked up.
 */

/**
 * `comment` is never emitted by {@link highlightJson} — JSON has none — and is here because
 * `yamlHighlight.ts` shares this vocabulary and the CSS that colours it. One set of token classes
 * rather than two that have to agree.
 */
export type TokenKind = "key" | "string" | "number" | "literal" | "punct" | "plain" | "comment";

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface HighlightLine {
  tokens: Token[];
  /** The schema's description of the first key on this line, shown ghosted at the end of it. */
  hint?: string;
}

/** Look up what a key means, given the path of the object it sits in. */
export type Describe = (path: string[], key: string) => string | undefined;

/** One open container, for tracking the path a key sits at. */
interface Frame {
  object: boolean;
  key?: string;
  current?: string;
}

/** Literals that are not strings or numbers. */
const LITERALS = new Set(["true", "false", "null"]);

export function highlightJson(text: string, describe?: Describe): HighlightLine[] {
  const lines: HighlightLine[] = [{ tokens: [] }];
  const stack: Frame[] = [];

  /** The token index of the most recent string, so a following `:` can re-label it. */
  let lastString: { line: number; index: number; value: string } | null = null;

  let lineNo = 0;
  let i = 0;

  /** Append text to the current line, splitting on newlines so no token ever spans one. */
  const emit = (raw: string, kind: TokenKind): void => {
    const parts = raw.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        lines.push({ tokens: [] });
        lineNo++;
      }
      if (parts[p]!.length > 0) lines[lineNo]!.tokens.push({ text: parts[p]!, kind });
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    // --- strings, terminated or not ---
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          closed = true;
          break;
        }
        j++;
      }
      const end = closed ? j + 1 : text.length;
      const raw = text.slice(i, end);
      const startLine = lineNo;
      const startIndex = lines[lineNo]!.tokens.length;
      emit(raw, "string");
      // Only a string that actually closed can become a key; an unterminated one is still being
      // typed, and the `:` that would prove it a key has not been reached.
      lastString = closed
        ? { line: startLine, index: startIndex, value: text.slice(i + 1, j) }
        : null;
      i = end;
      continue;
    }

    // --- structure ---
    if (ch === "{" || ch === "[") {
      stack.push({ object: ch === "{", ...(currentKeyOf(stack) !== undefined ? { key: currentKeyOf(stack)! } : {}) });
      emit(ch, "punct");
      lastString = null;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      emit(ch, "punct");
      lastString = null;
      i++;
      continue;
    }
    if (ch === ":") {
      // The string before this was a name, not a value — and this is where its path is known.
      if (lastString !== null) {
        const token = lines[lastString.line]?.tokens[lastString.index];
        if (token !== undefined) token.kind = "key";
        const frame = stack[stack.length - 1];
        if (frame?.object === true) frame.current = lastString.value;
        const hint = describe?.(pathOf(stack), lastString.value);
        // First key on the line wins: JSON is written one key per line, and a second hint on a line
        // holding an inline object would sit far from the key it describes.
        const line = lines[lastString.line];
        if (line !== undefined && hint !== undefined && line.hint === undefined) line.hint = hint;
      }
      emit(ch, "punct");
      lastString = null;
      i++;
      continue;
    }
    if (ch === ",") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) delete frame.current;
      emit(ch, "punct");
      lastString = null;
      i++;
      continue;
    }

    // --- numbers ---
    if (/[-\d]/.test(ch)) {
      const match = /^-?\d*\.?\d*(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      const raw = match?.[0];
      if (raw !== undefined && raw.length > 0) {
        emit(raw, "number");
        i += raw.length;
        continue;
      }
    }

    // --- bare words: `true`, `null`, and whatever half-typed thing is not yet any of these ---
    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))!;
      const raw = match[0];
      emit(raw, LITERALS.has(raw) ? "literal" : "plain");
      i += raw.length;
      continue;
    }

    // --- whitespace and anything else, verbatim ---
    const match = /^\s+/.exec(text.slice(i));
    if (match !== null) {
      emit(match[0], "plain");
      i += match[0].length;
      continue;
    }
    emit(ch, "plain");
    i++;
  }

  return lines;
}

/**
 * One line's tokens, cut at a column.
 *
 * The editor draws a marker at the cursor — the completion menu's anchor, and the ghost of what Tab
 * would write — and the cursor is usually in the MIDDLE of a token: typing `"mod` leaves it inside a
 * string. So the token that straddles the column is split in two and the marker goes between the
 * halves, which is the only way it lands exactly where the caret is.
 *
 * Pure, and separated from the rendering, because the property that matters is arithmetic rather
 * than visual: `before` and `after` must reconstitute the line exactly, and `before` must be exactly
 * `column` characters long. A marker one character off would drag the ghost text out of line with
 * the caret it is supposed to continue.
 *
 * A `column` past the end of the line puts everything in `before`, which is what happens when the
 * caret sits on the newline itself.
 */
export function splitTokensAt(tokens: readonly Token[], column: number): { before: Token[]; after: Token[] } {
  const before: Token[] = [];
  const after: Token[] = [];
  let remaining = column;

  for (const token of tokens) {
    if (remaining <= 0) {
      after.push(token);
      continue;
    }
    if (remaining >= token.text.length) {
      before.push(token);
      remaining -= token.text.length;
      continue;
    }
    before.push({ text: token.text.slice(0, remaining), kind: token.kind });
    after.push({ text: token.text.slice(remaining), kind: token.kind });
    remaining = 0;
  }

  return { before, after };
}

/** The object keys enclosing the current position — an array borrows its own key for its items. */
function pathOf(stack: Frame[]): string[] {
  const path: string[] = [];
  for (const frame of stack) {
    if (frame.object && frame.key !== undefined) path.push(frame.key);
  }
  return path;
}

function currentKeyOf(stack: Frame[]): string | undefined {
  const frame = stack[stack.length - 1];
  if (frame === undefined) return undefined;
  return frame.object ? frame.current : frame.key;
}
