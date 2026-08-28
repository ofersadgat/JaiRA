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
 * different position REPLACES rather than appends (a different state is speaking); a subagent's entry
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
import { foldWriting, isStreamBookkeeping, startsThinking, type LiveTurnSnapshot } from "@jaira/shared";
import type { TurnDelta } from "@jaira/runtime";

/**
 * A snapshot as a PARTIAL record value — the shape streamed into the open row's `result_json`
 * (`SqliteSessionStore.streamPartial`), in the SAME encoding a settled record holds, so every
 * reader parses it unchanged.
 *
 * ONE ARRAY. A record's conversation is `entries`, grown as fragments arrive; there is deliberately
 * no second field holding the in-progress version beside the finished one. That split is what this
 * writer used to produce — `messages`, a parallel `messageTimes`, and a `partial` object — and it
 * made a stopped record the only record in the store shaped differently from every other, because it
 * was the only one this function settled rather than the executor. Two encodings of one conversation
 * is exactly what the entry format replaced ("the encodings had no join").
 *
 * The turn being written RIGHT NOW is an entry like any other, marked `partial` so a reader can tell
 * a fragment from something the model finished saying — and so `messagesOfRecord` can keep it off
 * the wire, because half an assistant turn is not an exchange that can be replayed. Its clocks ride
 * ON it (`timing`), which is what removes the index-aligned array: a shift of one used to label
 * every turn with its neighbour's duration.
 *
 * `startedAt` and `thoughtMs` together recover both stamps the old `partial` object spelled out —
 * the thinking began at `startedAt`, the answer at `startedAt + thoughtMs` — so a partial turn now
 * carries the same timing shape a finished one does rather than its own.
 *
 * Event entries stay out, as they always have: a settled record's event entries come from the agent's
 * own session file at capture, and a partial inventing stream-shaped ones would write entries the
 * settle then replaces with different ones.
 *
 * `null` when nothing recordable has streamed — writing an empty array would overwrite nothing with
 * nothing at a cost.
 */
/** What the live stream knows about who produced a turn: nothing. The settled record uses the same
 *  word for the entries it synthesizes rather than receives (the spliced-in question). */
const LIVE_PROVIDER = "unknown";

/** One streamed entry as a message entry, or `undefined` for anything that is not a finished turn. */
function messageEntry(raw: JsonValue, call: string | undefined): { at?: number; entry: JsonValue } | undefined {
  const rec = raw as { kind?: string; content?: { role?: unknown; content?: JsonValue }; at?: number; startedAt?: number; thoughtMs?: number } | null;
  if (rec === null || typeof rec !== "object" || rec.kind !== "message") return undefined;
  const message = rec.content;
  if (message === null || typeof message !== "object") return undefined;
  // The HOST clock, all of it, on the entry. `timestamp` beside it is the provider's own and is a
  // different fact — a reader that wants "when did this reach us" must not read the provider's.
  const timing = {
    ...(rec.at !== undefined ? { at: rec.at } : {}),
    ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
    ...(rec.thoughtMs !== undefined ? { thoughtMs: rec.thoughtMs } : {}),
  };
  return {
    ...(rec.at !== undefined ? { at: rec.at } : {}),
    entry: {
      kind: "message",
      role: typeof message.role === "string" ? message.role : "assistant",
      content: (message.content ?? "") as JsonValue,
      ...(rec.at !== undefined ? { timestamp: new Date(rec.at).toISOString() } : {}),
      provider: LIVE_PROVIDER,
      ...(Object.keys(timing).length > 0 ? { timing } : {}),
      // Both halves of the subagent fact, which is one fact: this entry belongs to the agent the
      // call spawned. The live log keys a chain by the spawning call, and that id is the agent's.
      ...(call !== undefined ? { sidechain: { id: call, parentToolUseId: call } } : {}),
    } as JsonValue,
  };
}

/**
 * The turn in flight, as the entry it is.
 *
 * Emitted even when both tails are empty, provided the model has STARTED: `thinkingStartedAt` with
 * nothing said yet is the "still thinking" state, and an entry with no content and a `startedAt`
 * says exactly that. It used to be said by a `partial` object existing beside the messages.
 */
