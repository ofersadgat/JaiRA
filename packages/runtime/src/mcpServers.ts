/**
 * MCP servers, on the Node side: what other tools on this machine already run, what each configured
 * server answers with, and how a run hands the configured servers to an agent (the units doc
 * `mcp-servers`; the block and the subjects are `@jaira/shared`'s `./mcp`).
 *
 * Four jobs, and one rule that separates them:
 *
 *  - **Detection** ({@link detectMcpServers}) READS files — Claude Code's `~/.claude.json`, the
 *    project's `.mcp.json`, Claude Desktop's, Cursor's and VS Code's configs — and asks one known
 *    local port. It never starts anything: a server somebody else configured is somebody else's
 *    command, and listing it is not a reason to run it.
 *  - **The tools probe** ({@link probeMcpServers}) STARTS each server the person ADDED — a command
 *    over stdio, a URL over streamable HTTP falling back to SSE — lists its tools, and closes it. A
 *    deadline per server, all of them side by side, and a failure is a row, never a throw.
 *  - **Resolution** ({@link resolveMcpServers}) turns the configured block into what a process is
 *    handed: the servers that are on, each `{ "credential": … }` looked up through the secret chain
 *    a provider's key is.
 *  - **Handing them over** ({@link mcpServersOfCall}): every agent executor takes them as upstream's
 *    `mcpServers`, per call. Claude finds them in the one `--mcp-config` document the bridge's `dai`
 *    is in and asks its permission callback about each call; codex's bridge PROXIES them, so each call
 *    crosses the bridge and is put to the gate there before it is forwarded — every mode works on
 *    both. What a permission set says about a server decides only whether it is handed over at all: a
 *    server every line of which is `deny` is not started for nothing.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerSpec } from "@declarative-ai/agents-api";
import type { ExecServices } from "@declarative-ai/exec";
import {
  isMcpSecretRef,
  isMcpStdio,
  mcpSecretsOf,
  mcpNameOfForeign,
  mcpServerEnabled,
  mcpServerOfForeign,
  mcpServerSubject,
  mcpToolSubject,
  mcpWhere,
  parseMcpSubject,
  stripBom,
  type JairaMcpConfig,
  type McpDetectedSource,
  type McpLine,
  type McpServerConfig,
  type McpServerStatus,
  type McpSourceKind,
  type McpToolInfo,
  type McpToolsReport,
  type McpValue,
  type SecretOrigin,
} from "@jaira/shared";
import { resolveInvocation } from "./exec";
import type { ExecEnv } from "./paths";

// --- what a process is handed ------------------------------------------------------

/** A configured server, with every secret it names looked up — what a process is actually handed. */
export type ResolvedMcpServer =
  | { command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { url: string; headers: Record<string, string> };

/** The servers that are on, resolved; and, by server, the secrets that could not be found. */
export interface ResolvedMcpServers {
  servers: Record<string, ResolvedMcpServer>;
  /** A server that names a secret nothing stores is left out of {@link servers} and named here. */
  missing: Record<string, string[]>;
}

/**
 * The configured servers that are on, each value that names a secret replaced by the secret.
 *
 * `lookup` is the secret chain (`SecretResolver.lookup(...).value`). A server one of whose secrets is
 * not stored anywhere is LEFT OUT and named in `missing`: started without it, it fails in a way that
 * says nothing about why, and a run that goes on without the server is what a server that failed to
 * start gives anyway.
 */
export function resolveMcpServers(mcp: JairaMcpConfig, lookup: (name: string) => string | undefined): ResolvedMcpServers {
  const servers: Record<string, ResolvedMcpServer> = {};
  const missing: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(mcp.servers)) {
    if (!mcpServerEnabled(config)) continue;
    const lacking: string[] = [];
    const values = (bag: Record<string, McpValue> | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(bag ?? {})) {
        if (!isMcpSecretRef(value)) {
          out[key] = value;
          continue;
        }
        const found = lookup(value.credential);
        if (found === undefined || found.length === 0) lacking.push(value.credential);
        else out[key] = found;
      }
      return out;
    };
    const resolved: ResolvedMcpServer = isMcpStdio(config)
      ? { command: config.command, args: [...(config.args ?? [])], env: values(config.env), ...(config.cwd !== undefined ? { cwd: config.cwd } : {}) }
      : { url: config.url, headers: values(config.headers) };
    if (lacking.length > 0) missing[name] = lacking;
    else servers[name] = resolved;
  }
  return { servers, missing };
}

