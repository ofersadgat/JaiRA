/**
 * Main's copy of the LIVE TURN — the conversation a run is streaming right now, held where
 * navigation cannot lose it.
 *
 * The record lands only when the operation settles, so while a call is in flight the delta stream
 * is the only holder of its conversation. The renderer accumulates it into `liveTurn` — and wiped
 * it on every navigation, so leaving a watched run and coming back found the tail gone and the
 * stored view honestly empty ("this state ran no model call"). This log is the same accumulation,
 * one instance per task, fed at the same point the pushes are published and served back over
 * `session:live` whenever a viewer (re)builds its state.
 *
 * The SEMANTICS mirror the renderer's exactly, deliberately: one live entry per task; a delta for a
 * different position REPLACES rather than appends (a different state is speaking); a subagent's item
 * accumulates under the call that spawned it; a finished assistant turn restarts the text tails
 * (the turn now carries what the deltas streamed). A snapshot therefore equals what a
 * from-the-start watcher would be holding.
 *
 * `n` is the merge protocol. Every applied delta gets the next value of a PER-TASK counter that
 * never resets, the pushes carry it, and a snapshot reports the count folded in — so a viewer that
 * seeds from a snapshot skips every push with `n` at or below it and applies the rest, and no
 * fragment is ever shown twice or dropped in the seam between fetch and subscribe.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { LiveTurnSnapshot } from "@jaira/shared";
import type { TurnDelta } from "@jaira/runtime";

/**
 * A snapshot as a PARTIAL record value — the shape streamed into the open row's `result_json`
 * (`SqliteSessionStore.streamPartial`), matching what a settled record holds so `projectValue` and
 * every message reader parse it unchanged.
 *
 * Only finished turns travel: a `{kind:"message"}` item's `content` IS the provider's own message
 * object, so the mapping is a projection, not a translation. The text/thinking TAILS stay behind on
 * purpose — they are fragments of a turn that does not exist yet, and a record must never hold a
 * message nobody finished saying. Event items likewise: the settled record carries provider events
 * on their own channel, and a partial that invented one would just be wrong earlier.
 *
 * `null` when nothing recordable has streamed — a tail of pure text fragments has no turns to
 * persist, and writing `{messages: []}` would overwrite nothing with nothing at a cost.
 */
export function partialRecordValue(snapshot: LiveTurnSnapshot): JsonValue | null {
  const contentOf = (item: JsonValue): JsonValue | undefined => {
    const rec = item as { kind?: string; content?: JsonValue };
    return rec !== null && typeof rec === "object" && rec.kind === "message" ? (rec.content ?? undefined) : undefined;
  };
  const main = snapshot.items.filter((item) => contentOf(item) !== undefined);
  const messages = main.map((item) => contentOf(item)!);
  // The stamps, in a PARALLEL array rather than inside the messages: `messages` is the provider's
  // log verbatim, and injecting host fields into it would poison exactly the bytes a replay sends
  // back. Aligned by index, which holds because both are mapped from the same filtered list.
  const times = main.map((item) => {
    const rec = item as { at?: number; startedAt?: number; thoughtMs?: number };
    return {
      ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
      ...(rec.at !== undefined ? { at: rec.at } : {}),
      ...(rec.thoughtMs !== undefined ? { thoughtMs: rec.thoughtMs } : {}),
    };
  });
  const sidechains: Record<string, JsonValue[]> = {};
  for (const [call, items] of Object.entries(snapshot.sidechains)) {
    const turns = items.map(contentOf).filter((m): m is JsonValue => m !== undefined);
    if (turns.length > 0) sidechains[call] = turns;
  }
  // The TAILS ride in their own labeled field, never as a message: a fragment of a turn nobody
  // finished must stay distinguishable from a turn — but it is exactly what a crash was holding
  // when it died, `thinkingStartedAt` with an empty text tail IS the "still thinking" state, and
  // the viewer renders it as the trailing partial it was.
  const partial =
    snapshot.text.length > 0 || snapshot.thinking.length > 0
      ? {
          ...(snapshot.text.length > 0 ? { text: snapshot.text } : {}),
          ...(snapshot.thinking.length > 0 ? { thinking: snapshot.thinking } : {}),
          ...(snapshot.textStartedAt !== undefined ? { textStartedAt: snapshot.textStartedAt } : {}),
          ...(snapshot.thinkingStartedAt !== undefined ? { thinkingStartedAt: snapshot.thinkingStartedAt } : {}),
        }
      : undefined;
  if (messages.length === 0 && Object.keys(sidechains).length === 0 && partial === undefined) return null;
  return {
    value: {
      messages,
      ...(times.some((t) => Object.keys(t).length > 0) ? { messageTimes: times } : {}),
      ...(Object.keys(sidechains).length > 0 ? { sidechains } : {}),
      ...(partial !== undefined ? { partial } : {}),
    },
  } as JsonValue;
}

