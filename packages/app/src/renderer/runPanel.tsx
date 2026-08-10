/**
 * Run this state, and what running it has produced before.
 *
 * Two sections of the Files inspector, and they belong together: the form is the question and the
 * history is the answer to the last time you asked it. Both sit above the state's validation and
 * wiring, because a person who has just finished editing a state wants to try it, and a Run button
 * below four collapsible sections is a Run button reached by scrolling.
 *
 * Everything with a decision in it — which boxes, what they mean, why the button is off — is in
 * `runForm.ts` and tested there. What is left here is genuinely presentation: which control renders
 * a `boolean`, and how a previous run reads as one line.
 */
import { type JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type { BoardCard, StateView, TaskSummary } from "@jaira/shared/browser";
import { Badge } from "./board";
import { TextArea, TextInput } from "./controls";
import {
  isFilled,
  runBlocker,
  runHistoryOf,
  runInputsOf,
  runTitle,
  type RunField,
  type RunHistory,
  type RunTarget,
  type RunValues,
} from "./runForm";

/**
 * One declared input, as the control its schema earns.
 *
 * The boxes are never disabled, `busy` or not — only the button is. A run takes as long as it takes,
 * and the useful thing to do while one is going is to set up the next one with an input changed;
 * greying the form out for the duration would take that away for no safety in return.
 */
function InputRow({
  field,
  value,
  error,
  onChange,
}: {
  field: RunField;
  value: string;
  error: string | undefined;
  onChange: (text: string) => void;
}): JSX.Element {
  const label = (
    <span>
      {field.name}
      {field.required ? <b className="req" title="required"> *</b> : null}
    </span>
  );

  // Nothing to fill: the value is wired, or the name stands for N slots. Both are shown rather than
  // hidden — "why is this input not in the form" is a question the form should answer itself.
  if (!isFilled(field)) {
    return (
      <div className="field run-field" title={field.description}>
        {label}
        <div className="sub run-fixed">
          {field.spread === true ? "a spread — republished from a child" : `bound to ${field.binding}`}
        </div>
      </div>
    );
  }

  return (
    <div className={`field run-field${error !== undefined ? " bad" : ""}`} title={field.description}>
      {label}
      {field.control === "boolean" ? (
        <label className="run-bool">
          <input
            type="checkbox"
            checked={value.trim() === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          <span className="sub">{value.trim() === "true" ? "true" : "false"}</span>
        </label>
      ) : field.control === "multiline" || field.control === "json" ? (
        <TextArea
          value={value}
          rows={field.control === "json" ? 2 : 3}
          placeholder={field.control === "json" ? "JSON" : field.type?.mediaType}
          onChange={onChange}
        />
      ) : (
        <TextInput
          value={value}
          mono={field.control === "number"}
          {...(field.type !== null && field.type.name !== "text" ? { placeholder: field.type.name } : {})}
          onChange={onChange}
        />
      )}
      {error !== undefined ? <div className="reason">{error}</div> : null}
      {field.description.length > 0 ? <div className="sub ellip">{field.description}</div> : null}
    </div>
  );
}

/**
 * Everything the two sections need beyond the state itself.
 *
 * One bag rather than a dozen props, and optional at the call site: {@link StateInspector} is also
 * rendered in places with no host to start a task from, and a Run button that cannot run is worse
 * than no Run button.
 *
 * `values` lives in the store rather than in this component, for the reason every other per-document
 * thing in this view does: the inspector unmounts the moment you click another file, and a paragraph
 * of instruction typed into an input slot is exactly as losable as a draft.
 */
export interface RunSurface {
  /**
   * The state's declared inputs, read from the SAVED document. `null` when it does not parse.
   *
   * Read by the host rather than here so that both sections and the store agree on one reading —
   * and so the parse happens once per file opened, not once per keystroke in a box.
   */
  fields: RunField[] | null;
  values: RunValues;
  /**
   * Which project the run goes to, decided by the file's layer — see {@link runTargetOf}.
   *
   * Named on screen rather than left implicit. A shared workflow runs in JaiRA's own project with
   * `~/.jaira` as its workspace, and that is a surprise worth one line of text before the button
   * rather than a discovery afterwards.
   */
  target: RunTarget;
  /** Where the target project lives on disk, for the tooltip. */
  targetDir?: string | undefined;
  /** The open file exists on disk. A never-saved draft has no snapshot to pin. */
  exists: boolean;
  /** The open file has unsaved edits. A run reads the SAVED file, so this is worth saying out loud. */
  dirty: boolean;
  busy: boolean;
  /**
   * Every task in the TARGET project — what "started here" filters.
   *
   * The target's, not the focused project's: a shared state's runs are recorded in JaiRA's own
   * project, and listing the open checkout's tasks beside a button that writes somewhere else would
   * make the section permanently empty and permanently wrong about why.
   */
  tasks: TaskSummary[];
  /** The task the rest of the app has selected, so the row for it reads as current. */
  selected: string | null;
  onChange: (name: string, text: string) => void;
  /** Create the task and start it. The title is generated; see {@link runTitle}. */
  onRun: (title: string, inputs: Record<string, JsonValue>) => void;
  /**
   * Open a previous run.
   *
   * `project` is which one holds it, and the two history groups differ: a run STARTED here is the
   * target's, while one that merely passed through was projected from the state view, which is the
   * focused project's. Reading a task out of the wrong project finds nothing.
   */
  onSelectTask: (taskId: string, project?: string) => void;
}

/** The Run section: a box per declared input, and the button. */
export function RunSection({
  state,
  run,
  startedHere,
}: {
  state: StateView | null;
  run: RunSurface;
  /** How many runs this state has already had — what numbers the auto-generated title. */
  startedHere: number;
}): JSX.Element {
  const { fields, values, target, targetDir, exists, dirty, busy, onChange, onRun } = run;
  const read = runInputsOf(fields ?? [], values);
  const blocked = runBlocker({ state, target, exists, fields, inputs: read, busy });
  const errors = new Map(read.bad.map((bad) => [bad.name, bad.reason]));
  const filled = (fields ?? []).filter(isFilled);

  return (
    <section className="run-section">
      <h3>
        <span>Run</span>
        {filled.length > 0 ? <span className="count">{filled.length} inputs</span> : null}
      </h3>

      {/* Which project records the run, and therefore whose config, credentials and workspace it
          gets. Always shown, not only for the surprising case: a line that appears only sometimes is
          a line nobody reads the rest of the time. */}
      <div className="sub run-target" title={targetDir ?? target.label}>
        runs in <b>{target.label}</b>
      </div>

      {fields === null ? (
        <div className="notice bad">This file does not parse, so its inputs cannot be read.</div>
      ) : (
        <>
          {dirty ? (
            // Not a refusal. Running a state you are mid-edit on is a perfectly reasonable thing to
            // do — comparing the last saved behaviour against what you are about to write is most of
            // why the button is here — but which of the two runs must not be a guess.
            <div className="notice warn">Unsaved edits — the run uses the last saved file.</div>
          ) : null}
          {fields.length === 0 ? <div className="sub">This state declares no inputs.</div> : null}
          {fields.map((field) => (
            <InputRow
              key={field.name}
              field={field}
              value={values[field.name] ?? ""}
              error={errors.get(field.name)}
              onChange={(text) => onChange(field.name, text)}
            />
          ))}
        </>
      )}

      <div className="pane-actions run-actions">
        <button
          disabled={blocked !== null}
          title={blocked ?? `starts ${runTitle(state?.stateId ?? "", startedHere)}`}
          onClick={() => onRun(runTitle(state?.stateId ?? "", startedHere), read.inputs)}
        >
          Run
        </button>
        {blocked !== null ? <span className="sub ellip">{blocked}</span> : null}
      </div>
    </section>
  );
}

/** One previous run: what it was, how it went, and a click to go read it. */
function RunRow({
  taskId,
  title,
  status,
  at,
  selected,
  note,
  project,
  onSelect,
}: {
  taskId: string;
  title: string;
  status: string;
  at: number;
  selected: boolean;
  /** Where the run is now, for a task that is still moving. */
  note?: string | undefined;
  /** Which project holds it. Absent ⇒ the focused one. */
  project?: string | undefined;
  onSelect: (taskId: string, project?: string) => void;
}): JSX.Element {
  return (
    <div
      className={`leaf-row run-row${selected ? " sel" : ""}`}
      title={`${taskId} · ${new Date(at).toLocaleString()}`}
      onClick={() => onSelect(taskId, project)}
    >
      <Badge status={status} />
      <span className="grow ellip">{title}</span>
      {note !== undefined ? <span className="sub ellip run-at">{note}</span> : null}
    </div>
  );
}

/**
 * Every previous run, in the two groups a run can belong to.
 *
 * "Started here" is what the button above produced. "Also passed through" is every task that entered
 * this state as part of a bigger workflow — which for a child state is all of them, and is the half
 * that makes the section worth having on a state nobody starts directly.
 */
export function RunHistorySection({
  state,
  history,
  target,
  searched,
  selected,
  onSelect,
}: {
  state: StateView | null;
  history: RunHistory;
  /** Which project the first group's runs live in — see {@link RunSurface.onSelectTask}. */
  target: RunTarget;
  /** How many tasks the first group filtered. Reported on the empty state; see below. */
  searched: number;
  selected: string | null;
  onSelect: (taskId: string, project?: string) => void;
}): JSX.Element {
  const { startedHere, passedThrough } = history;
  const where = (card: BoardCard): string | undefined =>
    card.activeStateId !== undefined && card.activeStateId !== state?.stateId
      ? card.activeStateId.split("/").pop()
      : undefined;

  return (
    <section className="run-history">
      <h3>
        <span>History</span>
        <span className="count">{startedHere.length + passedThrough.length}</span>
      </h3>

      {startedHere.length + passedThrough.length === 0 ? (
        // "This state has never run" is a CLAIM, and it is indistinguishable from "the list it was
        // filtered out of was empty for some other reason" — which is the failure mode that hid in
        // here for three rounds. So the section says what it actually searched, on screen rather
        // than in a tooltip. `searched 0` means the task list never loaded; `searched N` with no
        // rows means the filter is missing them. Those are different bugs and this is the one line
        // that tells them apart. It is not debug output: the same honesty the tree applies to a
        // state no root reaches, which says "not validated" rather than showing a clean row.
        <div
          className="sub"
          title={`no task in ${target.label} names '${state?.stateId ?? ""}' as its workflow`}
        >
          No runs — searched {searched} task{searched === 1 ? "" : "s"} in {target.label}.
        </div>
      ) : null}

      {startedHere.length > 0 ? (
        <>
          <div className="sub run-group">started here</div>
          {startedHere.map((task) => (
            <RunRow
              key={task.taskId}
              taskId={task.taskId}
              title={task.title}
              status={task.status}
              at={task.updatedAt}
              selected={task.taskId === selected}
              project={target.project}
              onSelect={onSelect}
            />
          ))}
        </>
      ) : null}

      {state?.fileOnly === true ? (
        // Only the SECOND group is unknown here, and only that is said. With no user project open
        // there is no reference graph to project a path through this state from — but the first
        // group is JaiRA's own runs, which are known perfectly well.
        <div className="sub run-group" title="open a project to see tasks that ran through this state">
          runs through this state · not known without a project
        </div>
      ) : null}

      {passedThrough.length > 0 ? (
        <>
          <div className="sub run-group">also passed through</div>
          {passedThrough.map((card) => (
            <RunRow
              key={card.taskId}
              taskId={card.taskId}
              title={card.title}
              status={card.activeStatus ?? card.status}
              at={card.updatedAt}
              selected={card.taskId === selected}
              note={where(card)}
              onSelect={onSelect}
            />
          ))}
        </>
      ) : null}
    </section>
  );
}

/**
 * Both sections, in the order they answer each other.
 *
 * The history is computed once and shared: the form needs the count of runs started here to number
 * the next title, and the list below it needs the runs themselves. Deriving that twice is how the
 * button comes to promise a `#4` that appears in the list as `#3`.
 */
export function RunPanel({ state, run }: { state: StateView | null; run: RunSurface }): JSX.Element {
  const history = runHistoryOf(state?.stateId ?? "", run.tasks, state);
  return (
    <>
      <RunSection state={state} run={run} startedHere={history.startedHere.length} />
      <RunHistorySection
        state={state}
        history={history}
        target={run.target}
        searched={run.tasks.length}
        selected={run.selected}
        onSelect={run.onSelectTask}
      />
    </>
  );
}
