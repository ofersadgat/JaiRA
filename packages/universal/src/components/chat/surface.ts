import { useMemo, useRef, useState } from "react";
import type { ConversationView, TaskDetail } from "@jaira/shared/browser";
import type { SubagentWalkStep } from "@jaira/ui/panelStack";
import type { CallView } from "@jaira/ui/callRenderers";
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

/** A pane's path as the walk into a conversation's subagents (`usePaneChatSurface`'s `path`). */
export interface PaneWalk {
  /** The walk the pane's entry stands for (`walkOfEntry`); undefined on the conversation itself. */
  chain: readonly SubagentWalkStep[] | undefined;
  /** A walk in (a chain, and the instance its first call is on) or back out to the conversation (null). */
  onWalk: (chain: readonly SubagentWalkStep[] | null, at?: { instanceId: string; stateId: string }) => void;
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
  /** The level of detail — `task` where a program conversation is read as its task (decision 0033 §1). */
  density: CallView = "chat",
  /**
   * The subagents walked into as the pane's PATH has them (`PaneBody`): the walk the pane's entry stands
   * for, and a walk in or out as a step on that path — so a subagent put in a pane is this same thread
   * walked into it, and ‹ comes back out. Absent: the walk is this thread's own to keep.
   */
  path?: PaneWalk,
): ChatSurface {
  const room = useChatSurface();
  const { state } = useShell();
  const [walkedIntoHere, setWalkedInto] = useState<string | undefined>(undefined);
  const [ownChain, setWalkedChain] = useState<ChatSurface["walkedChain"]>(undefined);
  const onPath = useRef(path?.onWalk);
  onPath.current = path?.onWalk;
  const pathed = path !== undefined;
  const walkedChain = pathed ? path.chain : ownChain;
  // Standing in a subagent, no run is walked into: the two are never both the page.
  const walkedInto = walkedChain !== undefined ? undefined : walkedIntoHere;
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
      onWalkInto: (instanceId: string | null) => {
        setWalkedInto(instanceId ?? undefined);
        // Into a run from a subagent the path stands on: the path steps back out to the conversation.
        if (instanceId !== null && pathed && walkedChain !== undefined) onPath.current?.(null);
      },
      walkedChain,
      onWalkIntoSubagent: (chain: ChatSurface["walkedChain"] | null, at?: { instanceId: string; stateId: string }) => {
        setWalkedInto(undefined);
        if (pathed) onPath.current?.(chain !== null && chain !== undefined && chain.length > 0 ? chain : null, at);
        else setWalkedChain(chain ?? undefined);
      },
      onOpen: (id: string | null, at?: string) => (id === null ? room.onOpen(null, at) : onOpen(id, at)),
      density,
    }),
    // `onOpen` is the pane's, made again with it; what it does does not change with it — nor the
    // path's walk, read through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, taskId, project, run.detail, run.conversation, run.liveTurn, queued, approval, question, gate, walkedInto, walkedChain, density, pathed],
  );
}
