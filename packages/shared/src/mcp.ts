/**
 * MCP servers — the tools OTHER servers offer, configured once in `settings.json` and handed to the
 * agents that run (Settings → Connections → MCP servers; the units doc `mcp-servers`).
 *
 * ```jsonc
 * "mcp": {
 *   "servers": {
 *     "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
 *     "figma": { "url": "http://127.0.0.1:3845/mcp" },
 *     "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": { "credential": "LINEAR_AUTH" } } }
 *   }
 * }
 * ```
 *
 * Three things live here, and all three are pure so the renderer can read them too:
 *
 *  - **The block**: {@link parseMcp}, strict like every other block of `settings.json`. A server is a
 *    command JaiRA starts (stdio) or a URL it calls (HTTP), never both. A value in `env` or `headers`
 *    is a string, or `{ "credential": "NAME" }` — which NAMES a secret the way a provider's
 *    `credential` does and is looked up through the same chain (keychain, the `.env` files, the
 *    environment) at the moment a server is started. The layers merge the block by server name, through
 *    `mergeConfigDocuments` like everything else.
 *  - **The subjects**: a call to a tool of server `figma` is the subject `mcp__figma__get_code` — the
 *    name every agent already gives it — and `mcp__figma` is the server's own line in a permission set,
 *    standing for every tool of that server no line names ({@link mcpModeOf}): the tool's line, then its
 *    server's, then `other`. That is bash's program groups again (`git commit`, then `git`, then the
 *    shell's line), for a server.
 *  - **The wire shapes** of what Settings asks main: what other tools on this machine already run
 *    ({@link McpDetectedSource}) and what each configured server answered ({@link McpToolsReport}).
 */
import type { SecretOrigin } from "./executors";
import { isFunctionMode, type PermissionSetMode } from "./operationVocabulary";
import type { PermissionSet } from "./permissionSets";

/** A value that NAMES a secret — looked up at run time, never written into `settings.json`. */
export interface McpSecretRef {
  credential: string;
}

/** An `env` or `headers` value: the value itself, or the name of the secret that holds it. */
export type McpValue = string | McpSecretRef;

/** A server JaiRA starts: the command, its arguments, what it is handed in its environment, and where it runs. */
export interface McpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, McpValue>;
  cwd?: string;
  /** Absent means on. */
  enabled?: boolean;
}

/** A server JaiRA calls: streamable HTTP, falling back to SSE, with the headers each request carries. */
export interface McpHttpServer {
  url: string;
  headers?: Record<string, McpValue>;
  /** Absent means on. */
  enabled?: boolean;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

/** The `mcp` block of `settings.json`: every server by the name its tools are called under. */
export interface JairaMcpConfig {
  servers: Record<string, McpServerConfig>;
}

export function defaultMcp(): JairaMcpConfig {
  return { servers: {} };
}

/** Is this a server JaiRA starts, as against one it calls? */
export function isMcpStdio(config: McpServerConfig): config is McpStdioServer {
  return typeof (config as McpStdioServer).command === "string";
}

/** Is this value the name of a secret rather than the value itself? */
export function isMcpSecretRef(value: McpValue | unknown): value is McpSecretRef {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as McpSecretRef).credential === "string";
}

/** Is the server on — `enabled` absent or true? */
export function mcpServerEnabled(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

/**
 * What a server may be called. The name is the middle of every subject its tools are judged by
 * (`mcp__<server>__<tool>`), so it is held to what that subject can carry unambiguously: letters,
 * digits, `-` and `_`, and never two `_` in a row or one at either end — `mcp__a__b__c` must say
 * where the server ends.
 */
export const MCP_SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/**
 * Names no configured server may take: `dai` is the bridge every agent run already has — JaiRA's own
 * tools, served to the agent under `mcp__dai__…` — and a second server of that name would be handed
 * the first one's calls.
 */
export const RESERVED_MCP_SERVERS: readonly string[] = ["dai"];

const STDIO_FIELDS = ["command", "args", "env", "cwd", "enabled"] as const;
const HTTP_FIELDS = ["url", "headers", "enabled"] as const;

function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * One `env` / `headers` map: each value a string, or `{ "credential": "NAME" }`.
 *
 * The name is held to what a provider's `credential` is held to — a plain name with no whitespace —
 * because a value that LOOKS like a key there is the easiest way to end up with a secret committed.
 */
function valueMap(raw: unknown, where: string): Record<string, McpValue> {
  const out: Record<string, McpValue> = {};
  for (const [key, value] of Object.entries(plainObject(raw, where))) {
    if (key.length === 0) throw new Error(`${where} has an empty name`);
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const fields = Object.keys(value);
      const credential = (value as Record<string, unknown>)["credential"];
      if (fields.length !== 1 || typeof credential !== "string" || credential.length === 0) {
        throw new Error(`${where}.${key} must be a string, or { "credential": "<secret name>" } and nothing else`);
      }
      if (/\s/.test(credential)) {
        throw new Error(
          `${where}.${key}.credential ('${credential}') must NAME a secret, not hold one — the value is looked up ` +
            `when the server starts, from the keychain, a .env file, or the environment`,
        );
      }
      out[key] = { credential };
      continue;
    }
    throw new Error(`${where}.${key} must be a string, or { "credential": "<secret name>" }`);
  }
  return out;
}

