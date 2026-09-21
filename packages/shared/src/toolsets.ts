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
 * What a tool list, a `permissions` block and the composer's `implementations` map said in three
 * places is said here in one, and this module is the one place the three are read:
 *
 *  - {@link parseToolset} reads the MAP an author writes in `environment.tools`;
 *  - {@link toolsetOfLegacy} reads the old LIST and the old `permissions` block into the same shape,
 *    so everything downstream has one thing to consume and an unmigrated state runs as it did;
 *  - {@link lowerStateToolsets} writes a map-form state back out in the shape the upstream engine
 *    takes (`tools: string[]` + a `permissions` block), because the engine reads a non-array `tools`
 *    as a BINDING and refuses a map outright (`unrecognized binding form`).
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
 * `implementation: "native"` on a state the ENGINE runs is still carried and not enforced — the chat
 * path honours it through `planAgentTools`; a run injects ours, which is the governed choice, because
 * the engine hands an executor a state's tool LIST and a gate, and neither can say whose code was
 * chosen.
 *
 * ## The LEGACY reading, and how a run tells it from a map
 *
 * A state still written as a LIST (with or without the old `permissions` block) is the legacy
 * reading, and it runs EXACTLY as it did: on a delegated agent its list is a grant and not a fence,
 * so the built-ins of standard tools the list does not mention stay, under the gate. "Not in the
 * toolset → the native is removed" (decision 0007 §3) is what a MAP says — an inline map, a
 * `$/toolsets/…` reference, a `$ref` with overrides. Which one a state means is chosen when it is
 * migrated (0007 step 7), never inferred. {@link Toolset.legacy} carries the difference.
 *
 * A run does not see a `Toolset`: the engine hands an executor the tools it resolved and a GATE over
 * the state's `permissions` block, and nothing else. So a lowered map says it WAS a map in the one
 * place a gate can be asked about: {@link TOOLSET_MARKERS}, two entries in the lowered
 * `permissions.tools` that no tool is named by. They are a PAIR with different modes because a gate
 * answers `other` for a name it has no entry for — one marker could not be told from an `other` that
 * happened to agree with it; two that DISAGREE can only be entries. A legacy block never has them.
 *
 * ## There is no profile
 *
 * `permissions.profile` (`read-only` | `plan` | `full`) is gone as a concept (decision 0007 §1): what
 * it restrained is said by `deny` entries and `other`. An old block that still carries one is READ —
 * {@link applyLegacyProfile} turns it into the entries it used to mean — and nothing here writes one.
 */
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
 * a toolset MAP" — see the module header. Not tools, never offered, and stripped by every reader.
 */
export const TOOLSET_MARKERS: Readonly<Record<string, PermissionMode>> = { "jaira:toolset+": "allow", "jaira:toolset-": "deny" };

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
   * The entry's mode. Absent ONLY from the legacy list form, where a tool could be granted with no
   * mode of its own and resolve through the project baseline; an authored map entry always has one.
   */
  mode?: PermissionMode;
  implementation?: ToolImplementation;
  /**
   * `false` ONLY from the legacy reader: `permissions.tools` named a tool the `tools` list did not
   * grant. The mode still matters — a delegated agent's deny floor is built from it — so it is kept,
   * and the tool is still not offered. A map cannot say this, and has no need to: `deny` is an entry.
   */
  offered?: false;
}

