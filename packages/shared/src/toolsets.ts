/**
 * The toolset — what an agent may do, as one map from a SUBJECT to a MODE (decision 0007 §1).
 *
 * ```jsonc
 * { "read_file": "allow", "web_fetch": "ask", "bash": "deny", "git status": "allow", "other": "deny" }
 * ```
 *
 * Present means offered, with that mode. Absent means not offered. `other` is everything no entry
 * names. A value may be an object when whose code runs the tool is chosen too:
 * `{ "mode": "ask", "implementation": "native" }`.
 *
 * This module is the one place a toolset is read and written:
 *
 *  - {@link parseToolset} reads the MAP an author writes in `environment.tools`;
 *  - {@link lowerStateToolsets} writes a state's maps out in the shape the upstream engine takes
 *    (`tools: string[]` + a `permissions` block), because the engine reads a non-array `tools` as a
 *    BINDING and refuses a map outright (`unrecognized binding form`);
 *  - {@link toolsetOfEnvironment} reads that lowered shape back — what a loaded state, a message's
 *    inherited declaration and a run's resolved block all arrive as.
 *
 * A map is the only form. The old LIST form of `tools` and the old `permissions` block (`tools`,
 * `default`, `profile`) were read until every workflow had been migrated (decision 0007 step 7, and
 * the note of 2026-09-22 there); the linter now refuses them.
 *
 * Pure: no filesystem and no upstream import, so the renderer can read a toolset too. Following a
 * `$ref` needs a file, and that is handed in as a {@link ToolsetReader} — `@jaira/persistence` builds
 * one over the same reference resolver a workflow's other references use.
 *
 * ## The shell's entries
 *
 * A COMMAND subject (`git commit`, `git`) and `script` are kept on the {@link Toolset} and carried
 * through lowering under `permissions.subjects`, where the policy reads them at the moment a shell
 * line is decided: the line is taken apart and each part answers to its own subject (decision 0007
 * §4, `@jaira/runtime`'s `decideCommand`).
 *
 * The shell tool's OWN entry (`bash`) is the answer for "any other command" on such a line — not a
 * mode for the tool. So it lowers as `smart` in `permissions.tools` — the one mode under which the
 * gate reads the line before it answers — and its authored mode rides in `subjects` beside the
 * commands it stands behind. `"bash": "deny", "git status": "allow"` therefore offers the shell and
 * runs `git status`; every reader that wants the authored mode back goes through
 * {@link toolsetOfEnvironment}.
 *
 * A shell the map denies OUTRIGHT — `"bash": "deny"` and no command subject or `script` that allows,
 * asks or defers — is WITHHELD ({@link shellWithheld}): held as written, left off the lowered list,
 * `deny` at the gate, so an agent loses its own shell and codex's writing sandbox stays off.
 *
 * ## What a run reads
 *
 * The engine hands a run's policy and its executor the state's RESOLVED block, host keys included
 * (upstream `literalPermissions` and `ExecServices.authored`, declarative-ai 3f5e5cc and later) — so
 * `subjects`, `source`, `implementations` and a written `other` reach a run exactly as they reach a
 * conversation turn, and `implementation: "native"` is honoured in a run too (`withAgentToolset`).
 *
 * ## A state that declares no toolset
 *
 * A state whose `environment` chain names no toolset at all has said nothing about tools, which is
 * not the same statement as an empty map: an empty map offers nothing, and a delegated agent loses
 * every built-in; saying nothing leaves the agent as its executor built it, under the gate. Both
 * lower to a block with no tools in it, so a lowered map says it WAS one with {@link TOOLSET_MARKERS},
 * two entries in `permissions.tools` that no tool is named by. A run reads them off the block it is
 * handed (`ExecServices.authored`); `permissions.tools` merges per key down the `environment` chain,
 * so a child that inherits its parent's map inherits its marks with it.
 */
import { INLINE_TOOLSET } from "./commandParts";
import { PERMISSION_MODES, type ChatSettings, type PermissionMode, type PermissionsDecl, type ToolImplementation } from "./operationVocabulary";
import type { Scope } from "./scopes";
import { TOOL_SPEC_BY_NAME } from "./toolVocabulary";

