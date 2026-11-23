/**
 * WHICH processes a shell command that lists or stops them is about (decision 0023 §3.1, amended
 * 2026-11-23): the programs it names and the pids it names, so `pgrep node` and `kill 4242` answer at
 * the program places of `list_processes`' and `stop_process`'s lines, as a direct call does.
 *
 * Read strictly where a command can STOP more than it names:
 *  - `pkill` matches its pattern anywhere in a program's name, so `pkill node` is about `*node*` (it
 *    stops `nodemon` too); only `-x`, or a pattern anchored at both ends (`^node$`), names `node`
 *    itself. Matched against the whole command line (`-f`), or a pattern that is no plain name, it is
 *    about no one program ({@link unknownProgramPlace}), which only `**` answers.
 *  - `pgrep` lists, as `list_processes`' filter does: its pattern is the place as written, a plain
 *    name or one anchored at both ends; any other pattern is about no one program.
 *  - `killall`, `pidof`, `ps -C`, `lsof -c`, `Get-Process`/`Stop-Process -Name`, `taskkill /IM` and
 *    `tasklist`/`taskkill /FI "IMAGENAME eq …"` name programs exactly (a glob as written), spelled as
 *    `programName` spells them — `node.exe` is `node`.
 *  - `kill`, `Stop-Process`'s first operand and `-Id`, `/PID`, `PID eq`, `ps -p`, `top -p`, `htop -p`,
 *    `lsof -p` and `pstree` name pids, which are read off the machine when the part is judged.
 *  - A word decided when the line runs (`kill $PID`), a job (`kill %1`) and `-InputObject` are about no
 *    one program.
 *
 * A command that names none of these — `ps aux`, `top`, `Get-Process`, `tasklist` — lists every
 * program, so it is about no one place, and the line's `**` answers it. A selection that only narrows
 * among programs (`tasklist /FI "STATUS eq running"`, `ps -u root`) names none either.
 */
import { powershellParameter, programName, unknownProgramPlace, type CommandDialect, type CommandWord, type ParsedCommand } from "@jaira/shared";

/** What a process command is about: programs, as places, and pids, to be read off the machine. */
export interface ProcessTargets {
  programs: string[];
  pids: number[];
  /** For a command that stops processes, what it does to them ({@link stopActionsOf}). */
  actions?: string[];
}

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && token !== "--";
const PID = /^\d+$/;

/** One command's words after its program: each flag's value, by the flag's canonical name, and its operands. */
export interface Walked {
  values: Array<{ flag: string; word: CommandWord }>;
  flags: string[];
  operands: CommandWord[][];
}

/**
 * Walks POSIX words: a listed flag takes the next word (or its own `=value`, or for one letter the rest
 * of the word, `-p1234`); an unlisted flag takes nothing.
 */
export function walkPosix(command: ParsedCommand, valued: readonly string[]): Walked {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1);
  const out: Walked = { values: [], flags: [], operands: [] };
  let flagsOver = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!flagsOver && word.value === "--") {
      flagsOver = true;
      continue;
    }
    if (flagsOver || !isFlag(word.value) || word.dynamic === true) {
      out.operands.push([word]);
      continue;
    }
    const eq = word.value.indexOf("=");
    const name = eq > 0 ? word.value.slice(0, eq) : word.value;
    out.flags.push(name);
    if (valued.includes(name)) {
      if (eq > 0) out.values.push({ flag: name, word: { ...word, value: word.value.slice(eq + 1) } });
      else if (words[i + 1] !== undefined) out.values.push({ flag: name, word: words[++i]! });
      continue;
    }
    const short = word.value.slice(0, 2);
    if (!word.value.startsWith("--") && word.value.length > 2 && valued.includes(short)) out.values.push({ flag: short, word: { ...word, value: word.value.slice(2) } });
  }
  return out;
}

