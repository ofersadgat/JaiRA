import { useEffect, useMemo } from "react";
import { windowClockOf } from "@jaira/ui/boardModel";
import { useShellOrNull } from "./shell";

/**
 * A task's thread is on screen: mark the task read as far as it has gone, and keep marking it while it
 * moves (the unseen-tasks mockups, 2026-11-22: "seeing a task is synonymous with seeing the corresponding
 * chat"). Drawn by the one thread a conversation and a program read as its task share (`ChatThread`) and
 * by a run's own transcript (`RunConversation`), so a task opened from the Chat list, the Tasks list, the
 * board or a pane is one look, and its dot clears in all of them at once.
 *
 * `select` marks a task once, as it is opened (SHELL.md §4.3); this is what keeps it marked while it is
 * read — a thread you are watching does not go unread underneath you — and what marks one opened on a
 * pane, which `select` never hears of. The mark is the task's clock by every list the window holds
 * (`windowClockOf`), the same one `select` uses, so nothing stays lit on the task being read. `markSeen`
 * is monotonic: the calls that move nothing cost a comparison.
 *
 * A component of its own rather than a hook in the thread: what it reads (the boards, every project's
 * ended rows) changes far more often than the thread does, and reading it here keeps those changes from
 * drawing the thread again. Draws nothing; outside `UniversalApp` (a specimen) it does nothing.
 */
export function SeenWhileShown({ taskId }: { taskId: string | null | undefined }): null {
  const shell = useShellOrNull();
  const tasks = shell?.state.tasks;
  const allConversations = shell?.state.allConversations;
  const projects = shell?.state.projects;
  const boards = shell?.state.boards;
  const clock = useMemo(
    () => (taskId === null || taskId === undefined ? 0 : windowClockOf(taskId, { tasks: tasks ?? [], allConversations: allConversations ?? [], projects: projects ?? [], boards: boards ?? {} })),
    [taskId, tasks, allConversations, projects, boards],
  );
  const markSeen = shell?.actions.markSeen;
  // Opened by arriving at its project, it is on screen but not yet looked at (`ChatState.unseenHold`):
  // marked once the person presses or types in it, when the hold is let go and this runs again.
  const held = shell?.state.chat.unseenHold === taskId;
  useEffect(() => {
    if (taskId !== null && taskId !== undefined && clock > 0 && !held) markSeen?.(taskId, clock);
  }, [taskId, clock, markSeen, held]);
  return null;
}