/** The subject that answers for everything no entry names. */
export const OTHER_SUBJECT = "other";
/** The subject that answers for RUNNING A FILE — `./x.sh`, `npm run build` (decision 0007 §4). */
export const SCRIPT_SUBJECT = "script";
/** The shell tool: its entry answers for any command no other entry names (decision 0007 §4). */
export const SHELL_TOOL = "bash";
/** The key that starts a toolset from another — the same `$ref` every other block uses. */
export const TOOLSET_REF_KEY = "$ref";

/**
 * WRITTEN BY LOWERING, never authored: the two `permissions.tools` entries that say "this block was
 * a toolset MAP" rather than a state that declared none — see the module header. Not tools, never
 * offered, and stripped by every reader. A pair only because that is what every block lowered since
 * the migration carries; one would do, and changing it would turn every pinned snapshot's map into
 * a state that declared nothing.
 */
export const TOOLSET_MARKERS: Readonly<Record<string, PermissionMode>> = { "jaira:toolset+": "allow", "jaira:toolset-": "deny" };

/** Is this `permissions.tools` key one of the {@link TOOLSET_MARKERS} rather than a tool? */
export function isToolsetMarkKey(name: string): boolean {
  return Object.hasOwn(TOOLSET_MARKERS, name);
}

/** Does a block in the upstream shape carry the marks a lowered MAP leaves? */
export function isLoweredToolset(permissions: Pick<PermissionsDecl, "tools"> | undefined): boolean {
  const tools = permissions?.tools;
  return tools !== undefined && Object.entries(TOOLSET_MARKERS).every(([name, mode]) => Object.hasOwn(tools, name) && tools[name] === mode);
}

const IMPLEMENTATIONS: readonly ToolImplementation[] = ["app", "native"];

/** One authored entry: a mode, or a mode with the implementation chosen too. */
export type ToolsetEntryDecl = PermissionMode | { mode: PermissionMode; implementation?: ToolImplementation };

/** A toolset as AUTHORED, references already followed: subject → entry. */
export type ToolsetDecl = Record<string, ToolsetEntryDecl>;

/** What a subject names. `unknown-tool` is never stored — it is reported and dropped. */
export type SubjectKind = "tool" | "command" | "script" | "other" | "unknown-tool";

export interface ToolsetEntry {
  kind: "tool" | "command" | "script";
  /**
   * The entry's mode. An authored map entry always has one. Absent only where a block read back
   * ({@link toolsetOfEnvironment}) lists a tool it gives no mode — the always-granted tools of a turn
   * that declared no toolset — which resolves through the project baseline.
   */
  mode?: PermissionMode;
  implementation?: ToolImplementation;
  /**
   * `false` only from {@link toolsetOfEnvironment}: the lowered `permissions.tools` gives a mode for
   * a tool the lowered list does not offer — a withheld shell ({@link shellWithheld}), a tool nothing
   * serves yet, or an entry a child inherited per key from its parent's map beside its own list. The
   * mode is kept and the tool is not offered. An authored map never says this: `deny` is an entry.
   */
  offered?: false;
}

/** THE internal representation — what every consumer of a grant and its modes reads. */
export interface Toolset {
  /** Subject → entry, in authored order. Never holds `other`. */
  entries: Record<string, ToolsetEntry>;
  /** The mode for everything no entry names. */
  other?: PermissionMode;
}

