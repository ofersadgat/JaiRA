/**
 * Command parsing for policy decisions (DESIGN §10.1).
 *
 * Policy matches on a *parsed intent*, never a regex over the raw string: that is
 * what makes `git -c x reset --hard` and `git reset --hard` the same decision
 * instead of two spellings to enumerate (SPEC §11.2). This module turns a command
 * line into {@link ParsedCommand}s — plural, because one line can carry several
 * commands (`a && b`), and a wrapper (`sh -c "…"`, `env X=1 …`, `sudo …`) hides
 * the command that actually matters.
 *
 * Two dialects (DESIGN §16): a POSIX shell-words tokenizer used for WSL/bash, and
 * a best-effort PowerShell/cmd one. PowerShell parsing is *acknowledged* heuristic
 * — the safe default is to report the line as unparsed and let the policy treat
 * that as "ask", never as "allow".
 */

export type CommandDialect = "posix" | "powershell";

export interface ParsedCommand {
  /** Executable name, lowercased and stripped of any path and `.exe`. */
  program: string;
  /** First non-flag argument, when the program takes subcommands (`git push` → `push`). */
  subcommand?: string;
  /** Flags in order, long and short, without values (`--hard`, `-C`, `-rf`). */
  flags: string[];
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
}

export interface ParseResult {
  /** Every command on the line, wrappers unwrapped. Empty when nothing parsed. */
  commands: ParsedCommand[];
  /**
   * True when the line could not be tokenized with confidence — an unterminated
   * quote, or PowerShell syntax the heuristic does not model. Unparsable ⇒ the
   * policy's `require_approval` default (DESIGN §10.1), never an allow.
   */
  unparsed: boolean;
  /** Why it is unparsed, for the approval prompt. */
  reason?: string;
}

/** Separators that end one command and start another. */
const POSIX_SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);
/** PowerShell adds `;` and `|`; `&&`/`||` exist in PS 7+ and are harmless to split on. */
const PS_SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);

/** Shells that take a command *string* as an argument — the classic policy bypass. */
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish", "cmd", "powershell", "pwsh"]);
/** Wrappers whose trailing words are themselves a command. */
const PREFIX_WRAPPERS = new Set(["env", "sudo", "doas", "nice", "nohup", "time", "xargs", "command", "npx", "pnpm", "bunx"]);

/** What a tokenizer reports. `unparsed` is set when the dialect's own syntax
 *  defeats the heuristic, which the caller turns into an escalation. */
interface Tokenized {
  tokens: string[];
  unterminated: boolean;
  unparsed?: string;
}

/**
 * Tokenize a POSIX command line, honouring quotes and backslash escapes and
 * keeping operators as their own tokens.
 */
function tokenizePosix(line: string): Tokenized {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let had = false; // distinguishes an empty quoted token ("") from no token
  let unterminated = false;

  const push = (): void => {
    if (current.length > 0 || had) tokens.push(current);
    current = "";
    had = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) {
        quote = undefined;
        had = true;
      } else if (c === "\\" && quote === '"' && i + 1 < line.length) {
        current += line[++i];
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      current += line[++i];
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push();
      continue;
    }
    if (c === "\n") {
      push();
      tokens.push("\n");
      continue;
    }
    // Operators: two-character forms first so `&&` never becomes two `&`s.
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      tokens.push(two);
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      push();
      tokens.push(c);
      continue;
    }
    current += c;
  }
  if (quote) unterminated = true;
  push();
  return { tokens, unterminated };
}

/**
 * Tokenize a PowerShell/cmd line — best effort (DESIGN §16). PowerShell's real
 * grammar (subexpressions, splatting, backtick escapes, `&` call operator) is not
 * modelled; constructs that would change which program runs mark the line
 * unparsed so the policy escalates rather than guesses.
 */
