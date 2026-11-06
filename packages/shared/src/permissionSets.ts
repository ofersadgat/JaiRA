/**
 * The permission set — what an agent may do, as one map from a SUBJECT to a MODE (decision 0007 §1).
 *
 * ```jsonc
 * { "read_file": "allow", "web_fetch": "ask", "shell": "deny", "git status": "allow", "other": "deny" }
 * ```
 *
 * Present means offered, with that mode. Absent means not offered. `other` is everything no entry
 * names. A value may be an object when whose code runs the tool is chosen too:
 * `{ "mode": "ask", "implementation": "native" }`.
 *
 * ## A line's value (decision 0023 §1)
 *
 *  - A STRING is a decision: `allow`, `ask`, `deny`, `unavailable` (the tool is not handed to the model
 *    at all — `UNAVAILABLE`), or any other non-empty string, which names a FUNCTION (`"web_fetch": "smart"`).
 *  - An OBJECT is either the entry wrapper `{ "mode": …, "implementation": "app" | "native" }` — an
 *    object whose keys are all among those two and which has at least one — or a PLACE MAP, place →
 *    decision: `"write_file": { "src": "allow", "infra": "deny", "**": "ask" }`. Any other object is a
 *    place map, so a path literally named `mode` is written `./mode`, and a place map that names `mode`
 *    or `implementation` beside other places is refused as the typo it almost always is. A map speaks
 *    only at its places; `**` is how it gives itself a default, and a map with no `**` has no mode of
 *    its own (`PermissionSetEntry.mode` absent — a call no place matches falls to a less specific line,
 *    §3.4). `unavailable` is never a place's decision. What a place IS belongs to the tool
 *    (`placeKindOf`, `ToolSpec.scope`), and a map on a line whose calls name no place is refused.
 *
 * ## Layers (decision 0023 §2)
 *
 * A set may be built from others: `{ "$ref": lower, …lines }` is the stack [lower, these lines], and a
 * file may name a whole stack, `"layers": [ref, …]`, oldest first, its own lines the newest. A stack is
 * merged LINE BY LINE, the newest saying ({@link mergePermissionMode}): a plain decision covers
 * everywhere and clears the places below it; a map over a plain decision makes that decision its `**`;
 * map over map combines, the same place taking the newer decision. A line a layer leaves out says
 * nothing and falls through. {@link resolvePermissionSetDecl} does that merge as it follows references;
 * `composePermissionSetLayers` (`permissionLayers.ts`) does it for a stack handed in, and keeps who set
 * each line and each place.
 *
 * This module is the one place a permission set is read and written:
 *
 *  - {@link parsePermissionSet} reads the MAP an author writes in `environment.tools`;
 *  - {@link lowerStatePermissionSets} writes a state's maps out in the shape the upstream engine takes
 *    (`tools: string[]` + a `permissions` block), because the engine reads a non-array `tools` as a
 *    BINDING and refuses a map outright (`unrecognized binding form`);
 *  - {@link permissionSetOfEnvironment} reads that lowered shape back — what a loaded state, a message's
 *    inherited declaration and a run's resolved block all arrive as.
 *
 * A map is the only form of `tools`, and an authored `permissions` says nothing: a mode is an entry of
 * the permission set, and where it applies is a place map on its line. The linter refuses the rest,
 * the state table `permissions.scopes` included (decision 0023 §3.7).
 *
 * Pure: no filesystem and no upstream import, so the renderer can read a permission set too. Following a
 * `$ref` needs a file, and that is handed in as a {@link PermissionSetReader} — `@jaira/persistence` builds
 * one over the same reference resolver a workflow's other references use.
 *
 * ## The shell's entries
 *
 * A COMMAND subject (`git commit`, `git`) and `script` are kept on the {@link Permission set} and carried
 * through lowering under `permissions.subjects`, where the policy reads them at the moment a shell
 * line is decided: the line is taken apart and each part answers to its own subject (decision 0007
 * §4, `@jaira/runtime`'s `decideCommand`).
 *
 * The shell tool's OWN entry (`shell`) is the answer for "any other command" on such a line — not a
 * mode for the tool. So it lowers as `ask` in `permissions.tools` — no line runs before the host has
 * read it: the narrowing takes the line apart, and the approver JaiRA hands the engine lets a line
 * every part of which is allowed through without asking anybody — and its authored mode rides in
 * `subjects` beside the commands it stands behind. `"shell": "deny", "git status": "allow"` therefore
 * offers the shell and runs `git status`; every reader that wants the authored mode back goes through
 * {@link permissionSetOfEnvironment}.
 *
 * A shell the map denies OUTRIGHT — `"shell": "deny"` and no command subject or `script` that allows,
 * asks or names a function — is WITHHELD ({@link shellWithheld}): held as written, left off the
 * lowered list, `deny` at the gate, so an agent loses its own shell and codex's writing sandbox stays
 * off.
 *
 * ## A mode that is a function
 *
 * Any entry — a tool, a command, `script`, `shell`, `other` — may name a FUNCTION instead of a word:
 * `"shell": "smart"` (held in memory as a `FunctionMode`). It lowers as `ask` wherever the gate reads a
 * mode, and the reference rides in `permissions.functions`, by subject, which every lowered map
 * carries (empty when nothing is a function). The function is called per call — per PART of a shell
 * line — by the approver the host hands the engine, before any person is asked.
 *
 * ## An MCP server's tools
 *
 * `mcp__figma__get_code` is a line for one tool of a configured MCP server, and `mcp__figma` the
 * server's own line, standing for every tool of it no line names — bash's program groups again, for a
 * server (`./mcp`). Neither is offered: the agent the server is handed to calls the tool by that name,
 * and the line judges the call.
 *
 * ## What a run reads
 *
 * The engine hands a run's policy and its executor the state's RESOLVED block, host keys included
 * (upstream `literalPermissions` and `ExecServices.authored`, declarative-ai 3f5e5cc and later) — so
 * `subjects`, `source`, `implementations` and a written `other` reach a run exactly as they reach a
 * conversation turn, and `implementation: "native"` is honoured in a run too (`withAgentPermissionSet`).
 *
 * ## A state that declares no permission set
 *
 * A state whose `environment` chain names no permission set at all has said nothing about tools, which is
 * not the same statement as an empty map: an empty map offers nothing, and a delegated agent loses
 * every built-in; saying nothing leaves the agent as its executor built it, under the gate. Both
 * lower to a block with no tools in it, so a lowered map says it WAS one with {@link PERMISSION_SET_MARKERS},
 * two entries in `permissions.tools` that no tool is named by. A run reads them off the block it is
 * handed (`ExecServices.authored`); `permissions.tools` merges per key down the `environment` chain,
 * so a child that inherits its parent's map inherits its marks with it.
 */
import { INLINE_PERMISSION_SET } from "./commandParts";
import { isMcpSubject } from "./mcp";
import { commandRunnerOf, parseRunnerSubject } from "./commandRunners";
import {
  PERMISSION_MODES,
  RESERVED_DECISION_WORDS,
  UNAVAILABLE,
  gateModeOf,
  isFunctionMode,
  loosestMode,
  modeWord,
  strictestMode,
  type ChatSettings,
  type PermissionMode,
  type PermissionModeDecl,
  type PermissionsDecl,
  type PermissionStackDecl,
  type ToolImplementation,
  type PermissionSetMode,
} from "./operationVocabulary";
import { resolvePermissionStack, stackDeclOf } from "./permissionLayers";
import { PLACE_ANYWHERE, placeKindOf } from "./places";
import { TOOL_SPEC_BY_NAME } from "./toolVocabulary";

/** The subject that answers for everything no entry names. */
export const OTHER_SUBJECT = "other";
/** The subject that answers for RUNNING A FILE — `./x.sh`, `npm run build` (decision 0007 §4). */
export const SCRIPT_SUBJECT = "script";
/** The shell tool: its entry answers for any command no other entry names (decision 0007 §4). */
export const SHELL_TOOL = "shell";
/** The key that starts a permission set from another — the same `$ref` every other block uses. */
export const PERMISSION_SET_REF_KEY = "$ref";
/**
 * The key a set FILE names the stack it is built from by (decision 0023 §2.5): `"layers": [ref, …]`,
 * oldest first, the file's own lines the newest. Like `other` and `$ref`, it is never a subject — a
 * program called `layers` cannot have a line of its own.
 */
export const PERMISSION_SET_LAYERS_KEY = "layers";
/**
 * The key a set FILE names its icon by (decision 0023 §4.1, ruling 10: "each one has an icon"): a short
 * glyph name from the app's icon set (`"hammer"`, `"globe"`), or a mode word for that mode's glyph
 * (`"ask"`, `"deny"`). Like `layers`, never a subject — a program called `icon` cannot have a line —
 * and no layer's: it is the file's, so it is not merged, not inherited through `$ref`, and not a line
 * of the set it names. Absent, a shipped preset wears its own glyph and anybody else's set the
 * generic layers glyph (`permissionSetIconOf` in `permissionSetBuckets.ts`).
 */
export const PERMISSION_SET_ICON_KEY = "icon";

/** Is this key of a set file one of its instructions — `$ref`, `layers`, `icon` — rather than a line? */
export function isPermissionSetInstructionKey(key: string): boolean {
  return key === PERMISSION_SET_REF_KEY || key === PERMISSION_SET_LAYERS_KEY || key === PERMISSION_SET_ICON_KEY;
}

/**
 * WRITTEN BY LOWERING, never authored: the two `permissions.tools` entries that say "this block was
 * a permission set MAP" rather than a state that declared none — see the module header. Not tools, never
 * offered, and stripped by every reader. A pair only because that is what every block lowered since
 * the migration carries; one would do, and changing it would turn every pinned snapshot's map into
 * a state that declared nothing. That is also why the two keys still say `toolset`: they are DATA in
 * every lowered block a snapshot froze, not a name, and the rename to "permission set" (2026-09-23)
 * stops at them.
 */
