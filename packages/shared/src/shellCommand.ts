/**
 * Command parsing for policy decisions (DESIGN §10.1, decision 0007 §4).
 *
 * Policy matches on a *parsed intent*, never a regex over the raw string: that is
 * what makes `git -c x reset --hard` and `git reset --hard` the same decision
 * instead of two spellings to enumerate (SPEC §11.2). This module takes a command
 * line APART into the requests it is made of — plural, because one line carries
 * several (`a && b`, `a > out`, `a $(b)`), and an embedder (`sh -c "…"`, `env X=1 …`,
 * `find … -exec …`) hides the command that actually matters.
 *
 *  - {@link takeApart} is the whole answer: every command, every redirect, and every
 *    piece it could not model, each with its SPAN in the original line — which is what
 *    lets an approval tint the line in the colours of its parts.
 *  - {@link parseCommand} is the same walk reported as commands only, the shape the
 *    rules and the built-ins have always matched on.
 *
 * What opens what is DATA ({@link EMBEDDERS} in `shellTables.ts`). An embedder the
 * table does not know is a command like any other; what it hides is not seen.
 *
 * Three dialects (DESIGN §16): POSIX shell for WSL and bash; PowerShell, which
 * `powershellCommand.ts` parses as PowerShell does — script blocks, subexpressions,
 * here-strings, parameters, aliases, assignments and .NET calls; and cmd's, for what
 * `cmd /c` runs. A construct none of them models comes back unparsed, and the policy
 * treats that as "ask", never as "allow".
 */
import { isCommandRunner } from "./commandRunners";
import type { TextSpan } from "./commandParts";
import { walkPowerShell } from "./powershellCommand";
import { EMBEDDERS, POWERSHELL_ALIASES, isHarmlessVariable, isShellLocalName, type EmbedderSpec } from "./shellTables";
import type { ShellToken as Token, ShellWalk as Walk } from "./shellWords";

/**
 * The language a line is written in: POSIX shell, PowerShell, or cmd's (what `cmd /c` runs). A line a
 * project runs is POSIX or PowerShell (`dialectFor`); cmd is met inside one.
 */
export type CommandDialect = "posix" | "powershell" | "cmd";

/**
 * The shell an agent's OWN shell tool runs its line in, by the name the agent calls the tool. Claude
 * Code's `Bash` is Git Bash on Windows as everywhere else, and its `PowerShell` is PowerShell — so the
 * line is read in the tool's language, not the project's. Every other shell tool (JaiRA's `shell`,
 * codex's `shell`) runs where the project runs: `undefined` here, and `dialectFor` decides.
 */
const NATIVE_SHELL_DIALECTS: Readonly<Record<string, CommandDialect>> = { Bash: "posix", PowerShell: "powershell" };

export function nativeShellDialect(tool: string): CommandDialect | undefined {
  return Object.hasOwn(NATIVE_SHELL_DIALECTS, tool) ? NATIVE_SHELL_DIALECTS[tool] : undefined;
}

/** One word of a command, with where it was written. */
export interface CommandWord {
  value: string;
  /** In the ORIGINAL line, quotes included. */
  span: TextSpan;
  /** True when the shell decides its value at run time (`$X`, `$(…)`, a backtick). */
  dynamic?: boolean;
  /** A PowerShell script block (`{ … }`) — taken apart where it was written, as code of the line's own. */
  code?: boolean;
  /** A PowerShell array element after the first (`Remove-Item a, b`): the same argument as the word before it. */
  element?: boolean;
  /** The value a PowerShell parameter was given with a colon (`-Path:x`): its parameter's, never positional. */
  bound?: boolean;
}

export interface ParsedCommand {
  /**
   * Executable name, lowercased and stripped of any path and `.exe` — and in PowerShell, an alias read
   * as the cmdlet it runs (`rm` → `remove-item`).
   */
  program: string;
  /** The name the line called it by, when that was a PowerShell alias of {@link program} (`rm`, `gci`, `%`). */
  alias?: string;
  /** First non-flag argument, when the program takes subcommands (`git push` → `push`). */
  subcommand?: string;
  /** Flags in order, long and short, without values (`--hard`, `-C`, `-rf`). */
  flags: string[];
  /**
   * The flags written before the subcommand — the program's own options, as against the
   * subcommand's (`git -c k=v grep -c x`: `-c` is git's, the second `-c` is grep's count).
   */
  leadingFlags?: string[];
  /** Non-flag arguments, excluding the subcommand. */
  args: string[];
  /** Every token as parsed, for auditing and messages. */
  tokens: string[];
  /**
   * The wrapper this command was extracted from, when it was nested — `sh -c`,
   * `env`, `sudo`, `npx`. Policy can then reason about the real program while an
   * audit trail still shows how it was invoked.
   */
  via?: string[];
  /** The whole command in the original line, leading assignments included. */
  span?: TextSpan;
  /** {@link tokens} with their spans, one for one. */
  words?: CommandWord[];
  /** Index into {@link tokens} of the program word (after any `VAR=value`). */
  programIndex?: number;
  /**
   * The variables set for this command, by name: its own leading `VAR=value` words and those of an
   * embedder it was opened from (`env GIT_EXTERNAL_DIFF=x git diff`). A variable can change what a
   * program runs, so a part that sets one the tables do not know to be harmless is not vouched for.
   */
  sets?: string[];
  /**
   * True when WHAT RUNS is decided at run time — the program or its subcommand is a
   * variable or a substitution (`$CMD --hard`, `git $(cat x)`). Never allowed without asking.
   */
  dynamic?: boolean;
}

