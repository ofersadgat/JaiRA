import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { BoardCard, StateView } from "@jaira/shared/browser";
import { BADGE } from "@jaira/ui/panelFaceModel";
import { useRunCheck } from "@jaira/ui/newTaskModel";
import { isFilled, runBlocker, runHistoryOf, runInputsOf, runSchemaOf, runTitle, type RunField, type RunValues } from "@jaira/ui/runForm";
import type { RunSurface } from "@jaira/ui/runPanel";
import { useTouched } from "@jaira/ui/schemaForm/check";
import type { ValueSources } from "@jaira/ui/schemaForm/types";
import { Press, Txt, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { SchemaForm } from "../form/SchemaForm";
import { Button } from "../settings/Button";

/**
 * `runPanel.tsx`'s `RunPanel`, universal (decision 0015): a state's Run tab — a box per declared input
 * and the button (the one schema form, `components/form/SchemaForm.tsx`), then every previous run in the
 * two groups a run can belong to. Everything with a decision in it is `runForm.ts`'s, the DOM's own. The
 * rules (`cascade.mts .sp-body --scene state`):
 *
 *   section          blocks (the sections are not flex: their gap does nothing)
 *   h3               row, centred, spaced, gap 8, 8 under; app 11/12.5, 0.09em, upper, --dim; the
 *                    name 700, `.count` 400
 *   .run-target      app 11/12.5 --dim, 2 under; `b` 600 --text
 *   .run-inputs      column, gap 6
 *   .run-actions     row, centred, wrapping, gap 6, 2 above; a primary Run and why it is off (`.sub`)
 *   .run-group       app 10/12.5 --dim, 0.06em, upper, 5 above (collapsing into the h3's 8)
 *   .run-row         row, centred, gap 6, padding 4 6, radius 6, app 12/12.5: the badge (16 wide), the
 *                    title (ellipsed), where it is now (`.sub`)
 */
export function RunPanel({ state, run }: { state: StateView | null; run: RunSurface }): JSX.Element {
  const history = runHistoryOf(state?.stateId ?? "", run.tasks, state);
  return (
    <>
      <RunSection state={state} run={run} startedHere={history.startedHere.length} />
      <RunHistorySection state={state} history={history} run={run} />
    </>
  );
}

/** `h3`: a section's name and its count. */
function Heading({ name, count }: { name: string; count?: ReactNode }): JSX.Element {
  const base: FontSpec = { voice: "app", scale: 11 / 12.5, ls: 0.09, upper: true, color: "dim" };
  return (
    <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={8} marginBottom={8}>
      <Txt spec={{ ...base, weight: 700 }}>{name}</Txt>
      {count !== undefined ? <Txt spec={base}>{count}</Txt> : null}
    </View>
  );
}

/** `.notice`: a sentence on a tinted ground. */
function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v(tone === "bad" ? "tint-bad" : "tint-warn") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: tone }}>{children}</Txt>
    </View>
  );
}

const SUB: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };

