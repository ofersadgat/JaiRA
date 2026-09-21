/**
 * Migrating authored workflows from the `tools` LIST and the old `permissions` block to TOOLSETS
 * (decision 0007 step 7).
 *
 * ## Why this is not a rewrite of what a state says
 *
 * A list is a grant and a map is a fence (`@jaira/runtime` `agentTools.ts`): a state written
 * `tools: ["read_file"]` + `profile: "read-only"` leaves a delegated claude its own `Glob`, `Grep`,
 * `WebFetch` and `WebSearch`, under the gate, and the map `{ "read_file": "allow", "other": "deny" }`
 * takes them away. So the map a state is given is derived from what the state DOES today —
 * MEASURED, by `handedToClaude`, through the engine, JaiRA's agent wrapper and the upstream executor
 * — and every rewrite is then held to the same measurement: before and after must hand the agent
 * the same reach and the same decision per standard tool, the same answer for its unmapped
 * built-ins, and the same `other`. A difference is a FAILURE unless it is one the caller accepted by
 * name (`ToleratedDifference`, both about the shell), and those are reported per block, never hidden.
 *
 * ## What is rewritten, and into what
 *
 * Every block that can hold a toolset — a state's `environment`, its `operation`, each child mount's
 * `environment` — that still holds a list, or modes with no list. For each, the EFFECTIVE block is
 * computed the way the engine computes it (`mergeOperationFields` down the chain of ancestors and
 * mounts), so what a child inherited is in the map it is given, and the child resolves to the same
 * thing afterwards whatever its ancestors became. Then, in order of preference:
 *
 *  1. a toolset on the search path that measures the same → `"tools": "$/toolsets/<bucket>/<name>"`;
 *  2. one that does with a few lines changed → `{ "$ref": …, "<subject>": "<mode>" }`;
 *  3. an inline map. `other` is always written: upstream merges `permissions` per key, so a child
 *     toolset that left it out would inherit its parent's.
 *
 * ## What it does not need
 *
 * The chain is walked here rather than by loading a bundle, because a bundle load needs every
 * TypeScript function a workflow calls to be compiled and approved, and a migration that could only
 * run on a workflow that already starts would not be able to read a person's shared root without
 * writing to it. The two fields that matter merge by upstream's own rule, imported; only the walk
 * down `children` is restated, and an ancestor block that cannot be read statically — a referenced
 * `environment`, a bound `tools` — is a REFUSAL for everything under it.
 *
 * Nothing here opens a project or a database. {@link planToolsetMigration} only reads.
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { mergeOperationFields, parseReferencedFile, resolveStateRef, stateIdFromPath, type OperationFields } from "@declarative-ai/hw";
import { handedDifferences, handedToClaude, type AgentHanded, type HandedDifference, type JairaPolicy, type ToleratedDifference } from "@jaira/runtime";
import {
  JAIRA_DIR_NAME,
  LEGACY_PERMISSION_KEYS,
  lowerStateToolsets,
  lowerToolset,
  OTHER_SUBJECT,
  parseJsoncText,
  toolsetOfLegacy,
  parseToolset,
  rewriteToolsBlocksText,
  rewriteToolsBlocksValue,
  SHELL_TOOL,
  stateFileFormatOf,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  TOOLSET_REF_KEY,
  unifiedDiff,
  type JairaPaths,
  type PermissionMode,
  type PermissionsDecl,
  type ToolsBlockRewrite,
  type ToolsetChoice,
} from "@jaira/shared";
import { isStateFile } from "./snapshots";
import { readToolsets, toolsetReader } from "./toolsets";
import { workflowLoadOptions } from "./workflowRefs";

// --- what a plan says -----------------------------------------------------------

/** Which of the three rewrites a block got. */
export type MigrationCase = "reference" | "reference+lines" | "inline";

/** One block of one state file, and what became of it. */
export interface BlockMigration {
  stateId: string;
  /** The file, relative to the workflows directory. */
  file: string;
  /** `environment`, `operation`, `children.<key>.environment`. */
  at: string;
  outcome: MigrationCase | "refused";
  /** The node `tools` becomes. Absent when refused. */
  tools?: string | Record<string, unknown>;
  /** Why nothing was written for this block. */
  reason?: string;
  /** The differences no map could avoid, measured for this block — see `ToleratedDifference`. */
  tolerated: HandedDifference[];
}

/** One state, under one chain of ancestors, measured before and after. */
export interface StateProof {
  stateId: string;
  /** Root → … → state, as mounted. */
  chain: string;
  /** `environment`, `operation` or a mount — the level the effective block was taken at. */
  level: string;
  differences: HandedDifference[];
  /** True when the effective scope table is not the one it was. Always a failure. */
  scopesChanged: boolean;
}

export interface FileMigration {
  /** Absolute. */
  path: string;
  /** Relative to the workflows directory. */
  file: string;
  before: string;
  after: string;
  /** How the bytes were read, and so how they are written: a file that is not UTF-8 stays as it was. */
  encoding: "utf8" | "latin1";
  blocks: BlockMigration[];
}