/** One request a line is made of, before anybody has judged it. */
export type ShellRequest =
  | {
      kind: "command";
      span: TextSpan;
      command: ParsedCommand;
      /**
       * Set on a command runner that was OPENED (`sh -c`, `env`, `sudo`, `ssh`, `npx`): the runner itself,
       * spanning the whole invocation, ahead of the requests for what it runs. `kept` when it was a
       * request of its own before runners had a gate (`ssh` reaches the network whatever it runs).
       * A set with a runner line judges it as the runner's gate; one without passes an unkept one by.
       */
      opened?: { kept: boolean };
      /** The language it was written in — the line's, or a payload's (`powershell -Command "…"` inside a POSIX line). */
      dialect?: CommandDialect;
    }
  | {
      kind: "redirect";
      /** Operator and target together. */
      span: TextSpan;
      /** The operator as written (`>`, `>>`, `2>`, `&>`, `<`). */
      op: string;
      opSpan: TextSpan;
      /** `>` writes the target; `<` reads the source. */
      direction: "read" | "write";
      target: string;
      targetSpan: TextSpan;
      dynamic?: boolean;
      via?: string[];
    }
  /**
   * Code the line runs that is no command, and that nobody can read off it: a .NET call
   * (`[IO.File]::WriteAllText(…)`), a property set on an object, a method named for every object it is
   * handed (`ForEach-Object Delete`). It is the subject `script`, as code handed to `python -c` is.
   */
  | { kind: "code"; span: TextSpan; what: string; via?: string[] }
  | { kind: "unparsed"; span: TextSpan; reason: string; via?: string[] };

export interface ParseResult {
  /** Every command on the line, wrappers unwrapped. Empty when nothing parsed. */
  commands: ParsedCommand[];
  /**
   * True when the line — or a payload inside it — could not be tokenized with
   * confidence: an unterminated quote, PowerShell syntax the heuristic does not model.
   * Unparsable ⇒ the policy's `require_approval` default (DESIGN §10.1), never an allow.
   */
  unparsed: boolean;
  /** Why it is unparsed, for the approval prompt. */
  reason?: string;
}

export interface TakenApart extends ParseResult {
  /** Commands, redirects and unmodellable pieces, in source order. */
  requests: ShellRequest[];
}

const POSIX_SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "\n", "(", ")"]);
/** cmd: `&` runs one command after another, and `;` is no separator at all. */
const CMD_SEPARATORS = new Set(["&&", "||", "|", "&", "\n", "(", ")"]);

/** Words that lead a command without being one: what follows them is still judged. */
const POSIX_LEADERS = new Set(["{", "!", "if", "then", "elif", "else", "while", "until", "do"]);
/** Words that are a statement on their own, or open one with no command in it. */
const POSIX_CLOSERS = new Set(["}", "fi", "done", "esac"]);
/** Constructs with no model here: the whole line asks. */
const POSIX_UNMODELLED = new Set(["case", "function", "select", "coproc"]);
/** cmd's conditionals, loops and jumps run a command this does not follow. */
const CMD_UNMODELLED = new Set(["if", "for", "goto"]);

const MAX_DEPTH = 8;

interface Substitution {
  text: string;
  map: number[];
  via: string;
}

interface Tokenized {
  tokens: Token[];
  subs: Substitution[];
  unparsed?: string;
}

