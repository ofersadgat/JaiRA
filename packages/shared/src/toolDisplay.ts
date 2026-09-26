/**
 * What a tool CALL is called on screen — its name as a person reads it, its glyph, and the server it
 * came from when that is somebody else's.
 *
 * The record keeps the name the agent called, and that name is transport: `mcp__dai__list_merge_requests`
 * is JaiRA's own `list_merge_requests` reached over the bridge every agent run has, and
 * `mcp__linear__list_issues` is a tool of a server the person connected. Neither is a word. So:
 *
 *  - a standard tool (`TOOL_SPECS`), bare or over the `dai` bridge, is its own `title` and `icon`;
 *  - a tool of another MCP server is its name in words, with the server beside it — the server is the
 *    one part of the prefix that says something;
 *  - anything else — an agent's built-in (`Read`, `WebFetch`), a tool nobody modelled — is its name in
 *    words, since the agent chose a readable name and splitting it is all it needs.
 *
 * The icon is left unset where nothing KNOWS it, and the caller guesses from the name: a guess is a
 * drawing concern, and the one place that draws is where it belongs.
 */
import { parseMcpSubject, RESERVED_MCP_SERVERS } from "./mcp";
import { TOOL_SPEC_BY_NAME, type ToolIconName } from "./toolVocabulary";

export interface ToolDisplay {
  /** The call as a person reads it: "List merge requests", "Read", "Web fetch". */
  title: string;
  /** The glyph, when the tool's own entry states one. */
  icon?: ToolIconName;
  /** The MCP server it came from, when that is not JaiRA's own bridge. */
  server?: string;
}

/** `list_issues` → "List issues", `WebFetch` → "Web fetch", `getHTTPStatus` → "Get HTTP status". */
export function wordsOf(name: string): string {
  const words = name
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    // An acronym keeps its case; everything else reads in sentence case.
    .map((word, i) => (/^[A-Z0-9]{2,}$/.test(word) ? word : i === 0 ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()));
  return words.length > 0 ? words.join(" ") : name;
}

export function toolDisplayOf(name: string): ToolDisplay {
  const mcp = parseMcpSubject(name);
  const bare = mcp?.tool ?? name;
  const own = mcp === undefined || RESERVED_MCP_SERVERS.includes(mcp.server);
  const spec = own ? TOOL_SPEC_BY_NAME.get(bare) : undefined;
  if (spec !== undefined) return { title: spec.title, icon: spec.icon };
  return { title: wordsOf(bare), ...(mcp !== undefined && !own ? { server: mcp.server } : {}) };
}