/** THE internal representation — what every consumer of a grant and its modes reads. */
export interface Toolset {
  /** Subject → entry, in authored order. Never holds `other`. */
  entries: Record<string, ToolsetEntry>;
  /** The mode for everything no entry names. Legacy: `permissions.other ?? permissions.default`. */
  other?: PermissionMode;
  /**
   * `true` ONLY from {@link toolsetOfLegacy}: this came from a LIST and/or the old `permissions`
   * block, with no map. A legacy toolset is a GRANT on a delegated agent, as it always was — the
   * built-ins of standard tools it does not mention stay, under the gate — where a map is the whole
   * grant and what it does not hold is removed (decision 0007 §3). A map never has this.
   */
  legacy?: true;
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

// --- the legacy reader -------------------------------------------------------

/**
 * FROZEN — the tools `ToolSpec.readOnly` called NOT read-only on the day that flag was removed.
 *
 * Read by {@link applyLegacyProfile} and by nothing else, and never to be extended: it is a record of
 * what `"profile": "read-only"` MEANT when the states that still say it were written, not a fact
 * about tools. A tool registered after this was frozen was never covered by a profile, and a state
 * that wants it refused writes `deny`, or leaves it out of its toolset.
 */
export const LEGACY_NON_READ_ONLY_TOOLS: readonly string[] = ["edit", "write_file", "bash"];

/** FROZEN — the profile names that narrowed. `full` excluded nothing; any other name was custom. */
export const LEGACY_NARROWING_PROFILES: readonly string[] = ["read-only", "plan"];

/**
 * An old `permissions.profile`, as the MAP it used to mean (decision 0007 §1).
 *
 * `read-only` — and `plan`, which narrowed identically and which nothing authored — refused every tool
 * that could change anything, whatever the list granted and whatever mode sat beside it, and had no
 * opinion a person could rely on about a name it had never heard of. As a toolset that is: every tool
 * in {@link LEGACY_NON_READ_ONLY_TOOLS} is `deny` and NOT offered, and `other` is `deny`. `full` and
 * an absent profile change nothing. A custom name changes nothing either: JaiRA never registered one.
 *
 * Returns the SAME object when there is nothing to apply.
 */
export function applyLegacyProfile(toolset: Toolset, profile: string | undefined): Toolset {
  if (profile === undefined || !LEGACY_NARROWING_PROFILES.includes(profile)) return toolset;
  const entries: Record<string, ToolsetEntry> = { ...toolset.entries };
  for (const name of LEGACY_NON_READ_ONLY_TOOLS) entries[name] = { kind: "tool", mode: "deny", offered: false };
  return { entries, other: "deny", ...(toolset.legacy === true ? { legacy: true as const } : {}) };
}

/**
 * The old LIST form of `tools` and the old `permissions` block, as the same {@link Toolset}.
 *
 *  - every listed tool is an offered entry, with `permissions.tools[name] ?? permissions.default` as
 *    its mode — or none, when neither said, which resolves through the project baseline as it did;
 *  - a `permissions.tools` name the list did NOT grant is kept as an un-offered entry: its mode
 *    still reaches the baseline a delegated agent builds its deny floor from;
 *  - `default` becomes `other` (`permissions.other` wins where both were written);
 *  - `profile` becomes the entries it used to mean — see {@link applyLegacyProfile}.
 *
 * `implementations` is the composer's third map, folded onto the entries it names.
 */
export function toolsetOfLegacy(
  tools: readonly string[] | undefined,
  permissions?: Pick<PermissionsDecl, "tools" | "default" | "other" | "profile"> | undefined,
  implementations?: Readonly<Record<string, ToolImplementation>> | undefined,
): Toolset {
  const entries: Record<string, ToolsetEntry> = {};
  const own = <T>(map: Readonly<Record<string, T>> | undefined, name: string): T | undefined =>
    map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;
  for (const name of tools ?? []) {
    const mode = own(permissions?.tools, name) ?? permissions?.default;
    const implementation = own(implementations, name);
    entries[name] = { kind: "tool", ...(mode !== undefined ? { mode } : {}), ...(implementation !== undefined ? { implementation } : {}) };
  }
  for (const [name, mode] of Object.entries(permissions?.tools ?? {})) {
    if (Object.hasOwn(entries, name) || Object.hasOwn(TOOLSET_MARKERS, name)) continue;
    entries[name] = { kind: "tool", mode, offered: false };
  }
  const other = permissions?.other ?? permissions?.default;
  return applyLegacyProfile({ entries, ...(other !== undefined ? { other } : {}), legacy: true }, permissions?.profile);
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
  return heldTools(toolset).filter((name) => TOOL_SPEC_BY_NAME.get(name)?.unserved !== true);
}

/**
 * Does the toolset HOLD this tool — is its line ticked?
 *
 * An un-offered entry is the legacy reader's "a mode for a tool the list did not grant", and is not
 * held. The one exception is a tool nothing serves yet: lowering leaves it out of the `tools` list
 * (see {@link offeredTools}) and keeps its mode, so a lowered block read back has it un-offered —
 * and it was held. With no list it could ever be on, its entry is the whole of the statement.
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
 * Only the legacy list form can produce such a line (a tool granted with no mode anywhere); it is
 * what the composer has always drawn for it, and what {@link declOfToolset} writes when the map is
 * kept.
 */
export const MODE_WHEN_UNSET: PermissionMode = "ask";

/**
 * A {@link Toolset} as the MAP an author would write — the inverse of {@link parseToolset}.
 *
 * What the composer sends (`ChatSettings.toolset`) and what `+` keeps as a file. Only what is HELD is
 * written, because in a map present means offered: a legacy un-offered mode has no spelling here and
 * is dropped. An implementation is written only where it is the agent's own, since ours is the
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
 * {@link toolModes} as the GATE takes them: the shell's entry is `smart`, whatever it says.
 *
 * Any other mode would answer for the tool before its line was read — `deny` would refuse the
 * `git status` the same toolset allows, `allow` would pre-approve a delegated agent's shell so that
 * no line was ever judged at all. The authored mode is not lost: it is the `bash` subject a part
 * falls to ({@link shellSubjects}).
 */
export function gateToolModes(toolset: Toolset): Record<string, PermissionMode> {
  const modes = toolModes(toolset);
  if (Object.hasOwn(modes, SHELL_TOOL)) modes[SHELL_TOOL] = "smart";
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
export function permissionsOfToolset(toolset: Toolset, scopes?: readonly Scope[] | undefined): PermissionsDecl {
  // A MAP leaves its marks, so a run — which sees this block only through a gate — can tell it from
  // the legacy reading. See the module header and {@link TOOLSET_MARKERS}.
  const tools = { ...gateToolModes(toolset), ...(toolset.legacy === true ? {} : TOOLSET_MARKERS) };
  const subjects = shellSubjects(toolset);
  const implementations = toolImplementations(toolset);
  return {
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(toolset.other !== undefined ? { other: toolset.other } : {}),
    ...(Object.keys(subjects).length > 0 ? { subjects } : {}),
    ...(Object.keys(implementations).length > 0 ? { implementations } : {}),
    ...(scopes !== undefined && scopes.length > 0 ? { scopes: [...scopes] } : {}),
  };
}

/**
 * Read a block in the UPSTREAM shape back into a toolset — the inverse of {@link lowerToolset}.
 *
 * What a loaded state holds is always this shape, whichever form its author wrote, so this is how
 * the chat path gets from a state's environment to the one map. The carried `subjects` and
 * `implementations` come back as the entries they were.
 */
export function toolsetOfEnvironment(
  tools: readonly string[] | undefined,
  permissions?: PermissionsDecl | undefined,
  implementations?: Readonly<Record<string, ToolImplementation>> | undefined,
): Toolset {
  const toolset = toolsetOfLegacy(tools, permissions, { ...permissions?.implementations, ...implementations });
  // The marks a lowered MAP left say this block was never the legacy reading.
  if (isLoweredToolset(permissions)) delete toolset.legacy;
  for (const [subject, mode] of Object.entries(permissions?.subjects ?? {})) {
    if (Object.hasOwn(toolset.entries, subject)) {
      // The shell's entry was lowered as `smart`; its authored mode is the one carried here.
      if (subject === SHELL_TOOL) toolset.entries[subject] = { ...toolset.entries[subject]!, mode };
      continue;
    }
    // …and a block that carries the shell's mode without granting the shell keeps it un-offered.
    if (subject === SHELL_TOOL) {
      toolset.entries[subject] = { kind: "tool", mode, offered: false };
      continue;
    }
    toolset.entries[subject] = { kind: subject === SCRIPT_SUBJECT ? "script" : "command", mode };
  }
  return toolset;
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
 * `scopes`. A legacy `profile` beside the map is folded INTO the map ({@link applyLegacyProfile}) and
 * is not written out — the engine is never handed one by a lowering.
 */
export function lowerToolset(toolset: Toolset, rest?: PermissionsDecl | undefined): LoweredToolset {
  const narrowed = applyLegacyProfile(toolset, rest?.profile);
  const permissions = permissionsOfToolset(narrowed, rest?.scopes);
  return { tools: offeredTools(narrowed), ...(Object.keys(permissions).length > 0 ? { permissions } : {}) };
}

/** An issue against one state file, with the path where it was written. */
export interface StateToolsetIssue extends ToolsetIssue {
  stateId: string;
}

/**
 * Is this `tools` value a TOOLSET, as against the three other things the position can hold?
 *
 *  - an ARRAY is the legacy list, and is left exactly as written;
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
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) if (key.startsWith("$") && key !== TOOLSET_REF_KEY) return false;
  const reference = value[TOOLSET_REF_KEY];
  return reference === undefined || (typeof reference === "string" && pathLike(reference));
}

/**
 * Lower every toolset in one state file, returning the file the engine is handed and what was wrong.
 *
 * The positions are the ones an `environment` block can sit in: the state's own `environment`, its
 * `operation`, and each child MOUNT's `environment` (§6.1). A block brought in whole by a reference
 * (`"environment": "$/lib/env"`) is not opened — write the toolset on the state, or reference the
 * toolset rather than the block around it.
 *
 * A file with no toolset in it comes back as the SAME object, untouched — an unmigrated state is not
 * rewritten, which is what makes "runs exactly as before" true by construction.
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

  const lowerBlock = (block: unknown, at: string): unknown => {
    if (!isPlainObject(block) || !isToolsetNode(block["tools"])) return block;
    const node = block["tools"];
    const found: ToolsetIssue[] = [];
    // A reference that names a LIST fragment (`["bash"]` in a file) is the legacy form by reference.
    const reference = typeof node === "string" ? node : (node as Record<string, unknown>)[TOOLSET_REF_KEY];
    if (typeof reference === "string") {
      try {
        if (Array.isArray(read(reference, stateId).value)) return block;
      } catch {
        // Reported below, by the resolution that fails the same way.
      }
    }
    const resolved = resolveToolsetDecl(node, read, stateId, found);
    const parsed = parseToolset(resolved ?? {});
    if (resolved !== undefined) found.push(...parsed.issues);

    const own = block["permissions"];
    let rest: PermissionsDecl | undefined;
    if (own !== undefined && !isPlainObject(own)) {
      found.push({ path: "", message: "a toolset cannot sit beside a bound or referenced `permissions` — write its modes as entries", severity: "error" });
    } else if (own !== undefined) {
      rest = own as PermissionsDecl;
      if (rest.profile !== undefined) {
        found.push({
          path: "",
          message: `permissions.profile beside a toolset map is read as the entries it used to mean — ${LEGACY_NON_READ_ONLY_TOOLS.join(", ")} and 'other' as 'deny' under '${LEGACY_NARROWING_PROFILES.join("' or '")}', nothing otherwise — and is no longer handed to the engine; write those entries`,
          severity: "warning",
        });
      }
      const folded = (["tools", "default", "other"] as const).filter((key) => rest?.[key] !== undefined);
      if (folded.length > 0) {
        found.push({
          path: "",
          message: `permissions.${folded.join(", permissions.")} beside a toolset map ${folded.length === 1 ? "is" : "are"} ignored — a mode is an entry of the map, and 'default' is its 'other'`,
          severity: "warning",
        });
      }
    }
    for (const issue of found) {
      issues.push({ ...issue, stateId, path: issue.path === "" ? `${at}.tools` : `${at}.tools.${issue.path}` });
    }
    const lowered = lowerToolset(parsed.toolset, rest);
    const { permissions: _permissions, ...others } = block;
    return { ...others, tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) };
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
  if (settings.toolset !== undefined) {
    const parsed = parseToolset(settings.toolset);
    return { ...parsed, toolset: applyLegacyProfile(parsed.toolset, settings.permissions?.profile) };
  }
  return { toolset: toolsetOfEnvironment(settings.tools, settings.permissions, settings.implementations), issues: [] };
}