/** Index of the `)` that closes a `(` opened just before `from`, or -1. Quotes and nesting honoured. */
function closeOfParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === "$" && text[j + 1] === "(") {
          const close = closeOfParen(text, j + 2);
          if (close < 0) return -1;
          j = close;
        }
      }
      if (j >= text.length) return -1;
      i = j;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Tokenize one text as POSIX shell or cmd, keeping operators and redirects as their own tokens, and
 * collecting every substitution (`$( … )`, backticks, `<( … )`) to be taken apart in its own right.
 * (PowerShell is `powershellCommand.ts`'s.)
 *
 * `map[i]` is the original-line offset of `text[i]` — identity at the top, and the payload's own
 * offsets when this text is the inside of `sh -c "…"` — so every span comes out in the line the
 * person will be shown.
 */
function tokenize(text: string, map: readonly number[] | undefined, dialect: "posix" | "cmd"): Tokenized {
  const posix = dialect === "posix";
  const at = (i: number): number => (map === undefined ? i : i < map.length ? map[i]! : (map[map.length - 1] ?? -1) + 1);
  const endAt = (j: number): number => (j > 0 ? at(j - 1) + 1 : at(0));
  const sliceMap = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let k = from; k < to; k++) out.push(at(k));
    return out;
  };

  const tokens: Token[] = [];
  const subs: Substitution[] = [];
  let value = "";
  let valueMap: number[] = [];
  let wordStart = -1;
  let had = false; // distinguishes an empty quoted token ("") from no token
  let plain = true; // no quote or escape in the current word, so digits before `>` are a descriptor
  let dynamic = false;
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; literal: boolean }> = [];

  const begin = (i: number): void => {
    if (wordStart < 0) wordStart = i;
  };
  const add = (c: string, i: number): void => {
    begin(i);
    value += c;
    valueMap.push(at(i));
  };
  const push = (end: number): void => {
    if (value.length > 0 || had) {
      tokens.push({ type: "word", value, start: at(wordStart), end: endAt(end), map: valueMap, ...(dynamic ? { dynamic: true } : {}) });
    }
    value = "";
    valueMap = [];
    wordStart = -1;
    had = false;
    plain = true;
    dynamic = false;
  };
  const op = (type: "op" | "redir", text_: string, from: number, to: number): void => {
    tokens.push({ type, value: text_, start: at(from), end: endAt(to), map: sliceMap(from, to) });
  };

  /** `$( … )`, a backtick pair or `<( … )` starting at `i`: keeps the raw text in the word, queues the inside. Returns the index of its last character, or -1. */
  const substitution = (i: number): number => {
    const c = text[i]!;
    if (c === "`") {
      let j = i + 1;
      for (; j < text.length && text[j] !== "`"; j++) if (text[j] === "\\") j++;
      if (j >= text.length) return -1;
      subs.push({ text: text.slice(i + 1, j), map: sliceMap(i + 1, j), via: "`…`" });
      for (let k = i; k <= j; k++) add(text[k]!, k);
      dynamic = true;
      return j;
    }
    // `$((` is arithmetic: nothing runs.
    const arithmetic = c === "$" && text[i + 2] === "(";
    const close = closeOfParen(text, i + 2);
    if (close < 0) return -1;
    if (!arithmetic) subs.push({ text: text.slice(i + 2, close), map: sliceMap(i + 2, close), via: c === "$" ? "$(…)" : `${c}(…)` });
    for (let k = i; k <= close; k++) add(text[k]!, k);
    // `<( … )` stands for a PATH (`/dev/fd/63`), never for a program or a subcommand.
    if (c === "$") dynamic = true;
    return close;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    // cmd has no single quotes: `'` is a character like any other.
    if (posix && c === "'") {
      begin(i);
      had = true;
      plain = false;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "'") break;
        add(text[j]!, j);
      }
      if (j >= text.length) return { tokens: [], subs: [], unparsed: "unterminated quote" };
      i = j;
      continue;
    }
    if (c === '"') {
      begin(i);
      had = true;
      plain = false;
      let j = i + 1;
      for (; j < text.length; j++) {
        const q = text[j]!;
        if (q === '"') {
          // cmd hands a doubled quote inside quotes to the program as one.
          if (!posix && text[j + 1] === '"') {
            add('"', j);
            j++;
            continue;
          }
          break;
        }
        if (posix && q === "\\" && j + 1 < text.length) {
          add(text[j + 1]!, j + 1);
          j++;
          continue;
        }
        if (posix && ((q === "$" && text[j + 1] === "(") || q === "`")) {
          const end = substitution(j);
          if (end < 0) return { tokens: [], subs: [], unparsed: "unterminated substitution" };
          j = end;
          continue;
        }
        if (posix ? q === "$" : cmdExpands(text, j)) dynamic = true;
        add(q, j);
      }
      if (j >= text.length) return { tokens: [], subs: [], unparsed: "unterminated quote" };
      i = j;
      continue;
    }
    // cmd's escape: `^&` is the character, `^` before a newline continues the line.
    if (!posix && c === "^" && i + 1 < text.length) {
      if (next === "\n" || (next === "\r" && text[i + 2] === "\n")) {
        i += next === "\r" ? 2 : 1;
        continue;
      }
      plain = false;
      add(next!, i + 1);
      i++;
      continue;
    }
    if (posix && c === "\\" && i + 1 < text.length) {
      // A backslash-newline is a line continuation: no character at all.
      if (next === "\n") {
        i++;
        continue;
      }
      plain = false;
      add(next!, i + 1);
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push(i);
      continue;
    }
    if (c === "\n") {
      push(i);
      op("op", "\n", i, i + 1);
      // The bodies of the here-documents opened on this line: data, not commands.
      while (pendingHeredocs.length > 0) {
        const doc = pendingHeredocs.shift()!;
        let lineStart = i + 1;
        let found = false;
        while (lineStart <= text.length) {
          let lineEnd = text.indexOf("\n", lineStart);
          if (lineEnd < 0) lineEnd = text.length;
          const raw = text.slice(lineStart, lineEnd).replace(/\r$/, "");
          if ((doc.stripTabs ? raw.replace(/^\t+/, "") : raw) === doc.delimiter) {
            found = true;
            i = lineEnd; // the loop's i++ steps past the newline
            break;
          }
          if (!doc.literal) {
            // An unquoted delimiter leaves substitutions live inside the body.
            for (let k = lineStart; k < lineEnd; k++) {
              if ((text[k] === "$" && text[k + 1] === "(" && text[k + 2] !== "(") || text[k] === "`") {
                const close = text[k] === "`" ? text.indexOf("`", k + 1) : closeOfParen(text, k + 2);
                if (close < 0 || close > lineEnd) return { tokens: [], subs: [], unparsed: "unterminated substitution in a here-document" };
                const from = text[k] === "`" ? k + 1 : k + 2;
                subs.push({ text: text.slice(from, close), map: sliceMap(from, close), via: "<<" });
                k = close;
              }
            }
          }
          if (lineEnd >= text.length) break;
          lineStart = lineEnd + 1;
        }
        if (!found) return { tokens: [], subs: [], unparsed: "unterminated here-document" };
      }
      continue;
    }
    if (posix && c === "#" && wordStart < 0) {
      const end = text.indexOf("\n", i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (posix && ((c === "$" && next === "(") || c === "`" || ((c === "<" || c === ">") && next === "("))) {
      const end = substitution(i);
      if (end < 0) return { tokens: [], subs: [], unparsed: "unterminated substitution" };
      i = end;
      continue;
    }

    // Redirects. A run of digits right before one is its descriptor (`2>`), not a word.
    if (c === ">" || c === "<" || (posix && c === "&" && next === ">")) {
      let from = i;
      if (wordStart >= 0 && plain && /^\d+$/.test(value)) {
        from = wordStart;
        value = "";
        valueMap = [];
        wordStart = -1;
      } else {
        push(i);
      }
      const rest = text.slice(c === "&" ? i + 1 : i);
      const lead = c === "&" ? c : "";
      const match = /^(>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)/.exec(rest)!;
      const symbol = lead + match[1]!;
      let to = i + symbol.length;
      if (match[1] === ">&" || match[1] === "<&") {
        // `2>&1`, `>&-`: a descriptor, not a place — no request.
        const dup = /^(\d+|-)/.exec(text.slice(to));
        if (dup !== null) {
          i = to + dup[1]!.length - 1;
          continue;
        }
      }
      if (posix && (match[1] === "<<" || match[1] === "<<-")) {
        // The delimiter word, read here so the body can be skipped at the end of this line.
        let j = to;
        while (text[j] === " " || text[j] === "\t") j++;
        let delimiter = "";
        let literal = false;
        for (; j < text.length && !/[\s;&|<>()]/.test(text[j]!); j++) {
          if (text[j] === "'" || text[j] === '"') {
            const close = text.indexOf(text[j]!, j + 1);
            if (close < 0) return { tokens: [], subs: [], unparsed: "unterminated quote" };
            delimiter += text.slice(j + 1, close);
            literal = true;
            j = close;
          } else if (text[j] === "\\" && j + 1 < text.length) {
            delimiter += text[++j];
            literal = true;
          } else {
            delimiter += text[j];
          }
        }
        if (delimiter.length === 0) return { tokens: [], subs: [], unparsed: "here-document without a delimiter" };
        pendingHeredocs.push({ delimiter, stripTabs: match[1] === "<<-", literal });
        i = j - 1;
        continue;
      }
      op("redir", text.slice(from, to), from, to);
      i = to - 1;
      continue;
    }

    // Operators: two-character forms first so `&&` never becomes two `&`s.
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||" || (posix && (two === ";;" || two === "|&"))) {
      push(i);
      op("op", two, i, i + 2);
      i++;
      continue;
    }
    if ((posix && c === ";") || c === "|" || c === "(" || c === ")" || c === "&") {
      push(i);
      op("op", c, i, i + 1);
      continue;
    }
    if (posix ? c === "$" && /[A-Za-z_{@*#?!0-9$-]/.test(next ?? "") : cmdExpands(text, i)) dynamic = true;
    add(c, i);
  }
  if (pendingHeredocs.length > 0) return { tokens: [], subs: [], unparsed: "unterminated here-document" };
  push(text.length);
  return { tokens, subs };
}

/** Whether cmd expands a variable at `i`: `%PATH%`, `%~dp0`, `%1`, and `!X!` where delayed expansion is on. */
function cmdExpands(text: string, i: number): boolean {
  const c = text[i];
  if (c === "%") return /^%(~[a-z]*\d|\d|[A-Za-z_][^%\s]*%)/i.test(text.slice(i));
  return c === "!" && /^![A-Za-z_][^!\s]*!/.test(text.slice(i));
}

/** `C:\Program Files\Git\git.exe` / `/usr/bin/git` → `git`. */
export function programName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * What a command word runs, as the dialect reads it: its {@link programName}, and in PowerShell an
 * alias read as the cmdlet it stands for (`rm` → `remove-item`, `%` → `foreach-object`). A word that
 * names a path or an extension (`where.exe`, `.\ls`) is that program, never an alias.
 */
export function commandNameOf(word: string, dialect: CommandDialect): { program: string; alias?: string } {
  // PowerShell's `cd\` names no file: it is a function of that name.
  const program = programName(word) || word.toLowerCase();
  if (dialect !== "powershell" || /[\\/]/.test(word) || /\.[A-Za-z0-9]+$/.test(word) || !Object.hasOwn(POWERSHELL_ALIASES, program)) return { program };
  return { program: POWERSHELL_ALIASES[program]!, alias: program };
}

/** PowerShell's dashes: a parameter may be written with any of them (`–Path`). */
const POWERSHELL_DASHES = /^[-\u2013\u2014\u2015]/;

/**
 * A PowerShell parameter as PowerShell reads it — in any case, after any of its dashes, and cut short
 * to a prefix that names one of `known` alone (`-Pat` is `-path`). `known` is lowercase, dash first.
 * `undefined` when it names none of them, or several.
 */
export function powershellParameter(word: string, known: readonly string[]): string | undefined {
  if (!POWERSHELL_DASHES.test(word)) return undefined;
  const flag = `-${word.slice(1).toLowerCase()}`;
  if (flag.length < 2) return undefined;
  if (known.includes(flag)) return flag;
  const matching = known.filter((name) => name.startsWith(flag));
  return matching.length === 1 ? matching[0] : undefined;
}

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && token !== "--";
/** A `VAR=value` word, as a POSIX shell — and the POSIX programs that take them (`env`) — read one. */
const isAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token);

/** The variable an assignment word sets: `FOO=1` → `FOO`, `PATH+=x` → `PATH`, `$env:Path=x` → `$env:Path`. */
export const variableOf = (token: string): string => token.slice(0, token.indexOf("=")).replace(/\+$/, "");

const wordOf = (token: Token): CommandWord => ({
  value: token.value,
  span: { start: token.start, end: token.end },
  ...(token.dynamic === true ? { dynamic: true } : {}),
  ...(token.code === true ? { code: true } : {}),
  ...(token.element === true ? { element: true } : {}),
  ...(token.bound === true ? { bound: true } : {}),
});

/** One `ParsedCommand` from a run of words, with no embedder opened. */
function commandOf(words: Token[], start: number, via: string[], dialect: CommandDialect): ParsedCommand {
  const { program, alias } = commandNameOf(words[start]!.value, dialect);
  const rest = words.slice(start + 1);
  const flags = rest.filter((t) => isFlag(t.value)).map((t) => t.value);
  const nonFlags: Token[] = [];
  const leading: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!isFlag(token.value)) {
      nonFlags.push(token);
      continue;
    }
    if (nonFlags.length === 0) leading.push(token.value);
    // `git -C <dir> reset` / `-c key=value`: a flag that consumes the next token,
    // which must not be mistaken for the subcommand.
    if (/^-(C|c|C=|c=)$/.test(token.value) || token.value === "--work-tree" || token.value === "--git-dir") {
      if (i + 1 < rest.length && !isFlag(rest[i + 1]!.value)) i++;
    }
  }
  // A PowerShell parameter's colon value (`-Path:x`, and `-Path:a,b`'s `b`) is no subcommand, though it
  // is one of the command's words.
  let bound = false;
  const at = nonFlags.findIndex((t) => {
    bound = t.bound === true || (bound && t.element === true);
    return !bound;
  });
  const subcommand = at >= 0 ? nonFlags[at] : undefined;
  const args = nonFlags.filter((_, i) => i !== at);
  const dynamic = words[start]!.dynamic === true || subcommand?.dynamic === true;
  // Every word before the program was skipped as an assignment (`argv`), so each one names a variable.
  const sets = words.slice(0, start).map((t) => variableOf(t.value));
  return {
    program,
    ...(alias !== undefined ? { alias } : {}),
    ...(sets.length > 0 ? { sets } : {}),
    ...(subcommand !== undefined ? { subcommand: subcommand.value.toLowerCase() } : {}),
    flags,
    ...(leading.length > 0 ? { leadingFlags: leading } : {}),
    args: args.map((t) => t.value),
    tokens: words.map((t) => t.value),
    ...(via.length > 0 ? { via } : {}),
    span: { start: words[0]!.start, end: words[words.length - 1]!.end },
    words: words.map(wordOf),
    programIndex: start,
    ...(dynamic ? { dynamic: true } : {}),
  };
}

