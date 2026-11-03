/**
 * What the composer's two cards DO to a permission set — every edit, as a pure function of the map.
 *
 * The Permissions and Tools cards are two views of one thing: the permission set the next message runs
 * under (decision 0007 §5). Permissions picks a whole one; Tools changes a line of it. Either way
 * what leaves the composer is the WHOLE map (`ChatSettings.permission set`), so every function here takes a
 * `Permission set` and returns the next one, and the component only draws and calls.
 *
 * Kept out of the component for the reason `taskAction.ts` is out of its view: there is no DOM
 * harness in this repository, so logic that lives in a component is logic nothing asserts.
 */
import {
  COMMAND_RUNNERS,
  RUNNER_GROUP_SUBJECT,
  runnerSubject,
  holdsTool,
  MODE_WHEN_UNSET,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  subjectKindOf,
  TOOL_SPEC_BY_NAME,
  toolsInCategory,
  isFunctionMode,
  sameMode,
  PLACE_ANYWHERE,
  placeKindOf,
  placesMostSpecificFirst,
  parseRunnerSubject,
  SCRIPT_EXTENSIONS,
  SCRIPT_INTERPRETERS,
  SCRIPT_RUNNERS,
  type PermissionSetMode,
  type PermissionSet,
  type PermissionSetEntry,
  type PlaceKind,
  type ToolCategoryId,
  type ToolImplementation,
} from "@jaira/shared/browser";
import { CREDENTIAL_PLACES, NAMED_PLACE_WORDS, placeExample, placeGlyphOf, placeNoun } from "./permissionSetWords";

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

/**
 * Set the mode of a line the map HOLDS — a tool, a command subject or `script`. On a line with places
 * this is its own mode, the map's `**` (decision 0023 §4.2: the head's mode button); its places stay.
 * On an `unavailable` line it offers the tool again, at that mode.
 */
export function withSubjectMode(permissionSet: PermissionSet, subject: string, mode: PermissionSetMode): PermissionSet {
  const entry = Object.hasOwn(permissionSet.entries, subject) ? permissionSet.entries[subject] : undefined;
  if (entry === undefined) return permissionSet;
  const { offered: _offered, unavailable: _unavailable, ...rest } = entry;
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

/** Add (or re-mode) a command subject, a runner's line, or `script`. */
export function withSubject(permissionSet: PermissionSet, subject: string, mode: PermissionSetMode): PermissionSet {
  const read = subjectKindOf(subject);
  const kind = read === "script" || read === "runner" ? read : "command";
  return edited(permissionSet, { ...permissionSet.entries, [subject]: { kind, mode } });
}

// --- Execution: the command runners' gate ------------------------------------------------------------

/** One command runner as its row reads: its own line's mode, or none — then the group's answers for it. */
export interface RunnerRow {
  program: string;
  hint: string;
  /** The mode of its own `runner:<program>` line, when it has one. */
  own?: PermissionSetMode;
  /** Its own line names places (decision 0023 §3) — a line of its own even where it has no mode. */
  placed?: true;
}

/** Whether the permission set has any runner line — the group is drawn only then. */
export function holdsRunners(permissionSet: PermissionSet): boolean {
  return Object.values(permissionSet.entries).some((entry) => entry.kind === "runner");
}

/** The group's own line (`runner:*`), when written. */
export function runnerGroupModeOf(permissionSet: PermissionSet): PermissionSetMode | undefined {
  return Object.hasOwn(permissionSet.entries, RUNNER_GROUP_SUBJECT) ? permissionSet.entries[RUNNER_GROUP_SUBJECT]!.mode : undefined;
}

/** Every command runner, in the order they are listed, each with its own line's mode where it has one. */
export function runnerRowsOf(permissionSet: PermissionSet): RunnerRow[] {
  return COMMAND_RUNNERS.map((runner) => {
    const line = runnerSubject(runner.program);
    const entry = Object.hasOwn(permissionSet.entries, line) ? permissionSet.entries[line]! : undefined;
    const own = entry?.mode;
    const placed = Object.keys(entry?.places ?? {}).length > 0;
    return { program: runner.program, hint: runner.hint, ...(own !== undefined ? { own } : {}), ...(placed ? { placed: true as const } : {}) };
  });
}

/** What a runner with no line of its own gets: the group's line, else — no gate — what any command gets. */
export function runnerFallbackOf(permissionSet: PermissionSet): PermissionSetMode {
  return runnerGroupModeOf(permissionSet) ?? shellFallbackOf(permissionSet);
}

/** Take every runner line out — the group's minus: runners are no longer gated at all. */
export function withoutRunners(permissionSet: PermissionSet): PermissionSet {
  return edited(permissionSet, Object.fromEntries(Object.entries(permissionSet.entries).filter(([, entry]) => entry.kind !== "runner")));
}

/** Gate the runners: the group's line, at `ask` — the Execution add-menu's "Command runners". */
export function withRunners(permissionSet: PermissionSet): PermissionSet {
  return holdsRunners(permissionSet) ? permissionSet : withSubject(permissionSet, RUNNER_GROUP_SUBJECT, MODE_WHEN_UNSET);
}

// --- Execution: the shell, `script`, and commands under their program ----------

/** One program the permission set names, and the subcommands of it that have a line of their own. */
export interface CommandGroup {
  /** `git` */
  program: string;
  /**
   * The mode of the entry for the BARE program (`"git": …`), which stands for any other `git` — on a
   * line with places, its `**` (decision 0023 §4.2), absent where it has none.
   * Absent when the permission set names only subcommands — any other `git` then falls to the shell's line.
   */
  own?: PermissionSetMode;
  /** The bare program's line names places (§3.4): a line of its own even where it has no mode. */
  placed?: true;
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
    const placed = Object.keys(entry.places ?? {}).length > 0;
    if (subject === program) {
      // A place map speaks only at its places: with no `**` the line says nothing elsewhere.
      if (placed) group.placed = true;
      if (entry.mode !== undefined || !placed) group.own = entry.mode ?? MODE_WHEN_UNSET;
    } else group.subs.push({ subject, mode: entry.mode ?? MODE_WHEN_UNSET });
  }
  return [...groups.values()];
}

