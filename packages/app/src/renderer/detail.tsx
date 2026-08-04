/**
 * The task panel and the conversation viewer (DESIGN §11.1).
 *
 * Both views show these: Tasks puts the task panel in its right-hand column permanently, and Files
 * swaps its inspector onto it the moment you click a card. One component, so the two never drift
 * into describing the same task differently.
 */
import type { JSX } from "react";
import type { ConversationView, InstanceNode, TaskDetail } from "@jaira/shared/browser";
import { Badge } from "./board";

function Tree({ nodes }: { nodes: InstanceNode[] }): JSX.Element {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.instanceId} className={node.superseded ? "superseded" : undefined}>
          <span className="tree-row">
            <Badge status={node.status} />
            <span className="tree-label">{node.childKey ?? node.stateId}</span>
            {node.iteration > 0 ? <span className="chip">iter {node.iteration}</span> : null}
            {node.operation ? <span className="chip">{node.operation.kind}</span> : null}
            {node.superseded ? <span className="chip">superseded</span> : null}
            {node.operation?.reason ? <span className="reason">{node.operation.reason}</span> : null}
          </span>
          {node.children.length > 0 ? <Tree nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
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
}: {
  detail: TaskDetail;
  stream: string[];
  onStart: () => void;
  onCancel: () => void;
  onOpenState?: (stateId: string) => void;
}): JSX.Element {
  const latest = detail.runs[detail.runs.length - 1];
  const deepest = detail.activePath[detail.activePath.length - 1];
  return (
    <div className="detail">
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
        <div className="actions">
          <button onClick={onStart}>{detail.runs.length > 0 ? "Re-run" : "Start"}</button>
          <button onClick={onCancel} className="ghost">
            Cancel
          </button>
          {onOpenState && deepest ? (
            <button className="ghost" onClick={() => onOpenState(deepest.stateId)} title={deepest.stateId}>
              Open state ↗
            </button>
          ) : null}
        </div>
      </header>

      {detail.activePath.length > 0 ? (
        <section>
          <h3>Active path</h3>
          <div className="path">{detail.activePath.map((s) => s.childKey ?? s.stateId).join(" › ")}</div>
        </section>
      ) : null}

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

      <section>
        <h3>Instances</h3>
        {detail.instances.length > 0 ? <Tree nodes={detail.instances} /> : <p className="empty">No run yet.</p>}
      </section>

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
    </div>
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
        {conversation.runId !== undefined ? (
          <span className="sub">
            run #{conversation.runId} · {conversation.turns.length} turns
          </span>
        ) : null}
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
          {onAnswer ? <button onClick={onAnswer}>Answer</button> : null}
        </div>
      ) : null}
    </div>
  );
}