export interface ToolsetIssue {
  /** Relative to the toolset node — a subject, or `` for the node itself. */
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
 * know (`reed_file`, `Glob`, `mcp__x__y`): nothing is offered under it, which the linter says.
 */
export function subjectKindOf(subject: string): SubjectKind {
  if (subject === OTHER_SUBJECT) return "other";
  if (subject === SCRIPT_SUBJECT) return "script";
  if (TOOL_SPEC_BY_NAME.has(subject)) return "tool";
  if (/\s/.test(subject)) return "command";
  return /^[a-z][a-z0-9.+-]*$/.test(subject) ? "command" : "unknown-tool";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Read a RESOLVED map (no `$ref` left in it) into a {@link Toolset}, saying what is wrong with it.
 *
 * Never throws. An entry that cannot be read is reported and left out, so one bad line costs that
 * line and the linter can still speak about the rest.
 */
export function parseToolset(decl: unknown): { toolset: Toolset; issues: ToolsetIssue[] } {
  const toolset: Toolset = { entries: {} };
  const issues: ToolsetIssue[] = [];
  if (!isPlainObject(decl)) {
    issues.push({ path: "", message: "a toolset is a map from a subject to a mode", severity: "error" });
    return { toolset, issues };
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
      error(`'${rawSubject}' is not a subject — '${TOOLSET_REF_KEY}' is the only instruction a toolset takes`);
      continue;
    }
    let mode: unknown;
    let implementation: unknown;
    if (isPlainObject(value)) {
      mode = value["mode"];
      implementation = value["implementation"];
      for (const key of Object.keys(value)) {
        if (key !== "mode" && key !== "implementation") warn(`'${key}' is not a field of an entry — it takes 'mode' and 'implementation'`);
      }
      if (mode === undefined) {
        error(`'${subject}' has no mode — write one of ${PERMISSION_MODES.join(", ")}`);
        continue;
      }
    } else {
      mode = value;
    }
    if (!isMode(mode)) {
      error(`'${subject}' has the mode ${JSON.stringify(mode)} — a mode is one of ${PERMISSION_MODES.join(", ")}`);
      continue;
    }
    if (implementation !== undefined && !IMPLEMENTATIONS.includes(implementation as ToolImplementation)) {
      error(`'${subject}' has the implementation ${JSON.stringify(implementation)} — it is one of ${IMPLEMENTATIONS.join(", ")}`);
      continue;
    }
    const kind = subjectKindOf(subject);
    if (kind === "other") {
      if (implementation !== undefined) warn("'other' names no one tool, so an implementation means nothing on it");
      toolset.other = mode;
      continue;
    }
    if (kind === "unknown-tool") {
      // Reported and dropped, which is what "falls to `other`" means: nothing is offered under a
      // name no tool has, and a call that turns up by it is answered by `other`.
      warn(`'${subject}' is not a tool JaiRA knows — nothing is offered under that name, and a call by it answers to 'other'`);
      continue;
    }
    if (kind !== "tool" && implementation !== undefined) warn(`'${subject}' is not a tool, so an implementation means nothing on it`);
    toolset.entries[subject] = {
      kind,
      mode,
      ...(kind === "tool" && implementation !== undefined ? { implementation: implementation as ToolImplementation } : {}),
    };
  }
  return { toolset, issues };
}

// --- references --------------------------------------------------------------

/** What a reference named: the node there, an identity for cycle detection, and where `./` now means. */
export interface ToolsetSource {
  value: unknown;
  /** Unique per (file, property) — what a cycle is detected and NAMED by. */
  key: string;
  /** The id a reference written INSIDE that file is relative to. */
  from: string;
}

/** Follow one reference. Throws when it names nothing; the message is reported as written. */
export type ToolsetReader = (reference: string, from: string) => ToolsetSource;

/**
 * Follow a toolset node's references down to one plain map.
 *
 * Three spellings, all of which the format already has (WORKFLOWS.md §2.2): a bare string is a
 * reference, `{ "$ref": …, …siblings }` starts from one and says more, and a plain map is itself. A
 * toolset FILE may start from another the same way. Sibling keys override per SUBJECT and replace
 * the entry whole — `"write_file": "ask"` over `{ mode: "allow", implementation: "native" }` leaves
 * no implementation behind, because an entry is one statement.
 *
 * A cycle is an error NAMING it. `undefined` when nothing usable came back; the issues say why.
 */
export function resolveToolsetDecl(
  node: unknown,
  read: ToolsetReader,
  from: string,
  issues: ToolsetIssue[],
  active: readonly string[] = [],
): Record<string, unknown> | undefined {
  const follow = (reference: string): Record<string, unknown> | undefined => {
    let source: ToolsetSource;
    try {
      source = read(reference, from);
    } catch (e) {
      issues.push({ path: "", message: (e as Error).message, severity: "error" });
      return undefined;
    }
    if (active.includes(source.key)) {
      issues.push({
        path: "",
        message: `toolset reference cycle: ${[...active.slice(active.indexOf(source.key)), source.key].join(" → ")}`,
        severity: "error",
      });
      return undefined;
    }
    if (typeof source.value !== "string" && !isPlainObject(source.value)) {
      issues.push({ path: "", message: `'${reference}' is not a toolset — a toolset is a map from a subject to a mode`, severity: "error" });
      return undefined;
    }
    return resolveToolsetDecl(source.value, read, source.from, issues, [...active, source.key]);
  };
  if (typeof node === "string") return follow(node);
  if (!isPlainObject(node)) {
    issues.push({ path: "", message: "a toolset is a map from a subject to a mode, or a reference to one", severity: "error" });
    return undefined;
  }
  const reference = node[TOOLSET_REF_KEY];
  if (reference === undefined) return node;
  if (typeof reference !== "string") {
    issues.push({ path: TOOLSET_REF_KEY, message: `'${TOOLSET_REF_KEY}' takes a reference, as a string`, severity: "error" });
    return undefined;
  }
  const base = follow(reference);
  if (base === undefined) return undefined;
  const { [TOOLSET_REF_KEY]: _ref, ...siblings } = node;
  return { ...base, ...siblings };
}

// --- what consumers read -----------------------------------------------------

/**
 * The GRANT: the tools offered, in authored order. Command subjects and `script` are not tools.
 *
 * What is HANDED to somebody — the list lowering writes for the engine to resolve against the
 * registry, and the set `viewOfToolset` calls held — so a tool that is named and not yet served
 * (`ToolSpec.unserved`) is never in it. {@link heldTools} is the list a person reads.
 */
export function offeredTools(toolset: Toolset): string[] {
  const withheld = shellWithheld(toolset);
  return heldTools(toolset).filter((name) => TOOL_SPEC_BY_NAME.get(name)?.unserved !== true && !(withheld && name === SHELL_TOOL));
}

/**
 * Is this map's shell HELD and yet handed to nobody — a shell the toolset denies outright?
 *
 * Present means offered, and a map's `bash` entry is the answer for "any other command" on a line
 * taken apart (decision 0007 §4). When that answer is `deny` and no command subject and no `script`
 * entry allows, asks or defers (`smart`) anything, every line the shell could run is refused — or
 * duplicates a standard tool the toolset serves directly (`cat` is `read_file`). Offering such a shell
 * is a door with nothing behind it that a RUN cannot see is shut: the gate is told `smart`, and on
 * codex a held shell turns the writing sandbox on. So it is withheld: {@link offeredTools} leaves it
 * out, {@link gateToolModes} answers `deny` for it, and an agent loses its own shell with it. The
 * entry is still HELD — it is what the author wrote, and it is what a person reads and matches.
 */
export function shellWithheld(toolset: Toolset): boolean {
  const shell = Object.hasOwn(toolset.entries, SHELL_TOOL) ? toolset.entries[SHELL_TOOL] : undefined;
  if (shell === undefined || shell.kind !== "tool" || shell.mode !== "deny") return false;
  return Object.values(toolset.entries).every((entry) => entry.kind === "tool" || entry.mode === "deny");
}

/**
 * Does the toolset HOLD this tool — is its line ticked?
 *
 * An un-offered entry (see {@link ToolsetEntry.offered}) is not held. The one exception is a tool
 * nothing serves yet: lowering leaves it out of the `tools` list (see {@link offeredTools}) and keeps
 * its mode, so a lowered block read back has it un-offered — and it was held. With no list it could
 * ever be on, its entry is the whole of the statement.
 */
export function holdsTool(toolset: Toolset, name: string): boolean {
  const entry = Object.hasOwn(toolset.entries, name) ? toolset.entries[name] : undefined;
  if (entry === undefined || entry.kind !== "tool") return false;
  return entry.offered !== false || TOOL_SPEC_BY_NAME.get(name)?.unserved === true;
}

/** Every tool the toolset holds, served or not, in authored order — what a person reads and counts. */
export function heldTools(toolset: Toolset): string[] {
  return Object.keys(toolset.entries).filter((name) => holdsTool(toolset, name));
}

/**
 * The mode a line with none of its own reads as — the permission ledger's own last resort.
 *
 * What a new line starts at, what the composer draws for a tool listed with no mode (a turn that
 * declared no toolset), and what {@link declOfToolset} writes for `other` when nothing said.
 */
export const MODE_WHEN_UNSET: PermissionMode = "ask";

/**
 * A {@link Toolset} as the MAP an author would write — the inverse of {@link parseToolset}.
 *
 * What the composer sends (`ChatSettings.toolset`) and what `+` keeps as a file. Only what is HELD is
 * written, because in a map present means offered: an un-offered mode has no spelling here and is
 * dropped. An implementation is written only where it is the agent's own, since ours is the
 * default. `other` is always written, so the map a person kept says what happens to everything it
 * does not name instead of leaving it to whoever reads it next.
 */
export function declOfToolset(toolset: Toolset): ToolsetDecl {
  const out: ToolsetDecl = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "tool" && !holdsTool(toolset, subject)) continue;
    const mode = entry.mode ?? MODE_WHEN_UNSET;
    out[subject] = entry.kind === "tool" && entry.implementation === "native" ? { mode, implementation: "native" } : mode;
  }
  out[OTHER_SUBJECT] = toolset.other ?? MODE_WHEN_UNSET;
  return out;
}

