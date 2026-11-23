/**
 * Markdown while it is still being written: a model's answer drawn as markdown as it streams, not
 * as plain text until the turn ends.
 *
 * Two jobs, both pure, both here so they can be tested without anything that draws.
 *
 * ## Parsing only what can still change ({@link StreamParse})
 *
 * An answer arrives a few characters at a time and is drawn up to 30 times a second. Parsing all of
 * it each time is O(length) per frame — 7.5 ms for 60 KB — and, worse, every block comes back as a
 * new object, so nothing above the end can be recognised as unchanged and every block is drawn
 * again. But only the LAST top-level block of a markdown document can still change as text is added
 * to its end: a block before it was closed by the line that began the next one, and nothing after a
 * blank line reaches back over it. So once a block is followed by a blank line and a complete line
 * that starts another, it is SETTLED: its tokens are kept, in a segment that is never parsed again,
 * and only the text after it is.
 *
 * The one construct that does reach backwards is a reference definition (`[x]: https://…`), which
 * can give a link above it its target. An answer with one is parsed whole, every time.
 *
 * ## What half-written markdown shows ({@link streamingText})
 *
 * markdown-it already draws an unclosed fence as a code block running to the end, which is right.
 * What it cannot know is that `**bold` is about to be closed: it draws the asterisks. So the end of
 * the text is tidied before it is parsed — a dangling `**`, `*`, `_`, `~~` or `` ` `` on the last line
 * is closed (or dropped, with nothing after it yet), a link whose URL is still arriving shows its
 * words, a picture still arriving shows nothing, and a last line that is only a marker so far (`-`,
 * `1.`, `#`, a fence's backticks) is held back — `options:` over a lone `-` is a setext heading
 * until the item's words arrive.
 */
import { parseMarkdown, type Token } from "./markdownParse";

// --- the tail, tidied ---------------------------------------------------------------------------

/** A fence's opening or closing line: up to any indent (a fence in a list item is indented). */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
/** A last line that is only the start of something: a bullet, a number, a heading's hashes, a rule or underline, a fence. */
const MARKER_ONLY = /^\s*(?:[-*+=_]+|\d{1,9}[.)]?|#{1,6}|`+\w*|~+\w*|>)\s*$/;

/**
 * The text as it should be drawn while more is coming. Only the end changes: everything up to the
 * last line's start is returned as it is, so a settled prefix stays a prefix.
 */
export function streamingText(text: string): string {
  let body = text;
  const nl = body.lastIndexOf("\n");
  // An unfinished last line that is only a marker: drawn once its words come.
  if (MARKER_ONLY.test(body.slice(nl + 1)) && body.slice(nl + 1).length > 0) body = body.slice(0, nl + 1);
  // Inside a fence, everything is code and nothing is tidied.
  const lines = body.split("\n");
  let fence: string | undefined;
  for (const line of lines) {
    const m = FENCE_LINE.exec(line);
    if (m === null) continue;
    if (fence === undefined) fence = m[1]!;
    else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.slice(m[0].length).trim() === "") fence = undefined;
  }
  if (fence !== undefined) return body;
  // The last line with anything on it is the one tidied; a trailing newline is kept after it.
  let at = lines.length - 1;
  while (at >= 0 && lines[at]!.trim() === "") at -= 1;
  if (at < 0) return body;
  const last = lines[at]!;
  // A table's header with no delimiter row yet is a paragraph of pipes: not drawn until it is a table.
  if (/^\s*\|/.test(last) && (at === 0 || lines[at - 1]!.trim() === "")) {
    return lines.slice(0, at).join("\n") + (at > 0 ? "\n" : "");
  }
  const tidied = closeInline(last);
  if (tidied === last) return body;
  lines[at] = tidied;
  return lines.join("\n");
}

type Delim = "~~" | "**" | "__" | "*" | "_";