/** One server's block. */
function parseServer(raw: unknown, where: string): McpServerConfig {
  const spec = plainObject(raw, where);
  const stdio = spec["command"] !== undefined;
  const http = spec["url"] !== undefined;
  if (stdio && http) throw new Error(`${where} has both a command and a url — a server is one JaiRA starts, or one it calls`);
  if (!stdio && !http) throw new Error(`${where} needs a command (a server JaiRA starts) or a url (one it calls)`);
  const allowed: readonly string[] = stdio ? STDIO_FIELDS : HTTP_FIELDS;
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where}.${key} is not a setting of a ${stdio ? "server JaiRA starts" : "server JaiRA calls"} — it takes ${allowed.join(", ")}`);
    }
  }
  if (spec["enabled"] !== undefined && typeof spec["enabled"] !== "boolean") throw new Error(`${where}.enabled must be a boolean`);
  const enabled = spec["enabled"] === false ? { enabled: false as const } : spec["enabled"] === true ? { enabled: true as const } : {};
  if (stdio) {
    const command = spec["command"];
    if (typeof command !== "string" || command.trim().length === 0) throw new Error(`${where}.command must be a non-empty string`);
    const args = spec["args"];
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) throw new Error(`${where}.args must be an array of strings`);
    const cwd = spec["cwd"];
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) throw new Error(`${where}.cwd must be a non-empty string`);
    return {
      command: command.trim(),
      ...(args !== undefined ? { args: [...(args as string[])] } : {}),
      ...(spec["env"] !== undefined ? { env: valueMap(spec["env"], `${where}.env`) } : {}),
      ...(cwd !== undefined ? { cwd: cwd as string } : {}),
      ...enabled,
    };
  }
  const url = spec["url"];
  if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url.trim())) throw new Error(`${where}.url must be an http:// or https:// address`);
  return {
    url: url.trim(),
    ...(spec["headers"] !== undefined ? { headers: valueMap(spec["headers"], `${where}.headers`) } : {}),
    ...enabled,
  };
}

/**
 * Parse the `mcp` block.
 *
 * Strict, like every block of `settings.json`: a field this block does not read is a server somebody
 * believes is configured some way it is not, and the save is refused naming the field. A name is
 * checked against {@link MCP_SERVER_NAME}, since it becomes the middle of every subject its tools are
 * judged by, and against {@link RESERVED_MCP_SERVERS}.
 */
export function parseMcp(raw: unknown): JairaMcpConfig {
  const out = defaultMcp();
  if (raw === undefined) return out;
  const block = plainObject(raw, "config.mcp");
  for (const key of Object.keys(block)) {
    if (key !== "servers") throw new Error(`config.mcp.${key} is not a setting — the block holds servers`);
  }
  if (block["servers"] === undefined) return out;
  for (const [name, entry] of Object.entries(plainObject(block["servers"], "config.mcp.servers"))) {
    const where = `config.mcp.servers.${name}`;
    if (!MCP_SERVER_NAME.test(name)) {
      throw new Error(
        `${where}: '${name}' is not a server name — letters, digits, '-' and '_', with no '__' and no '_' at either end, ` +
          `since its tools are called mcp__${name}__<tool>`,
      );
    }
    if (RESERVED_MCP_SERVERS.includes(name)) {
      throw new Error(`${where}: '${name}' is the name of JaiRA's own bridge, which every agent run already has — call this server something else`);
    }
    out.servers[name] = parseServer(entry, where);
  }
  return out;
}

/** Every secret a server's config names, where it names it — what Connections draws a credential box for. */
export function mcpSecretsOf(config: McpServerConfig): Array<{ field: "env" | "headers"; key: string; credential: string }> {
  const out: Array<{ field: "env" | "headers"; key: string; credential: string }> = [];
  const bag = isMcpStdio(config) ? { field: "env" as const, values: config.env } : { field: "headers" as const, values: config.headers };
  for (const [key, value] of Object.entries(bag.values ?? {})) {
    if (isMcpSecretRef(value)) out.push({ field: bag.field, key, credential: value.credential });
  }
  return out;
}

