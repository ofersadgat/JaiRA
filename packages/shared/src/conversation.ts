/**
 * Conversation-mode document queries (DESIGN §14 phase 7).
 *
 * A state's `environment.conversation.mode` decides how much history its call
 * carries. Two layers need to read it — the runtime, to install the summarizer,
 * and the workflow browser, to lint a contradictory declaration — so the query
 * lives here rather than in either. It reads authored state files as plain JSON
 * and depends on no engine types.
 *
 * ## Only DECLARED sessions are grouped (DESIGN.md §7.3)
 *
 * There is no implicit `"default"` session any more. A state that declares none gets
 * its own stream, which nothing else writes to — so it has no one to conflict with,
 * and compacting it would compact a single operation's exchange. Both of the things
 * this query exists for are therefore questions about NAMED sessions, and an
 * undeclared state is skipped rather than bucketed under a fallback name.
 *
 * That is also why the old fallback was worth removing rather than renaming: it made
 * every undeclared state in a project look like one shared conversation, which is both
 * a false conflict report and the thing that drove unbounded context growth.
 */

export interface ConversationModes {
  /** Named sessions with at least one state declaring `mode: "summary"`. */
  sessions: Set<string>;
  /**
   * Sessions declaring both `summary` and `full_history`. One session has one
   * transcript, so those states cannot both be honoured — an authoring conflict
   * worth reporting rather than resolving silently.
   */
  conflicts: Array<{ session: string; stateIds: string[] }>;
}

interface EnvironmentShape {
  /** A name, a session ref, `null` (explicitly fresh), or absent. Only a NAME groups. */
  session?: string | null | { id: string };
  conversation?: { mode?: string };
}

/**
 * Read the authored conversation modes out of a map of state files (a bundle's
 * `source`, or raw parsed files).
 *
 * Deliberately a document query: whether a session is summarized is the author's
 * decision, not a runtime heuristic.
 *
 * A session supplied as a REF rather than a name is invisible here, and has to be —
 * it is a runtime value, so which states share it cannot be told from the document.
 * DESIGN §7.3 records the direction that resolves it: make conversation mode a
 * property of the session rather than of the state, and the conflict stops being a
 * static question at all.
 */
export function conversationModesOf(states: Record<string, unknown>): ConversationModes {
  const summary = new Map<string, string[]>();
  const full = new Map<string, string[]>();
  for (const [stateId, def] of Object.entries(states)) {
    if (def === null || typeof def !== "object") continue;
    const env = (def as { environment?: EnvironmentShape }).environment;
    const mode = env?.conversation?.mode;
    if (mode !== "summary" && mode !== "full_history") continue;
    const session = env?.session;
    // A private stream (`null`, absent) or a runtime ref groups with nothing.
    if (typeof session !== "string" || session === "") continue;
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