export const PERMISSION_SET_MARKERS: Readonly<Record<string, PermissionMode>> = { "jaira:toolset+": "allow", "jaira:toolset-": "deny" };

/** Is this `permissions.tools` key one of the {@link PERMISSION_SET_MARKERS} rather than a tool? */
export function isPermissionSetMarkKey(name: string): boolean {
  return Object.hasOwn(PERMISSION_SET_MARKERS, name);
}

/** Does a block in the upstream shape carry the marks a lowered MAP leaves? */
export function isLoweredPermissionSet(permissions: Pick<PermissionsDecl, "tools"> | undefined): boolean {
  const tools = permissions?.tools;
  return tools !== undefined && Object.entries(PERMISSION_SET_MARKERS).every(([name, mode]) => Object.hasOwn(tools, name) && tools[name] === mode);
}

const IMPLEMENTATIONS: readonly ToolImplementation[] = ["app", "native"];

/**
 * One authored entry (decision 0023 §1): a line's value — a decision string or a place map — or that
 * value with the implementation chosen too, `{ "mode": …, "implementation": … }`.
 */
export type PermissionSetEntryDecl = PermissionModeDecl | { mode: PermissionModeDecl; implementation?: ToolImplementation };

/** A permission set as AUTHORED, references already followed: subject → entry. */
export type PermissionSetDecl = Record<string, PermissionSetEntryDecl>;

/** One authored entry as its parts — what {@link entryOfDecl} and {@link parsePermissionSet} read. */
export interface EntryParts {
  /** The line's own decision: a plain decision, or a place map's `**`. Absent for `unavailable`, and for a map with no `**`. */
  mode?: PermissionSetMode;
  /** A place map's places other than `**`, each to its decision. Absent when the line names none. */
  places?: Record<string, PermissionSetMode>;
  /** The line says `unavailable`. */
  unavailable?: true;
  implementation?: ToolImplementation;
}

/** Is this object the entry WRAPPER — every key `mode` or `implementation`, and at least one — rather than a place map? */
function isEntryWrapper(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "mode" || key === "implementation");
}

/** What a mode may be, as a sentence the linter can say after "a mode is". */
const MODE_SENTENCE = `one of ${[...PERMISSION_MODES, UNAVAILABLE].join(", ")}, the name of a function ("smart"), or a map of places ({ "src": "allow", "**": "ask" })`;

/** One decision string read: a mode (a fixed word, or a function by name), `unavailable`, or what is wrong with it. */
function readDecision(value: unknown): { mode: PermissionSetMode } | { unavailable: true } | { error: string } {
  if (typeof value !== "string") return { error: `${JSON.stringify(value)} is not a decision — a decision is ${MODE_SENTENCE}` };
  const text = value.trim();
  if (text.length === 0) return { error: `an empty string names nothing — a decision is ${MODE_SENTENCE}` };
  if ((PERMISSION_MODES as readonly string[]).includes(text)) return { mode: text as PermissionMode };
  if (text === UNAVAILABLE) return { unavailable: true };
  // No function may be named a mode word (§1), in any case: "Allow" is a slip, not a function.
  const reserved = RESERVED_DECISION_WORDS.find((word) => word === text.toLowerCase());
  if (reserved !== undefined) return { error: `"${text}" is the word '${reserved}' — write it in lower case; no function can be named ${reserved}` };
  return { mode: { function: text } };
}

/**
 * One authored entry read into its parts, or what is wrong with it — the one reader of every spelling
 * of §1. A string is a decision; an object is the wrapper ({@link isEntryWrapper}) or a place map.
 */
function readEntry(value: unknown): EntryParts | { error: string } {
  if (typeof value === "string") {
    const decision = readDecision(value);
    return "error" in decision ? decision : "unavailable" in decision ? { unavailable: true } : { mode: decision.mode };
  }
  if (!isPlainObject(value)) return { error: `${JSON.stringify(value)} is not a decision — a decision is ${MODE_SENTENCE}` };
  if (!isEntryWrapper(value)) return readPlaceMap(value);
  if (value["mode"] === undefined) return { error: `it has no mode — write ${MODE_SENTENCE}` };
  const inner = value["mode"];
  const parts = typeof inner === "string" ? readEntry(inner) : isPlainObject(inner) ? readPlaceMap(inner) : { error: `its mode ${JSON.stringify(inner)} is not one — a mode is ${MODE_SENTENCE}` };
  if ("error" in parts) return parts;
  const implementation = value["implementation"];
  if (implementation !== undefined && !IMPLEMENTATIONS.includes(implementation as ToolImplementation)) {
    return { error: `it has the implementation ${JSON.stringify(implementation)} — it is one of ${IMPLEMENTATIONS.join(", ")}` };
  }
  return { ...parts, ...(implementation !== undefined ? { implementation: implementation as ToolImplementation } : {}) };
}

/** A place map read: `**` as the line's own mode, every other place to its decision. */
function readPlaceMap(map: Record<string, unknown>): EntryParts | { error: string } {
  const entries = Object.entries(map);
  if (entries.length === 0) return { error: "a map of places names no place — write one decision, or the places it decides for" };
  // `{ "function": "smart" }` is how a function was written until 2026-11-02. Nothing reads that
  // spelling; read as a place map it would quietly mean "at the path `function`", so the exact shape
  // is refused, naming what to write. A path called `function` is written `./function`.
  if (entries.length === 1 && entries[0]![0].trim() === "function" && typeof entries[0]![1] === "string") {
    return { error: `{ "function": ${JSON.stringify(entries[0]![1])} } is no longer how a function is named — write the function's name as the line's value: ${JSON.stringify(entries[0]![1].trim())} (a path called function is './function')` };
  }
  let mode: PermissionSetMode | undefined;
  const places: Record<string, PermissionSetMode> = {};
  for (const [rawPlace, decision] of entries) {
    const place = rawPlace.trim();
    if (place.length === 0) return { error: "a place cannot be empty — `**` is everywhere" };
    if (place === "mode" || place === "implementation") {
      return { error: `it names '${place}' beside other places — an entry object is { "mode", "implementation" } alone, and a path named ${place} is written './${place}'` };
    }
    const read = readDecision(decision);
    if ("error" in read) return { error: `at '${place}': ${read.error}` };
    if ("unavailable" in read) return { error: `at '${place}': unavailable is never a place's decision — what the model is handed is per tool, not per place; refuse it there with deny` };
    if (place === PLACE_ANYWHERE) mode = read.mode;
    else places[place] = read.mode;
  }
  return { ...(mode !== undefined ? { mode } : {}), ...(Object.keys(places).length > 0 ? { places } : {}) };
}

/**
 * One authored entry as its parts, whichever spelling it was written in — `"ask"`, `"smart"`,
 * `"unavailable"`, a place map, `{ "mode": …, "implementation": … }`. For an entry already known to
 * parse: what `parsePermissionSet` refuses comes back with no parts at all, and is not re-judged here.
 */
export function entryOfDecl(entry: PermissionSetEntryDecl | unknown): EntryParts {
  const parts = readEntry(entry);
  return "error" in parts ? {} : parts;
}

/**
 * A line's value as AUTHORED — the inverse of reading one: `unavailable`, a plain decision (a function
 * by its name), or a place map with the line's own mode as its `**`. A line with no decision at all
 * (a block read back that gave the tool none) is written as {@link MODE_WHEN_UNSET}.
 */
export function modeDeclOf(entry: EntryParts): PermissionModeDecl {
  if (entry.unavailable === true) return UNAVAILABLE;
  const places = entry.places ?? {};
  if (Object.keys(places).length === 0) return modeWord(entry.mode ?? MODE_WHEN_UNSET);
  const out: Record<string, string> = entry.mode !== undefined ? { [PLACE_ANYWHERE]: modeWord(entry.mode) } : {};
  for (const [place, mode] of Object.entries(places)) out[place] = modeWord(mode);
  return out;
}

/** An entry as AUTHORED: {@link modeDeclOf}, in the wrapper when the implementation is the agent's own. */
export function entryDeclOf(entry: EntryParts): PermissionSetEntryDecl {
  const mode = modeDeclOf(entry);
  return entry.implementation === "native" && entry.unavailable !== true ? { mode, implementation: "native" } : mode;
}

/**
 * What a subject names. `unknown-tool` is never stored — it is reported and dropped.
 *
 * `mcp` is a tool of somebody else's MCP server (`mcp__figma__get_code`) or a server's own line
 * (`mcp__figma`), which stands for every tool of it no line names — see `mcpModeOf` in `./mcp`.
 * Neither is a tool JaiRA serves: nothing is offered under it, and the agent that has the server
 * calls the tool by that name, which is what the line judges.
 */
export type SubjectKind = "tool" | "command" | "script" | "mcp" | "runner" | "other" | "unknown-tool";

export interface PermissionSetEntry {
  kind: "tool" | "command" | "script" | "mcp" | "runner";
  /**
   * The entry's own mode: its plain decision, or its place map's `**`. Absent where a block read back
   * ({@link permissionSetOfEnvironment}) lists a tool it gives no mode — the always-granted tools of a
   * turn that declared no permission set — which resolves through the project baseline; where the
   * line is a place map with no `**`, so that a call no place matches falls to a less specific line
   * (decision 0023 §3.4); and on an {@link unavailable} line.
   */
  mode?: PermissionSetMode;
  /**
   * The line's PLACES other than `**` (decision 0023 §3), each to its decision — what the most
   * specific matching place answers for a call (`resolvePlaces` in `places.ts`). Absent when the line
   * names none. Read by the narrowing per call; where one mode must stand for the whole line, see
   * {@link loosestModeOf} (the gate) and {@link strictestModeOf} (a judge that cannot yet see places).
   */
  places?: Record<string, PermissionSetMode>;
  /**
   * The line says `unavailable` (decision 0023 §1): the model is not handed the tool. Only a single
   * LAYER holds such an entry, as what it says over the layers below; it has no mode, is not held, and
   * is written back as `"unavailable"`. An effective set — a stack composed — never holds one on a
   * tool: the line is simply absent (`composePermissionSetLayers`).
   */
  unavailable?: true;
  implementation?: ToolImplementation;
  /**
   * `false` only from {@link permissionSetOfEnvironment}: the lowered `permissions.tools` gives a mode for
   * a tool the lowered list does not offer — a withheld shell ({@link shellWithheld}), a tool nothing
   * serves yet, or an entry a child inherited per key from its parent's map beside its own list. The
   * mode is kept and the tool is not offered. An authored map never says this: `deny` is an entry.
   */
  offered?: false;
}

