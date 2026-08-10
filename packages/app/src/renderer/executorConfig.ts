/**
 * Editing one executor's block inside one configuration layer (DESIGN §8.1).
 *
 * The Executors pane used to be able to write exactly one field — `enabled` — and everything else
 * about an executor (its binary, codex's sandbox, a generic CLI's argv, and above all WHICH secret
 * its credential is looked up under) had to be typed into `config.json` by hand. That is the gap
 * this module closes: it turns a form's values into a patch against the raw document of the layer
 * being edited.
 *
 * Three rules the rest of the app depends on, and each is why this is a module rather than a few
 * lines inside the store:
 *
 *  - **The LAYER's document is patched, never the merged one.** Saving the effective config into a
 *    project would copy every inherited value out of the shared root and freeze it there — a project
 *    that then stops tracking the base's changes without anyone having asked for that.
 *  - **An empty field REMOVES the key**, so the layer goes back to inheriting rather than pinning
 *    the value it happened to be showing. A block left with nothing in it is deleted outright, which
 *    is the difference between "this project overrides nothing" and "this project overrides nothing,
 *    verbosely".
 *  - **A generic-CLI override must be self-sufficient.** `agents.genericCli` merges by name, but the
 *    parser requires `command` on every entry, so an override created in the project layer carries
 *    the name and command forward rather than a lone `credential` that fails to parse.
 *
 * Pure functions over plain documents: no React, no IPC, and therefore testable without either.
 */
import { EXECUTOR_KINDS, type CredentialUse, type ExecutorField, type ExecutorKind } from "@jaira/shared/browser";

export type { ExecutorField } from "@jaira/shared/browser";

/**
 * Where each built-in executor's settings live inside `config.agents`.
 *
 * The registry name a workflow uses (`claude-code`) and the config key (`claudeCode`) are not the
 * same string, and they should not be: one is a stable identifier a state file depends on, the other
 * is a JSON field name. This map is the one place that knows both.
 */
export const EXECUTOR_CONFIG_KEYS: Record<string, string> = {
  "claude-code": "claudeCode",
  "claude-cli": "claudeCli",
  "codex-cli": "codex",
};

/** The registry name a `genericCli` entry takes when it names none — `AGENT_GENERIC_CLI` upstream. */
export const DEFAULT_GENERIC_NAME = "generic-cli";

/** The sandbox values codex accepts, in the order the parser lists them. */
export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * Which fields a kind actually has.
 *
 * Read from `EXECUTOR_KINDS` rather than decided here, because the config parser and the probe read
 * the same table: a field this form offered that the parser refused, or a key it asked for that the
 * runtime never reads, is exactly the drift one table exists to prevent. That drift was not
 * hypothetical — this used to offer an API key for `claude-cli`, which signs itself in and would
 * have ignored one.
 */
export function editableFields(kind: ExecutorKind): ExecutorField[] {
  return EXECUTOR_KINDS[kind].fields;
}

/** Whether this kind uses a key at all, which decides if the key entry is offered. */
export function credentialUseOf(kind: ExecutorKind): CredentialUse {
  return EXECUTOR_KINDS[kind].credential;
}

/**
 * Where each field lives inside an executor's config block.
 *
 * The three model fields are nested (`models.default`), the rest are flat. One map rather than a
 * branch at each call site, so a patch, a read and a placeholder all agree on the path.
 */
export const FIELD_PATHS: Record<ExecutorField, string> = {
  name: "name",
  command: "command",
  credential: "credential",
  sandbox: "sandbox",
  args: "args",
  prompt: "prompt",
  env: "env",
};

/** A field write. `undefined` REMOVES the key, which is how a layer goes back to inheriting. */
export type ExecutorPatch = Record<string, unknown>;