export interface ToolsetMigrationPlan {
  workflowsDir: string;
  /** Files whose text changes. A file with only refused blocks is not here. */
  files: FileMigration[];
  /** Every block that held the old form, migrated or refused. */
  blocks: BlockMigration[];
  /** Blocks already written as a toolset — what makes a second run a no-op. */
  already: Array<{ stateId: string; at: string }>;
  /** Every measurement made after the rewrite, passing or not. */
  proofs: StateProof[];
  /** State files read from the workflows directory. */
  statesRead: number;
  unreadable: Array<{ file: string; message: string }>;
  /** Inline maps more than one block was given — candidates for a toolset file of their own. */
  sharedMaps: Array<{ map: Record<string, unknown>; blocks: string[] }>;
}

export interface PlanToolsetMigrationOptions {
  /** The layout whose `workflowsDir` is migrated; its other layers are read for context. */
  paths: JairaPaths;
  /** The project's policy, under which everything is measured. The default policy when absent. */
  policy?: JairaPolicy;
  /** How many lines a `$ref` may change before an inline map is clearer. */
  maxLines?: number;
  /**
   * The opt-in differences the caller accepts, both of them about the SHELL — `unlisted-shell` takes
   * away one claude kept and no map can hold, `shell-judged` lets a line be judged by the project's
   * command policy where a person used to be asked. Nothing is accepted unless named here, and a
   * block that needs one it was not given is refused with the flag in the reason.
   */
  accept?: readonly ToleratedDifference[];
}

const DEFAULT_MAX_LINES = 3;

// --- reading ---------------------------------------------------------------------

interface SourceFile {
  path: string;
  file: string;
  stateId: string;
  text: string;
  encoding: "utf8" | "latin1";
  doc: unknown;
  /** True for the layer being migrated; false for a lower layer, read for context only. */
  own: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bytes as text, in the encoding that gives the SAME bytes back — so a write changes only what it means to. */
function decode(bytes: Buffer): { text: string; encoding: "utf8" | "latin1" } {
  const utf8 = bytes.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(bytes)) return { text: utf8, encoding: "utf8" };
  return { text: bytes.toString("latin1"), encoding: "latin1" };
}

/** A state file's document. JSON with comments is read too: the rewrite can carry them, so it may as well. */
function parseStateText(file: string, text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return parseReferencedFile(file, body);
  } catch (e) {
    if (stateFileFormatOf(file) !== "json") throw e;
    const lenient = parseJsoncText(body);
    if (!lenient.ok) throw e;
    return lenient.value;
  }
}

function readLayer(dir: string, own: boolean, unreadable: Array<{ file: string; message: string }>): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (at: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !isStateFile(entry.name)) continue;
      const file = relative(dir, path);
      try {
        const { text, encoding } = decode(readFileSync(path));
        out.push({ path, file, stateId: stateIdFromPath(file), text, encoding, doc: parseStateText(file, text), own });
      } catch (e) {
        if (own) unreadable.push({ file, message: (e as Error).message });
      }
    }
  };
  walk(dir);
  return out;
}

// --- the chain --------------------------------------------------------------------

/** The two fields of a block this migration is about, or why they cannot be read off the file. */
type BlockFields = { tools?: string[]; permissions?: PermissionsDecl } | { opaque: string };

function fieldsOf(block: unknown, where: string): BlockFields {
  if (block === undefined) return {};
  if (!isPlainObject(block)) return { opaque: `${where} is a reference, and a referenced block is not opened` };
  const out: { tools?: string[]; permissions?: PermissionsDecl } = {};
  const tools = block["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string")) return { opaque: `${where}.tools is bound at run time` };
    out.tools = tools as string[];
  }
  const permissions = block["permissions"];
  if (permissions !== undefined) {
    if (!isPlainObject(permissions) || "$expr" in permissions || "$binding" in permissions) return { opaque: `${where}.permissions is bound at run time` };
    out.permissions = permissions as PermissionsDecl;
  }
  return out;
}

type Effective = { tools?: string[]; permissions?: PermissionsDecl };

function mergeFields(base: Effective | { opaque: string }, over: BlockFields): Effective | { opaque: string } {
  if ("opaque" in base) return base;
  if ("opaque" in over) return over;
  const merged = mergeOperationFields(base as OperationFields, over as OperationFields) as Effective;
  return {
    ...(merged.tools !== undefined ? { tools: merged.tools } : {}),
    ...(merged.permissions !== undefined ? { permissions: merged.permissions } : {}),
  };
}

interface Mount {
  key: string;
  child: string;
  environment: unknown;
}

/** One way a state is reached: the chain of ids, and what that chain hands it. */
interface Instance {
  chain: string;
  inherited: Effective | { opaque: string };
}

