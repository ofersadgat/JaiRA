/**
 * What the composer's two cards DO to a toolset — every edit, as a pure function of the map.
 *
 * The Permissions and Tools cards are two views of one thing: the toolset the next message runs
 * under (decision 0007 §5). Permissions picks a whole one; Tools changes a line of it. Either way
 * what leaves the composer is the WHOLE map (`ChatSettings.toolset`), so every function here takes a
 * `Toolset` and returns the next one, and the component only draws and calls.
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
  type PermissionMode,
  type Toolset,
  type ToolsetEntry,
  type ToolCategoryId,
  type ToolImplementation,
} from "@jaira/shared/browser";

/**
 * What a line that is NOT held would run under if it were ticked.
 *
 * In a map, absent means not offered — so an unticked tool has nowhere in the toolset to keep a
 * mode. The card still shows one and still lets it be changed, because a control that blanks when
 * you untick loses what you had set; this is where that lives, for as long as the composer does. It
 * is never sent, and it is not a record of where the map came from.
 */
export type Parked = Readonly<Record<string, { mode?: PermissionMode; implementation?: ToolImplementation }>>;

/** The map with its legacy mark dropped: whatever the composer writes is a MAP. */
function edited(toolset: Toolset, entries: Record<string, ToolsetEntry>, other = toolset.other): Toolset {
  return { entries, ...(other !== undefined ? { other } : {}) };
}

/** The mode a tool's line shows: its entry's when held, else what it would be ticked back to. */
export function toolModeOf(toolset: Toolset, parked: Parked, name: string): PermissionMode {
  const entry = Object.hasOwn(toolset.entries, name) ? toolset.entries[name] : undefined;
  if (holdsTool(toolset, name)) return entry?.mode ?? MODE_WHEN_UNSET;
  return parked[name]?.mode ?? entry?.mode ?? MODE_WHEN_UNSET;
}

/** Whose code a tool's line shows — ours unless somebody chose the agent's. */
export function toolImplementationOf(toolset: Toolset, parked: Parked, name: string): ToolImplementation {
  const entry = Object.hasOwn(toolset.entries, name) ? toolset.entries[name] : undefined;
  if (holdsTool(toolset, name)) return entry?.implementation ?? "app";
  return parked[name]?.implementation ?? entry?.implementation ?? "app";
}

/**
 * Tick or untick a tool. Unticking REMOVES its line — absent is how a map says not offered — and
 * ticking writes one with the mode and implementation the row was showing.
 */
export function withToolHeld(toolset: Toolset, parked: Parked, name: string, held: boolean): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (subject !== name) entries[subject] = entry;
  }
  if (held) {
    const implementation = toolImplementationOf(toolset, parked, name);
    entries[name] = { kind: "tool", mode: toolModeOf(toolset, parked, name), ...(implementation === "native" ? { implementation } : {}) };
  }
  return edited(toolset, entries);
}

/** Set the mode of a line the map HOLDS — a tool, a command subject or `script`. */
export function withSubjectMode(toolset: Toolset, subject: string, mode: PermissionMode): Toolset {
  const entry = Object.hasOwn(toolset.entries, subject) ? toolset.entries[subject] : undefined;
  if (entry === undefined) return toolset;
  const { offered: _offered, ...rest } = entry;
  return edited(toolset, { ...toolset.entries, [subject]: { ...rest, mode } });
}

/** Choose whose code runs a tool the map holds. */
export function withToolImplementation(toolset: Toolset, name: string, implementation: ToolImplementation): Toolset {
  const entry = Object.hasOwn(toolset.entries, name) ? toolset.entries[name] : undefined;
  if (entry === undefined || entry.kind !== "tool") return toolset;
  const { implementation: _was, ...rest } = entry;
  return edited(toolset, { ...toolset.entries, [name]: { ...rest, ...(implementation === "native" ? { implementation } : {}) } });
}

/** Set the mode for everything no line names. */
export function withOther(toolset: Toolset, mode: PermissionMode): Toolset {
  return edited(toolset, { ...toolset.entries }, mode);
}

