/**
 * The Chat view: conversations, listed on the left and read in the middle.
 *
 * The two other views in this app are about a body of work — the Files view designs the states, the
 * Tasks view operates the runs. This one is about a THREAD. You open it, you type, an agent answers,
 * and the whole apparatus of workflows, boards and instance trees is somewhere underneath rather
 * than on the screen: a conversation here is a task (see `chatWorkflow.ts`), which is what gives it
 * a journal, a policy, an approval strip and a transcript for free — and none of that is worth
 * putting in front of somebody who is having a conversation.
 *
 * ## One thread, not a stack of panels
 *
 * The Tasks view's transcript is laid out by SESSION, in bands, because a run is several
 * conversations happening in a shape. A chat is one conversation, so it is one column of turns —
 * `chat:thread` reads the record chain whole, forks walked, and this renders it with the same
 * viewer the rest of the app uses. Same components, different question.
 *
 * ## What the composer here can do that the run panel's cannot
 *
 * Three things, and each is a fact about a conversation rather than about a transcript:
 *
 *  - **Stop.** A chat turn is not a run, so `task:cancel` has never had anything to abort here.
 *    `chat:cancel` does, and the send button becomes a stop button while a turn is in flight.
 *  - **Attachments.** Files dropped on the box, and `@`-mentions completed against the project.
 *  - **Edit.** Any message already sent can be replaced, which forks the chain at that position and
 *    leaves the branch it replaced in the record but off the path. See `chat:send`'s `branchAt`.
 *
 * ## Where a conversation runs
 *
 * In the open project, in its own directory — a conversation task binds no branch, so its workspace
 * is the checkout itself rather than a worktree. That is the point of the Agent kind: it is talking
 * about the code you have open. With no project open, conversations run in JaiRA's own root, which
 * is the same routing every base-layer workflow uses.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import type {
  ApprovalScope,
  ChatPlanView,
  ChatSettings,
  ConversationView,
  PendingApproval,
  PendingQuestion,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared/browser";
import { Composer } from "./composer";
import { ApprovalSurface, QuestionSurface, type ApprovalAnswerExtras } from "./components";
import { projectName } from "./projects";
import { ForkMark, OriginMark, ZigDefs } from "./sessionPanels";
import { useStickToBottom } from "./stickToBottom";
import { CHAT_SESSION } from "./chatWorkflow";
import { ContextMenu, AskDialog, pointOf, type AskSpec, type MenuAnchor } from "./menu";
import type { LiveTail } from "./transcript";
import { DayChip, LiveStatusBar, Paper, Transcript } from "./transcriptView";
import { ApprovalAskContext } from "./workSummaryView";
import { useMentions } from "./chatMentions";
import { KEPT, armingText, replyPlaceholder, useChatThread, useReadMark } from "./chatThreadModel";
import { Icon, Spinner } from "./icons";
import { invoke } from "./store";
import { agoOf, chatStartWhereOf, chatRowMenu, controlsOf, deleteAskOf, emptyListText, forkTitleOf, isAnswering, isUnread, renamedTitle, shownConversations, unreadTitle } from "./chatListModel";
import { WaitingLine, WaitingMessage } from "./usageMeters";

/** What the Chat view needs from the shell. Assembled in `App.tsx`, like every other pane's. */
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
  /** How far each conversation has been read — see `JairaUiState.seen`. */
  seen: Readonly<Record<string, number>>;
  /** Remember that a conversation has been read up to a moment. Monotonic; safe to call often. */
  onSeen: (taskId: string, at: number) => void;
  onOpen: (taskId: string | null, project?: string) => void;
  /** Start one. The settings are the composer's, and reach the first message by riding its run. */
  onNew: (message: string, overrides?: ChatSettings) => Promise<string | null>;
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

/**
 * The conversation list — the Chat row's drawer in the sidebar.
 *
 * Newest first, because a conversation you are having is a conversation you had a moment ago.
 *
 * The two controls that used to head it — "New conversation" and the search box — are the ROW's
 * now (SHELL.md §5.1): they are the verbs of the place this list is inside, and on the row they are
 * reachable without opening the drawer at all. What is left here is the list, which is what a
 * drawer under a row named Chat should hold.
 */