class Tree {
  readonly docs = new Map<string, SourceFile>();
  /** The documents as the ENGINE is handed them: every toolset already lowered. */
  readonly lowered = new Map<string, unknown>();
  readonly instances = new Map<string, Instance[]>();

  constructor(
    files: readonly SourceFile[],
    private readonly paths: JairaPaths,
  ) {
    for (const file of files) if (!this.docs.has(file.stateId)) this.docs.set(file.stateId, file);
    const read = toolsetReader(workflowLoadOptions(paths, { tolerant: true }));
    for (const [id, file] of this.docs) this.lowered.set(id, lowerStateToolsets(id, file.doc, read).def);
    this.walk();
  }

  mountsOf(id: string): Mount[] {
    const doc = this.lowered.get(id);
    if (!isPlainObject(doc)) return [];
    const children = doc["children"];
    if (children === undefined) {
      // Absent ⇒ every state one path segment below this one (WORKFLOWS.md §6).
      return [...this.docs.keys()]
        .filter((other) => other.startsWith(`${id}/`) && !other.slice(id.length + 1).includes("/"))
        .sort()
        .map((child) => ({ key: child.slice(id.length + 1), child, environment: undefined }));
    }
    if (!isPlainObject(children)) return [];
    const options = workflowLoadOptions(this.paths, { tolerant: true });
    const out: Mount[] = [];
    for (const [key, mount] of Object.entries(children)) {
      if (!isPlainObject(mount)) continue;
      const ref = typeof mount["state"] === "string" ? mount["state"] : `./${key}`;
      try {
        const child = resolveStateRef(ref, {
          ...(options.defaultRoot !== undefined ? { defaultRoot: options.defaultRoot } : {}),
          ...(options.roots !== undefined ? { roots: options.roots } : {}),
          ...(options.rootPath !== undefined ? { rootPath: options.rootPath } : {}),
          from: id,
        });
        out.push({ key, child, environment: mount["environment"] });
      } catch {
        // An unresolvable reference is the linter's to report; nothing is inherited through it.
      }
    }
    return out;
  }

  /** `inherited` ⊕ this state's own `environment` — what its operation and its children start from. */
  environmentOf(id: string, inherited: Instance["inherited"]): Effective | { opaque: string } {
    const doc = this.lowered.get(id);
    return mergeFields(inherited, fieldsOf(isPlainObject(doc) ? doc["environment"] : undefined, `${id}: environment`));
  }

  private walk(): void {
    const mounted = new Set<string>();
    for (const id of this.docs.keys()) for (const mount of this.mountsOf(id)) mounted.add(mount.child);
    const visit = (id: string, inherited: Instance["inherited"], path: readonly string[]): void => {
      if (path.includes(id) || !this.docs.has(id)) return;
      const chain = [...path, id];
      // Every chain is kept, not every DISTINCT inheritance: the proof pairs a chain before with the
      // same chain after, and two chains that inherit alike today need not tomorrow.
      this.instances.set(id, [...(this.instances.get(id) ?? []), { chain: chain.join(" → "), inherited }]);
      const environment = this.environmentOf(id, inherited);
      for (const mount of this.mountsOf(id)) {
        visit(mount.child, mergeFields(environment, fieldsOf(mount.environment, `${id}: children.${mount.key}.environment`)), chain);
      }
    };
    for (const id of this.docs.keys()) if (!mounted.has(id)) visit(id, {}, []);
    // A state only a cycle reaches is still a state somebody wrote: read it as a root.
    for (const id of this.docs.keys()) if (!this.instances.has(id)) visit(id, {}, []);
  }

  /** The effective block at one level of one state, per instance. */
  effectiveAt(id: string, level: string): Array<{ chain: string; effective: Effective | { opaque: string } }> {
    const doc = this.lowered.get(id);
    const own = isPlainObject(doc) ? doc : {};
    return (this.instances.get(id) ?? []).map((instance) => {
      const environment = this.environmentOf(id, instance.inherited);
      if (level === "environment") return { chain: instance.chain, effective: environment };
      if (level === "operation") return { chain: instance.chain, effective: mergeFields(environment, fieldsOf(own["operation"], `${id}: operation`)) };
      const key = /^children\.(.+)\.environment$/.exec(level)?.[1];
      const mount = isPlainObject(own["children"]) && key !== undefined ? (own["children"] as Record<string, unknown>)[key] : undefined;
      return { chain: instance.chain, effective: mergeFields(environment, fieldsOf(isPlainObject(mount) ? mount["environment"] : undefined, `${id}: ${level}`)) };
    });
  }

  /** Every level of a state a block can sit at. */
  levelsOf(id: string): string[] {
    const doc = this.lowered.get(id);
    if (!isPlainObject(doc)) return [];
    const out = ["environment"];
    if (isPlainObject(doc["operation"])) out.push("operation");
    if (isPlainObject(doc["children"])) {
      for (const [key, mount] of Object.entries(doc["children"])) if (isPlainObject(mount) && mount["environment"] !== undefined) out.push(`children.${key}.environment`);
    }
    return out;
  }
}