/** Every tool entry's mode, offered or not — what shadows the project baseline, per tool. */
export function toolModes(toolset: Toolset): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [name, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "tool" && entry.mode !== undefined) out[name] = entry.mode;
  }
  return out;
}

/**
 * {@link toolModes} as the GATE takes them: the shell's entry is `smart`, whatever it says — or
 * `deny` where the shell is withheld ({@link shellWithheld}), since there is then no line to read.
 *
 * Any other mode would answer for the tool before its line was read — `deny` would refuse the
 * `git status` the same toolset allows, `allow` would pre-approve a delegated agent's shell so that
 * no line was ever judged at all. The authored mode is not lost: it is the `bash` subject a part
 * falls to ({@link shellSubjects}).
 */
export function gateToolModes(toolset: Toolset): Record<string, PermissionMode> {
  const modes = toolModes(toolset);
  // A withheld shell has no line to read: nothing is offered, and the gate refuses it by name.
  if (Object.hasOwn(modes, SHELL_TOOL)) modes[SHELL_TOOL] = shellWithheld(toolset) ? "deny" : "smart";
  return modes;
}

/** Whose code runs each tool, where an entry chose. */
export function toolImplementations(toolset: Toolset): Record<string, ToolImplementation> {
  const out: Record<string, ToolImplementation> = {};
  for (const [name, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "tool" && entry.implementation !== undefined) out[name] = entry.implementation;
  }
  return out;
}

