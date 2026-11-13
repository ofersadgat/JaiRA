import { useMemo, useState } from "react";
import type { ConversationView, TaskDetail } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { chatSurfaceOf, conversationsAt } from "@jaira/ui/chatSurface";
import { askOfTask } from "@jaira/ui/approvalCall";
import { parkedGateOf } from "@jaira/ui/panelHost";
import { hueOf } from "@jaira/ui/pillModel";
import { inScope, placesOf, scopeOf } from "@jaira/ui/scopeModel";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { useShell } from "../../app/shell";

/**
 * The Chat room's surface, assembled from the shell's state (`chatSurface.ts`): the conversations
 * here, the open one, and the verbs on them. For the room, its drawers and its title.
 *
 * Inside a project, the conversations are those of the machine or workspace its title narrows to
 * (`scopeModel.ts`); at the root, every project's, each naming its own.
 */
export function useChatSurface(): ChatSurface {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const grouped = ui.groupWorkspaces !== false;
  const group = useMemo(() => groupOf(groupProjects(state.projects, grouped), state.at), [state.projects, grouped, state.at]);
  const scope = useMemo(() => (group === undefined ? {} : scopeOf(ui, group)), [group, ui]);
  const conversations = useMemo(() => {
    const here = conversationsAt({ at: state.at, allConversations: state.allConversations, projects: state.projects }, grouped);
    return group === undefined ? here : here.filter((c) => inScope(group, scope, c.project));
  }, [state.at, state.allConversations, state.projects, grouped, group, scope]);
  const places = useMemo(() => (group === undefined ? undefined : placesOf(group, scope)), [group, scope]);
  const hues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  const names = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.project, p.label])), [state.projects]);
  return chatSurfaceOf(state, actions, { conversations, spans: state.at === null, ...(places !== undefined ? { places } : {}), hues, names });
}

/**
 * The surface of a conversation a split's pane shows (decision 0025): the room's surface, with
 * everything about THE conversation taken from that one — its run, loaded on its own (`useTaskRun`), its
 * asks, and the runs and subagents walked into, which are the pane's to walk, not the room's. A link
 * to another conversation goes on the pane's path (`onOpen`). The composer sends by the conversation's
 * own id (`chatThreadModel.ts`), so it writes to the conversation the pane shows.
 */
export function usePaneChatSurface(
  taskId: string,
  project: string | undefined,
  run: { detail: TaskDetail | null; conversation: ConversationView | null; liveTurn: ChatSurface["live"] },
  onOpen: (taskId: string, project?: string) => void,
): ChatSurface {
  const room = useChatSurface();
  const { state } = useShell();
  const [walkedInto, setWalkedInto] = useState<string | undefined>(undefined);
  const [walkedChain, setWalkedChain] = useState<ChatSurface["walkedChain"]>(undefined);
  const queued = state.queue.find((q) => q.taskId === taskId);
  // The conversation the room has open: what the room knows of it before its run does (its opening
  // message while it is made, a send's failure) is its, wherever it is drawn.
  const own = room.taskId === taskId;
  const approval = askOfTask(state.approvals, taskId);
  const question = state.questions.find((q) => q.taskId === taskId);
  const gate = parkedGateOf(state.pending, taskId);
  return useMemo(
    () => ({
      ...room,
      taskId,
      project: project ?? room.project,
      busy: own ? room.busy : false,
      opening: own ? room.opening : null,
      error: own ? room.error : null,
      detail: run.detail ?? (own ? room.detail : null),
      journal: run.conversation,
      live: run.liveTurn,
      queued,
      approval,
      question,
      gate,
      walkedInto,
      onWalkInto: (instanceId: string | null) => setWalkedInto(instanceId ?? undefined),
      walkedChain,
      onWalkIntoSubagent: (chain: ChatSurface["walkedChain"] | null) => setWalkedChain(chain ?? undefined),
      onOpen: (id: string | null, at?: string) => (id === null ? room.onOpen(null, at) : onOpen(id, at)),
    }),
    // `onOpen` is the pane's, made again with it; what it does does not change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, taskId, project, run.detail, run.conversation, run.liveTurn, queued, approval, question, gate, walkedInto, walkedChain],
  );
}
