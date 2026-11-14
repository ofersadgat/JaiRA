import type { JSX, ReactNode } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { isConversation } from "@jaira/shared/browser";
import type { PanelEntry } from "@jaira/ui/panelStack";
import { publishedOfEntry, taskOfEntry, taskPaneEntryOf } from "@jaira/ui/splitModel";
import { useTaskRun } from "@jaira/ui/taskRun";
import { ChatThread } from "../components/chat/ChatThread";
import { usePaneChatSurface } from "../components/chat/surface";
import { PanelEmpty } from "../components/panel/PanelViews";
import { PreviewCard } from "../components/panel/PreviewCard";
import { PublishedView } from "../components/panel/PublishedView";
import type { PanelFace } from "../components/panel/SidePanel";
import { PLAIN_SCROLLER, scrollbarProps } from "../primitives";
import { useTokens } from "../tokens";
import { useFileSurfaces } from "./FilesView";
import { surfaceOf } from "./places";
import { useShell } from "./shell";

/**
 * What a pane draws of the entry its path stands on — the ONE function a path is drawn by, whichever
 * pane it is in and whether or not the column is split (decision 0025, as the person ruled 2026-11-13:
 * "if you opened the same path, the two panels should look pixel identical"). The room's own view is
 * the only entry drawn elsewhere (`SplitPane.tsx`), being the room's: the Chat room's conversation is
 * not that — it is this, by its own entry. The REAL view, as the main column draws it, never a side
 * panel's face in its frame.
 *
 *   a conversation   the Chat room's thread (`ChatThread`) with its composer, over the conversation's
 *                    own run (`useTaskRun`, `usePaneChatSurface`): what it says, what it asks, what is
 *                    sent from its box — all by its own id
 *   a task's run     its conversation as the run is read (`TaskConversation`, by the panel's face of
 *                    its Conversation tab, without the panel's head and tabs)
 *   an artifact      the artifact filling the pane (`PublishedView`'s `fill`): its title bar, its places
 *   anything else    a value, a state, a subagent's conversation: its face's body alone, filling the
 *                    pane or scrolling in it (padding 12 12 18)
 *
 * `onOpen` puts something on THIS pane's path: a conversation the thread links to.
 */
export function PaneBody({ entry, face, onOpen }: { entry: PanelEntry; face: (entry: PanelEntry) => PanelFace; onOpen: (entry: PanelEntry) => void }): JSX.Element {
  const published = publishedOfEntry(entry);
  if (published !== undefined) {
    return (
      <View flex={1} minHeight={0}>
        <PublishedView key={`${published.ref.id}@${String(published.ref.version)}`} published={published.ref} artifacts={surfaceOf(published.ref.taskId, published.project)} fill follows={published.follows} />
      </View>
    );
  }
  if (entry.kind === "preview") return <PreviewCard item={entry.preview} />;
  const task = taskOfEntry(entry);
  if (task !== undefined && entry.kind !== "subagent" && entry.kind !== "rerun") return <PaneTask key={task.taskId} taskId={task.taskId} project={task.project} face={face} onOpen={onOpen} />;
  return <FaceBody face={face(entry)} />;
}

/** A face's body alone: filling the pane when it lays itself out, else scrolling in it. */
function FaceBody({ face }: { face: PanelFace }): JSX.Element {
  const t = useTokens();
  if (face.scroll === false) {
    return (
      <View flex={1} minHeight={0} flexDirection="column" overflow="hidden">
        {face.body}
      </View>
    );
  }
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
      contentContainerStyle={{ flexGrow: 1, flexDirection: "column", gap: 14, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 18, ...PLAIN_SCROLLER } as never}
    >
      {face.body as ReactNode}
    </ScrollView>
  );
}

/** A task on a pane's path: its run read on its own, drawn as a conversation's thread or as a run. */
function PaneTask({ taskId, project, face, onOpen }: { taskId: string; project: string | undefined; face: (entry: PanelEntry) => PanelFace; onOpen: (entry: PanelEntry) => void }): JSX.Element {
  const context = useFileSurfaces();
  const { state } = useShell();
  const run = useTaskRun(taskId, project, context);
  const chat = <PaneChat taskId={taskId} project={project} run={{ detail: run.detail, conversation: run.context.conversation, liveTurn: run.context.liveTurn }} onOpen={onOpen} />;
  // The Chat room's own conversation is a conversation before its run can say so (its opening message).
  if (state.chat.taskId === taskId) return chat;
  if (run.failed !== null) return <PanelEmpty>{"Could not read this task: "}{run.failed}</PanelEmpty>;
  if (run.detail === null) return <PanelEmpty>Reading the task…</PanelEmpty>;
  // A conversation: one the chat started, or one the Chat room lists (a chat workflow's task, however made).
  if (isConversation(run.detail) || state.allConversations.some((c) => c.taskId === taskId)) return chat;
  return <FaceBody face={face(taskPaneEntryOf(taskId, project))} />;
}

/** A conversation on a pane's path: the Chat room's thread and composer, about this conversation. */
function PaneChat({ taskId, project, run, onOpen }: { taskId: string; project: string | undefined; run: Parameters<typeof usePaneChatSurface>[2]; onOpen: (entry: PanelEntry) => void }): JSX.Element {
  const surface = usePaneChatSurface(taskId, project, run, (id, at) => onOpen(taskPaneEntryOf(id, at)));
  return <ChatThread surface={surface} key={taskId} />;
}
