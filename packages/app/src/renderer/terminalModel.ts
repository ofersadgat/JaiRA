/**
 * A terminal as the window draws it (decision 0028): the raw output the engine keeps for a shell call
 * turned into lines of styled spans — what a terminal would be left showing, colours kept — plus what
 * the card says about it: its title, its status, whether it waits for input, and the answers its
 * prompt offers.
 *
 * Pure: no React, no store. `TermScreen` is incremental, so a push appends to what was parsed rather
 * than parsing a megabyte again; the store keeps one per terminal (`terminalStore.ts`).
 */
import { DIRECTORY_CHANGERS, YOU_CLOSE, YOU_OPEN, takeApart, type CommandDialect, type ShellRequest, type TerminalSummary } from "@jaira/shared/browser";

/** How a run of text is drawn. Colours are hex; absent is the screen's own. */
export interface TermStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Ink and ground swapped (SGR 7). */
  inverse?: boolean;
  /** There, but not drawn (SGR 8). */
  hidden?: boolean;
  /** Struck through (SGR 9). */
  strike?: boolean;
  /** A line over it (SGR 53). */
  overline?: boolean;
  /** What the person typed (between `YOU_OPEN` and `YOU_CLOSE`). */
  you?: boolean;
}

export interface TermSpan extends TermStyle {
  text: string;
}

export type TermLine = TermSpan[];

/**
 * The sixteen colours on the terminal's dark well — the ink palette's status hues where a colour means
 * the same thing (green ok, red bad, yellow warn), so a test runner's ticks read like the app's.
 */
export const TERM_COLOURS: readonly string[] = [
  "#3a3f63", "#ff8a80", "#6fd6a0", "#f3c464", "#7fb2ff", "#d6a8ff", "#7fc4f0", "#d4d7ee",
  "#8a90b4", "#ffb0a8", "#9be8bf", "#ffe08a", "#a9c9ff", "#e6c6ff", "#a6e3f5", "#ffffff",
];

/** The screen's own ink and ground. */
export const TERM_INK = { text: "#d4d7ee", dim: "#8a90b4", hint: "#5d6386", ground: "#0f1120", head: "#161931", line: "#262a45", accent: "#b3b6ff", ok: "#6fd6a0", warn: "#f3c464", bad: "#ff8a80" } as const;

const PLAIN: TermStyle = Object.freeze({});
const TAB = 8;

function cube(n: number): string {
  const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
  const r = level(Math.floor(n / 36) % 6);
  const g = level(Math.floor(n / 6) % 6);
  const b = level(n % 6);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The 256-colour palette's entry `n`. */
export function colour256(n: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(n)));
  if (i < 16) return TERM_COLOURS[i]!;
  if (i < 232) return cube(i - 16);
  const grey = (8 + (i - 232) * 10).toString(16).padStart(2, "0");
  return `#${grey}${grey}${grey}`;
}

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.trunc(Number.isNaN(v) ? 0 : v))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One SGR parameter: a number (`31`), or one with its sub-parameters as the colon form writes them
 * (`38:2::255:0:0` is `[38, 2, NaN, 255, 0, 0]`, `4:3` is `[4, 3]`).
 */
export type SgrParam = number | readonly number[];

/** An extended colour from its colon-form sub-parameters (`5:n`, `2:r:g:b`, `2:space:r:g:b`). */
function colourOfSubs(subs: readonly number[]): string | undefined {
  if (subs[0] === 5 && subs.length >= 2) return colour256(Number.isNaN(subs[1]!) ? 0 : subs[1]!);
  if (subs[0] === 2 && subs.length >= 5) return rgb(subs[2]!, subs[3]!, subs[4]!);
  if (subs[0] === 2 && subs.length === 4) return rgb(subs[1]!, subs[2]!, subs[3]!);
  return undefined;
}

/**
 * One SGR sequence's parameters applied to a style: a new object. What it does not draw (blink, fonts,
 * an underline's own colour) is passed over, its arguments with it.
 */
