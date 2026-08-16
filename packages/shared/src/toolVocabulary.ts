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
 *  - a profile is a map over them ({@link ToolProfile});
 *  - the agent wiring translates between our name and the agent's own ({@link ToolSpec.natives}).
 *
 * ## Categories are derived, never stored
 *
 * A category has no setting of its own. It SHOWS the setting of what is under it — every child the
 * same means the category reads as that, and anything else reads as `custom`. That keeps one map on
 * disk (`permissions.tools`) and keeps the menu from growing a precedence chain between a category, a
 * tool and a profile, which is three places for one answer to come from.
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

/** The four groups a permission menu shows. Hard-coded: these are a taxonomy, not data. */
export type ToolCategoryId = "files" | "execution" | "web" | "mcp";

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
  { id: "mcp", label: "MCP", hint: "tools served by connected MCP servers" },
];

/**
 * What an agent calls a tool of ours, per transport.
 *
 * The names are the agent's own and are what its permission rules, its allow-list and its deny-list
 * are all written against — so this map is what makes "use JaiRA's version of `read_file`" and "let
 * the agent use its own `Read`" expressible as the same decision about one tool.
 *
 * Absent for a transport ⇒ that agent has no built-in doing this job, so there is nothing to choose
 * between: the tool is ours or it does not exist.
 */
export interface NativeNames {
  claude?: string;
  codex?: string;
}

export interface ToolSpec {
  /** The LOGICAL name — what a workflow authors, what a policy is written against. */
  name: string;
  label: string;
  category: ToolCategoryId;
  /** Does not change the workspace or the world — what a narrowing profile gates on. */
  readOnly: boolean;
  /** What granting it actually lets the model do, in one line, for the menu. */
  hint: string;
  natives?: NativeNames;
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
    readOnly: true,
    hint: "read a file in the workspace",
    pathArgs: ["path"],
    natives: { claude: "Read" },
  },
  {
    name: "glob",
    label: "glob",
    category: "files",
    readOnly: true,
    hint: "list files matching a pattern",
    pathArgs: ["path"],
    natives: { claude: "Glob" },
  },
  {
    name: "grep",
    label: "grep",
    category: "files",
    readOnly: true,
    hint: "search file contents for a pattern",
    pathArgs: ["path"],
    natives: { claude: "Grep" },
  },
  {
    name: "edit",
    label: "edit",
    category: "files",
    readOnly: false,
    hint: "replace exact text in an existing file",
    pathArgs: ["path"],
    natives: { claude: "Edit" },
  },
  {
    name: "write_file",
    label: "write",
    category: "files",
    readOnly: false,
    hint: "create a file, or replace one whole",
    pathArgs: ["path"],
    natives: { claude: "Write" },
  },
  {
    name: "bash",
    label: "bash",
    category: "execution",
    readOnly: false,
    hint: "run shell commands, under the policy",
    pathArgs: ["cwd"],
    natives: { claude: "Bash" },
  },
  {
    name: "web_fetch",
    label: "fetch",
    category: "web",
    readOnly: true,
    hint: "fetch a URL and read what comes back",
    urlArgs: ["url"],
    natives: { claude: "WebFetch" },
  },
  {
    name: "web_search",
    label: "search",
    category: "web",
    readOnly: true,
    hint: "search the web",
    natives: { claude: "WebSearch" },
  },
];

/** By logical name — the lookup every consumer wants. */
export const TOOL_SPEC_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

/**
 * The LOGICAL name an agent's built-in stands for, when one of ours does that job.
 *
 * The reverse of {@link ToolSpec.natives}, and the direction the permission gate actually asks in: a
 * callback arrives naming `Glob`, and the mode that governs it was authored against `glob`.
 */
export function logicalOfNative(native: string): string | undefined {
  for (const spec of TOOL_SPECS) {
    if (spec.natives?.claude === native || spec.natives?.codex === native) return spec.name;
  }
  return undefined;
}

/** Every native name for a transport — what a deny-list or an ask-list is written from. */
export function nativeNamesFor(transport: keyof NativeNames, tools?: readonly string[]): string[] {
  const wanted = tools === undefined ? TOOL_SPECS : TOOL_SPECS.filter((spec) => tools.includes(spec.name));
  return wanted.map((spec) => spec.natives?.[transport]).filter((n): n is string => n !== undefined);
}

