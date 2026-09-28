/**
 * The Chat view's surface, assembled from the store — what `App.tsx` hands `ChatView` and
 * `ChatListPanel`, moved here unchanged so the universal shell (decision 0015) builds the same one.
 */
import type { AppState, useApp } from "./store";
import type { ChatSurface } from "./chatPane";
import { chatProjectOf, conversationsOf } from "./chatWorkflow";

type Actions = ReturnType<typeof useApp>["actions"];

/**
 * At the ROOT: every project's conversations, newest first, each stamped with its own project — "all
 * conversations" is a place, and this is what it holds. Inside a project: that project's.
 */
export function conversationsAt(state: Pick<AppState, "at" | "allConversations" | "tasks">): ChatSurface["conversations"] {
  return state.at === null ? state.allConversations : conversationsOf(state.tasks);
}

/**
 * Everything the Chat view needs, assembled like every other pane's context.
 *
 * The project is DERIVED rather than remembered: conversations belong to the open checkout, and to
 * JaiRA's own root when there is none (`runTargetOf`'s rule for base-layer workflows). Deriving it
 * means closing a project cannot leave the list pointed at a database this window is no longer
 * reading — the list simply becomes the other one. It is never `null`: a chat call NAMES its project,
 * because main resolves an unnamed one only while exactly one user project is open (`chatProjectOf`).
 */
export function chatSurfaceOf(
  state: AppState,
  actions: Actions,
  parts: {
    conversations: ChatSurface["conversations"];
    hues: Readonly<Record<string, string>>;
    names: Readonly<Record<string, string>>;
  },
): ChatSurface {
  return {
    conversations: parts.conversations,
    hues: parts.hues,
    names: parts.names,
    taskId: state.chat.taskId,
    project: chatProjectOf(state.chat.project, state.at),
    busy: state.chat.busy,
    opening: state.chat.opening,
    error: state.chat.error,
    // The detail, journal and live tail are the SELECTED task's — opening a conversation selects it,
    // so these are about the thread on screen. Guarded on that rather than assumed: a selection made
    // in the Tasks view would otherwise lend this panel another task's transcript.
    detail: state.selected === state.chat.taskId ? state.detail : null,
    journal: state.selected === state.chat.taskId ? state.conversation : null,
    live: state.selected === state.chat.taskId ? state.liveTurn : null,
    hasProject: state.at !== null,
    producing: state.producing,
    seen: state.settings.ui.seen,
    onSeen: actions.markSeen,
    onOpen: actions.openConversation,
    onNew: actions.newConversation,
    onRename: actions.renameTask,
    onDelete: actions.deleteTasks,
    onCancelRun: actions.cancelTask,
    onRewind: actions.rewindConversation,
    onFork: actions.forkConversation,
    approval: state.chat.taskId === null ? undefined : state.approvals.find((a) => a.taskId === state.chat.taskId),
    onApproval: actions.decideApproval,
    question: state.chat.taskId === null ? undefined : state.questions.find((q) => q.taskId === state.chat.taskId),
    onQuestion: actions.answerQuestion,
  };
}
