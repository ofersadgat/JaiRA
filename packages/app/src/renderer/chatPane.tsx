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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import type {
  ArtifactSummary,
  ChatPlanView,
  ChatSettings,
  ChatThreadView,
  ConversationView,
  SessionTurn,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared/browser";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { Composer } from "./composer";
import { projectName } from "./projects";
import { ForkMark, ZigDefs } from "./sessionPanels";
import { useStickToBottom } from "./stickToBottom";
import { CHAT_AGENT, isChatWorkflow, titleOf } from "./chatWorkflow";
import { ContextMenu, AskDialog, type AskSpec, type MenuAnchor } from "./menu";
import { agentTitleOf, entriesOf, journalFor, liveStatusOf, type LiveTail } from "./transcript";
import { DayChip, LiveStatusBar, Paper, sizeOf, Transcript, type ArtifactSurface } from "./transcriptView";
import { ValueView } from "./valueView";
import { Icon, Spinner } from "./icons";
import { invoke } from "./store";

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
}

/**
 * What this conversation PRODUCED, collected in one place.
 *
 * A transcript answers "what happened", and it answers it in order — which is the wrong shape for
 * "where is the thing you made". An artifact written twenty turns ago is twenty turns up, indistinguishable
 * from the twenty tool calls around it, and a conversation that produced four documents shows them
 * four screens apart. This is the other reading of the same records: not when they were made, but
 * what there is.
 *
 * Closed until asked for, and absent entirely when nothing has been produced — a disclosure that
 * only ever says "0" is a permanent row of chrome charging rent for a fact nobody needed.
 *
 * The viewer is {@link ValueView}, with the same `serve` the transcript uses, so an interactive
 * mockup runs here exactly as it does beside the call that made it. One renderer, not two.
 */