/** Several words as ONE shell line — what `ssh host a b`, `eval a b` and `watch a b` hand to a shell. */
function joined(words: Token[]): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  words.forEach((word, index) => {
    if (index > 0) {
      text += " ";
      map.push(words[index - 1]!.end);
    }
    text += word.value;
    map.push(...word.map);
  });
  return { text, map };
}

/** The dialect a shell embedder's payload is written in — the shell's own, not the line's. */
const payloadDialect = (program: string): CommandDialect => (program === "cmd" ? "cmd" : program === "powershell" || program === "pwsh" ? "powershell" : "posix");

/** A word that is nothing but a value decided at run time: `$cmd`, `${x}`, `$(…)`, `%CMD%`. */
const wholeVariable = (word: Token): boolean => word.dynamic === true && /^(\$\{[^}]*\}|\$[\w:?]+|\$\(.*\)|%[^%\s]+%)$/s.test(word.value);

/** A word and the array elements written after it (`a, b, c`): one PowerShell argument. */
function argumentAt(words: readonly Token[], at: number): Token[] {
  const out = [words[at]!];
  for (let i = at + 1; words[i]?.element === true; i++) out.push(words[i]!);
  return out;
}

/** Open one embedder. `undefined` when this invocation hides nothing (`sh` alone, `docker ps`, `find .`). */
function openEmbedder(spec: EmbedderSpec, words: Token[], start: number, dialect: CommandDialect, via: string[], depth: number): Walk | undefined {
  const program = commandNameOf(words[start]!.value, dialect).program;
  const rest = words.slice(start + 1);
  const inner = [...via, program];
  /** The embedder as a request of its own (`keep`), spanning the whole invocation, hidden command included. */
  const own = (keep: Token[] = words): ShellRequest => {
    const span = { start: words[0]!.start, end: words[words.length - 1]!.end };
    return { kind: "command", span, command: { ...commandOf(keep, start, via, dialect), span }, dialect };
  };
  const lineOf = (payload: { text: string; map: number[] }, payloadVia: string[], as: CommandDialect): Walk => walk(payload.text, payload.map, as, payloadVia, depth + 1);
  /** The whole invocation as a piece nobody can read. */
  const unreadable = (reason: string): Walk => ({ requests: [{ kind: "unparsed", span: own().span, reason, ...(via.length > 0 ? { via } : {}) }], unparsed: reason });

  if (spec.kind === "shell") {
    const lower = rest.map((t) => t.value.toLowerCase());
    let payload: Token[] | undefined;
    if (spec.caseless !== true) {
      if (spec.encodedFlags !== undefined && lower.some((t) => spec.encodedFlags!.includes(t))) return unreadable("an encoded command cannot be read");
      const pattern = spec.flagPattern !== undefined ? new RegExp(spec.flagPattern) : undefined;
      const flagAt = rest.findIndex((t, i) => spec.flags.includes(lower[i]!) || (pattern?.test(t.value) ?? false));
      if (flagAt >= 0 && rest[flagAt + 1] !== undefined) payload = spec.rest === true ? rest.slice(flagAt + 1) : [rest[flagAt + 1]!];
    } else {
      // A Windows shell's own switches come first, in any case, written with `-` or `/`; the line
      // starts at its command switch — or, for Windows PowerShell, at its first plain word.
      const pattern = spec.flagPattern !== undefined ? new RegExp(spec.flagPattern, "i") : undefined;
      const encoded = spec.encodedPattern !== undefined ? new RegExp(spec.encodedPattern, "i") : undefined;
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i]!.value;
        const key = lower[i]!.replace(/^[\u2013\u2014\u2015]/, "-");
        if (spec.encodedFlags?.includes(key) === true || (encoded?.test(key) ?? false)) return unreadable("an encoded command cannot be read");
        if (spec.flags.includes(key) || (pattern?.test(key) ?? false)) {
          if (rest[i + 1] !== undefined) payload = spec.rest === true ? rest.slice(i + 1) : [rest[i + 1]!];
          break;
        }
        // `-File x.ps1` runs a file, which is `script` — nothing to open.
        if (spec.fileFlags?.includes(key) === true) return undefined;
        if (spec.valueFlags?.some((flag) => flag === key || flag === key.replace(/^\//, "-")) === true) {
          i++;
          continue;
        }
        if (isFlag(word) || key.startsWith("/")) continue;
        if (spec.positional === true) payload = spec.rest === true ? rest.slice(i) : [rest[i]!];
        break;
      }
    }
    if (payload === undefined) return undefined;
    if (spec.stdinPayload !== undefined && payload.length === 1 && payload[0]!.value === spec.stdinPayload) return unreadable("the command is read from its input, which the line does not show");
    // `powershell -Command { … }`: the block was taken apart where the line wrote it.
    if (payload.every((word) => word.code === true)) return { requests: [] };
    if (payload.every(wholeVariable)) return unreadable("runs a line decided when the line runs");
    const opened = lineOf(payload.length === 1 ? { text: payload[0]!.value, map: payload[0]!.map } : joined(payload), inner, payloadDialect(program));
    // A shell whose payload holds nothing must not silently look empty: it stays a command.
    return opened.requests.length > 0 || opened.unparsed !== undefined ? opened : undefined;
  }

  if (spec.kind === "expression") {
    // `iex "git status"`: the line it is handed, when the line writes it out.
    let payload: Token | undefined;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (isFlag(word.value)) {
        if (powershellParameter(word.value, spec.flags) !== undefined) {
          payload = rest[i + 1];
          break;
        }
        continue;
      }
      payload = word;
      break;
    }
    if (payload === undefined) return unreadable("runs the code it is handed down the pipeline, which the line does not show");
    if (payload.code === true) return { requests: [] };
    if (payload.dynamic === true) return unreadable("runs code decided when the line runs");
    return lineOf({ text: payload.value, map: payload.map }, inner, "powershell");
  }

  if (spec.kind === "process") return openProcess(spec, words, start, dialect, via, depth, own, unreadable);

  if (spec.kind === "block") {
    const known = [...spec.blockFlags, ...spec.fileFlags, ...spec.remoteFlags, ...spec.valueFlags];
    let block: Token | undefined;
    let remote = false;
    let named = false;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (isFlag(word.value)) {
        const name = powershellParameter(word.value, known);
        if (name === undefined) continue;
        // `-FilePath x.ps1` runs a file, which is `script` — nothing to open.
        if (spec.fileFlags.includes(name)) return undefined;
        if (spec.remoteFlags.includes(name)) remote = true;
        if (rest[i + 1] === undefined) continue;
        if (spec.blockFlags.includes(name)) block ??= rest[i + 1];
        i += argumentAt(rest, i + 1).length;
        continue;
      }
      if (word.element === true) continue;
      if (word.code === true) block ??= word;
      // A plain word first is a computer's name: `Invoke-Command srv { … }`.
      else if (block === undefined) named = true;
    }
    if (block === undefined) return undefined;
    if (block.code !== true) return unreadable("runs a script block decided when the line runs");
    // What runs is the block, taken apart where it was written. On another machine the cmdlet is a
    // request of its own: no path scope reaches there.
    return { requests: remote || (named && spec.remoteFlags.length > 0) ? [own()] : [] };
  }

  if (spec.kind === "prefix") {
    let at = 0;
    if (spec.subcommands !== undefined) {
      if (rest[0] === undefined || !spec.subcommands.includes(rest[0].value.toLowerCase())) return undefined;
      at = 1;
    }
    // Skip the embedder's own flags and assignments, then re-parse from the first real word. The
    // remainder is kept INTACT: filtering flags out here would silently drop the inner command's own
    // (`env FOO=1 git reset --hard` must not lose `--hard`, or policy stops seeing a destructive reset).
    // The assignments it skips are set for everything it runs, so they travel with what it opens.
    const sets: string[] = [];
    const setting = (opened: Walk): Walk => {
      if (sets.length === 0) return opened;
      for (const request of opened.requests) if (request.kind === "command") request.command.sets = [...sets, ...(request.command.sets ?? [])];
      return opened;
    };
    while (at < rest.length) {
      const token = rest[at]!.value;
      if (spec.lineFlags?.includes(token) === true && rest[at + 1] !== undefined) {
        const opened = lineOf({ text: rest[at + 1]!.value, map: rest[at + 1]!.map }, inner, dialect);
        return spec.keep === true ? { ...opened, requests: [own(), ...opened.requests] } : opened;
      }
      if (token === "--") {
        at++;
        break;
      }
      if (isFlag(token)) {
        at += spec.valueFlags?.includes(token) === true ? 2 : 1;
        continue;
      }
      if (isAssignment(token)) {
        sets.push(variableOf(token));
        at++;
        continue;
      }
      break;
    }
    at += spec.positionals ?? 0;
    let hidden = rest.slice(at);
    if (spec.until !== undefined) {
      const stop = hidden.findIndex((t) => spec.until!.includes(t.value));
      if (stop >= 0) hidden = hidden.slice(0, stop);
    }
    if (hidden.length === 0) return undefined;
    const language = spec.dialect ?? dialect;
    const opened = setting(spec.line === true ? lineOf(joined(hidden), inner, language) : argv(hidden, language, inner, depth + 1));
    if (opened.requests.length === 0 && opened.unparsed === undefined) return undefined;
    return spec.keep === true ? { ...opened, requests: [own(), ...opened.requests] } : opened;
  }

  if (spec.kind === "find") {
    const kept: Token[] = words.slice(0, start + 1);
    const found: Walk = { requests: [] };
    for (let i = 0; i < rest.length; i++) {
      if (!spec.clauses.includes(rest[i]!.value)) {
        kept.push(rest[i]!);
        continue;
      }
      let end = i + 1;
      while (end < rest.length && rest[end]!.value !== ";" && rest[end]!.value !== "+") end++;
      const clause = rest.slice(i + 1, end);
      if (clause.length > 0) merge(found, argv(clause, dialect, inner, depth + 1));
      i = end;
    }
    if (found.requests.length === 0 && found.unparsed === undefined) return undefined;
    return { ...found, requests: [own(kept), ...found.requests] };
  }

  // git: an alias defined on the line, `submodule foreach`, `bisect run`.
  const found: Walk = { requests: [] };
  for (let i = 0; i < rest.length - 1; i++) {
    const alias = rest[i]!.value === "-c" ? /^alias\.[^=]+=!/.exec(rest[i + 1]!.value) : null;
    if (alias !== null) {
      const payload = rest[i + 1]!;
      merge(found, lineOf({ text: payload.value.slice(alias[0].length), map: payload.map.slice(alias[0].length) }, inner, dialect));
    }
  }
  const plain = rest.filter((t, i) => !isFlag(t.value) && !(i > 0 && /^-[cC]$/.test(rest[i - 1]!.value)));
  const sub = plain[0]?.value.toLowerCase();
  const after = (word: string): Token[] => {
    const from = rest.findIndex((t) => t.value.toLowerCase() === word);
    return rest.slice(from + 1).filter((t, i, all) => !(isFlag(t.value) && all.slice(0, i).every((p) => isFlag(p.value))));
  };
  if (sub === "submodule" && plain[1]?.value.toLowerCase() === "foreach") {
    const hidden = after("foreach");
    if (hidden.length > 0) merge(found, lineOf(joined(hidden), inner, dialect));
  } else if (sub === "bisect" && plain[1]?.value.toLowerCase() === "run") {
    const hidden = after("run");
    if (hidden.length > 0) merge(found, argv(hidden, dialect, inner, depth + 1));
  }
  if (found.requests.length === 0 && found.unparsed === undefined) return undefined;
  return { ...found, requests: [own(), ...found.requests] };
}