// --- a run: what an agent is handed -------------------------------------------------

/**
 * What a permission set says about MCP, as the handing-over reads it — `undefined` for a call whose
 * state declares no permission set, which is handed every server as the agent's own config would be.
 */
export interface McpView {
  /** What answers for one tool — its line, its server's, `other` — or `undefined` when nothing is written. */
  lineOf(subject: string): McpLine | undefined;
  /** Every MCP line the permission set holds, by subject. */
  lines(): Record<string, McpLine["mode"]>;
}

/**
 * Is every tool of this server refused, whatever it lists? True when its own line (or, with none, a
 * written `other`) is `deny` and no tool of it is named anything else — so it is not handed over, and
 * not started for nothing.
 */
export function mcpServerRefused(view: McpView, server: string): boolean {
  const own = view.lineOf(mcpServerSubject(server));
  if (own === undefined || own.mode !== "deny") return false;
  const prefix = `${mcpServerSubject(server)}__`;
  return Object.entries(view.lines()).every(([subject, mode]) => !subject.startsWith(prefix) || mode === "deny");
}

/** The MCP subjects the permission set refuses outright — what claude's deny list carries. */
export function mcpDeniedSubjects(view: McpView, servers: Iterable<string>): string[] {
  const out = Object.entries(view.lines())
    .filter(([subject, mode]) => mode === "deny" && parseMcpSubject(subject)?.tool !== undefined)
    .map(([subject]) => subject);
  for (const server of servers) if (mcpServerRefused(view, server)) out.push(mcpServerSubject(server));
  return out;
}

/** Read the MCP half of a call's permission set — handed in by the route, which knows how to find it. */
export type McpViewOf = (ctx: ExecServices) => McpView | undefined;

/**
 * The servers ONE call is handed, in upstream's shape: every server that is on, less one every line of
 * which the call's permission set refuses ({@link mcpServerRefused}) — not started for nothing. With no
 * permission set (`view` absent) every server is handed over, as the agent's own config would hold it.
 *
 * Nothing else a permission set says is written into what is handed over. Claude asks its permission
 * callback about every call to these tools, and codex's bridge puts every call to the gate before it
 * forwards it (upstream `AgentQueryOptions.mcpServers`), so a tool's line — `allow`, `ask`, a
 * function, `deny` — is answered where the call is made, on either transport.
 */
export function handedMcpServers(servers: Record<string, ResolvedMcpServer>, view?: McpView): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, server] of Object.entries(servers)) if (view === undefined || !mcpServerRefused(view, name)) out[name] = server;
  return out;
}

/**
 * What an agent executor takes as upstream's `mcpServers`: the servers each call is handed, read off
 * the call ({@link handedMcpServers} under the call's own permission set) — or `undefined` when none is
 * configured, so an executor with nothing to hand over is built exactly as before.
 */
export function mcpServersOfCall(servers: Record<string, ResolvedMcpServer>, viewOf: McpViewOf): ((ctx: ExecServices) => Record<string, McpServerSpec>) | undefined {
  if (Object.keys(servers).length === 0) return undefined;
  return (ctx) => handedMcpServers(servers, viewOf(ctx));
}

/**
 * The servers as the process that STARTS them must be told to — for codex, whose bridge starts them in
 * JaiRA's own process rather than in the agent's. A WSL project's agent runs inside the distro, and a
 * stdio server handed to it used to start there; started by the bridge on Windows it must still run in
 * the distro, so it becomes `wsl.exe -d <distro> [--cd <dir>] -- <command>` with its variables carried
 * across by `WSLENV` — the invocation the tools probe uses ({@link listMcpTools}). A native project's,
 * and every URL, are unchanged.
 */
export function mcpServersIn(servers: Record<string, ResolvedMcpServer>, execEnv: ExecEnv | undefined): Record<string, ResolvedMcpServer> {
  if (execEnv === undefined || execEnv === "windows") return servers;
  const out: Record<string, ResolvedMcpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!("command" in server)) {
      out[name] = server;
      continue;
    }
    const { file, argv } = resolveInvocation(server.command, server.args, { execEnv, ...(server.cwd !== undefined ? { cwd: server.cwd } : {}) });
    out[name] = { command: file, args: argv, env: { ...server.env, ...wslenvOf(server.env) } };
  }
  return out;
}

