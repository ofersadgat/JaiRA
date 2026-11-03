/**
 * What each part of a shell line is a request FOR, and what a permission set says about it
 * (decision 0007 §4).
 *
 * `shellCommand.ts` (`@jaira/shared`) takes the line apart; this module names each piece's SUBJECT, and looks the subject
 * up in the same subject → mode map every tool answers to. There are no categories here — no
 * read/write/network classes. A file utility is the standard tool on its path, running a file is
 * `script`, and anything else is the program and its subcommand. The verdicts themselves — rules, the
 * destructive floor, the built-in asks, and how they compose with what this module finds — are
 * `policy.ts`.
 */
import {
  OTHER_SUBJECT,
  SCRIPT_SUBJECT,
  holdsShellLines,
  isAbsolutePath,
  isFunctionMode,
  linePlaces,
  placeKindOf,
  resolvePlaces,
  sameMode,
  shellSubjects,
  subjectKindOf,
  toolModes,
  permissionSetOfEnvironment,
  type CommandPartKind,
  type PermissionsDecl,
  type PlaceKind,
  type PlaceOptions,
  type TextSpan,
  type PermissionSet,
  type PermissionSetMode,
} from "@jaira/shared";
import { openerOf, openerTool, powershellParameter, systemToolOf, variableOf, type CommandDialect, type CommandWord, type ParsedCommand, type ShellRequest } from "@jaira/shared";
import {
  CMD_UTILITIES,
  EMBEDDERS,
  NO_REQUEST,
  NULL_DEVICES,
  POSIX_UTILITIES,
  POWERSHELL_HARMLESS_MEMBERS,
  POWERSHELL_INTERPRETERS,
  POWERSHELL_REDEFINERS,
  POWERSHELL_UTILITIES,
  SCRIPT_EXTENSIONS,
  SCRIPT_INTERPRETERS,
  SCRIPT_RUNNERS,
  VARIABLE_SETTERS,
  CONFIGURING_OPTIONS,
  PACKAGE_SCRIPT_RUNNERS,
  isHarmlessVariable,
  isShellLocalName,
  type PackageScriptRunner,
  type UtilitySpec,
} from "@jaira/shared";

/** The subject that answers for "any other command" — the shell tool's own entry. */
export const SHELL_SUBJECT = "shell";

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

/**
 * Whether a flag a command was given is one of `flags`: the same word — or, for PowerShell's own
 * parameters (`powershell`), in any case and cut short to a prefix that names one of them alone
 * (`-Pat` is `-path`, `-Dest` is `-destination`).
 */
type FlagNamer = (given: string, flags: readonly string[]) => boolean;
const exactFlag: FlagNamer = (given, flags) => flags.includes(given);
const powershellFlag: FlagNamer = (given, flags) => powershellParameter(given, flags) !== undefined;

/**
 * A command's arguments after the program, each with its PowerShell array elements (`a, b` is one
 * argument), skipping the value each of `valueFlags` takes and a value given with a colon (`-Path:x`).
 */
function argumentsOf(command: ParsedCommand, valueFlags: readonly string[] = [], named: FlagNamer = exactFlag): CommandWord[][] {
  const words = command.words ?? [];
  const out: CommandWord[][] = [];
  const skip = (from: number): number => {
    let at = from + 1;
    while (words[at]?.element === true) at++;
    return at - 1;
  };
  for (let i = (command.programIndex ?? 0) + 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.value === "--") continue;
    if (isFlag(word.value)) {
      if (named(word.value, valueFlags) && words[i + 1] !== undefined && words[i + 1]!.bound !== true) i = skip(i + 1);
      continue;
    }
    if (word.bound === true) {
      i = skip(i);
      continue;
    }
    if (word.element === true && out.length > 0) out[out.length - 1]!.push(word);
    else out.push([word]);
  }
  return out;
}

/** A command's non-flag words after the program, skipping the value each of `valueFlags` takes. */
function operandsOf(command: ParsedCommand, valueFlags: readonly string[] = [], named: FlagNamer = exactFlag): CommandWord[] {
  return argumentsOf(command, valueFlags, named).flat();
}

/** The value written after a named flag (`-Path x`, `-OutFile y`, `-Path:a,b`), for each that is present. */
function valuesOf(command: ParsedCommand, flags: readonly string[], named: FlagNamer = (given, list) => list.includes(given.toLowerCase())): CommandWord[] {
  const words = command.words ?? [];
  const out: CommandWord[] = [];
  for (let i = (command.programIndex ?? 0) + 1; i < words.length - 1; i++) {
    if (!named(words[i]!.value, flags) || isFlag(words[i + 1]!.value)) continue;
    out.push(words[i + 1]!);
    for (let at = i + 2; words[at]?.element === true; at++) out.push(words[at]!);
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
  ...Object.keys(CMD_UTILITIES),
  ...Object.keys(SCRIPT_INTERPRETERS),
  ...SCRIPT_RUNNERS.map((r) => r.program),
]);

/** The file utility a program is, as its dialect names it — a POSIX one beside it (`rg` under PowerShell). */
function utilityOf(program: string, dialect: CommandDialect): UtilitySpec | undefined {
  const own = (table: Readonly<Record<string, UtilitySpec>>): UtilitySpec | undefined => (Object.hasOwn(table, program) ? table[program] : undefined);
  if (dialect === "powershell") return own(POWERSHELL_UTILITIES) ?? own(POSIX_UTILITIES);
  if (dialect === "cmd") return own(CMD_UTILITIES) ?? own(POSIX_UTILITIES);
  return own(POSIX_UTILITIES);
}

/** A registry path as PowerShell's file cmdlets take one: a drive (`HKLM:\…`) or the provider's name. */
const REGISTRY_PATH = /^(?:(?:microsoft\.powershell\.core\\)?registry::|hk(?:lm|cu|cr|u|cc):)/i;

/** PowerShell's drives that are no files: setting an item there changes a variable, or what a name runs. */
const POWERSHELL_DRIVE = /^(env|function|alias|variable):\\?(.*)$/i;

/**
 * What a PowerShell part does that its subject does not say, or `undefined`: a cmdlet that points a
 * name elsewhere (`Set-Alias`), one handed a variable that changes every command after it, an item set
 * on the `env:`, `function:` or `alias:` drive. The part is then one nobody can vouch for.
 */