/** The tools in one category, in table order. */
export function toolsInCategory(category: ToolCategoryId): ToolSpec[] {
  return TOOL_SPECS.filter((spec) => spec.category === category);
}

// --- profiles ----------------------------------------------------------------

/**
 * A profile, as a MAP rather than a predicate.
 *
 * It used to be a function over `readOnly`, which answered for the tools we had registered and had
 * nothing to say about the ones we had not — the exact gap that let an agent's built-ins run
 * ungoverned. A map says something about every tool by name, and `other` says something about every
 * tool there is no name for, which between them leaves nothing undecided.
 *
 * `default` and `other` are both here and are not the same (see the module header): `default` is the
 * fallback for a KNOWN tool with no entry, `other` is the answer for a name that is not in the table.
 */
export interface ToolProfile {
  id: string;
  label: string;
  hint: string;
  /** Per-tool, by logical name. A tool absent here takes {@link ToolProfile.default}. */
  tools: Record<string, ToolMode>;
  /** What a known tool with no entry resolves to. */
  default: ToolMode;
  /** What a tool NOT in {@link TOOL_SPECS} resolves to — an agent built-in, an MCP tool, anything. */
  other: ToolMode;
}

/** The four modes, restated here so this module stands alone for a renderer that only draws them. */
export type ToolMode = "ask" | "smart" | "allow" | "deny";

/**
 * A profile whose per-tool entries are GENERATED from `readOnly`.
 *
 * The three built-in profiles are built this way rather than hand-authored, because a hand-authored
 * table silently loses coverage the day somebody adds a tool and forgets to update four maps — and
 * the failure is invisible: the new tool simply falls to `default` under every profile, which is
 * precisely how you get a writer treated as a reader.
 */
function profileOf(id: string, label: string, hint: string, modeFor: (spec: ToolSpec) => ToolMode, rest: { default: ToolMode; other: ToolMode }): ToolProfile {
  return {
    id,
    label,
    hint,
    tools: Object.fromEntries(TOOL_SPECS.map((spec) => [spec.name, modeFor(spec)])),
    ...rest,
  };
}

/**
 * The built-in profiles.
 *
 * `other` is the entry that matters and the one that did not exist. Under `read-only` it is `ask`:
 * an unmodelled tool might read and might write, and the honest thing is to put the one question we
 * cannot answer to somebody who can. Under `full` it is `ask` as well rather than `allow` — `full`
 * means every tool is in SCOPE, not that every tool is waved through, and a name nobody has ever
 * seen is not a thing to wave through on the strength of the profile being permissive.
 */
export const TOOL_PROFILES: readonly ToolProfile[] = [
  profileOf("read-only", "Read only", "nothing may change the workspace or the world", (spec) => (spec.readOnly ? "ask" : "deny"), {
    default: "deny",
    other: "ask",
  }),
  profileOf("plan", "Plan", "read and think; changes wait for a plan you approve", (spec) => (spec.readOnly ? "allow" : "deny"), {
    default: "deny",
    other: "ask",
  }),
  profileOf("full", "Full", "every tool is in scope; each still answers to its own mode", () => "ask", {
    default: "ask",
    other: "ask",
  }),
];

export const TOOL_PROFILE_BY_ID: ReadonlyMap<string, ToolProfile> = new Map(TOOL_PROFILES.map((p) => [p.id, p]));

/**
 * The mode a profile gives one tool — the whole resolution, in one place.
 *
 * Order: the profile's explicit entry, then `default` for a tool we know, then `other` for one we do
 * not. A caller's own authored mode is layered ON TOP of this by the permission ledger; this answers
 * only what the profile says, which is the floor.
 */
export function profileModeOf(profile: ToolProfile, tool: string): ToolMode {
  const own = Object.hasOwn(profile.tools, tool) ? profile.tools[tool] : undefined;
  if (own !== undefined) return own;
  return TOOL_SPEC_BY_NAME.has(tool) ? profile.default : profile.other;
}

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
