/**
 * What the Logs room derives: every row, column and filter `LogsPanel`
 * (`packages/universal/src/components/logs/`) draws. The room is ONE list of what the app did and what
 * went wrong, because its sources answer one question — what happened, and where to look next — and a
 * row's pointers (`taskId`, `jobId`) are what make it useful. One line per entry, newest first; a row
 * unfolds in place, and older pages are asked for as the list is scrolled rather than held in memory.
 */
import {
  LOG_SOURCES,
  type JobOutputChunk,
  type LogEntry,
  type LogLevel,
  type LogOverride,
  type LogPolicy,
  type LogQuery,
} from "@jaira/shared/browser";
import type { LogUnseen } from "./updatesModel";

export const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * What a row is hiding, split: the STACK lifted out and printed as itself, whatever else the detail
 * holds printed beside it as JSON. Nothing at all when the entry carries neither (see `Detail`).
 */
export function detailParts(detail: unknown): { stack?: string; rest?: unknown } {
  if (detail === null || detail === undefined || typeof detail !== "object" || Array.isArray(detail)) {
    return detail === undefined ? {} : { rest: detail };
  }
  const { stack: held, ...others } = detail as Record<string, unknown>;
  return {
    ...(typeof held === "string" ? { stack: held } : {}),
    ...(Object.keys(others).length > 0 ? { rest: others } : {}),
  };
}

/**
 * When it happened, as TWO columns: the date is its own cell and is empty for today. An entry paged in
 * from last Tuesday has to say so, and one column that sometimes carries a date is ragged.
 */
export function stamp(at: number): { day: string; time: string } {
  const when = new Date(at);
  return {
    day: when.toDateString() === new Date().toDateString() ? "" : when.toLocaleDateString(),
    time: when.toLocaleTimeString(),
  };
}

/** A row's identity, across launches: where it sits in its day of the mirror, and when. */
export const keyOf = (entry: LogEntry): string => `${entry.at}-${entry.id}`;

/**
 * Why it went wrong, when the entry says so only in its detail — printed after the message on the row's
 * one line; a message that already carries it is not repeated.
 */
export function reasonOf(entry: LogEntry): string | undefined {
  const detail = entry.detail;
  if (detail === null || detail === undefined || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const said = (detail as Record<string, unknown>)["message"];
  if (typeof said !== "string" || said.trim() === "" || entry.message.includes(said)) return undefined;
  return said;
}

/** A process's captured output, by stream, in the order the streams first printed. */
export function streamsOf(chunks: readonly JobOutputChunk[]): [string, JobOutputChunk[]][] {
  const byStream = new Map<string, JobOutputChunk[]>();
  for (const chunk of chunks) byStream.set(chunk.stream, [...(byStream.get(chunk.stream) ?? []), chunk]);
  return [...byStream.entries()];
}

/** The filters as one value, so the refetch and the next page ask the same question. */
export function logQueryOf(level: LogLevel, source: string, text: string): LogQuery {
  return {
    level,
    ...(source === "" ? {} : { source }),
    ...(text.trim() === "" ? {} : { text: text.trim() }),
  };
}

/** Whether the end of the list is in view — the scroll's cue to ask for the next page. */
export const nearEnd = (scrollTop: number, clientHeight: number, scrollHeight: number): boolean => scrollTop + clientHeight >= scrollHeight - 400;

/** The catalogue, plus whatever is actually in the log — see {@link LOG_SOURCES}. */
export const sourcesOf = (entries: readonly LogEntry[]): string[] => [...new Set([...LOG_SOURCES, ...entries.map((e) => e.source)])].sort();

/** Is any of this from another day? The date column appears when it has something to say. */
export const datedOf = (entries: readonly LogEntry[]): boolean => entries.some((e) => stamp(e.at).day !== "");

/** Sources grouped by their first dot-segment, for the source picker (`SourceSelect`). */
export function sourceGroups(sources: readonly string[]): [string, string[]][] {
  const held = new Map<string, string[]>();
  for (const s of sources) {
    const top = s.includes(".") ? s.slice(0, s.indexOf(".")) : s;
    held.set(top, [...(held.get(top) ?? []), s]);
  }
  return [...held.entries()];
}

/** A rule written by key, so editing a rule replaces it rather than adding a second one nobody can see. */
export const putOverride = (policy: LogPolicy, next: LogOverride): LogPolicy => ({
  ...policy,
  overrides: [...policy.overrides.filter((o) => !(o.match === next.match && o.key === next.key)), next],
});
export const dropOverride = (policy: LogPolicy, o: LogOverride): LogPolicy => ({
  ...policy,
  overrides: policy.overrides.filter((h) => !(h.match === o.match && h.key === o.key)),
});

/**
 * A rule's sampling rate, typed: the rule it makes, or `undefined` when the text is not a rate (the field
 * then keeps what it had).
 */
export function sampledOverride(o: LogOverride, typed: string): LogOverride | undefined {
  const rate = typed === "" ? 1 : Number(typed);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return undefined;
  const { samplingRate: _held, ...rest } = o;
  return rate === 1 ? rest : { ...rest, samplingRate: rate };
}

export interface LogsPanelProps {
  /** The pages fetched so far, newest first. */
  entries: LogEntry[];
  /** Whether anything older exists — the panel asks for it as the list is scrolled. */
  hasOlder: boolean;
  loading: boolean;
  /** Ask the log a different question. The filters are applied where the entries are read. */
  onSearch: (query: LogQuery) => void;
  /** The next page towards the past. */
  onOlder: (query: LogQuery) => void;
  /** What is kept at all, and the control that changes it — see {@link LogPolicy}. */
  policy: LogPolicy;
  onPolicy: (policy: LogPolicy) => void;
  /** The process output being read, when a row opened one. */
  output: { jobId: number; chunks: JobOutputChunk[] } | null;
  onOpenJob: (jobId: number) => void;
  onOpenTask: (taskId: string) => void;
  onClearOutput: () => void;
  /**
   * The errors and warnings not seen yet — Settings' two log items (`logUnseen`): each such entry is
   * marked, the bar counts them, and its Dismiss clears both, as the items' × does elsewhere.
   */
  unseen?: LogUnseen | undefined;
  onDismissUnseen?: (() => void) | undefined;
}
