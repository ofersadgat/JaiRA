/**
 * What each part of a shell line is a request FOR, and what a toolset says about it
 * (decision 0007 §4).
 *
 * `command.ts` takes the line apart; this module names each piece's SUBJECT, and looks the subject
 * up in the same subject → mode map every tool answers to. There are no categories here — no
 * read/write/network classes. A file utility is the standard tool on its path, running a file is
 * `script`, and anything else is the program and its subcommand. The verdicts themselves — rules, the
 * destructive floor, the built-in asks, and how they compose with what this module finds — are
 * `policy.ts`.
 */
import {
  OTHER_SUBJECT,
  SCRIPT_SUBJECT,
  carriedShellSubjects,
  isAbsolutePath,
  isToolsetMarkKey,
  shellSubjects,
  subjectKindOf,
  toolModes,
  type CommandPartKind,
  type PermissionMode,
  type PermissionsDecl,
  type TextSpan,
  type Toolset,
} from "@jaira/shared";
import type { CommandDialect, CommandWord, ParsedCommand, ShellRequest } from "./command";
import {
  EMBEDDERS,
  NO_REQUEST,
  NULL_DEVICES,
  POSIX_UTILITIES,
  POWERSHELL_UTILITIES,
  SCRIPT_EXTENSIONS,
  SCRIPT_INTERPRETERS,
  SCRIPT_RUNNERS,
  type UtilitySpec,
} from "./shellTables";

/** The subject that answers for "any other command" — the shell tool's own entry. */
export const SHELL_SUBJECT = "bash";

/** A request with its subject named, and not yet judged. */
export interface ClassifiedPart {
  kind: CommandPartKind;
  /** What the part is a request for, before any entry has matched. */
  subject: string;
  span: TextSpan;
  /** What is underlined when nothing more specific matched. */
  matched: TextSpan[];
  paths: string[];
  url?: string;
  /** The standard tool whose scope table applies to {@link paths} / {@link url}. */
  tool?: string;
  widths: string[];
  via?: string[];
  /** The parsed command, for rules, the floor and the built-ins. Absent on a redirect. */
  command?: ParsedCommand;
  /** Why the parser could not vouch for it (`unparsed`, or a program decided at run time). */
  unmodelled?: string;
  /** `cd`, `echo`, `pwd`, `test`, `true`: a part only if a rule, the floor or a path makes it one. */
  noRequest?: boolean;
}

const spanOfWords = (words: readonly CommandWord[]): TextSpan[] => {
  // Adjacent words separated by nothing but blanks read as one underline.
  const out: TextSpan[] = [];
  for (const word of [...words].sort((a, b) => a.span.start - b.span.start)) {
    const last = out[out.length - 1];
    if (last !== undefined && word.span.start - last.end <= 1) last.end = Math.max(last.end, word.span.end);
    else out.push({ ...word.span });
  }
  return out;
};

/**
 * The spans of a command's program word and the words of a SUBJECT after it — what is underlined
 * when `git commit` decided: `git` and `commit`, and not the flags between or after them.
 */
export function subjectWordSpans(command: ParsedCommand, subject: string): TextSpan[] {
  const words = command.words ?? [];
  const program = words[command.programIndex ?? 0];
  if (program === undefined) return [];
  const wanted = subject.toLowerCase().split(/\s+/).slice(1);
  const found: CommandWord[] = [program];
  let from = (command.programIndex ?? 0) + 1;
  for (const want of wanted) {
    const at = words.findIndex((w, i) => i >= from && w.value.toLowerCase() === want);
    if (at < 0) break;
    found.push(words[at]!);
    from = at + 1;
  }
  return spanOfWords(found);
}

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-" && token !== "--";

