/**
 * Every tool JaiRA can gate, what it does, and what the agents call it — the one table.
 *
 * There were three lists of tools before this and they disagreed. `JAIRA_TOOLS` in the runtime named
 * three; the composer rendered those three and offered a fourth choice called "default" that was not
 * a tool at all; and a delegated agent turned up with a dozen built-ins nobody had written down, so a
 * `read-only` state watched `Glob`, `Grep` and `Read` run twenty times without a prompt — not because
 * the gate failed, but because a tool the gate has never heard of cannot be classified, and an
 * unclassifiable tool is escalated or waved through, never decided.
 *
 * So this is the vocabulary, in `shared`, because all four consumers need the SAME answer:
 *
 *  - the runtime registers implementations for these names;
 *  - the permission menu draws them, grouped by {@link ToolCategory};
 *  - a toolset is a map over them (`toolsets.ts`, decision 0007);
 *  - each agent executor says which of ITS tools is which of these (`agentTools.ts`) — the table
 *    holds no agent's names, and stays the one standard list.
 *
 * ## Categories are derived, never stored
 *
 * A category has no setting of its own. It SHOWS the setting of what is under it — every child the
 * same means the category reads as that, and anything else reads as `custom`. That keeps one map on
 * disk (`permissions.tools`) and keeps the menu from growing a precedence chain between a category, a
 * tool and a preset, which is three places for one answer to come from.
 *
 * ## `other` is not `default`
 *
 * They are different questions and the distinction is the whole reason an agent's built-ins were
 * ungoverned. `default` is what a KNOWN tool falls back to when nobody has set it — the base of the
 * table below. `other` is what happens to a name that is not in the table at all: an agent's built-in
 * we have not modelled, an MCP tool from someone else's server, anything that appears at runtime.
 * With only `default`, "I have not decided about `write_file` yet" and "I have never heard of this
 * tool" resolved to the same answer, and one of those deserves to be `deny`.
 */

/** The groups a permission menu shows. Hard-coded: these are a taxonomy, not data. */
export type ToolCategoryId = "files" | "execution" | "web" | "tasks" | "mcp";

export interface ToolCategory {
  id: ToolCategoryId;
  label: string;
  /** One line under the heading — what saying "allow" to the whole group would mean. */
  hint: string;
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  { id: "files", label: "File permissions", hint: "reading, searching and changing files in the workspace" },
  { id: "execution", label: "Execution", hint: "running commands on this machine" },
  { id: "web", label: "Web", hint: "reaching the network" },
  // The workflow tools of decision 0005 §3 — what `chat_control/*` holds, and nothing else does yet.
  { id: "tasks", label: "Tasks & workflows", hint: "starting, moving and answering tasks" },
  { id: "mcp", label: "MCP", hint: "tools served by connected MCP servers" },
];

export interface ToolSpec {
  /** The LOGICAL name — what a workflow authors, what a policy is written against. */
  name: string;
  label: string;
  category: ToolCategoryId;
  /** What granting it actually lets the model do, in one line, for the menu. */
  hint: string;
  /**
   * Which of this tool's arguments name a PLACE — what a scope table is resolved against.
   *
   * In the table rather than beside the implementations because it is the same fact the tool's
   * `inputSchema` states, and a permission that read it from a second list would drift from the tool
   * the day somebody renamed an argument. A tool with none is not about a place at all.
   */
  pathArgs?: readonly string[];
  /** The same, for arguments naming a URL — the web tools scope by those instead. */
  urlArgs?: readonly string[];
  /**
   * True when JaiRA has no implementation of its own, so `app` is not a choice that can be made.
   *
   * Listed anyway, and that is the point: a tool we cannot SERVE is still a tool we can GOVERN. The
   * agent has one, it will use it, and the only way to say anything about that is to have a name for
   * it here.
   */
  nativeOnly?: boolean;
  /**
   * Available whether or not anybody granted it — the tool list does not decide this one.
   *
   * Reserved for a tool that adds no CAPABILITY: `show_artifact` writes only under the task's own
   * artifact directory and cannot address anything else, so a state that omits it is not making a
   * decision about reach, it simply never thought about drawing. Leaving it to the list means a
   * conversation asked for a mockup gets HTML pasted into the answer instead, which is what
   * happened — the model had no other way to hand a picture over.
   *
   * Two things this deliberately is NOT. It is not exemption from the gate: the mode still resolves,
   * and the size rule on `CONTENT_TOOLS` still asks before a huge one. And it is not immunity from an
   * EXPLICIT `deny` — an author who names this tool and refuses it has decided, and an omission is
   * the only thing being overridden here.
   */
  alwaysGranted?: boolean;
  /**
   * NAMED, and not yet SERVED: the tool is in the standard list so a toolset can hold it, the menu
   * can draw it and the linter knows the name — and nothing registers an implementation for it yet.
   *
   * Everything that would HAND a tool to somebody skips one marked this way, in one place each:
   * `offeredTools` (so lowering never writes it into the `tools` list the engine resolves against
   * the registry, and `viewOfToolset` never sees it held), `planAgentTools` (never injected), and
   * `JAIRA_TOOLS` in the runtime (never registered, wrapped, or asserted against an implementation).
   * Its MODE still travels — a mode for a name nothing calls is inert — so the day the tool is
   * implemented, deleting this mark is the whole change.
   *
   * The workflow tools of decision 0005 §3 carry it until they are built.
   */
  unserved?: true;
}