export function applySgr(style: TermStyle, params: readonly SgrParam[]): TermStyle {
  let next: TermStyle = { ...style };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const param = list[i]!;
    const head = typeof param === "number" ? param : (param[0] ?? 0);
    const p = Number.isNaN(head) ? 0 : head;
    const subs = typeof param === "number" ? undefined : param.slice(1);
    if (p === 38 || p === 48 || p === 58) {
      let colour: string | undefined;
      if (subs !== undefined && subs.length > 0) colour = colourOfSubs(subs);
      else {
        const mode = list[i + 1];
        if (mode === 5) {
          const n = list[i + 2];
          if (typeof n === "number" && !Number.isNaN(n)) colour = colour256(n);
          i += 2;
        } else if (mode === 2) {
          const [r, g, b] = [list[i + 2], list[i + 3], list[i + 4]];
          if (typeof r === "number" && typeof g === "number" && typeof b === "number") colour = rgb(r, g, b);
          i += 4;
        } else i = list.length;
      }
      // 58 colours an underline, drawn here in the text's own ink: read past, not drawn.
      if (colour !== undefined && p === 38) next.fg = colour;
      else if (colour !== undefined && p === 48) next.bg = colour;
      continue;
    }
    if (p === 0) next = style.you === true ? { you: true } : {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) {
      if (subs !== undefined && subs[0] === 0) delete next.underline;
      else next.underline = true;
    } else if (p === 7) next.inverse = true;
    else if (p === 8) next.hidden = true;
    else if (p === 9) next.strike = true;
    else if (p === 21) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p === 28) delete next.hidden;
    else if (p === 29) delete next.strike;
    else if (p === 53) next.overline = true;
    else if (p === 55) delete next.overline;
    else if (p >= 30 && p <= 37) next.fg = TERM_COLOURS[p - 30]!;
    else if (p >= 90 && p <= 97) next.fg = TERM_COLOURS[p - 90 + 8]!;
    else if (p >= 40 && p <= 47) next.bg = TERM_COLOURS[p - 40]!;
    else if (p >= 100 && p <= 107) next.bg = TERM_COLOURS[p - 100 + 8]!;
    else if (p === 39) delete next.fg;
    else if (p === 49) delete next.bg;
  }
  return next;
}

interface Cells {
  chars: string[];
  styles: TermStyle[];
}

/** A row of the screen: its cells while the cursor can still reach it, its spans once drawn (kept until it changes). */
interface Row {
  cells?: Cells;
  spans?: TermLine;
}

function spansOf(cells: Cells): TermLine {
  const line: TermLine = [];
  let text = "";
  let style: TermStyle | undefined;
  for (let i = 0; i < cells.chars.length; i++) {
    const s = cells.styles[i]!;
    if (s !== style && text.length > 0) {
      line.push({ ...style, text });
      text = "";
    }
    style = s;
    text += cells.chars[i]!;
  }
  if (text.length > 0) line.push({ ...style, text });
  return line;
}

const textOf = (line: TermLine): string => line.map((span) => span.text).join("");

const emptyRow = (): Row => ({ cells: { chars: [], styles: [] } });

/** Rows the cursor can still move back into; older ones are kept only as drawn. */
const LIVE_ROWS = 1_000;
/** How many rows past {@link LIVE_ROWS} pile up before they are let go of together. */
const FREEZE_STEP = 500;
/** The height a program that positions its cursor is taken to assume (none can ask a pipe). */
const SCREEN_ROWS = 24;
/** How far below the screen's top an absolute position can reach. */
const SCREEN_MAX_ROWS = 200;
/** How far right the cursor can be moved (`ESC[999C` goes to "the end"). */
const MAX_COL = 512;
/** A control sequence longer than this is not one. */
const MAX_CSI = 256;
/** A string (OSC, DCS, …) still unfinished past this many characters is not one: its introducer is dropped and the rest read as text. */
const MAX_STRING = 65_536;
/** The person's typing, as the OSC bodies the engine wraps it in. */
const YOU_OPEN_BODY = YOU_OPEN.slice(2, -1);
const YOU_CLOSE_BODY = YOU_CLOSE.slice(2, -1);

/**
 * A terminal's screen, fed its raw output a piece at a time: lines of styled spans, as a terminal
 * would be left showing them. A terminal with no width (a line too long wraps where it is drawn) and a
 * screen as tall as the output, the last {@link LIVE_ROWS} rows of which the cursor can reach:
 *
 *  - text, `\r`, `\n` (a new line, as a terminal set to translate it does), backspace and tabs;
 *  - CSI: SGR colours and attributes (16, 256 and true colour, either form), cursor moves (`A`–`G`,
 *    `H`, `f`, `d`, `` ` ``, `a`, `e`, saving and restoring), erasing (`J`, `K`, `X`), inserting and
 *    deleting characters and lines (`@`, `P`, `L`, `M`), and the alternate screen (`?1049`, `?1047`,
 *    `?47`) — left, what was drawn on it is gone, as it is from a terminal;
 *  - ESC `7`/`8`/`D`/`E`/`M`/`c`; C1 controls as their ESC forms;
 *  - everything else — titles and links (OSC), DCS, APC, PM and SOS strings, charsets, modes, reports —
 *    read to its end and dropped, so none of it shows as text.
 *
 * Clearing the screen (`ESC[2J`, `ESC c`) keeps what was on it above, as a terminal's scrollback does.
 * The person's typing, set between `YOU_OPEN` and `YOU_CLOSE` by the engine, is marked `you`.
 */