/**
 * What a shell line's parts answer to beyond the standard tools: the command subjects, `script`, and
 * the shell's own entry (`bash`) as the mode for any other command — see the module header.
 */
export function shellSubjects(toolset: Toolset): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if ((entry.kind !== "tool" || subject === SHELL_TOOL) && entry.mode !== undefined) out[subject] = entry.mode;
  }
  return out;
}

/**
 * The toolset as the `permissions` block the upstream gate takes (`createToolGate`'s `authored`).
 *
 * `default` is never written: every offered tool carries its own mode by now, and what `default`
 * used to answer for a name nobody registered is what `other` says. `scopes` are not part of a
 * toolset and pass through beside it.
 */
export function permissionsOfToolset(toolset: Toolset, scopes?: readonly Scope[] | undefined, source?: string | undefined): PermissionsDecl {
  const subjects = shellSubjects(toolset);
  const hasSubjects = Object.keys(subjects).length > 0;
  // A MAP leaves its marks, so a run can tell it from a state that declared none. See the module
  // header and {@link TOOLSET_MARKERS}.
  const tools = { ...gateToolModes(toolset), ...TOOLSET_MARKERS };
  // ALWAYS written, empty when every held tool is ours. Upstream merges `permissions` per key down the
  // `environment` chain, so a child whose map chose no implementation and so wrote no key inherited its
  // parent's whole `implementations` — a parent's `grep: native` kept claude's `Grep` on a child whose
  // own line said nothing of the kind. A map is the whole statement of what a state holds and whose code
  // serves it (decision 0007 §1); an empty key replaces the parent's.
  const implementations = toolImplementations(toolset);
  return {
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(toolset.other !== undefined ? { other: toolset.other } : {}),
    ...(hasSubjects ? { subjects, ...(source !== undefined ? { source } : {}) } : {}),
    implementations,
    ...(scopes !== undefined && scopes.length > 0 ? { scopes: [...scopes] } : {}),
  };
}

