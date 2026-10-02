/**
 * "Still running" is said only of what IS still running (the person, 2026-09-25: "it is very important
 * that 'still running' is accurate everywhere it appears").
 *
 * Something with no end recorded is one of two facts: it is still happening, or its end was never
 * written (the record went on without it, or stopped). Nothing here infers the first from the absence
 * of the second. What is live is only ever the LAST stretch of a record that is still being written —
 * and whether a record is being written is said by the caller (a chat's task) or by the record's own
 * status, never by what is missing from it. The transcript (`SessionTranscript.tsx`), its rows
 * (`WorkRows.tsx`, with `toolLineOf`), the summary (`WorkSummary.tsx`, with `liveIndexOf` and
 * `currentPhaseOf`), a run's pieces (`RunTranscript.tsx`) and a subagent's page
 * (`SidechainConversation.tsx`) all ask it here.
 */
import type { SessionView } from "@jaira/shared/browser";
import { entriesOf, sidechainEntriesOf, type LiveTail, type TranscriptEntry } from "./transcript";

/** Whether a record is still being written: what the caller says, else the record's own status. */
export function writingOf(working: boolean | undefined, session: Pick<SessionView, "status"> | null | undefined): boolean {
  return working ?? session?.status === "running";
}

/** Whether a block is the one in progress: the last one, of a record still being written. */
export function openBlockOf(writing: boolean, index: number, count: number): boolean {
  return writing && index === count - 1;
}

/**
 * Whether an entry stands in the transcript's last stretch of work: nothing was said after it — no
 * message, no answer being written, no compaction. (`blocksOf`' last block, asked of one entry.)
 */
export function inLastStretch(entries: readonly TranscriptEntry[], index: number): boolean {
  for (let i = index + 1; i < entries.length; i++) {
    const kind = entries[i]!.kind;
    if (kind === "message" || kind === "live" || kind === "compaction") return false;
  }
  return true;
}

/**
 * Whether a piece of a record drawn in parts (`PiecePart`, `entriesOfPart`) holds the record's END. A
 * record cut at a call is drawn as two transcripts over one record: only the one that reaches the last
 * entry can be in progress — the other's work is over, whatever the record's status. A cut whose call
 * is not in the entries yet is taken as the end (as `entriesOfPart` takes it).
 */
export function partHoldsEnd(entries: readonly TranscriptEntry[], part: { after?: string; through?: string } | undefined): boolean {
  if (part?.through === undefined) return true;
  const at = entries.findIndex((entry) => entry.kind === "tool" && entry.callId === part.through);
  return at < 0 || at === entries.length - 1;
}

/** Whether a thought is still being thought: marked live, in the stretch in progress, and not narrated elsewhere. */
export function thoughtLiveOf(entry: { live?: boolean | undefined }, open: boolean, narrated?: boolean | undefined): boolean {
  return entry.live === true && open && narrated !== true;
}

const unanswered = (entry: TranscriptEntry): boolean => entry.kind === "tool" && entry.ok === undefined && entry.result === undefined;

/**
 * Whether a subagent's conversation is still being written: exactly while the call that spawned it is
 * still running — unanswered, in the last stretch of the conversation it was made in, and that
 * conversation itself still being written (the host's record, or the chain a nested call was made in).
 * The same rule a doorway's nested transcript is drawn by (`toolLineOf`'s `running`), asked from the
 * page that stands on the chain. `live` is the host's turn in flight, when it is this record's.
 *
 * A call the record does not hold yet is running only if its chain is streaming by.
 */
export function sidechainWorkingOf(session: SessionView | null, call: string, live: LiveTail | null | undefined, writing: boolean): boolean {
  if (!writing) return false;
  const chains = session?.sidechains ?? {};
  const streaming = live?.sidechains ?? {};
  const seen = new Set<string>();
  /** The call's answer within one conversation and the chains its calls spawned; `undefined`: not made here. */
  const within = (entries: readonly TranscriptEntry[], open: boolean): boolean | undefined => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.kind !== "tool" || entry.callId === undefined) continue;
      const running = open && unanswered(entry) && inLastStretch(entries, i);
      if (entry.callId === call) return running;
      if (seen.has(entry.callId) || (chains[entry.callId] === undefined && streaming[entry.callId] === undefined)) continue;
      seen.add(entry.callId);
      const found = within(sidechainEntriesOf(session, entry.callId, streaming[entry.callId]), running);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return within(entriesOf(session, [], live ?? null), true) ?? streaming[call] !== undefined;
}