/** Does the set write a line for the bare program — with a mode, places, or both? */
export function holdsProgramLine(group: CommandGroup): boolean {
  return group.own !== undefined || group.placed === true;
}

/**
 * What a program's head reads, as a line on the card does (§4.2) — it claims no mode the set does not
 * write. Its own mode where the bare program has one (a placed line's `**`); else, with places,
 * `elsewhere: as {line}`; else — no line of its own — `as {line}`, the less specific line of this set
 * any other command of it falls to, or `not written` where this set says nothing there and what the
 * sets under it say answers (§2.3). `follows` draws it faded, as a line that answers to another.
 */
export interface GroupHead {
  mode?: PermissionSetMode;
  label?: string;
  follows: boolean;
  /** The words under the button, on hover. */
  title: string;
}

/** {@link GroupHead} of a group. */
export function groupHeadOf(permissionSet: PermissionSet, group: CommandGroup): GroupHead {
  const { program } = group;
  if (group.own !== undefined) return { mode: group.own, follows: false, title: `${program}: any ${program} command not named under it` };
  const below = elsewhereOf(permissionSet, program);
  const falls = below !== undefined ? `${below.line}'s, which ${restVerb(below.mode)}` : "what the sets under this one say";
  if (group.placed === true) return { label: elsewhereLabel(permissionSet, program), follows: true, title: `${program}: at none of its places, ${falls}` };
  return { label: below !== undefined ? `as ${below.line}` : "not written", follows: true, title: `${program}: no line of its own here — any other ${program} is ${falls}` };
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

/** How many places the bare program's line names, and the noun for them: `1 place`. */
function programPlacesNoun(permissionSet: PermissionSet, group: CommandGroup): string {
  return placeNoun(linePlaceKindOf(group.program) ?? "path", placeCountOf(permissionSet, group.program));
}

/**
 * The sentence under an open group: `5 subcommands named; any other git asks`. A bare program with
 * places says them (§4.2): `every git command — 1 place; elsewhere, what the sets under it say`. One
 * with no line of its own, in a set that says nothing where it falls, says so: `any other npm falls
 * through to the sets under it` (§2.3).
 */
export function groupSentence(permissionSet: PermissionSet, group: CommandGroup): string {
  const { program } = group;
  const rest =
    group.placed === true
      ? `any other ${program}: ${placesSentence(permissionSet, program, programPlacesNoun(permissionSet, group))}`
      : group.own === undefined && elsewhereOf(permissionSet, program) === undefined
        ? `any other ${program} falls through to the sets under it`
        : `any other ${program} ${restVerb(groupModeOf(permissionSet, group))}`;
  if (group.subs.length === 0) return group.placed === true ? `every ${program} command — ${rest.slice(`any other ${program}: `.length)}` : `every ${program} command — ${rest.slice("any other ".length)}`;
  return `${group.subs.length} ${group.subs.length === 1 ? "subcommand" : "subcommands"} named; ${rest}`;
}

/** The line under a CLOSED group: what it names, without the program repeated — a placed bare line's count first. */
export function groupSummary(permissionSet: PermissionSet, group: CommandGroup): string {
  const placed = group.placed === true ? programPlacesNoun(permissionSet, group) : undefined;
  if (group.subs.length === 0) return placed !== undefined ? `every ${group.program} command — ${placed}` : groupSentence(permissionSet, group);
  const subs = group.subs.map((sub) => sub.subject.slice(group.program.length + 1)).join(" · ");
  return placed !== undefined ? `${placed} · ${subs}` : subs;
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
  if (kind === "runner") return { problem: `'${subject}' is a runner's line — it has a row under Command runners` };
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
    .filter((name) => (known === undefined || known.has(name)) && !holdsTool(permissionSet, name) && !isUnavailableLine(permissionSet, name));
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
    if (entry.kind === "command" || entry.kind === "script" || entry.kind === "runner") lines.push([subject, entry.mode ?? MODE_WHEN_UNSET]);
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
  // An MCP server's line and each tool it names — the MCP section holds no standard tools.
  if (category === "mcp") return tools + Object.values(permissionSet.entries).filter((entry) => entry.kind === "mcp").length;
  if (category !== "execution") return tools;
  const script = Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT) ? 1 : 0;
  const runners = Object.values(permissionSet.entries).filter((entry) => entry.kind === "runner").length;
  return tools + script + runners + commandGroupsOf(permissionSet).reduce((n, group) => n + Math.max(group.subs.length, 1), 0);
}