function powershellUnmodelled(command: ParsedCommand, paths: readonly string[]): string | undefined {
  if (Object.hasOwn(POWERSHELL_REDEFINERS, command.program)) return POWERSHELL_REDEFINERS[command.program];
  if (command.program === "set-variable" || command.program === "new-variable") {
    const named = valuesOf(command, ["-name"], powershellFlag)[0] ?? operandsOf(command, ["-value", "-scope", "-option", "-description", "-visibility"], powershellFlag)[0];
    if (named !== undefined && /^(global:|script:|local:|private:)?psdefaultparametervalues$/i.test(named.value)) return "changes the parameters every command after it is given";
  }
  for (const path of paths) {
    const drive = POWERSHELL_DRIVE.exec(path);
    if (drive === null) continue;
    const kind = drive[1]!.toLowerCase();
    const name = drive[2]!;
    if (kind === "env" && !isHarmlessVariable(`$env:${name}`)) return `it sets ${name || "variables"}, which can change what runs after it`;
    if (kind === "function" || kind === "alias") return `defines what '${name}' runs`;
  }
  return undefined;
}

/** The variables a variable-setting builtin sets that are not harmless (`export PATH=…`, `read GIT_DIR`) — see {@link VARIABLE_SETTERS}. */
function unsafeSetsOf(command: ParsedCommand): string[] {
  const spec = Object.hasOwn(VARIABLE_SETTERS, command.program) ? VARIABLE_SETTERS[command.program]! : undefined;
  if (spec === undefined) return [];
  const words = command.words ?? [];
  const after = words.slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  let names: string[];
  if ("flag" in spec) {
    const at = after.indexOf(spec.flag);
    if (at < 0) return [];
    if (spec.always === true) return [after[at + 1] ?? spec.flag];
    names = after[at + 1] !== undefined ? [after[at + 1]!] : [];
  } else {
    const operands = after.filter((w) => !isFlag(w));
    names = spec.names === "operands" ? operands : operands.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w)).map(variableOf);
  }
  // What is exported reaches every program after it, whatever its name. What is not reaches one only
  // if it was in the environment already — and those are upper case (`PATH`, `GIT_DIR`), where a
  // loop's `read -r line` is not.
  const exported = command.program === "export" || ((command.program === "declare" || command.program === "typeset") && after.some((w) => /^-[a-zA-Z]*x/.test(w)));
  return names.filter((name) => !isHarmlessVariable(name) && (exported || !isShellLocalName(name)));
}

/**
 * The part a command is, before it is judged: {@link classifyCommand}, and not vouched for when it sets
 * a variable that changes what runs, or is given one of its own {@link CONFIGURING_OPTIONS}.
 */