/**
 * `Start-Process git -ArgumentList 'push', '--force'` — see the `process` {@link EmbedderSpec}: the
 * program it starts with the words it hands it; the files it is told to write and read; the cmdlet
 * itself as well when it starts the program as someone else.
 */
function openProcess(
  spec: Extract<EmbedderSpec, { kind: "process" }>,
  words: Token[],
  start: number,
  dialect: CommandDialect,
  via: string[],
  depth: number,
  own: () => ShellRequest,
  unreadable: (reason: string) => Walk,
): Walk | undefined {
  const rest = words.slice(start + 1);
  const inner = [...via, commandNameOf(words[start]!.value, dialect).program];
  const known = [...spec.fileFlags, ...spec.argFlags, ...spec.valueFlags];
  let file: Token | undefined;
  let args: Token[] | undefined;
  const positional: Token[][] = [];
  const places: ShellRequest[] = [];
  let elevated = false;
  let environment = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (isFlag(word.value)) {
      const name = powershellParameter(word.value, known);
      // A switch of its own: `-Wait`, `-NoNewWindow`, `-PassThru`.
      if (name === undefined || rest[i + 1] === undefined) continue;
      const value = argumentAt(rest, i + 1);
      i += value.length;
      const first = value[0]!;
      if (spec.fileFlags.includes(name)) file = first;
      else if (spec.argFlags.includes(name)) args = value;
      if (Object.hasOwn(spec.elevating, name)) {
        const wanted = spec.elevating[name]!;
        if (wanted.length === 0 || wanted.includes(first.value.toLowerCase())) elevated = true;
      }
      if (spec.environmentFlags.includes(name)) environment = true;
      const direction = spec.outputFlags.includes(name) ? "write" : spec.inputFlags.includes(name) ? "read" : undefined;
      if (direction !== undefined) {
        places.push({
          kind: "redirect",
          span: { start: word.start, end: first.end },
          op: word.value,
          opSpan: { start: word.start, end: word.end },
          direction,
          target: first.value,
          targetSpan: { start: first.start, end: first.end },
          ...(first.dynamic === true ? { dynamic: true } : {}),
          ...(via.length > 0 ? { via } : {}),
        });
      }
      continue;
    }
    const value = argumentAt(rest, i);
    i += value.length - 1;
    positional.push(value);
  }
  file ??= positional.shift()?.[0];
  if (file === undefined) return undefined;
  args ??= positional.shift() ?? [];
  // The words a program is handed are one command line, which it reads as it likes; cmd's reading —
  // double quotes, and nothing else — is the nearest there is. A word decided as the line runs stays one.
  const started = [file, ...args];
  const line = joined(started);
  const hidden = started.some((word) => word.dynamic === true || word.code === true) ? argv(started, dialect, inner, depth + 1) : walk(line.text, line.map, "cmd", inner, depth + 1);
  const out: Walk = { requests: [...(elevated ? [own()] : []), ...places, ...hidden.requests], ...(hidden.unparsed !== undefined ? { unparsed: hidden.unparsed } : {}) };
  if (environment) merge(out, unreadable("sets variables for the program it starts"));
  return out;
}

