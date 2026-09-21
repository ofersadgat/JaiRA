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
 * ## What is carried and not yet enforced
 *
 * A COMMAND subject (`git commit`, `git`) and `script` are accepted, validated, kept on the
 * {@link Toolset} and carried through lowering under `permissions.subjects`. Nothing judges a shell
 * line against them yet: taking a line apart into requests is decision 0007 §4 and a later task. Until
 * it lands, a shell line answers to the `bash` entry and the project's command policy, exactly as
 * before. The same goes for `implementation: "native"` on a state the ENGINE runs — the chat path
 * honours it through `planAgentTools`; a run injects ours, which is the governed choice, until the
 * executors declare their natives (§3).
 */
import { PERMISSION_MODES, type ChatSettings, type PermissionMode, type PermissionsDecl, type ToolImplementation } from "./operationVocabulary";
import type { Scope } from "./scopes";
import { TOOL_SPEC_BY_NAME } from "./toolVocabulary";

/** The subject that answers for everything no entry names. */
export const OTHER_SUBJECT = "other";
/** The subject that answers for RUNNING A FILE — `./x.sh`, `npm run build` (decision 0007 §4). */
export const SCRIPT_SUBJECT = "script";
/** The key that starts a toolset from another — the same `$ref` every other block uses. */
export const TOOLSET_REF_KEY = "$ref";

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
  /** LEGACY ONLY: `permissions.profile`, still honoured. A later task removes profiles (0007 §1). */
  profile?: string;
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
 * The old LIST form of `tools` and the old `permissions` block, as the same {@link Toolset}.
 *
 *  - every listed tool is an offered entry, with `permissions.tools[name] ?? permissions.default` as
 *    its mode — or none, when neither said, which resolves through the project baseline as it did;
 *  - a `permissions.tools` name the list did NOT grant is kept as an un-offered entry: its mode
 *    still reaches the baseline a delegated agent builds its deny floor from;
 *  - `default` becomes `other` (`permissions.other` wins where both were written);
 *  - `profile` rides along, still honoured.
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
    if (Object.hasOwn(entries, name)) continue;
    entries[name] = { kind: "tool", mode, offered: false };
  }
  const other = permissions?.other ?? permissions?.default;
  return {
    entries,
    ...(other !== undefined ? { other } : {}),
    ...(permissions?.profile !== undefined ? { profile: permissions.profile } : {}),
  };
}

// --- what consumers read -----------------------------------------------------

/** The GRANT: the tools offered, in authored order. Command subjects and `script` are not tools. */
export function offeredTools(toolset: Toolset): string[] {
  return Object.entries(toolset.entries)
    .filter(([, entry]) => entry.kind === "tool" && entry.offered !== false)
    .map(([name]) => name);
}

/** Every tool entry's mode, offered or not — what shadows the project baseline, per tool. */
export function toolModes(toolset: Toolset): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [name, entry] of Object.entries(toolset.entries)) {
    if (entry.kind === "tool" && entry.mode !== undefined) out[name] = entry.mode;
  }
  return out;
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
 * The command subjects and `script`, with their modes.
 *
 * ⚠️ CARRIED, NOT ENFORCED. Nothing reads this to judge a shell line yet — see the module header.
 */
export function shellSubjects(toolset: Toolset): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const [subject, entry] of Object.entries(toolset.entries)) {
    if (entry.kind !== "tool" && entry.mode !== undefined) out[subject] = entry.mode;
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
  const tools = toolModes(toolset);
  const subjects = shellSubjects(toolset);
  const implementations = toolImplementations(toolset);
  return {
    ...(toolset.profile !== undefined ? { profile: toolset.profile } : {}),
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
  for (const [subject, mode] of Object.entries(permissions?.subjects ?? {})) {
    if (Object.hasOwn(toolset.entries, subject)) continue;
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
 * `rest` is the block's OWN `permissions`, of which only what a toolset does not say survives:
 * `scopes`, and a legacy `profile`.
 */
export function lowerToolset(toolset: Toolset, rest?: PermissionsDecl | undefined): LoweredToolset {
  const permissions = permissionsOfToolset(
    { ...toolset, ...(toolset.profile === undefined && rest?.profile !== undefined ? { profile: rest.profile } : {}) },
    rest?.scopes,
  );
  return { tools: offeredTools(toolset), ...(Object.keys(permissions).length > 0 ? { permissions } : {}) };
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
 * the `permissions` block and the `implementations` map the composer still writes.
 *
 * A `toolset` that does not parse keeps what could be read; the issues are the caller's to show.
 */
export function toolsetOfSettings(settings: ToolSettings): { toolset: Toolset; issues: ToolsetIssue[] } {
  if (settings.toolset !== undefined) {
    const parsed = parseToolset(settings.toolset);
    const profile = settings.permissions?.profile;
    return profile === undefined ? parsed : { ...parsed, toolset: { ...parsed.toolset, profile } };
  }
  return { toolset: toolsetOfEnvironment(settings.tools, settings.permissions, settings.implementations), issues: [] };
}
