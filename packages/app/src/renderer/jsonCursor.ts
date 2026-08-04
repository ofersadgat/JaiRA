/**
 * Where the cursor is, in a JSON document that is probably not valid yet.
 *
 * This is what lets the editor answer "what can I write HERE?" — `propertiesOf(schema, path)` needs
 * the path, and the path has to come from a document mid-edit, which by definition does not parse.
 * So: a single left-to-right scan that tracks containers and never needs the text to be complete.
 * Everything after the cursor is ignored, which is what makes an unclosed brace harmless.
 *
 * It answers three things, and the third is the one that decides whether to suggest anything at all:
 *
 *  - **path** — the object keys enclosing the cursor. `["operation"]` inside an operation block.
 *  - **partial** — the property name being typed, so the list can filter as you go.
 *  - **inKeyPosition** — whether a property name is what belongs here. After `"model":` it is NOT,
 *    and suggesting `temperature` there would produce `"model": temperature`, which is worse than
 *    suggesting nothing.
 *
 * Array indices are deliberately absent from `path`. A schema addresses `transitions` as one thing
 * whose `items` describe every element, so `transitions.0` and `transitions.7` have the same answer,
 * and carrying the number would mean every lookup had to strip it back out.
 */

export interface CursorContext {
  /** Object keys enclosing the cursor, outermost first. Empty at the document's top level. */
  path: string[];
  /** The property name being typed, if any — the filter for the suggestion list. */
  partial: string;
  /** True when a property NAME is what belongs at the cursor. */
  inKeyPosition: boolean;
  /**
   * True when the name is being typed INSIDE its quotes.
   *
   * The editor only offers completions once this is set, and that is a deliberate narrowing. A bare
   * key position — right after `{` or a comma, with nothing typed — is also a place a name belongs,
   * but offering the whole schema there means the menu is open whenever the caret rests on a blank
   * line inside an object, and the arrow keys belong to the menu while it is. Waiting for the opening
   * quote gives back the arrows everywhere except mid-word, which is where completion is wanted.
   */
  quoted: boolean;
  /** Offset where {@link partial} began, so an accepted suggestion knows what to replace. */
  partialStart: number;
}

/** One open container in the scan. */
interface Frame {
  object: boolean;
  /** The key this container sits under in its parent, for objects that have one. */
  key?: string;
  /** The key most recently completed at this level — set by `:`, cleared by `,`. */
  current?: string;
  /** True between `:` and the next `,` — a VALUE is what belongs, not a name. */
  expectingValue: boolean;
}

/**
 * Analyse `text` up to `cursor`.
 *
 * Written as an explicit character scan rather than over a tokenizer because the input is broken by
 * assumption: a tokenizer that throws on the half-typed string under the cursor answers nothing, and
 * the half-typed string under the cursor is exactly what is being asked about.
 */
export function cursorContext(text: string, cursor: number): CursorContext {
  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString = "";
  /** Where the token under the cursor began, when it is not inside quotes. */
  let bareStart = -1;
  /** Span of the most recently CLOSED string — see the closing-quote case at the end. */
  let closedFrom = -1;
  let closedTo = -1;

  for (let i = 0; i < Math.min(cursor, text.length); i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastString = text.slice(stringStart + 1, i);
        closedFrom = stringStart;
        closedTo = i + 1;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stringStart = i;
      bareStart = -1;
      continue;
    }

    switch (ch) {
      case "{":
      case "[": {
        // An array carries its key too, so an object opened inside it can borrow it — that is what
        // makes `transitions[0].when` resolve against `transitions`.
        const key = currentKeyOf(stack);
        stack.push({ object: ch === "{", expectingValue: false, ...(key !== undefined ? { key } : {}) });
        bareStart = -1;
        break;
      }
      case "}":
      case "]":
        stack.pop();
        // The value that container was is now complete, so its parent is between entries again.
        if (stack.length > 0) stack[stack.length - 1]!.expectingValue = true;
        bareStart = -1;
        break;
      case ":": {
        const frame = stack[stack.length - 1];
        if (frame?.object === true) {
          frame.current = lastString;
          frame.expectingValue = true;
        }
        bareStart = -1;
        break;
      }
      case ",": {
        const frame = stack[stack.length - 1];
        if (frame) {
          frame.expectingValue = false;
          delete frame.current;
        }
        bareStart = -1;
        break;
      }
      default:
        // Whitespace between tokens is not part of one; anything else starts a bare token, which at
        // a key position is an unquoted name someone is part-way through typing.
        if (/\s/.test(ch)) bareStart = -1;
        else if (bareStart === -1) bareStart = i;
        break;
    }
  }

  const frame = stack[stack.length - 1];
  const inObject = frame?.object === true;
  const expectingValue = frame?.expectingValue === true;

  // The path: every enclosing OBJECT's key. An object nested in an array borrows the array's key,
  // which is what makes `transitions[0].when` resolve against `transitions`' item schema.
  // Only objects contribute: an array and the object inside it hold the SAME key, and counting both
  // would produce `transitions.transitions`.
  const path: string[] = [];
  for (const entry of stack) {
    if (entry.object && entry.key !== undefined) path.push(entry.key);
  }

  if (!inObject || expectingValue) {
    return { path, partial: "", inKeyPosition: false, quoted: false, partialStart: cursor };
  }

  // In key position. The name may be inside an unterminated quote, or typed bare.
  if (inString) {
    return {
      path,
      partial: text.slice(stringStart + 1, cursor),
      inKeyPosition: true,
      quoted: true,
      partialStart: stringStart,
    };
  }
  if (bareStart >= 0) {
    return { path, partial: text.slice(bareStart, cursor), inKeyPosition: true, quoted: false, partialStart: bareStart };
  }
  // The cursor sits immediately after a string that was closed — someone typed both quotes. That
  // string is the name being written, not a finished one: treating it as empty would offer every key
  // in the schema and then insert one AFTER the quotes, producing `"mod""model": `.
  if (closedTo === cursor && closedFrom >= 0) {
    return {
      path,
      partial: text.slice(closedFrom + 1, closedTo - 1),
      inKeyPosition: true,
      quoted: true,
      partialStart: closedFrom,
    };
  }
  return { path, partial: "", inKeyPosition: true, quoted: false, partialStart: cursor };
}

/** The key the innermost frame is currently under — what a `{` opening here would be named. */
function currentKeyOf(stack: Frame[]): string | undefined {
  const frame = stack[stack.length - 1];
  if (frame === undefined) return undefined;
  // An object inside an array is addressed by the array's own key: `transitions` describes its items.
  return frame.object ? frame.current : frame.key;
}

/**
 * The keys already written in the object the cursor is in.
 *
 * Suggesting a property the document already has is noise at best and a duplicate key at worst, so
 * the list is filtered by this. Scans the enclosing object's span only — from the `{` that opened it
 * to its match, which may be past the cursor and may not exist yet.
 */
export function siblingKeys(text: string, cursor: number): string[] {
  const open = openingBraceOf(text, cursor);
  if (open === -1) return [];

  const keys: string[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString = "";

  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastString = text.slice(stringStart + 1, i);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      if (stack.length === 0) break;
      stack.pop();
    } else if (ch === ":" && stack.length === 0) keys.push(lastString);
  }
  return keys;
}

/** The offset of the `{` that opens the object containing `cursor`, or -1. */
function openingBraceOf(text: string, cursor: number): number {
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < Math.min(cursor, text.length); i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? i : -1);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]! >= 0) return stack[i]!;
  }
  return -1;
}