/** Walks cmd's words: a switch is `/x` or `-x` in any case; a listed one takes the next word. */
export function walkCmd(command: ParsedCommand, valued: readonly string[]): Walked {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1);
  const out: Walked = { values: [], flags: [], operands: [] };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const flag = /^[/-][a-z?]+$/i.test(word.value) ? `/${word.value.slice(1).toLowerCase()}` : undefined;
    if (flag === undefined) {
      out.operands.push([word]);
      continue;
    }
    out.flags.push(flag);
    if (valued.includes(flag) && words[i + 1] !== undefined) out.values.push({ flag, word: words[++i]! });
  }
  return out;
}

/** Walks a cmdlet's words: its parameters in any case and cut short; a valued one takes the next word and its array elements. */
export function walkPowershell(command: ParsedCommand, known: readonly string[], valued: readonly string[]): Walked {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1);
  const out: Walked = { values: [], flags: [], operands: [] };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const flag = isFlag(word.value) && word.dynamic !== true ? powershellParameter(word.value.replace(/:$/, ""), known) : undefined;
    if (flag === undefined) {
      if (isFlag(word.value) && word.dynamic !== true) {
        // A parameter this does not know: its value, if any, is not read as an operand.
        if (words[i + 1]?.bound === true) i++;
        continue;
      }
      const group = [word];
      while (words[i + 1]?.element === true) group.push(words[++i]!);
      out.operands.push(group);
      continue;
    }
    out.flags.push(flag);
    if (!valued.includes(flag) || words[i + 1] === undefined || (isFlag(words[i + 1]!.value) && words[i + 1]!.bound !== true)) continue;
    out.values.push({ flag, word: words[++i]! });
    while (words[i + 1]?.element === true) out.values.push({ flag, word: words[++i]! });
  }
  return out;
}