/** Where a server is — its command line or its address — as one line a person reads. */
export function mcpWhere(config: McpServerConfig): string {
  return isMcpStdio(config) ? [config.command, ...(config.args ?? [])].join(" ") : config.url;
}

// --- subjects -------------------------------------------------------------------

/** What every MCP subject starts with — the prefix every agent gives a tool of an MCP server. */
export const MCP_SUBJECT_PREFIX = "mcp__";

/** A server's own line in a permission set: `mcp__figma`, which stands for every tool of it no line names. */
export function mcpServerSubject(server: string): string {
  return `${MCP_SUBJECT_PREFIX}${server}`;
}

/** One tool's line: `mcp__figma__get_code` — the name the agent calls it by, and the subject it is judged by. */
export function mcpToolSubject(server: string, tool: string): string {
  return `${MCP_SUBJECT_PREFIX}${server}__${tool}`;
}

/**
 * A subject as the server and (for a tool's line) the tool it names — `undefined` for one that is not
 * an MCP subject. The server ends at the first `__` after the prefix, which {@link MCP_SERVER_NAME}
 * makes unambiguous; a tool's own name may hold anything, `__` included.
 */
export function parseMcpSubject(subject: string): { server: string; tool?: string } | undefined {
  if (!subject.startsWith(MCP_SUBJECT_PREFIX)) return undefined;
  const rest = subject.slice(MCP_SUBJECT_PREFIX.length);
  const cut = rest.indexOf("__");
  const server = cut === -1 ? rest : rest.slice(0, cut);
  if (!MCP_SERVER_NAME.test(server)) return undefined;
  if (cut === -1) return { server };
  const tool = rest.slice(cut + 2);
  return tool.length > 0 && !/\s/.test(tool) ? { server, tool } : undefined;
}

/** Is this a server's line or a tool's line of an MCP server? */
export function isMcpSubject(subject: string): boolean {
  return parseMcpSubject(subject) !== undefined;
}

/** What answers for an MCP call: the mode, and the line it came from — a tool's, its server's, or `other`. */
export interface McpLine {
  mode: PermissionSetMode;
  /** `mcp__figma__get_code`, `mcp__figma`, or `other`. */
  line: string;
}

/**
 * What a permission set says about one MCP tool: its own line, then its server's line, then `other` —
 * `undefined` when none of the three is written.
 *
 * The order is bash's program groups (decision 0007 §5): `git commit`, then `git`, then the shell's
 * line. A server's line is what "any other figma tool" answers to, exactly as `git` is what any
 * other `git` answers to.
 */
export function mcpModeOf(permissionSet: PermissionSet, subject: string): McpLine | undefined {
  const parsed = parseMcpSubject(subject);
  if (parsed === undefined) return permissionSet.other !== undefined ? { mode: permissionSet.other, line: "other" } : undefined;
  const own = (key: string) => (Object.hasOwn(permissionSet.entries, key) ? permissionSet.entries[key] : undefined);
  const tool = parsed.tool !== undefined ? own(subject) : undefined;
  if (tool?.mode !== undefined) return { mode: tool.mode, line: subject };
  const server = mcpServerSubject(parsed.server);
  const group = own(server);
  if (group?.mode !== undefined) return { mode: group.mode, line: server };
  return permissionSet.other !== undefined ? { mode: permissionSet.other, line: "other" } : undefined;
}

/** The tools of one server a permission set names a line for, in authored order. */
export function mcpToolLines(permissionSet: PermissionSet, server: string): Array<{ tool: string; subject: string; mode: PermissionSetMode | undefined }> {
  const out: Array<{ tool: string; subject: string; mode: PermissionSetMode | undefined }> = [];
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "mcp") continue;
    const parsed = parseMcpSubject(subject);
    if (parsed?.server === server && parsed.tool !== undefined) out.push({ tool: parsed.tool, subject, mode: entry.mode });
  }
  return out;
}

/** The annotations a server says about a tool, as the MCP spec names them. */
export interface McpToolAnnotations {
  title?: string;
  /** The tool does not change its environment. */
  readOnlyHint?: boolean;
  /** The tool may destroy something (only meaningful when it is not read-only). */
  destructiveHint?: boolean;
}

/**
 * The mode a tool's line starts at when it is first named: what the server SAYS about the tool, where
 * it says something — read-only is allowed, destructive is refused — and otherwise what the tool
 * answered to before it had a line of its own, so naming it changes nothing until the person does.
 */
export function mcpFirstMode(annotations: McpToolAnnotations | undefined, answering: PermissionSetMode): PermissionSetMode {
  if (annotations?.readOnlyHint === true) return "allow";
  if (annotations?.destructiveHint === true) return "deny";
  return answering;
}