// --- the measurement, remembered ----------------------------------------------------

class Measure {
  private readonly seen = new Map<string, Promise<AgentHanded>>();
  constructor(private readonly policy: JairaPolicy | undefined) {}

  of(effective: Effective): Promise<AgentHanded> {
    const { scopes: _scopes, ...permissions } = effective.permissions ?? {};
    const key = JSON.stringify({ tools: effective.tools ?? null, permissions });
    let known = this.seen.get(key);
    if (known === undefined) {
      known = handedToClaude(effective, this.policy !== undefined ? { policy: this.policy } : {});
      this.seen.set(key, known);
    }
    return known;
  }
}

// --- the map a block is given ---------------------------------------------------------

/**
 * The toolset MAP that says what `before` measured: every standard tool the agent can reach, with
 * what decides a call to it, and `other`.
 *
 * `full` also names a tool that is held whether a toolset names it or not (`alwaysGranted`), which
 * `map` leaves to that rule unless the list it came from named it — so an inline map stays the size
 * of what its author said, and a shipped toolset that does name it still compares equal.
 *
 * The SHELL is the one entry not read off the measurement. A map's `bash` is the answer for "any
 * other command" on a line that is taken apart (decision 0007 §4), which is not a mode for the tool
 * and so is not what a probe of the tool measures; and `smart` there means "the project's policy
 * decides", which is exactly what a list that named the shell and gave it no mode of its own got
 * from the baseline. So the entry is the mode the LEGACY reading resolved, `smart` where nothing
 * said — and the measurement is then what says whether that preserved anything.
 */
function mapOf(
  before: AgentHanded,
  effective: Effective,
  legacyShellMode: PermissionMode | undefined,
  dropUnlistedShell: boolean,
): { map: Record<string, PermissionMode>; full: Record<string, PermissionMode> } {
  const listed = effective.tools ?? [];
  const map: Record<string, PermissionMode> = {};
  const full: Record<string, PermissionMode> = {};
  for (const spec of TOOL_SPECS) {
    const tool = before.tools[spec.name];
    if (tool === undefined || !tool.reachable) continue;
    // The opt-in: a shell the list never named, which claude kept as its own, is left out.
    if (spec.name === SHELL_TOOL && dropUnlistedShell && !listed.includes(SHELL_TOOL)) continue;
    const mode = spec.name === SHELL_TOOL ? (legacyShellMode ?? "smart") : (tool.decision ?? "ask");
    full[spec.name] = mode;
    if (spec.alwaysGranted !== true || listed.includes(spec.name)) map[spec.name] = mode;
  }
  // One `other` answers for the unmapped built-ins AND for a name nobody declared. Where the list
  // form REMOVED the built-ins (an old narrowing profile), only `deny` keeps them removed.
  const natives = Object.values(before.natives);
  const other: PermissionMode = natives.length > 0 && natives.every((answer) => answer === "removed") ? "deny" : before.other;
  map[OTHER_SUBJECT] = other;
  full[OTHER_SUBJECT] = other;
  return { map, full };
}

/** The lines a `$ref` to `choice` would have to change to say `full`, or `undefined` when no lines could. */
function linesOver(choice: ToolsetChoice, map: Record<string, PermissionMode>, full: Record<string, PermissionMode>): Record<string, PermissionMode> | undefined {
  const parsed = parseToolset(choice.decl);
  if (parsed.issues.some((issue) => issue.severity === "error")) return undefined;
  const lines: Record<string, PermissionMode> = {};
  for (const [subject, entry] of Object.entries(parsed.toolset.entries)) {
    // A command subject or `script` is a statement no list ever made, and a line cannot take it back.
    if (entry.kind !== "tool") return undefined;
    // A toolset of tools nothing serves yet (`chat_control`) is not what a workflow state meant.
    if (TOOL_SPEC_BY_NAME.get(subject)?.unserved === true) return undefined;
    // A run injects ours whatever the entry chose, so a `native` choice would be measured as equal
    // and read as a decision nobody made.
    if (entry.implementation === "native") return undefined;
    const want = full[subject];
    if (want === undefined) {
      // `"bash": "deny"` still OFFERS the shell — a held entry is a door, whatever its mode, and a
      // line cannot take a subject out of a map. A base that holds the shell is therefore no base
      // for a state that has none, `chat/read-only` included.
      if (subject === SHELL_TOOL) return undefined;
      if (entry.mode === "deny") continue;
      lines[subject] = "deny";
    } else if (want !== entry.mode) {
      lines[subject] = want;
    }
  }
  for (const [subject, mode] of Object.entries(map)) {
    if (subject === OTHER_SUBJECT || Object.hasOwn(parsed.toolset.entries, subject)) continue;
    lines[subject] = mode;
  }
  if (parsed.toolset.other !== full[OTHER_SUBJECT]) lines[OTHER_SUBJECT] = full[OTHER_SUBJECT]!;
  return lines;
}

