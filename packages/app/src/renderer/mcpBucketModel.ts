/**
 * What a permission set's MCP bucket DOES — every edit and every sentence, as pure functions of the map
 * (the rows are `mcpBucket.tsx`).
 *
 * A configured server is a GROUP, as a program is under Execution (decision 0007 §5): its own line,
 * `mcp__figma`, is the mode for any tool of it no line names, and a line per named tool
 * (`mcp__figma__get_code`) says what differs. With no line of its own a server answers to `other`, and
 * that is what its group's button shows until the first change writes the server's line.
 *
 * Kept out of the component for the reason `composerPermissionSet.ts` is: there is no DOM harness, so
 * logic that lives in a component is logic nothing asserts.
 */
import {
  MODE_WHEN_UNSET,
  isFunctionMode,
  mcpFirstMode,
  mcpServerSubject,
  mcpToolLines,
  mcpToolSubject,
  parseMcpSubject,
  type McpServerStatus,
  type McpToolInfo,
  type PermissionSet,
  type PermissionSetEntry,
  type PermissionSetMode,
} from "@jaira/shared/browser";

/** One group the bucket draws: a configured server, or one the permission set names that is configured nowhere. */
export interface McpGroup {
  server: string;
  /** What the tools probe found, when it has asked. */
  status?: McpServerStatus | undefined;
  /** False for a server the map names and no layer configures. */
  configured: boolean;
}

/**
 * The groups, in order: every configured server as the probe listed it, then any server the permission
 * set names a line for that nothing configures — so a line for a server that went away can still be
 * read and taken out.
 */
export function mcpGroupsOf(permissionSet: PermissionSet, servers: readonly McpServerStatus[] | undefined): McpGroup[] {
  const groups: McpGroup[] = (servers ?? []).map((status) => ({ server: status.name, status, configured: true }));
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind !== "mcp") continue;
    const server = parseMcpSubject(subject)?.server;
    if (server !== undefined && !groups.some((group) => group.server === server)) groups.push({ server, configured: false });
  }
  return groups;
}

/** The mode a group's button shows: the server's own line, else what any tool of it answers to — `other`. */
export function mcpGroupModeOf(permissionSet: PermissionSet, server: string): PermissionSetMode {
  const own = permissionSet.entries[mcpServerSubject(server)];
  return (own?.kind === "mcp" ? own.mode : undefined) ?? permissionSet.other ?? MODE_WHEN_UNSET;
}

/** Does the permission set write a line for the server itself? */
export function holdsMcpServer(permissionSet: PermissionSet, server: string): boolean {
  return permissionSet.entries[mcpServerSubject(server)]?.kind === "mcp";
}

function edited(permissionSet: PermissionSet, entries: Record<string, PermissionSetEntry>): PermissionSet {
  return { entries, ...(permissionSet.other !== undefined ? { other: permissionSet.other } : {}) };
}

/** Set the server's own line — written the first time, which is how a group with none gets one. */
export function withMcpServerMode(permissionSet: PermissionSet, server: string, mode: PermissionSetMode): PermissionSet {
  return edited(permissionSet, { ...permissionSet.entries, [mcpServerSubject(server)]: { kind: "mcp", mode } });
}

/**
 * Name one tool, at the mode it starts at: what the SERVER says of it, where it says something —
 * read-only is allowed, destructive refused — else what it answered to before it had a line.
 */
export function withMcpTool(permissionSet: PermissionSet, server: string, tool: McpToolInfo | string): PermissionSet {
  const name = typeof tool === "string" ? tool : tool.name;
  const subject = mcpToolSubject(server, name);
  if (Object.hasOwn(permissionSet.entries, subject)) return permissionSet;
  const mode = mcpFirstMode(typeof tool === "string" ? undefined : tool.annotations, mcpGroupModeOf(permissionSet, server));
  return edited(permissionSet, { ...permissionSet.entries, [subject]: { kind: "mcp", mode } });
}