/** `WSLENV` carrying a server's own variables into the distro, beside whatever this process carries. */
function wslenvOf(env: Record<string, string>): { WSLENV?: string } {
  const carried = Object.keys(env).map((key) => `${key}/u`);
  const wslenv = [process.env["WSLENV"], ...carried].filter((part): part is string => part !== undefined && part.length > 0).join(":");
  return wslenv.length > 0 ? { WSLENV: wslenv } : {};
}

// --- the tools probe ------------------------------------------------------------------

/** Per server: long enough for `npx` to fetch a package on a cold cache, short enough to wait on. */
export const MCP_PROBE_TIMEOUT_MS = 10_000;

/** What one connection answered: how it was reached and what it listed. */
export interface McpListing {
  transport: "stdio" | "http" | "sse";
  tools: McpToolInfo[];
}

/** Connect to one server, list its tools, and close it — replaced in a test, so no server is needed. */
export type McpLister = (server: ResolvedMcpServer, options: { signal: AbortSignal; execEnv?: ExecEnv }) => Promise<McpListing>;

export interface McpProbeOptions {
  /** The secret chain — how `{ "credential": … }` is looked up. */
  lookup: (name: string) => string | undefined;
  /** Where the chain finds a secret, without its value — what each credential box says. */
  describe?: (name: string) => SecretOrigin | undefined;
  list?: McpLister;
  timeoutMs?: number;
  execEnv?: ExecEnv;
  now?: () => number;
}

/**
 * Ask every configured server for its tools, side by side, each under its own deadline.
 *
 * A server that is off, or names a secret nothing stores, is `not started` and says why; one that did
 * not answer is `failed` with the reason and what to do; one that answered is `ready` with its tools.
 * Never throws.
 */
export async function probeMcpServers(mcp: JairaMcpConfig, options: McpProbeOptions): Promise<McpToolsReport> {
  const now = options.now ?? Date.now;
  const resolved = resolveMcpServers(mcp, options.lookup);
  const list = options.list ?? listMcpTools;
  const servers = await Promise.all(
    Object.entries(mcp.servers).map(async ([name, config]): Promise<McpServerStatus> => {
      const credentials = mcpSecretsOf(config).map((secret) => {
        const origin = options.describe?.(secret.credential);
        return { ...secret, ...(origin !== undefined ? { origin } : {}) };
      });
      const base = { name, transport: isMcpStdio(config) ? ("stdio" as const) : ("http" as const), where: mcpWhere(config), tools: [] as McpToolInfo[], credentials };
      if (!mcpServerEnabled(config)) return { ...base, state: "not started", reason: "turned off", checkedAt: now() };
      const lacking = resolved.missing[name];
      if (lacking !== undefined) {
        return {
          ...base,
          state: "not started",
          reason: `${lacking.join(", ")} ${lacking.length === 1 ? "is" : "are"} not stored anywhere`,
          fix: "store it in the box on the right",
          checkedAt: now(),
        };
      }
      const server = resolved.servers[name]!;
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The deadline's reason first: aborting closes the connection, and the lister's own failure
          // ("aborted") would otherwise be the one read.
          reject(new Error(`no answer in ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`));
          controller.abort();
        }, timeoutMs);
      });
      try {
        const listing = await Promise.race([list(server, { signal: controller.signal, ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}) }), deadline]);
        return { ...base, state: "ready", transport: listing.transport, tools: listing.tools, checkedAt: now() };
      } catch (e) {
        const reason = failureOf(e);
        return { ...base, state: "failed", reason, ...fixFor(config, reason), checkedAt: now() };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  return { servers, checkedAt: now() };
}

/** What to do about a failure, when the reason says something a person can act on. */
function fixFor(config: McpServerConfig, reason: string): { fix?: string } {
  if (isMcpStdio(config) && /ENOENT|not found|not recognized/i.test(reason)) return { fix: `install ${config.command}, or give its full path` };
  if (!isMcpStdio(config) && /nothing is listening|ECONNREFUSED/i.test(reason)) return { fix: "start the server, then Re-check" };
  if (/401|403|unauthori[sz]ed|forbidden/i.test(reason)) return { fix: "check the credential it is sent" };
  return {};
}