/** Is `after` the grant `before` was — every difference one no map could avoid? */
function sameGrant(differences: readonly HandedDifference[]): boolean {
  return differences.every((difference) => difference.tolerated !== undefined);
}

// --- planning ---------------------------------------------------------------------------

/** Does this raw block still hold the old form? `already` when it holds a toolset instead. */
function blockFormOf(block: unknown): "legacy" | "already" | "none" {
  if (!isPlainObject(block)) return "none";
  const tools = block["tools"];
  if (Array.isArray(tools)) return "legacy";
  if (tools !== undefined) return typeof tools === "string" || (isPlainObject(tools) && Object.keys(tools).every((key) => !key.startsWith("$") || key === TOOLSET_REF_KEY)) ? "already" : "none";
  const permissions = block["permissions"];
  return isPlainObject(permissions) && LEGACY_PERMISSION_KEYS.some((key) => permissions[key] !== undefined) ? "legacy" : "none";
}

function blockAt(doc: unknown, level: string): unknown {
  let at: unknown = doc;
  for (const key of pathOf(level)) at = isPlainObject(at) ? at[key] : undefined;
  return at;
}

const pathOf = (level: string): string[] => {
  const mount = /^children\.(.+)\.environment$/.exec(level);
  return mount !== null ? ["children", mount[1]!, "environment"] : [level];
};

function rawLevelsOf(doc: unknown): string[] {
  if (!isPlainObject(doc)) return [];
  const out = ["environment", "operation"];
  if (isPlainObject(doc["children"])) for (const key of Object.keys(doc["children"])) out.push(`children.${key}.environment`);
  return out;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, held: unknown) => (isPlainObject(held) ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : held));

/**
 * Read a workflows directory and work out what a migration would write. Writes nothing.
 *
 * The result carries its own proof: `proofs` is every state measured before and after, and a file
 * whose rewrite any state fails under is taken back OUT of `files` and its blocks marked refused —
 * so what {@link applyToolsetMigration} writes is exactly what passed.
 */