/** A mode in the words the MCP bucket's hints use: `allowed`, `asks`, `denied`, `decided by smart`. */
export function mcpModeWords(mode: PermissionSetMode): string {
  if (isFunctionMode(mode)) return `decided by ${mode.function}`;
  return { allow: "allowed", ask: "asks", deny: "denied" }[mode];
}

// --- what other tools on this machine already run --------------------------------

/**
 * One entry of somebody else's MCP config — Claude Code's, Claude Desktop's, Cursor's, VS Code's — as
 * a server of ours, or `undefined` when it names neither a command nor a url.
 *
 * Only what this block has a place for is kept: `type` (`stdio`, `http`, `sse`), `disabled`, `alwaysAllow`
 * and every other tool's own field are dropped, because each is a statement in a vocabulary JaiRA does
 * not speak. A value written `${NAME}` — the spelling Claude Code and Cursor expand from the
 * environment — is read as what it means, the secret `NAME`, so it is looked up through the chain
 * rather than handed on as six characters.
 */
export function mcpServerOfForeign(raw: unknown): McpServerConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const spec = raw as Record<string, unknown>;
  const values = (bag: unknown): Record<string, McpValue> | undefined => {
    if (bag === null || typeof bag !== "object" || Array.isArray(bag)) return undefined;
    const out: Record<string, McpValue> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value !== "string" || key.length === 0) continue;
      const named = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
      out[key] = named !== null ? { credential: named[1]! } : value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  if (typeof spec["command"] === "string" && spec["command"].trim().length > 0) {
    const args = Array.isArray(spec["args"]) ? spec["args"].filter((a): a is string => typeof a === "string") : undefined;
    const env = values(spec["env"]);
    const cwd = typeof spec["cwd"] === "string" && spec["cwd"].length > 0 ? spec["cwd"] : undefined;
    return {
      command: spec["command"].trim(),
      ...(args !== undefined && args.length > 0 ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }
  const url = typeof spec["url"] === "string" ? spec["url"] : typeof spec["serverUrl"] === "string" ? spec["serverUrl"] : undefined;
  if (url !== undefined && /^https?:\/\/\S+$/i.test(url.trim())) {
    const headers = values(spec["headers"]);
    return { url: url.trim(), ...(headers !== undefined ? { headers } : {}) };
  }
  return undefined;
}

/**
 * Somebody else's server name, as one {@link MCP_SERVER_NAME} allows: what it cannot hold becomes
 * `-`, runs of `_` become one, and an empty result is `server`. `github.com/org` is `github-com-org`.
 */
export function mcpNameOfForeign(name: string): string {
  let out = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/_{2,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  if (out.length === 0) out = "server";
  if (RESERVED_MCP_SERVERS.includes(out)) out = `${out}-server`;
  return out;
}

/** Where a detected server list was found. */
export type McpSourceKind = "claude-code" | "project" | "claude-desktop" | "cursor" | "vscode" | "port";

/** One place servers were looked for, and what was there — a row of Connections' detection panel. */
export interface McpDetectedSource {
  source: McpSourceKind;
  /** What a person calls it: "Claude Code", "This project's .mcp.json", "Figma Dev Mode". */
  label: string;
  /** The file it was read from, or the address that was asked. */
  where: string;
  /** Found servers; a file there that lists none; or nothing there at all. */
  state: "found" | "none listed" | "not found";
  servers: Array<{ name: string; config: McpServerConfig }>;
  /** A sentence beside the servers — "answering, 21 tools", or why a file could not be read. */
  detail?: string;
}

/** One tool a server listed. */
export interface McpToolInfo {
  name: string;
  description?: string;
  annotations: McpToolAnnotations;
}

/** Whether a configured server answered when it was last asked. */
export type McpServerState = "ready" | "failed" | "not started";

/** One configured server, as the tools probe found it. */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Why it failed, or why it was not started (turned off; a secret it names is not stored). */
  reason?: string;
  /** What to do about it, when there is something. */
  fix?: string;
  /** How it was reached: started over stdio, or called over streamable HTTP or SSE. */
  transport: "stdio" | "http" | "sse";
  /** Its command line, or its address. */
  where: string;
  /** What it listed — empty unless ready. */
  tools: McpToolInfo[];
  /**
   * Each secret its `env` or `headers` names, and where the chain found it — absent where nothing
   * stores it. What Connections draws a credential box for; the value never leaves main.
   */
  credentials: Array<{ field: "env" | "headers"; key: string; credential: string; origin?: SecretOrigin }>;
  checkedAt: number;
}

/** Every configured server, as last asked. */
export interface McpToolsReport {
  servers: McpServerStatus[];
  /** When the probe last ran; `0` when it never has. */
  checkedAt: number;
}