/**
 * How many lines a section WRITES, as a permission set being edited counts them: {@link sectionCountOf},
 * and a tool line that says `unavailable` — it is a line of the set, a statement about the layers below
 * (decision 0023 §1), though it holds nothing.
 */
export function writtenCountOf(permissionSet: PermissionSet, category: ToolCategoryId): number {
  return sectionCountOf(permissionSet, category) + toolsInCategory(category).filter((spec) => isUnavailableLine(permissionSet, spec.name)).length;
}

// --- `unavailable` (decision 0023 §1) ----------------------------------------------------------------

/** Does this line say `unavailable` — the model is not handed the tool? */
export function isUnavailableLine(permissionSet: PermissionSet, subject: string): boolean {
  return Object.hasOwn(permissionSet.entries, subject) && permissionSet.entries[subject]!.unavailable === true;
}

/** Can a line of this subject say `unavailable`? A tool (the shell among them) and an MCP line; never a command, a runner, `script` or `other`. */
export function canBeUnavailable(subject: string): boolean {
  const kind = subjectKindOf(subject);
  return kind === "tool" || kind === "mcp";
}

/**
 * Make a line `unavailable`: the model is not handed the tool. Its mode, its places and whose code ran
 * it go with it — there is nothing left to run. Written for a tool or an MCP line, held or not; any
 * other subject is left as it was, since it cannot say this.
 */
export function withUnavailable(permissionSet: PermissionSet, subject: string): PermissionSet {
  if (!canBeUnavailable(subject)) return permissionSet;
  const kind = subjectKindOf(subject) === "mcp" ? "mcp" : "tool";
  return edited(permissionSet, { ...permissionSet.entries, [subject]: { kind, unavailable: true } });
}

// --- places on a line (decision 0023 §3, §4.2) ------------------------------------------------------

/**
 * The kind of place a line on the card takes (`placeKindOf`), or `undefined` where the card offers no
 * place: a line whose calls name none (`web_search`), `other`, and an MCP line — whose place is the
 * standard tool's the configuration maps it to, which a set alone cannot say.
 */