export class TermScreen {
  private readonly rows: Row[] = [emptyRow()];
  /** Rows above this are drawn only (`Row.spans`); the cursor cannot reach them. */
  private frozen = 0;
  /** The screen's top row, where `ESC[H` puts the cursor. */
  private top = 0;
  private row = 0;
  private col = 0;
  private style: TermStyle = PLAIN;
  private saved: { row: number; col: number; style: TermStyle } | undefined;
  /** While on the alternate screen: what to go back to. */
  private main: { length: number; row: number; col: number; top: number; style: TermStyle } | undefined;
  /** An escape cut off at the end of a piece, finished by the next one. */
  private carry = "";

  write(text: string): void {
    const input = this.carry + text;
    this.carry = "";
    const length = input.length;
    let i = 0;
    while (i < length) {
      const code = input.charCodeAt(i);
      if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) {
        const end = this.escape(input, i);
        if (end === undefined) {
          if (length - i > MAX_STRING) {
            i++;
            continue;
          }
          this.carry = input.slice(i);
          return;
        }
        i = end + 1;
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        this.control(code);
        i++;
        continue;
      }
      let j = i + 1;
      while (j < length) {
        const c = input.charCodeAt(j);
        if (c < 0x20 || c === 0x7f || c === 0x1b || (c >= 0x80 && c <= 0x9f)) break;
        j++;
      }
      this.print(input.slice(i, j));
      i = j;
    }
  }

  /** Every line, the one still being written last (empty when the output ended with a newline). */
  lines(): TermLine[] {
    const end = this.end();
    const out: TermLine[] = [];
    for (let r = 0; r < end; r++) out.push(this.spansAt(r));
    return out;
  }

  /** How many lines there are, the one being written included. */
  get count(): number {
    return this.end();
  }

  /** The last `n` lines, the one being written included unless it is empty. */
  tail(n: number): TermLine[] {
    let end = this.end();
    if (end > 0 && this.blank(end - 1)) end--;
    const out: TermLine[] = [];
    for (let r = Math.max(0, end - n); r < end; r++) out.push(this.spansAt(r));
    return out;
  }

  /** The line still being written, as text: a prompt that waits for an answer ends without a newline. */
  partial(): string {
    return textOf(this.spansAt(this.end() - 1));
  }

  /** The last line that has text, as text — a finished command's last word. */
  lastText(): string {
    for (let r = this.end() - 1; r >= 0; r--) {
      const text = textOf(this.spansAt(r));
      if (text.trim().length > 0) return text;
    }
    return "";
  }

  /** The whole screen as plain text: the `Text` reading, and what Copy takes. */
  plain(): string {
    return this.lines()
      .map(textOf)
      .join("\n")
      .replace(/\n+$/, "\n");
  }

  // --- the rows ------------------------------------------------------------------------------------

  /** One past the last row shown: the cursor's, or below it the last that has something on it. */
  private end(): number {
    let end = this.rows.length;
    while (end - 1 > this.row && this.blank(end - 1)) end--;
    return end;
  }

  private blank(r: number): boolean {
    const row = this.rows[r];
    if (row === undefined) return true;
    return row.cells !== undefined ? row.cells.chars.length === 0 : (row.spans?.length ?? 0) === 0;
  }

  private spansAt(r: number): TermLine {
    const row = this.rows[r];
    if (row === undefined) return [];
    row.spans ??= spansOf(row.cells!);
    return row.spans;
  }

  /** The cells of the row the cursor is on, its drawing let go of: it is about to change. */
  private cells(): Cells {
    while (this.rows.length <= this.row) this.rows.push(emptyRow());
    const row = this.rows[this.row]!;
    delete row.spans;
    row.cells ??= { chars: [], styles: [] };
    return row.cells;
  }

  /** Where the cursor may go up to: the oldest row it can reach — the alternate screen's top while on it. */
  private get ceiling(): number {
    return this.main !== undefined ? Math.max(this.frozen, this.top) : this.frozen;
  }

  private moveTo(row: number, col: number): void {
    this.row = Math.max(this.ceiling, row);
    this.col = Math.max(0, Math.min(MAX_COL, col));
    while (this.rows.length <= this.row) this.rows.push(emptyRow());
  }

  // --- text and controls ---------------------------------------------------------------------------

  private print(text: string): void {
    const cells = this.cells();
    // A cursor moved past the end (`ESC[G`, `ESC[C`) leaves no holes.
    while (cells.chars.length < this.col) {
      cells.chars.push(" ");
      cells.styles.push(PLAIN);
    }
    for (const ch of text) {
      cells.chars[this.col] = ch;
      cells.styles[this.col] = this.style;
      this.col++;
    }
  }

  private control(code: number): void {
    if (code === 0x0a || code === 0x0b || code === 0x0c) this.newline();
    else if (code === 0x0d) this.col = 0;
    else if (code === 0x08) this.col = Math.max(0, this.col - 1);
    else if (code === 0x09) {
      const to = Math.min(MAX_COL, (Math.floor(this.col / TAB) + 1) * TAB);
      const cells = this.cells();
      // Past the end a tab writes its blanks, so the text copied keeps its columns; over text it only moves.
      while (cells.chars.length < to) {
        cells.chars.push(" ");
        cells.styles.push(this.style);
      }
      this.col = to;
    }
    // BEL, NUL, SO, SI and the rest: nothing to draw.
  }

  /** Down a row to its start — a row added at the bottom, the screen scrolled, when it was the last. */
  private newline(): void {
    this.down();
    this.col = 0;
  }

  private down(): void {
    this.row++;
    while (this.rows.length <= this.row) this.rows.push(emptyRow());
    if (this.row - this.top >= SCREEN_ROWS) this.top = this.row - SCREEN_ROWS + 1;
    this.freeze();
  }

  /** Let go of the cells of rows the cursor can no longer reach. */
  private freeze(): void {
    if (this.rows.length - this.frozen <= LIVE_ROWS + FREEZE_STEP) return;
    const to = Math.min(this.rows.length - LIVE_ROWS, this.row, this.top, this.main?.length ?? Number.POSITIVE_INFINITY);
    for (let r = this.frozen; r < to; r++) {
      const row = this.rows[r]!;
      row.spans ??= spansOf(row.cells!);
      delete row.cells;
    }
    this.frozen = Math.max(this.frozen, to);
  }

  /** A clean screen below what was shown, which stays above as scrollback; the cursor where it was on it. */
  private newScreen(): void {
    let content = false;
    for (let r = this.top; r < this.rows.length && !content; r++) content = !this.blank(r);
    const offset = this.row - this.top;
    if (content) this.top = this.rows.length - (this.blank(this.rows.length - 1) ? 1 : 0);
    else {
      this.rows.length = Math.max(this.top, this.frozen) + 1;
      this.rows[this.rows.length - 1] = emptyRow();
    }
    this.moveTo(this.top + offset, this.col);
  }

  // --- escapes -------------------------------------------------------------------------------------

  /** An escape at `at` (ESC, or a C1 control): handled, and the index of its last character — or undefined when it is cut off. */
  private escape(input: string, at: number): number | undefined {
    const first = input.charCodeAt(at);
    let kind: number;
    let body: number;
    if (first === 0x1b) {
      if (at + 1 >= input.length) return undefined;
      kind = input.charCodeAt(at + 1);
      body = at + 2;
    } else {
      kind = first - 0x40;
      body = at + 1;
    }
    if (kind === 0x5b) return this.csi(input, body);
    if (kind === 0x5d) {
      const end = stringEnd(input, body);
      if (end === undefined) return undefined;
      const text = input.slice(body, end.at);
      if (text === YOU_OPEN_BODY) this.style = { ...this.style, you: true };
      else if (text === YOU_CLOSE_BODY) {
        const { you: _you, ...rest } = this.style;
        this.style = rest;
      }
      return end.last;
    }
    // DCS, SOS, PM, APC: a string to its terminator, none of it drawn.
    if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) return stringEnd(input, body)?.last;
    if (first !== 0x1b) {
      this.single(kind);
      return at;
    }
    if (kind >= 0x20 && kind <= 0x2f) {
      // ESC, intermediates, a final (`ESC ( B`, `ESC # 8`, `ESC % G`): a charset or a line's size — dropped.
      let j = at + 1;
      while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
      if (j >= input.length) return undefined;
      const final = input.charCodeAt(j);
      return final >= 0x30 && final <= 0x7e ? j : j - 1;
    }
    if (kind >= 0x30 && kind <= 0x7e) {
      this.single(kind);
      return at + 1;
    }
    // ESC before a control (or a second ESC): the ESC alone is dropped, what follows read as itself.
    return at;
  }

  /** A two-character escape: the cursor's saving and moves, and a reset. */
  private single(kind: number): void {
    const ch = String.fromCharCode(kind);
    if (ch === "7") this.saved = { row: this.row, col: this.col, style: this.style };
    else if (ch === "8") this.restore();
    else if (ch === "D") this.down();
    else if (ch === "E") this.newline();
    else if (ch === "M") this.row = Math.max(this.ceiling, this.row - 1);
    else if (ch === "c") {
      this.style = this.style.you === true ? { you: true } : PLAIN;
      this.newScreen();
      this.moveTo(this.top, 0);
    }
  }

  private restore(): void {
    if (this.saved === undefined) return this.moveTo(this.top, 0);
    this.moveTo(this.saved.row, this.saved.col);
    this.style = this.saved.style;
  }

  /** A control sequence from `start` (past its introducer): the index of its final character, or undefined when it is cut off. */
  private csi(input: string, start: number): number | undefined {
    let j = start;
    for (; j < input.length; j++) {
      const c = input.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      // Not a control sequence after all: its introducer is dropped, what follows read as itself.
      if (c < 0x20 || c > 0x7e || j - start > MAX_CSI) return start - 1;
    }
    if (j >= input.length) return undefined;
    let params = input.slice(start, j);
    const inter = /[ -/]+$/.exec(params);
    // With intermediates (`ESC[2 q`, the cursor's shape): nothing a log draws.
    if (inter !== null) return j;
    let prefix = "";
    if (/^[<=>?]/.test(params)) {
      prefix = params[0]!;
      params = params.slice(1);
    }
    this.sequence(prefix, input[j]!, params);
    return j;
  }

  private sequence(prefix: string, final: string, text: string): void {
    const groups = text.length === 0 ? [] : text.split(";").map((group) => group.split(":").map((p) => (p === "" ? Number.NaN : Number.parseInt(p, 10))));
    /** The `k`th parameter as a count: absent or 0 is `fallback`. */
    const count = (k: number, fallback = 1): number => {
      const v = groups[k]?.[0];
      return v === undefined || Number.isNaN(v) || v === 0 ? fallback : Math.min(v, 10_000);
    };
    if (prefix === "?") {
      if (final === "h" || final === "l") {
        for (const group of groups) if (group[0] === 1049 || group[0] === 1047 || group[0] === 47) this.alternate(final === "h");
      }
      return;
    }
    if (prefix !== "") return;
    switch (final) {
      case "m":
        this.style = applySgr(this.style, groups.map((group) => (group.length === 1 ? (Number.isNaN(group[0]!) ? 0 : group[0]!) : group)));
        return;
      case "A":
        this.row = Math.max(this.ceiling, this.row - count(0));
        return;
      case "B":
      case "e":
        // Down, but no further than what is there: `ESC[999B` means "to the bottom".
        this.row = Math.min(this.rows.length - 1, this.row + count(0));
        return;
      case "C":
      case "a":
        this.col = Math.min(MAX_COL, this.col + count(0));
        return;
      case "D":
        this.col = Math.max(0, this.col - count(0));
        return;
      case "E":
        this.row = Math.min(this.rows.length - 1, this.row + count(0));
        this.col = 0;
        return;
      case "F":
        this.row = Math.max(this.ceiling, this.row - count(0));
        this.col = 0;
        return;
      case "G":
      case "`":
        this.col = Math.min(MAX_COL, count(0) - 1);
        return;
      case "H":
      case "f":
        this.moveTo(this.top + Math.min(SCREEN_MAX_ROWS, count(0)) - 1, count(1) - 1);
        return;
      case "d":
        this.moveTo(this.top + Math.min(SCREEN_MAX_ROWS, count(0)) - 1, this.col);
        return;
      case "J":
        this.eraseDisplay(count(0, 0));
        return;
      case "K":
        this.eraseLine(count(0, 0));
        return;
      case "X": {
        const cells = this.cells();
        const to = Math.min(cells.chars.length, this.col + count(0));
        for (let c = this.col; c < to; c++) {
          cells.chars[c] = " ";
          cells.styles[c] = PLAIN;
        }
        return;
      }
      case "P": {
        const cells = this.cells();
        cells.chars.splice(this.col, count(0));
        cells.styles.splice(this.col, count(0));
        return;
      }
      case "@": {
        const cells = this.cells();
        if (this.col >= cells.chars.length) return;
        const n = Math.min(count(0), MAX_COL);
        cells.chars.splice(this.col, 0, ...new Array<string>(n).fill(" "));
        cells.styles.splice(this.col, 0, ...new Array<TermStyle>(n).fill(PLAIN));
        return;
      }
      case "L": {
        const n = Math.min(count(0), SCREEN_MAX_ROWS);
        this.rows.splice(this.row, 0, ...Array.from({ length: n }, emptyRow));
        this.col = 0;
        return;
      }
      case "M": {
        this.rows.splice(this.row, Math.min(count(0), this.rows.length - this.row));
        while (this.rows.length <= this.row) this.rows.push(emptyRow());
        this.col = 0;
        return;
      }
      case "s":
        if (groups.length === 0) this.saved = { row: this.row, col: this.col, style: this.style };
        return;
      case "u":
        this.restore();
        return;
      default:
      // Scrolling regions, reports, modes, tab stops: nothing a log draws.
    }
  }

  private eraseLine(mode: number): void {
    const cells = this.cells();
    if (mode === 0) {
      cells.chars.length = Math.min(cells.chars.length, this.col);
      cells.styles.length = cells.chars.length;
    } else if (mode === 1) {
      for (let c = 0; c <= this.col && c < cells.chars.length; c++) {
        cells.chars[c] = " ";
        cells.styles[c] = PLAIN;
      }
    } else if (mode === 2) {
      cells.chars.length = 0;
      cells.styles.length = 0;
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      this.rows.length = this.row + 1;
    } else if (mode === 1) {
      for (let r = Math.max(this.top, this.frozen); r < this.row; r++) this.rows[r] = emptyRow();
      this.eraseLine(1);
    } else if (mode === 2) this.newScreen();
    // 3, the scrollback: kept — it is the log.
  }

  /** Onto the alternate screen (a clean one below), or off it — what was drawn there goes, as it does from a terminal. */
  private alternate(on: boolean): void {
    if (on) {
      if (this.main !== undefined) return;
      this.main = { length: this.rows.length, row: this.row, col: this.col, top: this.top, style: this.style };
      this.top = this.blank(this.rows.length - 1) && this.row === this.rows.length - 1 ? this.rows.length - 1 : this.rows.length;
      this.moveTo(this.top, 0);
      return;
    }
    const main = this.main;
    if (main === undefined) return;
    this.main = undefined;
    this.rows.length = Math.max(this.frozen + 1, main.length);
    // The row it left from may have been reused as the alternate screen's first: as it was, empty.
    if (main.row === this.rows.length - 1 && this.rows.length - 1 >= this.top) this.rows[main.row] = emptyRow();
    this.top = main.top;
    this.moveTo(main.row, main.col);
    this.style = main.style;
  }
}

