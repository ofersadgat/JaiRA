/**
 * What the composer's two cards DO to a permission set — every edit, as a pure function of the map.
 *
 * The Permissions and Tools cards are two views of one thing: the permission set the next message runs
 * under (decision 0007 §5). Permissions picks a whole one; Tools changes a line of it. Either way
 * what leaves the composer is the WHOLE map (`ChatSettings.permission set`), so every function here takes a
 * `Permission set` and returns the next one, and the component only draws and calls.
 *
 * Kept out of `composer.tsx` for the reason `taskAction.ts` is out of its view: there is no DOM
 * harness in this repository, so logic that lives in a component is logic nothing asserts.
 */
import {
  holdsTool,
  MODE_WHEN_UNSET,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  subjectKindOf,
  TOOL_SPEC_BY_NAME,
  toolsInCategory,
  isFunctionMode,
  sameMode,
  type PermissionSetMode,
  type PermissionSet,
  type PermissionSetEntry,
  type ToolCategoryId,
  type ToolImplementation,
} from "@jaira/shared/browser";

/**
 * What a line that is NOT held would run under if it were ticked.
 *
 * In a map, absent means not offered — so an unticked tool has nowhere in the permission set to keep a
 * mode. The card still shows one and still lets it be changed, because a control that blanks when
 * you untick loses what you had set; this is where that lives, for as long as the composer does. It
 * is never sent, and it is not a record of where the map came from.
 */
export type Parked = Readonly<Record<string, { mode?: PermissionSetMode; implementation?: ToolImplementation }>>;

/** A permission set of these entries — whatever the composer writes is a map. */
function edited(permissionSet: PermissionSet, entries: Record<string, PermissionSetEntry>, other = permissionSet.other): PermissionSet {
  return { entries, ...(other !== undefined ? { other } : {}) };
}

/** The mode a tool's line shows: its entry's when held, else what it would be ticked back to. */
export function toolModeOf(permissionSet: PermissionSet, parked: Parked, name: string): PermissionSetMode {
  const entry = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined;
  if (holdsTool(permissionSet, name)) return entry?.mode ?? MODE_WHEN_UNSET;
  return parked[name]?.mode ?? entry?.mode ?? MODE_WHEN_UNSET;
}

/** Whose code a tool's line shows — ours unless somebody chose the agent's. */
export function toolImplementationOf(permissionSet: PermissionSet, parked: Parked, name: string): ToolImplementation {
  const entry = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined;
  if (holdsTool(permissionSet, name)) return entry?.implementation ?? "app";
  return parked[name]?.implementation ?? entry?.implementation ?? "app";
}

/**
 * Tick or untick a tool. Unticking REMOVES its line — absent is how a map says not offered — and
 * ticking writes one with the mode and implementation the row was showing.
 */
export function withToolHeld(permissionSet: PermissionSet, parked: Parked, name: string, held: boolean): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (subject !== name) entries[subject] = entry;
  }
  if (held) {
    const implementation = toolImplementationOf(permissionSet, parked, name);
    entries[name] = { kind: "tool", mode: toolModeOf(permissionSet, parked, name), ...(implementation === "native" ? { implementation } : {}) };
  }
  return edited(permissionSet, entries);
}

/** Set the mode of a line the map HOLDS — a tool, a command subject or `script`. */
export function withSubjectMode(permissionSet: PermissionSet, subject: string, mode: PermissionSetMode): PermissionSet {
  const entry = Object.hasOwn(permissionSet.entries, subject) ? permissionSet.entries[subject] : undefined;
  if (entry === undefined) return permissionSet;
  const { offered: _offered, ...rest } = entry;
  return edited(permissionSet, { ...permissionSet.entries, [subject]: { ...rest, mode } });
}

/** Choose whose code runs a tool the map holds. */
export function withToolImplementation(permissionSet: PermissionSet, name: string, implementation: ToolImplementation): PermissionSet {
  const entry = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined;
  if (entry === undefined || entry.kind !== "tool") return permissionSet;
  const { implementation: _was, ...rest } = entry;
  return edited(permissionSet, { ...permissionSet.entries, [name]: { ...rest, ...(implementation === "native" ? { implementation } : {}) } });
}

/** Set the mode for everything no line names. */
export function withOther(permissionSet: PermissionSet, mode: PermissionSetMode): PermissionSet {
  return edited(permissionSet, { ...permissionSet.entries }, mode);
}

/** Drop one line — how a command subject, or `script`, is taken back out. */
export function withoutSubject(permissionSet: PermissionSet, subject: string): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [key, entry] of Object.entries(permissionSet.entries)) if (key !== subject) entries[key] = entry;
  return edited(permissionSet, entries);
}

/** Add (or re-mode) a command subject or `script`. */
export function withSubject(permissionSet: PermissionSet, subject: string, mode: PermissionSetMode): PermissionSet {
  const kind = subject === SCRIPT_SUBJECT ? "script" : "command";
  return edited(permissionSet, { ...permissionSet.entries, [subject]: { kind, mode } });
}