/** Node's `fetch` hides the useful half of a failure in `cause`; a spawn error carries a code. */
function failureOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (cause?.code === "ECONNREFUSED") return "nothing is listening";
  if (typeof cause?.message === "string" && cause.message.length > 0) return cause.message;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return "the command was not found (ENOENT)";
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "it failed without saying why";
}

/**
 * The MCP SDK's client half, loaded when a server is first asked — by specifiers that are not string
 * literals, so a bundler leaves them to the runtime, as upstream loads the SDK's server half. Inlined,
 * the SDK drags in `ajv-formats`, whose `require("ajv")` the CLI's ESM bundle cannot run: the CLI
 * died at import, before it had printed anything.
 */
const SDK_CLIENT = "@modelcontextprotocol/sdk/client/index.js";
const SDK_STDIO = "@modelcontextprotocol/sdk/client/stdio.js";
const SDK_HTTP = "@modelcontextprotocol/sdk/client/streamableHttp.js";
const SDK_SSE = "@modelcontextprotocol/sdk/client/sse.js";

interface McpSdk {
  Client: typeof McpClient;
  StdioClientTransport: typeof StdioClientTransport;
  getDefaultEnvironment: () => Record<string, string>;
  StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport;
  SSEClientTransport: typeof SSEClientTransport;
}

let sdk: Promise<McpSdk> | undefined;
function loadSdk(): Promise<McpSdk> {
  sdk ??= Promise.all([
    import(/* @vite-ignore */ SDK_CLIENT),
    import(/* @vite-ignore */ SDK_STDIO),
    import(/* @vite-ignore */ SDK_HTTP),
    import(/* @vite-ignore */ SDK_SSE),
  ]).then(([client, stdio, http, sse]) => ({
    Client: client.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    getDefaultEnvironment: stdio.getDefaultEnvironment,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
    SSEClientTransport: sse.SSEClientTransport,
  }));
  return sdk;
}

/**
 * The real lister: the MCP SDK's client over stdio, or over streamable HTTP falling back to SSE; list
 * every page of tools; close — which, for stdio, ends the process it started.
 */
export const listMcpTools: McpLister = async (server, options) => {
  const mcp = await loadSdk();
  if ("command" in server) {
    const transport = stdioTransport(mcp, server, options.execEnv);
    return { transport: "stdio", tools: await listOver(mcp, transport, options.signal) };
  }
  const init = { headers: server.headers };
  try {
    return { transport: "http", tools: await listOver(mcp, new mcp.StreamableHTTPClientTransport(new URL(server.url), { requestInit: init }), options.signal) };
  } catch (first) {
    if (options.signal.aborted) throw first;
    // An older server speaks only SSE. What it says is the answer; if it fails too, the first failure
    // is the one worth reading — a streamable server that refused says why, an SSE retry would not.
    try {
      return { transport: "sse", tools: await listOver(mcp, new mcp.SSEClientTransport(new URL(server.url), { requestInit: init }), options.signal) };
    } catch {
      throw first;
    }
  }
};

/**
 * The stdio transport, in the project's execution environment: a WSL project's server runs in the
 * distro (`wsl.exe -d <distro> -- <command>`), with its variables carried across by `WSLENV`.
 */
function stdioTransport(mcp: McpSdk, server: Extract<ResolvedMcpServer, { command: string }>, execEnv: ExecEnv | undefined): StdioClientTransport {
  const env = { ...mcp.getDefaultEnvironment(), ...server.env };
  if (execEnv !== undefined && execEnv !== "windows") {
    const { file, argv } = resolveInvocation(server.command, server.args, { execEnv, ...(server.cwd !== undefined ? { cwd: server.cwd } : {}) });
    return new mcp.StdioClientTransport({ command: file, args: argv, env: { ...env, ...wslenvOf(server.env) }, stderr: "pipe" });
  }
  return new mcp.StdioClientTransport({ command: server.command, args: server.args, env, stderr: "pipe", ...(server.cwd !== undefined ? { cwd: server.cwd } : {}) });
}

