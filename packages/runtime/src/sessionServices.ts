/**
 * The two session seams a run needs.
 *
 * ⚠️ A run must ALWAYS have these. The engine does not write the transcript — "a run with no session
 * layer composed records nothing, and the transcript stays empty" — so a run without them would have
 * conversations that do not exist, rather than conversations that are merely uncompacted.
 *
 * `records` and `sessions` are ONE store. A conversation's messages ARE its records, so a caller that
 * recorded into one store and read another would report an empty transcript for a run that produced
 * one.
 *
 * ## What used to be here
 *
 * A `SummarizingSessionStore` decorator, which compacted a conversation inside `resolve` once it
 * passed a character budget. Three things retired it:
 *
 *  - **Its motivation was a bug.** Its own header cited a run going 232 → 317 → 1,396 → 3,975 →
 *    10,598 → 21,033 → 42,828 input tokens across seven calls "because `full_history` re-sends the
 *    whole transcript". Those ratios converge on ×2 — the doubling of a preamble that recorded itself
 *    and rendered itself back, not the linear cost of replay. The preamble is gone.
 *  - **It never protected the runs that die.** A standing TODO said so: its `isTurn` guard demanded
 *    `typeof content === "string"`, and an agent's messages carry arrays of parts, so "the
 *    conversations that most need compacting — long agent runs full of tool traffic — are exactly the
 *    ones that never do".
 *  - **It could not know the limit.** `SessionRequest` carries no model and the model is not resolved
 *    at `resolve` time, so the budget was `8_000` CHARACTERS against models with 200k-token windows —
 *    a number picked in the absence of the fact that would make it mean anything. `contextLength` is
 *    on the model catalog, which is the executor's side of the line, and that is where the trigger
 *    belongs.
 */
import type { RecordStore, SessionStore } from "@declarative-ai/exec";
import { MapSessionStore } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";

export interface SessionServicesOptions {
  /** The store to use. Absent ⇒ an in-memory one, which is what a run that keeps nothing wants. */
  inner?: SessionStore<JsonValue>;
}

export function sessionServicesFor(options: SessionServicesOptions = {}): {
  sessions: SessionStore<JsonValue>;
  records: RecordStore;
} {
  const base = options.inner ?? new MapSessionStore();
  return { sessions: base, records: base as unknown as RecordStore };
}