function tokenizePowerShell(line: string): Tokenized {
  // These change what actually executes in ways this tokenizer does not follow.
  if (/\$\(|@\(|`|\bInvoke-Expression\b|\biex\b/i.test(line)) {
    return { tokens: [], unterminated: false, unparsed: "PowerShell expression syntax is not modelled" };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let had = false;
  let unterminated = false;

  const push = (): void => {
    if (current.length > 0 || had) tokens.push(current);
    current = "";
    had = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      // PowerShell escapes a quote by doubling it.
      if (c === quote) {
        if (line[i + 1] === quote) {
          current += c;
          i++;
        } else {
          quote = undefined;
          had = true;
        }
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      push();
      continue;
    }
    if (c === "\n") {
      push();
      tokens.push("\n");
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      tokens.push(two);
      i++;
      continue;
    }
    if (c === ";" || c === "|") {
      push();
      tokens.push(c);
      continue;
    }
    current += c;
  }
  if (quote) unterminated = true;
  push();
  return { tokens, unterminated };
}

/** `C:\Program Files\Git\git.exe` / `/usr/bin/git` → `git`. */
export function programName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && token !== "--";

/** Build one `ParsedCommand` from a token run, following any wrapper to the real command. */
function parseSegment(tokens: string[], dialect: CommandDialect, via: string[] = []): ParsedCommand[] {
  // Skip leading `VAR=value` assignments (`FOO=1 git push`).
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
  if (start >= tokens.length) return [];

  const program = programName(tokens[start]!);
  const rest = tokens.slice(start + 1);

  // `sh -c "git push"` — the payload is a command line in its own right, and it is
  // what policy must actually judge (SPEC §11.2's evasion shapes).
  if (SHELL_WRAPPERS.has(program)) {
    const dashC = rest.findIndex((t) => t === "-c" || /^[-/]c$/i.test(t) || t.toLowerCase() === "-command");
    const payload = dashC >= 0 ? rest[dashC + 1] : undefined;
    if (payload !== undefined) {
      const inner = parseCommand(payload, dialect, [...via, program]);
      // A shell whose payload cannot be parsed must not silently look empty.
      return inner.commands.length > 0
        ? inner.commands
        : [{ program, flags: rest.filter(isFlag), args: rest.filter((t) => !isFlag(t)), tokens, ...(via.length > 0 ? { via } : {}) }];
    }
  }

  // `env X=1 git push`, `sudo git push`, `npx tsc` — strip the wrapper's own flags
  // and re-parse the remainder.
  if (PREFIX_WRAPPERS.has(program)) {
    const inner = rest.filter((t, i) => {
      if (!isFlag(t)) return true;
      void i;
      return false;
    });
    if (inner.length > 0) {
      const nested = parseSegment(inner, dialect, [...via, program]);
      if (nested.length > 0) return nested;
    }
  }

  const flags = rest.filter(isFlag);
  const nonFlags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!isFlag(token)) {
      nonFlags.push(token);
      continue;
    }
    // `git -C <dir> reset` / `-c key=value`: a flag that consumes the next token,
    // which must not be mistaken for the subcommand.
    if (/^-(C|c|C=|c=)$/.test(token) || token === "--work-tree" || token === "--git-dir") {
      if (i + 1 < rest.length && !isFlag(rest[i + 1]!)) i++;
    }
  }
  const [subcommand, ...args] = nonFlags;
  return [
    {
      program,
      ...(subcommand !== undefined ? { subcommand: subcommand.toLowerCase() } : {}),
      flags,
      args,
      tokens,
      ...(via.length > 0 ? { via } : {}),
    },
  ];
}

/**
 * Parse a command line into its constituent commands.
 *
 * Never throws: a line it cannot model comes back with `unparsed: true`, which the
 * policy treats as "ask" (DESIGN §10.1). That direction of failure is the whole
 * point — an unreadable command must not become an allowed one.
 */
export function parseCommand(line: string, dialect: CommandDialect = "posix", via: string[] = []): ParseResult {
  if (line.trim().length === 0) return { commands: [], unparsed: false };

  const tokenized = dialect === "posix" ? tokenizePosix(line) : tokenizePowerShell(line);
  if (tokenized.unparsed !== undefined) {
    return { commands: [], unparsed: true, reason: tokenized.unparsed };
  }
  if (tokenized.unterminated) {
    return { commands: [], unparsed: true, reason: "unterminated quote" };
  }

  const separators = dialect === "posix" ? POSIX_SEPARATORS : PS_SEPARATORS;
  const commands: ParsedCommand[] = [];
  let segment: string[] = [];
  const flush = (): void => {
    if (segment.length > 0) commands.push(...parseSegment(segment, dialect, via));
    segment = [];
  };
  for (const token of tokenized.tokens) {
    if (separators.has(token)) flush();
    else segment.push(token);
  }
  flush();

  return { commands, unparsed: false };
}

/** A one-line rendering of a parsed command, for prompts and the audit trail. */
export function describeCommand(command: ParsedCommand): string {
  const head = [command.program, command.subcommand].filter(Boolean).join(" ");
  const detail = [...command.flags, ...command.args].join(" ");
  const wrapper = command.via && command.via.length > 0 ? ` (via ${command.via.join(" → ")})` : "";
  return `${head}${detail ? ` ${detail}` : ""}${wrapper}`;
}