async function listOver(mcp: McpSdk, transport: Transport, signal: AbortSignal): Promise<McpToolInfo[]> {
  const client = new mcp.Client({ name: "jaira", version: "1" }, { capabilities: {} });
  const close = (): void => void client.close().catch(() => undefined);
  signal.addEventListener("abort", close, { once: true });
  try {
    await client.connect(transport, { signal });
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Pages until the server says there are no more — a cap, since a server that always answers with
    // a cursor would otherwise hold this open until the deadline.
    for (let page = 0; page < 50; page++) {
      const answer = await client.listTools(cursor !== undefined ? { cursor } : undefined, { signal });
      for (const tool of answer.tools) {
        const annotations = tool.annotations ?? {};
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description } : {}),
          annotations: {
            ...(typeof annotations.title === "string" ? { title: annotations.title } : typeof tool.title === "string" ? { title: tool.title } : {}),
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
            ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
          },
        });
      }
      cursor = typeof answer.nextCursor === "string" && answer.nextCursor.length > 0 ? answer.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return tools;
  } finally {
    signal.removeEventListener("abort", close);
    await client.close().catch(() => undefined);
  }
}

// --- detection ----------------------------------------------------------------------

/** A known server that answers on a port of this machine — asked, never started. */
export const KNOWN_MCP_PORTS: ReadonlyArray<{ name: string; label: string; url: string }> = [{ name: "figma", label: "Figma Dev Mode", url: "http://127.0.0.1:3845/mcp" }];

/** Short: a server on this machine that cannot list its tools in this long is not worth waiting for on a page. */
export const MCP_PORT_TIMEOUT_MS = 1500;

export interface McpDetectOptions {
  /** The home directory — `~/.claude.json`, `~/.cursor/`. Injected so a test points it at a temp dir. */
  home?: string;
  /** `%APPDATA%` — where Claude Desktop keeps its config on Windows. */
  appData?: string;
  platform?: NodeJS.Platform;
  /** The project, for its `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` and its entry in `~/.claude.json`. */
  projectDir?: string;
  /** How a known port is asked; replaced in a test. */
  list?: McpLister;
  timeoutMs?: number;
  /** Leave the port out — a test with no network. */
  ports?: ReadonlyArray<{ name: string; label: string; url: string }>;
}

/**
 * JSON with the comments and trailing commas VS Code's and Cursor's files allow — read leniently,
 * because a file another tool wrote is not ours to refuse. `undefined` when it still is not JSON.
 */
function readLenient(text: string): unknown {
  const source = stripBom(text);
  try {
    return JSON.parse(source);
  } catch {
    // Strip comments outside strings, then a comma before a closing bracket.
    let out = "";
    let inString = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]!;
      if (inString) {
        out += ch;
        if (ch === "\\") out += source[++i] ?? "";
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        out += "\n";
      } else if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i++;
      } else {
        out += ch;
      }
    }
    try {
      return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/** Two spellings of one directory — `C:\x`, `c:/x/` — compared as Claude Code keys its projects. */
function sameDir(a: string, b: string): boolean {
  const key = (dir: string): string => dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key(a) === key(b);
}

/** A server map from somebody else's file, as ours — names made safe, entries that are neither command nor url dropped. */
function serversOf(map: unknown): Array<{ name: string; config: McpServerConfig }> {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];
  const out: Array<{ name: string; config: McpServerConfig }> = [];
  for (const [name, entry] of Object.entries(map)) {
    const config = mcpServerOfForeign(entry);
    if (config === undefined) continue;
    let safe = mcpNameOfForeign(name);
    for (let n = 2; out.some((s) => s.name === safe); n++) safe = `${mcpNameOfForeign(name)}-${n}`;
    out.push({ name: safe, config });
  }
  return out;
}

/** One file-backed source: its label, where it is, and how its server map is found in the document. */
function fileSource(source: McpSourceKind, label: string, where: string, pick: (doc: Record<string, unknown>) => unknown[]): McpDetectedSource {
  let text: string;
  try {
    text = readFileSync(where, "utf8");
  } catch {
    return { source, label, where, state: "not found", servers: [] };
  }
  const doc = readLenient(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { source, label, where, state: "none listed", servers: [], detail: "the file is not JSON JaiRA can read" };
  }
  const servers = pick(doc as Record<string, unknown>).flatMap(serversOf);
  return { source, label, where, state: servers.length > 0 ? "found" : "none listed", servers };
}