/** THE internal representation — what every consumer of a grant and its modes reads. */
export interface PermissionSet {
  /** Subject → entry, in authored order. Never holds `other`. */
  entries: Record<string, PermissionSetEntry>;
  /** The mode for everything no entry names. */
  other?: PermissionSetMode;
}

export interface PermissionSetIssue {
  /** Relative to the permission set node — a subject, or `` for the node itself. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

/**
 * What a subject names.
 *
 * A standard tool is one the vocabulary holds. `other` and `script` are themselves. Anything with a
 * space in it is a command and its subcommand (`git commit`, `git push --force`). A single word that
 * looks like a PROGRAM — lowercase, no underscore (`git`, `terraform`, `apt-get`) — is a command
 * subject for every command of that program. What is left looks like a tool name and is not one we
 * know (`reed_file`, `Glob`): nothing is offered under it, which the linter says. `mcp__figma` and
 * `mcp__figma__get_code` are MCP subjects: a server's line and one of its tools'. `runner:*` and
 * `runner:npm` are the command runners' gate — the group's line and one runner's (`commandRunners.ts`).
 */
export function subjectKindOf(subject: string): SubjectKind {
  if (subject === OTHER_SUBJECT) return "other";
  if (subject === SCRIPT_SUBJECT) return "script";
  if (isMcpSubject(subject)) return "mcp";
  if (parseRunnerSubject(subject) !== undefined) return "runner";
  if (TOOL_SPEC_BY_NAME.has(subject)) return "tool";
  if (/\s/.test(subject)) return "command";
  return /^[a-z][a-z0-9.+-]*$/.test(subject) ? "command" : "unknown-tool";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A subject as one spelling — two spellings of one command (`git  commit`) are one line. */
export function normalizeSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, " ");
}

/**
 * Read a RESOLVED map (no `$ref` or `layers` left in it) into a {@link Permission set}, saying what is
 * wrong with it.
 *
 * Never throws. An entry that cannot be read is reported and left out, so one bad line costs that
 * line and the linter can still speak about the rest.
 *
 * Refused (decision 0023): `unavailable` on a command, a runner line, `script` or `other`; a place map
 * on `other` or on a line whose calls name no place (`placeKindOf`); a malformed decision or map. An
 * MCP line may hold a map: the place it takes is the standard tool's the configuration maps it to,
 * which a set alone cannot say.
 */
export function parsePermissionSet(decl: unknown): { permissionSet: PermissionSet; issues: PermissionSetIssue[] } {
  const permissionSet: PermissionSet = { entries: {} };
  const issues: PermissionSetIssue[] = [];
  if (!isPlainObject(decl)) {
    issues.push({ path: "", message: "a permission set is a map from a subject to a mode", severity: "error" });
    return { permissionSet, issues };
  }
  for (const [rawSubject, value] of Object.entries(decl)) {
    const subject = normalizeSubject(rawSubject);
    const error = (message: string): void => void issues.push({ path: rawSubject, message, severity: "error" });
    const warn = (message: string): void => void issues.push({ path: rawSubject, message, severity: "warning" });
    if (subject.length === 0) {
      error("a subject cannot be empty");
      continue;
    }
    if (subject === PERMISSION_SET_ICON_KEY) {
      if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(value.trim())) error(`'${PERMISSION_SET_ICON_KEY}' names the set's icon — a short glyph name like "hammer", in lower case`);
      continue;
    }
    if (subject.startsWith("$") || subject === PERMISSION_SET_LAYERS_KEY) {
      error(
        subject === PERMISSION_SET_LAYERS_KEY
          ? `'${PERMISSION_SET_LAYERS_KEY}' names the layers a set is built from, not a subject — it is followed before the lines are read (resolvePermissionSetDecl)`
          : `'${rawSubject}' is not a subject — '${PERMISSION_SET_REF_KEY}' and '${PERMISSION_SET_LAYERS_KEY}' are the only instructions a permission set takes`,
      );
      continue;
    }
    const parts = readEntry(value);
    if ("error" in parts) {
      error(`'${subject}': ${parts.error}`);
      continue;
    }
    const kind = subjectKindOf(subject);
    if (kind === "unknown-tool") {
      // Reported and dropped, which is what "falls to `other`" means: nothing is offered under a
      // name no tool has, and a call that turns up by it is answered by `other`.
      warn(`'${subject}' is not a tool JaiRA knows — nothing is offered under that name, and a call by it answers to 'other'`);
      continue;
    }
    if (parts.unavailable === true && kind !== "tool" && kind !== "mcp") {
      error(
        kind === "other"
          ? `'other' cannot be unavailable — it names no one tool to take away; it can deny`
          : `'${subject}' cannot be unavailable — what the model is handed is per tool, and it cannot be shown part of a shell: refuse it with deny, or make 'shell' unavailable`,
      );
      continue;
    }
    if (parts.places !== undefined && kind !== "mcp" && (kind === "other" || placeKindOf(subject) === undefined)) {
      error(`'${subject}' takes no place — ${kind === "other" ? "it names no one tool" : "its calls name none"}, so a map of places means nothing on it; write one decision`);
      continue;
    }
    const implementation = parts.implementation;
    if (kind === "other") {
      if (implementation !== undefined) warn("'other' names no one tool, so an implementation means nothing on it");
      permissionSet.other = parts.mode!;
      continue;
    }
    if (kind === "runner") {
      const program = parseRunnerSubject(subject)!.program;
      if (program !== undefined && commandRunnerOf(program) === undefined) {
        warn(`'${program}' is not a command runner JaiRA knows — nothing reads '${subject}'; a line for the program itself is '${program}'`);
        continue;
      }
    }
    if (kind !== "tool" && implementation !== undefined) warn(`'${subject}' is not a tool, so an implementation means nothing on it`);
    else if (parts.unavailable === true && implementation !== undefined) warn(`'${subject}' is unavailable, so whose code would run it means nothing`);
    permissionSet.entries[subject] = {
      kind,
      ...(parts.mode !== undefined ? { mode: parts.mode } : {}),
      ...(parts.places !== undefined ? { places: parts.places } : {}),
      ...(parts.unavailable === true ? { unavailable: true as const } : {}),
      ...(kind === "tool" && implementation !== undefined && parts.unavailable !== true ? { implementation } : {}),
    };
  }
  return { permissionSet, issues };
}

// --- layers: merging a stack, line by line (decision 0023 §2) -------------------

/**
 * One line's value under a newer layer's (decision 0023 §2.1), exactly as the decision writes it:
 *
 *  - a plain decision covers everywhere and clears the places below it;
 *  - a place map over a plain decision makes that decision its `**` — a base `read_file: "deny"` under
 *    a newer `{ "C:": "allow" }` comes to `{ "**": "deny", "C:": "allow" }`;
 *  - a map over a map combines, the same place taking the newer decision.
 *
 * One case the decision's code does not meet, because it was written before `unavailable` was a word:
 * a map over `unavailable`. `unavailable` is never a place's decision, so it does not become the `**`
 * — the newer layer offers the tool at its places, and elsewhere says nothing.
 */
export function mergePermissionMode(lower: PermissionModeDecl | undefined, upper: PermissionModeDecl): PermissionModeDecl {
  if (typeof upper === "string" || lower === undefined) return upper;
  if (typeof lower === "string") return lower.trim() === UNAVAILABLE ? upper : { [PLACE_ANYWHERE]: lower, ...upper };
  return { ...lower, ...upper };
}

/** An authored entry as its value and its implementation, unread — `undefined` when it is neither a string nor an object. */
function splitEntryDecl(value: unknown): { mode?: unknown; implementation?: unknown } | undefined {
  if (typeof value === "string") return { mode: value };
  if (!isPlainObject(value)) return undefined;
  if (!isEntryWrapper(value)) return { mode: value };
  return { ...(value["mode"] !== undefined ? { mode: value["mode"] } : {}), ...(value["implementation"] !== undefined ? { implementation: value["implementation"] } : {}) };
}

const isModeDecl = (value: unknown): value is PermissionModeDecl => typeof value === "string" || isPlainObject(value);

/**
 * One authored ENTRY under a newer layer's: the values merged by {@link mergePermissionMode}, and the
 * implementation the newest layer that SAYS one — a layer that writes `"write_file": "allow"` says
 * nothing about whose code runs it, so the `native` below stands (§2.3: what a layer leaves out says
 * nothing); a layer that means ours writes `"implementation": "app"`. An entry either side cannot read
 * is not merged: the newer stands whole, and the parser reports what is wrong with it.
 */
export function mergeEntryDecl(lower: unknown, upper: unknown): unknown {
  const up = splitEntryDecl(upper);
  const low = lower === undefined ? undefined : splitEntryDecl(lower);
  if (up === undefined || !isModeDecl(up.mode)) return upper;
  const below = low !== undefined && isModeDecl(low.mode) ? low.mode : undefined;
  const mode = mergePermissionMode(below, up.mode);
  const implementation = up.implementation !== undefined ? up.implementation : low?.implementation;
  // `unavailable` has nobody's code to run, and takes the choice below with it: a newer layer that
  // offers the tool again starts from ours, unless it names the agent's.
  return implementation === undefined || mode === UNAVAILABLE ? mode : { mode, implementation };
}