function classifyWithSets(command: ParsedCommand, span: TextSpan, dialect: CommandDialect): ClassifiedPart {
  const part = classifyCommand(command, span, dialect);
  if (part.unmodelled !== undefined) return part;
  const setting = (command.sets ?? []).filter((name) => !isHarmlessVariable(name));
  const own = Object.hasOwn(CONFIGURING_OPTIONS, command.program) ? CONFIGURING_OPTIONS[command.program]! : [];
  const configuring = (command.leadingFlags ?? []).filter((flag) => own.some((option) => (option.endsWith("=") ? flag.startsWith(option) : flag === option || flag.startsWith(`${option}=`))));
  if (setting.length === 0 && configuring.length === 0) return part;
  const { noRequest: _noRequest, ...rest } = part;
  const why = setting.length > 0 ? `it sets ${setting.join(", ")}, which can change what it runs` : `${configuring.join(", ")} changes what ${command.program} runs`;
  return { ...rest, unmodelled: why };
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

  const unmodelledBy = (why: string): ClassifiedPart => ({ ...base, kind: "command", subject: program, matched: programSpan, widths: [], unmodelled: why });
  if (dialect === "powershell") {
    const why = powershellUnmodelled(command, []);
    if (why !== undefined) return unmodelledBy(why);
  }

  if (NO_REQUEST[dialect].includes(program)) {
    const setting = dialect === "posix" ? unsafeSetsOf(command) : dialect === "cmd" ? cmdSetsOf(command) : [];
    if (setting.length > 0) return unmodelledBy(`it sets ${setting.join(", ")}, which can change what runs after it`);
    // `ForEach-Object Delete` calls `Delete` on every object it is handed — code the line does not show.
    const member = program === "foreach-object" ? memberCalledBy(command) : undefined;
    if (member !== undefined) return { ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], widths: [SCRIPT_SUBJECT] };
    return { ...base, kind: "command", subject: program, matched: programSpan, widths: [], noRequest: true, paths: operandsOf(command).map((w) => w.value) };
  }

  // Running a file through its interpreter, or code the line carries inline. A cmdlet's flags are
  // PowerShell's: any case, cut short.
  const interpreter = Object.hasOwn(SCRIPT_INTERPRETERS, program) ? SCRIPT_INTERPRETERS[program] : undefined;
  if (interpreter !== undefined) {
    const named: FlagNamer = POWERSHELL_INTERPRETERS.includes(program) ? powershellFlag : exactFlag;
    const lower = words.map((w) => w.value.toLowerCase());
    const has = (flags: readonly string[] | undefined): boolean =>
      (flags ?? []).some((f) => words.some((w, i) => w.value === f || lower[i] === f || (named === powershellFlag && isFlag(w.value) && powershellFlag(w.value, [f]))));
    const script = (paths: string[]): ClassifiedPart => ({ ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], paths, widths: [SCRIPT_SUBJECT] });
    if (!has(interpreter.moduleFlags)) {
      if (has(interpreter.inlineFlags)) return script([]);
      const given = valuesOf(command, interpreter.fileFlags ?? [], named === powershellFlag ? powershellFlag : undefined)[0];
      if (given !== undefined) return script([given.value]);
      const file = operandsOf(command, interpreter.valueFlags, named)[0];
      const runner = SCRIPT_RUNNERS.some((r) => r.program === program && r.subcommands?.includes(command.subcommand ?? "") === true);
      if (file !== undefined && !runner && (interpreter.anyOperand === true || looksLikeFile(file.value))) return script([file.value]);
    }
  }

  // Running a named script out of a project file: `npm run build`, `make all`.
  if (runsPackageScript(command) || SCRIPT_RUNNERS.some((r) => r.program === program && (r.subcommands === undefined || r.subcommands.includes(command.subcommand ?? "")))) {
    return { ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], widths: [SCRIPT_SUBJECT] };
  }

  // A program that opens something in its app — a file, a folder, a link, an app by name — is
  // `open_app`; opening what would run as a program is running it (decision 0019 §3).
  const opener = openerOf(program, dialect);
  if (opener !== undefined && (opener.sub === undefined || command.subcommand === opener.sub)) {
    const handed = command.flags.some((f) => (opener.passesArgs ?? []).includes(f));
    const named: FlagNamer = dialect === "powershell" ? powershellFlag : exactFlag;
    const given = [...operandsOf(command, opener.valueFlags ?? [], named).slice(opener.sub !== undefined ? 1 : 0), ...(dialect === "powershell" ? valuesOf(command, ["-path", "-literalpath", "-lp"], powershellFlag) : [])].map((w) => w.value);
    if (handed || openerTool(given, dialect) === "script") return { ...base, kind: "script", subject: SCRIPT_SUBJECT, matched: [{ ...span }], paths: given, widths: [SCRIPT_SUBJECT] };
    return { ...base, kind: "tool", subject: "open_app", tool: "open_app", matched: programSpan, widths: [commandSubjectOk(program) ? program : "open_app"] };
  }

  // A program that acts on the machine, where a System tool does that: `kill` is `stop_process`,
  // `systemctl start` is `control_service`. cmd's switches (`/release`) are its flags.
  const switches = dialect === "posix" ? [] : operandsOf(command).filter((w) => /^\/[a-z0-9?]+(:.*)?$/i.test(w.value));
  const system = systemToolOf(
    program,
    [...command.flags, ...switches.map((w) => w.value.toLowerCase())],
    operandsOf(command).filter((w) => !switches.includes(w)).map((w) => w.value),
    dialect,
  );
  if (system !== undefined) {
    return { ...base, kind: "tool", subject: system, tool: system, matched: programSpan, widths: [commandSubjectOk(program) ? program : system] };
  }

  // A file utility is the standard tool on its path.
  const utility = utilityOf(program, dialect);
  if (utility !== undefined) {
    // A cmdlet's parameters are PowerShell's: in any case, and cut short to a prefix.
    const named: FlagNamer = utility.pathParams !== undefined || utility.urlParams !== undefined ? powershellFlag : exactFlag;
    const flagged = (pattern: string): boolean => command.flags.some((f) => new RegExp(pattern).test(f));
    let tool = utility.when?.find((w) => flagged(w.flag))?.tool ?? utility.tool;
    // cmd's switches are written with a slash (`rd /s /q x`), and are no places.
    const groups = argumentsOf(command, utility.valueFlags, named).filter((group) => dialect !== "cmd" || !/^\/[a-z0-9?]+(:.*)?$/i.test(group[0]!.value));
    const operands = groups.flat();
    const patternGiven = (utility.patternFlags ?? []).some((f) => command.flags.some((g) => named(g, [f])));
    let places: CommandWord[];
    if (utility.paths === "all" || (utility.paths === "after-first" && patternGiven)) places = operands;
    else if (utility.paths === "after-first") places = groups.slice(1).flat();
    else if (utility.paths === "first") places = groups.slice(0, 1).flat();
    else if (utility.paths === "before-flags") {
      const firstFlag = words.findIndex((w, i) => i > (command.programIndex ?? 0) && isFlag(w.value));
      places = operands.filter((w) => firstFlag < 0 || words.indexOf(w) < firstFlag);
    } else places = [];
    const byName = (flags: readonly string[]): CommandWord[] => valuesOf(command, flags, named === powershellFlag ? powershellFlag : undefined);
    places = [...new Set([...places, ...byName(utility.pathParams ?? [])])];
    const urlWord = utility.url === true ? (byName(utility.urlParams ?? [])[0] ?? operands.find((w) => looksLikeUrl(w.value)) ?? operands[0]) : undefined;
    if (dialect === "powershell") {
      const why = powershellUnmodelled(command, places.map((w) => w.value));
      if (why !== undefined) return unmodelledBy(why);
      // A file cmdlet handed the registry reads or changes the machine's settings, not a file.
      if (places.length > 0 && places.every((w) => REGISTRY_PATH.test(w.value))) {
        tool = tool === "write_file" ? "write_settings" : "read_settings";
        return { ...base, kind: "tool", subject: tool, tool, matched: programSpan, widths: [commandSubjectOk(program) ? program : tool] };
      }
    }
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
  // A cmdlet (`Install-Module`, Verb-Noun) is its whole verb: what follows it is no subcommand.
  const cmdlet = dialect === "powershell" && /^[a-z]+-[a-z]/.test(program);
  const sub = !cmdlet && command.subcommand !== undefined && /^[a-z][a-z0-9_-]*$/.test(command.subcommand) ? command.subcommand : undefined;
  const subject = sub !== undefined ? `${program} ${sub}` : program;
  return {
    ...base,
    kind: "command",
    subject,
    matched: programSpan,
    widths: commandSubjectOk(program) ? (sub !== undefined ? [subject, program] : [program]) : [],
  };
}

/**
 * The member `ForEach-Object` is told to call on every object it is handed (`ForEach-Object Delete`,
 * `% -MemberName Kill`), when it is told one that may change something. A script block is no member,
 * and a property it only reads (`% FullName`) is harmless.
 */
function memberCalledBy(command: ParsedCommand): string | undefined {
  const member = valuesOf(command, ["-membername"], powershellFlag)[0] ?? argumentsOf(command, ["-begin", "-end", "-process", "-inputobject", "-argumentlist", "-throttlelimit", "-timeoutseconds"], powershellFlag).flat().find((w) => w.code !== true);
  if (member === undefined || member.code === true) return undefined;
  return POWERSHELL_HARMLESS_MEMBERS.includes(member.value.toLowerCase()) ? undefined : member.value;
}