export function linePlaceKindOf(subject: string): PlaceKind | undefined {
  return subjectKindOf(subject) === "mcp" ? undefined : placeKindOf(subject);
}

/** One place of a line, as its row draws it. `anywhere` is the line's own mode, its `**`. */
export interface PlaceRow {
  place: string;
  mode: PermissionSetMode;
  anywhere: boolean;
}

const entryOf = (permissionSet: PermissionSet, subject: string): PermissionSetEntry | undefined =>
  Object.hasOwn(permissionSet.entries, subject) ? permissionSet.entries[subject] : undefined;

/** The places a line names other than `**` — the count in its head. */
export function placeCountOf(permissionSet: PermissionSet, subject: string): number {
  return Object.keys(entryOf(permissionSet, subject)?.places ?? {}).length;
}

/**
 * A line's places, most specific first (`placesMostSpecificFirst`), with its `**` last where it has
 * one — empty for a line with no places, whose own mode is the whole of it.
 */
export function placeRowsOf(permissionSet: PermissionSet, subject: string): PlaceRow[] {
  const entry = entryOf(permissionSet, subject);
  const places = entry?.places ?? {};
  if (entry === undefined || Object.keys(places).length === 0) return [];
  const kind = linePlaceKindOf(subject) ?? "path";
  const rows: PlaceRow[] = placesMostSpecificFirst(kind, Object.keys(places)).map((place) => ({ place, mode: places[place]!, anywhere: false }));
  if (entry.mode !== undefined) rows.push({ place: PLACE_ANYWHERE, mode: entry.mode, anywhere: true });
  return rows;
}

/**
 * Does this command line RUN A FILE — a package script, `make`, an interpreter given a file, a path to
 * one — so that, where none of its places match, it is `script`'s before it is the shell's (§3.4,
 * `lookUp` in `@jaira/runtime`)? Read off the line's words alone, as the card reads a line and not a
 * call: `npm run build`, `make test`, `python x.py`, `./build.sh`.
 */
export function runsAFile(subject: string): boolean {
  const words = subject.trim().split(/\s+/);
  const program = words[0] ?? "";
  if (program.startsWith("./") || program.startsWith(".\\") || SCRIPT_EXTENSIONS.some((ext) => program.toLowerCase().endsWith(ext))) return true;
  const runner = SCRIPT_RUNNERS.find((one) => one.program === program);
  if (runner !== undefined) return runner.subcommands === undefined || (words[1] !== undefined && runner.subcommands.includes(words[1]));
  return Object.hasOwn(SCRIPT_INTERPRETERS, program) && words.length > 1;
}

/**
 * The line a call none of `subject`'s places match falls to, WITHIN this set, and what it says (§3.4) —
 * the next less specific line with a mode of its own: a command's shorter commands, then `script` for
 * one that runs a file, then the shell; then `other`. A runner's line falls to the group's (`runner:*`)
 * and no further.
 * `undefined` when this set says nothing there, and what the sets under it say answers — a layer that
 * writes no `other` (§2.3).
 */
export function elsewhereOf(permissionSet: PermissionSet, subject: string): { line: string; mode: PermissionSetMode } | undefined {
  const chain: string[] = [];
  const kind = subjectKindOf(subject);
  if (kind === "command") {
    const words = subject.split(" ");
    for (let n = words.length - 1; n >= 1; n--) chain.push(words.slice(0, n).join(" "));
    if (runsAFile(subject)) chain.push(SCRIPT_SUBJECT);
    chain.push(SHELL_TOOL);
  } else if (kind === "script") chain.push(SHELL_TOOL);
  else if (kind === "runner") {
    if (parseRunnerSubject(subject)?.program !== undefined) chain.push(RUNNER_GROUP_SUBJECT);
    else return undefined;
  }
  for (const line of chain) {
    const entry = entryOf(permissionSet, line);
    if (entry?.mode !== undefined && entry.unavailable !== true) return { line, mode: entry.mode };
  }
  // A runner no runner line speaks for is not looked inside — `other` does not answer for it.
  if (kind === "runner") return undefined;
  return permissionSet.other !== undefined ? { line: "other", mode: permissionSet.other } : undefined;
}