/** One layer of a stack: an id that names it to a person (`ask-first`, a reference, `inline`), and its own lines. */
export interface PermissionSetLayerDecl {
  id: string;
  decl: Record<string, unknown>;
}

/**
 * Who set a line, per place (decision 0023 §2.7): the layer that decided it EVERYWHERE — a plain
 * decision, or a map's `**` — and the layer behind each other place, and behind the implementation.
 */
export interface LineProvenance {
  /** The layer whose plain decision, or `**`, the line's own mode is. Absent when no layer gave it one. */
  everywhere?: string;
  /** Place → the layer that last wrote it. */
  places: Record<string, string>;
  /** The layer whose `implementation` stands. */
  implementation?: string;
}

/**
 * A stack of layers' lines, oldest first, merged line by line ({@link mergeEntryDecl}) into one map,
 * with who set what ({@link LineProvenance}, by normalized subject). Subjects compare in one spelling
 * (`git  commit` is `git commit`), the first layer's spelling kept; `$ref` and `layers` are not lines
 * and are skipped. Nothing is parsed or dropped here — `unavailable` stays a line, which is what a set
 * FILE built of layers must say — so the result is a map an author could have written.
 */
export function mergeLayerDecls(layers: readonly PermissionSetLayerDecl[]): { decl: Record<string, unknown>; provenance: Record<string, LineProvenance> } {
  const decl: Record<string, unknown> = {};
  const keyOf = new Map<string, string>();
  const provenance: Record<string, LineProvenance> = {};
  for (const { id, decl: lines } of layers) {
    for (const [rawSubject, value] of Object.entries(lines)) {
      if (isPermissionSetInstructionKey(rawSubject)) continue;
      const subject = normalizeSubject(rawSubject);
      const key = keyOf.get(subject) ?? rawSubject;
      keyOf.set(subject, key);
      const lower = Object.hasOwn(decl, key) ? decl[key] : undefined;
      decl[key] = mergeEntryDecl(lower, value);
      provenance[subject] = provenanceOver(Object.hasOwn(provenance, subject) ? provenance[subject] : undefined, lower, value, id);
    }
  }
  return { decl, provenance };
}

/** A line's provenance once layer `id` has written `upper` over `lower` — the same three cases as {@link mergePermissionMode}. */
function provenanceOver(prior: LineProvenance | undefined, lower: unknown, upper: unknown, id: string): LineProvenance {
  const up = splitEntryDecl(upper);
  // `unavailable` takes the implementation with it, as `mergeEntryDecl` does.
  const gone = typeof up?.mode === "string" && up.mode.trim() === UNAVAILABLE;
  const implementation = gone ? undefined : up?.implementation !== undefined ? id : prior?.implementation;
  const withImplementation = (line: LineProvenance): LineProvenance => (implementation !== undefined ? { ...line, implementation } : line);
  if (up === undefined || !isModeDecl(up.mode) || typeof up.mode === "string") return withImplementation({ everywhere: id, places: {} });
  const below = splitEntryDecl(lower)?.mode;
  const fromBelow = typeof below === "string" && below.trim() === UNAVAILABLE ? undefined : prior?.everywhere;
  const places: Record<string, string> = { ...prior?.places };
  let everywhere = fromBelow;
  for (const rawPlace of Object.keys(up.mode)) {
    const place = rawPlace.trim();
    if (place === PLACE_ANYWHERE) everywhere = id;
    else places[place] = id;
  }
  return withImplementation({ ...(everywhere !== undefined ? { everywhere } : {}), places });
}

// --- references --------------------------------------------------------------

/** What a reference named: the node there, an identity for cycle detection, and where `./` now means. */
export interface PermissionSetSource {
  value: unknown;
  /** Unique per (file, property) — what a cycle is detected and NAMED by. */
  key: string;
  /** The id a reference written INSIDE that file is relative to. */
  from: string;
}

/** Follow one reference. Throws when it names nothing; the message is reported as written. */
export type PermissionSetReader = (reference: string, from: string) => PermissionSetSource;

/** The id the lines written on a node itself, rather than in a file it names, are a layer by. */
export const INLINE_LAYER = "inline";

/**
 * A permission set node as the STACK of layers it is (decision 0023 §2.5), oldest first, every
 * reference followed: a bare string is the stack of the file it names; `{ "$ref": lower, …lines }` is
 * lower's stack and then these lines; a file that says `"layers": [ref, …]` is each named stack in
 * turn and then its own lines (after `$ref`'s, when it says both). Each layer is named by the
 * reference that reached it, and the lines written on `node` itself by `id`.
 *
 * A cycle is an error NAMING it. `undefined` when a reference could not be followed; the issues say why.
 */
export function permissionSetLayersOf(
  node: unknown,
  read: PermissionSetReader,
  from: string,
  issues: PermissionSetIssue[],
  id: string = INLINE_LAYER,
  active: readonly string[] = [],
): PermissionSetLayerDecl[] | undefined {
  const follow = (reference: string): PermissionSetLayerDecl[] | undefined => {
    let source: PermissionSetSource;
    try {
      source = read(reference, from);
    } catch (e) {
      issues.push({ path: "", message: (e as Error).message, severity: "error" });
      return undefined;
    }
    if (active.includes(source.key)) {
      issues.push({
        path: "",
        message: `permission set reference cycle: ${[...active.slice(active.indexOf(source.key)), source.key].join(" → ")}`,
        severity: "error",
      });
      return undefined;
    }
    if (typeof source.value !== "string" && !isPlainObject(source.value)) {
      issues.push({ path: "", message: `'${reference}' is not a permission set — a permission set is a map from a subject to a mode`, severity: "error" });
      return undefined;
    }
    return permissionSetLayersOf(source.value, read, source.from, issues, reference, [...active, source.key]);
  };
  if (typeof node === "string") return follow(node);
  if (!isPlainObject(node)) {
    issues.push({ path: "", message: "a permission set is a map from a subject to a mode, or a reference to one", severity: "error" });
    return undefined;
  }
  const reference = node[PERMISSION_SET_REF_KEY];
  const named = node[PERMISSION_SET_LAYERS_KEY];
  if (reference === undefined && named === undefined) {
    // The file's icon is the file's, not a line of the layer it is.
    const { [PERMISSION_SET_ICON_KEY]: _icon, ...lines } = node;
    return [{ id, decl: lines }];
  }
  const out: PermissionSetLayerDecl[] = [];
  if (reference !== undefined) {
    if (typeof reference !== "string") {
      issues.push({ path: PERMISSION_SET_REF_KEY, message: `'${PERMISSION_SET_REF_KEY}' takes a reference, as a string`, severity: "error" });
      return undefined;
    }
    const below = follow(reference);
    if (below === undefined) return undefined;
    out.push(...below);
  }
  if (named !== undefined) {
    if (!Array.isArray(named) || !named.every((each) => typeof each === "string")) {
      issues.push({ path: PERMISSION_SET_LAYERS_KEY, message: `'${PERMISSION_SET_LAYERS_KEY}' takes a list of references, oldest first`, severity: "error" });
      return undefined;
    }
    for (const each of named as string[]) {
      const layer = follow(each);
      if (layer === undefined) return undefined;
      out.push(...layer);
    }
  }
  const { [PERMISSION_SET_REF_KEY]: _ref, [PERMISSION_SET_LAYERS_KEY]: _layers, [PERMISSION_SET_ICON_KEY]: _icon, ...lines } = node;
  if (Object.keys(lines).length > 0) out.push({ id, decl: lines });
  return out;
}

/**
 * Follow a permission set node's references down to one plain map: the stack it is
 * ({@link permissionSetLayersOf}), merged line by line ({@link mergeLayerDecls}, decision 0023 §2.5).
 *
 * So a copy that names one place no longer replaces the whole map below it, as upstream's sibling
 * replacement would: `{ "$ref": …, "read_file": { "src": "allow" } }` over a `read_file: "deny"` comes
 * to `{ "**": "deny", "src": "allow" }`. A plain decision over a map still replaces it, since it covers
 * everywhere; an implementation below stands unless the newer line names one.
 *
 * A cycle is an error NAMING it. `undefined` when nothing usable came back; the issues say why.
 */
export function resolvePermissionSetDecl(
  node: unknown,
  read: PermissionSetReader,
  from: string,
  issues: PermissionSetIssue[],
  active: readonly string[] = [],
): Record<string, unknown> | undefined {
  const layers = permissionSetLayersOf(node, read, from, issues, INLINE_LAYER, active);
  if (layers === undefined) return undefined;
  if (layers.length === 1) return layers[0]!.decl;
  return mergeLayerDecls(layers).decl;
}

// --- what consumers read -----------------------------------------------------

/**
 * The GRANT: the tools offered, in authored order. Command subjects and `script` are not tools.
 *
 * What is HANDED to somebody — the list lowering writes for the engine to resolve against the
 * registry, and the set `viewOfPermissionSet` calls held — so a tool that is named and not yet served
 * (`ToolSpec.unserved`) is never in it. {@link heldTools} is the list a person reads.
 */
export function offeredTools(permissionSet: PermissionSet): string[] {
  const withheld = shellWithheld(permissionSet);
  return heldTools(permissionSet).filter((name) => TOOL_SPEC_BY_NAME.get(name)?.unserved !== true && !(withheld && name === SHELL_TOOL));
}

/** Every decision a line can give: its own mode, and each place's. Empty for `unavailable` and for a line read back with no mode. */
export function decisionsOf(entry: EntryParts): PermissionSetMode[] {
  return [...(entry.mode !== undefined ? [entry.mode] : []), ...Object.values(entry.places ?? {})];
}

/** Does every decision the line can give refuse? A line with none at all does not. */
function deniesOutright(entry: EntryParts): boolean {
  const decisions = decisionsOf(entry);
  return decisions.length > 0 && decisions.every((mode) => mode === "deny");
}

