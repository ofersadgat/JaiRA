/**
 * Conversation-mode document queries (DESIGN §14 phase 7).
 *
 * A state's `environment.conversation.mode` decides how much history its call
 * carries. Two layers need to read it — the runtime, to install the summarizer,
 * and the workflow browser, to lint a contradictory declaration — so the query
 * lives here rather than in either. It reads authored state files as plain JSON
 * and depends on no engine types.
 */

/** The session a state runs under when it declares none (the engine's own default). */
export const DEFAULT_SESSION = "default";

export interface ConversationModes {
  /** Sessions with at least one state declaring `mode: "summary"`. */
  sessions: Set<string>;
  /**
   * Sessions declaring both `summary` and `full_history`. One session has one
   * transcript, so those states cannot both be honoured — an authoring conflict
   * worth reporting rather than resolving silently.
   */
  conflicts: Array<{ session: string; stateIds: string[] }>;
}

interface EnvironmentShape {
  session?: string;
  conversation?: { mode?: string };
}

/**
 * Read the authored conversation modes out of a map of state files (a bundle's
 * `source`, or raw parsed files).
 *
 * Deliberately a document query: whether a session is summarized is the author's
 * decision, not a runtime heuristic.
 */
export function conversationModesOf(states: Record<string, unknown>): ConversationModes {
  const summary = new Map<string, string[]>();
  const full = new Map<string, string[]>();
  for (const [stateId, def] of Object.entries(states)) {
    if (def === null || typeof def !== "object") continue;
    const env = (def as { environment?: EnvironmentShape }).environment;
    const mode = env?.conversation?.mode;
    if (mode !== "summary" && mode !== "full_history") continue;
    const session = env?.session ?? DEFAULT_SESSION;
    const bucket = mode === "summary" ? summary : full;
    bucket.set(session, [...(bucket.get(session) ?? []), stateId]);
  }
  const conflicts: ConversationModes["conflicts"] = [];
  for (const [session, states] of summary) {
    const other = full.get(session);
    if (other) conflicts.push({ session, stateIds: [...states, ...other].sort() });
  }
  return { sessions: new Set(summary.keys()), conflicts };
}