/** One line's dangling inline marks, closed — or dropped, where nothing follows them yet. */
export function closeInline(line: string): string {
  let text = line;
  // A picture still arriving shows nothing; a link whose target is still arriving shows its words.
  text = text.replace(/!\[[^\]]*(?:\]\([^)]*)?$/, "");
  text = text.replace(/\[([^\]]*)\]\([^)]*$/, "$1");
  // Code spans: a run of n backticks closes at the next run of exactly n. What is inside is not
  // scanned for emphasis; an unclosed one runs to the end.
  let outside = "";
  let open: { at: number; ticks: string } | undefined;
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      outside += text[i];
      i += 1;
      continue;
    }
    let n = 1;
    while (text[i + n] === "`") n += 1;
    const ticks = "`".repeat(n);
    let close = -1;
    for (let j = i + n; j < text.length; ) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let m = 1;
      while (text[j + m] === "`") m += 1;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      open = { at: i, ticks };
      break;
    }
    // A span's place in `outside` is kept as spaces, so positions there are positions in `text`.
    outside += " ".repeat(close + n - i);
    i = close + n;
  }
  let end = "";
  if (open !== undefined) {
    if (text.slice(open.at + open.ticks.length).trim() === "") text = text.slice(0, open.at);
    else end = open.ticks;
  }
  // Emphasis: each run of `*`, `_` or `~` toggles what it can open or close.
  const opened = new Map<Delim, number>();
  const toggle = (d: Delim, at: number): void => {
    if (opened.has(d)) opened.delete(d);
    else opened.set(d, at);
  };
  for (const m of outside.matchAll(/\*+|_+|~+/g)) {
    const at = m.index;
    const run = m[0];
    const before = at === 0 ? " " : outside[at - 1]!;
    // A run at the very end after a space is an opener whose words have not come: not drawn yet.
    if (at + run.length === text.length && open === undefined && /\s/.test(before)) {
      text = text.slice(0, at);
      break;
    }
    const after = at + run.length >= outside.length ? " " : outside[at + run.length]!;
    // A run with space either side opens and closes nothing (`2 * 3`, a bullet's `* `).
    if (/\s/.test(before) && /\s/.test(after)) continue;
    const ch = run[0]!;
    if (ch === "~") {
      if (run.length >= 2) toggle("~~", at);
      continue;
    }
    // `_` inside a word (`snake_case`) is a letter, not emphasis.
    if (ch === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) continue;
    const strong = ch === "*" ? "**" : "__";
    const em = ch === "*" ? "*" : "_";
    if (run.length >= 3) {
      toggle(strong, at);
      toggle(em, at + 2);
    } else toggle(run.length === 2 ? strong : em, at);
  }
  // Innermost first: the one opened last closes first. One with nothing after it yet is dropped.
  const pending = [...opened.entries()].sort((a, b) => b[1] - a[1]);
  let body = text;
  let closers = "";
  for (const [d, at] of pending) {
    if (body.slice(at + d.length).replace(/[*_~]/g, "").trim() === "") {
      body = body.slice(0, at) + body.slice(at + d.length);
      continue;
    }
    closers += d;
  }
  if (end === "" && closers === "") return body === line ? line : body.trimEnd();
  // A closer after a space closes nothing (`**bold **`), so the space goes.
  return (end !== "" ? body : body.trimEnd()) + end + closers;
}

// --- the parse, kept ----------------------------------------------------------------------------

/** What a streaming parse hands back. */
export interface StreamParsed {
  /**
   * The settled blocks, a segment per stretch that settled together. Each segment is the SAME array
   * from one parse to the next, so what is built from it can be kept by it (`WeakMap`).
   */
  settled: readonly (readonly Token[])[];
  /** The tokens of the rest — the blocks that may still change. */
  tail: Token[];
  /** The fenced block still waiting for its closing fence, if there is one (it is in `tail`). */
  open: Token | undefined;
}

/** A reference definition, which can reach back over a settled block. */
const REFERENCE = /^ {0,3}\[[^\]]+\]:/m;

/**
 * A parse of a text that grows at its end, which parses only what can still change. One per
 * growing text: a text that is not the last one with something added is parsed from scratch.
 */
export class StreamParse {
  private segments: Token[][] = [];
  /** The settled text: the segments' source, ending at the start of a line. */
  private base = "";

  parse(text: string): StreamParsed {
    if (REFERENCE.test(text)) {
      this.reset();
      const tokens = parseMarkdown(text);
      return { settled: [], tail: tokens, open: openFence(tokens, text.split("\n")) };
    }
    if (!text.startsWith(this.base)) this.reset();
    const rest = text.slice(this.base.length);
    const tokens = parseMarkdown(rest);
    const lines = rest.split("\n");
    const open = openFence(tokens, lines);
    // Where the last top-level block starts: everything before it is settled, if it begins on a
    // complete line after a blank one.
    let split = -1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const token = tokens[i]!;
      if (token.level === 0 && token.nesting !== -1 && token.map !== null) {
        split = i;
        break;
      }
    }
    const line = split > 0 ? tokens[split]!.map![0] : 0;
    if (line > 0 && line < lines.length - 1 && lines[line - 1]!.trim() === "") {
      const settled = tokens.slice(0, split);
      this.segments.push(settled);
      this.base += lines.slice(0, line).join("\n") + "\n";
      return { settled: this.segments.slice(), tail: tokens.slice(split), open };
    }
    return { settled: this.segments.slice(), tail: tokens, open };
  }

  private reset(): void {
    this.segments = [];
    this.base = "";
  }
}

/** The last fenced block, when its closing fence has not arrived: an open fence runs to the end. */
function openFence(tokens: readonly Token[], lines: readonly string[]): Token | undefined {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    if (token.type !== "fence") continue;
    if (token.map === null) return undefined;
    const [from, to] = token.map;
    const closing = to - 1 > from ? FENCE_LINE.exec(lines[to - 1] ?? "") : null;
    const closed =
      closing !== null &&
      closing[1]![0] === token.markup[0] &&
      closing[1]!.length >= token.markup.length &&
      lines[to - 1]!.slice(closing[0].length).trim() === "";
    return closed ? undefined : token;
  }
  return undefined;
}