/** `RunSection`: a box per declared input, and the button. */
function RunSection({ state, run, startedHere }: { state: StateView | null; run: RunSurface; startedHere: number }): JSX.Element {
  const { fields, values, provenance, target, targetDir, exists, dirty, busy, onChange, onRun } = run;
  const check = useRunCheck(fields, values);
  const { touched, touch } = useTouched(state?.stateId ?? "");
  const blocked = runBlocker({ state, target, exists, fields, check, busy });
  const filled = (fields ?? []).filter(isFilled);
  return (
    <View flexDirection="column">
      <Heading name="Run" {...(filled.length > 0 ? { count: `${filled.length} inputs` } : {})} />
      <Txt spec={SUB} marginBottom={2} title={targetDir ?? target.label}>
        runs in <Txt spec={{ ...SUB, weight: 600, color: "text" }}>{target.label}</Txt>
      </Txt>
      {fields === null ? (
        <Notice tone="bad">This file does not parse, so its inputs cannot be read.</Notice>
      ) : (
        <>
          {dirty ? <Notice tone="warn">Unsaved edits — the run uses the last saved file.</Notice> : null}
          {fields.length === 0 ? <Txt spec={SUB}>This state declares no inputs.</Txt> : <RunInputs fields={fields} values={values} check={check} touched={touched} touch={touch} onChange={onChange} provenance={provenance} />}
        </>
      )}
      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} marginTop={2}>
        <Button kind="primary" disabled={blocked !== null} title={blocked !== null && blocked.length > 0 ? blocked : `starts ${runTitle(state?.stateId ?? "", startedHere)}`} onPress={() => onRun(runTitle(state?.stateId ?? "", startedHere), runInputsOf(fields ?? [], values))}>
          Run
        </Button>
        {blocked !== null && blocked.length > 0 ? (
          <Txt spec={SUB} ellip flexShrink={1} minWidth={0}>
            {blocked}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** `RunInputsForm`: a workflow's declared inputs, as the one schema form. */
export function RunInputs({
  fields,
  values,
  check,
  touched,
  touch,
  onChange,
  provenance,
  sources,
}: {
  fields: readonly RunField[];
  values: RunValues;
  check: ReturnType<typeof useRunCheck>;
  touched: (path: string) => boolean;
  touch: (path: string) => void;
  onChange: (values: RunValues) => void;
  provenance?: RunSurface["provenance"];
  /** "From a task…": another place a slot's value can come from. */
  sources?: ValueSources | undefined;
}): JSX.Element {
  const fixed = fields.filter((field) => !isFilled(field));
  return (
    <View flexDirection="column" gap={6} minWidth={0}>
      {/* Nothing to fill: the value is wired, or the name stands for N slots — shown, not hidden. */}
      {fixed.map((field) => (
        <View key={field.name} flexDirection="column" {...((field.description !== undefined ? { title: field.description } : {}) as object)}>
          <Txt spec={{ voice: "app", scale: 1 }}>{field.name}</Txt>
          <Txt spec={SUB}>{field.spread === true ? "a spread — republished from a child" : `bound to ${field.binding}`}</Txt>
        </View>
      ))}
      <SchemaForm
        schema={runSchemaOf(fields)}
        value={values}
        onChange={(next) => onChange(next as RunValues)}
        ctx={{ path: "", labels: "keys", errors: check.errors, touched, touch, ...(sources !== undefined ? { sources } : {}), ...(provenance !== undefined ? { provenance } : {}) }}
      />
    </View>
  );
}

/** One previous run: what it was, how it went, and a press to go read it. */
function RunRow({ taskId, title, status, at, selected, note, project, onSelect }: { taskId: string; title: string; status: string; at: number; selected: boolean; note?: string | undefined; project?: string | undefined; onSelect: (taskId: string, project?: string) => void }): JSX.Element {
  const t = useTokens();
  const hue = status === "running" || status === "interrupted" ? "accent" : status === "waiting_for_user" ? "warn" : status === "completed" ? "ok" : status === "failed" || status === "blocked" || status === "timeout" ? "bad" : "dim";
  const words: FontSpec = { voice: "app", scale: 12 / 12.5 };
  return (
    <Press
      onPress={() => onSelect(taskId, project)}
      title={`${taskId} · ${new Date(at).toLocaleString()}`}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingVertical={4}
      paddingHorizontal={6}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: selected ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Txt spec={{ ...words, color: hue }} width={16} textAlign="center" flexShrink={0}>
        {BADGE[status] ?? "·"}
      </Txt>
      <Txt spec={words} ellip flex={1} minWidth={0}>
        {title}
      </Txt>
      {note !== undefined ? (
        <Txt spec={SUB} ellip flexShrink={1} minWidth={0}>
          {note}
        </Txt>
      ) : null}
    </Press>
  );
}

/** `RunHistorySection`: every previous run, in the two groups a run can belong to. */
function RunHistorySection({ state, history, run }: { state: StateView | null; history: ReturnType<typeof runHistoryOf>; run: RunSurface }): JSX.Element {
  const { startedHere, passedThrough } = history;
  const where = (card: BoardCard): string | undefined => (card.activeStateId !== undefined && card.activeStateId !== state?.stateId ? card.activeStateId.split("/").pop() : undefined);
  const group: FontSpec = { voice: "app", scale: 10 / 12.5, ls: 0.06, upper: true, color: "dim" };
  const searched = run.tasks.length;
  return (
    <View flexDirection="column">
      <Heading name="History" count={startedHere.length + passedThrough.length} />
      {startedHere.length + passedThrough.length === 0 ? (
        <Txt spec={SUB} title={`no task in ${run.target.label} names '${state?.stateId ?? ""}' as its workflow`}>
          No runs — searched {searched} task{searched === 1 ? "" : "s"} in {run.target.label}.
        </Txt>
      ) : null}
      {startedHere.length > 0 ? (
        <>
          <Txt spec={group}>started here</Txt>
          {startedHere.map((task) => (
            <RunRow key={task.taskId} taskId={task.taskId} title={task.title} status={task.archived?.from ?? task.status} at={task.updatedAt} selected={task.taskId === run.selected} project={run.target.project} onSelect={run.onSelectTask} />
          ))}
        </>
      ) : null}
      {state?.fileOnly === true ? (
        <Txt spec={group} marginTop={5} title="open a project to see tasks that ran through this state">
          runs through this state · not known without a project
        </Txt>
      ) : null}
      {passedThrough.length > 0 ? (
        <>
          <Txt spec={group} marginTop={startedHere.length > 0 ? 5 : 0}>
            also passed through
          </Txt>
          {passedThrough.map((card) => (
            <RunRow key={card.taskId} taskId={card.taskId} title={card.title} status={card.activeStatus ?? card.status} at={card.updatedAt} selected={card.taskId === run.selected} note={where(card)} onSelect={run.onSelectTask} />
          ))}
        </>
      ) : null}
    </View>
  );
}
