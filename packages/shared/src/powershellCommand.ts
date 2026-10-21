/**
 * PowerShell, taken apart (decision 0007 §4) — the `powershell` dialect of `shellCommand.ts`.
 *
 * A PowerShell line is read the way PowerShell reads it, not as a shell line with other quotes. A
 * statement is a command, an expression, an assignment or a keyword's (`if`, `foreach`, `try`, …). A
 * command's arguments are words, parameters (`-Path x`, `-Path:x`), arrays (`a, b`), and values that
 * run code where they are written: `$( … )`, `@( … )`, `( … )`, a script block `{ … }`, a hash
 * literal's values, an expandable string's `$( … )` and a here-string's. Every command found in any of
 * them is a request, with its span in the original line, and goes through the same embedders and
 * runners a POSIX line's do (`hooks.argv`).
 *
 * What is not a command but still acts:
 *  - an assignment to `$env:X` sets a variable for what runs after it, and one to `$function:x`,
 *    `$alias:x` or `$PSDefaultParameterValues` changes what the commands after it do: pieces nobody
 *    can vouch for;
 *  - a .NET call (`[IO.File]::WriteAllText(…)`, `(Get-Item x).Delete()`) or a property set on an object
 *    is code nobody can read off the line — a `code` request, the subject `script` — unless it is a
 *    call that changes nothing (`POWERSHELL_PURE_METHODS`, `POWERSHELL_PURE_STATICS`);
 *  - `function`, `filter`, `class` define what a name runs, and `using module` loads code.
 *
 * A line PowerShell itself would refuse to parse — an unterminated string, a missing brace, `<` — is
 * unparsed. PowerShell runs none of a script it cannot parse, and the policy asks rather than allows.
 *
 * Calibrated against PowerShell's own parser (`[System.Management.Automation.Language.Parser]`): a
 * word that starts with a quote ends with it (`"a"b` is two), `(` and `{` end a word (`foo(bar)` is
 * two), `>` inside a word is a character of it (`x>y`), a parameter's name ends at `.` (`-o.txt` is
 * `-o` and `.txt`), and `` ` `` before a newline inside a word is a newline of the word.
 */
import type { TextSpan } from "./commandParts";
import type { ShellRequest } from "./shellCommand";
import { POWERSHELL_PURE_METHODS, POWERSHELL_PURE_STATICS, isHarmlessVariable } from "./shellTables";
import type { ShellToken, ShellWalk } from "./shellWords";

export interface PowerShellHooks {
  /** One command's words, taken apart as any argv is: embedders opened, runners marked. */
  argv(words: ShellToken[], via: string[], depth: number): ShellWalk;
}

/** A line PowerShell would refuse to parse. */
class Syntax extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** PowerShell's quotes: the typewriter ones, and the typographic ones it reads as the same. */
const SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const DOUBLE_QUOTES = '"\u201c\u201d\u201e';
/** PowerShell's dashes: a parameter or an operator may be written with any of them. */
const DASHES = "-\u2013\u2014\u2015";

const isSingleQuote = (c: string | undefined): boolean => c !== undefined && c.length === 1 && SINGLE_QUOTES.includes(c);
const isDoubleQuote = (c: string | undefined): boolean => c !== undefined && c.length === 1 && DOUBLE_QUOTES.includes(c);
const isQuote = (c: string | undefined): boolean => isSingleQuote(c) || isDoubleQuote(c);
const isDash = (c: string | undefined): boolean => c !== undefined && c.length === 1 && DASHES.includes(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_]$/.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);
const isBlank = (c: string | undefined): boolean =>
  c !== undefined &&
  (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "\u00a0" || c === "\ufeff" || c === "\u1680" || (c >= "\u2000" && c <= "\u200a") || c === "\u202f" || c === "\u205f" || c === "\u3000");

