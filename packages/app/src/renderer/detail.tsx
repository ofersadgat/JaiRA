/**
 * The task panel and the conversation viewer (DESIGN §11.1).
 *
 * Both views show these: Tasks puts the task panel in its right-hand column permanently, and Files
 * swaps its inspector onto it the moment you click a card. One component, so the two never drift
 * into describing the same task differently.
 */
import type { JSX, ReactNode } from "react";
import type { ConversationView, InstanceNode, TaskDetail } from "@jaira/shared/browser";
import { Badge } from "./board";
import { Icon } from "./icons";
import { RunIndex } from "./runIndex";
import { stoppedAction } from "./taskAction";

/**
 * What a task IS: its name, where it came from, and the two buttons that operate it.
 *
 * Its own component because it is the one part of the panel that every reading of a task needs —
 * the details below it and the conversation that replaces them are both about a task you have to be
 * able to name and to cancel, and a header duplicated once per reading is a header that stops
 * agreeing with itself.
 */
export function TaskHead({
  detail,
  onStart,
  onCancel,
  onOpenState,
  onReviewChanges,
  children,
}: {
  detail: TaskDetail;
  onStart: () => void;
  onCancel: () => void;
  onOpenState?: (stateId: string) => void;
  /** Review the worktree's edits as a changeset (CHANGESETS.md). Offered only when there is one. */
  onReviewChanges?: () => void;
  /** Anything the reading wants beside the buttons — the toggle between two of them. */
  children?: ReactNode;
}): JSX.Element {
  const deepest = detail.activePath[detail.activePath.length - 1];
  const action = stoppedAction(detail);
  return (
    <header>
      <h2>
        <Badge status={detail.status} /> {detail.title}
      </h2>
      <div className="sub">
        {detail.taskId} · {detail.workflow}
        {detail.snapshotHash ? ` · snapshot ${detail.snapshotHash.slice(0, 12)}` : ""}
      </div>
      {detail.branch ? (
        // Branch binding + the worktree the run executes in (DESIGN §9.2).
        <div className="sub" title={detail.worktreePath ?? ""}>
          ⎇ {detail.branch}
          {detail.worktreePath ? ` · ${detail.worktreePath}` : " · worktree pending"}
        </div>
      ) : null}
      {detail.origin !== undefined ? (
        // Where a FORK came from, on the line the task's own facts are on. The seam in the
        // conversation is where the link is; this is the head saying the same thing in words.
        <div className="sub" title={`forked from ${detail.origin.taskId}`}>
          <Icon name="choice" className="sub-glyph" /> forked from {detail.origin.title ?? "a task since deleted"}, {detail.origin.label}
        </div>
      ) : null}
      <div className="actions">
        {/* The verb the STRIP would use for this task, so the two buttons cannot promise different
            things about one task — `stoppedAction` reads the main process's plan, which is also what
            decides what the click does (see `App.startAgain`). It says nothing about a task that
            finished or is still going, and a finished one is copied, which is what "Re-run" means. */}
        <button onClick={onStart} title={action?.hint ?? ""}>
          {action?.verb ?? (detail.runs.length > 0 ? "Re-run" : "Start")}
        </button>
        <button onClick={onCancel} className="ghost">
          Cancel
        </button>
        {onOpenState && deepest ? (
          <button className="ghost" onClick={() => onOpenState(deepest.stateId)} title={deepest.stateId}>
            Open state ↗
          </button>
        ) : null}
        {onReviewChanges && detail.worktreePath ? (
          // The flagship changeset flow: diff the worktree against its HEAD and walk the changes
          // through the gate. The reviewer arrives as a pending interaction moments later.
          <button className="ghost" onClick={onReviewChanges}>
            Review changes
          </button>
        ) : null}
        {children}
      </div>
    </header>
  );
}

/**
 * One task: what it is, where it is, and what it is doing.
 *
 * `onOpenState` is the link back to authoring — it is how "this run is stuck in a state I need to
 * fix" stops being a hunt through the tree.
 */
export function TaskPanel({
  detail,
  stream,
  onStart,
  onCancel,
  onOpenState,
  onReviewChanges,
}: {
  detail: TaskDetail;
  stream: string[];
  onStart: () => void;
  onCancel: () => void;
  onOpenState?: (stateId: string) => void;
  onReviewChanges?: () => void;
}): JSX.Element {
  return (
    <div className="detail">
      <TaskHead
        detail={detail}
        onStart={onStart}
        onCancel={onCancel}
        {...(onOpenState ? { onOpenState } : {})}
        {...(onReviewChanges ? { onReviewChanges } : {})}
      />
      <TaskDetailSections detail={detail} stream={stream} />
    </div>
  );
}