function merge(into: Walk, from: Walk): void {
  into.requests.push(...from.requests);
  if (from.unparsed !== undefined && into.unparsed === undefined) into.unparsed = from.unparsed;
}

/** A run of words that is one ARGV — a segment of a line, or what `sudo`/`xargs`/`-exec` runs. */
function argv(words: Token[], dialect: CommandDialect, via: string[], depth: number): Walk {
  // Skip leading `VAR=value` assignments (`FOO=1 git push`). PowerShell and cmd have none: `FOO=1` is
  // the name of a command there.
  let start = 0;
  if (dialect === "posix") while (start < words.length && isAssignment(words[start]!.value)) start++;
  if (start >= words.length) {
    // Nothing but assignments: `PATH=/tmp/x; git status` sets the variable for the rest of the line.
    // Not exported: a shell-local name (`x=1`) reaches no program; `PATH` is in every environment already.
    const sets = words.map((t) => variableOf(t.value)).filter((name) => !isHarmlessVariable(name) && !isShellLocalName(name));
    if (sets.length === 0) return { requests: [] };
    const reason = `sets ${sets.join(", ")} for what runs after it`;
    return { requests: [{ kind: "unparsed", span: { start: words[0]!.start, end: words[words.length - 1]!.end }, reason, ...(via.length > 0 ? { via } : {}) }] };
  }
  if (depth > MAX_DEPTH) {
    return { requests: [{ kind: "unparsed", span: { start: words[0]!.start, end: words[words.length - 1]!.end }, reason: "nested too deeply to follow" }], unparsed: "nested too deeply to follow" };
  }
  const program = commandNameOf(words[start]!.value, dialect).program;
  const spec = Object.hasOwn(EMBEDDERS, program) ? EMBEDDERS[program] : undefined;
  if (spec !== undefined) {
    const opened = openEmbedder(spec, words, start, dialect, via, depth);
    if (opened !== undefined) return isCommandRunner(program) ? withRunner(opened, words, start, via, dialect) : opened;
  }
  const command = commandOf(words, start, via, dialect);
  return { requests: [{ kind: "command", span: command.span!, command, dialect }] };
}