/** A line with this entry in place of the one it had — in place, so the authored order stands. `undefined` takes it out. */
function withEntry(permissionSet: PermissionSet, subject: string, entry: PermissionSetEntry | undefined): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [key, one] of Object.entries(permissionSet.entries)) {
    if (key !== subject) entries[key] = one;
    else if (entry !== undefined) entries[key] = entry;
  }
  return edited(permissionSet, entries);
}

/** The mode that answers a call at a place this line does not name yet: its own, else what it falls to. */
function answerElsewhere(permissionSet: PermissionSet, subject: string): PermissionSetMode {
  return entryOf(permissionSet, subject)?.mode ?? elsewhereOf(permissionSet, subject)?.mode ?? MODE_WHEN_UNSET;
}

/**
 * Add places to a line. Each starts at `mode` when one is given, else at the mode that already answers
 * there — the line's own, or what it falls to — so adding one changes nothing until its mode is, as
 * with any line the card adds. `**` sets the line's own mode, where it has none. A place it already
 * names, a line it does not hold, an `unavailable` line and a line whose calls name no place
 * ({@link linePlaceKindOf}) are left as they were.
 */
export function withPlaces(permissionSet: PermissionSet, subject: string, places: readonly string[], mode?: PermissionSetMode): PermissionSet {
  const entry = entryOf(permissionSet, subject);
  if (entry === undefined || entry.unavailable === true || linePlaceKindOf(subject) === undefined) return permissionSet;
  const at = mode ?? answerElsewhere(permissionSet, subject);
  let own = entry.mode;
  const next: Record<string, PermissionSetMode> = { ...entry.places };
  for (const raw of places) {
    const place = raw.trim();
    if (place.length === 0) continue;
    if (place === PLACE_ANYWHERE) own ??= at;
    else if (!Object.hasOwn(next, place)) next[place] = at;
  }
  const { places: _was, mode: _mode, offered: _offered, ...rest } = entry;
  return withEntry(permissionSet, subject, { ...rest, ...(own !== undefined ? { mode: own } : {}), ...(Object.keys(next).length > 0 ? { places: next } : {}) });
}

/** Add one place to a line — {@link withPlaces}. */
export function withPlace(permissionSet: PermissionSet, subject: string, place: string, mode?: PermissionSetMode): PermissionSet {
  return withPlaces(permissionSet, subject, [place], mode);
}

/** Set the decision at one of a line's places; `**` is the line's own mode. A place the line does not name is left alone. */
export function withPlaceMode(permissionSet: PermissionSet, subject: string, place: string, mode: PermissionSetMode): PermissionSet {
  const entry = entryOf(permissionSet, subject);
  if (entry === undefined || entry.unavailable === true) return permissionSet;
  const at = place.trim();
  if (at === PLACE_ANYWHERE) return withEntry(permissionSet, subject, { ...entry, mode });
  if (!Object.hasOwn(entry.places ?? {}, at)) return permissionSet;
  return withEntry(permissionSet, subject, { ...entry, places: { ...entry.places, [at]: mode } });
}

/**
 * Take a place off a line. `**` takes the line's own mode, so a call none of its places match falls to
 * a less specific line (§3.4). A line left with no place and no mode of its own says nothing at all, and
 * is taken out — `{}` is no map a set can write.
 */
export function withoutPlace(permissionSet: PermissionSet, subject: string, place: string): PermissionSet {
  const entry = entryOf(permissionSet, subject);
  if (entry === undefined) return permissionSet;
  const at = place.trim();
  const { places: was, mode, ...rest } = entry;
  const places = Object.fromEntries(Object.entries(was ?? {}).filter(([key]) => key !== at));
  const own = at === PLACE_ANYWHERE ? undefined : mode;
  if (own === undefined && Object.keys(places).length === 0) return withEntry(permissionSet, subject, undefined);
  return withEntry(permissionSet, subject, { ...rest, ...(own !== undefined ? { mode: own } : {}), ...(Object.keys(places).length > 0 ? { places } : {}) });
}

/**
 * What a place typed into `another…` is refused with, or `undefined` when it can be added: a line whose
 * calls name no place, nothing typed, a space in a site or a name, a place the line already names, or
 * `**` where the line has its own mode already (its row is the last).
 */