/**
 * Everything the panel says about a task under its header — the facts, as opposed to the words.
 *
 * Split from {@link TaskPanel} so the Tasks view can put them behind a toggle beside the
 * conversation without a second copy of five sections drifting away from this one.
 */
export function TaskDetailSections({
  detail,
  stream,
  here,
  asking,
  onGoTo,
  onCut,
}: {
  detail: TaskDetail;
  stream: string[];
  /** The instance holding a question that is on offer right now — passed through to {@link RunIndex}. */
  asking?: string | undefined;
  /** The state the reader is on, by `keyOfNode` — see {@link RunIndex}. */
  here?: string | undefined;
  /** Take the conversation to a state. Absent ⇒ this host has no conversation beside it. */
  onGoTo?: ((node: InstanceNode) => void) | undefined;
  /** The index's row menu — see {@link RunIndex}. */
  onCut?: { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined;
}): JSX.Element {
  const latest = detail.runs[detail.runs.length - 1];
  return (
    <>
      {/*
        No `Active path` section. It said which state the run is standing in as a `›`-joined string,
        which the index now says in place: the deepest live row carries the letterhead's own tone, and
        the lanes above it ARE the path. A second copy in words is a second thing to keep in agreement.
      */}
      {detail.blocked.length > 0 ? (
        <section>
          <h3>Blocked</h3>
          {detail.blocked.map((b) => (
            <div key={b.stateId} className="reason">
              {b.stateId}: {b.reason}
            </div>
          ))}
        </section>
      ) : null}

      <RunIndex
        instances={detail.instances}
        {...(here !== undefined ? { here } : {})}
        {...(asking !== undefined ? { asking } : {})}
        {...(onGoTo !== undefined ? { onGoTo } : {})}
        {...(onCut !== undefined ? { onCut } : {})}
      />

      <section>
        <h3>Live events</h3>
        <pre className="stream">
          {stream.length > 0
            ? stream.join("\n")
            : detail.timeline
                .slice(-12)
                .map((t) => `${t.type}  ${t.stateId ?? ""}`)
                .join("\n") || "—"}
        </pre>
      </section>

      {latest?.outputs ? (
        <section>
          <h3>Outputs</h3>
          <pre className="outputs">{JSON.stringify(latest.outputs, null, 2)}</pre>
        </section>
      ) : null}
    </>
  );
}

/** How each turn kind introduces itself. Short, because the column is narrow and repeated. */
const TURN_ROLE: Record<string, string> = {
  operation: "state",
  tool: "tool",
  output: "output",
  policy: "policy",
  interaction: "waiting",
  failure: "failed",
  blocked: "blocked",
  transition: "→",
};

/**
 * The conversation running inside one task.
 *
 * A projection of the journal and the command log rather than a stored transcript — there is no
 * other record, and this is the reading of it that answers "what is this run actually doing".
 */
export function Conversation({
  conversation,
  waiting,
  onAnswer,
}: {
  conversation: ConversationView | null;
  waiting?: { component: string } | undefined;
  onAnswer?: () => void;
}): JSX.Element {
  if (!conversation) return <p className="empty">Select a task to see its conversation.</p>;
  if (conversation.turns.length === 0) {
    return <p className="empty">This task has not run yet.</p>;
  }
  return (
    <div className="convo">
      <h3>
        <span>Conversation · {conversation.title}</span>
        <span className="sub">{conversation.turns.length} turns</span>
      </h3>
      <div className="turns">
        {conversation.turns.map((turn) => (
          <div key={`${turn.kind}-${turn.seq}`} className={`turn turn-${turn.kind}${turn.ok === false ? " turn-bad" : ""}`}>
            <span className="role">{TURN_ROLE[turn.kind] ?? turn.kind}</span>
            <div className="turn-body">
              {turn.stateId ? <span className="turn-state">{turn.stateId}</span> : null}
              {turn.tool ? <span className="turn-tool">{turn.tool}</span> : null}
              {turn.text ? <span className="turn-text">{turn.text}</span> : null}
              {turn.data !== undefined ? <span className="turn-data">{JSON.stringify(turn.data)}</span> : null}
            </div>
          </div>
        ))}
      </div>
      {waiting ? (
        // Pinned rather than in the flow: it is the one turn that is not history, and scrolling away
        // from the thing blocking the run is exactly the wrong behaviour.
        <div className="waiting-on">
          <Badge status="waiting_for_user" />
          <span className="grow">Waiting on you — {waiting.component}</span>
          {onAnswer ? <button className="primary" onClick={onAnswer}>Answer</button> : null}
        </div>
      ) : null}
    </div>
  );
}