function ArtifactsPanel({
  taskId,
  project,
  artifacts,
  signal,
}: {
  taskId: string;
  project: string | undefined;
  artifacts: ArtifactSurface;
  /** Changes when the conversation has moved on — what makes a newly produced artifact appear. */
  signal: number;
}): JSX.Element | null {
  const [list, setList] = useState<ArtifactSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ path: string; mime: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The LIST is refreshed whenever the conversation moves, whether or not the panel is open: the
  // count in the header is the only thing that tells you there is something to open.
  useEffect(() => {
    let live = true;
    void invoke("artifact:list", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((rows) => {
        if (live) setList(rows);
      })
      .catch(() => {
        if (live) setList([]);
      });
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);

  // The CONTENT is fetched per artifact, on selection — see `ArtifactSummary` on why the list does
  // not carry it.
  useEffect(() => {
    if (selected === null) {
      setDoc(null);
      return;
    }
    let live = true;
    setError(null);
    void invoke("uri:read", { uri: `artifact://${taskId}/${selected}`, ...(project !== undefined ? { project } : {}) })
      .then((content) => {
        if (live) setDoc({ path: selected, mime: content.mime, text: content.text });
      })
      .catch((e: Error) => {
        if (live) {
          setDoc(null);
          setError(e.message);
        }
      });
    return () => {
      live = false;
    };
  }, [selected, taskId, project]);

  if (list.length === 0) return null;

  const shown = list.find((row) => row.path === selected);
  return (
    <div className={`chat-artifacts${open ? " open" : ""}`}>
      <button type="button" className="chat-artifacts-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ts-chev">
          <Icon name="chevron" />
        </span>
        <span>Produced</span>
        <span className="count">{list.length}</span>
      </button>

      {open ? (
        <div className="chat-artifacts-body">
          <div className="chat-artifacts-list">
            {list.map((row) => (
              <button
                type="button"
                key={row.path}
                className={`chat-artifact-row${row.path === selected ? " sel" : ""}`}
                onClick={() => setSelected(row.path === selected ? null : row.path)}
              >
                <span className="grow ellip" title={row.path}>
                  {row.path}
                </span>
                {/* Said plainly rather than shown as an icon: that a page can RUN is the one property
                    of an artifact worth knowing before opening it. */}
                {row.interactive ? <span className="chip chat-artifact-live">runs</span> : null}
                <span className="sub">{sizeOf(row.bytes)}</span>
              </button>
            ))}
          </div>

          {error !== null ? <p className="reason">{error}</p> : null}
          {shown !== undefined && doc !== null ? (
            <div className="chat-artifact-view">
              <ValueView
                // The ENVELOPE, not the bare text: it is what carries the media type and the
                // interactive claim into `viewsFor`, which is the same value the transcript renders.
                value={{ path: shown.path, mediaType: shown.mediaType, content: doc.text, ...(shown.interactive ? { interactive: true } : {}) }}
                serve={artifacts.serve}
                {...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {})}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = [...surface.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    return needle === "" ? list : list.filter((t) => t.title.toLowerCase().includes(needle));
  }, [surface.conversations, query]);

  // The ROW's project first — at the root every row is a different one — and the surface's only as
  // the fallback for a list that is already inside a project.
  const open = (task: TaskSummary & { project?: string }): void =>
    surface.onOpen(task.taskId, task.project ?? surface.project ?? undefined);

  /**
   * Whether the newest thing this conversation said has been read.
   *
   * Compared against the row's own `updatedAt` rather than held as a flag, which is what makes it
   * self-clearing: a thread marked read stops being read the moment the agent says something else,
   * and nothing has to notice that and go clear anything. See {@link JairaUiState.seen}.
   */
  const unread = (task: TaskSummary): boolean => (surface.seen[task.taskId] ?? 0) < task.updatedAt;

  /**
   * Whether it is producing something RIGHT NOW.
   *
   * Two sources, because there are two ways a conversation speaks and only one of them is a run. The
   * opening message IS the run, so it moves the task's status; every message after it is a typed
   * turn, which deliberately moves nothing (`runChatMessage`) and is visible only in the journal.
   */
  const answering = (task: TaskSummary): boolean =>
    task.status === "running" || (surface.producing[task.taskId] ?? 0) > 0;

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
        <p className="empty">{query === "" ? "No conversations yet." : "Nothing matches."}</p>
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
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: "Open", onSelect: () => open(task) },
                    { label: "Rename…", onSelect: () => setRenaming({ taskId: task.taskId, title: task.title }) },
                    {
                      label: "Copy task id",
                      separator: true,
                      onSelect: () => void navigator.clipboard?.writeText(task.taskId),
                    },
                    {
                      label: "Delete…",
                      separator: true,
                      danger: true,
                      onSelect: () =>
                        setAsk({
                          title: `Delete "${task.title}"?`,
                          note: "This deletes the conversation and everything said in it. None of it comes back.",
                          confirmLabel: "Delete",
                          danger: true,
                          onConfirm: () => {
                            setAsk(null);
                            surface.onDelete([task.taskId], surface.project ?? undefined);
                          },
                        }),
                    },
                  ],
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
                    const title = renaming.title.trim();
                    if (title !== "" && title !== task.title) {
                      surface.onRename(task.taskId, title, surface.project ?? undefined);
                    }
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
                    title={unread(task) ? "The latest reply has not been read" : "Read"}
                  />
                  <span className="chat-row-title ellip">{task.title}</span>
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

/** `4 min`, `2 h`, `3 d` — a list of times, not a list of dates. */
function agoOf(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** The middle column: a conversation, or the offer to start one. */
export function ChatView({ surface }: { surface: ChatSurface }): JSX.Element {
  /*
   * Reading a conversation is what marks it read, and this is the only place that knows it is being
   * read: the list is in the sidebar and stays there whichever view is on screen, so a mark set from
   * the list would say "seen" about a thread nobody has looked at.
   *
   * It fires again every time the conversation moves — a new turn, a streamed answer settling — which
   * is the point rather than a cost: a thread you are watching should not go unread underneath you.
   * `markSeen` is monotonic and does nothing when the mark would not move, so the several calls a
   * second an answer produces cost one comparison each.
   */
  const { taskId, conversations, onSeen } = surface;
  useEffect(() => {
    if (taskId === null) return;
    const row = conversations.find((task) => task.taskId === taskId);
    if (row !== undefined) onSeen(row.taskId, row.updatedAt);
  }, [taskId, conversations, onSeen]);

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
    void invoke("chat:startPlan", { stateId: CHAT_AGENT, overrides, ...(project !== undefined ? { project } : {}) })
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
          {surface.hasProject
            ? "This conversation works in the open project — it asks before it runs or changes anything."
            : "No project is open, so this runs in JaiRA's own root. Open one to talk about your code."}
        </p>

        {surface.error !== null ? <p className="cx-error">{surface.error}</p> : null}

        <Composer
          plan={plan}
          busy={surface.busy}
          overrides={overrides}
          onOverrides={setOverrides}
          placeholder="Ask for a change, or a question about the code…"
          onSend={(message) => void surface.onNew(message, overrides)}
          {...mentions}
        />
      </div>
    </div>
  );
}

/**
 * The key of the side the thread is ON — the branch the record chain actually walks.
 *
 * Empty because it is not a session of its own: the kept side IS this conversation, and every other
 * side is named by the id it was left behind in. See {@link ChatPane}'s `split`.
 */
const KEPT = "";

/** What a side of a split is CALLED: the message that opens it, which is what was said differently. */
function labelForBranch(turns: readonly SessionTurn[], fallback: string): string {
  const opening = turns.find((turn) => turn.role === "user")?.text?.trim();
  if (opening === undefined || opening === "") return fallback;
  const line = opening.split("\n").find((l) => l.trim() !== "")?.trim() ?? fallback;
  return line.length <= 40 ? line : `${line.slice(0, 37).trimEnd()}…`;
}

/**
 * What a re-read is allowed to replace a thread WITH — and it is never nothing.
 *
 * This is the rule the whole view rests on, which is why it is a named function with a test rather
 * than a `??` inside a callback. A read that fails or answers `null` is a statement about a FETCH,
 * not about the conversation: the records are on disk either way, and there is no condition under
 * which turns that were on screen a moment ago stopped having been said. So an empty answer is only
 * ever accepted as the FIRST answer — before which there is nothing to lose — and after that the
 * last good thread stands until a better one arrives.
 *
 * Every path that can answer `null` was otherwise a path that blanked the transcript: an IPC hiccup,
 * a read racing a run that had just re-entered its snapshot, a projection one refresh stale, a
 * position that momentarily resolved to nothing. None of those is a reason to show somebody an empty
 * conversation.
 *
 * Scoped by the component's `key`, which is the task: opening another conversation mounts a new
 * component with an empty thread, so this can never show one conversation's turns under another's
 * name.
 */
export function kept(was: ChatThreadView | null, next: ChatThreadView | null): ChatThreadView | null {
  return next ?? was;
}

/**
 * One conversation: the thread, and the box under it.
 *
 * The thread is re-read whenever anything about the task changes — the detail and the journal are
 * both refreshed by the store on a `task` invalidation, so their identity moving is the signal that
 * something landed. The live tail is separate and arrives per fragment, which is what makes an
 * answer appear as it is written rather than when it is finished.
 */
function ChatThread({ surface }: { surface: ChatSurface }): JSX.Element {
  const taskId = surface.taskId!;
  const project = surface.project ?? undefined;
  const [thread, setThread] = useState<ChatThreadView | null>(null);
  const [plan, setPlan] = useState<ChatPlanView | null | undefined>(undefined);
  const [overrides, setOverrides] = useState<ChatSettings>({});
  /**
   * How many messages are in flight, and what they said.
   *
   * A COUNT and a LIST rather than a boolean and a slot, because a conversation takes more than one
   * message at a time: a reply sent mid-turn joins the turn in flight (`ChatLiveState.steerable`) or
   * queues behind it, so two can be outstanding at once. With one slot the second overwrote the
   * first, and with a boolean the composer went idle the moment either of them landed.
   */
  const [sending, setSending] = useState(0);
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Which message is being replaced, when one is — see `chat:send`'s `branchAt`. */
  const [editing, setEditing] = useState<{ at: string; was: string } | null>(null);
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
  /** The agent title a rename has already been asked for — see the effect that adopts it. */
  const asked = useRef<string | null>(null);

  /**
   * The tail that was streaming, held until the record that supersedes it has arrived.
   *
   * A turn's words reach the screen twice: as fragments while it runs, then as the record once it
   * lands. The handover was a gap — main drops the live turn on the settle event, the thread is
   * re-read over IPC, and between those two the answer is on the screen in neither form. On a turn
   * that was STOPPED it is not a flicker at all: the stored copy is a hair behind what was streamed,
   * so a person who pressed stop watched the last thing they read disappear.
   *
   * Cleared in the same update as the thread it was waiting for, never on its own — two separate
   * updates would put the turn on screen twice for a frame, which is the same bug wearing the other
   * face.
   */
  const [afterglow, setAfterglow] = useState<LiveTail | null>(null);
  useEffect(() => {
    if (surface.live !== null) setAfterglow(surface.live);
  }, [surface.live]);

  const read = useCallback(() => {
    void invoke("chat:thread", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((next) => {
        setThread((was) => kept(was, next));
        setAfterglow(null);
      })
      .catch(() => undefined);
  }, [taskId, project]);

  // Re-read on anything that means the record moved. `detail` and `journal` are re-fetched by the
  // store on every task invalidation, so their identity is the cheapest honest signal there is; the
  // live tail is in the dependency list too, so the thread lands the moment a turn settles rather
  // than one interaction later.
  useEffect(read, [read, surface.detail, surface.journal, surface.live === null]);

  // The plan is re-asked whenever the settings change or a message lands, because it reports what
  // WOULD run — and after a turn that includes which model actually answered the last one.
  useEffect(() => {
    const instanceId = thread?.instanceId;
    if (instanceId === undefined) return;
    let live = true;
    void invoke("chat:plan", { taskId, instanceId, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [taskId, project, overrides, thread]);

  /**
   * Take the agent's own name for this conversation, once it has one.
   *
   * A conversation is born named after its first line, which is the best guess available before
   * anybody has answered and a poor one afterwards — "look at the failing test" names half the list.
   * The agent writes a title into its session file a few turns in, that lands in the record, and this
   * is where it becomes the name in the sidebar.
   *
   * Only while the conversation is still carrying the name it was born with. A title somebody typed
   * is a decision, and an agent that renamed it back on the next turn would be overruling them once
   * per message. Checked by RECOMPUTING the birth name from the opening message rather than by
   * storing a flag: the same rule, and nothing extra to keep in sync.
   *
   * The ref is only to keep a rename from being asked for twice while the first is in flight — the
   * guard above closes for good the moment the new title lands.
   */
  const title = surface.conversations.find((task) => task.taskId === taskId)?.title;
  useEffect(() => {
    const agent = agentTitleOf(thread?.session);
    if (agent === undefined || title === undefined || agent === title || asked.current === agent) return;
    const opened = thread?.session.turns.find((turn) => turn.role === "user")?.text ?? "";
    if (title !== titleOf(opened)) return;
    asked.current = agent;
    surface.onRename(taskId, agent, project);
    // On the thread and the current name, not on `surface` — the shell rebuilds that object every
    // render, and re-walking the record's native lines on each one to reach the same answer is work
    // nobody asked for. Every input this reads that can CHANGE is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, title, taskId, project]);

  const send = (message: string): void => {
    const instanceId = thread?.instanceId;
    if (instanceId === undefined) return;
    setSending((n) => n + 1);
    setSent((was) => [...was, message]);
    setError(null);
    const at = editing?.at;
    setEditing(null);
    // Sending re-pins. Typing into the box is the clearest possible statement that the live edge is
    // where you are, whatever you had scrolled up to read while composing.
    jump();
    void invoke("chat:send", {
      taskId,
      instanceId,
      message,
      overrides,
      ...(project !== undefined ? { project } : {}),
      ...(at !== undefined ? { branchAt: at } : {}),
    })
      .then((result) => setError(result.failure ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setSending((n) => Math.max(0, n - 1));
        // Re-read through the same reader as everything else — including its rule about never
        // answering with less than there was — and let the RECORD decide when the message stops
        // being pending (see the effect below). Dropping it here was right while a send lasted the
        // whole turn and wrong the moment one could join a turn in flight: a steered send returns
        // immediately, long before the turn it joined has written anything down, so the message
        // would blink off the screen and come back a minute later.
        read();
      });
  };

  /**
   * A message stops being pending when the conversation holds it — whoever put it there.
   *
   * The comparison is against the thread rather than against the send that produced it, because the
   * two no longer coincide: a steered message is part of somebody else's turn, and a stopped one is
   * recovered from its record's request. Both land in the same place, and this is that place.
   */
  useEffect(() => {
    const turns = thread?.session.turns ?? [];
    if (turns.length === 0) return;
    setSent((was) => {
      const left = was.filter((m) => !turns.some((turn) => turn.role === "user" && turn.text === m));
      return left.length === was.length ? was : left;
    });
  }, [thread]);

  const running = surface.detail?.status === "running";

  /**
   * Stop whatever is actually going, which is two different things.
   *
   * The FIRST message of a conversation is a run — that is what makes a conversation a task — so
   * while the task is running the thing to abort is the run, and `chat:cancel` has nothing
   * registered to reach. Every message after it is a chat turn, which is not a run and which
   * `task:cancel` in turn knows nothing about. One button, and it has to pick.
   */
  const stop = (): void => {
    if (running) {
      surface.onCancelRun(taskId, project);
      return;
    }
    void invoke("chat:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  };
  /**
   * The thread, woven with the journal and whatever is streaming right now.
   *
   * Built even with NO thread, which is the case that matters most: the opening message is a run,
   * and its record does not exist until the call settles — so for the length of the first answer the
   * live tail is the only thing there is to show. Passing a null session here is exactly what
   * `entriesOf` takes it for.
   */
  /**
   * What lets an artifact in this conversation RUN, and where a message from one lands.
   *
   * Built here because this is the first place that has all three things a grant needs: the task the
   * artifact belongs to, the project whose map holds it, and a composer for the bridge to write into.
   *
   * `onPrompt` FILLS the box rather than sending. A page a model wrote posting straight into the run
   * that produced it is a different kind of thing from rendering, and the difference is a person
   * reading the words first — so this ends at `setDraft`, and Enter is still somebody's decision.
   */
  const artifacts = useMemo(
    () => ({
      serve: (path: string) => invoke("artifact:serve", { taskId, path, ...(project !== undefined ? { project } : {}) }),
      onPrompt: (text: string) => setDraft(text),
    }),
    [taskId, project],
  );

  const entries = useMemo(() => {
    /**
     * The messages that have been sent and are not in the record yet, shown as the turns they are
     * about to be.
     *
     * A record lands when its call settles, so between pressing Enter and the answer arriving there
     * is nothing on disk holding what was typed — and a chat that swallows your message for thirty
     * seconds while an agent thinks is a chat you send twice. Dropped the moment the record contains
     * one, which is a comparison against the thread rather than a timer. Handed to `entriesOf` rather
     * than appended after it, so they land above the answer they provoked instead of under it.
     */
    const outstanding = surface.opening === null ? sent : [surface.opening, ...sent];
    const turns = thread?.session.turns ?? [];
    const pending = outstanding.filter((text) => !turns.some((turn) => turn.role === "user" && turn.text === text));
    return entriesOf(
      thread?.session ?? null,
      journalFor(surface.journal?.turns ?? [], thread?.session.stateId),
      // The tail that is arriving, or the one that just stopped arriving and has not been replaced
      // by its record yet — see `afterglow`.
      surface.live ?? afterglow,
      pending,
    );
  }, [thread, surface.journal, surface.live, afterglow, surface.opening, sent]);

  /**
   * What the model is doing right now — read off exactly what is being rendered.
   *
   * `running` is the task's own status rather than "the tail is not empty", because a tail outlives
   * the run that made it by a beat (see `afterglow`), and a bar that read the leftovers would keep
   * announcing a finished turn until the record landed.
   */
  const status = useMemo(
    () => liveStatusOf(entries, surface.live ?? afterglow, running),
    [entries, surface.live, afterglow, running],
  );

  /** Turn index → the position a replacement is sent at. Built once per thread, read per message. */
  const points = useMemo(() => new Map((thread?.points ?? []).map((p) => [p.turn, p.at] as const)), [thread]);

  /**
   * The thread, cut at each place it divided, with the sides of each division beside it.
   *
   * ONE fork is handled — the newest, which is the one a reader is looking at. A conversation edited
   * three times has three, nested inside each other on the branch that was kept, and drawing them
   * all means a tab row inside a tab row inside a tab row for a case nobody has yet had. The newest
   * seam is the one that just moved, and it is the one the person is asking about.
   *
   * Split by TURN index, which every message entry carries: the entries are a weave — journal facts,
   * native lines, live fragments — so their order says nothing about conversation position, and only
   * the ones the record supplied can be placed. Everything before the first entry at or past the
   * seam is shared; the rest is the kept side.
   */
  const split = useMemo(() => {
    const fork = (thread?.forks ?? []).at(-1);
    if (fork === undefined || thread === null) return null;
    const cut = entries.findIndex((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= fork.turn);
    if (cut < 0) return null;
    const kept = entries.slice(cut);
    return {
      shared: entries.slice(0, cut),
      /**
       * OLDEST FIRST, which is what makes "2 of 2" a true sentence.
       *
       * `forks` reports the sides left behind in the order they were created — the parent's own tail
       * first, then any sibling that branched from the same position — and the side the path is on
       * is the newest of them, because it is the edit that was just made. So the kept one goes last,
       * and the mark's count reads as the attempt number it is.
       */
      branches: [
        ...fork.left.map((branch) => ({
          key: branch.sessionId,
          label: labelForBranch(branch.turns, "what was replaced"),
          // Rendered through the SAME viewer as the thread it sits beside, over a session that
          // carries this branch's turns. A second renderer for "the other side" would be a second
          // answer to what a conversation looks like.
          entries: entriesOf({ ...thread.session, turns: [...branch.turns] }, [], null),
        })),
        { key: KEPT, label: labelForBranch(thread.session.turns.slice(fork.turn), "this conversation"), entries: kept },
      ],
    };
  }, [entries, thread]);
  /** Which side of the newest split is being read. The kept one until somebody says otherwise. */
  const [branch, setBranch] = useState(KEPT);
  // The fallback is the KEPT side by name rather than the first entry: the sides are in the order
  // they happened now, so `branches[0]` is the oldest thing the conversation said and landing there
  // by accident would mean opening a chat on a branch nobody is having.
  const shown = split?.branches.find((b) => b.key === branch) ?? split?.branches.find((b) => b.key === KEPT);
  /** Replacing a message: the same offer on either transcript, so it is stated once. */
  const edit = useMemo(
    () => ({
      can: (turn: number) => points.has(turn),
      edit: (turn: number, text: string) => {
        setEditing({ at: points.get(turn)!, was: text });
        setDraft(text);
      },
      /**
       * The same fork, with the box left empty.
       *
       * `editing` still carries the words that were there, because the banner above the composer
       * names the message being replaced and that is as true of a rewind as of an edit. What changes
       * is only the draft. Rewinding is not "say that again" — it is "everything from here was a
       * wrong turn", and prefilling the wrong turn is the one thing that makes it hard to leave.
       */
      rewind: (turn: number, text: string) => {
        setEditing({ at: points.get(turn)!, was: text });
        setDraft("");
      },
    }),
    [points],
  );

  return (
    <div className="chat-thread">
      <ArtifactsPanel
        taskId={taskId}
        project={project}
        artifacts={artifacts}
        // What this conversation has SAID is the cheapest proxy for "it may have produced something":
        // a turn arrived, so the map may have moved. Cheaper than polling and honest enough — the
        // list is metadata, and a refetch that finds nothing new costs one query.
        signal={entries.length}
      />
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
        <Paper>
          <Transcript
            session={thread?.session ?? null}
            entries={split === null ? entries : split.shared}
            // The live tail belongs to the END of the conversation, so it rides with whatever is
            // showing there — and a reader looking at the side that was replaced is not looking at
            // where a turn is arriving.
            {...(split === null || shown?.key === KEPT ? { live: surface.live ?? afterglow } : {})}
            empty={running ? "Working…" : "This conversation has not said anything yet."}
            artifacts={artifacts}
            onEdit={edit}
            // The conversation is what a type correction belongs to — see `messageTypes.ts`. The
            // replaced branch below deliberately gets none: it is off the path, and a preference
            // keyed to a message nobody can reach again is a preference nobody can clear.
            scope={taskId}
            {...(status !== null ? { narrated: true } : {})}
          />
        </Paper>
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
                {...(shown.key === KEPT ? { live: surface.live ?? afterglow } : {})}
                artifacts={artifacts}
                // Only on the side that is still being had. A message on the other side cannot be
                // replaced from here: it is not where this conversation ends, and "edit" means fork
                // from a position, which that side no longer holds.
                {...(shown.key === KEPT ? { onEdit: edit } : {})}
                {...(status !== null && shown.key === KEPT ? { narrated: true } : {})}
              />
            </Paper>
          </>
        ) : null}
      </div>

      {/* Between the conversation and the box: the live state is neither part of the record above it
          nor part of the message being composed below, and it is the one line whose position must
          not depend on how much has happened. */}
      {status !== null ? <LiveStatusBar status={status} {...(away ? { onJump: jump } : {})} /> : null}

      <div className="chat-foot">
        {editing !== null ? (
          // Said plainly, above the box, because it changes what pressing Enter MEANS: the message
          // will not be added to the end of this conversation, it will take another one's place.
          <div className="chat-editing">
            <span className="ellip">
              Replacing “{editing.was.split("\n")[0]?.slice(0, 60)}” — everything after it is left behind.
            </span>
            <button
              className="ghost"
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}
        {error !== null ? <p className="cx-error">{error}</p> : null}
        <Composer
          plan={plan ?? null}
          busy={sending > 0 || running}
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
          placeholder={editing !== null ? "Say this instead…" : "Reply…"}
          {...(plan === null && thread === null ? { disabled: "This conversation cannot be continued." } : {})}
          {...mentions}
        />
      </div>
    </div>
  );
}

/**
 * The composer's two project-file props, or neither.
 *
 * Neither with no project open: `@` would complete against a project that is not there, and the
 * completion would answer "no project is open" per keystroke. A conversation in JaiRA's own root
 * still works — it simply has nothing to mention.
 *
 * Both NAME the project rather than letting main resolve one. `$PROJECT` and a file search are
 * project-scoped calls, and an unnamed one answers only while exactly one user project is open — so
 * with a second checkout open every keystroke of a mention answered "several projects are open, so
 * this call must name one" instead of completing.
 */
function useMentions(hasProject: boolean, project: string | undefined): {
  mentions?: (query: string) => Promise<string[]>;
  readMention?: (path: string) => Promise<string>;
} {
  return useMemo(() => {
    if (!hasProject) return {};
    const where = project !== undefined ? { project } : {};
    return {
      mentions: (query: string) =>
        invoke("file:find", { query, limit: 20, ...where })
          .then((found) => found.paths)
          .catch(() => []),
      readMention: (path: string) =>
        invoke("uri:read", { uri: `$PROJECT/${path}`, ...where }).then((content) => content.text),
    };
  }, [hasProject, project]);
}

/**
 * Which project the Chat view reads and writes — the rule, so it can be stated once and tested.
 *
 * **A chat call always names its project.** Left unnamed, main resolves "the focused project", and
 * that answers only while exactly one user project is open: it throws `no project is open` on a
 * window standing on `~/.jaira` — a shared session is not a user one — and `several projects are
 * open, so this call must name one` the moment a second checkout is, which is the arrangement this
 * shell exists for. Every read the view makes went through that resolution: the thread, the artifact
 * list, the plan the composer shows before the first message, and the `@` completion per keystroke.
 *
 * Three answers, in order:
 *
 *  - the OPEN conversation's own project. It is what `openConversation` was already being told and
 *    what nothing was reading, so a thread opened from the root list — which spans every project —
 *    was read out of whichever database main resolved rather than the one holding it.
 *  - the project the address is standing on: where a new conversation goes, and what the composer's
 *    plan is read from.
 *  - the shared root at the root of the address, where there is no project to stand in. The same
 *    rule `runTargetOf` gives base-layer workflows, and the one project that means the same thing in
 *    every window.
 */
export function chatProjectOf(open: string | null, at: string | null): string {
  return open ?? at ?? SHARED_SESSION;
}

/** Which of a project's tasks are conversations — the list the drawer shows. */
export function conversationsOf(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter((task) => isChatWorkflow(task.workflow));
}