/** The executor a patch is aimed at — its identity plus the effective command, for a new override. */
export interface ExecutorTarget {
  name: string;
  kind: ExecutorKind;
  command?: string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The registry name of a `genericCli` entry, which is also its identity when layering. */
function genericName(entry: unknown): string {
  const name = isObject(entry) ? entry["name"] : undefined;
  return typeof name === "string" && name.length > 0 ? name : DEFAULT_GENERIC_NAME;
}

function agentsOf(doc: unknown): Record<string, unknown> | undefined {
  if (!isObject(doc)) return undefined;
  const agents = doc["agents"];
  return isObject(agents) ? agents : undefined;
}

/** Every `genericCli` entry a document declares, in order. */
export function genericEntries(doc: unknown): Array<Record<string, unknown>> {
  const list = agentsOf(doc)?.["genericCli"];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

/**
 * What THIS document says about one executor, or `undefined` when it says nothing.
 *
 * Used twice by the pane and for opposite purposes: against the layer being edited it supplies the
 * form's values, and against the effective config it supplies the placeholders — which is what makes
 * "inherited from the shared root" visible as something other than an empty box.
 */
export function executorBlock(doc: unknown, name: string): Record<string, unknown> | undefined {
  const agents = agentsOf(doc);
  if (agents === undefined) return undefined;
  const key = EXECUTOR_CONFIG_KEYS[name];
  if (key !== undefined) {
    const block = agents[key];
    return isObject(block) ? block : undefined;
  }
  return genericEntries(doc).find((entry) => genericName(entry) === name);
}

/**
 * Apply a patch to one executor's block in a layer's raw document, returning a new document.
 *
 * The input is never mutated: the store holds the last-read `ConfigView`, and editing it in place
 * would leave the UI showing a value that the write might still be refused for.
 */
export function applyExecutorPatch(doc: unknown, executor: ExecutorTarget, patch: ExecutorPatch): unknown {
  const next = structuredClone(isObject(doc) ? doc : {}) as Record<string, unknown>;
  const agents = isObject(next["agents"]) ? { ...(next["agents"] as Record<string, unknown>) } : {};
  next["agents"] = agents;

  const key = EXECUTOR_CONFIG_KEYS[executor.name];
  if (key !== undefined) {
    const block = applyFields(isObject(agents[key]) ? (agents[key] as Record<string, unknown>) : {}, patch);
    // An emptied block is deleted rather than left as `{}`: this layer overrides nothing now, and
    // the document should say so — an empty object reads as a deliberate, if inert, override.
    if (Object.keys(block).length === 0) delete agents[key];
    else agents[key] = block;
    return prune(next, agents);
  }

  const list = genericEntries(next);
  const index = list.findIndex((entry) => genericName(entry) === executor.name);
  if (index >= 0) {
    const block = applyFields(list[index]!, patch);
    // A generic entry is the executor — emptying it would delete the executor rather than an
    // override, so the identifying pair is kept whatever the patch says.
    list[index] = { name: executor.name, ...block };
  } else {
    // Nothing in this layer yet: the entry being created is an OVERRIDE of one the other layer
    // declares, and `command` is required on every entry, so it is carried across.
    const command = patch["command"] ?? executor.command;
    list.push(
      applyFields({ name: executor.name, ...(typeof command === "string" ? { command } : {}) }, patch),
    );
  }
  agents["genericCli"] = list;
  return prune(next, agents);
}

/** Add a new generic-CLI executor to a layer. Refuses a name the layer already uses. */
export function addGenericExecutor(doc: unknown, spec: { name: string; command: string }): unknown {
  const name = spec.name.trim().length > 0 ? spec.name.trim() : DEFAULT_GENERIC_NAME;
  const next = structuredClone(isObject(doc) ? doc : {}) as Record<string, unknown>;
  const agents = isObject(next["agents"]) ? { ...(next["agents"] as Record<string, unknown>) } : {};
  next["agents"] = agents;
  const list = genericEntries(next);
  if (list.some((entry) => genericName(entry) === name)) {
    throw new Error(`this layer already configures an executor called '${name}'`);
  }
  if (EXECUTOR_CONFIG_KEYS[name] !== undefined) {
    throw new Error(`'${name}' is a built-in executor — configure it above rather than adding a CLI with its name`);
  }
  list.push({ name, command: spec.command.trim() });
  agents["genericCli"] = list;
  return next;
}

/**
 * Remove a generic-CLI entry from a layer.
 *
 * Only ever a generic one: a built-in cannot be removed, because it is not declared anywhere to
 * begin with — turning it off is what `enabled: false` is for, and it stays listed so it can be
 * turned back on.
 */
export function removeGenericExecutor(doc: unknown, name: string): unknown {
  const next = structuredClone(isObject(doc) ? doc : {}) as Record<string, unknown>;
  const agents = agentsOf(next);
  if (agents === undefined) return next;
  const kept = genericEntries(next).filter((entry) => genericName(entry) !== name);
  const block = { ...agents };
  if (kept.length === 0) delete block["genericCli"];
  else block["genericCli"] = kept;
  next["agents"] = block;
  return prune(next, block);
}

/**
 * Apply the field writes, deleting on `undefined`.
 *
 * Keys are DOTTED paths, so `models.default` and `command` are one spelling rather than two — the
 * same rule `applyModelPatch` follows, for the same reason. A container the write EMPTIED is deleted
 * rather than left as `{}`, so clearing the last model setting takes the `models` block with it
 * instead of leaving an inert override behind.
 */
function applyFields(block: Record<string, unknown>, patch: ExecutorPatch): Record<string, unknown> {
  const next = { ...block };
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let cursor = next;
    for (const part of parts.slice(0, -1)) {
      cursor[part] = isObject(cursor[part]) ? { ...(cursor[part] as Record<string, unknown>) } : {};
      chain.push({ parent: cursor, key: part });
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;
    for (const { parent, key } of chain.reverse()) {
      const inner = parent[key];
      if (isObject(inner) && Object.keys(inner).length === 0) delete parent[key];
    }
  }
  return next;
}

/** Read a dotted path out of a block — the counterpart of {@link applyFields}'s write. */
export function fieldAt(block: Record<string, unknown> | undefined, path: string): unknown {
  let cursor: unknown = block;
  for (const part of path.split(".")) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Drop an `agents` block that no longer holds anything, so an untouched layer stays empty. */
function prune(doc: Record<string, unknown>, agents: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(agents).length === 0) delete doc["agents"];
  return doc;
}

// --- the text fields ---------------------------------------------------------

/**
 * argv as one argument per line.
 *
 * Not a shell string, deliberately: JaiRA spawns these without a shell, so splitting on spaces would
 * quietly break any argument that contains one — a prompt template or a path under `Program Files`.
 * A line is an argument, which is the only spelling that cannot be misread.
 */
export function formatArgs(args: unknown): string {
  return Array.isArray(args) ? args.filter((a): a is string => typeof a === "string").join("\n") : "";
}

/** Parse the argv box. Blank means "say nothing", which is different from an empty argv. */
export function parseArgs(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines : undefined;
}

/** Extra environment as `KEY=value` lines — the spelling these files already use. */
export function formatEnv(env: unknown): string {
  if (!isObject(env)) return "";
  return Object.entries(env)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}=${value as string}`)
    .join("\n");
}

/**
 * Parse the environment box.
 *
 * Throws on a line that is not `KEY=value` rather than skipping it: a dropped variable shows up as
 * an agent that behaves differently for no visible reason, which is far harder to find than a
 * refused save that names the line.
 */
export function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`'${line}' is not a NAME=value line`);
    out[match[1]!] = match[2]!;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Allowed model patterns, one per line — the same spelling the argv box uses, for the same reason. */
export function formatAllow(allow: unknown): string {
  return Array.isArray(allow) ? allow.filter((a): a is string => typeof a === "string").join("\n") : "";
}

/** Parse the allow box. Blank means "no limit", which is different from an empty list. */
export function parseAllow(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines : undefined;
}

/** A secret NAME, not a secret — the same rule `config.json`'s parser enforces, checked early. */
export function checkCredentialName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(
      `'${name}' is not a usable secret name — it NAMES the key (like ANTHROPIC_API_KEY), it does not hold it`,
    );
  }
}
