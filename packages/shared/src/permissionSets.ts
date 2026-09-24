/**
 * The permission set — what an agent may do, as one map from a SUBJECT to a MODE (decision 0007 §1).
 *
 * ```jsonc
 * { "read_file": "allow", "web_fetch": "ask", "bash": "deny", "git status": "allow", "other": "deny" }
 * ```
 *
 * Present means offered, with that mode. Absent means not offered. `other` is everything no entry
 * names. A value may be an object when whose code runs the tool is chosen too:
 * `{ "mode": "ask", "implementation": "native" }`.
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
 * A map is the only form. The old LIST form of `tools` and the old `permissions` block (`tools`,
 * `default`, `profile`) were read until every workflow had been migrated (decision 0007 step 7, and
 * the note of 2026-09-22 there); the linter now refuses them.
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
 * The shell tool's OWN entry (`bash`) is the answer for "any other command" on such a line — not a
 * mode for the tool. So it lowers as `ask` in `permissions.tools` — no line runs before the host has
 * read it: the narrowing takes the line apart, and the approver JaiRA hands the engine lets a line
 * every part of which is allowed through without asking anybody — and its authored mode rides in
 * `subjects` beside the commands it stands behind. `"bash": "deny", "git status": "allow"` therefore
 * offers the shell and runs `git status`; every reader that wants the authored mode back goes through
 * {@link permissionSetOfEnvironment}.
 *
 * A shell the map denies OUTRIGHT — `"bash": "deny"` and no command subject or `script` that allows,
 * asks or names a function — is WITHHELD ({@link shellWithheld}): held as written, left off the
 * lowered list, `deny` at the gate, so an agent loses its own shell and codex's writing sandbox stays
 * off.
 *
 * ## A mode that is a function
 *
 * Any entry — a tool, a command, `script`, `bash`, `other` — may name a FUNCTION instead of a word:
 * `"bash": { "function": "smart" }` (see `FunctionMode`). It lowers as `ask` wherever the gate reads a
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
import {
  PERMISSION_MODES,
  gateModeOf,
  isFunctionMode,
  isPermissionSetMode,
  type ChatSettings,
  type PermissionMode,
  type PermissionsDecl,
  type ToolImplementation,
  type PermissionSetMode,
} from "./operationVocabulary";
import type { Scope } from "./scopes";
import { TOOL_SPEC_BY_NAME } from "./toolVocabulary";

/** The subject that answers for everything no entry names. */
export const OTHER_SUBJECT = "other";
/** The subject that answers for RUNNING A FILE — `./x.sh`, `npm run build` (decision 0007 §4). */
export const SCRIPT_SUBJECT = "script";
/** The shell tool: its entry answers for any command no other entry names (decision 0007 §4). */
export const SHELL_TOOL = "bash";
/** The key that starts a permission set from another — the same `$ref` every other block uses. */
export const PERMISSION_SET_REF_KEY = "$ref";

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
 * One authored entry: a mode, or a mode with the implementation chosen too. A function mode may carry
 * the implementation beside its reference — `{ "function": "smart", "implementation": "native" }` —
 * as well as under `mode`.
 */
export type PermissionSetEntryDecl =
  | PermissionSetMode
  | { mode: PermissionSetMode; implementation?: ToolImplementation }
  | { function: string; implementation?: ToolImplementation };

/**
 * One authored entry as its two parts, whichever of the spellings it was written in — `"ask"`,
 * `{ "function": "smart" }`, `{ "mode": …, "implementation": … }`, `{ "function": …, "implementation": … }`.
 * For an entry already known to parse; what `parsePermissionSet` refuses is not re-judged here.
 */
export function entryOfDecl(entry: PermissionSetEntryDecl): { mode: PermissionSetMode; implementation?: ToolImplementation } {
  if (typeof entry === "string") return { mode: entry };
  const implementation = "implementation" in entry ? entry.implementation : undefined;
  const mode: PermissionSetMode = "mode" in entry ? entry.mode : { function: entry.function };
  return { mode, ...(implementation !== undefined ? { implementation } : {}) };
}