/**
 * Is this map's shell HELD and yet handed to nobody — a shell the permission set denies outright?
 *
 * Present means offered, and a map's `shell` entry is the answer for "any other command" on a line
 * taken apart (decision 0007 §4). When that answer is `deny` and no command subject and no `script`
 * entry allows, asks or names a function, every line the shell could run is refused — or duplicates a
 * standard tool the permission set serves directly (`cat` is `read_file`). A runner line that lets a runner through
 * (`runner:*`) counts as allowing, since `bash -c "cat x"` is then a read. Offering such a shell is a door
 * with nothing behind it that a RUN cannot see is shut: the gate is told `ask`, and on codex a held
 * shell turns the writing sandbox on. So it is withheld: {@link offeredTools} leaves it
 * out, {@link gateToolModes} answers `deny` for it, and an agent loses its own shell with it. The
 * entry is still HELD — it is what the author wrote, and it is what a person reads and matches.
 *
 * "Denies" means at every place: a shell, command or `script` line any place of which lets something
 * through keeps the shell. An `unavailable` shell is not held at all, so it is not withheld either.
 */
export function shellWithheld(permissionSet: PermissionSet): boolean {
  const shell = Object.hasOwn(permissionSet.entries, SHELL_TOOL) ? permissionSet.entries[SHELL_TOOL] : undefined;
  if (shell === undefined || shell.kind !== "tool" || shell.unavailable === true || !deniesOutright(shell)) return false;
  // Only what a LINE can run keeps the shell: a command, or `script`. A tool, or an MCP server's
  // line, is judged by name and never reaches the shell.
  return Object.values(permissionSet.entries).every((entry) => (entry.kind !== "command" && entry.kind !== "script" && entry.kind !== "runner") || deniesOutright(entry));
}

/**
 * Does the permission set HOLD this tool — is its line ticked?
 *
 * An un-offered entry (see {@link PermissionSetEntry.offered}) is not held. The one exception is a tool
 * nothing serves yet: lowering leaves it out of the `tools` list (see {@link offeredTools}) and keeps
 * its mode, so a lowered block read back has it un-offered — and it was held. With no list it could
 * ever be on, its entry is the whole of the statement. An `unavailable` line holds nothing: it is a
 * layer saying the tool is not to be handed over.
 */
export function holdsTool(permissionSet: PermissionSet, name: string): boolean {
  const entry = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined;
  if (entry === undefined || entry.kind !== "tool" || entry.unavailable === true) return false;
  return entry.offered !== false || TOOL_SPEC_BY_NAME.get(name)?.unserved === true;
}

/** Every tool the permission set holds, served or not, in authored order — what a person reads and counts. */
export function heldTools(permissionSet: PermissionSet): string[] {
  return Object.keys(permissionSet.entries).filter((name) => holdsTool(permissionSet, name));
}

/**
 * The mode a line with none of its own reads as — the permission ledger's own last resort.
 *
 * What a new line starts at, what the composer draws for a tool listed with no mode (a turn that
 * declared no permission set), and what a call no line names comes to when there is no `other`.
 */
export const MODE_WHEN_UNSET: PermissionMode = "ask";

/**
 * A {@link Permission set} as the MAP an author would write — the inverse of {@link parsePermissionSet}.
 *
 * What the composer sends (`ChatSettings.permission set`) and what `+` keeps as a file. Only what is HELD is
 * written, because in a map present means offered: an un-offered mode has no spelling here and is
 * dropped. An `unavailable` line is written back as one — it is a statement about the layers below.
 * A line with places is written as its place map, its own mode as `**`. An implementation is written
 * only where it is the agent's own, since ours is the default.
 *
 * `other` is written only when the set has one (decision 0023 §2.3): a layer that writes `other`
 * replaces the `other` under it, so a set that said nothing about it must not start saying `ask`
 * when it is kept.
 */
export function declOfPermissionSet(permissionSet: PermissionSet): PermissionSetDecl {
  const out: PermissionSetDecl = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "tool" && entry.unavailable !== true && !holdsTool(permissionSet, subject)) continue;
    out[subject] = entryDeclOf(entry);
  }
  if (permissionSet.other !== undefined) out[OTHER_SUBJECT] = modeWord(permissionSet.other);
  return out;
}

/**
 * ONE mode for a line that may have places, the LOOSEST any of them can give (decision 0023 §3.10:
 * gate modes compile loose and narrow per call). What the upstream gate is handed for the line — its
 * narrowing only tightens, so a mode stricter than some place's answer would refuse a call that place
 * allows before the narrowing could see it. A line with no `**` falls elsewhere to a less specific
 * line, so `elsewhere` (what that comes to: `other`, else {@link MODE_WHEN_UNSET}) is among the
 * answers it can give. A line with no places is its own mode.
 *
 * The narrowing then works out each call's own answer and tightens to it (`placeNarrowingFor` in
 * `@jaira/runtime`), so this is never what a call comes to — only never stricter than it.
 */
export function loosestModeOf(entry: EntryParts, elsewhere: PermissionSetMode): PermissionSetMode | undefined {
  if (entry.places === undefined || Object.keys(entry.places).length === 0) return entry.mode;
  return loosestMode(entry.mode ?? elsewhere, ...Object.values(entry.places));
}

/**
 * A set read for WHAT a call does, not WHERE (decision 0023 §7.1): every line at the loosest answer any
 * of its places gives ({@link loosestModeOf}), its places dropped. What the work summary and the Changes
 * tab judge a call by when they ask "did this only read?" of `read-only` — whose `read_file` asks
 * outside the project and at a credential, which says where the person is asked, not that a read
 * outside the project changed anything.
 */
export function withoutPlaces(permissionSet: PermissionSet): PermissionSet {
  const elsewhere = permissionSet.other ?? MODE_WHEN_UNSET;
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.places === undefined) {
      entries[subject] = entry;
      continue;
    }
    const { places: _places, ...rest } = entry;
    const mode = loosestModeOf(entry, elsewhere);
    entries[subject] = { ...rest, ...(mode !== undefined ? { mode } : {}) };
  }
  return { ...permissionSet, entries };
}

/**
 * ONE mode for a line that may have places, the STRICTEST any of them can give — for a reader that
 * must say one mode per line and cannot see a call (a summary), so it never reads a line as looser
 * than some call's answer. `elsewhere` is what a call no place matches comes to; where the caller
 * cannot know (a command line falls to a chain of less specific lines), it passes `deny`, which is
 * never looser than anything. A line with no places is its own mode. No judge of a CALL reads it:
 * those read the place map itself ({@link linePlaces}).
 */
export function strictestModeOf(entry: EntryParts, elsewhere: PermissionSetMode): PermissionSetMode | undefined {
  if (entry.places === undefined || Object.keys(entry.places).length === 0) return entry.mode;
  return strictestMode(entry.mode ?? elsewhere, ...Object.values(entry.places));
}

/** What a tool's call no place of its line matches falls to: `other`, else {@link MODE_WHEN_UNSET}. */
function toolElsewhere(permissionSet: PermissionSet): PermissionSetMode {
  return permissionSet.other ?? MODE_WHEN_UNSET;
}

/**
 * Every tool entry's OWN mode, offered or not — what a part of a shell line is judged by when it is the
 * standard tool it reads as (`cat x` as `read_file`), per tool.
 *
 * A line's own mode is its plain decision or its place map's `**`; a map with no `**` has none, and is
 * not here. Its places are {@link linePlaces}, which the judge of a call reads beside this: the most
 * specific place that matches the call answers, and a call no place matches falls to the own mode, or
 * — where there is none — to the next less specific line (decision 0023 §3.4). The gate's mode is
 * {@link gateToolModes}.
 */
export function toolModes(permissionSet: PermissionSet): Record<string, PermissionSetMode> {
  const out: Record<string, PermissionSetMode> = {};
  for (const [name, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "tool" && entry.mode !== undefined) out[name] = entry.mode;
  }
  return out;
}

/**
 * Every line's PLACES other than `**`, by subject (decision 0023 §3) — tools, commands, `script`,
 * runner lines and the shell's own — for a judge of one call: `decideCommand` for a shell line's parts,
 * the narrowing for a direct call. A line with no places is not here. MCP lines are not either: the
 * place an MCP tool takes is the standard tool's the configuration maps it to, and until that is read
 * a call to one answers to its line's own mode, or its server's, as it always has.
 */
export function linePlaces(permissionSet: PermissionSet): Record<string, Record<string, PermissionSetMode>> {
  const out: Record<string, Record<string, PermissionSetMode>> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "mcp" || entry.places === undefined || Object.keys(entry.places).length === 0) continue;
    out[subject] = { ...entry.places };
  }
  return out;
}

/** Is this one of the lines a shell line's PARTS answer to — a command, `script`, a runner line, or the shell's own? */
function isShellLine(subject: string, entry: PermissionSetEntry): boolean {
  return entry.kind === "command" || entry.kind === "script" || entry.kind === "runner" || subject === SHELL_TOOL;
}

/**
 * Does the set say anything a shell line's parts answer to — a command, `script` or runner line, or
 * the shell's own, with a mode or with places? What decides whether a line is judged by the set at
 * all (`shellPermissionSetOf` in `@jaira/runtime`), and whether lowering writes `subjects`.
 */
export function holdsShellLines(permissionSet: PermissionSet): boolean {
  return Object.entries(permissionSet.entries).some(
    ([subject, entry]) => isShellLine(subject, entry) && entry.unavailable !== true && (entry.mode !== undefined || (entry.places !== undefined && Object.keys(entry.places).length > 0)),
  );
}

