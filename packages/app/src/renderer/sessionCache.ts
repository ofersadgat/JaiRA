/**
 * What a transcript is cached UNDER, in one place — because it was in three, and they disagreed.
 *
 * `AppState.sessions` is a map from an operation to the conversation it ran. Three pieces of code
 * wrote a key into it: the panel that reads one, the loader that fetches one, and the invalidation
 * that drops one when the record lands. The first two agreed on `runId:instanceId`; the third used
 * the bare instance id. So the invalidation matched nothing on the view that matters, and a panel
 * opened while a call was in flight was frozen on whatever the record held mid-call — for the rest
 * of the session. Watch a workflow run, and every state you looked at kept the half transcript it
 * had when you arrived, with the interrupted marker under it, while the finished answer sat in the
 * database unread.
 *
 * One convention, one module, three call sites importing it. A key that only exists here cannot be
 * spelled two ways.
 */
import type { SessionView } from "@jaira/shared/browser";

/** Where one transcript lives — a run and an instance, or an instance alone. See {@link sessionKey}. */
export interface SessionAt {
  runId?: number;
  instanceId: string;
}

/**
 * Run and instance, never the instance alone.
 *
 * Instance ids are durable UUIDs now, so two runs can no longer mint the same one — but the RECORD
 * a transcript is read from is still filed per run, and legacy journals still hold counter ids that
 * do repeat across runs. The pair stays the key until sessions stop being run-scoped (Identity and
 * Resume §07 step 3). A single-run projection stamps no run, and then the id alone is the whole key
 * because there is only one run to confuse it with.
 */
export function sessionKey(at: SessionAt): string {
  return at.runId === undefined ? String(at.instanceId) : `${at.runId}:${at.instanceId}`;
}

/**
 * Forget one operation's transcript — the record it holds has been superseded.
 *
 * BOTH spellings of the key, because a cache filled by a task-level projection and one filled by a
 * single-run projection are the same cache, and the event that invalidates an entry knows the run
 * whether or not the entry was filed under it. Dropping only the form the caller happens to think in
 * is exactly the bug this module exists to end.
 *
 * Returns the same object when it held neither — the caller can then skip a state update rather than
 * re-rendering every panel to replace a map with an identical one.
 */
export function withoutSession(
  sessions: Readonly<Record<string, SessionView>>,
  at: SessionAt,
): Readonly<Record<string, SessionView>> {
  const keys = new Set([String(at.instanceId), sessionKey(at)]);
  if (![...keys].some((key) => sessions[key] !== undefined)) return sessions;
  const rest = { ...sessions };
  for (const key of keys) delete rest[key];
  return rest;
}