/**
 * An opened command runner's walk with the runner itself at its head, marked `opened` — the request a
 * set's runner line judges as a gate. A kept embedder's own request is already there, and is marked.
 */
function withRunner(opened: Walk, words: Token[], start: number, via: string[], dialect: CommandDialect): Walk {
  const span = { start: words[0]!.start, end: words[words.length - 1]!.end };
  const head = opened.requests[0];
  if (head?.kind === "command" && head.span.start === span.start && head.span.end === span.end && head.command.programIndex === start) {
    return { ...opened, requests: [{ ...head, opened: { kept: true } }, ...opened.requests.slice(1)] };
  }
  const runner: ShellRequest = { kind: "command", span, command: { ...commandOf(words, start, via, dialect), span }, opened: { kept: false }, dialect };
  return { ...opened, requests: [runner, ...opened.requests] };
}

/** One segment between separators: its redirects are requests, and what is left is an argv. */
function segment(tokens: Token[], dialect: CommandDialect, via: string[], depth: number): Walk {
  const out: Walk = { requests: [] };
  const words: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== "redir") {
      words.push(token);
      continue;
    }
    const target = tokens[i + 1];
    if (target === undefined || target.type !== "word") {
      const reason = "a redirect without a target";
      out.requests.push({ kind: "unparsed", span: { start: token.start, end: token.end }, reason });
      out.unparsed ??= reason;
      continue;
    }
    i++;
    // A here-string is data handed to the command, not a place.
    if (token.value.endsWith("<<<")) continue;
    out.requests.push({
      kind: "redirect",
      span: { start: token.start, end: target.end },
      op: token.value,
      opSpan: { start: token.start, end: token.end },
      direction: token.value.includes("<") && !token.value.includes(">") ? "read" : "write",
      target: target.value,
      targetSpan: { start: target.start, end: target.end },
      ...(target.dynamic === true ? { dynamic: true } : {}),
      ...(via.length > 0 ? { via } : {}),
    });
  }

  let from = 0;
  if (dialect === "posix") {
    while (from < words.length && POSIX_LEADERS.has(words[from]!.value)) from++;
    const lead = words[from]?.value;
    if (lead !== undefined && POSIX_UNMODELLED.has(lead)) {
      const reason = `'${lead}' is not modelled`;
      out.requests.push({ kind: "unparsed", span: { start: words[from]!.start, end: words[words.length - 1]!.end }, reason });
      out.unparsed ??= reason;
      return out;
    }
    // `for x in a b c` names no command; what its words substitute was queued by the tokenizer.
    if (lead === "for" || (lead !== undefined && POSIX_CLOSERS.has(lead))) return out;
  } else if (words.length > 0) {
    // `@echo off`: the `@` only keeps cmd from echoing the command.
    const first = words[0]!;
    if (first.value.startsWith("@") && first.value.length > 1) {
      words[0] = { ...first, value: first.value.slice(1), start: first.map[1] ?? first.start + 1, map: first.map.slice(1) };
    }
    const lead = words[0]!.value.toLowerCase();
    if (CMD_UNMODELLED.has(lead)) {
      const reason = `cmd's '${lead}' is not modelled`;
      out.requests.push({ kind: "unparsed", span: { start: words[0]!.start, end: words[words.length - 1]!.end }, reason });
      out.unparsed ??= reason;
      return out;
    }
  }
  if (from < words.length) merge(out, argv(words.slice(from), dialect, via, depth));
  return out;
}