/**
 * The tools' modes as the GATE takes them: each line's LOOSEST answer ({@link loosestModeOf} —
 * decision 0023 §3.10), a function as `ask` (see `gateModeOf`), and the shell's entry as `ask` whatever
 * it says — or `deny` where the shell is withheld ({@link shellWithheld}), since there is then no line
 * to read.
 *
 * Any other mode would answer for the shell before its line was read — `deny` would refuse the
 * `git status` the same permission set allows, `allow` would pre-approve a delegated agent's shell so that
 * no line was ever judged at all. `ask` reaches the host with the line in hand, every time: the
 * narrowing takes it apart, and the approver the host hands the engine runs the functions it names
 * and lets through, without asking anybody, a line every part of which the permission set allows. The
 * authored mode is not lost: it is the `shell` subject a part falls to ({@link shellSubjects}).
 */
export function gateToolModes(permissionSet: PermissionSet): Record<string, PermissionMode> {
  const modes: Record<string, PermissionMode> = {};
  for (const [name, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "tool") continue;
    const mode = loosestModeOf(entry, toolElsewhere(permissionSet));
    if (mode !== undefined) modes[name] = gateModeOf(mode);
  }
  // A withheld shell has no line to read: nothing is offered, and the gate refuses it by name.
  if (Object.hasOwn(modes, SHELL_TOOL)) modes[SHELL_TOOL] = shellWithheld(permissionSet) ? "deny" : "ask";
  return modes;
}

/**
 * Every MCP line's mode as the gate takes it — a function as `ask`, a line with places at its loosest
 * ({@link loosestModeOf}). An `unavailable` MCP line is `deny`: until what an agent is handed reads it
 * (decision 0023 §3.9), refusing every call is the nearest the gate can come to the tool not being
 * there — and dropping the line would let the server's line, or `other`, answer for it. See
 * {@link permissionsOfPermissionSet}.
 */
export function mcpGateModes(permissionSet: PermissionSet): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "mcp") continue;
    if (entry.unavailable === true) {
      out[subject] = "deny";
      continue;
    }
    const mode = loosestModeOf(entry, toolElsewhere(permissionSet));
    if (mode !== undefined) out[subject] = gateModeOf(mode);
  }
  return out;
}

/**
 * Every subject whose OWN mode is a FUNCTION, to the function's reference — tools, commands, `script`,
 * the shell's own entry and `other` alike. What lowering writes as `permissions.functions`. A function
 * a line names only at a place is not here; {@link functionReferencesOf} has every one.
 */
export function permissionSetFunctions(permissionSet: PermissionSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (isFunctionMode(entry.mode)) out[subject] = entry.mode.function;
  }
  if (isFunctionMode(permissionSet.other)) out[OTHER_SUBJECT] = permissionSet.other.function;
  return out;
}

/** Every line that names a function, at its own mode or at a place, as [subject, reference] — in authored order. */
function functionLines(permissionSet: PermissionSet): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    for (const mode of decisionsOf(entry)) if (isFunctionMode(mode)) out.push([subject, mode.function]);
  }
  if (isFunctionMode(permissionSet.other)) out.push([OTHER_SUBJECT, permissionSet.other.function]);
  return out;
}

/** Every function a permission set names, at a line or at a place, each once, in the order first met. */
export function functionReferencesOf(permissionSet: PermissionSet): string[] {
  return [...new Set(functionLines(permissionSet).map(([, reference]) => reference))];
}

/** Whose code runs each tool, where an entry chose. */
export function toolImplementations(permissionSet: PermissionSet): Record<string, ToolImplementation> {
  const out: Record<string, ToolImplementation> = {};
  for (const [name, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "tool" && entry.implementation !== undefined) out[name] = entry.implementation;
  }
  return out;
}

/**
 * What a shell line's parts answer to beyond the standard tools: the command subjects, `script`, and
 * the shell's own entry (`shell`) as the mode for any other command — see the module header.
 *
 * Each line's OWN mode — its plain decision or its `**` — as {@link toolModes} gives a tool's: a line
 * with places and no `**` has none here, and its places ({@link linePlaces}) are read beside this by
 * `decideCommand`, which takes a part no place matches to the next less specific line.
 */
export function shellSubjects(permissionSet: PermissionSet): Record<string, PermissionSetMode> {
  const out: Record<string, PermissionSetMode> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (isShellLine(subject, entry) && entry.mode !== undefined) out[subject] = entry.mode;
  }
  return out;
}

/**
 * The permission set as the `permissions` block the upstream gate takes (`createToolGate`'s `authored`).
 *
 * `default` is never written: every offered tool carries its own mode by now, and what `default`
 * used to answer for a name nobody registered is what `other` says. A function is `ask` wherever the
 * block says a mode, and named in `functions` — see `PermissionsDecl.functions` for why that key is on
 * every lowered map.
 *
 * A line's PLACES (decision 0023 §3) ride in `places`, on every lowered map (empty when no line has
 * any), each line's whole map as authored with its own mode as `**` — see `PermissionsDecl.places`.
 * The gate is handed each tool line at its LOOSEST answer ({@link gateToolModes}, §3.10), `subjects`
 * a shell line's own mode where it has one, and the narrowing and `decideCommand` read the places to
 * tighten each call to its own answer. `subjects` is written whenever the set has a line a shell
 * line's parts answer to ({@link holdsShellLines}) — `{}` for a set whose only such line is a place map
 * with no `**` — since its presence is what says the set judges a shell line at all.
 */
export function permissionsOfPermissionSet(permissionSet: PermissionSet, source?: string | undefined, stack?: PermissionStackDecl | undefined): PermissionsDecl {
  const subjects: Record<string, PermissionMode> = {};
  for (const [subject, mode] of Object.entries(shellSubjects(permissionSet))) subjects[subject] = gateModeOf(mode);
  const hasSubjects = holdsShellLines(permissionSet);
  // A MAP leaves its marks, so a run can tell it from a state that declared none. See the module
  // header and {@link PERMISSION_SET_MARKERS}.
  //
  // An MCP line (`mcp__figma__get_code`, `mcp__figma`) lowers into `tools` too, at its gate mode: the
  // gate reads a tool's line by the name the agent calls it, and a server's line is asked by the
  // server's name for a tool no line names (`@jaira/runtime`'s `translatedGate`). None of them is in
  // the lowered LIST — nothing JaiRA registers is offered under them — so reading the block back finds
  // them as MCP entries ({@link permissionSetOfEnvironment}).
  const tools = { ...gateToolModes(permissionSet), ...mcpGateModes(permissionSet), ...PERMISSION_SET_MARKERS };
  // ALWAYS written, empty when every held tool is ours. Upstream merges `permissions` per key down the
  // `environment` chain, so a child whose map chose no implementation and so wrote no key inherited its
  // parent's whole `implementations` — a parent's `grep: native` kept claude's `Grep` on a child whose
  // own line said nothing of the kind. A map is the whole statement of what a state holds and whose code
  // serves it (decision 0007 §1); an empty key replaces the parent's.
  const implementations = toolImplementations(permissionSet);
  // Where the lines came from is what "add to the permission set" writes into — for a shell line's
  // parts, and for an MCP call, which is judged by name and answered the same way.
  const named = hasSubjects || Object.keys(mcpGateModes(permissionSet)).length > 0;
  return {
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(permissionSet.other !== undefined ? { other: gateModeOf(permissionSet.other) } : {}),
    ...(hasSubjects ? { subjects } : {}),
    ...(named && source !== undefined ? { source } : {}),
    functions: permissionSetFunctions(permissionSet),
    // ALWAYS written, for the reason `implementations` and `functions` are.
    places: loweredPlaces(permissionSet),
    implementations,
    // Who said each line (decision 0023 §2.7), when the caller composed a stack — a state's lowering
    // always does, so a child's map never names its parent's layers.
    ...(stack !== undefined ? { stack } : {}),
  };
}

/** Every line with places, as `PermissionsDecl.places` carries it: the whole map in authored words, the own mode as `**`. */
function loweredPlaces(permissionSet: PermissionSet): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [subject, places] of Object.entries(linePlaces(permissionSet))) {
    const entry = permissionSet.entries[subject]!;
    const map: Record<string, string> = entry.mode !== undefined ? { [PLACE_ANYWHERE]: modeWord(entry.mode) } : {};
    for (const [place, mode] of Object.entries(places)) map[place] = modeWord(mode);
    out[subject] = map;
  }
  return out;
}

/**
 * Read a block in the UPSTREAM shape back into a permission set — the inverse of {@link lowerPermissionSet}.
 *
 * What a loaded state holds is always this shape, so this is how the chat path and a run get from a
 * state's environment to the one map:
 *
 *  - every listed tool is an offered entry, at its `permissions.tools` mode — none where the block
 *    gives none (the always-granted tools of a turn that declared no permission set);
 *  - a `permissions.tools` mode for a tool the list does not offer is an un-offered entry
 *    ({@link PermissionSetEntry.offered});
 *  - `other`, and the carried `subjects` and `implementations`, come back as what they were — the
 *    shell's entry at its AUTHORED mode, which lowering carried in `subjects` beside the `ask` (or
 *    the withheld shell's `deny`) it wrote for the gate;
 *  - a subject `functions` names comes back as that function, over the `ask` the gate was told;
 *  - a line `places` carries comes back as its place map, its own mode the map's `**` (or none), over
 *    the loosest mode the gate was told — a function at a place by its name.
 *
 * `implementations` is the composer's map, folded over the block's own.
 */
