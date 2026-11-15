/**
 * What the conversation list says about each row — `ChatListPanel`'s rules, pure: which rows, in what
 * order, which dot, what the right edge says, and what a row's menu offers.
 */
import type { TaskSummary } from "@jaira/shared/browser";
import type { AskSpec, MenuItem } from "./menuTypes";

export type ChatRow = TaskSummary & { project?: string };

/** Newest message first, filtered by a title search — a conversation you are having is one you had a moment ago. */
export function shownConversations<T extends ChatRow>(conversations: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  const list = [...conversations].sort((a, b) => whenOf(b, "message") - whenOf(a, "message"));
  return needle === "" ? list : list.filter((t) => t.title.toLowerCase().includes(needle));
}

/**
 * Whether the newest thing this conversation said has been read.
 *
 * Compared against the row's own `updatedAt` rather than held as a flag, which is what makes it
 * self-clearing: a thread marked read stops being read the moment the agent says something else,
 * and nothing has to notice that and go clear anything. See {@link JairaUiState.seen}.
 */
export function isUnread(task: TaskSummary, seen: Readonly<Record<string, number>>): boolean {
  return (seen[task.taskId] ?? 0) < task.updatedAt;
}

/**
 * Whether it is producing something RIGHT NOW.
 *
 * Two sources, because there are two ways a conversation speaks and only one of them is a run. The
 * opening message IS the run, so it moves the task's status; every message after it is a typed
 * turn, which deliberately moves nothing (`runChatMessage`) and is visible only in the journal.
 */
export function isAnswering(task: TaskSummary, producing: Readonly<Record<string, number>>): boolean {
  return task.status === "running" || (producing[task.taskId] ?? 0) > 0;
}

/** A fork's tooltip on its title: where it came from. */
export function forkTitleOf(task: TaskSummary): string | undefined {
  return task.origin !== undefined ? `forked from ${task.origin.title ?? "a task since deleted"}, ${task.origin.label}` : undefined;
}

/** How much work stands under a conversation that controls some (decision 0005): the count, and its tooltip. */
export function controlsOf(task: TaskSummary): { label: string; title: string } | undefined {
  const n = task.controls ?? 0;
  if (n <= 0) return undefined;
  return { label: `${n} ${n === 1 ? "task" : "tasks"}`, title: `${n} ${n === 1 ? "task stands" : "tasks stand"} under this conversation` };
}

/** What the list says when it has no rows. */
export const emptyListText = (query: string): string => (query === "" ? "No conversations yet." : "Nothing matches.");

/** `4 min`, `2 h`, `3 d` — a list of times, not a list of dates. */
export function agoOf(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/**
 * Which moment the list's When column says, and sorts and groups by (the person, 2026-11-12: "It should
 * list the time of the last message, not creation time"): the conversation's last message, or when it
 * was made. Chosen by a press and hold (or a right-click) on the column's head.
 */
export const CHAT_WHENS = ["message", "created"] as const;
export type ChatWhen = (typeof CHAT_WHENS)[number];
export const CHAT_WHEN_LABELS: Record<ChatWhen, string> = { message: "Last message", created: "Created" };
/** What the column head says of each: "Last message" does not fit beside Name and the group menu in a panel of the default width. */
export const CHAT_WHEN_SHORT: Record<ChatWhen, string> = { message: "Latest", created: "Created" };
/** Where the choice is kept, in `modes`. */
export const CHAT_WHEN_MODE = "chat.list.when";

/**
 * A row's moment by the chosen field. The last message is the newest call's (`TaskSummary.lastMessageAt`);
 * a conversation that has made none yet (being placed, waiting for room) has only its making, and the
 * row's own clock stands in for a summary that says neither.
 */
export function whenOf(row: Pick<TaskSummary, "createdAt" | "updatedAt" | "lastMessageAt">, when: ChatWhen): number {
  const created = Date.parse(row.createdAt);
  const made = Number.isFinite(created) ? created : row.updatedAt;
  return when === "created" ? made : (row.lastMessageAt ?? made);
}

/** What the list's column head groups by (the sidebar mockups, board 24): nothing, the day, how it stands, or where it runs. */
export const CHAT_GROUPS = ["none", "day", "status", "workspace"] as const;
export type ChatGroup = (typeof CHAT_GROUPS)[number];
export const CHAT_GROUP_LABELS: Record<ChatGroup, string> = { none: "Nothing", day: "Day", status: "Status", workspace: "Workspace" };
/** What it sorts by, and which way: the column head's Name and When, pressed again to turn them round. */
export const CHAT_SORTS = ["when-desc", "when-asc", "name-asc", "name-desc"] as const;
export type ChatSort = (typeof CHAT_SORTS)[number];

export interface ChatSection<T> {
  key: string;
  /** Empty when the list is not grouped: one section, drawn without a head. */
  label: string;
  rows: T[];
}

const DAY_ORDER = ["Today", "Yesterday", "This week", "Older"] as const;
const STATUS_ORDER = ["Answering", "Unread", "Read"] as const;

/** The day a moment falls in, as the list's groups name it. */
export function dayOf(at: number, now: number = Date.now()): (typeof DAY_ORDER)[number] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (at >= start) return "Today";
  if (at >= start - 86_400_000) return "Yesterday";
  if (at >= start - 6 * 86_400_000) return "This week";
  return "Older";
}

/**
 * The rows as the column head arranges them: sorted, then cut into groups in a fixed order (days
 * newest first, Answering before Unread before Read, the project's own workspace before the others).
 * `placeOf` names a row's workspace where it is not the project's first (`ChatSurface.places`);
 * `home` names that first one.
 */