/** Take one text apart: tokenize, open its substitutions, split at separators, walk each segment. */
function walk(text: string, map: readonly number[] | undefined, dialect: CommandDialect, via: string[], depth: number): Walk {
  if (text.trim().length === 0) return { requests: [] };
  const spanOf = (): TextSpan => {
    const first = map === undefined ? 0 : (map[0] ?? 0);
    const last = map === undefined ? text.length : (map[map.length - 1] ?? first - 1) + 1;
    return { start: first, end: last };
  };
  if (depth > MAX_DEPTH) return { requests: [{ kind: "unparsed", span: spanOf(), reason: "nested too deeply to follow" }], unparsed: "nested too deeply to follow" };
  if (dialect === "powershell") return walkPowerShell(text, map, via, depth, { argv: (words, inner, at) => argv(words, "powershell", inner, at) });
  const tokenized = tokenize(text, map, dialect);
  if (tokenized.unparsed !== undefined) {
    // At the top the LINE is unparsed and holds nothing; inside a payload the piece is, and the
    // rest of the line is still judged — a deny beside it must stay a deny.
    return depth === 0
      ? { requests: [], unparsed: tokenized.unparsed }
      : { requests: [{ kind: "unparsed", span: spanOf(), reason: tokenized.unparsed, ...(via.length > 0 ? { via } : {}) }], unparsed: tokenized.unparsed };
  }

  const out: Walk = { requests: [] };
  const separators = dialect === "posix" ? POSIX_SEPARATORS : CMD_SEPARATORS;
  let run: Token[] = [];
  const flush = (): void => {
    if (run.length > 0) merge(out, segment(run, dialect, via, depth));
    run = [];
  };
  for (const token of tokenized.tokens) {
    if (token.type === "op" && separators.has(token.value)) flush();
    else run.push(token);
  }
  flush();
  for (const sub of tokenized.subs) merge(out, walk(sub.text, sub.map, dialect, [...via, sub.via], depth + 1));
  return out;
}

/**
 * Take a command line apart into every request it makes.
 *
 * Never throws: a line it cannot model comes back with `unparsed: true`, which the
 * policy treats as "ask" (DESIGN §10.1). That direction of failure is the whole
 * point — an unreadable command must not become an allowed one. When only a PAYLOAD
 * inside the line is unreadable, `unparsed` is still true and the piece is a request
 * of kind `unparsed`, beside everything that could be read.
 */
export function takeApart(line: string, dialect: CommandDialect = "posix", via: string[] = []): TakenApart {
  const walked = walk(line, undefined, dialect, via, 0);
  const requests = [...walked.requests].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  // An opened runner that was never a request of its own is the gate's, not a command rules match on.
  const commands = requests.flatMap((r) => (r.kind === "command" && (r.opened === undefined || r.opened.kept) ? [r.command] : []));
  return {
    requests,
    commands,
    unparsed: walked.unparsed !== undefined,
    ...(walked.unparsed !== undefined ? { reason: walked.unparsed } : {}),
  };
}

/** {@link takeApart}, as the commands alone — what rules and built-ins match on. */
export function parseCommand(line: string, dialect: CommandDialect = "posix", via: string[] = []): ParseResult {
  const { commands, unparsed, reason } = takeApart(line, dialect, via);
  return { commands, unparsed, ...(reason !== undefined ? { reason } : {}) };
}

/** A one-line rendering of a parsed command, for prompts and the audit trail. */
export function describeCommand(command: ParsedCommand): string {
  const head = [command.program, command.subcommand].filter(Boolean).join(" ");
  const detail = [...command.flags, ...command.args].join(" ");
  const wrapper = command.via && command.via.length > 0 ? ` (via ${command.via.join(" → ")})` : "";
  return `${head}${detail ? ` ${detail}` : ""}${wrapper}`;
}
