import type { JSX } from "react";
import { isConversation, type TaskDetail } from "@jaira/shared/browser";
import type { PanelEntry } from "@jaira/ui/panelStack";
import { subagentEntryOf, taskPaneEntryOf, walkOfEntry } from "@jaira/ui/splitModel";
import { ChatThread } from "./ChatThread";
import { usePaneChatSurface, type PaneWalk } from "./surface";

/**
 * Whether a task is drawn as a conversation (`ConversationView`) wherever it is put: the Chat room's open
 * one (a conversation before its run can say so — its opening message), one the chat started, or one the
 * Chat room lists (a chat workflow's task, however made). One rule, so a pane and the side panel agree.
 */
export function isConversationTask(at: { chatTaskId: string | null; conversations: readonly { taskId: string }[] }, taskId: string, detail: TaskDetail | null): boolean {
  return at.chatTaskId === taskId || (detail !== null && isConversation(detail)) || at.conversations.some((c) => c.taskId === taskId);
}

/**
 * A conversation — or one of its subagents — as it is drawn wherever it stands: the main view, a split's
 * pane, the side panel (the person, 2026-11-25: "the render should be the same no matter where it
 * appears"). The Chat room's thread and composer (`ChatThread`) over the conversation's own run, walked
 * into the subagent the entry is (`walkOfEntry`); a walk into a subagent or back out is a step where the
 * entry stands (`onOpen`: the pane's path, the panel's stack), as is a link to another conversation.
 */
export function ConversationView({
  entry,
  taskId,
  project,
  run,
  onOpen,
}: {
  /** The conversation's own entry, or one of its subagents'. */
  entry: PanelEntry;
  taskId: string;
  project: string | undefined;
  run: Parameters<typeof usePaneChatSurface>[2];
  onOpen: (entry: PanelEntry) => void;
}): JSX.Element {
  const chain = walkOfEntry(entry);
  const stood = entry.kind === "subagent" ? { instanceId: entry.step.instanceId, stateId: entry.step.stateId } : undefined;
  const root = run.detail?.instances[0];
  const walk: PaneWalk = {
    chain,
    onWalk: (next, at) => {
      if (next === null) return onOpen(taskPaneEntryOf(taskId, project));
      const on = at ?? stood ?? (root !== undefined ? { instanceId: root.instanceId, stateId: root.stateId } : undefined);
      if (on !== undefined) onOpen(subagentEntryOf(taskId, project, on, next));
    },
  };
  const surface = usePaneChatSurface(taskId, project, run, (id, at) => onOpen(taskPaneEntryOf(id, at)), "chat", walk);
  return <ChatThread surface={surface} key={taskId} />;
}