export function arrangeConversations<T extends ChatRow>(
  rows: readonly T[],
  how: { group: ChatGroup; sort: ChatSort; when?: ChatWhen },
  facts: { seen: Readonly<Record<string, number>>; producing: Readonly<Record<string, number>>; placeOf: (row: T) => string | undefined; home: string; now?: number; pinned?: ReadonlySet<string> },
): ChatSection<T>[] {
  const [by, way] = how.sort.split("-") as ["when" | "name", "asc" | "desc"];
  const when = how.when ?? "message";
  const sign = way === "asc" ? 1 : -1;
  const all = [...rows].sort((a, b) => sign * (by === "name" ? a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) : whenOf(a, when) - whenOf(b, when)));
  // Pinned rows stand in a section of their own, first, whatever the grouping (board 28).
  const pinned = facts.pinned === undefined ? [] : all.filter((r) => facts.pinned!.has(r.taskId));
  const sorted = pinned.length === 0 ? all : all.filter((r) => !facts.pinned!.has(r.taskId));
  const top: ChatSection<T>[] = pinned.length === 0 ? [] : [{ key: "pinned", label: "Pinned", rows: pinned }];
  if (how.group === "none") return sorted.length === 0 ? top : [...top, { key: "all", label: top.length === 0 ? "" : "Recent", rows: sorted }];
  return [...top, ...groupedConversations(sorted, how.group, when, facts)];
}

function groupedConversations<T extends ChatRow>(
  sorted: readonly T[],
  group: Exclude<ChatGroup, "none">,
  when: ChatWhen,
  facts: { seen: Readonly<Record<string, number>>; producing: Readonly<Record<string, number>>; placeOf: (row: T) => string | undefined; home: string; now?: number },
): ChatSection<T>[] {
  const how = { group };
  const keyOf = (row: T): string =>
    how.group === "day"
      ? dayOf(whenOf(row, when), facts.now)
      : how.group === "status"
        ? isAnswering(row, facts.producing)
          ? "Answering"
          : isUnread(row, facts.seen)
            ? "Unread"
            : "Read"
        : (facts.placeOf(row) ?? facts.home);
  const sections: ChatSection<T>[] = [];
  for (const row of sorted) {
    const key = keyOf(row);
    const section = sections.find((s) => s.key === key);
    if (section === undefined) sections.push({ key, label: key, rows: [row] });
    else section.rows.push(row);
  }
  const order: readonly string[] = how.group === "day" ? DAY_ORDER : how.group === "status" ? STATUS_ORDER : [facts.home];
  const rank = (key: string): number => (order.includes(key) ? order.indexOf(key) : order.length);
  return sections.sort((a, b) => rank(a.key) - rank(b.key));
}

/** The confirmation a row's Delete asks for. */
export function deleteAskOf(task: TaskSummary, onConfirm: () => void): AskSpec {
  return {
    title: `Delete "${task.title}"?`,
    note: "This deletes the conversation and everything said in it. None of it comes back.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm,
  };
}

/**
 * A row's menu — its right-click, and the ⋯ a hovered row shows (board 28): Open, Rename…, Pin or
 * Unpin, Mark unread (only once read), Run on… each other workspace (only while it waits for one: a
 * conversation that has started stays where its record is), Copy task id, Delete….
 */
export function chatRowMenu(
  task: TaskSummary,
  verbs: {
    open: () => void;
    rename: () => void;
    copyId: () => void;
    askDelete: () => void;
    pinned?: boolean;
    pin?: (on: boolean) => void;
    unread?: boolean;
    markUnread?: () => void;
    runOn?: ReadonlyArray<{ label: string; note?: string; onSelect: () => void }>;
  },
): MenuItem[] {
  return [
    { label: "Open", onSelect: verbs.open },
    { label: "Rename…", onSelect: verbs.rename },
    ...(verbs.pin !== undefined ? [{ label: verbs.pinned === true ? "Unpin" : "Pin to top", separator: true, onSelect: () => verbs.pin!(verbs.pinned !== true) }] : []),
    ...(verbs.markUnread !== undefined && verbs.unread !== true ? [{ label: "Mark unread", onSelect: verbs.markUnread }] : []),
    ...(verbs.runOn ?? []).map((place, i) => ({ label: `Run on ${place.label}`, ...(place.note !== undefined ? { note: place.note } : {}), ...(i === 0 ? { separator: true } : {}), onSelect: place.onSelect })),
    { label: "Copy task id", separator: true, onSelect: verbs.copyId },
    { label: "Delete…", separator: true, danger: true, onSelect: verbs.askDelete },
  ];
}

/** The pinned conversations, as kept in `modes` (`PINNED_MODE`): task ids, comma-separated. */
export const PINNED_MODE = "chat.list.pinned";
export function pinnedOf(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").filter((id) => id !== ""));
}
export function withPinned(raw: string | undefined, taskId: string, on: boolean): string {
  const set = pinnedOf(raw);
  if (on) set.add(taskId);
  else set.delete(taskId);
  return [...set].join(",");
}

/**
 * What a rename in place commits: the new title, or nothing when it is empty or unchanged.
 */
export function renamedTitle(typed: string, was: string): string | undefined {
  const title = typed.trim();
  return title !== "" && title !== was ? title : undefined;
}

/** The open conversation's name, for the title bar — "New conversation" before there is one. */
export function chatTitleOf(conversations: readonly TaskSummary[], taskId: string | null): string {
  return conversations.find((c) => c.taskId === taskId)?.title ?? "New conversation";
}