export async function planToolsetMigration(options: PlanToolsetMigrationOptions): Promise<ToolsetMigrationPlan> {
  const { paths } = options;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const workflowsDir = paths.workflowsDir;
  const unreadable: Array<{ file: string; message: string }> = [];
  const own = readLayer(workflowsDir, true, unreadable);
  // The lower layers, for the ancestors and children a chain runs through. First layer wins per id.
  const lower = paths.roots
    .map((root) => join(root, "workflows"))
    .filter((dir) => resolve(dir) !== resolve(workflowsDir))
    .flatMap((dir) => readLayer(dir, false, []));
  const sources = [...own, ...lower];
  const before = new Tree(sources, paths);
  const measure = new Measure(options.policy);
  const choices = readToolsets(paths);

  const blocks: BlockMigration[] = [];
  const already: Array<{ stateId: string; at: string }> = [];
  const rewrites = new Map<string, ToolsBlockRewrite[]>();

  for (const source of own) {
    if (before.docs.get(source.stateId) !== source) continue; // shadowed by nothing above it, but be exact
    for (const level of rawLevelsOf(source.doc)) {
      const form = blockFormOf(blockAt(source.doc, level));
      if (form === "already") already.push({ stateId: source.stateId, at: level });
      if (form !== "legacy") continue;
      const block: BlockMigration = { stateId: source.stateId, file: source.file, at: level, outcome: "refused", tolerated: [] };
      blocks.push(block);

      const effectives = before.effectiveAt(source.stateId, level);
      const opaque = effectives.map((one) => one.effective).find((effective): effective is { opaque: string } => "opaque" in effective);
      if (opaque !== undefined) {
        block.reason = `what this block inherits cannot be read off the files: ${opaque.opaque}`;
        continue;
      }
      const distinct = new Map(effectives.map((one) => [canonical(one.effective), one.effective as Effective]));
      if (distinct.size !== 1) {
        block.reason = `the state is mounted under ${distinct.size} chains that hand it different tools (${effectives.map((one) => one.chain).join("; ")}), and one block cannot be the map for both`;
        continue;
      }
      const effective = [...distinct.values()][0]!;
      let measured: AgentHanded;
      try {
        measured = await measure.of(effective);
      } catch (e) {
        block.reason = (e as Error).message;
        continue;
      }
      const context = { permissions: effective.permissions, tools: effective.tools, ...(options.accept !== undefined ? { accept: options.accept } : {}) };
      // The shell's mode as the LEGACY reading resolved it — see `mapOf`.
      const legacy = toolsetOfLegacy(effective.tools, effective.permissions);
      const { map, full } = mapOf(measured, effective, legacy.entries[SHELL_TOOL]?.mode, options.accept?.includes("unlisted-shell") === true);

      // 1 and 2: a toolset on the search path, exactly or with a few lines changed — by MEASUREMENT.
      type Candidate = { node: string | Record<string, unknown>; outcome: MigrationCase; lines: number; differences: HandedDifference[] };
      let best: Candidate | undefined;
      for (const choice of choices) {
        const lines = linesOver(choice, map, full);
        if (lines === undefined || Object.keys(lines).length > maxLines) continue;
        if (best !== undefined && Object.keys(lines).length >= best.lines) continue;
        const lowered = lowerToolset(parseToolset({ ...choice.decl, ...lines }).toolset);
        const differences = handedDifferences(measured, await measure.of(lowered), context);
        if (!sameGrant(differences)) continue;
        const reference = `$/toolsets/${choice.id}`;
        best =
          Object.keys(lines).length === 0
            ? { node: reference, outcome: "reference", lines: 0, differences }
            : { node: { [TOOLSET_REF_KEY]: reference, ...lines }, outcome: "reference+lines", lines: Object.keys(lines).length, differences };
      }
      // 3: the inline map — and if even that does not measure the same, nothing is written.
      if (best === undefined) {
        const differences = handedDifferences(measured, await measure.of(lowerToolset(parseToolset(map).toolset)), context);
        if (!sameGrant(differences)) {
          block.reason = `no toolset map hands a claude agent what this block does today: ${describeDifferences(differences.filter((d) => d.tolerated === undefined))}${shellHint(measured, differences, effective.tools ?? [])}`;
          continue;
        }
        best = { node: map, outcome: "inline", lines: 0, differences };
      }
      block.outcome = best.outcome;
      block.tools = best.node;
      block.tolerated = best.differences;
      rewrites.set(source.path, [...(rewrites.get(source.path) ?? []), { at: pathOf(level), tools: best.node }]);
    }
  }

  // The text, and the check that it parses to exactly the document the rewrite describes.
  const texts = new Map<string, string>();
  const refuseFile = (source: SourceFile, reason: string): void => {
    texts.delete(source.path);
    for (const block of blocks) {
      if (block.file !== source.file || block.outcome === "refused") continue;
      block.outcome = "refused";
      block.reason = reason;
      delete block.tools;
    }
  };
  for (const source of own) {
    const planned = rewrites.get(source.path);
    if (planned === undefined) continue;
    try {
      const after = rewriteToolsBlocksText(source.text, stateFileFormatOf(source.file), planned);
      if (canonical(parseStateText(source.file, after)) !== canonical(rewriteToolsBlocksValue(source.doc, planned))) {
        throw new Error("the rewritten text does not parse to the rewritten document");
      }
      texts.set(source.path, after);
    } catch (e) {
      refuseFile(source, `the file could not be rewritten in place: ${(e as Error).message}`);
    }
  }

  // THE PROOF. Every state, under every chain, at every level, before and after — and a file any of
  // them fails under is taken back out, after which everything is measured again.
  let proofs: StateProof[] = [];
  for (let round = 0; round <= own.length; round += 1) {
    const after = new Tree(
      sources.map((source) => {
        const text = source.own ? texts.get(source.path) : undefined;
        return text === undefined ? source : { ...source, text, doc: parseStateText(source.file, text) };
      }),
      paths,
    );
    proofs = [];
    for (const id of before.docs.keys()) {
      for (const level of before.levelsOf(id)) {
        const was = before.effectiveAt(id, level);
        const now = after.effectiveAt(id, level);
        for (const a of was) {
          const b = now.find((one) => one.chain === a.chain);
          if ("opaque" in a.effective) continue;
          if (b === undefined || "opaque" in b.effective) {
            proofs.push({ stateId: id, chain: a.chain, level, differences: [{ subject: "block", before: "readable", after: "not readable" }], scopesChanged: false });
            continue;
          }
          let differences: HandedDifference[];
          try {
            differences = handedDifferences(await measure.of(a.effective), await measure.of(b.effective), {
              permissions: a.effective.permissions,
              tools: a.effective.tools,
              ...(options.accept !== undefined ? { accept: options.accept } : {}),
            });
          } catch (e) {
            // A block the engine refuses today (a tool nothing registers) is not one a rewrite broke.
            if (canonical(a.effective) === canonical(b.effective)) continue;
            differences = [{ subject: "block", before: "measured", after: (e as Error).message }];
          }
          const scopesChanged = canonical(a.effective.permissions?.scopes ?? null) !== canonical(b.effective.permissions?.scopes ?? null);
          proofs.push({ stateId: id, chain: a.chain, level, differences, scopesChanged });
        }
      }
    }
    const failed = proofs.filter((proof) => proof.scopesChanged || !sameGrant(proof.differences));
    if (failed.length === 0) break;
    let reverted = false;
    for (const proof of failed) {
      const why = `equivalence could not be proven for ${proof.stateId} (${proof.level}): ${proof.scopesChanged ? "its scope table changed" : describeDifferences(proof.differences.filter((d) => d.tolerated === undefined))}`;
      for (const id of proof.chain.split(" → ")) {
        const source = before.docs.get(id);
        if (source === undefined || !source.own || !texts.has(source.path)) continue;
        refuseFile(source, why);
        reverted = true;
      }
    }
    if (!reverted) break;
  }

  const files: FileMigration[] = [];
  for (const source of own) {
    const after = texts.get(source.path);
    if (after === undefined || after === source.text) continue;
    files.push({ path: source.path, file: source.file, before: source.text, after, encoding: source.encoding, blocks: blocks.filter((block) => block.file === source.file) });
  }
  const inline = new Map<string, { map: Record<string, unknown>; blocks: string[] }>();
  for (const block of blocks) {
    if (block.outcome !== "inline" || !isPlainObject(block.tools)) continue;
    const key = JSON.stringify(block.tools);
    const entry = inline.get(key) ?? { map: block.tools, blocks: [] };
    entry.blocks.push(`${block.stateId} (${block.at})`);
    inline.set(key, entry);
  }
  return {
    workflowsDir,
    files,
    blocks,
    already,
    proofs,
    statesRead: own.length,
    unreadable,
    sharedMaps: [...inline.values()].filter((entry) => entry.blocks.length > 1),
  };
}

