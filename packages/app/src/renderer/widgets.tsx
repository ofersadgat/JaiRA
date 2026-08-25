/**
 * Two small surfaces that belong to no view in particular.
 *
 * `NewTask` sits in the Tasks path bar; `History` is a Settings section. Both were previously in the
 * sidebar at the same visual weight as the approvals inbox, which is how a control you use twice a
 * year ends up looking as urgent as one that is blocking a run.
 */
import { useState, type JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type { HistorySize, WorkflowEntry } from "@jaira/shared/browser";
import { SelectInput } from "./controls";
import { InputRow } from "./runPanel";
import {
  createBlocker,
  initialRunValues,
  isFilled,
  runInputsOf,
  type RunField,
  type RunValues,
} from "./runForm";
import type { PruneReport } from "./store";

/**
 * Create a task.
 *
 * A popover rather than a permanent form: creating a task is an act, not a state, and a form parked
 * in the chrome is a form in the way of everything else you do.
 *
 * Two boxes are gone from it and one arrived, and all three changes are the same change — the form
 * now asks the WORKFLOW what it needs instead of guessing.
 *
 *  - **No title.** A title typed before the work exists is a name for something nobody has seen. The
 *    one people actually want is `feature/plan #3`, which is derivable, so it is derived — the same
 *    title the Files view's Run button generates, so a task made from either surface reads the same
 *    on the board. See `createTask` in the store.
 *  - **The workflow is a picker.** It was free text, which is a box you can only fill from memory
 *    and which reports a typo as a failed run rather than as an empty list.
 *  - **`Issue / input` is gone.** It was one box named after the one input the first workflow ever
 *    written happened to declare, sent as `{issue: …}` whatever the state actually asked for. What
 *    replaces it is the state's own `inputs`, as the same controls the Run form draws them with:
 *    a `boolean` gets a checkbox, a `number` a numeric box, a bound slot says what it is bound to.
 *
 * So the form has no fields of its own until a workflow is picked, and that is the honest shape:
 * everything below the picker is a question the picked workflow asked.
 */
export function NewTask({
  workflows,
  forms,
  values,
  busy,
  onPick,
  onChange,
  onCreate,
}: {
  /** Every root that can be started here, in the order the picker lists them. */
  workflows: WorkflowEntry[];
  /**
   * What each workflow declares it needs, by state id — see `AppState.workflowForms`.
   *
   * The whole map rather than the picked one's entry, because WHICH is picked is this component's
   * own state: a popover that is shut has no workflow picked, and lifting that into the store would
   * be remembering a question that was asked and abandoned. Three values per key and all three
   * distinct: absent is "not read yet", which is a state the form spends a round trip in and must
   * not render as "this file does not parse". See {@link createBlocker}.
   */
  forms: Record<string, RunField[] | null>;
  /** What has been typed, by state id then by input name — see `AppState.runValues`. */
  values: Record<string, RunValues>;
  busy: boolean;
  /** A workflow was picked: read its inputs. */
  onPick: (stateId: string) => void;
  onChange: (stateId: string, name: string, text: string) => void;
  onCreate: (workflow: string, inputs: Record<string, JsonValue>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [workflow, setWorkflow] = useState("");

  const picked = workflows.find((entry) => entry.rootId === workflow);
  const errors = picked?.issues.filter((issue) => issue.severity === "error").length ?? 0;
  const fields = workflow.length === 0 ? undefined : forms[workflow];
  // Declared defaults underneath, what has been typed over the top — the same sparse merge the Files
  // view's run form does, against the same map, so one workflow's boxes hold one set of answers
  // wherever they are filled in.
  const boxes: RunValues = { ...initialRunValues(fields ?? []), ...(values[workflow] ?? {}) };
  const read = runInputsOf(fields ?? [], boxes);
  const blocked = createBlocker({ workflow, fields, inputs: read, busy });
  const bad = new Map(read.bad.map((box) => [box.name, box.reason]));
  const filled = (fields ?? []).filter(isFilled);

  const pick = (stateId: string): void => {
    setWorkflow(stateId);
    if (stateId.length > 0) onPick(stateId);
  };

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
            if (blocked !== null) return;
            onCreate(workflow, read.inputs);
            // The picked workflow stays. Creating one task from a workflow is the strongest available
            // evidence about which workflow the next one comes from, and the boxes are held in the
            // store per state id, so re-opening the form finds what was typed.
            setOpen(false);
          }}
        >
          <label className="field">
            <span>Workflow</span>
            <SelectInput
              value={workflow}
              options={[
                // First and empty, so an unfilled picker reads as a question rather than as a
                // workflow somebody chose. `SelectInput` puts nothing here by itself.
                ["choose a workflow…", ""],
                ...workflows.map(
                  (entry): [string, string] => [entry.label ?? entry.rootId, entry.rootId],
                ),
              ]}
              onChange={pick}
            />
          </label>

          {/* What LINTING says about the workflow, and a warning rather than a refusal — the same
              call the Run button makes the other way. A state with errors will fail, and it should
              fail where it fails rather than behind a disabled button in a popover with no room to
              say which of five errors it means. The Files view is where they are readable. */}
          {picked?.loadError !== undefined ? (
            <div className="notice bad">{picked.loadError}</div>
          ) : errors > 0 ? (
            <div className="notice warn">
              {errors} validation error{errors === 1 ? "" : "s"} — it will start, and probably fail.
            </div>
          ) : null}

          {/* Everything below is the picked workflow's own question. Nothing at all before one is
              picked: boxes that belong to no state would be boxes nobody can answer. */}
          {workflow.length === 0 ? (
            <div className="sub">Its inputs appear here.</div>
          ) : fields === undefined ? (
            <div className="sub">reading its inputs…</div>
          ) : fields === null ? (
            <div className="notice bad">That workflow&apos;s file does not parse, so its inputs cannot be read.</div>
          ) : fields.length === 0 ? (
            <div className="sub">This workflow declares no inputs.</div>
          ) : (
            <div className="new-task-fields">
              {fields.map((field) => (
                <InputRow
                  key={field.name}
                  field={field}
                  value={boxes[field.name] ?? ""}
                  error={bad.get(field.name)}
                  onChange={(text) => onChange(workflow, field.name, text)}
                />
              ))}
            </div>
          )}

          <div className="pane-actions">
            <button
              type="submit"
              className="primary"
              disabled={blocked !== null}
              title={blocked ?? `creates ${workflow}`}
            >
              Create
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            {/* Why it is off, in the place the Run form says it — and the count of boxes when it is
                not, which is the one thing a form with no title left to read says about itself. */}
            {blocked !== null ? (
              <span className="sub ellip">{blocked}</span>
            ) : filled.length > 0 ? (
              <span className="sub ellip">
                {filled.length} input{filled.length === 1 ? "" : "s"}
              </span>
            ) : null}
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