/**
 * Read a block in the UPSTREAM shape back into a toolset — the inverse of {@link lowerToolset}.
 *
 * What a loaded state holds is always this shape, so this is how the chat path and a run get from a
 * state's environment to the one map:
 *
 *  - every listed tool is an offered entry, at its `permissions.tools` mode — none where the block
 *    gives none (the always-granted tools of a turn that declared no toolset);
 *  - a `permissions.tools` mode for a tool the list does not offer is an un-offered entry
 *    ({@link ToolsetEntry.offered});
 *  - `other`, and the carried `subjects` and `implementations`, come back as what they were — the
 *    shell's entry at its AUTHORED mode, which lowering carried in `subjects` beside the `smart` (or
 *    the withheld shell's `deny`) it wrote for the gate.
 *
 * `implementations` is the composer's map, folded over the block's own.
 */
export function toolsetOfEnvironment(
  tools: readonly string[] | undefined,
  permissions?: PermissionsDecl | undefined,
  implementations?: Readonly<Record<string, ToolImplementation>> | undefined,
): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  const own = <T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined =>
    map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;
  const chosen = { ...permissions?.implementations, ...implementations };
  for (const name of tools ?? []) {
    const mode = own(permissions?.tools, name);
    const implementation = own(chosen, name);
    entries[name] = { kind: "tool", ...(mode !== undefined ? { mode } : {}), ...(implementation !== undefined ? { implementation } : {}) };
  }
  for (const [name, mode] of Object.entries(permissions?.tools ?? {})) {
    if (Object.hasOwn(entries, name) || isToolsetMarkKey(name)) continue;
    entries[name] = { kind: "tool", mode, offered: false };
  }
  for (const [subject, mode] of Object.entries(permissions?.subjects ?? {})) {
    const held = Object.hasOwn(entries, subject) ? entries[subject] : undefined;
    if (subject === SHELL_TOOL) {
      // The shell's entry was lowered as `smart` (or, WITHHELD — {@link shellWithheld} — left off the
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
  const other = permissions?.other;
  return { entries, ...(other !== undefined ? { other } : {}) };
}

// --- lowering: a map-form state, in the shape the engine takes ----------------

/** The two fields of a block a toolset lowers into. */
export interface LoweredToolset {
  tools: string[];
  permissions?: PermissionsDecl;
}

/**
 * One toolset, as `tools: string[]` and a `permissions` block.
 *
 * `rest` is the block's OWN `permissions`, of which only what a toolset does not say survives: its
 * `scopes`.
 */
export function lowerToolset(toolset: Toolset, rest?: PermissionsDecl | undefined, source?: string | undefined): LoweredToolset {
  const permissions = permissionsOfToolset(toolset, rest?.scopes, source);
  return { tools: offeredTools(toolset), ...(Object.keys(permissions).length > 0 ? { permissions } : {}) };
}

/** An issue against one state file, with the path where it was written. */
export interface StateToolsetIssue extends ToolsetIssue {
  stateId: string;
}

/**
 * Is this `tools` value a TOOLSET, as against the other things the position can hold?
 *
 *  - an ARRAY is the list form, which is gone — {@link lowerStateToolsets} refuses it;
 *  - an object carrying a `$`-instruction other than `$ref` (`$expr`, `$any`, `$binding`, …) is a
 *    binding or a scoped name, and is the engine's;
 *  - a string, or a `$ref`, that is NOT written as a path (`review`, as against `$/toolsets/…`,
 *    `./x`, `a/b`) is a scoped NAME (NAMES.md §6), and is the engine's too.
 *
 * Everything else — a plain map, a path reference, a path `$ref` with siblings — is a toolset.
 */
function isToolsetNode(value: unknown): boolean {
  const pathLike = (s: string): boolean => s.startsWith("$") || s.includes("/") || s.startsWith(".");
  if (typeof value === "string") return pathLike(value);
  if (Array.isArray(value)) return false;
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) if (key.startsWith("$") && key !== TOOLSET_REF_KEY) return false;
  const reference = value[TOOLSET_REF_KEY];
  return reference === undefined || (typeof reference === "string" && pathLike(reference));
}