/** The targets being gathered, each word read as a program (`name`, a place as written or spelled) or a pid. */
class Gather {
  readonly programs: string[] = [];
  readonly pids: number[] = [];
  /** A word the line decides when it runs, or one that names no process this can read. */
  unknown(word: CommandWord | string): void {
    this.programs.push(unknownProgramPlace(typeof word === "string" ? word : word.value));
  }
  /** An exact program name, `node.exe` spelled `node`; a list (`a,b`) is each of it. */
  name(word: CommandWord, list = false): void {
    if (word.dynamic === true) return this.unknown(word);
    for (const one of list ? word.value.split(",") : [word.value]) {
      const text = one.trim();
      if (text === "") continue;
      this.programs.push(/[*?[]/.test(text) ? text.replace(/\.exe$/i, "").toLowerCase() : programName(text));
    }
  }
  /** A pid, or a list of them; anything else in a pid's place is about no one program. */
  pid(word: CommandWord, list = false): void {
    if (word.dynamic === true) return this.unknown(word);
    for (const one of list ? word.value.split(",") : [word.value]) {
      const text = one.trim();
      if (text === "") continue;
      if (PID.test(text) && Number(text) > 0) this.pids.push(Number(text));
      else this.unknown(text);
    }
  }
  done(): ProcessTargets {
    return { programs: [...new Set(this.programs)], pids: [...new Set(this.pids)] };
  }
}

/** A regular expression's program, as `pgrep`/`pkill` match it: `exact` (anchored both ends) or found anywhere. */
function patternProgram(pattern: string): { name: string; exact: boolean } | undefined {
  const anchoredStart = pattern.startsWith("^");
  const anchoredEnd = pattern.endsWith("$") && !pattern.endsWith("\\$");
  const body = pattern.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
  // A `.` in a pattern is any character, so only a name without one is read as itself.
  if (!/^[a-z0-9_+-]+$/i.test(body)) return undefined;
  return { name: body.toLowerCase(), exact: anchoredStart && anchoredEnd };
}

/** A tasklist/taskkill filter (`IMAGENAME eq node.exe`, `PID eq 4`): the program or pid it names, when it names one. */
function windowsFilter(gather: Gather, word: CommandWord): void {
  if (word.dynamic === true) return gather.unknown(word);
  const match = /^\s*(imagename|pid)\s+eq\s+(.+?)\s*$/i.exec(word.value);
  if (match === null) return;
  const value = { ...word, value: match[2]! };
  if (match[1]!.toLowerCase() === "pid") gather.pid(value);
  else gather.name(value);
}

/**
 * What a command the shell judges as `list_processes` or `stop_process` is about (see the module
 * header), or `undefined` for a program this does not read.
 */
export function processTargetsOf(command: ParsedCommand, dialect: CommandDialect): ProcessTargets | undefined {
  const gather = new Gather();
  const program = command.program;
  if (dialect === "powershell" && (program === "get-process" || program === "stop-process")) {
    const known = ["-name", "-id", "-inputobject", "-computername", "-module", "-fileversioninfo", "-includeusername", "-passthru", "-force", "-whatif", "-confirm"];
    const walked = walkPowershell(command, known, ["-name", "-id", "-inputobject", "-computername"]);
    for (const { flag, word } of walked.values) {
      if (flag === "-name") gather.name(word);
      else if (flag === "-id") gather.pid(word);
      else if (flag === "-inputobject") gather.unknown(word);
    }
    // The first positional is `-Name` for Get-Process and `-Id` for Stop-Process.
    for (const word of walked.operands[0] ?? []) {
      if (program === "get-process") gather.name(word);
      else gather.pid(word);
    }
    return gather.done();
  }
  if (dialect === "cmd" || program === "tasklist" || program === "taskkill") {
    if (program !== "tasklist" && program !== "taskkill") return undefined;
    const walked = walkCmd(command, ["/fi", "/im", "/pid", "/s", "/u", "/p", "/fo", "/m"]);
    for (const { flag, word } of walked.values) {
      if (flag === "/fi") windowsFilter(gather, word);
      else if (flag === "/im") gather.name(word);
      else if (flag === "/pid") gather.pid(word);
    }
    return gather.done();
  }
  switch (program) {
    case "pgrep":
    case "pkill": {
      const walked = walkPosix(command, ["-d", "--delimiter", "-g", "--pgroup", "-G", "--group", "-P", "--parent", "-s", "--session", "-t", "--terminal", "-u", "--euid", "-U", "--uid", "-F", "--pidfile", "--signal", "--ns", "--nslist", "-r", "--runstates"]);
      const word = walked.operands[0]?.[0];
      if (word === undefined) return gather.done();
      if (word.dynamic === true) {
        gather.unknown(word);
        return gather.done();
      }
      const wholeLine = walked.flags.some((f) => f === "-f" || f === "--full" || (/^-[a-z]+$/i.test(f) && f.includes("f") && !f.startsWith("--")));
      const exactFlag = walked.flags.some((f) => f === "-x" || f === "--exact" || (/^-[a-z]+$/i.test(f) && f.includes("x") && !f.startsWith("--")));
      const read = patternProgram(word.value);
      if (program === "pgrep") {
        // A list, as `list_processes`' filter is: the pattern as written.
        if (read === undefined) gather.unknown(word);
        else gather.programs.push(read.name);
      } else if (wholeLine || read === undefined) gather.unknown(word);
      else gather.programs.push(read.exact || exactFlag ? read.name : `*${read.name}*`);
      return gather.done();
    }
    case "killall": {
      const walked = walkPosix(command, ["-s", "--signal", "-u", "--user", "-o", "--older-than", "-y", "--younger-than", "-n", "-c"]);
      const regex = walked.flags.some((f) => f === "-r" || f === "--regexp");
      for (const { flag, word } of walked.values) if (flag === "-c") gather.name(word);
      for (const [word] of walked.operands) (regex ? gather.unknown(word!) : gather.name(word!));
      return gather.done();
    }
    case "pidof": {
      const walked = walkPosix(command, ["-o", "--omit-pid"]);
      for (const [word] of walked.operands) gather.name(word!);
      return gather.done();
    }
    case "kill": {
      const walked = walkPosix(command, ["-s", "-n"]);
      if (walked.flags.some((f) => f === "-l" || f === "-L" || f === "--list" || f === "--table")) return gather.done();
      for (const [word] of walked.operands) gather.pid(word!);
      return gather.done();
    }
    case "ps": {
      const walked = walkPosix(command, ["-C", "-p", "--pid", "-q", "--quick-pid", "-o", "-O", "--format", "-u", "-U", "--user", "-g", "-G", "--group", "-t", "--tty", "-s", "--sid", "--sort", "-k", "--ppid"]);
      for (const { flag, word } of walked.values) {
        if (flag === "-C") gather.name(word, true);
        else if (["-p", "--pid", "-q", "--quick-pid"].includes(flag)) gather.pid(word, true);
      }
      for (const [word] of walked.operands) if (PID.test(word!.value)) gather.pid(word!);
      return gather.done();
    }
    case "top":
    case "htop": {
      const walked = walkPosix(command, ["-p", "--pid", "-pid", "-d", "--delay", "-n", "-u", "-U", "--user", "-o", "-s", "--sort-key", "-l", "-stats", "-w"]);
      for (const { flag, word } of walked.values) if (flag === "-p" || flag === "--pid" || flag === "-pid") gather.pid(word, true);
      return gather.done();
    }
    case "lsof": {
      const walked = walkPosix(command, ["-c", "-p", "-u", "-g", "-d", "-s", "-r", "-T", "-F", "-k", "-o", "-S", "-a"]);
      for (const { flag, word } of walked.values) {
        if (flag === "-c") gather.name(word);
        else if (flag === "-p") gather.pid(word, true);
      }
      return gather.done();
    }
    case "pstree": {
      const walked = walkPosix(command, []);
      for (const [word] of walked.operands) if (PID.test(word!.value)) gather.pid(word!);
      return gather.done();
    }
    default:
      return gather.done();
  }
}


/**
 * What a command that stops processes does to them, as ACTION places (`stop_process`'s): `stop`, or
 * `interrupt` for Ctrl-C's signal, and `force` where it kills outright (`kill -9`, `taskkill /F`,
 * `Stop-Process -Force`), `tree` where it takes what they started too (`taskkill /T`).
 */
export function stopActionsOf(command: ParsedCommand, dialect: CommandDialect): string[] {
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  if (dialect === "powershell" && command.program === "stop-process") {
    return ["stop", ...(words.some((w) => isFlag(w) && powershellParameter(w.replace(/:$/, ""), ["-force", "-passthru", "-whatif", "-confirm", "-name", "-id", "-inputobject"]) === "-force") ? ["force"] : [])];
  }
  if (command.program === "taskkill") {
    const flags = words.filter((w) => /^[/-][a-z]+$/i.test(w)).map((w) => w.slice(1).toLowerCase());
    return ["stop", ...(flags.includes("f") ? ["force"] : []), ...(flags.includes("t") ? ["tree"] : [])];
  }
  // A signal: `-9`, `-KILL`, `-SIGKILL`, `-s KILL`, `--signal=9`.
  const signals: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "-s" || word === "-n" || word === "--signal") signals.push((words[i + 1] ?? "").toUpperCase());
    else if (word.startsWith("--signal=")) signals.push(word.slice("--signal=".length).toUpperCase());
    else if (/^-(SIG)?[A-Z0-9]+$/i.test(word) && !/^-[a-z]$/.test(word)) signals.push(word.slice(1).toUpperCase());
  }
  const named = signals.map((signal) => signal.replace(/^SIG/, ""));
  if (named.some((signal) => signal === "KILL" || signal === "9")) return ["stop", "force"];
  if (named.some((signal) => signal === "INT" || signal === "2")) return ["interrupt"];
  return ["stop"];
}