/**
 * The table.
 *
 * Ordered within a category by how ordinary the tool is, because that is the order somebody scans
 * looking for the one they are about to grant.
 */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "read_file",
    label: "read",
    category: "files",
    hint: "read a file in the workspace",
    pathArgs: ["path"],
  },
  {
    name: "glob",
    label: "glob",
    category: "files",
    hint: "list files matching a pattern",
    pathArgs: ["path"],
  },
  {
    name: "grep",
    label: "grep",
    category: "files",
    hint: "search file contents for a pattern",
    pathArgs: ["path"],
  },
  {
    name: "edit",
    label: "edit",
    category: "files",
    hint: "replace exact text in an existing file",
    pathArgs: ["path"],
  },
  {
    name: "write_file",
    label: "write",
    category: "files",
    hint: "create a file, or replace one whole",
    pathArgs: ["path"],
  },
  {
    name: "show_artifact",
    label: "show",
    category: "files",
    /*
     * ALWAYS GRANTED, and it is the confinement above that pays for it.
     *
     * The tool list answers "what may this agent reach", and this tool reaches nothing a state could
     * want to withhold — it produces a new file under the task's own artifact directory and cannot
     * address anything else. So its absence from a list is never a decision, only an omission, and
     * honouring the omission costs the thing the tool exists for: a conversation asked for a mockup
     * pastes 29k characters of HTML into its answer, because that is the only way left to hand a
     * picture over. See {@link ToolSpec.alwaysGranted} for what this does not exempt it from.
     */
    alwaysGranted: true,
    hint: "produce something to look at — a page, a drawing, a document",
    pathArgs: ["path"],
    // No agent declares a native for it: there is no built-in doing this job in a delegated run, so
    // there is nothing to displace and nothing to remove when the tool is not held.
  },
  {
    name: "bash",
    label: "bash",
    category: "execution",
    hint: "run shell commands, under the policy",
    pathArgs: ["cwd"],
  },
  {
    name: "web_fetch",
    label: "fetch",
    category: "web",
    hint: "fetch a URL and read what comes back",
    urlArgs: ["url"],
  },
  {
    name: "web_search",
    label: "search",
    category: "web",
    hint: "search the web",
  },
  // The workflow tools (decision 0005 §3): the host's own operations, offered to a conversation.
  // NAMED here so a toolset can hold them — `chat_control/*` holds nothing else — and NOT YET
  // SERVED: see {@link ToolSpec.unserved}.
  { name: "workflows", label: "workflows", category: "tasks", unserved: true, hint: "list workflows, and what a state takes and produces" },
  { name: "start", label: "start", category: "tasks", unserved: true, hint: "start a task in a workflow, from this conversation" },
  { name: "move", label: "move", category: "tasks", unserved: true, hint: "move a task to another state — forward, backward or across workflows" },
  { name: "tasks", label: "tasks", category: "tasks", unserved: true, hint: "what was started here, where each stands and what it produced" },
  { name: "answer", label: "answer", category: "tasks", unserved: true, hint: "settle a question a task is asking" },
  { name: "hold", label: "hold", category: "tasks", unserved: true, hint: "hold a task where it stands" },
  { name: "release", label: "release", category: "tasks", unserved: true, hint: "release a held task" },
  { name: "stop", label: "stop", category: "tasks", unserved: true, hint: "stop a task" },
];

/** By logical name — the lookup every consumer wants. */
export const TOOL_SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

/** Is this a standard tool something SERVES today? See {@link ToolSpec.unserved}. */
export function isServedTool(name: string): boolean {
  const spec = TOOL_SPEC_BY_NAME.get(name);
  return spec !== undefined && spec.unserved !== true;
}

/**
 * The tools a declared list does not get to leave out — see {@link ToolSpec.alwaysGranted}.
 *
 * Derived rather than restated, because three call sites need the same answer: what an agent is
 * handed (`planAgentTools`), what is wrapped for it (`gateTools`'s names), and what a state's own
 * `environment.tools` resolves to at the top of a run. A second copy is a third place for a tool to
 * go missing from.
 */
export const ALWAYS_GRANTED_TOOLS: readonly string[] = TOOL_SPECS.filter((spec) => spec.alwaysGranted === true).map(
  (spec) => spec.name,
);

/** A declared list with the always-granted tools folded in, order preserved, no duplicates. */
export function withAlwaysGranted(tools: readonly string[]): string[] {
  return [...tools, ...ALWAYS_GRANTED_TOOLS.filter((name) => !tools.includes(name))];
}

/** The tools in one category, in table order. */
export function toolsInCategory(category: ToolCategoryId): ToolSpec[] {
  return TOOL_SPECS.filter((spec) => spec.category === category);
}

/** The four modes, restated here so this module stands alone for a renderer that only draws them. */
export type ToolMode = "ask" | "smart" | "allow" | "deny";

/**
 * What a category reads as, given the modes under it — see the module header on derivation.
 *
 * `undefined` for a category whose tools are not all the same, which the menu draws as `custom`. Not
 * a mode: "these disagree" is a different statement from any of the four, and collapsing it to one
 * would make the row lie about what pressing it would preserve.
 */
export function categoryModeOf(category: ToolCategoryId, modeOf: (tool: string) => ToolMode): ToolMode | undefined {
  const tools = toolsInCategory(category);
  if (tools.length === 0) return undefined;
  const first = modeOf(tools[0]!.name);
  return tools.every((spec) => modeOf(spec.name) === first) ? first : undefined;
}