/** What a backtick makes of the character after it. */
const ESCAPES: Readonly<Record<string, string>> = { "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** Words that begin a statement of their own, at the start of one. */
const KEYWORDS = new Set([
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "try", "catch", "finally", "trap", "function", "filter",
  "workflow", "configuration", "class", "enum", "param", "begin", "process", "end", "clean", "dynamicparam", "return", "throw", "exit",
  "break", "continue", "using", "data", "parallel", "sequence", "inlinescript", "hidden", "static", "define", "from", "var",
]);

/** A number, as PowerShell writes one: `0x1F`, `1.5e3`, `10kb`, `5L`. Never the first dot of `1..3`. */
const NUMBER = /^(0x[0-9a-f]+|0b[01]+|(\d+(\.(?!\.)\d*)?|\.\d+)(e[+-]?\d+)?)(ul|us|uy|u|l|d|y|s|n)?(kb|mb|gb|tb|pb)?/i;

const MAX_NESTING = 128;

/** What may stand before a variable's name: its scope, or a drive whose items are variables of a kind. */
const VARIABLE_DRIVES = new Set(["global", "script", "local", "private", "using", "workflow", "env", "variable", "function", "alias"]);

/** A string's text, with where each character was written. */
interface Piece {
  value: string;
  map: number[];
  dynamic: boolean;
}

/** `.Where({ … })` and `.ForEach({ … })` run the block, which is taken apart; handed a name, they call it. */
function pureMethod(name: string, text: string, open: number): boolean {
  const lower = name.toLowerCase();
  if (!POWERSHELL_PURE_METHODS.includes(lower)) return false;
  if (lower === "where" || lower === "foreach") return /^\(\s*\{/.test(text.slice(open));
  return true;
}

/** `[string]::Join`, `[IO.Path]::Combine`, `[List[int]]::new` — by the type's name, without `System.` or its type arguments. */
function pureStatic(type: string | undefined, name: string): boolean {
  if (type === undefined) return false;
  const key = type.toLowerCase().replace(/^system\./, "").replace(/\[.*$/s, "").trim();
  const members = Object.hasOwn(POWERSHELL_PURE_STATICS, key) ? POWERSHELL_PURE_STATICS[key] : undefined;
  return members !== undefined && (members === "*" || members.includes(name.toLowerCase()));
}

/** The comma-separated targets of an assignment (`$a, $b = 1, 2`), as offsets into `text`. */
function targetsOf(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const c = text[k];
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push([start, k]);
      start = k + 1;
    }
  }
  out.push([start, to]);
  return out.map(([a, b]) => {
    while (a < b && isBlank(text[a])) a++;
    while (b > a && (isBlank(text[b - 1]) || text[b - 1] === "\n")) b--;
    return [a, b];
  });
}

class Parser {
  i = 0;
  readonly requests: ShellRequest[] = [];
  unparsed: string | undefined;
  /** The regions the parser is inside, outermost first (`{…}`, `$(…)`): what each request was opened out of. */
  private readonly marks: string[] = [];

  constructor(
    private readonly text: string,
    private readonly map: readonly number[] | undefined,
    private readonly via: readonly string[],
    private readonly depth: number,
    private readonly hooks: PowerShellHooks,
  ) {}

  // --- where things are ----------------------------------------------------------------------

  /** The original-line offset of `text[k]`. */
  private at(k: number): number {
    const map = this.map;
    if (map === undefined) return k;
    return k < map.length ? map[k]! : (map[map.length - 1] ?? -1) + 1;
  }

  /** The original-line offset just past `text[k - 1]`. */
  private end(k: number): number {
    return k > 0 ? this.at(k - 1) + 1 : this.at(0);
  }

  private span(from: number, to: number): TextSpan {
    return { start: this.at(from), end: this.end(to) };
  }

  private viaNow(): string[] {
    return [...this.via, ...this.marks];
  }

  private withVia<T extends object>(request: T): T & { via?: string[] } {
    const via = this.viaNow();
    return via.length > 0 ? { ...request, via } : request;
  }

  /** A piece nobody can vouch for. `whole`: PowerShell syntax this does not model, which leaves the line unparsed. */
  private piece(from: number, to: number, reason: string, whole: boolean): void {
    this.requests.push(this.withVia({ kind: "unparsed" as const, span: this.span(from, to), reason }));
    if (whole) this.unparsed ??= reason;
  }

  /** Code the line runs that nobody can read off it — the subject `script`. */
  private code(from: number, to: number, what: string): void {
    this.requests.push(this.withVia({ kind: "code" as const, span: this.span(from, to), what }));
  }

  private merge(walk: ShellWalk): void {
    this.requests.push(...walk.requests);
    if (walk.unparsed !== undefined) this.unparsed ??= walk.unparsed;
  }

  // --- blanks --------------------------------------------------------------------------------

  /** Past blanks, line continuations and comments — never past a newline. */
  private blanks(): void {
    for (;;) {
      const c = this.text[this.i];
      if (isBlank(c)) {
        this.i++;
        continue;
      }
      if (c === "`" && (this.text[this.i + 1] === "\n" || (this.text[this.i + 1] === "\r" && this.text[this.i + 2] === "\n"))) {
        this.i += this.text[this.i + 1] === "\r" ? 3 : 2;
        continue;
      }
      if (c === "<" && this.text[this.i + 1] === "#") {
        const close = this.text.indexOf("#>", this.i + 2);
        if (close < 0) throw new Syntax("unterminated comment");
        this.i = close + 2;
        continue;
      }
      if (c === "#") {
        while (this.i < this.text.length && this.text[this.i] !== "\n") this.i++;
      }
      return;
    }
  }

  /** Past blanks and newlines. */
  private lines(): void {
    for (;;) {
      this.blanks();
      if (this.text[this.i] !== "\n") return;
      this.i++;
    }
  }

  private endsCommand(): boolean {
    const c = this.text[this.i];
    return c === undefined || c === "\n" || c === ";" || c === "|" || c === "&" || c === ")" || c === "}";
  }

  // --- statements ----------------------------------------------------------------------------

  /** Statements, to the end of the text or to `close`, which is left for the caller. */
  statements(close?: string): void {
    for (;;) {
      this.blanks();
      const c = this.text[this.i];
      if (c === undefined) {
        if (close !== undefined) throw new Syntax(`missing '${close}'`);
        return;
      }
      if (c === close) return;
      if (c === "\n" || c === ";") {
        this.i++;
        continue;
      }
      if (c === ")" || c === "}" || c === "]") throw new Syntax(`unexpected '${c}'`);
      const background = this.statement();
      this.blanks();
      const after = this.text[this.i];
      if (!background && after !== undefined && after !== "\n" && after !== ";" && after !== close) throw new Syntax(`unexpected '${after}'`);
    }
  }

  /**
   * One statement. True when what ended it also separates it from the next: a keyword's statement
   * (`if (…) { … } b` is two), or PowerShell 7's background `&`.
   */
  private statement(): boolean {
    this.blanks();
    // `:outer foreach (…)`: a loop's label.
    if (this.text[this.i] === ":" && /[A-Za-z_]/.test(this.text[this.i + 1] ?? "")) {
      this.i++;
      while (isWordChar(this.text[this.i])) this.i++;
      this.blanks();
    }
    this.attributes();
    const word = this.keyword();
    if (word !== undefined) {
      this.keywordStatement(word);
      return true;
    }
    return this.chain();
  }

  /** `[CmdletBinding()]` before a `param` block: read past, and left where they are when no `param` follows. */
  private attributes(): void {
    if (this.text[this.i] !== "[") return;
    const save = this.i;
    try {
      while (this.text[this.i] === "[") {
        this.typeLiteral();
        this.lines();
      }
      if (this.keyword() === "param") return;
    } catch (error) {
      if (!(error instanceof Syntax)) throw error;
    }
    this.i = save;
  }

  /** The keyword at `this.i`, if a statement's first word is one. */
  private keyword(): string | undefined {
    const m = /^[A-Za-z]+/.exec(this.text.slice(this.i, this.i + 16));
    if (m === null) return undefined;
    const word = m[0].toLowerCase();
    if (!KEYWORDS.has(word)) return undefined;
    const next = this.text[this.i + m[0].length];
    if (next !== undefined && !isBlank(next) && !"\n;({)}$#".includes(next)) return undefined;
    return word;
  }

  /** Pipelines joined by `&&` and `||` (PowerShell 7). True when PowerShell 7's background `&` ends it. */
  private chain(): boolean {
    this.pipeline();
    for (;;) {
      this.blanks();
      const two = this.text.slice(this.i, this.i + 2);
      if (two === "&&" || two === "||") {
        this.i += 2;
        this.lines();
        this.pipeline();
        continue;
      }
      if (this.text[this.i] === "&") {
        this.i++;
        return true;
      }
      return false;
    }
  }

  /** Elements joined by `|`, or an assignment — whose value is a statement of its own. */
  private pipeline(): void {
    this.blanks();
    const from = this.i;
    if (this.startsExpression()) {
      const assign = this.expression();
      if (assign !== undefined) {
        this.assignment(from, assign);
        return;
      }
    } else this.command();
    for (;;) {
      this.blanks();
      if (this.text[this.i] !== "|" || this.text[this.i + 1] === "|") return;
      this.i++;
      this.lines();
      if (!this.startsExpression()) this.command();
      else if (this.expression() !== undefined) throw new Syntax("an assignment cannot follow '|'");
    }
  }

  /** Whether the element at `this.i` is an expression (`$x`, `"…"`, `(…)`, `[T]::M()`, `5`, `-not …`) rather than a command. */
  private startsExpression(): boolean {
    const c = this.text[this.i];
    const n = this.text[this.i + 1];
    if (c === undefined) return false;
    if (c === "$" || c === "(" || c === "[" || c === "{" || c === "!" || c === "," || c === "+" || isQuote(c) || isDash(c)) return true;
    if (c === "@") return n === "(" || n === "{" || isQuote(n) || isWordChar(n);
    if (c === "." && /^\d$/.test(n ?? "")) return true;
    if (/^\d$/.test(c)) {
      // `7z x a.zip` is a program; `1..3`, `10kb`, `5 + 3` are numbers.
      const m = NUMBER.exec(this.text.slice(this.i));
      if (m === null) return false;
      const after = this.text[this.i + m[0].length];
      return after === undefined || !/[A-Za-z0-9_\\/:.]/.test(after) || this.text.startsWith("..", this.i + m[0].length);
    }
    return false;
  }

  // --- commands ------------------------------------------------------------------------------

  /** A command — after `&` (call) or `.` (dot-source), or by name — and its arguments and redirects. */
  private command(): void {
    const c = this.text[this.i];
    const n = this.text[this.i + 1];
    const lead = c === "&" && n !== "&" ? "&" : c === "." && (isBlank(n) || n === "{" || n === "$" || n === "(" || isQuote(n)) ? "." : undefined;
    if (lead !== undefined) {
      this.i++;
      this.blanks();
      if (this.endsCommand()) throw new Syntax(`a command is missing after '${lead}'`);
    }
    const words: ShellToken[] = [];
    // `& { … }`, `. { … }`: the block runs here — and was taken apart where it was written.
    let block = false;
    if (lead !== undefined && this.text[this.i] === "{") {
      this.region(1, "}", "{…}");
      block = true;
    } else words.push(this.generic());
    let element = false;
    for (;;) {
      this.blanks();
      if (this.endsCommand()) break;
      const ch = this.text[this.i];
      if (ch === ",") {
        this.i++;
        this.lines();
        element = true;
        continue;
      }
      if (this.redirect()) continue;
      if (ch === "<") throw new Syntax("the '<' operator is reserved for future use");
      if (this.text.startsWith("--%", this.i) && (this.text[this.i + 3] === undefined || isBlank(this.text[this.i + 3]) || this.text[this.i + 3] === "\n")) {
        words.push(...this.verbatim());
        continue;
      }
      const tokens = this.argument();
      if (element) {
        tokens[0] = { ...tokens[0]!, element: true };
        element = false;
      }
      words.push(...tokens);
    }
    if (element) throw new Syntax("a value is missing after ','");
    if (!block && words.length > 0) this.merge(this.hooks.argv(words, this.viaNow(), this.depth));
  }

  /** One argument: a parameter (`-Path`, `-Path:x` — two words), or a word. */
  private argument(): ShellToken[] {
    if (isDash(this.text[this.i]) && /[A-Za-z_?]/.test(this.text[this.i + 1] ?? "")) return this.parameter();
    return [this.generic()];
  }

  /** `-Name`, and `-Name:value` with its value marked `bound`. Any of PowerShell's dashes, written as `-`. */
  private parameter(): ShellToken[] {
    const from = this.i;
    let j = from + 1;
    while (j < this.text.length && !isBlank(this.text[j]) && !"\n;|&(){},:.".includes(this.text[j]!) && !isQuote(this.text[j])) j++;
    // A quote straight after the name (`-m"msg"`) makes the whole a plain word, as PowerShell reads it.
    if (isQuote(this.text[j])) return [this.generic()];
    const map = [this.at(from)];
    for (let k = from + 1; k < j; k++) map.push(this.at(k));
    const flag: ShellToken = { type: "word", value: `-${this.text.slice(from + 1, j)}`, start: this.at(from), end: this.end(j), map };
    this.i = j;
    if (this.text[j] !== ":") return [flag];
    this.i++;
    this.blanks();
    if (this.endsCommand() || this.text[this.i] === ",") throw new Syntax(`a value is missing after '${flag.value}:'`);
    return [flag, { ...this.generic(), bound: true }];
  }

  /** `--%`: the rest of the line, to a newline or a `|`, goes to the program as it is written. */
  private verbatim(): ShellToken[] {
    this.i += 3;
    const out: ShellToken[] = [];
    for (;;) {
      while (isBlank(this.text[this.i])) this.i++;
      const c = this.text[this.i];
      if (c === undefined || c === "\n" || c === "|") return out;
      const from = this.i;
      let value = "";
      const map: number[] = [];
      while (this.i < this.text.length && !isBlank(this.text[this.i]) && this.text[this.i] !== "\n" && this.text[this.i] !== "|") {
        if (this.text[this.i] !== '"') {
          value += this.text[this.i];
          map.push(this.at(this.i));
        }
        this.i++;
      }
      out.push({ type: "word", value, start: this.at(from), end: this.end(this.i), map, ...(/%[^%\s]+%/.test(value) ? { dynamic: true } : {}) });
    }
  }

  /** A redirect at `this.i`, as a request: `>`, `>>`, `2>`, `*>>`. `2>&1` joins two streams and names no place. */
  private redirect(): boolean {
    const m = /^([1-6*])?(>>?)(&[12])?/.exec(this.text.slice(this.i, this.i + 5));
    if (m === null) return false;
    const from = this.i;
    this.i += m[0].length;
    if (m[3] !== undefined) return true;
    const opEnd = this.i;
    this.blanks();
    if (this.endsCommand() || this.text[this.i] === ",") throw new Syntax("a redirect without a target");
    const target = this.generic();
    this.requests.push(
      this.withVia({
        kind: "redirect" as const,
        span: { start: this.at(from), end: target.end },
        op: this.text.slice(from, opEnd),
        opSpan: this.span(from, opEnd),
        direction: "write" as const,
        target: target.value,
        targetSpan: { start: target.start, end: target.end },
        ...(target.dynamic === true ? { dynamic: true } : {}),
      }),
    );
    return true;
  }

  /**
   * One word: a run of characters with quotes, escapes and expansions inside it — or a value that is
   * a word of its own: a string, a variable (with its members), `( … )`, `$( … )`, `@( … )`, `@{ … }`,
   * a script block, a splat.
   */
  private generic(): ShellToken {
    const from = this.i;
    let value = "";
    const map: number[] = [];
    let dynamic = false;
    let code = false;
    const keep = (a: number, b: number): void => {
      for (let k = a; k < b; k++) {
        value += this.text[k];
        map.push(this.at(k));
      }
    };
    const add = (piece: Piece): void => {
      value += piece.value;
      map.push(...piece.map);
      if (piece.dynamic) dynamic = true;
    };
    const token = (): ShellToken => ({
      type: "word",
      value,
      start: this.at(from),
      end: this.end(this.i),
      map,
      ...(dynamic ? { dynamic: true } : {}),
      ...(code ? { code: true } : {}),
    });

    const c = this.text[this.i];
    const n = this.text[this.i + 1];
    if (c === "{") {
      this.region(1, "}", "{…}");
      code = true;
      keep(from, this.i);
      return token();
    }
    if (c === "(" || (c === "@" && n === "(")) {
      this.region(c === "@" ? 2 : 1, ")", c === "@" ? "@(…)" : "(…)");
      this.postfix(from);
      dynamic = true;
      keep(from, this.i);
      return token();
    }
    if (c === "@" && n === "{") {
      this.hash();
      dynamic = true;
      keep(from, this.i);
      return token();
    }
    if (c === "@" && isWordChar(n)) {
      // `@params`: splatted — the arguments are decided as the line runs.
      this.i++;
      while (isWordChar(this.text[this.i])) this.i++;
      dynamic = true;
      keep(from, this.i);
      return token();
    }
    if (c === "@" && isQuote(n)) {
      const here = this.hereString();
      if (here !== undefined) {
        add(here);
        return token();
      }
    }
    // A word that starts with a quote ends with it: `"a"b` is two words.
    if (isQuote(c)) {
      add(this.quoted());
      return token();
    }
    if (c === "$" && this.dollar()) {
      this.postfix(from);
      dynamic = true;
      keep(from, this.i);
      return token();
    }
    for (;;) {
      const ch = this.text[this.i];
      if (ch === undefined || isBlank(ch) || "\n;|&(){},".includes(ch)) break;
      if (ch === "`") {
        const next = this.text[this.i + 1];
        // At the very end of the line PowerShell keeps it as it is.
        if (next === undefined) {
          keep(this.i, this.i + 1);
          this.i++;
          continue;
        }
        // `` ` `` before a newline inside a word is a newline of the word.
        const crlf = next === "\r" && this.text[this.i + 2] === "\n";
        value += crlf ? "\n" : (ESCAPES[next] ?? next);
        map.push(this.at(this.i));
        this.i += crlf ? 3 : 2;
        continue;
      }
      if (isQuote(ch)) {
        add(this.quoted());
        continue;
      }
      if (ch === "$") {
        const k = this.i;
        if (this.dollar()) {
          dynamic = true;
          keep(k, this.i);
          continue;
        }
      }
      keep(this.i, this.i + 1);
      this.i++;
    }
    if (this.i === from) throw new Syntax(`unexpected '${this.text[from] ?? "end of line"}'`);
    return token();
  }

  // --- values --------------------------------------------------------------------------------

  /** `$( … )` or a variable at `this.i`: past it, and true; false (and nowhere) for a `$` that is a character. */
  private dollar(): boolean {
    if (this.text[this.i + 1] === "(") {
      this.region(2, ")", "$(…)");
      return true;
    }
    return this.variable();
  }

  /**
   * `$name`, `$env:Path`, `${any name}`, `$?`, `$$`, `$^`. A name on a drive that is no scope's and no
   * variable's (`${C:\notes.txt}`, `$HKCU:Software`) is an item of that drive — read where it is
   * written, and written where it is assigned — which is code nobody reads as a file tool.
   */
  private variable(): boolean {
    const from = this.i;
    const n = this.text[this.i + 1];
    let name: string;
    if (n === "{") {
      let j = this.i + 2;
      while (j < this.text.length && this.text[j] !== "}") j += this.text[j] === "`" ? 2 : 1;
      if (j >= this.text.length) throw new Syntax("unterminated variable name");
      name = this.text.slice(this.i + 2, j);
      this.i = j + 1;
    } else if (n === "$" || n === "?" || n === "^") {
      this.i += 2;
      return true;
    } else {
      if (!isWordChar(n)) return false;
      let j = this.i + 1;
      while (isWordChar(this.text[j])) j++;
      if (this.text[j] === ":" && isWordChar(this.text[j + 1])) {
        j++;
        while (isWordChar(this.text[j])) j++;
      }
      name = this.text.slice(this.i + 1, j);
      this.i = j;
    }
    const drive = /^([^:]+):/.exec(name)?.[1]?.toLowerCase();
    if (drive !== undefined && !VARIABLE_DRIVES.has(drive)) this.code(from, this.i, `reaches the item ${name}`);
    return true;
  }

  /** What follows a value — `.Name`, `[i]`, `::Member` — where a call (`.Delete()`) is code unless it changes nothing. */
  private postfix(from: number, type?: string): void {
    let known = type;
    for (;;) {
      const c = this.text[this.i];
      if (c === "[") {
        this.region(1, "]", "[…]");
        known = undefined;
        continue;
      }
      const isStatic = c === ":" && this.text[this.i + 1] === ":";
      if (!isStatic && !(c === "." && this.text[this.i + 1] !== ".")) return;
      const dot = this.i;
      this.i += isStatic ? 2 : 1;
      let name: string | undefined;
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.i));
      if (word !== null) {
        name = word[0];
        this.i += word[0].length;
      } else if (isQuote(this.text[this.i])) {
        const quoted = this.quoted();
        name = quoted.dynamic ? undefined : quoted.value;
      } else if (this.text[this.i] === "$" && this.dollar()) {
        name = undefined;
      } else if (!isStatic) {
        // A `.` that names nothing is a character of the word (`$dir.`).
        this.i = dot;
        return;
      } else throw new Syntax("a member's name is missing after '::'");
      if (this.text[this.i] === "(") {
        const pure = name !== undefined && (isStatic ? pureStatic(known, name) : pureMethod(name, this.text, this.i));
        this.region(1, ")", "(…)");
        if (!pure) this.code(from, this.i, isStatic ? `calls [${known ?? "…"}]::${name ?? "…"}()` : `calls .${name ?? "…"}()`);
      }
      known = undefined;
    }
  }

  /**
   * One expression, to where it ends — or, when it meets an assignment operator at its own level,
   * that operator's place: the expression was the assignment's target.
   */
  private expression(): { from: number; to: number } | undefined {
    // Whether a value may come next (`[` is then a type) or an operator (`[` then indexes).
    let operand = true;
    for (;;) {
      this.blanks();
      const c = this.text[this.i];
      const n = this.text[this.i + 1];
      if (c === undefined || c === "\n" || c === ";" || c === ")" || c === "}" || c === "]" || c === "|" || c === "&") return undefined;
      const from = this.i;
      const assign = /^(=|\+=|-=|\*=|\/=|%=|\?\?=)/.exec(this.text.slice(this.i, this.i + 3));
      if (assign !== null) return { from: this.i, to: this.i + assign[0].length };
      if (this.redirect()) {
        operand = false;
        continue;
      }
      if (c === "<") throw new Syntax("the '<' operator is reserved for future use");
      if (c === "@" && isQuote(n)) {
        if (this.hereString() === undefined) throw new Syntax("a here-string's opening quote must end its line");
      } else if (isQuote(c)) this.quoted();
      else if (c === "@" && n === "(") this.region(2, ")", "@(…)");
      else if (c === "@" && n === "{") this.hash();
      else if (c === "$") {
        if (!this.dollar()) throw new Syntax("unexpected '$'");
      } else if (c === "(") this.region(1, ")", "(…)");
      else if (c === "{") this.region(1, "}", "{…}");
      else if (c === "[") {
        if (!operand) {
          this.region(1, "]", "[…]");
          continue;
        }
        const type = this.typeLiteral();
        // `[IO.File]::X`: a static member. Otherwise a cast, and a value comes next (`[int]$x`).
        if (this.text.startsWith("::", this.i)) {
          this.postfix(from, type);
          operand = false;
        }
        continue;
      } else if (/^\d$/.test(c) || (c === "." && /^\d$/.test(n ?? ""))) {
        this.i += NUMBER.exec(this.text.slice(this.i))![0].length;
      } else if (isDash(c) && isLetter(n)) {
        // An operator: `-eq`, `-replace`, `-f`, `-not`, `-join`.
        this.i++;
        while (isLetter(this.text[this.i])) this.i++;
        operand = true;
        continue;
      } else if (c === "." && n === ".") {
        this.i += 2;
        operand = true;
        continue;
      } else if (c === "," || c === "!" || c === "+" || c === "*" || c === "/" || c === "%" || c === "?" || c === ":" || isDash(c)) {
        this.i++;
        operand = true;
        continue;
      } else if (c === "." && !operand) {
        this.postfix(from);
        if (this.i === from) throw new Syntax("unexpected '.'");
        continue;
      } else {
        // A word where a value or an operator belongs (`$x Get-Item`) is an error PowerShell reports.
        throw new Syntax(`unexpected '${c}' in an expression`);
      }
      this.postfix(from);
      operand = false;
    }
  }

  /** `[T]` at `this.i`: past it, and the type's name. An attribute's arguments are read past too. */
  private typeLiteral(): string {
    const from = this.i;
    let depth = 0;
    while (this.i < this.text.length) {
      const c = this.text[this.i]!;
      if (isQuote(c)) {
        this.quoted();
        continue;
      }
      if (c === "{") throw new Syntax("a script block inside an attribute is not modelled");
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          this.i++;
          return this.text.slice(from + 1, this.i - 1).trim();
        }
      }
      this.i++;
    }
    throw new Syntax("missing ']'");
  }

  /** `@{ key = value; … }`: each value is a statement, and runs where it is written. */
  private hash(): void {
    if (this.marks.length >= MAX_NESTING) throw new Syntax("nested too deeply to follow");
    this.i += 2;
    this.marks.push("@{…}");
    for (;;) {
      this.blanks();
      const c = this.text[this.i];
      if (c === undefined) throw new Syntax("missing '}'");
      if (c === "}") {
        this.i++;
        break;
      }
      if (c === "\n" || c === ";") {
        this.i++;
        continue;
      }
      if (isQuote(c)) this.quoted();
      else if (c === "$" || c === "(") this.expression();
      else {
        const key = /^[^\s=;}]+/.exec(this.text.slice(this.i));
        if (key === null) throw new Syntax("missing a key in a hash literal");
        this.i += key[0].length;
      }
      this.blanks();
      if (this.text[this.i] !== "=") throw new Syntax("missing '=' after a key in a hash literal");
      this.i++;
      this.lines();
      this.statement();
    }
    this.marks.pop();
  }

  /** A region: `open` characters at `this.i`, statements, then `close`. */
  private region(open: number, close: string, mark: string): void {
    if (this.marks.length >= MAX_NESTING) throw new Syntax("nested too deeply to follow");
    this.i += open;
    this.marks.push(mark);
    this.statements(close);
    this.marks.pop();
    if (this.text[this.i] !== close) throw new Syntax(`missing '${close}'`);
    this.i++;
  }

  // --- strings -------------------------------------------------------------------------------

  private quoted(): Piece {
    return isSingleQuote(this.text[this.i]) ? this.single() : this.double();
  }

  /** `'…'`: verbatim, `''` a quote. */
  private single(): Piece {
    const piece: Piece = { value: "", map: [], dynamic: false };
    let j = this.i + 1;
    for (;;) {
      const c = this.text[j];
      if (c === undefined) throw new Syntax("unterminated string");
      if (isSingleQuote(c)) {
        if (!isSingleQuote(this.text[j + 1])) break;
        piece.value += "'";
        piece.map.push(this.at(j));
        j += 2;
        continue;
      }
      piece.value += c;
      piece.map.push(this.at(j));
      j++;
    }
    this.i = j + 1;
    return piece;
  }

  /** `"…"`: `""` a quote, backtick escapes, and `$x` and `$( … )` expanded — the latter run where they are written. */
  private double(): Piece {
    const piece: Piece = { value: "", map: [], dynamic: false };
    let j = this.i + 1;
    for (;;) {
      const c = this.text[j];
      if (c === undefined) throw new Syntax("unterminated string");
      if (isDoubleQuote(c)) {
        if (!isDoubleQuote(this.text[j + 1])) break;
        piece.value += '"';
        piece.map.push(this.at(j));
        j += 2;
        continue;
      }
      j = this.expandable(piece, j);
    }
    this.i = j + 1;
    return piece;
  }

  /** One character of an expandable string's body at `j`: an escape, an expansion, or itself. Returns where the next begins. */
  private expandable(piece: Piece, j: number): number {
    const c = this.text[j]!;
    if (c === "`") {
      const n = this.text[j + 1];
      if (n === undefined) throw new Syntax("unterminated string");
      piece.value += ESCAPES[n] ?? n;
      piece.map.push(this.at(j));
      return j + 2;
    }
    if (c === "$") {
      const saved = this.i;
      this.i = j;
      if (this.dollar()) {
        const to = this.i;
        this.i = saved;
        for (let k = j; k < to; k++) {
          piece.value += this.text[k];
          piece.map.push(this.at(k));
        }
        piece.dynamic = true;
        return to;
      }
      this.i = saved;
    }
    piece.value += c;
    piece.map.push(this.at(j));
    return j + 1;
  }

  /**
   * `@"` … `"@` and `@'` … `'@` at `this.i`: the opening quote ends its line, and the body ends at a
   * line that begins with the closing one. `undefined` (and nowhere) when the opening is no here-string's.
   */
  private hereString(): Piece | undefined {
    const single = isSingleQuote(this.text[this.i + 1]);
    let k = this.i + 2;
    while (isBlank(this.text[k])) k++;
    if (this.text[k] !== "\n") return undefined;
    let end = -1;
    for (let e = k; e >= 0 && e < this.text.length; e = this.text.indexOf("\n", e + 1)) {
      const q = this.text[e + 1];
      if ((single ? isSingleQuote(q) : isDoubleQuote(q)) && this.text[e + 2] === "@") {
        end = e;
        break;
      }
    }
    if (end < 0) throw new Syntax("unterminated here-string");
    const piece: Piece = { value: "", map: [], dynamic: false };
    const stop = end > k + 1 && this.text[end - 1] === "\r" ? end - 1 : end;
    for (let j = k + 1; j < stop; ) {
      if (single) {
        piece.value += this.text[j];
        piece.map.push(this.at(j));
        j++;
      } else j = this.expandable(piece, j);
    }
    this.i = end + 3;
    return piece;
  }

  // --- assignments ---------------------------------------------------------------------------

  /** `target = statement`: the target judged, then the statement taken apart. */
  private assignment(from: number, op: { from: number; to: number }): void {
    for (const [a, b] of targetsOf(this.text, from, op.from)) this.target(a, b);
    this.i = op.to;
    this.lines();
    this.statement();
  }

  /**
   * One target of an assignment: a variable of the line's own is nothing to anybody else; one that
   * reaches past the line is a piece of its own.
   */
  private target(from: number, to: number): void {
    const written = this.text.slice(from, to);
    // Casts first: `[int]$x`, `[string[]]$names`.
    const bare = written.replace(/^(\s*\[[^\]]*(\[[^\]]*\][^\]]*)*\]\s*)+/, "");
    const variable = /^\$(?:\{([^}]*)\}|([A-Za-z0-9_?]+(?::[A-Za-z0-9_?]+)?))/.exec(bare);
    if (variable === null) {
      // `[Environment]::CurrentDirectory = …`, `(Get-Item x).IsReadOnly = …`: a property of something past the line.
      if (/::|\./.test(bare)) this.code(from, to, `sets ${written.trim()}`);
      return;
    }
    const name = variable[1] ?? variable[2]!;
    const rest = bare.slice(variable[0].length).trim();
    const colon = name.indexOf(":");
    const drive = colon > 0 ? name.slice(0, colon).toLowerCase() : undefined;
    const own = colon > 0 ? name.slice(colon + 1) : name;
    if (drive === "env") {
      if (!isHarmlessVariable(`$env:${own}`)) this.piece(from, to, `sets ${own} for what runs after it`, false);
    } else if (drive === "function" || drive === "alias") this.piece(from, to, `defines what '${own}' runs`, false);
    else if (own.toLowerCase() === "psdefaultparametervalues" && (drive === undefined || ["global", "script", "local", "private"].includes(drive))) {
      this.piece(from, to, "changes the parameters every command after it is given", false);
    } else if (rest.startsWith(".")) this.code(from, to, `sets ${written.trim()}`);
  }

  // --- keyword statements --------------------------------------------------------------------

  private condition(): void {
    this.lines();
    if (this.text[this.i] !== "(") throw new Syntax("missing '('");
    this.region(1, ")", "(…)");
  }

  private body(): void {
    this.lines();
    if (this.text[this.i] !== "{") throw new Syntax("missing '{'");
    this.region(1, "}", "{…}");
  }

  private endsStatement(): boolean {
    const c = this.text[this.i];
    return c === undefined || c === "\n" || c === ";" || c === ")" || c === "}" || c === "|" || c === "&";
  }

  /** A `{ … }` read past and not taken apart — a class's, whose methods run only when called by a .NET call. */
  private skipBraces(): void {
    let depth = 0;
    while (this.i < this.text.length) {
      const c = this.text[this.i]!;
      if (isQuote(c)) {
        this.quoted();
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        this.i++;
        return;
      }
      this.i++;
    }
    throw new Syntax("missing '}'");
  }

  private keywordStatement(word: string): void {
    const from = this.i;
    this.i += word.length;
    switch (word) {
      case "if": {
        this.condition();
        this.body();
        for (;;) {
          const save = this.i;
          this.lines();
          const next = this.keyword();
          if (next === "elseif") {
            this.i += next.length;
            this.condition();
            this.body();
          } else if (next === "else") {
            this.i += next.length;
            this.body();
            return;
          } else {
            this.i = save;
            return;
          }
        }
      }
      case "while":
      case "for":
        this.condition();
        this.body();
        return;
      case "foreach":
        this.foreach();
        return;
      case "do": {
        this.body();
        this.lines();
        const next = this.keyword();
        if (next !== "while" && next !== "until") throw new Syntax("'do' is missing its 'while' or 'until'");
        this.i += next.length;
        this.condition();
        return;
      }
      case "switch":
        this.switchStatement();
        return;
      case "try": {
        this.body();
        for (;;) {
          const save = this.i;
          this.lines();
          const next = this.keyword();
          if (next === "catch") {
            this.i += next.length;
            this.blanks();
            while (this.text[this.i] === "[") {
              this.typeLiteral();
              this.blanks();
              if (this.text[this.i] === ",") {
                this.i++;
                this.lines();
              }
            }
            this.body();
          } else if (next === "finally") {
            this.i += next.length;
            this.body();
            return;
          } else {
            this.i = save;
            return;
          }
        }
      }
      case "trap":
        this.blanks();
        if (this.text[this.i] === "[") this.typeLiteral();
        this.body();
        return;
      case "function":
      case "filter":
      case "workflow":
      case "configuration": {
        // It defines what a name runs for the rest of the line; the body is taken apart all the same.
        this.blanks();
        this.i += /^[^\s({]*/.exec(this.text.slice(this.i))![0].length;
        this.blanks();
        if (this.text[this.i] === "(") this.region(1, ")", "(…)");
        this.body();
        this.piece(from, this.i, `'${word}' is not modelled`, true);
        return;
      }
      case "class":
      case "enum": {
        while (!this.endsStatement() && this.text[this.i] !== "{") this.i++;
        this.lines();
        if (this.text[this.i] !== "{") throw new Syntax(`'${word}' is missing its '{'`);
        this.skipBraces();
        this.piece(from, this.i, `'${word}' is not modelled`, true);
        return;
      }
      case "param":
        this.blanks();
        if (this.text[this.i] !== "(") throw new Syntax("'param' is missing its '('");
        this.region(1, ")", "(…)");
        return;
      case "begin":
      case "process":
      case "end":
      case "clean":
      case "dynamicparam":
        this.body();
        return;
      case "return":
      case "throw":
      case "exit":
        this.blanks();
        if (!this.endsStatement()) this.chain();
        return;
      case "break":
      case "continue":
        this.blanks();
        if (!this.endsStatement()) this.generic();
        return;
      case "using": {
        this.blanks();
        const kind = (/^[A-Za-z]+/.exec(this.text.slice(this.i))?.[0] ?? "").toLowerCase();
        this.i += kind.length;
        const start = this.i;
        for (;;) {
          this.blanks();
          if (this.endsStatement()) break;
          if (this.text[this.i] === ",") this.i++;
          else this.generic();
        }
        if (kind === "module" || kind === "assembly") this.piece(from, this.i, `loads code from ${this.text.slice(start, this.i).trim()}`, false);
        return;
      }
      case "data":
        // `data -SupportedCommand a, b { … }`
        for (;;) {
          this.blanks();
          if (this.endsStatement() || this.text[this.i] === "{") break;
          if (this.text[this.i] === ",") this.i++;
          else this.generic();
        }
        this.body();
        return;
      case "parallel":
      case "sequence":
      case "inlinescript":
        this.body();
        this.piece(from, this.i, `'${word}' belongs to a workflow, which is not modelled`, true);
        return;
      default:
        throw new Syntax(`unexpected '${word}'`);
    }
  }

  /** `foreach ($x in …) { … }` — PowerShell 7's `-Parallel` and `-ThrottleLimit n` read past. */
  private foreach(): void {
    for (;;) {
      this.blanks();
      if (this.text[this.i] === "(" || this.endsStatement()) break;
      this.generic();
    }
    this.lines();
    if (this.text[this.i] !== "(") throw new Syntax("'foreach' is missing its '('");
    if (this.marks.length >= MAX_NESTING) throw new Syntax("nested too deeply to follow");
    this.i++;
    this.marks.push("(…)");
    this.lines();
    if (this.text[this.i] !== "$" || !this.variable()) throw new Syntax("'foreach' is missing its variable");
    this.lines();
    if (!/^in(?![A-Za-z0-9_-])/i.test(this.text.slice(this.i))) throw new Syntax("'foreach' is missing its 'in'");
    this.i += 2;
    this.statements(")");
    this.marks.pop();
    if (this.text[this.i] !== ")") throw new Syntax("missing ')'");
    this.i++;
    this.body();
  }

  /** `switch [-File path] (…) { condition { … } … }`. `-File` reads the file it names. */
  private switchStatement(): void {
    for (;;) {
      this.blanks();
      if (!isDash(this.text[this.i]) || !isLetter(this.text[this.i + 1])) break;
      const flagFrom = this.i;
      const [flag] = this.parameter();
      if (/^-f/i.test(flag!.value)) {
        this.blanks();
        const target = this.generic();
        this.requests.push(
          this.withVia({
            kind: "redirect" as const,
            span: { start: this.at(flagFrom), end: target.end },
            op: flag!.value,
            opSpan: { start: flag!.start, end: flag!.end },
            direction: "read" as const,
            target: target.value,
            targetSpan: { start: target.start, end: target.end },
            ...(target.dynamic === true ? { dynamic: true } : {}),
          }),
        );
      }
    }
    this.blanks();
    if (this.text[this.i] === "(") this.region(1, ")", "(…)");
    this.lines();
    if (this.text[this.i] !== "{") throw new Syntax("'switch' is missing its '{'");
    if (this.marks.length >= MAX_NESTING) throw new Syntax("nested too deeply to follow");
    this.i++;
    this.marks.push("{…}");
    for (;;) {
      this.lines();
      const c = this.text[this.i];
      if (c === undefined) throw new Syntax("missing '}'");
      if (c === "}") {
        this.i++;
        break;
      }
      if (c === ";") {
        this.i++;
        continue;
      }
      // A clause's condition is a value or a script block — never a command.
      const from = this.i;
      if (c === "{") this.region(1, "}", "{…}");
      else if (c === "(") this.region(1, ")", "(…)");
      else if (isQuote(c)) this.quoted();
      else if (c === "$") {
        if (!this.dollar()) throw new Syntax("unexpected '$'");
        this.postfix(from);
      } else this.generic();
      this.lines();
      if (this.text[this.i] !== "{") throw new Syntax("a 'switch' clause is missing its '{'");
      this.region(1, "}", "{…}");
    }
    this.marks.pop();
  }
}

/**
 * Take one PowerShell text apart — a line, or the inside of `powershell -Command "…"` — with `map`
 * giving each character's offset in the original line. See the module header.
 */
export function walkPowerShell(text: string, map: readonly number[] | undefined, via: string[], depth: number, hooks: PowerShellHooks): ShellWalk {
  const parser = new Parser(text, map, via, depth, hooks);
  try {
    parser.statements();
  } catch (error) {
    // Taking a line apart never throws (`takeApart`): whatever stopped the parser — PowerShell syntax
    // it would refuse, or a line too deep for the stack — leaves the line unread, which asks.
    const reason = error instanceof Syntax ? error.reason : "the line could not be read";
    // At the top the LINE is unparsed and holds nothing: PowerShell runs none of a script it cannot
    // parse. Inside a payload the piece is, and the rest of the line is still judged.
    if (depth === 0) return { requests: [], unparsed: reason };
    const first = map === undefined ? 0 : (map[0] ?? 0);
    const last = map === undefined ? text.length : (map[map.length - 1] ?? first - 1) + 1;
    return { requests: [{ kind: "unparsed", span: { start: first, end: last }, reason, ...(via.length > 0 ? { via } : {}) }], unparsed: reason };
  }
  return { requests: parser.requests, ...(parser.unparsed !== undefined ? { unparsed: parser.unparsed } : {}) };
}
