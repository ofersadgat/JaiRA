/**
 * Two small surfaces that belong to no view in particular.
 *
 * `NewTask` sits in the Tasks path bar; `History` is a Settings section. Both were previously in the
 * sidebar at the same visual weight as the approvals inbox, which is how a control you use twice a
 * year ends up looking as urgent as one that is blocking a run.
 */
import { useState, type JSX } from "react";
import type { HistorySize } from "@jaira/shared/browser";
import type { PruneReport } from "./store";

/**
 * Create a task.
 *
 * A popover rather than a permanent form: creating a task is an act, not a state, and three inputs
 * parked in the chrome are three inputs in the way for everything else you do.
 */
export function NewTask({
  onCreate,
  busy,
}: {
  onCreate: (title: string, workflow: string, issue: string) => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [issue, setIssue] = useState("");

  return (
    <div className="new-task-wrap">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        + New task
      </button>
      {open ? (
        <form
          className="new-task-pop"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !workflow.trim()) return;
            onCreate(title.trim(), workflow.trim(), issue.trim());
            setTitle("");
            setIssue("");
            setOpen(false);
          }}
        >
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what to do" autoFocus />
          </label>
          <label className="field">
            <span>Workflow</span>
            <input
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              placeholder="root state id, e.g. feature/plan"
            />
          </label>
          <label className="field">
            <span>Issue / input</span>
            <input value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="optional" />
          </label>
          <div className="pane-actions">
            <button type="submit" disabled={busy || !title.trim() || !workflow.trim()}>
              Create
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/**
 * History pruning (SPEC §13).
 *
 * Deliberately two steps: "Preview" runs a dry run and shows exactly what would go, and only then
 * can it be applied — pruned history is not recoverable. Tasks the safety rule protects are listed
 * rather than silently skipped.
 */
export function History({
  size,
  report,
  busy,
  onPreview,
  onApply,
  onDismiss,
}: {
  size: HistorySize | null;
  report: PruneReport | null;
  busy: boolean;
  onPreview: (days: number, keep: number) => void;
  onApply: (days: number, keep: number) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [days, setDays] = useState(30);
  const [keep, setKeep] = useState(1);
  if (!size) return <p className="empty">Open a project to see its history.</p>;
  const planned = report?.dryRun === true ? report : null;
  return (
    <div className="pane history">
      <div>
        <div className="pane-title">Stored history</div>
        <div className="sub">
          {size.runs} runs · {size.events} events · {size.commands} commands
        </div>
      </div>

      <div className="prune-controls">
        <label>
          older than
          <input type="number" min={0} value={days} onChange={(e) => setDays(Math.max(0, Number(e.target.value)))} />d
        </label>
        <label>
          keep
          <input type="number" min={0} value={keep} onChange={(e) => setKeep(Math.max(0, Number(e.target.value)))} />
          runs
        </label>
        <button className="ghost" onClick={() => onPreview(days, keep)} disabled={busy}>
          Preview
        </button>
      </div>

      {report ? (
        <div className="prune-report">
          {planned ? (
            planned.runs.length > 0 ? (
              <>
                <div className="sub">
                  would delete {planned.runs.length} run(s), {planned.events} events, {planned.commands} commands
                </div>
                <button className="danger" onClick={() => onApply(days, keep)} disabled={busy}>
                  Delete permanently
                </button>
              </>
            ) : (
              <div className="sub">nothing matches — no run history is old enough</div>
            )
          ) : (
            <div className="sub">
              deleted {report.runs.length} run(s); {report.remaining.events} events remain
            </div>
          )}
          {report.skippedTasks.length > 0 ? (
            // The §13 safety rule, made visible: these are resumable.
            <div className="sub" title={report.skippedTasks.map((s) => `${s.taskId}: ${s.reason}`).join("\n")}>
              kept {report.skippedTasks.length} unfinished task(s)
            </div>
          ) : null}
          <button className="ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
