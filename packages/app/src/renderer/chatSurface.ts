/**
 * The Chat view's surface, assembled from the store — what the Chat room, its drawers and its title
 * draw from (`useChatSurface`, `packages/universal/src/components/chat/surface.ts`).
 */
import type { AppState, useApp } from "./store";
import { chatProjectOf, conversationsOf } from "./chatWorkflow";
import type {
  ApprovalScope,
  ChatSettings,
  ConversationView,
  PendingApproval,
  PendingQuestion,
  QueuedPlacement,
  RunTarget,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared/browser";
import type { ApprovalAnswerExtras } from "./approvalSurfaceTypes";
import type { LiveTail } from "./transcript";

/** What the Chat view needs from the shell. Assembled by {@link chatSurfaceOf}. */
export interface ChatSurface {
  /**
   * Every conversation this window can show — already filtered to the chat workflows.
   *
   * A row may carry its OWN project, which is what makes the list work at the root of the address:
   * "all conversations" spans every open project, and a row that cannot say whose task it is cannot
   * be opened. Absent falls back to {@link project}, which is the case inside one project.
   */
  conversations: Array<TaskSummary & { project?: string }>;
  /** The open one, and the project it belongs to. */
  taskId: string | null;
  project: string | null;
  /**
   * The colour each project wears, by directory — see `hueOf`.
   *
   * Only read when a row carries its own project, which is only at the root: inside one project
   * every row is the same project and a chip on each would be a column of identical marks.
   */
  hues?: Readonly<Record<string, string>>;
  /**
   * What to CALL each project, by directory — the same name the sidebar's own row prints.
   *
   * Passed rather than derived, so one project is called one thing everywhere in the window: main
   * names them (`listProjects`), and it is the only thing that knows `~/.jaira` is called that
   * rather than `.jaira`, or that JaiRA's own project is called JaiRA. A directory that is not in
   * the map falls back to its last segment.
   */
  names?: Readonly<Record<string, string>>;
  /** True while a conversation is being created — its first message is a run, which takes a moment. */
  busy: boolean;
  /** The opening message, until the record holding it exists — see `ChatState.opening`. */
  opening: string | null;
  error: string | null;
  /** The open conversation's task detail — what says whether its run is still going. */
  detail: TaskDetail | null;
  /** The journal projection, which is where a gate, a failure or a policy escalation comes from. */
  journal: ConversationView | null;
  /** The turn streaming right now, when it belongs to the open conversation. */
  live: LiveTail | null;
  /** Whether a project is open — an agent conversation without one talks about JaiRA's own root. */
  hasProject: boolean;
  /**
   * Which conversations have a call in flight right now, by task id — see `AppState.producing`.
   *
   * Not `status`. A typed turn is not a run and moves no task status, so a conversation answering its
   * fourth message is `completed` as far as the list is concerned; this is the fact the list actually
   * wants to draw.
   */
  producing: Readonly<Record<string, number>>;
  /**
   * Which conversations have not started, by task id: `placing` while their workspaces are being asked,
   * `waiting` while none has room (decision 0013 §5). The list draws it where a row says "answering".
   */
  unplaced: Readonly<Record<string, "placing" | "waiting">>;
  /** How far each conversation has been read — see `JairaUiState.seen`. */
  seen: Readonly<Record<string, number>>;
  /** Remember that a conversation has been read up to a moment. Monotonic; safe to call often. */
  onSeen: (taskId: string, at: number) => void;
  onOpen: (taskId: string | null, project?: string) => void;
  /** Start one. The settings are the composer's, and reach the first message by riding its run. */
  onNew: (message: string, overrides?: ChatSettings) => Promise<string | null>;
  /**
   * The open conversation while it has not started: being placed, or waiting for a workspace with room
   * (decision 0013 §5). Its counts, what it asked last and what it waits for are what the thread draws
   * above the message that has not been sent.
   */
  queued?: QueuedPlacement | undefined;
  /** Where the next conversation is to run, when the person chose; absent is automatic. */
  runOn?: RunTarget | undefined;
  /** Choose it. For a conversation that waits, this changes what it waits for. */
  onRunOn: (target: RunTarget | undefined) => void;
  /** Change what a waiting conversation's first message runs under — the composer's chips, before the start. */
  onQueuedSettings: (overrides: ChatSettings) => void;
  /** Take a waiting conversation back to the start page, with where it was sent and what it ran under. */
  onTakeBack: (taskId: string, project?: string) => Promise<void>;
  /** What the start page's composer begins with, carried from a conversation taken back. */
  startSettings?: ChatSettings | undefined;
  onRename: (taskId: string, title: string, project?: string) => void;
  onDelete: (taskIds: readonly string[], project?: string) => void;
  /** Stop the RUN — what the first message is. Later messages are turns, and `chat:cancel` stops those. */
  onCancelRun: (taskId: string, project?: string) => void;
  /**
   * Cut the conversation before a message and carry on from there ("task:rewind"). `seq` is the
   * message's journal position (`ChatEditPoint.seq`). Confirmed in the banner before it is called.
   */
  onRewind: (taskId: string, seq: number, project?: string) => Promise<void>;
  /** A second conversation sharing everything before `seq`, with `message` as its next turn ("task:fork"). */
  onFork: (taskId: string, seq: number, message: string, overrides?: ChatSettings, project?: string) => Promise<string | null>;
  /**
   * The command approval the open conversation's agent is blocked on, and the question it asked — drawn
   * inline under what it said before asking, as the task panel draws them. A conversation always
   * renders inline; before this they were drawn only when the same task was open in the Tasks view,
   * so an agent in a chat waited on a `bash` approval for an hour and a half with nothing on screen
   * to answer (the person, 2026-09-26: "i restarted the app and dont see any permission ui").
   */
  approval?: PendingApproval | undefined;
  onApproval?: (requestId: string, decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void;
  question?: PendingQuestion | undefined;
  onQuestion?: (requestId: string, answers: Record<string, string | string[]> | undefined) => void;
}

type Actions = ReturnType<typeof useApp>["actions"];

/**
 * At the ROOT: every project's conversations, newest first, each stamped with its own project — "all
 * conversations" is a place, and this is what it holds. Inside a project: that project's.
 *
 * A project that is one repository in several workspaces (`grouped`, decision 0013 §4) lists the
 * conversations of ALL of them, each stamped with its workspace: a conversation is placed on whichever
 * has room (§5), and one that went to another clone is still this project's.
 */
export function conversationsAt(state: Pick<AppState, "at" | "allConversations" | "tasks" | "projects">, grouped = true): ChatSurface["conversations"] {
  if (state.at === null) return state.allConversations;
  const identity = grouped ? state.projects.find((p) => p.project === state.at)?.identity : undefined;
  const group = identity !== undefined ? new Set(state.projects.filter((p) => p.kind === "user" && p.identity === identity).map((p) => p.project)) : new Set<string>();
  if (group.size <= 1) return conversationsOf(state.tasks);
  return state.allConversations.filter((c) => c.project !== undefined && group.has(c.project));
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
  const queued = state.chat.taskId === null ? undefined : state.queue.find((q) => q.taskId === state.chat.taskId);
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
    unplaced: Object.fromEntries(state.queue.map((q) => [q.taskId, q.phase])),
    seen: state.settings.ui.seen,
    onSeen: actions.markSeen,
    onOpen: actions.openConversation,
    onNew: actions.newConversation,
    queued,
    runOn: queued !== undefined ? queued.target : state.chat.runOn,
    onRunOn: (target) => (queued !== undefined ? void actions.changeQueued(queued.taskId, queued.project, { runOn: target ?? null }) : actions.setRunOn(target)),
    onQueuedSettings: (overrides) => {
      if (queued !== undefined) void actions.changeQueued(queued.taskId, queued.project, { overrides });
    },
    onTakeBack: actions.takeBackQueued,
    startSettings: state.chat.settings,
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