/** A permission set as AUTHORED, references already followed: subject → entry. */
export type PermissionSetDecl = Record<string, PermissionSetEntryDecl>;

/**
 * What a subject names. `unknown-tool` is never stored — it is reported and dropped.
 *
 * `mcp` is a tool of somebody else's MCP server (`mcp__figma__get_code`) or a server's own line
 * (`mcp__figma`), which stands for every tool of it no line names — see `mcpModeOf` in `./mcp`.
 * Neither is a tool JaiRA serves: nothing is offered under it, and the agent that has the server
 * calls the tool by that name, which is what the line judges.
 */
export type SubjectKind = "tool" | "command" | "script" | "mcp" | "other" | "unknown-tool";

export interface PermissionSetEntry {
  kind: "tool" | "command" | "script" | "mcp";
  /**
   * The entry's mode. An authored map entry always has one. Absent only where a block read back
   * ({@link permissionSetOfEnvironment}) lists a tool it gives no mode — the always-granted tools of a turn
   * that declared no permission set — which resolves through the project baseline.
   */
  mode?: PermissionSetMode;
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
 * `mcp__figma__get_code` are MCP subjects: a server's line and one of its tools'.
 */
export function subjectKindOf(subject: string): SubjectKind {
  if (subject === OTHER_SUBJECT) return "other";
  if (subject === SCRIPT_SUBJECT) return "script";
  if (isMcpSubject(subject)) return "mcp";
  if (TOOL_SPEC_BY_NAME.has(subject)) return "tool";
  if (/\s/.test(subject)) return "command";
  return /^[a-z][a-z0-9.+-]*$/.test(subject) ? "command" : "unknown-tool";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What a mode may be, as a sentence the linter can say after "a mode is". */
const MODE_SENTENCE = `one of ${PERMISSION_MODES.join(", ")}, or a function — { "function": "smart" }`;

/**
 * Read a RESOLVED map (no `$ref` left in it) into a {@link Permission set}, saying what is wrong with it.
 *
 * Never throws. An entry that cannot be read is reported and left out, so one bad line costs that
 * line and the linter can still speak about the rest.
 */
export function parsePermissionSet(decl: unknown): { permissionSet: PermissionSet; issues: PermissionSetIssue[] } {
  const permissionSet: PermissionSet = { entries: {} };
  const issues: PermissionSetIssue[] = [];
  if (!isPlainObject(decl)) {
    issues.push({ path: "", message: "a permission set is a map from a subject to a mode", severity: "error" });
    return { permissionSet, issues };
  }
  for (const [rawSubject, value] of Object.entries(decl)) {
    const subject = rawSubject.trim().replace(/\s+/g, " ");
    const error = (message: string): void => void issues.push({ path: rawSubject, message, severity: "error" });
    const warn = (message: string): void => void issues.push({ path: rawSubject, message, severity: "warning" });
    if (subject.length === 0) {
      error("a subject cannot be empty");
      continue;
    }
    if (subject.startsWith("$")) {
      error(`'${rawSubject}' is not a subject — '${PERMISSION_SET_REF_KEY}' is the only instruction a permission set takes`);
      continue;
    }
    let mode: unknown;
    let implementation: unknown;
    if (isPlainObject(value)) {
      // Two object spellings: `{ "mode": …, "implementation": … }`, and a FUNCTION mode, which may
      // carry the implementation beside its reference — `{ "function": "smart", "implementation": … }`.
      const named = value["function"] !== undefined;
      if (named && value["mode"] !== undefined) {
        error(`'${subject}' says both 'mode' and 'function' — a function IS the mode: write { "function": … }, or { "mode": { "function": … } }`);
        continue;
      }
      mode = named ? { function: value["function"] } : value["mode"];
      implementation = value["implementation"];
      for (const key of Object.keys(value)) {
        if (key !== "mode" && key !== "implementation" && key !== "function") {
          warn(`'${key}' is not a field of an entry — it takes 'mode' (or 'function') and 'implementation'`);
        }
      }
      if (mode === undefined) {
        error(`'${subject}' has no mode — write ${MODE_SENTENCE}`);
        continue;
      }
    } else {
      mode = value;
    }
    if (isPlainObject(mode) && Object.hasOwn(mode, "function") && typeof mode["function"] === "string") {
      // A function mode: the reference is what the call names, trimmed, and it must name something.
      const reference = mode["function"].trim();
      if (reference.length === 0 || Object.keys(mode).length !== 1) {
        error(`'${subject}' names a function ${JSON.stringify(mode)} — a function mode is { "function": "<reference>" } and nothing else`);
        continue;
      }
      mode = { function: reference };
    }
    if (!isPermissionSetMode(mode)) {
      error(
        mode === "smart"
          ? `'${subject}' has the mode "smart" — smart is a function now: write { "function": "smart" }`
          : `'${subject}' has the mode ${JSON.stringify(mode)} — a mode is ${MODE_SENTENCE}`,
      );
      continue;
    }
    if (implementation !== undefined && !IMPLEMENTATIONS.includes(implementation as ToolImplementation)) {
      error(`'${subject}' has the implementation ${JSON.stringify(implementation)} — it is one of ${IMPLEMENTATIONS.join(", ")}`);
      continue;
    }
    const kind = subjectKindOf(subject);
    if (kind === "other") {
      if (implementation !== undefined) warn("'other' names no one tool, so an implementation means nothing on it");
      permissionSet.other = mode;
      continue;
    }
    if (kind === "unknown-tool") {
      // Reported and dropped, which is what "falls to `other`" means: nothing is offered under a
      // name no tool has, and a call that turns up by it is answered by `other`.
      warn(`'${subject}' is not a tool JaiRA knows — nothing is offered under that name, and a call by it answers to 'other'`);
      continue;
    }
    if (kind !== "tool" && implementation !== undefined) warn(`'${subject}' is not a tool, so an implementation means nothing on it`);
    permissionSet.entries[subject] = {
      kind,
      mode,
      ...(kind === "tool" && implementation !== undefined ? { implementation: implementation as ToolImplementation } : {}),
    };
  }
  return { permissionSet, issues };
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

/**
 * Follow a permission set node's references down to one plain map.
 *
 * Three spellings, all of which the format already has (WORKFLOWS.md §2.2): a bare string is a
 * reference, `{ "$ref": …, …siblings }` starts from one and says more, and a plain map is itself. A
 * permission set FILE may start from another the same way. Sibling keys override per SUBJECT and replace
 * the entry whole — `"write_file": "ask"` over `{ mode: "allow", implementation: "native" }` leaves
 * no implementation behind, because an entry is one statement.
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
  const follow = (reference: string): Record<string, unknown> | undefined => {
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
    return resolvePermissionSetDecl(source.value, read, source.from, issues, [...active, source.key]);
  };
  if (typeof node === "string") return follow(node);
  if (!isPlainObject(node)) {
    issues.push({ path: "", message: "a permission set is a map from a subject to a mode, or a reference to one", severity: "error" });
    return undefined;
  }
  const reference = node[PERMISSION_SET_REF_KEY];
  if (reference === undefined) return node;
  if (typeof reference !== "string") {
    issues.push({ path: PERMISSION_SET_REF_KEY, message: `'${PERMISSION_SET_REF_KEY}' takes a reference, as a string`, severity: "error" });
    return undefined;
  }
  const base = follow(reference);
  if (base === undefined) return undefined;
  const { [PERMISSION_SET_REF_KEY]: _ref, ...siblings } = node;
  return { ...base, ...siblings };
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

/**
 * Is this map's shell HELD and yet handed to nobody — a shell the permission set denies outright?
 *
 * Present means offered, and a map's `bash` entry is the answer for "any other command" on a line
 * taken apart (decision 0007 §4). When that answer is `deny` and no command subject and no `script`
 * entry allows, asks or names a function, every line the shell could run is refused — or duplicates a
 * standard tool the permission set serves directly (`cat` is `read_file`). Offering such a shell is a door
 * with nothing behind it that a RUN cannot see is shut: the gate is told `ask`, and on codex a held
 * shell turns the writing sandbox on. So it is withheld: {@link offeredTools} leaves it
 * out, {@link gateToolModes} answers `deny` for it, and an agent loses its own shell with it. The
 * entry is still HELD — it is what the author wrote, and it is what a person reads and matches.
 */
export function shellWithheld(permissionSet: PermissionSet): boolean {
  const shell = Object.hasOwn(permissionSet.entries, SHELL_TOOL) ? permissionSet.entries[SHELL_TOOL] : undefined;
  if (shell === undefined || shell.kind !== "tool" || shell.mode !== "deny") return false;
  // Only what a LINE can run keeps the shell: a command, or `script`. A tool, or an MCP server's
  // line, is judged by name and never reaches the shell.
  return Object.values(permissionSet.entries).every((entry) => (entry.kind !== "command" && entry.kind !== "script") || entry.mode === "deny");
}

/**
 * Does the permission set HOLD this tool — is its line ticked?
 *
 * An un-offered entry (see {@link PermissionSetEntry.offered}) is not held. The one exception is a tool
 * nothing serves yet: lowering leaves it out of the `tools` list (see {@link offeredTools}) and keeps
 * its mode, so a lowered block read back has it un-offered — and it was held. With no list it could
 * ever be on, its entry is the whole of the statement.
 */
export function holdsTool(permissionSet: PermissionSet, name: string): boolean {
  const entry = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined;
  if (entry === undefined || entry.kind !== "tool") return false;
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
 * declared no permission set), and what {@link declOfPermissionSet} writes for `other` when nothing said.
 */
export const MODE_WHEN_UNSET: PermissionMode = "ask";

/**
 * A {@link Permission set} as the MAP an author would write — the inverse of {@link parsePermissionSet}.
 *
 * What the composer sends (`ChatSettings.permission set`) and what `+` keeps as a file. Only what is HELD is
 * written, because in a map present means offered: an un-offered mode has no spelling here and is
 * dropped. An implementation is written only where it is the agent's own, since ours is the
 * default. `other` is always written, so the map a person kept says what happens to everything it
 * does not name instead of leaving it to whoever reads it next.
 */
export function declOfPermissionSet(permissionSet: PermissionSet): PermissionSetDecl {
  const out: PermissionSetDecl = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "tool" && !holdsTool(permissionSet, subject)) continue;
    const mode = entry.mode ?? MODE_WHEN_UNSET;
    if (entry.kind === "tool" && entry.implementation === "native") {
      // A function carries the implementation beside its reference — the spelling `parsePermissionSet` reads.
      out[subject] = isFunctionMode(mode) ? { function: mode.function, implementation: "native" } : { mode, implementation: "native" };
    } else {
      out[subject] = isFunctionMode(mode) ? { function: mode.function } : mode;
    }
  }
  const other = permissionSet.other ?? MODE_WHEN_UNSET;
  out[OTHER_SUBJECT] = isFunctionMode(other) ? { function: other.function } : other;
  return out;
}

/** Every tool entry's mode, offered or not — what shadows the project baseline, per tool. */
export function toolModes(permissionSet: PermissionSet): Record<string, PermissionSetMode> {
  const out: Record<string, PermissionSetMode> = {};
  for (const [name, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "tool" && entry.mode !== undefined) out[name] = entry.mode;
  }
  return out;
}

/**
 * {@link toolModes} as the GATE takes them: a function is `ask` (see `gateModeOf`), and the shell's
 * entry is `ask` whatever it says — or `deny` where the shell is withheld ({@link shellWithheld}),
 * since there is then no line to read.
 *
 * Any other mode would answer for the shell before its line was read — `deny` would refuse the
 * `git status` the same permission set allows, `allow` would pre-approve a delegated agent's shell so that
 * no line was ever judged at all. `ask` reaches the host with the line in hand, every time: the
 * narrowing takes it apart, and the approver the host hands the engine runs the functions it names
 * and lets through, without asking anybody, a line every part of which the permission set allows. The
 * authored mode is not lost: it is the `bash` subject a part falls to ({@link shellSubjects}).
 */
export function gateToolModes(permissionSet: PermissionSet): Record<string, PermissionMode> {
  const modes: Record<string, PermissionMode> = {};
  for (const [name, mode] of Object.entries(toolModes(permissionSet))) modes[name] = gateModeOf(mode);
  // A withheld shell has no line to read: nothing is offered, and the gate refuses it by name.
  if (Object.hasOwn(modes, SHELL_TOOL)) modes[SHELL_TOOL] = shellWithheld(permissionSet) ? "deny" : "ask";
  return modes;
}

/** Every MCP line's mode as the gate takes it — a function as `ask`. See {@link permissionsOfPermissionSet}. */
export function mcpGateModes(permissionSet: PermissionSet): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "mcp" && entry.mode !== undefined) out[subject] = gateModeOf(entry.mode);
  }
  return out;
}