function tailEntry(snapshot: LiveTurnSnapshot): JsonValue | undefined {
  if (snapshot.text.length === 0 && snapshot.thinking.length === 0 && snapshot.thinkingStartedAt === undefined) return undefined;
  const content: JsonValue[] = [
    ...(snapshot.thinking.length > 0 ? [{ type: "thinking", thinking: snapshot.thinking } as JsonValue] : []),
    ...(snapshot.text.length > 0 ? [{ type: "text", text: snapshot.text } as JsonValue] : []),
  ];
  const startedAt = snapshot.thinkingStartedAt ?? snapshot.textStartedAt;
  const thoughtMs =
    snapshot.thinkingStartedAt !== undefined && snapshot.textStartedAt !== undefined
      ? Math.max(0, snapshot.textStartedAt - snapshot.thinkingStartedAt)
      : undefined;
  const timing = {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(thoughtMs !== undefined ? { thoughtMs } : {}),
  };
  return {
    kind: "message",
    role: "assistant",
    content,
    // The one thing that must never be lost: this is not a turn anybody finished.
    partial: true,
    provider: LIVE_PROVIDER,
    ...(Object.keys(timing).length > 0 ? { timing } : {}),
  } as JsonValue;
}

export function partialRecordValue(snapshot: LiveTurnSnapshot): JsonValue | null {
  // Main chain and subagents in ONE list, put back into arrival order by the stamp every entry
  // carries. They were two key spaces before, which is the join the entry format exists to remove.
  const streamed: Array<{ at?: number; entry: JsonValue }> = [];
  for (const raw of snapshot.entries) {
    const mapped = messageEntry(raw, undefined);
    if (mapped !== undefined) streamed.push(mapped);
  }
  for (const [call, chain] of Object.entries(snapshot.sidechains)) {
    for (const raw of chain) {
      const mapped = messageEntry(raw, call);
      if (mapped !== undefined) streamed.push(mapped);
    }
  }
  // Stable by arrival. `sort` is stable in every engine this runs on, so entries sharing a stamp keep
  // the order they were folded in — which for a same-millisecond pair is the only order there is.
  streamed.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  const entries = streamed.map((s) => s.entry);
  const tail = tailEntry(snapshot);
  if (tail !== undefined) entries.push(tail);
  if (entries.length === 0) return null;
  return { value: { entries } } as JsonValue;
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
    private readonly flushNow: () => void,
    private readonly intervalMs = 400,
  ) {}

  /** Note that new data exists. Starts the interval timer unless one is already pending. */
  note(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flushNow();
      } catch {
        // Durability is best-effort beside a live stream that is already reaching the viewer — a
        // failed flush must not take the delta path down with it. The next note tries again.
      }
    }, this.intervalMs);
  }

  /**
   * Write what is held RIGHT NOW, and reset the interval.
   *
   * For the one moment the throttle is wrong: somebody pressing stop. The rule below — no final
   * flush, because the settled result supersedes — holds for a call that finishes, and an interrupted
   * one has no settled result to supersede anything: what survives is whatever the last flush wrote,
   * which is up to an interval stale and, for a turn stopped in its first half-second, nothing at
   * all. That is a transcript that loses the words somebody was watching arrive, which is the
   * opposite of what the stream is for.
   *
   * Called BEFORE the abort, so the row is still open and `streamPartial`'s status guard still
   * matches. After it, the record has settled and this writes nothing.
   */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.flushNow();
    } catch {
      // Same rule as the timer path: durability beside a live stream is best-effort.
    }
  }

  /** Stop the timer. No final flush: the run is settling, and the settled result supersedes. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Live entries kept per position — the renderer's own bound, mirrored. */
const LIVE_ENTRY_LIMIT = 500;

interface LiveLog extends LiveTurnSnapshot {
  entries: JsonValue[];
  sidechains: Record<string, JsonValue[]>;
}

/** The provider session id off a stream entry, when the envelope carried one — `session_id` rides on
 *  nearly every line of the agent's stream, forwarded opaquely inside `{kind:"event"}` entries. */
