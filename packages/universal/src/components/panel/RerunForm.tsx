import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import { useRerunForm, type RerunFormSurface } from "@jaira/ui/newTaskModel";
import { runInputsOf, type RunValues } from "@jaira/ui/runForm";
import { Txt, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { useEnterSubmits } from "../form/useEnterSubmits";
import { Button } from "../settings/Button";
import { SelectInput } from "../settings/fields";
import { RunInputs } from "./RunPanel";

/** What a re-run with changes needs: the form, and what happens on the way out (`RerunSurface`). */
export interface RerunSurface extends RerunFormSurface {
  onChange: (values: RunValues) => void;
  onRun: (inputs: Record<string, JsonValue>) => void;
}

/**
 * `panelViews.tsx`'s `RerunForm`, universal (decision 0015): a copy of a task with its inputs changed —
 * the form its workflow declares, opening on the values the task was called with — or, started before a
 * state the task entered, a fork there. What it decides is `newTaskModel.ts`'s (`useRerunForm`). The
 * rules are the New-task form's (`NewTaskForm.tsx`).
 */
export function RerunForm({ run, onCancel }: { run: RerunSurface; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const { check, touched, touch, from, setFrom, forking, blocked, startLabel } = useRerunForm(run);
  const sub: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };
  const start = (): void => {
    if (blocked !== null) return;
    if (forking) run.onFork?.(Number(from));
    else run.onRun(runInputsOf(run.fields ?? [], run.values));
  };
  // `<form onSubmit>`: Enter in one of its boxes starts the copy, as on the desktop.
  const form = useEnterSubmits(start);
  return (
    <View ref={form as never} flexDirection="column" gap={10} paddingTop={2} paddingHorizontal={2} paddingBottom={12}>
      {run.starts !== undefined && run.starts.length > 0 && run.onFork !== undefined ? (
        <View flexDirection="column" gap={4}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: 0.04, upper: true, color: "dim" }}>Start from</Txt>
          <SelectInput value={from} options={[["the beginning", ""], ...run.starts.map((one): [string, string] => [`before ${one.label}`, String(one.seq)])]} onChange={setFrom} />
        </View>
      ) : null}
      {forking ? (
        <Txt spec={sub}>Everything before {startLabel} is kept, so the copy runs with the inputs this task had.</Txt>
      ) : run.fields === undefined ? (
        <Txt spec={sub}>reading its inputs…</Txt>
      ) : run.fields === null ? (
        <View backgroundColor={t.v("tint-bad") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>That workflow&apos;s file does not parse, so its inputs cannot be read.</Txt>
        </View>
      ) : run.fields.length === 0 ? (
        <Txt spec={sub}>This workflow declares no inputs — the copy will run the same.</Txt>
      ) : (
        <RunInputs fields={run.fields} values={run.values} check={check} touched={touched} touch={touch} onChange={run.onChange} />
      )}
      <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
        <Button kind="primary" disabled={blocked !== null} title={blocked ?? (forking ? `a copy that starts before ${startLabel}` : `starts a new ${run.workflow}`)} onPress={start}>
          {forking ? "Start the copy there" : "Start the copy"}
        </Button>
        <Button kind="ghost" onPress={onCancel}>
          Cancel
        </Button>
        {blocked !== null && blocked.length > 0 ? (
          <Txt spec={sub} ellip flexShrink={1} minWidth={0}>
            {blocked}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}