/**
 * What to do about a block no map could say, where the shell is why — the two consents, each named.
 *
 * Both exist because a map cannot say what a list said about the shell, for two different reasons;
 * see `ToleratedDifference` in `@jaira/runtime`. Neither is assumed.
 */
function shellHint(measured: AgentHanded, differences: readonly HandedDifference[], listed: readonly string[]): string {
  if (measured.tools[SHELL_TOOL]?.reachable !== true) return "";
  const failures = differences.filter((difference) => difference.tolerated === undefined).map((difference) => difference.subject);
  const unlisted = !listed.includes(SHELL_TOOL);
  const away = unlisted
    ? "--accept unlisted-shell takes the shell away, which is the grant the list wrote down"
    : "leave `bash` out of the map by hand to take the shell away";
  if (failures.some((subject) => subject.startsWith("shell:"))) {
    return (
      `. Its shell answered every line with a person${unlisted ? ", through claude's own Bash, which the list never granted" : ""}. ` +
      "A map's shell entry is the answer for any other command on a line that is taken apart, and a RUN never sees it — the engine " +
      "hands the policy a state's tools, default, other and scopes, and drops the `permissions.subjects` the authored mode travels " +
      `in — so the line is judged by the project's command policy instead. --accept shell-judged migrates the block on those terms; ${away}`
    );
  }
  if (failures.includes(SHELL_TOOL)) {
    return `. No map holds the shell this block has: ${away}`;
  }
  return "";
}

function describeDifferences(differences: readonly HandedDifference[]): string {
  return differences.map((d) => `${d.subject}: ${d.before} → ${d.after}`).join("; ");
}

/** The proofs that did not pass. Empty is what a plan that may be written looks like. */
export function unprovenOf(plan: ToolsetMigrationPlan): StateProof[] {
  return plan.proofs.filter((proof) => proof.scopesChanged || !sameGrant(proof.differences));
}

// --- writing ----------------------------------------------------------------------------

export interface ApplyToolsetMigrationOptions {
  paths: JairaPaths;
  /**
   * The explicit second consent a write to the SHARED root takes. It is not a git repository and it
   * holds a person's hand-authored workflows, so `--write` alone never reaches it.
   */
  sharedRoot?: boolean;
  now?: () => Date;
}

/** Is `dir` inside the shared root — this layout's, or the real `~/.jaira` whatever the layout says? */
export function isUnderSharedRoot(dir: string, paths: JairaPaths): boolean {
  const target = resolve(dir).toLowerCase();
  return [paths.base.baseDir, join(homedir(), JAIRA_DIR_NAME)].some((root) => {
    const base = resolve(root).toLowerCase();
    return target === base || target.startsWith(base + sep);
  });
}

/**
 * Write a plan. Refuses the shared root without its own consent, and backs its `workflows/` folder
 * up — a timestamped copy beside it — BEFORE the first byte changes there.
 *
 * Refuses, having written nothing, when a file is no longer what the plan read.
 */
export function applyToolsetMigration(plan: ToolsetMigrationPlan, options: ApplyToolsetMigrationOptions): { written: string[]; backup?: string } {
  const shared = isUnderSharedRoot(plan.workflowsDir, options.paths);
  if (shared && options.sharedRoot !== true) {
    throw new Error(
      `${plan.workflowsDir} is in the shared root, which is not a git repository and holds hand-authored workflows. ` +
        `Nothing was written. Read the dry run, then pass --shared-root beside --write; a timestamped backup of workflows/ is made first`,
    );
  }
  if (unprovenOf(plan).length > 0) throw new Error("the plan holds a state whose equivalence was not proven; nothing was written");
  for (const file of plan.files) {
    const { text } = decode(readFileSync(file.path));
    if (text !== file.before) throw new Error(`${file.file} changed since the plan was made; nothing was written. Run the dry run again`);
  }
  if (plan.files.length === 0) return { written: [] };
  let backup: string | undefined;
  if (shared) {
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    backup = `${plan.workflowsDir}.backup-${stamp}`;
    if (existsSync(backup)) throw new Error(`${backup} already exists; nothing was written`);
    cpSync(plan.workflowsDir, backup, { recursive: true, errorOnExist: true });
  }
  const written: string[] = [];
  for (const file of plan.files) {
    writeFileSync(file.path, Buffer.from(file.after, file.encoding));
    written.push(file.path);
  }
  return { written, ...(backup !== undefined ? { backup } : {}) };
}