/**
 * Lower every toolset in one state file, returning the file the engine is handed and what was wrong.
 *
 * The positions are the ones an `environment` block can sit in: the state's own `environment`, its
 * `operation`, and each child MOUNT's `environment` (§6.1).
 *
 * A block brought in whole by a reference — `"environment": "$/lib/env"`, or
 * `{ "$ref": "$/lib/env", …siblings }` with no `tools` of its own — is OPENED: the reference is
 * followed through `read`, down every reference its target starts from, to the `tools` and
 * `permissions` the block holds once expanded (the nearest `tools` wins whole and `permissions` merges
 * per key, as the engine's own `$ref` merge does). A toolset there lowers exactly as one written on
 * the state, and a toolset reference inside the target resolves from the target's file. The block
 * stays the reference it was — so every other field of the target, and every relative reference in
 * it, still means what it means where it lives — and the lowered `tools` and `permissions` ride
 * beside it as siblings, which the engine's `$ref` merge lets win: a sibling `tools` list REPLACES the
 * target's map, and the sibling `permissions` override the target's per key. A referenced block with
 * no toolset, or a reference that cannot be followed here, is left as it was for the engine, whose own
 * expansion reports a reference that names nothing.
 *
 * A file with no toolset in it comes back as the SAME object, untouched.
 *
 * The old forms are ERRORS: `tools` as a LIST (written, or in a file a reference names), and a
 * `permissions` block that says `tools`, `default`, `other` or `profile` — each was a mode, and a mode
 * is an entry of the map now (`default` is its `other`; a profile is the `deny` entries it meant). A
 * list lowers to an empty map and the old keys are dropped, so a tolerant caller can go on.
 *
 * On an error the node lowers to what could be read (nothing, for a broken reference), so a tolerant
 * caller — the lint surface — can go on to load the rest; a strict one throws on the issues.
 */
