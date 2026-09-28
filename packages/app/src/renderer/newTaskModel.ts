/**
 * What the New-task form DECIDES — which workflow is picked, what its boxes hold, which slots take their
 * value from a task, and why the button is off — moved out of `widgets.tsx`'s `NewTaskForm` unchanged so
 * the universal copy (decision 0015, `packages/universal/src/components/panel/NewTaskForm.tsx`) runs the
 * same form. Also `useRunCheck`, the check every run form's values get, out of `runPanel.tsx`. Nothing
 * here draws.
 */
import { useState } from "react";
import type { InputSourcesResponse, WorkflowEntry } from "@jaira/shared/browser";
import { createBlocker, initialRunValues, isFilled, keptSources, missingOf, runChecksOf, sourceIdOf, sourceOptionsOf, sourceRefOf, type RunField, type RunSources, type RunValues } from "./runForm";
import { useSchemaCheck, useTouched } from "./schemaForm/check";
import type { FormCheck } from "./schemaForm/model";
import type { ValueSources } from "./schemaForm/types";

/** The check a run form's values get: the run's own validator per slot, plus a required slot with nothing in it. */
export function useRunCheck(fields: readonly RunField[] | null | undefined, values: RunValues, sources: RunSources = {}): FormCheck {
  return useSchemaCheck(runChecksOf(fields ?? [], values, sources), missingOf(fields ?? [], values, sources));
}

/** The New-task form's state and derivations — `NewTaskForm`'s, for either drawing of it. */
export function useNewTaskForm({
  workflows,
  forms,
  values,
  sources,
  busy,
  onPick,
}: {
  workflows: WorkflowEntry[];
  forms: Record<string, RunField[] | null>;
  values: Record<string, RunValues>;
  sources: Record<string, InputSourcesResponse>;
  busy: boolean;
  onPick: (stateId: string) => void;
}) {
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

  return { workflow, pick, picked, errors, fields, form, from, fromTask, check, touched, touch, blocked, filled };
}

/** What a re-run with changes is handed (`panelViews.tsx`'s `RerunSurface`, as far as the form reads it). */
export interface RerunFormSurface {
  workflow: string;
  fields: RunField[] | null | undefined;
  values: RunValues;
  busy: boolean;
  starts?: readonly { seq: number; label: string }[] | undefined;
  onFork?: ((seq: number) => void) | undefined;
}

/**
 * The re-run form's state and derivations — `RerunForm`'s: where the copy starts (the beginning, or
 * before a state the task entered — a FORK there), and why the button is off.
 */
export function useRerunForm(run: RerunFormSurface) {
  const check = useRunCheck(run.fields, run.values);
  const { touched, touch } = useTouched(`rerun:${run.workflow}`);
  const [from, setFrom] = useState("");
  const forking = from !== "" && run.onFork !== undefined;
  const blocked = forking ? (run.busy ? "busy" : null) : createBlocker({ workflow: run.workflow, fields: run.fields, check, busy: run.busy });
  const startLabel = run.starts?.find((one) => String(one.seq) === from)?.label;
  return { check, touched, touch, from, setFrom, forking, blocked, startLabel };
}