/** Take a whole server out — its own line and every tool line under it: the group's minus. */
export function withoutMcpServer(permissionSet: PermissionSet, server: string): PermissionSet {
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [subject, entry] of Object.entries(permissionSet.entries)) {
    if (entry.kind === "mcp" && parseMcpSubject(subject)?.server === server) continue;
    entries[subject] = entry;
  }
  return edited(permissionSet, entries);
}

/** The tools of a server the probe listed that the map names no line for, by name. */
export function unnamedMcpTools(permissionSet: PermissionSet, group: McpGroup): McpToolInfo[] {
  const named = new Set(mcpToolLines(permissionSet, group.server).map((line) => line.tool));
  return (group.status?.tools ?? []).filter((tool) => !named.has(tool.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A mode as the short word a folded group's hint uses: `allowed`, `asks`, `denied`, `smart`. */
function shortWord(mode: PermissionSetMode): string {
  return isFunctionMode(mode) ? mode.function : { allow: "allowed", ask: "asks", deny: "denied" }[mode];
}

/** What a mode does to a tool, as the end of a sentence: `asks`, `is allowed`, `is decided by smart`. */
function restVerb(mode: PermissionSetMode): string {
  return isFunctionMode(mode) ? `is decided by ${mode.function}` : { allow: "is allowed", ask: "asks", deny: "is refused" }[mode];
}

/** How many tools the server listed, as the hint opens: `21 tools`, or why there is no count. */
function toolCount(group: McpGroup): string {
  if (!group.configured) return "not a configured server";
  const status = group.status;
  if (status === undefined) return "not asked yet";
  if (status.state !== "ready") return status.state;
  return `${status.tools.length} ${status.tools.length === 1 ? "tool" : "tools"}`;
}

/**
 * The line under a group — open: `21 tools · 2 named here; any other figma tool asks`; folded, what
 * it names that differs from the rest: `21 tools · 2 named (browser_evaluate denied); the rest smart`.
 */
export function mcpGroupHint(permissionSet: PermissionSet, group: McpGroup, open: boolean): string {
  const mode = mcpGroupModeOf(permissionSet, group.server);
  const lines = mcpToolLines(permissionSet, group.server);
  if (open) return `${toolCount(group)} · ${lines.length} named here; any other ${group.server} tool ${restVerb(mode)}`;
  if (lines.length === 0) return `${toolCount(group)} · every tool ${shortWord(mode)}`;
  const differing = lines.filter((line) => line.mode !== undefined && shortWord(line.mode) !== shortWord(mode)).map((line) => `${line.tool} ${shortWord(line.mode!)}`);
  return `${toolCount(group)} · ${lines.length} named${differing.length > 0 ? ` (${differing.join(", ")})` : ""}; the rest ${shortWord(mode)}`;
}

/** A tool line's hint: what the server says the tool does, and what it says about touching anything. */
export function mcpToolHint(tool: McpToolInfo | undefined): string {
  if (tool === undefined) return "not in the list the server last answered with";
  const said = tool.annotations.readOnlyHint === true ? " · read-only, says the server" : tool.annotations.destructiveHint === true ? " · destructive, says the server" : "";
  return `${tool.description ?? tool.annotations.title ?? ""}${said}`.replace(/^ · /, "");
}

/** The add line's words: `name another figma tool: 19 more, from add_comment to whoami`. */
export function mcpAddLabel(server: string, unnamed: readonly McpToolInfo[]): string {
  if (unnamed.length === 0) return `name a ${server} tool`;
  if (unnamed.length === 1) return `name another ${server} tool: ${unnamed[0]!.name}`;
  return `name another ${server} tool: ${unnamed.length} more, from ${unnamed[0]!.name} to ${unnamed[unnamed.length - 1]!.name}`;
}

/** How many MCP lines the map holds — the bucket's badge. */
export function mcpLineCount(permissionSet: PermissionSet): number {
  return Object.values(permissionSet.entries).filter((entry) => entry.kind === "mcp").length;
}
