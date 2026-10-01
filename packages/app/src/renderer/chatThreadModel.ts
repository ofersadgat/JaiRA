/**
 * One conversation's STATE, as `ChatThread.tsx`'s `ChatThread` holds it — the thread read from the record,
 * the plan the composer shows, what is in flight, the draft, the armed edit, and everything derived from
 * them (the entries, the live status, the split and the seam, the cuts). No DOM here: scrolling is the
 * host's, reached through `jump`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ApprovalScope, ChatPlanView, ChatSettings, ChatThreadView, SessionTurn } from "@jaira/shared/browser";
import { useKeptDraft } from "./composerDrafts";
import { titleOf } from "./chatWorkflow";
import type { ChatSurface } from "./chatSurface";
import type { ApprovalAnswerExtras } from "./approvalSurfaceTypes";
import { useWaiting } from "./limitsStore";
import { invoke } from "./store";
import { agentTitleOf, entriesOf, journalFor, liveStatusOf, type LiveTail } from "./transcript";
import { approvalCallIndex } from "./approvalCall";

/**
 * What the box is ARMED for beyond a reply — see `EditMessage`.
 *
 * An edit sends in another message's place; a fork sends into a new conversation; a rewind sends
 * nothing at all and deletes when the banner's button is pressed. One state rather than three,
 * because they share the banner above the box and the box itself, and only one can be meant.
 * `from` is the first turn a cut would take, which is what the transcript fades from.
 */
export type Arming =
  | { kind: "edit"; at: string; was: string }
  | { kind: "rewind"; seq: number; from: number; was: string; side: "before" | "after" }
  | { kind: "fork"; seq: number; from: number; was: string; side: "before" | "after" };

/**
 * The key of the side the thread is ON — the branch the record chain actually walks.
 *
 * Empty because it is not a session of its own: the kept side IS this conversation, and every other
 * side is named by the id it was left behind in. See the `split` below.
 */
export const KEPT = "";

