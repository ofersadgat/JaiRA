/**
 * The ring round a project's tile and a conversation's row (the activity mockups, 2026-11-14: the person
 * picked round 3, board 11): one segment per thing that is working, waiting on the person, or has
 * stopped since they last looked; and in the middle, how long the oldest thing that wants the person has
 * waited, or, where nothing does, how long the work has run. Pure: `Sidebar.tsx` and `ChatListPanel.tsx`
 * draw it (`StatusRing.tsx`).
 *
 * A segment's LENGTH is its SHARE of the time on the ring (the person, 2026-11-15: "each line segment of
 * the ring represent what percent of the total time of all segments it is. this way, if there is only
 * one, it fills the circle"): its age over every segment's age together. One thing fills the ring; a
 * thing much younger than the rest is held at {@link MIN_LENGTH} so it is still seen. The number in the
 * middle says the real age.
 */
import type { LiveTask, ProjectSummary, TaskSummary } from "@jaira/shared/browser";
import { pillKindOf, seenClockOf, type PillKind } from "./pillModel";

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
  /**
   * The colour the middle is filled with, so the whole state reads at a glance (the person, 2026-11-15):
   * the first kind on the ring in {@link TINT_ORDER} — asking (yellow), failed (red), done (green),
   * working (blue). `null` for an empty ring.
   */
  tint: PillKind | null;
  /** Something on it is working: its clock moves by the second. */
  live: boolean;
}

/** A segment, beside others, never shorter than this, so a thing that began a second ago is still seen. */
const MIN_LENGTH = 8;
/** The gap between two segments. */
const GAP = 1.5;
/** The order round the ring: what broke, what asks, what stopped, what works, what worked. */
const ORDER: readonly PillKind[] = ["error", "waiting", "warning", "running", "success"];
/** What the middle prefers to tell: a wait the person owes, before work that is merely going on. */
const OWED: ReadonlySet<PillKind> = new Set<PillKind>(["waiting", "error", "warning"]);
/**
 * Which kind colours the middle, first to last (the person, 2026-11-15: "yellow, red, green, blue"). A
 * run that stopped without failing is the warning yellow, after red: it is owed less than a failure.
 */
export const TINT_ORDER: readonly PillKind[] = ["waiting", "error", "warning", "success", "running"];

export const EMPTY_RING: Ring = { segments: [], center: null, also: null, done: false, tint: null, live: false };

/** Each age's share of `room`, the ones under `floor` raised to it and the rest shrunk to make room. */
function shares(ages: readonly number[], room: number, floor: number): number[] {
  const total = ages.reduce((sum, a) => sum + a, 0);
  const raw = total === 0 ? ages.map(() => room / ages.length) : ages.map((a) => (a / total) * room);
  const small = raw.map((s) => s < floor);
  const smallCount = small.filter(Boolean).length;
  const bigTotal = raw.reduce((sum, s, i) => (small[i] ? sum : sum + s), 0);
  if (smallCount === 0 || bigTotal === 0) return raw;
  const left = room - floor * smallCount;
  return raw.map((s, i) => (small[i] ? floor : (s / bigTotal) * left));
}

export function ringOf(items: readonly RingItem[], now: number): Ring {
  if (items.length === 0) return EMPTY_RING;
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.since - b.since);
  const gap = sorted.length > 1 ? GAP : 0;
  const room = 100 - gap * sorted.length;
  const lengths = shares(
    sorted.map((item) => Math.max(0, now - item.since)),
    room,
    sorted.length > 1 ? Math.min(MIN_LENGTH, room / sorted.length) : 0,
  );
  let at = 0;
  const segments = sorted.map((item, i) => {
    const segment = { kind: item.kind, start: at, length: lengths[i]! };
    at += segment.length + gap;
    return segment;
  });
  const tint = TINT_ORDER.find((kind) => sorted.some((i) => i.kind === kind)) ?? null;
  const oldest = (keep: (kind: PillKind) => boolean): RingItem | undefined => sorted.filter((i) => keep(i.kind)).sort((a, b) => a.since - b.since)[0];
  // The number says the age of what the colour names: the oldest of the tint's kind where that is owed.
  const owed = tint !== null && OWED.has(tint) ? oldest((kind) => kind === tint) : undefined;
  const running = oldest((kind) => kind === "running");
  const center = owed !== undefined ? { kind: owed.kind, text: ageText(now - owed.since) } : running !== undefined ? { kind: "running" as const, text: elapsedText(now - running.since) } : null;
  const also = owed !== undefined && running !== undefined ? { kind: "running" as const, text: elapsedText(now - running.since) } : null;
  return { segments, center, also, done: center === null && sorted.every((i) => i.kind === "success"), tint, live: running !== undefined };
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

/**
 * What a project's ring holds: its live work and parked asks, and what stopped since the person looked
 * — a finish green until it is opened (opening marks it read: `select`, and `SeenWhileShown` while it is on screen).
 */
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
 * that is unread: a reply finished is green until the conversation is opened. Read, the ring is empty.
 */
export function chatRingItems(
  task: Pick<TaskSummary, "taskId" | "status" | "updatedAt" | "lastMessageAt">,
  facts: { seen: Readonly<Record<string, number>>; producing: Readonly<Record<string, number>>; askedAt?: number | undefined },
): RingItem[] {
  const items: RingItem[] = [];
  if (facts.askedAt !== undefined) items.push({ kind: "waiting", since: facts.askedAt });
  const answering = task.status === "running" || (facts.producing[task.taskId] ?? 0) > 0;
  const clock = seenClockOf(task);
  if (answering) items.push({ kind: "running", since: task.lastMessageAt ?? task.updatedAt });
  else if ((facts.seen[task.taskId] ?? 0) < clock) {
    const kind = pillKindOf(task.status);
    if (kind !== null && kind !== "running" && kind !== "waiting") items.push({ kind, since: clock });
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