// --- the report -------------------------------------------------------------------------

const CASE_WORDS: Record<BlockMigration["outcome"], string> = {
  reference: "a toolset by reference",
  "reference+lines": "a toolset plus lines",
  inline: "an inline map",
  refused: "REFUSED",
};

const TOLERATED_WORDS: Record<string, string> = {
  "profile-unknown-name": "a tool name nobody declared was put to a person under the old profile and is refused by `other: deny` (tightened; `ask` would hand back Task, Agent and SlashCommand)",
  "unlisted-shell": "ACCEPTED BY FLAG: the list never named `bash` and claude kept its own, which no map can hold — the shell is taken away (tightened)",
  "shell-judged": "ACCEPTED BY FLAG: the list asked before every shell line; a map's lines are judged by the project's command policy instead, which MAY RUN what a person used to be asked about (decision 0007 §4)",
};

/** The dry run, as text: a diff per file, what each block became, and the proof's tally. */
export function renderToolsetMigration(plan: ToolsetMigrationPlan): string {
  const lines: string[] = [];
  lines.push(`toolset migration — ${plan.workflowsDir}`, "");
  for (const file of plan.files) {
    lines.push(`--- ${file.file}`, `+++ ${file.file}${file.encoding === "latin1" ? "   (not UTF-8: written back byte for byte as it was read)" : ""}`);
    lines.push(...unifiedDiff(file.before, file.after), "");
  }
  lines.push("blocks", "");
  for (const block of plan.blocks) {
    const node = block.tools === undefined ? "" : typeof block.tools === "string" ? `  ${block.tools}` : `  ${JSON.stringify(block.tools)}`;
    lines.push(`  ${block.stateId} (${block.at}): ${CASE_WORDS[block.outcome]}${node}`);
    if (block.reason !== undefined) lines.push(`      ${block.reason}`);
    for (const kind of new Set(block.tolerated.map((d) => d.tolerated))) {
      const which = block.tolerated.filter((d) => d.tolerated === kind);
      lines.push(`      differs, unavoidably: ${describeDifferences(which)}`);
    }
  }
  if (plan.blocks.length === 0) lines.push("  nothing here is written in the old form");
  lines.push("");

  const count = (outcome: BlockMigration["outcome"]): number => plan.blocks.filter((block) => block.outcome === outcome).length;
  const unproven = unprovenOf(plan);
  lines.push("summary", "");
  lines.push(`  state files read        ${plan.statesRead}`);
  lines.push(`  blocks in the old form  ${plan.blocks.length}  (in ${new Set(plan.blocks.map((b) => b.file)).size} files)`);
  lines.push(`    → by reference        ${count("reference")}`);
  lines.push(`    → reference + lines   ${count("reference+lines")}`);
  lines.push(`    → inline map          ${count("inline")}`);
  lines.push(`    → refused             ${count("refused")}`);
  lines.push(`  already toolsets        ${plan.already.length}`);
  lines.push(`  files that would change ${plan.files.length}`);
  lines.push(`  measurements            ${plan.proofs.length} (every state, every chain, every level, before and after)`);
  lines.push(`  unproven                ${unproven.length}`);
  for (const proof of unproven) lines.push(`    ✗ ${proof.stateId} (${proof.level}) via ${proof.chain}: ${proof.scopesChanged ? "scope table changed; " : ""}${describeDifferences(proof.differences)}`);
  for (const file of plan.unreadable) lines.push(`  unreadable              ${file.file}: ${file.message}`);
  const kinds = new Set(plan.blocks.flatMap((block) => block.tolerated.map((d) => d.tolerated!)));
  if (kinds.size > 0) {
    lines.push("", "differences no map can avoid (each is listed on the block it applies to)", "");
    for (const kind of kinds) lines.push(`  ${kind}: ${TOLERATED_WORDS[kind] ?? kind}`);
  }
  if (plan.sharedMaps.length > 0) {
    lines.push("", "the same inline map, more than once — save it as toolsets/<bucket>/<name>.json and run again to get references", "");
    for (const shared of plan.sharedMaps) {
      lines.push(`  ${JSON.stringify(shared.map)}`);
      lines.push(`    ${shared.blocks.length} blocks: ${shared.blocks.join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}
