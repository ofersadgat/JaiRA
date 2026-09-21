/**
 * What an agent executor DECLARES about its own tools (decision 0007 §3).
 *
 * The standard list — `TOOL_SPECS` — used to carry a `natives: { claude: "Read" }` column, which made
 * the one table everybody shares a table about one agent. The fact belongs to the executor: which
 * built-ins it has, which standard tool each one is, and — for a transport that cannot be told about
 * tools one at a time — which coarse switch unlocks which standard subjects. This module is the SHAPE
 * of that declaration and the pure questions asked of one; the declarations themselves sit beside the
 * executors, in `@jaira/runtime`'s `agentTools.ts`.
 *
 * In `shared` because the composer draws a native's name on a tool's line and cannot import the
 * runtime: the service hands it the names, in this shape.
 */

/** How a toolset can reach one agent at all. */
export type AgentToolChannel =
  /** Per tool: a deny list up front, and a permission callback for what is kept (claude). */
  | "tools"
  /** Only coarse switches — a sandbox mode — and nothing per tool (codex). */
  | "switches"
  /** Nothing. A toolset that refuses anything cannot be held to, so such a call is refused. */
  | "none";

export interface AgentToolDeclaration {
  /** How a toolset reaches this agent — see {@link AgentToolChannel}. */
  channel: AgentToolChannel;
  /**
   * The agent's OWN tools, by the name IT calls them, and the standard tool each one is.
   *
   * Several natives may be one standard tool (`Edit`, `MultiEdit` and `NotebookEdit` are all `edit`).
   * `null` says the agent has the tool and no standard tool does that job: it is never removed for
   * want of an entry, and answers to the toolset's `other`.
   *
   * A native NOT listed here is one this declaration has not modelled. Nothing is done about it up
   * front, and a call by it that reaches the permission callback answers to `other` as well.
   */
  natives: Readonly<Record<string, string | null>>;
  /**
   * For a `switches` transport: each switch, and the standard subjects turning it ON unlocks.
   *
   * A switch is left OFF unless the toolset holds one of its subjects with a mode that is not `deny`
   * — codex's `workspace-write` sandbox is on for `write_file`, `edit` or `bash`, and off otherwise.
   */
  switches?: Readonly<Record<string, readonly string[]>>;
}

/** The standard tool a native IS: a name, `null` for "none — it answers to `other`", `undefined` for undeclared. */
export function standardOfNative(declaration: AgentToolDeclaration, native: string): string | null | undefined {
  return Object.hasOwn(declaration.natives, native) ? declaration.natives[native] : undefined;
}

/** Every native that is one standard tool, in declared order. */
export function nativesOfStandard(declaration: AgentToolDeclaration, standard: string): string[] {
  return Object.entries(declaration.natives)
    .filter(([, tool]) => tool === standard)
    .map(([native]) => native);
}

/** The native a person would recognise for a standard tool — the first declared — or `undefined`. */
export function primaryNativeOf(declaration: AgentToolDeclaration, standard: string): string | undefined {
  return nativesOfStandard(declaration, standard)[0];
}

/** The natives with no standard equivalent — the ones that answer to `other`. */
export function unmappedNatives(declaration: AgentToolDeclaration): string[] {
  return Object.entries(declaration.natives)
    .filter(([, tool]) => tool === null)
    .map(([native]) => native);
}

/** Standard tool → the natives it displaces when OUR implementation is injected. */
export function replacementsOf(declaration: AgentToolDeclaration): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [native, tool] of Object.entries(declaration.natives)) {
    if (tool === null) continue;
    (out[tool] ??= []).push(native);
  }
  return out;
}