// --- Execution: the shell, `script`, and commands under their program ----------

/** One program the permission set names, and the subcommands of it that have a line of their own. */
export interface CommandGroup {
  /** `git` */
  program: string;
  /**
   * The mode of the entry for the BARE program (`"git": …`), which stands for any other `git`.
   * Absent when the permission set names only subcommands — any other `git` then falls to the shell's line.
   */
  own?: PermissionSetMode;
  /** `git status`, `git push --force` — in authored order. */
  subs: Array<{ subject: string; mode: PermissionSetMode }>;
}

/** The command subjects of a permission set, grouped under their program, programs in authored order. */
export function commandGroupsOf(permissionSet: PermissionSet): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "command") continue;
    const program = subject.split(" ")[0]!;
    const group = groups.get(program) ?? { program, subs: [] };
    groups.set(program, group);
    const mode = entry.mode ?? MODE_WHEN_UNSET;
    if (subject === program) group.own = mode;
    else group.subs.push({ subject, mode });
  }
  return [...groups.values()];
}

/** What any command with no line of its own answers to: the shell's line, then `other`. */
export function shellFallbackOf(permissionSet: PermissionSet): PermissionSetMode {
  const shell = Object.hasOwn(permissionSet.entries, SHELL_TOOL) ? permissionSet.entries[SHELL_TOOL] : undefined;
  return (shell !== undefined && holdsTool(permissionSet, SHELL_TOOL) ? shell.mode : undefined) ?? permissionSet.other ?? MODE_WHEN_UNSET;
}

/** The mode a program's group row shows: its own entry's, else what any other command of it gets. */
export function groupModeOf(permissionSet: PermissionSet, group: CommandGroup): PermissionSetMode {
  return group.own ?? shellFallbackOf(permissionSet);
}

/** What a mode does to a command, as the end of a sentence: `asks`, `is decided by smart`. */
function restVerb(mode: PermissionSetMode): string {
  if (isFunctionMode(mode)) return `is decided by ${mode.function}`;
  return { ask: "asks", allow: "is allowed", deny: "is refused" }[mode];
}

/** The sentence under an open group: `5 subcommands named; any other git asks`. */
export function groupSentence(permissionSet: PermissionSet, group: CommandGroup): string {
  const rest = `any other ${group.program} ${restVerb(groupModeOf(permissionSet, group))}`;
  if (group.subs.length === 0) return `every ${group.program} command — ${rest.slice("any other ".length)}`;
  return `${group.subs.length} ${group.subs.length === 1 ? "subcommand" : "subcommands"} named; ${rest}`;
}

/** The line under a CLOSED group: what it names, without the program repeated. */
export function groupSummary(permissionSet: PermissionSet, group: CommandGroup): string {
  if (group.subs.length === 0) return groupSentence(permissionSet, group);
  return group.subs.map((sub) => sub.subject.slice(group.program.length + 1)).join(" · ");
}

/**
 * What was typed into "add a command" / "add a git subcommand", as the subject it names.
 *
 * Inside a group the program is implied, and typing it again is forgiven (`git push` under `git` is
 * `git push`, not `git git push`). The result has to be something the permission set reader would call a
 * COMMAND — not a tool's name, not `other`, not `script` (which has a row of its own) — or the
 * reason it is not comes back instead.
 */
export function commandSubjectOf(typed: string, program?: string): { subject: string } | { problem: string } {
  const words = typed.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return { problem: program === undefined ? "name a command, like terraform plan" : `name a ${program} subcommand, like push` };
  const subject = (program !== undefined && words[0] !== program ? [program, ...words] : words).join(" ");
  const kind = subjectKindOf(subject);
  if (kind === "command") return { subject };
  if (kind === "tool") return { problem: `'${subject}' is a tool — it has a line of its own above` };
  if (kind === "script") return { problem: "'script' has a line of its own above" };
  if (kind === "other") return { problem: "'other' is the last line of the card" };
  return { problem: `'${subject}' does not read as a command — a program is lowercase, like git or apt-get` };
}

/** Add a command line, at the mode that already answers for it — so adding it changes nothing yet. */
export function withCommand(permissionSet: PermissionSet, subject: string): PermissionSet {
  if (Object.hasOwn(permissionSet.entries, subject)) return permissionSet;
  const program = subject.split(" ")[0]!;
  const group = commandGroupsOf(permissionSet).find((g) => g.program === program);
  return withSubject(permissionSet, subject, group !== undefined ? groupModeOf(permissionSet, group) : shellFallbackOf(permissionSet));
}

// --- a permission set on the page: what a section does not hold yet --------------------
//
// The composer lists every tool and ticks the held ones. Settings → Permission sets and the state editor's
// Tools field list what a permission set HOLDS, and reach the rest through each section's last line
// (decision 0007 §6). These say what that line's menu offers, and what its minus takes away.