/** Drop one line — how a command subject, or `script`, is taken back out. */
export function withoutSubject(toolset: Toolset, subject: string): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  for (const [key, entry] of Object.entries(toolset.entries)) if (key !== subject) entries[key] = entry;
  return edited(toolset, entries);
}

/** Add (or re-mode) a command subject or `script`. */
export function withSubject(toolset: Toolset, subject: string, mode: PermissionMode): Toolset {
  const kind = subject === SCRIPT_SUBJECT ? "script" : "command";
  return edited(toolset, { ...toolset.entries, [subject]: { kind, mode } });
}

// --- Execution: the shell, `script`, and commands under their program ----------

/** One program the toolset names, and the subcommands of it that have a line of their own. */
export interface CommandGroup {
  /** `git` */
  program: string;
  /**
   * The mode of the entry for the BARE program (`"git": …`), which stands for any other `git`.
   * Absent when the toolset names only subcommands — any other `git` then falls to the shell's line.
   */
  own?: PermissionMode;
  /** `git status`, `git push --force` — in authored order. */
  subs: Array<{ subject: string; mode: PermissionMode }>;
}

/** The command subjects of a toolset, grouped under their program, programs in authored order. */
export function commandGroupsOf(toolset: Toolset): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const [subject, entry] of Object.entries(toolset.entries)) {
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
export function shellFallbackOf(toolset: Toolset): PermissionMode {
  const shell = Object.hasOwn(toolset.entries, SHELL_TOOL) ? toolset.entries[SHELL_TOOL] : undefined;
  return (shell !== undefined && holdsTool(toolset, SHELL_TOOL) ? shell.mode : undefined) ?? toolset.other ?? MODE_WHEN_UNSET;
}

/** The mode a program's group row shows: its own entry's, else what any other command of it gets. */
export function groupModeOf(toolset: Toolset, group: CommandGroup): PermissionMode {
  return group.own ?? shellFallbackOf(toolset);
}

const REST_VERBS: Readonly<Record<PermissionMode, string>> = {
  ask: "asks",
  allow: "is allowed",
  deny: "is refused",
  smart: "goes to the approver",
};

/** The sentence under an open group: `5 subcommands named; any other git asks`. */
export function groupSentence(toolset: Toolset, group: CommandGroup): string {
  const rest = `any other ${group.program} ${REST_VERBS[groupModeOf(toolset, group)]}`;
  if (group.subs.length === 0) return `every ${group.program} command — ${rest.slice("any other ".length)}`;
  return `${group.subs.length} ${group.subs.length === 1 ? "subcommand" : "subcommands"} named; ${rest}`;
}

/** The line under a CLOSED group: what it names, without the program repeated. */
export function groupSummary(toolset: Toolset, group: CommandGroup): string {
  if (group.subs.length === 0) return groupSentence(toolset, group);
  return group.subs.map((sub) => sub.subject.slice(group.program.length + 1)).join(" · ");
}

/**
 * What was typed into "add a command" / "add a git subcommand", as the subject it names.
 *
 * Inside a group the program is implied, and typing it again is forgiven (`git push` under `git` is
 * `git push`, not `git git push`). The result has to be something the toolset reader would call a
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
export function withCommand(toolset: Toolset, subject: string): Toolset {
  if (Object.hasOwn(toolset.entries, subject)) return toolset;
  const program = subject.split(" ")[0]!;
  const group = commandGroupsOf(toolset).find((g) => g.program === program);
  return withSubject(toolset, subject, group !== undefined ? groupModeOf(toolset, group) : shellFallbackOf(toolset));
}

// --- a toolset on the page: what a section does not hold yet --------------------
//
// The composer lists every tool and ticks the held ones. Settings → Toolsets and the state editor's
// Tools field list what a toolset HOLDS, and reach the rest through each section's last line
// (decision 0007 §6). These say what that line's menu offers, and what its minus takes away.

/** The tools of a section the toolset does not hold, in the section's own order. */
export function addableTools(toolset: Toolset, category: ToolCategoryId, offered?: readonly string[]): string[] {
  const known = offered === undefined ? undefined : new Set(offered);
  return toolsInCategory(category)
    .map((spec) => spec.name)
    .filter((name) => (known === undefined || known.has(name)) && !holdsTool(toolset, name));
}

/** `script`, when the toolset has no line for it — Execution's one subject that is neither tool nor command. */
export function addableScript(toolset: Toolset): boolean {
  return !Object.hasOwn(toolset.entries, SCRIPT_SUBJECT);
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

/** The suggested subcommands of a program the toolset has no line for yet, as whole subjects. */
export function suggestedSubcommands(toolset: Toolset, program: string): string[] {
  return (COMMON_SUBCOMMANDS[program] ?? []).map((sub) => `${program} ${sub}`).filter((subject) => !Object.hasOwn(toolset.entries, subject));
}

/** The programs worth offering by name that the toolset names no command of. */
export function suggestedPrograms(toolset: Toolset): string[] {
  const named = new Set(commandGroupsOf(toolset).map((group) => group.program));
  return Object.keys(COMMON_SUBCOMMANDS).filter((program) => !named.has(program));
}

/** Take a whole PROGRAM out: its own line and every subcommand under it — the group's minus. */
export function withoutProgram(toolset: Toolset, program: string): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "command" && subject.split(" ")[0] === program) continue;
    entries[subject] = entry;
  }
  return edited(toolset, entries);
}