/**
 * The debounce between the delta stream and the database — at most one write per interval, however
 * chatty the stream.
 *
 * A THROTTLE rather than a trailing debounce, deliberately: a delta stream under load never goes
 * quiet, and a debounce that reschedules on every event would starve the flush exactly when there
 * is most to save. `better-sqlite3` is synchronous on the main thread (the same fact that shapes
 * `JobOutputSink`), so the interval is what bounds the UI cost of durability.
 *
 * The flush callback is trusted to be a no-op when there is nothing to write — a timer that fires
 * after the record settled matches no open row and writes nothing (`streamPartial`'s status guard).
 */
export class LiveTurnFlusher {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly flush: () => void,
    private readonly intervalMs = 400,
  ) {}

  /** Note that new data exists. Starts the interval timer unless one is already pending. */
  note(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch {
        // Durability is best-effort beside a live stream that is already reaching the viewer — a
        // failed flush must not take the delta path down with it. The next note tries again.
      }
    }, this.intervalMs);
  }

  /** Stop the timer. No final flush: the run is settling, and the settled result supersedes. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Live stream items kept per position — the renderer's own bound, mirrored. */
const LIVE_ITEM_LIMIT = 500;

interface Entry extends LiveTurnSnapshot {
  items: JsonValue[];
  sidechains: Record<string, JsonValue[]>;
}

/** The provider session id off a stream item, when the envelope carried one — `session_id` rides on
 *  nearly every line of the agent's stream, forwarded opaquely inside `{kind:"event"}` items. */