/**
 * Where other tools on this machine keep their MCP servers, and what each lists — read, never started.
 *
 * Claude Code keeps two lists in `~/.claude.json`: `mcpServers` for every project, and one per project
 * under `projects[<dir>]`; both are this project's servers as Claude Code sees them. Figma's Dev Mode
 * server is asked on its port, since it is found running rather than configured.
 */
export async function detectMcpServers(options: McpDetectOptions = {}): Promise<McpDetectedSource[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const project = options.projectDir;
  const sources: McpDetectedSource[] = [];

  sources.push(
    fileSource("claude-code", "Claude Code", join(home, ".claude.json"), (doc) => {
      const projects = doc["projects"];
      const own =
        project !== undefined && projects !== null && typeof projects === "object" && !Array.isArray(projects)
          ? Object.entries(projects).find(([dir]) => sameDir(dir, project))?.[1]
          : undefined;
      return [doc["mcpServers"], own !== null && typeof own === "object" ? (own as Record<string, unknown>)["mcpServers"] : undefined];
    }),
  );
  if (project !== undefined) sources.push(fileSource("project", "This project's .mcp.json", join(project, ".mcp.json"), (doc) => [doc["mcpServers"]]));

  const desktop =
    platform === "win32"
      ? join(options.appData ?? process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");
  sources.push(fileSource("claude-desktop", "Claude Desktop", desktop, (doc) => [doc["mcpServers"]]));

  sources.push(fileSource("cursor", "Cursor", join(home, ".cursor", "mcp.json"), (doc) => [doc["mcpServers"]]));
  if (project !== undefined) {
    sources.push(fileSource("cursor", "Cursor, this project", join(project, ".cursor", "mcp.json"), (doc) => [doc["mcpServers"]]));
    sources.push(fileSource("vscode", "VS Code, this project", join(project, ".vscode", "mcp.json"), (doc) => [doc["servers"]]));
  }

  const list = options.list ?? listMcpTools;
  const ports = options.ports ?? KNOWN_MCP_PORTS;
  const asked = await Promise.all(
    ports.map(async (port): Promise<McpDetectedSource> => {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? MCP_PORT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const listing = await Promise.race([
          list({ url: port.url, headers: {} }, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error("no answer in time"));
              controller.abort();
            }, timeoutMs);
          }),
        ]);
        const count = listing.tools.length;
        return {
          source: "port",
          label: port.label,
          where: port.url,
          state: "found",
          servers: [{ name: port.name, config: { url: port.url } }],
          detail: `answering, ${count} ${count === 1 ? "tool" : "tools"}`,
        };
      } catch {
        return { source: "port", label: port.label, where: port.url, state: "not found", servers: [], detail: "not answering" };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  return [...sources, ...asked];
}

// --- the call, as the gate was asked about it ----------------------------------------

/** The MCP tool a call really is, by the call's own input — see {@link noteMcpCall}. */
const MCP_CALLS = new WeakMap<object, string>();

/**
 * Leave the MCP tool a call really is against the call's input, before the gate is asked about it by
 * its SERVER's name (`translatedGate` in `./agentTools`). Upstream hands the same input object on to
 * the narrowing and to the approver, and both read it back ({@link mcpCallOf}) — the seam
 * `commandDecisionOf` uses for a shell line.
 */
export function noteMcpCall(input: unknown, tool: string): void {
  if (input !== null && typeof input === "object") MCP_CALLS.set(input, tool);
}

/** The MCP tool {@link noteMcpCall} left against this input, if any. */
export function mcpCallOf(input: unknown): string | undefined {
  return input !== null && typeof input === "object" ? MCP_CALLS.get(input) : undefined;
}

/** The tool a call names, when it is a tool of an MCP server — and the subject its server's line is. */
export function mcpCallSubjects(subject: string): { tool: string; server: string } | undefined {
  const parsed = parseMcpSubject(subject);
  return parsed?.tool !== undefined ? { tool: mcpToolSubject(parsed.server, parsed.tool), server: mcpServerSubject(parsed.server) } : undefined;
}
