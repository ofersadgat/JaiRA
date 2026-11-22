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
  if (n < 16) return TERM_COLOURS[n]!;
  if (n < 232) return cube(n - 16);
  const grey = (8 + (n - 232) * 10).toString(16).padStart(2, "0");
  return `#${grey}${grey}${grey}`;
}

/** One SGR sequence's parameters applied to a style: a new object when anything changed. */
export function applySgr(style: TermStyle, params: number[]): TermStyle {
  let next: TermStyle = { ...style };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p === 0) next = style.you === true ? { you: true } : {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p >= 30 && p <= 37) next.fg = TERM_COLOURS[p - 30]!;
    else if (p >= 90 && p <= 97) next.fg = TERM_COLOURS[p - 90 + 8]!;
    else if (p >= 40 && p <= 47) next.bg = TERM_COLOURS[p - 40]!;
    else if (p >= 100 && p <= 107) next.bg = TERM_COLOURS[p - 100 + 8]!;
    else if (p === 39) delete next.fg;
    else if (p === 49) delete next.bg;
    else if ((p === 38 || p === 48) && list[i + 1] === 5 && list[i + 2] !== undefined) {
      const colour = colour256(list[i + 2]!);
      if (p === 38) next.fg = colour;
      else next.bg = colour;
      i += 2;
    } else if ((p === 38 || p === 48) && list[i + 1] === 2 && list[i + 4] !== undefined) {
      const colour = `#${[list[i + 2]!, list[i + 3]!, list[i + 4]!].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
      if (p === 38) next.fg = colour;
      else next.bg = colour;
      i += 4;
    }
  }
  return next;
}

interface Cells {
  chars: string[];
  styles: TermStyle[];
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

/**
 * A terminal's screen, fed its raw output a piece at a time: lines of styled spans, as a terminal
 * would be left showing them. Carriage returns overwrite (a progress bar is its last state), a
 * backspace steps back, `ESC[K` clears to the end of the line, SGR sets colours, and every other
 * escape — cursor movement, titles, the alternate screen — is dropped. The person's typing, set
 * between `YOU_OPEN` and `YOU_CLOSE` by the engine, is marked `you`.
 */
export class TermScreen {
  private readonly done: TermLine[] = [];
  private cells: Cells = { chars: [], styles: [] };
  private cursor = 0;
  private style: TermStyle = PLAIN;
  /** An escape cut off at the end of a piece, finished by the next one. */
  private carry = "";
  /** A carriage return at the end of a piece: a newline if the next starts with `\n`. */
  private pendingReturn = false;

  write(text: string): void {
    const input = this.carry + text;
    this.carry = "";
    let i = 0;
    if (this.pendingReturn) {
      this.pendingReturn = false;
      if (input.startsWith("\n")) {
        this.newline();
        i = 1;
      } else this.cursor = 0;
    }
    for (; i < input.length; i++) {
      const ch = input[i]!;
      if (ch === "\u001b") {
        const end = this.escape(input, i);
        if (end === undefined) {
          this.carry = input.slice(i);
          return;
        }
        i = end;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        continue;
      }
      if (ch === "\r") {
        if (i + 1 >= input.length) {
          this.pendingReturn = true;
          continue;
        }
        if (input[i + 1] === "\n") {
          this.newline();
          i++;
        } else this.cursor = 0;
        continue;
      }
      if (ch === "\b") {
        this.cursor = Math.max(0, this.cursor - 1);
        continue;
      }
      if (ch === "\t") {
        const to = (Math.floor(this.cursor / TAB) + 1) * TAB;
        while (this.cursor < to) this.put(" ");
        continue;
      }
      if (ch < " " || ch === "\u007f") continue;
      this.put(ch);
    }
  }

  /** Every line, the one still being written last (empty when the output ended with a newline). */
  lines(): TermLine[] {
    return [...this.done, spansOf(this.cells)];
  }

  /** How many lines there are, the one being written included. */
  get count(): number {
    return this.done.length + 1;
  }

  /** The last `n` lines, the one being written included unless it is empty. */
  tail(n: number): TermLine[] {
    const current = spansOf(this.cells);
    const all = current.length > 0 ? [...this.done.slice(-(n - 1)), current] : this.done.slice(-n);
    return all;
  }

  /** The line still being written, as text: a prompt that waits for an answer ends without a newline. */
  partial(): string {
    return this.cells.chars.join("");
  }

  /** The last line that has text, as text — a finished command's last word. */
  lastText(): string {
    const partial = this.partial();
    if (partial.trim().length > 0) return partial;
    for (let i = this.done.length - 1; i >= 0; i--) {
      const text = this.done[i]!.map((span) => span.text).join("");
      if (text.trim().length > 0) return text;
    }
    return "";
  }

  /** The whole screen as plain text: the `Text` reading, and what Copy takes. */
  plain(): string {
    return this.lines()
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n")
      .replace(/\n+$/, "\n");
  }

  private put(ch: string): void {
    // A cursor moved past the end (`ESC[G`) leaves no holes.
    while (this.cells.chars.length < this.cursor) {
      this.cells.chars.push(" ");
      this.cells.styles.push(PLAIN);
    }
    this.cells.chars[this.cursor] = ch;
    this.cells.styles[this.cursor] = this.style;
    this.cursor++;
  }

  private newline(): void {
    this.done.push(spansOf(this.cells));
    this.cells = { chars: [], styles: [] };
    this.cursor = 0;
  }

  /** An escape at `at`: handled, and the index of its last character — or undefined when it is cut off. */
  private escape(input: string, at: number): number | undefined {
    const next = input[at + 1];
    if (next === undefined) return undefined;
    if (next === "[") {
      let j = at + 2;
      while (j < input.length && !/[@-~]/.test(input[j]!)) j++;
      if (j >= input.length) return undefined;
      const final = input[j]!;
      const body = input.slice(at + 2, j);
      if (final === "m") {
        const params = body.length === 0 ? [] : body.split(/[;:]/).map((p) => (p === "" ? 0 : Number.parseInt(p, 10))).filter((p) => !Number.isNaN(p));
        this.style = applySgr(this.style, params);
      } else if (final === "K") {
        const mode = body === "" ? 0 : Number.parseInt(body, 10);
        if (mode === 0) {
          this.cells.chars.length = Math.min(this.cells.chars.length, this.cursor);
          this.cells.styles.length = this.cells.chars.length;
        } else if (mode === 2) this.cells = { chars: [], styles: [] };
      } else if (final === "G") {
        this.cursor = Math.max(0, (Number.parseInt(body, 10) || 1) - 1);
      }
      return j;
    }
    if (next === "]") {
      // OSC: to BEL, or to ESC \.
      let j = at + 2;
      while (j < input.length && input[j] !== "\u0007" && !(input[j] === "\u001b" && input[j + 1] === "\\")) j++;
      if (j >= input.length) return undefined;
      const body = input.slice(at + 2, j);
      const end = input[j] === "\u0007" ? j : j + 1;
      if (`\u001b]${body}\u0007` === YOU_OPEN) this.style = { ...this.style, you: true };
      else if (`\u001b]${body}\u0007` === YOU_CLOSE) {
        const { you: _you, ...rest } = this.style;
        this.style = rest;
      }
      return end;
    }
    // A two-character escape (`ESC (B`, `ESC =`): dropped.
    if (next === "(" || next === ")") return input[at + 2] === undefined ? undefined : at + 2;
    return at + 1;
  }
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