/** Where a string (OSC, DCS, …) from `start` ends — BEL, `ESC \` or ST: its text's end and its terminator's last character. */
function stringEnd(input: string, start: number): { at: number; last: number } | undefined {
  for (let j = start; j < input.length; j++) {
    const c = input.charCodeAt(j);
    if (c === 0x07 || c === 0x9c) return { at: j, last: j };
    if (c === 0x1b) {
      if (j + 1 >= input.length) return undefined;
      if (input.charCodeAt(j + 1) === 0x5c) return { at: j, last: j + 1 };
    }
  }
  return undefined;
}

// --- what the card says ----------------------------------------------------------------------------

/** How long, said the way the transcript says it: `0.8s`, `12s`, `2m 41s`. */
export function durationText(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A command's requests, as the policy's parser reads the line — none when it cannot be read. */
export function requestsOf(command: string, dialect: CommandDialect): ShellRequest[] {
  try {
    return takeApart(command, dialect).requests;
  } catch {
    return [];
  }
}

/**
 * The card's title: the command that does the work — the first that is not a change of directory —
 * as its program and subcommand (`npx vitest run …` reads `vitest run`, `git add -p` reads `git add`),
 * else the line's first word.
 */
export function terminalTitleOf(command: string, dialect: CommandDialect): string {
  const commands = requestsOf(command, dialect).flatMap((request) => (request.kind === "command" && request.opened === undefined ? [{ command: request.command, text: command.slice(request.span.start, request.span.end), viaRunner: RUN_BY.test(command.slice(0, request.span.start)) }] : []));
  const main = commands.find((one) => !DIRECTORY_CHANGERS.includes(one.command.program) && one.command.program !== "export") ?? commands[0];
  if (main !== undefined) return spelledAs(wordsOf(main.command, main.viaRunner), main.text);
  return command.trim().split(/\s+/)[0] ?? command;
}

/**
 * The title as the line spells it: PowerShell's parser lower-cases a program (`Write-Output` reads
 * `write-output`), and a title keeps the case it was typed in.
 */
function spelledAs(title: string, text: string): string {
  const at = text.toLowerCase().indexOf(title.toLowerCase());
  return at < 0 ? title : text.slice(at, at + title.length);
}

/**
 * Programs whose first word names what they do (`git add`, `npm run`, `vitest run`). The parser takes
 * every program's first plain argument for a subcommand (`echo done`, `read answer`); a title names it
 * only for these.
 */
const WITH_SUBCOMMANDS = new Set([
  "git", "gh", "glab", "npm", "pnpm", "yarn", "bun", "deno", "cargo", "go", "rustup", "docker", "podman", "kubectl", "helm",
  "brew", "apt", "apt-get", "dnf", "pip", "pip3", "poetry", "uv", "conda", "dotnet", "vitest", "jest", "terraform", "aws",
  "gcloud", "az", "systemctl", "launchctl", "mix", "gradle", "mvn", "make", "just", "nx", "turbo", "expo", "eas", "xcrun", "swift",
]);

/**
 * A package's program run through a runner (`npx one dev`, `pnpm dlx serve dist`): its first word names what it
 * does as a subcommand would, whatever the program — `one dev`, `serve dist`, `drizzle-kit studio`.
 */
const RUN_BY = /(?:^|[\s;&|(])(?:npx|pnpx|bunx|dlx|exec)\s+(?:(?:-y|--yes)\s+)?$/;

/** A command by its program, and its subcommand where the program has them (or a runner ran it) and it is a word. */
function wordsOf(command: { program: string; subcommand?: string | undefined }, viaRunner = false): string {
  const sub = command.subcommand;
  return sub !== undefined && (viaRunner || WITH_SUBCOMMANDS.has(command.program)) && /^[a-z][a-z0-9:_-]*$/i.test(sub) ? `${command.program} ${sub}` : command.program;
}

/** One request of the line, for the `Command` reading: its words, and what it asks for. */
export interface RequestRow {
  words: string;
  what: string;
  /** Inside another request (what a runner runs). */
  nested: boolean;
}

export function requestRowsOf(command: string, dialect: CommandDialect): RequestRow[] {
  const requests = requestsOf(command, dialect);
  return requests.map((request) => {
    const words = command.slice(request.span.start, request.span.end);
    const nested = requests.some((other) => other !== request && other.span.start <= request.span.start && other.span.end >= request.span.end && (other.span.end - other.span.start) > (request.span.end - request.span.start));
    if (request.kind === "command") {
      const c = request.command;
      const what = request.opened !== undefined ? `runs what follows` : `one ${wordsOf(c)}`;
      return { words, what, nested };
    }
    if (request.kind === "redirect") return { words, what: request.direction === "write" ? `write ${request.target}` : `read ${request.target}`, nested };
    if (request.kind === "code") return { words, what: `code: ${request.what}`, nested };
    if (request.kind === "env") return { words, what: `set_env ${request.name}`, nested };
    return { words, what: request.reason, nested };
  });
}

/**
 * Whether a running command waits for input (decision 0028, ruling 6) — the engine's call
 * (`TerminalSummary.waiting`): its output ends mid-line, a prompt, and has gone still. A guess, said as
 * one: a pipe cannot say who reads it.
 */
export function isWaiting(summary: TerminalSummary): boolean {
  return summary.endedAt === undefined && summary.waiting === true;
}

export type TerminalTone = "accent" | "warn" | "ok" | "bad" | "dim";

/** The card's status: what it is doing and for how long, in its tone. */
export function terminalStatusOf(summary: TerminalSummary, waiting: boolean, now: number): { text: string; tone: TerminalTone } {
  if (summary.endedAt === undefined) {
    const took = durationText(now - summary.startedAt);
    return waiting ? { text: `waiting for input · ${took}`, tone: "warn" } : { text: `running · ${took}`, tone: "accent" };
  }
  const took = durationText(summary.endedAt - summary.startedAt);
  if (summary.timedOut === true) return { text: `timed out · ${took}`, tone: "bad" };
  if (summary.stopped === true) return { text: `stopped · ${took}`, tone: "dim" };
  if (summary.exitCode === 0) return { text: `exit 0 · ${took}`, tone: "ok" };
  if (summary.exitCode === null || summary.exitCode === undefined) return { text: `ended${summary.signal ? ` by ${summary.signal}` : ""} · ${took}`, tone: "bad" };
  return { text: `exit ${summary.exitCode} · ${took}`, tone: "bad" };
}

/** While waiting under a time limit: when it ends, in words. */
export function endsInText(summary: TerminalSummary, now: number): string | undefined {
  if (summary.endedAt !== undefined || summary.endsAt === undefined) return undefined;
  return `ends in ${durationText(Math.max(0, summary.endsAt - now)).replace(/\.\ds$/, "s")} unless you answer`;
}

/** An answer a prompt offers, read off its last line: the key to type, what it means, what is sent. */
export interface PromptChoice {
  key: string;
  label: string;
  send: string;
}

const GIT_KEYS: Record<string, string> = {
  y: "yes",
  n: "no",
  q: "quit",
  a: "this and the rest",
  d: "none of the rest",
  s: "split it",
  e: "edit it",
  j: "leave, next undecided",
  J: "leave, next",
  k: "leave, previous undecided",
  K: "leave, previous",
  g: "go to…",
  "/": "search…",
  "?": "help",
  p: "print it again",
};

/**
 * The answers a prompt names on its last line (decision 0028, ruling 5): git's `[y,n,q,a,d,s,e,?]`,
 * and the usual `(y/N)`, `[Y/n]`, `(yes/no)`. None when the line names none.
 */
export function promptChoicesOf(line: string): PromptChoice[] {
  const trimmed = line.trimEnd();
  const git = /\[((?:[a-zA-Z?/],)+[a-zA-Z?/])\]\??$/.exec(trimmed);
  if (git !== null) {
    return git[1]!.split(",").map((key) => ({ key, label: GIT_KEYS[key] ?? key, send: `${key}\n` }));
  }
  const yesNo = /[([](y(?:es)?)\/(n(?:o)?)[)\]]\s*[:?]?$/i.exec(trimmed);
  if (yesNo !== null) {
    const [yes, no] = [yesNo[1]!, yesNo[2]!];
    const words = yes.length > 1;
    return [
      { key: words ? "yes" : "y", label: yes === yes.toUpperCase() && !words ? "yes (default)" : "yes", send: `${words ? "yes" : "y"}\n` },
      { key: words ? "no" : "n", label: no === no.toUpperCase() && !words ? "no (default)" : "no", send: `${words ? "no" : "n"}\n` },
    ];
  }
  return [];
}

/** How many of a command's last lines go to the agent with the person's next message. */
export const YOURS_LINES = 15;

/**
 * The person's own commands, as the note their next message carries to the agent (decision 0028, ruling
 * 8): each command, how it ended (or that it still runs), and its last lines. In the message itself,
 * so the person sees exactly what the agent is told.
 */
export function yourCommandsNote(commands: ReadonlyArray<{ summary: TerminalSummary; screen: TermScreen }>): string {
  if (commands.length === 0) return "";
  const parts = commands.map(({ summary, screen }) => {
    const how = summary.endedAt === undefined ? "still running" : terminalStatusOf(summary, false, summary.endedAt).text;
    const lines = screen
      .tail(YOURS_LINES)
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n")
      .trimEnd();
    return `\`${summary.command}\` — ${how}${lines.length > 0 ? `\n\`\`\`\n${lines}\n\`\`\`` : ""}`;
  });
  return `${commands.length === 1 ? "A command I ran" : "Commands I ran"} in the workspace:\n\n${parts.join("\n\n")}`;
}

/** A finished call's output from its result, for a terminal the engine no longer keeps. */
export function outputOfResult(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { stdout?: unknown; stderr?: unknown };
  const out = typeof r.stdout === "string" ? r.stdout : "";
  const err = typeof r.stderr === "string" ? r.stderr : "";
  if (out.length === 0 && err.length === 0) return typeof r.stdout === "string" ? "" : undefined;
  return out.length > 0 && err.length > 0 ? `${out}${out.endsWith("\n") ? "" : "\n"}${err}` : out + err;
}