export function placeProblem(permissionSet: PermissionSet, subject: string, typed: string): string | undefined {
  const place = typed.trim();
  const kind = linePlaceKindOf(subject);
  if (kind === undefined) return `'${subject}' takes no place — its calls name none`;
  if (place.length === 0) return "name a place, like src";
  if (kind !== "path" && /\s/.test(place)) return kind === "site" ? "a site has no spaces — a host, and a path after it" : "a name has no spaces";
  const entry = entryOf(permissionSet, subject);
  if (place === PLACE_ANYWHERE) return entry?.mode !== undefined ? "the line's own mode is its ** — it has a row already" : undefined;
  return Object.hasOwn(entry?.places ?? {}, place) ? `'${place}' has a row already` : undefined;
}

/**
 * The words of a line with places (§4.2), for its hint: `{n} places; the most specific decides`, or —
 * with no `**` — where a call none of them match goes: `{n} places; elsewhere it is script's`, or
 * `…; elsewhere, what the sets under it say` in a set that says nothing there.
 */
export function placesSentence(permissionSet: PermissionSet, subject: string, noun: string): string {
  const entry = entryOf(permissionSet, subject);
  if (entry?.mode !== undefined) return `${noun}; the most specific decides`;
  const below = elsewhereOf(permissionSet, subject);
  return below !== undefined ? `${noun}; elsewhere it is ${below.line}'s` : `${noun}; elsewhere, what the sets under it say`;
}

/** What the head's mode button reads on a line with places and no `**`: `elsewhere: as script`, or `elsewhere: as below`. */
export function elsewhereLabel(permissionSet: PermissionSet, subject: string): string {
  return `elsewhere: as ${elsewhereOf(permissionSet, subject)?.line ?? "below"}`;
}

/** The add-a-place menu's row that writes every {@link CREDENTIAL_PLACES} at once. */
export const CREDENTIALS_PICK = "credential files";

/** One row of a line's add-a-place menu: what picking it writes (`id`), its words and its glyph. */
export interface PlaceOption {
  id: string;
  label: string;
  hint: string;
  icon: string;
}

/**
 * What a line's `+ add a place` offers (§4.2), places of the line's kind it does not name yet: for a
 * path, `this project`, `the task's worktree`, `temp`, `your home folder` and `credential files` (the
 * six §7.1 asks about, added at once); for any kind, `everywhere else` — the line's own `**` — while it
 * has none. `another…` is the menu's own last row. Empty for a line whose calls name no place.
 */
export function placeOptionsOf(permissionSet: PermissionSet, subject: string): PlaceOption[] {
  const kind = linePlaceKindOf(subject);
  const entry = entryOf(permissionSet, subject);
  if (kind === undefined || entry === undefined || entry.unavailable === true) return [];
  const has = (place: string): boolean => Object.hasOwn(entry.places ?? {}, place);
  const out: PlaceOption[] = [];
  if (kind === "path") {
    for (const [place, words] of Object.entries(NAMED_PLACE_WORDS)) if (!has(place)) out.push({ id: place, label: words, hint: place, icon: "folder" });
    if (CREDENTIAL_PLACES.some((place) => !has(place))) out.push({ id: CREDENTIALS_PICK, label: "credential files", hint: CREDENTIAL_PLACES.join(" · "), icon: "script" });
  }
  if (entry.mode === undefined) out.push({ id: PLACE_ANYWHERE, label: kind === "branch" ? "every other branch" : "everywhere else", hint: "** — this line's own default", icon: placeGlyphOf(kind, PLACE_ANYWHERE) });
  return out;
}

/**
 * What picking a row of {@link placeOptionsOf} writes: that place, at the mode that answers there
 * already — or, for `credential files`, every credential place at `ask`, which is the point of naming
 * them (§7.1: credentials are asked about under a broad allow).
 */
export function withPlacePicked(permissionSet: PermissionSet, subject: string, id: string): PermissionSet {
  if (id === CREDENTIALS_PICK) return withPlaces(permissionSet, subject, CREDENTIAL_PLACES, "ask");
  return withPlace(permissionSet, subject, id);
}

/** What `another…` asks for on a line of this subject, as its menu row says it. */
export function placeTypedHint(subject: string): string {
  const kind = linePlaceKindOf(subject);
  return kind === undefined ? "" : placeExample(kind);
}