function providerSessionIdOf(entry: JsonValue): string | undefined {
  const rec = entry as { kind?: string; event?: { payload?: { session_id?: unknown }; session_id?: unknown } };
  if (rec === null || typeof rec !== "object" || rec.kind !== "event") return undefined;
  const id = rec.event?.payload?.session_id ?? rec.event?.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export class LiveTurnLog {
  private readonly byTask = new Map<string, LiveLog>();
  /** Per-task delta counters. Kept OUTSIDE the entries so replacement never resets one — the skip
   *  rule (`n` at or below the snapshot's is already folded) only works if `n` never goes back. */
  private readonly counters = new Map<string, number>();

  /**
   * Fold one delta in; returns the `n` the matching push should carry.
   *
   * TIME is stamped here, from the delta's host-clock `at`: every main-thread entry gains `at`
   * (completion — its arrival), and a finished assistant turn additionally gains `startedAt` (its
   * first delta) and `thoughtMs` (thinking start → answer start) — the numbers "thought for Xs"
   * is computed from. Stamped on the ENTRY OBJECT, additively, so the same enriched entry flows to
   * the renderer's push, the snapshot, and the persisted partial without three plumbing paths.
   * Ordering never DEPENDS on the stamps — the stream is sequential and array order is the
   * order — they make it auditable and displayable.
   *
   * Returns the `n` the matching push should carry, and the ENRICHED entry when the delta carried
   * one — the copy bearing the stamps, which is what the push must publish so the renderer sees
   * the same times the snapshot and the persisted partial hold.
   */
  apply(taskId: string, delta: TurnDelta): { n: number; entry?: JsonValue } {
    const n = (this.counters.get(taskId) ?? 0) + 1;
    this.counters.set(taskId, n);
    const at = delta.at ?? Date.now();
    const live = this.byTask.get(taskId);
    // A delta for a different position replaces the entry: a different state is speaking, and
    // concatenating two would invent a turn neither produced. Same rule the renderer applies.
    const same = live !== undefined && live.sessionId === delta.session?.id && live.seq === delta.session?.seq;
    const entry: LiveLog = same
      ? live
      : {
          ...(delta.session !== undefined ? { sessionId: delta.session.id, seq: delta.session.seq } : {}),
          ...(delta.stateId !== undefined ? { stateId: delta.stateId } : {}),
          n,
          text: "",
          thinking: "",
          entries: [],
          sidechains: {},
        };
    entry.n = n;
    let enriched: JsonValue | undefined;
    if (delta.entry !== undefined) {
      const incoming = delta.entry as { kind?: string; role?: string; parentToolUseId?: string };
      const sniffed = providerSessionIdOf(delta.entry);
      if (sniffed !== undefined) entry.providerSessionId = sniffed;
      if (typeof incoming.parentToolUseId === "string") {
        enriched = { ...(delta.entry as object), at } as JsonValue;
        const chain = [...(entry.sidechains[incoming.parentToolUseId] ?? []), enriched];
        entry.sidechains[incoming.parentToolUseId] = chain.length > LIVE_ENTRY_LIMIT ? chain.slice(-LIVE_ENTRY_LIMIT) : chain;
      } else {
        const finished = incoming.kind === "message" && incoming.role === "assistant";
        const startedAt = entry.thinkingStartedAt ?? entry.textStartedAt;
        const thoughtMs =
          finished && entry.thinkingStartedAt !== undefined
            ? Math.max(0, (entry.textStartedAt ?? at) - entry.thinkingStartedAt)
            : undefined;
        enriched = {
          ...(delta.entry as object),
          at,
          ...(finished && startedAt !== undefined ? { startedAt } : {}),
          ...(thoughtMs !== undefined ? { thoughtMs } : {}),
        } as JsonValue;
        // The one thing bookkeeping SAYS is folded here; the event itself is then dropped rather
        // than queued behind the cap — see `isStreamBookkeeping`. Folded before the drop, and before
        // the `finished` reset below, because a fold that runs after the entry is gone runs on
        // nothing.
        const writing = foldWriting(entry.writing, enriched);
        if (writing === undefined) delete entry.writing;
        else entry.writing = writing;
        if (!isStreamBookkeeping(enriched)) {
          entry.entries.push(enriched);
          if (entry.entries.length > LIVE_ENTRY_LIMIT) entry.entries.splice(0, entry.entries.length - LIVE_ENTRY_LIMIT);
        }
        // A finished assistant turn carries the same text and thinking its deltas streamed — the
        // tails restart, and with them the tail clocks. The half-written call goes with them: it is
        // ON that turn now, assembled, with a row of its own.
        if (finished) {
          entry.text = "";
          entry.thinking = "";
          delete entry.textStartedAt;
          delete entry.thinkingStartedAt;
          delete entry.writing;
        } else if (entry.thinkingStartedAt === undefined && entry.text.length === 0 && startsThinking(enriched)) {
          // A WITHHELD think starts the clock here rather than on a `thinking` delta, because it
          // sends none — see `startsThinking`. Only while nothing has been said yet: mid-answer the
          // block has no duration worth a row, and inventing one would report "thought for 0 s"
          // between two halves of a sentence.
          entry.thinkingStartedAt = at;
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
    return { n, ...(enriched !== undefined ? { entry: enriched } : {}) };
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
      entries: [...entry.entries],
      sidechains: Object.fromEntries(Object.entries(entry.sidechains).map(([k, v]) => [k, [...v]])),
      ...(entry.writing !== undefined ? { writing: { ...entry.writing } } : {}),
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
