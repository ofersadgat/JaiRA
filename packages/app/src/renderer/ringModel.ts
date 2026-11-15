/**
 * The ring round a project's tile and a conversation's row (the activity mockups, 2026-11-14: the person
 * picked round 3, board 11): one segment per thing that is working, waiting on the person, or has
 * stopped since they last looked, each as long as it has been so; and in the middle, how long the
 * oldest thing that wants the person has waited, or, where nothing does, how long the work has run.
 * Pure: `Sidebar.tsx` and `ChatListPanel.tsx` draw it (`StatusRing.tsx`).
 *
 * A segment's LENGTH is its age on a fixed scale ({@link RING_SPAN_MS} is the whole ring), so a glance
 * reads "old" and "new" without reading the number. When the ages add up to more than the ring, every
 * segment is shrunk by the same factor: the order and the proportions still hold, and the number in
 * the middle still says the real age.
 */
import type { LiveTask, ProjectSummary, TaskSummary } from "@jaira/shared/browser";
import { pillKindOf, type PillKind } from "./pillModel";

/** One thing on a ring: what it is, and since when. */
export interface RingItem {
  kind: PillKind;
  since: number;
}

/** One segment, in hundredths of the ring from its top-left, clockwise. */
export interface RingSegment {
  kind: PillKind;
  start: number;
  length: number;
}

export interface Ring {
  segments: RingSegment[];
  /** What the middle says, in the colour of its kind; `null` when nothing is waiting and nothing runs. */
  center: { kind: PillKind; text: string } | null;
  /**
   * The work's clock when the middle tells a wait instead (the mockup's row: `4m` in the ring, `▶ 1:30`
   * at the row's end) — so a conversation that asks while its agent works says both. `null` otherwise.
   */
  also: { kind: "running"; text: string } | null;
  /** All it holds is what finished: a row says so with a ✓ in the middle, where a tile keeps its letters. */
  done: boolean;
  /** Something on it is working: its clock moves by the second. */
  live: boolean;
}

/** The whole ring: thirty minutes. */
export const RING_SPAN_MS = 30 * 60_000;
/** A segment never shorter than this, so a thing that began a second ago is still seen. */
const MIN_LENGTH = 8;
/** The gap between two segments. */
const GAP = 1.5;
/** The order round the ring: what broke, what asks, what stopped, what works, what worked. */
const ORDER: readonly PillKind[] = ["error", "waiting", "warning", "running", "success"];
/** What the middle prefers to tell: a wait the person owes, before work that is merely going on. */
const OWED: ReadonlySet<PillKind> = new Set<PillKind>(["waiting", "error", "warning"]);

export const EMPTY_RING: Ring = { segments: [], center: null, also: null, done: false, live: false };

export function ringOf(items: readonly RingItem[], now: number): Ring {
  if (items.length === 0) return EMPTY_RING;
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.since - b.since);
  const gap = sorted.length > 1 ? GAP : 0;
  const wanted = sorted.map((item) => Math.min(100, Math.max(MIN_LENGTH, ((now - item.since) / RING_SPAN_MS) * 100)));
  const room = 100 - gap * sorted.length;
  const total = wanted.reduce((sum, n) => sum + n, 0);
  const scale = total > room ? room / total : 1;
  let at = 0;
  const segments = sorted.map((item, i) => {
    const segment = { kind: item.kind, start: at, length: wanted[i]! * scale };
    at += segment.length + gap;
    return segment;
  });
  const oldest = (keep: (kind: PillKind) => boolean): RingItem | undefined => sorted.filter((i) => keep(i.kind)).sort((a, b) => a.since - b.since)[0];
  const owed = oldest((kind) => OWED.has(kind));
  const running = oldest((kind) => kind === "running");
  const center = owed !== undefined ? { kind: owed.kind, text: ageText(now - owed.since) } : running !== undefined ? { kind: "running" as const, text: elapsedText(now - running.since) } : null;
  const also = owed !== undefined && running !== undefined ? { kind: "running" as const, text: elapsedText(now - running.since) } : null;
  return { segments, center, also, done: center === null && sorted.every((i) => i.kind === "success"), live: running !== undefined };
}

/** How long something has waited, in what fits a tile: `now`, `4m`, `2h`, `3d`. */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How long work has run, by the second: `0:42`, `6:10`, then `1h05`. */
export function elapsedText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** What a project's ring holds: its live work and parked asks, and what stopped since the person looked. */
export function projectRingItems(summary: Pick<ProjectSummary, "ended"> & { live?: readonly LiveTask[] }, seen: Readonly<Record<string, number>> = {}): RingItem[] {
  const live = summary.live ?? [];
  const items: RingItem[] = live.map((t) => ({ kind: t.kind, since: t.since }));
  // A conversation answering a typed turn is live AND, by its row, ended: it is drawn once, as live.
  const liveIds = new Set(live.map((t) => t.taskId));
  for (const task of summary.ended) {
    if (liveIds.has(task.taskId) || (seen[task.taskId] ?? 0) >= task.updatedAt) continue;
    const kind = pillKindOf(task.status);
    if (kind !== null) items.push({ kind, since: task.updatedAt });
  }
  return items;
}

/**
 * What a conversation's ring holds — at most two things: what it is doing (answering since its last
 * message, or asking the person since they were asked) and, once it has stopped, how it stopped while
 * that is unread. A completed conversation the person has read has an empty ring.
 */
export function chatRingItems(
  task: Pick<TaskSummary, "taskId" | "status" | "updatedAt" | "lastMessageAt">,
  facts: { seen: Readonly<Record<string, number>>; producing: Readonly<Record<string, number>>; askedAt?: number | undefined },
): RingItem[] {
  const items: RingItem[] = [];
  if (facts.askedAt !== undefined) items.push({ kind: "waiting", since: facts.askedAt });
  const answering = task.status === "running" || (facts.producing[task.taskId] ?? 0) > 0;
  if (answering) items.push({ kind: "running", since: task.lastMessageAt ?? task.updatedAt });
  else if ((facts.seen[task.taskId] ?? 0) < task.updatedAt) {
    const kind = pillKindOf(task.status);
    if (kind !== null && kind !== "running" && kind !== "waiting") items.push({ kind, since: task.updatedAt });
  }
  return items;
}

/** When each task asked the person: its oldest open approval or question, by task id. */
export function askedAtOf(requests: ReadonlyArray<{ taskId?: string | undefined; at: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requests) if (r.taskId !== undefined) out[r.taskId] = Math.min(out[r.taskId] ?? Infinity, r.at);
  return out;
}

/** The project rings summed for a group of workspaces: every member's items on the one ring. */
export function groupRingItems(members: ReadonlyArray<Pick<ProjectSummary, "ended"> & { live?: readonly LiveTask[] }>, seen: Readonly<Record<string, number>> = {}): RingItem[] {
  return members.flatMap((m) => projectRingItems(m, seen));
}

/** The ring's accessible words: "failed 12m, asks you 4m, working 2:14". */
export function ringLabel(items: readonly RingItem[], now: number): string {
  const word: Record<PillKind, string> = { running: "working", waiting: "asks you", error: "failed", warning: "stopped", success: "done" };
  return [...items]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.since - b.since)
    .map((i) => `${word[i.kind]} ${i.kind === "running" ? elapsedText(now - i.since) : ageText(now - i.since)}`)
    .join(", ");
}