/**
 * Every subject whose entry is a FUNCTION, to the function's reference — tools, commands, `script`,
 * the shell's own entry and `other` alike. What lowering writes as `permissions.functions`.
 */
export function permissionSetFunctions(permissionSet: PermissionSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (isFunctionMode(entry.mode)) out[subject] = entry.mode.function;
  }
  if (isFunctionMode(permissionSet.other)) out[OTHER_SUBJECT] = permissionSet.other.function;
  return out;
}

/** Every function a permission set names, each once, in the order first met. */
export function functionReferencesOf(permissionSet: PermissionSet): string[] {
  return [...new Set(Object.values(permissionSetFunctions(permissionSet)))];
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
 * the shell's own entry (`bash`) as the mode for any other command — see the module header.
 */
export function shellSubjects(permissionSet: PermissionSet): Record<string, PermissionSetMode> {
  const out: Record<string, PermissionSetMode> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if ((entry.kind === "command" || entry.kind === "script" || subject === SHELL_TOOL) && entry.mode !== undefined) out[subject] = entry.mode;
  }
  return out;
}

/**
 * The permission set as the `permissions` block the upstream gate takes (`createToolGate`'s `authored`).
 *
 * `default` is never written: every offered tool carries its own mode by now, and what `default`
 * used to answer for a name nobody registered is what `other` says. `scopes` are not part of a
 * permission set and pass through beside it. A function is `ask` wherever the block says a mode, and named
 * in `functions` — see `PermissionsDecl.functions` for why that key is on every lowered map.
 */
