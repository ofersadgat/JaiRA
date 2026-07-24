/**
 * The board and task-detail views (DESIGN §11.1).
 *
 * Everything rendered here arrives pre-projected from the main process: columns,
 * card placement, statuses, the instance tree. The renderer's job is layout and
 * intent — it never re-derives engine semantics.
 */
// React 19 no longer declares a global `JSX` namespace — it comes from the
// package now.
import { useState, type JSX } from "react";
import type { BoardCard, InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { InteractionDialog } from "./components";
import { useApp } from "./store";

const BADGE: Record<string, string> = {
  running: "▶",
  waiting_for_user: "⏸",
  blocked: "⛔",
  completed: "✓",
  failed: "✗",
  canceled: "∅",
  timeout: "⏱",
  queued: "·",
  interrupted: "⚠",
};

function Badge({ status }: { status?: string }): JSX.Element {
  const key = status ?? "queued";
  return (
    <span className={`badge badge-${key}`} title={key}>
      {BADGE[key] ?? "·"}
    </span>
  );
}

function Card({
  card,
  selected,
  onSelect,
  onDrill,
}: {
  card: BoardCard;
  selected: boolean;
  onSelect: () => void;
  onDrill: () => void;
}): JSX.Element {
  return (
    <div
      className={`card${selected ? " card-selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={card.hasSubBoard ? onDrill : undefined}
      title={card.hasSubBoard ? "double-click to open the sub-board" : card.activeStateId ?? card.status}
    >
      <div className="card-head">
        <Badge status={card.activeStatus ?? card.status} />
        <span className="card-title">{card.title}</span>
        {card.hasSubBoard ? <span className="drill">↳</span> : null}
      </div>
      <div className="card-meta">{card.activeStateId ?? card.status}</div>
    </div>
  );
}

function Tree({ nodes, depth = 0 }: { nodes: InstanceNode[]; depth?: number }): JSX.Element {
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
          {node.children.length > 0 ? <Tree nodes={node.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Detail({
  detail,
  stream,
  onStart,
  onCancel,
}: {
  detail: TaskDetail;
  stream: string[];
  onStart: () => void;
  onCancel: () => void;
}): JSX.Element {
  const latest = detail.runs[detail.runs.length - 1];
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
        <div className="actions">
          <button onClick={onStart}>{detail.runs.length > 0 ? "Re-run" : "Start"}</button>
          <button onClick={onCancel} className="ghost">
            Cancel
          </button>
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
        <h3>Runs</h3>
        <ul className="runs">
          {detail.runs.map((run) => (
            <li key={run.runId}>
              <span className="chip">#{run.runId}</span> {run.outcome}
              {run.failure ? <span className="reason"> {JSON.stringify(run.failure)}</span> : null}
            </li>
          ))}
          {detail.runs.length === 0 ? <li className="empty">—</li> : null}
        </ul>
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

/**
 * The approvals inbox (DESIGN §10.2, phase-4 scaffolding).
 *
 * Today it lists the pending human gates across every task, which is the whole
 * inbox: per-command `require_approval` decisions are provider-initiated and
 * arrive with the policy engine and process executors (phase 6), so there is
 * nothing to show for them yet rather than a placeholder pretending otherwise.
 */
function Inbox({
  pending,
  selected,
  onSelect,
}: {
  pending: PendingInteraction[];
  selected: string | null;
  onSelect: (taskId: string) => void;
}): JSX.Element | null {
  if (pending.length === 0) return null;
  return (
    <div className="inbox">
      <h3>
        Awaiting you <span className="count">{pending.length}</span>
      </h3>
      <ul>
        {pending.map((item) => (
          <li
            key={item.requestId}
            className={item.taskId === selected ? "selected" : undefined}
            onClick={() => onSelect(item.taskId)}
          >
            <span className="badge badge-waiting_for_user">⏸</span>
            <span className="task-title">{item.config?.prompt ?? item.component}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewTask({ onCreate, busy }: { onCreate: (t: string, w: string, i: string) => void; busy: boolean }): JSX.Element {
  const [title, setTitle] = useState("");
  const [workflow, setWorkflow] = useState("feature/plan");
  const [issue, setIssue] = useState("");
  return (
    <form
      className="new-task"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onCreate(title.trim(), workflow.trim(), issue.trim());
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" />
      <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} placeholder="workflow root state" />
      <input value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="issue / input" />
      <button type="submit" disabled={busy || !title.trim()}>
        Create
      </button>
    </form>
  );
}

export default function App(): JSX.Element {
  const { state, actions } = useApp();
  const { board, detail, pending } = state;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">JaiRA</div>
        <div className="project" title={state.projectDir ?? ""}>
          {state.projectDir ?? "no project open"}
        </div>
        <NewTask onCreate={actions.createTask} busy={state.busy} />
        <Inbox pending={pending} selected={state.selected} onSelect={actions.select} />
        <h3>Tasks</h3>
        <ul className="tasks">
          {state.tasks.map((task) => (
            <li
              key={task.taskId}
              className={task.taskId === state.selected ? "selected" : undefined}
              onClick={() => actions.select(task.taskId)}
            >
              <Badge status={task.status} /> <span className="task-title">{task.title}</span>
            </li>
          ))}
          {state.tasks.length === 0 ? <li className="empty">No tasks yet.</li> : null}
        </ul>
      </aside>

      <main className="board">
        <header className="board-head">
          <div className="crumbs">
            {(board?.breadcrumb ?? []).map((crumb, i) => (
              <button key={crumb} className="crumb" onClick={() => actions.drillTo(i === 0 ? undefined : crumb)}>
                {crumb}
                {i < (board?.breadcrumb.length ?? 0) - 1 ? " ›" : ""}
              </button>
            ))}
          </div>
          {board?.label ? <span className="level-label">{board.label}</span> : null}
        </header>

        <div className="columns">
          {(board?.columns ?? []).map((column) => (
            <section key={column.key} className="column">
              <h4>
                {column.label ?? column.stateId} <span className="count">{column.cards.length}</span>
              </h4>
              {column.cards.map((card) => (
                <Card
                  key={card.taskId}
                  card={card}
                  selected={card.taskId === state.selected}
                  onSelect={() => actions.select(card.taskId)}
                  onDrill={() => actions.drillTo(card.activePath[card.activePath.indexOf(card.activePath.find((s) => s.stateId === board?.level) ?? card.activePath[0]!) + 1]?.stateId)}
                />
              ))}
              {column.cards.length === 0 ? <div className="empty">—</div> : null}
            </section>
          ))}
          {board && board.columns.length === 0 ? <p className="empty">This level has no child states.</p> : null}
        </div>

        {(board?.atLevel.length ?? 0) > 0 ? (
          <div className="tray">
            <h4>At this level</h4>
            <div className="tray-cards">
              {board!.atLevel.map((card) => (
                <Card key={card.taskId} card={card} selected={card.taskId === state.selected} onSelect={() => actions.select(card.taskId)} onDrill={() => undefined} />
              ))}
            </div>
          </div>
        ) : null}

        {(board?.finished.length ?? 0) > 0 ? (
          <div className="tray">
            <h4>Finished / not started</h4>
            <div className="tray-cards">
              {board!.finished.map((card) => (
                <Card key={card.taskId} card={card} selected={card.taskId === state.selected} onSelect={() => actions.select(card.taskId)} onDrill={() => undefined} />
              ))}
            </div>
          </div>
        ) : null}
      </main>

      <aside className="panel">
        {detail ? (
          <Detail
            detail={detail}
            stream={state.stream}
            onStart={() => actions.startTask(detail.taskId)}
            onCancel={() => actions.cancelTask(detail.taskId)}
          />
        ) : (
          <p className="empty">Select a task.</p>
        )}
      </aside>

      {pending.length > 0 ? (
        <InteractionDialog
          pending={pending[0]!}
          error={state.error}
          onSubmit={(value) => actions.answer(pending[0]!.requestId, value)}
        />
      ) : null}

      {state.error ? (
        <div className="toast" onClick={actions.dismissError}>
          {state.error}
        </div>
      ) : null}
    </div>
  );
}
