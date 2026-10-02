/**
 * Event notices in the inbox strip — the pure half (decision 0010 §4; the approved mockup's option A).
 *
 * An automation's "tell me" step is a `notify({ text })` call its project's `events` task makes; main
 * keeps the process's notices (`notices:list`) and pushes each new one (`notice:posted`). The strip
 * draws ONE of them, quietly, at its right end after a spacer: the newest the viewer has not read, and
 * "+N" when older unread ones wait behind it. × marks that one read and the next takes its place;
 * opening it marks it read too (opening is looking, SHELL.md §4.3).
 *
 * A notice asks nothing of anyone, so it is NOT counted in "Awaiting you" — the pill keeps meaning
 * "something needs you" ({@link awaitingCount}).
 *
 * Read is per viewer, in the ui state (`JairaUiState.noticesRead`), so a reload or a second window
 * does not bring back what was dismissed.
 */
import type { EventsNotice, JairaUiState } from "@jaira/shared/browser";

/** The notice the strip shows, and how many older unread ones wait behind it. */
export interface ShownNotice {
  notice: EventsNotice;
  /** Unread notices older than the one shown. */
  more: number;
}

/**
 * The unread notices, newest first: not read by this viewer, and from somewhere this window can open
 * (`reachable` — a project it has open, or Shared). A notice from a project closed since would open
 * nothing.
 */
export function unreadNotices(
  notices: readonly EventsNotice[],
  read: Readonly<Record<string, number>>,
  reachable: (project: string) => boolean = () => true,
): EventsNotice[] {
  return notices
    .filter((n) => read[n.id] === undefined && reachable(n.project))
    .sort((a, b) => b.at - a.at);
}

/** The one the strip shows — the newest unread — or none. */
export function noticeToShow(
  notices: readonly EventsNotice[],
  read: Readonly<Record<string, number>>,
  reachable?: (project: string) => boolean,
): ShownNotice | undefined {
  const unread = unreadNotices(notices, read, reachable);
  const notice = unread[0];
  return notice === undefined ? undefined : { notice, more: unread.length - 1 };
}

/**
 * The ui state with `notice` read — and every mark of a notice main no longer holds dropped, so the
 * map never outgrows the backlog. The same object when it was read already.
 */
export function withNoticeRead(ui: JairaUiState, notice: Pick<EventsNotice, "id" | "at">, backlog: readonly Pick<EventsNotice, "id">[]): JairaUiState {
  if (ui.noticesRead[notice.id] !== undefined) return ui;
  const held = new Set(backlog.map((n) => n.id));
  const kept = Object.fromEntries(Object.entries(ui.noticesRead).filter(([id]) => held.has(id)));
  return { ...ui, noticesRead: { ...kept, [notice.id]: notice.at } };
}

/** What "Awaiting you" counts: questions, approvals and gates. Never a notice — it asks nothing. */
export function awaitingCount(inbox: { pending: readonly unknown[]; approvals: readonly unknown[]; questions: readonly unknown[] }): number {
  return inbox.pending.length + inbox.approvals.length + inbox.questions.length;
}

/** `now`, `2 m`, `3 h`, `2 d` — the strip's age: short, because it sits in a 40px line. */
export function noticeAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** The faint data line after the text: `pipeline.failed a1b2c3d · 2 m` — the event, which one, how long ago. */
export function noticeMeta(notice: Pick<EventsNotice, "event" | "ref" | "at">, now: number): string {
  const what = [notice.event, notice.ref].filter((part): part is string => part !== undefined && part.length > 0).join(" ");
  const age = noticeAge(notice.at, now);
  return what.length > 0 ? `${what} · ${age}` : age;
}

/** The item's hover title and label: what it says, who said it, and what a click does. */
export function noticeTitle(notice: Pick<EventsNotice, "text" | "summary" | "key">): string {
  const from = notice.key !== undefined ? `the events task (${notice.key})` : "the events task";
  const what = notice.summary !== undefined ? ` · ${notice.summary}` : "";
  return `${notice.text} — told by ${from}${what}. Opens its conversation at that step.`;
}

/** The "+N" pill's title. */
export function moreTitle(more: number): string {
  return `${more} more unread notice${more === 1 ? "" : "s"} — the events conversation has them all`;
}