export function permissionsOfPermissionSet(permissionSet: PermissionSet, scopes?: readonly Scope[] | undefined, source?: string | undefined): PermissionsDecl {
  const subjects: Record<string, PermissionMode> = {};
  for (const [subject, mode] of Object.entries(shellSubjects(permissionSet))) subjects[subject] = gateModeOf(mode);
  const hasSubjects = Object.keys(subjects).length > 0;
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
    implementations,
    ...(scopes !== undefined && scopes.length > 0 ? { scopes: [...scopes] } : {}),
  };
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
 *  - a subject `functions` names comes back as that function, over the `ask` the gate was told.
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
    entries[subject] = { kind: subject === SCRIPT_SUBJECT ? "script" : "command", mode };
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
  return { entries, ...(other !== undefined ? { other } : {}) };
}

// --- lowering: a map-form state, in the shape the engine takes ----------------

/** The two fields of a block a permission set lowers into. */
export interface LoweredPermissionSet {
  tools: string[];
  permissions?: PermissionsDecl;
}

/**
 * One permission set, as `tools: string[]` and a `permissions` block.
 *
 * `rest` is the block's OWN `permissions`, of which only what a permission set does not say survives: its
 * `scopes`.
 */
export function lowerPermissionSet(permissionSet: PermissionSet, rest?: PermissionsDecl | undefined, source?: string | undefined): LoweredPermissionSet {
  const permissions = permissionsOfPermissionSet(permissionSet, rest?.scopes, source);
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
 * is an entry of the map now (`default` is its `other`; a profile is the `deny` entries it meant). A
 * list lowers to an empty map and the old keys are dropped, so a tolerant caller can go on.
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
): { def: unknown; issues: StatePermissionSetIssue[] } {
  const issues: StatePermissionSetIssue[] = [];
  if (!isPlainObject(def)) return { def, issues };

  /**
   * One permission set node and the `permissions` beside it, lowered. `from` is the id a reference in the
   * node is relative to — the state's, or the referenced block's file — and `within` names that
   * block's reference in a message.
   */
  const lowerNode = (node: unknown, own: unknown, from: string, at: string, within: string | undefined): LoweredPermissionSet => {
    const oldKeys = isPlainObject(own) ? OLD_PERMISSION_KEYS.filter((key) => own[key] !== undefined) : [];
    const found: PermissionSetIssue[] = [];
    let permissionSet: PermissionSet = { entries: {} };
    if (Array.isArray(node)) {
      found.push({ path: "", message: LIST_FORM_MESSAGE, severity: "error" });
    } else {
      // A reference that names a LIST fragment (`["bash"]` in a file) is the list form by reference.
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
        found.push({ path: "", message: `'${String(reference)}' names a list — ${LIST_FORM_MESSAGE}`, severity: "error" });
      } else {
        const resolved = resolvePermissionSetDecl(node, read, from, found);
        const parsed = parsePermissionSet(resolved ?? {});
        if (resolved !== undefined) found.push(...parsed.issues);
        permissionSet = parsed.permissionSet;
      }
    }

    let rest: PermissionsDecl | undefined;
    if (own !== undefined && !isPlainObject(own)) {
      found.push({ path: "", message: "a permission set cannot sit beside a bound or referenced `permissions` — write its modes as entries", severity: "error" });
    } else if (own !== undefined) {
      rest = own as PermissionsDecl;
      if (oldKeys.length > 0) found.push({ path: "", message: oldPermissionsMessage(oldKeys), severity: "error" });
    }
    if (checkFunction !== undefined) {
      const answered = new Map<string, string | undefined>();
      for (const [subject, reference] of Object.entries(permissionSetFunctions(permissionSet))) {
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
    return lowerPermissionSet(permissionSet, rest, typeof node === "string" ? node : INLINE_PERMISSION_SET);
  };

  const lowerBlock = (block: unknown, at: string): unknown => {
    const reference = blockReference(block);
    if (reference !== undefined && !(isPlainObject(block) && block["tools"] !== undefined)) return lowerReferenced(block, reference, at);
    if (!isPlainObject(block)) return block;
    const node = block["tools"];
    const own = block["permissions"];
    if (!Array.isArray(node) && !isPermissionSetNode(node)) {
      // No permission set here. A `permissions` block that still says modes is the old statement on its own.
      const oldKeys = isPlainObject(own) ? OLD_PERMISSION_KEYS.filter((key) => own[key] !== undefined) : [];
      if (oldKeys.length === 0) return block;
      issues.push({ stateId, path: `${at}.permissions`, message: oldPermissionsMessage(oldKeys), severity: "error" });
      const { permissions: _permissions, ...others } = block;
      const kept = withoutOldKeys(own as Record<string, unknown>);
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
      // No permission set in it. Old modes in its `permissions` are refused as they are on the state; they
      // cannot be dropped from beside a reference, which is one more reason a run will not start.
      const own = expanded.permissions;
      const oldKeys = isPlainObject(own) ? OLD_PERMISSION_KEYS.filter((key) => own[key] !== undefined) : [];
      if (oldKeys.length > 0) {
        issues.push({ stateId, path: `${at}.permissions`, message: `in the block '${reference}' names: ${oldPermissionsMessage(oldKeys)}`, severity: "error" });
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

/** The keys of a `permissions` block that said a MODE, before a permission set held them all. `scopes` is not one. */
const OLD_PERMISSION_KEYS = ["tools", "default", "other", "profile"] as const;

const LIST_FORM_MESSAGE =
  "`tools` is a permission set map — a map from a tool, a command, `script` or `other` to a mode, or a reference to one; the list form was removed (decision 0007)";

function oldPermissionsMessage(keys: readonly string[]): string {
  return `permissions.${keys.join(", permissions.")} ${keys.length === 1 ? "is" : "are"} no longer read — a mode is an entry of the permission set in \`tools\`, \`default\` is its \`other\`, and a profile is the \`deny\` entries it meant (decision 0007)`;
}

function withoutOldKeys(permissions: Record<string, unknown>): Record<string, unknown> {
  const out = { ...permissions };
  for (const key of OLD_PERMISSION_KEYS) delete out[key];
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
