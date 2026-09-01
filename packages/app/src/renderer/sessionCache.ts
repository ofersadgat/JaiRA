/**
 * What a transcript is cached UNDER, in one place — because it was in three, and they disagreed.
 *
 * `AppState.sessions` is a map from an operation to the conversation it ran. Three pieces of code
 * write a key into it: the panel that reads one, the loader that fetches one, and the invalidation
 * that drops one when the record lands. When two of the three spelled the key differently, a panel
 * opened while a call was in flight froze on whatever the record held mid-call — for the rest of
 * the session. One convention, one module, three call sites importing it.
 *
 * The key is the INSTANCE ID alone since the runs collapse (Identity and Resume §05): a task is one
 * machine, instance ids are durable UUIDs, and a resume continues them — so the id is unique across
 * the task's whole life and there is no second run left to confuse it with.
 */
import type { SessionView } from "@jaira/shared/browser";

/** Where one transcript lives — the instance whose operation ran it. */
export interface SessionAt {
  instanceId: string;
}

export function sessionKey(at: SessionAt): string {
  return String(at.instanceId);
}

/**
 * Forget one operation's transcript — the record it holds has been superseded.
 *
 * Returns the same object when it held nothing — the caller can then skip a state update rather
 * than re-rendering every panel to replace a map with an identical one.
 */
export function withoutSession(
  sessions: Readonly<Record<string, SessionView>>,
  at: SessionAt,
): Readonly<Record<string, SessionView>> {
  const key = sessionKey(at);
  if (sessions[key] === undefined) return sessions;
  const rest = { ...sessions };
  delete rest[key];
  return rest;
}