/** A command's non-flag words after the program, skipping the value each of `valueFlags` takes. */
function operandsOf(command: ParsedCommand, valueFlags: readonly string[] = [], lower = false): CommandWord[] {
  const words = command.words ?? [];
  const out: CommandWord[] = [];
  for (let i = (command.programIndex ?? 0) + 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.value === "--") continue;
    if (isFlag(word.value)) {
      if (valueFlags.includes(lower ? word.value.toLowerCase() : word.value)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

/** The value written after a named flag (`-Path x`, `-OutFile y`), for each that is present. */
function valuesOf(command: ParsedCommand, flags: readonly string[]): CommandWord[] {
  const words = command.words ?? [];
  const out: CommandWord[] = [];
  for (let i = (command.programIndex ?? 0) + 1; i < words.length - 1; i++) {
    if (flags.includes(words[i]!.value.toLowerCase()) && !isFlag(words[i + 1]!.value)) out.push(words[i + 1]!);
  }
  return out;
}

const looksLikeUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
const looksLikeFile = (value: string): boolean => /[\\/]/.test(value) || SCRIPT_EXTENSIONS.some((ext) => value.toLowerCase().endsWith(ext));
const commandSubjectOk = (subject: string): boolean => subjectKindOf(subject) === "command";

const KNOWN_PROGRAMS = new Set<string>([
  ...Object.keys(EMBEDDERS),
  ...Object.keys(POSIX_UTILITIES),
  ...Object.keys(POWERSHELL_UTILITIES),
  ...Object.keys(SCRIPT_INTERPRETERS),
  ...SCRIPT_RUNNERS.map((r) => r.program),
]);

function utilityOf(program: string, dialect: CommandDialect): UtilitySpec | undefined {
  const own = (table: Readonly<Record<string, UtilitySpec>>): UtilitySpec | undefined => (Object.hasOwn(table, program) ? table[program] : undefined);
  return dialect === "powershell" ? (own(POWERSHELL_UTILITIES) ?? own(POSIX_UTILITIES)) : own(POSIX_UTILITIES);
}

function classifyCommand(command: ParsedCommand, span: TextSpan, dialect: CommandDialect): ClassifiedPart {
  const words = command.words ?? [];
  const programWord = words[command.programIndex ?? 0];
  const programSpan = programWord !== undefined ? [{ ...programWord.span }] : [{ ...span }];
  const base = { span, paths: [] as string[], ...(command.via !== undefined ? { via: command.via } : {}), command };
  const program = command.program;

  const undecided: ClassifiedPart = { ...base, kind: "command", subject: SHELL_SUBJECT, matched: programSpan, widths: [], unmodelled: "what runs is decided when the line runs" };
  if (programWord?.dynamic === true) return undecided;

  // Running a file, named by its path: `./x.sh`, `scripts/smoke.sh`, `build.ps1`.
  const raw = programWord?.value ?? program;
  const hasSeparator = /[\\/]/.test(raw);
  const hasExtension = SCRIPT_EXTENSIONS.some((ext) => raw.toLowerCase().endsWith(ext));
  if ((hasSeparator && (hasExtension || !isAbsolutePath(raw))) || (!hasSeparator && hasExtension && !KNOWN_PROGRAMS.has(program))) {
    return { ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], paths: [raw], widths: [SCRIPT_SUBJECT] };
  }

  if (NO_REQUEST[dialect].includes(program)) {
    return { ...base, kind: "command", subject: program, matched: programSpan, widths: [], noRequest: true, paths: operandsOf(command).map((w) => w.value) };
  }

  // Running a file through its interpreter, or code the line carries inline.
  const interpreter = Object.hasOwn(SCRIPT_INTERPRETERS, program) ? SCRIPT_INTERPRETERS[program] : undefined;
  if (interpreter !== undefined) {
    const lower = words.map((w) => w.value.toLowerCase());
    const has = (flags: readonly string[] | undefined): boolean => (flags ?? []).some((f) => words.some((w, i) => w.value === f || lower[i] === f));
    const script = (paths: string[]): ClassifiedPart => ({ ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], paths, widths: [SCRIPT_SUBJECT] });
    if (!has(interpreter.moduleFlags)) {
      if (has(interpreter.inlineFlags)) return script([]);
      const named = valuesOf(command, interpreter.fileFlags ?? [])[0];
      if (named !== undefined) return script([named.value]);
      const file = operandsOf(command, interpreter.valueFlags)[0];
      const runner = SCRIPT_RUNNERS.some((r) => r.program === program && r.subcommands?.includes(command.subcommand ?? "") === true);
      if (file !== undefined && !runner && (interpreter.anyOperand === true || looksLikeFile(file.value))) return script([file.value]);
    }
  }

  // Running a named script out of a project file: `npm run build`, `make all`.
  if (SCRIPT_RUNNERS.some((r) => r.program === program && (r.subcommands === undefined || r.subcommands.includes(command.subcommand ?? "")))) {
    return { ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], widths: [SCRIPT_SUBJECT] };
  }

  // A file utility is the standard tool on its path.
  const utility = utilityOf(program, dialect);
  if (utility !== undefined) {
    const powershell = utility.pathParams !== undefined || utility.urlParams !== undefined;
    const flagged = (pattern: string): boolean => command.flags.some((f) => new RegExp(pattern).test(f));
    const tool = utility.when?.find((w) => flagged(w.flag))?.tool ?? utility.tool;
    const operands = operandsOf(command, utility.valueFlags, powershell);
    const patternGiven = (utility.patternFlags ?? []).some((f) => command.flags.some((g) => (powershell ? g.toLowerCase() : g) === f));
    let places: CommandWord[];
    if (utility.paths === "all" || (utility.paths === "after-first" && patternGiven)) places = operands;
    else if (utility.paths === "after-first") places = operands.slice(1);
    else if (utility.paths === "first") places = operands.slice(0, 1);
    else if (utility.paths === "before-flags") {
      const firstFlag = words.findIndex((w, i) => i > (command.programIndex ?? 0) && isFlag(w.value));
      places = operands.filter((w) => firstFlag < 0 || words.indexOf(w) < firstFlag);
    } else places = [];
    places = [...new Set([...places, ...valuesOf(command, utility.pathParams ?? [])])];
    const urlWord = utility.url === true ? (valuesOf(command, utility.urlParams ?? [])[0] ?? operands.find((w) => looksLikeUrl(w.value)) ?? operands[0]) : undefined;
    return {
      ...base,
      kind: "tool",
      subject: tool,
      tool,
      matched: programSpan,
      paths: places.map((w) => w.value),
      ...(urlWord !== undefined ? { url: urlWord.value } : {}),
      // `grep` is a tool's name as well as a program's: remembered, it is the tool's own entry.
      widths: [commandSubjectOk(program) ? program : tool],
    };
  }

  // Anything else: the program and its subcommand — unless the subcommand is decided at run time
  // (`git $(cat x) --hard`), in which case nobody can say what it is a request for.
  if (command.dynamic === true) return undecided;
  const sub = command.subcommand !== undefined && /^[a-z][a-z0-9_-]*$/.test(command.subcommand) ? command.subcommand : undefined;
  const subject = sub !== undefined ? `${program} ${sub}` : program;
  return {
    ...base,
    kind: "command",
    subject,
    matched: programSpan,
    widths: commandSubjectOk(program) ? (sub !== undefined ? [subject, program] : [program]) : [],
  };
}

