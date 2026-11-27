import type { AppState, ChatState } from "./store";
import { conversationsAt } from "./chatSurface";
import { isUnread } from "./chatListModel";
import { seenClockOf } from "./pillModel";

/** The conversation a window arriving at a project opens on its own, and where it is. */
export interface ArrivalPick {
  taskId: string;
  project: string | null;
}

/**
 * The Chat view as a window arrives at another project — clicked in the sidebar, opened, made new, or
 * a workspace of it on another machine. The one that was open belongs to the place just left; kept,
 * the thread was asked for under a project that does not hold it, and the composer under it read like
 * the new project's start page while it typed into that other conversation (2026-11-26: a project's
 * first prompt, sent from that box, went nowhere). Where the next one runs and what it was carried
 * with were picked for the old place too. `busy` stays: a conversation being started still lands where
 * it was asked to.
 *
 * With a `pick` (`latestUnreadAt`, when the window stood in the Chat room), that conversation is
 * opened in its place — but HELD unseen (`unseenHold`): put on screen by arriving is not read, and its
 * dot stays until the person presses or types in its thread, or picks it in the list (the person,
 * 2026-11-26: "the seen notification shouldnt be cleared until the actual chat window gets focus").
 * Without one, a new conversation there.
 */
export function chatOnArriving(chat: ChatState, pick?: ArrivalPick): ChatState {
  const { runOn: _runOn, settings: _settings, walkedInto: _walked, walkedChain: _chain, unseenHold: _hold, ...rest } = chat;
  if (pick === undefined) return { ...rest, taskId: null, project: null, opening: null, error: null };
  return { ...rest, taskId: pick.taskId, project: pick.project, opening: null, error: null, unseenHold: pick.taskId };
}

/**
 * The newest conversation at `at` that has moved since it was last read — the one the Chat list lists
 * there (`conversationsAt`, workspaces grouped as the list groups them) with the latest activity
 * (`seenClockOf`) among those `isUnread` says are. None read-worthy, or no project: undefined.
 */
export function latestUnreadAt(
  state: Pick<AppState, "allConversations" | "projects">,
  at: string | null,
  seen: Readonly<Record<string, number>>,
  grouped = true,
): ArrivalPick | undefined {
  if (at === null) return undefined;
  let best: { taskId: string; project: string | null; clock: number } | undefined;
  for (const row of conversationsAt({ at, allConversations: state.allConversations, projects: state.projects }, grouped)) {
    if (!isUnread(row, seen)) continue;
    const clock = seenClockOf(row);
    if (best === undefined || clock > best.clock) best = { taskId: row.taskId, project: row.project ?? at, clock };
  }
  return best === undefined ? undefined : { taskId: best.taskId, project: best.project };
}
