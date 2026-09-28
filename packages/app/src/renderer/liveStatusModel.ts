/**
 * What the live status line says — `transcriptView.tsx`'s `LiveStatusBar` words, and the two
 * formatters it measures with — moved out unchanged so the universal copy (decision 0015) says the same.
 */
import { APPROVAL_PROMPT_FUNCTION, toolDisplayOf } from "@jaira/shared/browser";
import type { LiveStatus } from "./transcript";

/** Bytes as a person reads them — what a size looks like beside a name. */
export function sizeOf(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * How long a model thought, said the way a person waiting would say it — `0.4 seconds`,
 * `12.4 seconds`, `2 m 5.3 s`.
 *
 * Its own formatter rather than {@link durationOf}, which serves run cards and switches units under
 * a second: a thinking block that reports `840 ms` and then `1.2 s` a moment later is a counter that
 * changes shape while you are reading it. Tenths all the way down, so the number only ever grows,
 * and the word spelled out because this is a sentence about a wait, not a figure in a table.
 */
export function thoughtTime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} m`;
  return `${Math.floor(seconds / 60)} m ${(seconds % 60).toFixed(1)} s`;
}

/**
 * The figure at the line's end. Sized, not timed: the question asked of a page being written is how
 * big it is getting; the question asked of everything else is how long it has been.
 */
export function statusFigureOf(status: LiveStatus, elapsed: number | undefined): string | undefined {
  return status.kind === "writing" ? (status.chars > 0 ? sizeOf(status.chars) : undefined) : elapsed !== undefined ? thoughtTime(elapsed) : undefined;
}

/** The verb, present tense — the whole of what the line is for. */
export function verbOf(status: LiveStatus): string {
  if (status.kind === "writing") return "Writing";
  if (status.kind === "answering") return "Answering";
  if (status.kind === "thinking") return "Thinking";
  // The approval prompt is the turn waiting on the PERSON, not on a program.
  if (status.kind === "running") return status.name === APPROVAL_PROMPT_FUNCTION ? "Waiting for you" : "Running";
  return "Working";
}

/** What it is doing it TO, when there is something to name. */
export function whatOf(status: LiveStatus): string {
  if (status.kind === "writing") return status.path ?? toolDisplayOf(status.name).title;
  if (status.kind === "running" && status.name === APPROVAL_PROMPT_FUNCTION) return status.summary.length > 0 ? `to approve · ${status.summary}` : "to approve a command";
  if (status.kind === "running") {
    const title = toolDisplayOf(status.name).title;
    return status.summary.length > 0 ? `${title} · ${status.summary}` : title;
  }
  return "";
}


export { verbOf as statusVerbOf, whatOf as statusWhatOf };
