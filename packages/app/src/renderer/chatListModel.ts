/**
 * What the conversation list says about each row — `ChatListPanel`'s rules, pure: which rows, in what
 * order, which dot, what the right edge says, and what a row's menu offers.
 */
import type { TaskSummary } from "@jaira/shared/browser";
import type { AskSpec, MenuItem } from "./menuTypes";

export type ChatRow = TaskSummary & { project?: string };

/** Newest first, filtered by a title search — a conversation you are having is one you had a moment ago. */
export function shownConversations<T extends ChatRow>(conversations: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  const list = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
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

/** The dot's tooltip. */
export const unreadTitle = (unread: boolean): string => (unread ? "The latest reply has not been read" : "Read");

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

/** A row's right-click menu: Open, Rename…, Copy task id, Delete…. */
export function chatRowMenu(
  task: TaskSummary,
  verbs: { open: () => void; rename: () => void; copyId: () => void; askDelete: () => void },
): MenuItem[] {
  return [
    { label: "Open", onSelect: verbs.open },
    { label: "Rename…", onSelect: verbs.rename },
    { label: "Copy task id", separator: true, onSelect: verbs.copyId },
    { label: "Delete…", separator: true, danger: true, onSelect: verbs.askDelete },
  ];
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