export function permissionSetOfEnvironment(
  tools: readonly string[] | undefined,
  permissions?: PermissionsDecl | undefined,
  implementations?: Readonly<Record<string, ToolImplementation>> | undefined,
): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  const own = <T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined =>
    map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;
  const chosen = { ...permissions?.implementations, ...implementations };
  for (const name of tools ?? []) {
    const mode = own(permissions?.tools, name);
    const implementation = own(chosen, name);
    entries[name] = { kind: "tool", ...(mode !== undefined ? { mode } : {}), ...(implementation !== undefined ? { implementation } : {}) };
  }
  for (const [name, mode] of Object.entries(permissions?.tools ?? {})) {
    if (Object.hasOwn(entries, name) || isPermissionSetMarkKey(name)) continue;
    // An MCP line is never listed — nothing JaiRA registers is offered under it — so its mode here IS
    // the line, not a tool held back.
    entries[name] = isMcpSubject(name) ? { kind: "mcp", mode } : { kind: "tool", mode, offered: false };
  }
  for (const [subject, mode] of Object.entries(permissions?.subjects ?? {})) {
    const held = Object.hasOwn(entries, subject) ? entries[subject] : undefined;
    if (subject === SHELL_TOOL) {
      // The shell's entry was lowered as `ask` (or, WITHHELD — {@link shellWithheld} — left off the
      // list with the gate's `deny`, and held all the same); its authored mode is the one carried
      // here. A block that carries the shell's mode and holds no entry for it keeps it un-offered.
      if (held === undefined) {
        entries[subject] = { kind: "tool", mode, offered: false };
      } else {
        const { offered: _offered, ...entry } = held;
        entries[subject] = { ...entry, mode };
      }
      continue;
    }
    if (held !== undefined) continue;
    entries[subject] = { kind: subject === SCRIPT_SUBJECT ? "script" : parseRunnerSubject(subject) !== undefined ? "runner" : "command", mode };
  }
  // A function was lowered as `ask` wherever a mode is written; the reference is what it was.
  let other: PermissionSetMode | undefined = permissions?.other;
  for (const [subject, reference] of Object.entries(permissions?.functions ?? {})) {
    if (typeof reference !== "string" || reference.length === 0) continue;
    if (subject === OTHER_SUBJECT) {
      other = { function: reference };
      continue;
    }
    const held = Object.hasOwn(entries, subject) ? entries[subject] : undefined;
    if (held !== undefined) entries[subject] = { ...held, mode: { function: reference } };
  }
  // A line with places IS its map (`PermissionsDecl.places`): the mode `tools` gave it is the gate's
  // loosest, never the line's own, which is the map's `**` — or none.
  for (const [subject, map] of Object.entries(permissions?.places ?? {})) {
    if (map === null || typeof map !== "object") continue;
    let mode: PermissionSetMode | undefined;
    const places: Record<string, PermissionSetMode> = {};
    for (const [place, word] of Object.entries(map)) {
      const read = readDecision(word);
      if ("error" in read || "unavailable" in read) continue;
      if (place === PLACE_ANYWHERE) mode = read.mode;
      else places[place] = read.mode;
    }
    const held = Object.hasOwn(entries, subject) ? entries[subject] : undefined;
    const kind = subjectKindOf(subject);
    const base: PermissionSetEntry =
      held !== undefined
        ? held
        : kind === "command" || kind === "script" || kind === "runner"
          ? { kind }
          : { kind: "tool", offered: false };
    const { mode: _lowered, places: _places, ...rest } = base;
    entries[subject] = { ...rest, ...(mode !== undefined ? { mode } : {}), ...(Object.keys(places).length > 0 ? { places } : {}) };
  }
  return { entries, ...(other !== undefined ? { other } : {}) };
}

// --- lowering: a map-form state, in the shape the engine takes ----------------

/** The two fields of a block a permission set lowers into. */
export interface LoweredPermissionSet {
  tools: string[];
  permissions?: PermissionsDecl;
}

/**
 * One permission set, as `tools: string[]` and a `permissions` block. Nothing of a block's own authored
 * `permissions` survives beside it: an author writes nothing there (`PermissionsDecl`).
 */
export function lowerPermissionSet(permissionSet: PermissionSet, source?: string | undefined, stack?: PermissionStackDecl | undefined): LoweredPermissionSet {
  const permissions = permissionsOfPermissionSet(permissionSet, source, stack);
  return { tools: offeredTools(permissionSet), ...(Object.keys(permissions).length > 0 ? { permissions } : {}) };
}

/** An issue against one state file, with the path where it was written. */
export interface StatePermissionSetIssue extends PermissionSetIssue {
  stateId: string;
}

/**
 * Is this `tools` value a PERMISSION_SET, as against the other things the position can hold?
 *
 *  - an ARRAY is the list form, which is gone — {@link lowerStatePermissionSets} refuses it;
 *  - an object carrying a `$`-instruction other than `$ref` (`$expr`, `$any`, `$binding`, …) is a
 *    binding or a scoped name, and is the engine's;
 *  - a string, or a `$ref`, that is NOT written as a path (`review`, as against `$/permission-sets/…`,
 *    `./x`, `a/b`) is a scoped NAME (NAMES.md §6), and is the engine's too.
 *
 * Everything else — a plain map, a path reference, a path `$ref` with siblings — is a permission set.
 */
function isPermissionSetNode(value: unknown): boolean {
  const pathLike = (s: string): boolean => s.startsWith("$") || s.includes("/") || s.startsWith(".");
  if (typeof value === "string") return pathLike(value);
  if (Array.isArray(value)) return false;
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) if (key.startsWith("$") && key !== PERMISSION_SET_REF_KEY) return false;
  const reference = value[PERMISSION_SET_REF_KEY];
  return reference === undefined || (typeof reference === "string" && pathLike(reference));
}

/**
 * Lower every permission set in one state file, returning the file the engine is handed and what was wrong.
 *
 * The positions are the ones an `environment` block can sit in: the state's own `environment`, its
 * `operation`, and each child MOUNT's `environment` (§6.1).
 *
 * A block brought in whole by a reference — `"environment": "$/lib/env"`, or
 * `{ "$ref": "$/lib/env", …siblings }` with no `tools` of its own — is OPENED: the reference is
 * followed through `read`, down every reference its target starts from, to the `tools` and
 * `permissions` the block holds once expanded (the nearest `tools` wins whole and `permissions` merges
 * per key, as the engine's own `$ref` merge does). A permission set there lowers exactly as one written on
 * the state, and a permission set reference inside the target resolves from the target's file. The block
 * stays the reference it was — so every other field of the target, and every relative reference in
 * it, still means what it means where it lives — and the lowered `tools` and `permissions` ride
 * beside it as siblings, which the engine's `$ref` merge lets win: a sibling `tools` list REPLACES the
 * target's map, and the sibling `permissions` override the target's per key. A referenced block with
 * no permission set, or a reference that cannot be followed here, is left as it was for the engine, whose own
 * expansion reports a reference that names nothing.
 *
 * A file with no permission set in it comes back as the SAME object, untouched.
 *
 * The old forms are ERRORS: `tools` as a LIST (written, or in a file a reference names), and a
 * `permissions` block that says `tools`, `default`, `other` or `profile` — each was a mode, and a mode
 * is an entry of the map now (`default` is its `other`; a profile is the `deny` entries it meant) — or
 * `scopes`, the state table, whose places are a line's place map now (decision 0023 §3.7). A list
 * lowers to an empty map and the old keys are dropped, so a tolerant caller can go on.
 *
 * On an error the node lowers to what could be read (nothing, for a broken reference), so a tolerant
 * caller — the lint surface — can go on to load the rest; a strict one throws on the issues.
 *
 * `checkFunction`, when given, is asked about every function a permission set names — once per reference
 * per block — and what it answers is an ERROR at each entry naming it: a permission function that
 * does not resolve (a typo, a module nobody approved) must stop a run before it starts, not surface at
 * the first tool call. `@jaira/persistence` answers it by loading the call the way a run will.
 */