/** Name what one request is for. `undefined` for a redirect to nowhere (`> /dev/null`, `> $null`). */
export function classifyRequest(request: ShellRequest, dialect: CommandDialect): ClassifiedPart | undefined {
  if (request.kind === "unparsed") {
    return { kind: "unparsed", subject: SHELL_SUBJECT, span: request.span, matched: [{ ...request.span }], paths: [], widths: [], unmodelled: request.reason, ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  if (request.kind === "redirect") {
    if (NULL_DEVICES.includes(request.target.toLowerCase()) || /^\/dev\/fd\/\d+$/.test(request.target)) return undefined;
    const tool = request.direction === "read" ? "read_file" : "write_file";
    return { kind: "redirect", subject: tool, tool, span: request.span, matched: [{ ...request.opSpan }], paths: [request.target], widths: [tool], ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  return classifyCommand(request.command, request.span, dialect);
}

// --- the toolset, as the shell reads it ---------------------------------------

/** Every subject a shell part can answer to, with its mode: tools, commands, `script`, and `other`. */
export interface ShellToolset {
  entries: Record<string, PermissionMode>;
  other?: PermissionMode;
}

/**
 * The map a shell line is judged against, from a {@link Toolset}. `undefined` when the toolset says
 * nothing about the shell — no mode for `bash`, no command subject, no `script` — which is the same
 * test {@link shellToolsetOfBlock} applies to a lowered block, since lowering writes `subjects` from
 * exactly these.
 */
export function shellToolsetOf(toolset: Toolset): ShellToolset | undefined {
  const subjects = shellSubjects(toolset);
  if (Object.keys(subjects).length === 0) return undefined;
  return { entries: { ...toolModes(toolset), ...subjects }, ...(toolset.other !== undefined ? { other: toolset.other } : {}) };
}

/**
 * The same map from a LOWERED `permissions` block — what the engine hands the policy at the moment
 * of decision. `undefined` for a block lowering did not write (no `subjects`): an unmigrated state
 * says nothing about the parts of a line, and its shell answers to the command policy as it did.
 */
export function shellToolsetOfBlock(block: PermissionsDecl | undefined): ShellToolset | undefined {
  return shellToolsetsOfBlock(block)[0]?.toolset;
}

/** One map a line is judged against, and where it came from. */
export interface JudgingToolset {
  toolset: ShellToolset;
  source?: string;
}

/**
 * EVERY map a lowered block judges a line against.
 *
 * A block with `subjects` is one map, and only that one: a conversation turn's, a state read straight
 * off its file, and a RUN's since upstream `literalPermissions` passes a host's keys through
 * (declarative-ai 3f5e5cc). `subjects` merges per key of `permissions`, so a child's own replaces its
 * parent's, and a carried key it inherited beside them is not read.
 *
 * A block WITHOUT `subjects` is a snapshot lowered between 2026-09-22 and 3f5e5cc, handed over by an
 * older engine: its subjects are found in the keys lowering carried them in
 * (`SHELL_SUBJECTS_KEY_PREFIX` in `@jaira/shared`), and a child could hold its parent's key beside its
 * own — each is a map, and the caller keeps the strictest answer. Empty for a block no lowering wrote,
 * which is the unmigrated state's "the command policy decides".
 */
export function shellToolsetsOfBlock(block: PermissionsDecl | undefined): JudgingToolset[] {
  if (block === undefined) return [];
  const other = block.other ?? block.default;
  const tools = Object.fromEntries(Object.entries(block.tools ?? {}).filter(([name]) => !isToolsetMarkKey(name)));
  const of = (subjects: Record<string, PermissionMode>): ShellToolset => ({ entries: { ...tools, ...subjects }, ...(other !== undefined ? { other } : {}) });
  if (block.subjects !== undefined) return [{ toolset: of(block.subjects), ...(block.source !== undefined ? { source: block.source } : {}) }];
  return carriedShellSubjects(block.tools).map((carried) => ({ toolset: of(carried.subjects), ...(carried.source !== undefined ? { source: carried.source } : {}) }));
}

export interface ToolsetAnswer {
  /** Absent when the entry is `smart`: the toolset defers to the command policy. */
  mode?: Exclude<PermissionMode, "smart">;
  /** The entry that answered — `git commit`, `git`, `bash`, `write_file`, `script`, `other` — or none. */
  entry?: string;
  /** True when the entry NAMES this program (`git commit`, `rm`), as against a fallback. */
  specific: boolean;
  /** The words of the line that entry matched. */
  matched?: TextSpan[];
}

interface CommandEntry {
  key: string;
  mode: PermissionMode;
  program: string;
  subs: string[];
  flags: string[];
}

function commandEntriesOf(toolset: ShellToolset): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const [key, mode] of Object.entries(toolset.entries)) {
    if (subjectKindOf(key) !== "command") continue;
    const [program, ...rest] = key.split(/\s+/);
    out.push({ key, mode, program: program!.toLowerCase(), subs: rest.filter((w) => !isFlag(w)).map((w) => w.toLowerCase()), flags: rest.filter(isFlag) });
  }
  return out;
}

/** The most specific command entry that matches: program, then its subcommand words as a prefix, then every flag it names. */
function matchCommandEntry(toolset: ShellToolset, command: ParsedCommand): { entry: CommandEntry; words: CommandWord[] } | undefined {
  const operands = operandsOf(command).filter((w) => w.dynamic !== true);
  // `git -C dir commit`: the value `-C` takes is not the subcommand.
  const subs = command.subcommand !== undefined ? operands.slice(operands.findIndex((w) => w.value.toLowerCase() === command.subcommand)) : [];
  let best: { entry: CommandEntry; words: CommandWord[]; score: number } | undefined;
  for (const entry of commandEntriesOf(toolset)) {
    if (entry.program !== command.program) continue;
    if (!entry.subs.every((s, i) => subs[i]?.value.toLowerCase() === s)) continue;
    if (!entry.flags.every((f) => command.flags.includes(f))) continue;
    const score = entry.subs.length * 2 + entry.flags.length;
    const rank: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };
    if (best !== undefined && (score < best.score || (score === best.score && rank[entry.mode] <= rank[best.entry.mode]))) continue;
    const all = command.words ?? [];
    const program = all[command.programIndex ?? 0];
    const flagWords = entry.flags.flatMap((f) => all.find((w) => w.value === f) ?? []);
    best = { entry, score, words: [...(program !== undefined ? [program] : []), ...subs.slice(0, entry.subs.length), ...flagWords] };
  }
  return best;
}

/**
 * What the toolset says about one part.
 *
 * Lookup order: the most specific command entry naming the program (`git commit`, then `git`; for a
 * utility or a script runner that is `rm`, `npm run`), then the part's own subject — the standard
 * tool, or `script` — and for a plain command the shell's entry (`bash`, "any other command"), then
 * `other`. With nothing at all the answer is `ask`: absent means not offered.
 */
export function lookUp(toolset: ShellToolset, part: ClassifiedPart): ToolsetAnswer {
  const own = (key: string): PermissionMode | undefined => (Object.hasOwn(toolset.entries, key) ? toolset.entries[key] : undefined);
  const answer = (mode: PermissionMode, entry: string, specific: boolean, matched?: TextSpan[]): ToolsetAnswer => ({
    ...(mode !== "smart" ? { mode } : {}),
    entry,
    specific,
    ...(matched !== undefined ? { matched } : {}),
  });
  if (part.command !== undefined && part.kind !== "unparsed" && part.unmodelled === undefined) {
    const named = matchCommandEntry(toolset, part.command);
    if (named !== undefined) return answer(named.entry.mode, named.entry.key, true, spanOfWords(named.words));
  }
  const subject = part.kind === "tool" || part.kind === "redirect" ? part.tool! : part.kind === "script" ? SCRIPT_SUBJECT : SHELL_SUBJECT;
  const direct = own(subject);
  if (direct !== undefined) return answer(direct, subject, false);
  if (toolset.other !== undefined) return answer(toolset.other, OTHER_SUBJECT, false);
  return { mode: "ask", specific: false };
}
