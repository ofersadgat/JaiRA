import type { JSX, ReactNode } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { isProcessTaskId } from "@jaira/shared/browser";
import type { PanelEntry } from "@jaira/ui/panelStack";
import { publishedOfEntry, taskOfEntry, taskPaneEntryOf } from "@jaira/ui/splitModel";
import { useTaskRun } from "@jaira/ui/taskRun";
import { ConversationView, isConversationTask } from "../components/chat/ConversationView";
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
 *   its subagent     that same thread walked into it — its page, what it asks, the pills, the box — as
 *                    the main view walks into one; a walk in or out is a step on the pane's path
 *   a task's run     its conversation as the run is read (`TaskConversation`, by the panel's face of
 *                    its Conversation tab, without the panel's head and tabs); one of its subagents,
 *                    the subagent's page (`SidechainConversation`), with what it asks
 *   an artifact      the artifact filling the pane (`PublishedView`'s `fill`): its title bar, its places
 *   one of a set     the set's item with the others beside it (`SetItemBody`, by its face), as the side
 *                    panel draws it; a step to another is sideways, in place of it on the pane's path
 *   anything else    a value, a state, a re-run's form: its face's body alone, filling the pane or
 *                    scrolling in it (padding 12 12 18)
 *
 * `onOpen` puts something on THIS pane's path: a conversation the thread links to.
 */
export function PaneBody({ entry, face, onOpen }: { entry: PanelEntry; face: (entry: PanelEntry) => PanelFace; onOpen: (entry: PanelEntry) => void }): JSX.Element {
  // One of a shown set, put here by the set's place buttons: the others beside it, as the side panel draws it.
  if (entry.kind === "preview" && entry.within !== undefined) return <FaceBody face={face(entry)} />;
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
  // A process task (decision 0032) has no run or conversation to read: its face is its task view.
  if (task !== undefined && isProcessTaskId(task.taskId)) return <FaceBody face={face(entry)} />;
  if (task !== undefined && entry.kind !== "rerun") return <PaneTask key={task.taskId} entry={entry} taskId={task.taskId} project={task.project} face={face} onOpen={onOpen} />;
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

/**
 * A task on a pane's path — the task itself, or one of its subagents: its run read on its own, drawn as
 * a conversation's thread (walked into the subagent the entry is, as the main view walks into one) or as
 * a run (the entry's face: the task's conversation, a subagent's page).
 */
function PaneTask({ entry, taskId, project, face, onOpen }: { entry: PanelEntry; taskId: string; project: string | undefined; face: (entry: PanelEntry) => PanelFace; onOpen: (entry: PanelEntry) => void }): JSX.Element {
  const context = useFileSurfaces();
  const { state } = useShell();
  const run = useTaskRun(taskId, project, context);
  const chat = <ConversationView entry={entry} taskId={taskId} project={project} run={{ detail: run.detail, conversation: run.context.conversation, liveTurn: run.context.liveTurn }} onOpen={onOpen} />;
  const at = { chatTaskId: state.chat.taskId, conversations: state.allConversations };
  // The Chat room's own conversation is a conversation before its run can say so (its opening message).
  if (isConversationTask(at, taskId, null)) return chat;
  if (run.failed !== null) return <PanelEmpty>{"Could not read this task: "}{run.failed}</PanelEmpty>;
  if (run.detail === null) return <PanelEmpty>Reading the task…</PanelEmpty>;
  if (isConversationTask(at, taskId, run.detail)) return chat;
  return <FaceBody face={face(entry.kind === "subagent" ? entry : taskPaneEntryOf(taskId, project))} />;
}