export function lowerStatePermissionSets(
  stateId: string,
  def: unknown,
  read: PermissionSetReader,
  checkFunction?: ((reference: string, stateId: string) => string | undefined) | undefined,
  /**
   * Each bucket's STANDING layers (`config.permissions.layers`, decision 0023 §2.6 step 2): laid over
   * the set a state names, by that set's bucket, and under the state's own lines. A map written on the
   * state names no bucket and takes none.
   */
  standing?: Readonly<Record<string, readonly string[]>> | undefined,
): { def: unknown; issues: StatePermissionSetIssue[] } {
  const issues: StatePermissionSetIssue[] = [];
  if (!isPlainObject(def)) return { def, issues };

  /**
   * One permission set node and the `permissions` beside it, lowered. `from` is the id a reference in the
   * node is relative to — the state's, or the referenced block's file — and `within` names that
   * block's reference in a message.
   */
  const lowerNode = (node: unknown, own: unknown, from: string, at: string, within: string | undefined): LoweredPermissionSet => {
    const modeKeys = isPlainObject(own) ? MODE_KEYS.filter((key) => own[key] !== undefined) : [];
    const found: PermissionSetIssue[] = [];
    let permissionSet: PermissionSet = { entries: {} };
    let stack: PermissionStackDecl | undefined;
    if (Array.isArray(node)) {
      found.push({ path: "", message: MAP_FORM_MESSAGE, severity: "error" });
    } else {
      // A reference that names a LIST fragment (`["shell"]` in a file) is the list form by reference.
      const reference = typeof node === "string" ? node : (node as Record<string, unknown>)[PERMISSION_SET_REF_KEY];
      let listed = false;
      if (typeof reference === "string") {
        try {
          listed = Array.isArray(read(reference, from).value);
        } catch {
          // Reported below, by the resolution that fails the same way.
        }
      }
      if (listed) {
        found.push({ path: "", message: `'${String(reference)}' names a list — ${MAP_FORM_MESSAGE}`, severity: "error" });
      } else {
        // The stack the node is (decision 0023 §2.6): the set it names, the bucket's standing layers,
        // the rest it names, its own lines — merged as `resolvePermissionSetDecl` merges, and who set
        // each line kept for the rows that name it.
        const resolved = resolvePermissionStack(node, read, from, found, { standing });
        const parsed = parsePermissionSet(resolved?.decl ?? {});
        if (resolved !== undefined) found.push(...parsed.issues);
        permissionSet = parsed.permissionSet;
        if (resolved !== undefined) stack = stackDeclOf(resolved);
      }
    }

    if (own !== undefined && !isPlainObject(own)) {
      found.push({ path: "", message: "a permission set cannot sit beside a bound or referenced `permissions` — write its modes as entries", severity: "error" });
    } else if (own !== undefined && modeKeys.length > 0) {
      found.push({ path: "", message: modeKeysMessage(modeKeys), severity: "error" });
    }
    if (checkFunction !== undefined) {
      const answered = new Map<string, string | undefined>();
      for (const [subject, reference] of functionLines(permissionSet)) {
        if (!answered.has(reference)) answered.set(reference, checkFunction(reference, stateId));
        const problem = answered.get(reference);
        if (problem !== undefined) found.push({ path: subject, message: `the function '${reference}' does not resolve: ${problem}`, severity: "error" });
      }
    }
    for (const issue of found) {
      issues.push({
        ...issue,
        ...(within !== undefined ? { message: `in the block '${within}' names: ${issue.message}` } : {}),
        stateId,
        path: issue.path === "" ? `${at}.tools` : `${at}.tools.${issue.path}`,
      });
    }
    // Where the shell's subjects came from, written beside them — see `PermissionsDecl.source`. A
    // bare reference names a FILE; a map, and a `$ref` that says more, are written where they stand.
    return lowerPermissionSet(permissionSet, typeof node === "string" ? node : INLINE_PERMISSION_SET, stack);
  };

  const lowerBlock = (block: unknown, at: string): unknown => {
    const reference = blockReference(block);
    if (reference !== undefined && !(isPlainObject(block) && block["tools"] !== undefined)) return lowerReferenced(block, reference, at);
    if (!isPlainObject(block)) return block;
    const node = block["tools"];
    const own = block["permissions"];
    if (!Array.isArray(node) && !isPermissionSetNode(node)) {
      // No permission set here. A `permissions` block that says modes is refused, and the modes dropped.
      const modeKeys = isPlainObject(own) ? MODE_KEYS.filter((key) => own[key] !== undefined) : [];
      if (modeKeys.length === 0) return block;
      issues.push({ stateId, path: `${at}.permissions`, message: modeKeysMessage(modeKeys), severity: "error" });
      const { permissions: _permissions, ...others } = block;
      const kept = withoutModeKeys(own as Record<string, unknown>);
      return { ...others, ...(Object.keys(kept).length > 0 ? { permissions: kept } : {}) };
    }
    const lowered = lowerNode(node, own, stateId, at, undefined);
    const { permissions: _permissions, ...others } = block;
    return { ...others, tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) };
  };

  /**
   * A block that IS a reference and says no `tools` of its own: opened, and its permission set lowered
   * BESIDE the reference, as siblings the engine's `$ref` merge lets win — see the function header.
   */
  const lowerReferenced = (block: unknown, reference: string, at: string): unknown => {
    const expanded = expandedFields(block, stateId, read, []);
    if (expanded === undefined) return block;
    const node = expanded.tools?.node;
    if (node === undefined || (!Array.isArray(node) && !isPermissionSetNode(node))) {
      // No permission set in it. Modes in its `permissions` are refused as they are on the state; they
      // cannot be dropped from beside a reference, which is one more reason a run will not start.
      const own = expanded.permissions;
      const modeKeys = isPlainObject(own) ? MODE_KEYS.filter((key) => own[key] !== undefined) : [];
      if (modeKeys.length > 0) {
        issues.push({ stateId, path: `${at}.permissions`, message: `in the block '${reference}' names: ${modeKeysMessage(modeKeys)}`, severity: "error" });
      }
      return block;
    }
    const lowered = lowerNode(node, expanded.permissions, expanded.tools!.from, at, reference);
    const { permissions: _permissions, ...siblings } = typeof block === "string" ? { [PERMISSION_SET_REF_KEY]: block } : (block as Record<string, unknown>);
    return { ...siblings, tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) };
  };

  let out: Record<string, unknown> = def;
  const set = (key: string, value: unknown): void => {
    if (value !== out[key]) out = { ...out, [key]: value };
  };
  set("environment", lowerBlock(def["environment"], "environment"));
  set("operation", lowerBlock(def["operation"], "operation"));
  const children = def["children"];
  if (isPlainObject(children)) {
    let mounts = children;
    for (const [key, mount] of Object.entries(children)) {
      if (!isPlainObject(mount)) continue;
      const environment = lowerBlock(mount["environment"], `children.${key}.environment`);
      if (environment !== mount["environment"]) mounts = { ...mounts, [key]: { ...mount, environment } };
    }
    set("children", mounts);
  }
  return { def: out, issues };
}

/** The reference a block is brought in by — `"$/lib/env"`, or `{ "$ref": "$/lib/env", … }` — when it is one. */
function blockReference(block: unknown): string | undefined {
  if (typeof block === "string") return block;
  if (isPlainObject(block) && typeof block[PERMISSION_SET_REF_KEY] === "string") return block[PERMISSION_SET_REF_KEY] as string;
  return undefined;
}

/** The two fields lowering reads off a block, as they stand once its references are expanded. */
interface ExpandedFields {
  /** The nearest `tools`, and the id a reference written inside it is relative to. */
  tools?: { node: unknown; from: string };
  permissions?: unknown;
}

/**
 * Follow a block's references to its `tools` and `permissions`, assembled as the engine's expansion
 * assembles them: the target first, then each layer of siblings over it — `tools` nearest-wins whole,
 * `permissions` per key with its own `tools` per key, a bound block on either side replacing. The
 * block's other fields are not read; they stay the engine's.
 *
 * `undefined` when a reference cannot be followed here — no filesystem, a file that is not there, a
 * cycle — which the engine's own expansion then meets and reports in its own words.
 */
function expandedFields(block: unknown, from: string, read: PermissionSetReader, active: readonly string[]): ExpandedFields | undefined {
  const reference = blockReference(block);
  let base: ExpandedFields = {};
  if (reference !== undefined) {
    let source: PermissionSetSource;
    try {
      source = read(reference, from);
    } catch {
      return undefined;
    }
    if (active.includes(source.key)) return undefined;
    const inner = expandedFields(source.value, source.from, read, [...active, source.key]);
    if (inner === undefined) return undefined;
    base = inner;
  }
  if (!isPlainObject(block)) return reference !== undefined ? base : {};
  const tools = block["tools"] !== undefined ? { node: block["tools"], from } : base.tools;
  const permissions = mergePermissionsBlock(base.permissions, block["permissions"]);
  return { ...(tools !== undefined ? { tools } : {}), ...(permissions !== undefined ? { permissions } : {}) };
}

/** `over` onto `base`, as the engine merges a `permissions` field down a `$ref` or an `environment` chain. */
function mergePermissionsBlock(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  const bound = (p: unknown): boolean => !isPlainObject(p) || "$expr" in p || "$binding" in p;
  if (base === undefined || bound(base) || bound(over)) return over;
  const prior = base as Record<string, unknown>;
  const next = over as Record<string, unknown>;
  const priorTools = isPlainObject(prior["tools"]) ? prior["tools"] : undefined;
  const nextTools = isPlainObject(next["tools"]) ? next["tools"] : undefined;
  return { ...prior, ...next, ...(priorTools !== undefined || nextTools !== undefined ? { tools: { ...priorTools, ...nextTools } } : {}) };
}

/**
 * Keys of an authored `permissions` block that are refused: those that say a MODE — which only a
 * permission set's entries say — and `scopes`, the state table whose places moved onto lines (decision
 * 0023 §3.7). An author writes nothing in `permissions` now; every key in a lowered block is lowering's.
 */
const MODE_KEYS = ["tools", "default", "other", "profile", "scopes"] as const;

const MAP_FORM_MESSAGE = "`tools` is a permission set: a map from a tool, a command, `script` or `other` to a mode, or a reference to one";

function modeKeysMessage(keys: readonly string[]): string {
  const modes = keys.filter((key) => key !== "scopes");
  const sentences: string[] = [];
  if (modes.length > 0) {
    sentences.push(
      `permissions.${modes.join(", permissions.")} ${modes.length === 1 ? "is" : "are"} not a setting of \`permissions\` — a mode is an entry of the permission set in \`tools\` (decision 0007)`,
    );
  }
  if (keys.includes("scopes")) {
    sentences.push(
      'permissions.scopes is gone — where a tool may act is a map of places on its line in `tools`, e.g. "read_file": { "**": "deny", "docs/product": "allow" }, with `**` for everywhere else (decision 0023 §3.7)',
    );
  }
  return sentences.join("; ");
}

function withoutModeKeys(permissions: Record<string, unknown>): Record<string, unknown> {
  const out = { ...permissions };
  for (const key of MODE_KEYS) delete out[key];
  return out;
}

// --- the composer's settings -------------------------------------------------

/** The four fields of a message's settings a permission set is read from. */
type ToolSettings = Pick<ChatSettings, "tools" | "permissions" | "implementations" | "permissionSet">;

/**
 * Whether these settings say anything about WHICH tools are offered.
 *
 * Absent is a real answer on the chat path — "the message said nothing, the state's declaration
 * stands" — and it is not the same as an empty grant, which offers nothing.
 */
export function declaresTools(settings: ToolSettings): boolean {
  return settings.permissionSet !== undefined || settings.tools !== undefined;
}

/**
 * A message's settings as the one map — from `permission set` when it is there, else folded from the list,
 * the `permissions` block and the `implementations` map a state's own declaration arrives as (the
 * composer writes `permission set` — decision 0007 step 5).
 *
 * A `permission set` that does not parse keeps what could be read; the issues are the caller's to show.
 */
export function permissionSetOfSettings(settings: ToolSettings): { permissionSet: PermissionSet; issues: PermissionSetIssue[] } {
  if (settings.permissionSet !== undefined) return parsePermissionSet(settings.permissionSet);
  return { permissionSet: permissionSetOfEnvironment(settings.tools, settings.permissions, settings.implementations), issues: [] };
}
