/**
 * What the sync panel knows before it renders anything: which side has moved, and how to say so.
 *
 * Split out of the panel because two of these answers are load-bearing and neither is obvious.
 *
 * **Unsaved edits count as changes.** The baseline is recorded against files on disk, so main can
 * only compare against what has been saved. The document in front of you may have an hour of typing
 * in it that no file has seen, and a panel reporting "in step" over it would be reading a different
 * document than the person is. A dirty draft therefore means the description has changed — which is
 * sound whichever way the saved file sits: if the file already differs from the baseline the answer
 * was yes anyway, and if it matched, the draft no longer does.
 *
 * **Both sides changed is not a direction.** When the description and the workflows have both moved,
 * nothing here can say which of them is now the truth, and guessing would overwrite whichever one it
 * guessed against. `suggested` is null, both buttons are offered evenly, and the sentence says why.
 */
import type { SyncDirection, WorkflowSyncStatus } from "@jaira/shared/browser";

export interface SyncDrift {
  documentChanged: boolean;
  statesChanged: boolean;
  /** The side a sync should rewrite, or null when there is nothing to recommend. */
  suggested: SyncDirection | null;
  /** How many state files differ from the baseline. */
  changedStates: number;
}

/** The drift as the panel sees it: main's answer, plus the edits that have not been saved. */
export function driftOf(status: WorkflowSyncStatus | null, dirty: boolean): SyncDrift {
  if (status === null) return { documentChanged: dirty, statesChanged: false, suggested: null, changedStates: 0 };
  const documentChanged = status.documentChanged || dirty;
  const statesChanged = status.statesChanged;
  return {
    documentChanged,
    statesChanged,
    // Recomputed rather than taken from the status, because the unsaved draft may have just made
    // this a two-sided disagreement — and the recommendation has to change with it. With no
    // baseline there is nothing to recommend at all: `documentChanged` is then only "you have typed
    // something", which says nothing about whether the workflows agree with it.
    suggested:
      !status.synced || documentChanged === statesChanged ? null : documentChanged ? "states" : "document",
    changedStates: status.changedStates.length,
  };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The status line, in one sentence.
 *
 * Written out per case rather than assembled from fragments: these are the four states someone acts
 * on, the difference between "the document is stale" and "the workflows are" decides which button
 * they press, and a sentence stitched together from clauses is exactly how that distinction ends up
 * phrased so evenly that nobody reads it.
 */
export function syncSentence(status: WorkflowSyncStatus | null, drift: SyncDrift): string {
  if (status === null) return "Checking…";
  if (status.blocked !== undefined) return status.blocked;
  if (!status.synced) {
    return drift.documentChanged
      ? "These have never been synced, and the description has unsaved edits. Choose which one is right."
      : "These have never been synced, so there is no baseline to say which one has moved. Choose which one is right.";
  }
  if (drift.documentChanged && drift.statesChanged) {
    return `Both have changed since the last sync — the description, and ${plural(drift.changedStates, "workflow file")}. Only you can say which is right.`;
  }
  if (drift.documentChanged) return "The description has changed since the last sync; the workflows have not.";
  if (drift.statesChanged) {
    return `${plural(drift.changedStates, "workflow file")} changed since the last sync; the description has not.`;
  }
  return "The description and the workflows are in step.";
}

/** What each button does, in the words of what ends up different afterwards. */
export const SYNC_LABEL: Record<SyncDirection, string> = {
  document: "Rewrite the description",
  states: "Propose workflow changes",
};

/** The subtitle under each button — where the change comes FROM. */
export const SYNC_HINT: Record<SyncDirection, string> = {
  document: "from the workflows as they are",
  states: "from what the description asks for",
};

/** "3 minutes ago", for the last-synced line. Coarse on purpose: nobody needs the seconds. */
export function agoOf(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}