// --- sections -----------------------------------------------------------------

/** Every line a section's own mode button reads and writes, as `[subject, mode]`. */
function sectionLines(toolset: Toolset, parked: Parked, category: ToolCategoryId): Array<[string, PermissionMode]> {
  const lines: Array<[string, PermissionMode]> = toolsInCategory(category).map((spec) => [spec.name, toolModeOf(toolset, parked, spec.name)]);
  if (category !== "execution") return lines;
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (entry.kind !== "tool") lines.push([subject, entry.mode ?? MODE_WHEN_UNSET]);
  }
  return lines;
}

/**
 * What a section reads as: the mode its lines share, or `undefined` — drawn `custom` — when they
 * do not. Execution's lines are the shell, `script` when held, and every command the toolset names.
 */
export function sectionModeOf(toolset: Toolset, parked: Parked, category: ToolCategoryId): PermissionMode | undefined {
  const lines = sectionLines(toolset, parked, category);
  if (lines.length === 0) return undefined;
  return lines.every(([, mode]) => mode === lines[0]![1]) ? lines[0]![1] : undefined;
}

/**
 * Write one mode onto every line of a section. A held line changes in the map; a tool that is not
 * held changes where its would-be mode is kept — see {@link Parked}.
 */
export function withSectionMode(
  toolset: Toolset,
  parked: Parked,
  category: ToolCategoryId,
  mode: PermissionMode,
): { toolset: Toolset; parked: Parked } {
  let next = toolset;
  const nextParked: Record<string, { mode?: PermissionMode; implementation?: ToolImplementation }> = { ...parked };
  for (const [subject] of sectionLines(toolset, parked, category)) {
    const isTool = TOOL_SPEC_BY_NAME.has(subject);
    if (!isTool || holdsTool(toolset, subject)) next = withSubjectMode(next, subject, mode);
    else nextParked[subject] = { ...nextParked[subject], mode };
  }
  return { toolset: next, parked: nextParked };
}

/**
 * How many lines of a section are held — the number in its badge. A program counts its named
 * subcommands, as its own badge does; one named only as a whole (`"terraform": …`) counts once.
 */
export function sectionCountOf(toolset: Toolset, category: ToolCategoryId): number {
  const tools = toolsInCategory(category).filter((spec) => holdsTool(toolset, spec.name)).length;
  if (category !== "execution") return tools;
  const script = Object.hasOwn(toolset.entries, SCRIPT_SUBJECT) ? 1 : 0;
  return tools + script + commandGroupsOf(toolset).reduce((n, group) => n + Math.max(group.subs.length, 1), 0);
}