/** What a side of a split is CALLED: the message that opens it, which is what was said differently. */
export function labelForBranch(turns: readonly SessionTurn[], fallback: string): string {
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

/** The banner's name for the message a cut stands at — its first line, kept short. */
export function namedMessage(was: string): string {
  return `“${was.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 60) ?? ""}”`;
}

/** What the banner over the box says while something is armed — see {@link Arming}. */
export function armingText(arming: Arming): string {
  if (arming.kind === "edit") return `Replacing ${namedMessage(arming.was)} — everything after it is left behind.`;
  if (arming.kind === "fork")
    return `Forking ${arming.side === "before" ? "before" : "after"} ${namedMessage(arming.was)} — your next message starts a new conversation from there. This one is not changed.`;
  return `Rewind to ${arming.side === "before" ? "before" : ""} ${namedMessage(arming.was)} — the messages after it are deleted. This cannot be undone.`;
}

/** What the empty box says: a reply, or what an armed edit or fork will send. */
export function replyPlaceholder(arming: Arming | null): string {
  return arming?.kind === "edit" ? "Say this instead…" : arming?.kind === "fork" ? "Start the new conversation with…" : "Reply…";
}

/**
 * Everything one conversation holds and derives — what `ChatThread` draws.
 * `jump` is the host's "scroll to the live edge", called when a message is sent.
 */
export function useChatThread(surface: ChatSurface, jump: MutableRefObject<() => void>) {
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
  // Kept per conversation, so leaving it and coming back finds what was being typed.
  const [draft, setDraft] = useKeptDraft(`chat:${taskId}`);
  /** Which message is being replaced, when one is — see `chat:send`'s `branchAt`. */
  const [arming, setArming] = useState<Arming | null>(null);
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
    const armed = arming;
    setArming(null);
    setError(null);
    if (armed?.kind === "fork") {
      // The message starts the NEW conversation — see "task:fork" — and the shell opens it, so this
      // thread has nothing to show for it and nothing pending to keep.
      setSending((n) => n + 1);
      void surface.onFork(taskId, armed.seq, message, overrides, project).finally(() => setSending((n) => Math.max(0, n - 1)));
      return;
    }
    setSending((n) => n + 1);
    setSent((was) => [...was, message]);
    const at = armed?.kind === "edit" ? armed.at : undefined;
    // Sending re-pins. Typing into the box is the clearest possible statement that the live edge is
    // where you are, whatever you had scrolled up to read while composing.
    jump.current();
    void invoke("chat:send", {
      taskId,
      instanceId,
      message,
      overrides,
      ...(project !== undefined ? { project } : {}),
      ...(at !== undefined ? { branchAt: at } : {}),
    })
      .then((result) => {
        // WAITING for the allowance: held until the reset (drawn from the waiting list below, not as
        // a pending turn), or refused for it — then the refusal's own line, with "Try again at …",
        // says so instead of an error.
        if (result.waiting !== undefined) {
          if (result.waiting.state === "waiting") setSent((was) => was.filter((m, k) => k !== was.lastIndexOf(message)));
          setError(null);
          return;
        }
        setError(result.failure ?? null);
      })
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
   * Whether the conversation is speaking right now — the run, or a chat turn. Only the opening message
   * moves the task's status; every message after it is a turn that moves nothing but the journal, so
   * `running` alone drew every later turn as already finished while its call was still going: no
   * rows, no pulse, a running call reading "no result was recorded". The sidebar's spinner has always
   * asked both (`answering` in the list); what is drawn live asks the same.
   */
  const answering = running || (surface.producing[taskId] ?? 0) > 0;
  /** This conversation's messages waiting for the allowance — held, or refused and set to try again. */
  const waitingHere = useWaiting().filter((item) => item.kind === "message" && item.taskId === taskId);
  /** How full the conversation is: the reading on its last answer. */
  const lastContext = useMemo(() => [...(thread?.session.turns ?? [])].reverse().find((turn) => turn.context !== undefined)?.context, [thread]);
  /** Compact now — the agent's own `/compact`, which only a claude agent takes. */
  const model = plan?.effective.model ?? "";
  const onCompact = /^claude-(cli|code)\//.test(model) ? (focus?: string) => send(focus !== undefined ? `/compact ${focus}` : "/compact") : undefined;

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
   * `answering` is the journal's word rather than "the tail is not empty", because a tail outlives
   * the run that made it by a beat (see `afterglow`), and a bar that read the leftovers would keep
   * announcing a finished turn until the record landed.
   */
  const status = useMemo(() => liveStatusOf(entries, surface.live ?? afterglow, answering), [entries, surface.live, afterglow, answering]);

  /**
   * The approval, as the step it is: when the conversation holds its call (`approve_tool_call`, made by
   * the call that needs permission), the work summary draws its prompt in the step's own row. Drawn
   * under the page only when the conversation does not hold it — an ask from before the record had
   * anywhere to put it. Keyed on the request, so a second one starts with nothing lit.
   */
  const askValue = useMemo(
    () =>
      surface.approval !== undefined && surface.onApproval !== undefined
        ? {
            pending: surface.approval,
            onDecide: (decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => surface.onApproval!(surface.approval!.requestId, decision, scope, extras),
          }
        : undefined,
    [surface.approval, surface.onApproval],
  );
  const approvalInThread = surface.approval !== undefined && approvalCallIndex(entries as never, surface.approval.requestId) >= 0;

  /** Turn index → the position a replacement is sent at. Built once per thread, read per message. */
  const points = useMemo(() => new Map((thread?.points ?? []).map((p) => [p.turn, p.at] as const)), [thread]);
  /**
   * The CUTS the thread offers, by the turn each begins at — the messages whose turn the journal
   * names (see `ChatEditPoint.seq`), in order. A message is cut BEFORE itself; a reply is cut
   * AFTER, which is the same point as before the next message.
   */
  const cuts = useMemo(
    () =>
      (thread?.points ?? [])
        .filter((p): p is typeof p & { seq: number } => p.seq !== undefined)
        .map((p) => ({ turn: p.turn, seq: p.seq }))
        .sort((a, b) => a.turn - b.turn),
    [thread],
  );
  const cutAt = useCallback(
    (turn: number): { seq: number; from: number; side: "before" | "after" } | undefined => {
      const own = cuts.find((c) => c.turn === turn);
      if (own !== undefined) return { seq: own.seq, from: own.turn, side: "before" };
      const next = cuts.find((c) => c.turn > turn);
      return next === undefined ? undefined : { seq: next.seq, from: next.turn, side: "after" };
    },
    [cuts],
  );
  /**
   * Where this conversation was FORKED FROM, drawn as a seam between the shared part and its own.
   *
   * The boundary is a journal position; the first message whose turn begins past it is the first
   * this conversation said for itself. Absent for the ordinary conversation, and set aside while an
   * edit's split is showing — two seams in one thread is a case nobody has had.
   */
  const origin = thread?.origin;
  const seam = useMemo(() => {
    if (thread === null || origin === undefined) return null;
    const firstOwn = cuts.find((c) => c.seq > origin.boundary)?.turn;
    const cut = firstOwn === undefined ? -1 : entries.findIndex((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= firstOwn);
    return cut < 0 ? { shared: entries, own: [] } : { shared: entries.slice(0, cut), own: entries.slice(cut) };
  }, [thread, origin, cuts, entries]);

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
    const keptSide = entries.slice(cut);
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
        { key: KEPT, label: labelForBranch(thread.session.turns.slice(fork.turn), "this conversation"), entries: keptSide },
      ],
    };
  }, [entries, thread]);
  /** Which side of the newest split is being read. The kept one until somebody says otherwise. */
  const [branch, setBranch] = useState(KEPT);
  // The fallback is the KEPT side by name rather than the first entry: the sides are in the order
  // they happened now, so `branches[0]` is the oldest thing the conversation said and landing there
  // by accident would mean opening a chat on a branch nobody is having.
  const shown = split?.branches.find((b) => b.key === branch) ?? split?.branches.find((b) => b.key === KEPT);
  /** Replacing, cutting and forking: the same offer on either transcript, so it is stated once. */
  const edit = useMemo(
    () => ({
      can: (turn: number) => points.has(turn),
      edit: (turn: number, text: string) => {
        setArming({ kind: "edit", at: points.get(turn)!, was: text });
        setDraft(text);
      },
      cut: (turn: number) => cutAt(turn)?.side,
      /**
       * ARMS a deletion: the transcript fades what would go and the banner asks. Nothing is typed
       * for a rewind — the box empties so what is said next is said after the cut, not instead of
       * anything — and nothing happens until the banner's button is pressed.
       */
      rewind: (turn: number, text: string) => {
        const cut = cutAt(turn);
        if (cut === undefined) return;
        setArming({ kind: "rewind", seq: cut.seq, from: cut.from, was: text, side: cut.side });
        setDraft("");
      },
      /** Arms the box: the next message starts a new conversation that shares everything before the cut. */
      fork: (turn: number, text: string) => {
        const cut = cutAt(turn);
        if (cut === undefined) return;
        setArming({ kind: "fork", seq: cut.seq, from: cut.from, was: text, side: cut.side });
        setDraft("");
      },
    }),
    [points, cutAt],
  );
  /** What the transcript fades: everything from the cut an armed rewind would take. */
  const doomedFrom = arming?.kind === "rewind" ? arming.from : undefined;
  const confirmRewind = (): void => {
    if (arming?.kind !== "rewind") return;
    const { seq } = arming;
    setArming(null);
    void surface.onRewind(taskId, seq, project).then(read);
  };
  /** The banner's Cancel: nothing armed, and the box emptied of what the arming put there. */
  const disarm = (): void => {
    setArming(null);
    setDraft("");
  };

  return {
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
  };
}

export type ChatThreadModel = ReturnType<typeof useChatThread>;

/**
 * Reading a conversation is what marks it read, and the Chat view is the only place that knows it is
 * being read: the list is in the sidebar and stays there whichever view is on screen, so a mark set
 * from the list would say "seen" about a thread nobody has looked at.
 *
 * It fires again every time the conversation moves — a new turn, a streamed answer settling — which
 * is the point rather than a cost: a thread you are watching should not go unread underneath you.
 * `markSeen` is monotonic and does nothing when the mark would not move, so the several calls a
 * second an answer produces cost one comparison each.
 */
export function useReadMark(surface: Pick<ChatSurface, "taskId" | "conversations" | "onSeen">): void {
  const { taskId, conversations, onSeen } = surface;
  useEffect(() => {
    if (taskId === null) return;
    const row = conversations.find((task) => task.taskId === taskId);
    if (row !== undefined) onSeen(row.taskId, row.updatedAt);
  }, [taskId, conversations, onSeen]);
}