/** The tools of a section the permission set does not hold, in the section's own order. */
export function addableTools(permissionSet: PermissionSet, category: ToolCategoryId, offered?: readonly string[]): string[] {
  const known = offered === undefined ? undefined : new Set(offered);
  return toolsInCategory(category)
    .map((spec) => spec.name)
    .filter((name) => (known === undefined || known.has(name)) && !holdsTool(permissionSet, name));
}

/** `script`, when the permission set has no line for it — Execution's one subject that is neither tool nor command. */
export function addableScript(permissionSet: PermissionSet): boolean {
  return !Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT);
}

/**
 * The subcommands people give a line of their own, for the programs they most often name.
 *
 * SUGGESTIONS and nothing else: the menu's last row takes anything typed, no entry here means a
 * program is known or allowed, and a program that is not listed simply opens on the box. Kept short
 * on purpose — a menu of forty `git` verbs is a list nobody reads.
 */
export const COMMON_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  git: ["status", "log", "diff", "show", "add", "commit", "push", "pull", "fetch", "checkout", "rm"],
  npm: ["install", "ci", "test", "run", "publish"],
  pnpm: ["install", "test", "run", "publish"],
  yarn: ["install", "test", "run"],
  docker: ["ps", "build", "run", "exec", "push"],
  gh: ["pr", "issue", "repo", "api"],
  cargo: ["build", "test", "run", "publish"],
  terraform: ["plan", "apply", "destroy"],
  kubectl: ["get", "describe", "apply", "delete"],
};

/** The suggested subcommands of a program the permission set has no line for yet, as whole subjects. */
export function suggestedSubcommands(permissionSet: PermissionSet, program: string): string[] {
  return (COMMON_SUBCOMMANDS[program] ?? []).map((sub) => `${program} ${sub}`).filter((subject) => !Object.hasOwn(permissionSet.entries, subject));
}

/** The programs worth offering by name that the permission set names no command of. */
export function suggestedPrograms(permissionSet: PermissionSet): string[] {
  const named = new Set(commandGroupsOf(permissionSet).map((group) => group.program));
  return Object.keys(COMMON_SUBCOMMANDS).filter((program) => !named.has(program));
}

/** Take a whole PROGRAM out: its own line and every subcommand under it — the group's minus. */
export function withoutProgram(permissionSet: PermissionSet, program: string): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "command" && subject.split(" ")[0] === program) continue;
    entries[subject] = entry;
  }
  return edited(permissionSet, entries);
}

// --- sections -----------------------------------------------------------------

/** Every line a section's own mode button reads and writes, as `[subject, mode]`. */
function sectionLines(permissionSet: PermissionSet, parked: Parked, category: ToolCategoryId): Array<[string, PermissionSetMode]> {
  const lines: Array<[string, PermissionSetMode]> = toolsInCategory(category).map((spec) => [spec.name, toolModeOf(permissionSet, parked, spec.name)]);
  if (category !== "execution") return lines;
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "tool") lines.push([subject, entry.mode ?? MODE_WHEN_UNSET]);
  }
  return lines;
}

/**
 * What a section reads as: the mode its lines share, or `undefined` — drawn `custom` — when they
 * do not. Execution's lines are the shell, `script` when held, and every command the permission set names.
 */
export function sectionModeOf(permissionSet: PermissionSet, parked: Parked, category: ToolCategoryId): PermissionSetMode | undefined {
  const lines = sectionLines(permissionSet, parked, category);
  if (lines.length === 0) return undefined;
  return lines.every(([, mode]) => sameMode(mode, lines[0]![1])) ? lines[0]![1] : undefined;
}

/**
 * Write one mode onto every line of a section. A held line changes in the map; a tool that is not
 * held changes where its would-be mode is kept — see {@link Parked}.
 */
export function withSectionMode(
  permissionSet: PermissionSet,
  parked: Parked,
  category: ToolCategoryId,
  mode: PermissionSetMode,
): { permissionSet: PermissionSet; parked: Parked } {
  let next = permissionSet;
  const nextParked: Record<string, { mode?: PermissionSetMode; implementation?: ToolImplementation }> = { ...parked };
  for (const [subject] of sectionLines(permissionSet, parked, category)) {
    const isTool = TOOL_SPEC_BY_NAME.has(subject);
    if (!isTool || holdsTool(permissionSet, subject)) next = withSubjectMode(next, subject, mode);
    else nextParked[subject] = { ...nextParked[subject], mode };
  }
  return { permissionSet: next, parked: nextParked };
}

/**
 * How many lines of a section are held — the number in its badge. A program counts its named
 * subcommands, as its own badge does; one named only as a whole (`"terraform": …`) counts once.
 */
export function sectionCountOf(permissionSet: PermissionSet, category: ToolCategoryId): number {
  const tools = toolsInCategory(category).filter((spec) => holdsTool(permissionSet, spec.name)).length;
  if (category !== "execution") return tools;
  const script = Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT) ? 1 : 0;
  return tools + script + commandGroupsOf(permissionSet).reduce((n, group) => n + Math.max(group.subs.length, 1), 0);
}