export function ChatListPanel({ surface, find = false }: { surface: ChatSurface; find?: boolean }): JSX.Element {
  const [query, setQuery] = useState("");
  // Dropped when the field goes away, so re-opening it does not re-apply a filter nobody can see —
  // the list would come back short with an empty-looking reason.
  useEffect(() => {
    if (!find) setQuery("");
  }, [find]);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);

  const shown = useMemo(() => shownConversations(surface.conversations, query), [surface.conversations, query]);

  // The ROW's project first — at the root every row is a different one — and the surface's only as
  // the fallback for a list that is already inside a project.
  const open = (task: TaskSummary & { project?: string }): void =>
    surface.onOpen(task.taskId, task.project ?? surface.project ?? undefined);

  /** Whether the newest thing it said has been read, and whether it is answering now — `chatListModel.ts`. */
  const unread = (task: TaskSummary): boolean => isUnread(task, surface.seen);
  const answering = (task: TaskSummary): boolean => isAnswering(task, surface.producing);

  return (
    <div className="chat-list">
      {find ? (
        <input
          className="chat-search"
          autoFocus
          value={query}
          placeholder="Search conversations"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => (e.key === "Escape" ? setQuery("") : undefined)}
        />
      ) : null}

      {shown.length === 0 ? (
        <p className="empty">{emptyListText(query)}</p>
      ) : (
        <ul className="chat-rows">
          {shown.map((task) => (
            <li
              key={task.taskId}
              className={task.taskId === surface.taskId ? "sel" : undefined}
              onClick={() => open(task)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  // The point AND the row — opening a conversation scrolls the transcript beside it,
                  // and a menu that closed on that scroll never got read. See `menu.tsx`.
                  ...pointOf(e),
                  items: chatRowMenu(task, {
                    open: () => open(task),
                    rename: () => setRenaming({ taskId: task.taskId, title: task.title }),
                    copyId: () => void navigator.clipboard?.writeText(task.taskId),
                    askDelete: () =>
                      setAsk(
                        deleteAskOf(task, () => {
                          setAsk(null);
                          surface.onDelete([task.taskId], surface.project ?? undefined);
                        }),
                      ),
                  }),
                });
              }}
            >
              {renaming?.taskId === task.taskId ? (
                // Renamed IN PLACE, in the row, rather than in a dialog: the name is the row, and a
                // modal to change one word would be a modal over the list you are naming it in.
                <input
                  className="chat-rename"
                  autoFocus
                  value={renaming.title}
                  onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenaming(null);
                    if (e.key !== "Enter") return;
                    const title = renamedTitle(renaming.title, task.title);
                    if (title !== undefined) surface.onRename(task.taskId, title, surface.project ?? undefined);
                    setRenaming(null);
                  }}
                />
              ) : (
                <>
                  {/* The left edge is what the list is SCANNED down, so that is where "is there
                      anything here for me" belongs. A dot each way rather than a dot or nothing: a
                      mark that disappears when it is read takes the column's alignment with it, and
                      a row that has shifted left is a row the eye has to re-find. */}
                  <span
                    className={`chat-row-mark${unread(task) ? " unread" : ""}`}
                    title={unreadTitle(unread(task))}
                  />
                  <span
                    className="chat-row-title ellip"
                    {...(forkTitleOf(task) !== undefined ? { title: forkTitleOf(task) } : {})}
                  >
                    {/* A fork wears the glyph its seam does, so the list says what the thread says. */}
                    {task.origin !== undefined ? <Icon name="choice" className="chat-row-fork" /> : null}
                    {task.title}
                  </span>
                  {/* A conversation that is CONTROLLING work says so (decision 0005): a dynamic
                      workflow is a row in this list and not a column of its own, so the only place
                      it can say how much work stands in it is here. A count, not the titles — what
                      each task is doing is the conversation's to say, and it does. */}
                  {controlsOf(task) !== undefined ? (
                    <span className="prov" title={controlsOf(task)!.title}>
                      {controlsOf(task)!.label}
                    </span>
                  ) : null}
                  {/* Only on a row that carries its own project, which is only at the ROOT: inside
                      one project every row is the same project and a chip on each would be a column
                      of identical marks. The hue is the one that project wears everywhere else. */}
                  {task.project !== undefined ? (
                    <span
                      className="chip strip-project"
                      title={task.project}
                      style={{ "--hue": surface.hues?.[task.project] ?? "var(--p0)" } as CSSProperties}
                    >
                      {surface.names?.[task.project] ?? projectName(task.project)}
                    </span>
                  ) : null}
                  {/* The time is REPLACED while it is answering, not annotated. "2 min" is a fact
                      about the last thing that happened, and while something is happening it is a
                      fact about nothing anybody is asking. */}
                  {answering(task) ? (
                    <span className="chat-row-when chat-row-live" title="Answering now">
                      <Spinner />
                    </span>
                  ) : (
                    <span className="chat-row-when sub">{agoOf(task.updatedAt)}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask !== null ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </div>
  );
}

/** The middle column: a conversation, or the offer to start one. */
export function ChatView({ surface }: { surface: ChatSurface }): JSX.Element {
  // Reading a conversation is what marks it read — see `useReadMark` (`chatThreadModel.ts`).
  useReadMark(surface);
  return surface.taskId === null ? <ChatStart surface={surface} /> : <ChatThread surface={surface} key={surface.taskId} />;
}

/**
 * The empty view: say the first thing.
 *
 * It used to ask first whether this was to be an Agent or an Assistant conversation, which was a
 * question about permissions wearing the clothes of a question about identity. Every message is
 * gated — nothing runs, reads or writes without the mode on the composer saying it may, and that
 * mode starts at "ask first" — so a conversation with tools it never uses is exactly a conversation
 * without tools, minus a decision nobody could make before they had typed anything. There is one
 * kind now, and the composer still takes the tools away per message for anyone who wants that.
 */
function ChatStart({ surface }: { surface: ChatSurface }): JSX.Element {
  const [overrides, setOverrides] = useState<ChatSettings>({});
  const [plan, setPlan] = useState<ChatPlanView | null>(null);
  const project = surface.project ?? undefined;
  const mentions = useMentions(surface.hasProject, project);

  /**
   * What the first message would run under — asked of the STATE, since there is no conversation yet.
   *
   * The settings row used to be hidden here on the grounds that there was nothing to report, which
   * was true of the plan and not of the question: the first message is the one that decides what the
   * conversation inherits, and it was the only one being sent without being able to see the model,
   * the effort, the permissions or the tools. `chat:startPlan` reads the state file the way
   * `chat:plan` reads a run, and re-asked on every override for the same reason the thread's is —
   * changing one setting can change what another RESOLVES to.
   */
  useEffect(() => {
    let live = true;
    void invoke("chat:startPlan", { stateId: CHAT_SESSION, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [project, overrides]);

  return (
    <div className="chat-start">
      <div className="chat-start-mid">
        <h2 className="chat-start-head">What are we doing?</h2>
        <p className="sub chat-start-where">
          {chatStartWhereOf(surface.hasProject)}
        </p>

        {surface.error !== null ? <p className="cx-error">{surface.error}</p> : null}

        <Composer
          plan={plan}
          busy={surface.busy}
          overrides={overrides}
          onOverrides={setOverrides}
          placeholder="Ask for a change, or a question about the code…"
          draftKey={`chat:new:${project ?? ""}`}
          onSend={(message) => void surface.onNew(message, overrides)}
          onSavePermissionSet={(request) => invoke("permissionSet:save", { ...request, ...(project !== undefined ? { project } : {}) })}
          // With no project open this runs in JaiRA's own root, which has no "this project" to keep in.
          saveLayers={surface.hasProject ? ["project", "base"] : ["base"]}
          {...mentions}
        />
      </div>
    </div>
  );
}

// `kept` — what a re-read may replace a thread with — lives in `chatThreadModel.ts` with the rest of the
// thread's state, shared with the universal shell (decision 0015).
export { kept } from "./chatThreadModel";

/**
 * One conversation: the thread, and the box under it.
 *
 * The thread is re-read whenever anything about the task changes — the detail and the journal are
 * both refreshed by the store on a `task` invalidation, so their identity moving is the signal that
 * something landed. The live tail is separate and arrives per fragment, which is what makes an
 * answer appear as it is written rather than when it is finished.
 */
function ChatThread({ surface }: { surface: ChatSurface }): JSX.Element {
  /** Scrolling is this component's; the thread's state is `chatThreadModel.ts`'s, which calls this to re-pin on a send. */
  const jumpRef = useRef<() => void>(() => undefined);
  const {
    taskId,
    project,
    thread,
    plan,
    overrides,
    setOverrides,
    sending,
    error,
    draft,
    setDraft,
    arming,
    disarm,
    confirmRewind,
    send,
    stop,
    answering,
    waitingHere,
    lastContext,
    onCompact,
    artifacts,
    entries,
    status,
    askValue,
    approvalInThread,
    origin,
    seam,
    split,
    shown,
    setBranch,
    edit,
    doomedFrom,
    afterglow,
  } = useChatThread(surface, jumpRef);
  const mentions = useMentions(surface.hasProject, project);
  /**
   * Follow the live edge while the reader is standing on it — see {@link useStickToBottom}, which
   * is where this behaviour used to live in full and where the run and leaf transcripts now get it
   * from too.
   *
   * `thread` and the live tail are what "the content grew" means here; the task is what "a
   * different conversation" means.
   */
  const { ref: scroller, onScroll, away, jump } = useStickToBottom<HTMLDivElement>(
    [thread, surface.live],
    [taskId, project],
  );
  jumpRef.current = jump;

  /**
   * What the agent is blocked on — the command it is waiting to run, the question it asked — drawn
   * where the turn is arriving, under what it said before asking: on the page with the live tail, as
   * the task panel draws it. Keyed on the request, so a second one starts with nothing lit.
   */
  const asking = (
    <>
      {surface.approval !== undefined && surface.onApproval !== undefined && !approvalInThread ? (
        <div className="inline-gate">
          <ApprovalSurface
            key={surface.approval.requestId}
            pending={surface.approval}
            onDecide={(decision, scope, extras) => surface.onApproval!(surface.approval!.requestId, decision, scope, extras)}
          />
        </div>
      ) : null}
      {surface.question !== undefined && surface.onQuestion !== undefined ? (
        <div className="inline-gate">
          <QuestionSurface key={surface.question.requestId} pending={surface.question} onSubmit={(answers) => surface.onQuestion!(surface.question!.requestId, answers)} />
        </div>
      ) : null}
    </>
  );

  return (
    <div className="chat-thread">
      {/* What this conversation PRODUCED is the side panel's Produced tab now (the panel rulings,
          2026-09-24) — a disclosure above the thread was pushed off by the thread it sat over. */}
      <div
        className="chat-scroll scroll"
        ref={scroller}
        onScroll={onScroll}
      >
        <ZigDefs />
        {/* Which day you are reading, floating over the thread — see {@link DayChip}. Inside the
            scroller and outside the sheet: it is a fact about where you are standing, not a line in
            the record. The gaps between messages say how long each pause was; this says which day
            you are looking at, and between them nothing needs a rule drawn across the page. */}
        <DayChip scroller={scroller} />
        <ApprovalAskContext.Provider value={askValue}>
        <Paper>
          <Transcript
            session={thread?.session ?? null}
            entries={split !== null ? split.shared : seam !== null ? seam.shared : entries}
            // The live tail belongs to the END of the conversation, so it rides with whatever is
            // showing there — and a reader looking at the side that was replaced is not looking at
            // where a turn is arriving.
            {...(split === null && (seam === null || seam.own.length === 0) ? { live: surface.live ?? afterglow, working: answering } : {})}
            empty={answering ? "Working…" : "This conversation has not said anything yet."}
            artifacts={artifacts}
            onEdit={edit}
            // The conversation is what a type correction belongs to — see `messageTypes.ts`. The
            // replaced branch below deliberately gets none: it is off the path, and a preference
            // keyed to a message nobody can reach again is a preference nobody can clear.
            scope={taskId}
            {...(status !== null ? { narrated: true } : {})}
            {...(doomedFrom !== undefined ? { doomedFrom } : {})}
          />
          {split === null && (seam === null || seam.own.length === 0) ? asking : null}
        </Paper>
        {split === null && seam !== null && origin !== undefined ? (
          <>
            {/* Where this conversation came from — the same torn edge an edit's seam uses, with a
                different sentence: there is nothing to choose between here, only somewhere to go. */}
            <div className="chat-fork">
              <OriginMark origin={origin} onGo={() => surface.onOpen(origin.taskId, project)} />
            </div>
            {seam.own.length > 0 ? (
              <Paper>
                <Transcript
                  session={thread?.session ?? null}
                  entries={seam.own}
                  live={surface.live ?? afterglow}
                  working={answering}
                  artifacts={artifacts}
                  onEdit={edit}
                  scope={taskId}
                  {...(status !== null ? { narrated: true } : {})}
                  {...(doomedFrom !== undefined ? { doomedFrom } : {})}
                />
                {asking}
              </Paper>
            ) : null}
          </>
        ) : null}
        {split !== null && shown !== undefined ? (
          <>
            <div className="chat-fork">
              <ForkMark
                sides={split.branches}
                shown={shown.key}
                onShow={setBranch}
                note="a message was replaced here"
              />
            </div>
            <Paper>
              <Transcript
                session={thread?.session ?? null}
                entries={shown.entries}
                {...(shown.key === KEPT ? { live: surface.live ?? afterglow, working: answering } : {})}
                artifacts={artifacts}
                // Only on the side that is still being had. A message on the other side cannot be
                // replaced from here: it is not where this conversation ends, and "edit" means fork
                // from a position, which that side no longer holds.
                {...(shown.key === KEPT ? { onEdit: edit } : {})}
                {...(status !== null && shown.key === KEPT ? { narrated: true } : {})}
                {...(shown.key === KEPT && doomedFrom !== undefined ? { doomedFrom } : {})}
              />
              {shown.key === KEPT ? asking : null}
            </Paper>
          </>
        ) : null}
        </ApprovalAskContext.Provider>
      </div>

      {/* Between the conversation and the box: the live state is neither part of the record above it
          nor part of the message being composed below, and it is the one line whose position must
          not depend on how much has happened. */}
      {status !== null ? <LiveStatusBar status={status} {...(away ? { onJump: jump } : {})} /> : null}

      {waitingHere.length > 0 ? (
        <div className="um-waiting-host">
          {waitingHere.map((item) => (item.state === "waiting" ? <WaitingMessage key={item.id} item={item} /> : <WaitingLine key={item.id} item={item} />))}
        </div>
      ) : null}

      <div className="chat-foot">
        {arming !== null ? (
          // Said plainly, above the box, because it changes what pressing Enter MEANS: the message
          // will not be added to the end of this conversation — it will take another one's place,
          // or start a conversation of its own. A rewind changes what a BUTTON means instead, and
          // the button is the only filled thing in the row, in the app's danger colour.
          <div className={arming.kind === "rewind" ? "chat-editing danger" : "chat-editing"} role={arming.kind === "rewind" ? "alertdialog" : undefined}>
            <span className="ellip">{armingText(arming)}</span>
            <button className="ghost" onClick={disarm}>
              Cancel
            </button>
            {arming.kind === "rewind" ? (
              <button className="cut" onClick={confirmRewind}>
                Rewind
              </button>
            ) : null}
          </div>
        ) : null}
        {error !== null ? <p className="cx-error">{error}</p> : null}
        <Composer
          plan={plan ?? null}
          busy={sending > 0 || answering}
          // There is a thread, so there is somewhere for a mid-turn message to go: it joins the turn
          // in flight where the transport can take it, and waits for it where it cannot. Both are
          // `chat:send`'s own behaviour — the box was the only thing refusing.
          joinable={thread !== null}
          overrides={overrides}
          onOverrides={setOverrides}
          value={draft}
          onValue={setDraft}
          onSend={send}
          onStop={stop}
          placeholder={replyPlaceholder(arming)}
          {...(plan === null && thread === null ? { disabled: "This conversation cannot be continued." } : {})}
          onSavePermissionSet={(request) => invoke("permissionSet:save", { ...request, ...(project !== undefined ? { project } : {}) })}
          saveLayers={surface.hasProject ? ["project", "base"] : ["base"]}
          usage={{ context: lastContext, onCompact, cost: thread?.costUsd }}
          {...mentions}
        />
      </div>
    </div>
  );
}

// `useMentions` — the composer's two project-file props — lives in `chatMentions.ts`, shared with the
// universal composer (decision 0015).

// `chatProjectOf` and `conversationsOf` live in `chatWorkflow.ts` (pure), shared with the universal shell (decision 0015).
export { chatProjectOf, conversationsOf } from "./chatWorkflow";
