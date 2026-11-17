/**
 * Settings that follow the person across their machines (decision 0026): how a settings document is cut
 * into pieces that sync one by one, which pieces belong to the machine they are on, and how a piece
 * from another machine is laid into this one's document.
 *
 * Pure and browser-safe: the engine (`service/src/settingsSync.ts`) does the reading, writing and
 * talking; this file only says what a piece is.
 *
 * - **A piece is a path.** A layer's top-level blocks are pieces; a block that is an object is cut once
 *   more (`models.routes`, `appearance.mode`, `agents.claudeCli`), and the maps whose entries are things
 *   of their own once more again (one forge connection, one MCP server, one route, one preset, one
 *   bucket's standing layers). Two machines changing different pieces both keep their change; the same
 *   piece changed on both keeps the later one.
 * - **What is the machine's stays.** Where the engine runs (`execEnvironment`, `engine`), the update
 *   track, a server on this machine (the `local` and `embedded` routes, an MCP server that is a command
 *   or a loopback address), a workflow search path naming a folder, and an agent's binary given as a path
 *   are never sent, and never replaced by another machine's.
 */
import type { JsonValue } from "@declarative-ai/json";
import { BUILTIN_GENERIC_AGENTS } from "./executors";

/** The settings layers that sync: Shared (`<base>/settings.json`) and Just you (`personal-settings.json`). */
export type SyncedLayer = "base" | "you";

/** One piece of a layer: where it is, and what it holds there (never absent: an absent piece is no piece). */
export interface SettingsPiece {
  path: string[];
  value: JsonValue;
}

/** Blocks that hold settings of the machine itself, whole. */
const MACHINE_BLOCKS: ReadonlySet<string> = new Set(["execEnvironment", "engine", "updates"]);

/** Routes that reach something on this machine. */
const MACHINE_ROUTES: ReadonlySet<string> = new Set(["local", "embedded"]);

/** Maps under a block whose entries are pieces of their own. */
const ENTRY_MAPS: ReadonlyArray<readonly [string, string]> = [
  ["models", "routes"],
  ["models", "presets"],
  ["integrations", "forges"],
  ["integrations", "oauth"],
  ["mcp", "servers"],
  ["permissions", "layers"],
];

const isObject = (value: unknown): value is Record<string, JsonValue> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A command given as a path rather than a name found on the PATH: the machine's own. */
export function isCommandPath(command: unknown): boolean {
  return typeof command === "string" && /[\\/]/.test(command);
}

/** A host on this machine: a server another machine cannot reach by the same address. */
export function isLoopbackUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

/** A workflow search path entry naming a folder rather than a layer (`$SHARED/…`). */
const isFolderEntry = (entry: unknown): boolean => typeof entry === "string" && !entry.startsWith("$");

/**
 * Whether the piece at `path`, holding `value`, belongs to this machine alone: never sent, and never
 * replaced by another machine's.
 */
export function isMachinePiece(path: readonly string[], value: JsonValue | undefined): boolean {
  const [block, key, entry] = path;
  if (block === undefined) return false;
  if (MACHINE_BLOCKS.has(block)) return true;
  if (block === "models" && key === "routes" && entry !== undefined && MACHINE_ROUTES.has(entry)) return true;
  if (block === "models" && key === "routes" && entry === undefined) return false;
  if (block === "mcp" && key === "servers" && entry !== undefined && isObject(value)) return value["command"] !== undefined || isLoopbackUrl(value["url"]);
  if (block === "workflows" && (key === undefined || key === "path")) {
    const list = key === undefined && isObject(value) ? value["path"] : value;
    return Array.isArray(list) && list.some(isFolderEntry);
  }
  return false;
}

/** Whether a piece is cut further: the layer itself, each block that is an object, and the entry maps. */
function cutFurther(path: readonly string[], value: JsonValue): boolean {
  if (!isObject(value)) return false;
  if (path.length === 0 || path.length === 1) return true;
  return path.length === 2 && ENTRY_MAPS.some(([a, b]) => a === path[0] && b === path[1]);
}

/**
 * A piece as it is sent: the machine's own fields inside it taken out. An agent's binary given as a
 * path stays here — the agent itself, its key and its switches travel. A built-in CLI's entry may drop
 * its path, since the built-in layer names its binary; a CLI the person added keeps it, since without
 * one the entry would not load.
 */
export function shareable(path: readonly string[], value: JsonValue): JsonValue {
  const [block, key] = path;
  if (block !== "agents" || path.length !== 2) return value;
  if ((key === "claudeCli" || key === "codex") && isObject(value) && isCommandPath(value["command"])) {
    const { command: _local, ...rest } = value;
    return rest;
  }
  if (key === "genericCli" && Array.isArray(value)) {
    return value.map((entry) => {
      if (!isObject(entry) || !isCommandPath(entry["command"])) return entry;
      const name = typeof entry["name"] === "string" ? entry["name"] : "generic-cli";
      if (BUILTIN_GENERIC_AGENTS[name] === undefined) return entry;
      const { command: _local, ...rest } = entry;
      return rest;
    });
  }
  return value;
}

/**
 * The pieces of a layer that travel, each as it is sent ({@link shareable}). A document that is not an
 * object has none.
 */