export function lowerStateToolsets(
  stateId: string,
  def: unknown,
  read: ToolsetReader,
): { def: unknown; issues: StateToolsetIssue[] } {
  const issues: StateToolsetIssue[] = [];
  if (!isPlainObject(def)) return { def, issues };

  /**
   * One toolset node and the `permissions` beside it, lowered. `from` is the id a reference in the
   * node is relative to — the state's, or the referenced block's file — and `within` names that
   * block's reference in a message.
   */
  const lowerNode = (node: unknown, own: unknown, from: string, at: string, within: string | undefined): LoweredToolset => {
    const oldKeys = isPlainObject(own) ? OLD_PERMISSION_KEYS.filter((key) => own[key] !== undefined) : [];
    const found: ToolsetIssue[] = [];
    let toolset: Toolset = { entries: {} };
    if (Array.isArray(node)) {
      found.push({ path: "", message: LIST_FORM_MESSAGE, severity: "error" });
    } else {
      // A reference that names a LIST fragment (`["bash"]` in a file) is the list form by reference.
      const reference = typeof node === "string" ? node : (node as Record<string, unknown>)[TOOLSET_REF_KEY];
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
        const resolved = resolveToolsetDecl(node, read, from, found);
        const parsed = parseToolset(resolved ?? {});
        if (resolved !== undefined) found.push(...parsed.issues);
        toolset = parsed.toolset;
      }
    }

    let rest: PermissionsDecl | undefined;
    if (own !== undefined && !isPlainObject(own)) {
      found.push({ path: "", message: "a toolset cannot sit beside a bound or referenced `permissions` — write its modes as entries", severity: "error" });
    } else if (own !== undefined) {
      rest = own as PermissionsDecl;
      if (oldKeys.length > 0) found.push({ path: "", message: oldPermissionsMessage(oldKeys), severity: "error" });
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
    return lowerToolset(toolset, rest, typeof node === "string" ? node : INLINE_TOOLSET);
  };

  const lowerBlock = (block: unknown, at: string): unknown => {
    const reference = blockReference(block);
    if (reference !== undefined && !(isPlainObject(block) && block["tools"] !== undefined)) return lowerReferenced(block, reference, at);
    if (!isPlainObject(block)) return block;
    const node = block["tools"];
    const own = block["permissions"];
    if (!Array.isArray(node) && !isToolsetNode(node)) {
      // No toolset here. A `permissions` block that still says modes is the old statement on its own.
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
   * A block that IS a reference and says no `tools` of its own: opened, and its toolset lowered
   * BESIDE the reference, as siblings the engine's `$ref` merge lets win — see the function header.
   */
  const lowerReferenced = (block: unknown, reference: string, at: string): unknown => {
    const expanded = expandedFields(block, stateId, read, []);
    if (expanded === undefined) return block;
    const node = expanded.tools?.node;
    if (node === undefined || (!Array.isArray(node) && !isToolsetNode(node))) {
      // No toolset in it. Old modes in its `permissions` are refused as they are on the state; they
      // cannot be dropped from beside a reference, which is one more reason a run will not start.
      const own = expanded.permissions;
      const oldKeys = isPlainObject(own) ? OLD_PERMISSION_KEYS.filter((key) => own[key] !== undefined) : [];
      if (oldKeys.length > 0) {
        issues.push({ stateId, path: `${at}.permissions`, message: `in the block '${reference}' names: ${oldPermissionsMessage(oldKeys)}`, severity: "error" });
      }
      return block;
    }
    const lowered = lowerNode(node, expanded.permissions, expanded.tools!.from, at, reference);
    const { permissions: _permissions, ...siblings } = typeof block === "string" ? { [TOOLSET_REF_KEY]: block } : (block as Record<string, unknown>);
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
  if (isPlainObject(block) && typeof block[TOOLSET_REF_KEY] === "string") return block[TOOLSET_REF_KEY] as string;
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
function expandedFields(block: unknown, from: string, read: ToolsetReader, active: readonly string[]): ExpandedFields | undefined {
  const reference = blockReference(block);
  let base: ExpandedFields = {};
  if (reference !== undefined) {
    let source: ToolsetSource;
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

/** The keys of a `permissions` block that said a MODE, before a toolset held them all. `scopes` is not one. */
const OLD_PERMISSION_KEYS = ["tools", "default", "other", "profile"] as const;

const LIST_FORM_MESSAGE =
  "`tools` is a toolset map — a map from a tool, a command, `script` or `other` to a mode, or a reference to one; the list form was removed (decision 0007)";

function oldPermissionsMessage(keys: readonly string[]): string {
  return `permissions.${keys.join(", permissions.")} ${keys.length === 1 ? "is" : "are"} no longer read — a mode is an entry of the toolset in \`tools\`, \`default\` is its \`other\`, and a profile is the \`deny\` entries it meant (decision 0007)`;
}

function withoutOldKeys(permissions: Record<string, unknown>): Record<string, unknown> {
  const out = { ...permissions };
  for (const key of OLD_PERMISSION_KEYS) delete out[key];
  return out;
}

// --- the composer's settings -------------------------------------------------

/** The four fields of a message's settings a toolset is read from. */
type ToolSettings = Pick<ChatSettings, "tools" | "permissions" | "implementations" | "toolset">;

/**
 * Whether these settings say anything about WHICH tools are offered.
 *
 * Absent is a real answer on the chat path — "the message said nothing, the state's declaration
 * stands" — and it is not the same as an empty grant, which offers nothing.
 */
export function declaresTools(settings: ToolSettings): boolean {
  return settings.toolset !== undefined || settings.tools !== undefined;
}

/**
 * A message's settings as the one map — from `toolset` when it is there, else folded from the list,
 * the `permissions` block and the `implementations` map a state's own declaration arrives as (the
 * composer writes `toolset` — decision 0007 step 5).
 *
 * A `toolset` that does not parse keeps what could be read; the issues are the caller's to show.
 */
export function toolsetOfSettings(settings: ToolSettings): { toolset: Toolset; issues: ToolsetIssue[] } {
  if (settings.toolset !== undefined) return parseToolset(settings.toolset);
  return { toolset: toolsetOfEnvironment(settings.tools, settings.permissions, settings.implementations), issues: [] };
}