/** What cmd's `set NAME=value` sets that changes what runs after it. */
function cmdSetsOf(command: ParsedCommand): string[] {
  if (command.program !== "set") return [];
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  const assigned = words.find((w) => !/^\/[a-z]$/i.test(w) && w.includes("="));
  const name = assigned?.slice(0, assigned.indexOf("=")).replace(/^"/, "");
  return name !== undefined && name.length > 0 && !isHarmlessVariable(name.toUpperCase()) ? [name] : [];
}

/** Name what one request is for. `undefined` for a redirect to nowhere (`> /dev/null`, `> $null`). */
export function classifyRequest(request: ShellRequest, dialect: CommandDialect): ClassifiedPart | undefined {
  if (request.kind === "unparsed") {
    return { kind: "unparsed", subject: SHELL_SUBJECT, span: request.span, matched: [{ ...request.span }], paths: [], widths: [], unmodelled: request.reason, ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  // Read, and not vouched for: the same as `export PATH=…`, which is a command that asks and says why.
  if (request.kind === "unvouched") {
    return { kind: "command", subject: SHELL_SUBJECT, span: request.span, matched: [{ ...request.span }], paths: [], widths: [], unmodelled: request.reason, ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  // Code nobody can read off the line — a .NET call, a property set — is what `python -c` is.
  if (request.kind === "code") {
    return { kind: "script", subject: SCRIPT_SUBJECT, span: request.span, matched: [{ ...request.span }], paths: [], widths: [SCRIPT_SUBJECT], ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  if (request.kind === "redirect") {
    if (NULL_DEVICES.includes(request.target.toLowerCase()) || /^\/dev\/fd\/\d+$/.test(request.target)) return undefined;
    const tool = request.direction === "read" ? "read_file" : "write_file";
    return { kind: "redirect", subject: tool, tool, span: request.span, matched: [{ ...request.opSpan }], paths: [request.target], widths: [tool], ...(request.via !== undefined ? { via: request.via } : {}) };
  }
  return classifyWithSets(request.command, request.span, request.dialect ?? dialect);
}

/// --- the permission set, as the shell reads it ---------------------------------------

/**
 * Every subject a shell part can answer to, with its mode: tools, commands, `script`, and `other`. A
 * mode may be a FUNCTION — the part is then put to it (see `policy.ts`, the `function` verdict).
 *
 * `entries` holds each line's OWN mode — its plain decision, or its place map's `**`; `places` each
 * line's other places (decision 0023 §3), by subject. A line with places and no `**` is in `places`
 * alone: it speaks only where one of its places matches the part, and elsewhere the part falls to the
 * next less specific line ({@link lookUp}).
 */
export interface ShellPermissionSet {
  entries: Record<string, PermissionSetMode>;
  places?: Record<string, Record<string, PermissionSetMode>>;
  other?: PermissionSetMode;
}

/**
 * The map a shell line is judged against, from a {@link Permission set}. `undefined` when the permission set says
 * nothing about the shell — no line for `shell`, no command subject, no `script`, with a mode or with
 * places — which is the same test {@link shellPermissionSetOfBlock} applies to a lowered block, since
 * lowering writes `subjects` from exactly these (`holdsShellLines`).
 */
export function shellPermissionSetOf(permissionSet: PermissionSet): ShellPermissionSet | undefined {
  if (!holdsShellLines(permissionSet)) return undefined;
  const places = linePlaces(permissionSet);
  return {
    entries: { ...toolModes(permissionSet), ...shellSubjects(permissionSet) },
    ...(Object.keys(places).length > 0 ? { places } : {}),
    ...(permissionSet.other !== undefined ? { other: permissionSet.other } : {}),
  };
}

/** One map a line is judged against, and where it came from. */
export interface JudgingPermissionSet {
  permissionSet: ShellPermissionSet;
  source?: string;
}

/**
 * The map a lowered block judges a line against, or `undefined` when the block carries no shell
 * subjects — a state that declared no permission set, or a map that holds no shell — and the command policy
 * decides.
 *
 * The block is a conversation turn's, a state read straight off its file, or a RUN's (upstream
 * `literalPermissions` passes a host's keys through, declarative-ai 3f5e5cc and later). `subjects`
 * merges per key of `permissions`, so a child's own replaces its parent's — and `places` with it.
 */
export function shellPermissionSetOfBlock(block: PermissionsDecl | undefined): JudgingPermissionSet | undefined {
  if (block?.subjects === undefined) return undefined;
  // The block read back into the one map — the gate's modes, the subjects' authored ones, every line a
  // FUNCTION answers for (which lowering wrote as `ask` and named in `functions`), and every line's places.
  const read = permissionSetOfEnvironment(undefined, block);
  const entries: Record<string, PermissionSetMode> = {};
  for (const [subject, entry] of Object.entries(read.entries)) if (entry.mode !== undefined) entries[subject] = entry.mode;
  const places = linePlaces(read);
  return {
    permissionSet: { entries, ...(Object.keys(places).length > 0 ? { places } : {}), ...(read.other !== undefined ? { other: read.other } : {}) },
    ...(block.source !== undefined ? { source: block.source } : {}),
  };
}

export interface PermissionSetAnswer {
  /** The entry's mode — a word, or a FUNCTION the part is to be put to. */
  mode?: PermissionSetMode;
  /** The entry that answered — `git commit`, `git`, `shell`, `write_file`, `script`, `other` — or none. */
  entry?: string;
  /** True when the entry NAMES this program (`git commit`, `rm`), as against a fallback. */
  specific: boolean;
  /** The words of the line that entry matched. */
  matched?: TextSpan[];
  /** The PLACE of the entry's line that answered (`packages/app`), when a place did rather than the line's own mode. */
  place?: string;
}

interface CommandEntry {
  key: string;
  /** The line's own mode; absent for a place map with no `**`. */
  mode?: PermissionSetMode;
  program: string;
  subs: string[];
  flags: string[];
}

/** How strict a mode is, for picking between two equally specific entries: allow ▸ function ▸ ask ▸ deny. */
const MODE_RANK = (mode: PermissionSetMode): number => (isFunctionMode(mode) ? 1 : { allow: 0, ask: 2, deny: 3 }[mode]);

/** A line's places other than `**`, when it has any. */
function placesOfLine(permissionSet: ShellPermissionSet, key: string): Readonly<Record<string, PermissionSetMode>> | undefined {
  const places = permissionSet.places !== undefined && Object.hasOwn(permissionSet.places, key) ? permissionSet.places[key] : undefined;
  return places !== undefined && Object.keys(places).length > 0 ? places : undefined;
}

/** How strict a LINE is, for ordering equally specific entries: the strictest of its own mode and its places. */
function lineRank(permissionSet: ShellPermissionSet, key: string, mode: PermissionSetMode | undefined): number {
  const modes = [...(mode !== undefined ? [mode] : []), ...Object.values(placesOfLine(permissionSet, key) ?? {})];
  return modes.reduce((worst, next) => Math.max(worst, MODE_RANK(next)), -1);
}

/** Is there a line for this subject at all — an own mode, or places? */
function hasLine(permissionSet: ShellPermissionSet, key: string): boolean {
  return Object.hasOwn(permissionSet.entries, key) || placesOfLine(permissionSet, key) !== undefined;
}

function commandEntriesOf(permissionSet: ShellPermissionSet): CommandEntry[] {
  const out: CommandEntry[] = [];
  const keys = [...new Set([...Object.keys(permissionSet.entries), ...Object.keys(permissionSet.places ?? {})])];
  for (const key of keys) {
    if (subjectKindOf(key) !== "command" || !hasLine(permissionSet, key)) continue;
    const [program, ...rest] = key.split(/\s+/);
    const mode = Object.hasOwn(permissionSet.entries, key) ? permissionSet.entries[key] : undefined;
    out.push({ key, ...(mode !== undefined ? { mode } : {}), program: program!.toLowerCase(), subs: rest.filter((w) => !isFlag(w)).map((w) => w.toLowerCase()), flags: rest.filter(isFlag) });
  }
  return out;
}

/**
 * Whether a flag an entry names is the flag a command was given — or the entry that refuses it is a
 * spelling away from never matching:
 *  - the same word;
 *  - a long flag with its value joined on: `git diff --output` names `--output=patch.diff`;
 *  - a one-letter flag inside a cluster of short ones, or with its value joined on: `git push -f`
 *    names `-fu`, `git grep -O` names `-Ovim`. Where an allowing and a refusing entry then both
 *    match, they are equally specific and the stricter wins (`matchCommandEntry`).
 */
const flagMatches = (named: string, given: string): boolean => {
  if (given === named) return true;
  if (named.startsWith("--")) return !named.includes("=") && given.startsWith(`${named}=`);
  return /^-[A-Za-z0-9]$/.test(named) && /^-[^-]{2,}/.test(given) && given.slice(1).includes(named[1]!);
};

/** One command entry that matches a command, with the words it matched and how specific it is. */
export interface CommandMatch {
  entry: CommandEntry;
  words: CommandWord[];
  score: number;
}

/**
 * EVERY command entry that matches, most specific first — program, then its subcommand words as a
 * prefix, then every flag it names; among equally specific entries the stricter first, and among
 * those the first written. A PowerShell command answers to its cmdlet's name and to the alias the line
 * called it by (`Remove-Item`'s entry, or `rm`'s, for `rm x`). A line with places none of which
 * matches a part passes it to the next of these (decision 0023 §3.4), which is why all of them are
 * wanted and not the best alone.
 */
export function matchCommandEntries(permissionSet: ShellPermissionSet, command: ParsedCommand): CommandMatch[] {
  const operands = operandsOf(command).filter((w) => w.dynamic !== true);
  // `git -C dir commit`: the value `-C` takes is not the subcommand.
  const subs = command.subcommand !== undefined ? operands.slice(operands.findIndex((w) => w.value.toLowerCase() === command.subcommand)) : [];
  const out: Array<CommandMatch & { rank: number }> = [];
  for (const entry of commandEntriesOf(permissionSet)) {
    if (entry.program !== command.program && entry.program !== command.alias) continue;
    if (!entry.subs.every((s, i) => subs[i]?.value.toLowerCase() === s)) continue;
    if (!entry.flags.every((f) => command.flags.some((g) => flagMatches(f, g)))) continue;
    const score = entry.subs.length * 2 + entry.flags.length;
    const all = command.words ?? [];
    const program = all[command.programIndex ?? 0];
    const flagWords = entry.flags.flatMap((f) => all.find((w) => flagMatches(f, w.value)) ?? []);
    out.push({ entry, score, rank: lineRank(permissionSet, entry.key, entry.mode), words: [...(program !== undefined ? [program] : []), ...subs.slice(0, entry.subs.length), ...flagWords] });
  }
  // Array.prototype.sort is stable: among equals, the first written stays first.
  return out.sort((a, b) => b.score - a.score || b.rank - a.rank).map(({ rank: _rank, ...match }) => match);
}

/** The most specific command entry that matches — the first of {@link matchCommandEntries}. */
export function matchCommandEntry(permissionSet: ShellPermissionSet, command: ParsedCommand): { entry: CommandEntry; words: CommandWord[] } | undefined {
  return matchCommandEntries(permissionSet, command)[0];
}

/**
 * Where a part acts, for the places of the lines it answers to (decision 0023 §3.1): the places it is
 * about, of each kind a line can be about, as `places.ts` compares them. Built by the policy, which
 * knows the directory the part runs in and the packages a script runs in (`partPlacesOf` in `policy.ts`).
 */
export interface PartPlaces {
  /** The places the part is about for the line `line`, of kind `kind` — empty when it names none that can be read. */
  of(kind: PlaceKind, line: string): readonly string[];
  /** What a path place is resolved against: the project root and the named places. */
  options?: PlaceOptions | undefined;
}

/** One line a part may answer to, in the order it is asked. */
interface LineStep {
  key: string;
  mode?: PermissionSetMode;
  places?: Readonly<Record<string, PermissionSetMode>>;
  specific: boolean;
  matched?: TextSpan[];
}

/**
 * What the permission set says about one part.
 *
 * Lookup order — the lines from most specific to least: every command entry naming the program
 * (`git commit`, then `git`; for a utility or a script runner that is `rm`, `npm run`), most specific
 * first; then the part's own subject — the standard tool, or `script` — and for a plain command, or a
 * script that `script` does not answer, the shell's entry (`shell`, "any other command"); then `other`.
 * With nothing at all the answer is `ask`: absent means not offered.
 *
 * A line with PLACES (decision 0023 §3.4) answers only where one of its places matches what the part
 * is about (`where`): the most specific place that matches decides, a part about several places takes
 * the strictest (§3.5), and the places no place of the line matches go to the line's own mode — its
 * `**` — or, where it has none, on down the lookup order, never to a guess. Without `where` a line's
 * places match nothing, and only its own mode speaks.
 */
export function lookUp(permissionSet: ShellPermissionSet, part: ClassifiedPart, where?: PartPlaces): PermissionSetAnswer {
  const steps: LineStep[] = [];
  const step = (key: string, specific: boolean, matched?: TextSpan[]): void => {
    if (!hasLine(permissionSet, key) || steps.some((s) => s.key === key)) return;
    const mode = Object.hasOwn(permissionSet.entries, key) ? permissionSet.entries[key] : undefined;
    const places = placesOfLine(permissionSet, key);
    steps.push({ key, specific, ...(mode !== undefined ? { mode } : {}), ...(places !== undefined ? { places } : {}), ...(matched !== undefined ? { matched } : {}) });
  };
  if (part.command !== undefined && part.kind !== "unparsed" && part.unmodelled === undefined) {
    for (const named of matchCommandEntries(permissionSet, part.command)) step(named.entry.key, true, spanOfWords(named.words));
  }
  const subject = part.kind === "tool" || part.kind === "redirect" ? part.tool! : part.kind === "script" ? SCRIPT_SUBJECT : SHELL_SUBJECT;
  step(subject, false);
  // §3.4: elsewhere, `npm run build` is `script`'s, then `shell`'s, then `other`'s. A part that is a
  // FILE TOOL is not "any other command": `cat x` is `read_file`'s, then `other`'s, as it always was.
  if (part.kind === "script") step(SHELL_SUBJECT, false);
  const fallback: PermissionSetAnswer =
    permissionSet.other !== undefined ? { mode: permissionSet.other, entry: OTHER_SUBJECT, specific: false } : { mode: "ask", specific: false };
  return walkLines(steps, 0, undefined, fallback, where);
}

/**
 * What a chain of lines, most specific first, says about a part — each line's places, then its own
 * mode, a place that matches nothing passing on to the next (decision 0023 §3.4) — or `undefined` when
 * none of them says anything here. The runner gate's question (`runner:npm`, then `runner:*`), which
 * answers nothing rather than `other` when no runner line speaks.
 */
export function answerOfLines(permissionSet: ShellPermissionSet, keys: readonly string[], where?: PartPlaces): PermissionSetAnswer | undefined {
  const steps: LineStep[] = [];
  for (const key of keys) {
    if (!hasLine(permissionSet, key) || steps.some((s) => s.key === key)) continue;
    const mode = Object.hasOwn(permissionSet.entries, key) ? permissionSet.entries[key] : undefined;
    const places = placesOfLine(permissionSet, key);
    steps.push({ key, specific: false, ...(mode !== undefined ? { mode } : {}), ...(places !== undefined ? { places } : {}) });
  }
  const answer = walkLines(steps, 0, undefined, { specific: false }, where);
  return answer.mode === undefined ? undefined : answer;
}

/** The answer of `steps[at]` and the lines after it, for the places in `calls` (all of the part's, when undefined). */
function walkLines(
  steps: readonly LineStep[],
  at: number,
  calls: { kind: PlaceKind; calls: readonly string[] } | undefined,
  fallback: PermissionSetAnswer,
  where: PartPlaces | undefined,
): PermissionSetAnswer {
  const line = steps[at];
  if (line === undefined) return fallback;
  const answer = (mode: PermissionSetMode, place?: string): PermissionSetAnswer => ({
    mode,
    entry: line.key,
    specific: line.specific,
    ...(line.matched !== undefined ? { matched: line.matched } : {}),
    ...(place !== undefined ? { place } : {}),
  });
  if (line.places === undefined) return line.mode !== undefined ? answer(line.mode) : walkLines(steps, at + 1, calls, fallback, where);
  const kind = placeKindOf(line.key) ?? "path";
  // What the part is about, as this line's kind reads it: carried down from a line of the same kind
  // that matched none of them, else read afresh — a `git push` line's branches mean nothing to `git`'s folders.
  const about = calls !== undefined && calls.kind === kind ? calls.calls : (where?.of(kind, line.key) ?? []);
  const resolved = resolvePlaces(line.places, kind, about, where?.options ?? {});
  const answers: PermissionSetAnswer[] = [];
  if (resolved.decision !== undefined) {
    const deciding = resolved.matches.find((match) => sameMode(match.decision, resolved.decision)) ?? resolved.matches[0]!;
    answers.push(answer(resolved.decision, deciding.place));
  }
  // A part that names no place of this kind is about none of the line's places: all of it is "elsewhere".
  if (about.length === 0 || resolved.unmatched.length > 0) {
    answers.push(line.mode !== undefined ? answer(line.mode) : walkLines(steps, at + 1, about.length === 0 ? undefined : { kind, calls: resolved.unmatched }, fallback, where));
  }
  // Several places, the strictest answer (§3.5); among equals, the more specific line, met first.
  return answers.reduce((worst, next) => (MODE_RANK(next.mode ?? "ask") > MODE_RANK(worst.mode ?? "ask") ? next : worst));
}

// --- a package's script, by name ---------------------------------------------------------------------

/**
 * Whether a package manager is told to run a script, whatever stands before the word: the value of a
 * flag (`npm --workspace @a/b run x`) is no subcommand, and a flag this does not read does not make the
 * line any less a script. Not when what runs is decided as the line runs: that stays nobody's to vouch for.
 */
function runsPackageScript(command: ParsedCommand): boolean {
  const runner = Object.hasOwn(PACKAGE_SCRIPT_RUNNERS, command.program) ? PACKAGE_SCRIPT_RUNNERS[command.program]! : undefined;
  if (runner === undefined || command.dynamic === true) return false;
  return packageScriptOf(command) !== undefined || (command.words ?? []).slice((command.programIndex ?? 0) + 1).some((word) => runner.run.includes(word.value));
}

/** The workspaces a line picks: by name, name glob or path; every one; the root beside them; less those taken back. */
export interface WorkspacePicks {
  picked: string[];
  all: boolean;
  root: boolean;
  excluded: string[];
}

/** A package manager asked to run a script — which script, with what, and in which package. */
export interface PackageScriptCall {
  name: string;
  /** The words passed on to the script (`npm run lint -- --max-warnings 0` → `["--max-warnings", "0"]`). */
  args: string[];
  /** Where the package is found from, as written, when the manager was told (`npm --prefix app test`). */
  prefix?: string;
  /** The workspaces picked, when any were. */
  workspaces?: WorkspacePicks;
  /** A picked package without the script is passed over rather than an error (`--if-present`, `pnpm -r`). */
  ifPresent: boolean;
}

/**
 * The script a package manager is asked to run: its name, the words passed on to it, and which
 * package it runs in — the nearest, one found from a `--prefix`, or the workspaces a line picks:
 * npm's `-w`/`--workspaces`, pnpm's `--filter`/`-r`/`-w`, yarn's `workspace <name>`,
 * `workspaces run` and `workspaces foreach`. npm reads its own flags anywhere before `--`, so
 * `npm run build -w app` picks as `npm -w app run build` does. `undefined` when the line names no
 * script, or gives the manager something this does not read — a flag of its own it does not model
 * (`--script-shell`), a pick by what a package depends on (`pnpm --filter app...`), a pick by git
 * history (`--since`): what runs then cannot be read off the files.
 */
export function packageScriptOf(command: ParsedCommand): PackageScriptCall | undefined {
  const runner = Object.hasOwn(PACKAGE_SCRIPT_RUNNERS, command.program) ? PACKAGE_SCRIPT_RUNNERS[command.program]! : undefined;
  if (runner === undefined || command.dynamic === true) return undefined;
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  return command.program === "yarn" ? yarnScriptOf(runner, words) : managerScriptOf(runner, words);
}

/** A pick as a manager spells it, read into {@link WorkspacePicks}; `false` for one this does not read. */
function addPick(runner: PackageScriptRunner, picks: WorkspacePicks, value: string): boolean {
  if (runner.unreadPicks?.some((marker) => value.includes(marker)) === true) return false;
  const negated = value.startsWith("!");
  // pnpm's `{packages/app}` is a directory, written so it cannot be mistaken for a name.
  const bare = (negated ? value.slice(1) : value).replace(/^\{(.*)\}$/, "$1");
  if (bare === "") return false;
  (negated ? picks.excluded : picks.picked).push(bare);
  return true;
}

/** npm and pnpm: flags anywhere before `--` (pnpm's after the script's name are the script's), and the script's name among the words. */
function managerScriptOf(runner: PackageScriptRunner, words: readonly string[]): PackageScriptCall | undefined {
  const cut = words.indexOf("--");
  const head = cut < 0 ? words : words.slice(0, cut);
  const tail = cut < 0 ? [] : words.slice(cut + 1);
  const nameOf = (positionals: readonly string[]): { name: string; used: number } | undefined => {
    const first = positionals[0];
    if (first === undefined) return undefined;
    if (runner.run.includes(first)) return positionals[1] !== undefined ? { name: positionals[1], used: 2 } : undefined;
    if (Object.hasOwn(runner.named, first)) return { name: runner.named[first]!, used: 1 };
    if (runner.bare !== undefined && !runner.bare.includes(first)) return { name: first, used: 1 };
    return undefined;
  };
  const positionals: string[] = [];
  const passed: string[] = [];
  const picks: WorkspacePicks = { picked: [], all: false, root: false, excluded: [] };
  let rootOnly = false;
  let prefix: string | undefined;
  let ifPresent = false;
  const has = (list: readonly string[] | undefined, flag: string): boolean => list?.includes(flag) === true;
  for (let i = 0; i < head.length; i++) {
    const word = head[i]!;
    const named = nameOf(positionals) !== undefined;
    if (!isFlag(word)) {
      (named ? passed : positionals).push(word);
      continue;
    }
    // pnpm and yarn hand everything after the script's name to the script; npm keeps flags for itself.
    if (named && runner.passesArgs) {
      passed.push(word);
      continue;
    }
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const inline = eq > 0 ? word.slice(eq + 1) : undefined;
    const value = (): string | undefined => {
      const v = inline ?? head[++i];
      return v === undefined || isFlag(v) ? undefined : v;
    };
    const on = inline !== "false";
    if (has(runner.quiet, flag)) continue;
    if (has(runner.quietValued, flag)) {
      if (value() === undefined) return undefined;
      continue;
    }
    if (has(runner.ifPresent, flag)) ifPresent = on;
    else if (has(runner.workspace, flag)) {
      const v = value();
      if (v === undefined || !addPick(runner, picks, v)) return undefined;
    } else if (has(runner.allWorkspaces, flag)) {
      if (inline !== undefined && inline !== "true" && inline !== "false") return undefined;
      picks.all = on;
    } else if (has(runner.includeRoot, flag)) picks.root = on;
    else if (has(runner.rootOnly, flag)) rootOnly = on;
    else if (has(runner.prefix, flag)) {
      const v = value();
      if (v === undefined) return undefined;
      prefix = v;
    } else return undefined;
  }
  const found = nameOf(positionals);
  if (found === undefined) return undefined;
  if (rootOnly) {
    picks.root = true;
    picks.all = false;
    picks.picked = [];
  }
  const picking = picks.picked.length > 0 || picks.all || rootOnly;
  return {
    name: found.name,
    args: [...positionals.slice(found.used), ...passed, ...tail],
    ...(prefix !== undefined ? { prefix } : {}),
    ...(picking ? { workspaces: picks } : {}),
    // Several workspaces picked, pnpm passes over the ones without the script; one asked for by name, it fails.
    ifPresent: ifPresent || (picking && runner.skipsMissing === true && (picks.all || picks.picked.length !== 1 || /[*?]/.test(picks.picked[0]!))),
  };
}

/** `yarn foreach`'s own flags: those that take a value, and those that change nothing about what runs. */
const FOREACH_VALUED = ["-j", "--jobs"];
const FOREACH_QUIET = ["-p", "--parallel", "-i", "--interlaced", "-v", "--verbose", "-t", "--topological", "--topological-dev", "--no-private"];

/**
 * yarn: `workspace <name> <script>`, classic's `workspaces run <script>`, Berry's
 * `workspaces foreach [-A] [--include g] [--exclude g] run <script>` — subcommands rather than flags —
 * then the script as any yarn line names one. `--cwd <dir>` may come first.
 */
function yarnScriptOf(runner: PackageScriptRunner, words: readonly string[]): PackageScriptCall | undefined {
  let at = 0;
  let prefix: string | undefined;
  while (words[at] !== undefined && isFlag(words[at]!)) {
    const word = words[at]!;
    if (runner.quiet.includes(word)) at++;
    else if (runner.prefix?.includes(word) === true && words[at + 1] !== undefined) {
      prefix = words[at + 1];
      at += 2;
    } else if (word.startsWith("--cwd=")) {
      prefix = word.slice("--cwd=".length);
      at++;
    } else return undefined;
  }
  // A `--cwd` before the subcommand, and another after it, is two answers to one question.
  const withPrefix = (call: PackageScriptCall | undefined): PackageScriptCall | undefined => {
    if (call === undefined || prefix === undefined) return call;
    return call.prefix !== undefined ? undefined : { ...call, prefix };
  };
  const first = words[at];
  if (first === "workspace") {
    const name = words[at + 1];
    if (name === undefined || isFlag(name)) return undefined;
    const inner = managerScriptOf(runner, words.slice(at + 2));
    if (inner === undefined || inner.workspaces !== undefined) return undefined;
    return withPrefix({ ...inner, workspaces: { picked: [name], all: false, root: false, excluded: [] }, ifPresent: false });
  }
  if (first === "workspaces") {
    const verb = words[at + 1];
    if (verb === "run") {
      const inner = managerScriptOf(runner, words.slice(at + 1));
      if (inner === undefined || inner.workspaces !== undefined) return undefined;
      return withPrefix({ ...inner, workspaces: { picked: [], all: true, root: false, excluded: [] }, ifPresent: false });
    }
    if (verb !== "foreach") return undefined;
    const picks: WorkspacePicks = { picked: [], all: false, root: false, excluded: [] };
    let i = at + 2;
    for (; i < words.length && isFlag(words[i]!); i++) {
      const word = words[i]!;
      const eq = word.startsWith("--") ? word.indexOf("=") : -1;
      const flag = eq > 0 ? word.slice(0, eq) : word;
      const value = (): string | undefined => (eq > 0 ? word.slice(eq + 1) : words[++i]);
      if (flag === "-A" || flag === "--all" || flag === "-W" || flag === "--worktree") {
        // The whole project — the root is one of its workspaces.
        picks.all = true;
        picks.root = true;
      } else if (flag === "-R" || flag === "--recursive") {
        // This workspace and what it depends on: not read, so every workspace, which judges more, never less.
        picks.all = true;
        picks.root = true;
      } else if (flag === "--include" || flag === "--exclude") {
        const v = value();
        if (v === undefined) return undefined;
        (flag === "--include" ? picks.picked : picks.excluded).push(v);
      } else if (FOREACH_VALUED.includes(flag)) {
        if (value() === undefined) return undefined;
      } else if (!FOREACH_QUIET.includes(flag)) return undefined;
    }
    // `--include` narrows whatever `-A` named to the workspaces it matches.
    if (picks.picked.length > 0) {
      picks.all = false;
      picks.root = false;
    } else picks.all = true;
    const inner = managerScriptOf(runner, words.slice(i));
    if (inner === undefined || inner.workspaces !== undefined) return undefined;
    // `foreach run` passes over a workspace without the script.
    return withPrefix({ ...inner, workspaces: picks, ifPresent: true });
  }
  return withPrefix(managerScriptOf(runner, words.slice(at)));
}

// --- make's targets ----------------------------------------------------------------------------------

/** `make` asked to build targets: where, from which makefile, with what — what its dry run is asked. */
export interface MakeCall {
  /** Where it runs, as written (`-C sub`, several joined in order), when it was told. */
  dir?: string;
  /** The makefile it reads, as written (`-f build.mk`), when it was told. */
  makefile?: string;
  /** Its assignments (`V=1`) and targets, in order — passed to the dry run as they were written. */
  args: string[];
  /** The line is a dry run already (`make -n`): it prints what it would run, and runs nothing it prints. */
  dryRun: boolean;
}

/** Programs that are make. */
export const MAKE_PROGRAMS: readonly string[] = ["make", "gmake"];

/** Flags that change how make works but not what a recipe runs; those taking a value say so. */
const MAKE_QUIET = ["-s", "--silent", "--quiet", "-k", "--keep-going", "-S", "--no-keep-going", "--stop", "-w", "--print-directory", "--no-print-directory", "-r", "--no-builtin-rules", "-R", "--no-builtin-variables", "-B", "--always-make", "-i", "--ignore-errors", "-O", "--output-sync"];
const MAKE_DRY = ["-n", "--just-print", "--dry-run", "--recon"];
/** Variables that change the shell a printed line would run in, or make itself. */
const MAKE_SHELL_VARIABLES = ["SHELL", ".SHELLFLAGS", "MAKE", "MAKEFLAGS", "MFLAGS", "MAKEFILES", "MAKESHELL"];

/**
 * The make call a line is, or `undefined` when it cannot be read off the line: a flag this does not
 * model (`-t` touches the targets, `--eval` adds a rule, `-q`, `-p`), two makefiles, or an assignment
 * to the shell a printed line would run in (`SHELL=…`).
 */
export function makeCallOf(command: ParsedCommand): MakeCall | undefined {
  if (!MAKE_PROGRAMS.includes(command.program) || command.dynamic === true) return undefined;
  const words = (command.words ?? []).slice((command.programIndex ?? 0) + 1).map((w) => w.value);
  const args: string[] = [];
  const dirs: string[] = [];
  let makefile: string | undefined;
  let dryRun = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!isFlag(word)) {
      const assigned = /^([A-Za-z_.][A-Za-z0-9_.]*)\s*[:?+]?=/.exec(word);
      if (assigned !== null && MAKE_SHELL_VARIABLES.includes(assigned[1]!)) return undefined;
      args.push(word);
      continue;
    }
    const eq = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const inline = eq > 0 ? word.slice(eq + 1) : undefined;
    const value = (short: string): string | undefined => {
      if (inline !== undefined) return inline;
      if (word.length > short.length && word.startsWith(short) && !word.startsWith("--")) return word.slice(short.length);
      const next = words[++i];
      return next === undefined || isFlag(next) ? undefined : next;
    };
    if (flag === "-C" || flag === "--directory" || (word.startsWith("-C") && !word.startsWith("--"))) {
      const v = value("-C");
      if (v === undefined) return undefined;
      dirs.push(v);
    } else if (flag === "-f" || flag === "--file" || flag === "--makefile" || (word.startsWith("-f") && !word.startsWith("--"))) {
      const v = value("-f");
      if (v === undefined || makefile !== undefined) return undefined;
      makefile = v;
    } else if (flag === "-j" || flag === "--jobs" || /^-j\d+$/.test(word)) {
      // `-j 4`: the count is the next word when it is one.
      if (inline === undefined && word === "-j" && /^\d+$/.test(words[i + 1] ?? "")) i++;
    } else if (MAKE_DRY.includes(flag)) dryRun = true;
    else if (!MAKE_QUIET.includes(flag)) return undefined;
  }
  return { ...(dirs.length > 0 ? { dir: dirs.join("/") } : {}), ...(makefile !== undefined ? { makefile } : {}), args, dryRun };
}