function providerSessionIdOf(item: JsonValue): string | undefined {
  const rec = item as { kind?: string; event?: { payload?: { session_id?: unknown }; session_id?: unknown } };
  if (rec === null || typeof rec !== "object" || rec.kind !== "event") return undefined;
  const id = rec.event?.payload?.session_id ?? rec.event?.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export class LiveTurnLog {
  private readonly byTask = new Map<string, Entry>();
  /** Per-task delta counters. Kept OUTSIDE the entries so replacement never resets one — the skip
   *  rule (`n` at or below the snapshot's is already folded) only works if `n` never goes back. */
  private readonly counters = new Map<string, number>();

  /**
   * Fold one delta in; returns the `n` the matching push should carry.
   *
   * TIME is stamped here, from the delta's host-clock `at`: every main-thread item gains `at`
   * (completion — its arrival), and a finished assistant turn additionally gains `startedAt` (its
   * first delta) and `thoughtMs` (thinking start → answer start) — the numbers "thought for Xs"
   * is computed from. Stamped on the ITEM OBJECT, additively, so the same enriched item flows to
   * the renderer's push, the snapshot, and the persisted partial without three plumbing paths.
   * Ordering never DEPENDS on the stamps — the stream is sequential and array order is the
   * order — they make it auditable and displayable.
   *
   * Returns the `n` the matching push should carry, and the ENRICHED item when the delta carried
   * one — the copy bearing the stamps, which is what the push must publish so the renderer sees
   * the same times the snapshot and the persisted partial hold.
   */
  apply(taskId: string, delta: TurnDelta): { n: number; item?: JsonValue } {
    const n = (this.counters.get(taskId) ?? 0) + 1;
    this.counters.set(taskId, n);
    const at = delta.at ?? Date.now();
    const live = this.byTask.get(taskId);
    // A delta for a different position replaces the entry: a different state is speaking, and
    // concatenating two would invent a turn neither produced. Same rule the renderer applies.
    const same = live !== undefined && live.sessionId === delta.session?.id && live.seq === delta.session?.seq;
    const entry: Entry = same
      ? live
      : {
          ...(delta.session !== undefined ? { sessionId: delta.session.id, seq: delta.session.seq } : {}),
          ...(delta.stateId !== undefined ? { stateId: delta.stateId } : {}),
          n,
          text: "",
          thinking: "",
          items: [],
          sidechains: {},
        };
    entry.n = n;
    let enriched: JsonValue | undefined;
    if (delta.item !== undefined) {
      const item = delta.item as { kind?: string; role?: string; parentToolUseId?: string };
      const sniffed = providerSessionIdOf(delta.item);
      if (sniffed !== undefined) entry.providerSessionId = sniffed;
      if (typeof item.parentToolUseId === "string") {
        enriched = { ...(delta.item as object), at } as JsonValue;
        const chain = [...(entry.sidechains[item.parentToolUseId] ?? []), enriched];
        entry.sidechains[item.parentToolUseId] = chain.length > LIVE_ITEM_LIMIT ? chain.slice(-LIVE_ITEM_LIMIT) : chain;
      } else {
        const finished = item.kind === "message" && item.role === "assistant";
        const startedAt = entry.thinkingStartedAt ?? entry.textStartedAt;
        const thoughtMs =
          finished && entry.thinkingStartedAt !== undefined
            ? Math.max(0, (entry.textStartedAt ?? at) - entry.thinkingStartedAt)
            : undefined;
        enriched = {
          ...(delta.item as object),
          at,
          ...(finished && startedAt !== undefined ? { startedAt } : {}),
          ...(thoughtMs !== undefined ? { thoughtMs } : {}),
        } as JsonValue;
        entry.items.push(enriched);
        if (entry.items.length > LIVE_ITEM_LIMIT) entry.items.splice(0, entry.items.length - LIVE_ITEM_LIMIT);
        // A finished assistant turn carries the same text and thinking its deltas streamed — the
        // tails restart, and with them the tail clocks.
        if (finished) {
          entry.text = "";
          entry.thinking = "";
          delete entry.textStartedAt;
          delete entry.thinkingStartedAt;
        }
      }
    }
    if (delta.text !== undefined) {
      if (entry.text.length === 0 && delta.text.length > 0) entry.textStartedAt = at;
      entry.text += delta.text;
    }
    if (delta.thinking !== undefined) {
      if (entry.thinking.length === 0 && delta.thinking.length > 0) entry.thinkingStartedAt = at;
      entry.thinking += delta.thinking;
    }
    this.byTask.set(taskId, entry);
    return { n, ...(enriched !== undefined ? { item: enriched } : {}) };
  }

  /** The live turn for one task, if a call is streaming. A COPY — the log keeps mutating. */
  snapshot(taskId: string): LiveTurnSnapshot | null {
    const entry = this.byTask.get(taskId);
    if (entry === undefined) return null;
    return {
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
      ...(entry.stateId !== undefined ? { stateId: entry.stateId } : {}),
      ...(entry.providerSessionId !== undefined ? { providerSessionId: entry.providerSessionId } : {}),
      ...(entry.textStartedAt !== undefined ? { textStartedAt: entry.textStartedAt } : {}),
      ...(entry.thinkingStartedAt !== undefined ? { thinkingStartedAt: entry.thinkingStartedAt } : {}),
      n: entry.n,
      text: entry.text,
      thinking: entry.thinking,
      items: [...entry.items],
      sidechains: Object.fromEntries(Object.entries(entry.sidechains).map(([k, v]) => [k, [...v]])),
    };
  }

  /**
   * Drop a task's live turn — the record has landed (operation settled) or the run is over, and the
   * stored view now holds what the tail held. The counter deliberately survives, so a viewer holding
   * the old tail still skips stale pushes.
   */
  clear(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /** Forget the task entirely — run finished and settled; nothing more will stream. */
  drop(taskId: string): void {
    this.byTask.delete(taskId);
    this.counters.delete(taskId);
  }
}
