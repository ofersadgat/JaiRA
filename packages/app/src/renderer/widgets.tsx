/**
 * Two small surfaces that belong to no view in particular.
 *
 * `NewTask` sits in the Tasks path bar; `History` is a Settings section. Both were previously in the
 * sidebar at the same visual weight as the approvals inbox, which is how a control you use twice a
 * year ends up looking as urgent as one that is blocking a run.
 */
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useState, type JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type { HistorySize, InputSourcesResponse, WorkflowEntry } from "@jaira/shared/browser";
import { SelectInput } from "./controls";
import { RunInputsForm, useRunCheck } from "./runPanel";
import {
  createBlocker,
  initialRunValues,
  isFilled,
  keptSources,
  runInputsOf,
  sourceIdOf,
  sourceOptionsOf,
  sourceRefOf,
  type RunField,
  type RunSources,
  type RunValues,
} from "./runForm";
import type { ValueSources } from "./schemaForm/types";
import { useTouched } from "./schemaForm/check";
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
 *
 * A slot can also be filled FROM A TASK (decision 0005 §2): where an earlier task produced something
 * that fits the slot's schema, the slot's own line offers it, through the schema form like every
 * other choice the form makes. The pick is sent as a source, not as a value — the main process reads
 * it, and a task whose source is still running holds until it has.
 */
export function NewTask({
  workflows,
  forms,
  values,
  sources,
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
  /** What each workflow's form holds, by state id — see `AppState.runValues`. */
  values: Record<string, RunValues>;
  /** The earlier tasks' outputs that fit each slot, by state id — see `AppState.inputSources`. */
  sources: Record<string, InputSourcesResponse>;
  busy: boolean;
  /** A workflow was picked: read its inputs. */
  onPick: (stateId: string) => void;
  onChange: (stateId: string, values: RunValues) => void;
  onCreate: (workflow: string, inputs: Record<string, JsonValue>, sources: RunSources) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [workflow, setWorkflow] = useState("");
  /** Which slots take their value from a task, per workflow — the popover's own, like the pick itself. */
  const [taken, setTaken] = useState<Record<string, RunSources>>({});

  const picked = workflows.find((entry) => entry.rootId === workflow);
  const errors = picked?.issues.filter((issue) => issue.severity === "error").length ?? 0;
  const fields = workflow.length === 0 ? undefined : forms[workflow];
  // What the form opens holding until something is changed, and then what was changed — against the
  // same map the Files view's run form uses, so one workflow's form holds one set of answers wherever
  // it is filled in.
  const form: RunValues = values[workflow] ?? initialRunValues(fields ?? []);
  const offered = sources[workflow];
  // Only what is still on offer: a source deleted since it was picked is a pick that means nothing.
  const from = keptSources(taken[workflow] ?? {}, offered);
  const fromTask: ValueSources = {
    label: "from a task…",
    optionsFor: (path) => sourceOptionsOf(offered?.[path]),
    picked: (path) => (from[path] !== undefined ? sourceIdOf(from[path]!) : undefined),
    pick: (path, id) => {
      const next = { ...from };
      if (id === undefined) delete next[path];
      else next[path] = sourceRefOf(id);
      setTaken({ ...taken, [workflow]: next });
    },
  };
  const check = useRunCheck(fields, form, from);
  const { touched, touch } = useTouched(workflow);
  const blocked = createBlocker({ workflow, fields, check, busy });
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
            onCreate(workflow, runInputsOf(fields ?? [], form, from), from);
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
              <RunInputsForm
                fields={fields}
                values={form}
                check={check}
                touched={touched}
                touch={touch}
                onChange={(next) => onChange(workflow, next)}
                sources={fromTask}
              />
            </div>
          )}

          <div className="pane-actions">
            <button
              type="submit"
              className="primary"
              disabled={blocked !== null}
              title={blocked !== null && blocked.length > 0 ? blocked : `creates ${workflow}`}
            >
              Create
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            {/* Why it is off, in the place the Run form says it — and the count of boxes when it is
                not, which is the one thing a form with no title left to read says about itself. */}
            {blocked !== null ? (
              blocked.length > 0 ? <span className="sub ellip">{blocked}</span> : null
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
  onPreview: (days: number) => void;
  onApply: (days: number) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [days, setDays] = useState(30);
  if (!size) return <p className="empty">Open a project to see its history.</p>;
  const planned = report?.dryRun === true ? report : null;
  // Two sections of rows (`settingsLayout.tsx`): what is stored, and what pruning would free.
  return (
    <div className="history">
      <SettingsSection id="stored" title="Stored history" lead="This project's own records — they are the open project's whichever layer the switch above is on.">
        <SettingsRow name="Tasks" description="Every task this project has kept a record of." control={<span className="set-num data-num">{size.tasks}</span>} />
        <SettingsRow name="Events" description="What its runs recorded, step by step." control={<span className="set-num data-num">{size.events}</span>} />
        <SettingsRow name="Commands" description="Every command an agent ran, and what it was told." control={<span className="set-num data-num">{size.commands}</span>} />
      </SettingsSection>

      <SettingsSection id="prune" title="Pruning" info="An unfinished task is never pruned: it can still be resumed, so its history is kept whatever its age.">
        <SettingsRow
          name="Older than"
          description="Delete the history of finished tasks older than this. Preview first: nothing is deleted until you confirm."
          control={
            <div className="prune-controls">
              <label>
                <input type="number" min={0} value={days} onChange={(e) => setDays(Math.max(0, Number(e.target.value)))} aria-label="days" />
                days
              </label>
              <button className="ghost" onClick={() => onPreview(days)} disabled={busy}>
                Preview
              </button>
            </div>
          }
        />
        {report ? (
          <SettingsRow
            name={planned ? "Would delete" : "Deleted"}
            description={
              planned
                ? planned.tasks.length > 0
                  ? `The history of ${planned.tasks.length} task(s): ${planned.events} events, ${planned.commands} commands.`
                  : "Nothing matches — no task history is old enough."
                : `The history of ${report.tasks.length} task(s); ${report.remaining.events} events remain.`
            }
            {...(report.skippedTasks.length > 0
              ? // The §13 safety rule, made visible: these are resumable.
                { info: `Kept ${report.skippedTasks.length} unfinished task(s): ${report.skippedTasks.map((t) => `${t.taskId} (${t.reason})`).join(", ")}` }
              : {})}
            control={
              <>
                {planned && planned.tasks.length > 0 ? (
                  <button className="danger" onClick={() => onApply(days)} disabled={busy}>
                    Delete permanently
                  </button>
                ) : null}
                <button className="ghost" onClick={onDismiss}>
                  Dismiss
                </button>
              </>
            }
          />
        ) : null}
      </SettingsSection>
    </div>
  );
}
