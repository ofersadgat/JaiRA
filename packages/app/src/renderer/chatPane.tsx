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
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  ChatPlanView,
  ChatSettings,
  ChatThreadView,
  ConversationView,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared/browser";
import { Composer } from "./composer";
import { CHAT_AGENT, isChatWorkflow, titleOf } from "./chatWorkflow";
import { ContextMenu, AskDialog, type AskSpec, type MenuAnchor } from "./menu";
import { agentTitleOf, entriesOf, journalFor, type LiveTail } from "./transcript";
import { Paper, Transcript } from "./transcriptView";
import { invoke } from "./store";

/** What the Chat view needs from the shell. Assembled in `App.tsx`, like every other pane's. */
export interface ChatSurface {
  /** Every conversation this window can show — already filtered to the chat workflows. */
  conversations: TaskSummary[];
  /** The open one, and the project it belongs to. */
  taskId: string | null;
  project: string | null;
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
  onOpen: (taskId: string | null, project?: string) => void;
  /** Start one. The settings are the composer's, and reach the first message by riding its run. */
  onNew: (message: string, overrides?: ChatSettings) => Promise<string | null>;
  onRename: (taskId: string, title: string, project?: string) => void;
  onDelete: (taskIds: readonly string[], project?: string) => void;
  /** Stop the RUN — what the first message is. Later messages are turns, and `chat:cancel` stops those. */
  onCancelRun: (taskId: string, project?: string) => void;
}

/**
 * The conversation list — the Chat row's drawer in the sidebar.
 *
 * Newest first, because a conversation you are having is a conversation you had a moment ago. The
 * search box appears once there are enough of them to be worth searching; below that it is a control
 * offering to filter a list you can see all of.
 */
export function ChatListPanel({ surface }: { surface: ChatSurface }): JSX.Element {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const [renaming, setRenaming] = useState<{ taskId: string; title: string } | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = [...surface.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    return needle === "" ? list : list.filter((t) => t.title.toLowerCase().includes(needle));
  }, [surface.conversations, query]);

  const open = (task: TaskSummary): void => surface.onOpen(task.taskId, surface.project ?? undefined);

  return (
    <div className="chat-list">
      <button className="chat-new" onClick={() => surface.onOpen(null)}>
        <span className="chat-new-mark">+</span> New conversation
      </button>

      {surface.conversations.length > 6 ? (
        <input
          className="chat-search"
          value={query}
          placeholder="Search conversations"
          onChange={(e) => setQuery(e.target.value)}
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
                  <span className="chat-row-title ellip">{task.title}</span>
                  <span className={`chat-row-when sub${task.status === "running" ? " chat-row-live" : ""}`}>
                    {task.status === "running" ? "…" : agoOf(task.updatedAt)}
                  </span>
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
  const mentions = useMentions(surface.hasProject);
  const project = surface.project ?? undefined;

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
  const [sending, setSending] = useState(false);
  /** The message in flight, shown in the thread before the record that holds it exists. */
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Which message is being replaced, when one is — see `chat:send`'s `branchAt`. */
  const [editing, setEditing] = useState<{ at: string; was: string } | null>(null);
  const mentions = useMentions(surface.hasProject);
  const foot = useRef<HTMLDivElement | null>(null);
  /** The agent title a rename has already been asked for — see the effect that adopts it. */
  const asked = useRef<string | null>(null);

  const read = useCallback(() => {
    void invoke("chat:thread", { taskId, ...(project !== undefined ? { project } : {}) })
      .then(setThread)
      .catch(() => setThread(null));
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

  // Pinned to the bottom, the way every chat client is: what was just said is what you are reading.
  useEffect(() => {
    foot.current?.scrollIntoView({ block: "end" });
  }, [thread, surface.live]);

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
    setSending(true);
    setSent(message);
    setError(null);
    const at = editing?.at;
    setEditing(null);
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
        setSending(false);
        // Kept until the re-read lands, so the message does not blink out of the thread in the gap
        // between the turn settling and the record being read back.
        void invoke("chat:thread", { taskId, ...(project !== undefined ? { project } : {}) })
          .then((next) => {
            setThread(next);
            setSent(null);
          })
          .catch(() => setSent(null));
      });
  };

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
  const entries = useMemo(() => {
    /**
     * The message that has been sent and is not in the record yet, shown as the turn it is about to
     * be.
     *
     * A record lands when its call settles, so between pressing Enter and the answer arriving there
     * is nothing on disk holding what was typed — and a chat that swallows your message for thirty
     * seconds while an agent thinks is a chat you send twice. Dropped the moment the record contains
     * it, which is a comparison against the thread rather than a timer. Handed to `entriesOf` rather
     * than appended after it, so it lands above the answer it provoked instead of under it.
     */
    const pending = sent ?? surface.opening;
    const already =
      pending === null || (thread?.session.turns ?? []).some((turn) => turn.role === "user" && turn.text === pending);
    return entriesOf(
      thread?.session ?? null,
      journalFor(surface.journal?.turns ?? [], thread?.session.stateId),
      surface.live,
      already ? undefined : pending!,
    );
  }, [thread, surface.journal, surface.live, surface.opening, sent]);
  /** Turn index → the position a replacement is sent at. Built once per thread, read per message. */
  const points = useMemo(() => new Map((thread?.points ?? []).map((p) => [p.turn, p.at] as const)), [thread]);

  return (
    <div className="chat-thread">
      <div className="chat-scroll scroll">
        <Paper>
          <Transcript
            session={thread?.session ?? null}
            entries={entries}
            live={surface.live}
            empty={running ? "Working…" : "This conversation has not said anything yet."}
            onEdit={{
              can: (turn) => points.has(turn),
              edit: (turn, text) => {
                setEditing({ at: points.get(turn)!, was: text });
                setDraft(text);
              },
            }}
          />
        </Paper>
        <div ref={foot} />
      </div>

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
          busy={sending || running}
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
 */
function useMentions(hasProject: boolean): {
  mentions?: (query: string) => Promise<string[]>;
  readMention?: (path: string) => Promise<string>;
} {
  return useMemo(() => {
    if (!hasProject) return {};
    return {
      mentions: (query: string) =>
        invoke("file:find", { query, limit: 20 })
          .then((found) => found.paths)
          .catch(() => []),
      readMention: (path: string) => invoke("uri:read", { uri: `$PROJECT/${path}` }).then((content) => content.text),
    };
  }, [hasProject]);
}

/** Which of a project's tasks are conversations — the list the drawer shows. */
export function conversationsOf(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter((task) => isChatWorkflow(task.workflow));
}