export function settingsPieces(doc: JsonValue | null | undefined): SettingsPiece[] {
  const pieces: SettingsPiece[] = [];
  const walk = (path: string[], value: JsonValue): void => {
    if (path.length > 0 && isMachinePiece(path, value)) return;
    if (cutFurther(path, value)) {
      for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) if (v !== undefined) walk([...path, k], v);
      return;
    }
    pieces.push({ path, value: shareable(path, value) });
  };
  if (isObject(doc)) walk([], doc);
  return pieces;
}

/** The value at a path in a document, or undefined. */
export function valueAt(doc: JsonValue | null | undefined, path: readonly string[]): JsonValue | undefined {
  let at: JsonValue | null | undefined = doc;
  for (const key of path) {
    if (!isObject(at)) return undefined;
    at = at[key];
  }
  return at ?? undefined;
}

/**
 * Lay another machine's piece into this machine's document: set at its path (`undefined` removes it,
 * and objects left empty by the removal go with it), keeping what is this machine's own — a piece that
 * is the machine's here is left as it is (`kept: true`), and an agent's binary path here is put back
 * into the agent that came. Returns a new document; the one given is not changed.
 */
export function layPiece(doc: JsonValue | null | undefined, path: readonly string[], incoming: JsonValue | undefined): { doc: Record<string, JsonValue>; kept: boolean } {
  const root: Record<string, JsonValue> = isObject(doc) ? structuredClone(doc) : {};
  const here = valueAt(root, path);
  if (path.length === 0 || (here !== undefined && isMachinePiece(path, here))) return { doc: root, kept: true };
  if (incoming !== undefined && isMachinePiece(path, incoming)) return { doc: root, kept: true };
  const value = incoming === undefined ? undefined : withLocalFields(path, incoming, here);
  // Down to the parent, making objects where there are none.
  const parents: Array<Record<string, JsonValue>> = [root];
  let at = root;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    if (!isObject(next)) {
      if (value === undefined) return { doc: root, kept: false };
      at[key] = {};
    }
    at = at[key] as Record<string, JsonValue>;
    parents.push(at);
  }
  const last = path[path.length - 1]!;
  if (value === undefined) {
    delete at[last];
    // Prune what the removal left empty, up to the block.
    for (let i = parents.length - 1; i > 0; i -= 1) {
      if (Object.keys(parents[i]!).length > 0) break;
      delete parents[i - 1]![path[i - 1]!];
    }
  } else {
    at[last] = value;
  }
  return { doc: root, kept: false };
}

/** An agent from another machine, with this machine's binary path put back where it had one. */
function withLocalFields(path: readonly string[], incoming: JsonValue, here: JsonValue | undefined): JsonValue {
  const [block, key] = path;
  if (block !== "agents" || path.length !== 2) return structuredClone(incoming);
  if ((key === "claudeCli" || key === "codex") && isObject(incoming)) {
    const local = isObject(here) && isCommandPath(here["command"]) ? here["command"] : undefined;
    return local !== undefined ? { ...structuredClone(incoming), command: local } : structuredClone(incoming);
  }
  if (key === "genericCli" && Array.isArray(incoming)) {
    const localPaths = new Map<string, JsonValue>();
    if (Array.isArray(here)) {
      for (const entry of here) {
        if (isObject(entry) && isCommandPath(entry["command"])) localPaths.set(typeof entry["name"] === "string" ? entry["name"] : "generic-cli", entry["command"]!);
      }
    }
    return incoming.map((entry) => {
      if (!isObject(entry)) return structuredClone(entry);
      const name = typeof entry["name"] === "string" ? entry["name"] : "generic-cli";
      const local = localPaths.get(name);
      return local !== undefined && BUILTIN_GENERIC_AGENTS[name] !== undefined ? { ...structuredClone(entry), command: local } : structuredClone(entry);
    });
  }
  return structuredClone(incoming);
}

/** JSON with its keys in order, so one value always reads the same: what a piece's hash is taken over. */
export function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  const order = (v: JsonValue): JsonValue => {
    if (Array.isArray(v)) return v.map(order);
    if (isObject(v)) {
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = order(v[k]!);
      return out;
    }
    return v;
  };
  return JSON.stringify(order(value));
}

/** The words for what stays on a machine, as Settings → Machines lists them. */
export const MACHINE_PIECE_WORDS: readonly string[] = [
  "where commands and agents run (WSL), and how the engine is hosted",
  "the update track",
  "the local and embedded model routes",
  "MCP servers started as a command, or reached at a loopback address",
  "an agent's binary given as a path",
  "a workflow search path that names a folder",
];

/** What this machine says about keeping its settings in step with the others (Settings → Machines). */
export interface SettingsSyncView {
  /** The person's switch: on unless turned off here. */
  on: boolean;
  /** When this machine last took or gave a change, if it has. */
  at?: number;
  /** How many pieces it keeps in step, by kind. */
  counts: { settings: number; secrets: number; signIns: number; logins: number };
  /** The agents whose sign-in follows, where it is kept when that is worth saying ("inside Ubuntu (WSL)"), and why one does not when it does not. */
  logins: Array<{ agent: string; synced: boolean; why?: string; where?: string }>;
  /** A change from another machine that could not be laid in here, and why — the latest few. */
  refused?: Array<{ what: string; why: string; at: number }>;
}
