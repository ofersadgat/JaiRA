/**
 * The live turn's fold — one function, two holders.
 *
 * The store folds `session:turn` pushes into the tail of the task on screen. A made task's nested
 * conversation (decision 0003) folds the same pushes for ITS task, since the store keeps one tail and
 * it belongs to what is selected. Both must fold identically — main's `LiveTurnLog` is the third
 * copy of the rule, and a tail that disagrees between two viewers of one stream is the bug this
 * module exists to make impossible — so the fold lives here and both call it.
 */
import type { JsonValue } from "@declarative-ai/json";
import { foldWriting, isStreamBookkeeping, startsThinking, type LiveTurnSnapshot, type PushMessage, type WritingTool } from "@jaira/shared/browser";

/** The tail as a viewer holds it — see `AppState.liveTurn` for what each field is. */
export interface LiveTurn {
  sessionId?: string;
  seq?: number;
  stateId?: string;
  n?: number;
  text: string;
  thinking: string;
  textStartedAt?: number;
  thinkingStartedAt?: number;
  entries: JsonValue[];
  sidechains: Record<string, JsonValue[]>;
  writing?: WritingTool;
}

export type SessionTurnPush = Extract<PushMessage, { type: "session:turn" }>;

/** How many entries a tail keeps — the same cap main applies, so the two never disagree about a tail's length. */
export const LIVE_ENTRY_LIMIT = 500;

/** A `session:live` snapshot as a tail, or `null` when nothing is streaming. */
export function liveTurnOfSnapshot(live: LiveTurnSnapshot | null): LiveTurn | null {
  if (live === null) return null;
  return {
    ...(live.sessionId !== undefined ? { sessionId: live.sessionId } : {}),
    ...(live.seq !== undefined ? { seq: live.seq } : {}),
    ...(live.stateId !== undefined ? { stateId: live.stateId } : {}),
    n: live.n,
    text: live.text,
    thinking: live.thinking,
    ...(live.textStartedAt !== undefined ? { textStartedAt: live.textStartedAt } : {}),
    ...(live.thinkingStartedAt !== undefined ? { thinkingStartedAt: live.thinkingStartedAt } : {}),
    entries: live.entries,
    sidechains: live.sidechains,
    ...(live.writing !== undefined ? { writing: live.writing } : {}),
  };
}

/**
 * Whether a seed already AHEAD of a snapshot should be kept: pushes folded in while the snapshot
 * was in flight would be lost by reverting to it, and `n` says which of the two has seen more.
 */
export function tailIsAhead(current: LiveTurn | null, live: LiveTurnSnapshot | null): boolean {
  return live !== null && current !== null && current.sessionId === live.sessionId && current.seq === live.seq && (current.n ?? -1) >= live.n;
}

/**
 * Whether a push is already folded in — the tail was seeded from a snapshot that had seen this
 * delta, and applying it again would show the fragment twice.
 */
export function alreadyFolded(live: LiveTurn | null, message: SessionTurnPush): boolean {
  const same = live !== null && live.sessionId === message.sessionId && live.seq === message.seq;
  return same && message.n !== undefined && live!.n !== undefined && message.n <= live!.n;
}

/**
 * One push folded into the tail.
 *
 * Accumulated per position: a delta is a fragment, and the fragments of one call belong to one
 * answer. A delta for a different position REPLACES rather than appends, because that is a
 * different state speaking and concatenating two would invent a turn neither produced.
 */
export function foldLiveTurn(live: LiveTurn | null, message: SessionTurnPush): LiveTurn {
  const same = live !== null && live.sessionId === message.sessionId && live.seq === message.seq;
  const entries = same ? [...live.entries] : [];
  const sidechains = same ? { ...live.sidechains } : {};
  let text = same ? live.text : "";
  let thinking = same ? live.thinking : "";
  // The tail CLOCKS, kept in step with the tails themselves — set when a tail starts, cleared when
  // the finished turn restarts it. Main folds the identical rule (`LiveTurnLog`); both must agree,
  // because either can be the one holding the tail on screen.
  let textStartedAt = same ? live.textStartedAt : undefined;
  let thinkingStartedAt = same ? live.thinkingStartedAt : undefined;
  let writing = same ? live.writing : undefined;
  if (message.entry !== undefined) {
    // A SUBAGENT's turn accumulates under the call that spawned it and nowhere else — the doorway
    // row renders it there, and folding it into `entries` is the misattribution the tag exists to
    // prevent.
    const entry = message.entry as { kind?: string; role?: string; parentToolUseId?: string };
    if (typeof entry.parentToolUseId === "string") {
      const chain = [...(sidechains[entry.parentToolUseId] ?? []), message.entry];
      sidechains[entry.parentToolUseId] = chain.length > LIVE_ENTRY_LIMIT ? chain.slice(-LIVE_ENTRY_LIMIT) : chain;
    } else {
      // The identical fold main runs (`LiveTurnLog`), on the identical entry: what the bookkeeping
      // SAYS is kept, the event itself is dropped rather than queued behind the cap.
      writing = foldWriting(writing, message.entry);
      if (!isStreamBookkeeping(message.entry)) entries.push(message.entry);
      // A finished assistant turn carries the same text and thinking its deltas streamed — the
      // tails restart so nothing is shown twice, once in the turn and once as the live edge. The
      // half-written call ends with them: it is on that turn now, with a row of its own.
      if (entry.kind === "message" && entry.role === "assistant") {
        text = "";
        thinking = "";
        textStartedAt = undefined;
        thinkingStartedAt = undefined;
        writing = undefined;
      }
    }
  }
  // Stamped from the entry's own `at` where it has one (main enriches every entry), falling back to
  // the arrival clock — a delta with neither is a fragment we can still time.
  const stampedAt = (message.entry as { at?: number } | undefined)?.at ?? Date.now();
  if (message.text !== undefined) {
    if (text.length === 0 && message.text.length > 0) textStartedAt = stampedAt;
    text += message.text;
  }
  if (message.thinking !== undefined) {
    if (thinking.length === 0 && message.thinking.length > 0) thinkingStartedAt = stampedAt;
    thinking += message.thinking;
  }
  // A withheld think streams no text at all, so its start arrives as bookkeeping instead of as a
  // fragment. The identical rule main folds in `LiveTurnLog`.
  if (thinkingStartedAt === undefined && text.length === 0 && message.entry !== undefined && startsThinking(message.entry)) {
    thinkingStartedAt = stampedAt;
  }
  return {
    ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
    ...(message.seq !== undefined ? { seq: message.seq } : {}),
    ...(message.stateId !== undefined ? { stateId: message.stateId } : {}),
    ...(message.n !== undefined ? { n: message.n } : {}),
    text,
    thinking,
    ...(textStartedAt !== undefined ? { textStartedAt } : {}),
    ...(thinkingStartedAt !== undefined ? { thinkingStartedAt } : {}),
    entries: entries.length > LIVE_ENTRY_LIMIT ? entries.slice(-LIVE_ENTRY_LIMIT) : entries,
    sidechains,
    ...(writing !== undefined ? { writing } : {}),
  };
}
